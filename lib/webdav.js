(function (global) {
  function joinUrl(base, path) {
    const root = String(base || "").replace(/\/+$/, "");
    const rel = String(path || "").replace(/^\/+/, "");
    return `${root}/${rel}`;
  }

  // Apache DAV 对无斜杠的集合会 301 到 http://host/dir/（反代后还可能丢掉 /bilicaption 前缀）。
  // Chrome 跟随这条 Location 会 Failed to fetch。集合路径一律带尾斜杠。
  function collectionPath(path) {
    const rel = String(path || "").replace(/^\/+|\/+$/g, "");
    return rel ? `${rel}/` : "";
  }

  function authHeader(user, pass) {
    return `Basic ${btoa(`${user}:${pass}`)}`;
  }

  // http 会把 Basic 认证和同步的 API Key 全部明文过网，必须拦下
  function assertHttpsUrl(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("服务器地址无效，请填写完整 URL");
    }
    if (parsed.protocol !== "https:") {
      throw new Error("WebDAV 地址必须使用 https，否则网盘密码和 API Key 会明文传输");
    }
    return parsed;
  }

  async function ensureOrigin(url) {
    try {
      await chrome.permissions.request({ origins: [`${new URL(url).origin}/*`] });
    } catch {
      // ignore
    }
  }

  function safeFileId(value) {
    return String(value || "").replace(/[^A-Za-z0-9_-]/g, "");
  }

  // options 原样交给 fetch（可带 signal 做超时）；compact 只给 putJson 用
  async function davFetch(cfg, path, options = {}) {
    const url = joinUrl(cfg.url, path);
    assertHttpsUrl(url);
    await ensureOrigin(url);
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: authHeader(cfg.user, cfg.pass),
        ...(options.body && typeof options.body === "string" ? { "Content-Type": "application/json;charset=UTF-8" } : {}),
        ...(options.headers || {})
      }
    });
    return res;
  }

  async function mkcol(cfg, path) {
    const res = await davFetch(cfg, collectionPath(path), {
      method: "MKCOL",
      redirect: "manual"
    });
    const status = Number(res.status) || 0;
    if (
      res.type === "opaqueredirect"
      || status === 0
      || status === 200
      || status === 201
      || status === 405
      || status === 409
      || status === 301
      || status === 302
      || status === 307
      || status === 308
    ) return;
    if (!res.ok) {
      throw new Error(`无法创建目录 ${path}（HTTP ${res.status}）`);
    }
  }

  function httpError(message, status) {
    const error = new Error(message);
    error.status = Number(status) || 0;
    return error;
  }

  /** 返回写入的字节数。options.compact：不缩进（字幕备份文件大，省一半体积）；其余选项交给 fetch */
  async function putJson(cfg, path, data, options = {}) {
    const { compact, ...rest } = options;
    const body = compact ? JSON.stringify(data) : JSON.stringify(data, null, 2);
    const res = await davFetch(cfg, path, {
      ...rest,
      method: "PUT",
      body
    });
    if (!res.ok) throw httpError(`上传失败 ${path}（HTTP ${res.status}）`, res.status);
    return utf8Length(body);
  }

  async function getJson(cfg, path, options = {}) {
    const res = await davFetch(cfg, path, { ...options, method: "GET" });
    if (res.status === 404) return null;
    if (!res.ok) throw httpError(`下载失败 ${path}（HTTP ${res.status}）`, res.status);
    return res.json();
  }

  function utf8Length(text) {
    try {
      return new TextEncoder().encode(String(text || "")).length;
    } catch {
      return String(text || "").length;
    }
  }

  async function test(cfg) {
    if (!cfg.url) throw new Error("请填写服务器地址");
    if (!cfg.user || !cfg.pass) throw new Error("请填写用户名和密码");
    await mkcol(cfg, "");
    const res = await davFetch(cfg, "", { method: "PROPFIND", headers: { Depth: "0" } });
    if (!res.ok && res.status !== 207) throw new Error(`连接失败 HTTP ${res.status}`);
    return { ok: true };
  }

  function markFile(bvid, cid) {
    return `marks/${safeFileId(bvid) || "video"}-P${Number(cid) || 0}.json`;
  }

  async function pushMarks(cfg, entry, marks) {
    await mkcol(cfg, "marks");
    await putJson(cfg, markFile(entry.bvid, entry.cid), {
      ...entry,
      marks
    });
  }

  async function pullMarks(cfg, bvid, cid) {
    return getJson(cfg, markFile(bvid, cid));
  }

  // ---- 转写字幕与改字的备份：subs/ ----
  // 每个受保护视频（转写生成或改过字）一个 subs/<编号>-P<cid>.json，编号规则与标记文件相同；
  // subs/index.json 是 { "<文件编号>": { updatedAt, editedAt, origin, size, hash, deleted? } }，
  // 打开视频时先查它，远端没有这个视频就一个请求都不发。
  // 备份只含字幕本身和少量元信息：不含 API Key，也不含官方字幕轨地址这类带临时签名的链接。
  const SUBS_INDEX = "subs/index.json";
  const SUB_FORMAT = 1;
  // 墓碑留半年：足够让很久不开的另一台电脑也知道这个视频被删过
  const SUB_TOMBSTONE_TTL = 180 * 24 * 60 * 60 * 1000;

  function subFileId(bvid, cid) {
    return `${safeFileId(bvid) || "video"}-P${Number(cid) || 0}`;
  }

  function subFile(bvid, cid) {
    return `subs/${subFileId(bvid, cid)}.json`;
  }

  function subConflictFile(bvid, cid, at = Date.now()) {
    return `subs/${subFileId(bvid, cid)}-conflict-${Number(at) || Date.now()}.json`;
  }

  /** 一行字幕只留这几个字段（时间、原文 / 译文、改字标记），别的一律不带 */
  function backupCue(cue) {
    const row = {
      from: Number(cue?.from) || 0,
      to: Number(cue?.to) || 0,
      content: String(cue?.content ?? "")
    };
    if (cue?.original != null && String(cue.original) !== "") row.original = String(cue.original);
    if (cue?.edited === true) row.edited = true;
    if (typeof cue?.sid === "number" || typeof cue?.sid === "string") row.sid = cue.sid;
    return row;
  }

  function fnv1a(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  /**
   * 字幕内容的指纹：只看会让两台电脑看到不同字幕的字段。标题这类元信息改了不算改动。
   * 两边比指纹判断「自上次同步后谁改过」，不依赖各台电脑的时钟。
   */
  function subtitleContentHash(data) {
    const text = JSON.stringify([
      String(data?.origin || ""),
      String(data?.source || ""),
      String(data?.activeLan || ""),
      data?.partial === true,
      Number(data?.editedAt) || 0,
      (Array.isArray(data?.cues) ? data.cues : []).map(backupCue)
    ]);
    return `${text.length.toString(36)}-${fnv1a(text)}`;
  }

  function subtitleOrigin(entry) {
    const tools = global.BiliCaptionCueTools;
    if (tools?.subtitleCacheOrigin) return tools.subtitleCacheOrigin(entry);
    return entry?.origin === "official" ? "official" : "asr";
  }

  /** 本地字幕缓存条目 → 备份文件内容 */
  function subtitleBackupDoc(bvid, cid, entry, updatedAt = Date.now()) {
    const doc = {
      v: SUB_FORMAT,
      id: subFileId(bvid, cid),
      bvid: String(bvid || ""),
      cid: Number(cid) || 0,
      origin: subtitleOrigin(entry),
      source: String(entry?.source || ""),
      activeLan: String(entry?.activeLan || ""),
      partial: entry?.partial === true,
      editedAt: Number(entry?.editedAt) || 0,
      provider: String(entry?.provider || ""),
      model: String(entry?.model || ""),
      language: String(entry?.language || ""),
      title: String(entry?.title || ""),
      titleFull: String(entry?.titleFull || ""),
      up: String(entry?.up || ""),
      durationMeta: Number(entry?.durationMeta) || 0,
      updatedAt: Number(updatedAt) || Date.now(),
      cues: (Array.isArray(entry?.cues) ? entry.cues : []).map(backupCue)
    };
    doc.hash = subtitleContentHash(doc);
    return doc;
  }

  /** 下载到的是不是这个视频的、看得懂的备份 */
  function isSubtitleBackup(doc, bvid, cid) {
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return false;
    if ((Number(doc.v) || 0) > SUB_FORMAT) return false;
    if (!Array.isArray(doc.cues) || !doc.cues.length) return false;
    return doc.id === subFileId(bvid, cid);
  }

  /**
   * 备份文件 → 本地字幕缓存条目。本机原有条目里的字幕轨列表、封面这类元信息留着
   * （备份里不带轨地址），字幕本身和来源、改字标记整份用备份的。
   */
  function subtitleEntryFromBackup(doc, prev) {
    const entry = {};
    for (const key of ["tracks", "pic", "up", "title", "titleFull", "durationMeta"]) {
      if (prev?.[key] != null && prev[key] !== "") entry[key] = prev[key];
    }
    for (const key of ["title", "titleFull", "up", "provider", "model", "language"]) {
      if (doc[key]) entry[key] = String(doc[key]);
    }
    if (Number(doc.durationMeta) > 0) entry.durationMeta = Number(doc.durationMeta);
    entry.cues = doc.cues.map(backupCue);
    entry.source = String(doc.source || "");
    entry.activeLan = String(doc.activeLan || "");
    entry.origin = doc.origin === "official" ? "official" : "asr";
    entry.partial = doc.partial === true;
    if (Number(doc.editedAt) > 0) entry.editedAt = Number(doc.editedAt);
    return entry;
  }

  function subsIndexEntry(doc, size) {
    return {
      bvid: doc.bvid,
      cid: doc.cid,
      updatedAt: Number(doc.updatedAt) || 0,
      editedAt: Number(doc.editedAt) || 0,
      origin: doc.origin,
      size: Number(size) || 0,
      hash: doc.hash
    };
  }

  function normalizeSubsIndex(data) {
    const out = {};
    if (!data || typeof data !== "object" || Array.isArray(data)) return out;
    for (const [id, row] of Object.entries(data)) {
      if (id && row && typeof row === "object" && !Array.isArray(row)) out[id] = row;
    }
    return out;
  }

  async function pullSubsIndex(cfg, options = {}) {
    return normalizeSubsIndex(await getJson(cfg, SUBS_INDEX, options));
  }

  /** 写索引时顺手丢掉半年前的墓碑，免得索引越积越大 */
  async function pushSubsIndex(cfg, index, options = {}) {
    const now = Date.now();
    const out = {};
    for (const [id, row] of Object.entries(normalizeSubsIndex(index))) {
      if (row.deleted && now - (Number(row.updatedAt) || 0) > SUB_TOMBSTONE_TTL) continue;
      out[id] = row;
    }
    await putJson(cfg, SUBS_INDEX, out, { ...options, compact: true });
    return out;
  }

  async function pullSubtitle(cfg, bvid, cid, options = {}) {
    return getJson(cfg, subFile(bvid, cid), options);
  }

  /** 上传一份备份，返回字节数 */
  async function pushSubtitle(cfg, doc, options = {}) {
    return putJson(cfg, subFile(doc.bvid, doc.cid), doc, { ...options, compact: true });
  }

  /** 删掉远端备份文件；本来就没有（404）也算成功。返回 HTTP 状态码 */
  async function removeSubtitle(cfg, bvid, cid, options = {}) {
    const path = subFile(bvid, cid);
    const res = await davFetch(cfg, path, { ...options, method: "DELETE" });
    if (res.ok || res.status === 404) return Number(res.status) || 0;
    throw httpError(`删除失败 ${path}（HTTP ${res.status}）`, res.status);
  }

  async function pushConfig(cfg, data) {
    await putJson(cfg, "config.json", data);
  }

  async function pullConfig(cfg) {
    return getJson(cfg, "config.json");
  }

  function mergeTrash(localItems, remoteItems, localUpdated, remoteUpdated, syncedAt) {
    const local = Array.isArray(localItems) ? localItems : [];
    const remote = Array.isArray(remoteItems) ? remoteItems : [];
    const localAt = Number(localUpdated) || 0;
    const remoteAt = Number(remoteUpdated) || 0;
    const synced = Number(syncedAt) || 0;
    const localDirty = localAt > synced;
    const remoteDirty = remoteAt > synced;
    const byId = new Map();
    for (const item of local) {
      if (item?.id) byId.set(item.id, { local: item });
    }
    for (const item of remote) {
      if (!item?.id) continue;
      byId.set(item.id, { ...byId.get(item.id), remote: item });
    }
    const out = [];
    for (const pair of byId.values()) {
      const left = pair.local;
      const right = pair.remote;
      if (left && right) {
        out.push((Number(left.deletedAt) || 0) >= (Number(right.deletedAt) || 0) ? left : right);
        continue;
      }
      const only = left || right;
      const addedAfterSync = (Number(only.deletedAt) || 0) > synced;
      if (left && !right) {
        if (remoteDirty && !localDirty) continue;
        if (localDirty && remoteDirty && !addedAfterSync) continue;
        out.push(left);
        continue;
      }
      if (right && !left) {
        if (localDirty && !remoteDirty) continue;
        if (localDirty && remoteDirty && !addedAfterSync) continue;
        out.push(right);
      }
    }
    return out.sort((a, b) => (Number(b.deletedAt) || 0) - (Number(a.deletedAt) || 0));
  }

  function formatSyncAgo(at) {
    const ts = Number(at) || 0;
    if (!ts) return "";
    const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (mins < 1) return "刚刚";
    if (mins < 60) return `${mins} 分钟前`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} 小时前`;
    return new Date(ts).toLocaleString("zh-CN", { hour12: false });
  }

  function decideSync(localUpdated, remoteUpdated, syncedAt) {
    const local = Number(localUpdated) || 0;
    const remote = Number(remoteUpdated) || 0;
    const synced = Number(syncedAt) || 0;
    const localDirty = local > synced;
    const remoteDirty = remote > synced;
    if (!localDirty && !remoteDirty) return "skip";
    if (localDirty && !remoteDirty) return "push";
    if (!localDirty && remoteDirty) return "pull";
    return local >= remote ? "conflict-push" : "conflict-pull";
  }

  function stripChannelKeys(channels) {
    if (!Array.isArray(channels)) return [];
    return channels.map((ch) => {
      if (!ch || typeof ch !== "object") return ch;
      return { ...ch, key: "" };
    });
  }

  function configPayload(storage) {
    const syncKeys = Boolean(storage.syncKeys);
    const cfgOut = {
      sttProvider: storage.sttProvider,
      sttModel: storage.sttModel,
      sttChannels: syncKeys ? storage.sttChannels : stripChannelKeys(storage.sttChannels),
      backupProvider: storage.backupProvider,
      sumProvider: storage.sumProvider,
      apiBase: storage.apiBase,
      apiModel: storage.apiModel,
      selKey: storage.selKey,
      summaryPad: storage.summaryPad,
      translateConcurrency: storage.translateConcurrency,
      updatedAt: Number(storage.davConfigAt) || Date.now()
    };
    if (syncKeys) {
      cfgOut.sttCreds = storage.sttCreds;
      cfgOut.apiKey = storage.apiKey;
      cfgOut.backupKey = storage.backupKey;
    }
    return cfgOut;
  }

  async function loadSyncMeta() {
    const data = await chrome.storage.local.get({ davSyncMeta: {} });
    const meta = data.davSyncMeta && typeof data.davSyncMeta === "object" ? data.davSyncMeta : {};
    if (!meta.files || typeof meta.files !== "object") meta.files = {};
    return meta;
  }

  async function saveSyncMeta(meta) {
    await chrome.storage.local.set({ davSyncMeta: meta });
  }

  async function remoteIndex(cfg) {
    const list = await getJson(cfg, "marks/index.json");
    return Array.isArray(list) ? list : [];
  }

  // 只列键名，不把整库（含几 MB 的字幕缓存）读进内存；getKeys 需 Chrome 130+，旧版退回 get(null)。
  async function listLocalKeys() {
    const area = chrome.storage.local;
    if (typeof area.getKeys === "function") return area.getKeys();
    return Object.keys((await area.get(null)) || {});
  }

  async function localMarkEntries(Markers) {
    const index = await Markers.loadIndex();
    const byId = new Map(index.map((row) => [row.id, row]));
    const missing = [];
    for (const key of await listLocalKeys()) {
      if (!key.startsWith("marks:")) continue;
      const parts = key.slice(6).split(":");
      const bvid = parts[0] || "";
      const cid = Number(parts[1]) || 0;
      const id = `${bvid}:${cid}`;
      if (!byId.has(id)) missing.push({ key, id, bvid, cid });
    }
    // 只有不在索引里的旧标记才需要读出来数条数
    const values = missing.length ? await chrome.storage.local.get(missing.map((item) => item.key)) : {};
    for (const item of missing) {
      const list = values[item.key];
      byId.set(item.id, { id: item.id, bvid: item.bvid, cid: item.cid, updatedAt: 0, count: Array.isArray(list) ? list.length : 0 });
    }
    return [...byId.values()];
  }

  // 触发自动同步的键：只看真正会上传或会改变同步方式的键。
  // 设置内容是否上传只由 davConfigAt 决定（设置页保存且内容有变才会刷新它），
  // 浮窗透明度 / 位置、字幕语言、overlayOn 这类界面偏好一律不触发。
  // 字幕缓存（asr:*）和字幕备份的同步记录（davSubs）都不在这里：字幕备份只在转写完成、改字、翻译完成时单独上传。
  const SYNC_TRIGGER_KEYS = ["davConfigAt", "syncOn", "syncMarks", "syncConfig", "syncKeys", "syncSubs", "davUrl", "davUser"];
  const LOCAL_TRIGGER_KEYS = ["markerIndex", "markerTrash", "davPass"];

  function shouldSyncOnChange(changes, area) {
    const keys = Object.keys(changes || {});
    if (area === "local") {
      return keys.some((key) => LOCAL_TRIGGER_KEYS.includes(key) || key.startsWith("marks:"));
    }
    if (area !== "sync") return false;
    if (changes.syncOn?.newValue === false) return false;
    return keys.some((key) => SYNC_TRIGGER_KEYS.includes(key));
  }

  async function reconcileMarks(cfg, storage, meta) {
    const Markers = global.BiliCaptionMarkers;
    if (storage.syncMarks === false || !Markers) return { pushed: 0, pulled: 0, conflicts: 0 };
    await mkcol(cfg, "marks");
    const localRows = await localMarkEntries(Markers);
    const remoteRows = await remoteIndex(cfg);
    const ids = new Map();
    for (const row of remoteRows) ids.set(row.id || `${row.bvid}:${row.cid}`, { remote: row });
    for (const row of localRows) {
      const id = row.id || `${row.bvid}:${row.cid}`;
      ids.set(id, { ...ids.get(id), local: row });
    }
    let pushed = 0;
    let pulled = 0;
    let conflicts = 0;
    const nextIndex = [];
    for (const [id, pair] of ids) {
      const local = pair.local || { id, bvid: pair.remote?.bvid || "", cid: Number(pair.remote?.cid) || 0, updatedAt: 0 };
      const remote = await pullMarks(cfg, local.bvid || pair.remote?.bvid, local.cid ?? pair.remote?.cid);
      const path = markFile(local.bvid, local.cid);
      const syncedAt = Number(meta.files[path]?.syncedAt) || 0;
      const localUpdated = Number(local.updatedAt) || 0;
      const remoteUpdated = Number(remote?.updatedAt) || 0;
      const action = decideSync(localUpdated, remoteUpdated, syncedAt);
      if (action === "skip") {
        if (localUpdated) nextIndex.push(local);
        else if (remote) nextIndex.push({ ...remote, marks: undefined });
        continue;
      }
      if (action === "push" || action === "conflict-push") {
        if (action === "conflict-push" && remote) {
          await putJson(cfg, `marks/${safeFileId(id)}-conflict-${Date.now()}.json`, remote);
          conflicts += 1;
        }
        const marks = await Markers.load(local.bvid, local.cid);
        const entry = { ...local, marks, updatedAt: localUpdated || Date.now() };
        await pushMarks(cfg, entry, marks);
        meta.files[path] = { syncedAt: entry.updatedAt, remoteUpdatedAt: entry.updatedAt };
        nextIndex.push(entry);
        pushed += 1;
        continue;
      }
      if (remote) {
        if (action === "conflict-pull") {
          const marks = await Markers.load(local.bvid, local.cid);
          await putJson(cfg, `marks/${safeFileId(id)}-conflict-${Date.now()}.json`, { ...local, marks });
          conflicts += 1;
        }
        await Markers.save(remote.bvid || local.bvid, remote.cid ?? local.cid, remote.marks || [], {
          ...remote,
          updatedAt: remoteUpdated
        });
        meta.files[path] = { syncedAt: remoteUpdated, remoteUpdatedAt: remoteUpdated };
        nextIndex.push({ ...remote, marks: undefined, updatedAt: remoteUpdated });
        pulled += 1;
      }
    }
    const indexOut = nextIndex
      .map((row) => ({
        id: row.id || `${row.bvid || ""}:${Number(row.cid) || 0}`,
        bvid: row.bvid || "",
        cid: Number(row.cid) || 0,
        title: row.title || "",
        up: row.up || "",
        part: row.part || "",
        dur: row.dur || "",
        updatedAt: Number(row.updatedAt) || 0,
        count: Number(row.count) || 0
      }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 400);
    await putJson(cfg, "marks/index.json", indexOut);
    return { pushed, pulled, conflicts };
  }

  async function reconcileTrash(cfg, storage, meta) {
    const Markers = global.BiliCaptionMarkers;
    if (storage.syncMarks === false || !Markers?.loadTrashDoc) return { pushed: 0, pulled: 0, conflicts: 0 };
    await mkcol(cfg, "marks");
    const local = await Markers.loadTrashDoc();
    const remote = await getJson(cfg, "marks/trash.json");
    const path = "marks/trash.json";
    const localUpdated = Number(local.updatedAt) || 0;
    const remoteUpdated = Number(remote?.updatedAt) || 0;
    const syncedAt = Number(meta.files[path]?.syncedAt) || 0;
    const action = decideSync(localUpdated, remoteUpdated, syncedAt);
    if (action === "skip") return { pushed: 0, pulled: 0, conflicts: 0 };
    if (action === "push") {
      const doc = { updatedAt: localUpdated || Date.now(), items: local.items || [] };
      await putJson(cfg, path, doc);
      meta.files[path] = { syncedAt: doc.updatedAt, remoteUpdatedAt: doc.updatedAt };
      return { pushed: 1, pulled: 0, conflicts: 0 };
    }
    if (action === "pull" && remote) {
      await Markers.saveTrashDoc({
        updatedAt: remoteUpdated,
        items: Array.isArray(remote.items) ? remote.items : []
      });
      meta.files[path] = { syncedAt: remoteUpdated, remoteUpdatedAt: remoteUpdated };
      return { pushed: 0, pulled: 1, conflicts: 0 };
    }
    const merged = mergeTrash(local.items, remote?.items, localUpdated, remoteUpdated, syncedAt);
    const updatedAt = Math.max(localUpdated, remoteUpdated, Date.now());
    await Markers.saveTrashDoc({ updatedAt, items: merged });
    await putJson(cfg, path, { updatedAt, items: merged });
    meta.files[path] = { syncedAt: updatedAt, remoteUpdatedAt: updatedAt };
    return { pushed: 1, pulled: 1, conflicts: 1 };
  }

  async function reconcileConfig(cfg, storage, meta) {
    if (!storage.syncConfig && !storage.syncKeys) return { pushed: 0, pulled: 0 };
    const remote = await pullConfig(cfg);
    const path = "config.json";
    const localUpdated = Number(storage.davConfigAt) || 0;
    const remoteUpdated = Number(remote?.updatedAt) || 0;
    const syncedAt = Number(meta.files[path]?.syncedAt) || 0;
    const action = decideSync(localUpdated, remoteUpdated, syncedAt);
    if (action === "skip") return { pushed: 0, pulled: 0 };
    if (action === "push" || action === "conflict-push") {
      const payload = configPayload(storage);
      await pushConfig(cfg, payload);
      meta.files[path] = { syncedAt: payload.updatedAt, remoteUpdatedAt: payload.updatedAt };
      return { pushed: 1, pulled: 0 };
    }
    if (remote && (action === "pull" || action === "conflict-pull")) {
      const Prefs = global.BiliCaptionPrefs;
      if (Prefs) {
        const apply = { ...remote };
        delete apply.updatedAt;
        if (!storage.syncKeys) {
          delete apply.apiKey;
          delete apply.backupKey;
          delete apply.sttCreds;
          if (Array.isArray(apply.sttChannels)) apply.sttChannels = stripChannelKeys(apply.sttChannels);
        }
        apply.davConfigAt = remoteUpdated;
        await Prefs.saveSettings(apply);
      }
      meta.files[path] = { syncedAt: remoteUpdated, remoteUpdatedAt: remoteUpdated };
      return { pushed: 0, pulled: 1 };
    }
    return { pushed: 0, pulled: 0 };
  }

  async function autoSync(cfg, storage) {
    await test(cfg);
    await mkcol(cfg, "");
    const meta = await loadSyncMeta();
    const marks = await reconcileMarks(cfg, storage, meta);
    const trash = await reconcileTrash(cfg, storage, meta);
    const config = await reconcileConfig(cfg, storage, meta);
    meta.lastOk = Date.now();
    meta.lastError = "";
    await saveSyncMeta(meta);
    return {
      ok: true,
      at: Date.now(),
      marks,
      trash,
      config
    };
  }

  async function syncNow(cfg, storage) {
    return autoSync(cfg, storage);
  }

  global.BiliCaptionDav = {
    test,
    listLocalKeys,
    syncNow,
    autoSync,
    decideSync,
    configPayload,
    stripChannelKeys,
    mergeTrash,
    pushMarks,
    pullMarks,
    pushConfig,
    pullConfig,
    markFile,
    mkcol,
    putJson,
    getJson,
    subFileId,
    subFile,
    subConflictFile,
    subtitleContentHash,
    subtitleBackupDoc,
    isSubtitleBackup,
    subtitleEntryFromBackup,
    subsIndexEntry,
    normalizeSubsIndex,
    pullSubsIndex,
    pushSubsIndex,
    pullSubtitle,
    pushSubtitle,
    removeSubtitle,
    SUBS_INDEX,
    SUB_FORMAT,
    joinUrl,
    collectionPath,
    formatSyncAgo,
    shouldSyncOnChange,
    SYNC_TRIGGER_KEYS,
    LOCAL_TRIGGER_KEYS
  };
})(globalThis);
