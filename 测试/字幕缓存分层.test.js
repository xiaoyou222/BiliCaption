const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { loadBackgroundScripts, loadContentScripts, panelSource, runFile } = require("./源码加载.js");

// 本地字幕缓存分层：转写结果和用户改过字的字幕（受保护）不参与自动淘汰；
// 官方字幕及其译文（可重新生成）仍按数量 + 体积淘汰，上限只在这一层之间计算。

function storageArea(store) {
  return {
    async get(keys) {
      if (keys == null) return { ...store };
      if (typeof keys === "string") return { [keys]: store[keys] };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, store[key]]));
      const out = { ...keys };
      for (const key of Object.keys(keys || {})) {
        if (Object.hasOwn(store, key)) out[key] = store[key];
      }
      return out;
    },
    async set(values) {
      Object.assign(store, JSON.parse(JSON.stringify(values || {})));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
    },
    async setAccessLevel() {}
  };
}

function loadBackground() {
  const store = {};
  const noopEvent = { addListener() {} };
  const context = {
    console, URL, TextEncoder, TextDecoder, Blob, AbortController, AbortSignal, DOMException,
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async () => { throw new Error("不应联网"); },
    importScripts() {},
    chrome: {
      runtime: {
        id: "test-extension",
        onInstalled: noopEvent,
        onStartup: noopEvent,
        onMessage: { addListener(fn) { context.__onMessage = fn; } },
        async sendMessage() {},
        getURL(file) { return `chrome-extension://test/${file}`; },
        async getContexts() { return []; },
        lastError: null
      },
      sidePanel: { async setPanelBehavior() {}, async setOptions() {}, async open() {} },
      scripting: { async executeScript() { return []; } },
      tabs: {
        async get() { return {}; },
        query(_query, callback) {
          if (callback) callback([]);
          return Promise.resolve([]);
        },
        async sendMessage() {}
      },
      declarativeNetRequest: { async updateDynamicRules() {} },
      storage: { local: storageArea(store), session: storageArea({}) }
    },
    BiliCaptionPrefs: { async loadSettings(defaults) { return { ...defaults }; } },
    BiliCaptionProviders: {},
    BiliCaptionStt: {},
    BiliCaptionMp4: { CHUNK_SECONDS: 8 * 60, CHUNK_BYTES: 20 * 1024 * 1024 }
  };
  context.__store = store;
  context.self = context;
  vm.createContext(context);
  loadBackgroundScripts(context, ["lib/视频平台.js", "lib/字幕工具.js", "lib/zh-simp.js", "lib/translate.js", "lib/模型路由.js", "lib/webdav.js"]);
  return context;
}

const PANEL = { url: "chrome-extension://test-extension/sidepanel.html", id: "test-extension" };
const CONTENT = { url: "https://www.bilibili.com/video/BV1page", tab: { id: 9, windowId: 1 }, id: "test-extension" };

function route(bg, message, sender = PANEL) {
  return new Promise((resolve) => {
    const handled = bg.__onMessage(message, sender, resolve);
    if (handled !== true) resolve({ ignored: true });
  });
}

const line = (text, from = 0, to = 1, extra = {}) => ({ from, to, content: text, ...extra });
const official = (i, extra = {}) => ({
  cues: [line(`官方 ${i}`)], source: "bilibili", activeLan: "ai-zh", origin: "official", savedAt: 1000 + i, ...extra
});
const transcribed = (i, extra = {}) => ({
  cues: [line(`转写 ${i}`)], source: "groq", activeLan: "groq-asr", origin: "asr",
  provider: "Groq", model: "whisper-large-v3", savedAt: 1000 + i, ...extra
});
const keysWith = (store, prefix) => Object.keys(store).filter((key) => key.startsWith(prefix));
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

test("受保护条目超过 40 个也不淘汰；可再生条目只在它们之间按 40 个从旧到新淘汰，连同大纲 / 索引", async () => {
  const bg = loadBackground();
  const store = bg.__store;
  // 50 份转写（比所有官方字幕都旧）+ 5 份改过字的官方字幕 + 45 份可再生官方字幕
  for (let i = 0; i < 50; i++) store[`asr:BVasr${i}:1`] = transcribed(i);
  for (let i = 0; i < 5; i++) store[`asr:BVedit${i}:1`] = official(i, { editedAt: 5000 + i });
  for (let i = 0; i < 45; i++) store[`asr:BVoff${i}:1`] = official(100 + i);
  store["outline:v2:BVasr0:1"] = { summary: "转写视频的大纲", chapters: [] };
  store["asrIndex:BVasr0"] = 1;
  store["outline:v2:BVoff0:1"] = { summary: "最旧官方字幕的大纲", chapters: [] };
  store["asrIndex:BVoff0"] = 1;
  store["trJob:BVoff0:1"] = { pending: true, halted: true, cues: [] };

  const result = await bg.pruneAsrCache();
  assert.equal(result.removed, 5);
  assert.equal(keysWith(store, "asr:BVasr").length, 50, "转写一份不少");
  assert.equal(keysWith(store, "asr:BVedit").length, 5, "改过字的一份不少");
  assert.equal(keysWith(store, "asr:BVoff").length, 40, "可再生条目只在自己之间算 40 个");
  for (let i = 0; i < 5; i++) assert.equal(store[`asr:BVoff${i}:1`], undefined, `最旧的 BVoff${i} 被淘汰`);
  assert.ok(store["asr:BVoff5:1"]);
  // 被淘汰视频的大纲、索引和翻译存档一起走；受保护视频的留着
  assert.equal(store["outline:v2:BVoff0:1"], undefined);
  assert.equal(store["asrIndex:BVoff0"], undefined);
  assert.equal(store["trJob:BVoff0:1"], undefined);
  assert.ok(store["outline:v2:BVasr0:1"]);
  assert.equal(store["asrIndex:BVasr0"], 1);

  // 再跑一次 pruneAuxCache：转写视频的大纲不会因为字幕缓存规则被连带删掉
  await bg.pruneAuxCache();
  assert.ok(store["outline:v2:BVasr0:1"]);
});

test("体积上限也只在可再生条目之间算：受保护的大条目不计入、不删除", async () => {
  const bg = loadBackground();
  const store = bg.__store;
  const big = (n) => "字".repeat(n); // 每个汉字 3 字节
  for (let i = 0; i < 3; i++) store[`asr:BVasr${i}:1`] = transcribed(i, { cues: [line(big(1_000_000))] }); // 各约 3MB
  for (let i = 0; i < 4; i++) store[`asr:BVoff${i}:1`] = official(10 + i, { cues: [line(big(600_000))] }); // 各约 1.8MB

  const result = await bg.pruneAsrCache();
  assert.equal(result.removed, 1, "可再生 4 × 1.8MB 超过 6MB，删最旧的一份就够");
  assert.equal(store["asr:BVoff0:1"], undefined);
  for (let i = 1; i < 4; i++) assert.ok(store[`asr:BVoff${i}:1`]);
  for (let i = 0; i < 3; i++) assert.ok(store[`asr:BVasr${i}:1`], "约 9MB 的转写不占可再生的额度");
});

test("改字保存（edited: true）写 editedAt；翻译回写和不带标志的保存不写", async () => {
  const bg = loadBackground();
  const store = bg.__store;
  const cues = [line("Hello"), line("World", 1, 2)];

  // 页面转来的普通保存（例如侧栏翻译「已经是中文」时的回写）不带 edited
  await route(bg, { type: "SAVE_CUES_CACHE", bvid: "BVplain", cid: 1, cues, source: "translated", activeLan: "translated", edited: false }, CONTENT);
  assert.equal(store["asr:BVplain:1"].editedAt, undefined);

  // 后台翻译任务回写
  await bg.writeTranslatedCache({ bvid: "BVtr", cid: 1, cues });
  assert.equal(store["asr:BVtr:1"].editedAt, undefined);

  // 用户改字
  await bg.persistOfficialSubtitleCache("BVedit", 1, { cues, source: "bilibili", activeLan: "ai-en" });
  assert.equal(store["asr:BVedit:1"].origin, "official");
  assert.equal(bg.BiliCaptionCueTools.isProtectedSubtitleCache(store["asr:BVedit:1"]), false, "没改字前可再生");
  const before = Date.now();
  const edited = [{ ...cues[0], content: "Hello!", edited: true }, cues[1]];
  const res = await route(bg, { type: "SAVE_CUES_CACHE", bvid: "BVedit", cid: 1, cues: edited, source: "bilibili", activeLan: "ai-en", edited: true }, CONTENT);
  assert.equal(res.ok, true);
  const saved = store["asr:BVedit:1"];
  assert.ok(saved.editedAt >= before);
  assert.equal(saved.origin, "official", "改字不改变来源类别");
  assert.equal(bg.BiliCaptionCueTools.isProtectedSubtitleCache(saved), true, "改过字就受保护");

  // 之后再来一次普通保存：editedAt 不变
  const stamp = saved.editedAt;
  await route(bg, { type: "SAVE_CUES_CACHE", bvid: "BVedit", cid: 1, cues: edited, source: "bilibili", activeLan: "ai-en" }, CONTENT);
  assert.equal(store["asr:BVedit:1"].editedAt, stamp);
});

test("改过字的官方字幕：强制刷新不重拉、官方字幕不覆盖、切回同一条轨直接用改过的版本", async () => {
  const bg = loadBackground();
  const store = bg.__store;
  const page = bg.BiliCaptionPlatforms.parse("https://www.youtube.com/watch?v=aircAruvnKk");
  const key = `asr:${page.bvid}:1`;
  store[key] = {
    cues: [line("Hello fixed", 0, 1, { edited: true })], source: "youtube", activeLan: "en",
    origin: "official", editedAt: 123, savedAt: 1,
    tracks: [{ lan: "en", url: "https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=en" }]
  };
  assert.equal(bg.shouldUseSubtitleCache(store[key], true), true);
  assert.equal(bg.shouldUseSubtitleCache({ ...store[key], editedAt: 0 }, true), false, "没改过字的仍会重拉");

  const written = await bg.persistOfficialSubtitleCache(page.bvid, 1, { cues: [line("Hello")], source: "youtube", activeLan: "en" }, undefined, { overwrite: true });
  assert.equal(written, null);
  assert.equal(store[key].cues[0].content, "Hello fixed");

  let fetched = 0;
  bg.fetchPlatformTrack = async () => {
    fetched += 1;
    return [line("Bonjour")];
  };
  const same = await route(bg, { type: "FETCH_CUES", url: "x", lan: "en", page }, CONTENT);
  assert.equal(same.cues[0].content, "Hello fixed");
  assert.equal(fetched, 0);
  const other = await route(bg, { type: "FETCH_CUES", url: "x", lan: "fr", page }, CONTENT);
  assert.equal(other.cues[0].content, "Bonjour", "别的轨照常显示");
  assert.equal(fetched, 1);
  assert.equal(store[key].cues[0].content, "Hello fixed", "但不落盘盖掉改过的字");
  assert.equal(store[key].activeLan, "en");
});

test("改字后再合并译文、续转写：editedAt 和改过的文本都保留", async () => {
  const bg = loadBackground();
  const store = bg.__store;

  // 官方英文字幕 → 用户改了第 1 行 → 翻译任务用的是改字前的旧字幕（例如停下的存档续跑）
  const english = [line("Helo wrold", 0, 2), line("Second line", 2, 4)];
  await bg.persistOfficialSubtitleCache("BVtr", 1, { cues: english, source: "bilibili", activeLan: "ai-en", tracks: [{ lan: "ai-en" }] });
  await bg.saveCachedAsr("BVtr", 1, {
    cues: [{ ...english[0], content: "Hello world", edited: true }, english[1]],
    source: "bilibili",
    activeLan: "ai-en"
  }, { edited: true });
  const stamp = store["asr:BVtr:1"].editedAt;
  assert.ok(stamp > 0);
  await bg.writeTranslatedCache({
    bvid: "BVtr",
    cid: 1,
    cues: [line("旧的你好", 0, 2, { original: "Helo wrold" }), line("第二行", 2, 4, { original: "Second line" })]
  });
  let saved = store["asr:BVtr:1"];
  assert.equal(saved.cues[0].content, "Hello world", "改过的行不被旧译文冲掉");
  assert.equal(saved.cues[0].original, undefined, "也不留下改字前的原文");
  assert.equal(saved.cues[0].edited, true);
  assert.equal(saved.cues[1].content, "第二行", "没改过的行照常用译文");
  assert.equal(saved.source, "translated");
  assert.equal(saved.editedAt, stamp);
  assert.equal(saved.origin, "official");

  // 带着改字标记翻译出来的行（侧栏发起翻译时字幕里已有 edited）：译文正常写入
  await bg.writeTranslatedCache({
    bvid: "BVtr",
    cid: 1,
    cues: [line("你好世界", 0, 2, { original: "Hello world", edited: true }), line("第二行", 2, 4, { original: "Second line" })]
  });
  saved = store["asr:BVtr:1"];
  assert.equal(saved.cues[0].content, "你好世界");
  assert.equal(saved.cues[0].original, "Hello world");
  assert.equal(saved.editedAt, stamp);

  // 转写 → 翻译 → 用户改了一行中文 → 续转写再写一遍英文（preserveTranslatedCues 合并路径）
  await bg.saveCachedAsr("BVasr", 1, { cues: [line("Hi there", 0, 2), line("Bye now", 2, 4)], source: "groq", activeLan: "groq-asr", origin: "asr", provider: "Groq", model: "m" });
  await bg.writeTranslatedCache({ bvid: "BVasr", cid: 1, cues: [line("你好", 0, 2, { original: "Hi there" }), line("再见", 2, 4, { original: "Bye now" })] });
  await bg.saveCachedAsr("BVasr", 1, {
    cues: [line("你好呀（改）", 0, 2, { original: "Hi there", edited: true }), line("再见", 2, 4, { original: "Bye now" })],
    source: "translated",
    activeLan: "translated"
  }, { edited: true });
  const asrStamp = store["asr:BVasr:1"].editedAt;
  await bg.saveCachedAsr("BVasr", 1, { cues: [line("Hi there", 0, 2), line("Bye now", 2, 4)], source: "groq", activeLan: "groq-asr", origin: "asr", provider: "Groq", model: "m" });
  saved = store["asr:BVasr:1"];
  assert.equal(saved.cues[0].content, "你好呀（改）");
  assert.equal(saved.cues[1].content, "再见");
  assert.equal(saved.source, "translated");
  assert.equal(saved.editedAt, asrStamp);
  assert.equal(saved.origin, "asr");

  // 换成另一条官方轨（语言不同）时不按时间码套改字，免得串到别的语言里
  await bg.saveCachedAsr("BVtrack", 1, { cues: [line("中文改过", 0, 2, { edited: true })], source: "bilibili", activeLan: "ai-zh", origin: "official" }, { edited: true });
  await bg.saveCachedAsr("BVtrack", 1, { cues: [line("English edited", 0, 2, { edited: true }), line("Plain", 2, 4)], source: "bilibili", activeLan: "ai-en" }, { edited: true });
  assert.deepEqual(store["asr:BVtrack:1"].cues.map((cue) => cue.content), ["English edited", "Plain"]);
});

/** 走真实的 runTranslateJob（含开头的本地切句、结尾的拆行），只把模型请求换成按行号回中文 */
async function runRealTranslate(bg, bvid, cid, cues) {
  bg.BiliCaptionPrefs = {
    async loadSettings(defaults) {
      return { ...defaults, sumProvider: "OpenAI", apiBase: "https://api.example.com/v1", apiKey: "k", apiModel: "m", translateConcurrency: 1 };
    }
  };
  bg.BiliCaptionProviders = { resolveSum: (s) => ({ provider: s.sumProvider, base: s.apiBase, key: s.apiKey, model: s.apiModel }) };
  bg.chrome.runtime.getPlatformInfo = async () => ({});
  bg.translateChat = async (prompt) => {
    const count = [...prompt.matchAll(/^\d+\./gm)].length;
    return Array.from({ length: count }, (_, i) => `${i + 1}. 第${i + 1}句中文`).join("\n");
  };
  const prepared = bg.BiliCaptionTranslate.prepareCues(cues);
  const job = {
    jobId: `tr-${bvid}`, controller: new AbortController(), tabId: 0, bvid, cid,
    cues: prepared.cues, done: 0, total: prepared.targets.length, pending: true
  };
  await bg.runTranslateJob(job, prepared.targets);
  await tick();
  return job;
}

test("改过字的行经过真实翻译任务（本地切句 / 拆行）后，译文照常写进缓存，不被改字前的英文冲回去", async () => {
  const bg = loadBackground();
  const store = bg.__store;
  await bg.saveCachedAsr("BVflow", 1, {
    cues: [line("This is line one.", 0, 2), line("This is line two.", 2, 4)],
    source: "groq", activeLan: "groq-asr", origin: "asr", provider: "Groq", model: "m"
  });
  // 用户在侧栏把第 1 行改了字，然后点翻译：侧栏发来的字幕里第 1 行带 edited
  await bg.saveCachedAsr("BVflow", 1, {
    cues: [line("This is line one, fixed.", 0, 2, { edited: true }), line("This is line two.", 2, 4)],
    source: "groq", activeLan: "groq-asr"
  }, { edited: true });
  const stamp = store["asr:BVflow:1"].editedAt;
  const job = await runRealTranslate(bg, "BVflow", 1, store["asr:BVflow:1"].cues);
  assert.equal(job.cues[0].content, "第1句中文");

  const saved = store["asr:BVflow:1"];
  assert.deepEqual(saved.cues.map((cue) => cue.content), ["第1句中文", "第2句中文"], "改过字的那行也要留住译文（否则每点一次翻译就白花一次钱）");
  assert.equal(saved.cues[0].original, "This is line one, fixed.", "英文原文是改过的版本");
  assert.equal(saved.cues[0].edited, true, "改字标记跟着译文走，之后的自动写入仍认得这行");
  assert.equal(Boolean(saved.cues[1].edited), false);
  assert.equal(saved.editedAt, stamp);
  assert.equal(saved.source, "translated");
});

/** 把模型请求换成按行号回中文，设置里填好总结服务 */
function stubTranslateModel(bg) {
  bg.BiliCaptionPrefs = {
    async loadSettings(defaults) {
      return { ...defaults, sumProvider: "OpenAI", apiBase: "https://api.example.com/v1", apiKey: "k", apiModel: "m", translateConcurrency: 1 };
    }
  };
  bg.BiliCaptionProviders = { resolveSum: (s) => ({ provider: s.sumProvider, base: s.apiBase, key: s.apiKey, model: s.apiModel }) };
  bg.chrome.runtime.getPlatformInfo = async () => ({});
  bg.translateChat = async (prompt) => {
    const count = [...prompt.matchAll(/^\d+\./gm)].length;
    return Array.from({ length: count }, (_, i) => `${i + 1}. 第${i + 1}句中文`).join("\n");
  };
}

async function waitTranslateDone(bg, bvid, cid) {
  for (let i = 0; i < 200 && bg.findTranslateJob({ bvid, cid }); i++) await tick(5);
  await tick();
}

test("没有缓存条目时（如刚清掉可再生缓存）翻译或保存官方字幕：按实际来源记为 official，不被当成受保护", async () => {
  const bg = loadBackground();
  const store = bg.__store;
  const T = bg.BiliCaptionCueTools;
  stubTranslateModel(bg);

  // 侧栏直接翻译屏幕上的官方字幕：START_TRANSLATE 带着字幕来源
  const english = [line("Official line one.", 0, 2), line("Official line two.", 2, 4)];
  const started = await route(bg, { type: "START_TRANSLATE", bvid: "BVclr", cid: 1, cues: english, source: "youtube", origin: "official" });
  assert.equal(started.started, true);
  await waitTranslateDone(bg, "BVclr", 1);
  let saved = store["asr:BVclr:1"];
  assert.deepEqual(saved.cues.map((cue) => cue.content), ["第1句中文", "第2句中文"]);
  assert.equal(saved.source, "translated");
  assert.equal(saved.origin, "official");
  assert.equal(T.isProtectedSubtitleCache(saved), false, "可再生，照常参与淘汰、不上传");

  // 只带来源、没带 origin（旧侧栏）：官方来源同样认成 official
  await route(bg, { type: "START_TRANSLATE", bvid: "BVclr2", cid: 1, cues: english, source: "bilibili" });
  await waitTranslateDone(bg, "BVclr2", 1);
  assert.equal(store["asr:BVclr2:1"].origin, "official");

  // 翻译转写结果时本地条目已不在（不该发生，但来源仍要跟着走）
  await route(bg, { type: "START_TRANSLATE", bvid: "BVclr3", cid: 1, cues: english, source: "groq", origin: "official" });
  await waitTranslateDone(bg, "BVclr3", 1);
  assert.equal(store["asr:BVclr3:1"].origin, "asr", "转写来源以 source 为准");

  // 停下的翻译存档续跑、本地条目已不在：用存档里记下的来源
  const resumed = await bg.resumeStoredTranslate({
    jobId: "j-off", tabId: 0, bvid: "BVres", cid: 1, pending: true, halted: false, origin: "official",
    cues: [line("第一行", 0, 1, { original: "one" }), line("Two lines here.", 1, 2)], done: 1, total: 2
  });
  assert.ok(resumed);
  await waitTranslateDone(bg, "BVres", 1);
  assert.equal(store["asr:BVres:1"].origin, "official");

  // 页面转来的保存（侧栏「已经是中文」回写、改字）：带页面记着的来源
  await route(bg, { type: "SAVE_CUES_CACHE", bvid: "BVsave", cid: 1, cues: [line("中文")], source: "translated", activeLan: "translated", origin: "official" }, CONTENT);
  saved = store["asr:BVsave:1"];
  assert.equal(saved.origin, "official");
  assert.equal(T.isProtectedSubtitleCache(saved), false);
  await route(bg, { type: "SAVE_CUES_CACHE", bvid: "BVsave2", cid: 1, cues: [line("改过", 0, 1, { edited: true })], source: "youtube", activeLan: "en", edited: true }, CONTENT);
  assert.equal(store["asr:BVsave2:1"].origin, "official");
  assert.equal(T.isProtectedSubtitleCache(store["asr:BVsave2:1"]), true, "改过字才受保护");
  // 已有条目时来源跟着条目走，页面给的不覆盖
  store["asr:BVkeep:1"] = transcribed(1);
  await route(bg, { type: "SAVE_CUES_CACHE", bvid: "BVkeep", cid: 1, cues: [line("译文")], source: "translated", activeLan: "translated", origin: "official" }, CONTENT);
  assert.equal(store["asr:BVkeep:1"].origin, "asr");
  // 没带来源的保存不再默认成转写
  await route(bg, { type: "SAVE_CUES_CACHE", bvid: "BVnosrc", cid: 1, cues: [line("x")], origin: "official" }, CONTENT);
  assert.equal(store["asr:BVnosrc:1"].origin, "official");
  assert.notEqual(store["asr:BVnosrc:1"].source, "groq");
});

test("加载字幕返回的状态带 origin，页面据此转发保存；侧栏发起翻译带上字幕来源", async () => {
  const bg = loadBackground();
  const store = bg.__store;
  const page = bg.BiliCaptionPlatforms.parse("https://www.youtube.com/watch?v=aircAruvnKk");
  bg.readPlatformPage = async () => ({ title: "t", tracks: [{ lan: "en", url: "https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=en" }] });
  bg.fetchPlatformTrack = async () => [line("Hello")];
  let state = await bg.loadPlatformSubtitles(page, 1);
  assert.equal(state.cues.length, 1);
  assert.equal(state.origin, "official");
  store[`asr:${page.bvid}:1`] = transcribed(1);
  state = await bg.loadPlatformSubtitles(page, 1);
  assert.equal(state.origin, "asr");

  store["asr:BVbili:1"] = official(1);
  bg.fetchView = async () => ({ bvid: "BVbili", aid: 1, cid: 1, title: "t", duration: 10, pages: [{ cid: 1 }], owner: {} });
  bg.loadBiliLogin = async () => ({ isLogin: true });
  state = await bg.loadSubtitles({ kind: "video", bvid: "BVbili", p: 1 }, 1);
  assert.equal(state.origin, "official");

  const panel = panelSource();
  assert.match(panel, /type: "START_TRANSLATE",[\s\S]{0,400}source: state\.source,[\s\S]{0,80}origin: state\.origin/);
});

test("两行时间码完全相同（官方字幕常见）：只把改过的那一行换回去，同时间的另一行不被改字文本覆盖", async () => {
  const bg = loadBackground();
  const store = bg.__store;
  const T = bg.BiliCaptionCueTools;
  const existing = [line("Top sign", 0, 2), line("Dialog fixed", 0, 2, { edited: true }), line("Next", 2, 4)];
  const merged = T.keepEditedCues([line("顶部字", 0, 2, { original: "Top sign" }), line("对白旧译", 0, 2, { original: "Dialog" }), line("下一句", 2, 4)], existing);
  assert.deepEqual(merged.map((cue) => cue.content), ["顶部字", "Dialog fixed", "下一句"], "第 1 行不是用户改的，不能被换成第 2 行的改字");
  assert.deepEqual(merged.map((cue) => Boolean(cue.edited)), [false, true, false]);

  // 走缓存写入：翻译回写两行同时间码的字幕
  store["asr:BVsame:1"] = { cues: existing, source: "bilibili", activeLan: "ai-en", origin: "official", editedAt: 5, savedAt: 1 };
  await bg.writeTranslatedCache({
    bvid: "BVsame", cid: 1,
    cues: [line("顶部字", 0, 2, { original: "Top sign" }), line("对白改后译文", 0, 2, { original: "Dialog fixed", edited: true }), line("下一句", 2, 4, { original: "Next" })]
  });
  assert.deepEqual(store["asr:BVsame:1"].cues.map((cue) => cue.content), ["顶部字", "对白改后译文", "下一句"]);
});

test("停下的翻译存档续跑前先套回缓存里改过的行", async () => {
  const bg = loadBackground();
  const store = bg.__store;
  store["asr:BVresume:1"] = {
    cues: [line("第一行", 0, 1, { original: "one" }), line("Two (fixed)", 1, 2, { edited: true }), line("three", 2, 3)],
    source: "translated", activeLan: "translated", origin: "official", editedAt: 7, savedAt: 1
  };
  bg.runTranslateJob = async () => {};
  const job = await bg.resumeStoredTranslate({
    jobId: "j-resume", tabId: 0, bvid: "BVresume", cid: 1, pending: true, halted: false,
    cues: [line("第一行", 0, 1, { original: "one" }), line("Two", 1, 2), line("three", 2, 3)], done: 1, total: 3
  });
  assert.ok(job);
  assert.equal(job.cues[1].content, "Two (fixed)");
  assert.equal(job.cues[1].edited, true);
});

test("旧数据迁移：没有 origin 的条目按 source 推断，拿不准的一律按转写保护", async () => {
  const bg = loadBackground();
  const T = bg.BiliCaptionCueTools;
  assert.equal(T.subtitleCacheOrigin({ source: "bilibili" }), "official");
  assert.equal(T.subtitleCacheOrigin({ source: "youtube" }), "official");
  assert.equal(T.subtitleCacheOrigin({ source: "x" }), "official");
  assert.equal(T.subtitleCacheOrigin({ source: "groq" }), "asr");
  assert.equal(T.subtitleCacheOrigin({ source: "translated", tracks: [{ lan: "en" }] }), "official", "官方字幕的译文");
  assert.equal(T.subtitleCacheOrigin({ source: "translated", tracks: [{ lan: "en" }], provider: "Groq", model: "m" }), "asr");
  assert.equal(T.subtitleCacheOrigin({ source: "translated" }), "asr");
  assert.equal(T.subtitleCacheOrigin({}), "asr");
  assert.equal(T.subtitleCacheOrigin(null), "asr");
  assert.equal(T.isProtectedSubtitleCache({ source: "bilibili" }), false, "旧官方字幕是否改过字无从得知，按可再生处理");
  assert.equal(T.isProtectedSubtitleCache({ source: "translated" }), true);

  const store = bg.__store;
  for (let i = 0; i < 42; i++) store[`asr:BVold${i}:1`] = { cues: [line(`old ${i}`)], source: "youtube", savedAt: 100 + i };
  store["asr:BVlegacyAsr:1"] = { cues: [line("转写")], source: "groq", savedAt: 1 };
  store["asr:BVlegacyTr:1"] = { cues: [line("译文")], source: "translated", savedAt: 2 };
  store["asr:BVlegacyOffTr:1"] = { cues: [line("官方译文")], source: "translated", tracks: [{ lan: "en" }], savedAt: 3 };
  await bg.pruneAsrCache();
  assert.ok(store["asr:BVlegacyAsr:1"]);
  assert.ok(store["asr:BVlegacyTr:1"]);
  // 可再生 43 份（42 份旧官方 + 1 份官方译文），删最旧的 3 份：官方译文 savedAt 最小先走
  assert.equal(store["asr:BVlegacyOffTr:1"], undefined);
  assert.equal(store["asr:BVold0:1"], undefined);
  assert.equal(store["asr:BVold1:1"], undefined);
  assert.ok(store["asr:BVold2:1"]);

  // 旧条目下一次被写入时补上推断出的 origin
  store["asr:BVstamp:1"] = { cues: [line("Hi")], source: "bilibili", tracks: [{ lan: "en" }], savedAt: 1 };
  await bg.writeTranslatedCache({ bvid: "BVstamp", cid: 1, cues: [line("你好", 0, 1, { original: "Hi" })] });
  assert.equal(store["asr:BVstamp:1"].origin, "official");
  assert.equal(store["asr:BVstamp:1"].source, "translated");
});

test("设置页：统计两层占用、手动清理只删可再生条目及其大纲 / asrIndex；消息只许扩展页调用", async () => {
  const bg = loadBackground();
  await tick(); // 等启动时的翻译续跑检查做完，再摆翻译存档索引
  const store = bg.__store;
  store["asr:BVoff:1"] = official(1);
  store["asr:BVoff:2"] = official(2, { source: "translated", activeLan: "translated" });
  store["outline:v2:BVoff:1"] = { summary: "官方", chapters: [] };
  store["outline:v2:BVoff:2"] = { summary: "官方译文", chapters: [] };
  store["asrIndex:BVoff"] = 2;
  store["trJob:BVoff:2"] = { pending: true, halted: false, cues: [] };
  store.trJobIndex = { "trJob:BVoff:2": { bvid: "BVoff", cid: 2, tabId: 1 }, "trJob:BVasr:1": { bvid: "BVasr", cid: 1, tabId: 1 } };
  store["asr:BVasr:1"] = transcribed(1);
  store["outline:v2:BVasr:1"] = { summary: "转写", chapters: [] };
  store["asrIndex:BVasr"] = 1;
  store["asr:BVedit:1"] = official(3, { editedAt: 99 });
  store["outline:v2:BVedit:1"] = { summary: "改字", chapters: [] };
  store["marks:BVoff:1"] = [{ id: 1 }];

  for (const type of ["GET_CACHE_USAGE", "CLEAR_RENEWABLE_CACHE"]) {
    const denied = await route(bg, { type }, CONTENT);
    assert.equal(denied.error, "无权调用", type);
  }
  assert.ok(store["asr:BVoff:1"], "内容脚本清不动");

  const usage = await route(bg, { type: "GET_CACHE_USAGE" });
  assert.equal(usage.renewable.videos, 2);
  assert.equal(usage.protected.videos, 2);
  assert.equal(usage.protected.asr, 1);
  assert.equal(usage.protected.edited, 1);
  assert.ok(usage.renewable.bytes > 0 && usage.protected.bytes > 0);

  const cleared = await route(bg, { type: "CLEAR_RENEWABLE_CACHE" });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.removed, 2);
  assert.equal(cleared.bytes, usage.renewable.bytes);
  assert.equal(cleared.usage.renewable.videos, 0);
  assert.equal(cleared.usage.protected.videos, 2);
  for (const key of ["asr:BVoff:1", "asr:BVoff:2", "outline:v2:BVoff:1", "outline:v2:BVoff:2", "asrIndex:BVoff", "trJob:BVoff:2"]) {
    assert.equal(store[key], undefined, key);
  }
  assert.deepEqual(Object.keys(store.trJobIndex), ["trJob:BVasr:1"]);
  for (const key of ["asr:BVasr:1", "outline:v2:BVasr:1", "asrIndex:BVasr", "asr:BVedit:1", "outline:v2:BVedit:1", "marks:BVoff:1"]) {
    assert.ok(store[key], key);
  }

  // 用户对单个受保护视频点「清理缓存」仍照删
  await bg.clearVideoCache("BVasr", 1);
  assert.equal(store["asr:BVasr:1"], undefined);
  assert.equal(store["outline:v2:BVasr:1"], undefined);
});

test("大纲超上限时先删可重新生成视频的大纲，受保护视频的大纲留着", async () => {
  const bg = loadBackground();
  const store = bg.__store;
  // 受保护视频的大纲排在键名前面：以前「从列表前面删起」会先删它们
  for (let i = 0; i < 35; i++) {
    store[`asr:BVasr${i}:1`] = transcribed(i);
    store[`outline:v2:BVasr${i}:1`] = { summary: "转写", chapters: [] };
  }
  for (let i = 0; i < 35; i++) {
    store[`asr:BVoff${i}:1`] = official(100 + i);
    store[`outline:v2:BVoff${i}:1`] = { summary: "官方", chapters: [] };
  }
  await bg.pruneAuxCache();
  assert.equal(keysWith(store, "outline:v2:").length, 60, "大纲自身的 60 条上限不变");
  assert.equal(keysWith(store, "outline:v2:BVasr").length, 35);
  assert.equal(keysWith(store, "outline:v2:BVoff").length, 25);
  for (let i = 0; i < 10; i++) assert.equal(store[`outline:v2:BVoff${i}:1`], undefined, "先删最旧的可再生视频的大纲");
});

test("新增可再生条目后主动检查上限（装了 unlimitedStorage 写入不再因配额失败）", async () => {
  const bg = loadBackground();
  const store = bg.__store;
  for (let i = 0; i < 40; i++) store[`asr:BVoff${i}:1`] = official(i);
  await bg.persistOfficialSubtitleCache("BVnew", 1, { cues: [line("new")], source: "bilibili", activeLan: "ai-zh" });
  for (let i = 0; i < 50 && store["asr:BVoff0:1"]; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(store["asr:BVoff0:1"], undefined, "最旧的一份被挤掉");
  assert.ok(store["asr:BVnew:1"], "刚写入的保留");
  assert.equal(keysWith(store, "asr:").length, 40);
});

// ---- 发送端：只有侧栏 / 浮窗的手动改字、批量替换带 edited: true ----

function panelSlice(from, to) {
  const panel = panelSource();
  const start = panel.indexOf(from);
  const end = panel.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `找不到 ${from}`);
  return panel.slice(start, end);
}

function loadPanelEditing(cues) {
  const sent = [];
  const T = { console };
  T.self = T;
  T.window = T;
  vm.createContext(T);
  for (const file of ["lib/zh-simp.js", "lib/translate.js"]) runFile(T, file);
  const context = {
    sent,
    state: { bvid: "BV1", cid: 5, source: "bilibili", activeLan: "ai-zh", cues },
    cueEdit: null,
    lastCuesSig: "",
    cueRowEls: [],
    ui: { cueList: { replaceChildren() {} } },
    window: { BiliCaptionTranslate: T.BiliCaptionTranslate },
    renderCues() {},
    buildCueRows() {},
    paintVisibleCues() {},
    cuesSignature: () => "",
    flash() {},
    sendToTab: async (message) => {
      sent.push(JSON.parse(JSON.stringify(message)));
      return {};
    }
  };
  vm.createContext(context);
  vm.runInContext(panelSlice("function persistEditedCues", "function hideCueReplaceBarSoon"), context);
  vm.runInContext(panelSlice("function commitTranslatedCues", "function updateTranslateLock"), context);
  return context;
}

test("侧栏改字 / 批量替换发 SYNC_CUES 带 edited: true 并标出改过的行；翻译回写不带", () => {
  const cues = [line("接到 A", 0, 1), line("接到 B", 1, 2), line("别的", 2, 3)];
  const panel = loadPanelEditing(cues);

  panel.cueEdit = { index: 2, field: "content", before: "别的", draft: "别的（改）" };
  vm.runInContext("commitCueEdit()", panel);
  let msg = panel.sent.at(-1);
  assert.equal(msg.type, "SYNC_CUES");
  assert.equal(msg.edited, true);
  assert.deepEqual(msg.cues.map((cue) => Boolean(cue.edited)), [false, false, true]);
  assert.equal(msg.cues[2].content, "别的（改）");

  panel.cueEdit = { index: 0, field: "content", before: "接到 A", draft: "接到 A", term: "接到", replaceTo: "连到" };
  vm.runInContext("replaceAllCues()", panel);
  msg = panel.sent.at(-1);
  assert.equal(msg.edited, true);
  assert.deepEqual(msg.cues.map((cue) => cue.content), ["连到 A", "连到 B", "别的（改）"]);
  assert.deepEqual(msg.cues.map((cue) => Boolean(cue.edited)), [true, true, true]);

  vm.runInContext(`commitTranslatedCues([{ from: 0, to: 1, content: "中文" }])`, panel);
  msg = panel.sent.at(-1);
  assert.equal(msg.type, "SYNC_CUES");
  assert.equal(msg.source, "translated");
  assert.equal(msg.edited, undefined, "翻译回写不是改字");
});

function element(tag = "div") {
  return {
    tagName: tag.toUpperCase(),
    style: { setProperty() {}, removeProperty() {} },
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

function loadContent() {
  const href = "https://www.bilibili.com/video/BV1test";
  const url = new URL(href);
  const sent = [];
  const hooks = {};
  const document = {
    documentElement: element("html"),
    body: element("body"),
    head: element("head"),
    fullscreenElement: null,
    hidden: false,
    title: "",
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => element(tag),
    addEventListener() {}
  };
  const respond = (message) => {
    if (message?.type === "LOAD_SUBTITLES") return { page: "video", bvid: "BV1test", cid: 5, aid: 1, cues: [line("Hi")], tracks: [], source: "bilibili", origin: "official", activeLan: "ai-en" };
    if (message?.type === "WHOAMI") return { tabId: 3 };
    return { ok: true };
  };
  const runtime = {
    id: "ext",
    lastError: null,
    getURL: (file) => `chrome-extension://ext/${file}`,
    sendMessage(message, callback) {
      sent.push(JSON.parse(JSON.stringify(message)));
      const res = Promise.resolve(respond(message));
      if (typeof callback === "function") {
        res.then((value) => callback(value));
        return undefined;
      }
      return res;
    },
    onMessage: { addListener(fn) { hooks.onMessage = fn; } },
    onConnect: { addListener(fn) { hooks.onConnect = fn; } }
  };
  const context = {
    console: { ...console, log() {}, warn() {} },
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    setInterval: () => 0,
    clearInterval() {},
    getComputedStyle: () => ({ position: "relative" }),
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    location: { href, pathname: url.pathname, search: url.search, hostname: url.hostname },
    document,
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener() {},
    focus() {},
    chrome: {
      runtime,
      storage: {
        sync: {
          get(defaults, cb) {
            const data = { ...defaults, preferSidebar: true };
            cb?.(data);
            return Promise.resolve(data);
          },
          async set() {}
        },
        onChanged: { addListener() {} }
      }
    }
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  loadContentScripts(context);
  return { sent, hooks };
}

test("页面转发保存时带上字幕来源：加载时的来源、转写后换成 asr", async () => {
  const page = loadContent();
  await tick();
  const sync = () => new Promise((resolve) => {
    page.hooks.onMessage({ type: "SYNC_CUES", bvid: "BV1test", cid: 5, cues: [line("你好")], source: "translated", activeLan: "translated" }, {}, resolve);
  });
  await sync();
  await tick();
  let saves = page.sent.filter((message) => message.type === "SAVE_CUES_CACHE");
  assert.equal(saves.at(-1).origin, "official");

  await new Promise((resolve) => {
    page.hooks.onMessage({ type: "APPLY_ASR_CUES", bvid: "BV1test", cid: 5, cues: [line("Hi")], source: "groq", activeLan: "groq-asr" }, {}, resolve);
  });
  await sync();
  await tick();
  saves = page.sent.filter((message) => message.type === "SAVE_CUES_CACHE");
  assert.equal(saves.at(-1).origin, "asr");
});

test("页面把侧栏的 edited 原样转给后台：改字带 true，其它保存为 false", async () => {
  const page = loadContent();
  await tick();
  const sync = (extra) => new Promise((resolve) => {
    page.hooks.onMessage({ type: "SYNC_CUES", bvid: "BV1test", cid: 5, cues: [line("Hi!", 0, 1, { edited: true })], source: "bilibili", activeLan: "ai-en", ...extra }, {}, resolve);
  });
  await sync({ edited: true });
  await tick();
  let saves = page.sent.filter((message) => message.type === "SAVE_CUES_CACHE");
  assert.equal(saves.length, 1);
  assert.equal(saves[0].edited, true);
  assert.equal(saves[0].cues[0].edited, true);

  await sync({});
  await tick();
  saves = page.sent.filter((message) => message.type === "SAVE_CUES_CACHE");
  assert.equal(saves.length, 2);
  assert.equal(saves[1].edited, false);

  // 后台翻译已自己写缓存（persisted）时页面不再回传
  await sync({ persisted: true, edited: true });
  await tick();
  assert.equal(page.sent.filter((message) => message.type === "SAVE_CUES_CACHE").length, 2);
});
