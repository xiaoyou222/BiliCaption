const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { backgroundSource, loadBackgroundScripts } = require("./源码加载.js");

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

function loadBackground(fetchImpl, external = {}) {
  // external.store 可在两个后台实例间共享，模拟 service worker 重启后 session 里还留着的数据
  const store = external.store || {};
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
        onMessage: { addListener(fn) { context.__onMessage = fn; } },
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
      scripting: { async executeScript(args) { return external.executeScript ? external.executeScript(args) : [{result: await external.readPage?.(...args.args)}]; } },
      tabs: {
        async get() { return { url: external.url }; },
        query(_query, callback) {
          if (callback) callback([]);
          return Promise.resolve([]);
        },
        async sendMessage() {}
      },
      declarativeNetRequest: { async updateDynamicRules() {} },
      storage: { local: storageArea(store), session: storageArea(store) }
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
  loadBackgroundScripts(context, ["lib/视频平台.js", "lib/字幕工具.js", "lib/zh-simp.js", "lib/translate.js", "lib/模型路由.js", "lib/webdav.js"]);
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
  // fetch 设不了 Referer（禁用请求头），不再假装设置
  assert.equal(dm.options.headers.Referer, undefined);
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
  assert.equal(B.__store[`asr:${PAGE.bvid}:${cid}`].source, "bilibili");
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

test('YouTube 字幕经后台进入统一字幕状态且不调用 B 站接口', async () => {
  const bg=loadBackground(() => { throw Error('不应请求 B 站'); }, {
    url:'https://www.youtube.com/watch?v=aircAruvnKk',
    readPage: async (_page, url) => url ? {raw:JSON.stringify({events:[{tStartMs:0,dDurationMs:1200,segs:[{utf8:'Hello'}]}]})} : {title:'视频',tracks:[{lan:'en',url:'https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=en'}]}
  });
  const page=bg.BiliCaptionPlatforms.parse('https://www.youtube.com/watch?v=aircAruvnKk');
  const data=await bg.loadSubtitles(page,1);
  assert.equal(data.bvid,'yt_aircAruvnKk');
  assert.equal(data.cues[0].content,'Hello');
  assert.equal(data.canGenerate,false);
  assert.equal(data.source,'youtube');
  await bg.saveCachedAsr(data.bvid,1,{cues:[{from:0,to:1.2,content:'你好',original:'Hello'}],activeLan:'translated',source:'translated'});
  const cached=await bg.loadSubtitles(page,1);
  assert.equal(cached.cues[0].content,'你好');
  assert.equal(cached.source,'translated');
});

test('YouTube 播放器未就绪时返回 pending，不把 B 站文案写进侧栏状态', async () => {
  const bg=loadBackground(() => { throw Error('不应请求 B 站'); }, {
    url:'https://www.youtube.com/watch?v=aircAruvnKk',
    readPage: async () => { throw new Error('视频信息尚未就绪，请稍后刷新字幕'); }
  });
  const data=await bg.loadSubtitles(bg.BiliCaptionPlatforms.parse('https://www.youtube.com/watch?v=aircAruvnKk'),1);
  assert.equal(data.subtitleStatus,'pending');
  assert.equal(data.platform,'youtube');
  assert.equal(data.login.platform,'youtube');
  assert.equal(data.error,'');
  assert.equal(data.canGenerate,false);
  assert.match(data.notice,/尚未就绪/);
  assert.doesNotMatch(`${data.error}${data.notice}${data.login.platform}` , /B 站|哔哩哔哩|BiliCaption/);
});

test('YouTube 广告未结束时同样 pending，就绪后能读到字幕', async () => {
  let ready = false;
  const url='https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=en';
  const bg=loadBackground(() => { throw Error('不应请求 B 站'); }, {
    url:'https://www.youtube.com/watch?v=aircAruvnKk',
    readPage: async (_page, track) => {
      if (!ready) throw new Error('广告播放中，请在正片开始后刷新字幕');
      if (track) return {raw:JSON.stringify({events:[{tStartMs:0,dDurationMs:1000,segs:[{utf8:'Hi'}]}]})};
      return {title:'Ready',tracks:[{lan:'en',url}]};
    }
  });
  const page=bg.BiliCaptionPlatforms.parse('https://www.youtube.com/watch?v=aircAruvnKk');
  const pending=await bg.loadSubtitles(page,1);
  assert.equal(pending.subtitleStatus,'pending');
  assert.match(pending.notice,/广告/);
  ready = true;
  const data=await bg.loadSubtitles(page,1);
  assert.equal(data.cues[0].content,'Hi');
  assert.equal(data.subtitleStatus,'');
});

test('跨标签页或伪造平台编号不能读取字幕', async () => {
  const bg=loadBackground(()=>{}, {url:'https://www.youtube.com/watch?v=aircAruvnKk'});
  await assert.rejects(bg.loadSubtitles({kind:'youtube',videoId:'different00',bvid:'yt_different00'},1),/已切换/);
  await assert.rejects(bg.loadSubtitles({kind:'youtube',videoId:'aircAruvnKk',bvid:'BVfake'},1),/编号无效/);
  await assert.rejects(bg.resolveVideoMeta({bvid:'yt_aircAruvnKk'}),/暂不支持/);
});

test('executeScript 空结果仍按尚未就绪 pending，方便广告结束后再拉', async () => {
  const bg=loadBackground(() => { throw Error('不应请求 B 站'); }, {
    url:'https://www.youtube.com/watch?v=aircAruvnKk',
    executeScript: async () => [{}]
  });
  const data=await bg.loadSubtitles(bg.BiliCaptionPlatforms.parse('https://www.youtube.com/watch?v=aircAruvnKk'),1);
  assert.equal(data.subtitleStatus,'pending');
  assert.match(data.notice,/尚未就绪/);
});

test('executeScript 注入错误原样抛出，不伪装成无限 pending', async () => {
  const bg=loadBackground(() => { throw Error('不应请求 B 站'); }, {
    url:'https://www.youtube.com/watch?v=aircAruvnKk',
    executeScript: async () => [{ error: { message: '字幕请求失败（403）' } }]
  });
  await assert.rejects(bg.loadSubtitles(bg.BiliCaptionPlatforms.parse('https://www.youtube.com/watch?v=aircAruvnKk'),1), /403/);
});

test('读取字幕轨也会等待播放器就绪，空结果才当成尚未就绪', async () => {
  const args=[];
  const url='https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=en';
  const bg=loadBackground(() => { throw Error('不应请求 B 站'); }, {
    url:'https://www.youtube.com/watch?v=aircAruvnKk',
    executeScript: async (call) => {
      args.push(call.args);
      const [, trackUrl] = call.args;
      if (trackUrl) return [{ result: { raw: JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Hi' }] }] }) } }];
      return [{ result: { title: 'Ready', tracks: [{ lan: 'en', url }] } }];
    }
  });
  const data=await bg.loadSubtitles(bg.BiliCaptionPlatforms.parse('https://www.youtube.com/watch?v=aircAruvnKk'),1);
  assert.equal(data.cues[0].content,'Hi');
  assert.equal(args.length,2);
  assert.equal(args[0][3],2500);
  assert.equal(args[1][3],2500);
});

test('首选中文轨为空时改试英文轨，不把空 body 当成无限 pending', async () => {
  const zh='https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=zh';
  const en='https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=en';
  const bg=loadBackground(() => { throw Error('不应请求 B 站'); }, {
    url:'https://www.youtube.com/watch?v=aircAruvnKk',
    readPage: async (_page, track) => {
      if (!track) return {title:'Ready',tracks:[{lan:'zh',url:zh},{lan:'en',url:en}]};
      if (track === zh) return { error: 'YouTube 未返回字幕内容，请开启播放器字幕后重试' };
      return {raw:JSON.stringify({events:[{tStartMs:0,dDurationMs:1000,segs:[{utf8:'Hello'}]}] })};
    }
  });
  const data=await bg.loadSubtitles(bg.BiliCaptionPlatforms.parse('https://www.youtube.com/watch?v=aircAruvnKk'),1);
  assert.equal(data.cues[0].content,'Hello');
  assert.equal(data.subtitleStatus,'');
  assert.ok(['en','zh-Hans'].includes(data.activeLan));
});

test('字幕轨失效后改试下一轨，不立刻甩刷新', async () => {
  const stale='https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=zh&signature=gone';
  const en='https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=en';
  const bg=loadBackground(() => { throw Error('不应请求 B 站'); }, {
    url:'https://www.youtube.com/watch?v=aircAruvnKk',
    readPage: async (_page, track) => {
      if (!track) return {title:'Ready',tracks:[{lan:'zh',url:stale},{lan:'en',url:en}]};
      if (track !== en) return { error: '字幕轨已失效，请刷新后重试' };
      return {raw:JSON.stringify({events:[{tStartMs:0,dDurationMs:1000,segs:[{utf8:'Hello'}]}] })};
    }
  });
  const data=await bg.loadSubtitles(bg.BiliCaptionPlatforms.parse('https://www.youtube.com/watch?v=aircAruvnKk'),1);
  assert.equal(data.cues[0].content,'Hello');
  assert.equal(data.subtitleStatus,'');
});

test('全部字幕轨都是空 body 时为 fetch_failed，不再 pending', async () => {
  const url='https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=en';
  const bg=loadBackground(() => { throw Error('不应请求 B 站'); }, {
    url:'https://www.youtube.com/watch?v=aircAruvnKk',
    readPage: async (_page, track) => track
      ? { error: 'YouTube 未返回字幕内容，请开启播放器字幕后重试' }
      : {title:'Ready',tracks:[{lan:'en',url}]}
  });
  const data=await bg.loadSubtitles(bg.BiliCaptionPlatforms.parse('https://www.youtube.com/watch?v=aircAruvnKk'),1);
  assert.equal(data.subtitleStatus,'fetch_failed');
  assert.match(data.error,/未返回字幕内容|开启播放器字幕/);
  assert.equal(data.canGenerate,false);
});

test('readPage 返回 pending 对象时才继续等待，error 对象不当 pending', async () => {
  const pending=loadBackground(() => { throw Error('不应请求 B 站'); }, {
    url:'https://www.youtube.com/watch?v=aircAruvnKk',
    executeScript: async () => [{ result: { pending: true, notice: '广告播放中，请在正片开始后刷新字幕' } }]
  });
  const waiting=await pending.loadSubtitles(pending.BiliCaptionPlatforms.parse('https://www.youtube.com/watch?v=aircAruvnKk'),1);
  assert.equal(waiting.subtitleStatus,'pending');
  assert.match(waiting.notice,/广告/);
  const failed=loadBackground(() => { throw Error('不应请求 B 站'); }, {
    url:'https://www.youtube.com/watch?v=aircAruvnKk',
    executeScript: async () => [{ result: { error: '无法读取该视频' } }]
  });
  await assert.rejects(failed.loadSubtitles(failed.BiliCaptionPlatforms.parse('https://www.youtube.com/watch?v=aircAruvnKk'),1), /无法读取/);
});

test('YouTube 空响应不会伪装成成功或触发收费转写', async () => {
  const bg=loadBackground(()=>{}, {url:'https://www.youtube.com/watch?v=aircAruvnKk',readPage:async(_page,url)=>url?{raw:''}:{tracks:[{lan:'en',url:'https://www.youtube.com/api/timedtext?v=aircAruvnKk'}]}});
  const data=await bg.loadSubtitles(bg.BiliCaptionPlatforms.parse('https://www.youtube.com/watch?v=aircAruvnKk'),1);
  assert.equal(data.subtitleStatus,'fetch_failed');
  assert.equal(data.canGenerate,false);
  assert.equal(data.cues.length,0);
  assert.ok(data.error);
});

test('X HLS 拉取全部字幕分片，重复边界只保留一次', async () => {
  const urls=[];
  const bg=loadBackground(async url=>{
    urls.push(url);
    const text=url.endsWith('.m3u8')?'#EXTM3U\n#EXTINF:3,\na.vtt\n#EXTINF:3,\nb.vtt\n#EXT-X-ENDLIST':url.endsWith('a.vtt')?'WEBVTT\n\n00:00.000 --> 00:01.000\n第一句\n':'WEBVTT\n\n00:00.000 --> 00:01.000\n第一句\n\n00:04.000 --> 00:05.000\n最后一句\n';
    return {ok:true,text:async()=>text};
  });
  const tracks=bg.xManifestTracks('#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,NAME="English, auto",LANGUAGE="en",URI="/subtitles/list.m3u8"','https://video.twimg.com/a.m3u8');
  const cues=await bg.fetchXTrackCues(tracks[0]);
  assert.equal(tracks[0].lanDoc,'English, auto');
  assert.equal(cues.length,2);
  assert.equal(cues[1].to,5);
  assert.equal(urls.length,3);
});

test('X 字幕拒绝直播与跨域分片', async () => {
  const bg=loadBackground(async()=>({ok:true,text:async()=>'#EXTM3U\nhttps://evil.test/a.vtt\n#EXT-X-ENDLIST'}));
  await assert.rejects(bg.fetchXTrackCues({hls:true,url:'https://video.twimg.com/a.m3u8'}),/允许的域名/);
  const live=loadBackground(async()=>({ok:true,text:async()=>'#EXTM3U\n/a.vtt'}));
  await assert.rejects(live.fetchXTrackCues({hls:true,url:'https://video.twimg.com/a.m3u8'}),/直播/);
});

// 显式开启才请求真实服务；日常回归不依赖外网和第三方样例存续。
if (process.env.BILICAPTION_LIVE_X === '1') test('实网：Cursor 示例的 X 完整字幕进入统一状态', async () => {
  const pageUrl='https://x.com/cursor_ai/status/2098162488013455784';
  const bg=loadBackground(fetch, {url:pageUrl,readPage:async()=>({
    mediaId:'2098151257902809092', title:'Cursor Projects', duration:94.015999,
    tracks:[{lan:'en',url:'data:,WEBVTT',embedded:true}]
  })});
  vm.runInContext('xManifestUrls.set("xManifest:1:2098151257902809092", "https://video.twimg.com/amplify_video/2098151257902809092/pl/1dTuFeOV1h2N4tv7.m3u8?tag=29&v=26e")', bg);
  const data=await bg.loadSubtitles(bg.BiliCaptionPlatforms.parse(pageUrl),1);
  assert.equal(data.error,'');
  assert.equal(data.source,'x');
  assert.ok(data.cues.length>20);
  assert.ok(data.cues.at(-1).to>90 && data.cues.at(-1).to<95);
  assert.ok(data.cues.every(c=>!c.content.includes('<X-word-ms')));
  console.log(`X 实网字幕：${data.cues.length} 条，${data.cues[0].from}–${data.cues.at(-1).to} 秒`);
});

test('YouTube 默认选自动翻译中文，按目标语言隔离捕获地址', async () => {
  const base='https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=en&kind=asr';
  const calls=[];
  const bg=loadBackground(()=>{throw Error('不应调用模型或B站');},{url:'https://www.youtube.com/watch?v=aircAruvnKk',readPage:async(_page,url,loaded)=>{
    if (!url) return {tracks:[{lan:'en-auto',url:base},{lan:'zh-Hans',lanDoc:'中文（YouTube 自动翻译）',url:base+'&tlang=zh-Hans'}]};
    calls.push({url,loaded});
    return {raw:JSON.stringify({events:[{tStartMs:0,dDurationMs:1000,segs:[{utf8:url.includes('tlang=')?'中文':'English'}]}]})};
  }});
  vm.runInContext(`youtubeCueUrls.set('ytCue:1:aircAruvnKk:en:asr:zh-Hans', ${JSON.stringify(base+'&tlang=zh-Hans&pot=zh')}); youtubeCueUrls.set('ytCue:1:aircAruvnKk:en:asr:', ${JSON.stringify(base+'&pot=en')})`,bg);
  const page=bg.BiliCaptionPlatforms.parse('https://www.youtube.com/watch?v=aircAruvnKk');
  const data=await bg.loadSubtitles(page,1);
  assert.equal(data.activeLan,'zh-Hans');
  assert.equal(data.cues[0].content,'中文');
  assert.ok(calls[0].loaded.endsWith('pot=zh'));
  await bg.fetchPlatformTrack({page,url:base},1);
  assert.ok(calls[1].loaded.endsWith('pot=en'));
});

test('官方字幕写入同一套 asr 缓存：YouTube 第二次 load 不打 timedtext', async () => {
  const url='https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=en';
  const calls=[];
  const bg=loadBackground(()=>{throw Error('不应请求 B 站');},{
    url:'https://www.youtube.com/watch?v=aircAruvnKk',
    readPage: async (_page, track) => {
      calls.push(track || 'page');
      if (!track) return {title:'视频',tracks:[{lan:'en',url}]};
      return {raw:JSON.stringify({events:[{tStartMs:0,dDurationMs:1200,segs:[{utf8:'Hello'}]}] })};
    }
  });
  const page=bg.BiliCaptionPlatforms.parse('https://www.youtube.com/watch?v=aircAruvnKk');
  const first=await bg.loadSubtitles(page,1);
  assert.equal(first.source,'youtube');
  assert.equal(first.cues[0].content,'Hello');
  assert.equal(bg.__store[`asr:${page.bvid}:1`].source,'youtube');
  const timedtext=()=>calls.filter((item)=>item!=='page');
  assert.ok(timedtext().length>=1);
  const afterFirst=calls.length;
  const second=await bg.loadSubtitles(page,1);
  assert.equal(second.source,'youtube');
  assert.equal(second.cues[0].content,'Hello');
  assert.equal(calls.length,afterFirst);
  const forced=await bg.loadSubtitles(page,1,{force:true});
  assert.equal(forced.cues[0].content,'Hello');
  assert.ok(calls.length>afterFirst);
  assert.ok(timedtext().length>=2);
});

test('B 站官方字幕同样写入 asr 缓存，第二次不打字幕 JSON', async () => {
  const {calls, fetchImpl}=biliFetch({playerSubs:[aiZhTrack()]});
  const B=loadBackground(fetchImpl);
  const cueCalls=()=>calls.filter((item)=>item.url.includes('hdslb.com') || /\/bfs\/subtitle\//.test(item.url));
  const first=await B.loadSubtitles(PAGE);
  assert.equal(first.source,'bilibili');
  assert.equal(first.cues[0].content,'官方字幕');
  assert.equal(B.__store[`asr:${PAGE.bvid}:222`].source,'bilibili');
  const firstCues=cueCalls().length;
  assert.ok(firstCues>=1);
  const second=await B.loadSubtitles(PAGE);
  assert.equal(second.source,'bilibili');
  assert.equal(second.cues[0].content,'官方字幕');
  assert.equal(cueCalls().length,firstCues);
  assert.ok(calls.some((item)=>item.url.includes('/x/player/wbi/v2') || item.url.includes('/x/web-interface/view')));
  const forced=await B.loadSubtitles(PAGE,undefined,{force:true});
  assert.equal(forced.source,'bilibili');
  assert.ok(cueCalls().length>firstCues);
});

test('429、pending、空结果都不写入官方字幕缓存', async () => {
  const url='https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=en';
  const limited=loadBackground(()=>{throw Error('不应请求 B 站');},{
    url:'https://www.youtube.com/watch?v=aircAruvnKk',
    readPage: async (_page, track) => track
      ? { error: '字幕请求失败（429）' }
      : {title:'Ready',tracks:[{lan:'en',url}]}
  });
  const page=limited.BiliCaptionPlatforms.parse('https://www.youtube.com/watch?v=aircAruvnKk');
  const failed=await limited.loadSubtitles(page,1);
  assert.equal(failed.subtitleStatus,'fetch_failed');
  assert.match(failed.error,/限流/);
  assert.equal(failed.cues.length,0);
  assert.equal(limited.__store[`asr:${page.bvid}:1`],undefined);
  const pending=loadBackground(()=>{throw Error('不应请求 B 站');},{
    url:'https://www.youtube.com/watch?v=aircAruvnKk',
    readPage: async () => { throw new Error('视频信息尚未就绪，请稍后刷新字幕'); }
  });
  const waiting=await pending.loadSubtitles(page,1);
  assert.equal(waiting.subtitleStatus,'pending');
  assert.equal(pending.__store[`asr:${page.bvid}:1`],undefined);
  const empty=loadBackground(()=>{throw Error('不应请求 B 站');},{
    url:'https://www.youtube.com/watch?v=aircAruvnKk',
    readPage: async (_page, track) => track ? {raw:''} : {tracks:[{lan:'en',url}]}
  });
  const blank=await empty.loadSubtitles(page,1);
  assert.equal(blank.cues.length,0);
  assert.equal(empty.__store[`asr:${page.bvid}:1`],undefined);
});

test('X 官方字幕也写入同一套 asr 缓存，第二次不拉字幕文件', async () => {
  let cueFetches=0;
  const pageUrl='https://x.com/i/web/status/1234567890123456789';
  const bg=loadBackground(async (href)=>{
    if (String(href).includes('.vtt')) {
      cueFetches++;
      return {ok:true,text:async()=>'WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n'};
    }
    throw new Error(`unexpected fetch ${href}`);
  },{
    url:pageUrl,
    readPage: async () => ({
      title:'X 视频',
      duration:10,
      tracks:[{lan:'en',url:'https://video.twimg.com/a.vtt',embedded:true}]
    })
  });
  const page=bg.BiliCaptionPlatforms.parse(pageUrl);
  const first=await bg.loadSubtitles(page,1);
  assert.equal(first.source,'x');
  assert.equal(first.cues[0].content,'Hello');
  assert.equal(bg.__store[`asr:${page.bvid}:1`].source,'x');
  assert.equal(cueFetches,1);
  const second=await bg.loadSubtitles(page,1);
  assert.equal(second.cues[0].content,'Hello');
  assert.equal(cueFetches,1);
});

test('YouTube 429 只打一条轨，随后自动再 load 不打 timedtext，force 才再打', async () => {
  const en='https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=en';
  const zh='https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=zh';
  let tracksTried=0;
  let pagesTried=0;
  const bg=loadBackground(()=>{throw Error('不应请求 B 站');},{
    url:'https://www.youtube.com/watch?v=aircAruvnKk',
    readPage: async (_page, track) => {
      if (!track) {
        pagesTried++;
        return {title:'Ready',tracks:[{lan:'en',url:en},{lan:'zh',url:zh}]};
      }
      tracksTried++;
      return { error: '字幕请求失败（429）' };
    }
  });
  const page=bg.BiliCaptionPlatforms.parse('https://www.youtube.com/watch?v=aircAruvnKk');
  const failed=await bg.loadSubtitles(page,1);
  assert.equal(failed.subtitleStatus,'fetch_failed');
  assert.match(failed.error,/限流/);
  assert.equal(tracksTried,1);
  assert.equal(pagesTried,1);
  assert.equal(bg.__store[`asr:${page.bvid}:1`],undefined);
  const blocked=await bg.loadSubtitles(page,1);
  assert.equal(blocked.subtitleStatus,'fetch_failed');
  assert.match(blocked.error,/限流/);
  assert.equal(tracksTried,1);
  assert.equal(pagesTried,1);
  const forced=await bg.loadSubtitles(page,1,{force:true});
  assert.equal(forced.subtitleStatus,'fetch_failed');
  assert.equal(tracksTried,2);
  assert.equal(pagesTried,2);
});

test('X 缺标题的字幕缓存补短标题，不重拉字幕', async () => {
  const long = `${'字'.repeat(60)}。后面这段只留在悬停。`;
  let pages = 0;
  let tracks = 0;
  const bg = loadBackground(() => { throw Error('不应请求 B 站'); }, {
    url: 'https://x.com/a/status/2101666434757570841',
    readPage: async (_page, track) => {
      if (track) { tracks++; return { raw: '' }; }
      pages++;
      return { title: long, up: '小由', tracks: [] };
    }
  });
  const page = bg.BiliCaptionPlatforms.parse('https://x.com/a/status/2101666434757570841');
  bg.__store[`asr:${page.bvid}:1`] = {
    cues: [{ from: 0, to: 1, content: '你好', sid: 1 }],
    source: 'x',
    activeLan: 'zh',
    partial: false
  };
  const data = await bg.loadSubtitles(page, 1);
  assert.equal(data.cues[0].content, '你好');
  assert.equal(pages, 1);
  assert.equal(tracks, 0);
  assert.equal(Array.from(data.title).length, 41);
  assert.match(data.title, /^字+…$/);
  assert.match(data.titleFull, /悬停/);
  assert.ok(Array.from(data.titleFull).length <= 200);
  assert.equal(bg.__store[`asr:${page.bvid}:1`].title, data.title);
  const again = await bg.loadSubtitles(page, 1);
  assert.equal(again.title, data.title);
  assert.equal(pages, 1);
});

test('YouTube 官方缓存命中时不 executeScript、不打 timedtext，并带回标题', async () => {
  let pages=0;
  let tracks=0;
  const bg=loadBackground(()=>{throw Error('不应请求 B 站');},{
    url:'https://www.youtube.com/watch?v=aircAruvnKk',
    executeScript: async (call) => {
      const [, trackUrl] = call.args;
      if (trackUrl) {
        tracks++;
        throw new Error('缓存命中不应读 timedtext');
      }
      pages++;
      throw new Error('缓存命中不应 executeScript');
    }
  });
  const page=bg.BiliCaptionPlatforms.parse('https://www.youtube.com/watch?v=aircAruvnKk');
  await bg.saveCachedAsr(page.bvid,1,{
    cues:[{from:0,to:1.2,content:'Hello',sid:1}],
    activeLan:'en',
    source:'youtube',
    title:'Cached Title',
    up:'Cached Up',
    pic:'https://i.ytimg.com/x.jpg',
    durationMeta:88,
    tracks:[{lan:'en',url:'https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=en'}]
  });
  const data=await bg.loadSubtitles(page,1);
  assert.equal(data.title,'Cached Title');
  assert.equal(data.up,'Cached Up');
  assert.equal(data.pic,'https://i.ytimg.com/x.jpg');
  assert.equal(data.cues[0].content,'Hello');
  assert.equal(data.subtitleStatus,'');
  assert.equal(pages,0);
  assert.equal(tracks,0);
  const again=await bg.loadSubtitles(page,1);
  assert.equal(again.title,'Cached Title');
  assert.equal(pages,0);
  assert.equal(tracks,0);
});

test('X 无官方字幕时允许转写，YouTube 仍禁止', async () => {
  const pageUrl='https://x.com/i/web/status/1234567890123456789';
  const x=loadBackground(()=>{throw Error('不应请求 B 站');},{
    url:pageUrl,
    readPage: async () => ({ title:'X 视频', duration:10, tracks:[] })
  });
  const xData=await x.loadSubtitles(x.BiliCaptionPlatforms.parse(pageUrl),1);
  assert.equal(xData.canGenerate,true);
  assert.match(xData.notice,/生成|转写/);
  const pending=loadBackground(()=>{throw Error('不应请求 B 站');},{
    url:pageUrl,
    readPage: async () => { throw new Error('请先播放本帖视频，再刷新字幕'); }
  });
  const waiting=await pending.loadSubtitles(pending.BiliCaptionPlatforms.parse(pageUrl),1);
  assert.equal(waiting.subtitleStatus,'pending');
  assert.equal(waiting.canGenerate,true);
  assert.match(waiting.notice,/请先播放/);
});

test('X 点播独立 AAC 清单解析成功，无 AUDIO / 直播 / MPEG-TS 明确失败', async () => {
  const masterUrl='https://video.twimg.com/amplify_video/2098151257902809092/pl/master.m3u8';
  const audioUrl='https://video.twimg.com/amplify_video/2098151257902809092/pl/audio.m3u8';
  const master='#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="audio"\nhttps://video.twimg.com/amplify_video/2098151257902809092/pl/vid.m3u8\n';
  const audioPl='#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:5.0,\nhttps://video.twimg.com/amplify_video/2098151257902809092/pl/seg0.m4s\n#EXTINF:5.0,\nhttps://video.twimg.com/amplify_video/2098151257902809092/pl/seg1.m4s\n#EXT-X-ENDLIST\n';
  const bg=loadBackground(async (href)=>{
    if (String(href)===masterUrl) return {ok:true,text:async()=>master};
    if (String(href)===audioUrl) return {ok:true,text:async()=>audioPl};
    throw new Error(`unexpected fetch ${href}`);
  },{
    url:'https://x.com/i/web/status/1234567890123456789',
    readPage: async () => ({ mediaId:'2098151257902809092', duration:12, title:'X 视频', tracks:[] })
  });
  vm.runInContext(`xManifestUrls.set("xManifest:1:2098151257902809092", ${JSON.stringify(masterUrl)})`, bg);
  const audioTracks=bg.xManifestAudioTracks(master, masterUrl);
  assert.equal(audioTracks.length,1);
  assert.equal(bg.pickXAudioTrack(audioTracks).url, audioUrl);
  assert.throws(()=>bg.pickXAudioTrack([]), /独立音轨/);
  assert.throws(()=>bg.parseXAudioPlaylist('#EXTM3U\n#EXTINF:5.0,\nhttps://video.twimg.com/ext_tw_video/1/pl/seg0.m4s\n', 'https://video.twimg.com/ext_tw_video/1/pl/audio.m3u8'), /直播|Spaces/);
  assert.throws(()=>bg.parseXAudioPlaylist('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:5.0,\nhttps://video.twimg.com/amplify_video/1/pl/seg.ts\n#EXT-X-ENDLIST\n', 'https://video.twimg.com/amplify_video/1/pl/audio.m3u8'), /MPEG-TS/);
  const parsed=bg.parseXAudioPlaylist(audioPl, audioUrl);
  assert.match(parsed.mapUrl,/init\.mp4/);
  assert.equal(parsed.segmentUrls.length,2);
  const playurl=await bg.fetchXPlayurl({ bvid:'x_1234567890123456789_1', tabId:1, duration:12 });
  assert.equal(playurl.xAudio.kind,'x-hls');
  assert.equal(playurl.xAudio.audioUrl, audioUrl);
  assert.equal(playurl.xAudio.mediaId,'2098151257902809092');
  const missing=loadBackground(()=>{throw Error('不应下载');},{
    url:'https://x.com/i/web/status/1234567890123456789',
    readPage: async () => ({ mediaId:'1', duration:10, title:'X', tracks:[] })
  });
  await assert.rejects(missing.fetchXPlayurl({ bvid:'x_1234567890123456789_1', tabId:1 }), /请先.*播放/);
  const meta=await bg.resolveVideoMeta({ bvid:'x_1234567890123456789_1', tabId:1, title:'T' });
  assert.equal(meta.bvid,'x_1234567890123456789_1');
  assert.equal(meta.cid,1);
});

// ---- 字幕获取稳定性 / 性能 / 安全（第二轮审查） ----

test("B 站有本地缓存时先用缓存，只打 view，不再打 nav、WBI、player、dm/view", async () => {
  const { calls, fetchImpl } = biliFetch({ playerSubs: [aiZhTrack()] });
  const B = loadBackground(fetchImpl);
  const first = await B.loadSubtitles(PAGE);
  assert.equal(first.cues[0].content, "官方字幕");
  const before = calls.length;
  const second = await B.loadSubtitles(PAGE);
  const extra = calls.slice(before).map((item) => item.url);
  assert.equal(second.cues[0].content, "官方字幕");
  assert.equal(second.login.isLogin, true);
  assert.equal(second.tracks[0].lan, "ai-zh");
  assert.equal(extra.length, 1);
  assert.match(extra[0], /\/x\/web-interface\/view/);
});

test("换分 P 仍按 view 解析出的 cid 取缓存，不串到别的 P", async () => {
  const { fetchImpl } = biliFetch({ playerSubs: [aiZhTrack()] });
  const B = loadBackground(async (url, options) => {
    if (String(url).includes("/x/web-interface/view")) {
      return jsonResponse({ code: 0, data: { aid: 111, cid: 222, bvid: PAGE.bvid, title: "多 P", duration: 120, pages: [{ cid: 222, part: "P1", duration: 60 }, { cid: 333, part: "P2", duration: 60 }] } });
    }
    return fetchImpl(url, options);
  });
  B.__store[`asr:${PAGE.bvid}:222`] = { cues: [{ from: 0, to: 1, content: "P1 缓存" }], source: "groq", activeLan: "groq-asr", partial: false };
  // 内容脚本读不到页面变量，传来的 cid 恒为 0，分 P 只靠 view + p 解析
  const p1 = await B.loadSubtitles({ ...PAGE, cid: 0, p: 1 });
  const p2 = await B.loadSubtitles({ ...PAGE, cid: 0, p: 2 });
  assert.equal(p1.cid, 222);
  assert.equal(p1.cues[0].content, "P1 缓存");
  assert.equal(p2.cid, 333);
  assert.equal(p2.part, "P2");
  assert.equal(p2.cues[0].content, "官方字幕");
});

test("B 站首选字幕轨下载失败时依次换下一条，不整体报错", async () => {
  const bad = "https://i0.hdslb.com/bfs/subtitle/broken.json";
  const good = "https://i0.hdslb.com/bfs/subtitle/en.json";
  const { fetchImpl } = biliFetch({
    playerSubs: [aiZhTrack(bad), { lan: "en", lan_doc: "English", subtitle_url: good }]
  });
  const B = loadBackground(async (url, options) => {
    if (String(url) === bad) return jsonResponse({}, false, 404);
    return fetchImpl(url, options);
  });
  const data = await B.loadSubtitles(PAGE);
  assert.equal(data.activeLan, "en");
  assert.equal(data.cues[0].content, "官方字幕");
  assert.equal(data.subtitleStatus, "");
});

test("B 站 AI 字幕比视频长出 10% 以上判为别的视频的字幕：换轨，全都不对就提示", async () => {
  const wrong = "https://i0.hdslb.com/bfs/subtitle/wrong.json";
  const right = "https://i0.hdslb.com/bfs/subtitle/right.json";
  const cuesTo = (to) => jsonResponse({ body: [{ from: 0, to: 1, content: "开头" }, { from: to - 2, to, content: "结尾" }] });
  const { fetchImpl } = biliFetch({
    playerSubs: [aiZhTrack(wrong), { lan: "zh-CN", lan_doc: "中文", subtitle_url: right }]
  });
  const B = loadBackground(async (url, options) => {
    if (String(url) === wrong) return cuesTo(300);
    if (String(url) === right) return cuesTo(59);
    return fetchImpl(url, options);
  });
  const data = await B.loadSubtitles(PAGE);
  assert.equal(data.activeLan, "zh-CN");
  assert.equal(data.cues.at(-1).to, 59);

  const only = biliFetch({ playerSubs: [aiZhTrack(wrong)] });
  const C = loadBackground(async (url, options) => {
    if (String(url) === wrong) return cuesTo(300);
    return only.fetchImpl(url, options);
  });
  const none = await C.loadSubtitles(PAGE);
  assert.equal(none.cues.length, 0);
  assert.equal(none.subtitleStatus, "fetch_failed");
  assert.match(none.notice, /时长对不上/);
  assert.equal(C.__store[`asr:${PAGE.bvid}:222`], undefined);
  // 以前误存的错字幕缓存也不再直接用
  C.__store[`asr:${PAGE.bvid}:222`] = { cues: [{ from: 0, to: 300, content: "错的" }], source: "bilibili", partial: false };
  const again = await C.loadSubtitles(PAGE);
  assert.equal(again.cues.length, 0);
  assert.match(again.notice, /时长对不上/);
});

test("B 站「需要登录才有字幕」与「没有字幕」分开", async () => {
  const B = loadBackground(async (url) => {
    const href = String(url);
    if (href.includes("/x/web-interface/nav")) return jsonResponse({ code: 0, data: { isLogin: true, uname: "tester" } });
    if (href.includes("/x/web-interface/view")) return jsonResponse({ code: 0, data: { aid: 111, cid: 222, bvid: PAGE.bvid, pages: [{ cid: 222 }] } });
    if (href.includes("/x/player")) return jsonResponse({ code: 0, data: { need_login_subtitle: true, subtitle: { subtitles: [] } } });
    if (href.includes("/x/v2/dm/view")) return jsonResponse({ code: 0, data: { subtitle: { subtitles: [] } } });
    throw new Error(`unexpected ${href}`);
  });
  const data = await B.loadSubtitles(PAGE);
  assert.equal(data.subtitleStatus, "login");
  assert.match(data.notice, /登录/);
  assert.notEqual(data.subtitleStatus, "none");
  const { fetchImpl } = biliFetch({ playerSubs: [], dmSubs: [] });
  const plain = await loadBackground(fetchImpl).loadSubtitles(PAGE);
  assert.equal(plain.subtitleStatus, "none");
});

test("番剧 ss 链接从页面播放器读当前集；读不到时明确提示而不是猜第一集", async () => {
  const seasonCalls = [];
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/x/web-interface/nav")) return jsonResponse({ code: 0, data: { isLogin: true } });
    if (href.includes("/pgc/view/web/season")) {
      seasonCalls.push(href);
      return jsonResponse({ code: 0, result: { title: "番剧", episodes: [
        { ep_id: 330798, aid: 1, cid: 11, duration: 1721000, long_title: "第一集" },
        { ep_id: 330799, aid: 2, cid: 22, duration: 1440000, long_title: "第二集" }
      ] } });
    }
    if (href.includes("/x/player")) return jsonResponse({ code: 0, data: { subtitle: { subtitles: [] } } });
    if (href.includes("/x/v2/dm/view")) return jsonResponse({ code: 0, data: { subtitle: { subtitles: [] } } });
    throw new Error(`unexpected ${href}`);
  };
  const injected = [];
  const B = loadBackground(fetchImpl, {
    executeScript: async (call) => {
      injected.push(call);
      return [{ result: { epId: "330799", cid: 22, aid: 2 } }];
    }
  });
  const data = await B.loadSubtitles({ kind: "bangumi", epId: "", seasonId: "33802", cid: 0, aid: 0, bvid: "" }, 7);
  assert.equal(injected[0].world, "MAIN");
  assert.equal(injected[0].func, B.BiliCaptionPlatforms.readBangumiPage);
  assert.deepEqual([...injected[0].args], ["33802", 6000]);
  assert.match(seasonCalls[0], /ep_id=330799/);
  assert.equal(data.cid, 22);
  assert.equal(data.part, "第二集");
  // pgc 的毫秒时长换成秒
  assert.equal(data.durationMeta, 1440);

  const pending = loadBackground(fetchImpl, { executeScript: async () => [{ result: { pending: true } }] });
  await assert.rejects(
    pending.loadSubtitles({ kind: "bangumi", epId: "", seasonId: "33802", cid: 0, aid: 0, bvid: "" }, 7),
    /开始播放|具体一集/
  );
});

test("YouTube 最多试 3 条字幕轨；不支持翻译时后台不再自拼自动翻译中文轨", async () => {
  const tried = [];
  const tracks = ["en", "fr", "de", "ja", "ko"].map((lan) => ({ lan, url: `https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=${lan}` }));
  const bg = loadBackground(() => { throw Error("不应请求 B 站"); }, {
    url: "https://www.youtube.com/watch?v=aircAruvnKk",
    readPage: async (_page, track) => {
      if (!track) return { title: "Ready", tracks };
      tried.push(track);
      return { error: "YouTube 未返回字幕内容，请开启播放器字幕后重试" };
    }
  });
  const data = await bg.loadSubtitles(bg.BiliCaptionPlatforms.parse("https://www.youtube.com/watch?v=aircAruvnKk"), 1);
  assert.equal(tried.length, 3);
  assert.equal(data.subtitleStatus, "fetch_failed");
  assert.equal(data.tracks.some((t) => t.autoTranslated), false);
  assert.equal(data.tracks.length, 5);
  assert.equal(typeof bg.withYoutubeTranslateFallback, "undefined");
});

test("限流退避存在 session：service worker 重启后自动重读也不再打 timedtext", async () => {
  const store = {};
  const en = "https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=en";
  let tracksTried = 0;
  const readPage = async (_page, track) => {
    if (!track) return { title: "Ready", tracks: [{ lan: "en", url: en }] };
    tracksTried++;
    return { error: "字幕请求失败（429）" };
  };
  const first = loadBackground(() => { throw Error("不应请求 B 站"); }, { url: "https://www.youtube.com/watch?v=aircAruvnKk", readPage, store });
  const page = first.BiliCaptionPlatforms.parse("https://www.youtube.com/watch?v=aircAruvnKk");
  await first.loadSubtitles(page, 1);
  assert.equal(tracksTried, 1);
  assert.ok(Object.keys(store).some((key) => key.startsWith("subBackoff:")));
  const restarted = loadBackground(() => { throw Error("不应请求 B 站"); }, { url: "https://www.youtube.com/watch?v=aircAruvnKk", readPage, store });
  const blocked = await restarted.loadSubtitles(page, 1);
  assert.match(blocked.error, /限流/);
  assert.equal(tracksTried, 1);
  await restarted.loadSubtitles(page, 1, { force: true });
  assert.equal(tracksTried, 2);
});

test("X：页面只回原始正文，后台截短标题；没捕获清单时登记，清单一到只通知一次", async () => {
  const pageUrl = "https://x.com/a/status/2098162488013455784";
  const bg = loadBackground(() => { throw Error("不应请求"); }, {
    url: pageUrl,
    readPage: async () => ({
      mediaId: "2098151257902809092",
      xText: "第一句话很重要！后面的补充\n第二行",
      xAuthor: "小由",
      pageTitle: "X",
      up: "小由",
      duration: 94,
      tracks: []
    })
  });
  const sent = [];
  bg.chrome.tabs.sendMessage = async (tabId, message) => { sent.push({ tabId, message }); };
  const page = bg.BiliCaptionPlatforms.parse(pageUrl);
  const data = await bg.loadSubtitles(page, 5);
  assert.equal(data.title, "第一句话很重要");
  assert.match(data.titleFull, /后面的补充/);
  assert.equal(data.subtitleStatus, "fetch_failed");
  assert.ok(bg.__store["xWait:5:2098151257902809092"]);
  const manifest = "https://video.twimg.com/amplify_video/2098151257902809092/pl/abc.m3u8?tag=16";
  bg.onXManifestCompleted({ tabId: 5, url: manifest });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].tabId, 5);
  assert.equal(sent[0].message.type, "X_MANIFEST_READY");
  assert.equal(sent[0].message.bvid, page.bvid);
  assert.equal(bg.__store["xWait:5:2098151257902809092"], undefined);
  bg.onXManifestCompleted({ tabId: 5, url: manifest });
  bg.onXManifestCompleted({ tabId: 5, url: "https://video.twimg.com/amplify_video/2098151257902809092/pl/mp4a/128000/seg.m3u8" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sent.length, 1);
  assert.equal(vm.runInContext("X_MANIFEST_FILTER", bg).urls.every((pattern) => pattern.includes(".m3u8")), true);
});

test("X 字幕分片小并发拉取（最多 4 个同时），结果仍按顺序合并", async () => {
  let inFlight = 0;
  let peak = 0;
  const segs = Array.from({ length: 10 }, (_, i) => `s${i}.vtt`);
  const bg = loadBackground(async (url) => {
    const href = String(url);
    if (href.endsWith(".m3u8")) return { ok: true, text: async () => `#EXTM3U\n${segs.map((s) => `#EXTINF:3,\n${s}`).join("\n")}\n#EXT-X-ENDLIST` };
    inFlight++;
    peak = Math.max(peak, inFlight);
    const index = Number(href.match(/s(\d+)\.vtt/)[1]);
    await new Promise((resolve) => setTimeout(resolve, (10 - index) * 2));
    inFlight--;
    return { ok: true, text: async () => `WEBVTT\n\n00:00:${String(index * 3).padStart(2, "0")}.000 --> 00:00:${String(index * 3 + 1).padStart(2, "0")}.000\n第${index}句\n` };
  });
  const cues = await bg.fetchXTrackCues({ hls: true, url: "https://video.twimg.com/subs/list.m3u8" });
  assert.equal(cues.length, 10);
  assert.deepEqual(Array.from(cues, (c) => c.content), segs.map((_, i) => `第${i}句`));
  assert.ok(peak > 1 && peak <= 4, `并发峰值 ${peak}`);
});

test("fetchJson 出错时日志里不带查询参数（签名 / 令牌）", async () => {
  const B = loadBackground(async () => ({ ok: false, status: 403, json: async () => ({}) }));
  await assert.rejects(
    B.fetchJson("https://api.bilibili.com/x/player/wbi/v2?aid=1&cid=2&w_rid=secret&wts=1"),
    (error) => /403/.test(error.message) && /x\/player\/wbi\/v2/.test(error.message) && !/secret|w_rid|\?/.test(error.message)
  );
});

function routeMessage(bg, message, sender) {
  return new Promise((resolve) => {
    const handled = bg.__onMessage(message, sender, resolve);
    if (handled !== true) resolve({ ignored: true, handled });
  });
}

test("消息白名单：内容脚本只能调 7 种消息，扩展页专用类型回无权调用，TIME 等广播不处理", async () => {
  const { fetchImpl } = biliFetch();
  const bg = loadBackground(fetchImpl);
  const content = { url: "https://www.bilibili.com/video/BV1testxxx", tab: { id: 9, windowId: 1 }, id: "test-extension" };
  const panel = { url: "chrome-extension://test-extension/sidepanel.html", id: "test-extension" };
  assert.deepEqual(Array.from(vm.runInContext("CONTENT_MESSAGE_TYPES", bg)).sort(), ["CLOSE_SIDE_PANEL", "FETCH_CUES", "GET_MARKERS", "LOAD_SUBTITLES", "RESTORE_SIDE_PANEL", "SAVE_CUES_CACHE", "WHOAMI"]);
  for (const type of ["CANCEL_ASR", "PAUSE_ASR", "GENERATE_ASR", "GET_LOGIN", "CLEAR_VIDEO_CACHE", "DAV_SYNC_NOW", "START_TRANSLATE"]) {
    const res = await routeMessage(bg, { type, tabId: 123 }, content);
    assert.equal(res.error, "无权调用", type);
  }
  const who = await routeMessage(bg, { type: "WHOAMI" }, content);
  assert.equal(who.tabId, 9);
  const time = await routeMessage(bg, { type: "TIME", currentTime: 1 }, content);
  assert.equal(time.ignored, true);
  const unknown = await routeMessage(bg, { type: "SOMETHING_NEW" }, { url: "https://evil.test/", tab: { id: 3 } });
  assert.equal(unknown.ignored, true);
  const login = await routeMessage(bg, { type: "GET_LOGIN" }, panel);
  assert.equal(login.isLogin, true);
});

test("大纲 / asrIndex 缓存跟着字幕缓存淘汰，旧版 outline: 键清掉", async () => {
  const bg = loadBackground(() => { throw Error("不应请求"); });
  Object.assign(bg.__store, {
    "asr:BV1keep:1": { cues: [{ from: 0, to: 1, content: "a" }] },
    "asrIndex:BV1keep": 1,
    "asrIndex:BV1gone": 5,
    "outline:v2:BV1keep:1": { summary: "留", chapters: [] },
    "outline:v2:BV1gone:5": { summary: "删", chapters: [] },
    "outline:BV1keep:1": [{ title: "旧版" }],
    "marks:BV1gone:5": [{ id: 1 }]
  });
  const result = await bg.pruneAuxCache();
  assert.equal(result.removed, 3);
  assert.ok(bg.__store["outline:v2:BV1keep:1"]);
  assert.equal(bg.__store["asrIndex:BV1keep"], 1);
  assert.equal(bg.__store["asrIndex:BV1gone"], undefined);
  assert.equal(bg.__store["outline:v2:BV1gone:5"], undefined);
  assert.equal(bg.__store["outline:BV1keep:1"], undefined);
  assert.ok(bg.__store["marks:BV1gone:5"]);
  // 数量上限兜底
  for (let i = 0; i < 70; i++) {
    bg.__store[`asr:BV${i}:1`] = { cues: [] };
    bg.__store[`outline:v2:BV${i}:1`] = { summary: "x", chapters: [] };
  }
  await bg.pruneAuxCache();
  assert.ok(Object.keys(bg.__store).filter((key) => key.startsWith("outline:v2:")).length <= 60);
});
