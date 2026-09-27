// 后台 · 转写字幕与改字的 WebDAV 备份（远端 subs/，文件格式见 lib/webdav.js）。
//
// 只备份受保护的字幕缓存（转写生成，或用户改过字，见 lib/字幕工具.js 的 isProtectedSubtitleCache）；
// 官方字幕且没改过字的随时能重新拉，不上传。坚果云等网盘的 WebDAV 有请求频率限制，所以：
// - 上传只在关键时刻：转写完成（含部分完成）、改字（10 秒防抖，连续改字合并成一次）、受保护视频翻译完成。
//   同一批里的多个视频共用一次索引读写。不进改标记后的高频防抖同步，asr: 键变化也不触发整轮同步。
// - 下载按需：定时 / 手动同步时顺带拉一次 subs/index.json 存在本地；打开视频时只有本地没有受保护缓存
//   （或本机的没改过字、远端的有改字）、而本地存的索引里有这个视频，才 GET 一次它的备份
//   （5 秒超时，失败就当没有）。不轮询、不整批下载。
// - 冲突（远端这份不是本机上次同步的那份，且和本机不一样）：有用户改字的一方优先，没改过字的一方
//   永远不能覆盖改过字的一方（见 subConflictWinner）。输的一方有改字、或是远端另一台电脑的版本时，
//   另存为 subs/<编号>-conflict-<时间戳>.json（不进索引）；赢的一方把输的一方没改过字的行的译文合并进来。
//   有冲突副本或本机被换成远端版本时，写本机日志并通知侧栏（SUBS_BACKUP_NOTICE）。
// - 删除：用户对单个视频「清理缓存」并确认「同时删除网盘上的字幕备份」时，删远端文件并在索引里写墓碑。
// 同步记录存 storage.local 的 davSubs：index（远端索引的本地副本）、files（每个视频上次同步时远端那份的内容指纹）、
// pending（待上传 / 待删除）。失败的留在 pending：该视频再有变化、手动「立即同步」时马上重试；
// 定时同步也会按失败次数退避后重试（见 subRetryDelay），每次最多几个。

const SUBS_STATE_KEY = "davSubs";
const SUB_BACKUP_DELAYS = { edit: 10000, asr: 1500, translate: 1500, backfill: 15000, conflict: 15000, merge: 1500 };
// 失败项的自动重试：定时同步时按失败次数退避，10 分钟起、每失败一次翻倍、最长 1 天；
// 每次定时同步最多处理 SUB_AUTO_RETRY_MAX 个（没尝试过的优先），断网恢复后不会一下子发一大串请求
const SUB_RETRY_BASE_MS = 10 * 60 * 1000;
const SUB_RETRY_MAX_MS = 24 * 60 * 60 * 1000;
const SUB_AUTO_RETRY_MAX = 4;
const SUB_PULL_TIMEOUT_MS = 5000;
const SUB_REQUEST_TIMEOUT_MS = 60000;
// 改标记后 4 秒的防抖同步（及其 alarm 兜底）是高频路径，不顺带拉字幕索引、不补传字幕
const SUB_SKIP_SYNC_REASONS = new Set(["debounce", "dav-sync-soon"]);
const subBackupTimers = new Map();
// 同一时刻到点的几个视频合成一批上传（共用一次索引读写）
const subBackupDue = new Set();
let subBackupDueTimer = 0;
let subsStateChain = Promise.resolve();
let subsRemoteChain = Promise.resolve();
let subPendingSeq = 0;

async function loadSubBackupSettings() {
  return BiliCaptionPrefs.loadSettings({
    syncOn: false,
    syncSubs: true,
    davUrl: "",
    davUser: "",
    davPass: ""
  });
}

/** WebDAV 已开启时默认同步字幕；设置页可单独关掉 */
function subBackupEnabled(settings) {
  return Boolean(settings?.syncOn) && settings.syncSubs !== false && Boolean(String(settings.davUrl || "").trim());
}

function subsDavKey(cfg) {
  return `${cfg?.url || ""}|${cfg?.user || ""}`;
}

function isSubBackupCandidate(entry) {
  return Boolean(entry?.cues?.length) && BiliCaptionCueTools.isProtectedSubtitleCache(entry);
}

function subRequestOptions(ms = SUB_REQUEST_TIMEOUT_MS) {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? { signal: AbortSignal.timeout(ms) }
    : {};
}

function emptySubsState(dav = "") {
  return { dav, index: {}, indexAt: 0, files: {}, pending: {}, dirReady: false };
}

/**
 * 读同步记录。dav 是当前的「地址|账号」；换了网盘时旧网盘的索引和同步记录作废，
 * 待上传的保留（到新网盘上传），待删除的丢掉（那是旧网盘上的文件）。dav 为空时不做这个检查。
 */
async function readSubsState(dav = "") {
  const data = await chrome.storage.local.get(SUBS_STATE_KEY).catch(() => ({}));
  const raw = data?.[SUBS_STATE_KEY];
  const state = raw && typeof raw === "object" ? raw : emptySubsState(dav);
  for (const key of ["index", "files", "pending"]) {
    if (!state[key] || typeof state[key] !== "object") state[key] = {};
  }
  if (dav && state.dav !== dav) {
    const pending = Object.fromEntries(Object.entries(state.pending).filter(([, item]) => item?.op === "put"));
    return { ...emptySubsState(dav), pending };
  }
  return state;
}

/** 读-改-写同步记录，按顺序一次一个，避免上传结果和新排队的改动互相覆盖 */
function updateSubsState(dav, mutate) {
  const run = subsStateChain.then(async () => {
    const state = await readSubsState(dav);
    const out = await mutate(state);
    await chrome.storage.local.set({ [SUBS_STATE_KEY]: state });
    return out;
  });
  subsStateChain = run.catch(() => {});
  return run;
}

/** 本地看到的远端条目：还没删成的「待删除」也按已删除算 */
function subsRemoteEntry(state, id) {
  if (state.pending?.[id]?.op === "delete") return { ...(state.index?.[id] || {}), deleted: true };
  return state.index?.[id] || null;
}

/** 远端这一条还是本机上次同步时的那一份 */
function subsRemoteUnchanged(remote, synced) {
  if (!remote || !synced) return false;
  if (remote.hash) return remote.hash === synced.hash;
  return (Number(remote.updatedAt) || 0) <= (Number(synced.remoteAt) || 0);
}

/** 失败 tries 次后，距上次尝试至少等多久再由定时同步自动重试 */
function subRetryDelay(tries) {
  const n = Math.max(1, Number(tries) || 1);
  return Math.min(SUB_RETRY_MAX_MS, SUB_RETRY_BASE_MS * 2 ** Math.min(n - 1, 20));
}

/** 定时同步该不该处理这一项：有防抖定时器在等的不抢；没尝试过的马上做；失败过的等退避时间过了 */
function subRetryDue(id, item, now = Date.now()) {
  if (subBackupTimers.has(id)) return false;
  const tries = Number(item?.tries) || 0;
  if (tries <= 0) return true;
  return now - (Number(item.lastTry) || 0) >= subRetryDelay(tries);
}

/**
 * 两份不一样的字幕谁为准（参数是备份文件或索引条目，只看 editedAt）：有用户改字的一方优先；
 * 两边都改过时 editedAt 较新的为准（不同电脑的时钟可能有偏差，近似）；两边都没改过时本机为准。
 */
function subConflictWinner(local, remote) {
  const mine = Number(local?.editedAt) || 0;
  const theirs = Number(remote?.editedAt) || 0;
  if (theirs > 0 && mine <= 0) return "remote";
  if (mine > 0 && theirs > 0 && theirs > mine) return "remote";
  return "local";
}

/** 以 entry 为准，把 donor 没改过字的行的译文合并进 entry 还没译的行；没有可合并的原样返回 entry */
function withMergedTranslations(entry, donor) {
  const cues = BiliCaptionCueTools.mergeCueTranslations(entry?.cues, donor?.cues);
  if (cues === entry?.cues) return entry;
  return { ...entry, cues, source: "translated", activeLan: "translated" };
}

/**
 * 本机字幕缓存被网盘上的版本换掉后：让正开着这个视频的页面重读字幕，免得页面拿着旧字幕回写
 * （侧栏另收 SUBS_BACKUP_NOTICE 自己重读）。
 */
async function reloadVideoTabs(bvid, cid) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: [...BiliCaptionPlatforms.TAB_URL_PATTERNS] });
  } catch {
    tabs = [];
  }
  for (const tab of Array.isArray(tabs) ? tabs : []) {
    if (!tab?.id) continue;
    const verdict = tabVideoMatch(tab.url, { bvid, cid });
    if (verdict === "no") continue;
    if (verdict === "ask" && !(await tabPlaysCid(tab.id, cid))) continue;
    chrome.tabs.sendMessage(tab.id, { type: "REFRESH" }).catch(() => {});
  }
}

/** 冲突处理的结果写本机日志、告诉侧栏（一句话 + 冲突副本在网盘上的路径）；本机被换掉时让页面重读 */
function announceSubNotice(note) {
  appLog(note.conflictPath ? "warn" : "info", "dav", note.notice, {
    bvid: note.bvid,
    cid: note.cid,
    ...(note.conflictPath ? { path: note.conflictPath } : {})
  });
  broadcast({ type: "SUBS_BACKUP_NOTICE", ...note });
  if (note.replaced) reloadVideoTabs(note.bvid, note.cid).catch(() => {});
}

/**
 * 上传前发现远端这份不是本机上次同步的那份（或远端有改字而本机没有）：按 subConflictWinner 定胜负。
 * - 本机为准：远端那份（是另一台电脑的新版本时）另存为冲突副本，它没改过字的行的译文合并进本机，再上传本机的。
 * - 远端为准：本机改过字的先另存为冲突副本（没改过字的转写不上传），本机换成远端的版本并合并本机的译文；
 *   合并出新译文时把合并后的传上去，否则远端不动。
 * 返回 { push: 要上传的备份或 null, synced: 不上传时的同步记录, note: 要告诉用户的话 }；
 * 这个视频正在转写 / 翻译时返回 { deferred: true }，留在队列里下次再做。
 */
async function resolveSubConflict(cfg, item, theirs, remoteMoved) {
  const Dav = BiliCaptionDav;
  const { bvid, cid, entry, doc: mine } = item;
  const theirsEntry = Dav.subtitleEntryFromBackup(theirs, entry);
  const theirsHash = Dav.subtitleBackupDoc(bvid, cid, theirsEntry).hash;
  const synced = { hash: theirsHash, remoteAt: Number(theirs.updatedAt) || 0 };
  if (theirsHash === mine.hash) return { push: null, synced };
  if (subtitleCacheBusy(asrCacheKey(bvid, cid))) return { deferred: true };
  const base = { bvid, cid };
  if (subConflictWinner(mine, theirs) === "local") {
    let stored = entry;
    const merged = withMergedTranslations(entry, theirsEntry);
    if (merged !== entry) {
      stored = await replaceCachedAsr(bvid, cid, merged, { expectSavedAt: entry.savedAt });
      if (!stored) throw new Error("本机字幕刚有改动，下次再传");
    }
    let note = merged === entry ? null : { ...base, replaced: true, notice: "已把网盘上另一份字幕的译文合并进本机字幕" };
    if (remoteMoved) {
      const path = Dav.subConflictFile(bvid, cid);
      await Dav.putJson(cfg, path, theirs, { ...subRequestOptions(), compact: true });
      note = {
        ...base,
        conflictPath: path,
        replaced: merged !== entry,
        notice: `字幕备份有冲突：已保留本机的版本，网盘上原来那份另存为冲突副本 ${path}`
      };
    }
    return { push: Dav.subtitleBackupDoc(bvid, cid, stored), note };
  }
  let path = "";
  if (Number(mine.editedAt) > 0) {
    path = Dav.subConflictFile(bvid, cid);
    await Dav.putJson(cfg, path, mine, { ...subRequestOptions(), compact: true });
  }
  const next = withMergedTranslations(theirsEntry, entry);
  const stored = await replaceCachedAsr(bvid, cid, next, { expectSavedAt: entry.savedAt });
  if (!stored) throw new Error("本机字幕刚有改动，下次再传");
  const note = {
    ...base,
    replaced: true,
    ...(path ? { conflictPath: path } : {}),
    notice: path
      ? `字幕备份有冲突：另一台电脑的改字更新，已换成它的版本；本机原来的改字另存为冲突副本 ${path}`
      : `本机这份字幕没改过字，已换成网盘上另一台电脑改过字的版本${next === theirsEntry ? "" : "（本机的译文已合并进去）"}`
  };
  return { push: next === theirsEntry ? null : Dav.subtitleBackupDoc(bvid, cid, stored), synced, note };
}

/** 远端的串行队列：同一台电脑上的索引读-改-写不能交叉 */
function enqueueSubsRemote(work) {
  const run = subsRemoteChain.then(work);
  subsRemoteChain = run.catch(() => {});
  return run;
}

function armSubBackupTimer(id, delay) {
  clearTimeout(subBackupTimers.get(id));
  subBackupTimers.set(id, setTimeout(() => {
    subBackupTimers.delete(id);
    subBackupDue.add(id);
    if (subBackupDueTimer) return;
    subBackupDueTimer = setTimeout(() => {
      subBackupDueTimer = 0;
      const ids = [...subBackupDue];
      subBackupDue.clear();
      flushSubtitleBackups({ ids }).catch(() => {});
    }, 20);
  }, delay));
}

/**
 * 某个视频的字幕有了值得备份的变化（reason：asr 转写完成、edit 改字、translate 翻译完成、
 * backfill 开同步前就有的受保护字幕、conflict 两边都有变化、merge 换成远端版本后合并进了本机的译文）。
 * 没开字幕同步、或不是受保护条目时什么都不做。
 * 先记进待上传队列（后台被回收也不丢），再按 reason 的延迟上传；同一视频的新变化会重置延迟。
 */
async function queueSubtitleBackup(bvid, cid, reason = "edit") {
  if (!bvid && !cid) return false;
  let settings;
  try {
    settings = await loadSubBackupSettings();
  } catch {
    return false;
  }
  if (!subBackupEnabled(settings)) return false;
  const entry = await loadCachedAsr(bvid, cid).catch(() => null);
  if (!isSubBackupCandidate(entry)) return false;
  const id = BiliCaptionDav.subFileId(bvid, cid);
  await updateSubsState(subsDavKey(davCfgOf(settings)), (state) => {
    state.pending[id] = {
      bvid: String(bvid || ""),
      cid: Number(cid) || 0,
      op: "put",
      reason,
      at: Date.now(),
      tag: `${Date.now()}-${++subPendingSeq}`,
      tries: 0
    };
  });
  armSubBackupTimer(id, SUB_BACKUP_DELAYS[reason] ?? SUB_BACKUP_DELAYS.edit);
  return true;
}

/**
 * 侧栏「清理本视频缓存」前问：清理会不会连带删掉网盘上的字幕备份（会的话侧栏要二次确认）。
 * remote：开着字幕同步，且本地索引副本里网盘上有这个视频的备份（不是墓碑），或本机同步过它；
 * local：本机现在有这份受保护字幕（没有时多半是取回超时、只显示了官方字幕，删了就真找不回来）。
 */
async function subtitleBackupStatus(bvid, cid) {
  let settings = null;
  try {
    settings = await loadSubBackupSettings();
  } catch {
    settings = null;
  }
  const entry = await loadCachedAsr(bvid, cid).catch(() => null);
  const local = isSubBackupCandidate(entry);
  if (!subBackupEnabled(settings)) return { enabled: false, remote: false, local };
  const state = await readSubsState(subsDavKey(davCfgOf(settings)));
  const id = BiliCaptionDav.subFileId(bvid, cid);
  const known = subsRemoteEntry(state, id);
  return { enabled: true, remote: Boolean(known ? !known.deleted : state.files[id]), local };
}

/**
 * 用户对单个视频「清理缓存」并确认同时删除网盘备份（clearVideoCache 的 deleteRemote）：
 * 本地索引副本里马上记墓碑（紧接着的刷新不会再拉回来），删远端文件和写远端墓碑在后台排队做。
 * 本机从没备份过、远端也不知道的视频不发请求。没开字幕同步时，只在本地索引副本认识这个视频时
 * 记墓碑和待删除，重新开启同步后执行。
 */
async function forgetSubtitleBackup(bvid, cid, { wasProtected = false } = {}) {
  const id = BiliCaptionDav.subFileId(bvid, cid);
  clearTimeout(subBackupTimers.get(id));
  subBackupTimers.delete(id);
  let settings = null;
  try {
    settings = await loadSubBackupSettings();
  } catch {
    settings = null;
  }
  const enabled = subBackupEnabled(settings);
  const dav = enabled ? subsDavKey(davCfgOf(settings)) : "";
  const needRemote = (state) => {
    const known = state.index[id];
    return Boolean((known && !known.deleted) || state.files[id] || state.pending[id] || (enabled && wasProtected));
  };
  // 先看一眼：和远端无关的视频（没开过同步、官方字幕）连同步记录都不写
  if (!needRemote(await readSubsState(dav))) return false;
  const queued = await updateSubsState(dav, (state) => {
    if (!needRemote(state)) return false;
    const known = state.index[id];
    const now = Date.now();
    state.index[id] = {
      bvid: String(bvid || ""),
      cid: Number(cid) || 0,
      ...(known || {}),
      deleted: true,
      updatedAt: Math.max(now, (Number(known?.updatedAt) || 0) + 1)
    };
    delete state.index[id].hash;
    delete state.files[id];
    state.pending[id] = {
      bvid: String(bvid || ""),
      cid: Number(cid) || 0,
      op: "delete",
      at: now,
      tag: `${now}-${++subPendingSeq}`,
      tries: 0
    };
    return true;
  });
  if (queued && enabled) flushSubtitleBackups({ ids: [id], settings }).catch(() => {});
  return queued;
}

/**
 * 执行待办队列。options.ids：只做这几个视频（改动后的定时器，不管以前失败过几次）；
 * options.manual：手动「立即同步」，全部立即做；都没有时（定时同步）做没有防抖定时器在等的：
 * 还没尝试过的（后台在定时器触发前被回收时留下的），和失败后已过了退避时间的（subRetryDelay），
 * 一次最多 SUB_AUTO_RETRY_MAX 个，没尝试过的、失败次数少的优先。
 */
async function flushSubtitleBackups(options = {}) {
  let settings = options.settings;
  if (!settings) {
    try {
      settings = await loadSubBackupSettings();
    } catch {
      return { skipped: true };
    }
  }
  if (!subBackupEnabled(settings)) return { skipped: true };
  const cfg = davCfgOf(settings);
  return enqueueSubsRemote(() => runSubsBatch(cfg, subsDavKey(cfg), options));
}

async function runSubsBatch(cfg, dav, { ids = null, manual = false, quiet = false } = {}) {
  const Dav = BiliCaptionDav;
  const state = await readSubsState(dav);
  const want = Array.isArray(ids) ? new Set(ids) : null;
  const now = Date.now();
  let items = Object.entries(state.pending)
    .filter(([id, item]) => item && (want ? want.has(id) : (manual || subRetryDue(id, item, now))))
    .map(([id, item]) => ({ ...item, id }));
  if (!want && !manual && items.length > SUB_AUTO_RETRY_MAX) {
    items = items
      .sort((a, b) => (Number(a.tries) || 0) - (Number(b.tries) || 0) || (Number(a.lastTry) || 0) - (Number(b.lastTry) || 0))
      .slice(0, SUB_AUTO_RETRY_MAX);
  }
  const result = { pushed: 0, deleted: 0, conflicts: 0, failed: 0, indexFresh: false };
  if (!items.length) return result;

  // 先在本地筛：已不是受保护条目（被清掉、换成官方字幕）的直接出队；内容和上次同步时一样、
  // 本地索引副本也还是那一份的，不发请求
  const puts = [];
  const deletes = [];
  const settled = [];
  for (const item of items) {
    if (item.op === "delete") {
      deletes.push(item);
      continue;
    }
    const entry = await loadCachedAsr(item.bvid, item.cid).catch(() => null);
    if (!isSubBackupCandidate(entry)) {
      settled.push(item);
      continue;
    }
    const doc = Dav.subtitleBackupDoc(item.bvid, item.cid, entry);
    const synced = state.files[item.id];
    const known = state.index[item.id];
    if (synced?.hash === doc.hash && known && !known.deleted && known.hash === doc.hash) {
      settled.push(item);
      continue;
    }
    puts.push({ ...item, doc, entry });
  }

  const done = new Map();
  const failures = new Map();
  const notices = [];
  let index = null;
  let dirReady = state.dirReady === true;
  if (puts.length || deletes.length) {
    try {
      // 第一次上传前先建 subs/ 目录；以后每次都建会白白多一个请求
      if (puts.length && !dirReady) {
        await Dav.mkcol(cfg, "subs");
        dirReady = true;
      }
      index = await Dav.pullSubsIndex(cfg, subRequestOptions());
    } catch (error) {
      for (const item of [...puts, ...deletes]) failures.set(item.id, error);
    }
  }
  if (index) {
    const before = { ...index };
    for (const item of deletes) {
      try {
        const status = await Dav.removeSubtitle(cfg, item.bvid, item.cid, subRequestOptions());
        const prev = index[item.id];
        if (prev || status !== 404) {
          index[item.id] = {
            bvid: item.bvid,
            cid: item.cid,
            deleted: true,
            updatedAt: Math.max(Date.now(), (Number(prev?.updatedAt) || 0) + 1)
          };
        }
        done.set(item.id, { deleted: true });
        result.deleted += 1;
      } catch (error) {
        failures.set(item.id, error);
      }
    }
    for (const item of puts) {
      try {
        let { doc } = item;
        const remote = index[item.id];
        const synced = state.files[item.id];
        const live = Boolean(remote && !remote.deleted);
        if (remote?.deleted && item.reason === "backfill") {
          // 补传的是开同步前的旧字幕，而另一台电脑已经删掉了这个视频的备份：听删除的
          settled.push(item);
          continue;
        }
        if (live && remote.hash === doc.hash) {
          // 远端已经是同样的内容（另一台电脑传的，或上次传完没来得及记下）
          done.set(item.id, { hash: doc.hash, remoteAt: Number(remote.updatedAt) || 0 });
          continue;
        }
        // 另一台电脑在本机上次同步后也改过（含开同步前就有的转写「补传」时远端已有这个视频），
        // 或远端有改字而本机没有：先取回远端那份按「有改字的一方优先」处理，不直接覆盖
        const remoteMoved = live && !subsRemoteUnchanged(remote, synced);
        const guardEdits = live && !(Number(doc.editedAt) > 0) && Number(remote.editedAt) > 0;
        if (remoteMoved || guardEdits) {
          // 正在转写 / 翻译：先不处理（任务写完会再排一次），免得换掉本机后又被任务写回旧内容
          if (subtitleCacheBusy(asrCacheKey(item.bvid, item.cid))) continue;
          const theirs = await Dav.pullSubtitle(cfg, item.bvid, item.cid, subRequestOptions());
          if (Dav.isSubtitleBackup(theirs, item.bvid, item.cid)) {
            const outcome = await resolveSubConflict(cfg, item, theirs, remoteMoved);
            if (outcome.deferred) continue;
            if (outcome.note) {
              notices.push(outcome.note);
              if (outcome.note.conflictPath) result.conflicts += 1;
            }
            if (!outcome.push) {
              done.set(item.id, outcome.synced);
              continue;
            }
            doc = outcome.push;
          }
        }
        // 时间取「现在」和远端已有记录 +1 中较大的，另一台电脑时钟偏快时索引也按新的算
        doc.updatedAt = Math.max(Date.now(), (Number(remote?.updatedAt) || 0) + 1);
        let size;
        try {
          size = await Dav.pushSubtitle(cfg, doc, subRequestOptions());
        } catch (error) {
          // subs/ 目录被人删了：建回来再传一次
          if (![404, 409].includes(Number(error?.status))) throw error;
          await Dav.mkcol(cfg, "subs");
          size = await Dav.pushSubtitle(cfg, doc, subRequestOptions());
        }
        index[item.id] = Dav.subsIndexEntry(doc, size);
        done.set(item.id, { hash: doc.hash, remoteAt: doc.updatedAt });
        result.pushed += 1;
      } catch (error) {
        failures.set(item.id, error);
      }
    }
    // 索引读-改-写：只改这一批自己的条目，其它电脑写入的原样保留
    const changed = [...done.keys()].filter((id) => index[id] !== before[id]);
    if (changed.length) {
      try {
        index = await Dav.pushSubsIndex(cfg, index, subRequestOptions());
      } catch (error) {
        // 索引没写成：这些视频留在队列里下次重来（重传同一份内容，结果一样）
        index = before;
        for (const id of changed) {
          done.delete(id);
          failures.set(id, error);
        }
        result.pushed = 0;
        result.deleted = 0;
      }
    }
    result.indexFresh = true;
  }

  result.failed = failures.size;
  const byId = new Map(items.map((item) => [item.id, item]));
  await updateSubsState(dav, (next) => {
    if (index) {
      next.index = index;
      next.indexAt = Date.now();
    }
    if (dirReady) next.dirReady = true;
    const sameRequest = (id) => next.pending[id] && next.pending[id].tag === byId.get(id)?.tag;
    for (const item of settled) {
      if (sameRequest(item.id)) delete next.pending[item.id];
    }
    for (const [id, info] of done) {
      if (info.deleted) delete next.files[id];
      else next.files[id] = info;
      if (sameRequest(id)) delete next.pending[id];
    }
    for (const [id, error] of failures) {
      if (!sameRequest(id)) continue;
      next.pending[id].tries = (Number(next.pending[id].tries) || 0) + 1;
      next.pending[id].error = String(error?.message || error).slice(0, 200);
      next.pending[id].lastTry = Date.now();
    }
  });
  for (const note of notices) announceSubNotice(note);
  if (failures.size) {
    const first = failures.values().next().value;
    appLog("warn", "dav", `字幕备份有 ${failures.size} 个视频没传成：${first?.message || first}；之后的定时同步会自动重试（失败越多间隔越长，最长 1 天），也可以手动「立即同步」`);
  }
  // 全是 0 不写；随整轮 WebDAV 同步做的（quiet）由那一条同步摘要带出
  if (!quiet && (result.pushed || result.deleted)) {
    const bits = [
      result.pushed ? `上传 ${result.pushed} 个` : "",
      result.deleted ? `删除 ${result.deleted} 个` : "",
      result.conflicts ? `冲突副本 ${result.conflicts} 个` : ""
    ].filter(Boolean);
    appLog("info", "dav", `字幕备份：${bits.join("，")}`);
  }
  return result;
}

/**
 * 定时 / 手动同步时顺带做（改标记后的防抖同步不做）：先执行待办队列，再拉一次 subs/index.json
 * 存到本地；队列里有东西时上一步已经读写过索引，不再重复拉。
 */
async function syncSubtitleBackups(settings, { manual = false, quiet = false } = {}) {
  if (!subBackupEnabled(settings)) return { skipped: true };
  const flushed = await flushSubtitleBackups({ settings, manual, quiet });
  if (flushed?.indexFresh) return flushed;
  const cfg = davCfgOf(settings);
  const dav = subsDavKey(cfg);
  const index = await enqueueSubsRemote(() => BiliCaptionDav.pullSubsIndex(cfg, subRequestOptions()));
  await updateSubsState(dav, (state) => {
    state.index = index;
    state.indexAt = Date.now();
  });
  return { ...flushed, indexed: Object.keys(index).length };
}

/**
 * 打开视频加载字幕时调用（loadSubtitles / loadPlatformSubtitles）。需要时从 WebDAV 取回这个视频的备份，
 * 写进本地缓存并返回新条目；不需要或没取到时返回 null，照常走本地缓存 / 官方字幕。
 * - 强制刷新、正在转写或翻译（含强制重新生成）时不拉。
 * - 本地没有受保护缓存：本地索引副本里有这个视频（且不是墓碑）才 GET 一次，受保护条目优先于官方字幕。
 * - 本地已有受保护缓存且远端换了新内容：本机自上次同步后没改过就用远端覆盖；本机没改过字而远端
 *   有改字（例如开同步前就有的转写）也直接换成远端的，并把本机的译文合并进去（合并出新内容时排一次上传）；
 *   其余两边都有变化的情况排一次「冲突」上传，由 runSubsBatch 按「有改字的一方优先」处理，打开视频时不为此发请求。
 */
async function restoreSubtitleBackup(bvid, cid, cached, options = {}) {
  if (options.force || (!bvid && !cid)) return null;
  let settings;
  try {
    settings = await loadSubBackupSettings();
  } catch {
    return null;
  }
  if (!subBackupEnabled(settings)) return null;
  const key = asrCacheKey(bvid, cid);
  if (subtitleCacheBusy(key)) return null;
  const Dav = BiliCaptionDav;
  const cfg = davCfgOf(settings);
  const dav = subsDavKey(cfg);
  const id = Dav.subFileId(bvid, cid);
  const state = await readSubsState(dav);
  const remote = subsRemoteEntry(state, id);
  const localProtected = isSubBackupCandidate(cached);
  if (!remote || remote.deleted) {
    // 开字幕同步之前就有的转写 / 改字：远端没有、也不是被删掉的，排一次补传（不在打开视频时发请求；
    // 上传前会重新读远端索引，那时远端已有这个视频就按冲突规则处理，不直接覆盖）
    if (localProtected && !remote && state.indexAt && !state.files[id] && !state.pending[id]) {
      queueSubtitleBackup(bvid, cid, "backfill").catch(() => {});
    }
    return null;
  }
  // adopt：本机有自己的受保护字幕（自上次同步后变过或从没同步过），却因为远端有改字而本机没有，要换成远端的
  let adopt = false;
  let localDoc = null;
  const queueConflict = () => {
    if (!state.pending[id]) queueSubtitleBackup(bvid, cid, "conflict").catch(() => {});
    return null;
  };
  if (localProtected) {
    const synced = state.files[id];
    if (subsRemoteUnchanged(remote, synced)) return null;
    localDoc = Dav.subtitleBackupDoc(bvid, cid, cached);
    if (remote.hash && remote.hash === localDoc.hash) {
      await updateSubsState(dav, (next) => {
        next.files[id] = { hash: localDoc.hash, remoteAt: Number(remote.updatedAt) || 0 };
      });
      return null;
    }
    if (!synced || synced.hash !== localDoc.hash) {
      if (Number(localDoc.editedAt) > 0 || !(Number(remote.editedAt) > 0)) return queueConflict();
      adopt = true;
    }
  }
  let doc = null;
  try {
    doc = await Dav.pullSubtitle(cfg, bvid, cid, subRequestOptions(Number(options.timeoutMs) || SUB_PULL_TIMEOUT_MS));
  } catch (error) {
    appLog("warn", "dav", `取回字幕备份失败，先用本机字幕：${error.message || error}`, { bvid, cid });
    return null;
  }
  if (!Dav.isSubtitleBackup(doc, bvid, cid)) return null;
  // 本地索引副本是旧的、远端那份其实没有改字：不直接换，交给冲突处理
  if (adopt && subConflictWinner(localDoc, doc) !== "remote") return queueConflict();
  const fromRemote = Dav.subtitleEntryFromBackup(doc, cached);
  const remoteHash = Dav.subtitleBackupDoc(bvid, cid, fromRemote).hash;
  const entry = adopt ? withMergedTranslations(fromRemote, cached) : fromRemote;
  const stored = await replaceCachedAsr(bvid, cid, entry, {
    expectSavedAt: cached?.savedAt
  }).catch(() => null);
  if (!stored) return null;
  await updateSubsState(dav, (next) => {
    next.files[id] = {
      hash: remoteHash,
      remoteAt: Number(doc.updatedAt) || Number(remote.updatedAt) || 0
    };
  });
  // 合并进了本机的译文：本机这份比远端多，排一次上传（远端还是上次同步的那份，直接覆盖不算冲突）
  if (entry !== fromRemote) queueSubtitleBackup(bvid, cid, "merge").catch(() => {});
  appLog("info", "dav", adopt
    ? `本机这份字幕没改过字，已换成 WebDAV 上改过字的版本（${stored.cues.length} 条）`
    : `已从 WebDAV 取回字幕备份（${stored.cues.length} 条）`, { bvid, cid, cues: stored.cues.length });
  return stored;
}
