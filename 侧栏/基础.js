// 侧栏 · 基础：界面元素表、全部状态变量和通用小工具。
// 侧栏由 sidepanel.html 的多个 script 标签按顺序加载，共享同一个全局作用域。
// 侧栏/ 下的文件只做声明（本文件开头给浮窗 iframe 打标记、查界面元素除外）；事件绑定和启动代码都在 sidepanel.js。

const GEN_STEPS = ["拉取音频流", "分段语音识别", "对齐时间轴"];
if (window.top !== window || /(?:^|[?&])embed=1(?:&|$)/.test(location.search)) {
  document.documentElement.classList.add("float-embed");
}

const $ = (id) => document.getElementById(id);
// 与后台、内容脚本共用的小工具（lib/字幕工具.js）
const { cueHasCjk, cueOverlap, formatClock, isTypingTarget, keyLabel, matchesKey } = BiliCaptionCueTools;

const ui = {
  btnSettings: $("btnSettings"),
  btnFloat: $("btnFloat"),
  header: document.querySelector(".header"),
  siteIconB: $("siteIconB"),
  siteIconY: $("siteIconY"),
  siteIconX: $("siteIconX"),
  loginDot: $("loginDot"),
  loginLabel: $("loginLabel"),
  headerTitle: $("headerTitle"),
  noVideoView: $("noVideoView"),
  noVideoTitle: $("noVideoTitle"),
  lastVideoHint: $("lastVideoHint"),
  videoView: $("videoView"),
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
  outlineMeta: $("outlineMeta"),
  outlineMetaLabel: $("outlineMetaLabel"),
  outlineDensity: $("outlineDensity"),
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
  selKeyHint: $("selKeyHint"),
  selectTrail: $("selectTrail"),
  selectBar: $("selectBar"),
  selectInfo: $("selectInfo"),
  btnLoopSel: $("btnLoopSel"),
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
let pendingShownAt = 0;
let pendingUiTimer = 0;
let lastVideo = null;
let lastLogin = null;
let generating = false;
let generateToken = 0;
let genError = "";
let selecting = false;
let selectHeld = false;
let loopSel = false;
let lastLoopSent = "";
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
let cueEdit = null;
let cueEditToken = 0;
let lastOutlineIndex = -1;
let outlineSeekToken = 0;
let userOutlineScrollAt = 0;
let cueScrollRaf = 0;
let cueScrollAnim = null;
let userCueScrollAt = 0;
let moreOpen = false;
let toastTimer = 0;
let summaryAbort = null;
let hasSummary = false;
let summaryMarkTime = NaN;
let lastRenderKey = "";
let overlayOn = true;
let captionLang = "zh";
let captionLangPinned = false;
let summaryPad = 10;
let view = "captions";
let markers = [];
let markerKey = "";
let editingMarkerId = null;
let markerDrafts = new Map();
let polishingIds = new Set();
let polishAbort = new Map();
let polishDrafts = new Map();
let markerMoreOpen = false;
let outline = null;
let videoSummary = "";
let videoSummaryOpen = true;
let outlineDensity = "brief";
let chOpen = {};
let outlineLoading = false;
let outlineRaf = 0;
let errorMode = "";
let retrying = false;
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
let translateSnapshotPending = false;
let translateSeekAt = 0;
let translateSeekTimer = 0;
let lastPlaybackTime = NaN;
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

function flash(msg, duration = 1600) {
  ui.toast.textContent = msg;
  ui.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.add("hidden"), duration);
}

function inFloatEmbed() {
  return document.documentElement.classList.contains("float-embed");
}

function show(el, on) {
  el.classList.toggle("hidden", !on);
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

function fileBase() {
  return `${safeName(state?.bvid || state?.title)}${state?.part ? "-" + safeName(state.part) : ""}`;
}
