// 后台 · 本地缓存：字幕缓存（asr:*）、转写进度（asrJob:*）的读写与淘汰，
// 清理单个视频的全部缓存，以及跟着字幕缓存淘汰的大纲缓存。
//
// 字幕缓存分两层（判断在 lib/字幕工具.js 的 subtitleCacheOrigin / isProtectedSubtitleCache）：
// - 受保护：转写生成（origin "asr"），或用户手动改过字（editedAt）。不参与自动淘汰，
//   只在用户点「清理本视频缓存」「重新生成」时删除。
// - 可重新生成：官方字幕及其译文、且没改过字。按数量 + 体积淘汰，上限只在这一层之间计算；
//   设置页也可以一键清掉这一层。

// 大纲缓存（outline:v2:*）和 asrIndex:* 跟着字幕缓存走：对应的字幕缓存已不在的大纲 / 索引一并删除；
// 大纲另有数量和体积上限兜底，超出时先删可重新生成视频的大纲，受保护视频的排在最后。
// 旧版 outline:bvid:cid（非 v2）已无人读取，顺手清掉。只列键名，不把整库读进内存。
const OUTLINE_CACHE_MAX = 60;
const OUTLINE_CACHE_MAX_BYTES = 2 * 1024 * 1024;

function outlineAsrKey(key) {
  const [bvid = "", cid = ""] = key.slice("outline:v2:".length).split(":");
  return asrCacheKey(bvid, Number(cid) || 0);
}

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
      if (!present.has(outlineAsrKey(key))) drop.push(key);
      else outlines.push(key);
    } else if (key.startsWith("outline:")) {
      drop.push(key);
    }
  }
  if (outlines.length) {
    const values = await chrome.storage.local.get(outlines).catch(() => ({}));
    const sized = outlines.map((key) => ({ key, size: utf8Size(values[key]), protected: false, savedAt: 0 }));
    let total = sized.reduce((sum, item) => sum + item.size, 0);
    if (sized.length > OUTLINE_CACHE_MAX || total > OUTLINE_CACHE_MAX_BYTES) {
      // 大纲记录没有写入时间：超出上限时先删可重新生成视频的大纲，受保护视频的排在最后；
      // 同一层里按对应字幕缓存的写入时间从旧到新删
      const scan = await scanSubtitleCache(sized.map((item) => outlineAsrKey(item.key))).catch(() => []);
      const meta = new Map(scan.map((item) => [item.key, item]));
      for (const item of sized) {
        const entry = meta.get(outlineAsrKey(item.key));
        item.protected = Boolean(entry?.protected);
        item.savedAt = entry?.savedAt || 0;
      }
      sized.sort((a, b) => Number(a.protected) - Number(b.protected) || a.savedAt - b.savedAt);
    }
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

function isAsrCacheKey(key) {
  return String(key || "").startsWith("asr:");
}

/** asr:<bvid>:<cid> → { bvid, cid }；bvid 里本身可能带冒号，按最后一个冒号切 */
function parseAsrCacheKey(key) {
  const rest = String(key || "").slice("asr:".length);
  const at = rest.lastIndexOf(":");
  if (at < 0) return { bvid: rest, cid: 0 };
  return { bvid: rest.slice(0, at), cid: Number(rest.slice(at + 1)) || 0 };
}

// 可重新生成的字幕缓存上限（受保护条目不占名额、不计体积）。
// 装了 unlimitedStorage 后写入不会再因配额失败，所以新增可再生条目后会主动检查一次（至多每分钟一次）。
const ASR_CACHE_MAX = 40;
const ASR_CACHE_MAX_BYTES = 6 * 1024 * 1024;
const ASR_PRUNE_INTERVAL = 60 * 1000;
const SUBTITLE_SCAN_BATCH = 40;
let asrPruneNextAt = 0;

/**
 * 读出字幕缓存条目的元信息：{ key, savedAt, size, origin, editedAt, protected }。
 * 分批读，不一次把整库字幕都读进内存；读出后只留元信息。
 */
async function scanSubtitleCache(asrKeys) {
  const list = [];
  for (let i = 0; i < asrKeys.length; i += SUBTITLE_SCAN_BATCH) {
    const batch = asrKeys.slice(i, i + SUBTITLE_SCAN_BATCH);
    const values = await chrome.storage.local.get(batch);
    for (const key of batch) {
      const value = values?.[key];
      if (value == null) continue;
      list.push({
        key,
        savedAt: Number(value.savedAt) || 0,
        size: utf8Size(value) + key.length,
        origin: BiliCaptionCueTools.subtitleCacheOrigin(value),
        editedAt: Number(value.editedAt) || 0,
        protected: BiliCaptionCueTools.isProtectedSubtitleCache(value)
      });
    }
  }
  return list;
}

/** 这个视频正在转写 / 翻译或有写入排队：先不删，否则任务下一次回写会把条目又建回来 */
function subtitleCacheBusy(key) {
  if (asrCacheWrites.has(key)) return true;
  const { bvid, cid } = parseAsrCacheKey(key);
  return Boolean(findAsrJob({ bvid, cid }) || findTranslateJob({ bvid, cid }));
}

/** 字幕缓存加起来还没到上限时不必逐条读出来分层（受保护条目也算在内，只会高估） */
async function asrCacheWithinLimits(asrKeys) {
  if (asrKeys.length > ASR_CACHE_MAX) return false;
  const area = chrome.storage.local;
  if (typeof area.getBytesInUse !== "function") return false;
  try {
    return (await area.getBytesInUse(asrKeys)) <= ASR_CACHE_MAX_BYTES;
  } catch {
    return false;
  }
}

/**
 * 删掉一批可重新生成的字幕缓存，连同该视频的大纲、指向它的 asrIndex 和翻译任务存档
 * （留着存档的话，续跑翻译会在没有来源信息的情况下把条目重新建出来）。返回实际删掉的字节数。
 */
async function dropSubtitleEntries(items) {
  if (!items.length) return 0;
  const remove = new Set();
  const trKeys = [];
  const byBvid = new Map();
  for (const { key } of items) {
    const { bvid, cid } = parseAsrCacheKey(key);
    remove.add(key);
    remove.add(`outline:v2:${bvid}:${cid}`);
    remove.add(`outline:${bvid}:${cid}`);
    const trKey = translateJobStoreKey(bvid, cid);
    remove.add(trKey);
    trKeys.push(trKey);
    byBvid.set(`asrIndex:${bvid}`, bvid);
  }
  const index = await chrome.storage.local.get([...byBvid.keys()]).catch(() => ({}));
  for (const [indexKey, bvid] of byBvid) {
    if (index?.[indexKey] != null && remove.has(asrCacheKey(bvid, index[indexKey]))) remove.add(indexKey);
  }
  await chrome.storage.local.remove([...remove]);
  const trIndex = (await chrome.storage.local.get(TRANSLATE_INDEX_KEY).catch(() => ({})))?.[TRANSLATE_INDEX_KEY] || {};
  for (const trKey of trKeys) {
    if (trIndex[trKey]) await updateTranslateIndex(trKey, null).catch(() => {});
  }
  return items.reduce((sum, item) => sum + (item.size || 0), 0);
}

/**
 * 可重新生成的字幕缓存按数量 + 体积从旧到新淘汰；受保护条目（转写、改过字）不参与，也不占名额。
 * keepKey 是正在写入的那条，不删。写入因配额失败时、启动时、新增可再生条目后调用。
 */
async function pruneAsrCache(keepKey = "") {
  let keys;
  try {
    keys = await BiliCaptionDav.listLocalKeys();
  } catch {
    return { removed: 0 };
  }
  const asrKeys = keys.filter(isAsrCacheKey);
  if (await asrCacheWithinLimits(asrKeys)) return { removed: 0 };
  const renewable = (await scanSubtitleCache(asrKeys)).filter((item) => !item.protected);
  let count = renewable.length;
  let total = renewable.reduce((sum, item) => sum + item.size, 0);
  const candidates = renewable
    .filter((item) => item.key !== keepKey && !subtitleCacheBusy(item.key))
    .sort((a, b) => a.savedAt - b.savedAt);
  const drop = [];
  for (const item of candidates) {
    const overCount = count > ASR_CACHE_MAX;
    const overBytes = total > ASR_CACHE_MAX_BYTES && count > 1;
    if (!overCount && !overBytes) break;
    drop.push(item);
    count -= 1;
    total -= item.size;
  }
  if (drop.length) {
    await dropSubtitleEntries(drop).catch(() => {});
    appLog("info", "cache", `已清理 ${drop.length} 份可重新获取的旧字幕缓存`);
  }
  return { removed: drop.length };
}

/** 启动 / 安装时：先按分层规则淘汰字幕缓存，再清理跟着失效的大纲和索引 */
async function pruneLocalCaches() {
  await pruneAsrCache().catch(() => {});
  return pruneAuxCache();
}

/** 新增了一条可重新生成的字幕缓存：不等它，顺手检查一次上限（至多每分钟一次） */
function scheduleAsrCachePrune(keepKey) {
  const now = Date.now();
  if (now < asrPruneNextAt) return;
  asrPruneNextAt = now + ASR_PRUNE_INTERVAL;
  pruneAsrCache(keepKey).catch(() => {});
}

/**
 * 设置页：本地字幕缓存按两层统计条目数（每个视频分 P 一条）和占用字节。
 * 可再生层带上自动淘汰的上限（maxVideos / maxBytes），设置页的进度条和分母以此为准，不在页面里写死。
 */
async function getSubtitleCacheUsage() {
  const keys = await BiliCaptionDav.listLocalKeys();
  const usage = {
    renewable: { videos: 0, bytes: 0, maxVideos: ASR_CACHE_MAX, maxBytes: ASR_CACHE_MAX_BYTES },
    protected: { videos: 0, bytes: 0, asr: 0, edited: 0 }
  };
  for (const item of await scanSubtitleCache(keys.filter(isAsrCacheKey))) {
    const bucket = item.protected ? usage.protected : usage.renewable;
    bucket.videos += 1;
    bucket.bytes += item.size;
    if (item.protected && item.origin === "asr") usage.protected.asr += 1;
    if (item.protected && item.editedAt > 0) usage.protected.edited += 1;
  }
  return usage;
}

/** 设置页「官方字幕与译文」卡片的「清理」：只删可再生条目及其大纲 / asrIndex，受保护条目一条不碰 */
async function clearRenewableSubtitleCache() {
  const keys = await BiliCaptionDav.listLocalKeys();
  const renewable = (await scanSubtitleCache(keys.filter(isAsrCacheKey))).filter((item) => !item.protected);
  const targets = renewable.filter((item) => !subtitleCacheBusy(item.key));
  const bytes = await dropSubtitleEntries(targets);
  if (targets.length) appLog("info", "cache", `已手动清理 ${targets.length} 份可重新生成的字幕缓存`);
  return {
    ok: true,
    removed: targets.length,
    bytes,
    skipped: renewable.length - targets.length,
    usage: await getSubtitleCacheUsage()
  };
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

/** 官方字幕轨的语言代码（translated / groq-asr 不是轨） */
function isTrackLan(lan) {
  return Boolean(lan) && lan !== "translated" && lan !== "groq-asr";
}

function isCacheOrigin(value) {
  return value === "official" || value === "asr";
}

/**
 * 新建条目（本地还没有这个视频）时的来源类别。字幕本身的来源说了算：官方字幕轨 → official，
 * 转写 → asr；译文、页面转来的保存看不出来，用调用方给的 originHint（加载字幕时记下的来源、
 * 发起翻译时侧栏上字幕的来源）。都没有时才按旧条目的规则推断（拿不准的按转写保护）。
 */
function newEntryOrigin(payload, source, hint) {
  if (isOfficialSubtitleSource(source)) return "official";
  if (source === "groq" || payload.activeLan === "groq-asr") return "asr";
  if (isCacheOrigin(hint)) return hint;
  return BiliCaptionCueTools.subtitleCacheOrigin({ ...payload, source });
}

/**
 * options.edited：这次写入是用户在侧栏 / 浮窗手动改字或批量替换（SAVE_CUES_CACHE 带 edited: true），
 * 记下 editedAt。其余写入一律保留已有的 editedAt，并按时间码把改过的行换回来（keepEditedCues）。
 * options.originHint：本地还没有条目时这份字幕的来源类别（见 newEntryOrigin）；已有条目时不用。
 */
async function writeCachedAsr(key, bvid, cid, payload, options = {}) {
  const data = await chrome.storage.local.get(key);
  const prev = data[key] || null;
  const now = Date.now();
  let cues = payload.cues || [];
  let source = payload.source || prev?.source || "";
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
  // 换成另一条官方轨（语言不同）时两份字幕不是一回事，按时间码套改字会串行
  const otherTrack = isTrackLan(prev?.activeLan) && isTrackLan(activeLan) && prev.activeLan !== activeLan;
  if (prev?.cues?.length && cues.length && !otherTrack) {
    cues = BiliCaptionCueTools.keepEditedCues(cues, prev.cues);
  }
  const editedAt = options.edited === true
    ? now
    : Math.max(Number(prev?.editedAt) || 0, Number(payload.editedAt) || 0);
  const stored = {
    ...(prev || {}),
    ...payload,
    cues,
    source,
    activeLan,
    // 来源类别一经写下就跟着条目走：翻译、改字不改变它；转写 / 官方字幕写入时自己带上。
    // 新建条目按这份字幕的实际来源记，不因为是译文或来源没传就落成转写（受保护）
    origin: isCacheOrigin(payload.origin)
      ? payload.origin
      : (prev ? BiliCaptionCueTools.subtitleCacheOrigin(prev) : newEntryOrigin(payload, source, options.originHint)),
    savedAt: now
  };
  if (editedAt > 0) stored.editedAt = editedAt;
  else delete stored.editedAt;
  const keyPayload = { [key]: stored };
  if (bvid) keyPayload[`asrIndex:${bvid}`] = cid;
  if (!(await writeLocal(keyPayload))) {
    await pruneAsrCache(key);
    if (!(await writeLocal(keyPayload))) {
      appLog("warn", "asr", "字幕缓存写入失败，已跳过以免打断转写", { bvid, cid });
    }
  }
  if (!prev && !BiliCaptionCueTools.isProtectedSubtitleCache(stored)) scheduleAsrCachePrune(key);
  return stored;
}

// 分段转写、批量翻译、改字和 WebDAV 取回可能同时写同一个视频。所有 read-modify-write
// 必须按视频串行，否则同时读到旧值时，较晚完成的一次会覆盖翻译或新分片。
async function enqueueAsrCacheWrite(key, write) {
  const previous = asrCacheWrites.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(write);
  asrCacheWrites.set(key, current);
  try {
    return await current;
  } finally {
    if (asrCacheWrites.get(key) === current) asrCacheWrites.delete(key);
  }
}

async function saveCachedAsr(bvid, cid, payload, options = {}) {
  const key = asrCacheKey(bvid, cid);
  const stored = await enqueueAsrCacheWrite(key, () => writeCachedAsr(key, bvid, cid, payload, options));
  // 改字后备份到 WebDAV（10 秒防抖，连续改字合并成一次上传；没开字幕同步时什么都不做）
  if (options.edited === true) queueSubtitleBackup(bvid, cid, "edit").catch(() => {});
  return stored;
}

/**
 * 从 WebDAV 取回的备份：整条替换本地条目，不与旧条目合并（合并会把本机的官方译文套进别人的转写里）。
 * options.expectSavedAt：下载期间本机又写过这条缓存（改字、转写）就放弃，返回 null。
 */
async function replaceCachedAsr(bvid, cid, entry, options = {}) {
  const key = asrCacheKey(bvid, cid);
  return enqueueAsrCacheWrite(key, async () => {
    if ("expectSavedAt" in options) {
      const now = (await chrome.storage.local.get(key))?.[key];
      if ((Number(now?.savedAt) || 0) !== (Number(options.expectSavedAt) || 0)) return null;
    }
    const stored = { ...entry, savedAt: Date.now() };
    const payload = { [key]: stored };
    if (bvid) payload[`asrIndex:${bvid}`] = cid;
    if (!(await writeLocal(payload))) {
      await pruneAsrCache(key);
      if (!(await writeLocal(payload))) return null;
    }
    return stored;
  });
}

function isOfficialSubtitleSource(source) {
  return BiliCaptionCueTools.isOfficialSubtitleSource(source);
}

function isEditedSubtitleCache(cached) {
  return Number(cached?.editedAt) > 0;
}

function shouldUseSubtitleCache(cached, force) {
  if (!cached?.cues?.length) return false;
  // 强制刷新会重拉官方字幕；用户改过字的不重拉，否则改过的字会被官方原文盖掉
  if (force && isOfficialSubtitleSource(cached.source) && cached.partial !== true && !isEditedSubtitleCache(cached)) {
    return false;
  }
  return true;
}

async function persistOfficialSubtitleCache(bvid, cid, payload, existing, options = {}) {
  const cues = payload?.cues || [];
  const source = payload?.source || "";
  if (!cues.length || !isOfficialSubtitleSource(source)) return null;
  const prev = existing === undefined ? await loadCachedAsr(bvid, cid) : existing;
  // 用户改过字的缓存不被官方字幕覆盖（刷新、切换字幕轨都一样），要换回官方原文请清理本视频缓存
  if (isEditedSubtitleCache(prev)) return null;
  if (!options.overwrite) {
    if (prev?.cues?.length && !isOfficialSubtitleSource(prev.source)) return null;
    if (prev?.partial && prev?.cues?.length) return null;
  }
  return saveCachedAsr(bvid, cid, {
    cues,
    activeLan: payload.activeLan || "",
    source,
    origin: "official",
    partial: false,
    ...(payload.title ? { title: payload.title } : {}),
    ...(payload.titleFull ? { titleFull: payload.titleFull } : {}),
    ...(payload.up ? { up: payload.up } : {}),
    ...(payload.pic ? { pic: payload.pic } : {}),
    ...(Number(payload.durationMeta) > 0 ? { durationMeta: Number(payload.durationMeta) } : {}),
    ...(Array.isArray(payload.tracks) && payload.tracks.length ? { tracks: payload.tracks } : {})
  });
}

/**
 * 「清理本视频缓存」。options.deleteRemote：用户在侧栏二次确认过「会同时删除网盘上的字幕备份」才为 true，
 * 这时连同 WebDAV 上的备份一起删；否则只清本机，网盘备份和同步记录都不动（下次打开视频会照常取回）。
 */
async function clearVideoCache(bvid, cid, options = {}) {
  const asr = findAsrJob({ bvid, cid });
  const translation = findTranslateJob({ bvid, cid });
  asr?.controller?.abort();
  translation?.controller?.abort();

  // 删除本插件写入的字幕缓存（含官方 CC 副本）、转写进度、翻译任务和大纲。
  // 这是用户的明确操作：转写结果和改过字的字幕（受保护条目）也照删。
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
  const before = await loadCachedAsr(bvid, cid).catch(() => null);
  await chrome.storage.local.remove([
    key,
    asrJobKey(bvid, cid),
    translateJobStoreKey(bvid, cid),
    `outline:${bvid || ""}:${Number(cid) || 0}`,
    `outline:v2:${bvid || ""}:${Number(cid) || 0}`
  ]);
  // 用户确认过才删 WebDAV 上的字幕备份，并在索引里留墓碑，免得下次打开又被拉回来。
  // 本地先记墓碑再返回，删远端在后台做，不让用户等网络。
  if (options.deleteRemote === true) {
    await forgetSubtitleBackup(bvid, cid, {
      wasProtected: Boolean(before?.cues?.length) && BiliCaptionCueTools.isProtectedSubtitleCache(before)
    }).catch(() => {});
  }
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
