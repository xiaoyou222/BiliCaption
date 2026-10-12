const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { contentSource, panelSource, loadContentScripts } = require("./source-loader.js");

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

function loadContent(options = {}) {
  const videoListeners = new WeakMap();
  function createVideo() {
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
    videoListeners.set(video, listeners);
    return video;
  }
  let video = createVideo();
  const windowListeners = {};
  const intervals = new Map();
  let nextInterval = 1;
  const stored = options.stored || {};
  const writes = [];
  const storageListeners = [];
  const storageChanged = (changes, area = "local") => storageListeners.forEach((fn) => fn(changes, area));
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
    setInterval(fn, delay) { const id = nextInterval++; intervals.set(id, { fn, delay }); return id; },
    clearInterval(id) { intervals.delete(id); },
    getComputedStyle: () => ({ position: "relative" }),
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    location: { href: "https://www.bilibili.com/video/BV1test", pathname: "/video/BV1test", search: "", hostname: "www.bilibili.com" },
    document,
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener(type, fn) { (windowListeners[type] ||= []).push(fn); },
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
        local: {
          get(defaults, callback) {
            const keys = typeof defaults === "string" ? [defaults] : Array.isArray(defaults) ? defaults : Object.keys(defaults || stored);
            const fallback = defaults && typeof defaults === "object" && !Array.isArray(defaults) ? defaults : {};
            const data = Object.fromEntries(keys.map((key) => [key, stored[key] ?? fallback[key]]));
            const result = options.getLocal ? Promise.resolve().then(() => options.getLocal(data)) : Promise.resolve(data);
            if (callback) result.then(callback, () => callback({}));
            return result;
          },
          async set(data) {
            const copy = { ...data };
            writes.push(copy);
            if (options.setLocal) await options.setLocal(copy);
            const changes = Object.fromEntries(Object.entries(copy).map(([key, newValue]) => [key, { oldValue: stored[key], newValue }]));
            Object.assign(stored, copy);
            storageChanged(changes);
          }
        },
        onChanged: { addListener(fn) { storageListeners.push(fn); } }
      }
    }
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  loadContentScripts(context);
  const fire = (type, target = video) => (videoListeners.get(target)?.[type] || []).slice().forEach((fn) => fn());
  return {
    context, sent, hooks, fire, stored, writes, storageChanged,
    get video() { return video; },
    get listeners() { return videoListeners.get(video); },
    replaceVideo() { video.isConnected = false; video = createVideo(); return video; },
    runIntervals(delay = 1000) { [...intervals.values()].filter((item) => item.delay === delay).forEach((item) => item.fn()); },
    key(code, key = code.slice(-1).toLowerCase()) {
      const event = { type: "keydown", code, key, target: document.body, preventDefault() {}, stopImmediatePropagation() {} };
      (windowListeners.keydown || []).forEach((fn) => fn(event));
    },
    send(message) { return new Promise((resolve) => hooks.onMessage(message, {}, resolve)); }
  };
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

test("首次使用默认 1 倍，手动选择 2 倍后新页面和刷新均恢复 2 倍", async () => {
  const stored = {};
  const first = loadContent({ stored });
  await tick();
  assert.equal(first.video.playbackRate, 1);
  await first.send({ type: "SET_RATE", rate: 2 });
  await tick();
  assert.equal(stored.playbackRate, 2);
  for (const description of ["打开新视频", "刷新视频页面"]) {
    const page = loadContent({ stored });
    await tick();
    assert.equal(page.video.playbackRate, 2, description);
    assert.equal(page.video.defaultPlaybackRate, 2, "换源时播放器默认速度也应保持偏好");
    assert.equal(page.writes.length, 0, "恢复偏好不应反复写入存储");
  }
});

test("站点重置速度不覆盖用户偏好，同一播放器加载新媒体时恢复 2 倍", async () => {
  const page = loadContent({ stored: { playbackRate: 2 } });
  await tick();
  for (const event of ["loadstart", "loadedmetadata"]) {
    page.video.playbackRate = 1;
    page.fire("ratechange");
    assert.equal(page.sent.filter((m) => m.type === "RATE").at(-1)?.rate, 1, "显示播放器实际速度");
    page.fire(event);
    await tick();
    assert.equal(page.video.playbackRate, 2, `${event} 应恢复手动选择的倍速`);
  }
  assert.equal(page.stored.playbackRate, 2);
  assert.deepEqual(page.writes, [], "站点的 ratechange 不能写成用户偏好");
});

test("方向键跳转后播放器把速度重置为 1 倍：立刻改回用户倍速，不提示、不改偏好", async () => {
  const page = loadContent({ stored: { playbackRate: 2 } });
  await tick();
  assert.equal(page.video.playbackRate, 2);
  const ratesBefore = page.sent.filter((m) => m.type === "RATE").length;
  page.fire("seeking");
  page.video.playbackRate = 1;
  page.fire("ratechange");
  assert.equal(page.video.playbackRate, 2, "跳转后的重置应被改回");
  assert.equal(page.sent.filter((m) => m.type === "RATE").length, ratesBefore, "不把重置当成速度变化通知侧栏");
  assert.deepEqual(page.writes, []);
});

test("空格暂停再继续时播放器把速度重置为 1 倍：立刻改回用户倍速", async () => {
  for (const events of [["pause"], ["play"], ["playing"], ["pause", "play"]]) {
    const page = loadContent({ stored: { playbackRate: 2 } });
    await tick();
    for (const type of events) page.fire(type);
    page.video.playbackRate = 1;
    page.fire("ratechange");
    assert.equal(page.video.playbackRate, 2, `${events.join("→")} 后的重置应被改回`);
    assert.deepEqual(page.writes, []);
  }
});

test("不在跳转附近的速度变化仍按用户在播放器菜单里的操作处理", async () => {
  const page = loadContent({ stored: { playbackRate: 2 } });
  await tick();
  page.video.playbackRate = 1.5;
  page.fire("ratechange");
  assert.equal(page.video.playbackRate, 1.5);
  assert.equal(page.sent.filter((m) => m.type === "RATE").at(-1)?.rate, 1.5);
});

test("更换 video 节点及同节点切换视频地址均恢复倍速偏好", async () => {
  const page = loadContent({ stored: { playbackRate: 2 } });
  await tick();
  const oldVideo = page.video;
  page.replaceVideo();
  page.runIntervals();
  await tick();
  assert.equal(page.video.playbackRate, 2);
  assert.notEqual(page.video, oldVideo);

  page.video.playbackRate = 1;
  page.fire("ratechange");
  page.context.location.href = "https://www.bilibili.com/video/BV1second";
  page.context.location.pathname = "/video/BV1second";
  page.runIntervals();
  await tick();
  assert.equal(page.video.playbackRate, 2, "同一播放器的 SPA 视频切换也应恢复偏好");
  assert.deepEqual(page.writes, []);
});

test("选择 1 倍会替换旧偏好，快捷键设置也会保存", async () => {
  const page = loadContent({ stored: { playbackRate: 2 } });
  await tick();
  await page.send({ type: "SET_RATE", rate: 1 });
  await tick();
  assert.equal(page.video.playbackRate, 1);
  assert.equal(page.stored.playbackRate, 1);
  page.fire("loadedmetadata");
  assert.equal(page.video.playbackRate, 1);
  page.key("KeyC");
  await tick();
  assert.equal(page.stored.playbackRate, 1.1);
  page.key("KeyZ");
  await tick();
  assert.equal(page.stored.playbackRate, 1);
});

test("读取倍速偏好较慢时不能覆盖用户刚刚选择的新速度", async () => {
  let finishRead;
  const page = loadContent({
    stored: { playbackRate: 2 },
    getLocal: () => new Promise((resolve) => { finishRead = resolve; })
  });
  await tick();
  await page.send({ type: "SET_RATE", rate: 3 });
  await tick();
  finishRead({ playbackRate: 2 });
  await tick();
  assert.equal(page.video.playbackRate, 3);
  assert.equal(page.stored.playbackRate, 3);
  page.fire("loadedmetadata");
  assert.equal(page.video.playbackRate, 3, "旧的异步读取不能污染下一次恢复值");
});

test("另一标签页更改倍速只更新下次恢复的偏好，不打断当前播放", async () => {
  const page = loadContent({ stored: { playbackRate: 2 } });
  await tick();
  page.storageChanged({ playbackRate: { oldValue: 2, newValue: 3 } });
  assert.equal(page.video.playbackRate, 2, "不立即改当前视频");
  page.fire("loadedmetadata");
  await tick();
  assert.equal(page.video.playbackRate, 3);
  assert.deepEqual(page.writes, [], "接收存储通知不应再写一遍");
});

test("读取倍速偏好失败不妨碍手动调速及后续保存", async () => {
  const page = loadContent({ getLocal: async () => { throw new Error("storage unavailable"); } });
  await tick();
  assert.equal(page.video.playbackRate, 1);
  await page.send({ type: "SET_RATE", rate: 2 });
  await tick();
  assert.equal(page.video.playbackRate, 2);
  assert.equal(page.stored.playbackRate, 2);
});

test("本页保存回调较慢时，不能漏掉另一标签页随后保存的新倍速", async () => {
  const page = loadContent();
  await tick();
  let finishWrite;
  page.context.chrome.storage.local.set = (data) => {
    Object.assign(page.stored, data);
    page.storageChanged({ playbackRate: { newValue: data.playbackRate } });
    return new Promise((resolve) => { finishWrite = resolve; });
  };
  const saving = page.send({ type: "SET_RATE", rate: 2 });
  await tick();
  // A 已落盘但回调尚未返回，此时 B 又保存了 3 倍。
  page.stored.playbackRate = 3;
  page.storageChanged({ playbackRate: { oldValue: 2, newValue: 3 } });
  finishWrite();
  await saving;
  assert.equal(page.video.playbackRate, 2, "不打断当前视频的速度");
  page.fire("loadedmetadata");
  assert.equal(page.video.playbackRate, 3, "下个视频应使用存储里的最新偏好");
});

test("连续选择速度按顺序保存，较早的慢写入不会覆盖最新选择", async () => {
  let finishFirst;
  const page = loadContent({
    setLocal: () => {
      if (page.writes.length === 1) return new Promise((resolve) => { finishFirst = resolve; });
      return Promise.resolve();
    }
  });
  await tick();
  const first = page.send({ type: "SET_RATE", rate: 2 });
  await tick();
  const second = page.send({ type: "SET_RATE", rate: 3 });
  await tick();
  assert.equal(page.video.playbackRate, 3, "播放器调速无需等待存储完成");
  assert.deepEqual(page.writes, [{ playbackRate: 2 }], "第二次保存应等待第一次完成");
  finishFirst();
  await Promise.all([first, second]);
  await tick();
  assert.deepEqual(page.writes, [{ playbackRate: 2 }, { playbackRate: 3 }]);
  assert.equal(page.stored.playbackRate, 3);
  page.fire("loadedmetadata");
  assert.equal(page.video.playbackRate, 3);
});

test("失去脚本所有权后，旧读取、按键、消息及媒体事件都不能改速或保存", async () => {
  let finishRead;
  const page = loadContent({ getLocal: () => new Promise((resolve) => { finishRead = resolve; }) });
  await tick();
  page.context.document.documentElement.setAttribute("data-bilicaption-owner", "new-script-owner");
  page.video.playbackRate = 1.5;
  finishRead({ playbackRate: 2 });
  page.hooks.onMessage({ type: "SET_RATE", rate: 3 }, {}, () => assert.fail("旧脚本不能回应设置消息"));
  page.key("KeyC");
  page.storageChanged({ playbackRate: { newValue: 4 } });
  page.fire("loadedmetadata");
  page.fire("loadstart");
  await tick();
  assert.equal(page.video.playbackRate, 1.5);
  assert.deepEqual(page.writes, []);
});
