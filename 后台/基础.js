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
const LOG_KEY = "appLogs";
const LOG_MAX = 200;
let appLogs = [];
let appLogsLoaded = false;
let appLogsLoading = null;
let appLogFlushTimer = 0;

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
