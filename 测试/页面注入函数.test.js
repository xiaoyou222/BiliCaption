const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// executeScript({ func, world: "MAIN" }) 只序列化函数源码，模块里的其它函数在页面里都不存在。
// 这里按同样方式：只取函数源码，在一个没有 BiliCaptionPlatforms、没有闭包的空上下文里执行。
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'lib/视频平台.js'), 'utf8');
const loader = vm.createContext({ URL });
vm.runInContext(source, loader);
const P = loader.BiliCaptionPlatforms;

function isolated(fn, globals) {
  const context = vm.createContext({ ...globals });
  return vm.runInContext(`(${fn.toString()})`, context);
}

// 模块顶层（两格缩进）定义的函数名。注入函数里出现「名字(」即说明引用了外部函数。
function moduleFunctionNames() {
  return [...source.matchAll(/^ {2}(?:async )?function (\w+)\(/gm)].map((m) => m[1]);
}

test('注入函数不引用模块内的其它函数（xHeadline 回归）', () => {
  const names = moduleFunctionNames();
  assert.ok(names.includes('xHeadline'));
  for (const fn of [P.readPage, P.readBangumiPage]) {
    const body = fn.toString();
    const own = new RegExp(`^(?:async )?function ${fn.name}\\(`);
    assert.match(body, own);
    for (const name of names) {
      if (name === fn.name) continue;
      assert.doesNotMatch(body, new RegExp(`(?<![.\\w])${name}\\(`), `${fn.name} 引用了外部函数 ${name}`);
    }
  }
});

function ytPlayer(tracks, extra = {}) {
  return {
    classList: { contains: () => false },
    getPlayerResponse: () => ({
      videoDetails: { videoId: 'aircAruvnKk', title: 'Title', author: 'Author', lengthSeconds: '90' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: tracks,
          translationLanguages: [{ languageCode: 'zh-Hans' }]
        }
      }
    }),
    ...extra
  };
}

function ytGlobals(player, overrides = {}) {
  return {
    URL,
    AbortSignal,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    location: { hostname: 'www.youtube.com', href: 'https://www.youtube.com/watch?v=aircAruvnKk' },
    window: {},
    document: { querySelector: () => null, getElementById: () => player },
    ...overrides
  };
}

const PAGE_YT = { kind: 'youtube', videoId: 'aircAruvnKk', bvid: 'yt_aircAruvnKk', cid: 1 };
const BASE = 'https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=en&kind=asr&signature=listed';
const body = (text) => JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: text }] }] });

test('YouTube 分支在空上下文里能列轨、只在支持时生成自动翻译中文', async () => {
  const player = ytPlayer([{ baseUrl: BASE, languageCode: 'en', kind: 'asr', isTranslatable: true }]);
  const readPage = isolated(P.readPage, ytGlobals(player));
  const data = await readPage(PAGE_YT);
  assert.equal(data.title, 'Title');
  assert.equal(data.duration, 90);
  assert.deepEqual(data.tracks.map((t) => t.lan), ['en-auto', 'zh-Hans']);
  assert.equal(data.tracks.filter((t) => t.autoTranslated).length, 1);
});

test('YouTube 先用播放器音轨上已带 pot 的同轨地址，不等 setOption', async () => {
  const asked = [];
  const requests = [];
  const player = ytPlayer([{ baseUrl: BASE, languageCode: 'en', kind: 'asr' }], {
    getAudioTrack: () => ({ captionTracks: [{ url: `${BASE}&pot=audio-token&potc=1&c=WEB` }] }),
    setOption: () => asked.push('set')
  });
  const readPage = isolated(P.readPage, ytGlobals(player, {
    fetch: async (href) => {
      const url = new URL(href);
      requests.push(url);
      return { ok: true, status: 200, text: async () => (url.searchParams.get('pot') === 'audio-token' ? body('Hello') : '') };
    }
  }));
  const result = await readPage(PAGE_YT, BASE);
  assert.equal(P.parseCues(result.raw)[0].content, 'Hello');
  assert.equal(requests[0].searchParams.get('pot'), 'audio-token');
  assert.equal(requests[0].searchParams.get('potc'), '1');
  assert.deepEqual(asked, []);
});

test('YouTube 从资源计时里借 pot：只认同一视频，别的轨只借令牌不换地址', async () => {
  const requests = [];
  const player = ytPlayer([{ baseUrl: BASE, languageCode: 'en', kind: 'asr' }], { setOption() {} });
  const entries = [
    { name: 'https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=fr&pot=same-video&c=WEB&cver=2.1' },
    { name: 'https://www.youtube.com/api/timedtext?v=othervideo0&lang=en&kind=asr&pot=stale-video' }
  ];
  const readPage = isolated(P.readPage, ytGlobals(player, {
    performance: { getEntriesByType: (type) => (type === 'resource' ? entries : []) },
    fetch: async (href) => {
      const url = new URL(href);
      requests.push(url);
      return { ok: true, status: 200, text: async () => (url.searchParams.get('pot') === 'same-video' ? body('Borrowed') : '') };
    }
  }));
  const result = await readPage(PAGE_YT, BASE);
  assert.equal(P.parseCues(result.raw)[0].content, 'Borrowed');
  const first = requests[0];
  assert.equal(first.searchParams.get('pot'), 'same-video');
  assert.equal(first.searchParams.get('lang'), 'en');
  assert.equal(first.searchParams.get('kind'), 'asr');
  assert.equal(first.searchParams.get('signature'), 'listed');
  assert.equal(first.searchParams.get('cver'), '2.1');
  assert.ok(requests.every((url) => url.searchParams.get('pot') !== 'stale-video'));
});

function mockXHR(respond) {
  function XHR() { this._on = {}; }
  XHR.prototype.open = function (_m, href) { this._url = String(href || ''); };
  XHR.prototype.addEventListener = function (type, fn) { (this._on[type] ||= []).push(fn); };
  XHR.prototype.send = function () {
    queueMicrotask(() => {
      this.status = 200;
      this.responseText = respond(this._url);
      (this._on.load || []).forEach((fn) => fn.call(this));
    });
  };
  return XHR;
}

test('借播放器取字幕后还原字幕开关：原本关着就关回去', async () => {
  const calls = [];
  let XHR;
  const player = ytPlayer([{ baseUrl: BASE, languageCode: 'en', kind: 'asr' }], {
    getOption: () => ({}),
    loadModule: () => calls.push(['load']),
    unloadModule: (name) => calls.push(['unload', name]),
    setOption(mod, key, val) {
      calls.push([mod, key, val]);
      if (mod === 'captions' && key === 'track' && val?.languageCode) {
        const xhr = new XHR();
        xhr.open('GET', `${BASE}&pot=player&fmt=json3`);
        xhr.send();
      }
    }
  });
  XHR = mockXHR((href) => (new URL(href).searchParams.get('pot') === 'player' ? body('From player') : ''));
  const globals = ytGlobals(player, { XMLHttpRequest: XHR, fetch: async () => ({ ok: true, status: 200, text: async () => '' }) });
  globals.window.fetch = globals.fetch;
  const readPage = isolated(P.readPage, globals);
  const result = await readPage(PAGE_YT, BASE);
  assert.equal(P.parseCues(result.raw)[0].content, 'From player');
  const setTrack = calls.filter((c) => c[0] === 'captions' && c[1] === 'track');
  assert.equal(setTrack[0][2].languageCode, 'en');
  assert.equal(Object.keys(setTrack.at(-1)[2]).length, 0);
  assert.ok(calls.some((c) => c[0] === 'unload' && c[1] === 'captions'));
});

test('借播放器取字幕后还原字幕开关：原本开着别的轨就切回那条', async () => {
  const calls = [];
  let XHR;
  const previous = { languageCode: 'de', kind: '' };
  const player = ytPlayer([{ baseUrl: BASE, languageCode: 'en', kind: 'asr' }], {
    getOption: () => previous,
    loadModule() {},
    unloadModule: () => calls.push(['unload']),
    setOption(mod, key, val) {
      calls.push([mod, key, val]);
      if (mod === 'captions' && key === 'track' && val?.languageCode === 'en') {
        const xhr = new XHR();
        xhr.open('GET', `${BASE}&pot=player&fmt=json3`);
        xhr.send();
      }
    }
  });
  XHR = mockXHR(() => body('From player'));
  const globals = ytGlobals(player, { XMLHttpRequest: XHR, fetch: async () => ({ ok: true, status: 200, text: async () => '' }) });
  globals.window.fetch = globals.fetch;
  const readPage = isolated(P.readPage, globals);
  await readPage(PAGE_YT, BASE);
  const setTrack = calls.filter((c) => c[0] === 'captions' && c[1] === 'track');
  assert.equal(setTrack.at(-1)[2], previous);
  assert.equal(calls.some((c) => c[0] === 'unload'), false);
});

test('两次借播放器取字幕重叠（强制刷新赶上初次读取、重复注入）：排队执行，字幕开关和 fetch / XHR 都还原', async () => {
  // 页面里的计时器缩短（最长 400ms），「一直等不到」的情况也能很快跑完
  const quickTimeout = (fn, ms, ...args) => setTimeout(fn, Math.min(Number(ms) || 0, 400), ...args);
  for (const mode of ['xhr-late', 'fetch', 'timeout']) {
    let track = {}; // 用户原本关着字幕
    const realFetch = async () => ({ ok: true, status: 200, text: async () => body('From player'), clone() { return this; } });
    const win = { fetch: realFetch };
    function XHR() { this._on = {}; }
    XHR.prototype.open = function (_m, href) { this._url = href; };
    XHR.prototype.addEventListener = function (type, fn) { (this._on[type] ||= []).push(fn); };
    XHR.prototype.send = function () {
      setTimeout(() => {
        this.responseText = body('From player');
        (this._on.load || []).forEach((fn) => fn.call(this));
      }, 100);
    };
    const realOpen = XHR.prototype.open;
    const realSend = XHR.prototype.send;
    const player = ytPlayer([{ baseUrl: BASE, languageCode: 'en', kind: 'asr' }], {
      getOption: () => track,
      loadModule() {},
      unloadModule() {},
      setOption(mod, key, val) {
        if (mod !== 'captions' || key !== 'track') return;
        const changed = (val?.languageCode || '') !== (track?.languageCode || '');
        track = val && val.languageCode ? { ...val } : {};
        // 播放器只在换轨时发一次字幕请求
        if (!changed || !val?.languageCode || mode === 'timeout') return;
        setTimeout(() => {
          const href = `${BASE}&pot=player&fmt=json3`;
          if (mode === 'fetch') win.fetch(href);
          else {
            const xhr = new XHR();
            xhr.open('GET', href);
            xhr.send();
          }
        }, 50);
      }
    });
    const globals = ytGlobals(player, {
      window: win,
      XMLHttpRequest: XHR,
      setTimeout: quickTimeout,
      fetch: async () => ({ ok: true, status: 200, text: async () => '' })
    });
    const readPage = isolated(P.readPage, globals);
    const first = readPage(PAGE_YT, BASE);
    await new Promise((resolve) => setTimeout(resolve, mode === 'xhr-late' ? 100 : 10));
    const second = readPage(PAGE_YT, BASE); // 第一次还没收到字幕时第二次开始
    const results = await Promise.all([first, second]);
    assert.deepEqual(track, {}, `${mode}：字幕开关应还原为关闭`);
    assert.equal(win.fetch, realFetch, `${mode}：window.fetch 应还原`);
    assert.equal(XHR.prototype.open, realOpen, `${mode}：XHR.open 应还原`);
    assert.equal(XHR.prototype.send, realSend, `${mode}：XHR.send 应还原`);
    if (mode !== 'timeout') {
      for (const result of results) assert.equal(P.parseCues(result.raw)[0].content, 'From player', mode);
    }
  }
});

function xDom({ withVideo = true } = {}) {
  const article = {
    querySelector(selector) {
      if (selector === '[data-testid="tweetText"]') return { textContent: '第一句话很重要！后面的补充说明不进短标题\n第二行' };
      if (selector === '[data-testid="User-Name"]') return { textContent: '小由@xiaoyou' };
      return null;
    },
    querySelectorAll: () => []
  };
  const video = {
    dataset: { bilicaptionVideoKey: 'x_2098162488013455784_1' },
    poster: 'https://pbs.twimg.com/amplify_video_thumb/2098151257902809092/img/a.jpg',
    duration: 94,
    closest: (selector) => (selector === 'article' ? article : null),
    querySelectorAll: () => [],
    textTracks: []
  };
  return {
    title: '小由 on X: "第一句话很重要" / X',
    querySelectorAll: (selector) => (selector === 'video' && withVideo ? [video] : []),
    querySelector: () => null
  };
}

const PAGE_X = { kind: 'x', videoId: '2098162488013455784', mediaIndex: 1, explicitMedia: false, bvid: 'x_2098162488013455784_1', cid: 1 };

test('X 分支在空上下文里执行：返回原始正文与作者，不调用 xHeadline', async () => {
  const readPage = isolated(P.readPage, {
    URL,
    setTimeout,
    location: { hostname: 'x.com', href: 'https://x.com/a/status/2098162488013455784', pathname: '/a/status/2098162488013455784' },
    window: {},
    document: xDom()
  });
  const data = await readPage(PAGE_X);
  assert.equal(data.error, undefined);
  assert.equal(data.mediaId, '2098151257902809092');
  assert.match(data.xText, /^第一句话很重要/);
  assert.equal(data.xAuthor, '小由@xiaoyou');
  assert.equal(data.up, '小由@xiaoyou');
  assert.equal(data.duration, 94);
  assert.equal(data.title, undefined);
  // 后台再用 xHeadline 截短：只取第一句
  const shaped = P.xHeadline({ text: data.xText, author: data.xAuthor, pageTitle: data.pageTitle });
  assert.equal(shaped.title, '第一句话很重要');
});

test('X 分支找不到视频时返回 pending 对象，不把 throw 留给 executeScript', async () => {
  const readPage = isolated(P.readPage, {
    URL,
    setTimeout,
    location: { hostname: 'x.com', href: 'https://x.com/a/status/2098162488013455784', pathname: '/a/status/2098162488013455784' },
    window: {},
    document: xDom({ withVideo: false })
  });
  const data = await readPage(PAGE_X);
  assert.equal(data.pending, true);
  assert.ok(P.isPending(data.notice));
  const moved = isolated(P.readPage, {
    URL,
    setTimeout,
    location: { hostname: 'x.com', href: 'https://x.com/a/status/1', pathname: '/a/status/1' },
    window: {},
    document: xDom()
  });
  assert.match((await moved(PAGE_X)).error, /已切换/);
});

test('番剧 ss 页在空上下文里读播放器当前集，季度对不上不认', async () => {
  const manifest = { aid: 626339509, cid: 210288241, seasonId: 33802, episodeId: 330798 };
  const globals = {
    setTimeout,
    location: { hostname: 'www.bilibili.com', pathname: '/bangumi/play/ss33802' },
    window: { player: { getManifest: () => manifest } }
  };
  const read = isolated(P.readBangumiPage, globals);
  assert.deepEqual({ ...(await read('33802', 0)) }, { epId: '330798', cid: 210288241, aid: 626339509 });
  assert.equal((await read('99999', 0)).pending, true);
  const notReady = isolated(P.readBangumiPage, { ...globals, window: {} });
  assert.equal((await notReady('33802', 0)).pending, true);
  const elsewhere = isolated(P.readBangumiPage, { ...globals, location: { hostname: 'www.bilibili.com', pathname: '/video/BV1xx' } });
  assert.match((await elsewhere('33802', 0)).error, /已切换/);
});
