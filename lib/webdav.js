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

  async function putJson(cfg, path, data) {
    const res = await davFetch(cfg, path, {
      method: "PUT",
      body: JSON.stringify(data, null, 2)
    });
    if (!res.ok) throw new Error(`上传失败 ${path}（HTTP ${res.status}）`);
  }

  async function getJson(cfg, path) {
    const res = await davFetch(cfg, path, { method: "GET" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`下载失败 ${path}（HTTP ${res.status}）`);
    return res.json();
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

  function configPayload(storage) {
    const cfgOut = {
      sttProvider: storage.sttProvider,
      sttModel: storage.sttModel,
      sttChannels: storage.sttChannels,
      backupProvider: storage.backupProvider,
      sumProvider: storage.sumProvider,
      apiBase: storage.apiBase,
      apiModel: storage.apiModel,
      selKey: storage.selKey,
      summaryPad: storage.summaryPad,
      translateConcurrency: storage.translateConcurrency,
      updatedAt: Number(storage.davConfigAt) || Date.now()
    };
    if (storage.syncKeys) {
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

  async function localMarkEntries(Markers) {
    const index = await Markers.loadIndex();
    const byId = new Map(index.map((row) => [row.id, row]));
    const all = await chrome.storage.local.get(null);
    for (const key of Object.keys(all || {})) {
      if (!key.startsWith("marks:")) continue;
      const parts = key.slice(6).split(":");
      const bvid = parts[0] || "";
      const cid = Number(parts[1]) || 0;
      const id = `${bvid}:${cid}`;
      if (!byId.has(id)) {
        byId.set(id, { id, bvid, cid, updatedAt: 0, count: Array.isArray(all[key]) ? all[key].length : 0 });
      }
    }
    return [...byId.values()];
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
    syncNow,
    autoSync,
    decideSync,
    mergeTrash,
    pushMarks,
    pullMarks,
    pushConfig,
    pullConfig,
    markFile,
    joinUrl,
    collectionPath,
    formatSyncAgo
  };
})(globalThis);
