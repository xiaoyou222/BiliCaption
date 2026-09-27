const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { loadBackgroundScripts, panelSource } = require("./源码加载.js");

// 转写字幕与改字的 WebDAV 备份（后台/字幕备份.js + lib/webdav.js 的 subs/ 部分）。
// 后台按真实加载顺序执行，fetch 换成内存里的假 WebDAV，chrome.storage 换成内存对象；
// 1 秒以上的定时器（上传防抖）不真的等，由测试手动触发。

const DAV_URL = "https://dav.example.com/dav/";

function storageArea(store) {
  return {
    async get(keys) {
      if (keys == null) return { ...store };
      if (typeof keys === "string") return Object.hasOwn(store, keys) ? { [keys]: store[keys] } : {};
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => Object.hasOwn(store, key)).map((key) => [key, store[key]]));
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

/** 内存里的 WebDAV：记下每个请求；faults 里的函数返回值非空时代替正常响应 */
function davServer() {
  const files = new Map();
  const dirs = new Set([""]);
  const log = [];
  const faults = [];
  const response = (status, body = "") => ({
    ok: status >= 200 && status < 300,
    status,
    type: "basic",
    async json() { return JSON.parse(body); },
    async text() { return body; }
  });
  async function handle(url, options = {}) {
    const method = options.method || "GET";
    const path = decodeURIComponent(new URL(url).pathname).replace(/^\/dav\/?/, "");
    log.push({ method, path, body: options.body });
    for (const fault of faults) {
      const hit = fault(method, path, options);
      if (hit) return hit;
    }
    if (method === "MKCOL") {
      const dir = path.replace(/\/$/, "");
      if (dirs.has(dir)) return response(405);
      dirs.add(dir);
      return response(201);
    }
    if (method === "PROPFIND") return response(207);
    if (method === "PUT") {
      const dir = path.split("/").slice(0, -1).join("/");
      if (!dirs.has(dir)) return response(409);
      files.set(path, options.body);
      return response(201);
    }
    if (method === "GET") return files.has(path) ? response(200, files.get(path)) : response(404);
    if (method === "DELETE") {
      if (!files.has(path)) return response(404);
      files.delete(path);
      return response(204);
    }
    return response(405);
  }
  return {
    files,
    dirs,
    log,
    faults,
    handle,
    json(path) {
      return files.has(path) ? JSON.parse(files.get(path)) : null;
    },
    /** 只看 subs/ 下的请求 */
    subs() {
      return log.filter((item) => item.path.startsWith("subs"));
    },
    count(method, path) {
      return log.filter((item) => item.method === method && item.path === path).length;
    }
  };
}

function loadBackground(overrides = {}) {
  const store = {};
  const server = davServer();
  const longTimers = new Map();
  let timerSeq = 0;
  const noopEvent = { addListener() {} };
  const settings = {
    syncOn: true,
    syncSubs: true,
    syncMarks: true,
    syncConfig: false,
    davUrl: DAV_URL,
    davUser: "me",
    davPass: "pw",
    sumProvider: "OpenAI",
    apiBase: "https://api.example.com/v1",
    apiKey: "sk-secret-sum-key",
    apiModel: "m",
    translateModel: "",
    translateConcurrency: 1,
    sttChannels: [{ provider: "Groq", key: "gsk_secret_stt_key", model: "whisper" }],
    ...overrides
  };
  const context = {
    console, URL, TextEncoder, TextDecoder, Blob, AbortController, AbortSignal, DOMException,
    setInterval, clearInterval,
    // 上传防抖（1.5 秒、10 秒这类）记下来由测试触发；短定时器照常跑
    setTimeout(fn, ms, ...args) {
      if (Number(ms) >= 1000) {
        const id = { longTimer: ++timerSeq };
        longTimers.set(id, { fn, ms: Number(ms), args });
        return id;
      }
      return setTimeout(fn, ms, ...args);
    },
    clearTimeout(id) {
      if (id && typeof id === "object" && "longTimer" in id) longTimers.delete(id);
      else clearTimeout(id);
    },
    fetch: (url, options) => server.handle(url, options),
    btoa: (text) => Buffer.from(text, "binary").toString("base64"),
    importScripts() {},
    chrome: {
      runtime: {
        id: "test-extension",
        onInstalled: noopEvent,
        onStartup: noopEvent,
        onMessage: { addListener(fn) { context.__onMessage = fn; } },
        async sendMessage() {},
        async getPlatformInfo() { return {}; },
        getURL(file) { return `chrome-extension://test/${file}`; },
        async getContexts() { return []; },
        lastError: null
      },
      permissions: { async request() { return true; } },
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
    BiliCaptionPrefs: {
      async loadSettings(defaults) { return { ...defaults, ...settings }; },
      async saveSettings(data) { Object.assign(settings, data); }
    },
    BiliCaptionProviders: {
      resolveSum: (s) => ({ provider: s.sumProvider, base: s.apiBase, key: s.apiKey, model: s.apiModel })
    },
    BiliCaptionStt: {},
    BiliCaptionMp4: { CHUNK_SECONDS: 8 * 60, CHUNK_BYTES: 20 * 1024 * 1024 }
  };
  context.self = context;
  vm.createContext(context);
  loadBackgroundScripts(context, ["lib/视频平台.js", "lib/字幕工具.js", "lib/zh-simp.js", "lib/translate.js", "lib/模型路由.js", "lib/webdav.js"]);
  const bg = context;
  return {
    bg,
    store,
    server,
    settings,
    longTimers,
    /** 等后台里排着的写入和远端操作都做完 */
    async settle() {
      for (let i = 0; i < 8; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await vm.runInContext("subsRemoteChain", context);
        await vm.runInContext("subsStateChain", context);
      }
    },
    /** 触发所有已排上的上传防抖定时器 */
    async fireTimers() {
      const due = [...longTimers.entries()];
      longTimers.clear();
      for (const [, timer] of due) timer.fn(...timer.args);
      await this.settle();
    },
    backupDelays() {
      return [...longTimers.values()].map((timer) => timer.ms);
    },
    state() {
      return store.davSubs || { index: {}, files: {}, pending: {} };
    },
    /** 读后台脚本顶层的 const / let（不挂在全局对象上） */
    run(code) {
      return vm.runInContext(code, context);
    }
  };
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

/** 走真实的 runAsrJob：只把拿音频地址和转写本身换成桩 */
async function transcribe(env, bvid, cid, cues, { partial = false } = {}) {
  const { bg } = env;
  bg.fetchPlayurl = async () => ({ timelength: 60000 });
  bg.pickAudioStream = () => ({ url: "https://upos.example.com/audio.m4s" });
  bg.transcribeAudio = async () => ({ cues, partial, reason: partial ? "有一段没转成" : "", done: 1, total: 1 });
  const job = { jobId: `asr-${bvid}`, controller: new AbortController(), tabId: 0, bvid, cid, sttCfg: { provider: "Groq", model: "whisper-large-v3" } };
  await bg.runAsrJob(job, { meta: { bvid, cid, aid: 1, title: "标题", duration: 60 }, signal: job.controller.signal, asrLanguage: "en", forceRestart: false });
  await env.settle();
}

/** 走真实的 runTranslateJob：只把模型请求换成按行号回中文 */
async function translate(env, bvid, cid) {
  const { bg } = env;
  bg.translateChat = async (prompt) => {
    const count = [...prompt.matchAll(/^\d+\./gm)].length;
    return Array.from({ length: count }, (_, i) => `${i + 1}. 第${i + 1}句中文`).join("\n");
  };
  const cached = await bg.loadCachedAsr(bvid, cid);
  const prepared = bg.BiliCaptionTranslate.prepareCues(cached.cues);
  const job = {
    jobId: `tr-${bvid}`,
    controller: new AbortController(),
    tabId: 0,
    bvid,
    cid,
    cues: prepared.cues,
    done: 0,
    total: prepared.targets.length,
    pending: true
  };
  await bg.runTranslateJob(job, prepared.targets);
  await env.settle();
}

/** 模拟另一台电脑：直接往假网盘里写一份备份并更新索引 */
function remoteWrite(env, bvid, cid, entry, updatedAt) {
  const Dav = env.bg.BiliCaptionDav;
  const doc = Dav.subtitleBackupDoc(bvid, cid, entry, updatedAt);
  const body = JSON.stringify(doc);
  env.server.dirs.add("subs");
  env.server.files.set(Dav.subFile(bvid, cid), body);
  const index = env.server.json("subs/index.json") || {};
  index[Dav.subFileId(bvid, cid)] = Dav.subsIndexEntry(doc, body.length);
  env.server.files.set("subs/index.json", JSON.stringify(index));
  return doc;
}

const ytPage = (env, id) => env.bg.BiliCaptionPlatforms.parse(`https://www.youtube.com/watch?v=${id}`);

test("转写完成（含部分完成）后上传一次：先建 subs/ 再读-改-写索引；官方字幕且没改字的不上传", async () => {
  const env = loadBackground();
  await transcribe(env, "BVasr", 1, [line("Hello there", 0, 2), line("Second", 2, 4)], { partial: true });
  assert.deepEqual(env.backupDelays(), [1500], "转写完成后很快上传，不等 10 秒");
  assert.equal(env.server.subs().length, 0, "定时器触发前不发请求");
  await env.fireTimers();

  assert.deepEqual(env.server.subs().map((item) => `${item.method} ${item.path}`), [
    "MKCOL subs/",
    "GET subs/index.json",
    "PUT subs/BVasr-P1.json",
    "PUT subs/index.json"
  ]);
  const doc = env.server.json("subs/BVasr-P1.json");
  assert.equal(doc.v, 1);
  assert.equal(doc.id, "BVasr-P1");
  assert.equal(doc.origin, "asr");
  assert.equal(doc.partial, true, "部分完成也备份");
  assert.equal(doc.provider, "Groq");
  assert.equal(doc.model, "whisper-large-v3");
  assert.deepEqual(doc.cues.map((cue) => cue.content), ["Hello there", "Second"]);
  const index = env.server.json("subs/index.json");
  assert.equal(index["BVasr-P1"].hash, doc.hash);
  assert.equal(index["BVasr-P1"].origin, "asr");
  assert.ok(index["BVasr-P1"].size > 0);
  assert.deepEqual(env.state().pending, {});
  assert.equal(env.state().files["BVasr-P1"].hash, doc.hash);

  // 同一份内容再触发一次（例如翻译没译出东西）：本地就能判断没变，不发请求
  const before = env.server.log.length;
  await env.bg.queueSubtitleBackup("BVasr", 1, "translate");
  await env.fireTimers();
  assert.equal(env.server.log.length, before);

  // 官方字幕、没改过字：不排队、不上传
  await env.bg.persistOfficialSubtitleCache("BVoff", 1, { cues: [line("官方")], source: "bilibili", activeLan: "ai-zh" });
  assert.equal(await env.bg.queueSubtitleBackup("BVoff", 1, "asr"), false);
  await env.fireTimers();
  assert.equal(env.server.log.length, before);
  assert.equal(env.state().pending["BVoff-P1"], undefined);
});

test("改字：10 秒防抖，连续几次改字合并成一次上传，传的是最后一次的内容", async () => {
  const env = loadBackground();
  const { bg } = env;
  const cues = [line("Helo", 0, 1), line("wrold", 1, 2)];
  await bg.persistOfficialSubtitleCache("BVedit", 1, { cues, source: "bilibili", activeLan: "ai-en" });
  const edits = [
    [{ ...cues[0], content: "Hello", edited: true }, cues[1]],
    [{ ...cues[0], content: "Hello", edited: true }, { ...cues[1], content: "world", edited: true }],
    [{ ...cues[0], content: "Hello!", edited: true }, { ...cues[1], content: "world", edited: true }]
  ];
  for (const edited of edits) {
    const res = await route(bg, { type: "SAVE_CUES_CACHE", bvid: "BVedit", cid: 1, cues: edited, source: "bilibili", activeLan: "ai-en", edited: true }, CONTENT);
    assert.equal(res.ok, true);
    await env.settle();
  }
  assert.deepEqual(env.backupDelays(), [10000], "三次改字只剩一个 10 秒定时器");
  assert.equal(env.server.subs().length, 0);
  await env.fireTimers();
  assert.equal(env.server.count("PUT", "subs/BVedit-P1.json"), 1);
  const doc = env.server.json("subs/BVedit-P1.json");
  assert.deepEqual(doc.cues.map((cue) => cue.content), ["Hello!", "world"]);
  assert.deepEqual(doc.cues.map((cue) => cue.edited), [true, true]);
  assert.equal(doc.origin, "official");
  assert.ok(doc.editedAt > 0);

  // 不带 edited 的普通保存（翻译回写等）不触发上传
  await route(bg, { type: "SAVE_CUES_CACHE", bvid: "BVplain", cid: 1, cues, source: "bilibili", activeLan: "ai-en" }, CONTENT);
  await env.settle();
  assert.deepEqual(env.backupDelays(), []);
});

test("受保护视频翻译完成后上传一次（译文和英文原文一起备份）；官方字幕的译文不上传", async () => {
  const env = loadBackground();
  const { bg, store } = env;
  store["asr:BVtr:1"] = {
    cues: [line("This is line one.", 0, 2), line("This is line two.", 2, 4)],
    source: "groq", activeLan: "groq-asr", origin: "asr", provider: "Groq", model: "w", partial: false, savedAt: 1
  };
  await translate(env, "BVtr", 1);
  assert.deepEqual(env.backupDelays(), [1500]);
  await env.fireTimers();
  assert.equal(env.server.count("PUT", "subs/BVtr-P1.json"), 1);
  const doc = env.server.json("subs/BVtr-P1.json");
  assert.equal(doc.source, "translated");
  assert.equal(doc.origin, "asr");
  assert.deepEqual(doc.cues.map((cue) => cue.content), ["第1句中文", "第2句中文"]);
  assert.deepEqual(doc.cues.map((cue) => cue.original), ["This is line one.", "This is line two."]);

  // 官方字幕（没改字）翻译完成：不上传
  const before = env.server.log.length;
  await bg.persistOfficialSubtitleCache("BVofftr", 1, { cues: [line("Official line.", 0, 2)], source: "youtube", activeLan: "en", tracks: [{ lan: "en" }] });
  await translate(env, "BVofftr", 1);
  await env.fireTimers();
  assert.equal(store["asr:BVofftr:1"].cues[0].content, "第1句中文");
  assert.equal(env.server.log.length, before);
});

test("索引读-改-写：上传前重新读远端索引，只改自己的条目，其它电脑写入的原样保留", async () => {
  const env = loadBackground();
  const { bg } = env;
  // 本机的索引副本是旧的（不知道另一台电脑刚传的 BVother）
  remoteWrite(env, "BVother", 2, { cues: [line("别的电脑")], source: "groq", origin: "asr" }, 5000);
  remoteWrite(env, "BVtomb", 1, { cues: [line("x")], source: "groq", origin: "asr" }, 4000);
  const index = env.server.json("subs/index.json");
  index["BVtomb-P1"] = { bvid: "BVtomb", cid: 1, deleted: true, updatedAt: Date.now() };
  env.server.files.set("subs/index.json", JSON.stringify(index));
  const otherEntry = env.server.json("subs/index.json")["BVother-P2"];

  await transcribe(env, "BVmine", 1, [line("mine")]);
  await transcribe(env, "BVmine", 2, [line("mine two")]);
  await env.fireTimers();
  const merged = env.server.json("subs/index.json");
  assert.deepEqual(merged["BVother-P2"], otherEntry, "另一台电脑的条目一字不改");
  assert.equal(merged["BVtomb-P1"].deleted, true, "别人的墓碑也保留");
  assert.ok(merged["BVmine-P1"] && merged["BVmine-P2"]);
  // 两个视频的上传合并成一批：只读一次、写一次索引
  assert.equal(env.server.count("GET", "subs/index.json"), 1);
  assert.equal(env.server.count("PUT", "subs/index.json"), 1);
  // 本机的索引副本也换成了合并后的
  assert.ok(env.state().index["BVother-P2"]);
  assert.equal(bg.BiliCaptionDav.normalizeSubsIndex(env.state().index)["BVmine-P2"].hash, merged["BVmine-P2"].hash);
});

test("打开视频：同步时拉一次索引；只在索引里有、本机没有受保护缓存时 GET 一次，取回后写进本地并使用", async () => {
  const env = loadBackground();
  const { bg, store, server } = env;
  const yt = ytPage(env, "aircAruvnKk");
  const ytId = bg.BiliCaptionDav.subFileId(yt.bvid, 1);
  const remoteDoc = remoteWrite(env, yt.bvid, 1, {
    cues: [line("另一台电脑转写的", 0, 2), line("改过的一行", 2, 4, { edited: true })],
    source: "groq", activeLan: "groq-asr", origin: "asr", editedAt: 777, provider: "Groq", model: "w", title: "远端标题"
  }, 9000);

  // 还没同步过：本地没有索引副本，打开视频一个 subs/ 请求都不发
  bg.readPlatformPage = async () => ({ title: "页面标题", tracks: [] });
  let state = await bg.loadPlatformSubtitles(yt, 1);
  assert.equal(state.cues.length, 0);
  assert.equal(server.subs().length, 0);

  // 手动同步：顺带拉一次 subs/index.json
  await bg.runDavSync("manual");
  await env.settle();
  assert.equal(server.count("GET", "subs/index.json"), 1);
  assert.ok(env.state().index[ytId]);
  assert.ok(env.state().indexAt > 0);

  // 索引里没有的视频：不发请求
  const before = server.subs().length;
  await bg.loadPlatformSubtitles(ytPage(env, "dQw4w9WgXcQ"), 1);
  assert.equal(server.subs().length, before);

  // 强制刷新不拉远端
  await bg.loadPlatformSubtitles(yt, 1, { force: true });
  assert.equal(server.count("GET", `subs/${ytId}.json`), 0);

  // 正常打开：GET 一次，写进本地缓存并直接使用
  state = await bg.loadPlatformSubtitles(yt, 1);
  assert.equal(server.count("GET", `subs/${ytId}.json`), 1);
  assert.deepEqual(state.cues.map((cue) => cue.content), ["另一台电脑转写的", "改过的一行"]);
  const local = store[`asr:${yt.bvid}:1`];
  assert.equal(local.origin, "asr");
  assert.equal(local.editedAt, 777);
  assert.equal(local.cues[1].edited, true);
  assert.equal(bg.BiliCaptionCueTools.isProtectedSubtitleCache(local), true);
  assert.equal(env.state().files[ytId].hash, remoteDoc.hash);

  // 再打开：本机已有、远端没变，不再请求
  await bg.loadPlatformSubtitles(yt, 1);
  await bg.loadPlatformSubtitles(yt, 1);
  assert.equal(server.count("GET", `subs/${ytId}.json`), 1);

  // B 站：本机只有官方字幕（没改字），远端有改过字的备份 → 受保护条目优先
  remoteWrite(env, "BVbili", 11, {
    cues: [line("改过的官方字幕", 0, 1, { edited: true })], source: "bilibili", activeLan: "ai-zh", origin: "official", editedAt: 55
  }, 9100);
  await bg.runDavSync("manual");
  store["asr:BVbili:11"] = {
    cues: [line("官方原文")], source: "bilibili", activeLan: "ai-zh", origin: "official", savedAt: 3,
    tracks: [{ lan: "ai-zh", lanDoc: "中文", url: "https://aisubtitle.hdslb.com/x.json?auth_key=1" }]
  };
  bg.fetchView = async () => ({ bvid: "BVbili", aid: 1, cid: 11, title: "B 站视频", duration: 100, pages: [{ cid: 11, duration: 100 }], owner: { name: "up" } });
  bg.loadBiliLogin = async () => ({ isLogin: true });
  bg.fetchPlayer = async () => { throw new Error("命中缓存时不该取字幕轨"); };
  const bili = await bg.loadSubtitles({ kind: "video", bvid: "BVbili", p: 1 }, 1);
  assert.equal(server.count("GET", "subs/BVbili-P11.json"), 1);
  assert.deepEqual(bili.cues.map((cue) => cue.content), ["改过的官方字幕"]);
  assert.equal(store["asr:BVbili:11"].editedAt, 55);
  assert.equal(store["asr:BVbili:11"].tracks.length, 1, "本机原有的字幕轨列表留着");
});

test("取回备份超时或失败：5 秒内放弃，照常用本机字幕", async () => {
  const env = loadBackground();
  const { bg, server } = env;
  remoteWrite(env, "BVslow", 1, { cues: [line("远端")], source: "groq", origin: "asr" }, 100);
  await bg.runDavSync("manual");
  server.faults.push((method, path, options) => {
    if (method !== "GET" || path !== "subs/BVslow-P1.json") return null;
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  });
  const started = Date.now();
  const got = await bg.restoreSubtitleBackup("BVslow", 1, null, { timeoutMs: 60 });
  assert.equal(got, null);
  assert.ok(Date.now() - started < 2000);
  assert.equal(env.store["asr:BVslow:1"], undefined);
});

test("冲突：远端更新而本机没改过就用远端覆盖；两边都改过保留本机，远端那份另存为冲突副本", async () => {
  const env = loadBackground();
  const { bg, store, server } = env;
  const yt = ytPage(env, "aircAruvnKk");
  const key = `asr:${yt.bvid}:1`;
  const id = bg.BiliCaptionDav.subFileId(yt.bvid, 1);
  bg.readPlatformPage = async () => { throw new Error("命中缓存时不该读页面"); };

  // 本机转写并上传
  await transcribe(env, yt.bvid, 1, [line("v1 本机", 0, 1)]);
  await env.fireTimers();
  const firstHash = env.state().files[id].hash;

  // 另一台电脑改过（远端换了内容），同步拉到新索引；本机没改过 → 打开时用远端覆盖
  remoteWrite(env, yt.bvid, 1, { cues: [line("v2 另一台电脑改的", 0, 1, { edited: true })], source: "groq", activeLan: "groq-asr", origin: "asr", editedAt: 2000 }, Date.now() + 10);
  await bg.runDavSync("manual");
  let state = await bg.loadPlatformSubtitles(yt, 1);
  assert.deepEqual(state.cues.map((cue) => cue.content), ["v2 另一台电脑改的"]);
  assert.equal(store[key].editedAt, 2000);
  assert.notEqual(env.state().files[id].hash, firstHash);
  assert.equal(server.count("GET", `subs/${id}.json`), 1);

  // 两边都改：本机改字（还没上传），另一台电脑又传了 v3
  await route(bg, {
    type: "SAVE_CUES_CACHE", bvid: yt.bvid, cid: 1, cues: [line("v3 本机改的", 0, 1, { edited: true })],
    source: "groq", activeLan: "groq-asr", edited: true
  }, CONTENT);
  await env.settle();
  remoteWrite(env, yt.bvid, 1, { cues: [line("v3 另一台电脑改的", 0, 1, { edited: true })], source: "groq", activeLan: "groq-asr", origin: "asr", editedAt: 3000 }, Date.now() + 20);
  // 定时同步拉到新索引；改字的防抖定时器还在等，定时同步不抢着传
  await bg.runDavSync("dav-auto-sync");
  await env.settle();
  assert.equal(server.count("PUT", `subs/${id}.json`), 1, "只有最初那次上传");
  assert.equal(env.state().index[id].editedAt, 3000);
  // 打开视频：保留本机，不为冲突发 GET
  state = await bg.loadPlatformSubtitles(yt, 1);
  assert.deepEqual(state.cues.map((cue) => cue.content), ["v3 本机改的"]);
  assert.equal(server.count("GET", `subs/${id}.json`), 1);

  // 防抖到点上传：远端那份另存为冲突副本，再用本机的覆盖
  await env.fireTimers();
  const conflicts = [...server.files.keys()].filter((path) => path.startsWith(`subs/${id}-conflict-`));
  assert.equal(conflicts.length, 1);
  assert.deepEqual(server.json(conflicts[0]).cues.map((cue) => cue.content), ["v3 另一台电脑改的"]);
  assert.deepEqual(server.json(`subs/${id}.json`).cues.map((cue) => cue.content), ["v3 本机改的"]);
  assert.equal(server.json("subs/index.json")[id].hash, server.json(`subs/${id}.json`).hash);
  assert.equal(store[key].cues[0].content, "v3 本机改的");
  assert.equal(server.json("subs/index.json")[`${id}-conflict`], undefined, "冲突副本不进索引，不会被自动拉回");
});

/** 收集后台发给侧栏的广播 */
function captureBroadcasts(bg) {
  const sent = [];
  bg.chrome.runtime.sendMessage = async (message) => {
    sent.push(JSON.parse(JSON.stringify(message)));
  };
  return sent;
}

const conflictFiles = (server, id) => [...server.files.keys()].filter((path) => path.startsWith(`subs/${id}-conflict-`));

test("冲突：本机从没改过字的转写打开视频时直接换成远端的改字版，不上传本机版本、不生成冲突副本", async () => {
  const env = loadBackground();
  const { bg, store, server } = env;
  // A 机改过字并上传
  const remoteDoc = remoteWrite(env, "BVab", 1, {
    cues: [line("A 改过的第一句", 0, 1, { edited: true }), line("second", 1, 2)],
    source: "groq", activeLan: "groq-asr", origin: "asr", editedAt: 5000
  }, 9000);
  // B 机：开同步前就有、从没改过字的转写
  store["asr:BVab:1"] = {
    cues: [line("B 的第一句", 0, 1), line("second", 1, 2)],
    source: "groq", activeLan: "groq-asr", origin: "asr", provider: "Groq", model: "w", savedAt: 5
  };
  await bg.runDavSync("manual");
  await env.settle();

  const got = await bg.restoreSubtitleBackup("BVab", 1, store["asr:BVab:1"]);
  await env.settle();
  await env.fireTimers();
  assert.deepEqual(got?.cues.map((cue) => cue.content), ["A 改过的第一句", "second"], "打开时就用 A 的改字版");
  assert.equal(store["asr:BVab:1"].editedAt, 5000);
  assert.equal(store["asr:BVab:1"].cues[0].edited, true);
  assert.equal(server.count("PUT", "subs/BVab-P1.json"), 0, "B 的版本不上传");
  assert.deepEqual(conflictFiles(server, "BVab-P1"), [], "未改字的一方输了不留冲突副本");
  assert.equal(server.json("subs/BVab-P1.json").hash, remoteDoc.hash, "远端还是 A 的那份");
  assert.deepEqual(env.state().pending, {});

  // A 下次打开：远端还是 A 自己的那份，改字都在
  assert.deepEqual(server.json("subs/BVab-P1.json").cues.map((cue) => cue.content), ["A 改过的第一句", "second"]);
});

test("冲突：开同步前的转写补传时先看远端索引，远端已有改字版就取回，不直接覆盖；本机译文合并进来", async () => {
  const env = loadBackground();
  const { bg, store, server } = env;
  const sent = captureBroadcasts(bg);
  await bg.runDavSync("manual"); // 本机拉到的索引里还没有这个视频
  store["asr:BVfill:1"] = {
    cues: [line("B 的第一句", 0, 1), line("第二句（B 译）", 1, 2, { original: "second" })],
    source: "translated", activeLan: "translated", origin: "asr", provider: "Groq", model: "w", savedAt: 5
  };
  await bg.restoreSubtitleBackup("BVfill", 1, store["asr:BVfill:1"]);
  await env.settle();
  assert.equal(env.state().pending["BVfill-P1"].reason, "backfill");
  // 补传前 A 机传了改字版
  remoteWrite(env, "BVfill", 1, {
    cues: [line("A 改过的第一句", 0, 1, { edited: true }), line("second", 1, 2)],
    source: "groq", activeLan: "groq-asr", origin: "asr", editedAt: 5000
  }, 9000);
  await env.fireTimers();

  const doc = server.json("subs/BVfill-P1.json");
  assert.deepEqual(doc.cues.map((cue) => cue.content), ["A 改过的第一句", "第二句（B 译）"], "A 的改字保留，B 的译文补在没改过的行上");
  assert.equal(doc.cues[0].edited, true);
  assert.equal(doc.cues[1].original, "second");
  assert.equal(doc.editedAt, 5000);
  assert.deepEqual(conflictFiles(server, "BVfill-P1"), []);
  const local = store["asr:BVfill:1"];
  assert.deepEqual(local.cues.map((cue) => cue.content), ["A 改过的第一句", "第二句（B 译）"]);
  assert.equal(local.editedAt, 5000);
  assert.equal(env.state().files["BVfill-P1"].hash, doc.hash);
  assert.deepEqual(env.state().pending, {});
  assert.ok(sent.some((msg) => msg.type === "SUBS_BACKUP_NOTICE" && msg.bvid === "BVfill" && msg.replaced === true), "通知侧栏重新读字幕");
});

test("冲突：两边都改过字时以 editedAt 较新的为准，另一方另存为冲突副本，并在日志和侧栏提示路径", async () => {
  const env = loadBackground();
  const { bg, store, server } = env;
  const sent = captureBroadcasts(bg);
  // 远端（A 机）的改字更新
  const remoteDoc = remoteWrite(env, "BVboth", 1, {
    cues: [line("A 新改的", 0, 1, { edited: true }), line("second", 1, 2)],
    source: "groq", activeLan: "groq-asr", origin: "asr", editedAt: Date.now() - 1000
  }, Date.now());
  await bg.runDavSync("manual");
  // 本机（B 机）的改字较旧，还没同步过
  store["asr:BVboth:1"] = {
    cues: [line("B 旧改的", 0, 1, { edited: true }), line("second", 1, 2)],
    source: "groq", activeLan: "groq-asr", origin: "asr", editedAt: 1000, savedAt: 5
  };
  const got = await bg.restoreSubtitleBackup("BVboth", 1, store["asr:BVboth:1"]);
  assert.equal(got, null, "打开视频时先用本机的，冲突排队处理");
  await env.settle();
  await env.fireTimers();

  assert.equal(server.json("subs/BVboth-P1.json").hash, remoteDoc.hash, "较新的远端不被覆盖");
  const copies = conflictFiles(server, "BVboth-P1");
  assert.equal(copies.length, 1);
  assert.deepEqual(server.json(copies[0]).cues.map((cue) => cue.content), ["B 旧改的", "second"], "本机较旧的改字另存为冲突副本");
  assert.deepEqual(store["asr:BVboth:1"].cues.map((cue) => cue.content), ["A 新改的", "second"]);
  assert.equal(store["asr:BVboth:1"].editedAt, remoteDoc.editedAt);
  assert.equal(env.state().files["BVboth-P1"].hash, remoteDoc.hash);
  assert.equal(server.json("subs/index.json")[`${copies[0].slice(5, -5)}`], undefined, "冲突副本不进索引");
  const logs = await bg.getAppLogs();
  assert.ok(logs.some((entry) => entry.message.includes(copies[0])), "本机日志写明冲突副本路径");
  const notice = sent.find((msg) => msg.type === "SUBS_BACKUP_NOTICE" && msg.bvid === "BVboth");
  assert.ok(notice);
  assert.equal(notice.conflictPath, copies[0]);
  assert.match(notice.notice, /冲突副本/);
  assert.ok(notice.notice.includes(copies[0]));
  assert.equal(notice.replaced, true);
});

test("冲突：两边都没改字（都是转写）时保留本机、远端另存冲突副本，双方的译文合并不丢", async () => {
  const env = loadBackground();
  const { bg, store, server } = env;
  remoteWrite(env, "BVtr2", 1, {
    cues: [line("one", 0, 1), line("第二句（A 译）", 1, 2, { original: "two" })],
    source: "translated", activeLan: "translated", origin: "asr"
  }, 9000);
  await bg.runDavSync("manual");
  store["asr:BVtr2:1"] = {
    cues: [line("第一句（B 译）", 0, 1, { original: "one" }), line("two", 1, 2)],
    source: "translated", activeLan: "translated", origin: "asr", provider: "Groq", model: "w", savedAt: 5
  };
  await bg.restoreSubtitleBackup("BVtr2", 1, store["asr:BVtr2:1"]);
  await env.settle();
  await env.fireTimers();

  const doc = server.json("subs/BVtr2-P1.json");
  assert.deepEqual(doc.cues.map((cue) => cue.content), ["第一句（B 译）", "第二句（A 译）"]);
  assert.deepEqual(doc.cues.map((cue) => cue.original), ["one", "two"]);
  assert.deepEqual(store["asr:BVtr2:1"].cues.map((cue) => cue.content), ["第一句（B 译）", "第二句（A 译）"]);
  const copies = conflictFiles(server, "BVtr2-P1");
  assert.equal(copies.length, 1, "沿用以前的做法：远端那份留一个冲突副本");
  assert.deepEqual(server.json(copies[0]).cues.map((cue) => cue.content), ["one", "第二句（A 译）"]);
});

test("清理本视频缓存（用户确认删网盘备份后）：删远端文件、写墓碑，之后不再拉回；「清理可重新生成的缓存」不碰远端", async () => {
  const env = loadBackground();
  const { bg, store, server } = env;
  const yt = ytPage(env, "aircAruvnKk");
  const id = bg.BiliCaptionDav.subFileId(yt.bvid, 1);
  await transcribe(env, yt.bvid, 1, [line("要删掉的转写")]);
  await env.fireTimers();
  assert.ok(server.files.has(`subs/${id}.json`));

  const res = await route(bg, { type: "CLEAR_VIDEO_CACHE", bvid: yt.bvid, cid: 1, deleteRemote: true });
  assert.equal(res.ok, true);
  assert.equal(store[`asr:${yt.bvid}:1`], undefined);
  assert.equal(env.state().index[id].deleted, true, "本地先记墓碑");
  await env.settle();
  assert.equal(server.files.has(`subs/${id}.json`), false, "远端文件已删");
  const index = server.json("subs/index.json");
  assert.equal(index[id].deleted, true);
  assert.equal(index[id].hash, undefined);
  assert.deepEqual(env.state().pending, {});

  // 墓碑视频：打开不拉、同步后也不拉
  bg.readPlatformPage = async () => ({ title: "页面", tracks: [] });
  const gets = () => server.count("GET", `subs/${id}.json`);
  await bg.loadPlatformSubtitles(yt, 1);
  await bg.runDavSync("manual");
  const state = await bg.loadPlatformSubtitles(yt, 1);
  assert.equal(state.cues.length, 0);
  assert.equal(gets(), 0);

  // 官方字幕的视频清理缓存：本机没备份过、远端也不知道，不发请求
  const stateBefore = JSON.stringify(env.state());
  const before = server.log.length;
  await bg.persistOfficialSubtitleCache("BVoff", 1, { cues: [line("官方")], source: "bilibili", activeLan: "ai-zh" });
  await route(bg, { type: "CLEAR_VIDEO_CACHE", bvid: "BVoff", cid: 1 });
  await env.settle();
  assert.equal(server.log.length, before);
  assert.equal(JSON.stringify(env.state()), stateBefore, "同步记录也不动");

  // 设置页「清理可重新生成的缓存」：只动本地
  await transcribe(env, "BVkeep", 1, [line("留着")]);
  await env.fireTimers();
  await bg.persistOfficialSubtitleCache("BVoff2", 1, { cues: [line("官方")], source: "bilibili", activeLan: "ai-zh" });
  const logged = server.log.length;
  const cleared = await route(bg, { type: "CLEAR_RENEWABLE_CACHE" });
  await env.settle();
  assert.equal(cleared.removed, 1);
  assert.equal(server.log.length, logged);
  assert.ok(server.files.has("subs/BVkeep-P1.json"));
});

test("清理本视频缓存：没带删网盘的确认时只清本机，网盘备份和索引都不动（取回超时只显示官方字幕时也一样）", async () => {
  const env = loadBackground();
  const { bg, store, server } = env;
  const status = async (bvid, cid = 1) => ({ ...(await route(bg, { type: "GET_SUBTITLE_BACKUP_STATUS", bvid, cid })) });

  // 本机转写并已备份：清理会连带删网盘备份
  await transcribe(env, "BVkeep", 1, [line("备份过的转写")]);
  await env.fireTimers();
  assert.deepEqual(await status("BVkeep"), { enabled: true, remote: true, local: true });
  const before = server.log.length;
  const res = await route(bg, { type: "CLEAR_VIDEO_CACHE", bvid: "BVkeep", cid: 1 });
  await env.settle();
  assert.equal(res.ok, true);
  assert.equal(store["asr:BVkeep:1"], undefined, "本机照删");
  assert.equal(server.log.length, before, "不发任何网盘请求");
  assert.ok(server.files.has("subs/BVkeep-P1.json"));
  assert.notEqual(env.state().index["BVkeep-P1"].deleted, true, "本地索引副本也不记墓碑");
  assert.equal(env.state().pending["BVkeep-P1"], undefined);

  // 远端有备份、本机取回超时只显示了官方字幕：状态里标出「本机没有这份备份」，清理不删网盘
  remoteWrite(env, "BVslow", 1, { cues: [line("远端改字", 0, 1, { edited: true })], source: "groq", origin: "asr", editedAt: 9 }, 100);
  await bg.runDavSync("manual");
  await env.settle();
  server.faults.push((method, path, options) => (method === "GET" && path === "subs/BVslow-P1.json"
    ? new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
    : null));
  await bg.persistOfficialSubtitleCache("BVslow", 1, { cues: [line("官方")], source: "bilibili", activeLan: "ai-zh" });
  assert.equal(await bg.restoreSubtitleBackup("BVslow", 1, store["asr:BVslow:1"], { timeoutMs: 30 }), null);
  assert.deepEqual(await status("BVslow"), { enabled: true, remote: true, local: false });
  const logged = server.log.length;
  await route(bg, { type: "CLEAR_VIDEO_CACHE", bvid: "BVslow", cid: 1 });
  await env.settle();
  assert.equal(server.log.length, logged);
  assert.ok(server.files.has("subs/BVslow-P1.json"));
  assert.notEqual(env.state().index["BVslow-P1"].deleted, true);

  // 没有网盘备份的视频、没开字幕同步：不需要确认
  await bg.persistOfficialSubtitleCache("BVoff", 1, { cues: [line("官方")], source: "bilibili", activeLan: "ai-zh" });
  assert.equal((await status("BVoff")).remote, false);
  env.settings.syncSubs = false;
  assert.deepEqual(await status("BVslow"), { enabled: false, remote: false, local: false });
});

/** 侧栏「清理缓存」的请求流程：先问后台会不会删网盘备份，会的话二次确认，确认后消息里才带 deleteRemote */
function loadPanelClear({ status, confirmAnswer = true, statusThrows = false } = {}) {
  const panel = panelSource();
  const start = panel.indexOf("function videoCacheClearWarning");
  const end = panel.indexOf('$("btnClearCache")', start);
  assert.ok(start >= 0 && end > start, "找不到侧栏清理缓存的请求函数");
  const sent = [];
  const asked = [];
  const context = {
    chrome: {
      runtime: {
        async sendMessage(message) {
          sent.push(JSON.parse(JSON.stringify(message)));
          if (message.type === "GET_SUBTITLE_BACKUP_STATUS") {
            if (statusThrows) throw new Error("后台没响应");
            return status;
          }
          return { ok: true };
        }
      }
    },
    confirm(text) {
      asked.push(text);
      return confirmAnswer;
    }
  };
  vm.createContext(context);
  vm.runInContext(panel.slice(start, end), context);
  return { context, sent, asked, run: () => vm.runInContext(`requestVideoCacheClear("BVx", 3)`, context) };
}

test("侧栏清理缓存：会删网盘备份时二次确认，确认后消息才带 deleteRemote；没有备份或没开同步时不问", async () => {
  const clears = (sent) => sent.filter((msg) => msg.type === "CLEAR_VIDEO_CACHE");

  // 网盘上有备份：确认 → 带 deleteRemote: true
  let panel = loadPanelClear({ status: { enabled: true, remote: true, local: true } });
  let res = await panel.run();
  assert.equal(res.ok, true);
  assert.equal(panel.asked.length, 1);
  assert.match(panel.asked[0], /会同时删除网盘上的字幕备份/);
  assert.deepEqual(clears(panel.sent), [{ type: "CLEAR_VIDEO_CACHE", bvid: "BVx", cid: 3, deleteRemote: true }]);

  // 取消 → 什么都不清
  panel = loadPanelClear({ status: { enabled: true, remote: true, local: true }, confirmAnswer: false });
  res = await panel.run();
  assert.equal(res.canceled, true);
  assert.deepEqual(clears(panel.sent), []);

  // 备份还没取回（本机只显示官方字幕）：提示里单独说明
  panel = loadPanelClear({ status: { enabled: true, remote: true, local: false } });
  await panel.run();
  assert.match(panel.asked[0], /会同时删除网盘上的字幕备份/);
  assert.match(panel.asked[0], /还没取回/);

  // 没有网盘备份 / 没开字幕同步 / 查询失败：不问，也不删网盘
  for (const opts of [{ status: { enabled: true, remote: false, local: true } }, { status: { enabled: false, remote: false, local: false } }, { statusThrows: true }]) {
    panel = loadPanelClear(opts);
    res = await panel.run();
    assert.equal(res.ok, true);
    assert.deepEqual(panel.asked, [], JSON.stringify(opts));
    assert.deepEqual(clears(panel.sent), [{ type: "CLEAR_VIDEO_CACHE", bvid: "BVx", cid: 3, deleteRemote: false }]);
  }
});

test("侧栏收到字幕备份冲突通知：当前视频提示冲突副本路径；本机被换成远端版本时放弃改字并重读", () => {
  const panel = panelSource();
  const start = panel.indexOf("function onSubsBackupNotice");
  const end = panel.indexOf("chrome.runtime.onMessage.addListener", start);
  assert.ok(start >= 0 && end > start);
  const calls = [];
  const context = {
    state: { bvid: "BVx", cid: 2 },
    generating: false,
    translating: false,
    flash: (text) => calls.push(`flash:${text}`),
    cancelCueEdit: () => calls.push("cancel"),
    refresh: async (force) => { calls.push(`refresh:${force}`); }
  };
  vm.createContext(context);
  vm.runInContext(panel.slice(start, end), context);
  const notice = (message) => vm.runInContext(`onSubsBackupNotice(${JSON.stringify(message)})`, context);
  notice({ bvid: "BVother", cid: 2, notice: "别的视频", replaced: true });
  assert.deepEqual(calls, []);
  notice({ bvid: "BVx", cid: 2, notice: "已保留本机的版本，另存为冲突副本 subs/BVx-P2-conflict-1.json" });
  assert.deepEqual(calls, ["flash:已保留本机的版本，另存为冲突副本 subs/BVx-P2-conflict-1.json"]);
  calls.length = 0;
  notice({ bvid: "BVx", cid: 2, notice: "已换成远端", replaced: true });
  assert.deepEqual(calls, ["flash:已换成远端", "cancel", "refresh:true"]);
});

test("重新生成转写时不拉远端；新结果完成后覆盖远端那份", async () => {
  const env = loadBackground();
  const { bg, server } = env;
  remoteWrite(env, "BVregen", 1, { cues: [line("旧转写")], source: "groq", origin: "asr" }, 100);
  await bg.runDavSync("manual");
  // 转写任务进行中（含强制重新生成）：打开视频不拉远端
  const asrJobs = env.run("asrJobs");
  asrJobs.set("running", { jobId: "running", bvid: "BVregen", cid: 1, controller: new AbortController() });
  assert.equal(await bg.restoreSubtitleBackup("BVregen", 1, null), null);
  asrJobs.delete("running");
  assert.equal(server.count("GET", "subs/BVregen-P1.json"), 0);

  await transcribe(env, "BVregen", 1, [line("新转写")]);
  await env.fireTimers();
  assert.deepEqual(server.json("subs/BVregen-P1.json").cues.map((cue) => cue.content), ["新转写"]);
});

test("开关关闭（同步字幕关或 WebDAV 关）时不上传也不下载", async () => {
  for (const off of [{ syncSubs: false }, { syncOn: false }]) {
    const env = loadBackground(off);
    const { bg, server, store } = env;
    // 以前开着时留下的索引副本里有这个视频
    store.davSubs = {
      dav: `${DAV_URL}|me`, indexAt: 1, files: {}, pending: {},
      index: { "BVfar-P1": { bvid: "BVfar", cid: 1, updatedAt: 5, hash: "x" } }
    };
    remoteWrite(env, "BVfar", 1, { cues: [line("远端")], source: "groq", origin: "asr" }, 5);
    await transcribe(env, "BVnew", 1, [line("本机转写")]);
    await route(bg, { type: "SAVE_CUES_CACHE", bvid: "BVnew", cid: 1, cues: [line("改", 0, 1, { edited: true })], source: "groq", activeLan: "groq-asr", edited: true }, CONTENT);
    await env.settle();
    assert.deepEqual(env.backupDelays(), [], JSON.stringify(off));
    assert.deepEqual(env.state().pending, {});
    assert.equal(await bg.restoreSubtitleBackup("BVfar", 1, null), null);
    await bg.runDavSync("manual");
    await env.settle();
    assert.equal(server.subs().length, 0, JSON.stringify(off));
  }
});

test("上传失败进入待上传队列：定时同步在退避时间内不重试，手动「立即同步」补传", async () => {
  const env = loadBackground();
  const { bg, server } = env;
  let broken = true;
  server.faults.push((method, path) => (broken && method === "PUT" && path === "subs/BVfail-P1.json"
    ? { ok: false, status: 503, type: "basic", async json() { return {}; } }
    : null));
  await transcribe(env, "BVfail", 1, [line("第一次传失败")]);
  await env.fireTimers();
  let pending = env.state().pending["BVfail-P1"];
  assert.equal(pending.op, "put");
  assert.equal(pending.tries, 1);
  assert.match(pending.error, /503/);
  assert.equal(server.files.has("subs/BVfail-P1.json"), false);
  const logs = await bg.getAppLogs();
  assert.ok(logs.some((entry) => entry.level === "warn" && /字幕备份/.test(entry.message)));

  broken = false;
  // 改标记后的防抖同步：不碰字幕备份
  const before = server.subs().length;
  await bg.runDavSync("debounce");
  assert.equal(server.subs().length, before);
  // 定时同步：刚失败过、还在退避时间内的不重试，只拉索引
  await bg.runDavSync("dav-auto-sync");
  await env.settle();
  assert.equal(server.count("PUT", "subs/BVfail-P1.json"), 1, "只有第一次失败的那次");
  assert.equal(env.state().pending["BVfail-P1"].tries, 1);
  // 手动立即同步：补传
  await route(bg, { type: "DAV_SYNC_NOW", reason: "manual" });
  await env.settle();
  assert.ok(server.files.has("subs/BVfail-P1.json"));
  assert.equal(env.state().pending["BVfail-P1"], undefined);
  assert.ok(server.json("subs/index.json")["BVfail-P1"]);

  // 后台在防抖定时器触发前被回收（从没尝试过的）：下一次定时同步补上
  await transcribe(env, "BVlost", 1, [line("定时器丢了")]);
  env.longTimers.clear();
  env.run("subBackupTimers").clear(); // 后台重启后内存里的定时器都没了，队列还在 storage 里
  assert.equal(env.state().pending["BVlost-P1"].tries, 0);
  await bg.runDavSync("dav-auto-sync");
  await env.settle();
  assert.ok(server.files.has("subs/BVlost-P1.json"));

  // 失败过的视频再有变化：立刻按新变化重传，不用等手动同步
  broken = true;
  await route(bg, { type: "SAVE_CUES_CACHE", bvid: "BVfail", cid: 1, cues: [line("再改", 0, 1, { edited: true })], source: "groq", activeLan: "groq-asr", edited: true }, CONTENT);
  await env.settle();
  await env.fireTimers();
  pending = env.state().pending["BVfail-P1"];
  assert.equal(pending.tries, 1);
  broken = false;
  await route(bg, { type: "SAVE_CUES_CACHE", bvid: "BVfail", cid: 1, cues: [line("再改一次", 0, 1, { edited: true })], source: "groq", activeLan: "groq-asr", edited: true }, CONTENT);
  await env.settle();
  await env.fireTimers();
  assert.deepEqual(server.json("subs/BVfail-P1.json").cues.map((cue) => cue.content), ["再改一次"]);
  assert.equal(env.state().pending["BVfail-P1"], undefined);
});

test("定时同步重试失败项：按失败次数退避（上限约 1 天），每次最多处理几个，待删除的也重试", async () => {
  const env = loadBackground();
  const { bg, store, server } = env;
  const MIN = 60 * 1000;
  // 退避：失败越多间隔越长，封顶 1 天
  const delays = [1, 2, 3, 4, 20].map((tries) => bg.subRetryDelay(tries));
  assert.ok(delays[0] > 0 && delays[0] <= 15 * MIN, "第一次失败后下一两轮定时同步就重试");
  assert.ok(delays[1] > delays[0] && delays[2] > delays[1] && delays[3] > delays[2]);
  assert.equal(delays[4], 24 * 60 * MIN);

  // 断网时生成的 8 份转写都没传成
  let broken = true;
  server.faults.push((method, path) => (broken && path.startsWith("subs/")
    ? { ok: false, status: 503, type: "basic", async json() { return {}; } }
    : null));
  for (let i = 0; i < 8; i++) await transcribe(env, `BVnet${i}`, 1, [line(`断网 ${i}`)]);
  await env.fireTimers();
  const pending = () => env.state().pending;
  assert.equal(Object.keys(pending()).length, 8);
  assert.ok(Object.values(pending()).every((item) => item.tries === 1 && item.lastTry > 0));

  // 网络恢复，但还在退避时间内：定时同步不重试
  broken = false;
  await bg.runDavSync("dav-auto-sync");
  await env.settle();
  assert.equal(Object.keys(pending()).length, 8);
  assert.equal(server.files.has("subs/BVnet0-P1.json"), false);

  // 退避时间过了：定时同步自动重试，但一次最多处理几个，剩下的下一轮
  const past = (tries) => Date.now() - bg.subRetryDelay(tries) - 1000;
  for (const item of Object.values(store.davSubs.pending)) item.lastTry = past(1);
  const before = server.log.filter((item) => item.method === "PUT" && /subs\/BVnet\d-P1\.json/.test(item.path)).length;
  await bg.runDavSync("dav-auto-sync");
  await env.settle();
  const puts = () => server.log.filter((item) => item.method === "PUT" && /subs\/BVnet\d-P1\.json/.test(item.path)).length - before;
  const limit = env.run("SUB_AUTO_RETRY_MAX");
  assert.ok(limit >= 2 && limit <= 5);
  assert.equal(puts(), limit, "单次定时同步只重试少量几个");
  assert.equal(Object.keys(pending()).length, 8 - limit);
  await bg.runDavSync("dav-auto-sync");
  await env.settle();
  assert.equal(Object.keys(pending()).length, Math.max(0, 8 - 2 * limit));

  // 失败多次的：间隔更长，没到时间不重试
  store.davSubs.pending = {};
  broken = true;
  await transcribe(env, "BVmany", 1, [line("失败好几次")]);
  await env.fireTimers();
  broken = false;
  store.davSubs.pending["BVmany-P1"].tries = 3;
  store.davSubs.pending["BVmany-P1"].lastTry = past(2);
  await bg.runDavSync("dav-auto-sync");
  await env.settle();
  assert.equal(store.davSubs.pending["BVmany-P1"].tries, 3, "失败 3 次后按更长的间隔等");
  store.davSubs.pending["BVmany-P1"].lastTry = past(3);
  await bg.runDavSync("dav-auto-sync");
  await env.settle();
  assert.equal(store.davSubs.pending["BVmany-P1"], undefined);
  assert.ok(server.files.has("subs/BVmany-P1.json"));

  // 删除远端备份失败：同样退避后自动重试
  broken = true;
  await route(bg, { type: "CLEAR_VIDEO_CACHE", bvid: "BVmany", cid: 1, deleteRemote: true });
  await env.settle();
  assert.equal(store.davSubs.pending["BVmany-P1"].op, "delete");
  assert.equal(store.davSubs.pending["BVmany-P1"].tries, 1);
  broken = false;
  store.davSubs.pending["BVmany-P1"].lastTry = past(1);
  await bg.runDavSync("dav-auto-sync");
  await env.settle();
  assert.equal(server.files.has("subs/BVmany-P1.json"), false);
  assert.equal(server.json("subs/index.json")["BVmany-P1"].deleted, true);
  assert.equal(store.davSubs.pending["BVmany-P1"], undefined);
});

test("备份文件和索引里不含 API Key、字幕轨签名地址等无关字段", async () => {
  const env = loadBackground({ syncKeys: true });
  const { bg, store, server } = env;
  store["asr:BVsecret:1"] = {
    cues: [line("Hi", 0, 1, { edited: true, token: "cue-level-secret", words: [{ w: "Hi" }] })],
    source: "bilibili",
    activeLan: "ai-en",
    origin: "official",
    editedAt: 9,
    savedAt: 1,
    apiKey: "sk-should-not-leak",
    pic: "https://i0.hdslb.com/cover.jpg",
    tracks: [{ lan: "ai-en", url: "https://aisubtitle.hdslb.com/bfs/ai_subtitle/x.json?auth_key=1700000000-abc-0-deadbeef" }]
  };
  await bg.queueSubtitleBackup("BVsecret", 1, "edit");
  await env.fireTimers();
  const text = server.files.get("subs/BVsecret-P1.json") + server.files.get("subs/index.json");
  for (const secret of ["sk-secret-sum-key", "gsk_secret_stt_key", "sk-should-not-leak", "auth_key", "aisubtitle", "tracks", "cue-level-secret", "words", "davPass", "pw\""]) {
    assert.equal(text.includes(secret), false, secret);
  }
  const doc = server.json("subs/BVsecret-P1.json");
  assert.deepEqual(Object.keys(doc.cues[0]).sort(), ["content", "edited", "from", "to"]);
});

test("开同步前就有的转写：打开视频时排一次补传；asr: 和同步记录的变化不触发整轮同步，开关本身会", async () => {
  const env = loadBackground();
  const { bg, store, server } = env;
  await bg.runDavSync("manual");
  store["asr:BVold:1"] = { cues: [line("早就转写好的")], source: "groq", activeLan: "groq-asr", origin: "asr", savedAt: 5 };
  bg.fetchView = async () => ({ bvid: "BVold", aid: 1, cid: 1, title: "t", duration: 10, pages: [{ cid: 1 }], owner: {} });
  bg.loadBiliLogin = async () => ({ isLogin: true });
  const state = await bg.loadSubtitles({ kind: "video", bvid: "BVold", p: 1 }, 1);
  assert.equal(state.cues[0].content, "早就转写好的");
  await env.settle();
  assert.deepEqual(env.backupDelays(), [15000], "不在打开视频时发请求，稍后补传");
  assert.equal(server.count("PUT", "subs/BVold-P1.json"), 0);
  await env.fireTimers();
  assert.equal(server.count("PUT", "subs/BVold-P1.json"), 1);

  // 另一台电脑在本机拉索引之后删掉了这个视频的备份（墓碑）：补传时听删除的，不把旧字幕传回去
  store["asr:BVgone:1"] = { cues: [line("旧转写")], source: "groq", activeLan: "groq-asr", origin: "asr", savedAt: 6 };
  await bg.restoreSubtitleBackup("BVgone", 1, store["asr:BVgone:1"]);
  await env.settle();
  assert.equal(env.state().pending["BVgone-P1"].reason, "backfill");
  const index = server.json("subs/index.json");
  index["BVgone-P1"] = { bvid: "BVgone", cid: 1, deleted: true, updatedAt: Date.now() };
  server.files.set("subs/index.json", JSON.stringify(index));
  await env.fireTimers();
  assert.equal(server.count("PUT", "subs/BVgone-P1.json"), 0);
  assert.equal(env.state().pending["BVgone-P1"], undefined);
  assert.equal(env.state().index["BVgone-P1"].deleted, true);

  const Dav = bg.BiliCaptionDav;
  const change = (key) => ({ [key]: { newValue: 1 } });
  assert.equal(Dav.shouldSyncOnChange(change("asr:BVold:1"), "local"), false);
  assert.equal(Dav.shouldSyncOnChange(change("davSubs"), "local"), false);
  assert.equal(Dav.shouldSyncOnChange(change("syncSubs"), "sync"), true);
});

test("运行日志：WebDAV 同步没有任何变化时不写日志；有变化时只写一条摘要，字幕备份并进这一条", async () => {
  const env = loadBackground();
  const { bg } = env;
  const davLogs = async () => (await bg.getAppLogs()).filter((entry) => entry.scope === "dav");
  // 第一次同步（建目录、拉索引等）之后，再同步一次就什么都没变
  await bg.runDavSync("manual");
  await env.settle();
  await bg.clearAppLogs();
  await bg.runDavSync("dav-auto-sync");
  await bg.runDavSync("manual");
  await env.settle();
  assert.deepEqual(Array.from(await davLogs(), (entry) => entry.message), [], "没有上传、下载、删除、冲突时不写「同步完成」");

  // 有一个待上传的转写：随手动同步传上去，只写一条同步摘要，不再另写「字幕备份：…」
  await transcribe(env, "BVlog", 1, [line("要备份的一句")]);
  await bg.clearAppLogs();
  await bg.runDavSync("manual");
  await env.settle();
  const logs = await davLogs();
  assert.equal(logs.length, 1, Array.from(logs, (entry) => entry.message).join(" | "));
  assert.equal(logs[0].level, "info");
  assert.equal(logs[0].message, "同步完成（manual）：字幕备份 上传 1");
  assert.ok(env.server.files.has("subs/BVlog-P1.json"));

  // 不随整轮同步、单独按防抖上传时仍写自己的一条；全是 0 的项不出现
  await bg.clearAppLogs();
  await route(bg, { type: "SAVE_CUES_CACHE", bvid: "BVlog", cid: 1, cues: [line("改过的一句", 0, 1, { edited: true })], source: "groq", activeLan: "groq-asr", edited: true }, CONTENT);
  await env.settle();
  await env.fireTimers();
  assert.deepEqual(Array.from(await davLogs(), (entry) => entry.message), ["字幕备份：上传 1 个"]);

  // 摘要按类别列出非 0 的项；全是 0（含字幕备份被跳过、出错）时为空，不写日志
  const zero = { pushed: 0, pulled: 0, conflicts: 0 };
  assert.equal(bg.davSyncChanges({ marks: zero, trash: zero, config: { pushed: 0, pulled: 0 }, subs: { skipped: true } }), "");
  assert.equal(bg.davSyncChanges({ marks: zero, trash: zero, config: zero, subs: { error: "503" } }), "");
  assert.equal(
    bg.davSyncChanges({ marks: { pushed: 2, pulled: 1, conflicts: 0 }, trash: zero, config: { pushed: 0, pulled: 1 }, subs: { pushed: 0, deleted: 3, conflicts: 1 } }),
    "标记 上传 2、下载 1；设置 下载 1；字幕备份 删除 3、冲突副本 1"
  );
});
