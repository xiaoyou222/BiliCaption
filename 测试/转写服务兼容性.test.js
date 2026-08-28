const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const root = path.resolve(__dirname, "..");

function loadStt(fetchImpl) {
  const context = {
    console,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Blob,
    FormData,
    DOMException,
    crypto: webcrypto,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
    chrome: {
      permissions: {
        async request() { return true; }
      }
    }
  };
  context.self = context;
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "lib/providers.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(root, "lib/stt.js"), "utf8"), context);
  return context;
}

test("自定义接口只允许 https，本机可用 http", () => {
  const C = loadStt(async () => { throw new Error("不应请求网络"); });
  const P = C.BiliCaptionProviders;
  assert.equal(P.assertSafeApiUrl("https://api.openai.com/v1").protocol, "https:");
  assert.equal(P.assertSafeApiUrl("http://127.0.0.1:11434/v1").hostname, "127.0.0.1");
  assert.throws(() => P.assertSafeApiUrl("http://example.com/v1"), /https/);
  assert.throws(() => P.assertSafeApiUrl("not-a-url"), /无效/);
});

test("转写服务商只剩 Fish Audio / Groq / OpenAI", () => {
  const C = loadStt(async () => { throw new Error("不应请求网络"); });
  assert.deepEqual(Array.from(C.BiliCaptionProviders.STT_PROVIDERS), ["Fish Audio", "Groq", "OpenAI", "ElevenLabs"]);
  assert.equal(C.BiliCaptionProviders.schema("Fish Audio").kind, "fish");
  assert.equal(C.BiliCaptionProviders.schema("OpenAI").editableUrl, true);
  assert.equal(C.BiliCaptionProviders.schema("Groq").editableUrl, undefined);
});

test("未知旧服务商回落到 Groq，无效备用不启用", () => {
  const C = loadStt(async () => { throw new Error("不应请求网络"); });
  const P = C.BiliCaptionProviders;
  const cfg = P.resolveStt({
    sttProvider: "火山引擎",
    sttModel: "bigmodel",
    sttCreds: { Groq: { key: "gsk" }, 火山引擎: { apiKey: "old" } }
  });
  assert.equal(cfg.provider, "Groq");
  assert.equal(cfg.key, "gsk");
  assert.equal(cfg.kind, "openai");
  assert.equal(cfg.model, "whisper-large-v3-turbo");
  assert.equal(P.resolveBackup({ backupProvider: "讯飞", sttCreds: { 讯飞: { appid: "1", key: "x" } } }), null);
  assert.equal(P.resolveBackup({ backupProvider: "不启用" }), null);
});

test("OpenAI 改接口地址后请求打到新 host，空值回落官方地址", async () => {
  let capturedUrl;
  const C = loadStt(async (url, options) => {
    capturedUrl = url;
    return {
      ok: true,
      status: 200,
      headers: { get() { return null; } },
      async text() { return JSON.stringify({ text: "ok" }); }
    };
  });
  const custom = C.BiliCaptionProviders.resolveStt({
    sttProvider: "OpenAI",
    sttCreds: { OpenAI: { key: "test", url: "https://gateway.example.com/v1/" } }
  });
  assert.equal(custom.base, "https://gateway.example.com/v1");
  assert.equal(custom.model, "whisper-1");
  await C.BiliCaptionStt.transcribe(
    new Blob([new Uint8Array([1])], { type: "audio/mp4" }),
    custom
  );
  assert.equal(capturedUrl, "https://gateway.example.com/v1/audio/transcriptions");

  const empty = C.BiliCaptionProviders.resolveStt({
    sttProvider: "OpenAI",
    sttCreds: { OpenAI: { key: "test", url: "   " } }
  });
  assert.equal(empty.base, "https://api.openai.com/v1");
});

test("Groq 与 Fish 忽略用户填写的 URL", () => {
  const C = loadStt(async () => { throw new Error("不应请求网络"); });
  const groq = C.BiliCaptionProviders.resolveStt({
    sttProvider: "Groq",
    sttCreds: { Groq: { key: "gsk", url: "https://evil.example/v1" } }
  });
  const fish = C.BiliCaptionProviders.resolveStt({
    sttProvider: "Fish Audio",
    sttCreds: { "Fish Audio": { key: "k", url: "https://evil.example" } }
  });
  assert.equal(groq.base, "https://api.groq.com/openai/v1");
  assert.equal(fish.base, "https://api.fish.audio");
});

test("Fish Audio 使用 multipart audio 并保留秒级时间轴", async () => {
  let captured;
  const C = loadStt(async (url, options) => {
    captured = { url, headers: options.headers, entries: [...options.body.entries()] };
    return {
      ok: true,
      status: 200,
      headers: { get() { return null; } },
      async text() {
        return JSON.stringify({
          text: "第一句。第二句。",
          duration: 3.1,
          language_code: "zh",
          segments: [
            { text: "第一句。", start: 0, end: 1.2 },
            { text: "第二句。", start: 1.3, end: 3.1 }
          ]
        });
      }
    };
  });
  const cfg = C.BiliCaptionProviders.resolveStt({
    sttProvider: "Fish Audio",
    sttCreds: { "Fish Audio": { key: "fish-key" } }
  });
  const result = await C.BiliCaptionStt.transcribe(
    new Blob([new Uint8Array([1])], { type: "audio/mp4" }),
    cfg,
    { duration: 3.1, language: "zh", filename: "audio.m4a" }
  );

  assert.equal(cfg.kind, "fish");
  assert.equal(cfg.base, "https://api.fish.audio");
  assert.equal(captured.url, "https://api.fish.audio/v1/asr");
  assert.equal(captured.headers.Authorization, "Bearer fish-key");
  const fields = Object.fromEntries(captured.entries.filter(([key]) => key !== "audio"));
  assert.equal(fields.ignore_timestamps, "false");
  assert.equal(fields.language, "zh");
  assert.ok(captured.entries.some(([key, value]) => key === "audio" && value instanceof Blob));
  assert.deepEqual(
    Array.from(result.segments, (segment) => ({
      start: segment.start,
      end: segment.end,
      text: segment.text
    })),
    [
      { start: 0, end: 1.2, text: "第一句。" },
      { start: 1.3, end: 3.1, text: "第二句。" }
    ]
  );
  assert.equal(result.text, "第一句。第二句。");
});

test("Fish 测连通走 ASR 而不是 /models", async () => {
  let captured;
  const C = loadStt(async (url, options) => {
    captured = { url, keys: [...options.body.keys()] };
    return {
      ok: true,
      status: 200,
      headers: { get() { return null; } },
      async text() { return JSON.stringify({ text: "", duration: 1, segments: [] }); }
    };
  });
  const cfg = C.BiliCaptionProviders.resolveStt({
    sttProvider: "Fish Audio",
    sttCreds: { "Fish Audio": { key: "fish-key" } }
  });
  assert.deepEqual(Array.from(await C.BiliCaptionStt.listModels("stt", cfg)), []);
  const result = await C.BiliCaptionStt.testConnection(cfg);
  assert.equal(result.ok, true);
  assert.equal(captured.url, "https://api.fish.audio/v1/asr");
  assert.ok(captured.keys.includes("audio"));
  assert.ok(captured.keys.includes("ignore_timestamps"));
  assert.ok(!captured.keys.includes("model"));
});

test("中文 language 只作语种提示，不把转写要求塞进 Whisper prompt", async () => {
  let captured;
  const C = loadStt(async (_url, options) => {
    captured = Object.fromEntries([...options.body.entries()].filter(([key]) => key !== "file"));
    return {
      ok: true,
      status: 200,
      headers: { get() { return null; } },
      async text() { return JSON.stringify({ text: "你好" }); }
    };
  });
  await C.BiliCaptionStt.transcribe(
    new Blob([new Uint8Array([1])], { type: "audio/mp4" }),
    {
      provider: "OpenAI", kind: "openai", base: "https://api.openai.com/v1",
      model: "whisper-1", key: "test"
    },
    { language: "zh" }
  );
  assert.equal(captured.language, "zh");
  assert.equal(captured.prompt, undefined);
});

test("OpenAI 新转写模型使用 json，Whisper 与 Groq 才请求时间戳", async () => {
  const requests = [];
  const C = loadStt(async (url, options) => {
    requests.push({ url, entries: [...options.body.entries()] });
    return {
      ok: true,
      status: 200,
      headers: { get() { return null; } },
      async text() { return JSON.stringify({ text: "hello" }); }
    };
  });
  const blob = new Blob([new Uint8Array([1])], { type: "audio/mp4" });
  await C.BiliCaptionStt.transcribe(blob, {
    provider: "OpenAI", kind: "openai", base: "https://api.openai.com/v1",
    model: "gpt-4o-mini-transcribe", key: "test"
  });
  await C.BiliCaptionStt.transcribe(blob, {
    provider: "Groq", kind: "openai", base: "https://api.groq.com/openai/v1",
    model: "whisper-large-v3-turbo", key: "test"
  });

  const first = Object.fromEntries(requests[0].entries.filter(([key]) => key !== "file"));
  const secondKeys = requests[1].entries.map(([key]) => key);
  assert.equal(first.response_format, "json");
  assert.equal(first["timestamp_granularities[]"], undefined);
  assert.equal(Object.fromEntries(requests[1].entries).response_format, "verbose_json");
  assert.equal(secondKeys.filter((key) => key === "timestamp_granularities[]").length, 2);
});

test("三家转写都接受 M4A，切片上限仍是 8 分钟 / 20MB", () => {
  const C = loadStt(async () => { throw new Error("不应请求网络"); });
  const P = C.BiliCaptionProviders;
  for (const name of P.STT_PROVIDERS) {
    const cfg = P.resolveStt({ sttProvider: name, sttCreds: { [name]: { key: "test" } } });
    assert.equal(P.acceptsSttExtension(cfg, "m4a"), true);
    assert.equal(P.sttCompatibilityError(cfg, "m4a"), "");
    const limits = P.sttLimits(cfg);
    assert.equal(limits.maxSeconds, 8 * 60);
    assert.equal(limits.maxBytes, 20 * 1024 * 1024);
    assert.equal(limits.hardDuration, false);
  }
});

test("总结服务商只剩 OpenAI / Gemini / DeepSeek / 自定义", () => {
  const C = loadStt(async () => { throw new Error("不应请求网络"); });
  const P = C.BiliCaptionProviders;
  assert.deepEqual(Array.from(P.SUM_PROVIDERS), ["OpenAI", "Gemini", "DeepSeek", "自定义"]);
  const gemini = P.resolveSum({ sumProvider: "Gemini", apiKey: "k" });
  assert.equal(gemini.provider, "Gemini");
  assert.equal(gemini.base, "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(gemini.model, "gemini-2.5-flash");
  const hijack = P.resolveSum({
    sumProvider: "Gemini",
    apiBase: "https://evil.example/v1",
    apiKey: "k"
  });
  assert.equal(hijack.base, "https://generativelanguage.googleapis.com/v1beta/openai");
  const def = P.resolveSum({});
  assert.equal(def.provider, "OpenAI");
  assert.equal(def.base, "https://api.openai.com/v1");
  assert.equal(def.model, "gpt-4o-mini");
});

test("旧总结服务商迁移到自定义或 OpenAI", () => {
  const C = loadStt(async () => { throw new Error("不应请求网络"); });
  const P = C.BiliCaptionProviders;

  const gatewayUrl = P.migrateSum({
    sumProvider: "统一网关",
    apiBase: "https://cpa.example/v1/",
    apiKey: "k",
    apiModel: "xy-smart",
    translateModel: "xy-fast"
  });
  assert.equal(gatewayUrl.sumProvider, "自定义");
  assert.equal(gatewayUrl.apiBase, "https://cpa.example/v1");
  assert.equal(gatewayUrl.apiKey, "k");
  assert.equal(gatewayUrl.apiModel, "xy-smart");
  assert.equal(gatewayUrl.translateModel, "");

  const gatewayEmpty = P.migrateSum({
    sumProvider: "统一网关",
    apiKey: "k",
    translateModel: "xy-backup"
  });
  assert.equal(gatewayEmpty.sumProvider, "OpenAI");
  assert.equal(gatewayEmpty.translateModel, "");

  const named = P.migrateSum({
    sumProvider: "通义千问",
    apiKey: "sk-sum",
    apiModel: "qwen-plus"
  });
  assert.equal(named.sumProvider, "自定义");
  assert.equal(named.apiBase, "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.equal(named.apiKey, "sk-sum");
  assert.equal(named.apiModel, "qwen-plus");

  const resolved = P.resolveSum({
    sumProvider: "智谱 GLM",
    apiKey: "glm-key"
  });
  assert.equal(resolved.provider, "自定义");
  assert.equal(resolved.base, "https://open.bigmodel.cn/api/paas/v4");
  assert.equal(resolved.key, "glm-key");

  const kimi = P.migrateSum({ sumProvider: "Kimi", apiKey: "kimi-key" });
  assert.equal(kimi.sumProvider, "自定义");
  assert.equal(kimi.apiBase, "https://api.moonshot.cn/v1");
  assert.equal(kimi.apiKey, "kimi-key");

  const openrouter = P.migrateSum({ sumProvider: "OpenRouter", apiKey: "or-key" });
  assert.equal(openrouter.sumProvider, "自定义");
  assert.equal(openrouter.apiBase, "https://openrouter.ai/api/v1");
  assert.equal(openrouter.apiKey, "or-key");

  const unknown = P.migrateSum({ sumProvider: "Claude" });
  assert.equal(unknown.sumProvider, "OpenAI");
});

test("通道备注进入标签，两个 Groq 账号能区分", () => {
  const C = loadStt(async () => { throw new Error("不应请求网络"); });
  const P = C.BiliCaptionProviders;
  const main = P.normalizeChannel({ provider: "Groq", key: "gsk_main", note: "主账号" });
  const backup = P.normalizeChannel({ provider: "Groq", key: "gsk_backup", note: "  备用账号  " });
  const plain = P.normalizeChannel({ provider: "Groq", key: "gsk_plain", note: "   " });
  assert.equal(main.note, "主账号");
  assert.equal(backup.note, "备用账号");
  assert.equal(plain.note, "");
  assert.equal(P.channelLabel(main), "Groq · 主账号");
  assert.equal(P.channelLabel(backup), "Groq · 备用账号");
  assert.equal(P.channelLabel(plain), "Groq");
  assert.equal(P.channelLabel(null), "转写");
  const chain = P.resolveChannels({
    sttChannels: [
      { provider: "Groq", key: "gsk_main", note: "主账号" },
      { provider: "Groq", key: "gsk_backup", note: "备用账号" }
    ]
  });
  assert.equal(chain.length, 2);
  assert.equal(P.channelLabel(chain[0]), "Groq · 主账号");
  assert.equal(P.channelLabel(chain[1]), "Groq · 备用账号");
  assert.equal(
    `${P.channelLabel(chain[0])} 限流，已切到 ${P.channelLabel(chain[1])} 继续`,
    "Groq · 主账号 限流，已切到 Groq · 备用账号 继续"
  );
});

test("停用的转写通道不进入可用链", () => {
  const C = loadStt(async () => { throw new Error("不应请求网络"); });
  const P = C.BiliCaptionProviders;
  const on = P.normalizeChannel({ provider: "Groq", key: "gsk_on" });
  const off = P.normalizeChannel({ provider: "Groq", key: "gsk_off", off: true });
  assert.equal(P.channelUsable(on), true);
  assert.equal(P.channelUsable(off), false);
  const usable = P.resolveChannels({
    sttChannels: [
      { provider: "Groq", key: "gsk_off", off: true },
      { provider: "Fish Audio", key: "sk_fish" }
    ]
  }).filter((cfg) => P.channelUsable(cfg));
  assert.equal(usable.length, 1);
  assert.equal(usable[0].provider, "Fish Audio");
});
