// 后台 · 基础：各模块共用的任务表、小工具、运行日志和广播。
// 后台脚本由 background.js 第 1 行的 importScripts 按顺序加载，共享同一个全局作用域。
// 后台/ 下的文件只做声明，不在加载时执行任何代码；启动时要跑的代码和事件监听都在 background.js。

// 进行中的转写 / 翻译任务，以及按视频串行写缓存的队列。转写、翻译、清理缓存都要查，所以放在这里。
const asrJobs = new Map();
const asrJobLocks = new Map();
const asrCacheWrites = new Map();
const translateJobs = new Map();
const translateJobLocks = new Map();

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

// ---- 运行日志：存 storage.local，设置页「日志」里看 ----
// 分级保留：错误和警告（异常）留 7 天、最多 200 条；普通信息留 24 小时、最多 100 条。
// 两类各自计数，信息再多也挤不掉异常。仍存成一个按时间排列的数组（旧版就是这样存的，读进来按新规则裁剪即可）。
const LOG_KEY = "appLogs";
const LOG_KEEP = {
  issue: { ms: 7 * 24 * 60 * 60 * 1000, max: 200 },
  info: { ms: 24 * 60 * 60 * 1000, max: 100 }
};
let appLogs = [];
let appLogsLoaded = false;
let appLogsLoading = null;
let appLogFlushTimer = 0;

function logDetail(extra) {
  if (!extra) return "";
  if (typeof extra === "string") return extra.slice(0, 400);
  const pick = {};
  for (const key of ["status", "ms", "mb", "done", "total", "current", "chunk", "bvid", "cid", "host", "waitMs", "chunks", "cues", "left", "path", "try"]) {
    if (extra[key] != null && extra[key] !== "") pick[key] = extra[key];
  }
  if (!Object.keys(pick).length) return "";
  try {
    return JSON.stringify(pick).slice(0, 400);
  } catch {
    return "";
  }
}

function logIsIssue(entry) {
  return entry?.level === "error" || entry?.level === "warn";
}

/** 按级别裁剪：过期的去掉，每类只留最新的若干条；返回新数组，顺序不变 */
function pruneAppLogs(list, now = Date.now()) {
  const src = Array.isArray(list) ? list : [];
  const kept = [];
  let issues = 0;
  let infos = 0;
  for (let i = src.length - 1; i >= 0; i -= 1) {
    const entry = src[i];
    if (!entry || typeof entry !== "object") continue;
    const issue = logIsIssue(entry);
    const rule = issue ? LOG_KEEP.issue : LOG_KEEP.info;
    if (now - (Number(entry.t) || 0) > rule.ms) continue;
    if ((issue ? issues : infos) >= rule.max) continue;
    if (issue) issues += 1;
    else infos += 1;
    kept.push(entry);
  }
  return kept.reverse();
}

/** 裁剪内存里的日志；有删掉的就排一次落盘 */
function trimAppLogs() {
  const next = pruneAppLogs(appLogs);
  if (next.length === appLogs.length) return false;
  appLogs = next;
  return true;
}

function ensureAppLogs() {
  if (appLogsLoaded) return Promise.resolve();
  if (!appLogsLoading) {
    appLogsLoading = chrome.storage.local.get(LOG_KEY).then((data) => {
      const stored = Array.isArray(data[LOG_KEY]) ? data[LOG_KEY] : [];
      appLogs = pruneAppLogs(stored);
      appLogsLoaded = true;
      // 旧版按条数存的 200 条、或者上次关掉后已过期的：裁剪后写回
      if (appLogs.length !== stored.length) scheduleLogFlush(false);
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
  appLogs = pruneAppLogs(appLogs);
  chrome.storage.local.set({ [LOG_KEY]: appLogs.slice() }).catch(() => {});
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
  trimAppLogs();
  chrome.runtime.sendMessage({ type: "APP_LOG", entry }).catch(() => {});
  scheduleLogFlush(entry.level === "error");
  return entry;
}

async function getAppLogs() {
  await ensureAppLogs();
  if (trimAppLogs()) scheduleLogFlush(false);
  return appLogs.slice();
}

async function clearAppLogs() {
  await ensureAppLogs();
  appLogs = [];
  flushAppLogs();
  return { ok: true };
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error("已取消生成");
    error.name = "AbortError";
    throw error;
  }
}

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
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
