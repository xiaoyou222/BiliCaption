importScripts("lib/md5.js", "lib/wbi.js", "lib/mp4-aac.js", "lib/zh-simp.js");

const GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3-turbo";
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 400 * 1024 * 1024;
const MAX_CHUNK_SLACK = 15;
const MAX_QUOTA_WAIT_MS = 70 * 60 * 1000;
const LOG_KEY = "appLogs";
const LOG_MAX = 200;

const immersiveByTab = new Map();
const asrJobs = new Map();
const asrJobLocks = new Map();
let appLogs = [];
let appLogsLoaded = false;
let appLogsLoading = null;
let appLogFlushTimer = 0;

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
    delete rule.condition.initiatorDomains;
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [1001],
        addRules: [rule]
      });
    } catch (retryError) {
      console.warn("[BiliCaption] dnr rules", retryError);
      appLog("warn", "net", `改 Referer 规则安装失败：${retryError.message || retryError}`);
    }
  }
}

enableAllBiliPanels();
installAudioRefererRules();
chrome.runtime.onInstalled.addListener(() => {
  enableAllBiliPanels();
  installAudioRefererRules();
});
chrome.runtime.onStartup.addListener(() => {
  enableAllBiliPanels();
  installAudioRefererRules();
});

async function resolvePanelContext(sender) {
  if (sender?.tab?.id) {
    return { tabId: sender.tab.id, windowId: sender.tab.windowId };
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return { tabId: tab?.id, windowId: tab?.windowId };
}

// 用 enabled 开关而不是 close()：停用只是把面板藏起来，重新启用时
// Chrome 会自己显示回来，不需要用户手势
async function hideChromeSidePanel(tabId) {
  if (!tabId) return;
  try {
    await chrome.sidePanel.setOptions({ tabId, enabled: false });
  } catch {
    // ignore
  }
}

function showChromeSidePanel(tabId, windowId) {
  if (tabId) enableSidePanel(tabId);
  if (tabId) return chrome.sidePanel.open({ tabId });
  if (windowId) return chrome.sidePanel.open({ windowId });
  return Promise.resolve();
}

chrome.tabs.onRemoved.addListener((tabId) => {
  immersiveByTab.delete(tabId);
});

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

function jobBroadcast(job, extra) {
  const prev = job.progress || {};
  job.progress = {
    ...prev,
    ...extra,
    cues: extra.cues || prev.cues,
    at: Date.now()
  };
  broadcast({
    type: "ASR_PROGRESS",
    tabId: job?.tabId || 0,
    jobId: job?.jobId || "",
    bvid: job?.bvid || "",
    cid: job?.cid || 0,
    ...job.progress
  });
}

function findAsrJob({ jobId, tabId, bvid, cid }) {
  if (jobId && asrJobs.has(jobId)) return asrJobs.get(jobId);
  for (const job of asrJobs.values()) {
    if (bvid && job.bvid && job.bvid !== bvid) continue;
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
    ...(job.progress || {})
  };
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    credentials: "include",
    headers: {
      Accept: "application/json, text/plain, */*",
      ...(options.headers || {})
    },
    ...options
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
    epId: String(ep.ep_id || ep.id || epId || "")
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

async function fetchCues(url) {
  const json = await fetchJson(normalizeSubtitleUrl(url));
  const body = Array.isArray(json?.body) ? json.body : [];
  return body
    .map((item, index) => ({
      from: Number(item.from) || 0,
      to: Number(item.to) || 0,
      content: String(item.content || "").replace(/\s+/g, " ").trim(),
      sid: item.sid || index + 1
    }))
    .filter((item) => item.content);
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

async function loadCachedAsr(bvid, cid) {
  const key = asrCacheKey(bvid, cid);
  const data = await chrome.storage.local.get(key);
  const cached = data[key] || null;
  if (!cached?.cues?.length) return cached;
  // 旧版按字硬切的缓存拼回去；B 站官方字幕不走这里
  const refined = refineCues(cached.cues);
  const changed = refined.length !== cached.cues.length
    || refined.some((cue, i) => cue.content !== cached.cues[i]?.content);
  if (changed) {
    cached.cues = refined;
    await chrome.storage.local.set({ [key]: { ...cached, savedAt: Date.now() } });
  }
  return cached;
}

async function saveCachedAsr(bvid, cid, payload) {
  const key = asrCacheKey(bvid, cid);
  await chrome.storage.local.set({
    [key]: {
      ...payload,
      savedAt: Date.now()
    }
  });
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
  await chrome.storage.local.set({
    [key]: {
      ...payload,
      savedAt: Date.now()
    }
  });
}

async function clearAsrJob(bvid, cid) {
  await chrome.storage.local.remove(asrJobKey(bvid, cid));
}

function chunkStartKey(start) {
  return Math.round((Number(start) || 0) * 10) / 10;
}

function hydratePart(chunk, saved, index) {
  return {
    i: index,
    start: chunk.start || 0,
    overlap: chunk.overlap || 0,
    cues: saved?.cues || []
  };
}

function partCoversChunk(part, chunk) {
  const cues = part?.cues || [];
  if (!cues.length) return false;
  const lastTo = Math.max(...cues.map((cue) => Number(cue.to) || 0));
  const dur = (Number(chunk.end) || 0) - (Number(chunk.start) || 0);
  if (dur > 20) return lastTo >= dur - 8;
  return true;
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
  const pool = (saved?.parts || []).filter((part) => part && (part.cues?.length || part.start != null));
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
      .filter((part) => !used.has(part) && part.cues?.length)
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
      const lastTo = Math.max(...slice.map((cue) => Number(cue.to) || 0));
      const dur = (Number(chunks[i].end) || 0) - (Number(chunks[i].start) || 0);
      if (dur > 0 && lastTo >= dur - 8) {
        parts[i] = {
          i,
          start: chunks[i].start || 0,
          overlap: chunks[i].overlap || 0,
          cues: slice
        };
      }
    }
  }

  return parts;
}

function maxChunkSeconds() {
  return (self.BiliCaptionMp4?.CHUNK_SECONDS || 8 * 60) + MAX_CHUNK_SLACK;
}

function maxChunkBytes() {
  return self.BiliCaptionMp4?.CHUNK_BYTES || 20 * 1024 * 1024;
}

/**  Groq 看的是文件大小；时间轴标签不准时不能据此整段报废 */
function chunkFitsLimits(chunk) {
  const size = Number(chunk?.blob?.size) || 0;
  if (size <= 0 || size > MAX_UPLOAD_BYTES) return false;
  const dur = Number(chunk.end) - Number(chunk.start);
  if (Number.isFinite(dur) && dur > maxChunkSeconds()) {
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
      duration: part?.duration || view.duration || 0
    };
  } else if (page.kind === "bangumi") {
    meta = await fetchBangumi(page);
  } else {
    return { page: "other", tracks: [], cues: [], activeLan: "", error: "", login, canGenerate: false };
  }

  const player = await fetchPlayer(meta.aid, meta.cid);
  const rawTracks = player?.subtitle?.subtitles || [];
  const tracks = rawTracks
    .map((item) => ({
      lan: item.lan || "",
      lanDoc: item.lan_doc || item.lan || "字幕",
      url: item.subtitle_url || "",
      aiType: item.ai_type,
      aiStatus: item.ai_status
    }))
    .filter((item) => item.url);

  const preferred = pickDefaultTrack(tracks);
  let cues = [];
  let activeLan = "";
  let source = "";
  let error = "";
  let notice = "";
  const cached = await loadCachedAsr(meta.bvid, meta.cid);
  const asrJob = await loadAsrJob(meta.bvid, meta.cid);
  const lastCueTo = Math.max(0, ...(cached?.cues || []).map((cue) => Number(cue.to) || 0));
  const looksIncomplete = lastCueTo > 20 && Number(meta.duration) > 0 && lastCueTo < Number(meta.duration) - 90;
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
  } else if (!login.isLogin) {
    error = "未登录或登录态无效，B 站通常不返回字幕。请先在浏览器登录 bilibili.com。";
  } else {
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
    tracks,
    activeLan,
    cues,
    login,
    source,
    canGenerate: true,
    partial,
    asrDone: Math.max(
      Number(asrJob?.done) || 0,
      Number(asrJob?.parts?.length) || 0,
      lastCueTo > 20 ? Math.max(1, Math.round(lastCueTo / (8 * 60))) : 0
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

function estimatedChunkCount(duration) {
  const maxChunk = BiliCaptionMp4.CHUNK_SECONDS || 8 * 60;
  if (!(Number(duration) > 0)) return 1;
  return Math.max(1, Math.ceil(Number(duration) / maxChunk));
}

async function downloadAudio(stream, onProgress, signal) {
  onProgress?.("正在下载音频…");
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
  while (true) {
    throwIfAborted(signal);
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
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
  const blob = new Blob(chunks, { type: mime });
  appLog("info", "bili", `音频下载完成 ${mbOf(blob.size)}MB`, { mb: mbOf(blob.size) });
  return blob;
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

function mergeChunkCues(parts) {
  const all = [];
  for (const part of parts) {
    const keepAfter = part.start + (part.overlap ? part.overlap * 0.45 : 0);
    for (const cue of part.cues) {
      const from = Number(cue.from) + part.start;
      const to = Number(cue.to) + part.start;
      if (all.length && from < keepAfter) continue;
      all.push({
        from,
        to,
        content: cue.content,
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
  const end = Date.now() + Math.max(2000, ms) + 1500;
  while (Date.now() < end) {
    throwIfAborted(signal);
    const left = end - Date.now();
    emitProgress(onProgress, {
      stage: "wait",
      message: extra.waitKind === "retry"
        ? `${extra.waitReason || "Groq 暂时繁忙"}，${formatWait(left)} 后重试`
        : `额度冷却中，${formatWait(left)} 后继续`,
      waitUntil: end,
      ...extra
    });
    await sleep(Math.min(5000, left), signal);
  }
  emitProgress(onProgress, {
    stage: "upload",
    message: "冷却结束，正在重试当前分段…",
    waitUntil: 0,
    ...extra
  });
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
    try {
      appLog("info", "groq", `上传第 ${options.current || 1}/${options.total || 1} 段 ${mbOf(blob.size)}MB`, {
        mb: mbOf(blob.size),
        current: options.current,
        total: options.total,
        try: transientTries + 1
      });
      return await transcribeWithGroq(blob, options);
    } catch (error) {
      if (error?.name === "AbortError" || options.signal?.aborted) throw error;
      if (Number(error?.requested) > maxChunkSeconds() + 20) {
        throw new Error(
          `这一段实际约 ${Math.round(Number(error.requested) / 60)} 分钟，超过约 8 分钟上限，已停下以免浪费额度`
        );
      }
      const retryable = Boolean(error?.quota || error?.retryable || error?.retryAfter);
      if (!retryable) {
        appLog("error", "groq", error.message || String(error), {
          status: error.status,
          current: options.current,
          total: options.total
        });
        throw error;
      }
      if (!error?.quota) transientTries += 1;
      if (!error?.quota && transientTries > 6) {
        const giveUp = `${error.message || "Groq 临时故障"}。已保存前面的段落，可点继续生成`;
        appLog("error", "groq", giveUp, { current: options.current, total: options.total, try: transientTries });
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
      const extra = {
        done: options.done || 0,
        total: options.total || 0,
        current: options.current || 0,
        waitKind: error?.quota ? "quota" : "retry",
        waitReason: error?.quota ? "" : (error.status ? `Groq 错误 ${error.status}` : "网络暂时中断")
      };
      appLog(
        error?.quota ? "warn" : "error",
        "groq",
        error?.quota
          ? `额度冷却，${formatWait(wait)} 后继续第 ${options.current || "?"} 段`
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
          ? `额度冷却中，${formatWait(wait)} 后继续`
          : `Groq 繁忙（${error.status || "临时故障"}），${formatWait(wait)} 后重试第 ${options.current || "?"} 段`,
        waitUntil: Date.now() + wait + 1500,
        ...extra
      });
      await waitForQuota(wait, options.signal, options.onProgress, extra);
    }
  }
}

async function persistAsrProgress({ bvid, cid, tabId, fingerprint, parts, total, language, onProgress }) {
  const ready = parts.filter(Boolean);
  const cues = ready.length > 1 ? mergeChunkCues(ready) : (ready[0]?.cues || []);
  const pending = ready.length < total;
  await saveAsrJob(bvid, cid, {
    fingerprint,
    parts: ready,
    total,
    done: ready.length,
    pending
  });
  if (cues.length) {
    await saveCachedAsr(bvid, cid, {
      cues,
      language: language || "",
      model: GROQ_MODEL,
      activeLan: "groq-asr",
      source: "groq",
      partial: pending
    });
  }
  if (tabId && cues.length) {
    chrome.tabs.sendMessage(tabId, {
      type: "APPLY_ASR_CUES",
      cues,
      activeLan: "groq-asr",
      source: "groq",
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
    total,
    cues,
    partial: pending,
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
  forceRestart
}) {
  const maxChunk = BiliCaptionMp4.CHUNK_SECONDS || 8 * 60;
  const mustSplit = blob.size > MAX_UPLOAD_BYTES || Number(duration) > maxChunk + MAX_CHUNK_SLACK;
  const shouldSplit = mustSplit || Number(duration) > maxChunk + 5 || blob.size > maxChunkBytes();
  let chunks = [];
  if (shouldSplit) {
    emitProgress(onProgress, {
      message: `音频约 ${Math.round(Number(duration) || 0) || "?"} 秒，按 8 分钟且小于 24MB 切片…`
    });
    try {
      chunks = await BiliCaptionMp4.splitAudio(blob);
    } catch (error) {
      if (mustSplit) throw error;
    }
  }
  if (!chunks.length) {
    const unknownLong = !(Number(duration) > 0) && blob.size > maxChunkBytes();
    if (mustSplit || unknownLong) {
      throw new Error("音频太长或无法切片。每段必须同时小于 24MB 且不超过约 8 分钟");
    }
    chunks = [{
      blob,
      filename: `audio.${guessExt(blob.type)}`,
      start: 0,
      end: Number(duration) || 0,
      overlap: 0
    }];
  }
  const oversized = chunks.find((chunk) => !chunkFitsLimits(chunk));
  if (oversized) {
    throw new Error(`切片后仍超限（${chunkLimitLabel(oversized)}）。每段必须同时小于 24MB 且不超过约 8 分钟`);
  }

  const fingerprint = `${blob.size}:${Math.round(Number(duration) || 0)}:${chunks.length}:${chunks[0]?.filename || "bin"}`;
  appLog("info", "asr", `音频 ${mbOf(blob.size)}MB / ${Math.round(Number(duration) || 0)} 秒，切成 ${chunks.length} 段（${chunks[0]?.filename || "bin"}）`, {
    mb: mbOf(blob.size),
    chunks: chunks.length
  });
  const saved = forceRestart ? null : await loadAsrJob(bvid, cid);
  const cachedAsr = forceRestart ? null : await loadCachedAsr(bvid, cid);
  const parts = matchSavedParts(chunks, saved, cachedAsr?.cues || []);

  const skipped = parts.filter(Boolean).length;
  if (skipped) {
    appLog("info", "asr", `从断点继续，已有 ${skipped}/${chunks.length} 段`, { done: skipped, chunks: chunks.length });
    emitProgress(onProgress, {
      message: `已有 ${skipped}/${chunks.length} 段结果，从断点继续…`,
      done: skipped,
      total: chunks.length
    });
  }

  throwIfAborted(signal);
  for (let i = 0; i < chunks.length; i += 1) {
    throwIfAborted(signal);
    const chunk = chunks[i];
    const done = parts.filter(Boolean).length;
    if (parts[i]) {
      emitProgress(onProgress, {
        message: `第 ${i + 1}/${chunks.length} 段已转写过，跳过`,
        done,
        total: chunks.length
      });
      continue;
    }
    emitProgress(onProgress, {
      stage: "upload",
      message: chunks.length > 1
        ? `Groq 正在识别第 ${i + 1}/${chunks.length} 段（约 1–2 分钟）`
        : `Groq 正在识别（${(chunk.blob.size / 1024 / 1024).toFixed(1)}MB，约 1–2 分钟）`,
      done,
      total: chunks.length,
      current: i + 1,
      waitUntil: 0
    });
    const result = await transcribeOne(chunk.blob, {
      apiKey,
      language,
      signal,
      filename: chunk.filename,
      onProgress,
      done,
      total: chunks.length,
      current: i + 1
    });
    parts[i] = {
      i,
      start: chunk.start || 0,
      overlap: chunk.overlap || 0,
      cues: segmentsToCues(result)
    };
    await persistAsrProgress({
      bvid,
      cid,
      tabId,
      fingerprint,
      parts,
      total: chunks.length,
      language,
      onProgress
    });
  }

  const ready = parts.filter(Boolean);
  const cues = chunks.length > 1 ? mergeChunkCues(ready) : (ready[0]?.cues || []);
  if (!cues.length) {
    await clearAsrJob(bvid, cid);
    throw new Error("Groq 没有识别出有效文本");
  }
  await clearAsrJob(bvid, cid);
  return { text: cues.map((cue) => cue.content).join(""), segments: cues, words: [], cues };
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
  totalHint
}) {
  const total = Math.max(Number(totalHint) || 1, parts.length, index + 1);
  const done = parts.filter(Boolean).length;
  if (parts[index]) {
    emitProgress(onProgress, {
      message: `第 ${index + 1}/${total} 段已转写过，跳过`,
      done,
      total
    });
    return;
  }
  if (!chunkFitsLimits(chunk)) {
    appLog("warn", "asr", `第 ${index + 1} 段 ${chunkLimitLabel(chunk)}，再切开后继续`);
    const pieces = await BiliCaptionMp4.splitAudio(chunk.blob).catch(() => []);
    if (!pieces.length || (pieces.length === 1 && (pieces[0].blob?.size || 0) >= (chunk.blob?.size || 1))) {
      throw new Error(`切片后仍超限（${chunkLimitLabel(chunk)}）。每段必须同时小于 24MB 且不超过约 8 分钟`);
    }
    for (let p = 0; p < pieces.length; p += 1) {
      const piece = {
        ...pieces[p],
        start: Number(chunk.start) + Number(pieces[p].start || 0),
        end: Number(chunk.start) + Number(pieces[p].end || 0)
      };
      await transcribeOneIncoming(piece, index + p, parts, {
        apiKey,
        language,
        signal,
        onProgress,
        bvid,
        cid,
        tabId,
        duration,
        totalHint: Math.max(total, index + pieces.length)
      });
    }
    return;
  }
  emitProgress(onProgress, {
    stage: "upload",
    message: total > 1
      ? `正在转写 ${index + 1}/${total}（边下边传）`
      : `正在上传到 Groq（${mbOf(chunk.blob.size)}MB）`,
    done,
    total,
    current: index + 1,
    waitUntil: 0
  });
  const result = await transcribeOne(chunk.blob, {
    apiKey,
    language,
    signal,
    filename: chunk.filename,
    onProgress,
    done,
    total,
    current: index + 1
  });
  parts[index] = {
    i: index,
    start: chunk.start || 0,
    overlap: chunk.overlap || 0,
    cues: segmentsToCues(result)
  };
  await persistAsrProgress({
    bvid,
    cid,
    tabId,
    fingerprint: `stream:${Math.round(Number(duration) || 0)}:${total}`,
    parts,
    total,
    language,
    onProgress
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
  forceRestart
}) {
  emitProgress(onProgress, { stage: "download", message: "开始拉取音轨，切出一段就上传…" });
  const { res, total: totalBytes, mime } = await openAudioDownload(stream, signal);
  if (!res.body) {
    const buf = await res.arrayBuffer();
    return transcribeChunks(new Blob([buf], { type: mime }), {
      apiKey, language, signal, onProgress, duration, bvid, cid, tabId, forceRestart
    });
  }

  const estimated = estimatedChunkCount(duration);
  const saved = forceRestart ? null : await loadAsrJob(bvid, cid);
  const cachedAsr = forceRestart ? null : await loadCachedAsr(bvid, cid);
  const reader = res.body.getReader();
  const chunks = [];
  const parts = [];
  let received = 0;

  try {
    for await (const item of BiliCaptionMp4.iterateFmp4Chunks(reader, {
      signal,
      onBytes(n) {
        received = n;
        if (n > MAX_DOWNLOAD_BYTES) {
          reader.cancel().catch(() => {});
          throw new Error("音频文件过大，请换更短视频");
        }
        const pct = totalBytes ? Math.min(99, Math.round((n / totalBytes) * 100)) : 0;
        const total = Math.max(estimated, chunks.length || 1);
        emitProgress(onProgress, {
          stage: "download",
          message: pct
            ? `下载 ${pct}% · 已切 ${chunks.length}/${total} 段`
            : `已下载 ${mbOf(n)}MB · 已切 ${chunks.length} 段`,
          done: parts.filter(Boolean).length,
          total
        });
      }
    })) {
      throwIfAborted(signal);
      if (item.fallback) {
        appLog("info", "asr", "音频不是分片封装，改走整段切片");
        return transcribeChunks(item.blob, {
          apiKey, language, signal, onProgress, duration, bvid, cid, tabId, forceRestart
        });
      }
      chunks.push(item);
      const mapped = matchSavedParts(chunks, saved, cachedAsr?.cues || []);
      for (let i = 0; i < mapped.length; i += 1) {
        if (mapped[i] && !parts[i]) parts[i] = mapped[i];
      }
      const index = chunks.length - 1;
      if (index === 0) {
        appLog("info", "asr", `已切出第 1 段 ${mbOf(item.blob.size)}MB（${item.filename || "bin"}），开始边下边传`, {
          mb: Number(mbOf(item.blob.size)),
          estimated
        });
      }
      await transcribeOneIncoming(item, index, parts, {
        apiKey,
        language,
        signal,
        onProgress,
        bvid,
        cid,
        tabId,
        duration,
        totalHint: Math.max(estimated, chunks.length)
      });
    }
  } catch (error) {
    if (error?.name === "AbortError" || signal?.aborted) throw error;
    if (/过大/.test(error?.message || "")) throw error;
    if (!/DataView|Offset is outside|封装无法切片/i.test(error?.message || "")) throw error;
    appLog("warn", "asr", `边下边切失败，改走整段下载：${error.message || error}`);
    const blob = await downloadAudio(stream, (message) => {
      emitProgress(onProgress, { stage: "download", message });
    }, signal);
    return transcribeChunks(blob, {
      apiKey, language, signal, onProgress, duration, bvid, cid, tabId, forceRestart
    });
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  if (!chunks.length) {
    throw new Error("音频封装无法切片，请换更短视频或使用官方字幕");
  }

  appLog("info", "asr", `音频 ${mbOf(received)}MB / ${Math.round(Number(duration) || 0)} 秒，切成 ${chunks.length} 段`, {
    mb: mbOf(received),
    chunks: chunks.length,
    streamed: true
  });

  const ready = parts.filter(Boolean);
  const cues = chunks.length > 1 ? mergeChunkCues(ready) : (ready[0]?.cues || []);
  if (!cues.length) {
    await clearAsrJob(bvid, cid);
    throw new Error("Groq 没有识别出有效文本");
  }
  await clearAsrJob(bvid, cid);
  return { text: cues.map((cue) => cue.content).join(""), segments: cues, words: [], cues };
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

async function transcribeWithGroq(blob, { apiKey, language, signal, filename, current, total }) {
  const form = new FormData();
  const ext = filename?.includes(".") ? filename.split(".").pop() : guessExt(blob.type);
  form.append("file", blob, filename || `audio.${ext}`);
  form.append("model", GROQ_MODEL);
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  form.append("timestamp_granularities[]", "segment");
  form.append("timestamp_granularities[]", "word");
  if (language) form.append("language", language);
  if (language === "zh") form.append("prompt", "请使用简体中文转写。");

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
    throw new Error(`Groq 返回异常：${text.slice(0, 200)}`);
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
    throw new Error(raw);
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
    .map((seg, index) => ({
      from: Number(seg.start) || 0,
      to: Number(seg.end) || 0,
      content: String(seg.text || "").replace(/\s+/g, " ").trim(),
      sid: index + 1
    }))
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

const HARD_PUNCT = /[。！？；!?\u2026]/;
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

/** 按句读切开，保留标点在上一片末尾 */
function splitByPunctuation(text) {
  const src = String(text || "").replace(/\s+/g, " ").trim();
  if (!src) return [];
  const parts = src.split(/(?<=[。！？；!?\u2026])/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) return parts;

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

function splitLongCue(cue, words) {
  if (!shouldSplitCue(cue)) return [cue];

  const hard = String(cue.content || "")
    .split(/(?<=[。！？；!?\u2026])/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (hard.length > 1) return allocateTimesByWords(cue.from, cue.to, hard, words);

  const dur = Math.max(0, (Number(cue.to) || 0) - (Number(cue.from) || 0));
  if (cueLen(cue.content) <= 72 && dur <= 16) return [cue];

  let pieces = splitByPunctuation(cue.content);
  if (pieces.length <= 1) return [cue];
  return allocateTimesByWords(cue.from, cue.to, pieces, words);
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
      prev.content = `${prev.content}${cue.content}`.replace(/\s+/g, " ").trim();
      prev.to = cue.to;
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
      prev.content = `${prev.content}${cue.content}`.replace(/\s+/g, " ").trim();
      prev.to = cue.to;
      continue;
    }
    out.push({ ...cue });
  }
  return out;
}

function toSimplified(text) {
  return self.BiliCaptionZh?.toSimplified?.(text) || String(text || "");
}

function refineAsrCues(cues, words = []) {
  const source = looksLikeHardWrap(cues) ? stitchBrokenWraps(cues) : cues;
  const flat = [];
  for (const cue of source) {
    for (const part of splitLongCue(cue, words)) {
      if (!part.content) continue;
      flat.push({
        from: part.from,
        to: part.to,
        content: toSimplified(part.content),
        sid: flat.length + 1
      });
    }
  }
  return mergeTinyCues(flat);
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

  const bufText = () => buf
    .map((w) => w.word)
    .join("")
    .replace(/\s+/g, " ")
    .replace(/\s+([，。！？；、,.!?])/g, "$1")
    .trim();

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

    const { groqApiKey, asrLanguage } = await chrome.storage.sync.get({
      groqApiKey: "",
      asrLanguage: ""
    });
    throwIfAborted(signal);
    if (!groqApiKey) {
      throw new Error("请先在设置里填写 Groq API Key（console.groq.com）");
    }

    try {
      await chrome.permissions.request({ origins: ["https://api.groq.com/*"] });
    } catch {
      // optional
    }

    const meta = await resolveVideoMeta(input);
    throwIfAborted(signal);
    job.bvid = meta.bvid || job.bvid;
    job.cid = meta.cid || job.cid;
    const lockKey = `${meta.bvid || "bv"}:${meta.cid || 0}`;
    const live = asrJobLocks.get(lockKey);
    if (live) {
      job.joined = true;
      asrJobs.delete(jobId);
      return live;
    }

    const existingJob = await loadAsrJob(meta.bvid, meta.cid);
    const cachedAsr = await loadCachedAsr(meta.bvid, meta.cid);
    const lastCueTo = Math.max(0, ...(cachedAsr?.cues || []).map((cue) => Number(cue.to) || 0));
    const looksIncomplete = lastCueTo > 20 && Number(meta.duration) > 0 && lastCueTo < Number(meta.duration) - 90;
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
      groqApiKey,
      asrLanguage,
      forceRestart
    });
    asrJobLocks.set(lockKey, work);
    try {
      return await work;
    } finally {
      if (asrJobLocks.get(lockKey) === work) asrJobLocks.delete(lockKey);
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

function startAsr(input, sender) {
  const existing = findAsrJob({
    bvid: input.bvid,
    cid: input.cid,
    tabId: input.tabId || sender?.tab?.id
  });
  if (existing) {
    return { started: true, joined: true, jobId: existing.jobId };
  }

  const jobId = String(input.jobId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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
      onProgress: (info) => {
        const extra = typeof info === "string" ? { message: info } : info;
        jobBroadcast(job, { stage: extra.stage || "upload", ...extra });
      }
    });

    throwIfAborted(signal);
    const cues = result.cues?.length ? result.cues : segmentsToCues(result);
    if (!cues.length) throw new Error("Groq 没有识别出有效文本");

    throwIfAborted(signal);
    await saveCachedAsr(meta.bvid, meta.cid, {
      cues,
      language: result.language || asrLanguage || "",
      model: GROQ_MODEL,
      activeLan: "groq-asr",
      source: "groq",
      partial: false
    });

    appLog("info", "asr", `生成完成 ${cues.length} 条`, { cues: cues.length, bvid: meta.bvid, cid: meta.cid });
    jobBroadcast(job, {
      stage: "done",
      message: `已生成 ${cues.length} 条字幕`,
      done: job.progress?.total || 1,
      total: job.progress?.total || 1,
      cues,
      partial: false,
      waitUntil: 0
    });

    return {
      cues,
      activeLan: "groq-asr",
      source: "groq",
      language: result.language || asrLanguage || "",
      model: GROQ_MODEL,
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
      cues: message.cues || [],
      activeLan: message.activeLan || "",
      source: message.source || "groq"
    }).then(() => ({ ok: true })));
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
    cancelAsrJob(message.jobId, {
      bvid: message.bvid,
      cid: message.cid,
      tabId: message.tabId
    });
    sendResponse({ ok: true });
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
      tabId: message.tabId || _sender.tab?.id,
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
  if (message?.type === "CLOSE_SIDE_PANEL") {
    return reply((async () => {
      const ctx = await resolvePanelContext(_sender);
      if (ctx.tabId) immersiveByTab.set(ctx.tabId, { immersive: true, windowId: ctx.windowId });
      await hideChromeSidePanel(ctx.tabId);
      return { ok: true };
    })());
  }
  if (message?.type === "RESTORE_SIDE_PANEL") {
    const tabId = _sender.tab?.id;
    const windowId = _sender.tab?.windowId;
    if (tabId) immersiveByTab.set(tabId, { immersive: false, windowId });
    // 必须立刻 open()，前面不能 await，否则点「侧栏」会丢掉用户手势
    showChromeSidePanel(tabId, windowId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  return false;
});
