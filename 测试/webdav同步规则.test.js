const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadBackgroundScripts } = require("./源码加载.js");

function loadDav() {
  const context = {
    console,
    chrome: {
      storage: { local: { async get() { return {}; }, async set() {} } },
      permissions: { async request() {} }
    },
    btoa: (s) => Buffer.from(s, "binary").toString("base64")
  };
  context.self = context;
  context.window = context;
  context.global = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "lib/webdav.js"), "utf8"), context);
  return context.BiliCaptionDav;
}

test("集合目录补尾斜杠，避免 MKCOL 被 301 到 http", () => {
  const D = loadDav();
  assert.equal(D.collectionPath(""), "");
  assert.equal(D.collectionPath("marks"), "marks/");
  assert.equal(D.collectionPath("/marks/"), "marks/");
  assert.equal(
    D.joinUrl("https://bili.xiaoyou.love/bilicaption/", D.collectionPath("marks")),
    "https://bili.xiaoyou.love/bilicaption/marks/"
  );
});

test("同步时间按时间戳现算，不会永远停在刚刚", () => {
  const D = loadDav();
  assert.equal(D.formatSyncAgo(0), "");
  assert.equal(D.formatSyncAgo(Date.now() - 20 * 1000), "刚刚");
  assert.equal(D.formatSyncAgo(Date.now() - 5 * 60 * 1000), "5 分钟前");
  assert.equal(D.formatSyncAgo(Date.now() - 3 * 60 * 60 * 1000), "3 小时前");
});

test("本地改过、云端没动则上传", () => {
  const D = loadDav();
  assert.equal(D.decideSync(200, 100, 100), "push");
});

test("云端较新、本地没改则下载", () => {
  const D = loadDav();
  assert.equal(D.decideSync(100, 200, 100), "pull");
});

test("都没超过上次同步则跳过", () => {
  const D = loadDav();
  assert.equal(D.decideSync(100, 100, 100), "skip");
});

test("两边都改过则较新的赢", () => {
  const D = loadDav();
  assert.equal(D.decideSync(300, 250, 100), "conflict-push");
  assert.equal(D.decideSync(250, 300, 100), "conflict-pull");
});

test("未勾选同步 API Key 时转写通道的 key 不上云", () => {
  const D = loadDav();
  const payload = D.configPayload({
    sttChannels: [{ provider: "Groq", key: "gsk_secret", model: "whisper-large-v3-turbo" }],
    apiKey: "sk-sum",
    backupKey: "sk-bak",
    sttCreds: { Groq: { key: "gsk_secret" } },
    syncKeys: false
  });
  assert.equal(payload.sttChannels[0].key, "");
  assert.equal(payload.sttChannels[0].provider, "Groq");
  assert.equal(payload.apiKey, undefined);
  assert.equal(payload.backupKey, undefined);
  assert.equal(payload.sttCreds, undefined);
});

test("勾选同步 API Key 时转写通道的 key 保留", () => {
  const D = loadDav();
  const payload = D.configPayload({
    sttChannels: [{ provider: "Groq", key: "gsk_secret", model: "whisper-large-v3-turbo" }],
    apiKey: "sk-sum",
    syncKeys: true
  });
  assert.equal(payload.sttChannels[0].key, "gsk_secret");
  assert.equal(payload.apiKey, "sk-sum");
});

test("回拉配置时未勾选同步 Key 会清掉通道里的 key", () => {
  const D = loadDav();
  const cleaned = D.stripChannelKeys([
    { provider: "Groq", key: "gsk_secret", model: "w" },
    { provider: "Fish Audio", key: "sk-fish", off: true }
  ]);
  assert.equal(cleaned[0].key, "");
  assert.equal(cleaned[1].key, "");
  assert.equal(cleaned[1].off, true);
});

test("回收站两边各删一条时合并保留", () => {
  const D = loadDav();
  const merged = D.mergeTrash(
    [{ id: "a", deletedAt: 180 }],
    [{ id: "b", deletedAt: 190 }],
    200,
    210,
    100
  );
  assert.equal(merged.map((item) => item.id).sort().join(","), "a,b");
});

test("这边恢复后，另一边未改过的回收站条目不再加回来", () => {
  const D = loadDav();
  const merged = D.mergeTrash(
    [],
    [{ id: "old", deletedAt: 80 }],
    200,
    90,
    100
  );
  assert.equal(merged.length, 0);
});

test("只有真正会上传的键才触发自动同步：透明度、浮窗位置、字幕语言不触发", () => {
  const Dav = loadDav();
  const change = (keys, extra = {}) => Object.fromEntries(keys.map((key) => [key, { newValue: extra[key] ?? 1 }]));
  for (const key of ["dockAlpha", "dockGeomPage", "dockGeomFull", "dockOpen", "preferSidebar", "captionLang", "overlayOn", "davLast", "davAt"]) {
    assert.equal(Dav.shouldSyncOnChange(change([key]), "sync"), false, key);
  }
  for (const key of ["davConfigAt", "syncMarks", "syncConfig", "syncKeys", "davUrl", "davUser"]) {
    assert.equal(Dav.shouldSyncOnChange(change([key]), "sync"), true, key);
  }
  assert.equal(Dav.shouldSyncOnChange(change(["syncOn"], { syncOn: true }), "sync"), true);
  assert.equal(Dav.shouldSyncOnChange(change(["syncOn", "davConfigAt"], { syncOn: false }), "sync"), false);
  for (const key of ["markerIndex", "markerTrash", "marks:BV1:2", "davPass"]) {
    assert.equal(Dav.shouldSyncOnChange(change([key]), "local"), true, key);
  }
  for (const key of ["asr:BV1:2", "outline:v2:BV1:2", "appLogs", "davSyncMeta", "lastVideo"]) {
    assert.equal(Dav.shouldSyncOnChange(change([key]), "local"), false, key);
  }
  assert.equal(Dav.shouldSyncOnChange(change(["marks:BV1:2"]), "session"), false);
});

test("防抖定时器跑完就清掉兜底 alarm，一次改动只同步一次", () => {
  const timers = [];
  const alarms = { created: [], cleared: [], listener: null };
  const noop = { addListener() {} };
  const context = {
    console, URL, TextEncoder, TextDecoder, AbortController, AbortSignal,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout() {},
    setInterval() { return 0; },
    clearInterval() {},
    importScripts() {},
    fetch: async () => { throw new Error("不应联网"); },
    chrome: {
      runtime: { id: "t", onInstalled: noop, onStartup: noop, onMessage: noop, async sendMessage() {} },
      sidePanel: { async setPanelBehavior() {}, async setOptions() {} },
      tabs: { query(_q, cb) { cb?.([]); return Promise.resolve([]); } },
      declarativeNetRequest: { async updateDynamicRules() {} },
      storage: { local: { async get() { return {}; }, async set() {}, async remove() {} } },
      alarms: {
        create: (name, info) => alarms.created.push({ name, info }),
        clear: async (name) => { alarms.cleared.push(name); return true; },
        onAlarm: { addListener: (fn) => { alarms.listener = fn; } }
      }
    },
    BiliCaptionPrefs: { async loadSettings(defaults) { return { ...defaults }; }, async saveSettings() {} }
  };
  context.self = context;
  vm.createContext(context);
  loadBackgroundScripts(context, ["lib/视频平台.js", "lib/webdav.js"]);
  const before = timers.length;
  context.scheduleDavSync();
  assert.equal(alarms.created.at(-1).name, "dav-sync-soon");
  assert.ok(alarms.created.at(-1).info.when - Date.now() >= 29000);
  timers[before]();
  assert.deepEqual(alarms.cleared, ["dav-sync-soon"]);
});
