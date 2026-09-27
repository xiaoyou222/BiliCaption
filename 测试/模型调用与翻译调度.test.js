const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { backgroundSource, contentSource, panelSource, loadBackgroundScripts, backgroundImports } = require("./源码加载.js");

const root = path.resolve(__dirname, "..");
const plain = (value) => JSON.parse(JSON.stringify(value));

function run(context, file) {
  vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context);
}

function loadLibs(files, extra = {}) {
  const context = {
    console, URL, TextEncoder, TextDecoder, AbortController, DOMException,
    setTimeout, clearTimeout, Response, ReadableStream, ...extra
  };
  context.self = context;
  context.window = context;
  vm.createContext(context);
  for (const file of files) run(context, file);
  return context;
}

function sseResponse(chunks, { stallAfter = false, status = 200 } = {}) {
  return (_url, options) => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        options?.signal?.addEventListener("abort", () => {
          try {
            controller.error(new DOMException("aborted", "AbortError"));
          } catch {
            // 已关闭
          }
        });
        if (!stallAfter) controller.close();
      }
    });
    return Promise.resolve(new Response(body, { status, headers: { "content-type": "text/event-stream" } }));
  };
}

function storageArea(store, writes) {
  return {
    async get(keys) {
      if (keys == null) {
        writes.getAll += 1;
        return { ...store };
      }
      if (typeof keys === "string") return Object.hasOwn(store, keys) ? { [keys]: store[keys] } : {};
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.filter((key) => Object.hasOwn(store, key)).map((key) => [key, store[key]]));
      }
      const out = { ...keys };
      for (const key of Object.keys(keys || {})) {
        if (Object.hasOwn(store, key)) out[key] = store[key];
      }
      return out;
    },
    async set(values) {
      for (const key of Object.keys(values || {})) writes.set.push(key);
      Object.assign(store, JSON.parse(JSON.stringify(values || {})));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
    },
    async setAccessLevel() {}
  };
}

function loadBackground(fetchImpl, { tabs = [] } = {}) {
  const store = {};
  const writes = { set: [], getAll: 0 };
  const runtimeMessages = [];
  const tabMessages = [];
  const noopEvent = { addListener() {} };
  const context = {
    console, URL, TextEncoder, TextDecoder, Blob, FormData, AbortController, AbortSignal, DOMException,
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: fetchImpl,
    importScripts() {},
    chrome: {
      runtime: {
        id: "test-extension",
        onInstalled: noopEvent,
        onStartup: noopEvent,
        onMessage: noopEvent,
        async sendMessage(message) {
          runtimeMessages.push(JSON.parse(JSON.stringify(message)));
        },
        getURL(file) { return `chrome-extension://test/${file}`; },
        async getContexts() { return []; },
        lastError: null,
        async getPlatformInfo() { return {}; }
      },
      sidePanel: { async setPanelBehavior() {}, async setOptions() {}, async open() {} },
      tabs: {
        query(_query, callback) {
          if (callback) callback(tabs);
          return Promise.resolve(tabs);
        },
        async sendMessage(tabId, message) {
          tabMessages.push({ tabId, message: JSON.parse(JSON.stringify(message)) });
          return message.patch ? { ok: true } : {};
        }
      },
      declarativeNetRequest: { async updateDynamicRules() {} },
      storage: { local: storageArea(store, writes) }
    },
    BiliCaptionPrefs: { async loadSettings(defaults) { return { ...defaults }; } },
    BiliCaptionProviders: {},
    BiliCaptionStt: {},
    BiliCaptionMp4: { CHUNK_SECONDS: 8 * 60, CHUNK_BYTES: 20 * 1024 * 1024 }
  };
  context.self = context;
  vm.createContext(context);
  loadBackgroundScripts(context, ["lib/视频平台.js", "lib/字幕工具.js", "lib/zh-simp.js", "lib/translate.js", "lib/模型路由.js", "lib/模型调用.js"]);
  context.BiliCaptionPrefs.loadSettings = async () => ({
    sumProvider: "OpenAI",
    apiKey: "key",
    apiModel: "gpt-4o-mini",
    translateConcurrency: 2
  });
  context.BiliCaptionProviders.resolveSum = () => ({
    provider: "OpenAI",
    base: "https://api.openai.com/v1",
    key: "key",
    model: "gpt-4o-mini"
  });
  return { B: context, store, writes, runtimeMessages, tabMessages };
}

function englishCues(n) {
  return Array.from({ length: n }, (_, i) => ({ from: i * 2, to: i * 2 + 1.5, content: `This is line ${i + 1}.` }));
}

function echoTranslate(body) {
  const prompt = body.messages.at(-1).content;
  const ids = [...prompt.matchAll(/^\d+\. This is line (\d+)\.$/gm)].map((m) => Number(m[1]));
  return ids.map((id, i) => `${i + 1}. 第${id}句`).join("\n");
}

function okJson(content) {
  return { ok: true, status: 200, async json() { return { choices: [{ message: { content } }] }; } };
}

/** 等后台脚本加载时自己跑的那次续跑检查结束，再清零计数。 */
async function settle(bg) {
  await new Promise((resolve) => setTimeout(resolve, 20));
  bg.writes.getAll = 0;
  bg.writes.set.length = 0;
}

async function waitFor(check, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

// ---------- 思考参数 ----------

test("思考参数只在翻译任务、文档明确支持的服务商和模型上发送，自定义一律不发", () => {
  const { BiliCaptionModelRoute: R } = loadLibs(["lib/模型路由.js"]);
  const f = (provider, model, task = "translate") => plain(R.requestFields({ provider, model, task }));
  assert.deepEqual(f("Gemini", "gemini-2.5-flash"), { reasoning_effort: "none" });
  assert.deepEqual(f("Gemini", "gemini-2.5-pro"), { reasoning_effort: "low" });
  assert.deepEqual(f("Gemini", "gemini-3-flash-preview"), { reasoning_effort: "low" });
  assert.deepEqual(f("Gemini", "gemini-3.8-flash"), { reasoning_effort: "low" });
  assert.deepEqual(f("Gemini", "gemini-2.5-flash-lite"), {});
  assert.deepEqual(f("Gemini", "gemini-3.5-flash-lite"), {});
  assert.deepEqual(f("DeepSeek", "deepseek-flash"), { thinking: { type: "disabled" } });
  assert.deepEqual(f("DeepSeek", "deepseek-v4-pro"), { thinking: { type: "disabled" } });
  assert.deepEqual(f("OpenAI", "gpt-4o-mini"), {});
  // 新默认：OpenAI gpt-6-luna 翻译关思考；Gemini 默认翻译模型 3.5 Flash-Lite 默认已是 minimal，不加参数
  assert.deepEqual(f("OpenAI", "gpt-6-luna"), { reasoning_effort: "none" });
  assert.deepEqual(f("OpenAI", "gpt-6-sol"), { reasoning_effort: "none" });
  assert.deepEqual(f("Gemini", "models/gemini-3.8-flash"), { reasoning_effort: "low" });
  assert.deepEqual(f("自定义", "xy-fast"), {});
  assert.deepEqual(f("自定义", "gpt-6-luna"), {});
  assert.deepEqual(f("自定义", "gemini-2.5-flash"), {});
  // 总结、大纲、润色保持服务商默认
  assert.deepEqual(f("Gemini", "gemini-2.5-flash", "summary"), {});
  assert.deepEqual(f("DeepSeek", "deepseek-flash", "outline"), {});
});

test("自定义网关下主模型和翻译模型别名都保留，换到具体服务商都清掉；下线的 DeepSeek 旧名换成 deepseek-flash", () => {
  const { BiliCaptionProviders: P } = loadLibs(["lib/providers.js"]);
  const custom = P.migrateSum({ sumProvider: "自定义", apiBase: "https://cpa.example/v1", apiModel: "xy-smart", translateModel: "xy-fast" });
  assert.equal(custom.apiModel, "xy-smart");
  assert.equal(custom.translateModel, "xy-fast");
  const openai = P.migrateSum({ sumProvider: "OpenAI", apiModel: "xy-smart", translateModel: "xy-fast" });
  assert.equal(openai.apiModel, "");
  assert.equal(openai.translateModel, "");
  const deepseek = P.migrateSum({ sumProvider: "DeepSeek", apiModel: "deepseek-reasoner", translateModel: "deepseek-chat" });
  assert.equal(deepseek.apiModel, "deepseek-flash");
  assert.equal(deepseek.translateModel, "deepseek-flash");
  assert.equal(P.resolveSum({ sumProvider: "DeepSeek", apiKey: "k" }).model, "deepseek-flash");
});

test("默认模型按服务商取；Gemini 翻译默认用 Flash-Lite 速度档，OpenAI / DeepSeek 跟随总结模型", () => {
  const { BiliCaptionProviders: P } = loadLibs(["lib/providers.js"]);
  assert.deepEqual(plain(P.SUM_MODELS), { OpenAI: "gpt-6-luna", Gemini: "gemini-3.8-flash", DeepSeek: "deepseek-flash", 自定义: "" });
  assert.equal(P.translateDefault("Gemini"), "gemini-3.5-flash-lite");
  assert.equal(P.translateDefault("OpenAI"), "gpt-6-luna");
  assert.equal(P.translateDefault("DeepSeek"), "deepseek-flash");
  assert.equal(P.translateDefault("自定义"), "");
  assert.equal(P.resolveSum({ sumProvider: "OpenAI", apiKey: "k" }).model, "gpt-6-luna");
  assert.equal(P.resolveSum({ sumProvider: "Gemini", apiKey: "k" }).model, "gemini-3.8-flash");
});

test("已下线的 Gemini 模型迁到新默认；仍可用但不再推荐的已保存值不动", () => {
  const { BiliCaptionProviders: P } = loadLibs(["lib/providers.js"]);
  // 2.0 Flash 2026-06-01 停用、3 Pro Preview 2026-03-09 停用、3.1 Flash-Lite Preview 2026-05-25 停用
  const retired = P.migrateSum({ sumProvider: "Gemini", apiModel: "gemini-2.0-flash", translateModel: "models/gemini-2.0-flash-lite" });
  assert.equal(retired.apiModel, "gemini-3.8-flash");
  assert.equal(retired.translateModel, "gemini-3.5-flash-lite");
  assert.equal(P.migrateSum({ sumProvider: "Gemini", apiModel: "gemini-3-pro-preview" }).apiModel, "gemini-3.8-flash");
  assert.equal(P.migrateSum({ sumProvider: "Gemini", apiModel: "x", translateModel: "gemini-3.1-flash-lite-preview" }).translateModel, "gemini-3.5-flash-lite");
  assert.equal(P.resolveSum({ sumProvider: "Gemini", apiKey: "k", apiModel: "gemini-2.5-flash-preview-05-20" }).model, "gemini-3.8-flash");

  // 老用户仍能用：2.5 系列只限老用户访问但没停用、3 Flash Preview 没公布停用日期、gpt-4o-mini 没弃用
  const keepGemini = P.migrateSum({ sumProvider: "Gemini", apiModel: "gemini-2.5-flash", translateModel: "gemini-3-flash-preview" });
  assert.equal(keepGemini.apiModel, "gemini-2.5-flash");
  assert.equal(keepGemini.translateModel, "gemini-3-flash-preview");
  const keepOpenAI = P.migrateSum({ sumProvider: "OpenAI", apiModel: "gpt-4o-mini", translateModel: "" });
  assert.equal(keepOpenAI.apiModel, "gpt-4o-mini");
  assert.equal(keepOpenAI.translateModel, "");
  // 翻译模型留空仍表示跟随总结模型，不会被悄悄换成 Flash-Lite
  assert.equal(P.migrateSum({ sumProvider: "Gemini", apiModel: "gemini-2.5-flash", translateModel: "" }).translateModel, "");

  // 下线名单按服务商区分：自定义网关里同名模型不动，Gemini 名单不套到 DeepSeek
  assert.equal(P.migrateSum({ sumProvider: "自定义", apiBase: "https://cpa.example/v1", apiModel: "gemini-2.0-flash" }).apiModel, "gemini-2.0-flash");
  assert.equal(P.migrateSum({ sumProvider: "Gemini", apiModel: "deepseek-chat" }).apiModel, "deepseek-chat");
});

/** 设置页 options.js 里 loadSettings 内的 pickSum（点总结服务商的分段按钮），配最小的 DOM 桩单独执行 */
function loadPickSum(initial) {
  const source = fs.readFileSync(path.join(root, "options.js"), "utf8");
  const start = source.indexOf("  function pickSum(p) {");
  const end = source.indexOf("\n  }\n", start);
  assert.ok(start > 0 && end > start, "找不到 pickSum");
  const { BiliCaptionProviders: P } = loadLibs(["lib/providers.js"]);
  const inputs = { sumModel: { value: initial.sumModel }, trModel: { value: initial.trModel }, sumKey: { placeholder: "" }, sumSeg: {}, sumCustom: {} };
  const context = {
    P,
    sumProvider: initial.provider,
    sumFetch: "done",
    $: (id) => inputs[id],
    updateTrPlaceholder() {},
    show() {},
    renderSeg() {}
  };
  vm.createContext(context);
  vm.runInContext(`${source.slice(start, end + 4)}\nthis.pickSum = pickSum;`, context);
  return { context, inputs };
}

test("设置页：再点一次当前服务商不清掉手填的模型；真换服务商时才换成新服务商的默认 / 速度档", () => {
  const { context, inputs } = loadPickSum({ provider: "Gemini", sumModel: "gemini-2.5-pro", trModel: "gemini-2.5-flash-lite" });
  context.pickSum("Gemini");
  assert.equal(inputs.trModel.value, "gemini-2.5-flash-lite", "手填的翻译模型不被速度档预填覆盖");
  assert.equal(inputs.sumModel.value, "gemini-2.5-pro");

  context.pickSum("OpenAI");
  assert.equal(context.sumProvider, "OpenAI");
  assert.equal(inputs.sumModel.value, "gpt-6-luna");
  assert.equal(inputs.trModel.value, "", "OpenAI 没有单独的速度档：留空跟随总结模型，不留上一家的模型名");
  context.pickSum("Gemini");
  assert.equal(inputs.sumModel.value, "gemini-3.8-flash");
  assert.equal(inputs.trModel.value, "gemini-3.5-flash-lite");
});

// ---------- 统一调用层 ----------

test("调用层：Gemini 翻译带 reasoning_effort，自定义不带；鉴权头、去 <think>、错误信息统一", async () => {
  const bodies = [];
  const C = loadLibs(["lib/模型路由.js", "lib/模型调用.js"]);
  const fetchImpl = async (url, options) => {
    bodies.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    return okJson("<think>先想一想</think>\n答案");
  };
  const Call = C.BiliCaptionModelCall;
  const got = await Call.chat({ base: "https://generativelanguage.googleapis.com/v1beta/openai/", key: " k ", provider: "Gemini", model: "gemini-2.5-flash", task: "translate", prompt: "p", fetch: fetchImpl });
  assert.equal(got.text, "答案");
  assert.equal(bodies[0].url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
  assert.equal(bodies[0].headers.Authorization, "Bearer k");
  assert.equal(bodies[0].body.reasoning_effort, "none");
  await Call.chat({ base: "https://cpa.example/v1", key: "k", provider: "自定义", model: "xy-fast", task: "translate", prompt: "p", fetch: fetchImpl });
  assert.equal("reasoning_effort" in bodies[1].body, false);
  assert.equal("thinking" in bodies[1].body, false);

  await assert.rejects(
    Call.chat({ base: "http://evil.example/v1", key: "k", prompt: "p", fetch: fetchImpl }),
    (error) => error.fatal === true && /https/.test(error.message)
  );
  const failing = async () => ({
    ok: false,
    status: 429,
    headers: new Map([["retry-after", "7"]]),
    async json() { return { error: { message: "slow down" } }; }
  });
  await assert.rejects(
    Call.chat({ base: "https://api.openai.com/v1", key: "k", prompt: "p", fetch: failing }),
    (error) => error.status === 429 && error.retryAfter === 7000 && error.message === "slow down" && Call.isRetryable(error)
  );
  const badKey = async () => ({ ok: false, status: 401, async json() { return null; } });
  await assert.rejects(
    Call.chat({ base: "https://api.openai.com/v1", key: "k", prompt: "p", fetch: badKey }),
    (error) => error.fatal === true && /401/.test(error.message)
  );
});

test("调用层按服务商与模型挑参数：OpenAI 推理模型不发 temperature、用 max_completion_tokens，翻译发文档允许的最低强度；Gemini 3 不发 temperature", async () => {
  const bodies = [];
  const C = loadLibs(["lib/模型路由.js", "lib/模型调用.js"]);
  const fetchImpl = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return okJson("好");
  };
  const Call = C.BiliCaptionModelCall;
  const send = async (provider, model, extra = {}) => {
    const base = provider === "Gemini" ? "https://generativelanguage.googleapis.com/v1beta/openai" : "https://api.openai.com/v1";
    await Call.chat({ base, key: "k", provider, model, task: "translate", prompt: "p", fetch: fetchImpl, ...extra });
    return bodies.at(-1);
  };
  const pick = (body) => ({
    temperature: "temperature" in body ? body.temperature : "（不发）",
    effort: body.reasoning_effort ?? "（不发）",
    max_tokens: body.max_tokens ?? "（不发）",
    max_completion_tokens: body.max_completion_tokens ?? "（不发）"
  });
  const none = "（不发）";
  // 非推理模型照旧带 temperature；OpenAI 的 max_tokens 已弃用，一律改用 max_completion_tokens
  assert.deepEqual(pick(await send("OpenAI", "gpt-4o-mini", { maxTokens: 8 })), { temperature: 0.3, effort: none, max_tokens: none, max_completion_tokens: 8 });
  assert.deepEqual(pick(await send("OpenAI", "gpt-4.1")), { temperature: 0.3, effort: none, max_tokens: none, max_completion_tokens: none });
  // 推理模型：不发 temperature；翻译取各模型文档写明支持的最低强度
  assert.deepEqual(pick(await send("OpenAI", "gpt-5-mini", { maxTokens: 8 })), { temperature: none, effort: "minimal", max_tokens: none, max_completion_tokens: 8 });
  assert.deepEqual(pick(await send("OpenAI", "gpt-5-nano-2025-08-07")), { temperature: none, effort: "minimal", max_tokens: none, max_completion_tokens: none });
  assert.deepEqual(pick(await send("OpenAI", "gpt-5.1")), { temperature: none, effort: "none", max_tokens: none, max_completion_tokens: none });
  assert.deepEqual(pick(await send("OpenAI", "gpt-5.4-mini")), { temperature: none, effort: "none", max_tokens: none, max_completion_tokens: none });
  assert.deepEqual(pick(await send("OpenAI", "gpt-5.6-terra")), { temperature: none, effort: "none", max_tokens: none, max_completion_tokens: none });
  assert.deepEqual(pick(await send("OpenAI", "gpt-6-luna")), { temperature: none, effort: "none", max_tokens: none, max_completion_tokens: none });
  assert.deepEqual(pick(await send("OpenAI", "gpt-6-astra")), { temperature: none, effort: "low", max_tokens: none, max_completion_tokens: none });
  assert.deepEqual(pick(await send("OpenAI", "gpt-5.5-pro")), { temperature: none, effort: "medium", max_tokens: none, max_completion_tokens: none });
  // 文档没写可调强度（gpt-5-pro 只支持 high；o 系列模型页未列取值）：不发强度，只去掉 temperature
  assert.deepEqual(pick(await send("OpenAI", "gpt-5-pro")), { temperature: none, effort: none, max_tokens: none, max_completion_tokens: none });
  assert.deepEqual(pick(await send("OpenAI", "o4-mini")), { temperature: none, effort: none, max_tokens: none, max_completion_tokens: none });
  // 总结等任务保持服务商默认强度，但推理模型同样不发 temperature
  assert.deepEqual(pick(await send("OpenAI", "gpt-5.5", { task: "summary" })), { temperature: none, effort: none, max_tokens: none, max_completion_tokens: none });
  // chat-latest 模型页没标推理，按普通模型处理
  assert.deepEqual(pick(await send("OpenAI", "gpt-5-chat-latest")), { temperature: 0.3, effort: none, max_tokens: none, max_completion_tokens: none });
  // Gemini 3 系列官方建议保持默认 temperature；2.5 不受影响
  assert.equal("temperature" in await send("Gemini", "gemini-3.8-flash"), false);
  assert.equal("temperature" in await send("Gemini", "gemini-3.1-flash-lite"), false);
  // 新默认：OpenAI gpt-6-luna 总结不发强度和 temperature；Gemini 3.8 Flash 翻译降到 low（不支持 minimal），
  // 默认翻译模型 3.5 Flash-Lite 不发强度也不发 temperature
  assert.deepEqual(pick(await send("OpenAI", "gpt-6-luna", { task: "summary", maxTokens: 8 })), { temperature: none, effort: none, max_tokens: none, max_completion_tokens: 8 });
  assert.deepEqual(pick(await send("Gemini", "gemini-3.8-flash")), { temperature: none, effort: "low", max_tokens: none, max_completion_tokens: none });
  assert.deepEqual(pick(await send("Gemini", "gemini-3.8-flash", { task: "summary" })), { temperature: none, effort: none, max_tokens: none, max_completion_tokens: none });
  assert.deepEqual(pick(await send("Gemini", "gemini-3.5-flash-lite", { maxTokens: 8 })), { temperature: none, effort: none, max_tokens: 8, max_completion_tokens: none });
  assert.equal((await send("Gemini", "gemini-2.5-flash")).temperature, 0.3);
  assert.equal((await send("Gemini", "gemini-2.5-flash", { maxTokens: 8 })).max_tokens, 8);
});

test("调用层：服务端明确拒绝 temperature 或 max_tokens 时去掉 / 换名自动重试一次，同一模型之后不再发", async () => {
  const C = loadLibs(["lib/模型路由.js", "lib/模型调用.js"]);
  const Call = C.BiliCaptionModelCall;
  const bodies = [];
  const reject = (message) => ({ ok: false, status: 400, async json() { return { error: { message, type: "invalid_request_error" } }; } });
  const gateway = async (_url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    if ("temperature" in body) return reject("Unsupported value: 'temperature' does not support 0.3 with this model. Only the default (1) value is supported.");
    if ("max_tokens" in body) return reject("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.");
    return okJson("好");
  };
  const custom = { base: "https://cpa.example/v1", key: "k", provider: "自定义", model: "xy-smart", prompt: "p", fetch: gateway };
  const got = await Call.chat({ ...custom, task: "translate" });
  assert.equal(got.text, "好");
  assert.equal(bodies.length, 2);
  assert.equal("temperature" in bodies[0], true);
  assert.equal("temperature" in bodies[1], false);
  // 同一网关同一模型：之后第一次就不带 temperature
  await Call.chat({ ...custom, task: "summary" });
  assert.equal(bodies.length, 3);
  assert.equal("temperature" in bodies[2], false);
  // 测试连接带 max_tokens 被拒：换成 max_completion_tokens 再试
  await Call.chat({ ...custom, maxTokens: 8, allowEmpty: true });
  assert.deepEqual(bodies.slice(3).map((b) => [b.max_tokens, b.max_completion_tokens]), [[8, undefined], [undefined, 8]]);

  // 别的 400 不重试，照常报错
  let calls = 0;
  const other = async () => {
    calls += 1;
    return reject("Invalid 'messages[0].content': string too long.");
  };
  await assert.rejects(Call.chat({ ...custom, model: "xy-fast", fetch: other }), /string too long/);
  assert.equal(calls, 1);
});

test("调用层流式：拼出正文、识别 finish_reason=length 截断和流中途的 error 事件", async () => {
  const { BiliCaptionModelCall: Call } = loadLibs(["lib/模型调用.js"]);
  const deltas = [];
  const ok = await Call.chat({
    base: "https://api.openai.com/v1", key: "k", prompt: "p", stream: true,
    onDelta: (full) => deltas.push(full),
    fetch: sseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choices":[{"delta":{"content":"好"},"finish_reason":"length"}]}\n\n',
      "data: [DONE]\n\n"
    ])
  });
  assert.equal(ok.text, "你好");
  assert.equal(ok.truncated, true);
  assert.deepEqual(deltas, ["你", "你好"]);

  await assert.rejects(
    Call.chat({
      base: "https://api.openai.com/v1", key: "k", prompt: "p", stream: true,
      fetch: sseResponse([
        'data: {"choices":[{"delta":{"content":"半"}}]}\n\n',
        'event: error\ndata: {"error":{"message":"overloaded","code":503}}\n\n'
      ])
    }),
    (error) => /模型输出中断：overloaded/.test(error.message) && Call.isRetryable(error)
  );

  // 服务端没理 stream:true，直接回整段 JSON
  const json = await Call.chat({
    base: "https://api.openai.com/v1", key: "k", prompt: "p", stream: true,
    fetch: sseResponse([JSON.stringify({ choices: [{ message: { content: "整段" }, finish_reason: "stop" }] }, null, 2)])
  });
  assert.equal(json.text, "整段");
});

test("调用层流式：首字超时与空闲超时，有新数据就续期", async () => {
  const { BiliCaptionModelCall: Call } = loadLibs(["lib/模型调用.js"]);
  await assert.rejects(
    Call.chat({
      base: "https://api.openai.com/v1", key: "k", prompt: "p", stream: true, firstByteMs: 40, idleMs: 40,
      fetch: sseResponse(['data: {"choices":[{"delta":{"content":"一"}}]}\n\n'], { stallAfter: true })
    }),
    (error) => error.status === 408 && /空闲超时/.test(error.message)
  );
  await assert.rejects(
    Call.chat({
      base: "https://api.openai.com/v1", key: "k", prompt: "p", stream: true, firstByteMs: 40, idleMs: 1000,
      fetch: sseResponse([], { stallAfter: true })
    }),
    (error) => error.status === 408 && /首字超时/.test(error.message)
  );
  // 输出总时长超过首字时限，但每段间隔都很短：不会被掐断
  const slow = (_url, options) => {
    const encoder = new TextEncoder();
    let i = 0;
    const body = new ReadableStream({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        if (options.signal.aborted) return controller.error(new DOMException("aborted", "AbortError"));
        if (i >= 8) return controller.close();
        i += 1;
        controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"${i}"}}]}\n\n`));
      }
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  };
  const long = await Call.chat({ base: "https://api.openai.com/v1", key: "k", prompt: "p", stream: true, firstByteMs: 60, idleMs: 60, fetch: slow });
  assert.equal(long.text, "12345678");
});

// ---------- 按播放位置排批次 ----------

test("按播放位置排翻译批次：当前位置小批优先，往后，最后从近到远补前面", () => {
  const { BiliCaptionTranslate: T } = loadLibs(["lib/zh-simp.js", "lib/translate.js"]);
  const cues = englishCues(100);
  const items = cues.map((cue, index) => ({ index, text: cue.content }));
  const plan = T.planTranslateBatches(items, cues, 100.5);
  const firsts = plan.map((batch) => batch[0].index);
  // 100.5 秒落在第 50 行（索引 50），往前带 2 行
  assert.equal(firsts[0], 48);
  assert.equal(plan[0].length, 10);
  assert.deepEqual(plain(firsts.slice(1, 3)), [58, 82]);
  assert.deepEqual(plain(firsts.slice(3)), [24, 0]);
  assert.equal(plan.flat().length, 100);
  assert.equal(new Set(plan.flat().map((item) => item.index)).size, 100);
  const fromStart = T.planTranslateBatches(items, cues, 0);
  assert.equal(fromStart[0][0].index, 0);
  assert.equal(fromStart[0].length, 10);
});

// ---------- 队列：退避重试、限流降并发、补翻一轮 ----------

test("批次队列：按 Retry-After 退避重试，遇 429 并发减半，失败批次最后统一补翻一轮", async () => {
  const { BiliCaptionTranslate: T } = loadLibs(["lib/translate.js"]);
  const batches = Array.from({ length: 6 }, (_, i) => [i]);
  const waits = [];
  const attempts = new Map();
  let active = 0;
  let peakAfter429 = 0;
  let saw429 = false;
  const rateLimits = [];
  const result = await T.runBatchQueue({ take: () => batches.shift() || null }, {
    limit: 4,
    retries: 2,
    baseDelayMs: 100,
    sleep: async (ms) => { waits.push(ms); },
    isRetryable: (error) => error.status === 429 || error.status >= 500,
    onRateLimit: (cap) => rateLimits.push(cap),
    async worker(batch) {
      const id = batch[0];
      const n = (attempts.get(id) || 0) + 1;
      attempts.set(id, n);
      active += 1;
      if (saw429) peakAfter429 = Math.max(peakAfter429, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (id === 1 && n === 1) {
        saw429 = true;
        const error = new Error("limited");
        error.status = 429;
        error.retryAfter = 5000;
        throw error;
      }
      // 第 4 批主流程里三次都失败，补翻那一轮才成功
      if (id === 4 && n <= 3) {
        const error = new Error("busy");
        error.status = 503;
        throw error;
      }
    }
  });
  assert.equal(result.failed.length, 0);
  assert.ok(waits.includes(5000), "尊重 Retry-After");
  assert.deepEqual(rateLimits, [2]);
  assert.ok(peakAfter429 <= 4);
  assert.equal(attempts.get(4), 4);
});

test("批次队列：取消立即停，鉴权等致命错误不再派新批，开局连续失败熔断", async () => {
  const { BiliCaptionTranslate: T } = loadLibs(["lib/translate.js"]);
  const ctrl = new AbortController();
  let calls = 0;
  const list = Array.from({ length: 10 }, (_, i) => [i]);
  await assert.rejects(T.runBatchQueue({ take: () => list.shift() || null }, {
    limit: 1,
    signal: ctrl.signal,
    async worker() {
      calls += 1;
      ctrl.abort();
      const error = new Error("已取消");
      error.name = "AbortError";
      throw error;
    }
  }), (error) => error.name === "AbortError");
  assert.equal(calls, 1);

  calls = 0;
  const fatalList = Array.from({ length: 10 }, (_, i) => [i]);
  await assert.rejects(T.runBatchQueue({ take: () => fatalList.shift() || null }, {
    limit: 1,
    isFatal: (error) => error.fatal,
    async worker() {
      calls += 1;
      const error = new Error("API Key 无效");
      error.fatal = true;
      throw error;
    }
  }), /API Key 无效/);
  assert.equal(calls, 1);

  calls = 0;
  const badList = Array.from({ length: 10 }, (_, i) => [i]);
  await assert.rejects(T.runBatchQueue({ take: () => badList.shift() || null }, {
    limit: 1,
    isRetryable: () => false,
    async worker() {
      calls += 1;
      const error = new Error("bad request");
      error.status = 400;
      throw error;
    }
  }), /bad request/);
  assert.equal(calls, 3);
});

// ---------- 后台翻译任务 ----------

test("翻译运行中只广播本批变化的行，页面收补丁且不回传缓存，存档和缓存节流写入", async () => {
  const { B, store, writes, runtimeMessages, tabMessages } = loadBackground(async (_url, options) => okJson(echoTranslate(JSON.parse(options.body))));
  const started = await B.startTranslate({ tabId: 7, bvid: "BV-patch", cid: 2, title: "标题", cues: englishCues(60) });
  assert.equal(started.started, true);
  assert.equal(started.stage, "run");
  assert.equal(started.total, 60);
  assert.equal(started.cues.length, 60);
  assert.ok(await waitFor(() => runtimeMessages.some((m) => m.type === "TRANSLATE_PROGRESS" && m.stage === "done")));

  const progress = runtimeMessages.filter((m) => m.type === "TRANSLATE_PROGRESS");
  const running = progress.filter((m) => m.stage === "run");
  assert.ok(running[0].cues?.length === 60, "开始时带整份");
  const patches = running.slice(1);
  assert.ok(patches.length >= 3);
  for (const m of patches) {
    assert.equal("cues" in m, false);
    assert.equal(m.cueCount, 60);
    for (const [index, zh, en] of m.patch) {
      assert.equal(zh, `第${index + 1}句`);
      assert.equal(en, `This is line ${index + 1}.`);
    }
  }
  const done = progress.at(-1);
  assert.equal(done.cues.length, 60);
  assert.equal(done.message, "已翻译 60 行英文");

  const toTab = tabMessages.filter((m) => m.message.type === "SYNC_CUES");
  assert.ok(toTab.every((m) => m.tabId === 7 && m.message.bvid === "BV-patch" && m.message.cid === 2 && m.message.persisted === true));
  assert.ok(toTab.some((m) => Array.isArray(m.message.patch) && !m.message.cues));
  // 节流：不再每批都整份写存档和缓存
  assert.ok(writes.set.filter((key) => key === "trJob:BV-patch:2").length <= 2);
  assert.ok(writes.set.filter((key) => key === "asr:BV-patch:2").length <= 2);
  assert.equal(store["asr:BV-patch:2"].cues[59].content, "第60句");
  assert.equal(store["trJob:BV-patch:2"], undefined);

  const content = contentSource();
  assert.match(content, /if \(!message\.persisted && cachedState\.bvid/);
  assert.match(content, /return reply\(Promise\.resolve\(\{ needFull: true \}\)\)/);
});

test("后台翻译用的翻译模型也走读设置时的迁移：已下线的换成默认速度档，别处的网关别名不带到具体服务商", async () => {
  const cases = [
    { settings: { sumProvider: "Gemini", apiModel: "gemini-3.8-flash", translateModel: "gemini-2.0-flash-lite" }, model: "gemini-3.5-flash-lite" },
    { settings: { sumProvider: "DeepSeek", apiModel: "deepseek-flash", translateModel: "deepseek-chat" }, model: "deepseek-flash" },
    { settings: { sumProvider: "OpenAI", apiModel: "gpt-6-luna", translateModel: "xy-fast" }, model: "gpt-6-luna" },
    // 仍可用的手填翻译模型、自定义网关的别名原样用
    { settings: { sumProvider: "Gemini", apiModel: "gemini-3.8-flash", translateModel: "gemini-2.5-flash-lite" }, model: "gemini-2.5-flash-lite" },
    { settings: { sumProvider: "自定义", apiBase: "https://cpa.example.com/v1", apiModel: "xy-smart", translateModel: "xy-fast" }, model: "xy-fast" }
  ];
  for (const { settings, model } of cases) {
    const models = [];
    const { B, runtimeMessages } = loadBackground(async (_url, options) => {
      const body = JSON.parse(options.body);
      models.push(body.model);
      return okJson(echoTranslate(body));
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    run(B, "lib/providers.js");
    B.BiliCaptionPrefs.loadSettings = async (defaults) => ({ ...defaults, apiKey: "key", translateConcurrency: 1, ...settings });
    await B.startTranslate({ tabId: 3, bvid: "BV-migrate", cid: 1, cues: englishCues(2) });
    assert.ok(await waitFor(() => runtimeMessages.some((m) => m.type === "TRANSLATE_PROGRESS" && m.stage !== "run")), settings.translateModel);
    assert.ok(models.length > 0, settings.translateModel);
    assert.deepEqual([...new Set(models)], [model], `${settings.sumProvider} / ${settings.translateModel}`);
  }
});

test("部分批次重试后仍失败：保留停下的存档、提示 N 行未翻译，不自动续跑，再点一次只补缺的行", async () => {
  let fail = true;
  const { B, store, runtimeMessages } = loadBackground(async (_url, options) => {
    const body = JSON.parse(options.body);
    const prompt = body.messages.at(-1).content;
    if (fail && /This is line 1[1-9]\./.test(prompt.slice(prompt.lastIndexOf("【待译】")))) {
      return { ok: false, status: 503, async json() { return { error: { message: "busy" } }; } };
    }
    return okJson(echoTranslate(body));
  });
  const job = await B.startTranslate({ tabId: 3, bvid: "BV-part", cid: 1, cues: englishCues(20) });
  B.findTranslateJob({ jobId: job.jobId }).retryBaseMs = 1;
  assert.ok(await waitFor(() => runtimeMessages.some((m) => m.type === "TRANSLATE_PROGRESS" && m.stage !== "run")));
  const end = runtimeMessages.filter((m) => m.type === "TRANSLATE_PROGRESS").at(-1);
  assert.equal(end.stage, "done");
  assert.match(end.message, /^已翻译 10 行，10 行未翻译，可再点一次/);
  const saved = store["trJob:BV-part:1"];
  assert.equal(saved.pending, true);
  assert.equal(saved.halted, true);
  assert.deepEqual(plain(store.trJobIndex || {}), {});

  // 侧栏查询和 SW 重启都不会自动续跑停下的任务
  assert.equal((await B.getTranslateJobStatus({ bvid: "BV-part", cid: 1 })).running, false);
  await B.resumePendingTranslateJobs();
  assert.equal(B.findTranslateJob({ bvid: "BV-part", cid: 1 }), null);

  // 用户再点一次：从存档续上，只补没译成的 10 行
  fail = false;
  runtimeMessages.length = 0;
  const again = await B.startTranslate({ tabId: 3, bvid: "BV-part", cid: 1, cues: englishCues(20) });
  assert.equal(again.joined, true);
  assert.ok(await waitFor(() => runtimeMessages.some((m) => m.type === "TRANSLATE_PROGRESS" && m.stage === "done")));
  const final = runtimeMessages.filter((m) => m.type === "TRANSLATE_PROGRESS").at(-1);
  assert.equal(final.done, 20);
  assert.equal(final.cues[19].content, "第20句");
  assert.equal(store["trJob:BV-part:1"], undefined);
});

test("续跑只读待续跑索引，不扫全部存储；只在该视频标签页仍打开时续跑", async () => {
  const pendingRecord = (bvid, tabId) => ({
    jobId: `job-${bvid}`, tabId, bvid, cid: 1, cues: englishCues(3), done: 0, total: 3,
    pending: true, halted: false, savedAt: Date.now()
  });
  const closed = loadBackground(async () => new Promise(() => {}), { tabs: [{ id: 5, url: "https://www.bilibili.com/video/BVother" }] });
  await settle(closed);
  closed.store["trJob:BVgone:1"] = pendingRecord("BVgone", 5);
  closed.store.trJobIndex = { "trJob:BVgone:1": { bvid: "BVgone", cid: 1, tabId: 5 } };
  await closed.B.resumePendingTranslateJobs();
  assert.equal(closed.writes.getAll, 0);
  assert.equal(closed.B.findTranslateJob({ bvid: "BVgone", cid: 1 }), null);
  assert.ok(closed.store["trJob:BVgone:1"], "记录留着，回到视频时再接上");

  // 浏览器重启后 tabId 变了，按地址找到仍打开的标签页
  const open = loadBackground(async () => new Promise(() => {}), { tabs: [{ id: 42, url: "https://www.youtube.com/watch?v=abcdefghijk&t=3" }] });
  await settle(open);
  open.store["trJob:yt_abcdefghijk:1"] = pendingRecord("yt_abcdefghijk", 9);
  open.store.trJobIndex = { "trJob:yt_abcdefghijk:1": { bvid: "yt_abcdefghijk", cid: 1, tabId: 9 } };
  await open.B.resumePendingTranslateJobs();
  const job = open.B.findTranslateJob({ bvid: "yt_abcdefghijk", cid: 1 });
  assert.ok(job);
  assert.equal(job.tabId, 42);
  await open.B.cancelTranslateJob(job.jobId, { bvid: "yt_abcdefghijk", cid: 1 });

  // 旧版本没有索引：只补建一次
  const legacy = loadBackground(async () => new Promise(() => {}));
  await settle(legacy);
  delete legacy.store.trJobIndex;
  legacy.store["trJob:BVold:1"] = pendingRecord("BVold", 1);
  await legacy.B.resumePendingTranslateJobs();
  assert.equal(legacy.writes.getAll, 1);
  assert.ok(legacy.store.trJobIndex["trJob:BVold:1"]);
  await legacy.B.resumePendingTranslateJobs();
  assert.equal(legacy.writes.getAll, 1);
});

test("翻译自动续跑：多 P 换了分 P、番剧换了一集都不续跑；地址认不出分集时问页面当前的 cid", async () => {
  const record = (bvid, cid, pageKey) => ({
    jobId: `job-${bvid}-${cid}`, tabId: 5, bvid, cid, ...(pageKey ? { pageKey } : {}),
    cues: englishCues(3), done: 0, total: 3, pending: true, halted: false, savedAt: Date.now()
  });
  const cases = [
    { url: "https://www.bilibili.com/video/BVmulti?p=3", rec: record("BVmulti", 22, "video:BVmulti:2"), resume: false },
    { url: "https://www.bilibili.com/video/BVmulti?p=2&t=10", rec: record("BVmulti", 22, "video:BVmulti:2"), resume: true },
    { url: "https://www.bilibili.com/bangumi/play/ep1001", rec: record("BVep", 5, "ep:100"), resume: false },
    { url: "https://www.bilibili.com/bangumi/play/ep100", rec: record("BVep", 5, "ep:100"), resume: true },
    { url: "https://www.bilibili.com/bangumi/play/ss8", rec: record("BVss", 6, "ss:8"), metaCid: 7, resume: false },
    { url: "https://www.bilibili.com/bangumi/play/ss8", rec: record("BVss", 6, "ss:8"), metaCid: 6, resume: true },
    // 旧存档没记页面标识：番剧页、同一 BV 的某一 P 都要问页面当前播的 cid
    { url: "https://www.bilibili.com/bangumi/play/ep7", rec: record("BVold", 9), metaCid: 8, resume: false },
    { url: "https://www.bilibili.com/bangumi/play/ep7", rec: record("BVold", 9), metaCid: 9, resume: true },
    { url: "https://www.bilibili.com/video/BVold2?p=2", rec: record("BVold2", 31), resume: false },
    { url: "https://www.bilibili.com/video/BVold2?p=2", rec: record("BVold2", 31), metaCid: 31, resume: true }
  ];
  for (const c of cases) {
    const env = loadBackground(async () => new Promise(() => {}), { tabs: [{ id: 5, url: c.url }] });
    await settle(env);
    env.B.chrome.tabs.sendMessage = async (_tabId, message) => (message.type === "GET_META" ? { cid: c.metaCid || 0 } : {});
    const key = `trJob:${c.rec.bvid}:${c.rec.cid}`;
    env.store[key] = c.rec;
    env.store.trJobIndex = { [key]: { bvid: c.rec.bvid, cid: c.rec.cid, tabId: 5 } };
    await env.B.resumePendingTranslateJobs();
    const job = env.B.findTranslateJob({ bvid: c.rec.bvid, cid: c.rec.cid });
    assert.equal(Boolean(job), c.resume, `${c.url} ${c.rec.pageKey || "（旧存档）"}`);
    if (job) await env.B.cancelTranslateJob(job.jobId, { bvid: c.rec.bvid, cid: c.rec.cid });
  }

  // 开始翻译时按标签页地址记下页面标识，写进存档
  const env = loadBackground(async () => new Promise(() => {}));
  await settle(env);
  env.B.chrome.tabs.get = async (id) => ({ id, url: "https://www.bilibili.com/bangumi/play/ep321?from=search" });
  const started = await env.B.startTranslate({ tabId: 5, bvid: "BVrec", cid: 3, cues: englishCues(3) });
  const job = env.B.findTranslateJob({ jobId: started.jobId });
  assert.equal(job.pageKey, "ep:321");
  await env.B.saveTranslateJob(job);
  assert.equal(env.store["trJob:BVrec:3"].pageKey, "ep:321");
  await env.B.cancelTranslateJob(job.jobId, { bvid: "BVrec", cid: 3 });
});

test("拖动进度条后按新位置重排还没派发的批次", async () => {
  const order = [];
  const { B, runtimeMessages } = loadBackground(async (_url, options) => {
    const body = JSON.parse(options.body);
    const ids = [...body.messages.at(-1).content.matchAll(/^\d+\. This is line (\d+)\.$/gm)].map((m) => Number(m[1]));
    order.push(ids[0]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return okJson(echoTranslate(body));
  });
  B.BiliCaptionPrefs.loadSettings = async () => ({ sumProvider: "OpenAI", apiKey: "key", translateConcurrency: 1 });
  const started = await B.startTranslate({ tabId: 1, bvid: "BV-seek", cid: 1, currentTime: 0, cues: englishCues(120) });
  assert.ok(await waitFor(() => order.length >= 1));
  assert.equal(B.reprioritizeTranslateJob({ jobId: started.jobId, time: 200 }).ok, true);
  assert.ok(await waitFor(() => runtimeMessages.some((m) => m.type === "TRANSLATE_PROGRESS" && m.stage === "done")));
  // 第一批从开头；跳到 200 秒（第 101 行）后，下一批就从那附近开始
  assert.equal(order[0], 1);
  assert.ok(order.slice(1, 3).some((line) => line >= 99 && line <= 101), `实际顺序 ${order}`);
});

// ---------- 设置读取 ----------

test("读设置不再每次删 sync 旧键；确有旧键时只迁移并清理一次", async () => {
  const removed = [];
  const sync = { apiKey: "old-key", sumProvider: "OpenAI" };
  const local = {};
  const area = (store) => ({
    async get(keys) {
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]]));
      const out = { ...(keys || {}) };
      for (const key of Object.keys(keys || {})) if (key in store) out[key] = store[key];
      return out;
    },
    async set(values) { Object.assign(store, values); },
    async remove(keys) {
      removed.push(...keys);
      for (const key of keys) delete store[key];
    }
  });
  const context = { chrome: { storage: { sync: area(sync), local: area(local) } } };
  context.globalThis = context;
  vm.createContext(context);
  run(context, "lib/prefs.js");
  const Prefs = context.BiliCaptionPrefs;
  const first = await Prefs.loadSettings({ sumProvider: "", apiKey: "" });
  assert.equal(first.apiKey, "old-key");
  assert.equal(local.apiKey, "old-key");
  assert.deepEqual(removed, ["apiKey"]);
  await Prefs.loadSettings({ sumProvider: "", apiKey: "" });
  await Prefs.loadSettings({ sumProvider: "" });
  assert.deepEqual(removed, ["apiKey"]);
});

// ---------- 超长字幕大纲 ----------

test("超长字幕大纲按段并行产出章节，最终请求不再塞全文；合并时原章节变成小节", () => {
  const C = loadLibs(["lib/字幕工具.js", "lib/outline.js"]);
  const O = C.BiliCaptionOutline;
  const cues = Array.from({ length: 300 }, (_, i) => ({ from: i * 20, to: i * 20 + 18, content: `line ${i + 1} ${"x".repeat(60)}` }));
  const ranges = O.planOutlineChunks(cues, 4000);
  assert.ok(ranges.length > 3);
  assert.equal(ranges[0].from, 0);
  assert.equal(ranges.at(-1).to, 299);
  ranges.slice(1).forEach((range, i) => assert.equal(range.from, ranges[i].to + 1));

  const prompt = O.buildChunkOutlinePrompt(cues, ranges[1], { part: 2, parts: ranges.length });
  const first = ranges[1].from + 1;
  assert.match(prompt, new RegExp(`^${first}\\t`, "m"));
  assert.doesNotMatch(prompt, /^1\tline 1 /m);
  assert.match(prompt, new RegExp(`只能落在 ${first} 到 ${ranges[1].to + 1} 之间`));
  assert.match(prompt, /summary、chapters/);

  const chapters = Array.from({ length: 14 }, (_, i) => ({ start: i * 400, end: (i + 1) * 400, title: `章${i + 1}`, synopsis: `摘要${i + 1}` }));
  const layout = O.outlineLayout(cues);
  const merge = O.buildOutlineMergePrompt(chapters, ["第一段要点"], layout);
  assert.doesNotMatch(merge, /line 1 x/);
  assert.match(merge, /1\. \[00:00–06:40\] 章1/);
  // 满 1 小时的时间标签带小时（与侧栏、标记、浮窗同一格式）
  assert.match(merge, /14\. \[1:26:40–1:33:20\] 章14/);
  const parsed = O.parseOutlineMerge('```json\n{"summary":"全片总览","groups":[{"title":"上半","synopsis":"甲","chapters":[1,2,3]},{"title":"下半","synopsis":"乙","chapters":[4,5]}]}\n```');
  const merged = O.mergeOutlineGroups(chapters, parsed.groups);
  assert.equal(merged[0].title, "上半");
  assert.equal(merged[0].start, 0);
  assert.equal(merged[0].end, 1200);
  assert.deepEqual(plain(merged[0].subs.map((sub) => sub.title)), ["章1", "章2", "章3"]);
  // 漏掉的章节单独成章，不丢内容
  assert.equal(merged.length, 2 + 9);
  const finalized = O.finalizeOutline(merged, cues);
  assert.equal(finalized[0].title, "上半");
});

// ---------- 侧栏接线 ----------

test("侧栏：选区总结可中止旧请求，翻译进度按补丁更新，大纲失败不清空已流出的章节", () => {
  const panel = panelSource();
  const html = fs.readFileSync(path.join(root, "sidepanel.html"), "utf8");
  const options = fs.readFileSync(path.join(root, "options.html"), "utf8");
  const background = backgroundSource();
  assert.match(html, /lib\/模型路由\.js[\s\S]*lib\/模型调用\.js[\s\S]*sidepanel\.js/);
  assert.match(options, /lib\/模型调用\.js/);
  assert.ok(backgroundImports().includes("lib/模型调用.js"));
  const summarize = panel.match(/async function summarizeSelection\([\s\S]*?\n\}\n/)?.[0] || "";
  assert.match(summarize, /summaryAbort\?\.abort\(\)/);
  assert.match(summarize, /signal: ac\.signal/);
  assert.doesNotMatch(panel, /function readChatStream|function defaultChatModel|function chatErrorMessage|siliconflow|let translateConcurrency|summaryModel/);
  assert.match(panel, /function applyTranslatePatch\(patch, cueCount\)/);
  assert.match(panel, /type: "TRANSLATE_SEEK"/);
  assert.match(panel, /currentTime: translateSeekAt/);
  const outline = panel.match(/async function generateOutline\([\s\S]*?\n\}\n/)?.[0] || "";
  assert.match(outline, /if \(!streamed\) \{/);
  assert.doesNotMatch(outline, /buildChaptersPrompt|buildSummaryMapPrompt/);
  assert.doesNotMatch(background, /translateBatchWithFallback|function defaultChatModel|siliconflow/);
});
