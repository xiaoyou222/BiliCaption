const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const CUE_URL = "https://i0.hdslb.com/bfs/subtitle/ai-zh.json";
const PAGE = { kind: "video", bvid: "BV1testxxx", p: 1, cid: 222 };

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

function jsonResponse(body, ok = true, status = ok ? 200 : 502) {
  return {
    ok,
    status,
    async json() {
      return body;
    }
  };
}

function loadBackground(fetchImpl) {
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
      storage: { local: storageArea(store) }
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
  vm.runInContext(fs.readFileSync(path.join(root, "lib/模型路由.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), context);
  return context;
}

function biliFetch(overrides = {}) {
  const calls = [];
  const login = overrides.login ?? { isLogin: true, uname: "tester", mid: 1 };
  const playerSubs = Object.hasOwn(overrides, "playerSubs") ? overrides.playerSubs : [];
  const dmSubs = Object.hasOwn(overrides, "dmSubs") ? overrides.dmSubs : [];
  const playerOk = overrides.playerOk !== false;
  const dmOk = overrides.dmOk !== false;
  const fetchImpl = async (url, options = {}) => {
    const href = String(url);
    calls.push({ url: href, options });
    if (href.includes("/x/web-interface/nav")) {
      return jsonResponse({ code: 0, data: login });
    }
    if (href.includes("/x/web-interface/view")) {
      return jsonResponse({
        code: 0,
        data: {
          aid: 111,
          cid: 222,
          bvid: PAGE.bvid,
          title: "测试视频",
          duration: 60,
          pages: [{ cid: 222, part: "P1", duration: 60 }]
        }
      });
    }
    if (href.includes("/x/player/wbi/v2") || href.includes("/x/player/v2")) {
      if (!playerOk) return jsonResponse({ code: -400, message: "player down" }, false);
      return jsonResponse({
        code: 0,
        data: { subtitle: { subtitles: playerSubs } }
      });
    }
    if (href.includes("/x/v2/dm/view")) {
      if (!dmOk) return jsonResponse({ code: -500, message: "dm down" }, false);
      return jsonResponse({
        code: 0,
        data: { subtitle: { subtitles: dmSubs } }
      });
    }
    if (href.includes("hdslb.com") || href.includes("subtitle")) {
      return jsonResponse({
        body: [{ from: 0, to: 1.5, content: "官方字幕" }]
      });
    }
    throw new Error(`unexpected fetch ${href}`);
  };
  return { calls, fetchImpl };
}

function aiZhTrack(url = CUE_URL) {
  return {
    lan: "ai-zh",
    lan_doc: "中文（自动生成）",
    subtitle_url: url
  };
}

test("player 列表为空且 dm/view 有 ai-zh 时用官方字幕", async () => {
  const { calls, fetchImpl } = biliFetch({
    playerSubs: [{ lan: "ai-zh", lan_doc: "中文（自动生成）", subtitle_url: "" }],
    dmSubs: [aiZhTrack()]
  });
  const B = loadBackground(fetchImpl);
  const data = await B.loadSubtitles(PAGE);
  assert.equal(data.subtitleStatus, "");
  assert.equal(data.error, "");
  assert.equal(data.source, "bilibili");
  assert.equal(data.activeLan, "ai-zh");
  assert.equal(data.cues[0].content, "官方字幕");
  assert.equal(data.tracks[0].lan, "ai-zh");
  assert.ok(calls.some((item) => item.url.includes("/x/player/wbi/v2")));
  const dm = calls.find((item) => item.url.includes("/x/v2/dm/view"));
  assert.ok(dm);
  assert.match(dm.url, /oid=222/);
  assert.match(dm.url, /pid=111/);
  assert.equal(dm.options.credentials, "include");
  assert.equal(dm.options.headers.Referer, "https://www.bilibili.com/");
  assert.equal(dm.options.headers.Accept, "application/json");
});

test("已登录且两个接口都返回空列表时为 none", async () => {
  const { calls, fetchImpl } = biliFetch({ playerSubs: [], dmSubs: [] });
  const B = loadBackground(fetchImpl);
  const data = await B.loadSubtitles(PAGE);
  assert.equal(data.subtitleStatus, "none");
  assert.equal(data.error, "");
  assert.equal(data.cues.length, 0);
  assert.equal(data.canGenerate, true);
  assert.ok(calls.some((item) => item.url.includes("/x/v2/dm/view")));
});

test("已登录且两个接口都失败时为 fetch_failed", async () => {
  const { fetchImpl } = biliFetch({ playerOk: false, dmOk: false });
  const B = loadBackground(fetchImpl);
  const data = await B.loadSubtitles(PAGE);
  assert.equal(data.subtitleStatus, "fetch_failed");
  assert.equal(data.error, "");
  assert.equal(data.notice, "没拿到字幕列表");
  assert.equal(data.cues.length, 0);
  assert.equal(data.canGenerate, true);
});

test("未登录时空列表不打成 none", async () => {
  const { fetchImpl } = biliFetch({
    login: { isLogin: false },
    playerSubs: [],
    dmSubs: []
  });
  const B = loadBackground(fetchImpl);
  const data = await B.loadSubtitles(PAGE);
  assert.notEqual(data.subtitleStatus, "none");
  assert.notEqual(data.subtitleStatus, "fetch_failed");
  assert.equal(data.subtitleStatus, "login");
  assert.match(data.error, /未登录/);
});

test("player 已有字幕轨时不请求 dm/view", async () => {
  const { calls, fetchImpl } = biliFetch({
    playerSubs: [aiZhTrack()],
    dmSubs: [aiZhTrack("https://i0.hdslb.com/bfs/subtitle/other.json")]
  });
  const B = loadBackground(fetchImpl);
  const data = await B.loadSubtitles(PAGE);
  assert.equal(data.activeLan, "ai-zh");
  assert.equal(data.cues[0].content, "官方字幕");
  assert.ok(calls.some((item) => item.url.includes("/x/player/wbi/v2")));
  assert.equal(calls.some((item) => item.url.includes("/x/v2/dm/view")), false);
});

test("fetchJson 合并 headers，不让 options 覆盖默认 Accept", async () => {
  const { calls, fetchImpl } = biliFetch();
  const B = loadBackground(fetchImpl);
  await B.fetchJson("https://api.bilibili.com/x/web-interface/nav", {
    headers: { Referer: "https://www.bilibili.com/" }
  });
  const nav = calls.find((item) => item.url.includes("/x/web-interface/nav"));
  assert.equal(nav.options.credentials, "include");
  assert.equal(nav.options.headers.Referer, "https://www.bilibili.com/");
  assert.match(nav.options.headers.Accept, /application\/json/);
});

test("清理缓存只删转写翻译大纲，官方字幕会重新加载", async () => {
  const { fetchImpl } = biliFetch({ playerSubs: [aiZhTrack()] });
  const B = loadBackground(fetchImpl);
  const cid = 222;
  B.__store[`asr:${PAGE.bvid}:${cid}`] = {
    cues: [{ from: 0, to: 1, content: "自己生成的字幕" }],
    source: "groq",
    activeLan: "groq-asr"
  };
  B.__store[`asrJob:${PAGE.bvid}:${cid}`] = { pending: false };
  B.__store[`trJob:${PAGE.bvid}:${cid}`] = { status: "done" };
  B.__store[`outline:${PAGE.bvid}:${cid}`] = [{ title: "旧大纲" }];
  B.__store[`outline:v2:${PAGE.bvid}:${cid}`] = { summary: "旧总结", chapters: [] };

  const before = await B.loadSubtitles(PAGE);
  assert.equal(before.source, "groq");
  assert.equal(before.cues[0].content, "自己生成的字幕");

  const cleared = await B.clearVideoCache(PAGE.bvid, cid);
  assert.equal(cleared.ok, true);
  assert.equal(B.__store[`asr:${PAGE.bvid}:${cid}`], undefined);
  assert.equal(B.__store[`asrJob:${PAGE.bvid}:${cid}`], undefined);
  assert.equal(B.__store[`trJob:${PAGE.bvid}:${cid}`], undefined);
  assert.equal(B.__store[`outline:${PAGE.bvid}:${cid}`], undefined);
  assert.equal(B.__store[`outline:v2:${PAGE.bvid}:${cid}`], undefined);

  const after = await B.loadSubtitles(PAGE);
  assert.equal(after.source, "bilibili");
  assert.equal(after.cues[0].content, "官方字幕");
});

test("已登录且 player 空列表但 dm/view 失败时为 fetch_failed", async () => {
  const { fetchImpl } = biliFetch({ playerSubs: [], dmOk: false });
  const B = loadBackground(fetchImpl);
  const data = await B.loadSubtitles(PAGE);
  assert.equal(data.subtitleStatus, "fetch_failed");
  assert.equal(data.error, "");
  assert.equal(data.notice, "没拿到字幕列表");
  assert.equal(data.canGenerate, true);
});
