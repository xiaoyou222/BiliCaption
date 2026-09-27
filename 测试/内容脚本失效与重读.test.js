const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { loadContentScripts } = require("./源码加载.js");

// 极简 DOM：只够 content.js 在 B 站 / X 页面跑起来、建出浮窗节点。
function element(tag = "div") {
  return {
    tagName: tag.toUpperCase(),
    style: { setProperty() {}, removeProperty() {} },
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    attributes: {},
    children: [],
    parentElement: null,
    isConnected: true,
    textContent: "",
    offsetWidth: 640,
    offsetHeight: 360,
    clientWidth: 640,
    clientHeight: 360,
    setAttribute(key, value) { this.attributes[key] = String(value); },
    getAttribute(key) { return this.attributes[key] ?? null; },
    hasAttribute(key) { return key in this.attributes; },
    removeAttribute(key) { delete this.attributes[key]; },
    appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
    append(...items) { items.forEach((item) => this.appendChild(item)); },
    insertBefore(child) { return this.appendChild(child); },
    replaceChildren() {},
    remove() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360 }; },
    closest() { return null; },
    contains() { return false; },
    focus() {}
  };
}

/**
 * 按 manifest 顺序加载内容脚本。respond 可以返回 Promise：后台应答到了才回调，
 * 用来模拟「一次读取还在进行中」。MutationObserver 的回调都收集起来，测试里手动触发。
 */
function loadContent({ href = "https://www.bilibili.com/video/BV1test", respond = () => undefined, sync = {} } = {}) {
  const url = new URL(href);
  const sent = [];
  const hooks = {};
  const observers = [];
  const document = {
    documentElement: element("html"),
    body: element("body"),
    head: element("head"),
    fullscreenElement: null,
    hidden: false,
    title: "",
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => element(tag),
    addEventListener() {}
  };
  const runtime = {
    id: "ext",
    lastError: null,
    getURL: (file) => `chrome-extension://ext/${file}`,
    sendMessage(message, callback) {
      sent.push(message);
      const res = Promise.resolve(respond(message));
      if (typeof callback === "function") {
        res.then((value) => callback(value));
        return undefined;
      }
      return res;
    },
    onMessage: { addListener(fn) { hooks.onMessage = fn; } },
    onConnect: { addListener(fn) { hooks.onConnect = fn; } }
  };
  const context = {
    console: { ...console, log() {}, warn() {} },
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    setInterval: () => 0,
    clearInterval() {},
    getComputedStyle: () => ({ position: "relative" }),
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        this.disconnected = false;
        observers.push(this);
      }
      observe() {}
      disconnect() { this.disconnected = true; }
    },
    ResizeObserver: class { observe() {} disconnect() {} },
    location: { href, pathname: url.pathname, search: url.search, hostname: url.hostname },
    document,
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener() {},
    focus() {},
    chrome: {
      runtime,
      storage: {
        sync: {
          get(defaults, cb) {
            const data = { ...defaults, ...sync };
            cb?.(data);
            return Promise.resolve(data);
          },
          async set() {}
        },
        onChanged: { addListener() {} }
      }
    }
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  loadContentScripts(context);
  return { context, runtime, sent, hooks, observers };
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** 模拟扩展重载后旧内容脚本所在的环境：runtime.id 没了，getURL 之类一调就抛 */
function invalidate(runtime) {
  runtime.id = undefined;
  runtime.getURL = () => {
    throw new Error("Extension context invalidated.");
  };
}

test("扩展失效后浮窗节点被移除：旧内容脚本不再重建浮窗，也不抛 Extension context invalidated", async () => {
  // 用户选了浮窗（不走侧栏）：浮窗节点被移除时 dockWatch 会想把它重新放回去
  const page = loadContent({
    respond: (message) => (message?.type === "LOAD_SUBTITLES"
      ? { page: "video", bvid: "BV1test", cid: 5, aid: 1, cues: [], tracks: [] }
      : message?.type === "WHOAMI" ? { tabId: 3 } : undefined),
    sync: { preferSidebar: false }
  });
  await tick();
  const dockWatch = page.observers.find((observer) => observer.callback);
  assert.ok(dockWatch, "注册了浮窗的 MutationObserver");
  invalidate(page.runtime);
  assert.doesNotThrow(() => dockWatch.callback([{ type: "childList" }]));
  assert.equal(dockWatch.disconnected, true, "确认扩展已失效后断开监听");
});

test("X 清单到达时如果有一次读取正在进行：等它结束后再读一次，不会拿到清单到达前的结果就停", async () => {
  const href = "https://x.com/someone/status/1234567890";
  let loads = 0;
  let releaseFirst;
  const firstDone = new Promise((resolve) => { releaseFirst = resolve; });
  const cue = { from: 0, to: 1, content: "Hello" };
  const page = loadContent({
    href,
    respond: (message) => {
      if (message?.type === "WHOAMI") return { tabId: 3 };
      if (message?.type !== "LOAD_SUBTITLES") return undefined;
      loads += 1;
      // 第一次读取：发生在清单到达之前，迟迟才回，而且没字幕
      if (loads === 1) return firstDone.then(() => ({ page: "video", platform: "x", bvid: "x_1234567890_1", cid: 1, cues: [], tracks: [] }));
      return { page: "video", platform: "x", bvid: "x_1234567890_1", cid: 1, cues: [cue], tracks: [] };
    }
  });
  await tick();
  assert.equal(loads, 1, "页面加载时发起了第一次读取");
  // 读取还没回来时，后台通知清单已捕获
  const replies = [];
  page.hooks.onMessage({ type: "X_MANIFEST_READY", bvid: "x_1234567890_1" }, {}, (res) => replies.push(res));
  await tick();
  releaseFirst();
  await tick(50);
  assert.equal(loads, 2, "第一次读取结束后又读了一次");
  const states = page.sent.filter((message) => message.type === "STATE");
  assert.equal(states.at(-1)?.payload?.cues?.length, 1, "最后发给侧栏的状态带上了字幕");
});
