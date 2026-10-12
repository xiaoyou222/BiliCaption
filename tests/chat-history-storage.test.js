const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { read, runFile, backgroundImports } = require("./source-loader.js");

const plain = (value) => JSON.parse(JSON.stringify(value));
const pair = (text = "旧问题") => [
  { id: "q", role: "user", text, at: 1 },
  { id: "a", role: "ai", text: "旧回答", at: 2 }
];
const record = (messages, revision = 1, generation = 0) => ({ messages, revision, generation, clientId: "test" });

function storageArea(seed = {}) {
  const data = plain(seed);
  const calls = [];
  return {
    data, calls, beforeSet: null, beforeRemove: null,
    async getKeys() { calls.push(["keys"]); return Object.keys(data); },
    async get(keys) {
      calls.push(["get", keys]);
      const list = keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => Object.hasOwn(data, key)).map((key) => [key, plain(data[key])]));
    },
    async set(values) {
      calls.push(["set", plain(values)]);
      await this.beforeSet?.(values);
      Object.assign(data, plain(values));
    },
    async remove(keys) {
      calls.push(["remove", keys]);
      await this.beforeRemove?.(keys);
      for (const key of [].concat(keys)) delete data[key];
    }
  };
}

function worker(local = storageArea(), session = storageArea()) {
  let listener;
  const context = { console, TextEncoder, URL, chrome: {
    storage: { local, session },
    runtime: { id: "chat-test", onMessage: { addListener(fn) { listener = fn; } } }
  }, BiliCaptionPlatforms: { isSupportedHost: (host) => host.endsWith("bilibili.com") } };
  vm.createContext(context);
  runFile(context, "background/chat-history.js");
  const source = read("background.js");
  vm.runInContext(source.slice(source.indexOf("function isExtensionPage"), source.indexOf("// ---- 启动")), context);
  vm.runInContext(source.slice(source.indexOf("chrome.runtime.onMessage.addListener")), context);
  return {
    context, local, session,
    request(type, values = {}, sender = { url: "chrome-extension://chat-test/sidepanel.html" }) {
      return new Promise((resolve, reject) => {
        try {
          if (!listener({ type, ...values }, sender, resolve)) resolve(null);
        } catch (error) { reject(error); }
      }).then(plain);
    }
  };
}

test("对话记录：只声明模块不提前读写；真实后台已加载且消息仅向扩展页开放", async () => {
  assert.ok(backgroundImports().includes("background/chat-history.js"));
  const w = worker();
  assert.equal(w.local.calls.length + w.session.calls.length, 0);
  for (const type of ["CHAT_HISTORY_READ", "CHAT_HISTORY_WRITE", "CHAT_HISTORY_CLEAR", "CLEAR_CHAT_HISTORY", "GET_CHAT_HISTORY_USAGE"]) {
    const reply = await w.request(type, { key: "chat:V:1" }, { url: "https://www.bilibili.com/video/BV1", tab: { id: 1 } });
    assert.equal(reply.error, "无权调用");
  }
  assert.equal(w.local.calls.length + w.session.calls.length, 0);
  assert.equal((await w.request("CHAT_HISTORY_READ", { key: "chat:V:1" })).revision, 0);
});

test("迁移：一次导入全部 session 对话，本地已有记录和空记录优先，其他数据不动", async () => {
  const local = storageArea({ "chat:V:2": record(pair("本机问题"), 3), "chat:V:3": record([], 9), "asr:V:1": { cues: [1] } });
  const session = storageArea({ "chat:V:1": pair(), "chat:V:2": pair("过期问题"), "chat:V:3": pair("已清空问题"), ephemeral: "保留" });
  const w = worker(local, session);
  assert.deepEqual((await w.request("CHAT_HISTORY_READ", { key: "chat:V:1" })).messages, pair());
  assert.equal(local.data["chat:V:2"].messages[0].text, "本机问题");
  assert.deepEqual(local.data["chat:V:3"].messages, []);
  assert.deepEqual(session.data, { ephemeral: "保留" });
  assert.deepEqual(local.data["asr:V:1"], { cues: [1] });
});

test("迁移写失败保留 session，下次可重试；旧浏览器没有 getKeys 也可迁移", async () => {
  const local = storageArea();
  const session = storageArea({ "chat:V:1": pair() });
  session.getKeys = undefined;
  let fail = true;
  local.beforeSet = async () => { if (fail) { fail = false; throw new Error("磁盘写入失败"); } };
  const w = worker(local, session);
  assert.equal((await w.request("CHAT_HISTORY_READ", { key: "chat:V:1" })).error, "磁盘写入失败");
  assert.ok(session.data["chat:V:1"]);
  assert.equal((await w.request("CHAT_HISTORY_READ", { key: "chat:V:1" })).messages.length, 2);
  assert.equal(session.data["chat:V:1"], undefined);
});

test("本地长期保存：重启后恢复、分 P 和平台隔离；不按日期或 60 条裁剪", async () => {
  const w = worker();
  const messages = Array.from({ length: 100 }, (_, i) => ({ id: String(i), role: i % 2 ? "ai" : "user", text: `消息${i}`, at: 1 }));
  for (const key of ["chat:V:1", "chat:V:2", "chat:yt_V:1", "chat:x_V:1", "chat:article:https://example.com/a"]) {
    const saved = await w.request("CHAT_HISTORY_WRITE", { key, messages, revision: 0, generation: 0, clientId: "old-panel" });
    assert.equal(saved.ok, true);
  }
  const reopened = worker(w.local, storageArea());
  assert.deepEqual((await reopened.request("CHAT_HISTORY_READ", { key: "chat:V:1" })).messages, messages);
  assert.equal((await reopened.request("GET_CHAT_HISTORY_USAGE")).count, 5);
  const cleared = await reopened.request("CHAT_HISTORY_CLEAR", { key: "chat:V:2" });
  assert.equal(cleared.revision, 2);
  assert.equal((await reopened.request("CHAT_HISTORY_READ", { key: "chat:V:1" })).messages.length, 100);
});

test("同时写同一视频：只有一份旧版本写入成功，另一份返回最新记录供前端处理", async () => {
  const w = worker();
  const [a, b] = await Promise.all([
    w.request("CHAT_HISTORY_WRITE", { key: "chat:V:1", messages: pair("侧栏问题"), revision: 0, generation: 0, clientId: "sidebar" }),
    w.request("CHAT_HISTORY_WRITE", { key: "chat:V:1", messages: pair("浮窗问题"), revision: 0, generation: 0, clientId: "float" })
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.conflict, true);
  assert.equal(b.messages[0].text, "侧栏问题");
  assert.equal(w.local.data["chat:V:1"].messages[0].text, "侧栏问题");
});

test("单条清空保留空版本：在途写先完成再清空，旧页面迟到回答不能复活", async () => {
  const w = worker();
  let release;
  let entered;
  const blocked = new Promise((resolve) => { entered = resolve; });
  w.local.beforeSet = async (values) => {
    if (values["chat:V:1"]?.messages.length) {
      entered();
      await new Promise((resolve) => { release = resolve; });
    }
  };
  const write = w.request("CHAT_HISTORY_WRITE", { key: "chat:V:1", messages: pair(), revision: 0, generation: 0 });
  await blocked;
  const clear = w.request("CHAT_HISTORY_CLEAR", { key: "chat:V:1", clientId: "clearer" });
  release();
  await write;
  assert.equal((await clear).revision, 2);
  const late = await w.request("CHAT_HISTORY_WRITE", { key: "chat:V:1", messages: pair("迟到回答"), revision: 1, generation: 0 });
  assert.equal(late.conflict, true);
  assert.deepEqual(late.messages, []);
  assert.deepEqual(w.local.data["chat:V:1"].messages, []);
});

test("清空全部更换持久世代：重启后拒绝旧页面、仅删除对话、旧 session 不再导入", async () => {
  const local = storageArea({ "chat:V:1": record(pair()), "chat:V:2": record([]), "article:v1:url": { summary: "保留" }, apiKey: "保留", "marks:V:1": [1] });
  const w = worker(local);
  const cleared = await w.request("CLEAR_CHAT_HISTORY", { clientId: "settings" });
  assert.deepEqual(cleared, { ok: true, count: 1 });
  assert.deepEqual(local.data.chatHistoryState, { generation: 1, clientId: "settings" });
  assert.equal(Object.keys(local.data).some((key) => key.startsWith("chat:")), false);
  assert.equal(local.data.apiKey, "保留");
  assert.deepEqual(local.data["marks:V:1"], [1]);
  assert.deepEqual(local.data["article:v1:url"], { summary: "保留" });
  const reopened = worker(local, storageArea({ "chat:V:1": pair("迟来的 session") }));
  const late = await reopened.request("CHAT_HISTORY_WRITE", { key: "chat:V:1", messages: pair(), revision: 0, generation: 0 });
  assert.equal(late.conflict, true);
  assert.equal(late.generation, 1);
  assert.deepEqual(late.messages, []);
  assert.equal(reopened.session.data["chat:V:1"], undefined);
  assert.equal((await reopened.request("CHAT_HISTORY_WRITE", { key: "chat:V:1", messages: pair("新的对话"), revision: 0, generation: 1 })).ok, true);
});

test("清空全部后删除中断：旧物理记录不再可读，重启与统计也看不到旧代", async () => {
  const local = storageArea({ "chat:V:1": record(pair()) });
  const w = worker(local);
  local.beforeRemove = async () => { throw new Error("模拟清理中断"); };
  assert.equal((await w.request("CLEAR_CHAT_HISTORY")).error, "模拟清理中断");
  assert.ok(local.data["chat:V:1"]);
  assert.equal(local.data.chatHistoryState.generation, 1);
  const reopened = worker(local);
  assert.deepEqual((await reopened.request("CHAT_HISTORY_READ", { key: "chat:V:1" })).messages, []);
  assert.deepEqual(await reopened.request("GET_CHAT_HISTORY_USAGE"), { count: 0, messages: 0, bytes: 0 });
});

test("清空全部已入队时后续旧写请求被世代拒绝，清空后新版本正常保存", async () => {
  const w = worker(storageArea({ "chat:V:1": record(pair()) }));
  const [cleared, late] = await Promise.all([
    w.request("CLEAR_CHAT_HISTORY"),
    w.request("CHAT_HISTORY_WRITE", { key: "chat:V:1", messages: pair("旧内容"), revision: 1, generation: 0 })
  ]);
  assert.equal(cleared.ok, true);
  assert.equal(late.conflict, true);
  assert.deepEqual(late.messages, []);
  const saved = await w.request("CHAT_HISTORY_WRITE", { key: "chat:V:1", messages: pair("新内容"), revision: late.revision, generation: late.generation });
  assert.equal(saved.ok, true);
});

test("统计只算当前世代非空对话；无效 key 或数据不会误写其他设置", async () => {
  const w = worker(storageArea({ "chat:V:1": record(pair()), "chat:V:2": record([]), "asr:V:1": { cues: [1] } }));
  const usage = await w.request("GET_CHAT_HISTORY_USAGE");
  assert.equal(usage.count, 1);
  assert.equal(usage.messages, 2);
  assert.ok(usage.bytes > 0);
  assert.match((await w.request("CHAT_HISTORY_WRITE", { key: "apiKey", messages: [], revision: 0, generation: 0 })).error, /标识无效/);
  assert.match((await w.request("CHAT_HISTORY_WRITE", { key: "chat:V:3", messages: "不是数组", revision: 0, generation: 0 })).error, /格式无效/);
  assert.equal(w.local.data.apiKey, undefined);
});

test("隔离：对话和清空世代不触发 WebDAV，同步设置的实际载荷不包含对话", () => {
  const w = worker();
  runFile(w.context, "lib/webdav.js");
  const dav = w.context.BiliCaptionDav;
  const changes = {
    "chat:V:1": { newValue: record(pair()) },
    chatHistoryState: { newValue: { generation: 1, clientId: "settings" } }
  };
  assert.equal(dav.shouldSyncOnChange(changes, "local"), false);
  const payload = dav.configPayload({ ...changes, apiBase: "https://example.com/v1", syncKeys: true });
  assert.equal(Object.hasOwn(payload, "chat:V:1"), false);
  assert.equal(Object.hasOwn(payload, "chatHistoryState"), false);
  assert.equal(payload.apiBase, "https://example.com/v1");
});

test("隔离：清理本视频、官方字幕及文章自动淘汰均不删除长期对话", async () => {
  const local = storageArea({
    "chat:V:1": record(pair()),
    chatHistoryState: { generation: 0, clientId: "" },
    "asr:V:1": { cues: [{ content: "字幕" }], origin: "official" },
    "outline:v2:V:1": { summary: "摘要" },
    "asr:V:2": { cues: [{ content: "第二 P" }], origin: "official" }
  });
  for (let i = 0; i < 101; i += 1) local.data[`article:v1:${i}`] = { generatedAt: i, summary: "摘要" };
  const w = worker(local);
  Object.assign(w.context, {
    appLog() {},
    utf8Size: (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength,
    asrCacheWrites: new Map(),
    findAsrJob: () => null,
    findTranslateJob: () => null,
    translateJobStoreKey: (bvid, cid) => `translate:${bvid}:${cid}`,
    TRANSLATE_INDEX_KEY: "translateIndex",
    updateTranslateIndex: async () => {}
  });
  runFile(w.context, "lib/subtitle-tools.js");
  runFile(w.context, "lib/webdav.js");
  runFile(w.context, "background/cache.js");
  await w.context.clearVideoCache("V", 1);
  assert.equal(local.data["asr:V:1"], undefined);
  assert.equal(local.data["outline:v2:V:1"], undefined);
  const cleared = await w.context.clearRenewableSubtitleCache();
  assert.equal(cleared.removed, 1);
  const pruned = await w.context.pruneArticleCache();
  assert.equal(pruned.removed, 1);
  await w.context.pruneAuxCache();
  assert.deepEqual(local.data["chat:V:1"].messages, pair());
  assert.deepEqual(local.data.chatHistoryState, { generation: 0, clientId: "" });
});
