const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  root,
  read,
  backgroundImports,
  pageScripts,
  contentScripts,
  runFile,
  loadBackgroundScripts
} = require("./源码加载.js");

// 经典脚本共享全局作用域：顶层 const / let 重名会在加载时抛 SyntaxError，function 重名则悄悄覆盖。
// 把一个页面的全部脚本按加载顺序拼进一个严格模式的块里只编译不执行：块里的 function 声明是块级的，
// 与同名 function / const / let / class / var 冲突都会报「has already been declared」。
function assertNoDuplicateTopLevel(label, files) {
  const body = files.map((file) => `// ---- ${file}\n${read(file)}`).join("\n;\n");
  assert.doesNotThrow(
    () => new vm.Script(`"use strict";{\n${body}\n}`, { filename: `${label}.js` }),
    (error) => assert.fail(`${label}的脚本之间有重复的顶层声明：${error.message}`)
  );
}

test("自检：拼接编译能查出跨文件的同名 function、const 和 var", () => {
  for (const pair of [
    ["function a() {}", "function a() {}"],
    ["const a = 1;", "function a() {}"],
    ["var a = 1;", "function a() {}"],
    ["let a = 1;", "const a = 2;"]
  ]) {
    assert.throws(() => new vm.Script(`"use strict";{\n${pair.join("\n;\n")}\n}`), /already been declared/);
  }
});

test("后台、侧栏、设置页、标记库、内容脚本各自的脚本之间没有重复的顶层声明", () => {
  assertNoDuplicateTopLevel("后台", [...backgroundImports(), "background.js"]);
  assertNoDuplicateTopLevel("侧栏", pageScripts("sidepanel.html"));
  assertNoDuplicateTopLevel("设置页", pageScripts("options.html"));
  assertNoDuplicateTopLevel("标记库", pageScripts("library.html"));
  assertNoDuplicateTopLevel("内容脚本", contentScripts());
});

test("拆分目录里的每个文件都有加载点，加载清单里的文件都存在", () => {
  const listed = (dir) => fs.readdirSync(path.join(root, dir)).filter((name) => name.endsWith(".js")).map((name) => `${dir}/${name}`).sort();
  assert.deepEqual(backgroundImports().filter((file) => file.startsWith("后台/")).sort(), listed("后台"));
  assert.deepEqual(pageScripts("sidepanel.html").filter((file) => file.startsWith("侧栏/")).sort(), listed("侧栏"));
  assert.deepEqual(contentScripts().filter((file) => file.startsWith("内容/")).sort(), listed("内容"));
  for (const file of [...backgroundImports(), ...pageScripts("sidepanel.html"), ...pageScripts("options.html"), ...pageScripts("library.html"), ...contentScripts()]) {
    assert.ok(fs.existsSync(path.join(root, file)), `${file} 不存在`);
  }
  // 侧栏入口最后加载：事件绑定和启动代码要在所有模块声明完之后才跑
  assert.equal(pageScripts("sidepanel.html").at(-1), "sidepanel.js");
  assert.equal(contentScripts().at(-1), "content.js");
});

test("后台/ 下的文件只做声明：空环境里（没有 chrome、没有 lib）也能加载，不在加载时执行任何代码", () => {
  const context = vm.createContext({});
  for (const file of backgroundImports().filter((item) => item.startsWith("后台/"))) {
    assert.doesNotThrow(() => runFile(context, file), `${file} 加载时执行了代码`);
  }
  // 侧栏/ 同理（基础.js 要在加载时查界面元素，不算）
  const panel = vm.createContext({});
  for (const file of pageScripts("sidepanel.html").filter((item) => item.startsWith("侧栏/") && item !== "侧栏/基础.js")) {
    assert.doesNotThrow(() => runFile(panel, file), `${file} 加载时执行了代码`);
  }
});

// ---------- 后台加载冒烟：模拟 chrome API，按 importScripts 真实顺序加载全部脚本 ----------

function storageArea(store = {}) {
  return {
    async get(keys) {
      if (keys == null) return { ...store };
      if (typeof keys === "string") return keys in store ? { [keys]: store[keys] } : {};
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in store).map((key) => [key, store[key]]));
      const out = { ...keys };
      for (const key of Object.keys(keys)) if (key in store) out[key] = store[key];
      return out;
    },
    async getKeys() { return Object.keys(store); },
    async set(values) { Object.assign(store, values || {}); },
    async remove(keys) { for (const key of [].concat(keys)) delete store[key]; },
    async setAccessLevel() {}
  };
}

function event(registry, name) {
  return {
    addListener(fn) { (registry[name] ||= []).push(fn); },
    removeListener(fn) { registry[name] = (registry[name] || []).filter((item) => item !== fn); }
  };
}

function chromeMock(listeners) {
  return {
    runtime: {
      id: "smoke-test",
      lastError: null,
      onMessage: event(listeners, "runtime.onMessage"),
      onInstalled: event(listeners, "runtime.onInstalled"),
      onStartup: event(listeners, "runtime.onStartup"),
      onConnect: event(listeners, "runtime.onConnect"),
      async sendMessage() {},
      getURL: (file) => `chrome-extension://smoke-test/${file}`,
      async getPlatformInfo() { return {}; },
      openOptionsPage() {}
    },
    sidePanel: { async setPanelBehavior() {}, async setOptions() {}, async open() {}, async close() {} },
    tabs: {
      query(_query, callback) { callback?.([]); return Promise.resolve([]); },
      async get() { throw new Error("No tab"); },
      async sendMessage() {},
      async create() {},
      onRemoved: event(listeners, "tabs.onRemoved")
    },
    scripting: { async executeScript() { return []; } },
    declarativeNetRequest: { async updateDynamicRules() {} },
    storage: {
      local: storageArea(),
      session: storageArea(),
      sync: storageArea(),
      onChanged: event(listeners, "storage.onChanged")
    },
    alarms: { create() {}, async clear() { return true; }, onAlarm: event(listeners, "alarms.onAlarm") },
    webRequest: { onCompleted: event(listeners, "webRequest.onCompleted") },
    permissions: { async request() { return true; } }
  };
}

function loadWholeBackground() {
  const listeners = {};
  const timers = [];
  const context = {
    console: { ...console, log() {}, warn() {}, info() {} },
    URL, URLSearchParams, TextEncoder, TextDecoder, Blob, FormData, AbortController, AbortSignal, DOMException,
    setTimeout: (fn, ms) => { timers.push(fn); return timers.length; },
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    fetch: async () => { throw new Error("冒烟测试不联网"); },
    chrome: chromeMock(listeners)
  };
  context.self = context;
  vm.createContext(context);
  // 全部 lib 都真实加载，与 service worker 里一致
  loadBackgroundScripts(context, backgroundImports().filter((file) => file.startsWith("lib/")));
  return { context, listeners };
}

// 拆分引入的错误只有两类：引用了不存在的名字，或在初始化之前用到了常量（暂时性死区）。
const LOAD_ORDER_ERROR = /is not defined|before initialization/;

test("后台冒烟：按 importScripts 顺序加载全部脚本不报错，事件监听都在首次同步执行时注册", async () => {
  const { context, listeners } = loadWholeBackground();
  for (const name of ["runtime.onMessage", "runtime.onInstalled", "runtime.onStartup", "alarms.onAlarm", "storage.onChanged", "tabs.onRemoved"]) {
    assert.equal(listeners[name]?.length, 1, `${name} 应注册一次`);
  }
  assert.equal(listeners["webRequest.onCompleted"]?.length, 2, "YouTube 字幕与 X 清单各一个 webRequest 监听");
  await vm.runInContext("asrResumeScan", context);

  // 安装、启动、定时同步、存储变更、关标签页：跑一遍，跨文件调用都要找得到
  const errors = [];
  const guard = (fn) => {
    try {
      const out = fn();
      if (out?.catch) out.catch((error) => errors.push(error));
    } catch (error) {
      errors.push(error);
    }
  };
  guard(() => listeners["runtime.onInstalled"][0]());
  guard(() => listeners["runtime.onStartup"][0]());
  guard(() => listeners["alarms.onAlarm"][0]({ name: "dav-auto-sync" }));
  guard(() => listeners["storage.onChanged"][0]({ markerIndex: { newValue: {} } }, "local"));
  guard(() => listeners["tabs.onRemoved"][0](5));
  for (const fn of listeners["webRequest.onCompleted"]) {
    guard(() => fn({ tabId: 5, url: "https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=en" }));
  }
  await new Promise((resolve) => setImmediate(resolve));
  const loadErrors = errors.filter((error) => LOAD_ORDER_ERROR.test(String(error?.message || error)));
  assert.deepEqual(loadErrors.map(String), []);
});

test("后台冒烟：路由里的每种消息都能分派到拆分后的模块，没有找不到的函数", async () => {
  const { context, listeners } = loadWholeBackground();
  const onMessage = listeners["runtime.onMessage"][0];
  const types = [
    ...vm.runInContext("[...CONTENT_MESSAGE_TYPES]", context),
    ...vm.runInContext("[...EXTENSION_MESSAGE_TYPES]", context)
  ];
  const sender = { url: "chrome-extension://smoke-test/sidepanel.html", tab: { id: 5, windowId: 1 } };
  const payload = {
    page: { kind: "other" },
    bvid: "BV1smoke",
    cid: 1,
    cues: [],
    url: "https://i0.hdslb.com/bfs/subtitle/smoke.json"
  };
  for (const type of types) {
    const response = await new Promise((resolve) => {
      let handled = false;
      try {
        handled = onMessage({ type, ...payload }, sender, resolve);
      } catch (error) {
        resolve({ thrown: String(error?.message || error) });
        return;
      }
      if (handled !== true) resolve({ unhandled: true });
    });
    assert.notEqual(response?.unhandled, true, `${type} 没有被路由处理`);
    const message = String(response?.error || response?.thrown || "");
    assert.doesNotMatch(message, LOAD_ORDER_ERROR, `${type}：${message}`);
  }
  // 内容脚本调扩展页专用的消息，回「无权调用」
  const denied = await new Promise((resolve) => onMessage({ type: "GET_LOGS" }, { url: "https://www.bilibili.com/video/BV1", tab: { id: 5 } }, resolve));
  assert.equal(denied.error, "无权调用");
});

// ---------- 侧栏加载冒烟：最小 DOM 桩，按 script 标签顺序加载 ----------

function fakeElement(id = "") {
  const classes = new Set();
  const listeners = {};
  const store = {
    id,
    dataset: {},
    style: {},
    attributes: {},
    textContent: "",
    innerHTML: "",
    value: "",
    childElementCount: 0,
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
    setAttribute(key, value) { store.attributes[key] = String(value); },
    getAttribute(key) { return store.attributes[key] ?? null; },
    removeAttribute(key) { delete store.attributes[key]; },
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    contains: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    appendChild: (child) => child,
    append() {},
    replaceChildren() {},
    remove() {},
    focus() {},
    scrollTo() {}
  };
  return store;
}

test("侧栏冒烟：按 script 标签顺序加载全部脚本不报错，界面事件和消息监听都已挂上", () => {
  const elements = new Map();
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, fakeElement(id));
    return elements.get(id);
  };
  const listeners = {};
  const docListeners = fakeElement("document");
  const document = {
    documentElement: fakeElement("html"),
    body: fakeElement("body"),
    title: "",
    getElementById: byId,
    querySelector: (selector) => byId(`query:${selector}`),
    querySelectorAll: () => [],
    createElement: () => fakeElement(),
    addEventListener: docListeners.addEventListener,
    removeEventListener() {},
    execCommand: () => true
  };
  const chrome = chromeMock(listeners);
  chrome.windows = { async getCurrent() { return { id: 1 }; }, async update() {} };
  chrome.tabs.onActivated = event(listeners, "tabs.onActivated");
  chrome.tabs.onUpdated = event(listeners, "tabs.onUpdated");
  chrome.tabs.getCurrent = async () => null;
  chrome.tabs.connect = () => ({ onMessage: event({}, "m"), onDisconnect: event({}, "d"), disconnect() {} });
  const windowListeners = fakeElement("window");
  const context = {
    console: { ...console, log() {}, warn() {} },
    URL, URLSearchParams, AbortController, AbortSignal, Blob, TextEncoder, TextDecoder,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    fetch: async () => { throw new Error("冒烟测试不联网"); },
    location: { search: "", href: "chrome-extension://smoke-test/sidepanel.html" },
    navigator: {},
    document,
    chrome,
    addEventListener: windowListeners.addEventListener,
    removeEventListener() {},
    innerHeight: 800,
    devicePixelRatio: 1
  };
  context.window = context;
  context.self = context;
  context.top = context;
  vm.createContext(context);
  for (const file of pageScripts("sidepanel.html")) {
    assert.doesNotThrow(() => runFile(context, file), `${file} 加载失败`);
  }
  assert.equal(listeners["runtime.onMessage"]?.length, 1, "侧栏消息监听");
  assert.equal(listeners["storage.onChanged"]?.length, 1, "设置变更监听");
  assert.equal(listeners["tabs.onActivated"]?.length, 1, "换标签页监听");
  assert.ok(windowListeners.listeners.keydown?.length, "快捷键监听");
  assert.ok(byId("btnSettings").listeners.click?.length, "设置按钮");
  assert.ok(byId("cueList").listeners.pointerdown?.length, "字幕列表选择");
  assert.ok(byId("btnGenOutline").listeners.click?.length, "生成大纲");
  // 状态变量、共用工具在后面的文件里都读得到
  assert.equal(vm.runInContext("typeof state + typeof renderState + typeof formatClock + typeof ui.cueList", context), "objectfunctionfunctionobject");
});
