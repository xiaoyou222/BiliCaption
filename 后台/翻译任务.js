// 后台 · 翻译任务：批量翻译的排队、并发、进度广播、存档续跑和译文写回。

// 待续跑任务的索引键；存档超过 6 小时就不再自动续跑。
const TRANSLATE_INDEX_KEY = "trJobIndex";
const TRANSLATE_RESUME_MAX_AGE = 6 * 60 * 60 * 1000;
// 译文持久化节流：运行中最多每 2 秒写一次任务存档和字幕缓存，结束时再写一次。
const TRANSLATE_PERSIST_MS = 2000;
let translateIndexChain = Promise.resolve();

/**
 * SW 启动时续跑被中断的翻译。只读待续跑索引里的任务，且只在该视频的标签页仍打开时续跑，
 * 用户已经离开就不再花 API 费用（记录留着，回到该视频打开侧栏时再接上）。
 */
async function resumePendingTranslateJobs() {
  try {
    const data = await chrome.storage.local.get(TRANSLATE_INDEX_KEY);
    let index = data[TRANSLATE_INDEX_KEY];
    if (!index || typeof index !== "object") index = await rebuildTranslateIndex();
    const keys = Object.keys(index);
    if (!keys.length) return;
    const records = await chrome.storage.local.get(keys);
    const live = [];
    for (const key of keys) {
      const value = records[key];
      const fresh = value?.pending && !value.halted && value.cues?.length
        && Date.now() - (Number(value.savedAt) || 0) < TRANSLATE_RESUME_MAX_AGE;
      if (fresh) live.push(value);
      else await updateTranslateIndex(key, null);
    }
    live.sort((a, b) => (Number(b.savedAt) || 0) - (Number(a.savedAt) || 0));
    for (const value of live) {
      const tabId = await findVideoTab(value);
      if (!tabId) continue;
      // 只等任务建好（会先读一次字幕缓存套回改字），不等翻译跑完
      await resumeStoredTranslate({ ...value, tabId }).catch(() => {});
      break;
    }
  } catch {
    // ignore
  }
}

function translateJobStoreKey(bvid, cid) {
  return `trJob:${bvid || "bv"}:${cid || 0}`;
}

function findTranslateJob({ jobId, tabId, bvid, cid }) {
  if (jobId && translateJobs.has(jobId)) return translateJobs.get(jobId);
  for (const job of translateJobs.values()) {
    if (bvid && job.bvid && job.bvid !== bvid) continue;
    if (cid && job.cid && Number(job.cid) !== Number(cid)) continue;
    if (!bvid && tabId && job.tabId && Number(job.tabId) !== Number(tabId)) continue;
    if (bvid || jobId || tabId) return job;
  }
  return null;
}

/** 查询快照。lite 轮询不带整份 cues；侧栏行数对不上时再要一次完整的。 */
function translateJobSnapshot(job, { withCues = true } = {}) {
  if (!job) return { running: false };
  return {
    running: true,
    jobId: job.jobId,
    tabId: job.tabId || 0,
    bvid: job.bvid || "",
    cid: job.cid || 0,
    ...(job.progress || {}),
    cueCount: (job.cues || []).length,
    ...(withCues && job.cues?.length ? { cues: job.cues } : {})
  };
}

/**
 * 翻译进度广播。运行中只带本批变化的行：patch = [[行索引, 译文, 英文原文], …]，
 * 配合 cueCount 让侧栏确认行数一致再打补丁；整份 cues 只在开始和结束（done / canceled / error）时带。
 */
function trBroadcast(job, extra = {}) {
  const { cues, patch, ...rest } = extra;
  job.progress = { ...(job.progress || {}), ...rest, at: Date.now() };
  delete job.progress.cues;
  delete job.progress.patch;
  broadcast({
    type: "TRANSLATE_PROGRESS",
    tabId: job?.tabId || 0,
    jobId: job?.jobId || "",
    bvid: job?.bvid || "",
    cid: job?.cid || 0,
    ...job.progress,
    ...(cues?.length ? { cues } : {}),
    ...(patch?.length ? { patch } : {}),
    cueCount: (job.cues || []).length
  });
}

async function loadTranslateJob(bvid, cid) {
  const key = translateJobStoreKey(bvid, cid);
  const data = await chrome.storage.local.get(key);
  return data[key] || null;
}

/**
 * 待续跑任务索引：{ [trJob 键]: { bvid, cid, tabId } }。只收可自动续跑的任务，
 * 续跑时按索引取记录，不再把整个 storage.local 读一遍。成员不变时不写。
 */
function updateTranslateIndex(key, entry) {
  const run = async () => {
    const data = await chrome.storage.local.get(TRANSLATE_INDEX_KEY);
    const index = { ...(data[TRANSLATE_INDEX_KEY] || {}) };
    const prev = index[key];
    if (entry) {
      if (prev && prev.bvid === entry.bvid && Number(prev.cid) === Number(entry.cid)
        && Number(prev.tabId) === Number(entry.tabId)) return;
      index[key] = entry;
    } else {
      if (!prev) return;
      delete index[key];
    }
    await chrome.storage.local.set({ [TRANSLATE_INDEX_KEY]: index });
  };
  const current = translateIndexChain.then(run, run);
  translateIndexChain = current.catch(() => {});
  return current;
}

async function saveTranslateJob(job) {
  if (!job?.bvid && !job?.cid) return;
  if (job.userCanceled) {
    await clearTranslateJob(job.bvid, job.cid);
    return;
  }
  const key = translateJobStoreKey(job.bvid, job.cid);
  const pending = job.pending !== false;
  // halted：部分失败或出错后停下的任务。保留进度，但只在用户再点翻译时续跑，不自动花 API 费用。
  const halted = pending && Boolean(job.halted);
  await chrome.storage.local.set({
    [key]: {
      jobId: job.jobId,
      tabId: job.tabId || 0,
      bvid: job.bvid || "",
      cid: job.cid || 0,
      title: job.title || "",
      cues: job.cues || [],
      done: Number(job.done) || 0,
      total: Number(job.total) || 0,
      pending,
      halted,
      pageKey: job.pageKey || "",
      origin: job.origin || "",
      savedAt: Date.now()
    }
  });
  await updateTranslateIndex(key, pending && !halted
    ? { bvid: job.bvid || "", cid: Number(job.cid) || 0, tabId: Number(job.tabId) || 0 }
    : null);
}

async function clearTranslateJob(bvid, cid) {
  const key = translateJobStoreKey(bvid, cid);
  await chrome.storage.local.remove(key);
  await updateTranslateIndex(key, null);
}

/** 旧版本没有索引：只在第一次扫一遍存储补建，之后都走索引。 */
async function rebuildTranslateIndex() {
  const all = await chrome.storage.local.get(null);
  const index = {};
  for (const [key, value] of Object.entries(all || {})) {
    if (!key.startsWith("trJob:") || !value?.pending || value.halted) continue;
    index[key] = { bvid: value.bvid || "", cid: Number(value.cid) || 0, tabId: Number(value.tabId) || 0 };
  }
  await chrome.storage.local.set({ [TRANSLATE_INDEX_KEY]: index });
  return index;
}

/**
 * B 站地址能认出的页面：普通视频带分 P（video:BV…:p），番剧按编号（ep:… / ss:…）；认不出返回空串。
 * 开始翻译时记下，续跑时拿标签页当前地址比对：多 P 换了分 P、番剧换了一集都不算还在这个视频。
 */
function biliPageKey(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ""));
  } catch {
    return "";
  }
  if (!/(^|\.)bilibili\.com$/.test(parsed.hostname)) return "";
  const path = parsed.pathname;
  const bvid = path.match(/\/video\/(BV\w+)/)?.[1] || (/\/list\//.test(path) ? parsed.searchParams.get("bvid") || "" : "");
  if (bvid) return `video:${bvid}:${Math.max(1, Number(parsed.searchParams.get("p")) || 1)}`;
  const ep = path.match(/\/bangumi\/play\/ep(\d+)/)?.[1];
  if (ep) return `ep:${ep}`;
  const ss = path.match(/\/bangumi\/play\/ss(\d+)/)?.[1];
  if (ss) return `ss:${ss}`;
  return "";
}

/** 标签页当前地址的页面标识；读不到标签页返回空串 */
async function tabPageKey(tabId) {
  if (!(Number(tabId) > 0)) return "";
  try {
    const tab = await chrome.tabs.get(Number(tabId));
    return biliPageKey(tab?.url);
  } catch {
    return "";
  }
}

/**
 * 标签页地址是否还在放这个视频（bvid 沿用各平台编号：BV…、yt_…、x_…）。
 * 返回 "yes" / "no"；B 站地址看不出是哪一 P、哪一集时返回 "ask"，由调用方问页面当前播的 cid。
 */
function tabVideoMatch(url, record) {
  const id = String(record?.bvid || "");
  if (!url || !id) return "no";
  const yt = id.match(/^yt_([\w-]{11})$/);
  if (yt) return new RegExp(`[?&]v=${yt[1]}(?:[&#]|$)`).test(url) ? "yes" : "no";
  const x = id.match(/^x_(\d+)_\d$/);
  if (x) return url.includes(`/status/${x[1]}`) ? "yes" : "no";
  const key = biliPageKey(url);
  if (!key) return "no";
  if (key.startsWith("video:") && !key.startsWith(`video:${id}:`)) return "no";
  const want = String(record?.pageKey || "");
  if (want) {
    if (key !== want) return "no";
    // ss 页的地址看不出正在放哪一集
    return key.startsWith("ss:") ? "ask" : "yes";
  }
  // 旧存档没记页面标识：地址只能说明是同一个 BV 或某个番剧页，分 P / 分集要问页面
  return "ask";
}

/** 问页面当前播的是不是这个 cid；页面没有内容脚本或还没读到视频信息都算不是 */
async function tabPlaysCid(tabId, cid) {
  if (!(Number(cid) > 0)) return false;
  try {
    const meta = await chrome.tabs.sendMessage(tabId, { type: "GET_META" });
    return Number(meta?.cid) === Number(cid);
  } catch {
    return false;
  }
}

/** 找仍打开着这个视频的标签页；浏览器重启后 tabId 会变，所以按地址找，原来的标签页优先。 */
async function findVideoTab(record) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: [...BiliCaptionPlatforms.TAB_URL_PATTERNS] });
  } catch {
    tabs = [];
  }
  const same = Number(record?.tabId);
  const list = (Array.isArray(tabs) ? tabs : [])
    .filter((tab) => tab?.id)
    .sort((a, b) => Number(b.id === same) - Number(a.id === same));
  for (const tab of list) {
    const verdict = tabVideoMatch(tab.url, record);
    if (verdict === "yes") return tab.id;
    if (verdict === "ask" && await tabPlaysCid(tab.id, record?.cid)) return tab.id;
  }
  return 0;
}

async function writeTranslatedCache(job) {
  if ((job.bvid || job.cid) && job.cues?.length) {
    // 译文看不出原字幕是官方的还是转写的：本地条目已不在时按发起翻译时记下的来源建条目
    await saveCachedAsr(job.bvid, job.cid, {
      cues: job.cues,
      activeLan: "translated",
      source: "translated"
    }, { originHint: job.origin });
  }
}

/**
 * 发起翻译时这份字幕的来源类别（official / asr），本地条目已不在时建条目用（见 writeCachedAsr）。
 * 本地条目还在就以它为准；否则看侧栏发来的字幕来源（官方轨 / 转写），最后才用侧栏记着的 origin。
 */
function translateOriginHint(input, cached) {
  if (cached?.cues?.length) return BiliCaptionCueTools.subtitleCacheOrigin(cached);
  const source = String(input?.source || "");
  if (BiliCaptionCueTools.isOfficialSubtitleSource(source)) return "official";
  if (source === "groq") return "asr";
  return input?.origin === "official" || input?.origin === "asr" ? input.origin : "";
}

/**
 * 发给页面（浮层字幕）。运行中只发本批变化的行；页面行数对不上（刚刷新、刚切句）时
 * 回 needFull，再补发整份。persisted 表示后台已负责写缓存，页面不必再回传 SAVE_CUES_CACHE。
 */
function sendTranslatedCuesToTab(job, patch) {
  const cues = job?.cues || [];
  if (!job?.tabId || !cues.length) return;
  const base = {
    type: "SYNC_CUES",
    source: "translated",
    activeLan: "translated",
    bvid: job.bvid || "",
    cid: Number(job.cid) || 0,
    persisted: true
  };
  const sendFull = () => chrome.tabs.sendMessage(job.tabId, { ...base, cues: job.cues }).catch(() => {});
  if (!patch?.length) {
    sendFull();
    return;
  }
  chrome.tabs.sendMessage(job.tabId, { ...base, patch, cueCount: cues.length })
    .then((res) => {
      if (res?.needFull) sendFull();
    })
    .catch(() => {});
}

function enqueueTranslateCommit(job, operation) {
  const previous = job.commitChain || Promise.resolve();
  const current = previous.then(operation);
  // 后续批次可以等前一批清理完；当前调用仍拿到原始错误并交给任务统一处理。
  job.commitChain = current.catch(() => {});
  return current;
}

function scheduleTranslatePersist(job) {
  job.persistDirty = true;
  if (job.persistTimer) return;
  job.persistTimer = setTimeout(() => {
    job.persistTimer = 0;
    flushTranslatePersist(job).catch(() => {});
  }, TRANSLATE_PERSIST_MS);
}

/** 把内存里的译文写进任务存档和字幕缓存；写入按任务串行，取消后不再写。 */
function flushTranslatePersist(job) {
  clearTimeout(job.persistTimer);
  job.persistTimer = 0;
  return enqueueTranslateCommit(job, async () => {
    if (!job.persistDirty || job.userCanceled) return;
    job.persistDirty = false;
    await saveTranslateJob(job);
    await writeTranslatedCache(job);
  });
}

async function translateChat(prompt, { apiBase, apiKey, apiModel, provider, signal, system, task = "translate" } = {}) {
  const result = await self.BiliCaptionModelCall.chat({
    base: apiBase,
    key: apiKey,
    model: apiModel,
    provider,
    task,
    prompt,
    system,
    signal,
    // 流式请求：响应头和首段数据很快就到，避开 SW「fetch 超过 30 秒没拿到响应会被终止」的限制，
    // 同时用首字 / 空闲超时代替 90 秒总时限。
    stream: true
  });
  return result.text;
}

/**
 * 翻译一批：带上文（前 3 行原文和已有译文）和视频标题请求一次；
 * 缺号、条数不对或复述英文的行，只把这些行带着错误说明小批再试一次。
 * 返回与 batch 等长的译文数组，没译成的是空串。
 */
async function translateBatch(batch, cues, { apiBase, apiKey, apiModel, provider, signal, title, T }) {
  const config = { apiBase, apiKey, apiModel, provider, signal, system: T.TRANSLATE_SYSTEM };
  const firstIndex = batch[0]?.index ?? 0;
  const raw = await translateChat(T.buildTranslatePrompt(batch, {
    context: T.translateContext(cues, firstIndex),
    title
  }), config);
  const aligned = T.alignTranslatedBatch(batch, raw);
  if (!aligned.missing.length) return aligned.lines;
  const retry = aligned.missing.map((i) => batch[i]);
  let again;
  try {
    const rawAgain = await translateChat(T.buildTranslatePrompt(retry, {
      context: T.translateContext(cues, retry[0].index),
      title,
      note: T.alignRetryNote(retry.length)
    }), config);
    again = T.alignTranslatedBatch(retry, rawAgain);
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") throw error;
    // 对齐重试本身失败：保留第一次已对上的行，剩下的算未翻译。
    return aligned.lines;
  }
  aligned.missing.forEach((i, k) => {
    if (again.lines[k]) aligned.lines[i] = again.lines[k];
  });
  return aligned.lines;
}

async function cancelTranslateJob(jobId, extra = {}) {
  const job = findTranslateJob({ jobId, bvid: extra.bvid, cid: extra.cid, tabId: extra.tabId });
  const bvid = job?.bvid || extra.bvid || "";
  const cid = Number(job?.cid || extra.cid) || 0;
  if (job) {
    job.userCanceled = true;
    job.pending = false;
    job.controller.abort();
    clearTimeout(job.persistTimer);
    job.persistTimer = 0;
    appLog("info", "sum", "已取消翻译", { bvid: job.bvid, cid: job.cid });
  }
  // 排在正在进行的写入之后删除，免得刚删掉又被节流写回来。
  if (job) await enqueueTranslateCommit(job, () => clearTranslateJob(bvid, cid)).catch(() => {});
  else if (bvid || cid) await clearTranslateJob(bvid, cid);
  return Boolean(job);
}

/** 侧栏发现播放位置跳转（拖进度条）时调用：按新位置重排还没派发的批次。 */
function reprioritizeTranslateJob(query = {}) {
  const job = findTranslateJob(query);
  const time = Number(query.time);
  if (!job || !Number.isFinite(time)) return { ok: false };
  job.anchorTime = time;
  job.translateQueue?.reprioritize(time);
  return { ok: true };
}

async function startTranslate(input, sender) {
  const tabId = Number(input.tabId || sender?.tab?.id) || 0;
  const existing = findTranslateJob({
    bvid: input.bvid,
    cid: input.cid,
    tabId
  });
  const anchorTime = Number(input.currentTime) || 0;
  if (existing) {
    if (anchorTime) reprioritizeTranslateJob({ jobId: existing.jobId, time: anchorTime });
    return { started: true, joined: true, ...translateJobSnapshot(existing) };
  }
  // 顺带记下标签页地址的页面标识（分 P / 分集），后台重启后据此判断还在不在这个视频
  const [stored, pageKey, cached] = await Promise.all([
    loadTranslateJob(input.bvid, input.cid),
    tabPageKey(tabId),
    loadCachedAsr(input.bvid, input.cid).catch(() => null)
  ]);
  const origin = translateOriginHint(input, cached);
  if (stored?.pending) {
    // 用户亲自点的翻译：停下的（halted）任务也从存档续上，已译出的行不用重译。
    const resumed = await resumeStoredTranslate({
      ...stored,
      halted: false,
      tabId: tabId || stored.tabId,
      title: input.title || stored.title,
      pageKey: pageKey || stored.pageKey || "",
      origin: stored.origin || origin,
      anchorTime
    });
    if (resumed) return { started: true, joined: true, ...translateJobSnapshot(resumed) };
  }

  const T = self.BiliCaptionTranslate;
  const { cues, targets } = T.prepareCues(input.cues || []);
  if (!targets.length) return { empty: true, cues };

  const jobId = String(input.jobId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const controller = new AbortController();
  const job = {
    jobId,
    controller,
    tabId,
    bvid: input.bvid || "",
    cid: Number(input.cid) || 0,
    title: String(input.title || ""),
    pageKey,
    origin,
    anchorTime,
    cues,
    done: 0,
    total: targets.length,
    originTotal: targets.length,
    pending: true,
    progress: {
      stage: "run",
      running: true,
      done: 0,
      total: targets.length,
      partial: true
    }
  };
  translateJobs.set(jobId, job);
  runTranslateJob(job, targets).catch(() => {});
  return { started: true, jobId, done: 0, total: targets.length, stage: "run", cues };
}

async function resumeStoredTranslate(stored) {
  if (!stored?.pending || stored.halted || !stored.cues?.length) return null;
  // 翻译停下后用户可能又改过字：存档里的字幕是停下时的样子，先把缓存里改过的行套回来再续跑。
  // 读缓存放在查重之前，查重到建任务之间不能有 await，否则两次续跑会各建一个任务。
  const cached = await loadCachedAsr(stored.bvid, stored.cid).catch(() => null);
  const live = findTranslateJob({ bvid: stored.bvid, cid: stored.cid, jobId: stored.jobId });
  if (live) return live;
  const T = self.BiliCaptionTranslate;
  const base = cached?.cues?.length
    ? BiliCaptionCueTools.keepEditedCues(stored.cues, cached.cues)
    : stored.cues;
  const { cues, targets } = T.prepareCues(base);
  if (!targets.length) {
    await clearTranslateJob(stored.bvid, stored.cid);
    return null;
  }
  const jobId = String(stored.jobId || `${Date.now()}-resume`);
  const job = {
    jobId,
    controller: new AbortController(),
    tabId: Number(stored.tabId) || 0,
    bvid: stored.bvid || "",
    cid: Number(stored.cid) || 0,
    title: String(stored.title || ""),
    pageKey: String(stored.pageKey || ""),
    origin: translateOriginHint(stored, cached),
    anchorTime: Number(stored.anchorTime) || 0,
    cues,
    done: Number(stored.done) || Math.max(0, (Number(stored.total) || 0) - targets.length),
    total: Number(stored.total) || (Number(stored.done) || 0) + targets.length,
    pending: true,
    progress: {
      stage: "run",
      running: true,
      done: Number(stored.done) || 0,
      total: Number(stored.total) || targets.length,
      partial: true
    }
  };
  translateJobs.set(jobId, job);
  runTranslateJob(job, targets).catch(() => {});
  return job;
}

async function getTranslateJobStatus(query = {}) {
  const withCues = query.lite !== true;
  const live = findTranslateJob(query);
  if (live) return translateJobSnapshot(live, { withCues });
  if (query.bvid || query.cid) {
    const stored = await loadTranslateJob(query.bvid, query.cid);
    // 侧栏正打开着这个视频才会来问；停下的（halted）任务不自动续跑，等用户再点。
    if (stored?.pending && !stored.halted) {
      const job = await resumeStoredTranslate({
        ...stored,
        tabId: Number(query.tabId) || stored.tabId,
        pageKey: stored.pageKey || await tabPageKey(query.tabId),
        anchorTime: query.currentTime
      });
      if (job) return translateJobSnapshot(job, { withCues });
    }
  }
  return { running: false };
}

/** 待派发批次队列：按播放位置排序，播放位置跳转时重排还没派出去的批次。 */
function createTranslateQueue(job, cues, targets, T) {
  let pending = T.planTranslateBatches(targets, cues, job.anchorTime);
  return {
    take() {
      return pending.shift() || null;
    },
    size() {
      return pending.length;
    },
    reprioritize(time) {
      pending = T.planTranslateBatches(pending.flat(), cues, time);
    }
  };
}

/**
 * 把一批译文写回内存里的字幕，只广播这一批变化的行，持久化交给节流写入。
 * 不再每批都整份写存档、读写缓存、发整份字幕，开销不再随行数平方增长。
 */
function commitTranslatedBatch(job, cues, batch, lines, T) {
  if (job.failed || job.userCanceled) return 0;
  const patch = [];
  batch.forEach((item, i) => {
    const got = lines[i] || "";
    const cue = cues[item.index];
    if (!got || !cue) return;
    T.stampCueOriginal?.(cue, item.text);
    cue.content = got;
    patch.push([item.index, got, cue.original || ""]);
  });
  if (!patch.length) return 0;
  job.done = (Number(job.done) || 0) + patch.length;
  sendTranslatedCuesToTab(job, patch);
  trBroadcast(job, {
    stage: "run",
    running: true,
    done: job.done,
    total: job.total,
    partial: true,
    patch
  });
  scheduleTranslatePersist(job);
  return patch.length;
}

async function translatePreparedCues(job, cues, targets, { apiBase, apiKey, apiModel, provider, signal, conc, T, title }) {
  if (!targets.length) return { failed: [], errors: [] };
  const Call = self.BiliCaptionModelCall;
  const queue = createTranslateQueue(job, cues, targets, T);
  job.translateQueue = queue;
  const ids = { bvid: job.bvid, cid: job.cid };
  try {
    return await T.runBatchQueue(queue, {
      limit: conc,
      signal,
      baseDelayMs: Number(job.retryBaseMs) || 1500,
      maxDelayMs: 30000,
      isRetryable: (error) => (Call?.isRetryable ? Call.isRetryable(error) : true),
      isFatal: (error) => Boolean(Call?.isFatal?.(error)),
      onRetry: ({ error, tries, wait }) => {
        appLog("warn", "sum", `翻译有一批失败，${Math.max(1, Math.round(wait / 1000))} 秒后第 ${tries} 次重试：${error.message || error}`, ids);
      },
      onRateLimit: (cap) => {
        appLog("warn", "sum", `翻译被限流，并发降到 ${cap}`, ids);
      },
      async worker(batch) {
        throwIfAborted(signal);
        const lines = await translateBatch(batch, cues, { apiBase, apiKey, apiModel, provider, signal, title, T });
        throwIfAborted(signal);
        commitTranslatedBatch(job, cues, batch, lines, T);
      }
    });
  } finally {
    if (job.translateQueue === queue) job.translateQueue = null;
  }
}

async function runTranslateJob(job, targets) {
  const T = self.BiliCaptionTranslate;
  const lockKey = `${job.bvid || "bv"}:${job.cid || 0}`;
  if (translateJobLocks.has(lockKey) && translateJobLocks.get(lockKey) !== job.jobId) {
    translateJobs.delete(job.jobId);
    return;
  }
  translateJobLocks.set(lockKey, job.jobId);
  const { signal } = job.controller;
  // Chrome 会在 SW 空闲 30 秒后终止它；翻译期间定时调扩展 API 重置空闲计时（Chrome 110+）。
  const stopHeartbeat = typeof startWorkerHeartbeat === "function" ? startWorkerHeartbeat() : null;
  let work = targets;

  try {
    const settings = await BiliCaptionPrefs.loadSettings({
      sumProvider: "OpenAI",
      apiBase: "",
      apiKey: "",
      apiModel: "",
      translateModel: "",
      translateConcurrency: 4
    });
    const sumCfg = self.BiliCaptionProviders.resolveSum(settings);
    const apiBase = sumCfg.base;
    const apiKey = sumCfg.key;
    const apiModel = sumCfg.model;
    const provider = sumCfg.provider || "";
    // 翻译模型和主模型一样按读设置时的规则迁移（已下线的换成默认速度档、网关别名只留给自定义），
    // 不能等用户打开设置页才写回，否则这期间每次翻译都打到已下线的模型上
    const migrated = self.BiliCaptionProviders.migrateSum?.(settings) || settings;
    const translateModel = String(migrated.translateModel || apiModel).trim();
    const translateConcurrency = settings.translateConcurrency;
    throwIfAborted(signal);
    if (!apiKey) throw new Error("请先在设置里配置总结服务和 API Key");
    if (!apiBase) throw new Error("请先在设置里填写接口地址");

    const conc = T.clampTranslateConcurrency(translateConcurrency);
    // 本地按句号切开后直接分批翻译。
    job.cues = refineAsrCues(job.cues || []);
    const prepared = T.prepareCues(job.cues);
    job.cues = prepared.cues;
    work = prepared.targets;
    const originTotal = (Number(job.done) || 0) + work.length;
    job.originTotal = originTotal;
    job.total = originTotal;
    job.done = Number(job.done) || 0;
    job.commitChain = Promise.resolve();
    job.pending = true;
    job.halted = false;
    await saveTranslateJob(job);
    // 本地切句后行数可能变了：开始时发一次整份，之后只发补丁。
    sendTranslatedCuesToTab(job);
    trBroadcast(job, {
      stage: "run",
      running: true,
      done: job.done,
      total: job.total,
      cues: job.cues,
      partial: true
    });
    const outcome = await translatePreparedCues(job, job.cues, work, {
      apiBase,
      apiKey,
      apiModel: translateModel,
      provider,
      signal,
      conc,
      T,
      title: job.title
    });
    throwIfAborted(signal);

    const leftover = T.prepareCues(job.cues || []).targets.length;
    const applied = Number(job.done) || 0;
    const lastError = outcome.errors?.length ? outcome.errors[outcome.errors.length - 1] : null;
    job.cues = splitTranslatedCues(job.cues || []);
    // 部分失败：保留存档（halted），用户再点一次只补没译成的行；不自动续跑，免得反复花 API 费用。
    job.pending = leftover > 0;
    job.halted = leftover > 0;
    if (leftover) {
      job.persistDirty = true;
      await flushTranslatePersist(job);
    } else {
      clearTimeout(job.persistTimer);
      job.persistTimer = 0;
      job.persistDirty = false;
      await enqueueTranslateCommit(job, async () => {
        await clearTranslateJob(job.bvid, job.cid);
        await writeTranslatedCache(job);
      });
    }
    sendTranslatedCuesToTab(job);
    const reason = lastError ? `（最后一次错误：${lastError.message || lastError}）` : "";
    const message = leftover
      ? `已翻译 ${applied} 行，${leftover} 行未翻译，可再点一次${reason}`
      : `已翻译 ${applied} 行英文`;
    // 一句都没译成且确实报过错，按失败提示；否则都是完成（可能部分）。
    const stage = !applied && lastError ? "error" : "done";
    appLog(stage === "error" ? "error" : "info", "sum", message, {
      bvid: job.bvid,
      cid: job.cid,
      done: applied,
      total: job.total,
      left: leftover
    });
    trBroadcast(job, {
      stage,
      running: false,
      done: applied,
      total: job.total,
      cues: job.cues,
      partial: leftover > 0,
      failed: leftover,
      message
    });
    // 受保护视频（转写、改过字）的译文也一起备份到 WebDAV；官方字幕的译文不传
    if (applied) queueSubtitleBackup(job.bvid, job.cid, "translate").catch(() => {});
  } catch (error) {
    job.failed = true;
    clearTimeout(job.persistTimer);
    job.persistTimer = 0;
    const canceled = signal.aborted || error?.name === "AbortError";
    const leftover = T.prepareCues(job.cues || []).targets.length;
    if (job.userCanceled || !leftover) {
      job.pending = false;
      await enqueueTranslateCommit(job, () => clearTranslateJob(job.bvid, job.cid)).catch(() => {});
      await writeTranslatedCache(job).catch(() => {});
    } else {
      // 非用户取消的中断仍可自动续跑；出错（鉴权、配置等）则停下等用户处理后再点。
      job.pending = true;
      job.halted = !canceled;
      job.persistDirty = true;
      await flushTranslatePersist(job).catch(() => {});
    }
    sendTranslatedCuesToTab(job);
    if (canceled) {
      trBroadcast(job, {
        stage: "canceled",
        running: false,
        done: job.done,
        total: job.total,
        cues: job.cues,
        partial: true,
        message: "已取消翻译，已译出的句子会留着"
      });
      return;
    }
    appLog("error", "sum", error.message || String(error), { bvid: job.bvid, cid: job.cid });
    const kept = Number(job.done) > 0 ? `，已译出的 ${job.done} 行会留着` : "";
    trBroadcast(job, {
      stage: "error",
      running: false,
      done: job.done,
      total: job.total,
      cues: job.cues,
      partial: true,
      failed: leftover,
      message: `${error.message || "翻译失败"}${kept}`
    });
  } finally {
    stopHeartbeat?.();
    clearTimeout(job.persistTimer);
    job.persistTimer = 0;
    if (translateJobLocks.get(lockKey) === job.jobId) translateJobLocks.delete(lockKey);
    translateJobs.delete(job.jobId);
  }
}
