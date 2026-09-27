const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { root, read, runFile, pageScripts, panelSource } = require("./源码加载.js");

// 字幕助手：lib/字幕助手.js 的上下文、提示词、历史、时间点和对话状态机，
// 以及 侧栏/字幕助手.js 接统一调用层、渲染时间点、点击跳转的接线。全部真实执行源码。

const LIBS = ["lib/字幕工具.js", "lib/translate.js", "lib/outline.js", "lib/模型路由.js", "lib/模型调用.js", "lib/字幕助手.js"];
const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setImmediate(resolve));

function loadLibs(extra = {}) {
  const context = {
    console,
    URL,
    AbortController,
    AbortSignal,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    ...extra
  };
  context.self = context;
  vm.createContext(context);
  for (const file of LIBS) runFile(context, file);
  return context;
}

function chatLib() {
  return loadLibs().BiliCaptionChat;
}

const SHORT_CUES = [
  { from: 0, to: 2, content: " 开场  介绍 " },
  { from: 65.4, to: 70, content: "第二句" },
  { from: 3725, to: 3730, content: "一小时后" },
  { from: 3800, to: 3801, content: "   " }
];

/** 600 句、每 5 秒一句（50 分钟）；第 100 句和第 500 句讲「实例化节点」，其余是无关的填充 */
function longCues() {
  return Array.from({ length: 600 }, (_, i) => ({
    from: i * 5,
    to: i * 5 + 4,
    content: i === 100
      ? "这里讲 Geometry Nodes 的实例化节点"
      : i === 500
        ? "实例化节点可以把很多点替换成模型"
        : `填充内容第${i}句，讲一些无关的话题。`
  }));
}

test("字幕上下文：预算内给全文，每行 [mm:ss] 字幕，满 1 小时写 h:mm:ss，预算沿用大纲上限", () => {
  const C = chatLib();
  assert.equal(C.contextBudget(), 100000);
  const ctx = C.buildSubtitleContext({ cues: SHORT_CUES, question: "讲了什么" });
  assert.equal(ctx.mode, "full");
  assert.equal(ctx.text, "[00:00] 开场 介绍\n[01:05] 第二句\n[1:02:05] 一小时后");
});

test("字幕上下文：超预算改给节选——大纲 + 当前位置前后 + 关键词段，按时间排序、片段间用「……」隔开", () => {
  const C = chatLib();
  const budget = 8000;
  const outline = [
    { title: "开场", start: 0, end: 600, synopsis: "介绍这期要做什么" },
    { title: "实例化", start: 600, end: 3000, synopsis: "用节点批量复制", subs: [{ title: "替换成模型", start: 2500 }] }
  ];
  const ctx = C.buildSubtitleContext({
    cues: longCues(),
    question: "实例化节点有什么用？",
    currentTime: 1500,
    outline,
    videoSummary: "讲几何节点",
    budget
  });
  assert.equal(ctx.mode, "excerpt");
  assert.ok(ctx.text.length + ctx.outline.length + C.EXCERPT_NOTE.length <= budget, "节选不超预算");
  // 大纲（含全片总结与小节）
  assert.match(ctx.outline, /^全片总结：讲几何节点/);
  assert.match(ctx.outline, /\[00:00–10:00\] 开场：介绍这期要做什么/);
  assert.match(ctx.outline, / {2}\[41:40\] 替换成模型/);
  // 关键词命中的两段都在，离得远又不相关的不在
  assert.match(ctx.text, /\[08:20\] 这里讲 Geometry Nodes 的实例化节点/);
  assert.match(ctx.text, /\[41:40\] 实例化节点可以把很多点替换成模型/);
  assert.doesNotMatch(ctx.text, /\[35:00\]/);
  // 当前播放位置（25:00）前后
  assert.match(ctx.text, /\[25:00\] 填充内容第300句/);
  assert.match(ctx.text, /\[23:00\] 填充内容第276句/);
  assert.match(ctx.text, /\[27:00\] 填充内容第324句/);
  // 按时间顺序、不相邻处用「……」
  const lines = ctx.text.split("\n");
  const times = lines.filter((line) => line !== "……").map((line) => C.clockToSeconds(line.match(/^\[([\d:]+)\]/)[1]));
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.ok(lines.includes("……"));
  assert.notEqual(lines[0], "……");

  // system 里注明是节选
  const messages = C.buildChatMessages({ cues: longCues(), question: "实例化节点有什么用？", currentTime: 1500, outline, budget });
  assert.match(messages[0].content, /以下为节选/);
  assert.match(messages[0].content, /【大纲】\n章节：\n\[00:00–10:00\] 开场/);
  assert.match(messages[0].content, /【字幕节选】\n/);
});

test("字幕上下文：问题里写到的时间点附近也放进节选；没有播放位置时不硬塞开头", () => {
  const C = chatLib();
  const ctx = C.buildSubtitleContext({ cues: longCues(), question: "12:30 那里在干嘛", budget: 6000 });
  assert.equal(ctx.mode, "excerpt");
  assert.match(ctx.text, /\[12:30\] 填充内容第150句/);
  assert.match(ctx.text, /\[11:30\] 填充内容第138句/);
  assert.doesNotMatch(ctx.text, /\[00:00\]/);
  assert.deepEqual(plain(C.questionTimes("先看 1:02:05，再看 [03:12] 和 12:30")), [3725, 192, 750]);
});

test("历史：只带有回答的轮次，保留最近 6 轮，超字数从最早的丢；中断的部分回答注明「已中断」", () => {
  const C = chatLib();
  const msgs = [];
  for (let i = 1; i <= 8; i += 1) msgs.push({ role: "user", text: `问${i}` }, { role: "ai", text: `答${i}` });
  msgs.push({ role: "user", text: "问错" }, { role: "ai", status: "error", text: "429" });
  msgs.push({ role: "user", text: "问断" }, { role: "ai", status: "aborted", text: "半截" });
  msgs.push({ role: "user", text: "问空断" }, { role: "ai", status: "aborted", text: "" });
  msgs.push({ role: "user", text: "没回答" });
  const history = C.selectHistory(msgs);
  assert.deepEqual(plain(history.map((m) => m.content)), [
    "问4", "答4", "问5", "答5", "问6", "答6", "问7", "答7", "问8", "答8", "问断", "半截（已中断）"
  ]);
  assert.deepEqual(plain(history.map((m) => m.role)), Array.from({ length: 12 }, (_, i) => (i % 2 ? "assistant" : "user")));

  const long = [
    { role: "user", text: "A" }, { role: "ai", text: "x".repeat(5000) },
    { role: "user", text: "B" }, { role: "ai", text: "y".repeat(5000) }
  ];
  assert.deepEqual(plain(C.selectHistory(long).map((m) => m.content.slice(0, 1))), ["B", "y"]);
  const single = C.selectHistory([{ role: "user", text: "C" }, { role: "ai", text: "z".repeat(9000) }], { maxChars: 100 });
  assert.equal(single[1].content.length, 99);
  assert.ok(single[1].content.endsWith("…"));
  assert.equal(C.HISTORY_MAX_TURNS, 6);
});

test("请求消息：system（角色说明 + 字幕）在最前，之后按顺序是历史，最后是本次问题；全文模式下 system 每轮不变", () => {
  const C = chatLib();
  const history = [
    { role: "user", content: "开场讲了啥" },
    { role: "assistant", content: "介绍 [00:00]" }
  ];
  const messages = C.buildChatMessages({ cues: SHORT_CUES, question: " 第二句说了啥 ", history, currentTime: 66, title: "几何节点入门" });
  assert.equal(messages[0].role, "system");
  assert.ok(messages[0].content.startsWith("你是视频助手，只根据下面的字幕回答问题，字幕里没有的就说没提到。用简洁中文回答，不要使用 Markdown。"));
  assert.match(messages[0].content, /格式为 \[mm:ss\]，超过 1 小时写成 \[h:mm:ss\]/);
  assert.match(messages[0].content, /视频标题：几何节点入门/);
  assert.match(messages[0].content, /【字幕】\n\[00:00\] 开场 介绍\n\[01:05\] 第二句\n\[1:02:05\] 一小时后$/);
  assert.deepEqual(plain(messages.slice(1, -1)), history);
  assert.deepEqual(plain(messages.at(-1)), { role: "user", content: "（当前播放到 [01:06]）\n第二句说了啥" });
  // 播放位置、问题、历史都变了，system 仍一字不差（利于前缀缓存）
  const next = C.buildChatMessages({ cues: SHORT_CUES, question: "还有呢", history: [], currentTime: 3000, title: "几何节点入门" });
  assert.equal(next[0].content, messages[0].content);
  assert.equal(next.length, 2);
  assert.equal(C.buildChatMessages({ cues: SHORT_CUES, question: "开头？" }).at(-1).content, "开头？");
});

test("回答里的时间点：[mm:ss] / 【h:mm:ss】/ 时间段切成可点片段并换算成秒，不合法的留在文字里", () => {
  const C = chatLib();
  const parts = C.parseAnswerSegments("开头在 [00:05]，重点见【1:02:05】和 [03:12–04:30]，[03:75] 不算，[12] 也不算");
  assert.deepEqual(plain(parts), [
    { type: "text", text: "开头在 " },
    { type: "time", text: "[00:05]", label: "00:05", seconds: 5 },
    { type: "text", text: "，重点见" },
    { type: "time", text: "【1:02:05】", label: "1:02:05", seconds: 3725 },
    { type: "text", text: "和 " },
    { type: "time", text: "[03:12–04:30]", label: "03:12–04:30", seconds: 192 },
    { type: "text", text: "，[03:75] 不算，[12] 也不算" }
  ]);
  assert.deepEqual(plain(C.parseAnswerSegments("")), []);
  assert.deepEqual(plain(C.parseAnswerSegments("没有时间点")), [{ type: "text", text: "没有时间点" }]);
  assert.equal(C.clockToSeconds("03:12"), 192);
  assert.equal(C.clockToSeconds("75:30"), 4530);
  assert.ok(Number.isNaN(C.clockToSeconds("1:75:00")));
  assert.ok(Number.isNaN(C.clockToSeconds("03:60")));
});

test("Enter 发送、Shift+Enter 换行、输入法组字中不发送", () => {
  const C = chatLib();
  assert.equal(C.shouldSendOnKey({ key: "Enter" }), true);
  assert.equal(C.shouldSendOnKey({ key: "Enter", shiftKey: true }), false);
  assert.equal(C.shouldSendOnKey({ key: "Enter", isComposing: true }), false);
  assert.equal(C.shouldSendOnKey({ key: "Enter", keyCode: 229 }), false);
  assert.equal(C.shouldSendOnKey({ key: "a" }), false);
});

// ---------- 对话状态机 ----------

const CTX = { cues: SHORT_CUES, currentTime: 10, title: "T" };

function controller(C, overrides = {}) {
  const changes = [];
  const storage = overrides.storage || C.memoryStorage();
  const ctl = C.createChatController({
    storage,
    request: overrides.request || (async ({ messages }) => `答：${messages.at(-1).content}`),
    hasConfig: overrides.hasConfig || (async () => true),
    onChange: (kind) => changes.push(kind)
  });
  return { ctl, storage, changes };
}

test("流式：经统一调用层读 SSE，逐字出现在待回答里，<think> 不外露；完成后存成完整回答", async () => {
  const context = loadLibs();
  const C = context.BiliCaptionChat;
  const Call = context.BiliCaptionModelCall;
  const encoder = new TextEncoder();
  const sse = [
    'data: {"choices":[{"delta":{"content":"<think>先想"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"一想</think>答"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"案在 [00:05]"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  ];
  let sentBody = null;
  const fakeFetch = async (url, init) => {
    sentBody = JSON.parse(init.body);
    let i = 0;
    return {
      ok: true,
      status: 200,
      headers: { get: () => "" },
      body: {
        getReader: () => ({
          async read() {
            if (i >= sse.length) return { done: true };
            return { done: false, value: encoder.encode(sse[i++]) };
          }
        })
      }
    };
  };
  const seen = [];
  let ctlRef = null;
  const { ctl, storage } = controller(C, {
    request: ({ messages, signal, onDelta }) => Call.chat({
      base: "https://api.example.com/v1",
      key: "k",
      model: "xy-smart",
      provider: "自定义",
      task: "chat",
      messages,
      signal,
      stream: true,
      onDelta(full) {
        onDelta(full);
        if (ctlRef.pending) seen.push(ctlRef.pending.text);
      },
      fetch: fakeFetch
    }).then((result) => result.text)
  });
  ctlRef = ctl;
  await ctl.open("chat:BV1:1");
  assert.equal(await ctl.send("答案在哪", CTX), "done");
  assert.deepEqual(seen, ["答", "答案在 [00:05]"]);
  assert.equal(sentBody.stream, true);
  assert.equal(sentBody.messages[0].role, "system");
  assert.equal(sentBody.messages.at(-1).role, "user");
  assert.match(sentBody.messages.at(-1).content, /答案在哪$/);
  // 自定义网关：不发厂商专用的思考参数
  assert.equal("reasoning_effort" in sentBody, false);
  assert.equal("thinking" in sentBody, false);
  assert.deepEqual(plain(ctl.messages.map((m) => [m.role, m.text, m.status || ""])), [
    ["user", "答案在哪", ""],
    ["ai", "答案在 [00:05]", ""]
  ]);
  assert.equal(ctl.pending, null);
  assert.equal(ctl.busy, false);
  assert.deepEqual(plain(storage.store["chat:BV1:1"].map((m) => m.text)), ["答案在哪", "答案在 [00:05]"]);
});

test("流式：状态机自己也去掉 <think>，只写了开头的半截思考不显示", async () => {
  const C = chatLib();
  const shown = [];
  let ctlRef = null;
  const { ctl } = controller(C, {
    async request({ onDelta }) {
      for (const full of ["<think>abc", "<think>abc</think>好", "<think>abc</think>好的"]) {
        onDelta(full);
        shown.push(ctlRef.pending?.text ?? null);
      }
      return "<think>abc</think>好的";
    }
  });
  ctlRef = ctl;
  await ctl.open("chat:BV1:1");
  assert.equal(await ctl.send("问", CTX), "done");
  assert.deepEqual(shown, ["", "好", "好的"]);
  assert.equal(ctl.messages.at(-1).text, "好的");
});

test("每个视频一份对话：切换视频看各自的，重新打开侧栏从 session 存储恢复，清空只清当前视频", async () => {
  const C = chatLib();
  assert.equal(C.chatStorageKey({ bvid: "BV1", cid: "12" }), "chat:BV1:12");
  assert.equal(C.chatStorageKey({ bvid: "yt_abc", cid: 1 }), "chat:yt_abc:1");
  assert.equal(C.chatStorageKey({}), "");

  const { ctl, storage } = controller(C);
  await ctl.open("chat:BV1:1");
  assert.equal(await ctl.send("问A", CTX), "done");
  await ctl.open("chat:BV1:2");
  assert.equal(ctl.messages.length, 0);
  assert.equal(await ctl.send("问B", CTX), "done");
  await ctl.open("chat:BV1:1");
  assert.deepEqual(plain(ctl.messages.map((m) => m.text)), ["问A", "答：（当前播放到 [00:10]）\n问A"]);

  // 重新打开侧栏：新的状态机，同一个 session 存储
  const reopened = controller(C, { storage }).ctl;
  await reopened.open("chat:BV1:2");
  assert.deepEqual(plain(reopened.messages.map((m) => m.text)), ["问B", "答：（当前播放到 [00:10]）\n问B"]);
  await reopened.clear();
  assert.equal(reopened.messages.length, 0);
  assert.equal("chat:BV1:2" in storage.store, false);
  assert.equal(storage.store["chat:BV1:1"].length, 2);

  // 第二轮带上第一轮的历史
  let sent = null;
  const multi = controller(C, { storage, request: async ({ messages }) => { sent = messages; return "第二答"; } }).ctl;
  await multi.open("chat:BV1:1");
  assert.equal(await multi.send("追问", CTX), "done");
  assert.deepEqual(plain(sent.slice(1).map((m) => m.role)), ["user", "assistant", "user"]);
  assert.equal(sent[1].content, "问A");
});

function abortableRequest(partial) {
  const calls = [];
  const request = ({ signal, onDelta }) => new Promise((resolve, reject) => {
    const call = { resolve, signal };
    calls.push(call);
    if (partial) onDelta(partial);
    signal.addEventListener("abort", () => {
      const error = new Error("已取消");
      error.name = "AbortError";
      reject(error);
    });
  });
  return { request, calls };
}

test("中止：关面板存下带「已中断」标记的部分回答，发送中再点发送无效；迟到的回答不覆盖", async () => {
  const C = chatLib();
  const { request, calls } = abortableRequest("半截回");
  const { ctl, storage } = controller(C, { request });
  await ctl.open("chat:A:1");
  const run = ctl.send("问题", CTX);
  await tick();
  assert.equal(ctl.busy, true);
  assert.deepEqual(plain(ctl.pending), { text: "半截回", started: true, question: "问题" });
  assert.equal(await ctl.send("再问一个", CTX), "busy");

  assert.equal(ctl.abort({ keep: true }), true);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(await run, "aborted");
  calls[0].resolve("迟到的完整回答");
  await tick();
  assert.deepEqual(plain(ctl.messages.map((m) => [m.role, m.text, m.status || ""])), [
    ["user", "问题", ""],
    ["ai", "半截回", "aborted"]
  ]);
  assert.equal(storage.store["chat:A:1"][1].status, "aborted");
  assert.equal(ctl.canRetry, true);
  // 带进下一轮历史时注明已中断，不当作完整回答
  assert.equal(C.selectHistory(ctl.messages)[1].content, "半截回（已中断）");
});

test("中止：切换视频时中止请求，半截回答存回原视频；清空时直接丢弃", async () => {
  const C = chatLib();
  const { request } = abortableRequest("A 的半截");
  const { ctl, storage } = controller(C, { request });
  await ctl.open("chat:A:1");
  const run = ctl.send("A 的问题", CTX);
  await tick();
  await ctl.open("chat:B:1");
  assert.equal(await run, "aborted");
  assert.equal(ctl.messages.length, 0);
  assert.deepEqual(plain(storage.store["chat:A:1"].map((m) => [m.text, m.status || ""])), [["A 的问题", ""], ["A 的半截", "aborted"]]);

  const run2 = ctl.send("B 的问题", CTX);
  await tick();
  await ctl.clear();
  assert.equal(await run2, "aborted");
  assert.equal(ctl.messages.length, 0);
  assert.equal("chat:B:1" in storage.store, false);

  // 还没收到字就被中止：留一条空的「已中断」，可重新发送
  const empty = abortableRequest("");
  const other = controller(C, { request: empty.request }).ctl;
  await other.open("chat:C:1");
  const run3 = other.send("问", CTX);
  await tick();
  assert.equal(other.pending.started, false);
  other.abort();
  assert.equal(await run3, "aborted");
  assert.deepEqual(plain(other.messages.at(-1)).status, "aborted");
  assert.equal(other.messages.at(-1).text, "");
});

test("侧栏在回答途中被关掉：重新打开时问题后面补一条「已中断」", () => {
  const C = chatLib();
  const list = C.normalizeStored([
    { id: "1", role: "user", text: "问" },
    { id: "2", role: "ai", text: "答" },
    { id: "3", role: "user", text: "没等到回答" },
    { role: "system", text: "非法" }
  ]);
  assert.deepEqual(plain(list.map((m) => [m.role, m.text, m.status || ""])), [
    ["user", "问", ""], ["ai", "答", ""], ["user", "没等到回答", ""], ["ai", "", "aborted"]
  ]);
});

test("异常：没有字幕不发送；没配置总结服务给出提示且不记问题；请求失败显示错误，可重新发送", async () => {
  const C = chatLib();
  let configured = true;
  let fail = true;
  const sent = [];
  const { ctl, storage } = controller(C, {
    hasConfig: async () => configured,
    async request({ messages }) {
      sent.push(messages);
      if (fail) {
        fail = false;
        const error = new Error("API Key 无效或已过期（401）");
        error.status = 401;
        throw error;
      }
      return "好的";
    }
  });
  await ctl.open("chat:V:1");
  assert.equal(await ctl.send("问", { cues: [] }), "no-cues");
  assert.equal(await ctl.send("   ", CTX), "empty");
  assert.equal(ctl.messages.length, 0);

  configured = false;
  assert.equal(await ctl.send("问", CTX), "no-config");
  assert.equal(ctl.notice, "config");
  assert.equal(ctl.messages.length, 0);
  assert.equal("chat:V:1" in storage.store, false);
  assert.equal(await ctl.checkConfig(), false);

  configured = true;
  assert.equal(await ctl.checkConfig(), true);
  assert.equal(ctl.notice, "");
  assert.equal(await ctl.send("问", CTX), "error");
  assert.deepEqual(plain(ctl.messages.map((m) => [m.role, m.text, m.status || ""])), [
    ["user", "问", ""],
    ["ai", "API Key 无效或已过期（401）", "error"]
  ]);
  assert.equal(ctl.canRetry, true);

  assert.equal(await ctl.retry(CTX), "done");
  assert.deepEqual(plain(ctl.messages.map((m) => [m.role, m.text, m.status || ""])), [
    ["user", "问", ""],
    ["ai", "好的", ""]
  ]);
  assert.equal(ctl.canRetry, false);
  // 重新发送时不带失败的那一轮，问题只出现一次
  assert.deepEqual(plain(sent[1].map((m) => m.role)), ["system", "user"]);
  assert.equal(await ctl.retry(CTX), "empty");
});

// ---------- 侧栏接线（侧栏/字幕助手.js） ----------

function fakeNode(tag = "div") {
  const classes = new Set();
  const node = {
    tagName: tag.toUpperCase(),
    dataset: {},
    children: [],
    textContent: "",
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
    set className(value) { classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach((name) => classes.add(name)); },
    get className() { return [...classes].join(" "); },
    append(...items) { node.children.push(...items); },
    replaceChildren(...items) { node.children = items; },
    closest(selector) {
      return selector === ".chat-time" && classes.has("chat-time") ? node : null;
    }
  };
  return node;
}

function loadPanelChat({ cfg, chat } = {}) {
  const calls = { origins: [], chat: [], seek: [], flash: [], settings: [] };
  const context = loadLibs({
    document: {
      createElement: (tag) => fakeNode(tag),
      createTextNode: (text) => ({ nodeType: 3, textContent: String(text) })
    },
    chrome: { storage: { session: null } },
    ui: { chatScroll: { contains: () => true } },
    $: () => null,
    show() {},
    flash: (message) => calls.flash.push(message),
    sumServiceConfig: async () => ({ provider: "OpenAI", base: "https://api.openai.com/v1", model: "gpt-6-luna", key: "sk-test", ...cfg }),
    ensureApiOrigin: async (url) => calls.origins.push(url),
    seekOutlineTime: (time) => calls.seek.push(time),
    openSettings: (tab) => calls.settings.push(tab),
    state: { bvid: "BV1", cid: 3, title: "标题", currentTime: 42, cues: SHORT_CUES },
    outline: null,
    videoSummary: ""
  });
  if (chat) {
    context.BiliCaptionModelCall = {
      ...context.BiliCaptionModelCall,
      chat: async (options) => {
        calls.chat.push(options);
        return chat(options);
      }
    };
  }
  runFile(context, "侧栏/字幕助手.js");
  return { context, calls, run: (code) => vm.runInContext(code, context) };
}

test("侧栏接线：用总结服务主模型、task 为 chat、流式发 messages；没配 Key 时报配置错误", async () => {
  const { context, calls, run } = loadPanelChat({
    chat: async (options) => {
      options.onDelta?.("答");
      return { text: "答", truncated: true };
    }
  });
  const messages = [{ role: "system", content: "s" }, { role: "user", content: "q" }];
  const deltas = [];
  context.__messages = messages;
  context.__deltas = deltas;
  const text = await run("requestChatAnswer({ messages: __messages, onDelta: (t) => __deltas.push(t) })");
  assert.equal(text, "答");
  assert.deepEqual(deltas, ["答"]);
  const sent = calls.chat[0];
  assert.equal(sent.task, "chat");
  assert.equal(sent.stream, true);
  assert.equal(sent.messages, messages);
  assert.deepEqual([sent.base, sent.key, sent.model, sent.provider], ["https://api.openai.com/v1", "sk-test", "gpt-6-luna", "OpenAI"]);
  assert.deepEqual(calls.origins, ["https://api.openai.com/v1"]);
  assert.match(calls.flash[0], /截断/);
  assert.equal(await run("chatServiceReady()"), true);

  const missing = loadPanelChat({ cfg: { key: "" }, chat: async () => ({ text: "x" }) });
  await assert.rejects(missing.run("requestChatAnswer({ messages: [] })"), /请先在设置里配置总结服务和 API Key/);
  assert.equal(await missing.run("chatServiceReady()"), false);
  assert.equal(missing.calls.chat.length, 0);
});

test("侧栏接线：跟着当前视频切对话；提问上下文取当前字幕、播放位置和大纲", async () => {
  const { run } = loadPanelChat();
  run("syncChatVideo({ bvid: 'BV1', cid: 3 })");
  assert.equal(run("chatController().key"), "chat:BV1:3");
  run("syncChatVideo({ page: 'other' })");
  assert.equal(run("chatController().key"), "chat:BV1:3", "离开视频页不丢对话");
  run("syncChatVideo({ bvid: 'yt_x', cid: 1 })");
  assert.equal(run("chatController().key"), "chat:yt_x:1");
  const ctx = run("chatContext()");
  assert.equal(ctx.cues.length, SHORT_CUES.length);
  assert.equal(ctx.currentTime, 42);
  assert.equal(ctx.title, "标题");
  assert.deepEqual(plain(ctx.outline), []);
});

test("侧栏接线：回答里的时间点渲染成按钮（不用 innerHTML），点了跳到对应秒数；「打开设置」进总结服务页", () => {
  const { run, calls, context } = loadPanelChat();
  const el = fakeNode();
  context.__el = el;
  run("fillChatAnswer(__el, '看 [01:05] 和【1:02:05】')");
  assert.equal(el.children.length, 4);
  assert.equal(el.children[0].textContent, "看 ");
  const chip = el.children[1];
  assert.equal(chip.tagName, "BUTTON");
  assert.equal(chip.className, "chat-time");
  assert.equal(chip.dataset.time, "65");
  assert.equal(chip.textContent, "01:05");
  assert.equal(el.children[3].dataset.time, "3725");

  context.__chip = chip;
  run("onChatAreaClick({ target: __chip })");
  assert.deepEqual(calls.seek, [65]);

  const link = { closest: (selector) => (selector === "[data-chat-action]" ? link : null), dataset: { chatAction: "settings" } };
  context.__link = link;
  run("onChatAreaClick({ target: __link })");
  assert.deepEqual(calls.settings, ["sum"]);

  assert.doesNotMatch(read("侧栏/字幕助手.js"), /\.innerHTML|insertAdjacentHTML|outerHTML/);
});

test("界面：三个视图底部栏各有入口按钮，位置与设计稿一致；面板在视频视图里，样式与层级按设计稿", () => {
  const html = read("sidepanel.html");
  const css = read("sidepanel.css");
  const bar = (id) => html.match(new RegExp(`<div id="${id}" class="action-bar hidden">([\\s\\S]*?)\\n      </div>\\n`))[1];
  const caption = bar("actionBar");
  assert.ok(caption.indexOf('id="btnOverlay"') < caption.indexOf('id="btnChat"'));
  assert.ok(caption.indexOf('id="btnChat"') < caption.indexOf('id="btnMore"'));
  const marker = bar("markerBar");
  assert.ok(marker.indexOf('id="btnAddMarker"') < marker.indexOf('<div style="flex:1"></div>'));
  assert.ok(marker.indexOf('<div style="flex:1"></div>') < marker.indexOf('id="btnChatMarker"'));
  assert.ok(marker.indexOf('id="btnChatMarker"') < marker.indexOf('id="btnLibrary"'));
  const outlineBar = bar("outlineBar");
  assert.ok(outlineBar.indexOf('id="btnRegenOutline"') < outlineBar.indexOf('id="btnChatOutline"'));
  for (const id of ["btnChat", "btnChatMarker", "btnChatOutline"]) {
    assert.match(html, new RegExp(`id="${id}" type="button" class="chat-btn" title="字幕助手"`));
  }
  // 面板在 #videoView 里（侧栏与浮窗 iframe 同一页面）
  const videoView = html.slice(html.indexOf('id="videoView"'), html.indexOf('id="selectTrail"'));
  assert.match(videoView, /id="chatPanel" class="chat-panel hidden"/);
  assert.match(videoView, /placeholder="问点关于这个视频的…"/);
  assert.match(videoView, />问问这个视频</);
  assert.match(videoView, />回答只基于当前字幕</);
  assert.match(videoView, />思考中…</);
  assert.match(css, /\.chat-panel \{[^}]*left: 10px;[^}]*right: 10px;[^}]*bottom: 56px;[^}]*height: 64%;[^}]*z-index: 30;/);
  assert.match(css, /\.video-view \{[^}]*position: relative;/);
  assert.match(css, /\.chat-send\.ready \{[^}]*background: var\(--blue\);[^}]*color: #0B0C0E;/);
  // 任务胶囊下拉、「更多」菜单、提示条压在面板上面
  for (const selector of ["view-tabs", "more-menu", "toast"]) {
    const z = Number(css.match(new RegExp(`\\.${selector} \\{[^}]*z-index: (\\d+);`))[1]);
    assert.ok(z > 30, `${selector} 的 z-index 应高于字幕助手面板`);
  }
  // 纯逻辑先于界面加载
  const scripts = pageScripts("sidepanel.html");
  assert.ok(scripts.indexOf("lib/字幕工具.js") < scripts.indexOf("lib/字幕助手.js"));
  assert.ok(scripts.indexOf("lib/字幕助手.js") < scripts.indexOf("侧栏/字幕助手.js"));
});

test("快捷键：焦点在对话输入框里时全局快捷键不抢按键，打开助手收起「更多」菜单", () => {
  const context = loadLibs();
  const { isTypingTarget } = context.BiliCaptionCueTools;
  assert.equal(isTypingTarget({ tagName: "TEXTAREA" }), true);
  const panel = panelSource();
  assert.match(panel, /function onSidepanelHotkey\(event\) \{\s*if \(isTypingTarget\(event\.target\) \|\| isTypingTarget\(document\.activeElement\)\) return;/);
  assert.match(panel, /function openChat\(\) \{[\s\S]*?setMoreOpen\(false\);\s*setMarkerMoreOpen\(false\);/);
  assert.match(panel, /if \(!selectHeld && !dragSelect && pointerInChat\(event\)\) return;/);
  assert.ok(fs.existsSync(path.join(root, "lib/字幕助手.js")));
});
