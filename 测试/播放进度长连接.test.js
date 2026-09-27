const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { contentSource, panelSource, loadContentScripts } = require("./源码加载.js");

const root = path.resolve(__dirname, "..");

// 极简 DOM：只够 content.js 在 B 站视频页跑起来、挂上 <video> 的事件。
function element(tag = "div") {
  return {
    tagName: tag.toUpperCase(),
    style: { setProperty() {} },
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

function loadContent() {
  const listeners = {};
  const video = element("video");
  Object.assign(video, {
    currentTime: 12.5,
    duration: 300,
    paused: false,
    playbackRate: 1,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((item) => item !== fn); }
  });
  const sent = [];
  const hooks = {};
  const respond = (message) => {
    if (message?.type === "WHOAMI") return { tabId: 3 };
    if (message?.type === "LOAD_SUBTITLES") return { page: "video", bvid: "BV1test", cid: 5, aid: 1, cues: [], tracks: [] };
    if (message?.type === "GET_MARKERS") return { markers: [] };
    return undefined;
  };
  const docEl = element("html");
  const document = {
    documentElement: docEl,
    body: element("body"),
    head: element("head"),
    fullscreenElement: null,
    hidden: false,
    title: "",
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: (selector) => (selector === "video" ? [video] : []),
    createElement: (tag) => element(tag),
    addEventListener() {}
  };
  const context = {
    console,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    setInterval: () => 0,
    clearInterval() {},
    getComputedStyle: () => ({ position: "relative" }),
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    location: { href: "https://www.bilibili.com/video/BV1test", pathname: "/video/BV1test", search: "", hostname: "www.bilibili.com" },
    document,
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener() {},
    focus() {},
    chrome: {
      runtime: {
        id: "ext",
        lastError: null,
        getURL: (file) => `chrome-extension://ext/${file}`,
        sendMessage(message, callback) {
          sent.push(message);
          const res = respond(message);
          if (typeof callback === "function") {
            callback(res);
            return undefined;
          }
          return Promise.resolve(res);
        },
        onMessage: { addListener(fn) { hooks.onMessage = fn; } },
        onConnect: { addListener(fn) { hooks.onConnect = fn; } }
      },
      storage: {
        sync: { get(defaults, cb) { cb?.(defaults); return Promise.resolve(defaults); }, async set() {} },
        onChanged: { addListener() {} }
      }
    }
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  loadContentScripts(context);
  const fire = (type) => (listeners[type] || []).forEach((fn) => fn());
  return { context, video, sent, hooks, fire, listeners };
}

function fakePort(name = "bc-time") {
  const port = { name, messages: [], disconnectFns: [] };
  port.postMessage = (message) => port.messages.push(message);
  port.onDisconnect = { addListener: (fn) => port.disconnectFns.push(fn) };
  port.disconnect = () => port.disconnectFns.forEach((fn) => fn());
  return port;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test("没有侧栏连接时播放进度一条都不发，页面内字幕照常更新", async () => {
  const page = loadContent();
  await tick();
  assert.ok(page.listeners.timeupdate?.length, "应已挂上 timeupdate");
  page.fire("timeupdate");
  page.fire("seeked");
  assert.equal(page.sent.some((m) => m?.type === "TIME"), false);
});

test("侧栏用 bc-time 长连接连上后才推送 TIME，断开即停", async () => {
  const page = loadContent();
  await tick();
  const other = fakePort("something-else");
  page.hooks.onConnect(other);
  const port = fakePort();
  page.hooks.onConnect(port);
  // 连上先推一次当前进度
  assert.equal(port.messages.length, 1);
  assert.deepEqual({ ...port.messages[0] }, { type: "TIME", currentTime: 12.5, duration: 300, rate: 1 });
  page.video.currentTime = 20;
  page.fire("seeked");
  assert.equal(port.messages.at(-1).currentTime, 20);
  assert.equal(other.messages.length, 0);
  assert.equal(page.sent.some((m) => m?.type === "TIME"), false);
  port.disconnect();
  const count = port.messages.length;
  page.video.currentTime = 30;
  page.fire("seeked");
  assert.equal(port.messages.length, count);
});

test("侧栏与内容脚本两端用同一个 port 名，侧栏的 TIME 只从长连接来", () => {
  const content = contentSource();
  const panel = panelSource();
  assert.match(content, /TIME_PORT_NAME = "bc-time"/);
  assert.match(panel, /TIME_PORT_NAME = "bc-time"/);
  assert.match(panel, /chrome\.tabs\.connect\(tabId, \{ name: TIME_PORT_NAME \}\)/);
  assert.doesNotMatch(content, /postRuntime\(\{\s*type: "TIME"/);
  // 让出所有权时断开长连接，侧栏会重连到新脚本
  assert.match(content, /if \(!isCurrentScript\(\)\) \{[\s\S]{0,160}closeTimePorts\(\)/);
});
