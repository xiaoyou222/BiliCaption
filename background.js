importScripts("lib/md5.js", "lib/wbi.js", "lib/mp4-aac.js", "lib/zh-simp.js", "lib/translate.js", "lib/模型路由.js", "lib/providers.js", "lib/stt.js", "lib/prefs.js", "lib/markers.js", "lib/webdav.js");

const GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3-turbo";
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 400 * 1024 * 1024;
const MAX_CHUNK_SLACK = 15;
const MAX_QUOTA_WAIT_MS = 70 * 60 * 1000;
const LOG_KEY = "appLogs";
const LOG_MAX = 200;

const asrJobs = new Map();
const asrJobLocks = new Map();
const asrCacheWrites = new Map();
const translateJobs = new Map();
const translateJobLocks = new Map();
let appLogs = [];
let appLogsLoaded = false;
let appLogsLoading = null;
let appLogFlushTimer = 0;

function maxCueField(cues, field = "to") {
  let max = 0;
  for (const cue of cues || []) {
    const n = Number(cue?.[field]) || 0;
    if (n > max) max = n;
  }
  return max;
}

function clampCues(cues, max = 8000) {
  if (!Array.isArray(cues)) return [];
  return cues.slice(0, max).map((cue) => {
    const row = {
      ...cue,
      content: String(cue?.content || "").slice(0, 500)
    };
    if (row.original) row.original = String(row.original).slice(0, 500);
    return row;
  });
}

function isExtensionPage(sender) {
  const url = String(sender?.url || "");
  return url.startsWith(`chrome-extension://${chrome.runtime.id}/`);
}

function isBiliContent(sender) {
  const url = String(sender?.url || sender?.tab?.url || "");
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "www.bilibili.com" || host.endsWith(".bilibili.com");
  } catch {
    return false;
  }
}

const CONTENT_MESSAGE_TYPES = new Set([
  "WHOAMI",
  "LOAD_SUBTITLES",
  "GET_LOGIN",
  "SAVE_CUES_CACHE",
  "GET_ASR_JOB",
  "CANCEL_ASR",
  "BOOST_ASR",
  "PAUSE_ASR",
  "RETRY_ASR_CHUNK",
  "FETCH_CUES",
  "GENERATE_ASR",
  "GET_TRANSLATE_JOB",
  "CLOSE_SIDE_PANEL",
  "RESTORE_SIDE_PANEL"
]);

function allowMessage(type, sender) {
  if (isExtensionPage(sender)) return true;
  if (isBiliContent(sender) && CONTENT_MESSAGE_TYPES.has(type)) return true;
  return false;
}

function utf8Size(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value || {})).length;
  } catch {
    return JSON.stringify(value || {}).length;
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function mbOf(bytes) {
  return Math.round((Number(bytes) || 0) / 1024 / 102.4) / 10;
}

function logDetail(extra) {
  if (!extra) return "";
  if (typeof extra === "string") return extra.slice(0, 400);
  const pick = {};
  for (const key of ["status", "ms", "mb", "done", "total", "current", "bvid", "cid", "host", "waitMs", "chunks", "cues", "try"]) {
    if (extra[key] != null && extra[key] !== "") pick[key] = extra[key];
  }
  if (!Object.keys(pick).length) return "";
  try {
    return JSON.stringify(pick).slice(0, 400);
  } catch {
    return "";
  }
}

function ensureAppLogs() {
  if (appLogsLoaded) return Promise.resolve();
  if (!appLogsLoading) {
    appLogsLoading = chrome.storage.local.get(LOG_KEY).then((data) => {
      appLogs = Array.isArray(data[LOG_KEY]) ? data[LOG_KEY].slice(-LOG_MAX) : [];
      appLogsLoaded = true;
    }).catch(() => {
      appLogs = [];
      appLogsLoaded = true;
    });
  }
  return appLogsLoading;
}

function flushAppLogs() {
  if (appLogFlushTimer) {
    clearTimeout(appLogFlushTimer);
    appLogFlushTimer = 0;
  }
  chrome.storage.local.set({ [LOG_KEY]: appLogs.slice(-LOG_MAX) }).catch(() => {});
}

function scheduleLogFlush(immediate) {
  if (immediate) {
    flushAppLogs();
    return;
  }
  if (appLogFlushTimer) return;
  appLogFlushTimer = setTimeout(() => {
    appLogFlushTimer = 0;
    flushAppLogs();
  }, 400);
}

async function appLog(level, scope, message, extra) {
  const entry = {
    t: Date.now(),
    level: level === "error" || level === "warn" ? level : "info",
    scope: String(scope || "app").slice(0, 16),
    message: String(message || "").slice(0, 400),
    detail: logDetail(extra)
  };
  await ensureAppLogs();
  appLogs.push(entry);
  if (appLogs.length > LOG_MAX) appLogs = appLogs.slice(-LOG_MAX);
  chrome.runtime.sendMessage({ type: "APP_LOG", entry }).catch(() => {});
  scheduleLogFlush(entry.level === "error");
  return entry;
}

async function getAppLogs() {
  await ensureAppLogs();
  return appLogs.slice();
}

async function clearAppLogs() {
  await ensureAppLogs();
  appLogs = [];
  flushAppLogs();
  return { ok: true };
}

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.warn("[BiliCaption]", error));

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error("已取消生成");
    error.name = "AbortError";
    throw error;
  }
}

function enableSidePanel(tabId) {
  const options = { enabled: true, path: "sidepanel.html" };
  const task = tabId
    ? chrome.sidePanel.setOptions({ ...options, tabId })
    : chrome.sidePanel.setOptions(options);
  return task.catch(() => {});
}

function enableAllBiliPanels() {
  enableSidePanel();
  chrome.tabs.query({ url: "*://*.bilibili.com/*" }, (tabs) => {
    for (const tab of tabs) enableSidePanel(tab.id);
  });
}

async function installAudioRefererRules() {
  const rule = {
    id: 1001,
    priority: 2,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "Referer", operation: "set", value: "https://www.bilibili.com/" }
      ]
    },
    condition: {
      requestDomains: ["bilivideo.com", "bilivideo.cn", "akamaized.net", "hdslb.com"],
      resourceTypes: ["xmlhttprequest", "other"],
      initiatorDomains: [chrome.runtime.id]
    }
  };
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1001],
      addRules: [rule]
    });
  } catch (error) {
    // 不去掉 initiatorDomains 降级重试：那会把 Referer 改写扩大到全浏览器流量
    console.warn("[BiliCaption] dnr rules", error);
    appLog("warn", "net", `改 Referer 规则安装失败：${error.message || error}`);
  }
}

async function resumePendingTranslateJobs() {
  try {
    const all = await chrome.storage.local.get(null);
    const pending = Object.entries(all)
      .filter(([key, value]) => key.startsWith("trJob:") && value?.pending && value?.cues?.length)
      .map(([, value]) => value)
      .filter((value) => Date.now() - (Number(value.savedAt) || 0) < 6 * 60 * 60 * 1000)
      .slice(0, 1);
    for (const value of pending) {
      resumeStoredTranslate(value).catch(() => {});
    }
  } catch {
    // ignore
  }
}

function injectBiliContentScripts() {
  chrome.tabs.query({ url: "*://*.bilibili.com/*" }, (tabs) => {
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"]
      }).catch(() => {});
    }
  });
}

enableAllBiliPanels();
installAudioRefererRules();
resumePendingTranslateJobs();
chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});
chrome.runtime.onInstalled.addListener(() => {
  enableAllBiliPanels();
  installAudioRefererRules();
  chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});
  injectBiliContentScripts();
});
chrome.runtime.onStartup.addListener(() => {
  enableAllBiliPanels();
  installAudioRefererRules();
  resumePendingTranslateJobs();
});

async function resolvePanelContext(sender) {
  if (sender?.tab?.id) {
    return { tabId: sender.tab.id, windowId: sender.tab.windowId };
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return { tabId: tab?.id, windowId: tab?.windowId };
}

// 关掉已打开的侧栏必须用 close()。setOptions({enabled:false}) 只禁止下次打开，
// 当前面板常常还挂在那里，于是浮窗和侧栏会叠在一起。
function hideChromeSidePanel(tabId, windowId) {
  if (typeof chrome.sidePanel?.close === "function") {
    if (tabId) return chrome.sidePanel.close({ tabId }).catch(() => {});
    if (windowId) return chrome.sidePanel.close({ windowId }).catch(() => {});
    return Promise.resolve();
  }
  if (!tabId) return Promise.resolve();
  return chrome.sidePanel.setOptions({ tabId, enabled: false }).catch(() => {});
}

function showChromeSidePanel(tabId, windowId) {
  if (tabId) enableSidePanel(tabId);
  if (tabId) return chrome.sidePanel.open({ tabId });
  if (windowId) return chrome.sidePanel.open({ windowId });
  return Promise.resolve();
}

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

const DAV_ALARM = "dav-auto-sync";
const DAV_SOON = "dav-sync-soon";
let davTimer = 0;
let davRunning = null;
let davApplying = false;

function davCfgOf(settings) {
  return {
    url: String(settings.davUrl || "").trim(),
    user: String(settings.davUser || "").trim(),
    pass: String(settings.davPass || "")
  };
}

function davLastLabel(at) {
  return self.BiliCaptionDav.formatSyncAgo(at) || "刚刚";
}

async function loadDavSettings() {
  return self.BiliCaptionPrefs.loadSettings({
    syncOn: false,
    syncMarks: true,
    syncConfig: true,
    syncKeys: false,
    davUrl: "",
    davUser: "",
    davPass: "",
    davConfigAt: 0,
    davLast: "",
    sttProvider: "",
    sttModel: "",
    sttChannels: [],
    backupProvider: "",
    sumProvider: "",
    apiBase: "",
    apiModel: "",
    apiKey: "",
    backupKey: "",
    sttCreds: {},
    selKey: "Shift",
    summaryPad: 10,
    translateConcurrency: 4
  });
}

async function runDavSync(reason = "auto") {
  const settings = await loadDavSettings();
  if (!settings.syncOn || !String(settings.davUrl || "").trim()) {
    return { skipped: true };
  }
  if (davRunning) return davRunning;
  davRunning = (async () => {
    davApplying = true;
    try {
      const result = await self.BiliCaptionDav.autoSync(davCfgOf(settings), settings);
      await self.BiliCaptionPrefs.saveSettings({
        davLast: davLastLabel(result.at),
        davAt: result.at
      });
      appLog("info", "dav", `同步完成（${reason}）`, result.marks);
      broadcast({ type: "DAV_SYNCED", reason, ...result });
      return result;
    } catch (error) {
      const message = error.message || String(error);
      appLog("error", "dav", `同步失败：${message}`);
      broadcast({ type: "DAV_SYNC_ERROR", error: message });
      throw error;
    } finally {
      davApplying = false;
      davRunning = null;
    }
  })();
  return davRunning;
}

function scheduleDavSync() {
  clearTimeout(davTimer);
  davTimer = setTimeout(() => {
    runDavSync("debounce").catch(() => {});
  }, 4000);
  try {
    chrome.alarms.create(DAV_SOON, { when: Date.now() + 8000 });
  } catch {
    // alarms 在部分环境不可用
  }
}

function armDavAlarm() {
  try {
    chrome.alarms.create(DAV_ALARM, { periodInMinutes: 15 });
  } catch {
    // ignore
  }
}

chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm?.name === DAV_ALARM || alarm?.name === DAV_SOON) {
    runDavSync(alarm.name).catch(() => {});
  }
});

chrome.runtime.onInstalled?.addListener(() => {
  armDavAlarm();
  runDavSync("install").catch(() => {});
});
chrome.runtime.onStartup?.addListener(() => {
  armDavAlarm();
  runDavSync("startup").catch(() => {});
});

chrome.storage.onChanged?.addListener((changes, area) => {
  if (davApplying) return;
  const keys = Object.keys(changes || {});
  if (area === "local" && keys.some((key) => key === "markerIndex" || key === "markerTrash" || key.startsWith("marks:"))) {
    scheduleDavSync();
    return;
  }
  if (area !== "sync") return;
  if (keys.every((key) => key === "davLast" || key === "davAt")) return;
  if (changes.syncOn?.newValue === false) return;
  if (changes.syncOn?.newValue === true || keys.some((key) => key !== "davLast" && key !== "davAt")) {
    scheduleDavSync();
  }
});

// ---- 通道链：sttChannels 顺序即优先级，前面的限流/失效自动落到后面的 ----

function asrChannelLabel(cfg, fallback = "转写") {
  return self.BiliCaptionProviders.channelLabel(cfg, fallback);
}

function asrChannelState(job, idx) {
  if (!job) return "ok";
  if ((job.deadChannels || []).includes(idx)) return "dead";
  const until = Number(job.channelCools?.[idx]) || 0;
  return until > Date.now() ? "cool" : "ok";
}

/** 从链头找第一个可用通道（高优先级冷却恢复后自动回归） */
function pickAsrChannel(job) {
  const channels = job?.channels || [];
  for (let i = 0; i < channels.length; i += 1) {
    if (asrChannelState(job, i) === "ok") return { cfg: channels[i], idx: i };
  }
  return null;
}

/** 全部通道不可用时：有冷却中的返回最近剩余毫秒，全 dead 返回 0 */
function asrChainRevivalMs(job) {
  const channels = job?.channels || [];
  const now = Date.now();
  let soonest = 0;
  for (let i = 0; i < channels.length; i += 1) {
    if ((job.deadChannels || []).includes(i)) continue;
    const until = Number(job.channelCools?.[i]) || 0;
    if (until > now && (!soonest || until < soonest)) soonest = until;
  }
  return soonest ? Math.max(2000, soonest - now) : 0;
}

function markChannelCool(job, idx, ms) {
  if (!job) return;
  job.channelCools = job.channelCools || [];
  job.channelCools[idx] = Date.now() + Math.max(2000, Number(ms) || 5000);
}

function markChannelDead(job, idx, reason) {
  if (!job) return;
  job.deadChannels = job.deadChannels || [];
  if (!job.deadChannels.includes(idx)) job.deadChannels.push(idx);
  appLog("warn", "asr", `通道 ${idx + 1}（${asrChannelLabel(job.channels?.[idx], "?")}）已停用：${reason || "不可用"}`);
}

function partIsComplete(part) {
  return Boolean(
    part
    && !part.failed
    && (part.complete === true || (Array.isArray(part.cues) && part.cues.length > 0))
  );
}

function snapshotAsrChunks(job, parts, current) {
  const plan = job?.chunkPlan || [];
  const failed = job?.failedChunks || [];
  const total = Math.max(plan.length, (parts || []).length, Number(job?.progress?.total) || 0);
  // 流式转写时后面的分段还没切出来，用视频时长均分兜底，让列表能显示时间范围
  const slice = Number(job?.duration) > 0 && total > 0 ? Number(job.duration) / total : 0;
  const out = [];
  for (let i = 0; i < total; i += 1) {
    const part = parts?.[i];
    const item = plan[i] || {};
    const status = part?.failed || failed.includes(i + 1)
      ? "fail"
      : partIsComplete(part)
        ? "done"
        : (i + 1 === current
          ? (job?.paused ? "pause" : "run")
          : "wait");
    const rawStart = part?.start ?? item.start;
    const rawEnd = Number(item.end) || 0;
    out.push({
      i: i + 1,
      start: rawStart != null && Number.isFinite(Number(rawStart)) ? Number(rawStart) : (slice ? slice * i : 0),
      end: rawEnd > 0 ? rawEnd : (slice ? slice * (i + 1) : 0),
      status
    });
  }
  return out;
}

async function waitIfAsrPaused(job, signal, onProgress, extra = {}) {
  while (job?.paused && !signal?.aborted) {
    emitProgress(onProgress, {
      stage: "pause",
      paused: true,
      message: "已暂停",
      done: extra.done,
      total: extra.total,
      current: extra.current,
      failed: job?.failedChunks || [],
      chunks: snapshotAsrChunks(job, extra.parts, extra.current)
    });
    await sleep(400, signal);
  }
}

function pauseAsrJob(query, paused) {
  const job = findAsrJob(query);
  if (!job) return { error: "没有进行中的转写" };
  job.paused = Boolean(paused);
  jobBroadcast(job, {
    paused: job.paused,
    stage: job.paused ? "pause" : "upload",
    message: job.paused ? "已暂停" : "继续转写",
    chunks: snapshotAsrChunks(job, job.partsRef, job.progress?.current)
  });
  return { ok: true, paused: job.paused };
}

function retryAsrChunks(query, { index } = {}) {
  const job = findAsrJob(query);
  if (!job) return { error: "没有进行中的转写" };
  const parts = job.partsRef || [];
  const queue = job.retryQueue || [];
  const want = [Math.max(0, Number(index) - 1)].filter((i) => parts[i]?.failed);
  if (!want.length) return { error: "没有可重试的分片" };
  for (const i of want) {
    parts[i] = null;
    if (!queue.includes(i)) queue.push(i);
  }
  job.failedChunks = (job.failedChunks || []).filter((n) => !want.includes(n - 1));
  job.retryQueue = queue;
  job.paused = false;
  jobBroadcast(job, {
    paused: false,
    failed: job.failedChunks,
    chunks: snapshotAsrChunks(job, parts, job.progress?.current),
    message: `已重新提交 ${want.length} 片`
  });
  return { ok: true, count: want.length };
}

function asrBoostFlags(job) {
  const idx = Number(job?.activeChannel) || 0;
  return {
    // 通道切换已全自动，不再提供手动加速
    canBoost: false,
    boosted: false,
    usingBackup: (job?.channels?.length || 0) > 1 && idx > 0,
    provider: asrChannelLabel(job?.channels?.[idx] || job?.sttCfg, "")
  };
}

function pickAsrCfg(job, fallbackKey) {
  const picked = pickAsrChannel(job);
  if (picked) {
    if (job) job.activeChannel = picked.idx;
    return picked.cfg;
  }
  if (job?.channels?.length) return null;
  if (!fallbackKey) return null;
  return {
    provider: "Groq",
    kind: "openai",
    base: "https://api.groq.com/openai/v1",
    model: GROQ_MODEL,
    key: fallbackKey,
    creds: { key: fallbackKey }
  };
}

function jobBroadcast(job, extra) {
  const prev = job.progress || {};
  const { job: _ignoreJob, ...safe } = extra || {};
  // done / chunks 一律从 partsRef 现算，避免旧广播残留导致「头部 8/13、列表 0 完成」这种错位
  const partsRef = Array.isArray(job.partsRef) ? job.partsRef : null;
  const doneLive = partsRef ? partsRef.filter(partIsComplete).length : null;
  const done = doneLive != null
    ? doneLive
    : (safe.done != null ? Number(safe.done) || 0 : Number(prev.done) || 0);
  const total = safe.total != null ? Number(safe.total) || 0 : Number(prev.total) || 0;
  const current = Number(safe.current) > 0
    ? Number(safe.current)
    : (Number(prev.current) || 0);
  job.progress = {
    ...prev,
    ...safe,
    done,
    total,
    current,
    cues: safe.cues || prev.cues,
    paused: Boolean(job.paused),
    failed: job.failedChunks || safe.failed || prev.failed || [],
    chunks: partsRef
      ? snapshotAsrChunks(job, partsRef, current)
      : (safe.chunks || prev.chunks),
    ...asrBoostFlags(job),
    at: Date.now()
  };
  const { parts: _parts, partsRef: _partsRef, chunkPlan: _chunkPlan, ...rest } = job.progress;
  broadcast({
    type: "ASR_PROGRESS",
    tabId: job?.tabId || 0,
    jobId: job?.jobId || "",
    bvid: job?.bvid || "",
    cid: job?.cid || 0,
    ...rest,
    cueCount: Array.isArray(rest.cues) ? rest.cues.length : 0
  });
}

function findAsrJob({ jobId, tabId, bvid, cid }) {
  if (jobId && asrJobs.has(jobId)) return asrJobs.get(jobId);
  for (const job of asrJobs.values()) {
    if (bvid && job.bvid && job.bvid !== bvid) continue;
    // 任务刚建、bvid 还没解析出来时，必须 cid 也一致才算同一个视频
    if (bvid && !job.bvid && !(cid && job.cid && Number(job.cid) === Number(cid))) continue;
    if (cid && job.cid && Number(job.cid) !== Number(cid)) continue;
    if (!bvid && tabId && job.tabId && Number(job.tabId) !== Number(tabId)) continue;
    if (bvid || jobId || tabId) return job;
  }
  return null;
}

function getAsrJobStatus(query = {}) {
  const job = findAsrJob(query);
  if (!job) return { running: false };
  return {
    running: true,
    jobId: job.jobId,
    tabId: job.tabId || 0,
    bvid: job.bvid || "",
    cid: job.cid || 0,
    ...(job.progress || {}),
    ...asrBoostFlags(job),
    paused: Boolean(job.paused),
    failed: job.failedChunks || job.progress?.failed || [],
    done: Array.isArray(job.partsRef)
      ? job.partsRef.filter(partIsComplete).length
      : (Number(job.progress?.done) || 0),
    chunks: (Array.isArray(job.partsRef)
      ? snapshotAsrChunks(job, job.partsRef, job.progress?.current)
      : (job.progress?.chunks || []))
  };
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

function translateJobSnapshot(job) {
  if (!job) return { running: false };
  return {
    running: true,
    jobId: job.jobId,
    tabId: job.tabId || 0,
    bvid: job.bvid || "",
    cid: job.cid || 0,
    ...(job.progress || {})
  };
}

function trBroadcast(job, extra) {
  const prev = job.progress || {};
  job.progress = {
    ...prev,
    ...extra,
    cues: extra.cues || prev.cues,
    at: Date.now()
  };
  const { cues, ...rest } = job.progress;
  broadcast({
    type: "TRANSLATE_PROGRESS",
    tabId: job?.tabId || 0,
    jobId: job?.jobId || "",
    bvid: job?.bvid || "",
    cid: job?.cid || 0,
    ...rest,
    ...(cues?.length ? { cues } : {}),
    cueCount: Array.isArray(cues) ? cues.length : 0
  });
}

async function loadTranslateJob(bvid, cid) {
  const key = translateJobStoreKey(bvid, cid);
  const data = await chrome.storage.local.get(key);
  return data[key] || null;
}

async function saveTranslateJob(job) {
  if (!job?.bvid && !job?.cid) return;
  if (job.userCanceled) {
    await clearTranslateJob(job.bvid, job.cid);
    return;
  }
  await chrome.storage.local.set({
    [translateJobStoreKey(job.bvid, job.cid)]: {
      jobId: job.jobId,
      tabId: job.tabId || 0,
      bvid: job.bvid || "",
      cid: job.cid || 0,
      cues: job.cues || [],
      done: Number(job.done) || 0,
      total: Number(job.total) || 0,
      pending: job.pending !== false,
      regrouped: Boolean(job.regrouped),
      savedAt: Date.now()
    }
  });
}

async function clearTranslateJob(bvid, cid) {
  await chrome.storage.local.remove(translateJobStoreKey(bvid, cid));
}

async function syncTranslatedCues(job) {
  const cues = job.cues || [];
  if (job.tabId && cues.length) {
    chrome.tabs.sendMessage(job.tabId, {
      type: "SYNC_CUES",
      cues,
      source: "translated",
      activeLan: "translated",
      bvid: job.bvid || "",
      cid: Number(job.cid) || 0
    }).catch(() => {});
  }
  if ((job.bvid || job.cid) && cues.length) {
    await saveCachedAsr(job.bvid, job.cid, {
      cues,
      activeLan: "translated",
      source: "translated"
    });
  }
}

function enqueueTranslateCommit(job, operation) {
  const previous = job.commitChain || Promise.resolve();
  const current = previous.then(operation);
  // 后续批次可以等前一批清理完；当前调用仍拿到原始错误并交给任务统一处理。
  job.commitChain = current.catch(() => {});
  return current;
}

function defaultChatModel(base, apiModel) {
  if (apiModel) return apiModel;
  if (String(base).includes("siliconflow")) return "Qwen/Qwen2.5-7B-Instruct";
  return "gpt-4o-mini";
}

function chatErrorMessage(json, status) {
  return json?.error?.message || json?.message || `接口错误 ${status}`;
}

async function translateChat(prompt, { apiBase, apiKey, apiModel, signal, system } = {}) {
  const base = String(apiBase || "").replace(/\/$/, "");
  if (!base) throw new Error("请先在设置里填写接口地址");
  const model = defaultChatModel(base, apiModel);
  const route = self.BiliCaptionModelRoute;
  const timeout = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(90000) : null;
  const combined = typeof AbortSignal.any === "function"
    ? AbortSignal.any([signal, timeout].filter(Boolean))
    : signal;
  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      signal: combined,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        ...(route?.requestFields?.(model, "none") || {}),
        messages: [
          { role: "system", content: system || "你是简洁的中文助手。只输出结果，不要客套。" },
          { role: "user", content: prompt }
        ]
      })
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw route?.markError?.(new Error("模型请求超时"), { status: 408 }) || error;
    }
    throw error;
  }
  if (!res.ok) {
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    const error = new Error(chatErrorMessage(json, res.status));
    error.status = res.status;
    throw error;
  }
  let json;
  try {
    json = await res.json();
  } catch (error) {
    throw route?.markError?.(new Error("模型响应不是有效 JSON"), { invalidResponse: true }) || error;
  }
  const content = json.choices?.[0]?.message?.content?.trim() || "";
  if (!content) {
    throw route?.markError?.(new Error("模型响应为空"), { invalidResponse: true }) || new Error("模型响应为空");
  }
  return content;
}

async function translateBatchWithFallback(prompt, batch, config, _job, T) {
  const raw = await translateChat(prompt, config);
  return T.parseTranslatedBatch(raw, batch.length);
}

async function cancelTranslateJob(jobId, extra = {}) {
  const job = findTranslateJob({ jobId, bvid: extra.bvid, cid: extra.cid, tabId: extra.tabId });
  const bvid = job?.bvid || extra.bvid || "";
  const cid = Number(job?.cid || extra.cid) || 0;
  if (job) {
    job.userCanceled = true;
    job.pending = false;
    job.controller.abort();
    appLog("info", "sum", "已取消翻译", { bvid: job.bvid, cid: job.cid });
  }
  if (bvid || cid) await clearTranslateJob(bvid, cid);
  return Boolean(job);
}

async function startTranslate(input, sender) {
  const tabId = Number(input.tabId || sender?.tab?.id) || 0;
  const existing = findTranslateJob({
    bvid: input.bvid,
    cid: input.cid,
    tabId
  });
  if (existing) {
    return { started: true, joined: true, ...translateJobSnapshot(existing) };
  }
  const stored = await loadTranslateJob(input.bvid, input.cid);
  if (stored?.pending) {
    const resumed = await resumeStoredTranslate(stored);
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
    cues,
    done: 0,
    total: targets.length,
    originTotal: targets.length,
    pending: true,
    regrouped: false,
    progress: {
      stage: "run",
      running: true,
      done: 0,
      total: targets.length,
      cues,
      partial: true
    }
  };
  translateJobs.set(jobId, job);
  runTranslateJob(job, targets).catch(() => {});
  return { started: true, jobId, done: 0, total: targets.length, stage: "run", cues };
}

async function resumeStoredTranslate(stored) {
  if (!stored?.pending || !stored.cues?.length) return null;
  const live = findTranslateJob({ bvid: stored.bvid, cid: stored.cid, jobId: stored.jobId });
  if (live) return live;
  const T = self.BiliCaptionTranslate;
  const { cues, targets } = T.prepareCues(stored.cues);
  if (!targets.length) {
    await clearTranslateJob(stored.bvid, stored.cid);
    return null;
  }
  const jobId = String(stored.jobId || `${Date.now()}-resume`);
  const alreadyRegrouped = Boolean(stored.regrouped);
  const job = {
    jobId,
    controller: new AbortController(),
    tabId: Number(stored.tabId) || 0,
    bvid: stored.bvid || "",
    cid: Number(stored.cid) || 0,
    cues,
    done: Number(stored.done) || Math.max(0, (Number(stored.total) || 0) - targets.length),
    total: Number(stored.total) || (Number(stored.done) || 0) + targets.length,
    pending: true,
    regrouped: alreadyRegrouped,
    progress: {
      stage: "run",
      running: true,
      done: Number(stored.done) || 0,
      total: Number(stored.total) || targets.length,
      cues,
      partial: true
    }
  };
  translateJobs.set(jobId, job);
  runTranslateJob(job, targets).catch(() => {});
  return job;
}

async function getTranslateJobStatus(query = {}) {
  const live = findTranslateJob(query);
  if (live) return translateJobSnapshot(live);
  if (query.bvid || query.cid) {
    const stored = await loadTranslateJob(query.bvid, query.cid);
    if (stored?.pending) {
      const job = await resumeStoredTranslate(stored);
      if (job) return translateJobSnapshot(job);
    }
  }
  return { running: false };
}

async function regroupOneChunk(chunk, index, { apiBase, apiKey, apiModel, signal, job, T }) {
  try {
    const raw = await translateChat(T.buildRegroupPrompt(chunk), {
      apiBase,
      apiKey,
      apiModel,
      signal,
      system: T.REGROUP_SYSTEM
    });
    const result = T.applyRegroupText(chunk, raw);
    if (result.fallback) {
      appLog("info", "sum", `断句第 ${index + 1} 块解析失败，保持原句`, {
        bvid: job.bvid,
        cid: job.cid,
        reason: result.reason
      });
    }
    return result.cues;
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") throw error;
    appLog("info", "sum", `断句第 ${index + 1} 块失败，保持原句`, {
      bvid: job.bvid,
      cid: job.cid,
      message: error.message || String(error)
    });
    return chunk;
  }
}

async function translatePreparedCues(job, cues, targets, { apiBase, apiKey, apiModel, signal, conc, T }) {
  if (!targets.length) return;
  const size = 24;
  const batches = [];
  for (let offset = 0; offset < targets.length; offset += size) {
    batches.push(targets.slice(offset, offset + size));
  }
  const total = Number(job.total) || targets.length;
  await T.runPool(batches, conc, async (batch) => {
    throwIfAborted(signal);
    if (job.failed) return;
    const text = batch.map((item, i) => `${i + 1}. ${item.text}`).join("\n");
    const parsed = await translateBatchWithFallback(
      `只把下面的英文字幕译成简体中文。必须保持编号，一行一条，不要解释，不要输出英文原文：\n\n${text}`,
      batch,
      { apiBase, apiKey, apiModel, signal },
      job,
      T
    );
    throwIfAborted(signal);
    if (job.failed) return;
    await enqueueTranslateCommit(job, async () => {
      throwIfAborted(signal);
      if (job.failed) return;
      let added = 0;
      for (let i = 0; i < batch.length; i += 1) {
        const got = T.toSimplified(parsed[i] || "");
        if (!T.looksTranslated(got, batch[i].text)) continue;
        const cue = cues[batch[i].index];
        if (!cue) continue;
        T.stampCueOriginal?.(cue, batch[i].text);
        cue.content = got;
        added += 1;
      }
      job.done = (Number(job.done) || 0) + added;
      job.total = total;
      await saveTranslateJob(job);
      await syncTranslatedCues(job);
      if (job.failed) return;
      trBroadcast(job, {
        stage: "run",
        running: true,
        done: job.done,
        total: job.total,
        cues: job.cues,
        partial: true
      });
    });
  }, signal);
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
    const translateModel = String(settings.translateModel || apiModel).trim();
    const translateConcurrency = settings.translateConcurrency;
    throwIfAborted(signal);
    if (!apiKey) throw new Error("请先在设置里配置总结服务和 API Key");
    if (!apiBase) throw new Error("请先在设置里填写接口地址");

    const conc = T.clampTranslateConcurrency(translateConcurrency);
    // 不再先跑 LLM 断句。2000+ 行时那一步会串行卡死翻译；本地按句号切开后直接批量译。
    job.cues = refineAsrCues(job.cues || []);
    const prepared = T.prepareCues(job.cues);
    job.cues = prepared.cues;
    work = prepared.targets;
    const originTotal = (Number(job.done) || 0) + work.length;
    job.originTotal = originTotal;
    job.total = originTotal;
    const translateCfg = { apiBase, apiKey, apiModel: translateModel, signal, conc, T };
    job.done = Number(job.done) || 0;
    job.commitChain = Promise.resolve();
    job.regrouped = true;
    await saveTranslateJob(job);
    trBroadcast(job, {
      stage: "run",
      running: true,
      done: job.done,
      total: job.total,
      cues: job.cues,
      partial: true
    });
    await translatePreparedCues(job, job.cues, work, translateCfg);
    job.cues = splitTranslatedCues(job.cues || []);

    throwIfAborted(signal);
    await job.commitChain;
    job.cues = splitTranslatedCues(job.cues || []);
    job.pending = false;
    await syncTranslatedCues(job);
    await clearTranslateJob(job.bvid, job.cid);
    const applied = Number(job.done) || 0;
    const left = Math.max(0, job.total - applied);
    const message = left
      ? `已翻译 ${applied} 句，还有 ${left} 句没对上，可再点一次`
      : `已翻译 ${applied} 句英文`;
    appLog("info", "sum", message, { bvid: job.bvid, cid: job.cid, done: applied, total: job.total });
    trBroadcast(job, {
      stage: "done",
      running: false,
      done: applied,
      total: job.total,
      cues: job.cues,
      partial: false,
      message
    });
  } catch (error) {
    job.failed = true;
    const canceled = signal.aborted || error?.name === "AbortError";
    const leftover = T.prepareCues(job.cues || []).targets.length;
    await syncTranslatedCues(job).catch(() => {});
    if (canceled && leftover > 0 && !job.userCanceled) {
      job.pending = true;
      await saveTranslateJob(job).catch(() => {});
    } else {
      job.pending = false;
      await clearTranslateJob(job.bvid, job.cid).catch(() => {});
    }
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
    trBroadcast(job, {
      stage: "error",
      running: false,
      done: job.done,
      total: job.total,
      cues: job.cues,
      partial: true,
      message: error.message || "翻译失败"
    });
  } finally {
    if (translateJobLocks.get(lockKey) === job.jobId) translateJobLocks.delete(lockKey);
    translateJobs.delete(job.jobId);
  }
}

async function fetchJson(url, options = {}) {
  const { headers, ...rest } = options;
  const res = await fetch(url, {
    ...rest,
    credentials: rest.credentials || "include",
    headers: {
      Accept: "application/json, text/plain, */*",
      ...(headers || {})
    }
  });
  if (!res.ok) throw new Error(`请求失败 ${res.status}: ${url}`);
  return res.json();
}

function normalizeSubtitleUrl(url) {
  if (!url) return "";
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("http://")) return url.replace("http://", "https://");
  return url;
}

async function fetchLoginStatus() {
  try {
    const json = await fetchJson("https://api.bilibili.com/x/web-interface/nav");
    const data = json.data || {};
    const isLogin = Boolean(data.isLogin);
    return {
      isLogin,
      mid: data.mid || 0,
      uname: data.uname || "",
      face: data.face || "",
      level: data.level_info?.current_level ?? null,
      vipDueDate: data.vipDueDate || 0,
      vipStatus: data.vipStatus || 0,
      vipType: data.vipType || 0,
      error: ""
    };
  } catch (error) {
    return {
      isLogin: false,
      mid: 0,
      uname: "",
      face: "",
      level: null,
      vipDueDate: 0,
      vipStatus: 0,
      vipType: 0,
      error: error.message || String(error)
    };
  }
}

async function fetchView(bvid) {
  const json = await fetchJson(
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`
  );
  if (json.code !== 0) throw new Error(json.message || "获取视频信息失败");
  return json.data;
}

function collectBangumiEpisodes(result) {
  const list = [];
  const push = (item) => {
    if (item && (item.cid || item.aid || item.bvid)) list.push(item);
  };
  (result?.episodes || []).forEach(push);
  for (const section of result?.section || []) {
    (section.episodes || []).forEach(push);
  }
  return list;
}

function pickBangumiEpisode(result, hint = {}) {
  const all = collectBangumiEpisodes(result);
  if (!all.length) return null;
  const epId = hint.epId || hint.ep_id;
  if (epId) {
    return all.find((item) => String(item.ep_id || item.id) === String(epId)) || null;
  }
  if (hint.cid) {
    return all.find((item) => Number(item.cid) === Number(hint.cid)) || null;
  }
  const last = result?.user_status?.progress?.last_ep_id;
  if (last) {
    return all.find((item) => String(item.ep_id || item.id) === String(last)) || null;
  }
  return null;
}

async function fetchBangumi(input) {
  const epId = typeof input === "object" ? input.epId : input;
  const seasonId = typeof input === "object" ? input.seasonId : "";
  const cid = typeof input === "object" ? input.cid : 0;
  if (!epId && !seasonId) throw new Error("找不到该分集");
  const url = epId
    ? `https://api.bilibili.com/pgc/view/web/season?ep_id=${encodeURIComponent(epId)}`
    : `https://api.bilibili.com/pgc/view/web/season?season_id=${encodeURIComponent(seasonId)}`;
  const json = await fetchJson(url);
  const result = json.result || json.data;
  if (!result) throw new Error(json.message || "获取番剧信息失败");
  const ep = pickBangumiEpisode(result, { epId, cid });
  if (!ep) throw new Error("找不到该分集，请从具体一集进入");
  return {
    title: result.title || "",
    part: ep.long_title || ep.title || "",
    aid: ep.aid,
    cid: ep.cid,
    bvid: ep.bvid || "",
    duration: ep.duration || 0,
    epId: String(ep.ep_id || ep.id || epId || ""),
    pic: ep.cover || result.cover || "",
    up: result.subtitle || result.title || ""
  };
}

async function fetchPlayer(aid, cid) {
  try {
    const query = await BiliCaptionWbi.signQuery({ aid, cid });
    const json = await fetchJson(`https://api.bilibili.com/x/player/wbi/v2?${query}`);
    if (json.code === 0 && json.data) return json.data;
  } catch (error) {
    console.warn("[BiliCaption] wbi player failed", error);
  }
  const json = await fetchJson(`https://api.bilibili.com/x/player/v2?aid=${aid}&cid=${cid}`);
  if (json.code !== 0 || !json.data) {
    throw new Error(json.message || "获取播放器信息失败，请先登录 B 站");
  }
  return json.data;
}

async function fetchDmView(aid, cid) {
  const json = await fetchJson(
    `https://api.bilibili.com/x/v2/dm/view?type=1&oid=${Number(cid) || 0}&pid=${Number(aid) || 0}`,
    {
      headers: {
        Accept: "application/json",
        Referer: "https://www.bilibili.com/"
      }
    }
  );
  if (json.code != null && json.code !== 0) {
    throw new Error(json.message || "获取字幕列表失败");
  }
  return json.data || json.result || json;
}

function mapSubtitleTracks(source) {
  const raw = source?.subtitle?.subtitles || source?.subtitles || [];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => ({
      lan: item.lan || "",
      lanDoc: item.lan_doc || item.lan || "字幕",
      url: item.subtitle_url || "",
      aiType: item.ai_type,
      aiStatus: item.ai_status
    }))
    .filter((item) => item.url);
}

function isAllowedCueHost(url) {
  try {
    const parsed = new URL(normalizeSubtitleUrl(url));
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return (
      host === "bilibili.com"
      || host.endsWith(".bilibili.com")
      || host === "hdslb.com"
      || host.endsWith(".hdslb.com")
      || host === "bilivideo.com"
      || host.endsWith(".bilivideo.com")
      || host.endsWith(".akamaized.net")
    );
  } catch {
    return false;
  }
}

async function fetchCues(url) {
  if (!isAllowedCueHost(url)) throw new Error("字幕地址不在允许的域名内");
  const json = await fetchJson(normalizeSubtitleUrl(url));
  const body = Array.isArray(json?.body) ? json.body : [];
  return refineCues(body
    .map((item, index) => ({
      from: Number(item.from) || 0,
      to: Number(item.to) || 0,
      content: String(item.content || "").replace(/\s+/g, " ").trim(),
      sid: item.sid || index + 1
    }))
    .filter((item) => item.content));
}

function pickDefaultTrack(tracks) {
  const zhAi = tracks.find((t) => t.lan === "ai-zh" || /中文.*自动/.test(t.lanDoc));
  if (zhAi) return zhAi;
  const zh = tracks.find((t) => /zh/.test(t.lan) && !/en/.test(t.lan));
  if (zh) return zh;
  return tracks[0] || null;
}

function asrCacheKey(bvid, cid) {
  return `asr:${bvid || "bv"}:${cid || 0}`;
}

function cueHasCjk(text) {
  return (String(text || "").match(/[\u4e00-\u9fff]/g) || []).length >= 1;
}

function cueOverlap(a, b) {
  return Math.min(Number(a?.to) || 0, Number(b?.to) || 0)
    - Math.max(Number(a?.from) || 0, Number(b?.from) || 0);
}

function mergeTranslatedCues(incoming, existing) {
  const prev = (existing || []).filter((cue) => cueHasCjk(cue.content));
  if (!prev.length) return incoming || [];
  return (incoming || []).map((cue) => {
    if (cueHasCjk(cue.content)) return { ...cue };
    let best = null;
    let bestOverlap = 0;
    for (const item of prev) {
      const overlap = cueOverlap(cue, item);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = item;
      }
    }
    const dur = Math.max(
      0.2,
      Math.min(
        (Number(cue.to) || 0) - (Number(cue.from) || 0),
        best ? (Number(best.to) || 0) - (Number(best.from) || 0) : 0
      )
    );
    if (best && bestOverlap >= dur * 0.45) {
      const original = String(cue.original || cue.content || best.original || "").trim();
      return original
        ? { ...cue, content: best.content, original }
        : { ...cue, content: best.content };
    }
    return { ...cue };
  });
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

async function loadCachedAsr(bvid, cid) {
  const key = asrCacheKey(bvid, cid);
  const data = await chrome.storage.local.get(key);
  const cached = data[key] || null;
  if (!cached?.cues?.length) return cached;
  const translated = cached.source === "translated" || cached.activeLan === "translated";
  const refined = translated ? splitTranslatedCues(cached.cues) : refineCues(cached.cues);
  const changed = refined.length !== cached.cues.length
    || refined.some((cue, i) => cue.content !== cached.cues[i]?.content);
  if (changed) {
    cached.cues = refined;
    await writeLocal({ [key]: { ...cached, savedAt: Date.now() } });
  }
  return cached;
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
    cues = mergeTranslatedCues(cues, prev.cues);
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

async function clearVideoCache(bvid, cid) {
  const asr = findAsrJob({ bvid, cid });
  const translation = findTranslateJob({ bvid, cid });
  asr?.controller?.abort();
  translation?.controller?.abort();

  // 只删本插件写入的转写 / 翻译 / 大纲。B 站 player、dm 官方轨不是缓存，
  // loadSubtitles 在 asr: 缺失后会重新拉官方字幕。
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

function chunkStartKey(start) {
  return Math.round((Number(start) || 0) * 10) / 10;
}

function hydratePart(chunk, saved, index) {
  const duration = Math.max(0, (Number(chunk.end) || 0) - (Number(chunk.start) || 0));
  const cues = (saved?.cues || [])
    .filter((cue) => !(duration > 0) || Number(cue.from) < duration - 0.01)
    .map((cue) => ({
      ...cue,
      from: Math.max(0, Number(cue.from) || 0),
      to: duration > 0
        ? Math.min(duration, Math.max(Number(cue.from) + 0.15, Number(cue.to) || 0))
        : Math.max(Number(cue.from) + 0.15, Number(cue.to) || 0)
    }));
  return {
    i: index,
    start: chunk.start || 0,
    end: chunk.end || 0,
    overlap: chunk.overlap || 0,
    cues,
    complete: true,
    silent: Boolean(saved?.silent)
  };
}

function partCoversChunk(part, chunk) {
  const chunkStart = Number(chunk.start) || 0;
  const chunkEnd = Number(chunk.end) || 0;
  const chunkDur = chunkEnd - chunkStart;
  const savedStart = Number(part?.start) || 0;
  const savedEnd = Number(part?.end) || 0;
  if (
    part?.complete === true
    && chunkDur > 0
    && savedEnd > savedStart
    && Math.abs(savedStart - chunkStart) < 1.5
    && savedEnd >= chunkEnd - 1.5
  ) return true;
  const cues = part?.cues || [];
  if (!cues.length) return false;
  const lastTo = maxCueField(cues);
  const dur = chunkDur;
  if (!(dur > 0)) return false;
  const need = dur > 20 ? Math.max(dur - 8, dur * 0.7) : Math.max(dur * 0.8, dur - 0.4);
  return lastTo >= need;
}

function cuesForChunk(cues, chunk) {
  const start = Number(chunk.start) || 0;
  const end = Number(chunk.end) || 0;
  if (!cues?.length || !(end > start)) return [];
  return cues
    .filter((cue) => Number(cue.from) >= start - 0.8 && Number(cue.from) < end - 0.05)
    .map((cue) => ({
      from: Math.max(0, Number(cue.from) - start),
      to: Math.max(0, Number(cue.to) - start),
      content: cue.content
    }));
}

function matchSavedParts(chunks, saved, cachedCues) {
  const parts = chunks.map(() => null);
  const pool = (saved?.parts || []).filter(partIsComplete);
  const used = new Set();
  const sameLayout = Number(saved?.total) === chunks.length;

  const take = (index, part) => {
    if (parts[index] || !part) return;
    if (!partCoversChunk(part, chunks[index])) return;
    parts[index] = hydratePart(chunks[index], part, index);
    used.add(part);
  };

  if (sameLayout) {
    for (const part of pool) {
      const idx = Number(part.i);
      if (Number.isInteger(idx) && idx >= 0 && idx < chunks.length) take(idx, part);
    }
  }

  for (let i = 0; i < chunks.length; i += 1) {
    if (parts[i]) continue;
    const key = chunkStartKey(chunks[i].start);
    const found = pool.find((part) => !used.has(part) && chunkStartKey(part.start) === key);
    if (found) take(i, found);
  }

  for (let i = 0; i < chunks.length; i += 1) {
    if (parts[i]) continue;
    const start = Number(chunks[i].start) || 0;
    const end = Number(chunks[i].end) || start + 1;
    const found = pool.find((part) => {
      if (used.has(part)) return false;
      const at = Number(part.start) || 0;
      return at >= start - 2 && at < end - 0.05;
    });
    if (found) take(i, found);
  }

  if (sameLayout) {
    const leftover = pool
      .filter((part) => !used.has(part) && partIsComplete(part))
      .sort((a, b) => {
        const ai = Number.isInteger(Number(a.i)) ? Number(a.i) : 1e9;
        const bi = Number.isInteger(Number(b.i)) ? Number(b.i) : 1e9;
        if (ai !== bi) return ai - bi;
        return (Number(a.start) || 0) - (Number(b.start) || 0);
      });
    const holes = [];
    for (let i = 0; i < chunks.length; i += 1) if (!parts[i]) holes.push(i);
    for (let k = 0; k < leftover.length && k < holes.length; k += 1) {
      take(holes[k], leftover[k]);
    }
  }

  if (cachedCues?.length) {
    for (let i = 0; i < chunks.length; i += 1) {
      if (parts[i]) continue;
      const slice = cuesForChunk(cachedCues, chunks[i]);
      if (!slice.length) continue;
      const lastTo = maxCueField(slice);
      const dur = (Number(chunks[i].end) || 0) - (Number(chunks[i].start) || 0);
      const need = dur > 20 ? Math.max(dur - 8, dur * 0.7) : Math.max(dur * 0.8, dur - 0.4);
      if (dur > 0 && lastTo >= need) {
        parts[i] = {
          i,
          start: chunks[i].start || 0,
          overlap: chunks[i].overlap || 0,
          cues: slice,
          complete: true,
          silent: false
        };
      }
    }
  }

  return parts;
}

function resumeChunkPlan(saved, duration, estimated) {
  const savedTotal = Math.max(1, Number(saved?.total) || 0, Number(estimated) || 0);
  const byIndex = new Map();
  for (const part of saved?.parts || []) {
    const idx = Number(part?.i);
    if (Number.isInteger(idx) && idx >= 0) byIndex.set(idx, part);
  }
  const slice = Number(duration) > 0 ? Number(duration) / savedTotal : 0;
  const plan = [];
  for (let i = 0; i < savedTotal; i += 1) {
    const part = byIndex.get(i);
    const start = Number(part?.start);
    const end = Number(part?.end);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      plan.push({ start, end, overlap: Number(part.overlap) || 0 });
    } else {
      plan.push({ start: slice * i, end: slice * (i + 1), overlap: 0 });
    }
  }
  return { plan, total: savedTotal };
}

function seedResumeParts(saved, cachedCues, duration, estimated) {
  const guess = Math.max(1, Number(estimated) || 0);
  if (!saved?.parts?.length && !cachedCues?.length) {
    return { parts: [], total: guess, skipped: 0, plan: [] };
  }
  const { plan, total } = resumeChunkPlan(saved, duration, guess);
  const parts = matchSavedParts(plan, saved, cachedCues);
  while (parts.length < total) parts.push(null);
  return {
    parts,
    total,
    skipped: parts.filter(partIsComplete).length,
    plan
  };
}

function asrChunkLimits(job) {
  const base = {
    maxSeconds: self.BiliCaptionMp4?.CHUNK_SECONDS || 8 * 60,
    maxBytes: self.BiliCaptionMp4?.CHUNK_BYTES || 20 * 1024 * 1024,
    hardDuration: false
  };
  const cfgs = job?.channels?.length
    ? job.channels
    : [job?.sttCfg, job?.backupCfg].filter(Boolean);
  for (const cfg of cfgs) {
    const next = self.BiliCaptionProviders?.sttLimits?.(cfg);
    if (!next) continue;
    base.maxSeconds = Math.min(base.maxSeconds, Number(next.maxSeconds) || base.maxSeconds);
    base.maxBytes = Math.min(base.maxBytes, Number(next.maxBytes) || base.maxBytes);
    base.hardDuration ||= Boolean(next.hardDuration);
  }
  return base;
}

function maxChunkSeconds(job) {
  const limits = asrChunkLimits(job);
  return limits.maxSeconds + (limits.hardDuration ? 1 : MAX_CHUNK_SLACK);
}

function maxChunkBytes(job) {
  return asrChunkLimits(job).maxBytes;
}

/**  Groq 看的是文件大小；时间轴标签不准时不能据此整段报废 */
function chunkFitsLimits(chunk, job) {
  const limits = asrChunkLimits(job);
  const size = Number(chunk?.blob?.size) || 0;
  if (size <= 0 || size > Math.min(MAX_UPLOAD_BYTES, limits.maxBytes)) return false;
  const dur = Number(chunk.end) - Number(chunk.start);
  if (Number.isFinite(dur) && dur > maxChunkSeconds(job)) {
    if (limits.hardDuration) return false;
    const minBytes = dur * 3000;
    if (size >= minBytes) return false;
  }
  return true;
}

function chunkLimitLabel(chunk) {
  const mb = ((Number(chunk?.blob?.size) || 0) / 1024 / 1024).toFixed(1);
  const dur = Number(chunk?.end) - Number(chunk?.start);
  const sec = Number.isFinite(dur) && dur > 0 ? `${Math.round(dur)} 秒` : "时长未知";
  return `${mb}MB / ${sec}`;
}

async function loadSubtitles(page) {
  const login = await fetchLoginStatus();

  if (!page || page.kind === "other") {
    return { page: "other", tracks: [], cues: [], activeLan: "", error: "", login, canGenerate: false };
  }

  let meta;
  if (page.kind === "video") {
    const view = await fetchView(page.bvid);
    const p = Math.max(1, Number(page.p) || 1);
    const part = view.pages?.[p - 1];
    if (!part && view.pages?.length > 1) {
      throw new Error(`找不到第 ${p} P`);
    }
    const cid = Number(page.cid) || part?.cid || (view.pages?.length === 1 ? view.cid : 0);
    if (!cid) throw new Error("无法解析当前分 P，请刷新后再试");
    meta = {
      title: view.title || "",
      part: part?.part && view.pages?.length > 1 ? part.part : "",
      aid: view.aid,
      cid,
      bvid: view.bvid || page.bvid,
      duration: part?.duration || view.duration || 0,
      pic: view.pic || "",
      up: view.owner?.name || ""
    };
  } else if (page.kind === "bangumi") {
    meta = await fetchBangumi(page);
  } else {
    return { page: "other", tracks: [], cues: [], activeLan: "", error: "", login, canGenerate: false };
  }

  let tracks = [];
  let playerError = null;
  let dmViewError = null;
  try {
    tracks = mapSubtitleTracks(await fetchPlayer(meta.aid, meta.cid));
  } catch (error) {
    playerError = error;
    console.warn("[BiliCaption] player failed", error);
  }
  if (!tracks.length && meta.aid && meta.cid) {
    try {
      const dmTracks = mapSubtitleTracks(await fetchDmView(meta.aid, meta.cid));
      if (dmTracks.length) tracks = dmTracks;
    } catch (error) {
      dmViewError = error;
      console.warn("[BiliCaption] dm/view failed", error);
    }
  }

  const preferred = pickDefaultTrack(tracks);
  let cues = [];
  let activeLan = "";
  let source = "";
  let error = "";
  let notice = "";
  let subtitleStatus = "";
  const cached = await loadCachedAsr(meta.bvid, meta.cid);
  const asrJob = await loadAsrJob(meta.bvid, meta.cid);
  const lastCueTo = maxCueField(cached?.cues);
  // 新缓存会明确写 partial=false；长片尾静音不能仅凭最后一句离视频结尾远
  // 就判成断点任务。时长启发式只用于兼容没有 partial 字段的旧缓存。
  const looksIncomplete = cached?.partial == null
    && lastCueTo > 20
    && Number(meta.duration) > 0
    && lastCueTo < Number(meta.duration) - 90;
  const partial = Boolean(
    cached?.partial
    || (asrJob?.parts?.length && asrJob.pending !== false)
    || looksIncomplete
  );
  if (cached?.cues?.length) {
    cues = cached.cues;
    activeLan = cached.activeLan || (cached.source === "translated" ? "translated" : "groq-asr");
    source = cached.source || "groq";
    if (partial) notice = "字幕还没转写完，点「继续生成」会从断点接着传";
  } else if (preferred) {
    cues = await fetchCues(preferred.url);
    activeLan = preferred.lan || "";
    source = "bilibili";
  } else if (login.error) {
    error = `无法确认登录状态：${login.error}`;
    subtitleStatus = "network";
  } else if (!login.isLogin) {
    error = "未登录或登录态无效，B 站通常不返回字幕。请先在浏览器登录 bilibili.com。";
    subtitleStatus = "login";
  } else if (playerError || dmViewError) {
    subtitleStatus = "fetch_failed";
    notice = "没拿到字幕列表";
  } else {
    subtitleStatus = "none";
    notice = "该视频暂无 AI/CC 字幕。";
  }

  return {
    page: "video",
    bvid: meta.bvid,
    aid: meta.aid,
    cid: meta.cid,
    title: meta.title,
    part: meta.part,
    durationMeta: meta.duration || 0,
    pic: meta.pic || "",
    up: meta.up || "",
    tracks,
    activeLan,
    cues,
    login,
    source,
    subtitleStatus,
    canGenerate: true,
    partial,
    asrDone: Math.max(
      Number(asrJob?.done) || 0,
      (asrJob?.parts || []).filter(Boolean).length,
      lastCueTo > 80 ? Math.max(1, Math.round(lastCueTo / (8 * 60))) : 0
    ),
    asrTotal: Number(asrJob?.total) || (Number(meta.duration) > 0 ? Math.ceil(Number(meta.duration) / (8 * 60)) : 0),
    notice,
    error
  };
}

async function fetchPlayurl(meta) {
  const params = {
    bvid: meta.bvid || undefined,
    avid: meta.aid,
    cid: meta.cid,
    qn: 0,
    fnval: 16,
    fourk: 1
  };
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== ""));
  try {
    const query = await BiliCaptionWbi.signQuery(clean);
    const json = await fetchJson(`https://api.bilibili.com/x/player/wbi/playurl?${query}`);
    if (json.code === 0 && json.data) return json.data;
  } catch (error) {
    console.warn("[BiliCaption] wbi playurl failed", error);
    appLog("warn", "bili", `WBI playurl 失败，改走普通接口：${error.message || error}`);
  }
  const qs = new URLSearchParams({
    avid: String(meta.aid),
    cid: String(meta.cid),
    qn: "0",
    fnval: "16",
    fourk: "1"
  });
  if (meta.bvid) qs.set("bvid", meta.bvid);
  const json = await fetchJson(`https://api.bilibili.com/x/player/playurl?${qs}`);
  if (json.code !== 0 || !json.data) {
    const msg = json.message || "获取音频地址失败，请确认已登录且能正常播放";
    appLog("error", "bili", msg, { status: json.code });
    throw new Error(msg);
  }
  return json.data;
}

function pickAudioStream(playurl) {
  const audios = playurl?.dash?.audio;
  if (!Array.isArray(audios) || !audios.length) {
    throw new Error("没有找到可下载的音频流（可能是大会员/地区限制）");
  }
  const sorted = [...audios].sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0));
  // 优先较低码率，更容易压进 Groq 25MB 限制
  return sorted[0];
}

function audioUrls(stream) {
  const urls = [];
  const push = (value) => {
    if (typeof value === "string" && value && !urls.includes(value)) urls.push(value);
  };
  push(stream.baseUrl || stream.base_url || stream.url);
  const backups = stream.backupUrl || stream.backup_url || [];
  if (Array.isArray(backups)) backups.forEach(push);
  else push(backups);
  return urls;
}

async function fetchAudio(url, signal) {
  return fetch(url, {
    credentials: "include",
    signal,
    headers: {
      Referer: "https://www.bilibili.com/"
    }
  });
}

async function openAudioDownload(stream, signal) {
  const urls = audioUrls(stream);
  if (!urls.length) throw new Error("音频地址为空");
  throwIfAborted(signal);

  let res = null;
  let lastStatus = 0;
  for (const url of urls) {
    throwIfAborted(signal);
    const host = hostOf(url);
    try {
      res = await fetchAudio(url, signal);
    } catch (error) {
      lastStatus = 0;
      appLog("warn", "bili", `音频下载中断 ${host || ""}：${error.message || error}`, { host });
      res = null;
      continue;
    }
    lastStatus = res.status;
    if (res.ok) {
      appLog("info", "bili", `开始下载音频 ${host}`, { status: res.status, host });
      break;
    }
    appLog("warn", "bili", `音频地址 HTTP ${res.status} ${host}`, { status: res.status, host });
    res = null;
  }
  if (!res) {
    const msg = `音频下载失败 ${lastStatus || ""}`.trim();
    appLog("error", "bili", msg, { status: lastStatus });
    throw new Error(msg);
  }

  const total = Number(res.headers.get("content-length") || 0);
  if (total && total > MAX_DOWNLOAD_BYTES) {
    throw new Error(`音频约 ${(total / 1024 / 1024).toFixed(1)}MB，文件过大，请换更短视频`);
  }
  return {
    res,
    total,
    mime: stream.mimeType || stream.mime_type || "audio/mp4"
  };
}

function estimatedChunkCount(duration, job) {
  const maxChunk = asrChunkLimits(job).maxSeconds;
  if (!(Number(duration) > 0)) return 1;
  return Math.max(1, Math.ceil(Number(duration) / maxChunk));
}

function audioIsShort(duration, size = 0, job) {
  const maxSec = maxChunkSeconds(job);
  const dur = Number(duration) || 0;
  const bytes = Number(size) || 0;
  if (bytes > Math.min(MAX_UPLOAD_BYTES, maxChunkBytes(job))) return false;
  if (dur > 0) return dur <= maxSec;
  return bytes > 0 && bytes <= maxChunkBytes(job);
}

async function downloadAudio(stream, onProgress, signal) {
  for (let attempt = 0; ; attempt += 1) {
    onProgress?.(attempt ? `音频下载断开，正在重试（第 ${attempt + 1} 次）…` : "正在下载音频…");
    const { res, total, mime } = await openAudioDownload(stream, signal);

    if (!res.body || !total) {
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_DOWNLOAD_BYTES) {
        throw new Error(`音频约 ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB，文件过大，请换更短视频`);
      }
      appLog("info", "bili", `音频下载完成 ${mbOf(buf.byteLength)}MB`, { mb: mbOf(buf.byteLength) });
      return new Blob([buf], { type: mime });
    }

    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    let broken = false;
    while (true) {
      throwIfAborted(signal);
      let piece;
      try {
        piece = await reader.read();
      } catch (error) {
        if (error?.name === "AbortError" || signal?.aborted) throw error;
        broken = true;
        break;
      }
      if (piece.done) break;
      chunks.push(piece.value);
      received += piece.value.byteLength;
      if (received > MAX_DOWNLOAD_BYTES) {
        reader.cancel().catch(() => {});
        throw new Error("音频文件过大，请换更短视频");
      }
      if (total) {
        const pct = Math.min(99, Math.round((received / total) * 100));
        onProgress?.(`正在下载音频… ${pct}%`);
      } else {
        onProgress?.(`正在下载音频… ${(received / 1024 / 1024).toFixed(1)}MB`);
      }
    }
    const incomplete = broken || (total > 0 && received < total - 64 * 1024);
    if (incomplete) {
      appLog("warn", "bili", `音频下载中断 ${mbOf(received)}/${mbOf(total)}MB`, { attempt: attempt + 1 });
      if (attempt >= 2) {
        throw new Error(`音频下载中断（${mbOf(received)}MB/${mbOf(total)}MB），请点「生成字幕」重试`);
      }
      continue;
    }
    const blob = new Blob(chunks, { type: mime });
    appLog("info", "bili", `音频下载完成 ${mbOf(blob.size)}MB`, { mb: mbOf(blob.size) });
    return blob;
  }
}

function guessExt(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("aac")) return "aac";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("wav")) return "wav";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("webm")) return "webm";
  if (m.includes("flac")) return "flac";
  return "m4a";
}

function jobCompatibilityError(cfg) {
  if (!cfg) return "";
  return self.BiliCaptionProviders?.sttCompatibilityError?.(cfg, "m4a") || "";
}

function mergeChunkCues(parts) {
  const all = [];
  for (const part of parts) {
    if (!part?.cues?.length) continue;
    for (const cue of part.cues) {
      const from = Number(cue.from) + part.start;
      const to = Number(cue.to) + part.start;
      const content = String(cue.content || "").trim();
      if (!content) continue;
      // 重叠区不能一刀切掉：上一片末尾可能本来就是静音，盲删会漏掉
      // 下一片开头的第一句话。只在时间相邻且文本确实重复时去重。
      if (part.overlap && from < part.start + part.overlap + 0.35) {
        const normalized = content.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
        const duplicate = [...all].reverse().find((item) => {
          if (Number(item.to) < part.start - 2 || Number(item.from) > to + 0.5) return false;
          const previous = String(item.content || "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
          if (!normalized || !previous) return false;
          if (normalized === previous) return true;
          const shorter = Math.min(normalized.length, previous.length);
          return shorter >= 6 && (normalized.includes(previous) || previous.includes(normalized));
        });
        if (duplicate) {
          if (normalized.length > String(duplicate.content || "").replace(/[\s\p{P}\p{S}]+/gu, "").length) {
            duplicate.content = content;
          }
          duplicate.to = Math.max(Number(duplicate.to) || 0, to);
          continue;
        }
      }
      all.push({
        from,
        to,
        content,
        sid: all.length + 1
      });
    }
  }
  return refineAsrCues(all);
}

function formatWait(ms) {
  const sec = Math.max(1, Math.ceil(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m} 分 ${s} 秒` : `${m} 分钟`;
}

function parseGroqLimit(message) {
  const text = String(message || "");
  const minSec = text.match(/try again in (\d+)m([\d.]+)s/i);
  const secOnly = text.match(/try again in ([\d.]+)s/i);
  let waitMs = 0;
  if (minSec) waitMs = (Number(minSec[1]) * 60 + Number(minSec[2])) * 1000;
  else if (secOnly) waitMs = Number(secOnly[1]) * 1000;
  const requested = Number(text.match(/Requested\s+(\d+)/i)?.[1] || 0);
  return {
    waitMs: Number.isFinite(waitMs) ? waitMs : 0,
    requested,
    hourly: /audio per hour|ASPH|ASH/i.test(text)
  };
}

function parseRetryAfter(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

function groqLimitError(raw, retryAfter = 0) {
  const limit = parseGroqLimit(raw);
  const error = new Error(
    limit.hourly
      ? `Groq 免费档每小时只能转写约 2 小时音频${limit.waitMs ? `，${formatWait(limit.waitMs)} 后自动继续` : ""}`
      : `Groq 额度不足${limit.waitMs ? `，${formatWait(limit.waitMs)} 后自动继续` : ""}`
  );
  error.retryAfter = Math.max(limit.waitMs, Number(retryAfter) || 0);
  error.requested = limit.requested;
  error.hourly = Boolean(limit.hourly);
  error.quota = true;
  return error;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const error = new Error("已取消生成");
      error.name = "AbortError";
      reject(error);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function emitProgress(onProgress, extra) {
  if (!onProgress) return;
  if (typeof extra === "string") {
    onProgress({ message: extra });
    return;
  }
  onProgress(extra);
}

async function waitForQuota(ms, signal, onProgress, extra = {}) {
  const job = extra.job;
  const end = Date.now() + Math.max(2000, ms) + 1500;
  const stopHeartbeat = startWorkerHeartbeat();
  try {
    while (Date.now() < end) {
      throwIfAborted(signal);
      // 有别的通道恢复了就提前结束等待
      if (job && extra.waitKind === "quota" && pickAsrChannel(job)) break;
      const left = end - Date.now();
      emitProgress(onProgress, {
        stage: "wait",
        message: extra.waitKind === "retry"
          ? `${extra.waitReason || "转写暂时繁忙"}，${formatWait(left)} 后重试`
          : `所有通道都在冷却，${formatWait(left)} 后继续`,
        waitUntil: end,
        canBoost: false,
        waitKind: extra.waitKind
      });
      await sleep(Math.min(5000, left), signal);
    }
    emitProgress(onProgress, {
      stage: "upload",
      message: "冷却结束，正在重试当前分段…",
      waitUntil: 0
    });
  } finally {
    stopHeartbeat?.();
  }
}

function sttCallError(error, cfg) {
  const status = Number(error?.status) || 0;
  const raw = error?.message || String(error || "");
  const retryAfter = Number(error?.retryAfter) || 0;
  const waitMs = retryAfter > 0 && retryAfter < 1000 ? retryAfter * 1000 : retryAfter;
  if (status === 429 || /rate limit|quota|try again|额度|限流|ASPH|ASH/i.test(raw)) {
    if (cfg?.provider === "Groq") return groqLimitError(raw, waitMs || retryAfter);
    const next = new Error(`${cfg?.provider || "转写"} 额度不足${waitMs ? `，${formatWait(waitMs)} 后自动继续` : ""}`);
    next.quota = true;
    next.retryAfter = waitMs || 60 * 1000;
    next.status = status;
    return next;
  }
  if ([408, 500, 502, 503, 504].includes(status) || /timeout|unavailable|bad gateway|network|Failed to fetch/i.test(raw)) {
    return groqTransientError(raw, status, status === 429 ? 15000 : 8000);
  }
  return error;
}

function isFatalSttError(error) {
  const status = Number(error?.status) || 0;
  if ([401, 403, 404, 405].includes(status)) return true;
  const raw = String(error?.message || error || "");
  return /未配置转写服务|转写模块未加载|未选择转写服务商|未接通的转写服务|未知服务商|不支持.*音频|无法直接转写|请填写.*(?:API\s*Key|AppID|SecretId|SecretKey)|先填写 API Key|签名.*失败|鉴权|未授权|未开通|invalid api key|incorrect api key|unauthorized|authentication|forbidden|model .*not found/i.test(raw);
}

async function transcribeWithCfg(blob, cfg, options) {
  if (!cfg) throw new Error("未配置转写服务");
  if (cfg.provider === "Groq" && cfg.key) {
    const result = await transcribeWithGroq(blob, { ...options, apiKey: cfg.key, model: cfg.model });
    if (options.job) {
      options.job.lastSttModel = cfg.model || GROQ_MODEL;
      options.job.lastSttProvider = cfg.provider;
    }
    return result;
  }
  const Stt = self.BiliCaptionStt;
  if (!Stt?.transcribe) throw new Error("转写模块未加载");
  const stopHeartbeat = startWorkerHeartbeat();
  let timed;
  try {
    timed = abortAfter(options.signal, 3 * 60 * 1000);
    const result = await Stt.transcribe(blob, cfg, {
      language: options.language,
      signal: timed.signal,
      filename: options.filename,
      duration: options.duration
    });
    if (options.job) {
      options.job.lastSttModel = cfg.model || "";
      options.job.lastSttProvider = cfg.provider || "";
    }
    return result;
  } catch (error) {
    if (error?.name === "AbortError") {
      if (options.signal?.aborted) throw error;
      const timeout = new Error(`${cfg.provider || "转写服务"}响应超时`);
      timeout.status = 504;
      throw sttCallError(timeout, cfg);
    }
    throw sttCallError(error, cfg);
  } finally {
    timed?.cleanup();
    stopHeartbeat?.();
  }
}

function groqTransientError(raw, status, waitMs = 8000) {
  const error = new Error(raw || `Groq 错误 ${status || ""}`.trim());
  error.retryable = true;
  error.retryAfter = waitMs;
  error.status = Number(status) || 0;
  return error;
}

async function transcribeOne(blob, options) {
  let transientTries = 0;
  for (;;) {
    const job = options.job;
    const cfg = pickAsrCfg(job, options.apiKey);
    const channelIdx = Number(job?.activeChannel) || 0;
    const multiChannel = (job?.channels?.length || 0) > 1;
    const label = asrChannelLabel(cfg);

    // 全部通道都不可用：有冷却中的就等最近恢复，全 dead 则报错收尾
    if (!cfg) {
      const revive = asrChainRevivalMs(job);
      if (!revive) {
        throw new Error("所有转写通道都不可用，请在设置里检查通道的 Key 与额度");
      }
      emitProgress(options.onProgress, {
        stage: "wait",
        message: "所有通道都在冷却，等待最近的通道恢复…",
        waitUntil: Date.now() + revive + 1500,
        waitKind: "quota"
      });
      await waitForQuota(revive, options.signal, options.onProgress, { job, waitKind: "quota" });
      continue;
    }

    try {
      appLog("info", "asr", `上传第 ${options.current || 1}/${options.total || 1} 段 ${mbOf(blob.size)}MB · ${label}${multiChannel ? `（通道${channelIdx + 1}）` : ""}`, {
        mb: mbOf(blob.size),
        current: options.current,
        total: options.total,
        try: transientTries + 1
      });
      return await transcribeWithCfg(blob, cfg, options);
    } catch (error) {
      if (error?.name === "AbortError" || options.signal?.aborted) throw error;
      if (Number(error?.requested) > maxChunkSeconds(job) + 20) {
        throw new Error(
          `这一段实际约 ${Math.round(Number(error.requested) / 60)} 分钟，超过约 8 分钟上限，已停下以免浪费额度`
        );
      }

      // 通道自身致命（Key 无效 / 模型不存在等）：停用该通道，立即落向下一条
      if (isFatalSttError(error)) {
        appLog("error", "asr", `${label} 通道不可用：${error.message || String(error)}`, {
          status: error.status,
          current: options.current,
          total: options.total
        });
        markChannelDead(job, channelIdx, error.message || String(error));
        const next = pickAsrChannel(job);
        emitProgress(options.onProgress, {
          stage: "upload",
          message: next
            ? `${label} 不可用，已切到 ${asrChannelLabel(next.cfg)} 继续`
            : `${label} 不可用`,
          waitUntil: 0
        });
        if (next) continue;
        const revive = asrChainRevivalMs(job);
        if (revive) {
          await waitForQuota(revive, options.signal, options.onProgress, { job, waitKind: "quota" });
          continue;
        }
        throw new Error(`所有转写通道都不可用：${error.message || String(error)}`);
      }

      const retryable = Boolean(error?.quota || error?.retryable || error?.retryAfter);
      if (!retryable) {
        appLog("error", "asr", error.message || String(error), {
          status: error.status,
          current: options.current,
          total: options.total
        });
        throw error;
      }
      if (!error?.quota) transientTries += 1;
      if (!error?.quota && transientTries > 6) {
        const giveUp = `${error.message || `${label} 临时故障`}。已保存前面的段落，可点继续生成`;
        appLog("error", "asr", giveUp, { current: options.current, total: options.total, try: transientTries });
        throw new Error(giveUp);
      }
      const transientBackoff = Math.min(
        60 * 1000,
        8000 * (2 ** Math.max(0, transientTries - 1))
      );
      const wait = Math.min(
        Math.max(
          error?.quota
            ? (Number(error.retryAfter) || (error.hourly ? 60 * 60 * 1000 : 5 * 60 * 1000))
            : Math.max(Number(error.retryAfter) || 0, transientBackoff),
          2000
        ),
        error?.quota ? MAX_QUOTA_WAIT_MS : 60 * 1000
      );

      if (error?.quota) {
        // 限流：给该通道记冷却，立即尝试下一条通道；全部冷却才等待
        markChannelCool(job, channelIdx, wait);
        const next = pickAsrChannel(job);
        if (next) {
          const nextLabel = asrChannelLabel(next.cfg);
          appLog("warn", "asr", `${label} 额度冷却 ${formatWait(wait)}，自动切到 ${nextLabel} 继续第 ${options.current || "?"} 段`, {
            waitMs: wait,
            current: options.current,
            total: options.total
          });
          emitProgress(options.onProgress, {
            stage: "upload",
            message: `${label} 限流，已切到 ${nextLabel} 继续（冷却结束自动切回）`,
            waitUntil: 0
          });
          continue;
        }
      }

      const extra = {
        job,
        done: options.done || 0,
        total: options.total || 0,
        current: options.current || 0,
        waitKind: error?.quota ? "quota" : "retry",
        waitReason: error?.quota ? "" : (error.status ? `${label} 错误 ${error.status}` : "网络暂时中断")
      };
      appLog(
        error?.quota ? "warn" : "error",
        "asr",
        error?.quota
          ? `${label} 额度冷却，${formatWait(wait)} 后继续第 ${options.current || "?"} 段`
          : `第 ${options.current || "?"} 段失败（${error.status || "网络中断"}），${formatWait(wait)} 后第 ${transientTries} 次重试：${error.message || "临时故障"}`,
        {
          status: error.status || 0,
          waitMs: wait,
          current: options.current,
          total: options.total,
          try: transientTries
        }
      );
      emitProgress(options.onProgress, {
        stage: "wait",
        message: error?.quota
          ? `所有通道都在冷却，${formatWait(wait)} 后继续`
          : `${label} 繁忙（${error.status || "临时故障"}），${formatWait(wait)} 后重试第 ${options.current || "?"} 段`,
        waitUntil: Date.now() + wait + 1500,
        ...extra
      });
      await waitForQuota(wait, options.signal, options.onProgress, extra);
    }
  }
}

async function persistAsrProgress({ bvid, cid, tabId, fingerprint, parts, total, language, onProgress, job }) {
  const ready = parts.filter(partIsComplete);
  const textParts = ready.filter((item) => item.cues?.length);
  // 总分片数大于 1 时，即使当前只有一个非静音分片，也必须加上
  // 该分片在整条音轨中的 start。否则“前一片静音/失败”时，后一片字幕
  // 会在任务进行期被错写到 00:00。
  let cues = total > 1 ? mergeChunkCues(textParts) : (textParts[0]?.cues || []);
  const pending = ready.length < total;
  await saveAsrJob(bvid, cid, {
    fingerprint,
    parts: ready,
    total,
    done: ready.length,
    pending
  });
  let stored = null;
  if (cues.length) {
    stored = await saveCachedAsr(bvid, cid, {
      cues,
      language: language || "",
      model: job?.lastSttModel || job?.sttCfg?.model || GROQ_MODEL,
      provider: job?.lastSttProvider || job?.sttCfg?.provider || "Groq",
      activeLan: "groq-asr",
      source: "groq",
      partial: pending
    });
    cues = stored.cues || cues;
  }
  if (tabId && cues.length) {
    chrome.tabs.sendMessage(tabId, {
      type: "APPLY_ASR_CUES",
      cues,
      activeLan: stored?.activeLan || "groq-asr",
      source: stored?.source || "groq",
      partial: pending,
      bvid,
      cid
    }).catch(() => {});
  }
  emitProgress(onProgress, {
    stage: "upload",
    message: pending
      ? `已完成 ${ready.length}/${total} 段，可先看前面的字幕`
      : `已完成 ${ready.length}/${total} 段`,
    done: ready.length,
    total: Math.max(Number(total) || 0, ready.length),
    current: pending ? ready.length + 1 : ready.length,
    cues,
    source: stored?.source || "groq",
    activeLan: stored?.activeLan || "groq-asr",
    partial: pending,
    failed: job?.failedChunks || [],
    paused: Boolean(job?.paused),
    chunks: job ? snapshotAsrChunks(job, parts, pending ? ready.length + 1 : ready.length) : undefined,
    waitUntil: 0
  });
  return cues;
}

async function transcribeChunks(blob, {
  apiKey,
  language,
  signal,
  onProgress,
  duration,
  bvid,
  cid,
  tabId,
  forceRestart,
  job
}) {
  const limits = asrChunkLimits(job);
  const mustSplit = blob.size > Math.min(MAX_UPLOAD_BYTES, limits.maxBytes)
    || Number(duration) > maxChunkSeconds(job);
  const shouldSplit = !audioIsShort(duration, blob.size, job);
  let chunks = [];
  if (shouldSplit) {
    emitProgress(onProgress, {
      message: `音频约 ${Math.round(Number(duration) || 0) || "?"} 秒，按每段不超过 ${Math.floor(limits.maxSeconds / 60)} 分 ${limits.maxSeconds % 60 ? `${limits.maxSeconds % 60} 秒` : ""}切片…`
    });
    try {
      chunks = await BiliCaptionMp4.splitAudio(blob, limits);
    } catch (error) {
      if (mustSplit) throw error;
    }
  }
  if (!chunks.length) {
    const unknownLong = !(Number(duration) > 0) && blob.size > maxChunkBytes(job);
    if (mustSplit || unknownLong) {
      throw new Error("音频太长或无法按当前服务商限制切片");
    }
    chunks = [{
      blob,
      filename: `audio.${guessExt(blob.type)}`,
      start: 0,
      end: Number(duration) || 0,
      overlap: 0
    }];
  }
  const oversized = chunks.find((chunk) => !chunkFitsLimits(chunk, job));
  if (oversized) {
    throw new Error(`切片后仍超过当前服务商限制（${chunkLimitLabel(oversized)}）`);
  }

  const fingerprint = `${blob.size}:${Math.round(Number(duration) || 0)}:${chunks.length}:${chunks[0]?.filename || "bin"}:${limits.maxSeconds}:${limits.maxBytes}`;
  appLog("info", "asr", `音频 ${mbOf(blob.size)}MB / ${Math.round(Number(duration) || 0)} 秒，切成 ${chunks.length} 段（${chunks[0]?.filename || "bin"}）`, {
    mb: mbOf(blob.size),
    chunks: chunks.length
  });
  const loadedSaved = forceRestart ? null : await loadAsrJob(bvid, cid);
  const saved = loadedSaved?.fingerprint === fingerprint ? loadedSaved : null;
  const cachedAsr = forceRestart ? null : await loadCachedAsr(bvid, cid);
  const parts = matchSavedParts(chunks, saved, cachedAsr?.cues || []);

  const skipped = parts.filter(partIsComplete).length;
  if (skipped) {
    appLog("info", "asr", `从断点继续，已有 ${skipped}/${chunks.length} 段`, { done: skipped, chunks: chunks.length });
    emitProgress(onProgress, {
      message: `已有 ${skipped}/${chunks.length} 段结果，从断点继续…`,
      done: skipped,
      total: chunks.length
    });
  }

  if (job) {
    job.duration = Number(duration) || job.duration || 0;
    job.chunkPlan = chunks.map((chunk) => ({ start: chunk.start || 0, end: chunk.end || 0 }));
    job.partsRef = parts;
    job.failedChunks = job.failedChunks || [];
    job.retryQueue = job.retryQueue || [];
  }

  const doneCount = () => parts.filter(partIsComplete).length;

  const runChunk = async (i) => {
    throwIfAborted(signal);
    await waitIfAsrPaused(job, signal, onProgress, {
      parts,
      current: i + 1,
      done: doneCount(),
      total: chunks.length
    });
    throwIfAborted(signal);
    const chunk = chunks[i];
    const done = doneCount();
    if (partIsComplete(parts[i])) {
      emitProgress(onProgress, {
        message: `第 ${i + 1}/${chunks.length} 段已转写过，跳过`,
        done,
        total: chunks.length,
        chunks: snapshotAsrChunks(job, parts, i + 1)
      });
      return;
    }
    emitProgress(onProgress, {
      stage: "upload",
      message: chunks.length > 1
        ? `正在识别第 ${i + 1}/${chunks.length} 段（约 1–2 分钟）`
        : `正在识别（${(chunk.blob.size / 1024 / 1024).toFixed(1)}MB，约 1–2 分钟）`,
      done,
      total: chunks.length,
      current: i + 1,
      failed: job?.failedChunks || [],
      chunks: snapshotAsrChunks(job, parts, i + 1),
      waitUntil: 0
    });
    try {
      const result = await transcribeOne(chunk.blob, {
        apiKey,
        language,
        signal,
        filename: chunk.filename,
        duration: Math.max(0, Number(chunk.end) - Number(chunk.start)),
        onProgress,
        done,
        total: chunks.length,
        current: i + 1,
        job
      });
      const cues = segmentsToCues(result);
      parts[i] = {
        i,
        start: chunk.start || 0,
        end: chunk.end || 0,
        overlap: chunk.overlap || 0,
        cues,
        complete: true,
        silent: cues.length === 0
      };
      if (job) job.failedChunks = (job.failedChunks || []).filter((n) => n !== i + 1);
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError" || error?.canceled) throw error;
      if (isFatalSttError(error)) throw error;
      parts[i] = {
        i,
        start: chunk.start || 0,
        overlap: chunk.overlap || 0,
        failed: true
      };
      if (job && !job.failedChunks.includes(i + 1)) job.failedChunks.push(i + 1);
      appLog("warn", "asr", `第 ${i + 1} 段失败：${error.message || error}`, { bvid, cid, chunk: i + 1 });
      emitProgress(onProgress, {
        stage: "upload",
        message: `第 ${i + 1} 段失败，可稍后重试`,
        done: doneCount(),
        total: chunks.length,
        current: i + 1,
        failed: job?.failedChunks || [],
        chunks: snapshotAsrChunks(job, parts, i + 1)
      });
    }
    await persistAsrProgress({
      bvid,
      cid,
      tabId,
      fingerprint,
      parts,
      total: chunks.length,
      language,
      onProgress,
      job
    });
  };

  throwIfAborted(signal);
  for (let i = 0; i < chunks.length; i += 1) {
    await runChunk(i);
  }

  while (job && (job.failedChunks?.length || job.retryQueue?.length) && !signal?.aborted) {
    if (job.retryQueue?.length) {
      const next = job.retryQueue.shift();
      if (next != null && next >= 0 && next < chunks.length) await runChunk(next);
      continue;
    }
    emitProgress(onProgress, {
      stage: "upload",
      message: `${job.failedChunks.length} 段失败，可重试或取消`,
      done: doneCount(),
      total: chunks.length,
      failed: job.failedChunks,
      chunks: snapshotAsrChunks(job, parts, job.progress?.current),
      waitUntil: 0
    });
    await sleep(400, signal);
  }

  const ready = parts.filter((part) => partIsComplete(part) && part.cues?.length);
  const cues = chunks.length > 1 ? mergeChunkCues(ready) : (ready[0]?.cues || []);
  if (!cues.length) {
    await clearAsrJob(bvid, cid);
    throw new Error("没有识别出有效文本");
  }
  await clearAsrJob(bvid, cid);
  return { text: cues.reduce((text, cue) => joinCueText(text, cue.content), ""), segments: cues, words: [], cues };
}

async function transcribeOneIncoming(chunk, index, parts, {
  apiKey,
  language,
  signal,
  onProgress,
  bvid,
  cid,
  tabId,
  duration,
  totalHint,
  job
}) {
  const total = Math.max(Number(totalHint) || 1, parts.length, index + 1);
  const done = parts.filter(partIsComplete).length;
  if (partIsComplete(parts[index])) {
    emitProgress(onProgress, {
      message: `第 ${index + 1}/${total} 段已转写过，跳过`,
      done,
      total
    });
    return;
  }
  if (job) {
    job.partsRef = parts;
    job.failedChunks = job.failedChunks || [];
    job.retryQueue = job.retryQueue || [];
  }
  try {
    let inputs = [chunk];
    const limits = asrChunkLimits(job);
    if (!chunkFitsLimits(chunk, job)) {
      appLog("warn", "asr", `第 ${index + 1} 段 ${chunkLimitLabel(chunk)}，再切开后继续`);
      const pieces = await BiliCaptionMp4.splitAudio(chunk.blob, limits).catch(() => []);
      if (!pieces.length || (pieces.length === 1 && (pieces[0].blob?.size || 0) >= (chunk.blob?.size || 1))) {
        throw new Error(`切片后仍超限（${chunkLimitLabel(chunk)}）。每段必须同时小于 24MB 且不超过约 8 分钟`);
      }
      inputs = pieces.map((piece) => ({
        ...piece,
        start: Number(chunk.start) + Number(piece.start || 0),
        end: Number(chunk.start) + Number(piece.end || 0)
      }));
      const oversized = inputs.find((piece) => !chunkFitsLimits(piece, job));
      if (oversized) {
        throw new Error(`切片后仍超限（${chunkLimitLabel(oversized)}）。每段必须同时小于 24MB 且不超过约 8 分钟`);
      }
    }

    const subparts = [];
    for (let p = 0; p < inputs.length; p += 1) {
      const input = inputs[p];
      await waitIfAsrPaused(job, signal, onProgress, {
        parts,
        current: index + 1,
        done,
        total
      });
      throwIfAborted(signal);
      emitProgress(onProgress, {
        stage: "upload",
        message: inputs.length > 1
          ? `正在转写 ${index + 1}/${total} 的子段 ${p + 1}/${inputs.length}`
          : (total > 1
            ? `正在转写 ${index + 1}/${total}（边下边传）`
            : `正在上传（${mbOf(input.blob.size)}MB）`),
        done,
        total,
        current: index + 1,
        failed: job?.failedChunks || [],
        chunks: snapshotAsrChunks(job, parts, index + 1),
        waitUntil: 0
      });
      const result = await transcribeOne(input.blob, {
        apiKey,
        language,
        signal,
        filename: input.filename,
        duration: Math.max(0, Number(input.end) - Number(input.start)),
        onProgress,
        done,
        total,
        current: index + 1,
        job
      });
      subparts.push({
        start: Math.max(0, Number(input.start) - Number(chunk.start || 0)),
        overlap: Number(input.overlap) || 0,
        cues: segmentsToCues(result)
      });
    }
    const cues = subparts.length > 1
      ? mergeChunkCues(subparts)
      : (subparts[0]?.cues || []);
    parts[index] = {
      i: index,
      start: chunk.start || 0,
      end: chunk.end || 0,
      overlap: chunk.overlap || 0,
      cues,
      complete: true,
      silent: cues.length === 0
    };
    if (job) job.failedChunks = (job.failedChunks || []).filter((n) => n !== index + 1);
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError" || error?.canceled) throw error;
    if (isFatalSttError(error)) throw error;
    parts[index] = {
      i: index,
      start: chunk.start || 0,
      overlap: chunk.overlap || 0,
      failed: true
    };
    if (job && !job.failedChunks.includes(index + 1)) job.failedChunks.push(index + 1);
    appLog("warn", "asr", `第 ${index + 1} 段失败：${error.message || error}`, { bvid, cid, chunk: index + 1 });
    emitProgress(onProgress, {
      stage: "upload",
      message: `第 ${index + 1} 段失败，可稍后重试`,
      done: parts.filter(partIsComplete).length,
      total,
      current: index + 1,
      failed: job?.failedChunks || [],
      chunks: snapshotAsrChunks(job, parts, index + 1)
    });
  }
  await persistAsrProgress({
    bvid,
    cid,
    tabId,
    fingerprint: `stream:${Math.round(Number(duration) || 0)}:${total}`,
    parts,
    total,
    language,
    onProgress,
    job
  });
}

async function transcribeStreaming(stream, {
  apiKey,
  language,
  signal,
  onProgress,
  duration,
  bvid,
  cid,
  tabId,
  forceRestart,
  job
}) {
  const limits = asrChunkLimits(job);
  const knownShort = audioIsShort(duration, 0, job);
  const estimated = estimatedChunkCount(duration, job);
  const saved = forceRestart ? null : await loadAsrJob(bvid, cid);
  const cachedAsr = forceRestart ? null : await loadCachedAsr(bvid, cid);
  const seeded = seedResumeParts(saved, cachedAsr?.cues || [], duration, estimated);
  if (job && seeded.parts.length) {
    job.duration = Number(duration) || job.duration || 0;
    job.partsRef = seeded.parts;
    job.chunkPlan = seeded.plan.slice();
    job.failedChunks = job.failedChunks || [];
    job.retryQueue = job.retryQueue || [];
  }
  emitProgress(onProgress, {
    stage: "download",
    message: knownShort
      ? "短视频整段下载，一次转写…"
      : (seeded.skipped
        ? `从断点继续 ${seeded.skipped}/${seeded.total}，继续拉取音轨…`
        : "开始拉取音轨…"),
    done: seeded.skipped,
    total: Math.max(seeded.total, estimated, 1)
  });
  if (knownShort) {
    const blob = await downloadAudio(stream, (message) => {
      emitProgress(onProgress, { stage: "download", message, total: 1 });
    }, signal);
    return transcribeChunks(blob, {
      apiKey, language, signal, onProgress, duration, bvid, cid, tabId, forceRestart, job
    });
  }

  const { res, total: totalBytes, mime } = await openAudioDownload(stream, signal);
  if (!res.body || (totalBytes > 0 && audioIsShort(duration, totalBytes, job))) {
    const buf = await res.arrayBuffer();
    return transcribeChunks(new Blob([buf], { type: mime }), {
      apiKey, language, signal, onProgress, duration, bvid, cid, tabId, forceRestart, job
    });
  }

  const chunks = [];
  const parts = seeded.parts;
  let received = 0;
  let body = res.body;

  if (job) {
    job.duration = Number(duration) || job.duration || 0;
    job.partsRef = parts;
    if (!job.chunkPlan?.length) job.chunkPlan = seeded.plan.slice();
    job.failedChunks = job.failedChunks || [];
    job.retryQueue = job.retryQueue || [];
  }

  // CDN 可能中途干净地断流（read 返回 done 但字节没收全）。
  // 不校验就会把半截音频当完整视频广播 done，字幕缺后半段。
  for (let attempt = 0; ; attempt += 1) {
    const reader = body.getReader();
    chunks.length = 0;
    received = 0;
    let streamBroken = false;
    try {
      for await (const item of BiliCaptionMp4.iterateFmp4Chunks(reader, {
        signal,
        maxBytes: limits.maxBytes,
        maxSeconds: limits.maxSeconds,
        onBytes(n) {
          received = n;
          if (n > MAX_DOWNLOAD_BYTES) {
            reader.cancel().catch(() => {});
            throw new Error("音频文件过大，请换更短视频");
          }
          const pct = totalBytes ? Math.min(99, Math.round((n / totalBytes) * 100)) : 0;
          const total = Math.max(estimated, seeded.total, chunks.length || 1);
          emitProgress(onProgress, {
            stage: "download",
            message: pct
              ? `下载 ${pct}% · 已切 ${chunks.length}/${total} 段`
              : `已下载 ${mbOf(n)}MB · 已切 ${chunks.length} 段`,
            done: parts.filter(partIsComplete).length,
            total
          });
        }
      })) {
        throwIfAborted(signal);
        if (item.fallback) {
          if (totalBytes > 0 && item.blob.size < totalBytes - 512 * 1024) {
            throw new Error(`音频下载中断（${mbOf(item.blob.size)}MB/${mbOf(totalBytes)}MB），请点「生成字幕」重试`);
          }
          appLog("info", "asr", "音频不是分片封装，改走整段切片");
          return transcribeChunks(item.blob, {
            apiKey, language, signal, onProgress, duration, bvid, cid, tabId, forceRestart, job
          });
        }
        chunks.push(item);
        if (job) job.chunkPlan[chunks.length - 1] = { start: item.start || 0, end: item.end || 0 };
        const mapped = matchSavedParts(chunks, saved, cachedAsr?.cues || []);
        for (let i = 0; i < mapped.length; i += 1) {
          if (mapped[i] && !parts[i]) parts[i] = mapped[i];
        }
        const index = chunks.length - 1;
        if (index === 0 && attempt === 0) {
          appLog("info", "asr", `已切出第 1 段 ${mbOf(item.blob.size)}MB（${item.filename || "bin"}），开始边下边传`, {
            mb: Number(mbOf(item.blob.size)),
            estimated
          });
        }
        if (!partIsComplete(parts[index])) {
          await transcribeOneIncoming(item, index, parts, {
            apiKey,
            language,
            signal,
            onProgress,
            bvid,
            cid,
            tabId,
            duration,
            totalHint: Math.max(estimated, seeded.total, chunks.length),
            job
          });
        }
      }
    } catch (error) {
      if (error?.name === "AbortError" || signal?.aborted) throw error;
      if (/过大|下载中断/.test(error?.message || "")) throw error;
      if (/DataView|Offset is outside|封装无法切片/i.test(error?.message || "")) {
        appLog("warn", "asr", `边下边切失败，改走整段下载：${error.message || error}`);
        const blob = await downloadAudio(stream, (message) => {
          emitProgress(onProgress, { stage: "download", message });
        }, signal);
        return transcribeChunks(blob, {
          apiKey, language, signal, onProgress, duration, bvid, cid, tabId, forceRestart, job
        });
      }
      const netBroken = error instanceof TypeError
        || /Failed to fetch|network|connection|ERR_|BodyStream/i.test(error?.message || "");
      if (!netBroken || attempt >= 2) throw error;
      streamBroken = true;
      appLog("warn", "asr", `音频流读取中断：${error.message || error}`, { attempt: attempt + 1 });
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }

    const lastEnd = chunks.length ? Number(chunks[chunks.length - 1].end) || 0 : 0;
    const bytesShort = totalBytes > 0 && received < totalBytes - 512 * 1024;
    const timeShort = Number(duration) > 0 && lastEnd > 0 && lastEnd < Number(duration) - 90;
    if (!streamBroken && !bytesShort && !timeShort) break;

    const doneN = parts.filter(partIsComplete).length;
    if (attempt >= 2) {
      throw new Error(`音频流中途断开（已收 ${mbOf(received)}MB${totalBytes ? `/${mbOf(totalBytes)}MB` : ""}），已保存 ${doneN} 段，点「生成字幕」继续`);
    }
    appLog("warn", "asr", `音频流提前结束（${mbOf(received)}MB${totalBytes ? `/${mbOf(totalBytes)}MB` : ""}，切到 ${Math.round(lastEnd)}s/${Math.round(Number(duration) || 0)}s），重新拉取续传`, {
      attempt: attempt + 1,
      done: doneN
    });
    emitProgress(onProgress, {
      stage: "download",
      message: `音频流断开，正在重新连接（第 ${attempt + 2} 次）…`,
      done: doneN,
      total: Math.max(estimated, chunks.length || 1)
    });
    const reopened = await openAudioDownload(stream, signal);
    if (!reopened.res.body) {
      const buf = await reopened.res.arrayBuffer();
      return transcribeChunks(new Blob([buf], { type: reopened.mime || mime }), {
        apiKey, language, signal, onProgress, duration, bvid, cid, tabId, forceRestart, job
      });
    }
    body = reopened.res.body;
  }

  if (!chunks.length) {
    throw new Error("音频封装无法切片，请换更短视频或使用官方字幕");
  }

  appLog("info", "asr", `音频 ${mbOf(received)}MB / ${Math.round(Number(duration) || 0)} 秒，切成 ${chunks.length} 段`, {
    mb: mbOf(received),
    chunks: chunks.length,
    streamed: true
  });

  if (job) {
    job.chunkPlan = chunks.map((chunk) => ({ start: chunk.start || 0, end: chunk.end || 0 }));
    job.partsRef = parts;
    job.failedChunks = job.failedChunks || [];
    job.retryQueue = job.retryQueue || [];
  }

  while (job && (job.failedChunks?.length || job.retryQueue?.length) && !signal?.aborted) {
    if (job.retryQueue?.length) {
      const next = job.retryQueue.shift();
      if (next != null && chunks[next]) {
        await transcribeOneIncoming(chunks[next], next, parts, {
          apiKey, language, signal, onProgress, bvid, cid, tabId, duration, totalHint: chunks.length, job
        });
      }
      continue;
    }
    emitProgress(onProgress, {
      stage: "upload",
      message: `${job.failedChunks.length} 段失败，可重试或取消`,
      done: parts.filter(partIsComplete).length,
      total: chunks.length,
      failed: job.failedChunks,
      chunks: snapshotAsrChunks(job, parts, job.progress?.current),
      waitUntil: 0
    });
    await sleep(400, signal);
  }

  const ready = parts.filter((part) => partIsComplete(part) && part.cues?.length);
  const cues = chunks.length > 1 ? mergeChunkCues(ready) : (ready[0]?.cues || []);
  if (!cues.length) {
    await clearAsrJob(bvid, cid);
    throw new Error("没有识别出有效文本");
  }
  await clearAsrJob(bvid, cid);
  return { text: cues.reduce((text, cue) => joinCueText(text, cue.content), ""), segments: cues, words: [], cues };
}

function abortAfter(signal, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const onAbort = () => {
    clearTimeout(timer);
    ctrl.abort();
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: ctrl.signal,
    cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

function startWorkerHeartbeat() {
  const pulse = () => {
    try {
      chrome.runtime.getPlatformInfo().catch(() => {});
    } catch {
      // service worker 正在关闭
    }
  };
  pulse();
  const timer = setInterval(pulse, 20 * 1000);
  return () => clearInterval(timer);
}

async function transcribeWithGroq(blob, { apiKey, model, language, signal, filename, current, total }) {
  const form = new FormData();
  const ext = filename?.includes(".") ? filename.split(".").pop() : guessExt(blob.type);
  form.append("file", blob, filename || `audio.${ext}`);
  form.append("model", model || GROQ_MODEL);
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  form.append("timestamp_granularities[]", "segment");
  form.append("timestamp_granularities[]", "word");
  if (language) form.append("language", language);

  const started = Date.now();
  const timed = abortAfter(signal, 180000);
  const stopHeartbeat = startWorkerHeartbeat();
  const waitLog = setInterval(() => {
    appLog("info", "groq", `仍在等 Groq 第 ${current || 1} 段，已 ${Math.round((Date.now() - started) / 1000)} 秒`, {
      ms: Date.now() - started,
      current,
      total
    });
  }, 30000);
  let res;
  try {
    res = await fetch(GROQ_TRANSCRIBE_URL, {
      method: "POST",
      signal: timed.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body: form
    });
  } catch (error) {
    const ms = Date.now() - started;
    if (error?.name === "AbortError" && !signal?.aborted) {
      appLog("error", "groq", "Groq 3 分钟内没有返回，按超时重试", { status: 504, ms, current, total });
      throw groqTransientError("Groq 响应超时", 504, 5000);
    }
    if (/Failed to fetch|NetworkError|network/i.test(error?.message || "")) {
      appLog("error", "groq", "连不上 api.groq.com（Failed to fetch）。扩展可能没走系统代理，或当前网络访问不了 Groq", {
        status: 0,
        ms,
        current,
        total
      });
      throw groqTransientError("网络中断，稍后重试", 0, 5000);
    }
    appLog("error", "groq", error.message || String(error), { ms, current, total });
    throw error;
  } finally {
    clearInterval(waitLog);
    timed.cleanup();
    stopHeartbeat();
  }

  const ms = Date.now() - started;
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    const snippet = text.replace(/\s+/g, " ").slice(0, 180);
    appLog("error", "groq", `Groq HTTP ${res.status}，响应不是 JSON：${snippet}`, { status: res.status, ms, current, total });
    if ([408, 429, 500, 502, 503, 504].includes(res.status)) {
      throw groqTransientError(`Groq 错误 ${res.status}`, res.status, res.status === 429 ? 15000 : 8000);
    }
    const error = new Error(`Groq 返回异常：${text.slice(0, 200)}`);
    error.status = res.status;
    throw error;
  }
  if (!res.ok) {
    const raw = json?.error?.message || json?.message || `Groq 错误 ${res.status}`;
    appLog("error", "groq", `Groq HTTP ${res.status}：${String(raw).slice(0, 220)}`, { status: res.status, ms, current, total });
    if (/rate limit|ASPH|ASH|try again/i.test(raw) || res.status === 429) {
      throw groqLimitError(raw, parseRetryAfter(res.headers.get("retry-after")));
    }
    if ([408, 500, 502, 503, 504].includes(res.status) || /bad gateway|unavailable|timeout|gateway/i.test(raw)) {
      throw groqTransientError(raw, res.status, 8000);
    }
    const error = new Error(raw);
    error.status = res.status;
    throw error;
  }
  const cues = Array.isArray(json?.segments) ? json.segments.length : 0;
  appLog("info", "groq", `第 ${current || 1}/${total || 1} 段 Groq ${res.status}，${cues} 句，${Math.round(ms / 1000)} 秒`, {
    status: res.status,
    ms,
    current,
    total,
    cues
  });
  return json;
}

function normalizeWords(words) {
  return (Array.isArray(words) ? words : [])
    .map((w) => ({
      word: String(w.word || w.text || "").trim(),
      start: Number(w.start) || 0,
      end: Number(w.end) || 0
    }))
    .filter((w) => w.word);
}

function segmentsToCues(result) {
  const words = normalizeWords(result?.words);
  const segments = Array.isArray(result?.segments) ? result.segments : [];
  const cues = segments
    .map((seg, index) => {
      const from = Math.max(0, Number(seg.start) || 0);
      return {
        from,
        to: Math.max(from + 0.15, Number(seg.end) || 0),
        content: String(seg.text || seg.content || "").replace(/\s+/g, " ").trim(),
        sid: index + 1
      };
    })
    .filter((item) => item.content);

  // 有官方 segments 就用它当行，词级时间戳只在切开长段时对轴
  if (cues.length) return refineAsrCues(cues, words);

  if (words.length) return cuesFromWords(words);

  const whole = String(result?.text || "").trim();
  if (!whole) return [];
  return refineAsrCues([{ from: 0, to: Number(result.duration) || 0, content: whole, sid: 1 }], words);
}

/** 中文按字、英文按词大致估算长度 */
function cueLen(text) {
  return String(text || "")
    .replace(/\s+/g, "")
    .length;
}

const HARD_PUNCT = /[。．.！？；!?\u2026]/;
const SOFT_PUNCT = /[，、,;：:]/;
const CLAUSE_MARKERS = [
  "大家都知道", "简单来说", "这种方式", "更简单",
  "再就是", "就是说", "首先是", "另外", "其次", "首先",
  "所以", "但是", "然后", "因此", "而且", "不过",
  "如果", "比如", "例如", "其实", "目前"
];

function shouldSplitCue(cue, maxChars = 56, maxDur = 12) {
  const dur = Math.max(0, (Number(cue.to) || 0) - (Number(cue.from) || 0));
  return cueLen(cue.content) > maxChars || dur > maxDur;
}

/** 中文句号，或英文句号后跟空格。4.8 / Dr. 这种中间点不切。 */
function splitBySentences(text) {
  const src = String(text || "").replace(/\s+/g, " ").trim();
  if (!src) return [];
  const parts = src
    .split(/(?<=[。！？；!?\u2026])|(?<=[.!?]["'”’]*)\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? parts : [src];
}

function mostlyLatin(text) {
  const raw = String(text || "");
  const latin = (raw.match(/[A-Za-z]/g) || []).length;
  const cjk = (raw.match(/[\u4e00-\u9fff]/g) || []).length;
  return latin >= 8 && latin > cjk;
}

/** 按句读切开，保留标点在上一片末尾 */
function splitByPunctuation(text) {
  const src = String(text || "").replace(/\s+/g, " ").trim();
  if (!src) return [];
  const hard = splitBySentences(src);
  if (hard.length > 1) return hard;

  const soft = src.split(/(?<=[，、,;：:])/).map((p) => p.trim()).filter(Boolean);
  if (soft.length > 1) return soft;

  const marked = splitByMarkers(src);
  return marked.length > 1 ? marked : [src];
}

function splitByMarkers(text) {
  const src = String(text || "");
  if (src.length < 18) return [src];
  const hits = [];
  for (const mark of CLAUSE_MARKERS) {
    let from = 1;
    while (from < src.length) {
      const at = src.indexOf(mark, from);
      if (at < 0) break;
      if (at >= 8) hits.push(at);
      from = at + mark.length;
    }
  }
  if (!hits.length) return [src];
  hits.sort((a, b) => a - b);
  const collapsed = [];
  for (const at of hits) {
    if (collapsed.length && at - collapsed[collapsed.length - 1] < 8) {
      collapsed[collapsed.length - 1] = at;
      continue;
    }
    collapsed.push(at);
  }
  const parts = [];
  let last = 0;
  for (const at of collapsed) {
    if (at - last < 10) continue;
    parts.push(src.slice(last, at).trim());
    last = at;
  }
  parts.push(src.slice(last).trim());
  return parts.filter(Boolean);
}

function allocateTimes(from, to, pieces) {
  const start = Number(from) || 0;
  const end = Math.max(start + 0.2, Number(to) || start + 0.2);
  const weights = pieces.map((p) => Math.max(1, cueLen(p)));
  const total = weights.reduce((a, b) => a + b, 0);
  const span = end - start;
  const result = [];
  let cursor = start;
  pieces.forEach((content, i) => {
    const ratio = weights[i] / total;
    const next = i === pieces.length - 1 ? end : cursor + span * ratio;
    result.push({
      from: Number(cursor.toFixed(3)),
      to: Number(Math.max(cursor + 0.15, next).toFixed(3)),
      content: content.trim()
    });
    cursor = next;
  });
  return result;
}

/** 切开长段时，用词级时间戳对齐，对不上再按字数比例估 */
function allocateTimesByWords(from, to, pieces, words) {
  const start = Number(from) || 0;
  const end = Math.max(start + 0.2, Number(to) || start + 0.2);
  const span = (Array.isArray(words) ? words : []).filter(
    (w) => w.end > start - 0.05 && w.start < end + 0.05
  );
  if (span.length < 2) return allocateTimes(from, to, pieces);

  const result = [];
  let i = 0;
  let cursor = start;
  pieces.forEach((content, p) => {
    const need = cueLen(content);
    const begin = i;
    let got = 0;
    while (i < span.length && (p === pieces.length - 1 || got < need)) {
      got += cueLen(span[i].word);
      i += 1;
      if (got >= need && p < pieces.length - 1) break;
    }
    if (i <= begin) i = Math.min(span.length, begin + 1);
    const next = p === pieces.length - 1
      ? end
      : Math.max(cursor + 0.15, Number(span[i - 1]?.end) || cursor + 0.15);
    result.push({
      from: Number(cursor.toFixed(3)),
      to: Number(next.toFixed(3)),
      content: content.trim()
    });
    cursor = next;
  });
  return result;
}

function splitByLength(text, maxChars = 56) {
  const src = String(text || "").trim();
  if (!src) return [];
  if (cueLen(src) <= maxChars) return [src];
  const parts = [];
  let buf = "";
  for (const ch of src) {
    buf += ch;
    if (cueLen(buf) >= maxChars) {
      parts.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

function splitOversized(pieces, maxChars = 72) {
  const out = [];
  for (const piece of pieces) {
    if (cueLen(piece) <= maxChars) {
      out.push(piece);
      continue;
    }
    const soft = piece.split(/(?<=[，、,;：:])/).map((p) => p.trim()).filter(Boolean);
    if (soft.length > 1) {
      out.push(...splitOversized(soft, maxChars));
      continue;
    }
    const marked = splitByMarkers(piece);
    if (marked.length > 1) {
      out.push(...splitOversized(marked, maxChars));
      continue;
    }
    if (mostlyLatin(piece)) {
      out.push(piece);
      continue;
    }
    out.push(...splitByLength(piece, 56));
  }
  return out;
}

function splitLongCue(cue, words) {
  if (!shouldSplitCue(cue)) return [cue];

  let pieces = splitBySentences(cue.content);

  if (pieces.length <= 1) {
    const dur = Math.max(0, (Number(cue.to) || 0) - (Number(cue.from) || 0));
    if (cueLen(cue.content) <= 72 && dur <= 16) return [cue];
    pieces = splitByPunctuation(cue.content);
  }
  pieces = splitOversized(pieces);
  if (pieces.length <= 1) return [cue];
  return allocateTimesByWords(cue.from, cue.to, pieces, words);
}

function joinCueText(left, right) {
  if (self.BiliCaptionTranslate?.joinCueText) {
    return self.BiliCaptionTranslate.joinCueText(left, right);
  }
  const a = String(left || "").trimEnd();
  const b = String(right || "").trimStart();
  const needsSpace = /[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b);
  return `${a}${needsSpace ? " " : ""}${b}`.replace(/\s+/g, " ").trim();
}

function mergeTinyCues(cues) {
  const out = [];
  for (const cue of cues) {
    const prev = out[out.length - 1];
    if (!prev) {
      out.push({ ...cue });
      continue;
    }
    const gap = (Number(cue.from) || 0) - (Number(prev.to) || 0);
    const mergedLen = cueLen(prev.content) + cueLen(cue.content);
    const nextStartsClause = CLAUSE_MARKERS.some((m) => cue.content.startsWith(m));
    const tiny = cueLen(prev.content) < 8 || cueLen(cue.content) < 6;
    if (tiny && !nextStartsClause && gap < 0.4 && mergedLen <= 40) {
      prev.content = joinCueText(prev.content, cue.content);
      prev.to = cue.to;
      if (prev.original || cue.original) {
        prev.original = joinCueText(prev.original || "", cue.original || "");
      }
      continue;
    }
    out.push({ ...cue });
  }
  return out.map((cue, i) => ({ ...cue, sid: i + 1 }));
}

function looksLikeHardWrap(cues) {
  if (!Array.isArray(cues) || cues.length < 4) return false;
  const mid = cues.filter((cue) => {
    const n = cueLen(cue.content);
    return n >= 18 && n <= 26 && !HARD_PUNCT.test(cue.content.slice(-1));
  }).length;
  return mid / cues.length >= 0.55;
}

/** 旧版按字数硬切的碎片先拼回去 */
function stitchBrokenWraps(cues) {
  const out = [];
  for (const cue of cues) {
    const prev = out[out.length - 1];
    const gap = prev ? (Number(cue.from) || 0) - (Number(prev.to) || 0) : 99;
    const prevEnds = HARD_PUNCT.test(prev?.content?.slice(-1) || "");
    if (prev && !prevEnds && gap < 0.55 && cueLen(prev.content) <= 26) {
      prev.content = joinCueText(prev.content, cue.content);
      prev.to = cue.to;
      if (prev.original || cue.original) {
        prev.original = joinCueText(prev.original || "", cue.original || "");
      }
      continue;
    }
    out.push({ ...cue });
  }
  return out;
}

function toSimplified(text) {
  return self.BiliCaptionZh?.toSimplified?.(text) || String(text || "");
}

/** Whisper 的 prompt 是上一句转写上下文，不是系统指令；静音时会把这句原样念进字幕。 */
function stripAsrInstructionLeak(text) {
  return String(text || "").replace(/^(请使用简体中文转写[。．.！!？?\s]*)+/, "").trim();
}

function flattenCueParts(cues, words = []) {
  const flat = [];
  for (const cue of cues || []) {
    for (const part of splitLongCue(cue, words)) {
      const content = toSimplified(stripAsrInstructionLeak(part.content));
      if (!content) continue;
      const row = {
        from: part.from,
        to: part.to,
        content,
        sid: flat.length + 1
      };
      const original = String(part.original || cue.original || "").trim();
      if (original) row.original = original;
      flat.push(row);
    }
  }
  return flat;
}

function refineAsrCues(cues, words = []) {
  const source = looksLikeHardWrap(cues) ? stitchBrokenWraps(cues) : cues;
  return mergeTinyCues(flattenCueParts(source, words));
}

function splitTranslatedCues(cues) {
  return flattenCueParts(cues);
}

function refineCues(cues) {
  return refineAsrCues(cues);
}

/** 没有 segments 时，才用词级时间戳按标点收成行 */
function cuesFromWords(words) {
  const cleaned = normalizeWords(words);
  if (!cleaned.length) return [];

  const cues = [];
  let buf = [];

  const bufText = () => {
    let out = "";
    for (const w of buf) out = joinCueText(out, w.word);
    return out;
  };

  const flush = () => {
    if (!buf.length) return;
    const content = bufText();
    if (!content) {
      buf = [];
      return;
    }
    cues.push({
      from: buf[0].start,
      to: Math.max(buf[0].start + 0.2, buf[buf.length - 1].end),
      content,
      sid: cues.length + 1
    });
    buf = [];
  };

  const startsClause = (word) => CLAUSE_MARKERS.some((m) => String(word || "").startsWith(m));

  for (const w of cleaned) {
    const chars = cueLen(bufText());
    const dur = buf.length ? w.end - buf[0].start : 0;
    const hitPunct = HARD_PUNCT.test(w.word.slice(-1));
    const hitSoft = SOFT_PUNCT.test(w.word.slice(-1));
    const atBoundary = buf.length && startsClause(w.word) && chars >= 14;

    if (buf.length && atBoundary) flush();
    else if (buf.length && (chars > 72 || dur > 16) && (hitPunct || hitSoft || atBoundary)) flush();

    buf.push(w);
    if (hitPunct || (hitSoft && cueLen(bufText()) >= 20)) flush();
  }
  flush();
  return refineAsrCues(cues, cleaned);
}

async function resolveVideoMeta(input = {}) {
  let aid = Number(input.aid) || 0;
  let cid = Number(input.cid) || 0;
  let bvid = input.bvid || "";
  let title = input.title || "";
  let part = input.part || "";

  if (bvid && (!aid || !cid)) {
    const view = await fetchView(bvid);
    const p = Math.max(1, Number(input.p) || 1);
    const page = view.pages?.[p - 1];
    aid = aid || view.aid;
    title = title || view.title || "";
    bvid = view.bvid || bvid;
    if (!cid) {
      if (page?.cid) cid = page.cid;
      else if (view.pages?.length === 1) cid = view.pages[0].cid || view.cid;
    }
    if (page?.part && view.pages?.length > 1) part = part || page.part;
  }

  if ((!aid || !cid) && (input.epId || input.seasonId)) {
    const bangumi = await fetchBangumi(input);
    aid = bangumi.aid;
    cid = bangumi.cid;
    bvid = bangumi.bvid || bvid;
    title = title || bangumi.title || "";
    part = part || bangumi.part || "";
  }

  if (!aid || !cid) {
    throw new Error("无法解析当前分 P 的 aid/cid，请确认在对应一集/一 P 再生成");
  }

  return { aid, cid, bvid, title, part, duration: Number(input.duration) || 0 };
}

function cancelAsrJob(jobId, extra = {}) {
  const job = findAsrJob({ jobId, bvid: extra.bvid, cid: extra.cid, tabId: extra.tabId });
  if (!job) return false;
  job.controller.abort();
  appLog("info", "asr", "已取消生成", { bvid: job.bvid, cid: job.cid });
  return true;
}

function boostAsrJob() {
  // 通道切换已全自动：前面的通道限流会立即落到后面的通道，无需手动加速
  return { ok: false, error: "通道切换已自动化，前面的通道限流时会自动切到后面的通道" };
}

async function generateAsr(input, sender) {
  const jobId = String(input.jobId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const controller = new AbortController();
  const job = {
    jobId,
    controller,
    tabId: Number(input.tabId || sender?.tab?.id) || 0,
    bvid: input.bvid || "",
    cid: Number(input.cid) || 0
  };
  asrJobs.set(jobId, job);
  const { signal } = controller;

  try {
    jobBroadcast(job, { stage: "start", message: "准备生成字幕…" });
    appLog("info", "asr", `开始生成 ${input.bvid || input.epId || ""}`, {
      bvid: input.bvid || "",
      cid: Number(input.cid) || 0
    });

    const storage = await BiliCaptionPrefs.loadSettings({
      groqApiKey: "",
      sttKey: "",
      sttProvider: "Groq",
      sttCreds: {},
      sttModel: "",
      backupProvider: "不启用",
      backupKey: "",
      asrLanguage: ""
    });
    throwIfAborted(signal);
    const P = self.BiliCaptionProviders;
    // 预过滤掉不可用通道（没填 Key 的付费通道），链里至少留一条可用的
    const channels = P.resolveChannels(storage).filter((cfg) => P.channelUsable(cfg));
    if (!channels.length) {
      throw new Error("请先在设置里添加并配置好转写通道（至少一条填好 Key）");
    }
    const sttCfg = channels[0];
    job.channels = channels;
    job.channelCools = [];
    job.deadChannels = [];
    job.activeChannel = 0;
    // 兼容存量引用（日志/缓存元信息用）
    job.sttCfg = sttCfg;
    job.backupCfg = null;
    const compatibilityError = jobCompatibilityError(sttCfg);
    if (compatibilityError) throw new Error(compatibilityError);

    const meta = await resolveVideoMeta(input);
    throwIfAborted(signal);
    job.bvid = meta.bvid || job.bvid;
    job.cid = meta.cid || job.cid;
    const lockKey = asrLockKey(meta.bvid, meta.cid);
    const live = asrJobLocks.get(lockKey);
    if (live && live.jobId !== jobId) {
      const pending = live.work || await waitForAsrLockWork(lockKey);
      if (pending) {
        job.joined = true;
        asrJobs.delete(jobId);
        return pending;
      }
    }
    asrJobLocks.set(lockKey, { jobId });
    try {
      const existingJob = await loadAsrJob(meta.bvid, meta.cid);
      const cachedAsr = await loadCachedAsr(meta.bvid, meta.cid);
      const lastCueTo = maxCueField(cachedAsr?.cues);
      const looksIncomplete = cachedAsr?.partial == null
        && lastCueTo > 20
        && Number(meta.duration) > 0
        && lastCueTo < Number(meta.duration) - 90;
      const resume = Boolean(
        (existingJob?.parts?.length && existingJob.pending !== false)
        || cachedAsr?.partial
        || looksIncomplete
      );
      const forceRestart = Boolean(input.force) && !resume;
      if (forceRestart) await clearAsrJob(meta.bvid, meta.cid);

      const work = runAsrJob(job, {
        meta,
        signal,
        groqApiKey: sttCfg.key || storage.groqApiKey,
        asrLanguage: storage.asrLanguage,
        forceRestart
      });
      asrJobLocks.set(lockKey, { jobId, work });
      return await work;
    } finally {
      const cur = asrJobLocks.get(lockKey);
      if (cur?.jobId === jobId) asrJobLocks.delete(lockKey);
    }
  } catch (error) {
    if (signal.aborted || error?.name === "AbortError") {
      const canceled = new Error("已取消生成");
      canceled.canceled = true;
      if (!job.joined) {
        jobBroadcast(job, {
          stage: "canceled",
          message: canceled.message,
          running: false,
          waitUntil: 0
        });
      }
      throw canceled;
    }
    if (!job.joined) {
      appLog("error", "asr", error.message || String(error), { bvid: job.bvid, cid: job.cid });
      jobBroadcast(job, {
        stage: "error",
        message: error.message || String(error),
        running: false,
        partial: Boolean(job.progress?.cues?.length),
        cues: job.progress?.cues || [],
        waitUntil: 0
      });
    }
    throw error;
  } finally {
    asrJobs.delete(jobId);
  }
}

function asrLockKey(bvid, cid) {
  return `${bvid || "bv"}:${Number(cid) || 0}`;
}

async function waitForAsrLockWork(lockKey, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const live = asrJobLocks.get(lockKey);
    if (live?.work) return live.work;
    if (!live) return null;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return asrJobLocks.get(lockKey)?.work || null;
}

function startAsr(input, sender) {
  const existing = findAsrJob({
    bvid: input.bvid,
    cid: input.cid,
    tabId: input.tabId || sender?.tab?.id
  });
  if (existing) {
    return { started: true, joined: true, jobId: existing.jobId };
  }

  const lockKey = (input.bvid || input.cid) ? asrLockKey(input.bvid, input.cid) : "";
  if (lockKey && asrJobLocks.has(lockKey)) {
    const live = asrJobLocks.get(lockKey);
    return { started: true, joined: true, jobId: live?.jobId || "" };
  }

  const jobId = String(input.jobId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  if (lockKey) asrJobLocks.set(lockKey, { jobId });
  generateAsr({ ...input, jobId }, sender).catch(() => {
    // 结果通过 ASR_PROGRESS 广播，避免单个消息请求持续数小时
  });
  return { started: true, jobId };
}

async function runAsrJob(job, { meta, signal, groqApiKey, asrLanguage, forceRestart }) {
  try {
    jobBroadcast(job, { stage: "playurl", message: "正在获取音频地址…" });
    const playurl = await fetchPlayurl(meta);
    throwIfAborted(signal);
    const stream = pickAudioStream(playurl);

    const duration = Number(playurl.timelength) > 1000
      ? Number(playurl.timelength) / 1000
      : Number(meta.duration) || 0;
    const result = await transcribeStreaming(stream, {
      apiKey: groqApiKey,
      language: asrLanguage || undefined,
      signal,
      duration,
      bvid: meta.bvid,
      cid: meta.cid,
      tabId: job.tabId,
      forceRestart,
      job,
      onProgress: (info) => {
        const extra = typeof info === "string" ? { message: info } : info;
        const { job: _j, ...safe } = extra || {};
        jobBroadcast(job, { stage: extra.stage || "upload", ...safe });
      }
    });

    throwIfAborted(signal);
    let cues = result.cues?.length ? result.cues : segmentsToCues(result);
    if (!cues.length) throw new Error(`${job.sttCfg?.provider || "转写服务"}没有识别出有效文本`);

    throwIfAborted(signal);
    const stored = await saveCachedAsr(meta.bvid, meta.cid, {
      cues,
      language: result.language || asrLanguage || "",
      model: job.lastSttModel || job.sttCfg?.model || GROQ_MODEL,
      provider: job.lastSttProvider || job.sttCfg?.provider || "Groq",
      activeLan: "groq-asr",
      source: "groq",
      partial: false
    });
    cues = stored.cues || cues;

    appLog("info", "asr", `生成完成 ${cues.length} 条`, { cues: cues.length, bvid: meta.bvid, cid: meta.cid });
    jobBroadcast(job, {
      stage: "done",
      message: `已生成 ${cues.length} 条字幕`,
      done: job.progress?.total || 1,
      total: job.progress?.total || 1,
      cues,
      source: stored.source || "groq",
      activeLan: stored.activeLan || "groq-asr",
      partial: false,
      waitUntil: 0
    });

    return {
      cues,
      activeLan: stored.activeLan || "groq-asr",
      source: stored.source || "groq",
      language: result.language || asrLanguage || "",
      model: job.lastSttModel || job.sttCfg?.model || GROQ_MODEL,
      provider: job.lastSttProvider || job.sttCfg?.provider || "Groq",
      aid: meta.aid,
      cid: meta.cid,
      bvid: meta.bvid,
      title: meta.title,
      part: meta.part,
      jobId: job.jobId,
      tabId: job.tabId
    };
  } catch (error) {
    if (signal.aborted || error?.name === "AbortError") {
      const canceled = new Error("已取消生成");
      canceled.canceled = true;
      throw canceled;
    }
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = message?.type;
  const handled = new Set([
    ...CONTENT_MESSAGE_TYPES,
    "GET_LOGS",
    "CLEAR_LOGS",
    "APPEND_LOG",
    "START_TRANSLATE",
    "CANCEL_TRANSLATE",
    "CLEAR_VIDEO_CACHE"
  ]);
  if (handled.has(type) && !allowMessage(type, _sender)) {
    sendResponse({ error: "无权调用" });
    return true;
  }
  const tabId = isExtensionPage(_sender)
    ? (Number(message?.tabId) || _sender.tab?.id || 0)
    : (Number(_sender.tab?.id) || 0);
  const reply = (promise) => {
    Promise.resolve(promise)
      .then(sendResponse)
      .catch((error) => sendResponse({ error: error.message || String(error) }));
    return true;
  };

  if (message?.type === "WHOAMI") {
    sendResponse({ tabId: _sender.tab?.id || 0, windowId: _sender.tab?.windowId });
    return true;
  }
  if (message?.type === "LOAD_SUBTITLES") {
    return reply(loadSubtitles(message.page));
  }
  if (message?.type === "GET_LOGIN") {
    return reply(fetchLoginStatus());
  }
  if (message?.type === "SAVE_CUES_CACHE") {
    return reply(saveCachedAsr(message.bvid, message.cid, {
      cues: clampCues(message.cues),
      activeLan: message.activeLan || "",
      source: message.source || "groq"
    }).then(() => ({ ok: true })));
  }
  if (message?.type === "CLEAR_VIDEO_CACHE") {
    return reply(clearVideoCache(message.bvid || "", Number(message.cid) || 0));
  }
  if (message?.type === "GET_LOGS") {
    return reply(getAppLogs().then((logs) => ({ logs })));
  }
  if (message?.type === "CLEAR_LOGS") {
    return reply(clearAppLogs());
  }
  if (message?.type === "APPEND_LOG") {
    return reply(appLog(message.level || "info", message.scope || "set", message.message || "", message.extra));
  }
  if (message?.type === "GET_ASR_JOB") {
    sendResponse(getAsrJobStatus(message));
    return true;
  }
  if (message?.type === "CANCEL_ASR") {
    const ok = cancelAsrJob(message.jobId, {
      bvid: message.bvid,
      cid: message.cid,
      tabId: message.tabId
    });
    sendResponse({ ok });
    return true;
  }
  if (message?.type === "BOOST_ASR") {
    sendResponse(boostAsrJob({
      jobId: message.jobId,
      bvid: message.bvid,
      cid: message.cid,
      tabId: message.tabId
    }));
    return true;
  }
  if (message?.type === "PAUSE_ASR") {
    sendResponse(pauseAsrJob({
      jobId: message.jobId,
      bvid: message.bvid,
      cid: message.cid,
      tabId: message.tabId
    }, message.paused !== false));
    return true;
  }
  if (message?.type === "RETRY_ASR_CHUNK") {
    sendResponse(retryAsrChunks({
      jobId: message.jobId,
      bvid: message.bvid,
      cid: message.cid,
      tabId: message.tabId
    }, {
      index: message.index
    }));
    return true;
  }
  if (message?.type === "FETCH_CUES") {
    return reply(
      fetchCues(message.url)
        .then((cues) => ({ cues }))
        .catch((error) => ({
          error: error.message || String(error),
          cues: []
        }))
    );
  }
  if (message?.type === "GENERATE_ASR") {
    sendResponse(startAsr({
      jobId: message.jobId,
      tabId,
      aid: message.aid,
      cid: message.cid,
      bvid: message.bvid,
      p: message.p,
      epId: message.epId,
      seasonId: message.seasonId,
      title: message.title,
      part: message.part,
      force: Boolean(message.force)
    }, _sender));
    return true;
  }
  if (message?.type === "GET_TRANSLATE_JOB") {
    return reply(getTranslateJobStatus(message));
  }
  if (message?.type === "CANCEL_TRANSLATE") {
    return reply(cancelTranslateJob(message.jobId, {
      bvid: message.bvid,
      cid: message.cid,
      tabId: message.tabId
    }).then((ok) => ({ ok })));
  }
  if (message?.type === "START_TRANSLATE") {
    return reply(startTranslate({
      jobId: message.jobId,
      tabId,
      bvid: message.bvid,
      cid: message.cid,
      cues: clampCues(message.cues)
    }, _sender));
  }
  if (message?.type === "CLOSE_SIDE_PANEL") {
    const tabId = _sender.tab?.id;
    const windowId = _sender.tab?.windowId;
    hideChromeSidePanel(tabId, windowId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === "DAV_SYNC_NOW") {
    return reply(runDavSync(message.reason || "manual"));
  }
  if (message?.type === "RESTORE_SIDE_PANEL") {
    const tabId = _sender.tab?.id;
    const windowId = _sender.tab?.windowId;
    // 必须立刻 open()，前面不能 await，否则点「侧栏」会丢掉用户手势
    showChromeSidePanel(tabId, windowId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  return false;
});
