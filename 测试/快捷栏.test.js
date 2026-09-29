const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { pageScripts, runFile } = require("./源码加载.js");

// 侧栏按 sidepanel.html 的 script 顺序加载。DOM 桩记父子关系（insertBefore / appendChild 会挪动节点），
// chrome.storage 真实存取，这样能看到按钮到底被摆在快捷栏还是「更多」菜单里、配置有没有存下来。
function fakeElement(id = "", tag = "div") {
  const classes = new Set();
  const listeners = {};
  const detach = (child) => {
    const parent = child.parentNode;
    if (!parent) return;
    parent.children = parent.children.filter((item) => item !== child);
    child.parentNode = null;
  };
  const el = {
    id,
    tagName: tag.toUpperCase(),
    dataset: {},
    style: {},
    attributes: {},
    textContent: "",
    value: "",
    disabled: false,
    children: [],
    parentNode: null,
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
    get className() { return [...classes].join(" "); },
    set className(value) {
      classes.clear();
      String(value).split(/\s+/).filter(Boolean).forEach((name) => classes.add(name));
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
    appendChild(child) {
      detach(child);
      el.children.push(child);
      child.parentNode = el;
      return child;
    },
    insertBefore(child, ref) {
      detach(child);
      const at = el.children.indexOf(ref);
      if (at < 0) el.children.push(child);
      else el.children.splice(at, 0, child);
      child.parentNode = el;
      return child;
    },
    append(...items) { for (const item of items) typeof item === "object" ? el.appendChild(item) : el.children.push(item); },
    replaceChildren(...items) {
      for (const child of el.children) if (child && typeof child === "object") child.parentNode = null;
      el.children = [];
      el.append(...items);
    },
    removeChild(child) { detach(child); },
    remove() { detach(el); },
    focus() {},
    scrollTo() {},
    getContext: () => new Proxy({}, { get: () => () => {} }),
    offsetTop: 0,
    offsetHeight: 20,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 400
  };
  return el;
}

function storageArea(store) {
  return {
    async get(keys) {
      if (keys == null) return { ...store };
      if (typeof keys === "string") return keys in store ? { [keys]: store[keys] } : {};
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in store).map((key) => [key, store[key]]));
      const out = { ...keys };
      for (const key of Object.keys(keys)) if (key in store) out[key] = store[key];
      return out;
    },
    async set(values) { Object.assign(store, JSON.parse(JSON.stringify(values || {}))); },
    async remove(keys) { for (const key of [].concat(keys)) delete store[key]; }
  };
}

const ACTION_BUTTONS = {
  sel: "btnSelect",
  mark: "btnMarkNow",
  overlay: "btnOverlay",
  gen: "btnGenerate",
  srt: "btnSrt",
  txt: "btnTxt",
  tr: "btnTranslate",
  clear: "btnClearCache"
};
const ALL_IDS = Object.keys(ACTION_BUTTONS);

function loadPanel({ sync = {} } = {}) {
  const elements = new Map();
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, fakeElement(id, "button"));
    return elements.get(id);
  };
  // 按 sidepanel.html 搭出底部操作栏和「更多」菜单的初始结构
  const bar = byId("actionBar");
  for (const id of ["btnSelect", "btnMarkNow", "btnOverlay", "btnChat", "moreWrap"]) bar.appendChild(byId(id));
  byId("moreWrap").appendChild(byId("btnMore"));
  byId("moreWrap").appendChild(byId("moreMenu"));
  byId("moreMenu").appendChild(byId("moreNormal"));
  byId("moreMenu").appendChild(byId("quickCustom"));
  for (const id of ["btnGenerate", "btnSrt", "btnTxt", "btnTranslate", "btnClearCache"]) byId("moreActions").appendChild(byId(id));
  byId("moreNormal").appendChild(byId("moreActions"));
  byId("moreNormal").appendChild(byId("btnQuickCustomize"));
  byId("quickCustom").appendChild(byId("quickPinCount"));
  byId("quickCustom").appendChild(byId("quickPinRows"));
  byId("quickCustom").appendChild(byId("quickFoot"));
  byId("quickFoot").appendChild(byId("btnQuickReset"));
  byId("quickFoot").appendChild(byId("btnQuickDone"));
  byId("moreMenu").classList.add("hidden");
  byId("quickCustom").classList.add("hidden");
  for (const id of ["btnSelect", "btnMarkNow", "btnOverlay", "btnMore"]) byId(id).classList.add("btn-outline");

  const reg = {};
  const event = (name) => ({ addListener(fn) { (reg[name] ||= []).push(fn); }, removeListener() {} });
  const syncStore = { ...sync };
  const runtimeSent = [];
  const docListeners = {};
  const chrome = {
    runtime: {
      id: "x",
      lastError: null,
      onMessage: event("onMessage"),
      onConnect: event("onConnect"),
      getURL: (file) => file,
      openOptionsPage() {},
      async sendMessage(message) {
        runtimeSent.push(message);
        if (message.type === "CLEAR_VIDEO_CACHE") return { ok: true };
        return {};
      }
    },
    tabs: {
      async query() { return []; },
      async get(id) { throw new Error(`No tab with id: ${id}`); },
      onActivated: event("onActivated"),
      onUpdated: event("onUpdated"),
      async getCurrent() { return null; },
      connect() { return { onMessage: event("pm"), onDisconnect: event("pd"), disconnect() {} }; },
      async sendMessage() { return {}; }
    },
    windows: { async getCurrent() { return { id: 1 }; }, async update() {} },
    sidePanel: { async close() {} },
    scripting: { async executeScript() { return []; } },
    storage: { local: storageArea({}), sync: storageArea(syncStore), session: storageArea({}), onChanged: event("storageChanged") }
  };
  const document = {
    documentElement: fakeElement("html"),
    body: fakeElement("body"),
    getElementById: byId,
    querySelector: (selector) => byId(`q:${selector}`),
    querySelectorAll: () => [],
    createElement: (tag) => fakeElement("", tag),
    createDocumentFragment: () => fakeElement("fragment"),
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
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
    confirm: () => true,
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

  const idOf = (el) => ALL_IDS.find((id) => ACTION_BUTTONS[id] === el.id);
  const barIds = () => bar.children.map(idOf).filter(Boolean);
  const menuIds = () => byId("moreActions").children.map(idOf).filter(Boolean);
  const rows = () => byId("quickPinRows").children;
  const row = (id) => rows().find((item) => item.dataset.pin === id);
  const click = (el, extra = {}) => {
    let stopped = false;
    const ev = { target: el, stopPropagation() { stopped = true; }, preventDefault() {}, ...extra };
    for (const fn of el.listeners.click || []) fn(ev);
    return { stopped };
  };
  // 点击冒泡：按钮自己 → 所在容器（quickCustom 会拦下）→ document（收起菜单）。
  // 和浏览器一样，冒泡路径在派发前就定下，处理函数里重绘挪走节点不影响。
  const clickBubbling = (el) => {
    let stopped = false;
    const ev = { target: el, stopPropagation() { stopped = true; }, preventDefault() {} };
    const path = [];
    for (let node = el; node; node = node.parentNode) path.push(node);
    for (const node of path) {
      if (stopped) break;
      for (const fn of node.listeners?.click || []) fn(ev);
    }
    if (!stopped) for (const fn of docListeners.click || []) fn(ev);
  };
  const isHidden = (id) => byId(id).classList.contains("hidden");
  const changeSync = (changes) => {
    for (const fn of reg.storageChanged || []) fn(changes, "sync");
  };
  return { context, run, byId, reg, bar, barIds, menuIds, rows, row, click, clickBubbling, isHidden, syncStore, runtimeSent, docListeners, changeSync };
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

async function openCustomize(panel) {
  panel.clickBubbling(panel.byId("btnMore"));
  panel.clickBubbling(panel.byId("btnQuickCustomize"));
}

test("没保存过配置：默认固定划选、标记、显示字幕，菜单里是其余 5 个，两边互补不重复", async () => {
  const panel = loadPanel();
  await tick();
  assert.deepEqual(panel.barIds(), ["sel", "mark", "overlay"]);
  assert.deepEqual(panel.menuIds(), ["gen", "srt", "txt", "tr", "clear"]);
  // 快捷栏按钮在字幕助手按钮之前，「更多」在最后
  assert.deepEqual(panel.bar.children.slice(-2).map((el) => el.id), ["btnChat", "moreWrap"]);
  assert.ok(panel.byId("btnSelect").classList.contains("btn-outline"));
  assert.ok(!panel.byId("btnSrt").classList.contains("btn-outline"));
  assert.equal(panel.syncStore.quickBarPins, undefined, "没动过就不写存储");
});

test("配置读入：过滤未知 id、去重，超过 3 个截断；非数组按没存过处理", async () => {
  const panel = loadPanel({ sync: { quickBarPins: ["srt", "bogus", "srt", "clear", "tr", "sel"] } });
  await tick();
  assert.deepEqual(panel.barIds(), ["srt", "clear", "tr"]);
  assert.deepEqual(panel.menuIds(), ["sel", "mark", "overlay", "gen", "txt"]);
  const norm = (value) => JSON.parse(panel.run(`JSON.stringify(normalizeQuickPins(${JSON.stringify(value)}))`));
  assert.deepEqual(norm(null), ["sel", "mark", "overlay"]);
  assert.deepEqual(norm("sel"), ["sel", "mark", "overlay"]);
  assert.deepEqual(norm([]), [], "用户全部取消也要记住");
  assert.deepEqual(norm(["x", "gen"]), ["gen"]);
});

test("自定义：勾选 / 取消即时生效并保存到 chrome.storage.sync，计数跟着变", async () => {
  const panel = loadPanel();
  await tick();
  await openCustomize(panel);
  assert.ok(!panel.isHidden("moreMenu"), "点自定义不收起菜单");
  assert.ok(panel.isHidden("moreNormal"));
  assert.ok(!panel.isHidden("quickCustom"));
  assert.equal(panel.byId("quickPinCount").textContent, "3/3");
  assert.equal(panel.rows().length, 8);
  assert.deepEqual(panel.rows().map((r) => r.children[1].textContent),
    ["划选", "添加标记", "显示字幕", "生成字幕", "下载 SRT", "下载纯文本", "翻译成中文", "清理缓存"]);

  panel.clickBubbling(panel.row("mark"));
  assert.deepEqual(panel.barIds(), ["sel", "overlay"]);
  assert.deepEqual(panel.menuIds(), ["mark", "gen", "srt", "txt", "tr", "clear"]);
  assert.deepEqual(panel.syncStore.quickBarPins, ["sel", "overlay"]);
  assert.equal(panel.byId("quickPinCount").textContent, "2/3");
  assert.ok(!panel.isHidden("moreMenu") && !panel.isHidden("quickCustom"), "勾选不收起菜单、不退出自定义");

  panel.clickBubbling(panel.row("srt"));
  assert.deepEqual(panel.barIds(), ["sel", "overlay", "srt"], "新勾选的排在最后");
  assert.deepEqual(panel.syncStore.quickBarPins, ["sel", "overlay", "srt"]);
  assert.ok(panel.byId("btnSrt").classList.contains("btn-outline"), "放到外面用快捷栏按钮样式");
  assert.ok(!panel.byId("btnMarkNow").classList.contains("btn-outline"), "进菜单去掉按钮边框样式");
});

test("满 3 个后其余项置灰、点了不变；取消一个后又能选", async () => {
  const panel = loadPanel();
  await tick();
  await openCustomize(panel);
  const off = panel.rows().filter((r) => r.classList.contains("off")).map((r) => r.dataset.pin);
  assert.deepEqual(off, ["gen", "srt", "txt", "tr", "clear"]);
  assert.equal(panel.row("gen").getAttribute("aria-disabled"), "true");
  assert.equal(panel.row("sel").children[0].textContent, "✓");
  panel.clickBubbling(panel.row("gen"));
  assert.deepEqual(panel.barIds(), ["sel", "mark", "overlay"]);
  assert.equal(panel.syncStore.quickBarPins, undefined);
  panel.clickBubbling(panel.row("overlay"));
  assert.equal(panel.rows().filter((r) => r.classList.contains("off")).length, 0);
  panel.clickBubbling(panel.row("gen"));
  assert.deepEqual(panel.barIds(), ["sel", "mark", "gen"]);
});

test("恢复默认、完成：恢复默认写回默认 3 个；完成只退出自定义状态", async () => {
  const panel = loadPanel({ sync: { quickBarPins: ["txt"] } });
  await tick();
  await openCustomize(panel);
  panel.clickBubbling(panel.byId("btnQuickReset"));
  assert.deepEqual(panel.barIds(), ["sel", "mark", "overlay"]);
  assert.deepEqual(panel.syncStore.quickBarPins, ["sel", "mark", "overlay"]);
  assert.ok(!panel.isHidden("quickCustom"), "恢复默认后仍在自定义状态");
  panel.clickBubbling(panel.byId("btnQuickDone"));
  assert.ok(!panel.isHidden("moreMenu"), "完成不收起菜单");
  assert.ok(panel.isHidden("quickCustom"));
  assert.ok(!panel.isHidden("moreNormal"));
  assert.deepEqual(panel.syncStore.quickBarPins, ["sel", "mark", "overlay"]);
});

test("菜单收起（点外面、Esc、再点「更多」）或重新打开时都退出自定义状态", async () => {
  const panel = loadPanel();
  await tick();
  const customizing = () => panel.run("quickCustomizing");

  await openCustomize(panel);
  assert.equal(customizing(), true);
  for (const fn of panel.docListeners.click || []) fn({ target: panel.byId("body") });
  assert.ok(panel.isHidden("moreMenu"));
  assert.equal(customizing(), false);

  await openCustomize(panel);
  for (const fn of panel.docListeners.keydown || []) fn({ key: "Escape", target: panel.byId("body") });
  assert.ok(panel.isHidden("moreMenu"));
  assert.equal(customizing(), false);

  await openCustomize(panel);
  panel.clickBubbling(panel.byId("btnMore"));
  assert.ok(panel.isHidden("moreMenu"));
  assert.equal(customizing(), false);

  // 直接改状态再打开：打开时也回到普通菜单
  panel.run("quickCustomizing = true");
  panel.clickBubbling(panel.byId("btnMore"));
  assert.ok(!panel.isHidden("moreMenu"));
  assert.equal(customizing(), false);
  assert.ok(!panel.isHidden("moreNormal"));
  assert.ok(panel.isHidden("quickCustom"));
});

test("另一个页面（浮窗 / 侧栏）改了配置：storage.onChanged 同步过来，也会过滤非法值", async () => {
  const panel = loadPanel();
  await tick();
  panel.changeSync({ quickBarPins: { newValue: ["tr", "nope", "clear"] } });
  assert.deepEqual(panel.barIds(), ["tr", "clear"]);
  panel.changeSync({ quickBarPins: { newValue: undefined } });
  assert.deepEqual(panel.barIds(), ["sel", "mark", "overlay"]);
});

test("按钮换了位置仍调用原有处理函数，禁用条件照旧", async () => {
  const panel = loadPanel({ sync: { quickBarPins: ["srt", "clear", "overlay"] } });
  await tick();
  assert.deepEqual(panel.barIds(), ["srt", "clear", "overlay"]);
  const calls = [];
  panel.context.__calls = calls;
  panel.run(`
    state = { page: "video", bvid: "BV1", cid: 2, title: "t", cues: [{ from: 0, to: 1, content: "一" }] };
    downloadText = (name) => __calls.push("download:" + name);
    translateCues = () => __calls.push("translate");
    addManualMarker = () => __calls.push("mark");
    setOverlayOn = (on) => __calls.push("overlay:" + on);
    generateSubtitles = () => __calls.push("generate");
  `);
  // 固定在外面的：下载 SRT、显示字幕、清理缓存
  panel.click(panel.byId("btnSrt"));
  assert.ok(calls.some((c) => /^download:.*\.srt$/.test(c)), calls.join(","));
  const overlayBefore = panel.run("overlayOn");
  panel.click(panel.byId("btnOverlay"));
  assert.ok(calls.includes(`overlay:${!overlayBefore}`) || panel.run("overlayOn") !== overlayBefore);
  // 挪进菜单的：划选、下载纯文本
  panel.click(panel.byId("btnSelect"));
  assert.equal(panel.run("selecting"), true, "划选进入选择状态");
  panel.click(panel.byId("btnTxt"));
  assert.ok(calls.some((c) => /^download:.*\.txt$/.test(c)));
  panel.click(panel.byId("btnClearCache"));
  await tick();
  assert.ok(panel.runtimeSent.some((m) => m.type === "CLEAR_VIDEO_CACHE" && m.bvid === "BV1"));
  // 禁用条件（转写中不能翻译）由原函数设置在同一个按钮上，与位置无关
  panel.run("generating = true; updateTranslateLock();");
  assert.equal(panel.byId("btnTranslate").disabled, true);
  panel.run("generating = false; updateTranslateLock();");
  assert.equal(panel.byId("btnTranslate").disabled, false);
});
