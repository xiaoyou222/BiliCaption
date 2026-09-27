// 后台 · 本地缓存：字幕缓存（asr:*）、转写进度（asrJob:*）的读写与按数量 / 体积淘汰，
// 清理单个视频的全部缓存，以及跟着字幕缓存淘汰的大纲缓存。

// 大纲缓存（outline:v2:*）和 asrIndex:* 以前只增不删。字幕缓存 asr:* 由 pruneAsrCache 按数量 + 体积淘汰，
// 这里跟着它走：对应的字幕缓存已被淘汰的大纲 / 索引一并删除；大纲另有数量和体积上限兜底。
// 旧版 outline:bvid:cid（非 v2）已无人读取，顺手清掉。只列键名，不把整库读进内存。
const OUTLINE_CACHE_MAX = 60;
const OUTLINE_CACHE_MAX_BYTES = 2 * 1024 * 1024;

async function pruneAuxCache() {
  let keys;
  try {
    // 与 WebDAV 同步共用 lib/webdav.js 的实现
    keys = await BiliCaptionDav.listLocalKeys();
  } catch {
    return { removed: 0 };
  }
  const present = new Set(keys);
  const drop = [];
  const outlines = [];
  const indexKeys = keys.filter((key) => key.startsWith("asrIndex:"));
  if (indexKeys.length) {
    const index = await chrome.storage.local.get(indexKeys).catch(() => ({}));
    for (const key of indexKeys) {
      const bvid = key.slice("asrIndex:".length);
      if (!present.has(asrCacheKey(bvid, index[key]))) drop.push(key);
    }
  }
  for (const key of keys) {
    if (key.startsWith("outline:v2:")) {
      const [bvid = "", cid = ""] = key.slice("outline:v2:".length).split(":");
      if (!present.has(asrCacheKey(bvid, Number(cid) || 0))) drop.push(key);
      else outlines.push(key);
    } else if (key.startsWith("outline:")) {
      drop.push(key);
    }
  }
  if (outlines.length) {
    const values = await chrome.storage.local.get(outlines).catch(() => ({}));
    // 大纲记录没有写入时间；能走到这里的都还有字幕缓存，上限只是兜底，超出时从列表前面删起
    const sized = outlines.map((key) => ({ key, size: utf8Size(values[key]) }));
    let total = sized.reduce((sum, item) => sum + item.size, 0);
    while (sized.length > OUTLINE_CACHE_MAX || (total > OUTLINE_CACHE_MAX_BYTES && sized.length > 1)) {
      const gone = sized.shift();
      total -= gone.size;
      drop.push(gone.key);
    }
  }
  if (drop.length) {
    await chrome.storage.local.remove(drop).catch(() => {});
    appLog("info", "cache", `已清理 ${drop.length} 份失效的大纲 / 索引缓存`);
  }
  return { removed: drop.length };
}

function asrCacheKey(bvid, cid) {
  return `asr:${bvid || "bv"}:${cid || 0}`;
}

const ASR_CACHE_MAX = 40;
const ASR_CACHE_MAX_BYTES = 6 * 1024 * 1024;

async function pruneAsrCache(keepKey = "") {
  let all;
  try {
    all = await chrome.storage.local.get(null);
  } catch {
    return;
  }
  const entries = Object.keys(all)
    .filter((key) => key.startsWith("asr:") && !key.startsWith("asrJob:"))
    .map((key) => ({
      key,
      savedAt: Number(all[key]?.savedAt) || 0,
      size: utf8Size(all[key])
    }))
    .sort((a, b) => a.savedAt - b.savedAt);
  const drop = [];
  const takeOldest = () => {
    const idx = entries.findIndex((item) => item.key !== keepKey);
    if (idx < 0) return null;
    return entries.splice(idx, 1)[0];
  };
  while (entries.length > ASR_CACHE_MAX) {
    const gone = takeOldest();
    if (!gone) break;
    drop.push(gone);
  }
  let total = entries.reduce((sum, item) => sum + item.size, 0);
  while (total > ASR_CACHE_MAX_BYTES && entries.length > 1) {
    const gone = takeOldest();
    if (!gone) break;
    drop.push(gone);
    total -= gone.size;
  }
  if (drop.length) {
    await chrome.storage.local.remove(drop.map((item) => item.key)).catch(() => {});
    appLog("info", "asr", `已清理 ${drop.length} 份旧转写缓存`);
  }
}

async function writeLocal(payload) {
  try {
    await chrome.storage.local.set(payload);
    return true;
  } catch (error) {
    if (!/quota|resource|full/i.test(error?.message || "")) throw error;
    return false;
  }
}

/** 读缓存只读：切句在转写每段时已用词级时间戳做过一次，这里不再整理、也不写回 */
async function loadCachedAsr(bvid, cid) {
  const key = asrCacheKey(bvid, cid);
  const data = await chrome.storage.local.get(key);
  return data[key] || null;
}

async function writeCachedAsr(key, bvid, cid, payload) {
  const data = await chrome.storage.local.get(key);
  const prev = data[key] || null;
  let cues = payload.cues || [];
  let source = payload.source || "";
  let activeLan = payload.activeLan || "";
  const writingAsr = source === "groq" || activeLan === "groq-asr";
  const prevTranslated = prev?.source === "translated" || prev?.activeLan === "translated";
  if (writingAsr && prevTranslated && prev?.cues?.length && cues.length) {
    cues = BiliCaptionCueTools.preserveTranslatedCues(cues, prev.cues);
    if (cues.some((cue, i) => cue.content !== payload.cues[i]?.content)) {
      source = "translated";
      activeLan = "translated";
    }
  }
  const stored = {
    ...(prev || {}),
    ...payload,
    cues,
    source,
    activeLan,
    savedAt: Date.now()
  };
  const keyPayload = { [key]: stored };
  if (bvid) keyPayload[`asrIndex:${bvid}`] = cid;
  if (!(await writeLocal(keyPayload))) {
    await pruneAsrCache(key);
    if (!(await writeLocal(keyPayload))) {
      appLog("warn", "asr", "字幕缓存写入失败，已跳过以免打断转写", { bvid, cid });
    }
  }
  return stored;
}

async function saveCachedAsr(bvid, cid, payload) {
  const key = asrCacheKey(bvid, cid);
  // 分段转写和批量翻译可能同时回写同一个视频。所有 read-modify-write
  // 必须按视频串行，否则二者同时读到旧值时，较晚完成的一次会覆盖翻译或新分片。
  const previous = asrCacheWrites.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => writeCachedAsr(key, bvid, cid, payload));
  asrCacheWrites.set(key, current);
  try {
    return await current;
  } finally {
    if (asrCacheWrites.get(key) === current) asrCacheWrites.delete(key);
  }
}

function isOfficialSubtitleSource(source) {
  return source === "bilibili" || source === "youtube" || source === "x";
}

function shouldUseSubtitleCache(cached, force) {
  if (!cached?.cues?.length) return false;
  if (force && isOfficialSubtitleSource(cached.source) && cached.partial !== true) return false;
  return true;
}

async function persistOfficialSubtitleCache(bvid, cid, payload, existing, options = {}) {
  const cues = payload?.cues || [];
  const source = payload?.source || "";
  if (!cues.length || !isOfficialSubtitleSource(source)) return null;
  const prev = existing === undefined ? await loadCachedAsr(bvid, cid) : existing;
  if (!options.overwrite) {
    if (prev?.cues?.length && !isOfficialSubtitleSource(prev.source)) return null;
    if (prev?.partial && prev?.cues?.length) return null;
  }
  return saveCachedAsr(bvid, cid, {
    cues,
    activeLan: payload.activeLan || "",
    source,
    partial: false,
    ...(payload.title ? { title: payload.title } : {}),
    ...(payload.titleFull ? { titleFull: payload.titleFull } : {}),
    ...(payload.up ? { up: payload.up } : {}),
    ...(payload.pic ? { pic: payload.pic } : {}),
    ...(Number(payload.durationMeta) > 0 ? { durationMeta: Number(payload.durationMeta) } : {}),
    ...(Array.isArray(payload.tracks) && payload.tracks.length ? { tracks: payload.tracks } : {})
  });
}

async function clearVideoCache(bvid, cid) {
  const asr = findAsrJob({ bvid, cid });
  const translation = findTranslateJob({ bvid, cid });
  asr?.controller?.abort();
  translation?.controller?.abort();

  // 删除本插件写入的字幕缓存（含官方 CC 副本）、转写进度、翻译任务和大纲。
  // 平台字幕接口本身不是缓存；asr: 缺失后 loadSubtitles 会重新拉官方字幕。
  // 先让任务的取消清理和最后一次部分结果落盘结束，再在同一写队列之后删除，
  // 保证“清理缓存”不会过几百毫秒又被后台任务写回来。
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!findAsrJob({ bvid, cid }) && !findTranslateJob({ bvid, cid })) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const key = asrCacheKey(bvid, cid);
  await asrCacheWrites.get(key)?.catch(() => {});
  await chrome.storage.local.remove([
    key,
    asrJobKey(bvid, cid),
    translateJobStoreKey(bvid, cid),
    `outline:${bvid || ""}:${Number(cid) || 0}`,
    `outline:v2:${bvid || ""}:${Number(cid) || 0}`
  ]);
  return { ok: true };
}

function asrJobKey(bvid, cid) {
  return `asrJob:${bvid || "bv"}:${cid || 0}`;
}

async function loadAsrJob(bvid, cid) {
  const key = asrJobKey(bvid, cid);
  const data = await chrome.storage.local.get(key);
  return data[key] || null;
}

async function saveAsrJob(bvid, cid, payload) {
  const key = asrJobKey(bvid, cid);
  const data = {
    [key]: {
      ...payload,
      savedAt: Date.now()
    }
  };
  if (!(await writeLocal(data))) {
    await pruneAsrCache();
    if (!(await writeLocal(data))) {
      appLog("warn", "asr", "转写进度写入失败，已跳过以免打断任务", { bvid, cid });
    }
  }
}

async function clearAsrJob(bvid, cid) {
  await chrome.storage.local.remove(asrJobKey(bvid, cid));
}
