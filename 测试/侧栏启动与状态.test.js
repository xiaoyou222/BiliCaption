const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { pageScripts, runFile } = require("./源码加载.js");

// 侧栏按 sidepanel.html 的 script 顺序加载，DOM 用最小桩；chrome API 按测试需要应答。
function fakeElement(id = "") {
  const classes = new Set();
  const listeners = {};
  const el = {
    id,
    dataset: {},
    style: {},
    attributes: {},
    textContent: "",
    value: "",
    children: [],
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle(name, on) {
        const next = on === undefined ? !classes.has(name) : Boolean(on);
        if (next) classes.add(name);
        else classes.delete(name);
        return next;
      },
      contains: (name) => classes.has(name)
    },
    listeners,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    setAttribute(key, value) { el.attributes[key] = String(value); },
    getAttribute: (key) => el.attributes[key] ?? null,
    removeAttribute(key) { delete el.attributes[key]; },
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    contains: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    appendChild(child) { el.children.push(child); return child; },
    append(...items) { el.children.push(...items); },
    replaceChildren(...items) { el.children = items; },
    removeChild() {},
    remove() {},
    focus() {},
    scrollTo() {},
    // 划选轨迹画在 canvas 上：给个什么都不做的 2D 上下文
    getContext: () => new Proxy({}, { get: () => () => {} }),
    offsetTop: 0,
    offsetHeight: 20,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 400
  };
  return el;
}

const TAB = { id: 7, windowId: 1, url: "https://www.youtube.com/watch?v=aircAruvnKk", status: "complete" };
const IDENT = { bvid: "yt_aircAruvnKk", cid: 1 };
const ENGLISH = [
  { from: 0, to: 2, content: "one" },
  { from: 2, to: 4, content: "two" },
  { from: 4, to: 6, content: "three" }
];

/**
 * onTabMessage(tabId, message, reg) 返回页面对某条消息的应答（可以抛错）；
 * onRuntimeMessage(message) 返回后台的应答。
 */
function loadPanel({ onTabMessage, onRuntimeMessage, tabs = { 7: TAB }, activeTab = TAB } = {}) {
  const elements = new Map();
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, fakeElement(id));
    return elements.get(id);
  };
  const reg = {};
  const event = (name) => ({ addListener(fn) { (reg[name] ||= []).push(fn); }, removeListener() {} });
  const sentToTab = [];
  const ports = [];
  const store = () => ({
    async get(defaults) { return typeof defaults === "object" && defaults ? { ...defaults } : {}; },
    async set() {},
    async remove() {}
  });
  const env = { tabs, activeTab };
  const chrome = {
    runtime: {
      id: "x",
      lastError: null,
      onMessage: event("onMessage"),
      onConnect: event("onConnect"),
      getURL: (file) => file,
      openOptionsPage() {},
      async sendMessage(message) {
        return (onRuntimeMessage && onRuntimeMessage(message)) || {};
      }
    },
    tabs: {
      async query() { return env.activeTab ? [env.activeTab] : []; },
      async get(id) {
        if (env.tabs[id]) return env.tabs[id];
        throw new Error(`No tab with id: ${id}`);
      },
      onActivated: event("onActivated"),
      onUpdated: event("onUpdated"),
      async getCurrent() { return null; },
      connect(tabId) {
        const port = { tabId, disconnected: false, onMessage: event("portMessage"), onDisconnect: event("portDisconnect") };
        port.disconnect = () => { port.disconnected = true; };
        ports.push(port);
        return port;
      },
      async sendMessage(tabId, message) {
        sentToTab.push({ tabId, type: message.type });
        return onTabMessage ? onTabMessage(tabId, message, reg) : {};
      }
    },
    windows: { async getCurrent() { return { id: 1 }; }, async update() {} },
    sidePanel: { async close() {} },
    scripting: { async executeScript() { return []; } },
    storage: { local: store(), sync: store(), session: store(), onChanged: event("storageChanged") }
  };
  const document = {
    documentElement: fakeElement("html"),
    body: fakeElement("body"),
    getElementById: byId,
    querySelector: (selector) => byId(`q:${selector}`),
    querySelectorAll: () => [],
    createElement: (tag) => fakeElement(tag),
    createDocumentFragment: () => fakeElement("fragment"),
    addEventListener() {},
    removeEventListener() {},
    elementsFromPoint: () => [],
    execCommand: () => true
  };
  const context = {
    console: { log() {}, warn() {}, error() {} },
    URL, URLSearchParams, AbortController, AbortSignal, Blob, TextEncoder, TextDecoder,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    performance,
    fetch: async () => { throw new Error("不联网"); },
    location: { search: "", href: "chrome-extension://x/sidepanel.html" },
    navigator: {},
    document,
    chrome,
    addEventListener() {},
    removeEventListener() {},
    innerHeight: 800,
    devicePixelRatio: 1,
    getComputedStyle: () => ({})
  };
  context.window = context;
  context.self = context;
  context.top = context;
  context.parent = context;
  vm.createContext(context);
  for (const file of pageScripts("sidepanel.html")) runFile(context, file);
  const run = (code) => vm.runInContext(code, context);
  return { context, run, byId, reg, sentToTab, ports, env };
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

function videoState(extra = {}) {
  return { page: "video", platform: "youtube", ...IDENT, title: "视频标题", cues: ENGLISH, tracks: [], rate: 1, ...extra };
}

test("侧栏启动途中收到翻译进度广播：照样读页面状态，不会卡在「不是视频页」", async () => {
  const panel = loadPanel({
    onRuntimeMessage: (message) => {
      if (message.type === "GET_TRANSLATE_JOB") {
        return {
          running: true, jobId: "j1", tabId: 7, ...IDENT, stage: "run", done: 1, total: 3, cueCount: 3,
          cues: [{ ...ENGLISH[0], content: "一", original: "one" }, ENGLISH[1], ENGLISH[2]]
        };
      }
      if (message.type === "GET_ASR_JOB") return { running: false };
      return {};
    },
    onTabMessage: (_tabId, message, reg) => {
      if (message.type === "CLOSE_FLOAT") {
        // 侧栏还没拿到页面状态时，后台广播了一条运行中的翻译补丁
        for (const fn of reg.onMessage || []) {
          fn({ type: "TRANSLATE_PROGRESS", tabId: 7, jobId: "j1", ...IDENT, stage: "run", running: true, done: 2, total: 3, cueCount: 3, patch: [[1, "二", "two"]] }, {});
        }
        return { ok: true };
      }
      if (message.type === "GET_STATE" || message.type === "REFRESH") return videoState();
      return {};
    }
  });
  await tick(300);
  const types = panel.sentToTab.map((item) => item.type);
  assert.ok(types.includes("GET_STATE") || types.includes("REFRESH"), `发给页面的消息：${types.join(", ")}`);
  const view = panel.run("({ page: state?.page, title: state?.title, translating })");
  assert.equal(view.page, "video");
  assert.equal(view.title, "视频标题");
  assert.equal(view.translating, true, "之后由 refresh 接上进行中的翻译");
  assert.equal(panel.byId("noVideoView").classList.contains("hidden"), true);
});

test("切到读不到内容脚本的标签页：断开旧标签页的播放进度连接", async () => {
  const panel = loadPanel({
    onRuntimeMessage: (message) => (message.type === "GET_TRANSLATE_JOB" || message.type === "GET_ASR_JOB" ? { running: false } : {}),
    onTabMessage: (tabId, message) => {
      if (tabId === 8) throw new Error("Frame with ID 0 was removed.");
      if (message.type === "GET_STATE" || message.type === "REFRESH") return videoState();
      return {};
    }
  });
  await tick(200);
  const first = panel.ports.find((port) => port.tabId === 7);
  assert.ok(first && !first.disconnected, "启动后连上了标签页 7 的播放进度");
  // 原标签页关了，当前活动的是标签页 8，但它的页面脚本应答不了
  const other = { id: 8, windowId: 1, url: "https://www.youtube.com/watch?v=bbbbbbbbbbb", status: "complete" };
  panel.env.tabs = { 8: other };
  panel.env.activeTab = other;
  await panel.run("refresh()");
  assert.equal(panel.run("state?.page"), "no-script");
  assert.equal(first.disconnected, true, "旧标签页的进度连接已断开");
  assert.equal(panel.ports.some((port) => !port.disconnected), false);
});

test("开始改字时行数对不上要重建列表：重建后当前播放句的高亮照样在", async () => {
  const panel = loadPanel({
    onRuntimeMessage: (message) => (message.type === "GET_TRANSLATE_JOB" || message.type === "GET_ASR_JOB" ? { running: false } : {}),
    onTabMessage: (_tabId, message) => (message.type === "GET_STATE" || message.type === "REFRESH" ? videoState({ currentTime: 2.5 }) : {})
  });
  await tick(200);
  panel.run("highlight(2.5)");
  assert.equal(panel.run("cueRowEls[1]?.classList.contains('active')"), true, "列表建好后第 2 句高亮");
  // 字幕换成了 4 行（重新断句等），列表还没重画
  panel.run(`state = { ...state, currentTime: 2.5, cues: [
    { from: 0, to: 1, content: "a" }, { from: 1, to: 2, content: "b" },
    { from: 2, to: 3, content: "c" }, { from: 3, to: 6, content: "d" }
  ] }`);
  panel.run("startCueEdit(0)");
  assert.equal(panel.run("cueRowEls.length"), 4);
  assert.equal(panel.run("cueRowEls[2].classList.contains('active')"), true, "重建后 2.5 秒所在的第 3 句高亮");
});

test("字幕行数变少后旧选区越界：重画选区不抛错，并清掉选区", async () => {
  const panel = loadPanel({
    onRuntimeMessage: (message) => (message.type === "GET_TRANSLATE_JOB" || message.type === "GET_ASR_JOB" ? { running: false } : {}),
    onTabMessage: (_tabId, message) => (message.type === "GET_STATE" || message.type === "REFRESH" ? videoState() : {})
  });
  await tick(200);
  for (const pick of ["{ start: 5, end: -1 }", "{ start: 1, end: 6 }"]) {
    panel.run(`range = ${pick}; selecting = true;`);
    assert.doesNotThrow(() => panel.run("paintSelection()"), pick);
    assert.deepEqual(JSON.parse(panel.run("JSON.stringify(range)")), { start: -1, end: -1 }, pick);
    panel.run("selecting = false;");
  }
});

test("转写只剩失败段在等重试：胶囊显示失败态、点阵球停下，点胶囊重试全部失败段", async () => {
  const sent = [];
  const panel = loadPanel({
    onRuntimeMessage: (message) => {
      sent.push(message);
      if (message.type === "RETRY_ASR_CHUNK") return { ok: true };
      return {};
    }
  });
  await tick();
  const failRows = [
    { i: 1, start: 0, end: 90, status: "fail" },
    { i: 2, start: 87, end: 567, status: "fail" }
  ];
  const summary = panel.run(`asrFailSummary(${JSON.stringify(failRows)})`);
  assert.equal(summary.stalled, true);
  assert.equal(summary.label, "转写失败 · 重试");

  // 部分成功部分失败
  const mixed = panel.run(`asrFailSummary(${JSON.stringify([
    { i: 1, status: "done" }, { i: 2, status: "fail" }, { i: 3, status: "done" }
  ])})`);
  assert.equal(mixed.label, "2/3 · 1 段失败");
  assert.equal(mixed.stalled, true);
  // 还有段在转：不算卡住
  const busy = panel.run(`asrFailSummary(${JSON.stringify([{ i: 1, status: "fail" }, { i: 2, status: "run" }])})`);
  assert.equal(busy.stalled, false);
  assert.equal(panel.run(`asrFailSummary([{ i: 1, status: "done" }])`).label, "");

  panel.run(`
    state = { ...(state || {}), bvid: "BV1TYN76GEBP", cid: 39819807045, duration: 1041 };
    generating = true;
    asrPaused = false;
    asrProgress = { jobId: "j", done: 0, total: 2, waitUntil: 0, failed: [1, 2], chunks: ${JSON.stringify(failRows)} };
    renderAsrJobBar();
  `);
  const pill = panel.byId("jobPill");
  assert.equal(panel.byId("jobPillLabel").textContent, "转写失败 · 重试");
  assert.equal(pill.classList.contains("is-fail"), true);
  assert.equal(panel.byId("jobPillOrb").children.length, 0, "点阵球不再转");
  assert.equal(panel.byId("btnPauseAsr").dataset.mode, "retry");

  const head = panel.byId("jobPillHead");
  for (const fn of head.listeners.click || []) fn({ stopPropagation() {}, target: head });
  await tick();
  const retries = sent.filter((message) => message.type === "RETRY_ASR_CHUNK").map((message) => message.index);
  assert.deepEqual(retries, [1, 2]);

  // 重试后有段在跑：恢复正常计数和点阵球
  panel.run(`
    asrProgress = { ...asrProgress, failed: [], chunks: [{ i: 1, status: "run" }, { i: 2, status: "wait" }] };
    renderAsrJobBar();
  `);
  assert.equal(panel.byId("jobPillLabel").textContent, "转写 0/2");
  assert.equal(pill.classList.contains("is-fail"), false);
});
