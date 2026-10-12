const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { runFile } = require("./source-loader.js");

// 真实运行后台持久层、窗口存储适配器和对话状态机。
// 仅替换 Chrome 传输 / 存储边界，storage.onChanged 会发给所有打开的面板。
const copy = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const flush = async () => {
  for (let i = 0; i < 15; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const CTX = { cues: [{ from: 0, to: 10, content: "这段字幕说明如何使用工具。" }] };
const KEY = "chat:BVtest:1";
const LIBS = ["lib/subtitle-tools.js", "lib/translate.js", "lib/outline.js", "lib/model-routing.js", "lib/model-call.js", "lib/subtitle-assistant.js"];

function environment(initial = {}) {
  const local = copy(initial);
  const listeners = new Set();
  const controls = { failSet: null };
  const emit = (changes, area) => {
    for (const fn of listeners) fn(copy(changes), area);
  };
  function area(store, name) {
    return {
      async get(keys) {
        if (keys == null) return copy(store);
        const wanted = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        return copy(Object.fromEntries(wanted.filter((key) => Object.hasOwn(store, key)).map((key) => [key, store[key]])));
      },
      async getKeys() { return Object.keys(store); },
      async set(values) {
        const error = name === "local" ? controls.failSet?.(values) : null;
        if (error) throw new Error(error);
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          changes[key] = { oldValue: copy(store[key]), newValue: copy(value) };
          store[key] = copy(value);
        }
        emit(changes, name);
      },
      async remove(keys) {
        const changes = {};
        for (const key of typeof keys === "string" ? [keys] : keys) {
          if (!Object.hasOwn(store, key)) continue;
          changes[key] = { oldValue: copy(store[key]) };
          delete store[key];
        }
        if (Object.keys(changes).length) emit(changes, name);
      }
    };
  }
  const chrome = { storage: { local: area(local, "local"), session: area({}, "session") } };
  const background = vm.createContext({ chrome, TextEncoder, console });
  runFile(background, "background/chat-history.js");
  const routes = {
    CHAT_HISTORY_READ: "readChatHistory",
    CHAT_HISTORY_WRITE: "writeChatHistory",
    CHAT_HISTORY_CLEAR: "clearChatHistory",
    CLEAR_CHAT_HISTORY: "clearAllChatHistory",
    GET_CHAT_HISTORY_USAGE: "getChatHistoryUsage"
  };
  const call = async (message) => {
    try { return copy(await background[routes[message.type]](copy(message))); }
    catch (error) { return { error: error.message }; }
  };
  let panelId = 0;
  function panel({ request = async () => "回答", intercept, hasConfig, onChange } = {}) {
    const context = { console, URL, TextEncoder, TextDecoder, AbortController, AbortSignal, setTimeout, clearTimeout };
    context.self = context;
    vm.createContext(context);
    for (const file of LIBS) runFile(context, file);
    const errors = [];
    const requests = [];
    const api = context.BiliCaptionChat;
    const storage = api.persistentStorage({
      clientId: `panel-${++panelId}`,
      changes: { addListener(fn) { listeners.add(fn); } },
      sendMessage: async (message) => {
        const result = await call(message);
        return intercept ? intercept(message, result) : result;
      }
    });
    const ctl = api.createChatController({
      storage,
      hasConfig,
      onChange,
      onStorageError: (error) => errors.push(error.message),
      request(args) { requests.push(args); return request(args); }
    });
    return { ctl, errors, requests, api };
  }
  return { local, controls, panel, call };
}

const texts = (ctl) => Array.from(ctl.messages, (item) => item.text);

test("持久对话整链路：等待配置时收到清空，取消发送后恢复按钮状态", async () => {
  const env = environment();
  const busyStates = [];
  let configured;
  let panel;
  panel = env.panel({
    hasConfig: () => new Promise((resolve) => { configured = resolve; }),
    onChange: () => busyStates.push(panel.ctl.busy)
  });
  await panel.ctl.open(KEY);
  const sending = panel.ctl.send("尚未开始的问题", CTX);
  await flush();
  await env.call({ type: "CLEAR_CHAT_HISTORY" });
  await flush();
  configured(true);
  assert.equal(await sending, "aborted");
  assert.equal(panel.ctl.busy, false);
  assert.equal(busyStates.at(-1), false);
  assert.equal(panel.requests.length, 0);
});

test("持久对话整链路：两个面板同步回答与清空，不同分 P 各自保存", async () => {
  const env = environment();
  const a = env.panel({ request: async () => "第一答" });
  const b = env.panel({ request: async () => "第二答" });
  await Promise.all([a.ctl.open(KEY), b.ctl.open(KEY)]);
  assert.equal(await a.ctl.send("第一问", CTX), "done");
  await flush();
  assert.deepEqual(texts(a.ctl), ["第一问", "第一答"]);
  assert.deepEqual(texts(b.ctl), ["第一问", "第一答"]);
  assert.equal(await b.ctl.send("第二问", CTX), "done");
  await flush();
  assert.deepEqual(texts(a.ctl), ["第一问", "第一答", "第二问", "第二答"]);
  assert.deepEqual(texts(b.ctl), texts(a.ctl));
  const other = env.panel();
  await other.ctl.open("chat:BVtest:2");
  await other.ctl.send("另一分 P", CTX);
  await a.ctl.clear();
  await flush();
  assert.deepEqual(texts(a.ctl), []);
  assert.deepEqual(texts(b.ctl), []);
  assert.deepEqual(texts(other.ctl), ["另一分 P", "回答"]);
  assert.equal((await env.call({ type: "GET_CHAT_HISTORY_USAGE" })).count, 1);
});

test("持久对话整链路：清空全部中止在途模型，迟到的字和回答不能复活记录", async () => {
  const env = environment();
  let release;
  const a = env.panel({ request: ({ onDelta }) => {
    onDelta("已收到的前半段");
    return new Promise((resolve) => { release = resolve; });
  } });
  const b = env.panel();
  await Promise.all([a.ctl.open(KEY), b.ctl.open(KEY)]);
  const sending = a.ctl.send("还没回答完的问题", CTX);
  await flush();
  assert.equal(a.ctl.busy, true);
  assert.equal(env.local[KEY].messages.at(-1).status, "aborted", "流式期间已保存部分回答快照");
  assert.equal((await env.call({ type: "CLEAR_CHAT_HISTORY" })).ok, true);
  await flush();
  assert.equal(a.requests[0].signal.aborted, true);
  a.requests[0].onDelta("清空后迟到的内容");
  release("清空后迟到的完整回答");
  assert.equal(await sending, "aborted");
  await flush();
  assert.deepEqual(texts(a.ctl), []);
  assert.deepEqual(texts(b.ctl), []);
  assert.equal(env.local[KEY], undefined);
  assert.equal((await env.call({ type: "GET_CHAT_HISTORY_USAGE" })).messages, 0);
});

test("持久对话整链路：清空前的慢读取返回后不能恢复旧对话", async () => {
  const env = environment({ [KEY]: [{ role: "user", text: "旧问题" }, { role: "ai", text: "旧回答" }] });
  let release;
  let held = false;
  const p = env.panel({ intercept(message, result) {
    if (message.type === "CHAT_HISTORY_READ" && !held) {
      held = true;
      return new Promise((resolve) => { release = () => resolve(result); });
    }
    return result;
  } });
  const opening = p.ctl.open(KEY);
  await flush();
  assert.equal(typeof release, "function");
  await env.call({ type: "CLEAR_CHAT_HISTORY" });
  release();
  await opening;
  await flush();
  await p.ctl.ready();
  assert.deepEqual(texts(p.ctl), []);
  assert.equal(await p.ctl.send("新的问题", CTX), "done");
  assert.deepEqual(texts(p.ctl), ["新的问题", "回答"]);
  assert.deepEqual(env.local[KEY].messages.map((item) => item.text), ["新的问题", "回答"]);
});

test("持久对话整链路：保留超过 60 条记录，重开后恢复全文，模型仅带最近 6 轮", async () => {
  const old = Array.from({ length: 35 }, (_, i) => [
    { role: "user", text: `问题${i + 1}` }, { role: "ai", text: `回答${i + 1}` }
  ]).flat();
  const env = environment({ [KEY]: old });
  const p = env.panel();
  await p.ctl.open(KEY);
  assert.equal(p.ctl.messages.length, 70);
  assert.equal(await p.ctl.send("最后一问", CTX), "done");
  assert.equal(p.ctl.messages.length, 72);
  assert.equal(env.local[KEY].messages.length, 72);
  assert.deepEqual(Array.from(p.requests[0].messages.slice(1, -1), (item) => item.content), old.slice(-12).map((item) => item.text));
  assert.equal(p.requests[0].messages.length, 14);
  const reopened = env.panel();
  await reopened.ctl.open(KEY);
  assert.deepEqual(texts(reopened.ctl), [...old.map((item) => item.text), "最后一问", "回答"]);
});

test("持久对话整链路：问题保存失败会提示，且不调用模型或伪造已保存记录", async () => {
  const env = environment();
  const p = env.panel();
  await p.ctl.open(KEY);
  env.controls.failSet = () => "磁盘写入失败";
  assert.equal(await p.ctl.send("不能保存的问题", CTX), "storage-error");
  assert.equal(p.requests.length, 0);
  assert.match(p.errors[0], /磁盘写入失败/);
  assert.equal(env.local[KEY], undefined);
  assert.equal(p.ctl.messages.at(-1).status, "error");
  assert.equal(p.ctl.canRetry, true);
  env.controls.failSet = null;
  assert.equal(await p.ctl.retry(CTX), "done");
  assert.deepEqual(env.local[KEY].messages.map((item) => item.text), ["不能保存的问题", "回答"]);
});

test("持久对话整链路：流式中断保存已收到部分，重开可恢复并继续提问", async () => {
  const env = environment();
  let release;
  const p = env.panel({ request: ({ onDelta }) => {
    onDelta("已经收到的部分回答");
    return new Promise((resolve) => { release = resolve; });
  } });
  await p.ctl.open(KEY);
  const run = p.ctl.send("我的问题", CTX);
  await flush();
  p.ctl.abort({ keep: true });
  release("最终结果已迟到");
  assert.equal(await run, "aborted");
  await flush();
  const reopened = env.panel();
  await reopened.ctl.open(KEY);
  assert.deepEqual(texts(reopened.ctl), ["我的问题", "已经收到的部分回答"]);
  assert.equal(reopened.ctl.messages.at(-1).status, "aborted");
  assert.equal(reopened.ctl.canRetry, true);
  assert.equal(await reopened.ctl.send("继续", CTX), "done");
  assert.match(reopened.requests[0].messages[2].content, /已经收到的部分回答（已中断）/);
});

test("持久对话整链路：完整回答保存失败不能返回已完成", async () => {
  const env = environment();
  const p = env.panel();
  await p.ctl.open(KEY);
  env.controls.failSet = (values) => values[KEY]?.messages.at(-1)?.role === "ai" ? "保存完整回答失败" : null;
  assert.equal(await p.ctl.send("我的问题", CTX), "storage-error");
  assert.match(p.errors[0], /保存完整回答失败/);
  assert.deepEqual(env.local[KEY].messages.map((item) => item.text), ["我的问题"]);
});
