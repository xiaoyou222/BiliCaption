const GEN_STEPS = ["拉取音频流", "上传 Groq 转写", "对齐时间轴"];
if (window.top !== window) document.documentElement.classList.add("float-embed");

const $ = (id) => document.getElementById(id);

const ui = {
  btnSettings: $("btnSettings"),
  btnFloat: $("btnFloat"),
  header: document.querySelector(".header"),
  loginDot: $("loginDot"),
  loginLabel: $("loginLabel"),
  headerTitle: $("headerTitle"),
  userName: $("userName"),
  vipChip: $("vipChip"),
  noVideoView: $("noVideoView"),
  noVideoTitle: $("noVideoTitle"),
  lastVideoHint: $("lastVideoHint"),
  videoView: $("videoView"),
  controlRow: $("controlRow"),
  trackSelect: $("trackSelect"),
  speedSelect: $("speedSelect"),
  speedBtn: $("speedBtn"),
  speedValue: $("speedValue"),
  speedMenu: $("speedMenu"),
  viewTabs: $("viewTabs"),
  emptyView: $("emptyView"),
  emptyKeyHint: $("emptyKeyHint"),
  emptyEstimate: $("emptyEstimate"),
  generatingView: $("generatingView"),
  genThink: $("genThink"),
  jobPill: $("jobPill"),
  asrJobBar: $("asrJobBar"),
  asrJobTitle: $("asrJobTitle"),
  asrJobFill: $("asrJobFill"),
  trJobBar: $("trJobBar"),
  trJobTitle: $("trJobTitle"),
  trJobFill: $("trJobFill"),
  errorView: $("errorView"),
  errorTitle: $("errorTitle"),
  errorPrimary: $("errorPrimary"),
  outlineEmpty: $("outlineEmpty"),
  outlineEmptyLabel: $("outlineEmptyLabel"),
  outlineList: $("outlineList"),
  outlineBar: $("outlineBar"),
  summaryBox: $("summaryBox"),
  summaryTitle: $("summaryTitle"),
  summaryThink: $("summaryThink"),
  summaryText: $("summaryText"),
  summaryMeta: $("summaryMeta"),
  outlineThink: $("outlineThink"),
  outlineHead: $("outlineHead"),
  outlineEmptyIcon: $("outlineEmptyIcon"),
  cueList: $("cueList"),
  cueWrap: $("cueWrap"),
  selectTrail: $("selectTrail"),
  selectBar: $("selectBar"),
  selectInfo: $("selectInfo"),
  actionBar: $("actionBar"),
  btnGenerate: $("btnGenerate"),
  btnGenerateEmpty: $("btnGenerateEmpty"),
  btnSelect: $("btnSelect"),
  btnOverlay: $("btnOverlay"),
  btnMore: $("btnMore"),
  moreMenu: $("moreMenu"),
  toast: $("toast")
};

let state = null;
let lastVideo = null;
let lastLogin = null;
let generating = false;
let generateToken = 0;
let genError = "";
let selecting = false;
let selectHeld = false;
let selKey = "Shift";
let hasSttKey = false;
let range = { start: -1, end: -1 };
let anchor = -1;
let dragSelect = null;
let lastPointer = { x: 0, y: 0 };
let ignoreCueClickUntil = 0;
let hoverSelectFrom = null;
let selKeyHeldFromPage = null;
let trailPoints = [];
let lastActiveIndex = -1;
let lastCuesSig = "";
let cueRowEls = [];
let lastOutlineIndex = -1;
let cueScrollRaf = 0;
let cueScrollAnim = null;
let userCueScrollAt = 0;
let moreOpen = false;
let toastTimer = 0;
let summaryModel = "";
let hasSummary = false;
let lastRenderKey = "";
let overlayOn = true;
let summaryPad = 10;
let view = "captions";
let outline = null;
let outlineLoading = false;
let outlineRaf = 0;
let errorMode = "";
let stopSummaryOrb = null;
let stopOutlineOrb = null;
let stopGenerateOrb = null;
let lastGenLabel = "";
let boundTabId = 0;
let panelWindowId = 0;
let asrJobId = "";
let myTabId = 0;
let asrProgress = null;
let asrWaitTimer = 0;
let asrWatchTimer = 0;
let asrMissingChecks = 0;
let asrStopReason = "";
let translating = false;
let translateToken = 0;
let translateProgress = { done: 0, total: 0 };
let translatedCueText = new Map();
let translatedCueVideoKey = "";

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function srtTime(seconds) {
  const ms = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const rest = ms % 1000;
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(rest, 3)}`;
}

function toSrt(cues) {
  return cues
    .map((cue, i) => `${i + 1}\n${srtTime(cue.from)} --> ${srtTime(cue.to)}\n${cue.content}\n`)
    .join("\n");
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function safeName(name) {
  return (name || "bilibili").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderMarkdownLite(text) {
  let html = escapeHtml(text || "");
  html = html.replace(/```[\s\S]*?```/g, (block) => {
    const body = block.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "");
    return `<code class="md-block">${body}</code>`;
  });
  html = html.replace(/\*\*(.+?)\*\*/g, "$1");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/(^|\n)\s*[-*]\s+/g, "$1• ");
  html = html.replace(/(^|\n)\s*\d+\.\s+/g, "$1");
  return html;
}

function setSummaryBody(text) {
  ui.summaryText.innerHTML = renderMarkdownLite(text);
}

function keyLabel(key) {
  return key.length === 1 ? key.toUpperCase() : key;
}

function flash(msg, duration = 1600) {
  ui.toast.textContent = msg;
  ui.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.add("hidden"), duration);
}

function inFloatEmbed() {
  return document.documentElement.classList.contains("float-embed");
}

function isForThisPanel(message, sender) {
  const tabId = Number(message?.tabId || sender?.tab?.id) || 0;
  if (inFloatEmbed()) {
    if (myTabId && tabId && tabId !== myTabId) return false;
    return true;
  }
  if (boundTabId && tabId && tabId !== boundTabId) return false;
  return true;
}

async function getActiveTab() {
  if (inFloatEmbed() && myTabId) {
    try {
      return await chrome.tabs.get(myTabId);
    } catch {
      // fall through
    }
  }
  if (boundTabId) {
    try {
      const tab = await chrome.tabs.get(boundTabId);
      if (tab) return tab;
    } catch {
      // fall through
    }
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function pingTab(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return Boolean(res?.ok);
  } catch {
    return false;
  }
}

async function ensureContentScript(tabId) {
  if (!tabId) return false;
  if (await pingTab(tabId)) return true;
  if (!chrome.scripting?.executeScript) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    return pingTab(tabId);
  } catch {
    return false;
  }
}

function waitTabComplete(tabId, timeout = 20000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const timer = setTimeout(finish, timeout);
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        finish();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab?.status === "complete") {
        clearTimeout(timer);
        finish();
      }
    }).catch(() => {
      clearTimeout(timer);
      finish();
    });
  });
}

async function sendToTab(message, tabId = 0) {
  const id = tabId || (inFloatEmbed() ? myTabId : boundTabId);
  if (id) {
    await ensureContentScript(id);
    return chrome.tabs.sendMessage(id, message);
  }
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error("没有活动标签页");
  if (!inFloatEmbed()) boundTabId = tab.id;
  await ensureContentScript(tab.id);
  return chrome.tabs.sendMessage(tab.id, message);
}

function selectedCues() {
  if (!state?.cues?.length || range.start < 0 || range.end < 0) return [];
  const from = Math.min(range.start, range.end);
  const to = Math.max(range.start, range.end);
  return state.cues.slice(from, to + 1);
}

function cueLines(list) {
  return list.map((cue) => cue.content).join("\n");
}

function buildSummaryPrompt(from, to) {
  const all = state.cues;
  const selected = all.slice(from, to + 1);
  const pad = Math.min(50, Math.max(0, Math.round(Number(summaryPad) || 0)));
  const before = pad ? all.slice(Math.max(0, from - pad), from) : [];
  const after = pad ? all.slice(to + 1, to + 1 + pad) : [];
  const parts = [
    "请用中文总结【选区】这段视频字幕，分 3-6 条要点，保留关键术语。每条一行，以 \"- \" 开头。不要加粗、不要标题。",
    "【上文】和【下文】只用来理解指代和背景，不要写进要点，也不要总结它们。"
  ];
  if (before.length) parts.push(`【上文】\n${cueLines(before)}`);
  parts.push(`【选区】\n${cueLines(selected)}`);
  if (after.length) parts.push(`【下文】\n${cueLines(after)}`);
  return parts.join("\n\n");
}

function show(el, on) {
  el.classList.toggle("hidden", !on);
}

const SPEED_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4];

function currentRate() {
  return Math.min(10, Math.max(0.1, Math.round((Number(state?.rate) || 1) * 10) / 10));
}

function formatRate(rate) {
  const n = Math.min(10, Math.max(0.1, Math.round((Number(rate) || 1) * 10) / 10));
  return Number.isInteger(n) ? `${n}×` : `${n.toFixed(1)}×`;
}

function renderSpeed(rate) {
  const value = Math.min(10, Math.max(0.1, Math.round((Number(rate) || 1) * 10) / 10));
  if (state) state.rate = value;
  if (ui.speedValue) ui.speedValue.textContent = formatRate(value);
  ui.speedBtn?.classList.toggle("boosted", Math.abs(value - 1) > 0.001);
  if (!ui.speedMenu) return;
  const rates = SPEED_PRESETS.slice();
  if (!rates.some((item) => Math.abs(item - value) < 0.001)) rates.push(value);
  const html = rates.map((item) => {
    const on = Math.abs(item - value) < 0.001 ? " on" : "";
    return `<button type="button" role="option" data-rate="${item}" class="${on.trim()}">${formatRate(item)}</button>`;
  }).join("");
  if (ui.speedMenu.dataset.html !== html) {
    ui.speedMenu.dataset.html = html;
    ui.speedMenu.innerHTML = html;
  } else {
    ui.speedMenu.querySelectorAll("button").forEach((btn) => {
      btn.classList.toggle("on", Math.abs(Number(btn.dataset.rate) - value) < 0.001);
    });
  }
}

function setSpeedMenuOpen(open) {
  show(ui.speedMenu, open);
  ui.speedBtn?.setAttribute("aria-expanded", open ? "true" : "false");
}

function isVip(login) {
  if (!login?.isLogin) return false;
  if (Number(login.vipStatus) === 1) return true;
  if (Number(login.vipDueDate) > Date.now()) return true;
  return Number(login.vipType) > 0 && Number(login.vipStatus) === 1;
}

function renderLogin(login) {
  lastLogin = login || lastLogin;
  const data = lastLogin;
  const loggedIn = Boolean(data?.isLogin);
  ui.loginDot.className = `login-dot ${loggedIn ? "ok" : "warn"}`;
  ui.header.classList.toggle("warn", !loggedIn);

  const unknown = !data;
  ui.loginLabel.textContent = unknown ? "登录未知" : "未登录";
  show(ui.loginLabel, !loggedIn);

  const name = loggedIn ? String(data.uname || "").trim() : "";
  ui.userName.textContent = name;
  ui.userName.title = name;
  show(ui.userName, Boolean(name));
  show(ui.vipChip, isVip(data));
}

function renderHeaderTitle(next) {
  const title = String(next?.title || lastVideo?.title || "").trim();
  const part = String(next?.part || lastVideo?.part || "").trim();
  if (!title) {
    ui.headerTitle.textContent = next?.page === "other" ? "当前不是视频页" : "等待视频";
    ui.headerTitle.title = "";
    return;
  }
  ui.headerTitle.textContent = part && part !== title ? `${title} · ${part}` : title;
  ui.headerTitle.title = ui.headerTitle.textContent;
}

function persistLastVideo(next) {
  if (!next?.bvid && !next?.title) return;
  lastVideo = {
    title: next.title || lastVideo?.title || "",
    part: next.part || "",
    bvid: next.bvid || lastVideo?.bvid || ""
  };
  chrome.storage.local.set({ lastVideo }).catch(() => {});
}

function renderLastVideoHint() {
  if (!lastVideo?.bvid && !lastVideo?.part) {
    ui.lastVideoHint.textContent = "";
    return;
  }
  const bits = [lastVideo.bvid, lastVideo.part].filter(Boolean);
  ui.lastVideoHint.textContent = bits.length ? `上次：${bits.join(" · ")}` : "";
}

function outlineKey(next = state) {
  if (!next?.bvid && !next?.cid) return "";
  return `outline:${next.bvid || ""}:${next.cid || ""}`;
}

function setMoreOpen(open) {
  moreOpen = open;
  show(ui.moreMenu, open);
  ui.btnMore.classList.toggle("active", open);
  if (open) setSpeedMenuOpen(false);
}

function openSettings() {
  chrome.runtime.openOptionsPage();
}

function openBiliLogin() {
  chrome.tabs.create({ url: "https://passport.bilibili.com/login" });
}

function startOrb(host, options) {
  try {
    return globalThis.mountThinkingOrb?.(host, options) || (() => {});
  } catch {
    return () => {};
  }
}

function showSummaryThinking(on) {
  if (on) {
    if (stopSummaryOrb) return;
    if (!ui.summaryThink) return;
    show(ui.summaryThink, true);
    show(ui.summaryText, false);
    stopSummaryOrb = startOrb(ui.summaryThink, { state: "composing", size: 20, speed: 0.6, label: "总结中…" });
    return;
  }
  stopSummaryOrb?.();
  stopSummaryOrb = null;
  if (ui.summaryThink) {
    show(ui.summaryThink, false);
    show(ui.summaryText, true);
  }
}

function showOutlineThinking(on) {
  if (on) {
    if (stopOutlineOrb) return;
    if (ui.outlineThink) {
      stopOutlineOrb = startOrb(ui.outlineThink, { state: "searching", size: 20, speed: 0.6, label: "生成大纲…" });
    }
    return;
  }
  stopOutlineOrb?.();
  stopOutlineOrb = null;
}

function setOrbLabel(host, label) {
  const text = host?.querySelector(".think-pill-label");
  if (!text) return;
  text.dataset.text = label;
  text.textContent = label;
}

function showGenerateThinking(on, label) {
  if (label) lastGenLabel = label;
  if (!on) {
    stopGenerateOrb?.();
    stopGenerateOrb = null;
    return;
  }
  const text = lastGenLabel || `${GEN_STEPS[0]}…`;
  if (stopGenerateOrb) {
    setOrbLabel(ui.genThink, text);
    return;
  }
  if (ui.genThink) {
    stopGenerateOrb = startOrb(ui.genThink, { state: "searching", size: 20, speed: 0.6, label: text });
  }
}

function renderGenProgress(stage = "start", message = "") {
  if (message) {
    showGenerateThinking(true, message);
    return;
  }
  let step = 0;
  if (stage === "upload") step = 1;
  else if (stage === "done") step = 2;
  showGenerateThinking(true, `${GEN_STEPS[step]}…`);
}

function formatWait(ms) {
  const sec = Math.max(1, Math.ceil(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m} 分 ${s} 秒` : `${m} 分钟`;
}

function sameAsrVideo(info) {
  if (!info || !state) return !info?.bvid;
  if (info.bvid && state.bvid && info.bvid !== state.bvid) return false;
  if (info.cid && state.cid && Number(info.cid) !== Number(state.cid)) return false;
  return true;
}

function translationVideoKey(value = state) {
  const id = value?.bvid || value?.aid || "";
  const cid = Number(value?.cid) || 0;
  return id || cid ? `${id}:${cid}` : "";
}

function cueTranslationKey(cue) {
  return String(Math.round((Number(cue?.from) || 0) * 10));
}

function resetTranslationsFor(value = state) {
  const key = translationVideoKey(value);
  if (translatedCueVideoKey && key && translatedCueVideoKey !== key) {
    translatedCueText = new Map();
  }
  if (key) translatedCueVideoKey = key;
}

function rememberTranslatedCue(cue, content) {
  resetTranslationsFor(state);
  translatedCueText.set(cueTranslationKey(cue), String(content || ""));
}

function applyRememberedTranslations(cues) {
  if (!Array.isArray(cues) || !translatedCueText.size) {
    return Array.isArray(cues) ? cues.map((cue) => ({ ...cue })) : [];
  }
  return cues.map((cue) => {
    const content = translatedCueText.get(cueTranslationKey(cue));
    return content == null ? { ...cue } : { ...cue, content };
  });
}

function tickAsrWait() {
  clearInterval(asrWaitTimer);
  asrWaitTimer = 0;
  if (!asrProgress?.waitUntil || asrProgress.waitUntil <= Date.now()) return;
  asrWaitTimer = setInterval(() => {
    if (!asrProgress?.waitUntil || asrProgress.waitUntil <= Date.now()) {
      clearInterval(asrWaitTimer);
      asrWaitTimer = 0;
    }
    renderAsrJobBar();
  }, 1000);
}

function stopAsrWatch() {
  clearInterval(asrWatchTimer);
  asrWatchTimer = 0;
  asrMissingChecks = 0;
}

function startAsrWatch() {
  stopAsrWatch();
  let checking = false;
  asrWatchTimer = setInterval(async () => {
    if (!generating || checking) {
      if (!generating) stopAsrWatch();
      return;
    }
    checking = true;
    try {
      const status = await chrome.runtime.sendMessage({
        type: "GET_ASR_JOB",
        jobId: asrJobId,
        tabId: boundTabId || myTabId,
        bvid: state?.bvid,
        cid: state?.cid
      });
      if (status?.running) {
        asrMissingChecks = 0;
        if (status.stage !== "done") applyAsrProgress(status);
        return;
      }
      asrMissingChecks += 1;
      if (asrMissingChecks < 2) return;
      stopAsrWatch();
      generating = false;
      asrJobId = "";
      asrProgress = null;
      clearInterval(asrWaitTimer);
      asrStopReason = "Chrome 后台任务已中断";
      await refresh(true);
      if (state?.partial) flash("后台任务已中断，已保留进度，可继续生成", 6000);
    } catch {
      // 下一轮再确认，避免一次消息失败就误判任务中断
    } finally {
      checking = false;
    }
  }, 20 * 1000);
}

function renderAsrJobBar() {
  const bar = ui.asrJobBar;
  const trBar = ui.trJobBar;
  const pill = ui.jobPill;
  const hasCues = Boolean(state?.cues?.length);
  const partial = Boolean(state?.partial);
  const showAsr = Boolean(bar && hasCues && (generating || partial));
  const showTr = Boolean(trBar && hasCues && translating);
  const progress = asrProgress || {};
  const waitLeft = Math.max(0, (Number(progress.waitUntil) || 0) - Date.now());
  const waiting = generating && waitLeft > 0;

  if (pill) {
    show(pill, showAsr || showTr);
    pill.classList.toggle("is-split", showAsr && showTr);
    pill.classList.toggle("is-wait", showAsr && waiting);
    pill.classList.toggle("is-idle", showAsr && !generating && partial);
  }

  if (bar) {
    show(bar, showAsr);
    if (showAsr) {
      const asrDone = Number(generating ? progress.done ?? state?.asrDone : state?.asrDone) || 0;
      const asrTotal = Number(generating ? progress.total ?? state?.asrTotal : state?.asrTotal) || 0;
      const asrCurrent = Number(progress.current) || 0;
      const asrShown = generating
        ? (asrCurrent || (asrTotal ? Math.min(asrTotal, asrDone + 1) : 0))
        : asrDone;
      bar.classList.toggle("is-wait", waiting);
      if (ui.asrJobFill?.parentElement) show(ui.asrJobFill.parentElement, generating);
      if ($("btnCancelAsrJob")) show($("btnCancelAsrJob"), generating);
      if (ui.asrJobTitle) {
        const count = asrTotal ? `${asrShown}/${asrTotal}` : String(asrShown || "");
        const waitLabel = progress.waitKind === "quota" ? "额度冷却" : "重试";
        ui.asrJobTitle.textContent = waiting
          ? (count
            ? `${waitLabel} ${formatWait(waitLeft || 1000)} · ${count}`
            : `${waitLabel} ${formatWait(waitLeft || 1000)}`)
          : generating
            ? (count ? `转写中 ${count}` : "转写中")
            : (count ? `继续生成 ${count}` : "继续生成");
        ui.asrJobTitle.title = !generating && partial && asrStopReason
          ? asrStopReason
          : (progress.message || "");
      }
      if (ui.asrJobFill) {
        const pct = asrTotal ? Math.max(4, Math.min(100, Math.round((asrShown / asrTotal) * 100))) : 8;
        ui.asrJobFill.style.width = `${pct}%`;
      }
    }
  }

  if (trBar) {
    show(trBar, showTr);
    if (showTr) {
      const done = Number(translateProgress.done) || 0;
      const total = Number(translateProgress.total) || 0;
      if (ui.trJobTitle) ui.trJobTitle.textContent = total ? `翻译中 ${done}/${total}` : "翻译中";
      if (ui.trJobFill) {
        const pct = total ? Math.max(4, Math.min(100, Math.round((done / total) * 100))) : 8;
        ui.trJobFill.style.width = `${pct}%`;
      }
    }
  }
}

function applyAsrProgress(info) {
  if (!info || !sameAsrVideo(info)) return;
  const hadCues = Boolean(state?.cues?.length);
  asrProgress = {
    done: info.done != null ? Number(info.done) : asrProgress?.done || 0,
    total: info.total != null ? Number(info.total) : asrProgress?.total || 0,
    waitUntil: Number(info.waitUntil) || 0,
    message: info.message || asrProgress?.message || "",
    stage: info.stage || "",
    current: info.current != null ? Number(info.current) : asrProgress?.current || 0,
    waitKind: info.stage === "wait" ? (info.waitKind || asrProgress?.waitKind || "") : "",
    running: info.running !== false && info.stage !== "done"
  };
  if (info.cues?.length) {
    const cues = applyRememberedTranslations(info.cues);
    const translated = translatedCueText.size > 0;
    state = {
      ...(state || {}),
      cues,
      source: translated ? "translated" : (info.source || "groq"),
      activeLan: translated ? "translated" : (info.activeLan || "groq-asr"),
      partial: info.partial !== false,
      asrDone: asrProgress.done,
      asrTotal: asrProgress.total
    };
  }
  tickAsrWait();
  if (info.cues?.length && !hadCues) {
    renderState(state);
    return;
  }
  renderAsrJobBar();
  if (info.cues?.length) renderCues();
}

async function attachRunningAsr(next) {
  try {
    const status = await chrome.runtime.sendMessage({
      type: "GET_ASR_JOB",
      tabId: boundTabId || myTabId,
      bvid: next?.bvid || state?.bvid,
      cid: next?.cid || state?.cid
    });
    if (!status?.running) return false;
    generating = true;
    asrJobId = status.jobId || asrJobId;
    applyAsrProgress(status);
    startAsrWatch();
    return true;
  } catch {
    return false;
  }
}

function estimateLabel(duration) {
  const sec = Number(duration) || 0;
  if (!sec) return "";
  const wait = Math.max(18, Math.round(sec * 0.027));
  return `预计 ${wait} 秒 · ${formatTime(sec)} 音频`;
}

function cuesSignature(cues) {
  if (!cues?.length) return "";
  const head = cues[0];
  const tail = cues[cues.length - 1];
  return `${cues.length}:${head.from}:${tail.to}:${head.content}:${tail.content}`;
}

function cueRowAt(index) {
  return cueRowEls[index] || null;
}

function cueTargetTop(index) {
  const row = cueRowAt(index);
  if (!row) return ui.cueList.scrollTop;
  const center = row.offsetTop + row.offsetHeight / 2;
  const max = Math.max(0, ui.cueList.scrollHeight - ui.cueList.clientHeight);
  return Math.min(max, Math.max(0, center - ui.cueList.clientHeight * 0.4));
}

function cueIndexFromOffset(y) {
  const n = cueRowEls.length;
  if (!n) return -1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const row = cueRowEls[mid];
    if (row.offsetTop + row.offsetHeight <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function paintVisibleCues() {
  const start = range.start;
  const end = range.end >= 0 ? range.end : start;
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  const ready = start >= 0;
  for (let index = 0; index < cueRowEls.length; index += 1) {
    const row = cueRowEls[index];
    row.classList.toggle("active", index === lastActiveIndex);
    row.classList.toggle("picked", ready && index >= from && index <= to);
  }
}

function buildCueRows(cues) {
  const frag = document.createDocumentFragment();
  cueRowEls = new Array(cues.length);
  for (let i = 0; i < cues.length; i += 1) {
    const row = document.createElement("div");
    row.className = "cue";
    row.dataset.index = String(i);
    const time = document.createElement("time");
    time.textContent = formatTime(cues[i].from);
    const text = document.createElement("div");
    text.textContent = cues[i].content;
    row.append(time, text);
    cueRowEls[i] = row;
    frag.append(row);
  }
  ui.cueList.replaceChildren(frag);
}

function renderCues() {
  const cues = state?.cues || [];
  const sig = cuesSignature(cues);
  const changed = sig !== lastCuesSig;
  if (changed) {
    lastCuesSig = sig;
    lastActiveIndex = -1;
    buildCueRows(cues);
  }
  if (!cues.length) return;
  highlight(state.currentTime || 0, { forceScroll: changed });
  paintSelection();
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function stepCueScroll(now) {
  cueScrollRaf = 0;
  const anim = cueScrollAnim;
  if (!anim || selecting || selectHeld) return;
  const t = Math.min(1, (now - anim.start) / anim.dur);
  ui.cueList.scrollTop = anim.from + (anim.to - anim.from) * easeInOutCubic(t);
  if (t >= 1) {
    cueScrollAnim = null;
    return;
  }
  cueScrollRaf = requestAnimationFrame(stepCueScroll);
}

// 按行滚动：只有高亮句切换时才平滑滑动一次，滑到位就停（歌词/字幕通用做法）
function scrollActiveCueIntoView(index, { immediate = false } = {}) {
  if (selecting || selectHeld || hasSummary) return;
  if (index < 0 || index >= (state?.cues?.length || 0)) return;
  const target = cueTargetTop(index);

  if (immediate) {
    cueScrollAnim = null;
    if (cueScrollRaf) cancelAnimationFrame(cueScrollRaf);
    cueScrollRaf = 0;
    ui.cueList.scrollTop = target;
    return;
  }

  if (Date.now() - userCueScrollAt < 2500) return;
  if (Math.abs(target - ui.cueList.scrollTop) < 2) return;

  const distance = Math.abs(target - ui.cueList.scrollTop);
  cueScrollAnim = {
    from: ui.cueList.scrollTop,
    to: target,
    start: performance.now(),
    dur: Math.min(620, Math.max(260, distance * 1.4))
  };
  if (!cueScrollRaf) cueScrollRaf = requestAnimationFrame(stepCueScroll);
}

function highlight(currentTime, { forceScroll = false } = {}) {
  renderOutlineActive(currentTime, { forceScroll });
  const cues = state?.cues || [];
  if (!cues.length || ui.cueWrap?.classList.contains("hidden")) return;
  let index = cues.findIndex((cue) => currentTime >= cue.from && currentTime < cue.to);
  if (index < 0) index = cues.findLastIndex((cue) => currentTime >= cue.from);
  if (index < 0) return;

  const changed = index !== lastActiveIndex;
  if (changed) lastActiveIndex = index;
  if (changed) paintVisibleCues();
  if (changed || forceScroll) scrollActiveCueIntoView(index, { immediate: forceScroll });
}

function syncSelectChrome(onCaptions = view === "captions") {
  const selectOpen = onCaptions && !hasSummary && (range.start >= 0 || selecting);
  show(ui.selectBar, selectOpen);
  show(ui.actionBar, onCaptions && !hasSummary && !selectOpen);
}

function paintSelection() {
  paintVisibleCues();
  const start = range.start;
  const ready = start >= 0;

  ui.cueList.classList.toggle("selecting", selectHeld || selecting);

  if (!ready && !selecting) {
    syncSelectChrome();
    ui.btnSelect.textContent = "划选";
    ui.btnSelect.classList.remove("active");
    return;
  }

  if (view !== "captions") {
    syncSelectChrome(false);
    return;
  }

  syncSelectChrome(true);
  ui.btnSelect.textContent = selecting && range.end < 0 && start >= 0 ? "滑到终点…" : "划选";
  ui.btnSelect.classList.toggle("active", selecting);

  if (start < 0) {
    ui.selectInfo.textContent = selectHeld
      ? `鼠标放在起点，按住 ${keyLabel(selKey)} 再滑动`
      : "点第一行作为起点";
  } else if (range.end < 0) {
    ui.selectInfo.textContent = `起点 ${formatTime(state.cues[start].from)} · 滑到终点`;
  } else {
    const a = Math.min(start, range.end);
    const b = Math.max(start, range.end);
    ui.selectInfo.textContent = `已选 ${b - a + 1} 句 · ${formatTime(state.cues[a].from)}–${formatTime(state.cues[b].from)}`;
  }
}

function pausePlayback() {
  sendToTab({ type: "PAUSE" }).catch(() => {});
}

function notifyPageSelKey(held) {
  if (window.parent === window) return;
  try {
    window.parent.postMessage({ type: "BC_SEL_KEY", held: Boolean(held) }, "*");
  } catch {
    // ignore
  }
}

function selectModeOn(event) {
  return selecting || selectHeld || selKeyDownNow(event);
}

function pointerSelKeyState(event) {
  const key = String(selKey || "Shift").toLowerCase();
  if (key === "shift") return Boolean(event.shiftKey);
  if (key === "control" || key === "ctrl") return Boolean(event.ctrlKey);
  if (key === "alt" || key === "option") return Boolean(event.altKey);
  if (key === "meta" || key === "command") return Boolean(event.metaKey);
  return null;
}

function selKeyDownNow(event) {
  const fromPointer = pointerSelKeyState(event);
  if (inFloatEmbed()) {
    if (fromPointer === false) return false;
    return selKeyHeldFromPage === true;
  }
  if (selKeyHeldFromPage === true) return true;
  if (selKeyHeldFromPage === false) return false;
  return fromPointer === true;
}

function selKeyReleasedNow(event) {
  const fromPointer = pointerSelKeyState(event);
  if (inFloatEmbed()) {
    if (fromPointer === false) return true;
    return selKeyHeldFromPage === false;
  }
  if (selKeyHeldFromPage === false) return true;
  if (selKeyHeldFromPage === true) return false;
  return fromPointer === false;
}

function cueIndexFromPoint(clientX, clientY) {
  const stack = document.elementsFromPoint(clientX, clientY);
  const row = stack.find((el) => el.classList?.contains("cue") || el.closest?.(".cue"));
  const cue = row?.classList?.contains("cue") ? row : row?.closest?.(".cue");
  if (cue && ui.cueList.contains(cue)) {
    const index = Number(cue.dataset.index);
    if (Number.isFinite(index)) return index;
  }
  const box = ui.cueList.getBoundingClientRect();
  if (clientX < box.left || clientX > box.right || clientY < box.top || clientY > box.bottom) {
    if (!selectHeld && !dragSelect) return -1;
  }
  const y = ui.cueList.scrollTop + (clientY - box.top);
  return cueIndexFromOffset(y);
}

function trailPoint(x, y) {
  const box = ui.selectTrail?.getBoundingClientRect();
  if (!box) return { x: 0, y: 0 };
  return { x: x - box.left, y: y - box.top };
}

function trailPointFromEvent(event) {
  return trailPoint(event.clientX, event.clientY);
}

function prepareTrailCanvas() {
  const canvas = ui.selectTrail;
  if (!canvas) return null;
  const box = canvas.getBoundingClientRect();
  const width = Math.max(1, box.width);
  const height = Math.max(1, box.height);
  const dpr = window.devicePixelRatio || 1;
  const nextW = Math.max(1, Math.round(width * dpr));
  const nextH = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== nextW || canvas.height !== nextH) {
    canvas.width = nextW;
    canvas.height = nextH;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

function drawTrail() {
  show(ui.selectTrail, true);
  const ready = prepareTrailCanvas();
  if (!ready) return;
  const { ctx, width, height } = ready;
  ctx.clearRect(0, 0, width, height);
  if (trailPoints.length < 2) {
    if (trailPoints[0]) {
      ctx.fillStyle = "rgba(255,255,255,.9)";
      ctx.beginPath();
      ctx.arc(trailPoints[0].x, trailPoints[0].y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let i = 1; i < trailPoints.length; i += 1) {
    const t = i / (trailPoints.length - 1);
    ctx.strokeStyle = `rgba(77, 142, 240, ${0.18 + t * 0.72})`;
    ctx.lineWidth = 2 + t * 3.2;
    ctx.beginPath();
    ctx.moveTo(trailPoints[i - 1].x, trailPoints[i - 1].y);
    ctx.lineTo(trailPoints[i].x, trailPoints[i].y);
    ctx.stroke();
  }
  const last = trailPoints[trailPoints.length - 1];
  ctx.fillStyle = "rgba(255,255,255,.92)";
  ctx.beginPath();
  ctx.arc(last.x, last.y, 3.5, 0, Math.PI * 2);
  ctx.fill();
}

function clearTrail() {
  trailPoints = [];
  const ready = prepareTrailCanvas();
  if (ready) ready.ctx.clearRect(0, 0, ready.width, ready.height);
  show(ui.selectTrail, false);
}

function autoScrollCues(clientY) {
  const box = ui.cueList.getBoundingClientRect();
  const edge = 36;
  if (clientY < box.top + edge) {
    ui.cueList.scrollTop -= 18;
  } else if (clientY > box.bottom - edge) {
    ui.cueList.scrollTop += 18;
  }
}

function rememberPointer(event) {
  lastPointer = { x: event.clientX, y: event.clientY };
}

function extendHoverSelect(event) {
  if (!selectHeld) return;
  rememberPointer(event);
  const point = trailPointFromEvent(event);
  const last = trailPoints[trailPoints.length - 1];
  if (!last || Math.hypot(point.x - last.x, point.y - last.y) >= 1.5) {
    trailPoints.push(point);
    if (trailPoints.length > 90) trailPoints.shift();
    drawTrail();
  }
  autoScrollCues(event.clientY);
  const index = cueIndexFromPoint(event.clientX, event.clientY);
  if (index < 0) return;
  if (range.start < 0) {
    if (hoverSelectFrom) {
      const dist = Math.hypot(event.clientX - hoverSelectFrom.x, event.clientY - hoverSelectFrom.y);
      if (dist < 8) return;
    }
    hoverSelectFrom = null;
    range = { start: index, end: index };
    anchor = index;
    pausePlayback();
    paintSelection();
    return;
  }
  if (index !== range.end) {
    range.end = index;
    paintSelection();
  }
}

function beginHoverSelect() {
  hasSummary = false;
  show(ui.summaryBox, false);
  trailPoints = [];
  hoverSelectFrom = { x: lastPointer.x, y: lastPointer.y };
  range = { start: -1, end: -1 };
  anchor = -1;
  paintSelection();
}

function onCuePointerDown(event, index) {
  if (selectHeld) {
    event.preventDefault();
    return;
  }
  if (event.button !== 0 || !selecting) return;
  event.preventDefault();
  pausePlayback();
  hasSummary = false;
  show(ui.summaryBox, false);
  dragSelect = { start: index, pointerId: event.pointerId, moved: false };
  range = { start: index, end: index };
  anchor = index;
  trailPoints = [trailPointFromEvent(event)];
  drawTrail();
  paintSelection();
  ui.cueList.setPointerCapture?.(event.pointerId);
}

function onCuePointerMove(event) {
  rememberPointer(event);
  if (selKeyDownNow(event) && !selectHeld) {
    selectHeld = true;
    beginHoverSelect();
  } else if (selKeyReleasedNow(event) && selectHeld) {
    finishHeldSelect();
    return;
  }
  if (selectHeld) {
    extendHoverSelect(event);
    return;
  }
  if (!dragSelect) return;
  const point = trailPointFromEvent(event);
  const last = trailPoints[trailPoints.length - 1];
  if (!last || Math.hypot(point.x - last.x, point.y - last.y) >= 1.5) {
    trailPoints.push(point);
    if (trailPoints.length > 90) trailPoints.shift();
    drawTrail();
  }
  autoScrollCues(event.clientY);
  const index = cueIndexFromPoint(event.clientX, event.clientY);
  if (index < 0) return;
  if (index !== range.end) {
    dragSelect.moved = true;
    range.end = index;
    paintSelection();
  }
}

function onCuePointerUp(event) {
  if (!dragSelect) return;
  const index = cueIndexFromPoint(event.clientX, event.clientY);
  if (index >= 0) range.end = index;
  if (range.end < 0) range.end = range.start;
  selecting = false;
  dragSelect = null;
  paintSelection();
  window.setTimeout(clearTrail, 280);
}

function onCueClick(index, cue, event) {
  if (selectModeOn(event) || Date.now() < ignoreCueClickUntil) {
    event.preventDefault();
    return;
  }

  range = { start: -1, end: -1 };
  anchor = -1;
  hasSummary = false;
  show(ui.summaryBox, false);
  paintSelection();
  sendToTab({ type: "SEEK", time: cue.from }).catch(() => {});
}

function renderOutlineActive(currentTime, { forceScroll = false, smooth = false } = {}) {
  if (!outline?.length || ui.outlineList.classList.contains("hidden") || outlineLoading) return;
  const t = Number(currentTime) || 0;
  let idx = outline.findIndex((ch) => t >= ch.start && t < ch.end);
  if (idx < 0) idx = outline.findLastIndex((ch) => t >= ch.start);
  if (idx < 0) return;
  if (idx === lastOutlineIndex && !forceScroll) return;
  lastOutlineIndex = idx;

  const rows = ui.outlineList.querySelectorAll(".chapter");
  rows.forEach((row, i) => row.classList.toggle("active", i === idx));
  const active = rows[idx];
  if (!active) return;
  const top = active.offsetTop - ui.outlineList.clientHeight / 2 + active.offsetHeight / 2;
  ui.outlineList.scrollTo({
    top: Math.max(0, top),
    behavior: smooth || forceScroll ? "smooth" : "auto"
  });
}

function renderOutline() {
  if (!outline?.length) {
    ui.outlineList.innerHTML = "";
    return;
  }
  const t = Number(state?.currentTime) || 0;
  while (ui.outlineList.children.length > outline.length) {
    ui.outlineList.lastElementChild.remove();
  }
  outline.forEach((ch, i) => {
    const streaming = outlineLoading && i === outline.length - 1;
    const active = !outlineLoading && t >= ch.start && t < ch.end;
    let row = ui.outlineList.children[i];
    if (!row) {
      row = document.createElement("div");
      row.innerHTML = `
        <div class="chapter-time">
          <span class="chapter-start"></span>
          <div class="chapter-line"></div>
          <span class="chapter-end"></span>
        </div>
        <div class="chapter-body">
          <span class="chapter-title"></span>
          <span class="chapter-synopsis"></span>
        </div>`;
      ui.outlineList.appendChild(row);
    }
    row.dataset.start = String(ch.start);
    row.dataset.end = String(ch.end);
    const startEl = row.querySelector(".chapter-start");
    const endEl = row.querySelector(".chapter-end");
    if (startEl && startEl.textContent !== formatTime(ch.start)) startEl.textContent = formatTime(ch.start);
    if (endEl && endEl.textContent !== formatTime(ch.end)) endEl.textContent = formatTime(ch.end);
    const titleEl = row.querySelector(".chapter-title");
    const synEl = row.querySelector(".chapter-synopsis");
    if (titleEl && titleEl.textContent !== ch.title) titleEl.textContent = ch.title;
    if (synEl && synEl.textContent !== ch.synopsis) synEl.textContent = ch.synopsis;
    const nextClass = `chapter${active ? " active" : ""}${streaming ? " streaming" : ""}`;
    if (row.className !== nextClass) row.className = nextClass;
  });
}

function outlineText() {
  return (outline || []).map((ch) => (
    `${formatTime(ch.start)}–${formatTime(ch.end)} ${ch.title}\n${ch.synopsis}`
  )).join("\n\n");
}

function outlineMarkdown() {
  const title = state?.title || "大纲";
  const body = (outline || []).map((ch) => (
    `## ${formatTime(ch.start)}–${formatTime(ch.end)} ${ch.title}\n\n${ch.synopsis}`
  )).join("\n\n");
  return `# ${title}\n\n${body}\n`;
}

async function loadOutlineCache(next) {
  const key = outlineKey(next);
  if (!key) {
    outline = null;
    return;
  }
  const data = await chrome.storage.local.get({ [key]: null });
  outline = Array.isArray(data[key]) ? data[key] : null;
}

function normalizeChapter(item) {
  return {
    start: Number(item.start) || 0,
    end: Number(item.end) || 0,
    title: String(item.title || "").trim() || "未命名章节",
    synopsis: String(item.synopsis || item.summary || "").trim()
  };
}

function parseOutlineJson(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonText = fenced ? fenced[1] : raw;
  const start = jsonText.indexOf("[");
  const end = jsonText.lastIndexOf("]");
  if (start < 0 || end < 0) throw new Error("大纲格式无法解析");
  const list = JSON.parse(jsonText.slice(start, end + 1));
  if (!Array.isArray(list) || !list.length) throw new Error("大纲为空");
  return list.map(normalizeChapter);
}

function takeJsonString(src, key) {
  const hit = String(src).match(new RegExp(`"${key}"\\s*:\\s*"`));
  if (!hit) return "";
  let i = hit.index + hit[0].length;
  let out = "";
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\" && i + 1 < src.length) {
      const next = src[i + 1];
      out += next === "n" ? "\n" : next === "t" ? " " : next;
      i += 2;
      continue;
    }
    if (ch === "\"") break;
    out += ch;
    i += 1;
  }
  return out;
}

function takeJsonNumber(src, key) {
  const hit = String(src).match(new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
  return hit ? Number(hit[1]) : 0;
}

function parseStreamingChapters(text) {
  const raw = String(text || "");
  const from = raw.indexOf("[");
  const body = from >= 0 ? raw.slice(from + 1) : raw;
  const out = [];
  const re = /\{[^{}]*\}/g;
  let lastEnd = 0;
  let match;
  while ((match = re.exec(body))) {
    try {
      const obj = JSON.parse(match[0]);
      if (obj && (obj.title || obj.synopsis || obj.summary)) {
        out.push(normalizeChapter(obj));
      }
      lastEnd = match.index + match[0].length;
    } catch {
      // 半截对象交给后面的尾部解析
    }
  }
  const tail = body.slice(lastEnd);
  const open = tail.lastIndexOf("{");
  if (open < 0) return out;
  const frag = tail.slice(open);
  const title = takeJsonString(frag, "title");
  const synopsis = takeJsonString(frag, "synopsis") || takeJsonString(frag, "summary");
  if (!title && !synopsis) return out;
  out.push({
    start: takeJsonNumber(frag, "start"),
    end: takeJsonNumber(frag, "end"),
    title: title || "…",
    synopsis
  });
  return out;
}

async function generateOutline() {
  if (!state?.cues?.length || outlineLoading) return;
  outlineLoading = true;
  outline = null;
  lastOutlineIndex = -1;
  view = "outline";
  renderState(state);
  showOutlineThinking(true);
  const startedOutlineKey = outlineKey(state);
  try {
    const lines = state.cues.map((cue) => `[${formatTime(cue.from)}] ${cue.content}`).join("\n");
    let lastPreview = "";
    const result = await runModel(`请根据下面带时间戳的视频字幕，生成 3-8 个章节大纲。只输出 JSON 数组。每个对象字段顺序必须是 title、synopsis、start、end。title 是短标题，synopsis 是一两句摘要，start/end 是秒（数字）。不要输出其他文字。\n\n${lines}`, {
      onDelta(full) {
        const partial = parseStreamingChapters(full);
        const preview = JSON.stringify(partial);
        if (!partial.length || preview === lastPreview) return;
        lastPreview = preview;
        outline = partial;
        if (view !== "outline") return;
        show(ui.outlineEmpty, false);
        show(ui.outlineHead, true);
        if (ui.outlineHead) ui.outlineHead.classList.add("has-rows");
        show(ui.outlineList, true);
        if (!outlineRaf) {
          outlineRaf = requestAnimationFrame(() => {
            outlineRaf = 0;
            if (view === "outline") renderOutline();
          });
        }
      }
    });
    outline = parseOutlineJson(result);
    const key = startedOutlineKey;
    if (key) await chrome.storage.local.set({ [key]: outline });
    flash("大纲已生成");
  } catch (error) {
    outline = null;
    flash(error.message || "生成大纲失败");
  } finally {
    outlineLoading = false;
    showOutlineThinking(false);
    renderState(state);
  }
}

function renderState(next) {
  resetTranslationsFor(next);
  if (next?.cues?.length && translatedCueText.size) {
    next = {
      ...next,
      cues: applyRememberedTranslations(next.cues),
      source: "translated",
      activeLan: "translated"
    };
  }
  state = next;
  renderLogin(next?.login || lastLogin);
  renderHeaderTitle(next);

  const noScript = Boolean(
    next?.page === "no-script" || next?.error?.includes("Could not establish connection")
  );
  const isOther = !next || next.page === "other";

  if (isOther && !noScript) {
    show(ui.noVideoView, true);
    show(ui.videoView, false);
    show(ui.speedSelect, false);
    if (ui.noVideoTitle) ui.noVideoTitle.textContent = "当前标签页不是视频页";
    renderLastVideoHint();
    return;
  }

  show(ui.noVideoView, false);
  show(ui.videoView, true);
  persistLastVideo(next);

  const renderKey = `${next?.bvid || ""}:${next?.cid || ""}:${next?.aid || ""}`;
  if (renderKey && renderKey !== lastRenderKey) {
    hasSummary = false;
    ui.summaryText.textContent = "";
    lastRenderKey = renderKey;
    loadOutlineCache(next).then(() => {
      if (outline && outlineKey(state) === outlineKey(next)) renderState(state);
    });
  }

  const loggedIn = Boolean(lastLogin?.isLogin);
  const hasCues = Boolean(next?.cues?.length);
  const combinedError = `${genError || ""} ${next?.error || ""} ${lastLogin?.error || ""}`;
  const netLogin = /无法确认登录|请求失败|Failed to fetch|NetworkError|网络/i.test(combinedError);
  const loginError = noScript ? false : Boolean(genError && /登录/.test(genError) && !loggedIn && !netLogin);
  const showLoginEmpty = !generating && !hasCues && !loggedIn && !netLogin && (loginError || (Boolean(next?.error) && /登录/.test(next.error || "") && !/无法确认登录/.test(next.error || "")));
  const showNetLogin = !generating && !hasCues && !noScript && netLogin;
  const showGenError = !generating && Boolean(genError) && !hasCues && !showLoginEmpty && !showNetLogin;
  const showFullGen = generating && !hasCues && !showLoginEmpty && !showNetLogin && !noScript;
  const isEmpty = !generating && !showLoginEmpty && !showNetLogin && !showGenError && !noScript && !hasCues;
  const hasList = !showFullGen && !showLoginEmpty && !showNetLogin && !showGenError && !noScript && hasCues;
  const onCaptions = hasList && view === "captions";
  const onOutline = hasList && view === "outline";

  show(ui.speedSelect, true);
  show(ui.controlRow, hasList && (next.tracks?.length || 0) > 1);
  show(ui.viewTabs, hasList);

  ui.viewTabs.querySelectorAll("button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });

  if (next.tracks?.length && hasList) {
    ui.trackSelect.classList.remove("hidden");
    ui.trackSelect.replaceChildren();
    for (const item of next.tracks) {
      const option = document.createElement("option");
      option.value = item.lan;
      option.selected = item.lan === next.activeLan;
      option.textContent = item.lanDoc;
      ui.trackSelect.appendChild(option);
    }
  } else {
    ui.trackSelect.classList.add("hidden");
  }

  renderSpeed(next.rate || 1);

  show(ui.emptyView, isEmpty);
  if (isEmpty) {
    show(ui.emptyKeyHint, !hasSttKey);
    ui.emptyEstimate.textContent = estimateLabel(next.duration);
  }

  show(ui.generatingView, showFullGen);
  showGenerateThinking(showFullGen);
  renderAsrJobBar();

  errorMode = "";
  if (noScript) {
    errorMode = "refresh";
    show(ui.errorView, true);
    ui.errorTitle.textContent = "请刷新这个 B 站标签页";
    ui.errorPrimary.textContent = "刷新";
    show(ui.emptyView, false);
  } else if (showNetLogin) {
    errorMode = "retryState";
    show(ui.errorView, true);
    ui.errorTitle.textContent = "无法确认登录状态，请检查网络后重试";
    ui.errorPrimary.textContent = "重试";
  } else if (showLoginEmpty) {
    errorMode = "login";
    show(ui.errorView, true);
    ui.errorTitle.textContent = "未登录 B 站";
    ui.errorPrimary.textContent = "去登录";
  } else if (showGenError) {
    errorMode = "retry";
    show(ui.errorView, true);
    ui.errorTitle.textContent = genError;
    ui.errorPrimary.textContent = "重试";
  } else {
    show(ui.errorView, false);
  }

  const outlineRows = Boolean(outline?.length);
  show(ui.outlineHead, onOutline && outlineLoading);
  if (ui.outlineHead) ui.outlineHead.classList.toggle("has-rows", outlineRows);

  const outlineEmptyShown = onOutline && !outlineLoading && !outlineRows;
  show(ui.outlineEmpty, outlineEmptyShown);
  if (outlineEmptyShown) {
    ui.outlineEmptyLabel.textContent = "还没有生成大纲";
    show($("btnGenOutline"), true);
    show(ui.outlineEmptyIcon, true);
  }

  show(ui.outlineList, onOutline && outlineRows);
  if (onOutline && outlineRows) {
    renderOutline();
    lastOutlineIndex = -1;
    renderOutlineActive(next.currentTime || 0, { forceScroll: true });
  }

  show(ui.cueWrap || ui.cueList, onCaptions);
  show(ui.summaryBox, onCaptions && hasSummary);
  syncSelectChrome(onCaptions);
  show(ui.outlineBar, onOutline && outlineRows && !outlineLoading);

  if (onCaptions) {
    const generated = next.source === "groq" || next.activeLan === "groq-asr";
    show(ui.btnGenerate, !next.partial);
    ui.btnGenerate.textContent = generating ? "转写中" : generated ? "重新生成" : "生成字幕";
    ui.btnGenerate.disabled = generating;
    if (typeof next.overlayOn === "boolean") overlayOn = next.overlayOn;
    renderOverlayBtn();
    renderCues();
  } else if (!onCaptions) {
    ui.cueList.classList.remove("selecting");
  }
}

async function refreshLoginOnly() {
  try {
    renderLogin(await chrome.runtime.sendMessage({ type: "GET_LOGIN" }));
  } catch {
    renderLogin(null);
  }
}

async function refresh(force = false) {
  if ((outlineLoading || generating) && !force) return;
  genError = "";
  try {
    const tab = await getActiveTab();
    if (tab?.id && !inFloatEmbed()) boundTabId = tab.id;
    if (!tab?.url?.includes("bilibili.com")) {
      renderState({ page: "other" });
      await refreshLoginOnly();
      return;
    }
    const next = await sendToTab({ type: force ? "REFRESH" : "GET_STATE" }, tab.id);
    renderState(next);
    if (await attachRunningAsr(next)) renderState(state || next);
    if (!next?.login) await refreshLoginOnly();
  } catch (error) {
    renderState({ page: "no-script", error: error.message });
    await refreshLoginOnly();
  }
}

function extractBvidFromUrl(url = "") {
  const fromPath = url.match(/\/video\/(BV[\w]+)/i)?.[1];
  if (fromPath) return fromPath;
  try {
    return new URL(url).searchParams.get("bvid") || "";
  } catch {
    return "";
  }
}

function extractEpIdFromUrl(url = "") {
  return url.match(/\/bangumi\/play\/ep(\d+)/)?.[1] || "";
}

function extractSeasonIdFromUrl(url = "") {
  return url.match(/\/bangumi\/play\/ss(\d+)/)?.[1] || "";
}

async function generateSubtitles() {
  if (generating) return;

  const { groqApiKey, sttProvider } = await chrome.storage.sync.get({
    groqApiKey: "",
    sttProvider: "Groq"
  });
  if (sttProvider && sttProvider !== "Groq") {
    flash("当前仅接通了 Groq 转写");
    openSettings();
    return;
  }
  if (!groqApiKey) {
    flash("请先填写 Groq API Key");
    openSettings();
    return;
  }

  const token = ++generateToken;
  const jobId = `${Date.now()}-${token}`;
  asrJobId = jobId;
  generating = true;
  genError = "";
  asrStopReason = "";
  if (state?.cues?.length) {
    asrProgress = {
      done: Number(state.asrDone) || 0,
      total: Number(state.asrTotal) || 0,
      waitUntil: 0,
      message: "准备继续转写…",
      stage: "start"
    };
  }
  renderGenProgress("start", "准备生成字幕…", 4);
  renderState(state || { page: "video" });

  let backgroundStarted = false;
  try {
    const tab = await getActiveTab();
    const frozenTabId = tab?.id || boundTabId || myTabId;
    let meta = {
      aid: Number(state?.aid) || 0,
      cid: Number(state?.cid) || 0,
      bvid: state?.bvid || extractBvidFromUrl(tab?.url || ""),
      p: 1,
      epId: extractEpIdFromUrl(tab?.url || ""),
      seasonId: extractSeasonIdFromUrl(tab?.url || ""),
      title: state?.title || ""
    };

    try {
      const snap = await sendToTab({ type: "GET_META" }, frozenTabId);
      if (snap) {
        meta = {
          aid: Number(snap.aid) || meta.aid,
          cid: Number(snap.cid) || meta.cid,
          bvid: snap.bvid || meta.bvid || extractBvidFromUrl(snap.href || ""),
          p: Number(snap.p || snap.page?.p) || meta.p,
          epId: snap.epId || snap.page?.epId || meta.epId,
          seasonId: snap.seasonId || snap.page?.seasonId || "",
          title: snap.title || meta.title
        };
      }
    } catch {
      // background 再补
    }

    if (!meta.bvid && !meta.epId && !meta.seasonId && (!meta.aid || !meta.cid)) {
      throw new Error("请先打开 B 站视频播放页，再点生成");
    }
    if (!meta.cid && !meta.epId && !meta.seasonId) {
      throw new Error("无法确认当前分 P，请刷新后再生成");
    }
    if (token !== generateToken) return;

    const data = await chrome.runtime.sendMessage({
      type: "GENERATE_ASR",
      jobId,
      tabId: frozenTabId,
      aid: meta.aid,
      cid: meta.cid,
      bvid: meta.bvid,
      p: meta.p,
      epId: meta.epId,
      seasonId: meta.seasonId,
      title: meta.title,
      force: Boolean(state?.source === "groq" && !state?.partial && state?.cues?.length)
    });
    if (token !== generateToken) return;
    if (data?.error) throw new Error(data.error);
    if (data?.started) {
      backgroundStarted = true;
      asrJobId = data.jobId || asrJobId;
      startAsrWatch();
      return;
    }

    const merged = {
      ...(state || {}),
      page: "video",
      aid: data.aid || meta.aid,
      cid: data.cid || meta.cid,
      bvid: data.bvid || meta.bvid,
      title: data.title || meta.title || state?.title || "",
      part: data.part || state?.part || "",
      cues: data.cues || [],
      activeLan: data.activeLan || "groq-asr",
      source: data.source || "groq",
      error: "",
      canGenerate: true,
      partial: false
    };

    try {
      await sendToTab({
        type: "APPLY_ASR_CUES",
        cues: data.cues,
        activeLan: data.activeLan,
        source: data.source,
        partial: false,
        aid: merged.aid,
        cid: merged.cid,
        bvid: merged.bvid,
        title: merged.title
      }, frozenTabId);
    } catch {
      // 贴到生成时的那个标签；侧栏可能已经切走
    }
    generating = false;
    if (boundTabId && frozenTabId && Number(boundTabId) !== Number(frozenTabId)) {
      await refresh(true);
    } else {
      try {
        const next = await sendToTab({ type: "GET_STATE" }, frozenTabId);
        renderState(next?.page ? { ...merged, ...next } : merged);
      } catch {
        renderState(merged);
      }
    }
    flash(`已生成 ${data.cues?.length || 0} 条字幕`);
  } catch (error) {
    if (token !== generateToken) return;
    generating = false;
    if (state?.cues?.length) {
      state = { ...state, partial: true };
      flash(error.message || "转写中断，已保存进度，可继续生成");
      renderState(state);
    } else {
      genError = error.message || String(error);
      renderState(state || { page: "video" });
    }
  } finally {
    if (token === generateToken && !backgroundStarted) {
      generating = false;
      asrJobId = "";
      asrProgress = null;
      clearInterval(asrWaitTimer);
      stopAsrWatch();
    }
  }
}

function cancelGenerate() {
  const jobId = asrJobId;
  generateToken += 1;
  generating = false;
  genError = "";
  asrStopReason = "";
  asrProgress = null;
  clearInterval(asrWaitTimer);
  stopAsrWatch();
  if (jobId) {
    chrome.runtime.sendMessage({
      type: "CANCEL_ASR",
      jobId,
      bvid: state?.bvid,
      cid: state?.cid,
      tabId: boundTabId || myTabId
    }).catch(() => {});
  }
  asrJobId = "";
  flash("已取消，已完成的段落会留着");
  refresh(true).catch(() => renderState(state || { page: "video" }));
}

async function copyText(text) {
  const tryLegacy = () => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  };

  if (tryLegacy()) return;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  throw new Error("复制失败");
}

function markCopied(btn, ok = true) {
  if (!btn) return;
  btn.textContent = ok ? "已复制" : "复制失败";
  btn.classList.toggle("copied", ok);
  clearTimeout(btn._copiedTimer);
  btn._copiedTimer = setTimeout(() => {
    btn.textContent = "复制";
    btn.classList.remove("copied");
  }, 1400);
}

function defaultChatModel(base, apiModel) {
  if (apiModel) return apiModel;
  if (String(base).includes("siliconflow")) return "Qwen/Qwen2.5-7B-Instruct";
  return "gpt-4o-mini";
}

async function ensureApiOrigin(url) {
  try {
    await chrome.permissions.request({ origins: [`${new URL(url).origin}/*`] });
  } catch {
    // 已授权或用户拒绝时继续，后面的 fetch 会给出明确错误
  }
}

function chatErrorMessage(json, status) {
  return json?.error?.message || json?.message || `接口错误 ${status}`;
}

async function readChatStream(res, onDelta) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let json = null;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      const piece = json?.choices?.[0]?.delta?.content
        || json?.choices?.[0]?.message?.content
        || "";
      if (piece) {
        full += piece;
        onDelta(full);
      }
    }
  }
  if (!full && buffer.trim()) {
    try {
      const json = JSON.parse(buffer);
      full = json?.choices?.[0]?.message?.content?.trim() || "";
      if (full) onDelta(full);
    } catch {
      // 不是完整 JSON，忽略
    }
  }
  return full;
}

async function openaiPrompt(prompt, { onDelta } = {}) {
  const { apiBase, apiKey, apiModel } = await chrome.storage.sync.get({
    apiBase: "",
    apiKey: "",
    apiModel: ""
  });
  if (!apiKey) return null;
  const base = (apiBase || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = defaultChatModel(base, apiModel);
  await ensureApiOrigin(base);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        stream: Boolean(onDelta),
        messages: [
          { role: "system", content: "你是简洁的中文助手。只输出结果，不要客套。" },
          { role: "user", content: prompt }
        ]
      })
    });
    if (!res.ok) {
      let json = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      throw new Error(chatErrorMessage(json, res.status));
    }

    summaryModel = model;
    if (onDelta && res.body) {
      const text = await readChatStream(res, onDelta);
      return text.trim();
    }
    const json = await res.json();
    summaryModel = apiModel || json.model || model;
    return json.choices?.[0]?.message?.content?.trim() || "";
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("请求超时，请稍后重试");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function runModel(prompt, options) {
  const remote = await openaiPrompt(prompt, options);
  if (remote) return remote;
  throw new Error("请先在设置里配置总结服务和 API Key");
}

async function summarizeSelection() {
  const cues = selectedCues();
  if (!cues.length) {
    ui.selectInfo.textContent = "先划选一段字幕";
    return;
  }
  const from = Math.min(range.start, range.end);
  const to = Math.max(range.start, range.end);
  const prompt = buildSummaryPrompt(from, to);
  const span = `${formatTime(state.cues[from].from)}–${formatTime(state.cues[to].from)}`;
  hasSummary = true;
  cueScrollAnim = null;
  if (cueScrollRaf) cancelAnimationFrame(cueScrollRaf);
  cueScrollRaf = 0;
  show(ui.summaryBox, true);
  syncSelectChrome(true);
  ui.summaryTitle.textContent = "选区总结";
  ui.summaryMeta.textContent = span;
  setSummaryBody("");
  ui.summaryText.classList.remove("streaming");
  try {
    showSummaryThinking(true);
    let started = false;
    const result = await runModel(prompt, {
      onDelta(full) {
        if (!started) {
          started = true;
          showSummaryThinking(false);
          ui.summaryText.classList.add("streaming");
        }
        setSummaryBody(full);
      }
    });
    ui.summaryText.classList.remove("streaming");
    setSummaryBody(result);
    ui.summaryMeta.textContent = span;
    flash("总结完成");
  } catch (error) {
    showSummaryThinking(false);
    ui.summaryText.classList.remove("streaming");
    ui.summaryText.textContent = error.message || String(error);
  }
}

function toSimplified(text) {
  return window.BiliCaptionZh?.toSimplified?.(text) || String(text || "");
}

function needsTranslation(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  const latin = (raw.match(/[A-Za-z]/g) || []).length;
  const cjk = (raw.match(/[\u4e00-\u9fff]/g) || []).length;
  if (latin < 4) return false;
  if (cjk > 0 && latin <= Math.max(cjk * 1.5, 12)) return false;

  const zhPunct = /[、。！？；：…「」『』《》]/.test(raw);
  const englishSentence =
    /\b(the|a|an|is|are|was|were|be|been|to|of|and|or|in|on|for|with|this|that|it|you|we|i|can|will|have|has|do|does|not|but|if|as|at|from|your|our|they|their|what|how|why|when|all|just|about|into|than|then|so|my|me|no|yes|let|get|got|make|use|using)\b/i.test(raw)
    || /[A-Za-z]{3,}(?:\s+[A-Za-z]{2,}){2,}/.test(raw);

  if (zhPunct && !englishSentence) return false;
  if (cjk === 0) return englishSentence;
  return englishSentence && latin > cjk * 1.5;
}

async function translateCues() {
  if (!state?.cues?.length || translating) return;
  setMoreOpen(false);
  resetTranslationsFor(state);

  const next = state.cues.map((cue) => ({
    ...cue,
    content: toSimplified(cue.content)
  }));
  next.forEach((cue, index) => {
    if (cue.content !== state.cues[index]?.content) {
      rememberTranslatedCue(cue, cue.content);
    }
  });
  const targets = next
    .map((cue, index) => ({ index, text: cue.content }))
    .filter((item) => needsTranslation(item.text));

  if (!targets.length) {
    if (translatedCueText.size) {
      state = {
        ...state,
        cues: applyRememberedTranslations(state.cues),
        source: "translated",
        activeLan: "translated"
      };
      renderCues();
      sendToTab({
        type: "SYNC_CUES",
        cues: state.cues,
        source: "translated",
        activeLan: "translated"
      }).catch(() => {});
    }
    flash("已经是中文，不用翻译");
    return;
  }

  const token = ++translateToken;
  translating = true;
  translateProgress = { done: 0, total: targets.length };
  renderAsrJobBar();
  try {
    const size = 24;
    for (let offset = 0; offset < targets.length; offset += size) {
      if (token !== translateToken) return;
      translateProgress = { done: offset, total: targets.length };
      renderAsrJobBar();
      const batch = targets.slice(offset, offset + size);
      const text = batch.map((item, i) => `${i + 1}. ${item.text}`).join("\n");
      const translated = await runModel(`只把下面的英文字幕译成简体中文。保持编号，一行一条，不要解释，不要翻译编号：\n\n${text}`);
      if (token !== translateToken) return;
      const byId = new Map();
      for (const line of translated.split(/\n+/)) {
        const match = line.match(/^(\d+)[\.、\)]\s*(.+)$/);
        if (match) byId.set(Number(match[1]), match[2].trim());
      }
      for (let i = 0; i < batch.length; i += 1) {
        const got = byId.get(i + 1);
        const cue = next[batch[i].index];
        const content = toSimplified(got || batch[i].text);
        cue.content = content;
        if (got) rememberTranslatedCue(cue, content);
      }
      state = {
        ...state,
        cues: applyRememberedTranslations(state?.cues?.length ? state.cues : next),
        source: "translated",
        activeLan: "translated"
      };
      renderCues();
      sendToTab({
        type: "SYNC_CUES",
        cues: state.cues,
        source: "translated",
        activeLan: "translated"
      }).catch(() => {});
      translateProgress = { done: Math.min(targets.length, offset + batch.length), total: targets.length };
      renderAsrJobBar();
    }
    if (token !== translateToken) return;
    flash(`已翻译 ${targets.length} 句英文`);
  } catch (error) {
    if (token !== translateToken) return;
    flash(error.message || "翻译失败");
  } finally {
    if (token === translateToken) {
      translating = false;
      translateProgress = { done: 0, total: 0 };
      renderAsrJobBar();
    }
  }
}

function cancelTranslate() {
  translateToken += 1;
  translating = false;
  translateProgress = { done: 0, total: 0 };
  renderAsrJobBar();
  flash("已取消翻译，已译出的句子会留着");
}

async function setRateFromHotkey(rate) {
  const next = Math.min(10, Math.max(0.1, Math.round((Number(rate) || 1) * 10) / 10));
  renderSpeed(next);
  try {
    const result = await sendToTab({ type: "SET_RATE", rate: next });
    if (result?.rate != null) {
      state = { ...(state || {}), ...result };
      renderSpeed(result.rate);
    }
  } catch (error) {
    flash(error.message || "调速失败，请先点一下视频页");
  }
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = (el.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (el.isContentEditable) return true;
  return Boolean(el.closest?.("[contenteditable='true'], input, textarea, select"));
}

function matchesSelKey(event) {
  const key = event?.key;
  if (!key) return false;
  return key.toLowerCase() === String(selKey || "Shift").toLowerCase();
}

function onSidepanelHotkey(event) {
  if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return;
  if (event.isComposing || event.key === "Process") return;

  if (matchesSelKey(event)) {
    event.preventDefault();
    selKeyHeldFromPage = true;
    notifyPageSelKey(true);
    return;
  }

  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const code = event.code;
  const key = event.key?.toLowerCase();
  if (code === "KeyZ" || key === "z") {
    event.preventDefault();
    setRateFromHotkey(1);
    return;
  }
  if (code === "KeyX" || key === "x") {
    event.preventDefault();
    setRateFromHotkey(currentRate() - 0.1);
    return;
  }
  if (code === "KeyC" || key === "c") {
    event.preventDefault();
    setRateFromHotkey(currentRate() + 0.1);
  }
}

function finishHeldSelect() {
  if (selectHeld) {
    ignoreCueClickUntil = Date.now() + 400;
    if (range.start >= 0 && range.end < 0) range.end = range.start;
  }
  selectHeld = false;
  hoverSelectFrom = null;
  clearTrail();
  paintSelection();
}

function onSelKeyUp(event) {
  if (event.type === "blur") {
    finishHeldSelect();
    return;
  }
  if (!matchesSelKey(event)) return;
  selKeyHeldFromPage = false;
  notifyPageSelKey(false);
  finishHeldSelect();
}

async function reloadBoundTab() {
  try {
    const tab = await getActiveTab();
    const tabId = tab?.id || boundTabId || myTabId;
    if (!tabId) {
      flash("找不到要刷新的标签");
      return;
    }
    if (!inFloatEmbed()) boundTabId = tabId;
    await chrome.tabs.reload(tabId);
    await waitTabComplete(tabId);
    await ensureContentScript(tabId);
    await refresh(true);
  } catch (error) {
    flash(error.message || "刷新失败");
  }
}

function onErrorPrimary() {
  if (errorMode === "login") openBiliLogin();
  else if (errorMode === "retry") generateSubtitles();
  else if (errorMode === "refresh") reloadBoundTab();
  else if (errorMode === "retryState") refresh(true);
  else refresh(true);
}

function fileBase() {
  return `${safeName(state?.bvid || state?.title)}${state?.part ? "-" + safeName(state.part) : ""}`;
}

function renderOverlayBtn() {
  if (!ui.btnOverlay) return;
  ui.btnOverlay.textContent = "显示字幕";
  ui.btnOverlay.classList.toggle("active", overlayOn);
}

async function setOverlayOn(on) {
  overlayOn = on !== false;
  renderOverlayBtn();
  chrome.storage.sync.set({ overlayOn }).catch(() => {});
  sendToTab({ type: "SET_OVERLAY", on: overlayOn }).catch(() => {});
}

async function loadPrefs() {
  const data = await chrome.storage.sync.get({
    groqApiKey: "",
    sttKey: "",
    selKey: "Shift",
    overlayOn: true,
    summaryPad: 10
  });
  hasSttKey = Boolean(data.groqApiKey || data.sttKey);
  selKey = data.selKey || "Shift";
  overlayOn = data.overlayOn !== false;
  summaryPad = Math.min(50, Math.max(0, Math.round(Number(data.summaryPad) || 10)));
  renderOverlayBtn();
}

ui.btnSettings.addEventListener("click", openSettings);
ui.btnFloat?.addEventListener("click", async () => {
  try {
    const tab = await getActiveTab();
    if (tab?.windowId) await chrome.windows.update(tab.windowId, { focused: true });
    if (tab?.id) await chrome.tabs.update(tab.id, { active: true });
  } catch {
    // ignore
  }
  sendToTab({ type: "OPEN_FLOAT" }).catch(() => {});
});
$("openSettingsLink").addEventListener("click", openSettings);
ui.speedBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  const open = ui.speedMenu.classList.contains("hidden");
  setMoreOpen(false);
  setSpeedMenuOpen(open);
});
ui.speedMenu.addEventListener("click", (event) => {
  event.stopPropagation();
  const btn = event.target.closest("button[data-rate]");
  if (!btn) return;
  setSpeedMenuOpen(false);
  setRateFromHotkey(Number(btn.dataset.rate) || 1);
});
ui.errorPrimary.addEventListener("click", onErrorPrimary);

ui.viewTabs.addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-view]");
  if (!btn) return;
  view = btn.dataset.view;
  if (view === "outline" && !outline && state?.cues?.length) {
    // stay empty until user clicks 生成大纲
  }
  renderState(state);
});

ui.btnGenerate.addEventListener("click", generateSubtitles);
ui.btnGenerateEmpty.addEventListener("click", generateSubtitles);
$("btnCancelGen").addEventListener("click", cancelGenerate);
$("btnCancelAsrJob")?.addEventListener("click", cancelGenerate);
$("btnCancelTrJob")?.addEventListener("click", cancelTranslate);
ui.asrJobBar?.addEventListener("click", (event) => {
  if (event.target.closest("#btnCancelAsrJob")) return;
  if (!generating && state?.partial) generateSubtitles();
});
$("btnGenOutline").addEventListener("click", generateOutline);
$("btnRegenOutline").addEventListener("click", () => {
  outline = null;
  generateOutline();
});
$("btnCopyOutline").addEventListener("click", async () => {
  if (!outline?.length) return;
  await copyText(outlineText());
  flash("大纲已复制（含时间戳）");
});
$("btnOutlineMd").addEventListener("click", () => {
  if (!outline?.length) return;
  const name = `${fileBase()}-outline.md`;
  downloadText(name, outlineMarkdown());
  flash(`已保存 ${name}`);
});

ui.outlineList.addEventListener("click", (event) => {
  const row = event.target.closest(".chapter");
  if (!row || !ui.outlineList.contains(row)) return;
  const time = Number(row.dataset.start);
  if (!Number.isFinite(time)) return;
  sendToTab({ type: "SEEK", time }).catch((error) => {
    flash(error.message || "跳转失败，请先点一下视频页");
  });
});

const markUserCueScroll = () => {
  userCueScrollAt = Date.now();
  cueScrollAnim = null;
  if (cueScrollRaf) {
    cancelAnimationFrame(cueScrollRaf);
    cueScrollRaf = 0;
  }
};
ui.cueList.addEventListener("wheel", markUserCueScroll, { passive: true });
ui.cueList.addEventListener("touchmove", markUserCueScroll, { passive: true });
ui.cueList.addEventListener("click", (event) => {
  const row = event.target.closest(".cue");
  if (!row || !ui.cueList.contains(row)) return;
  const index = Number(row.dataset.index);
  const cue = state?.cues?.[index];
  if (!cue) return;
  onCueClick(index, cue, event);
});
ui.cueList.addEventListener("pointerdown", (event) => {
  const row = event.target.closest(".cue");
  if (row && ui.cueList.contains(row)) {
    onCuePointerDown(event, Number(row.dataset.index));
    return;
  }
  if (event.pointerType === "mouse" && event.button === 0 && !selectHeld && !selecting) {
    if (event.target === ui.cueList) markUserCueScroll();
  }
});

ui.cueList.addEventListener("pointermove", onCuePointerMove);
ui.cueList.addEventListener("pointerenter", onCuePointerMove);
ui.cueList.addEventListener("pointerup", onCuePointerUp);
ui.cueList.addEventListener("pointercancel", onCuePointerUp);
window.addEventListener("pointermove", (event) => {
  rememberPointer(event);
  if (selKeyReleasedNow(event) && selectHeld) {
    finishHeldSelect();
    return;
  }
  if (selectHeld) extendHoverSelect(event);
  else if (dragSelect || selKeyDownNow(event)) onCuePointerMove(event);
});
window.addEventListener("pointerup", (event) => {
  if (dragSelect) onCuePointerUp(event);
});

ui.btnOverlay.addEventListener("click", () => setOverlayOn(!overlayOn));
ui.btnSelect.addEventListener("click", () => {
  selecting = !selecting;
  range = { start: -1, end: -1 };
  anchor = -1;
  hasSummary = false;
  show(ui.summaryBox, false);
  if (selecting) pausePlayback();
  paintSelection();
});
$("btnClearSelect").addEventListener("click", () => {
  selecting = false;
  range = { start: -1, end: -1 };
  hasSummary = false;
  show(ui.summaryBox, false);
  paintSelection();
});
$("btnCopy").addEventListener("click", async () => {
  const cues = selectedCues();
  if (!cues.length) return;
  try {
    await copyText(cues.map((item) => item.content).join("\n"));
    markCopied($("btnCopy"), true);
  } catch {
    markCopied($("btnCopy"), false);
  }
});
function closeSummary() {
  hasSummary = false;
  showSummaryThinking(false);
  show(ui.summaryBox, false);
  paintSelection();
}

$("btnSummary").addEventListener("click", summarizeSelection);
$("btnCloseSummary").addEventListener("click", closeSummary);
$("btnCopySummary").addEventListener("click", async () => {
  const thinking = ui.summaryThink && !ui.summaryThink.classList.contains("hidden");
  const text = ui.summaryText.textContent.trim();
  if (!text || thinking) return;
  try {
    await copyText(text);
    markCopied($("btnCopySummary"), true);
  } catch {
    markCopied($("btnCopySummary"), false);
  }
});

ui.btnMore.addEventListener("click", (event) => {
  event.stopPropagation();
  setMoreOpen(!moreOpen);
});
document.addEventListener("click", () => {
  if (moreOpen) setMoreOpen(false);
  setSpeedMenuOpen(false);
});
$("btnSrt").addEventListener("click", () => {
  if (!state?.cues?.length) return;
  const name = `${fileBase()}.srt`;
  downloadText(name, toSrt(state.cues));
  flash(`已保存 ${name}`);
  setMoreOpen(false);
});
$("btnTxt").addEventListener("click", () => {
  if (!state?.cues?.length) return;
  const name = `${fileBase()}.txt`;
  downloadText(name, state.cues.map((item) => item.content).join("\n"));
  flash(`已保存 ${name}`);
  setMoreOpen(false);
});
$("btnTranslate").addEventListener("click", translateCues);

ui.trackSelect.addEventListener("change", async () => {
  const next = await sendToTab({ type: "SWITCH_TRACK", lan: ui.trackSelect.value });
  renderState(next);
});

function applySelKeyState(held) {
  selKeyHeldFromPage = Boolean(held);
  if (!selKeyHeldFromPage && selectHeld) finishHeldSelect();
}

function applyForwardedKey(data) {
  const fake = {
    key: data.key,
    code: data.code,
    metaKey: data.metaKey,
    ctrlKey: data.ctrlKey,
    altKey: data.altKey,
    shiftKey: data.shiftKey,
    type: data.phase,
    target: document.body,
    preventDefault() {}
  };
  if (data.phase === "keydown") onSidepanelHotkey(fake);
  else onSelKeyUp(fake);
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!isForThisPanel(message, sender)) return;
  if (message?.type === "SEL_KEY_STATE") {
    applySelKeyState(Boolean(message.held));
    return;
  }
  if (message?.type === "PANEL_KEY" || message?.type === "BC_DOCK_KEY") {
    applyForwardedKey(message);
    return;
  }
  if (message?.type === "TIME" || message?.type === "RATE") {
    if (state) {
      if (message.currentTime != null) state.currentTime = message.currentTime;
      if (message.duration != null) state.duration = message.duration;
      if (message.rate != null) state.rate = message.rate;
    }
    if (message.currentTime != null) highlight(message.currentTime || 0);
    if (message.rate != null) renderSpeed(message.rate);
  }
  if (message?.type === "ASR_PROGRESS") {
    if (message.tabId && boundTabId && message.tabId !== boundTabId && !inFloatEmbed()) return;
    if (state?.bvid && !sameAsrVideo(message)) return;
    if (message.jobId) asrJobId = message.jobId;
    if (message.stage === "error" || message.stage === "canceled") {
      generating = false;
      asrProgress = null;
      asrJobId = "";
      clearInterval(asrWaitTimer);
      stopAsrWatch();
      if (message.cues?.length) {
        const cues = applyRememberedTranslations(message.cues);
        const translated = translatedCueText.size > 0;
        state = {
          ...(state || {}),
          cues,
          source: translated ? "translated" : "groq",
          activeLan: translated ? "translated" : "groq-asr",
          partial: true,
          asrDone: Number(message.done) || Number(state?.asrDone) || 0,
          asrTotal: Number(message.total) || Number(state?.asrTotal) || 0
        };
      }
      if (message.stage === "error") {
        asrStopReason = message.message || "转写失败";
        if (state?.cues?.length) {
          flash(`转写已停止：${asrStopReason}`, 6000);
        }
        else genError = message.message || "转写失败";
      }
      renderState(state || { page: "video" });
      return;
    }
    if (message.stage === "done") {
      generating = false;
      asrProgress = null;
      asrJobId = "";
      asrStopReason = "";
      clearInterval(asrWaitTimer);
      stopAsrWatch();
      if (message.cues?.length) {
        const cues = applyRememberedTranslations(message.cues);
        const translated = translatedCueText.size > 0;
        state = {
          ...(state || {}),
          cues,
          source: translated ? "translated" : "groq",
          activeLan: translated ? "translated" : "groq-asr",
          partial: false
        };
      }
      renderState(state || { page: "video" });
      flash(message.message || "字幕生成完成");
      return;
    }
    generating = true;
    applyAsrProgress(message);
    if (!state?.cues?.length) renderGenProgress(message.stage, message.message || "");
  }
  if (message?.type === "STATE" && message.payload && !outlineLoading) {
    if (generating) {
      if (message.payload.cues?.length && sameAsrVideo(message.payload)) {
        const cues = applyRememberedTranslations(message.payload.cues);
        const translated = translatedCueText.size > 0;
        state = {
          ...state,
          ...message.payload,
          cues,
          source: translated ? "translated" : message.payload.source,
          activeLan: translated ? "translated" : message.payload.activeLan
        };
        renderCues();
        renderAsrJobBar();
      }
      return;
    }
    renderState(message.payload);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (changes.selKey) selKey = changes.selKey.newValue || "Shift";
  if (changes.overlayOn) {
    overlayOn = changes.overlayOn.newValue !== false;
    renderOverlayBtn();
  }
  if (changes.summaryPad) {
    summaryPad = Math.min(50, Math.max(0, Math.round(Number(changes.summaryPad.newValue) || 10)));
  }
  if (changes.groqApiKey || changes.sttKey) {
    hasSttKey = Boolean(changes.groqApiKey?.newValue || changes.sttKey?.newValue || hasSttKey);
    if (changes.groqApiKey) hasSttKey = Boolean(changes.groqApiKey.newValue);
  }
});

if (!inFloatEmbed()) {
  chrome.windows.getCurrent().then((win) => {
    panelWindowId = win?.id || 0;
  }).catch(() => {});
  chrome.tabs.onActivated.addListener((info) => {
    if (panelWindowId && info.windowId && info.windowId !== panelWindowId) return;
    boundTabId = info.tabId;
    refresh(false);
  });
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (tabId !== boundTabId) return;
    if (info.status === "complete") refresh(false);
  });
}

chrome.storage.local.get({ lastVideo: null }).then((data) => {
  lastVideo = data.lastVideo;
  renderLastVideoHint();
});

loadPrefs().then(() => {
  if (state) renderState(state);
});
refresh(false);
window.addEventListener("keydown", onSidepanelHotkey, true);
window.addEventListener("keyup", onSelKeyUp, true);
window.addEventListener("blur", onSelKeyUp);
window.addEventListener("message", (event) => {
  if (event.data?.type === "BC_TAB") {
    myTabId = Number(event.data.tabId) || 0;
    boundTabId = myTabId;
    return;
  }
  if (event.data?.type === "SEL_KEY_STATE") {
    applySelKeyState(Boolean(event.data.held));
    return;
  }
  if (event.data?.type === "BC_DOCK_KEY" || event.data?.type === "PANEL_KEY") {
    applyForwardedKey(event.data);
  }
});
