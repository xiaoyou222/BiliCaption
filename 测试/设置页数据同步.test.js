const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { pageScripts } = require("./源码加载.js");

// 设置页「数据同步」：按真实的 options.html 搭一棵最小 DOM，按 script 标签顺序在 vm 里执行 lib/ 与 options.js，
// chrome.storage / runtime.sendMessage 换成内存桩；计时器只记录不真跑（setInterval 不挂起进程）。

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const MB = 1024 * 1024;

// ---------- 最小 DOM：够 options.js 用即可 ----------

const VOID = new Set(["input", "meta", "link", "br", "img", "hr"]);

class TextNode {
  constructor(text) {
    this.nodeType = 3;
    this.textContent = text;
    this.parent = null;
  }
}

class El {
  constructor(tag, attrs = {}, doc = null) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.ownerDocument = doc;
    this.attrs = { ...attrs };
    this.children = [];
    this.parent = null;
    this.listeners = {};
    this.style = {};
    this.dataset = {};
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith("data-")) this.dataset[key.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = value;
    }
    this.classSet = new Set(String(attrs.class || "").split(/\s+/).filter(Boolean));
    const self = this;
    this.classList = {
      add: (...names) => names.forEach((name) => self.classSet.add(name)),
      remove: (...names) => names.forEach((name) => self.classSet.delete(name)),
      contains: (name) => self.classSet.has(name),
      toggle(name, force) {
        const on = force === undefined ? !self.classSet.has(name) : Boolean(force);
        if (on) self.classSet.add(name);
        else self.classSet.delete(name);
        return on;
      }
    };
    this.id = attrs.id || "";
    this.type = attrs.type || "";
    this.value = attrs.value || "";
    this.placeholder = attrs.placeholder || "";
    this.title = attrs.title || "";
    this.disabled = Object.hasOwn(attrs, "disabled");
    this.hidden = false;
    this.draggable = false;
    this.offsetWidth = 0;
    this.offsetHeight = 0;
  }

  get className() { return [...this.classSet].join(" "); }
  set className(value) { this.classSet = new Set(String(value).split(/\s+/).filter(Boolean)); }

  get textContent() { return this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { this.replaceChildren(new TextNode(String(value))); }

  set innerHTML(html) { this.replaceChildren(...parseHtml(html, this.ownerDocument)); }

  setAttribute(name, value) {
    this.attrs[name] = String(value);
    if (name === "id") this.id = String(value);
    if (name === "class") this.className = value;
  }
  getAttribute(name) {
    if (name === "class") return this.className;
    return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null;
  }

  appendChild(child) {
    if (child.parent) child.parent.children = child.parent.children.filter((c) => c !== child);
    child.parent = this;
    this.children.push(child);
    return child;
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(typeof node === "string" ? new TextNode(node) : node);
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }

  *descendants() {
    for (const child of this.children) {
      if (child.nodeType !== 1) continue;
      yield child;
      yield* child.descendants();
    }
  }
  matches(selector) { return selector.split(",").some((one) => matchCompound(this, one.trim())); }
  querySelectorAll(selector) { return [...this.descendants()].filter((el) => el.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) {
    for (let el = this; el && el.nodeType === 1; el = el.parent) if (el.matches(selector)) return el;
    return null;
  }
  contains(other) {
    for (let el = other; el; el = el.parent) if (el === this) return true;
    return false;
  }

  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  dispatch(type) {
    let stopped = false;
    const event = { type, target: this, preventDefault() {}, stopPropagation() { stopped = true; } };
    for (let el = this; el && !stopped; el = el.parent) {
      for (const fn of el.listeners[type] || []) fn(event);
    }
    if (!stopped) for (const fn of this.ownerDocument?.listeners[type] || []) fn(event);
  }
  click() {
    if (this.disabled) return;
    this.dispatch("click");
  }
  focus() {}
  getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; }
}

/** 只支持复合选择器：tag / .class / #id / [attr="v"] 的组合（options.js 用到的就这些） */
function matchCompound(el, selector) {
  const re = /([.#]?)([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
  let m;
  let any = false;
  while ((m = re.exec(selector))) {
    any = true;
    if (m[3]) {
      const actual = m[3].startsWith("data-") ? el.dataset[m[3].slice(5)] : el.getAttribute(m[3]);
      if (actual == null || (m[4] != null && String(actual) !== m[4])) return false;
    } else if (m[1] === ".") {
      if (!el.classSet.has(m[2])) return false;
    } else if (m[1] === "#") {
      if (el.id !== m[2]) return false;
    } else if (el.tagName !== m[2].toUpperCase()) return false;
  }
  return any;
}

function parseAttrs(text) {
  const attrs = {};
  for (const m of text.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[m[1]] = m[2] ?? "";
  return attrs;
}

function parseHtml(html, doc) {
  const top = new El("fragment", {}, doc);
  const stack = [top];
  const re = /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[4] != null) {
      if (m[4].trim()) stack.at(-1).appendChild(new TextNode(m[4].trim()));
      continue;
    }
    if (!m[2]) continue;
    const tag = m[2].toLowerCase();
    if (m[1]) {
      while (stack.length > 1 && stack.pop().tagName !== tag.toUpperCase()) { /* 逐层关闭 */ }
      continue;
    }
    const el = new El(tag, parseAttrs(m[3] || ""), doc);
    stack.at(-1).appendChild(el);
    if (!VOID.has(tag)) stack.push(el);
  }
  return top.children.slice();
}

function createDocument(html) {
  const doc = { listeners: {} };
  const body = new El("body", {}, doc);
  const inner = html.match(/<body[^>]*>([\s\S]*)<\/body>/)[1];
  body.append(...parseHtml(inner, doc));
  Object.assign(doc, {
    body,
    getElementById: (id) => body.querySelector(`#${id}`),
    querySelector: (selector) => body.querySelector(selector),
    querySelectorAll: (selector) => body.querySelectorAll(selector),
    createElement: (tag) => new El(tag, {}, doc),
    createTextNode: (text) => new TextNode(text),
    addEventListener: (type, fn) => { (doc.listeners[type] ||= []).push(fn); }
  });
  return doc;
}

// ---------- chrome 桩与页面加载 ----------

function storageArea(store) {
  return {
    async get(keys) {
      if (keys == null) return JSON.parse(JSON.stringify(store));
      if (typeof keys === "string") return Object.hasOwn(store, keys) ? { [keys]: store[keys] } : {};
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => Object.hasOwn(store, key)).map((key) => [key, store[key]]));
      const out = { ...keys };
      for (const key of Object.keys(keys)) if (Object.hasOwn(store, key)) out[key] = store[key];
      return out;
    },
    async set(values) { Object.assign(store, JSON.parse(JSON.stringify(values || {}))); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key]; }
  };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * 打开设置页（默认直接落在「数据同步」）。handlers 按消息 type 回复后台消息；
 * sync / local 是 chrome.storage 的初始内容。
 */
async function openOptions({ sync = {}, local = {}, handlers = {}, tab = "sync" } = {}) {
  const document = createDocument(read("options.html"));
  const messages = [];
  const timers = [];
  const syncStore = { ...sync };
  const localStore = { ...local };
  const context = {
    console: { ...console, log() {}, warn() {} },
    document,
    location: { search: tab ? `?tab=${tab}` : "" },
    navigator: {},
    URL, URLSearchParams, Blob, TextEncoder, TextDecoder, AbortController, DOMException,
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].fn = null; },
    setInterval() { return 0; },
    clearInterval() {},
    fetch: () => Promise.reject(new Error("不应联网")),
    addEventListener() {},
    chrome: {
      runtime: {
        id: "test-extension",
        getManifest: () => ({ version: "9.9.9" }),
        onMessage: { addListener() {} },
        async sendMessage(message) {
          messages.push(message);
          const handler = handlers[message?.type];
          return handler ? handler(message) : {};
        }
      },
      storage: { sync: storageArea(syncStore), local: storageArea(localStore) }
    }
  };
  context.window = context;
  context.self = context;
  vm.createContext(context);
  for (const file of pageScripts("options.html")) {
    vm.runInContext(read(file), context, { filename: file });
  }
  await flush();
  const $ = (id) => document.getElementById(id);
  return {
    $,
    document,
    messages,
    syncStore,
    /** 执行到期的计时器（只跑一轮已登记的） */
    runTimers() {
      for (const timer of timers.splice(0)) timer.fn?.();
    },
    sent: (type) => messages.filter((m) => m?.type === type)
  };
}

const usageOf = ({ videos = 0, bytes = 0, maxVideos, maxBytes, keptVideos = 0, keptBytes = 0 } = {}) => ({
  renewable: { videos, bytes, ...(maxVideos != null ? { maxVideos } : {}), ...(maxBytes != null ? { maxBytes } : {}) },
  protected: { videos: keptVideos, bytes: keptBytes, asr: keptVideos, edited: 0 }
});

const pct = (el) => Number.parseFloat(el.style.width);

// ---------- 测试 ----------

test("设置页数据同步：同步关闭时细节整块隐藏，打开开关才显示；本地字幕缓存始终可见", async () => {
  const page = await openOptions({ sync: { syncOn: false }, handlers: { GET_CACHE_USAGE: () => usageOf() } });
  const details = page.$("syncDetails");
  // 同步内容、服务器与账号、测试 / 立即同步都在这块里；缓存卡片不在
  for (const id of ["syncMarks", "syncConfig", "syncSubs", "syncKeys", "syncKeysWarn", "davUrl", "davUser", "davPass", "testDav", "syncNow", "davStatus"]) {
    assert.ok(details.contains(page.$(id)), `${id} 应在 syncDetails 里`);
  }
  for (const id of ["clearCache", "cacheRegenCount", "cacheKeepCount"]) {
    assert.equal(details.contains(page.$(id)), false, `${id} 不随同步开关隐藏`);
  }

  assert.equal(details.classList.contains("hidden"), true);
  page.$("syncToggle").click();
  assert.equal(details.classList.contains("hidden"), false);
  assert.equal(page.$("syncToggle").getAttribute("aria-pressed"), "true");
  page.$("syncToggle").click();
  assert.equal(details.classList.contains("hidden"), true);

  const opened = await openOptions({ sync: { syncOn: true }, handlers: { GET_CACHE_USAGE: () => usageOf() } });
  assert.equal(opened.$("syncDetails").classList.contains("hidden"), false);
});

test("设置页数据同步：同步内容是 4 个 chip，「转写与改字」读写的仍是 syncSubs（默认开），说明放在悬停提示里", async () => {
  const page = await openOptions({ sync: { syncOn: true }, handlers: { GET_CACHE_USAGE: () => usageOf() } });
  const chips = page.document.querySelector(".chips").querySelectorAll("button");
  assert.deepEqual(chips.map((el) => el.id), ["syncMarks", "syncConfig", "syncSubs", "syncKeys"]);
  assert.deepEqual(chips.map((el) => el.textContent), ["✓ 标记", "✓ 设置", "✓ 转写与改字", "API Key"]);
  const subs = page.$("syncSubs");
  assert.equal(subs.title, "只上传转写生成和改过字的字幕，打开视频时按需下载");
  assert.equal(subs.classList.contains("on"), true, "没存过 syncSubs 时默认开");
  assert.equal(subs.getAttribute("aria-pressed"), "true");

  subs.click();
  assert.equal(subs.textContent, "转写与改字");
  assert.equal(subs.classList.contains("on"), false);
  assert.equal(subs.getAttribute("aria-pressed"), "false");
  page.$("saveSettings").click();
  await flush();
  assert.equal(page.syncStore.syncSubs, false, "关掉后写回的是原来的 syncSubs 键");

  // 已存 syncSubs:false 的用户打开设置页：chip 显示关，再点一次写回 true
  const off = await openOptions({ sync: { syncOn: true, syncSubs: false }, handlers: { GET_CACHE_USAGE: () => usageOf() } });
  assert.equal(off.$("syncSubs").textContent, "转写与改字");
  off.$("syncSubs").click();
  assert.equal(off.$("syncSubs").textContent, "✓ 转写与改字");
  off.$("saveSettings").click();
  await flush();
  assert.equal(off.syncStore.syncSubs, true);

  // API Key：勾选后才显示明文提醒
  assert.equal(page.$("syncKeysWarn").classList.contains("hidden"), true);
  page.$("syncKeys").click();
  assert.equal(page.$("syncKeys").textContent, "✓ API Key");
  assert.equal(page.$("syncKeysWarn").classList.contains("hidden"), false);
  assert.equal(page.$("syncKeysWarn").textContent, "Key 将明文存入网盘，请确认只有你能访问");
});

test("设置页本地字幕缓存：分母与进度条按后台返回的上限计算，页面不写死 40 / 6 MB", async () => {
  const bytes = Math.round(0.27 * MB);
  const page = await openOptions({
    handlers: {
      GET_CACHE_USAGE: () => usageOf({ videos: 9, bytes, maxVideos: 50, maxBytes: 8 * MB, keptVideos: 10, keptBytes: Math.round(1.13 * MB) })
    }
  });
  assert.equal(page.sent("GET_CACHE_USAGE").length, 1, "落在「数据同步」时统计一次");
  assert.equal(page.$("cacheRegenCount").textContent, "9 / 50");
  assert.equal(page.$("cacheRegenCount").querySelector(".cache-den").textContent, " / 50");
  assert.equal(page.$("cacheRegenSize").textContent, "0.27 / 8 MB");
  assert.equal(pct(page.$("cacheRegenCountBar")), 18);
  assert.ok(Math.abs(pct(page.$("cacheRegenSizeBar")) - 0.27 / 8 * 100) < 0.01);
  assert.equal(page.$("cacheKeepCount").textContent, "10");
  assert.equal(page.$("cacheKeepSize").textContent, "1.13 MB");
  assert.equal(page.$("clearCache").disabled, false);

  // 后台没给上限：只写数字，不猜分母，进度条为空
  const bare = await openOptions({ handlers: { GET_CACHE_USAGE: () => usageOf({ videos: 3, bytes }) } });
  assert.equal(bare.$("cacheRegenCount").textContent, "3");
  assert.equal(bare.$("cacheRegenSize").textContent, "0.27 MB");
  assert.equal(pct(bare.$("cacheRegenCountBar")), 0);

  // 超过上限时进度条封顶
  const over = await openOptions({ handlers: { GET_CACHE_USAGE: () => usageOf({ videos: 45, bytes: 7 * MB, maxVideos: 40, maxBytes: 6 * MB }) } });
  assert.equal(pct(over.$("cacheRegenCountBar")), 100);
  assert.equal(over.$("cacheRegenSize").textContent, "7.00 / 6 MB");

  // 页面源码里没有写死上限
  const html = read("options.html");
  const section = html.slice(html.indexOf("<h2>本地缓存"), html.indexOf("</section>", html.indexOf("<h2>本地缓存")));
  assert.doesNotMatch(section, /\b40\b|6 MB/);
  assert.doesNotMatch(read("options.js"), /\/ 40|6 MB|6 \* 1024 \* 1024/);

  // 读取失败：数字处写「读取失败」，清理不可点
  const failed = await openOptions({ handlers: { GET_CACHE_USAGE: () => ({ error: "无权调用" }) } });
  assert.equal(failed.$("cacheRegenCount").textContent, "读取失败");
  assert.equal(failed.$("cacheRegenCount").title, "无权调用");
  assert.equal(failed.$("clearCache").disabled, true);
});

test("设置页本地字幕缓存：单击「清理」直接执行，进行中禁用，完成后轻提示并刷新两张卡片", async () => {
  let release;
  const page = await openOptions({
    handlers: {
      GET_CACHE_USAGE: () => usageOf({ videos: 9, bytes: 3 * MB, maxVideos: 40, maxBytes: 6 * MB, keptVideos: 10, keptBytes: MB }),
      CLEAR_RENEWABLE_CACHE: () => new Promise((resolve) => { release = resolve; })
    }
  });
  const btn = page.$("clearCache");
  const toast = page.$("toast");
  assert.equal(btn.textContent, "清理");
  assert.equal(page.$("cacheRegenCount").textContent, "9 / 40");
  assert.equal(pct(page.$("cacheRegenSizeBar")), 50);

  btn.click();
  assert.equal(page.sent("CLEAR_RENEWABLE_CACHE").length, 1, "单击就发出清理，不再要求连点两次");
  assert.equal(btn.disabled, true, "清理进行中禁用");
  assert.equal(btn.textContent, "清理");
  btn.click();
  assert.equal(page.sent("CLEAR_RENEWABLE_CACHE").length, 1, "进行中再点不重复发");

  release({ ok: true, removed: 9, bytes: 3 * MB, skipped: 0, usage: usageOf({ videos: 0, bytes: 0, maxVideos: 40, maxBytes: 6 * MB, keptVideos: 10, keptBytes: MB }) });
  await flush();
  assert.equal(page.$("cacheRegenCount").textContent, "0 / 40");
  assert.equal(page.$("cacheRegenSize").textContent, "0 / 6 MB");
  assert.equal(pct(page.$("cacheRegenCountBar")), 0);
  assert.equal(pct(page.$("cacheRegenSizeBar")), 0);
  assert.equal(page.$("cacheKeepCount").textContent, "10", "转写与改字不受影响");
  assert.equal(page.$("cacheKeepSize").textContent, "1.00 MB");
  assert.equal(btn.disabled, true, "没有可清理的内容时置灰");
  assert.equal(toast.classList.contains("hidden"), false);
  assert.equal(toast.textContent, "已清理可重新获取的字幕");
  page.runTimers();
  assert.equal(toast.classList.contains("hidden"), true, "轻提示到时消失");

  // 正在转写或翻译的视频照旧跳过：提示里说明，按钮仍可点
  const busy = await openOptions({
    handlers: {
      GET_CACHE_USAGE: () => usageOf({ videos: 3, bytes: MB, maxVideos: 40, maxBytes: 6 * MB }),
      CLEAR_RENEWABLE_CACHE: () => ({ ok: true, removed: 2, bytes: MB / 2, skipped: 1, usage: usageOf({ videos: 1, bytes: MB / 2, maxVideos: 40, maxBytes: 6 * MB }) })
    }
  });
  busy.$("clearCache").click();
  await flush();
  assert.equal(busy.$("toast").textContent, "已清理可重新获取的字幕；1 个视频正在转写或翻译，稍后再清");
  assert.equal(busy.$("cacheRegenCount").textContent, "1 / 40");
  assert.equal(busy.$("clearCache").disabled, false);

  // 清理失败：提示原因，按钮恢复
  const failing = await openOptions({
    handlers: {
      GET_CACHE_USAGE: () => usageOf({ videos: 2, bytes: MB, maxVideos: 40, maxBytes: 6 * MB }),
      CLEAR_RENEWABLE_CACHE: () => ({ error: "存储不可用" })
    }
  });
  failing.$("clearCache").click();
  await flush();
  assert.equal(failing.$("toast").textContent, "清理失败：存储不可用");
  assert.equal(failing.$("clearCache").disabled, false);
  assert.equal(failing.$("cacheRegenCount").textContent, "2 / 40");
});

test("设置页数据同步：旧结构已移除（同步内容标题、路径列表、过时说明、旧缓存 id 与确认逻辑）", () => {
  const html = read("options.html");
  const js = read("options.js");
  for (const id of ["cacheRenewable", "cacheProtected", "clearRenewable", "cacheStatus", "syncSubsNote", "syncKeysNote"]) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`), id);
    assert.doesNotMatch(js, new RegExp(`\\$\\("${id}"\\)`), id);
  }
  assert.doesNotMatch(html, /同步内容|\/bilicaption\/(config\.json|marks|subs)|只存在本机|dav-paths|设置（服务商/);
  assert.doesNotMatch(js, /再点一次确认清理|clearRenewableArmed|设置（服务商/);
  assert.doesNotMatch(read("options.css"), /\.dav-paths|\.cache-usage|\.cache-line|\.cache-name/);
  // 缓存区标题旁不再有「?」，两张卡片的标题各带悬停说明，右卡角标
  const section = html.slice(html.indexOf('<div class="hr-section">'), html.indexOf("</section>", html.indexOf('<div class="hr-section">')));
  assert.doesNotMatch(section, /class="tip"/);
  assert.match(section, /title="删掉后打开视频会免费重新读取官方字幕，译文需重新翻译；超出上限自动删除最旧的">官方字幕与译文</);
  assert.match(section, /title="花钱转写或手动改过字的字幕不会被自动删除；单个视频可在侧栏「清理缓存」中删除">转写与改字</);
  assert.match(section, /class="cache-badge">不自动清理</);
});
