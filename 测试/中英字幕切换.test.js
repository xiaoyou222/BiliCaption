const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

function loadTranslate() {
  const context = { console };
  context.self = context;
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "lib/translate.js"), "utf8"), context);
  return context.BiliCaptionTranslate;
}

function storageArea(store) {
  return {
    async get(keys) {
      if (keys == null) return { ...store };
      if (typeof keys === "string") return { [keys]: store[keys] };
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, store[key]]));
      }
      const out = { ...keys };
      for (const key of Object.keys(keys || {})) {
        if (Object.hasOwn(store, key)) out[key] = store[key];
      }
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

function loadBackground(fetchImpl = globalThis.fetch) {
  const store = {};
  const noopEvent = { addListener() {} };
  const context = {
    console,
    URL,
    TextEncoder,
    TextDecoder,
    Blob,
    FormData,
    AbortController,
    AbortSignal,
    DOMException,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: fetchImpl,
    importScripts() {},
    chrome: {
      runtime: {
        id: "test-extension",
        onInstalled: noopEvent,
        onStartup: noopEvent,
        onMessage: noopEvent,
        async sendMessage() {},
        getURL(file) { return `chrome-extension://test/${file}`; },
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
        async sendMessage() {}
      },
      declarativeNetRequest: { async updateDynamicRules() {} },
      storage: { local: storageArea(store), sync: storageArea({}) }
    },
    BiliCaptionPrefs: { async loadSettings(defaults) { return { ...defaults }; } },
    BiliCaptionProviders: {},
    BiliCaptionStt: {},
    BiliCaptionMp4: { CHUNK_SECONDS: 8 * 60, CHUNK_BYTES: 20 * 1024 * 1024 },
    BiliCaptionWbi: {
      async signQuery(params = {}) {
        return new URLSearchParams(
          Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)]))
        ).toString();
      }
    }
  };
  context.__store = store;
  context.self = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "lib/translate.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), context);
  return context;
}

test("显示语言：有 original 时 EN 看原文、中看译文", () => {
  const T = loadTranslate();
  const cue = { from: 0, to: 1, content: "所以接到 Set Position", original: "so plug into Set Position" };
  assert.equal(T.cueDisplayText(cue, "zh"), "所以接到 Set Position");
  assert.equal(T.cueDisplayText(cue, "en"), "so plug into Set Position");
  assert.equal(T.cueHasOriginal(cue), true);
  assert.equal(T.cueHasOriginal({ content: "hello" }), false);
});

test("stampCueOriginal 只在没有原文时写入", () => {
  const T = loadTranslate();
  const cue = { content: "Hello" };
  T.stampCueOriginal(cue, "Hello");
  assert.equal(cue.original, "Hello");
  T.stampCueOriginal(cue, "Other");
  assert.equal(cue.original, "Hello");
});

test("翻译后 cue.original 仍是英文，content 是中文", async () => {
  const B = loadBackground(async (_url, options) => {
    const body = JSON.parse(options.body);
    const prompt = body.messages.at(-1).content;
    const count = [...prompt.matchAll(/^\d+\./gm)].length;
    const content = Array.from({ length: count }, (_, i) => `${i + 1}. 第${i + 1}句`).join("\n");
    return {
      ok: true,
      status: 200,
      async json() { return { choices: [{ message: { content } }] }; }
    };
  });
  B.BiliCaptionPrefs.loadSettings = async () => ({
    sumProvider: "OpenAI",
    apiBase: "https://api.openai.com/v1",
    apiKey: "key",
    apiModel: "gpt-4o-mini",
    translateModel: "",
    translateConcurrency: 1
  });
  B.BiliCaptionProviders.resolveSum = (storage) => ({
    provider: storage.sumProvider,
    base: storage.apiBase,
    key: storage.apiKey,
    model: storage.apiModel
  });
  const input = [
    { from: 0, to: 1, content: "This is line 1." },
    { from: 1, to: 2, content: "This is line 2." }
  ];
  const prepared = B.BiliCaptionTranslate.prepareCues(input);
  const job = {
    jobId: "lang-1",
    controller: new AbortController(),
    tabId: 0,
    bvid: "BV-lang",
    cid: 1,
    cues: prepared.cues,
    done: 0,
    total: prepared.targets.length,
    pending: true,
    regrouped: true
  };
  await B.runTranslateJob(job, prepared.targets);
  assert.equal(job.cues[0].content, "第1句");
  assert.equal(job.cues[0].original, "This is line 1.");
  assert.equal(job.cues[1].original, "This is line 2.");
  assert.equal(B.__store["asr:BV-lang:1"].cues[0].original, "This is line 1.");
});

test("断句切开后仍带上 original", () => {
  const B = loadBackground();
  const cues = B.flattenCueParts([{
    from: 0,
    to: 20,
    content: "第一句。第二句也还在。",
    original: "First sentence. Second still here."
  }]);
  assert.ok(cues.length >= 2);
  assert.ok(cues.every((cue) => cue.original === "First sentence. Second still here."));
});

test("ASR 回写会把英文原文留在 original 上", () => {
  const B = loadBackground();
  const merged = B.mergeTranslatedCues(
    [{ from: 0, to: 1, content: "plug into Set Position" }],
    [{ from: 0, to: 1, content: "接到 Set Position", original: "plug into Set Position" }]
  );
  assert.equal(merged[0].content, "接到 Set Position");
  assert.equal(merged[0].original, "plug into Set Position");
});

test("自己转写/翻译算插件字幕，不能拿去切官方轨", () => {
  const T = loadTranslate();
  assert.equal(T.isPluginCaptionSource("groq", "groq-asr"), true);
  assert.equal(T.isPluginCaptionSource("translated", "translated"), true);
  assert.equal(T.isPluginCaptionSource("bilibili", "ai-zh"), false);
  assert.equal(T.isPluginCaptionSource("bilibili", "en"), false);
  const panel = fs.readFileSync(path.join(root, "sidepanel.js"), "utf8");
  assert.match(panel, /function isPluginCaptions/);
  assert.match(panel, /if \(!isPluginCaptions\(\)\)/);
  assert.match(panel, /SWITCH_TRACK/);
  assert.match(panel, /这份翻译没有留下英文原文/);
});

test("只有中文字幕不算能切英文", () => {
  const T = loadTranslate();
  const zh = [{ content: "再交给另一个 session" }, { content: "所以几周前我就把它发布了" }];
  assert.equal(T.captionListHasLang(zh, "zh"), true);
  assert.equal(T.captionListHasLang(zh, "en"), false);
  const en = [{ content: "So a few weeks ago I shipped it." }, { content: "Hand it to another session." }];
  assert.equal(T.captionListHasLang(en, "zh"), false);
  assert.equal(T.captionListHasLang(en, "en"), true);
  const both = [{ content: "所以几周前我就把它发布了", original: "So a few weeks ago I shipped it." }];
  assert.equal(T.captionListHasLang(both, "zh"), true);
  assert.equal(T.captionListHasLang(both, "en"), true);
});

test("官方轨：ai-zh 算中，en 算英，日文不算", () => {
  const T = loadTranslate();
  assert.equal(T.trackLangKind({ lan: "ai-zh", lanDoc: "中文（自动生成）" }), "zh");
  assert.equal(T.trackLangKind({ lan: "en", lanDoc: "English" }), "en");
  assert.equal(T.trackLangKind({ lan: "ai-en", lanDoc: "English" }), "en");
  assert.equal(T.trackLangKind({ lan: "ja", lanDoc: "日本語" }), "");
  const tracks = [
    { lan: "en", lanDoc: "English", url: "e" },
    { lan: "ai-zh", lanDoc: "中文（自动生成）", url: "z" },
    { lan: "zh-CN", lanDoc: "中文", url: "c" }
  ];
  assert.equal(T.pickTrackByLang(tracks, "zh").lan, "ai-zh");
  assert.equal(T.pickTrackByLang(tracks, "en").lan, "en");
  assert.equal(T.tracksAreZhEnOnly(tracks), true);
  assert.equal(T.tracksAreZhEnOnly([...tracks, { lan: "ja", lanDoc: "日本語" }]), false);
});

test("侧栏有中英切换，浮层会跟语言", () => {
  const html = fs.readFileSync(path.join(root, "sidepanel.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "sidepanel.css"), "utf8");
  const panel = fs.readFileSync(path.join(root, "sidepanel.js"), "utf8");
  const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
  assert.match(html, /id="captionLang"/);
  assert.match(html, /data-lang="zh"/);
  assert.match(html, /data-lang="en"/);
  assert.match(css, /\.lang-switch\s*\{/);
  assert.match(css, /html\.float-embed \.lang-switch[\s\S]{0,80}background:\s*transparent/);
  assert.match(panel, /SET_CAPTION_LANG/);
  assert.match(panel, /function setCaptionLang/);
  assert.match(panel, /canShowCaptionLang\("zh"\)/);
  assert.match(panel, /canShowCaptionLang\("en"\)/);
  assert.doesNotMatch(panel, /const onCaptions = view === "captions" && Boolean\(state\?\.cues\?\.length\)/);
  assert.match(panel, /extraTracks\.length > 0/);
  assert.match(panel, /SWITCH_TRACK/);
  assert.doesNotMatch(panel, /bilingual = view === "captions" && hasBilingualCaptions/);
  assert.match(content, /SET_CAPTION_LANG/);
  assert.match(content, /captionLang === "en" && original/);
});
