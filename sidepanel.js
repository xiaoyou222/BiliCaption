const GEN_STEPS = ["拉取音频流", "分段语音识别", "对齐时间轴"];
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
  captionLang: $("captionLang"),
  emptyView: $("emptyView"),
  emptyTitle: $("emptyTitle"),
  emptyFetchHint: $("emptyFetchHint"),
  emptyKeyHint: $("emptyKeyHint"),
  generatingView: $("generatingView"),
  genThink: $("genThink"),
  jobPill: $("jobPill"),
  jobPillHead: $("jobPillHead"),
  jobPillLabel: $("jobPillLabel"),
  jobPillOrb: $("jobPillOrb"),
  jobPillBody: $("jobPillBody"),
  asrJobBar: $("asrJobBar"),
  asrSwitchNote: $("asrSwitchNote"),
  asrSegOrb: $("asrSegOrb"),
  asrJobTitle: $("asrJobTitle"),
  asrJobFill: $("asrJobFill"),
  asrSegPct: $("asrSegPct"),
  trJobBar: $("trJobBar"),
  trJobTitle: $("trJobTitle"),
  trSegPct: $("trSegPct"),
  chunkLiveList: $("chunkLiveList"),
  chunkDoneList: $("chunkDoneList"),
  btnChunkFold: $("btnChunkFold"),
  cueGhosts: $("cueGhosts"),
  errorView: $("errorView"),
  errorTitle: $("errorTitle"),
  errorPrimary: $("errorPrimary"),
  outlineEmpty: $("outlineEmpty"),
  outlineEmptyOrb: $("outlineEmptyOrb"),
  outlineEmptyLabel: $("outlineEmptyLabel"),
  outlineList: $("outlineList"),
  videoSummary: $("videoSummary"),
  videoSummaryToggle: $("videoSummaryToggle"),
  videoSummaryChevron: $("videoSummaryChevron"),
  videoSummaryBody: $("videoSummaryBody"),
  outlineBar: $("outlineBar"),
  summaryBox: $("summaryBox"),
  summaryTitle: $("summaryTitle"),
  summaryThink: $("summaryThink"),
  summaryText: $("summaryText"),
  summaryMeta: $("summaryMeta"),
  outlineThink: $("outlineThink"),
  outlineHead: $("outlineHead"),
  outlineHeadLabel: $("outlineHeadLabel"),
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
let captionLang = "zh";
let summaryPad = 10;
let translateConcurrency = 4;
let view = "captions";
let markers = [];
let markerKey = "";
let editingMarkerId = null;
let markerDrafts = new Map();
let markerMoreOpen = false;
let outline = null;
let videoSummary = "";
let videoSummaryOpen = true;
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
let asrSwitchNote = "";
let asrSwitchNoteTimer = 0;
let asrWaitTimer = 0;
let asrWatchTimer = 0;
let asrMissingChecks = 0;
let asrStopReason = "";
let translating = false;
let translateJobId = "";
let translateProgress = { done: 0, total: 0 };
let translateWatchTimer = 0;
let translateMissingChecks = 0;
let translatedCueText = new Map();
let translatedCueVideoKey = "";
let translatedCueRanges = [];
let jobPillOpen = false;
let jobPillAnimating = false;
let jobPillChipW = 0;
let chunkListExpanded = false;
let asrPaused = false;
let outlineAbort = null;
let stopPillOrb = null;
let stopAsrSegOrb = null;
let stopOutlineEmptyOrb = null;
let outlineChapterTotal = 0;

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
    .map((cue, i) => `${i + 1}\n${srtTime(cue.from)} --> ${srtTime(cue.to)}\n${cueDisplayText(cue)}\n`)
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
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
  return list.map((cue) => String(cue?.content || "").trim()).join("\n");
}

function originalForCue(cue) {
  const tagged = String(cue?.original || "").trim();
  if (tagged) return tagged;
  const text = normCueText(cue?.content);
  if (!text) return "";
  for (const item of translatedCueRanges) {
    if (item.original && normCueText(item.translated) === text) return item.original;
  }
  for (const [key, zh] of translatedCueText.entries()) {
    if (key.startsWith("e:") && normCueText(zh) === text) return key.slice(2);
  }
  return "";
}

function hydrateCueOriginals(cues) {
  if (!Array.isArray(cues)) return [];
  return cues.map((cue) => {
    if (String(cue?.original || "").trim()) return cue;
    const original = originalForCue(cue);
    return original ? { ...cue, original } : cue;
  });
}

function cueDisplayText(cue) {
  if (captionLang === "en") {
    const original = originalForCue(cue);
    if (original) return original;
  }
  return window.BiliCaptionTranslate?.cueDisplayText?.(cue, captionLang)
    || String(cue?.content || "").trim();
}

function hasBilingualCaptions(cues = state?.cues) {
  return (cues || []).some((cue) => {
    const original = originalForCue(cue);
    return Boolean(original) && original !== String(cue?.content || "").trim();
  });
}

function trackLangKind(track) {
  return window.BiliCaptionTranslate?.trackLangKind?.(track) || "";
}

function pickTrackByLang(tracks, lang) {
  return window.BiliCaptionTranslate?.pickTrackByLang?.(tracks, lang) || null;
}

function isPluginCaptions(next = state) {
  return window.BiliCaptionTranslate?.isPluginCaptionSource?.(next?.source, next?.activeLan) === true;
}

function cueLooksEnglish(text) {
  return window.BiliCaptionTranslate?.needsTranslation?.(text) === true;
}

function canShowCaptionLang(lang) {
  if (isPluginCaptions()) {
    return window.BiliCaptionTranslate?.captionListHasLang?.(state?.cues, lang) === true;
  }
  return Boolean(pickTrackByLang(state?.tracks, lang));
}

function syncCaptionLangFromState(next = state) {
  if (hasBilingualCaptions(next?.cues)) return;
  if (isPluginCaptions(next)) {
    const cues = next?.cues || [];
    const hasZh = cues.some((cue) => cueHasCjk(cue.content));
    const hasEn = cues.some((cue) => String(cue.original || "").trim() || cueLooksEnglish(cue.content));
    if (hasEn && !hasZh) captionLang = "en";
    else if (hasZh && !hasEn) captionLang = "zh";
    return;
  }
  const kind = trackLangKind({ lan: next?.activeLan || "", lanDoc: "" });
  if (kind) captionLang = kind;
}

function renderCaptionLang() {
  const el = ui.captionLang || $("captionLang");
  if (!el) return;
  const bilingual = view === "captions"
    && Boolean(state?.cues?.length)
    && canShowCaptionLang("zh")
    && canShowCaptionLang("en");
  show(el, bilingual);
  el.querySelectorAll("button[data-lang]").forEach((btn) => {
    const lang = btn.dataset.lang;
    const on = lang === captionLang;
    const enabled = canShowCaptionLang(lang);
    btn.classList.toggle("active", on);
    btn.disabled = !enabled;
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

async function setCaptionLang(lang) {
  const next = lang === "en" ? "en" : "zh";
  if (!canShowCaptionLang(next)) {
    if (isPluginCaptions() && next === "en") {
      flash("这份翻译没有留下英文原文，清理缓存后再翻译一次");
    } else if (isPluginCaptions() && next === "zh") {
      flash("还没有中文，请先翻译");
    } else {
      flash(next === "en" ? "没有英文字幕" : "没有中文字幕");
    }
    return;
  }
  captionLang = next;
  chrome.storage.sync.set({ captionLang }).catch(() => {});
  // 自己转写/翻译的字幕绝不能切到 B 站官方轨，否则生成结果会被盖掉。
  if (!isPluginCaptions()) {
    const track = pickTrackByLang(state?.tracks, next);
    if (track && track.lan !== state?.activeLan) {
      const result = await sendToTab({ type: "SWITCH_TRACK", lan: track.lan });
      renderState(result);
      return;
    }
  }
  lastCuesSig = "";
  renderCaptionLang();
  renderCues();
  sendToTab({ type: "SET_CAPTION_LANG", lang: captionLang }).catch(() => {});
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

const SPEED_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

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
    return `<button type="button" role="option" aria-selected="${on ? "true" : "false"}" data-rate="${item}" class="${on.trim()}">${formatRate(item)}</button>`;
  }).join("");
  if (ui.speedMenu.dataset.html !== html) {
    ui.speedMenu.dataset.html = html;
    ui.speedMenu.innerHTML = html;
  } else {
    ui.speedMenu.querySelectorAll("button").forEach((btn) => {
      const selected = Math.abs(Number(btn.dataset.rate) - value) < 0.001;
      btn.classList.toggle("on", selected);
      btn.setAttribute("aria-selected", selected ? "true" : "false");
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
    bvid: next.bvid || lastVideo?.bvid || "",
    pic: next.pic || lastVideo?.pic || "",
    up: next.up || lastVideo?.up || ""
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

function outlineApi() {
  return globalThis.BiliCaptionOutline;
}

function outlineKey(next = state) {
  if (!next?.bvid && !next?.cid) return "";
  return `outline:v2:${next.bvid || ""}:${next.cid || ""}`;
}

function setMoreOpen(open) {
  moreOpen = open;
  show(ui.moreMenu, open);
  ui.btnMore.classList.toggle("active", open);
  if (open) {
    setSpeedMenuOpen(false);
    setMarkerMoreOpen(false);
  }
}

function setMarkerMoreOpen(open) {
  markerMoreOpen = open;
  show($("markerMoreMenu"), open);
  $("btnMarkerMore")?.classList.toggle("active", open);
  if (open) {
    moreOpen = false;
    show(ui.moreMenu, false);
    ui.btnMore?.classList.remove("active");
    setSpeedMenuOpen(false);
  }
}

function markersApi() {
  return globalThis.BiliCaptionMarkers;
}

function marksVideoKey(next = state) {
  if (!next?.bvid && next?.cid == null) return "";
  return `${next?.bvid || ""}:${Number(next?.cid) || 0}`;
}

function markerMeta(next = state) {
  return {
    title: next?.title || lastVideo?.title || "",
    up: next?.up || lastVideo?.up || "",
    part: next?.part || lastVideo?.part || "",
    dur: formatTime(next?.duration || lastVideo?.duration || 0),
    pic: next?.pic || lastVideo?.pic || ""
  };
}

async function loadMarkers(next = state) {
  const M = markersApi();
  const key = marksVideoKey(next);
  if (!M || !key) {
    markers = [];
    markerKey = "";
    editingMarkerId = null;
    markerDrafts.clear();
    return;
  }
  if (key !== markerKey) {
    editingMarkerId = null;
    markerDrafts.clear();
    markerKey = key;
  }
  const list = await M.load(next.bvid, next.cid);
  if (marksVideoKey(state) !== key && marksVideoKey(next) !== marksVideoKey(state)) return;
  markers = list;
}

function sameMarkerId(a, b) {
  return String(a) === String(b);
}

function renderMarkerBar() {
  const label = `+ 标记 ${formatTime(state?.currentTime || 0)}`;
  const add = $("btnAddMarker");
  if (add) add.textContent = label;
  const now = $("btnMarkNow");
  if (now) now.textContent = label;
}

function renderMarkers() {
  const host = $("markerList");
  const empty = $("markerEmpty");
  if (!host || !empty) return;
  const has = markers.length > 0;
  show(host, has);
  show(empty, !has);
  host.replaceChildren();
  renderMarkerBar();
  updateSummaryMarkerBtn();
  if (!has) return;

  for (const m of markers) {
    const row = document.createElement("div");
    row.className = "marker-row";
    row.dataset.id = String(m.id);

    const time = document.createElement("time");
    time.textContent = formatTime(m.time);

    const body = document.createElement("div");
    body.style.cssText = "flex:1;min-width:0";

    if (sameMarkerId(editingMarkerId, m.id)) {
      const ta = document.createElement("textarea");
      ta.rows = 2;
      ta.placeholder = "写点什么…";
      ta.value = markerDrafts.has(m.id) ? markerDrafts.get(m.id) : (m.text || "");
      ta.addEventListener("click", (e) => e.stopPropagation());
      ta.addEventListener("pointerdown", (e) => e.stopPropagation());
      ta.addEventListener("input", () => {
        markerDrafts.set(m.id, ta.value);
        ta.style.height = "auto";
        ta.style.height = `${ta.scrollHeight}px`;
      });
      ta.addEventListener("blur", () => commitMarker(m.id));
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          ta.blur();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          markerDrafts.delete(m.id);
          editingMarkerId = null;
          renderMarkers();
        }
      });
      body.appendChild(ta);
      requestAnimationFrame(() => {
        ta.focus();
        ta.style.height = "auto";
        ta.style.height = `${ta.scrollHeight}px`;
        const end = ta.value.length;
        ta.setSelectionRange(end, end);
      });
    } else {
      const p = document.createElement("span");
      p.className = `marker-text${m.text ? "" : " empty"}`;
      p.textContent = m.text || "（空）";
      p.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        startEditMarker(m.id);
      });
      body.appendChild(p);
    }

    const tools = document.createElement("div");
    tools.className = "marker-tools";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "改";
    edit.addEventListener("click", (e) => {
      e.stopPropagation();
      startEditMarker(m.id);
    });
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "×";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteMarker(m.id);
    });
    tools.append(edit, del);

    row.append(time, body, tools);
    row.addEventListener("click", () => {
      if (sameMarkerId(editingMarkerId, m.id)) return;
      sendToTab({ type: "SEEK", time: m.time }).catch((error) => {
        flash(error.message || "跳转失败，请先点一下视频页");
      });
    });
    host.appendChild(row);
  }
}

function startEditMarker(id) {
  editingMarkerId = id;
  const m = markers.find((x) => sameMarkerId(x.id, id));
  if (m && !markerDrafts.has(m.id)) markerDrafts.set(m.id, m.text || "");
  renderMarkers();
}

async function commitMarker(id) {
  const M = markersApi();
  if (!M || !state) {
    editingMarkerId = null;
    return;
  }
  const draft = String(markerDrafts.get(id) ?? "").trim();
  markerDrafts.delete(id);
  if (sameMarkerId(editingMarkerId, id)) editingMarkerId = null;
  try {
    markers = await M.update(state.bvid, state.cid, id, draft, markerMeta());
  } catch {
    await loadMarkers(state);
  }
  renderMarkers();
}

async function deleteMarker(id) {
  const M = markersApi();
  if (!M || !state) return;
  if (sameMarkerId(editingMarkerId, id)) editingMarkerId = null;
  markerDrafts.delete(id);
  markers = await M.remove(state.bvid, state.cid, id, markerMeta());
  renderMarkers();
}

async function addManualMarker() {
  if (!state) return;
  const time = Math.floor(Number(state.currentTime) || 0);
  const M = markersApi();
  if (!M) return;
  try {
    markers = await M.add(state.bvid, state.cid, { time, text: "" }, markerMeta());
    const added = markers.find((m) => Math.floor(m.time) === time);
    editingMarkerId = added?.id ?? null;
    if (editingMarkerId != null) markerDrafts.set(editingMarkerId, "");
    view = "markers";
    renderState(state);
  } catch (error) {
    flash(error.message || "添加失败");
    if (error.duplicate) {
      view = "markers";
      renderState(state);
    }
  }
}

function summaryMarkerText() {
  const edit = $("summaryEdit");
  if (edit && !edit.classList.contains("hidden")) return edit.value.trim();
  return (ui.summaryText?.innerText || ui.summaryText?.textContent || "").trim();
}

function summaryMarkerTime() {
  const from = Math.min(range.start, range.end >= 0 ? range.end : range.start);
  if (from >= 0 && state?.cues?.[from]) return Number(state.cues[from].from) || 0;
  return Number(state?.currentTime) || 0;
}

async function addMarkerFromSummary() {
  const text = summaryMarkerText();
  if (!text) {
    flash("还没有总结内容");
    return;
  }
  const time = summaryMarkerTime();
  const M = markersApi();
  if (!M || !state) return;
  try {
    markers = await M.add(state.bvid, state.cid, { time, text }, markerMeta());
    flash(`已添加标记 · ${formatTime(time)}`);
    updateSummaryMarkerBtn();
  } catch (error) {
    flash(error.message || "添加失败");
  }
}

function updateSummaryMarkerBtn() {
  const btn = $("btnAddMarkerSummary");
  if (!btn) return;
  const time = summaryMarkerTime();
  const exists = markers.some((m) => Math.floor(m.time) === Math.floor(time));
  btn.textContent = exists ? "已标记" : "+ 标记";
  btn.classList.toggle("active", exists);
}

function openLibrary() {
  const id = marksVideoKey();
  openExtensionPage("library.html", id ? `?id=${encodeURIComponent(id)}` : "");
}

function markerEntry() {
  return {
    bvid: state?.bvid || "",
    cid: Number(state?.cid) || 0,
    title: state?.title || "",
    part: state?.part || "",
    dur: formatTime(state?.duration || 0)
  };
}

async function copyMarkers() {
  const M = markersApi();
  if (!M || !markers.length) {
    flash("还没有标记");
    return;
  }
  try {
    await copyText(M.copyText(markers, state?.bvid || ""));
    flash(`已复制 ${markers.length} 条标记（时间戳为可点链接）`);
  } catch {
    flash("复制失败");
  }
}

function exportMarkers(kind) {
  const M = markersApi();
  if (!M || !markers.length) {
    flash("还没有标记");
    return;
  }
  const entry = markerEntry();
  if (kind === "md") {
    const name = `${fileBase()}-marks.md`;
    downloadText(name, M.toMarkdown(entry, markers));
    flash(`已保存 ${name} · 时间戳带 ?t= 可跳回 B 站`);
  } else {
    const name = `${fileBase()}-marks.csv`;
    downloadText(name, M.toCsv(entry, markers));
    flash(`已保存 ${name} · 含 URL 列`);
  }
}

function openExtensionPage(file, query = "") {
  const url = chrome.runtime.getURL(file) + query;
  chrome.tabs.create({ url }).catch(() => {
    chrome.runtime.openOptionsPage();
  });
}

const SETTINGS_TABS = ["stt", "sum", "sync", "keys", "logs"];

function openSettings(tab) {
  const name = SETTINGS_TABS.includes(tab) ? tab : "";
  const query = name ? `?tab=${encodeURIComponent(name)}` : "";
  openExtensionPage("options.html", query);
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
    stopSummaryOrb = startOrb(ui.summaryThink, { state: "composing", size: 20, speed: 0.7, iconOnly: true, label: "" });
    setShimmer(ui.summaryTitle, true, "正在总结…");
    return;
  }
  stopSummaryOrb?.();
  stopSummaryOrb = null;
  if (ui.summaryThink) show(ui.summaryThink, false);
  setShimmer(ui.summaryTitle, false, "选区总结");
}

function showOutlineThinking(on) {
  if (on) {
    if (stopOutlineOrb) return;
    if (ui.outlineThink) {
      stopOutlineOrb = startOrb(ui.outlineThink, { state: "composing", size: 20, speed: 0.7, iconOnly: true, label: "" });
    }
    return;
  }
  stopOutlineOrb?.();
  stopOutlineOrb = null;
}

function setShimmer(el, on, text) {
  if (!el) return;
  if (text != null) el.textContent = text;
  el.classList.toggle("is-shimmer", Boolean(on));
  if (on) el.setAttribute("data-shimmer", el.textContent || "");
  else el.removeAttribute("data-shimmer");
}

function setOrbLabel(host, label) {
  const text = host?.querySelector(".think-pill-label");
  if (!text) return;
  text.dataset.text = label;
  text.textContent = label;
}

function showAsrSegOrb(on) {
  if (!on) {
    stopAsrSegOrb?.();
    stopAsrSegOrb = null;
    if (ui.asrSegOrb) ui.asrSegOrb.replaceChildren();
    return;
  }
  if (stopAsrSegOrb || !ui.asrSegOrb) return;
  stopAsrSegOrb = startOrb(ui.asrSegOrb, {
    state: "searching",
    size: 13,
    speed: 0.9,
    iconOnly: true,
    label: ""
  });
}

function showOutlineEmptyOrb(on) {
  if (!on) {
    stopOutlineEmptyOrb?.();
    stopOutlineEmptyOrb = null;
    if (ui.outlineEmptyOrb) {
      ui.outlineEmptyOrb.replaceChildren();
      show(ui.outlineEmptyOrb, false);
    }
    return;
  }
  if (!ui.outlineEmptyOrb) return;
  show(ui.outlineEmptyOrb, true);
  if (stopOutlineEmptyOrb) return;
  stopOutlineEmptyOrb = startOrb(ui.outlineEmptyOrb, { state: "composing", size: 64, speed: 0.6, iconOnly: true, label: "" });
}

function showPillOrb(on) {
  if (!on) {
    stopPillOrb?.();
    stopPillOrb = null;
    if (ui.jobPillOrb) ui.jobPillOrb.replaceChildren();
    return;
  }
  if (stopPillOrb || !ui.jobPillOrb) return;
  stopPillOrb = startOrb(ui.jobPillOrb, {
    state: "searching",
    size: 13,
    speed: 0.9,
    iconOnly: true,
    label: ""
  });
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
  if (!info || !state) return false;
  const hasIdentity = Boolean(info.bvid || info.cid);
  const expectedBvid = state.bvid || "";
  const expectedCid = Number(state.cid) || 0;
  if (!hasIdentity || (!expectedBvid && !expectedCid)) return false;
  if (info.bvid && (!expectedBvid || info.bvid !== expectedBvid)) return false;
  if (info.cid && (!expectedCid || Number(info.cid) !== expectedCid)) return false;
  return true;
}

function translationVideoKey(value = state) {
  const id = value?.bvid || value?.aid || "";
  const cid = Number(value?.cid) || 0;
  return id || cid ? `${id}:${cid}` : "";
}

function cueTranslationKey(cue) {
  const from = Math.round((Number(cue?.from) || 0) * 100);
  const to = Math.round((Number(cue?.to) || 0) * 100);
  return `${from}-${to}`;
}

function cueHasCjk(text) {
  return (String(text || "").match(/[\u4e00-\u9fff]/g) || []).length >= 1;
}

function cueOverlap(a, b) {
  return Math.min(Number(a?.to) || 0, Number(b?.to) || 0)
    - Math.max(Number(a?.from) || 0, Number(b?.from) || 0);
}

function normCueText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function resetTranslationsFor(value = state) {
  const key = translationVideoKey(value);
  if (translatedCueVideoKey && key && translatedCueVideoKey !== key) {
    translatedCueText = new Map();
    translatedCueRanges = [];
  }
  if (key) translatedCueVideoKey = key;
}

function rememberTranslatedCue(cue, content, original) {
  resetTranslationsFor(state);
  const translated = String(content || "");
  if (!translated) return;
  translatedCueText.set(cueTranslationKey(cue), translated);
  const orig = normCueText(original);
  if (orig) translatedCueText.set(`e:${orig}`, translated);
  translatedCueRanges.push({
    from: Number(cue?.from) || 0,
    to: Number(cue?.to) || Number(cue?.from) || 0,
    original: orig,
    translated
  });
}

function applyRememberedTranslations(cues) {
  if (!Array.isArray(cues)) return [];
  const hasMemory = translatedCueText.size || translatedCueRanges.length;
  if (!hasMemory) return cues.map((cue) => ({ ...cue }));
  return cues.map((cue) => {
    const text = normCueText(cue.content);
    if (cueHasCjk(text) && !needsTranslation(text)) return { ...cue };
    const byOriginal = text ? translatedCueText.get(`e:${text}`) : null;
    if (byOriginal) return { ...cue, content: byOriginal, original: cue.original || text };
    const byTime = translatedCueText.get(cueTranslationKey(cue));
    if (byTime != null) return { ...cue, content: byTime, original: cue.original || text };
    for (const item of translatedCueRanges) {
      if (!item.original || item.original !== text) continue;
      const overlap = cueOverlap(cue, item);
      const dur = Math.max(0.2, (Number(cue.to) || 0) - (Number(cue.from) || 0));
      if (overlap >= dur * 0.8) {
        return { ...cue, content: item.translated, original: cue.original || text };
      }
    }
    return { ...cue };
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
      clearInterval(asrWaitTimer);
      asrStopReason = "Chrome 后台任务已中断";
      if (state) {
        state = {
          ...state,
          partial: true,
          asrDone: Math.max(Number(asrProgress?.done) || 0, Number(state.asrDone) || 0),
          asrTotal: Math.max(Number(asrProgress?.total) || 0, Number(state.asrTotal) || 0)
        };
      }
      renderAsrJobBar();
      if (state?.partial) flash("后台任务已中断，已保留进度，可继续生成", 6000);
    } catch {
      // 下一轮再确认，避免一次消息失败就误判任务中断
    } finally {
      checking = false;
    }
  }, 20 * 1000);
}

function chunkStatusLabel(status) {
  if (status === "fail") return "失败";
  if (status === "run") return "转写中";
  if (status === "pause") return "已暂停";
  if (status === "done") return "✓ 完成";
  return "排队";
}

function synthesizeChunks(done, total, current, duration, failed = []) {
  const n = Math.max(0, Number(total) || 0);
  if (!n || n > 400) return [];
  const dur = Math.max(0, Number(duration) || 0);
  const slice = dur && n ? dur / n : 0;
  const failSet = new Set((failed || []).map((i) => Number(i)));
  const running = Math.max(0, Number(current) || (done < n ? done + 1 : 0));
  return Array.from({ length: n }, (_, idx) => {
    const i = idx + 1;
    const start = slice ? slice * idx : 0;
    const end = slice ? slice * i : 0;
    let status = "wait";
    if (failSet.has(i) || failSet.has(idx)) status = "fail";
    else if (i <= done) status = "done";
    else if (i === running && generating && !asrPaused) status = "run";
    else if (i === running && asrPaused) status = "pause";
    return { i, start, end, status };
  });
}

function renderChunkRows(host, rows) {
  if (!host) return;
  // 冷却倒计时每秒重渲染整个胶囊，行没变就跳过，避免点阵球每秒重启闪一下
  const sig = rows.map((c) => `${c.i}:${c.status}:${Math.round(c.start || 0)}-${Math.round(c.end || 0)}`).join("|");
  if (host._chunkSig === sig) return;
  host._chunkSig = sig;
  (host._chunkOrbStops || []).forEach((stop) => stop());
  host._chunkOrbStops = [];
  host.replaceChildren();
  for (const c of rows) {
    const row = document.createElement("div");
    row.className = `chunk-row is-${c.status}`;
    const idx = document.createElement("span");
    idx.className = "chunk-idx";
    idx.textContent = `#${String(c.i).padStart(2, "0")}`;
    const range = document.createElement("span");
    range.className = "chunk-range";
    range.textContent = c.end
      ? `${formatTime(c.start)}–${formatTime(c.end)}`
      : "";
    row.append(idx, range);
    if (c.status === "fail") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "chunk-retry";
      retry.textContent = "重试";
      retry.addEventListener("click", (e) => {
        e.stopPropagation();
        retryAsrChunk(c.i);
      });
      row.appendChild(retry);
    } else {
      const st = document.createElement("span");
      st.className = `chunk-status ${c.status}`;
      if (c.status === "run") {
        const orbHost = document.createElement("span");
        orbHost.className = "chunk-orb";
        st.appendChild(orbHost);
        host._chunkOrbStops.push(startOrb(orbHost, {
          state: "searching",
          size: 13,
          speed: 0.9,
          iconOnly: true,
          label: ""
        }));
      }
      const label = document.createElement("span");
      label.textContent = chunkStatusLabel(c.status);
      st.appendChild(label);
      row.appendChild(st);
    }
    host.appendChild(row);
  }
}

const PILL_MORPH_MS = 340;
const PILL_MAX_H = () => Math.min(Math.round(window.innerHeight * 0.72), 420);

function cacheJobPillChipWidth(pill) {
  if (!pill || jobPillOpen || jobPillAnimating || pill.classList.contains("hidden")) return;
  const w = Math.ceil(pill.getBoundingClientRect().width);
  if (w > 24) jobPillChipW = w;
}

function pillMorphEnd(pill, done) {
  let called = false;
  const finish = () => {
    if (called) return;
    called = true;
    pill.removeEventListener("transitionend", onEnd);
    clearTimeout(timer);
    done();
  };
  // 宽和高谁先结束都行，只认 height，避免宽度先到就把展开类拆掉，箭头会在最后一帧抖一下
  const onEnd = (e) => {
    if (e.target === pill && e.propertyName === "height") finish();
  };
  pill.addEventListener("transitionend", onEnd);
  const timer = setTimeout(finish, PILL_MORPH_MS + 80);
}

function expandJobPill() {
  const pill = ui.jobPill;
  if (!pill || jobPillAnimating || jobPillOpen) return;
  const startW = Math.ceil(pill.getBoundingClientRect().width);
  if (startW > 24) jobPillChipW = startW;
  jobPillOpen = true;
  jobPillAnimating = true;
  // 先把展开态内容渲染出来并测量最终盒（含边框），避免结束时从 px 切回 max-content 跳一下
  renderAsrJobBar();
  pill.style.transition = "none";
  pill.style.width = "";
  pill.style.height = "auto";
  pill.offsetHeight;
  const openBox = pill.getBoundingClientRect();
  const targetW = openBox.width;
  const targetH = Math.min(openBox.height, PILL_MAX_H());
  // 从收起尺寸起步
  pill.style.width = `${startW}px`;
  pill.style.height = "20px";
  pill.offsetWidth; // reflow
  pill.style.transition = "";
  requestAnimationFrame(() => {
    pill.style.width = `${targetW}px`;
    pill.style.height = `${targetH}px`;
  });
  pillMorphEnd(pill, () => {
    pill.style.transition = "none";
    pill.style.width = "";
    pill.style.height = "";
    pill.offsetWidth;
    pill.style.transition = "";
    jobPillAnimating = false;
  });
}

function resetJobPillClosed() {
  jobPillOpen = false;
  jobPillAnimating = false;
  const pill = ui.jobPill;
  if (!pill) return;
  pill.classList.remove("is-open", "is-collapsing");
  pill.style.width = "";
  pill.style.height = "";
  pill.style.transition = "";
}

function collapseJobPill() {
  const pill = ui.jobPill;
  if (!pill || jobPillAnimating || !jobPillOpen) return;
  const startW = Math.ceil(pill.getBoundingClientRect().width);
  const startH = Math.ceil(pill.getBoundingClientRect().height);
  const chipW = jobPillChipW > 24 ? jobPillChipW : 80;
  jobPillAnimating = true;
  pill.classList.add("is-collapsing");
  renderAsrJobBar();
  pill.style.transition = "none";
  pill.style.width = `${startW}px`;
  pill.style.height = `${startH}px`;
  pill.offsetWidth;
  pill.style.transition = "";
  requestAnimationFrame(() => {
    pill.style.width = `${chipW}px`;
    pill.style.height = "20px";
  });
  pillMorphEnd(pill, () => {
    jobPillOpen = false;
    pill.classList.remove("is-open");
    pill.classList.remove("is-collapsing");
    pill.style.transition = "none";
    pill.style.width = "";
    pill.style.height = "";
    pill.offsetWidth;
    pill.style.transition = "";
    jobPillAnimating = false;
    renderAsrJobBar();
  });
}

function renderAsrJobBar() {
  const pill = ui.jobPill;
  const bar = ui.asrJobBar;
  const trBar = ui.trJobBar;
  const hasCues = Boolean(state?.cues?.length);
  const partial = Boolean(state?.partial);
  const showAsr = Boolean(generating || (partial && (asrProgress?.total || state?.asrTotal)));
  const showTr = Boolean(translating);
  const progress = asrProgress || {};
  const waitLeft = Math.max(0, (Number(progress.waitUntil) || 0) - Date.now());
  const waiting = generating && waitLeft > 0 && !progress.boosted;
  // 头部计数与分片列表必须同源，否则会出现「8/13 但列表 0 完成」
  const chunkRows = generating && Array.isArray(progress.chunks) && progress.chunks.length
    ? progress.chunks
    : null;
  const chunkDoneN = chunkRows ? chunkRows.filter((c) => c.status === "done").length : 0;
  const chunkRunIdx = chunkRows
    ? chunkRows.findIndex((c) => c.status === "run" || c.status === "pause") + 1
    : 0;
  const asrDone = chunkRows
    ? chunkDoneN
    : Number(generating ? progress.done ?? state?.asrDone : state?.asrDone) || 0;
  const asrTotal = chunkRows
    ? chunkRows.length
    : Number(generating ? progress.total ?? state?.asrTotal : state?.asrTotal) || 0;
  const asrCurrent = chunkRows ? chunkRunIdx : Number(progress.current) || 0;
  const asrShown = asrDone;
  const trDone = Number(translateProgress.done) || 0;
  const trTotal = Number(translateProgress.total) || 0;
  const failed = progress.failed || [];

  const coolLabel = (() => {
    const ms = waitLeft || 0;
    const sec = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  })();

  const collapsing = Boolean(pill?.classList.contains("is-collapsing"));
  if (ui.jobPillLabel) {
    if (jobPillOpen && !collapsing) ui.jobPillLabel.textContent = "后台任务";
    else if (showAsr && showTr) ui.jobPillLabel.textContent = "2 个任务";
    else if (showAsr && waiting) ui.jobPillLabel.textContent = `冷却 ${coolLabel}`;
    else if (showAsr) ui.jobPillLabel.textContent = asrTotal ? `转写 ${asrShown}/${asrTotal}` : "转写中";
    else if (showTr) ui.jobPillLabel.textContent = trTotal ? `翻译 ${trDone}/${trTotal}` : "翻译中";
  }

  if (pill) {
    const visible = showAsr || showTr;
    const wasHidden = pill.classList.contains("hidden");
    if (!visible || (visible && wasHidden)) resetJobPillClosed();
    show(pill, visible);
    pill.classList.toggle("is-wait", waiting);
    if (ui.jobPillHead) ui.jobPillHead.setAttribute("aria-expanded", jobPillOpen && visible ? "true" : "false");
    if (!collapsing) pill.classList.toggle("is-open", jobPillOpen && visible);
    if (visible && !jobPillOpen && !jobPillAnimating) cacheJobPillChipWidth(pill);
  }
  showPillOrb(Boolean((showAsr && generating && !waiting && !asrPaused) || showTr));
  updateTranslateLock();

  if (bar) {
    show(bar, showAsr);
    if (!showAsr && ui.asrSwitchNote) show(ui.asrSwitchNote, false);
    if (showAsr) {
      const pauseBtn = $("btnPauseAsr");
      if (pauseBtn) {
        pauseBtn.textContent = generating ? (asrPaused ? "继续" : "暂停") : "继续生成";
        pauseBtn.dataset.mode = generating ? "pause" : "resume";
        show(pauseBtn, generating || partial);
      }
      show($("btnCancelAsrJob"), generating || partial);
      showAsrSegOrb(false);
      if (ui.asrSwitchNote) {
        const on = Boolean(asrSwitchNote);
        ui.asrSwitchNote.textContent = asrSwitchNote;
        show(ui.asrSwitchNote, on);
      }
      if (ui.asrJobTitle) {
        const activeProvider = String(asrProgress?.provider || "").trim();
        ui.asrJobTitle.textContent = waiting
          ? `所有通道都在冷却，${coolLabel} 后继续`
          : asrPaused
            ? "已暂停"
            : generating
              ? (activeProvider ? `转写中 · ${activeProvider}` : "转写中")
              : "继续生成";
      }
      if (ui.asrSegPct) ui.asrSegPct.textContent = asrTotal ? `${asrShown}/${asrTotal}` : "";
      if (ui.asrJobFill) {
        const pct = asrTotal ? Math.max(0, Math.min(100, Math.round((asrShown / asrTotal) * 100))) : 0;
        ui.asrJobFill.style.width = `${pct}%`;
        ui.asrJobFill.style.background = asrPaused ? "#8A9099" : "";
        const track = $("asrJobTrack");
        if (track) {
          track.setAttribute("aria-valuenow", String(pct));
          track.setAttribute("aria-valuetext", asrTotal ? `${asrShown}/${asrTotal} 个分片已完成` : "正在准备转写");
        }
      }
      const chunks = chunkRows
        || synthesizeChunks(asrDone, asrTotal, asrCurrent, state?.duration, failed);
      const live = chunks.filter((c) => c.status === "fail" || c.status === "run" || c.status === "pause");
      const doneRows = chunks.filter((c) => c.status === "done" || c.status === "wait");
      renderChunkRows(ui.chunkLiveList, live);
      const queued = chunks.filter((c) => c.status === "wait").length;
      const doneN = chunks.filter((c) => c.status === "done").length;
      if (ui.btnChunkFold) {
        show(ui.btnChunkFold, doneRows.length > 0);
        ui.btnChunkFold.textContent = chunkListExpanded
          ? "收起 ▴"
          : `已完成 ${doneN} 片 · 排队 ${queued} 片 ▸`;
      }
      show(ui.chunkDoneList, chunkListExpanded);
      if (chunkListExpanded) renderChunkRows(ui.chunkDoneList, doneRows);
    }
  }

  if (trBar) {
    show(trBar, showTr);
    if (showTr) {
      if (ui.trJobTitle) ui.trJobTitle.textContent = "翻译中";
      if (ui.trSegPct) ui.trSegPct.textContent = trTotal ? `${trDone}/${trTotal}` : "";
    }
  }

  renderCueGhosts(generating && view === "captions");
}

function renderCueGhosts(on) {
  const host = ui.cueGhosts;
  if (!host) return;
  show(host, on);
  if (!on) {
    host.replaceChildren();
    return;
  }
  if (host.childElementCount) return;
  for (let i = 0; i < 3; i += 1) {
    const row = document.createElement("div");
    row.className = "cue-ghost";
    row.innerHTML = `<span class="cue-ghost-time"></span><span class="cue-ghost-bar"></span>`;
    host.appendChild(row);
  }
}

async function pauseAsr(paused) {
  try {
    await chrome.runtime.sendMessage({
      type: "PAUSE_ASR",
      paused: paused !== false,
      jobId: asrJobId,
      bvid: state?.bvid,
      cid: state?.cid,
      tabId: boundTabId || myTabId
    });
    asrPaused = paused !== false;
    renderAsrJobBar();
  } catch (error) {
    flash(error.message || "无法暂停");
  }
}

async function retryAsrChunk(index) {
  try {
    const result = await chrome.runtime.sendMessage({
      type: "RETRY_ASR_CHUNK",
      index,
      jobId: asrJobId,
      bvid: state?.bvid,
      cid: state?.cid,
      tabId: boundTabId || myTabId
    });
    if (result?.error) flash(result.error);
  } catch (error) {
    flash(error.message || "重试失败");
  }
}

function setAsrSwitchNote(text) {
  asrSwitchNote = String(text || "").replace(/（冷却结束自动切回）$/, "").trim();
  clearTimeout(asrSwitchNoteTimer);
  if (!asrSwitchNote) return;
  asrSwitchNoteTimer = setTimeout(() => {
    asrSwitchNote = "";
    renderAsrJobBar();
  }, 8000);
}

function applyAsrProgress(info) {
  if (!info || !sameAsrVideo(info)) return;
  const hadCues = Boolean(state?.cues?.length);
  const sameJob = !info.jobId || !asrProgress?.jobId || info.jobId === asrProgress.jobId;
  const prevDone = sameJob ? Number(asrProgress?.done) || 0 : 0;
  const prevTotal = sameJob ? Number(asrProgress?.total) || 0 : 0;
  const prevCurrent = sameJob ? Number(asrProgress?.current) || 0 : 0;
  // 后台的 done/chunks 都是从任务实况现算的，直接信任；本地再取 max 会把重开任务的旧计数残留下来
  asrProgress = {
    jobId: info.jobId || asrProgress?.jobId || "",
    done: info.done != null ? Number(info.done) || 0 : prevDone,
    total: info.total != null ? Number(info.total) || 0 : prevTotal,
    waitUntil: Number(info.waitUntil) || 0,
    message: info.message || asrProgress?.message || "",
    stage: info.stage || "",
    current: Number(info.current) > 0 ? Number(info.current) : prevCurrent,
    waitKind: info.stage === "wait" ? (info.waitKind || asrProgress?.waitKind || "") : "",
    canBoost: Boolean(info.canBoost),
    provider: info.provider || asrProgress?.provider || "",
    running: info.running !== false && info.stage !== "done",
    chunks: Array.isArray(info.chunks) ? info.chunks : asrProgress?.chunks,
    failed: Array.isArray(info.failed) ? info.failed : asrProgress?.failed || [],
    paused: info.paused != null ? Boolean(info.paused) : asrProgress?.paused
  };
  const noteMsg = String(info.message || "");
  if (/已切到/.test(noteMsg)) setAsrSwitchNote(noteMsg);
  if (info.paused != null) asrPaused = Boolean(info.paused);
  if (info.cues?.length) {
    const cues = applyRememberedTranslations(info.cues);
    const translated = translatedCueText.size > 0 || translatedCueRanges.length > 0 || info.source === "translated";
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
  if (info.cues?.length) {
    renderCues();
    renderCaptionLang();
  }
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

function stopTranslateWatch() {
  clearInterval(translateWatchTimer);
  translateWatchTimer = 0;
  translateMissingChecks = 0;
}

function startTranslateWatch() {
  if (translateWatchTimer) return;
  stopTranslateWatch();
  let checking = false;
  translateWatchTimer = setInterval(async () => {
    if (!translating || checking) {
      if (!translating) stopTranslateWatch();
      return;
    }
    checking = true;
    try {
      const status = await chrome.runtime.sendMessage({
        type: "GET_TRANSLATE_JOB",
        jobId: translateJobId,
        tabId: boundTabId || myTabId,
        bvid: state?.bvid,
        cid: state?.cid
      });
      if (status?.running) {
        translateMissingChecks = 0;
        if (status.stage !== "done") applyTranslateProgress(status);
        return;
      }
      translateMissingChecks += 1;
      if (translateMissingChecks < 2) return;
      stopTranslateWatch();
      translating = false;
      translateJobId = "";
      translateProgress = { done: 0, total: 0 };
      renderAsrJobBar();
      if (!state?.cues?.length) await refresh(true);
      flash("后台翻译已中断，已保留进度，可再点一次", 6000);
    } catch {
      // 下一轮再确认
    } finally {
      checking = false;
    }
  }, 20 * 1000);
}

function rememberCuesFromJob(cues) {
  if (!Array.isArray(cues)) return;
  resetTranslationsFor(state);
  for (const cue of cues) {
    if (cueHasCjk(cue.content)) rememberTranslatedCue(cue, cue.content, cue.original);
  }
}

function applyTranslateProgress(info) {
  if (!info || (state && !sameAsrVideo(info))) return;
  const running = info.running !== false && info.stage !== "done" && info.stage !== "canceled" && info.stage !== "error";
  translating = running;
  if (info.jobId) translateJobId = info.jobId;
  translateProgress = {
    done: Number(info.done) || 0,
    total: Number(info.total) || 0,
    stage: info.stage || ""
  };
  if (info.cues?.length) {
    rememberCuesFromJob(info.cues);
    state = {
      ...(state || {}),
      cues: hydrateCueOriginals(info.cues),
      source: "translated",
      activeLan: "translated"
    };
    renderCues();
    renderCaptionLang();
  }
  renderAsrJobBar();
}

async function attachRunningTranslate(next) {
  try {
    const status = await chrome.runtime.sendMessage({
      type: "GET_TRANSLATE_JOB",
      tabId: boundTabId || myTabId,
      bvid: next?.bvid || state?.bvid,
      cid: next?.cid || state?.cid
    });
    if (!status?.running) return false;
    translating = true;
    translateJobId = status.jobId || translateJobId;
    applyTranslateProgress(status);
    startTranslateWatch();
    return true;
  } catch {
    return false;
  }
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
    text.className = "cue-text";
    text.textContent = cueDisplayText(cues[i]);
    row.append(time, text);
    cueRowEls[i] = row;
    frag.append(row);
  }
  ui.cueList.replaceChildren(frag);
}

function patchCueTexts(cues) {
  if (!cues?.length) return;
  if (cueRowEls.length !== cues.length) {
    lastCuesSig = cuesSignature(cues);
    lastActiveIndex = -1;
    buildCueRows(cues);
    return;
  }
  for (let i = 0; i < cues.length; i += 1) {
    const row = cueRowEls[i];
    const text = row?.querySelector(".cue-text") || row?.children?.[1];
    const shown = cueDisplayText(cues[i]);
    if (text && text.textContent !== shown) text.textContent = shown;
  }
}

function renderCues() {
  const cues = state?.cues || [];
  const sig = cuesSignature(cues);
  const changed = sig !== lastCuesSig;
  if (changed) {
    lastCuesSig = sig;
    lastActiveIndex = -1;
    buildCueRows(cues);
  } else {
    patchCueTexts(cues);
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
  // 设计稿：有起点后才切到底部选区条，未定起点时保持行动条（按钮变「点起点…」）
  const selectOpen = onCaptions && !hasSummary && range.start >= 0;
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
  ui.btnSelect.textContent = selecting ? (start < 0 ? "点起点…" : "点终点…") : "划选";
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

function renderVideoSummary({ streaming = false } = {}) {
  const box = ui.videoSummary;
  const body = ui.videoSummaryBody;
  if (!box) return;
  const text = String(videoSummary || "").trim();
  const onOutline = view === "outline";
  const visible = onOutline && Boolean(text);
  show(box, visible);
  if (!visible) return;
  if (body) {
    if (body.textContent !== videoSummary) body.textContent = videoSummary;
    body.classList.toggle("is-streaming", Boolean(streaming || outlineLoading));
    show(body, videoSummaryOpen);
  }
  ui.videoSummaryChevron?.classList.toggle("is-collapsed", !videoSummaryOpen);
  ui.videoSummaryToggle?.setAttribute("aria-expanded", videoSummaryOpen ? "true" : "false");
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
  return outlineApi()?.formatOutlineCopy(videoSummary, outline) || (outline || []).map((ch) => (
    `${formatTime(ch.start)}–${formatTime(ch.end)} ${ch.title}\n${ch.synopsis}`
  )).join("\n\n");
}

function outlineMarkdown() {
  const title = state?.title || "大纲";
  return outlineApi()?.formatOutlineMarkdown(title, videoSummary, outline) || `# ${title}\n`;
}

async function loadOutlineCache(next) {
  const key = outlineKey(next);
  if (!key) {
    outline = null;
    videoSummary = "";
    return;
  }
  const data = await chrome.storage.local.get({ [key]: null });
  const rec = outlineApi()?.normalizeOutlineRecord(data[key]) || { summary: "", chapters: [] };
  const chapters = Array.isArray(rec.chapters) ? rec.chapters : [];
  const cues = next?.cues || [];
  const fixed = chapters.length
    ? (outlineApi()?.finalizeOutline(chapters, cues) || chapters)
    : [];
  outline = fixed.length ? fixed : null;
  videoSummary = rec.summary || "";
  videoSummaryOpen = true;
}

function outlineCues() {
  return state?.cues || [];
}

function normalizeChapter(item) {
  return outlineApi()?.normalizeChapter(item, outlineCues()) || {
    start: Number(item.start) || 0,
    end: Number(item.end) || 0,
    title: String(item.title || "").trim() || "未命名章节",
    synopsis: String(item.synopsis || item.summary || "").trim()
  };
}

function parseOutlineRecord(text) {
  const rec = outlineApi()?.parseOutlinePayload(text);
  if (!rec) throw new Error("大纲格式无法解析");
  return {
    summary: rec.summary || "",
    chapters: outlineApi()?.finalizeOutline(rec.chapters, outlineCues()) || (rec.chapters || []).map(normalizeChapter)
  };
}

function parseStreamingChapters(text) {
  return outlineApi()?.parseStreamingChapters(text, outlineCues()) || [];
}

function parseStreamingOutline(text) {
  return outlineApi()?.parseStreamingOutline(text, outlineCues()) || { summary: "", chapters: [] };
}

function paintOutlineStream() {
  if (view !== "outline") return;
  const hasSummary = Boolean(String(videoSummary || "").trim());
  const hasChapters = Boolean(outline?.length);
  if (!hasSummary && !hasChapters) return;
  show(ui.outlineEmpty, false);
  showOutlineEmptyOrb(false);
  show(ui.outlineHead, true);
  showOutlineThinking(true);
  if (ui.outlineHeadLabel) {
    const n = Math.max(1, outline?.length || 1);
    setShimmer(ui.outlineHeadLabel, true, hasChapters ? `正在生成大纲 · 第 ${n} 段` : "正在生成大纲");
  }
  renderVideoSummary({ streaming: true });
  show(ui.outlineList, hasChapters);
  show(ui.outlineBar, true);
  const copyBtn = $("btnCopyOutline");
  if (copyBtn) copyBtn.textContent = "停止生成";
  if (hasChapters && !outlineRaf) {
    outlineRaf = requestAnimationFrame(() => {
      outlineRaf = 0;
      if (view === "outline") renderOutline();
    });
  }
}

async function generateOutline() {
  if (!state?.cues?.length || outlineLoading) return;
  outlineAbort?.abort();
  outlineAbort = new AbortController();
  const ac = outlineAbort;
  outlineLoading = true;
  outline = null;
  videoSummary = "";
  videoSummaryOpen = true;
  lastOutlineIndex = -1;
  view = "outline";
  renderState(state);
  const startedOutlineKey = outlineKey(state);
  const cues = state.cues;
  const O = outlineApi();
  try {
    let summary = "";
    let chapters = [];
    const corpus = O?.cueCorpus?.(cues) || (cues || []).map((cue, i) => O?.formatCueLine?.(cue, i) || "").join("\n");
    const overBudget = corpus.length > (O?.SUMMARY_CUE_CHAR_BUDGET || 100000);

    if (overBudget) {
      const chunks = O?.chunkCueLines?.(cues) || [corpus];
      const partials = [];
      for (const chunk of chunks) {
        if (ac.signal.aborted) return;
        partials.push(await runModel(O.buildSummaryMapPrompt(chunk), { signal: ac.signal }));
      }
      if (ac.signal.aborted) return;
      summary = String(await runModel(O.buildSummaryReducePrompt(partials), { signal: ac.signal }) || "").trim();
      if (!summary) throw new Error("大纲结果结构校验失败");
      let lastPreview = "";
      const result = await runModel(O.buildChaptersPrompt(cues), {
        signal: ac.signal,
        validate(text) {
          try {
            return parseOutlineRecord(text).chapters.length > 0;
          } catch {
            return false;
          }
        },
        onDelta(full) {
          if (ac.signal.aborted || outlineKey(state) !== startedOutlineKey) return;
          const partial = parseStreamingChapters(full);
          const preview = JSON.stringify(partial);
          if (!partial.length || preview === lastPreview) return;
          lastPreview = preview;
          videoSummary = summary;
          outline = partial;
          paintOutlineStream();
        }
      });
      if (ac.signal.aborted) return;
      chapters = parseOutlineRecord(result).chapters;
    } else {
      let lastPreview = "";
      const result = await runModel(O?.buildOutlinePrompt(cues) || "", {
        signal: ac.signal,
        validate(text) {
          try {
            const rec = parseOutlineRecord(text);
            return Boolean(rec.summary) || rec.chapters.length > 0;
          } catch {
            return false;
          }
        },
        onDelta(full) {
          if (ac.signal.aborted || outlineKey(state) !== startedOutlineKey) return;
          const rec = parseStreamingOutline(full);
          const preview = `${rec.summary}\n${JSON.stringify(rec.chapters)}`;
          if (preview === lastPreview) return;
          if (!rec.summary && !rec.chapters.length) return;
          lastPreview = preview;
          if (rec.summary) videoSummary = rec.summary;
          if (rec.chapters.length) outline = rec.chapters;
          paintOutlineStream();
        }
      });
      if (ac.signal.aborted) return;
      const rec = parseOutlineRecord(result);
      summary = rec.summary;
      chapters = rec.chapters;
    }

    if (ac.signal.aborted) return;
    summary = String(summary || "").trim();
    if (!summary || !chapters.length) throw new Error("大纲结果结构校验失败");
    const key = startedOutlineKey;
    if (key) await chrome.storage.local.set({ [key]: { summary, chapters } });
    if (outlineKey(state) !== startedOutlineKey) return;
    videoSummary = summary;
    outline = chapters;
    flash("大纲已生成");
  } catch (error) {
    if (ac.signal.aborted || error?.name === "AbortError") return;
    if (outlineKey(state) !== startedOutlineKey) return;
    outline = null;
    videoSummary = "";
    flash(error.message || "生成大纲失败");
  } finally {
    if (outlineAbort === ac) {
      outlineLoading = false;
      showOutlineThinking(false);
      renderState(state);
    }
  }
}

function stopOutline() {
  outlineAbort?.abort();
  outlineLoading = false;
  if (!outline?.length && !String(videoSummary || "").trim()) {
    videoSummary = "";
  }
  showOutlineThinking(false);
  renderState(state);
}

function renderState(next) {
  resetTranslationsFor(next);
  if (next?.cues?.length && translatedCueText.size) {
    next = {
      ...next,
      cues: hydrateCueOriginals(applyRememberedTranslations(next.cues)),
      source: "translated",
      activeLan: "translated"
    };
  } else if (next?.cues?.length) {
    next = { ...next, cues: hydrateCueOriginals(next.cues) };
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
    if (outlineLoading) {
      outlineAbort?.abort();
      outlineAbort = null;
      outlineLoading = false;
    }
    outline = null;
    videoSummary = "";
    videoSummaryOpen = true;
    lastRenderKey = renderKey;
    loadOutlineCache(next).then(() => {
      if (outlineKey(state) === outlineKey(next)) renderState(state);
    });
    loadMarkers(next).then(() => {
      if (marksVideoKey(state) === marksVideoKey(next)) {
        if (view === "markers") renderMarkers();
        updateSummaryMarkerBtn();
      }
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
  const onVideoReady = !showLoginEmpty && !showNetLogin && !showGenError && !noScript;
  const isEmpty = onVideoReady && !hasCues && !generating && view !== "markers";
  const hasList = onVideoReady && (hasCues || generating);
  const onCaptions = hasList && view === "captions";
  const onOutline = hasList && view === "outline";
  const onMarkers = onVideoReady && view === "markers";

  show(ui.speedSelect, true);
  const extraTracks = (next.tracks || []).filter((item) => !trackLangKind(item));
  show(ui.controlRow, hasCues && extraTracks.length > 0);
  show(ui.viewTabs, hasList || onMarkers || generating || translating);

  ui.viewTabs.querySelectorAll("button[data-view]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
  syncCaptionLangFromState(next);
  renderCaptionLang();

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

  const fetchFailed = isEmpty && (
    next?.subtitleStatus === "fetch_failed"
    || String(next?.error || "") === "没拿到字幕列表"
  );
  if (ui.emptyTitle) {
    ui.emptyTitle.textContent = fetchFailed ? "没拿到字幕列表" : "这个视频没有字幕";
  }
  show(ui.emptyView, isEmpty);
  if (ui.emptyFetchHint) show(ui.emptyFetchHint, fetchFailed);
  if (isEmpty) show(ui.emptyKeyHint, !hasSttKey);
  else show(ui.emptyKeyHint, false);

  show(ui.generatingView, false);
  showGenerateThinking(false);
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
  const hasVideoSummary = Boolean(String(videoSummary || "").trim());
  const outlineContent = outlineRows || hasVideoSummary;
  const outlineBoot = onOutline && outlineLoading && !outlineContent;
  show(ui.outlineHead, onOutline && outlineLoading && outlineContent);
  if (ui.outlineHeadLabel && outlineLoading && outlineContent) {
    const n = Math.max(1, outline?.length || 1);
    setShimmer(ui.outlineHeadLabel, true, outlineRows ? `正在生成大纲 · 第 ${n} 段` : "正在生成大纲");
  } else if (ui.outlineHeadLabel) {
    setShimmer(ui.outlineHeadLabel, false);
  }
  showOutlineThinking(onOutline && outlineLoading && outlineContent);

  const outlineEmptyShown = onOutline && !outlineLoading && !outlineContent;
  show(ui.outlineEmpty, outlineEmptyShown || outlineBoot);
  if (outlineBoot) {
    setShimmer(ui.outlineEmptyLabel, true, "AI 正在阅读全文字幕…");
    show($("btnGenOutline"), false);
    showOutlineEmptyOrb(true);
  } else {
    showOutlineEmptyOrb(false);
    if (outlineEmptyShown) {
      setShimmer(ui.outlineEmptyLabel, false, "还没有生成大纲");
      show($("btnGenOutline"), true);
    } else {
      setShimmer(ui.outlineEmptyLabel, false);
    }
  }

  renderVideoSummary({ streaming: outlineLoading && hasVideoSummary });
  show(ui.outlineList, onOutline && outlineRows);
  if (onOutline && outlineRows) {
    renderOutline();
    lastOutlineIndex = -1;
    renderOutlineActive(next.currentTime || 0, { forceScroll: true });
  }

  show(ui.cueWrap || ui.cueList, onCaptions);
  show(ui.summaryBox, onCaptions && hasSummary);
  syncSelectChrome(onCaptions);
  // 流式期间底部条也在：第一个按钮变「停止生成」（设计稿 outlineActions）
  show(ui.outlineBar, onOutline && outlineContent);
  if (onOutline && outlineContent) {
    const copyBtn = $("btnCopyOutline");
    if (copyBtn) copyBtn.textContent = outlineLoading ? "停止生成" : "复制大纲";
  }
  show($("markerView"), onMarkers);
  show($("markerBar"), onMarkers);
  if (onMarkers) renderMarkers();
  else if (hasSummary) updateSummaryMarkerBtn();

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

function tabVideoChanged(tabUrl) {
  const bvid = extractBvidFromUrl(tabUrl || "");
  const epId = extractEpIdFromUrl(tabUrl || "");
  if (bvid && state?.bvid && bvid !== state.bvid) return true;
  if (epId && state?.epId && epId !== state.epId) return true;
  if (bvid && !state?.bvid && state?.page === "video") return true;
  return false;
}

function stopJobsForVideoSwitch() {
  translating = false;
  generating = false;
  asrProgress = null;
  translateProgress = { done: 0, total: 0 };
  stopTranslateWatch();
  stopAsrWatch();
  outlineAbort?.abort();
  outlineLoading = false;
}

async function refresh(force = false) {
  genError = "";
  try {
    const tab = await getActiveTab();
    if (tab?.id && !inFloatEmbed()) boundTabId = tab.id;
    const switched = tabVideoChanged(tab?.url || "");
    if ((outlineLoading || generating || translating) && !force && !switched) return;
    if (switched) stopJobsForVideoSwitch();
    if (!tab?.url?.includes("bilibili.com")) {
      renderState({ page: "other" });
      await refreshLoginOnly();
      return;
    }
    const next = await sendToTab({ type: force || switched ? "REFRESH" : "GET_STATE" }, tab.id);
    renderState(next);
    const asrOn = await attachRunningAsr(next);
    const trOn = await attachRunningTranslate(next);
    if (asrOn || trOn) renderState(state || next);
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

  const sttSettings = await BiliCaptionPrefs.loadSettings({
    groqApiKey: "",
    sttKey: "",
    sttProvider: "Groq",
    sttCreds: {},
    sttChannels: []
  });
  const P = globalThis.BiliCaptionProviders;
  const channels = P?.resolveChannels?.(sttSettings) || [];
  const usable = channels.filter((cfg) => P?.channelUsable?.(cfg));
  if (!usable.length) {
    flash("请先在设置里添加并配置好转写通道");
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
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // iframe 无焦点时走下面
    }
  }
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
  if (!ok) throw new Error("复制失败");
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
  const consume = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let json = null;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const piece = json?.choices?.[0]?.delta?.content
      || json?.choices?.[0]?.message?.content
      || "";
    if (piece) {
      full += piece;
      onDelta(full);
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    lines.forEach(consume);
  }
  buffer += decoder.decode();
  if (buffer.trim().startsWith("data:")) consume(buffer);
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

async function requestPromptModel(prompt, { base, key, model, onDelta, signal, validate }) {
  const route = globalThis.BiliCaptionModelRoute;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        stream: Boolean(onDelta),
        ...(route?.requestFields?.(model, "low") || {}),
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
      const error = new Error(chatErrorMessage(json, res.status));
      error.status = res.status;
      throw error;
    }

    let text = "";
    let responseModel = model;
    if (onDelta && res.body) {
      text = (await readChatStream(res, onDelta)).trim();
    } else {
      let json;
      try {
        json = await res.json();
      } catch {
        throw route?.markError?.(new Error("模型响应不是有效 JSON"), { invalidResponse: true }) || new Error("模型响应不是有效 JSON");
      }
      responseModel = json.model || model;
      text = json.choices?.[0]?.message?.content?.trim() || "";
    }
    if (!text || (validate && !validate(text))) {
      throw route?.markError?.(new Error("模型响应结构校验失败"), { invalidResponse: true }) || new Error("模型响应结构校验失败");
    }
    summaryModel = responseModel;
    return text;
  } catch (error) {
    if (error?.name === "AbortError") {
      if (signal?.aborted) throw error;
      throw route?.markError?.(new Error("请求超时，请稍后重试"), { status: 408 }) || error;
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    clearTimeout(timer);
  }
}

async function openaiPrompt(prompt, { onDelta, signal, validate } = {}) {
  const settings = await BiliCaptionPrefs.loadSettings({
    sumProvider: "OpenAI",
    apiBase: "",
    apiKey: "",
    apiModel: ""
  });
  const cfg = globalThis.BiliCaptionProviders.resolveSum(settings);
  if (!cfg.key) return null;
  if (!cfg.base) throw new Error("请先在设置里填写接口地址");
  const base = cfg.base;
  const model = defaultChatModel(base, cfg.model);
  await ensureApiOrigin(base);
  return requestPromptModel(prompt, {
    base,
    key: cfg.key,
    model,
    onDelta,
    signal,
    validate
  });
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
          ui.summaryText.classList.add("streaming");
        }
        setSummaryBody(full);
      }
    });
    ui.summaryText.classList.remove("streaming");
    showSummaryThinking(false);
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
  return window.BiliCaptionTranslate?.toSimplified?.(text)
    || window.BiliCaptionZh?.toSimplified?.(text)
    || String(text || "");
}

function needsTranslation(text) {
  return window.BiliCaptionTranslate?.needsTranslation?.(text) === true;
}

function clampTranslateConcurrency(value) {
  return window.BiliCaptionTranslate?.clampTranslateConcurrency?.(value) ?? 4;
}

function commitTranslatedCues(next) {
  state = {
    ...state,
    cues: next.map((cue) => ({ ...cue })),
    source: "translated",
    activeLan: "translated"
  };
  renderCues();
  sendToTab({
    type: "SYNC_CUES",
    cues: state.cues,
    source: "translated",
    activeLan: "translated",
    bvid: state.bvid || "",
    cid: Number(state.cid) || 0
  }).catch(() => {});
}

function updateTranslateLock() {
  const btn = $("btnTranslate");
  if (!btn) return;
  const lock = Boolean(generating);
  btn.disabled = lock;
  btn.title = lock ? "转写完成后再翻译，否则只会译到当前已有的句子" : "";
}

async function translateCues() {
  if (!state?.cues?.length || translating) return;
  if (generating) {
    flash("请等转写完成后再翻译");
    return;
  }
  setMoreOpen(false);

  const settings = await BiliCaptionPrefs.loadSettings({
    sumProvider: "OpenAI",
    apiBase: "",
    apiKey: ""
  });
  const cfg = globalThis.BiliCaptionProviders.resolveSum(settings);
  if (!cfg.key) {
    flash("请先在设置里配置总结服务和 API Key");
    openSettings();
    return;
  }
  if (!cfg.base) {
    flash("请先在设置里填写接口地址");
    openSettings();
    return;
  }
  await ensureApiOrigin(cfg.base);

  try {
    const started = await chrome.runtime.sendMessage({
      type: "START_TRANSLATE",
      tabId: boundTabId || myTabId,
      bvid: state.bvid,
      cid: state.cid,
      cues: state.cues
    });
    if (started?.error) {
      flash(started.error);
      return;
    }
    if (started?.empty) {
      if (started.cues?.length) commitTranslatedCues(started.cues);
      flash("已经是中文，不用翻译");
      return;
    }
    translating = true;
    translateJobId = started.jobId || "";
    translateProgress = {
      done: Number(started.done) || 0,
      total: Number(started.total) || 0,
      stage: started.stage || "run"
    };
    if (started.cues?.length) {
      rememberCuesFromJob(started.cues);
      state = {
        ...state,
        cues: started.cues,
        source: "translated",
        activeLan: "translated"
      };
      renderCues();
    }
    renderAsrJobBar();
    startTranslateWatch();
  } catch (error) {
    flash(error.message || "翻译启动失败");
  }
}

function cancelTranslate() {
  const jobId = translateJobId;
  translating = false;
  translateProgress = { done: 0, total: 0 };
  stopTranslateWatch();
  renderAsrJobBar();
  if (jobId || state?.bvid || state?.cid) {
    chrome.runtime.sendMessage({
      type: "CANCEL_TRANSLATE",
      jobId,
      bvid: state?.bvid,
      cid: state?.cid,
      tabId: boundTabId || myTabId
    }).catch(() => {});
  }
  translateJobId = "";
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
  const data = await BiliCaptionPrefs.loadSettings({
    groqApiKey: "",
    sttKey: "",
    sttProvider: "Groq",
    sttCreds: {},
    sttChannels: [],
    selKey: "Shift",
    overlayOn: true,
    captionLang: "zh",
    summaryPad: 10,
    translateConcurrency: 4
  });
  const P = globalThis.BiliCaptionProviders;
  const channels = P?.resolveChannels?.(data) || [];
  hasSttKey = channels.some((cfg) => P?.channelUsable?.(cfg));
  selKey = data.selKey || "Shift";
  overlayOn = data.overlayOn !== false;
  captionLang = data.captionLang === "en" ? "en" : "zh";
  summaryPad = Math.min(50, Math.max(0, Math.round(Number(data.summaryPad) || 10)));
  translateConcurrency = clampTranslateConcurrency(data.translateConcurrency);
  renderOverlayBtn();
  renderCaptionLang();
}

ui.btnSettings.addEventListener("click", openSettings);
ui.btnFloat?.addEventListener("click", () => {
  if (inFloatEmbed()) return;
  const tabId = boundTabId;
  // 必须在这次点击里关掉 Chrome 侧栏。消息绕一圈再 close 会丢掉用户手势，
  // enabled:false 也不会收掉已经打开的面板，于是浮窗和侧栏叠在一起。
  if (tabId && typeof chrome.sidePanel?.close === "function") {
    chrome.sidePanel.close({ tabId }).catch(() => {});
  }
  sendToTab({ type: "OPEN_FLOAT" }).catch(() => {});
  getActiveTab().then((tab) => {
    if (tab?.windowId) chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    if (tab?.id) chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  }).catch(() => {});
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
ui.captionLang?.addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-lang]");
  if (!btn) return;
  setCaptionLang(btn.dataset.lang).catch((error) => flash(error.message || "切换字幕失败"));
});

ui.btnGenerate.addEventListener("click", generateSubtitles);
ui.btnGenerateEmpty.addEventListener("click", generateSubtitles);
$("btnCancelGen").addEventListener("click", cancelGenerate);
$("btnCancelAsrJob")?.addEventListener("click", cancelGenerate);
$("btnCancelTrJob")?.addEventListener("click", cancelTranslate);
ui.jobPillHead?.addEventListener("click", (event) => {
  event.stopPropagation();
  if (jobPillAnimating) return;
  if (jobPillOpen) collapseJobPill();
  else expandJobPill();
});
$("btnPauseAsr")?.addEventListener("click", (event) => {
  event.stopPropagation();
  if ($("btnPauseAsr")?.dataset.mode === "resume") {
    generateSubtitles();
    return;
  }
  pauseAsr(!asrPaused);
});
ui.btnChunkFold?.addEventListener("click", (event) => {
  event.stopPropagation();
  chunkListExpanded = !chunkListExpanded;
  renderAsrJobBar();
});
$("btnStopOutline")?.addEventListener("click", stopOutline);
$("btnGenOutline").addEventListener("click", generateOutline);
$("btnRegenOutline").addEventListener("click", () => {
  outline = null;
  videoSummary = "";
  generateOutline();
});
$("btnCopyOutline").addEventListener("click", async () => {
  if (outlineLoading) {
    stopOutline();
    return;
  }
  if (!outline?.length && !String(videoSummary || "").trim()) return;
  await copyText(outlineText());
  flash("大纲已复制（含时间戳）");
});
$("btnOutlineMd").addEventListener("click", () => {
  if (!outline?.length && !String(videoSummary || "").trim()) return;
  const name = `${fileBase()}-outline.md`;
  downloadText(name, outlineMarkdown());
  flash(`已保存 ${name}`);
});
ui.videoSummaryToggle?.addEventListener("click", () => {
  videoSummaryOpen = !videoSummaryOpen;
  renderVideoSummary({ streaming: outlineLoading });
});
$("emptyRetryLink")?.addEventListener("click", () => refresh(true));

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
    await copyText(cues.map((item) => cueDisplayText(item)).join("\n"));
    markCopied($("btnCopy"), true);
  } catch {
    markCopied($("btnCopy"), false);
  }
});
function closeSummary() {
  hasSummary = false;
  showSummaryThinking(false);
  ui.summaryBox?.classList.remove("is-beam");
  ui.summaryText?.classList.remove("streaming");
  endSummaryEdit(true);
  show(ui.summaryBox, false);
  paintSelection();
}

/** 双击总结正文进入编辑，失焦后保留文本（不重新请求） */
function startSummaryEdit() {
  const edit = $("summaryEdit");
  if (!edit || !hasSummary) return;
  if (!edit.classList.contains("hidden")) return;
  edit.value = ui.summaryText.innerText || ui.summaryText.textContent || "";
  show(ui.summaryText, false);
  show(edit, true);
  autoGrowSummaryEdit(edit);
  requestAnimationFrame(() => {
    edit.focus();
    const end = edit.value.length;
    edit.setSelectionRange(end, end);
  });
}

function endSummaryEdit(silent = false) {
  const edit = $("summaryEdit");
  if (!edit || edit.classList.contains("hidden")) return;
  const text = edit.value.trim();
  show(edit, false);
  show(ui.summaryText, true);
  if (!silent && text) setSummaryBody(text);
}

function autoGrowSummaryEdit(edit) {
  edit.style.height = "auto";
  edit.style.height = `${edit.scrollHeight}px`;
}

$("btnSummary").addEventListener("click", summarizeSelection);
$("btnCloseSummary").addEventListener("click", closeSummary);
ui.summaryText.addEventListener("dblclick", startSummaryEdit);
$("summaryEdit")?.addEventListener("input", (event) => autoGrowSummaryEdit(event.target));
$("summaryEdit")?.addEventListener("blur", () => endSummaryEdit(false));
$("summaryEdit")?.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    endSummaryEdit(true);
  }
});
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
$("btnAddMarkerSummary")?.addEventListener("click", addMarkerFromSummary);
$("btnAddMarker")?.addEventListener("click", addManualMarker);
$("btnAddMarkerEmpty")?.addEventListener("click", addManualMarker);
$("btnMarkNow")?.addEventListener("click", addManualMarker);
$("btnLibrary")?.addEventListener("click", openLibrary);
$("btnLibraryEmpty")?.addEventListener("click", openLibrary);
$("btnMarkerMore")?.addEventListener("click", (event) => {
  event.stopPropagation();
  setMarkerMoreOpen(!markerMoreOpen);
});
$("btnCopyMarkers")?.addEventListener("click", () => {
  setMarkerMoreOpen(false);
  copyMarkers();
});
$("btnMarkerMd")?.addEventListener("click", () => {
  setMarkerMoreOpen(false);
  exportMarkers("md");
});
$("btnMarkerCsv")?.addEventListener("click", () => {
  setMarkerMoreOpen(false);
  exportMarkers("csv");
});

ui.btnMore.addEventListener("click", (event) => {
  event.stopPropagation();
  setMoreOpen(!moreOpen);
});
document.addEventListener("click", () => {
  if (moreOpen) setMoreOpen(false);
  if (markerMoreOpen) setMarkerMoreOpen(false);
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
  downloadText(name, state.cues.map((item) => cueDisplayText(item)).join("\n"));
  flash(`已保存 ${name}`);
  setMoreOpen(false);
});
$("btnTranslate").addEventListener("click", translateCues);
$("btnClearCache")?.addEventListener("click", async () => {
  setMoreOpen(false);
  const bvid = state?.bvid || "";
  const cid = Number(state?.cid) || 0;
  if (!bvid && !cid) {
    flash("当前没有视频");
    return;
  }
  let cleared;
  try {
    cleared = await chrome.runtime.sendMessage({ type: "CLEAR_VIDEO_CACHE", bvid, cid });
  } catch (error) {
    flash(error.message || "清理缓存失败");
    return;
  }
  if (!cleared?.ok) {
    flash(cleared?.error || "清理缓存失败");
    return;
  }
  generating = false;
  translating = false;
  asrJobId = "";
  translateJobId = "";
  asrProgress = null;
  translateProgress = { done: 0, total: 0 };
  stopAsrWatch();
  stopTranslateWatch();
  translatedCueText = new Map();
  translatedCueRanges = [];
  translatedCueVideoKey = translationVideoKey(state);
  outline = null;
  lastRenderKey = "";
  await refresh(true).catch(() => renderState({ page: "video" }));
  if (state?.cues?.length && state.source === "bilibili") {
    flash("已清理转写、翻译和大纲缓存，已重新加载官方字幕");
  } else {
    flash("已清理本视频的转写、翻译和大纲缓存");
  }
});

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
  if (message?.type === "DAV_SYNCED") {
    loadMarkers(state).then(() => {
      if (view === "markers") renderMarkers();
    }).catch(() => {});
    return;
  }
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
    if (message.currentTime != null) {
      highlight(message.currentTime || 0);
      if (view === "markers" || view === "captions") renderMarkerBar();
    }
    if (message.rate != null) renderSpeed(message.rate);
  }
  if (message?.type === "ASR_PROGRESS") {
    if (message.tabId && boundTabId && message.tabId !== boundTabId && !inFloatEmbed()) {
      if (!(message.bvid && state?.bvid && message.bvid === state.bvid)) return;
    }
    if (state?.bvid && !sameAsrVideo(message)) return;
    if (message.jobId) asrJobId = message.jobId;
    if (message.stage === "error" || message.stage === "canceled") {
      generating = false;
      asrProgress = null;
      asrJobId = "";
      asrSwitchNote = "";
      clearTimeout(asrSwitchNoteTimer);
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
      asrSwitchNote = "";
      clearTimeout(asrSwitchNoteTimer);
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
  if (message?.type === "TRANSLATE_PROGRESS") {
    if (message.tabId && boundTabId && message.tabId !== boundTabId && !inFloatEmbed()) return;
    if (state?.bvid && !sameAsrVideo(message)) return;
    if (message.jobId) translateJobId = message.jobId;
    if (message.stage === "error" || message.stage === "canceled" || message.stage === "done") {
      translating = false;
      translateJobId = "";
      translateProgress = { done: 0, total: 0 };
      stopTranslateWatch();
      applyTranslateProgress({ ...message, running: false });
      translating = false;
      renderAsrJobBar();
      if (message.stage === "error") flash(message.message || "翻译失败", 6000);
      else if (message.stage === "done") flash(message.message || "翻译完成");
      return;
    }
    translating = true;
    applyTranslateProgress(message);
    startTranslateWatch();
  }
  if (message?.type === "STATE" && message.payload) {
    const incoming = message.payload;
    const switched = Boolean(
      (incoming.bvid && state?.bvid && incoming.bvid !== state.bvid)
      || (incoming.bvid && incoming.bvid === state?.bvid && incoming.cid && state?.cid
        && Number(incoming.cid) !== Number(state.cid))
    );
    if (switched) stopJobsForVideoSwitch();
    else if (outlineLoading) return;
    else if (translating) {
      // 页面缓存仍是断句前的英文字幕。翻译进度自己带 cues，
      // 这里若再套上去，滑动列表时会把已译中文整表打回英文。
      return;
    }
    if (generating && !switched) {
      if (incoming.cues?.length && sameAsrVideo(incoming)) {
        const cues = applyRememberedTranslations(incoming.cues);
        const translated = translatedCueText.size > 0;
        state = {
          ...state,
          ...incoming,
          cues,
          source: translated ? "translated" : incoming.source,
          activeLan: translated ? "translated" : incoming.activeLan
        };
        renderCues();
        renderAsrJobBar();
      }
      return;
    }
    renderState(incoming);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") {
    if (changes.groqApiKey || changes.sttKey || changes.sttCreds) {
      loadPrefs().catch(() => {});
    }
  }
  if (area !== "sync") return;
  if (changes.sttProvider) loadPrefs().catch(() => {});
  if (changes.selKey) selKey = changes.selKey.newValue || "Shift";
  if (changes.overlayOn) {
    overlayOn = changes.overlayOn.newValue !== false;
    renderOverlayBtn();
  }
  if (changes.captionLang) {
    const next = changes.captionLang.newValue === "en" ? "en" : "zh";
    if (next !== captionLang) {
      captionLang = next;
      lastCuesSig = "";
      renderCaptionLang();
      renderCues();
    }
  }
  if (changes.summaryPad) {
    summaryPad = Math.min(50, Math.max(0, Math.round(Number(changes.summaryPad.newValue) || 10)));
  }
  if (changes.translateConcurrency) {
    translateConcurrency = clampTranslateConcurrency(changes.translateConcurrency.newValue);
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
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (tabId !== boundTabId) return;
    if (info.status === "complete" || info.url) {
      refresh(Boolean(info.url) || tabVideoChanged(info.url || tab?.url || ""));
    }
  });
  setInterval(() => {
    if (!boundTabId || inFloatEmbed()) return;
    chrome.tabs.get(boundTabId).then((tab) => {
      if (tabVideoChanged(tab?.url || "")) refresh(true);
    }).catch(() => {});
  }, 1500);
}

chrome.storage.local.get({ lastVideo: null }).then((data) => {
  lastVideo = data.lastVideo;
  renderLastVideoHint();
});

loadPrefs().then(() => {
  if (state) renderState(state);
});
bindFloatTab().then(async () => {
  if (!inFloatEmbed()) {
    await sendToTab({ type: "CLOSE_FLOAT" }).catch(() => {});
  }
  await refresh(false);
});
window.addEventListener("keydown", onSidepanelHotkey, true);
window.addEventListener("keyup", onSelKeyUp, true);
window.addEventListener("blur", onSelKeyUp);

async function bindFloatTab() {
  if (!inFloatEmbed()) return;
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id) {
      myTabId = tab.id;
      boundTabId = tab.id;
      return;
    }
  } catch {
    // ignore
  }
  try {
    const me = await chrome.runtime.sendMessage({ type: "WHOAMI" });
    myTabId = Number(me?.tabId) || 0;
    boundTabId = myTabId;
  } catch {
    // ignore
  }
}
