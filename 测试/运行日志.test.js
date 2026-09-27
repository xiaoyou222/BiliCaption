const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { loadBackgroundScripts } = require("./源码加载.js");

// 运行日志的分级保留（后台/基础.js）：异常（错误 + 警告）留 7 天、最多 200 条；信息留 24 小时、最多 100 条。
// 按真实加载顺序执行后台，chrome.storage 换成内存对象；计时器和 Date 走外层，由 t.mock.timers 接管。

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;
const PANEL = { url: "chrome-extension://test-extension/options.html", id: "test-extension" };

function storageArea(store, writes) {
  return {
    async get(keys) {
      if (keys == null) return { ...store };
      if (typeof keys === "string") return Object.hasOwn(store, keys) ? { [keys]: store[keys] } : {};
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => Object.hasOwn(store, key)).map((key) => [key, store[key]]));
      const out = { ...keys };
      for (const key of Object.keys(keys || {})) if (Object.hasOwn(store, key)) out[key] = store[key];
      return out;
    },
    async set(values) {
      writes?.push(Object.keys(values || {}));
      Object.assign(store, JSON.parse(JSON.stringify(values || {})));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
    },
    async setAccessLevel() {}
  };
}

function loadLogs(local = {}) {
  const writes = [];
  const listeners = [];
  const noopEvent = { addListener() {} };
  const context = {
    console: { ...console, log() {}, warn() {} },
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Blob,
    AbortController,
    AbortSignal,
    DOMException,
    Date: globalThis.Date,
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: (...args) => globalThis.clearTimeout(...args),
    setInterval: (...args) => globalThis.setInterval(...args),
    clearInterval: (...args) => globalThis.clearInterval(...args),
    fetch: () => Promise.reject(new Error("不应请求网络")),
    importScripts() {},
    chrome: {
      runtime: {
        id: "test-extension",
        onInstalled: noopEvent,
        onStartup: noopEvent,
        onMessage: { addListener(fn) { listeners.push(fn); } },
        async sendMessage() {},
        getURL(file) { return `chrome-extension://test-extension/${file}`; },
        async getContexts() { return []; },
        lastError: null,
        async getPlatformInfo() { return {}; }
      },
      sidePanel: { async setPanelBehavior() {}, async setOptions() {}, async open() {} },
      tabs: {
        query(_query, callback) {
          if (callback) callback([]);
          return Promise.resolve([]);
        },
        async sendMessage() {},
        async get() { throw new Error("no tab"); },
        onRemoved: noopEvent
      },
      declarativeNetRequest: { async updateDynamicRules() {} },
      storage: {
        local: storageArea(local, writes),
        session: storageArea({}),
        sync: storageArea({})
      }
    },
    BiliCaptionPrefs: { async loadSettings(defaults) { return { ...defaults }; } }
  };
  context.self = context;
  vm.createContext(context);
  loadBackgroundScripts(context, ["lib/视频平台.js", "lib/字幕工具.js", "lib/providers.js"]);
  context.__local = local;
  context.__writes = writes;
  context.__listeners = listeners;
  return context;
}

const flush = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function route(B, message, sender = PANEL) {
  return new Promise((resolve) => {
    const handled = B.__listeners[0](message, sender, resolve);
    if (handled !== true) resolve({ ignored: true });
  });
}

const count = (logs, level) => logs.filter((entry) => entry.level === level).length;
// vm 里的数组、对象原型和外层不同，比较前转成普通 JSON
const plain = (value) => JSON.parse(JSON.stringify(value));
const messages = (logs) => plain(logs.map((entry) => entry.message));
const logWrites = (B) => B.__writes.filter((keys) => keys.includes("appLogs")).length;

test("分级保留：普通信息超过 100 条时只留最新 100 条，错误和警告一条都不会被挤掉", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const B = loadLogs();
  await B.appLog("error", "asr", "最早的一条错误", { status: 500, bvid: "BV1", cid: 2 });
  await B.appLog("warn", "bili", "最早的一条警告");
  for (let i = 1; i <= 250; i += 1) await B.appLog("info", "asr", `信息 ${i}`);
  const logs = await B.getAppLogs();
  assert.equal(count(logs, "info"), 100);
  assert.equal(count(logs, "error"), 1);
  assert.equal(count(logs, "warn"), 1);
  assert.equal(logs[0].message, "最早的一条错误", "异常仍按时间排在最前");
  assert.equal(logs[0].detail, JSON.stringify({ status: 500, bvid: "BV1", cid: 2 }), "错误的状态码、bvid/cid 原样保留");
  assert.equal(logs.find((entry) => entry.level === "info").message, "信息 151", "信息只留最新 100 条");
  assert.equal(logs.at(-1).message, "信息 250");
});

test("分级保留：错误和警告合计最多 200 条，超出时去掉最旧的", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const B = loadLogs();
  for (let i = 1; i <= 230; i += 1) await B.appLog(i % 2 ? "warn" : "error", "asr", `异常 ${i}`);
  await B.appLog("info", "dav", "一条信息");
  const logs = await B.getAppLogs();
  assert.equal(count(logs, "warn") + count(logs, "error"), 200);
  assert.equal(logs[0].message, "异常 31");
  assert.equal(count(logs, "info"), 1, "异常再多也不占信息的名额");
});

test("过期按级别清理：信息 24 小时后删除，错误和警告保留到 7 天，裁剪结果写回存储", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const B = loadLogs();
  await B.appLog("info", "dav", "同步完成");
  await B.appLog("warn", "asr", "限流冷却");
  await B.appLog("error", "asr", "转写失败");
  t.mock.timers.tick(400);
  await flush();
  assert.equal(B.__local.appLogs.length, 3);

  t.mock.timers.tick(DAY);
  let logs = await B.getAppLogs();
  assert.deepEqual(messages(logs), ["限流冷却", "转写失败"], "信息过了 24 小时就不再返回");
  t.mock.timers.tick(400);
  await flush();
  assert.deepEqual(messages(B.__local.appLogs), ["限流冷却", "转写失败"], "读取时裁掉的也写回存储");

  t.mock.timers.tick(6 * DAY - 1000);
  logs = await B.getAppLogs();
  assert.equal(logs.length, 2, "7 天之内异常都在");
  t.mock.timers.tick(2000);
  logs = await B.getAppLogs();
  assert.equal(logs.length, 0, "过了 7 天异常也清掉");

  // 写入时同样按时间裁剪
  await B.appLog("info", "set", "新的一条");
  t.mock.timers.tick(400);
  await flush();
  assert.deepEqual(messages(B.__local.appLogs), ["新的一条"]);
});

test("旧版单数组日志：首次读取时按新规则迁移（过期的去掉、各级分别限量），并写回存储", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const old = [];
  // 旧版按条数保留的 200 条：8 天前的错误、3 天前的警告、25 小时前的信息、最近一小时的大量信息
  for (let i = 0; i < 2; i += 1) old.push({ t: NOW - 8 * DAY + i, level: "error", scope: "asr", message: `8 天前错误 ${i}`, detail: "" });
  for (let i = 0; i < 3; i += 1) old.push({ t: NOW - 3 * DAY + i, level: "warn", scope: "bili", message: `3 天前警告 ${i}`, detail: "" });
  for (let i = 0; i < 5; i += 1) old.push({ t: NOW - 25 * HOUR + i, level: "info", scope: "dav", message: `昨天的信息 ${i}`, detail: "" });
  for (let i = 0; i < 189; i += 1) old.push({ t: NOW - HOUR + i * 1000, level: "info", scope: "asr", message: `上传第 ${i} 段`, detail: "" });
  old.push(null);
  assert.equal(old.length, 200);
  const B = loadLogs({ appLogs: old });

  const logs = await B.getAppLogs();
  assert.equal(count(logs, "error"), 0, "8 天前的错误过期");
  assert.deepEqual(messages(logs.filter((entry) => entry.level === "warn")), ["3 天前警告 0", "3 天前警告 1", "3 天前警告 2"]);
  assert.equal(count(logs, "info"), 100);
  assert.ok(!logs.some((entry) => /昨天的信息/.test(entry.message)), "25 小时前的信息过期");
  assert.equal(logs.find((entry) => entry.level === "info").message, "上传第 89 段", "信息只留最新 100 条");
  assert.equal(logs.length, 103);

  t.mock.timers.tick(400);
  await flush();
  assert.deepEqual(plain(B.__local.appLogs), plain(logs), "迁移结果写回同一个键");
});

test("GET_LOGS 返回裁剪后的日志和保留规则；CLEAR_LOGS 清空", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const stale = [
    { t: NOW - 2 * DAY, level: "info", scope: "dav", message: "前天的信息", detail: "" },
    { t: NOW - 2 * DAY, level: "warn", scope: "dav", message: "前天的警告", detail: "" }
  ];
  const B = loadLogs({ appLogs: stale });
  for (let i = 0; i < 120; i += 1) await B.appLog("info", "asr", `信息 ${i}`);
  await B.appLog("error", "asr", "一条错误");
  const res = await route(B, { type: "GET_LOGS" });
  assert.equal(res.logs.length, 102);
  assert.equal(res.logs[0].message, "前天的警告");
  assert.equal(count(res.logs, "info"), 100);
  assert.ok(!res.logs.some((entry) => entry.message === "前天的信息"));
  assert.deepEqual(plain(res.keep), {
    issue: { ms: 7 * DAY, max: 200 },
    info: { ms: DAY, max: 100 }
  });

  // 设置页写日志（APPEND_LOG）也走同一套规则
  await route(B, { type: "APPEND_LOG", level: "info", scope: "set", message: "测试成功" });
  const again = await route(B, { type: "GET_LOGS" });
  assert.equal(count(again.logs, "info"), 100);
  assert.equal(again.logs.at(-1).message, "测试成功");

  assert.deepEqual(plain(await route(B, { type: "CLEAR_LOGS" })), { ok: true });
  assert.equal((await route(B, { type: "GET_LOGS" })).logs.length, 0);
  assert.equal(B.__local.appLogs.length, 0);
});

test("写入节流不变：普通信息 400ms 内合并落盘，错误立即落盘", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const B = loadLogs();
  await B.appLog("info", "dav", "第一条");
  await B.appLog("info", "dav", "第二条");
  await flush();
  assert.equal(logWrites(B), 0, "400ms 内不落盘");
  t.mock.timers.tick(400);
  await flush();
  assert.equal(logWrites(B), 1, "两条合并成一次写入");
  assert.equal(B.__local.appLogs.length, 2);

  await B.appLog("error", "asr", "出错了");
  await flush();
  assert.equal(logWrites(B), 2, "错误立即落盘");
  assert.equal(B.__local.appLogs.at(-1).message, "出错了");
});
