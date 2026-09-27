const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

function storageArea(store) {
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
      Object.assign(store, values || {});
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
    },
    async setAccessLevel() {}
  };
}

/**
 * 加载真实的 background.js 及其依赖（providers / stt / mp4-aac），chrome API 与网络全部 mock。
 * 计时器走外层（可被 t.mock.timers 接管），Date 也用外层的，便于用虚拟时间跑限流、退避、超时。
 */
function loadAsr({ fetchImpl, session = {}, tabs = {}, settings = {} } = {}) {
  const local = {};
  const sessionStore = { ...session };
  const sent = [];
  const tabMessages = [];
  const listeners = [];
  const removedListeners = [];
  const noopEvent = { addListener() {} };
  const context = {
    console: { ...console, log() {}, warn() {} },
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Blob,
    FormData,
    AbortController,
    AbortSignal,
    DOMException,
    Date: globalThis.Date,
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: (...args) => globalThis.clearTimeout(...args),
    setInterval: (...args) => globalThis.setInterval(...args),
    clearInterval: (...args) => globalThis.clearInterval(...args),
    fetch: (...args) => (fetchImpl ? fetchImpl(...args) : Promise.reject(new Error("不应请求网络"))),
    importScripts() {},
    chrome: {
      runtime: {
        id: "test-extension",
        onInstalled: noopEvent,
        onStartup: noopEvent,
        onMessage: { addListener(fn) { listeners.push(fn); } },
        async sendMessage(message) { sent.push(message); },
        getURL(file) { return `chrome-extension://test-extension/${file}`; },
        async getContexts() { return []; },
        lastError: null,
        async getPlatformInfo() { return {}; }
      },
      sidePanel: {
        async setPanelBehavior() {},
        async setOptions() {},
        async open() {}
      },
      tabs: {
        query(_query, callback) {
          if (callback) callback([]);
          return Promise.resolve([]);
        },
        async sendMessage(tabId, message) { tabMessages.push({ tabId, message }); },
        async get(tabId) {
          if (tabs[tabId]) return tabs[tabId];
          throw new Error(`No tab with id: ${tabId}`);
        },
        onRemoved: { addListener(fn) { removedListeners.push(fn); } }
      },
      declarativeNetRequest: { async updateDynamicRules() {} },
      storage: {
        local: storageArea(local),
        session: storageArea(sessionStore),
        sync: storageArea({})
      }
    },
    BiliCaptionPrefs: { async loadSettings(defaults) { return { ...defaults, ...settings }; } }
  };
  context.self = context;
  vm.createContext(context);
  loadBackgroundScripts(context, [
    "lib/视频平台.js",
    "lib/字幕工具.js",
    "lib/mp4-aac.js",
    "lib/zh-simp.js",
    "lib/translate.js",
    "lib/模型路由.js",
    "lib/模型调用.js",
    "lib/providers.js",
    "lib/stt.js"
  ]);
  // 顶层 const 不是全局属性，单独取出来给测试用
  context.asrJobs = vm.runInContext("asrJobs", context);
  context.asrJobLocks = vm.runInContext("asrJobLocks", context);
  context.__local = local;
  context.__session = sessionStore;
  context.__sent = sent;
  context.__tabMessages = tabMessages;
  context.__listeners = listeners;
  context.__removedListeners = removedListeners;
  return context;
}

const flush = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** 用虚拟时间推进，直到 promise 结束 */
async function settle(t, promise, { step = 500, limitMs = 3 * 3600 * 1000 } = {}) {
  let done = false;
  let value;
  let error;
  promise.then((v) => { done = true; value = v; }, (e) => { done = true; error = e; });
  let elapsed = 0;
  await flush();
  while (!done) {
    if (elapsed > limitMs) throw new Error(`虚拟时间过了 ${elapsed}ms 仍未结束`);
    t.mock.timers.tick(step);
    elapsed += step;
    await flush();
  }
  if (error) throw error;
  return value;
}

async function advance(t, ms, step = 250) {
  for (let spent = 0; spent < ms; spent += step) {
    t.mock.timers.tick(step);
    await flush();
  }
}

function channel(provider, key, note = "") {
  const base = {
    Groq: "https://api.groq.com/openai/v1",
    OpenAI: "https://api.openai.com/v1",
    "Fish Audio": "https://api.fish.audio",
    ElevenLabs: "https://api.elevenlabs.io/v1"
  }[provider];
  return { provider, kind: provider === "Fish Audio" ? "fish" : provider === "ElevenLabs" ? "elevenlabs" : "openai", base, model: "whisper-large-v3", key, note };
}

function makeJob(channels, extra = {}) {
  return {
    jobId: extra.jobId || "job-1",
    controller: new AbortController(),
    tabId: 0,
    bvid: extra.bvid || "BV1test",
    cid: extra.cid || 1,
    channels,
    channelCools: [],
    deadChannels: [],
    channelBusy: [],
    activeChannel: 0,
    sttCfg: channels[0]
  };
}

function fakeChunks(n, { seconds = 480, overlap = 2.5 } = {}) {
  const chunks = [];
  let start = 0;
  for (let i = 0; i < n; i += 1) {
    const end = start + seconds;
    chunks.push({
      blob: new Blob([new Uint8Array(4096)], { type: "audio/mp4" }),
      filename: "audio.m4a",
      start,
      end,
      overlap: i ? overlap : 0,
      tail: i < n - 1 ? overlap : 0
    });
    start = end - overlap;
  }
  return chunks;
}

/** 让分段来源直接吐出假分段；下载本身仍走 openAudioDownload + mock fetch */
function useFakeSource(B, chunks, log = []) {
  B.BiliCaptionMp4.iterateFmp4Chunks = async function* (reader) {
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    for (const chunk of chunks) {
      log.push({ type: "yield", at: Date.now(), start: chunk.start });
      yield chunk;
    }
  };
}

function audioResponse(bytes = new Uint8Array([1, 2, 3, 4]), { status = 200, headers = {} } = {}) {
  let sent = false;
  const head = { "content-length": String(bytes.length), ...headers };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => head[String(name).toLowerCase()] ?? null },
    body: {
      getReader() {
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: bytes };
          },
          async cancel() {}
        };
      }
    }
  };
}

/** 跑一次完整转写（跳过取播放地址）；onProgress 与 runAsrJob 一致地转成广播 */
function runTranscribe(B, job, { duration = 1920, stream } = {}) {
  job.controller = job.controller || new AbortController();
  B.asrJobs.set(job.jobId, job);
  return B.transcribeAudio(stream || { id: 30216, baseUrl: "https://upos.bilivideo.com/a.m4s" }, {
    meta: { bvid: job.bvid, cid: job.cid, aid: 1 },
    language: "zh",
    signal: job.controller.signal,
    duration,
    tabId: 0,
    forceRestart: true,
    job,
    onProgress: (info) => {
      const extra = typeof info === "string" ? { message: info } : info;
      B.jobBroadcast(job, { stage: extra.stage || job.progress?.stage || "upload", ...extra });
    }
  }).finally(() => B.asrJobs.delete(job.jobId));
}

function segmentResult(text, start = 10, end = 12) {
  return { text, segments: [{ start, end, text }], words: [] };
}

function httpError(status, message, extra = {}) {
  const error = new Error(message);
  error.status = status;
  Object.assign(error, extra);
  return error;
}

const groqAshMessage = (wait = "1m0s") => "Rate limit reached for model `whisper-large-v3` in organization `org_x` service tier `on_demand` on seconds of audio per hour (ASH): Limit 7200, Used 7100, Requested 480. Please try again in "
  + `${wait}. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing`;

// ---------------- 错误分类 ----------------

test("错误分类：额度用完判通道失效，限流才冷却，ASH 不再误中 crash / flash", () => {
  const B = loadAsr();
  const groq = channel("Groq", "g");
  const openai = channel("OpenAI", "o");
  const insufficient = httpError(429, "You exceeded your current quota, please check your plan and billing details.", { code: "insufficient_quota" });
  assert.equal(B.classifyAsrError(insufficient, openai).kind, "dead");
  assert.equal(B.classifyAsrError(httpError(402, "Payment Required"), openai).kind, "dead");
  assert.equal(B.classifyAsrError(httpError(401, "This request exceeds your quota of 10000", { code: "quota_exceeded" }), channel("ElevenLabs", "e")).kind, "dead");

  // Groq 的 ASH 限流文案里带 settings/billing 链接，也只能算限流
  const limited = B.classifyAsrError(httpError(429, groqAshMessage("1m24.5s")), groq);
  assert.equal(limited.kind, "quota");
  assert.equal(limited.waitMs, 84500);
  assert.equal(limited.hourly, true);

  // 旧的 /ASH/i 会把 crash、flash 当成限流无限重试
  assert.equal(B.classifyAsrError(httpError(400, "decoder crash on flash segment"), groq).kind, "chunk");
  assert.equal(B.classifyAsrError(httpError(400, "Audio file could not be decoded"), openai).kind, "chunk");

  // retryAfter 统一是毫秒：5 秒就是 5000，不会被当成秒再乘 1000
  assert.equal(B.classifyAsrError(httpError(429, "Too Many Requests", { retryAfter: 5000 }), openai).waitMs, 5000);
  assert.equal(B.classifyAsrError(httpError(429, "Too Many Requests", { retryAfter: 500 }), openai).waitMs, 2000);
  assert.equal(B.classifyAsrError(httpError(429, "Too Many Requests"), openai).waitMs, 60000);

  assert.equal(B.classifyAsrError(httpError(503, "Service Unavailable"), openai).kind, "transient");
  assert.equal(B.classifyAsrError(Object.assign(new Error("连不上 Groq（Failed to fetch）"), { network: true }), groq).kind, "transient");
  assert.equal(B.classifyAsrError(httpError(401, "Invalid API Key"), groq).kind, "dead");
  const tooLong = B.classifyAsrError(httpError(429, groqAshMessage().replace("Requested 480", "Requested 1500")), groq, { maxSeconds: 495 });
  assert.equal(tooLong.kind, "job");

  const parsed = B.parseGroqLimit("Please try again in 2m59.56s");
  assert.equal(parsed.waitMs, 179560);
  assert.equal(B.parseGroqLimit("crash flash splash").hourly, false);
  assert.equal(B.parseGroqLimit("on seconds of audio per day (ASD): Limit 28800").daily, true);
});

// ---------------- 通道分担与切换 ----------------

test("通道选择：按优先级挑有空位的通道，主通道占满时备用同时分担，冷却结束自动切回", () => {
  const B = loadAsr();
  const job = makeJob([channel("Groq", "a", "主"), channel("OpenAI", "b", "备")]);
  assert.equal(B.pickAsrChannel(job).idx, 0);
  job.channelBusy = [2, 0];
  assert.equal(B.pickAsrChannel(job).idx, 1, "Groq 同时最多 2 路，占满后交给下一条");
  job.channelBusy = [0, 0];
  job.channelCools = [Date.now() - 1, Date.now() + 60_000];
  assert.equal(B.pickAsrChannel(job).idx, 0, "主通道冷却已结束，不会继续等备用的长冷却");
  job.channelCools = [Date.now() + 60_000, 0];
  assert.equal(B.pickAsrChannel(job).idx, 1);
  job.deadChannels = [1];
  assert.equal(B.pickAsrChannel(job), null);
  assert.ok(B.asrChainRevivalMs(job) > 50_000);
  // 已试过且被拒的通道跳过
  job.channelCools = [];
  job.deadChannels = [];
  assert.equal(B.pickAsrChannel(job, { skip: new Set([0]) }).idx, 1);
});

test("Groq 额度前瞻：学到每小时上限后，剩余额度装不下下一段就先交给其他通道", () => {
  const B = loadAsr();
  const groq = channel("Groq", "gsk-look");
  const job = makeJob([groq, channel("OpenAI", "o")]);
  assert.equal(B.groqQuotaWaitMs(groq, 480), 0, "还不知道上限时不猜");
  B.learnGroqQuota(groq, httpError(429, groqAshMessage("3m0s")));
  const wait = B.groqQuotaWaitMs(groq, 480);
  assert.ok(wait > 0 && wait <= 3 * 60 * 1000, `等待 ${wait}`);
  assert.equal(B.groqQuotaWaitMs(groq, 90), 0, "短一点的段还装得下");
  const picked = B.pickAsrChannel(job, { seconds: 480 });
  assert.equal(picked.idx, 1);
  assert.ok(job.channelCools[0] > Date.now());

  // 响应头显示今日请求次数用完：冷却到重置时间
  const other = makeJob([channel("Groq", "gsk-rpd"), channel("OpenAI", "o")]);
  B.noteGroqRateHeaders(other, 0, { remainingRequests: 0, limitRequests: 2000, resetRequestsMs: 90_000 });
  assert.ok(other.channelCools[0] - Date.now() > 80_000);
  assert.equal(B.pickAsrChannel(other).idx, 1);
});

test("下载不等转写：分段先全部切出，多段并发转写，转完立刻释放音频", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_700_000_000_000 });
  const B = loadAsr({ fetchImpl: async () => audioResponse() });
  const chunks = fakeChunks(4);
  const log = [];
  useFakeSource(B, chunks, log);
  let active = 0;
  let maxActive = 0;
  let firstDoneAt = 0;
  let released = null;
  B.BiliCaptionStt = {
    ...B.BiliCaptionStt,
    async transcribe(blob, cfg, extra) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      active -= 1;
      if (!firstDoneAt) {
        firstDoneAt = Date.now();
        // 第一段刚转完时，最后一段应该还握着音频
        released = { last: Boolean(chunks[3].blob) };
      }
      return segmentResult(`第${Math.round(extra.duration)}秒段`);
    }
  };
  const job = makeJob([channel("Groq", "g")]);
  const result = await settle(t, runTranscribe(B, job));
  assert.equal(result.partial, false);
  assert.equal(result.cues.length, 4);
  assert.equal(maxActive, 2, "Groq 单通道同时 2 路");
  assert.ok(log.filter((item) => item.type === "yield").every((item) => item.at < firstDoneAt), "下载切片不等转写");
  assert.equal(released.last, true);
  assert.ok(chunks.every((chunk) => chunk.blob === null), "转完的分段不再占内存");
  assert.equal(B.__local["asrJob:BV1test:1"], undefined, "全部完成后清掉断点进度");
});

test("多通道同时分担：主通道占满后备用通道并行转写，总并发不超过 3", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_700_000_000_000 });
  const B = loadAsr({ fetchImpl: async () => audioResponse() });
  useFakeSource(B, fakeChunks(6));
  let active = 0;
  let maxActive = 0;
  const firstWave = [];
  B.BiliCaptionStt = {
    ...B.BiliCaptionStt,
    async transcribe(_blob, cfg) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (firstWave.length < 3) firstWave.push(cfg.provider);
      await new Promise((resolve) => setTimeout(resolve, 4000));
      active -= 1;
      return segmentResult(`${cfg.provider} 的结果`);
    }
  };
  const job = makeJob([channel("Groq", "g", "主"), channel("OpenAI", "o", "备")]);
  const result = await settle(t, runTranscribe(B, job, { duration: 2880 }));
  assert.equal(result.partial, false);
  assert.equal(maxActive, 3);
  assert.deepEqual(firstWave.sort(), ["Groq", "Groq", "OpenAI"]);
});

test("限流自动换通道；Groq 限流文案带 billing 链接也不会被当成额度用完", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_700_000_000_000 });
  const B = loadAsr({ fetchImpl: async () => audioResponse() });
  useFakeSource(B, fakeChunks(3));
  const calls = [];
  let limited = false;
  B.BiliCaptionStt = {
    ...B.BiliCaptionStt,
    async transcribe(_blob, cfg, extra) {
      calls.push({ provider: cfg.provider, current: extra.duration });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (cfg.provider === "Groq" && !limited) {
        limited = true;
        throw httpError(429, groqAshMessage("1m0s"), { retryAfter: 60_000 });
      }
      return segmentResult(`${cfg.provider} ok`);
    }
  };
  const job = makeJob([channel("Groq", "gsk-switch", "主"), channel("OpenAI", "o", "备")]);
  const result = await settle(t, runTranscribe(B, job, { duration: 1440 }));
  assert.equal(result.partial, false);
  assert.deepEqual(Array.from(job.deadChannels), [], "限流不是失效");
  assert.ok(calls.some((call) => call.provider === "OpenAI"), "限流的那段交给了备用通道");
  const switched = B.__sent.find((message) => message.type === "ASR_PROGRESS" && /限流，已切到/.test(message.message || ""));
  assert.ok(switched, "侧栏收到切换提示");
});

test("额度用完（insufficient_quota）立即停用该通道，不再重试它", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_700_000_000_000 });
  const B = loadAsr({ fetchImpl: async () => audioResponse() });
  useFakeSource(B, fakeChunks(4));
  const calls = { OpenAI: 0, Groq: 0 };
  B.BiliCaptionStt = {
    ...B.BiliCaptionStt,
    async transcribe(_blob, cfg) {
      calls[cfg.provider] += 1;
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (cfg.provider === "OpenAI") {
        throw httpError(429, "You exceeded your current quota", { code: "insufficient_quota", type: "insufficient_quota" });
      }
      return segmentResult("Groq ok");
    }
  };
  const job = makeJob([channel("OpenAI", "o"), channel("Groq", "g")]);
  const result = await settle(t, runTranscribe(B, job));
  assert.equal(result.partial, false);
  assert.equal(result.cues.length, 4);
  assert.deepEqual(Array.from(job.deadChannels), [0]);
  // OpenAI 优先级最高、同时 3 路：只有停用前已经派出去的第一波，之后一次都不再打
  assert.equal(calls.OpenAI, 3);
  assert.equal(calls.Groq, 4);
});

test("所有通道都失效时整个任务报错，不会空转", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_700_000_000_000 });
  const B = loadAsr({ fetchImpl: async () => audioResponse() });
  useFakeSource(B, fakeChunks(2));
  B.BiliCaptionStt = {
    ...B.BiliCaptionStt,
    async transcribe() {
      throw httpError(401, "Invalid API Key");
    }
  };
  const job = makeJob([channel("Groq", "g")]);
  await assert.rejects(settle(t, runTranscribe(B, job)), /所有转写通道都不可用/);
});

// ---------------- 重试上限与失败段 ----------------

test("临时故障重试有上限；只剩失败段时等待超时就按部分完成结束并保留进度", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_700_000_000_000 });
  const B = loadAsr({ fetchImpl: async () => audioResponse() });
  const chunks = fakeChunks(3);
  useFakeSource(B, chunks);
  let badCalls = 0;
  B.BiliCaptionStt = {
    ...B.BiliCaptionStt,
    async transcribe(blob) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (blob === chunks[1].blob) {
        badCalls += 1;
        throw httpError(503, "Service Unavailable");
      }
      return segmentResult("正常的一段");
    }
  };
  const job = makeJob([channel("Groq", "g")]);
  const started = Date.now();
  const sentBefore = B.__sent.length;
  const result = await settle(t, runTranscribe(B, job, { duration: 1440 }), { step: 1000 });
  assert.equal(badCalls, 7, "首次 + 6 次重试");
  assert.equal(result.partial, true);
  assert.match(result.reason, /1 段转写失败/);
  assert.equal(result.cues.length, 2);
  const waited = Date.now() - started;
  assert.ok(waited >= 10 * 60 * 1000 && waited < 20 * 60 * 1000, `等待 ${waited}ms`);
  const saved = B.__local["asrJob:BV1test:1"];
  assert.equal(saved.pending, true, "断点进度留着，下次继续只补失败段");
  assert.equal(saved.parts.length, 2);
  assert.ok(chunks.every((chunk) => chunk.blob === null), "收尾后释放全部音频");
  // 失败等待期间的进度广播是节流过的
  const progress = B.__sent.slice(sentBefore).filter((message) => message.type === "ASR_PROGRESS");
  assert.ok(progress.length < 400, `广播 ${progress.length} 次`);
});

test("失败段点重试后重新转写，任务完整结束", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_700_000_000_000 });
  const B = loadAsr({ fetchImpl: async () => audioResponse() });
  const chunks = fakeChunks(2);
  useFakeSource(B, chunks);
  let broken = true;
  B.BiliCaptionStt = {
    ...B.BiliCaptionStt,
    async transcribe(blob) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (blob === chunks[1].blob && broken) throw httpError(400, "Audio file could not be decoded");
      return segmentResult("好的");
    }
  };
  const job = makeJob([channel("Groq", "g")]);
  const work = runTranscribe(B, job, { duration: 960 });
  let finished = false;
  work.then(() => { finished = true; }, () => { finished = true; });
  await advance(t, 5000);
  assert.deepEqual(Array.from(job.failedChunks), [2]);
  assert.equal(finished, false, "失败段在等重试");
  broken = false;
  assert.equal(B.retryAsrChunks({ jobId: job.jobId }, { index: 2 }).ok, true);
  const result = await settle(t, work);
  assert.equal(result.partial, false);
  assert.equal(result.cues.length, 2);
});

test("所有通道长时间冷却超过等待预算，按部分完成收尾而不是一直等", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_700_000_000_000 });
  const B = loadAsr({ fetchImpl: async () => audioResponse() });
  const chunks = fakeChunks(3);
  useFakeSource(B, chunks);
  B.BiliCaptionStt = {
    ...B.BiliCaptionStt,
    async transcribe(blob) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (blob === chunks[0].blob) return segmentResult("第一段");
      throw httpError(429, "Too Many Requests", { retryAfter: 20 * 60 * 1000 });
    }
  };
  const job = makeJob([channel("OpenAI", "o")]);
  const started = Date.now();
  const result = await settle(t, runTranscribe(B, job, { duration: 1440 }), { step: 5000 });
  assert.equal(result.partial, true);
  assert.match(result.reason, /冷却/);
  assert.equal(result.cues.length, 1);
  const waited = Date.now() - started;
  assert.ok(waited < 45 * 60 * 1000, `只等了 ${Math.round(waited / 60000)} 分钟`);
  assert.ok(job.quotaWaitMs <= 30 * 60 * 1000);
});

test("暂停后不再派发新分段，继续后接着转", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_700_000_000_000 });
  const B = loadAsr({ fetchImpl: async () => audioResponse() });
  useFakeSource(B, fakeChunks(4));
  let calls = 0;
  B.BiliCaptionStt = {
    ...B.BiliCaptionStt,
    async transcribe() {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return segmentResult("段");
    }
  };
  const job = makeJob([channel("Groq", "g")]);
  const work = runTranscribe(B, job);
  await advance(t, 100);
  assert.equal(B.pauseAsrJob({ jobId: job.jobId }, true).paused, true);
  const during = calls;
  await advance(t, 20_000, 500);
  assert.equal(calls, during, "暂停期间没有新请求");
  B.pauseAsrJob({ jobId: job.jobId }, false);
  const result = await settle(t, work);
  assert.equal(result.cues.length, 4);
});

// ---------------- 锁 ----------------

test("同一视频加锁：对方还在准备时等待而不是覆盖，对方挂上结果后加入它", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_700_000_000_000 });
  const B = loadAsr();
  const key = B.asrLockKey("BV1lock", 3);
  B.asrJobs.set("A", { jobId: "A" });
  B.asrJobLocks.set(key, { jobId: "A" });
  let owner;
  const waiting = B.acquireAsrLock(key, "B", new AbortController().signal).then((value) => { owner = value; });
  await advance(t, 5000, 100);
  assert.equal(owner, undefined, "5 秒后仍在等，旧实现 2 秒就会抢锁");
  assert.equal(B.asrJobLocks.get(key).jobId, "A");
  const work = Promise.resolve({ cues: [] });
  B.asrJobLocks.set(key, { jobId: "A", work });
  await advance(t, 200, 50);
  await waiting;
  assert.equal(owner.jobId, "A");
  assert.equal(owner.work, work);

  // 锁的主人已经不在（异常退出没清理）才接手
  B.asrJobs.delete("A");
  B.asrJobLocks.set(key, { jobId: "A" });
  assert.equal(await B.acquireAsrLock(key, "C", new AbortController().signal), null);
  assert.equal(B.asrJobLocks.get(key).jobId, "C");
});

test("同一视频连点两次生成，只启动一个任务", async () => {
  const B = loadAsr();
  const first = B.startAsr({ bvid: "BV1twice", cid: 9, tabId: 5 }, null);
  const second = B.startAsr({ bvid: "BV1twice", cid: 9, tabId: 5 }, null);
  assert.equal(first.started, true);
  assert.equal(second.joined, true);
  assert.equal(second.jobId, first.jobId);
  await flush();
});

// ---------------- 下载续传 ----------------

function readerBody(pieces, { failAfter = false } = {}) {
  return {
    getReader() {
      let i = 0;
      return {
        async read() {
          if (i < pieces.length) return { done: false, value: pieces[i++] };
          if (failAfter) throw new TypeError("network error");
          return { done: true, value: undefined };
        },
        async cancel() {}
      };
    }
  };
}

function response(status, headers, body) {
  const head = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => head[String(name).toLowerCase()] ?? null },
    body
  };
}

async function readAll(t, reader) {
  const out = [];
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(...value);
    }
  })();
  await settle(t, pump, { step: 250 });
  return out;
}

test("下载断开后按字节 Range 续传；地址过期（403）会重新获取播放地址", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_700_000_000_000 });
  const bytes = Uint8Array.from({ length: 10 }, (_, i) => i);
  const calls = [];
  const B = loadAsr({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, range: options.headers?.Range || "" });
      if (calls.length === 1) return response(200, { "content-length": 10 }, readerBody([bytes.slice(0, 4)], { failAfter: true }));
      if (url.includes("old")) return response(403, {}, readerBody([]));
      return response(206, { "content-range": "bytes 4-9/10", "content-length": 6 }, readerBody([bytes.slice(4)]));
    }
  });
  let refreshed = 0;
  const opened = await B.openAudioDownload({ id: 30216, baseUrl: "https://upos.bilivideo.com/old.m4s" }, new AbortController().signal, {
    refresh: async (old) => {
      refreshed += 1;
      assert.equal(old.id, 30216);
      return { id: 30216, baseUrl: "https://upos.bilivideo.com/new.m4s" };
    }
  });
  assert.equal(opened.total, 10);
  const got = await readAll(t, opened.reader);
  assert.deepEqual(got, Array.from(bytes));
  assert.equal(refreshed, 1);
  assert.deepEqual(calls.map((call) => call.range), ["", "bytes=4-", "bytes=4-"]);
  assert.match(calls[2].url, /new\.m4s/);
});

test("CDN 提前干净断流也续传；服务器不认 Range 时从头下并丢掉已收部分", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_700_000_000_000 });
  const bytes = Uint8Array.from({ length: 10 }, (_, i) => 100 + i);
  let n = 0;
  const B = loadAsr({
    fetchImpl: async () => {
      n += 1;
      // 第一次：说好 10 字节，只给 4 字节就正常结束；第二次：无视 Range 返回整段 200
      if (n === 1) return response(200, { "content-length": 10 }, readerBody([bytes.slice(0, 4)]));
      return response(200, { "content-length": 10 }, readerBody([bytes.slice(0, 3), bytes.slice(3)]));
    }
  });
  const opened = await B.openAudioDownload({ id: 1, baseUrl: "https://upos.bilivideo.com/a.m4s" }, new AbortController().signal);
  const got = await readAll(t, opened.reader);
  assert.deepEqual(got, Array.from(bytes));
  assert.equal(n, 2);
});

test("重连次数有上限，超过后报下载中断并保留进度提示", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_700_000_000_000 });
  let n = 0;
  const B = loadAsr({
    fetchImpl: async () => {
      n += 1;
      if (n === 1) return response(200, { "content-length": 100 }, readerBody([new Uint8Array(10)], { failAfter: true }));
      throw new TypeError("Failed to fetch");
    }
  });
  const opened = await B.openAudioDownload({ id: 1, baseUrl: "https://upos.bilivideo.com/a.m4s" }, new AbortController().signal);
  await assert.rejects(readAll(t, opened.reader), /音频下载中断.*已保存进度/);
  assert.equal(n, 1 + 5);
});

test("X 音频选最低码率的音轨", () => {
  const B = loadAsr();
  const master = [
    "#EXTM3U",
    '#EXT-X-MEDIA:NAME="Audio",TYPE=AUDIO,GROUP-ID="audio-128000",DEFAULT=YES,URI="/amplify_video/1/pl/mp4a/128000/a.m3u8"',
    '#EXT-X-MEDIA:NAME="Audio",TYPE=AUDIO,GROUP-ID="audio-32000",URI="/amplify_video/1/pl/mp4a/32000/b.m3u8"',
    '#EXT-X-MEDIA:NAME="Audio",TYPE=AUDIO,GROUP-ID="audio-64000",URI="/amplify_video/1/pl/mp4a/64000/c.m3u8"'
  ].join("\n");
  const tracks = B.xManifestAudioTracks(master, "https://video.twimg.com/amplify_video/1/pl/master.m3u8");
  assert.equal(tracks.length, 3);
  assert.match(B.pickXAudioTrack(tracks).url, /\/mp4a\/32000\//);
  // 读不出码率时退回默认音轨
  assert.equal(B.pickXAudioTrack([{ url: "https://video.twimg.com/x/a.m3u8" }, { url: "https://video.twimg.com/x/b.m3u8", defaulted: true }]).url, "https://video.twimg.com/x/b.m3u8");
});

// ---------------- 分段边界与幻觉 ----------------

test("分段边界按重叠区中点用词级时间戳裁掉重复，被切开的一句拼回", () => {
  const B = loadAsr();
  const first = { start: 0, end: 480, overlap: 0, tail: 2.5 };
  const second = { start: 477.5, end: 957.5, overlap: 2.5, tail: 0 };
  const partA = B.resultToPartCues({
    segments: [
      { start: 470, end: 474, text: "今天先讲第一部分。" },
      { start: 476, end: 479.8, text: "接下来我们看第二部分" }
    ],
    words: [
      { word: "今天", start: 470, end: 470.8 }, { word: "先讲", start: 470.8, end: 471.6 },
      { word: "第一", start: 471.6, end: 472.6 }, { word: "部分", start: 472.6, end: 474 },
      { word: "接下来", start: 476, end: 477 }, { word: "我们", start: 477, end: 477.6 },
      { word: "看", start: 477.6, end: 478.2 }, { word: "第二", start: 478.9, end: 479.3 },
      { word: "部分", start: 479.3, end: 479.8 }
    ]
  }, first);
  const partB = B.resultToPartCues({
    segments: [
      { start: 0.1, end: 2.3, text: "们看第二部分，" },
      { start: 3, end: 6, text: "这里有三个要点。" }
    ],
    words: [
      { word: "们", start: 0.1, end: 0.2 }, { word: "看", start: 0.2, end: 0.8 },
      { word: "第二", start: 1.4, end: 1.8 }, { word: "部分", start: 1.8, end: 2.3 },
      { word: "这里", start: 3, end: 3.6 }, { word: "有", start: 3.6, end: 4 },
      { word: "三个", start: 4, end: 4.8 }, { word: "要点", start: 4.8, end: 6 }
    ]
  }, second);
  assert.equal(partA.at(-1).content, "接下来我们看");
  assert.equal(partB[0].content, "第二部分，");
  const merged = B.mergeChunkCues([
    { ...first, cues: partA, trimmed: true },
    { ...second, cues: partB, trimmed: true }
  ]);
  const text = Array.from(merged, (cue) => cue.content);
  assert.deepEqual(text, ["今天先讲第一部分。", "接下来我们看第二部分，", "这里有三个要点。"]);
  assert.ok(merged[2].from > 480);
});

test("没有词级时间戳时按句子中点取舍；裁剪后为空不会退回整段原文", () => {
  const B = loadAsr();
  const chunk = { start: 100, end: 580, overlap: 2.5, tail: 2.5 };
  const cues = B.resultToPartCues({
    text: "开头重复。中间内容。结尾重复。",
    segments: [
      { start: 0, end: 1, text: "开头重复。" },
      { start: 10, end: 20, text: "中间内容。" },
      { start: 478.9, end: 480, text: "结尾重复。" }
    ]
  }, chunk);
  assert.deepEqual(Array.from(cues, (cue) => cue.content), ["中间内容。"]);
  const empty = B.resultToPartCues({ text: "整段原文", segments: [{ start: 0.1, end: 0.5, text: "整段原文" }] }, chunk);
  assert.deepEqual(Array.from(empty), []);
});

test("旧进度的分段仍按文本去重，静音后的新句子不会被误删", () => {
  const B = loadAsr();
  const merged = B.mergeChunkCues([
    { start: 0, overlap: 0, cues: [
      { from: 100, to: 102, content: "前文" },
      { from: 478.8, to: 480, content: "重复一句" }
    ] },
    { start: 479.2, overlap: 0.8, cues: [
      { from: 0, to: 0.8, content: "重复一句。" },
      { from: 0.1, to: 1.2, content: "全新一句" }
    ] }
  ]);
  assert.equal(merged.filter((cue) => cue.content.includes("重复一句")).length, 1);
  assert.equal(merged.some((cue) => cue.content.includes("全新一句")), true);
});

test("过滤 Whisper 明显的幻觉段，阈值保守，没有质量指标的不动", () => {
  const B = loadAsr();
  const cues = B.resultToPartCues({
    segments: [
      { start: 0, end: 2, text: "谢谢观看", no_speech_prob: 0.6, avg_logprob: -0.4, compression_ratio: 1 },
      { start: 3, end: 6, text: "这是正文内容。", no_speech_prob: 0.02, avg_logprob: -0.2, compression_ratio: 1.2 },
      { start: 7, end: 9, text: "嗯嗯嗯嗯嗯", no_speech_prob: 0.92, avg_logprob: -1.3, compression_ratio: 1.1 },
      { start: 10, end: 20, text: "好的好的好的好的好的好的好的好的", no_speech_prob: 0.1, avg_logprob: -1.2, compression_ratio: 3.4 },
      { start: 21, end: 24, text: "谢谢观看，我们下期见。", no_speech_prob: 0.05, avg_logprob: -0.3, compression_ratio: 1.1 }
    ]
  }, { start: 0, end: 30 });
  assert.deepEqual(Array.from(cues, (cue) => cue.content), ["这是正文内容。", "谢谢观看，我们下期见。"]);
  const plain = B.resultToPartCues({ segments: [{ start: 0, end: 2, text: "谢谢观看" }] }, { start: 0, end: 30 });
  assert.deepEqual(Array.from(plain, (cue) => cue.content), ["谢谢观看"]);
});

test("断点续传：起点对不上的旧分段不会被拿来顶替，改用全局时间轴的缓存字幕", () => {
  const B = loadAsr();
  const oldPart = { i: 1, start: 477.5, end: 957.5, complete: true, cues: [{ from: 1, to: 470, content: "旧第二段" }] };
  assert.equal(B.partCoversChunk(oldPart, { start: 87.5, end: 567.5 }), false);
  assert.equal(B.partCoversChunk(oldPart, { start: 477.6, end: 957.5 }), true);
  const cached = Array.from({ length: 60 }, (_, i) => ({ from: 90 + i * 8, to: 95 + i * 8, content: `缓存${i}` }));
  const parts = B.matchSavedParts([{ start: 87.5, end: 567.5 }], { total: 3, parts: [oldPart] }, cached);
  assert.ok(parts[0]);
  assert.equal(parts[0].cues[0].content, "缓存0");
  assert.ok(Math.abs(parts[0].cues[0].from - 2.5) < 1e-6, "时间换算到这一段的起点");
});

// ---------------- 广播 ----------------

test("进度广播节流：高频下载进度每 250ms 最多一次，字幕只在有新结果或结束时带", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_700_000_000_000 });
  const B = loadAsr();
  const job = { jobId: "bc", tabId: 1, bvid: "BV1bc", cid: 1 };
  const progress = () => B.__sent.filter((message) => message.type === "ASR_PROGRESS");
  for (let i = 0; i < 100; i += 1) B.jobBroadcast(job, { stage: "download", message: `下载 ${i}%` });
  assert.equal(progress().length, 1);
  await advance(t, 300, 50);
  assert.equal(progress().length, 2, "最后一条会补发");
  assert.equal(progress().at(-1).message, "下载 99%");

  const cues = [{ from: 0, to: 1, content: "第一句" }];
  B.jobBroadcast(job, { stage: "download", message: "有新字幕", cues });
  assert.equal(progress().length, 3, "带新字幕立即发");
  assert.equal(progress().at(-1).cues.length, 1);
  await advance(t, 300, 50);
  B.jobBroadcast(job, { stage: "download", message: "继续下载", cues });
  assert.equal(progress().at(-1).cues, undefined, "字幕没变就不再带");
  assert.equal(progress().at(-1).cueCount, 1);

  B.jobBroadcast(job, { stage: "done", message: "完成" });
  assert.equal(progress().at(-1).stage, "done");
  assert.equal(progress().at(-1).cues.length, 1, "结束时带全部字幕");
  const count = progress().length;
  B.jobBroadcast(job, { stage: "upload", message: "迟到的进度" });
  await advance(t, 500, 50);
  assert.equal(progress().length, count, "结束后迟到的进度不再发出");
});

test("GET_ASR_JOB 经消息路由返回进行中任务，包含并发中的分段状态", async () => {
  const B = loadAsr();
  const job = makeJob([channel("Groq", "g")], { jobId: "q1", bvid: "BV1query", cid: 2 });
  job.partsRef = [{ complete: true, cues: [{ content: "a" }] }, null, null];
  job.chunkPlan = [{ start: 0, end: 90 }, { start: 87.5, end: 567.5 }, { start: 565, end: 1045 }];
  job.activeChunks = new Set([1, 2]);
  job.chunkTotal = 3;
  job.progress = { stage: "upload", total: 3 };
  B.asrJobs.set(job.jobId, job);
  const status = await new Promise((resolve) => {
    const handled = B.__listeners[0](
      { type: "GET_ASR_JOB", bvid: "BV1query", cid: 2 },
      { url: "chrome-extension://test-extension/sidepanel.html" },
      resolve
    );
    assert.equal(handled, true);
  });
  assert.equal(status.running, true);
  assert.equal(status.jobId, "q1");
  assert.equal(status.done, 1);
  assert.deepEqual(Array.from(status.chunks, (chunk) => chunk.status), ["done", "run", "run"]);
});

// ---------------- 后台被回收后的续跑 ----------------

test("后台被回收后：视频页还开着就自动续跑，切走或关掉就不续跑", async () => {
  const marker = (bvid, tabId, p = 1) => ({
    tabId,
    startedAt: Date.now(),
    resumes: 0,
    input: { tabId, aid: 1, cid: 5, bvid, p }
  });
  const B = loadAsr({
    session: {
      "asrRun:BV1open:5": marker("BV1open", 7),
      "asrRun:BV1moved:5": marker("BV1moved", 8),
      "asrRun:BV1closed:5": marker("BV1closed", 9)
    },
    tabs: {
      7: { id: 7, url: "https://www.bilibili.com/video/BV1open?p=1" },
      8: { id: 8, url: "https://www.bilibili.com/video/BV1other" }
    }
  });
  await vm.runInContext("asrResumeScan", B);
  await flush();
  const starts = B.__sent.filter((message) => message.type === "ASR_PROGRESS" && message.stage === "start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].bvid, "BV1open");
  assert.match(starts[0].message, /后台重启后自动继续/);
  assert.equal(B.__session["asrRun:BV1moved:5"], undefined);
  assert.equal(B.__session["asrRun:BV1closed:5"], undefined);

  assert.equal(B.tabShowsAsrVideo({ url: "https://www.bilibili.com/video/BV1open?p=2" }, { bvid: "BV1open", p: 1 }), false);
  assert.equal(B.tabShowsAsrVideo({ url: "https://x.com/someone/status/123/video/1" }, { bvid: "x_123_1" }), true);
  assert.equal(B.tabShowsAsrVideo({ url: "https://www.bilibili.com/bangumi/play/ep456" }, { epId: "456" }), true);
});

test("续跑有次数上限，避免反复崩溃时无限重来", async () => {
  const B = loadAsr({
    session: {
      "asrRun:BV1loop:5": { tabId: 7, startedAt: Date.now(), resumes: 3, input: { tabId: 7, bvid: "BV1loop", cid: 5 } }
    },
    tabs: { 7: { id: 7, url: "https://www.bilibili.com/video/BV1loop" } }
  });
  await vm.runInContext("asrResumeScan", B);
  await flush();
  assert.equal(B.__sent.filter((message) => message.type === "ASR_PROGRESS").length, 0);
  assert.equal(B.__session["asrRun:BV1loop:5"], undefined);
});

// ---------------- 独立复查发现的问题 ----------------

test("续跑时下载在第 1 段后中断：断点里已转好的其余分段仍在结果里，不会只剩第一段", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_700_000_000_000 });
  const B = loadAsr({ fetchImpl: async () => audioResponse() });
  const chunks = fakeChunks(3);
  // 旧进度：3 段都转完了（上次收尾前被打断）
  const parts = chunks.map((c, i) => ({
    i, start: c.start, end: c.end, overlap: c.overlap, tail: c.tail,
    cues: [{ from: 10, to: 12, content: `旧第${i + 1}段` }], complete: true, silent: false, trimmed: true
  }));
  B.__local["asrJob:BV1test:1"] = { fingerprint: "v2:1435", parts, total: 3, done: 3, pending: true };
  B.__local["asr:BV1test:1"] = {
    cues: parts.map((p, i) => ({ from: p.start + 10, to: p.start + 12, content: `旧第${i + 1}段` })),
    source: "groq", activeLan: "groq-asr", partial: true
  };
  // 这次下载只切出第 1 段就断了
  B.BiliCaptionMp4.iterateFmp4Chunks = async function* (reader) {
    await reader.read();
    yield { ...chunks[0], blob: new Blob([new Uint8Array(4096)]) };
    throw new Error("音频下载中断（模拟）");
  };
  B.BiliCaptionStt = { ...B.BiliCaptionStt, async transcribe() { throw new Error("第 1 段应复用旧进度，不该请求"); } };
  const job = makeJob([channel("Groq", "g")]);
  B.asrJobs.set(job.jobId, job);
  const result = await settle(t, B.transcribeAudio({ id: 30216, baseUrl: "https://upos.bilivideo.com/a.m4s" }, {
    meta: { bvid: job.bvid, cid: job.cid, aid: 1 }, language: "zh", signal: job.controller.signal,
    duration: 1435, tabId: 0, forceRestart: false, job, onProgress() {}
  }));
  assert.equal(result.partial, true);
  assert.deepEqual(Array.from(result.cues, (cue) => cue.content), ["旧第1段", "旧第2段", "旧第3段"]);
  // 各段字幕按自己在整条音轨里的起点摆放，不会都挤到 00:00
  assert.deepEqual(Array.from(result.cues, (cue) => cue.from), [10, chunks[1].start + 10, chunks[2].start + 10]);
});

/** 先给几段数据，之后 read() 永远不返回（连接不断也不给数据）；cancel 时记一次 */
function stalledBody(pieces, onCancel = () => {}) {
  return {
    getReader() {
      let i = 0;
      return {
        read() {
          if (i < pieces.length) return Promise.resolve({ done: false, value: pieces[i++] });
          return new Promise(() => {});
        },
        async cancel() { onCancel(); }
      };
    }
  };
}

test("音频流卡住（连接不断也不给数据）：空闲超时后取消这条连接，按 Range 续传", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_700_000_000_000 });
  const bytes = Uint8Array.from({ length: 10 }, (_, i) => i);
  const ranges = [];
  let canceled = 0;
  const B = loadAsr({
    fetchImpl: async (_url, options = {}) => {
      ranges.push(options.headers?.Range || "");
      if (ranges.length === 1) return response(200, { "content-length": 10 }, stalledBody([bytes.slice(0, 4)], () => { canceled += 1; }));
      return response(206, { "content-range": "bytes 4-9/10", "content-length": 6 }, readerBody([bytes.slice(4)]));
    }
  });
  const opened = await B.openAudioDownload({ id: 1, baseUrl: "https://upos.bilivideo.com/a.m4s" }, new AbortController().signal);
  const out = [];
  const pump = (async () => {
    for (;;) {
      const { done, value } = await opened.reader.read();
      if (done) break;
      out.push(...value);
    }
  })();
  await settle(t, pump, { step: 1000, limitMs: 10 * 60 * 1000 });
  assert.deepEqual(out, Array.from(bytes));
  assert.deepEqual(ranges, ["", "bytes=4-"]);
  assert.equal(canceled, 1, "卡住的连接被取消");
});

test("续传时 CDN 迟迟不回响应头：连接超时后再试，不会一直挂着", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_700_000_000_000 });
  const bytes = Uint8Array.from({ length: 10 }, (_, i) => 50 + i);
  let n = 0;
  const B = loadAsr({
    fetchImpl: (_url, options = {}) => {
      n += 1;
      if (n === 1) return Promise.resolve(response(200, { "content-length": 10 }, readerBody([bytes.slice(0, 4)], { failAfter: true })));
      if (n === 2) {
        // 响应头永远不来，只在被取消时报错
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }
      return Promise.resolve(response(206, { "content-range": "bytes 4-9/10", "content-length": 6 }, readerBody([bytes.slice(4)])));
    }
  });
  const opened = await B.openAudioDownload({ id: 1, baseUrl: "https://upos.bilivideo.com/a.m4s" }, new AbortController().signal);
  const out = [];
  const pump = (async () => {
    for (;;) {
      const { done, value } = await opened.reader.read();
      if (done) break;
      out.push(...value);
    }
  })();
  await settle(t, pump, { step: 1000, limitMs: 10 * 60 * 1000 });
  assert.deepEqual(out, Array.from(bytes));
  assert.equal(n, 3);
});

test("整条音轨下载一直卡住：重连用完后任务报下载中断结束，不会永远挂起", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_700_000_000_000 });
  let reads = 0;
  const stalled = {
    ok: true,
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === "content-length" ? "1000000" : null) },
    body: {
      getReader() {
        return {
          read() {
            reads += 1;
            return reads === 1 ? Promise.resolve({ done: false, value: new Uint8Array(1000) }) : new Promise(() => {});
          },
          async cancel() {}
        };
      }
    }
  };
  const B = loadAsr({ fetchImpl: async () => stalled });
  B.BiliCaptionStt = { ...B.BiliCaptionStt, async transcribe() { return segmentResult("x"); } };
  const job = makeJob([channel("Groq", "g")]);
  await assert.rejects(
    settle(t, runTranscribe(B, job, { duration: 1200 }), { step: 5000, limitMs: 30 * 60 * 1000 }),
    /音频下载中断/
  );
});

test("失败段放回队列后被立刻重派：旧请求的收尾不会删掉新请求的在途记录，结果完整", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_700_000_000_000 });
  const hops = async (n) => { for (let i = 0; i < n; i += 1) await null; };
  for (const kind of ["400", "401", "429"]) {
    for (const k of [0, 1, 2, 3]) {
      const B = loadAsr({ fetchImpl: async () => audioResponse() });
      const chunks = fakeChunks(3);
      useFakeSource(B, chunks);
      let relaunchWhileInflight = 0;
      const launch = B.launchAsrChunk;
      B.launchAsrChunk = (run, index, picked) => {
        if (run.inflight.has(index)) relaunchWhileInflight += 1;
        return launch(run, index, picked);
      };
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      let calls = 0;
      let failed = false;
      B.BiliCaptionStt = {
        ...B.BiliCaptionStt,
        async transcribe(blob) {
          const idx = chunks.findIndex((c) => c.blob === blob);
          calls += 1;
          if (calls <= 3) await gate;
          else await new Promise((resolve) => setTimeout(resolve, 3000));
          // 第 2 段第一次失败，比第 1 段的成功晚 k 个微任务
          if (idx === 1 && !failed) {
            failed = true;
            await hops(k);
            if (kind === "400") throw httpError(400, "bad audio");
            if (kind === "401") throw httpError(401, "Invalid API Key");
            throw httpError(429, "Too Many Requests", { retryAfter: 60000 });
          }
          return segmentResult(`段${idx}`, 20, 22);
        }
      };
      const job = makeJob([channel("Groq", "g"), channel("OpenAI", "o")]);
      const work = runTranscribe(B, job, { duration: 1400 });
      await advance(t, 100, 10);
      release();
      const result = await settle(t, work, { step: 250 });
      assert.equal(relaunchWhileInflight, 0, `${kind} k=${k}：同一段还在途就又派发了一次`);
      assert.equal(result.partial, false, `${kind} k=${k}：${result.reason || ""}`);
      assert.equal(result.cues.length, 3);
    }
  }
});

test("暂停超过 30 分钟不继续：按部分完成收尾，释放锁和音频内存", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_700_000_000_000 });
  const B = loadAsr({ fetchImpl: async () => audioResponse() });
  const chunks = fakeChunks(4);
  useFakeSource(B, chunks);
  B.BiliCaptionStt = {
    ...B.BiliCaptionStt,
    async transcribe() {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return segmentResult("段");
    }
  };
  const job = makeJob([channel("Groq", "g")]);
  const work = runTranscribe(B, job);
  await advance(t, 100);
  B.pauseAsrJob({ jobId: job.jobId }, true);
  const started = Date.now();
  const result = await settle(t, work, { step: 5000, limitMs: 45 * 60 * 1000 });
  assert.equal(result.partial, true);
  assert.match(result.reason, /暂停/);
  assert.ok(result.cues.length >= 1 && result.cues.length < 4);
  const waited = Date.now() - started;
  assert.ok(waited >= 30 * 60 * 1000 && waited < 32 * 60 * 1000, `等了 ${Math.round(waited / 60000)} 分钟`);
  assert.ok(chunks.every((chunk) => chunk.blob === null), "音频分片都已释放");
});

test("视频标签页关掉时取消该标签页上暂停中的转写，运行中的和别的标签页不受影响", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_700_000_000_000 });
  const B = loadAsr({ fetchImpl: async () => audioResponse() });
  assert.ok(B.__removedListeners.length >= 1, "注册了标签页关闭监听");
  useFakeSource(B, fakeChunks(4));
  B.BiliCaptionStt = {
    ...B.BiliCaptionStt,
    async transcribe() {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return segmentResult("段");
    }
  };
  const job = makeJob([channel("Groq", "g")]);
  job.tabId = 7;
  const work = runTranscribe(B, job);
  let error = null;
  work.catch((e) => { error = e; });
  await advance(t, 100);
  B.pauseAsrJob({ jobId: job.jobId }, true);
  const running = { jobId: "run", tabId: 7, bvid: "BV1run", cid: 1, paused: false, controller: new AbortController() };
  const otherTab = { jobId: "other", tabId: 8, bvid: "BV1other", cid: 1, paused: true, controller: new AbortController() };
  B.asrJobs.set(running.jobId, running);
  B.asrJobs.set(otherTab.jobId, otherTab);
  for (const fn of B.__removedListeners) fn(7, { windowId: 1, isWindowClosing: false });
  await advance(t, 5000);
  assert.equal(job.controller.signal.aborted, true);
  assert.equal(error?.name, "AbortError");
  assert.equal(running.controller.signal.aborted, false);
  assert.equal(otherTab.controller.signal.aborted, false);
});

test("续跑的任务在记下运行标记前就出错：清掉旧标记，下次后台启动不再续跑、不再报错", async () => {
  const record = { tabId: 7, startedAt: Date.now(), resumes: 1, input: { tabId: 7, aid: 1, cid: 1, bvid: "BV1test", p: 1 } };
  const session = { "asrRun:BV1test:1": record };
  const tabs = { 7: { id: 7, url: "https://www.bilibili.com/video/BV1test" } };
  const errors = [];
  for (let boot = 1; boot <= 3; boot += 1) {
    // 每次「SW 启动」都重新加载后台；用户已在设置里删掉了全部通道
    const B = loadAsr({ session, tabs, settings: { sttChannels: [] } });
    await vm.runInContext("asrResumeScan", B);
    for (let i = 0; i < 10; i += 1) await flush();
    errors.push(B.__sent.filter((m) => m.type === "ASR_PROGRESS" && m.stage === "error").length);
    for (const key of Object.keys(session)) delete session[key];
    Object.assign(session, B.__session);
  }
  assert.deepEqual(errors, [1, 0, 0], "只在第一次续跑时报一次错");
  assert.equal(session["asrRun:BV1test:1"], undefined);
});

test("续跑前先把续跑次数写回运行标记：任务还没记下标记后台就又被回收，也会数到上限", async () => {
  const record = { tabId: 7, startedAt: Date.now(), resumes: 1, input: { tabId: 7, aid: 1, cid: 1, bvid: "BV1hang", p: 1 } };
  const B = loadAsr({
    session: { "asrRun:BV1hang:1": record },
    tabs: { 7: { id: 7, url: "https://www.bilibili.com/video/BV1hang" } }
  });
  // 读设置一直不返回：模拟任务还没走到 markAsrRunning 后台就被回收
  B.BiliCaptionPrefs.loadSettings = () => new Promise(() => {});
  await vm.runInContext("asrResumeScan", B);
  await flush();
  assert.equal(B.__session["asrRun:BV1hang:1"]?.resumes, 2);
});

test("续跑判断番剧分集要精确：ep12 不会匹配 ep123，ss 同理", () => {
  const B = loadAsr();
  const bangumi = (path) => ({ url: `https://www.bilibili.com/bangumi/play/${path}` });
  assert.equal(B.tabShowsAsrVideo(bangumi("ep12"), { epId: "12" }), true);
  assert.equal(B.tabShowsAsrVideo(bangumi("ep12?from=search"), { epId: "12" }), true);
  assert.equal(B.tabShowsAsrVideo(bangumi("ep12/"), { epId: "12" }), true);
  assert.equal(B.tabShowsAsrVideo(bangumi("ep123"), { epId: "12" }), false);
  assert.equal(B.tabShowsAsrVideo(bangumi("ss45"), { seasonId: "45" }), true);
  assert.equal(B.tabShowsAsrVideo(bangumi("ss456"), { seasonId: "45" }), false);
});

// ---------------- 端到端：真实切片器 + 可续传下载 ----------------

const { execFileSync } = require("node:child_process");
const os = require("node:os");
const { loadBackgroundScripts } = require("./源码加载.js");
const ffmpeg = "/opt/homebrew/bin/ffmpeg";

test("端到端：真实 fMP4 边下边切（中途断流续传），第一段约 90 秒，多段并发转写后按时间合并", { skip: !fs.existsSync(ffmpeg) }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bilicaption-端到端-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "音轨.m4a");
  execFileSync(ffmpeg, [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=620",
    "-c:a", "aac", "-b:a", "32k",
    "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "2000000",
    file
  ], { stdio: "pipe" });
  const bytes = new Uint8Array(fs.readFileSync(file));
  const ranges = [];
  const B = loadAsr({
    fetchImpl: async (_url, options = {}) => {
      const range = options.headers?.Range || "";
      ranges.push(range);
      const from = Number(range.match(/bytes=(\d+)-/)?.[1] || 0);
      const body = bytes.subarray(from);
      // 第一次连接读到 40% 就断开，考验 Range 续传
      const cutAt = ranges.length === 1 ? Math.floor(bytes.length * 0.4) : body.length;
      const pieces = [];
      for (let i = 0; i < cutAt; i += 65536) pieces.push(Uint8Array.from(body.subarray(i, Math.min(cutAt, i + 65536))));
      return response(from ? 206 : 200, {
        "content-length": body.length,
        ...(from ? { "content-range": `bytes ${from}-${bytes.length - 1}/${bytes.length}` } : {})
      }, readerBody(pieces, { failAfter: ranges.length === 1 }));
    }
  });
  const seen = [];
  B.BiliCaptionStt = {
    ...B.BiliCaptionStt,
    async transcribe(blob, cfg, extra) {
      const size = blob.size;
      seen.push({ duration: extra.duration, size });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const dur = extra.duration;
      return {
        text: "x",
        segments: [
          { start: 0.2, end: 1, text: "开头。" },
          { start: dur / 2, end: dur / 2 + 1, text: `中间${Math.round(dur)}。` },
          { start: dur - 1, end: dur - 0.2, text: "结尾。" }
        ],
        words: []
      };
    }
  };
  const job = makeJob([channel("Groq", "g")], { bvid: "BV1e2e", cid: 3 });
  const result = await runTranscribe(B, job, { duration: 620 });
  assert.equal(result.partial, false);
  assert.equal(seen.length, 3, "90 秒 + 480 秒 + 余下");
  assert.ok(seen[0].duration > 85 && seen[0].duration <= 90.1, `第一段 ${seen[0].duration}`);
  assert.ok(ranges.length >= 2 && /^bytes=\d+-$/.test(ranges[1]), "断流后用 Range 续传");
  const froms = Array.from(result.cues, (cue) => cue.from);
  assert.deepEqual(froms, [...froms].sort((a, b) => a - b), "合并后时间递增");
  // 每段开头、结尾那句落在重叠区外侧的被裁掉，内部句子都在
  const middles = Array.from(result.cues, (cue) => cue.content).filter((text) => text.startsWith("中间"));
  assert.equal(middles.length, 3);
  assert.equal(Array.from(result.cues, (cue) => cue.content).filter((text) => text === "开头。").length, 1);
  assert.equal(Array.from(result.cues, (cue) => cue.content).filter((text) => text === "结尾。").length, 1);
});
