const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { contentSource, panelSource, runFile } = require("./源码加载.js");
const root = path.resolve(__dirname, '..');
const context = vm.createContext({ URL });
vm.runInContext(fs.readFileSync(path.join(root, 'lib/视频平台.js'), 'utf8'), context);
const P = context.BiliCaptionPlatforms;
const plain = (v) => JSON.parse(JSON.stringify(v));

test('平台域名只接受精确主机，拒绝相似域名和扩展页', () => {
  for (const url of ['https://youtube.com.evil.test/watch?v=aircAruvnKk', 'https://evil.test/?x.com', 'https://notbilibili.com', 'chrome-extension://x.com/test']) assert.equal(P.platform(url), '');
  assert.equal(P.platform('https://www.youtube.com/watch?v=aircAruvnKk'), 'youtube');
  assert.equal(P.platform('https://twitter.com/a/status/123'), 'x');
});

test('YouTube 缓存编号稳定，查询参数不影响身份，Shorts 不冒充普通视频', () => {
  assert.equal(P.parse('https://www.youtube.com/watch?v=aircAruvnKk&t=12s&list=x').bvid, 'yt_aircAruvnKk');
  assert.equal(P.parse('https://www.youtube.com/shorts/aircAruvnKk').kind, 'other');
  assert.equal(P.parse('https://www.youtube.com/watch?v=bad').kind, 'other');
});

test('X 多视频、旧域名、导出链接使用互不冲突的编号', () => {
  const a = P.parse('https://x.com/cursor_ai/status/2098162488013455784');
  const b = P.parse('https://twitter.com/cursor_ai/status/2098162488013455784/video/2');
  assert.equal(a.bvid, 'x_2098162488013455784_1');
  assert.equal(b.bvid, 'x_2098162488013455784_2');
  assert.equal(P.parse(P.videoUrl(b.bvid, 12)).bvid, b.bvid);
  assert.equal(P.videoUrl('yt_aircAruvnKk', 10), 'https://www.youtube.com/watch?v=aircAruvnKk&t=10s');
  assert.equal(P.videoUrl('BV1test', 10), 'https://www.bilibili.com/video/BV1test?t=10');
  for (const id of [a.bvid, b.bvid, 'yt_aircAruvnKk']) assert.ok(!id.includes(':'));
});

test('JSON3 合并逐词字幕并保留小数时间，过滤空事件和无效时长', () => {
  const cues = P.parseCues({ events: [
    { tStartMs: 120, dDurationMs: 1480, segs: [{utf8:'Hello'}, {utf8:' world'}] },
    { tStartMs: 0 }, { tStartMs: 400, dDurationMs: 0, segs: [{utf8:'bad'}] }
  ] });
  assert.deepEqual(plain(cues), [{ from: .12, to: 1.6, content:'Hello world', sid:1 }]);
});

test('X WebVTT 识别单词时间标签、实体、小时与字幕块编号', () => {
  const cues = P.parseCues('WEBVTT\n\n1\n00:00:00.120 --> 00:00:01.600\n<X-word-ms ms=260>Hello &amp; world</X-word-ms>\n\n2\n01:02:03.100 --> 01:02:05.999 align:start\n第二行\n字幕\n');
  assert.equal(cues[0].content, 'Hello & world');
  assert.equal(cues[1].from, 3723.1);
  assert.equal(cues[1].content, '第二行 字幕');
  assert.throws(() => P.parseCues('<html>Access denied</html>'), /无法识别/);
});

test('字幕 URL 拒绝非 HTTPS、伪装域名、凭据及不相关路径', () => {
  for (const url of ['http://video.twimg.com/a.vtt','https://video.twimg.com.evil.test/a.vtt','https://user:pass@video.twimg.com/a.vtt','https://www.youtube.com/watch?v=test','https://video.twimg.com:444/a.vtt']) assert.equal(P.cueUrl(url), false);
  assert.equal(P.cueUrl('https://www.youtube.com/api/timedtext?v=test'), true);
  assert.equal(P.cueUrl('https://video.twimg.com/subtitles/a.vtt'), true);
});

function article(id, videos) {
  return {
    querySelectorAll(selector) {
      if (selector === 'video') return videos;
      return [{ href:`https://x.com/a/status/${id}/video/1`, querySelector:()=>null, hasAttribute:()=>false, getAttribute:()=> 'View media' }];
    }
  };
}
test('新版 X 没有 time 标签时仍能锁定主帖，忽略回复和登录弹层', () => {
  const main = {paused:true, closest:()=>null};
  const reply = {paused:false, closest:()=>null};
  const doc = { querySelectorAll:()=>[article('11',[reply]), article('22',[main])], querySelector:()=>({querySelector:()=>null}) };
  assert.equal(P.xSelection(doc, {videoId:'22',mediaIndex:1}).video, main);
  assert.equal(P.xSelection(doc, {videoId:'99',mediaIndex:1}).video, null);
});

test('X 选中正在播放的第二视频，显式视频链接优先', () => {
  const first = {paused:true,closest:()=>null}, second={paused:false,closest:()=>null};
  const doc = {querySelectorAll:()=>[article('22',[first,second])],querySelector:()=>null};
  assert.equal(P.xSelection(doc,{videoId:'22',mediaIndex:1}).mediaIndex,2);
  assert.equal(P.xSelection(doc,{videoId:'22',mediaIndex:1,explicitMedia:true}).video,first);
});

test('平台标记链接贯穿 Markdown 与 CSV 导出', () => {
  for (const file of ['lib/字幕工具.js','lib/markers.js']) runFile(context,file);
  const M=context.BiliCaptionMarkers;
  const md=M.toMarkdown({bvid:'yt_aircAruvnKk',title:'测试'},[{time:3,text:'重点'}]);
  assert.match(md,/youtube\.com\/watch\?v=aircAruvnKk&t=3s/);
  assert.doesNotMatch(md,/bilibili\.com/);
});

test('侧栏顶栏登录后显示平台图标，标题行加高居中', () => {
  const html = fs.readFileSync(path.join(root, 'sidepanel.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'sidepanel.css'), 'utf8');
  const panel = panelSource();
  const header = html.match(/<header class="header">[\s\S]*?<\/header>/)?.[0] || '';
  assert.match(header, /id="siteIconB"/);
  assert.match(header, /id="siteIconY"/);
  assert.match(header, /id="siteIconX"/);
  assert.match(header, /id="loginDot"/);
  assert.match(header, /id="loginLabel"/);
  assert.doesNotMatch(header, /id="userName"|id="vipChip"|VIP/);
  assert.match(css, /\.header\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /\.header\s*\{[^}]*align-items:\s*center/);
  assert.doesNotMatch(css, /\.header\s*\{[^}]*height:\s*36px/);
  assert.match(css, /\.site-icon/);
  assert.match(css, /\.header-title\s*\{[^}]*margin-left:\s*4px/);
  assert.doesNotMatch(css, /\.header-user|\.vip-chip/);
  assert.match(panel, /function setSiteIcon/);
  assert.match(panel, /function renderLogin/);
  assert.match(panel, /siteIconB/);
  assert.match(panel, /siteIconY/);
  assert.match(panel, /siteIconX/);
  assert.doesNotMatch(panel, /ui\.userName|ui\.vipChip|function isVip/);
  assert.doesNotMatch(panel, /loginLabel\.textContent = BiliCaptionPlatforms\.siteName/);
});

test('平台可见文案跟站点走，B 站保持原名', () => {
  assert.equal(P.chromeTitle('youtube'), 'YouTube 字幕');
  assert.equal(P.chromeTitle('x'), 'X 字幕');
  assert.equal(P.chromeTitle('bilibili'), 'BiliCaption');
  assert.equal(P.labels('youtube').other, '当前不是YouTube视频页');
  assert.equal(P.labels('youtube').login, 'YouTube');
  assert.equal(P.labels('bilibili').loginError, '未登录 B 站');
  assert.equal(P.labels('bilibili').other, '当前标签页不是视频页');
  assert.ok(P.isPending('视频信息尚未就绪，请稍后刷新字幕'));
  assert.ok(P.isPending('广告播放中，请在正片开始后刷新字幕'));
  assert.equal(P.isPending('视频页面已切换'), false);
  assert.equal(P.isPending('YouTube 未返回字幕内容，请开启播放器字幕后重试'), false);
  assert.ok(P.isRateLimited('字幕请求失败（429）'));
  assert.ok(P.isRateLimited('YouTube 字幕接口限流，请稍后再试'));
  assert.equal(P.isRateLimited('字幕请求失败（403）'), false);
});

test('MAIN world 拒绝过期播放器身份，空字幕响应明确报错', async () => {
  let requested = 0;
  const player = {classList:{contains:()=>false},getPlayerResponse:()=>({videoDetails:{videoId:'oldvideo000'},captions:{}})};
  const c=vm.createContext({URL,AbortSignal,setTimeout, location:{hostname:'www.youtube.com',href:'https://www.youtube.com/watch?v=aircAruvnKk'},window:{},document:{querySelector:()=>null,getElementById:()=>player},fetch:async()=>{requested++;return {ok:true,text:async()=>''};}});
  vm.runInContext(fs.readFileSync(path.join(root,'lib/视频平台.js'),'utf8'),c);
  const page=P.parse('https://www.youtube.com/watch?v=aircAruvnKk');
  const waiting=await c.BiliCaptionPlatforms.readPage(page);
  assert.equal(waiting.pending,true);
  assert.match(waiting.notice,/尚未就绪/);
  assert.equal(requested,0);
  const url='https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=en';
  player.getPlayerResponse=()=>({videoDetails:{videoId:page.videoId},captions:{playerCaptionsTracklistRenderer:{captionTracks:[{baseUrl:url,languageCode:'en'}]}}});
  const empty=await c.BiliCaptionPlatforms.readPage(page,url);
  assert.match(empty.error,/未返回字幕内容/);
  assert.equal(requested,4);
  const invalid=await c.BiliCaptionPlatforms.readPage(page,'https://evil.test/');
  assert.match(invalid.error,/字幕轨已失效/);
  assert.equal(requested,4);
});

test('广告结束且播放器身份对齐后自动读取，不必手动刷新', async () => {
  let ad = true;
  let id = 'oldvideo000';
  const player = {
    classList: { contains: (name) => name === 'ad-showing' && ad },
    getPlayerResponse: () => ({ videoDetails: { videoId: id, title: 'Ready', author: 'A', lengthSeconds: '12' }, captions: {} })
  };
  const c=vm.createContext({URL,AbortSignal,setTimeout, location:{hostname:'www.youtube.com',href:'https://www.youtube.com/watch?v=aircAruvnKk'},window:{},document:{querySelector:()=>null,getElementById:()=>player}});
  vm.runInContext(fs.readFileSync(path.join(root,'lib/视频平台.js'),'utf8'),c);
  setTimeout(() => { ad = false; id = 'aircAruvnKk'; }, 40);
  const data = await c.BiliCaptionPlatforms.readPage(P.parse('https://www.youtube.com/watch?v=aircAruvnKk'), '', '', 400);
  assert.equal(data.title, 'Ready');
  assert.equal(data.duration, 12);
});

test('切换视频时清掉旧字幕，旧异步响应不能覆盖新视频', async () => {
  const code=contentSource();
  const fn=code.slice(code.indexOf('  async function loadState()'),code.indexOf('  async function switchTrack'));
  let page={kind:'youtube',bvid:'yt_video000001',cid:1}, resolveFirst;
  const c=vm.createContext({loadToken:0,loadingPageKey:'',lastStateKey:'old',pendingReload:0,inflightLoad:null,pendingSince:0,pendingGiveUpMs:60000,cachedState:{cues:[{content:'旧字幕'}]},targetRate:1,
    parsePage:()=>page,pageKey:(p=page)=>p.bvid,clearCueLoop(){},setOverlayCues(){},setProgressMarks(){},emptyState:(page,extra)=>({page,cues:[],...extra}),getVideo:()=>null,hookVideo(){},pullProgressMarks(){},
    allowsAsr:(kind)=>kind!=='youtube', schedulePendingReload(){}, clearTimeout(){}, askBackground:()=>new Promise(resolve=>{resolveFirst=resolve;})});
  vm.runInContext(fn,c);
  const first=c.loadState();
  assert.equal(c.cachedState.cues.length,0);
  assert.equal(c.loadingPageKey,page.bvid);
  const oldResolve=resolveFirst;
  page={kind:'youtube',bvid:'yt_video000002',cid:1};
  const second=c.loadState();
  oldResolve({bvid:'yt_video000001',cues:[{content:'旧结果'}]});
  await first;
  assert.equal(c.loadingPageKey,page.bvid);
  resolveFirst({bvid:page.bvid,cues:[{content:'新结果'}]});
  await second;
  assert.equal(c.cachedState.cues[0].content,'新结果');
  assert.equal(c.loadingPageKey,'');
});

test('YouTube pending 会自动再拉，不把尚未就绪当成终态', async () => {
  const code=contentSource();
  const fn=code.slice(code.indexOf('  async function loadState()'),code.indexOf('  async function switchTrack'));
  let scheduled=0;
  const page={kind:'youtube',bvid:'yt_aircAruvnKk',cid:1,platform:'youtube'};
  const c=vm.createContext({loadToken:0,loadingPageKey:'',lastStateKey:'',pendingReload:0,inflightLoad:null,pendingSince:0,pendingGiveUpMs:60000,cachedState:{cues:[]},targetRate:1,
    parsePage:()=>page,pageKey:()=>page.bvid,clearCueLoop(){},setOverlayCues(){},setProgressMarks(){},
    emptyState:(name,extra)=>({page:name,cues:[],...extra}),getVideo:()=>null,hookVideo(){},pullProgressMarks(){},
    allowsAsr:(kind)=>kind!=='youtube', schedulePendingReload(){scheduled++;},clearTimeout(){},
    askBackground:async()=>({page:'video',platform:'youtube',subtitleStatus:'pending',notice:'视频信息尚未就绪，请稍后刷新字幕',cues:[],error:'',login:{platform:'youtube'}})});
  vm.runInContext(fn,c);
  const state=await c.loadState();
  assert.equal(state.subtitleStatus,'pending');
  assert.equal(state.platform,'youtube');
  assert.equal(scheduled,1);
});

test('同一视频并发 loadState 复用进行中的请求，避免轮询把等待判成过期', async () => {
  const code=contentSource();
  const fn=code.slice(code.indexOf('  async function loadState()'),code.indexOf('  async function switchTrack'));
  let calls=0, resolveBg;
  const page={kind:'youtube',bvid:'yt_aircAruvnKk',cid:1,platform:'youtube'};
  const c=vm.createContext({loadToken:0,loadingPageKey:'',lastStateKey:'',pendingReload:0,inflightLoad:null,pendingSince:0,pendingGiveUpMs:60000,cachedState:{cues:[]},targetRate:1,
    parsePage:()=>page,pageKey:()=>page.bvid,clearCueLoop(){},setOverlayCues(){},setProgressMarks(){},
    emptyState:(name,extra)=>({page:name,cues:[],...extra}),getVideo:()=>null,hookVideo(){},pullProgressMarks(){},
    allowsAsr:(kind)=>kind!=='youtube', schedulePendingReload(){},clearTimeout(){},
    askBackground:()=>{calls++;return new Promise(resolve=>{resolveBg=resolve;});}});
  vm.runInContext(fn,c);
  const first=c.loadState();
  const second=c.loadState();
  assert.equal(calls,1);
  resolveBg({page:'video',platform:'youtube',subtitleStatus:'pending',notice:'视频信息尚未就绪，请稍后刷新字幕',cues:[],error:'',login:{platform:'youtube'}});
  const [a,b]=await Promise.all([first,second]);
  assert.equal(a.subtitleStatus,'pending');
  assert.equal(b.subtitleStatus,'pending');
  assert.equal(c.loadToken,1);
});

test('pending 超时后变成可重试错误；用户再刷新会重新计时', async () => {
  const code=contentSource();
  const fn=code.slice(code.indexOf('  async function loadState()'),code.indexOf('  async function switchTrack'));
  let scheduled=0, calls=0;
  const page={kind:'youtube',bvid:'yt_aircAruvnKk',cid:1,platform:'youtube'};
  const pending={page:'video',platform:'youtube',subtitleStatus:'pending',notice:'视频信息尚未就绪，请稍后刷新字幕',cues:[],error:'',login:{platform:'youtube'}};
  const c=vm.createContext({loadToken:0,loadingPageKey:'',lastStateKey:page.bvid,pendingReload:0,inflightLoad:null,pendingSince:Date.now()-70000,pendingGiveUpMs:60000,cachedState:{page:'video',subtitleStatus:'pending',cues:[]},targetRate:1,
    parsePage:()=>page,pageKey:()=>page.bvid,clearCueLoop(){},setOverlayCues(){},setProgressMarks(){},
    emptyState:(name,extra)=>({page:name,cues:[],...extra}),getVideo:()=>null,hookVideo(){},pullProgressMarks(){},
    allowsAsr:(kind)=>kind!=='youtube', schedulePendingReload(){scheduled++;},clearTimeout(){},
    askBackground:async()=>{calls++;return pending;}});
  vm.runInContext(fn,c);
  const timedOut=await c.loadState();
  assert.equal(timedOut.subtitleStatus,'fetch_failed');
  assert.match(timedOut.error,/超时|正片/);
  assert.equal(scheduled,0);
  const retried=await c.loadState();
  assert.equal(calls,2);
  assert.equal(retried.subtitleStatus,'pending');
  assert.equal(scheduled,1);
});

test('getPlayerResponse 对不上时改用匹配的 ytInitialPlayerResponse', async () => {
  const player={classList:{contains:()=>false},getPlayerResponse:()=>({videoDetails:{videoId:'oldvideo000'}})};
  const initial={videoDetails:{videoId:'aircAruvnKk',title:'FromInit',author:'A',lengthSeconds:'8'},captions:{}};
  const c=vm.createContext({URL,AbortSignal,setTimeout,location:{hostname:'www.youtube.com',href:'https://www.youtube.com/watch?v=aircAruvnKk'},window:{ytInitialPlayerResponse:initial},document:{querySelector:()=>null,getElementById:()=>player}});
  vm.runInContext(fs.readFileSync(path.join(root,'lib/视频平台.js'),'utf8'),c);
  const data=await c.BiliCaptionPlatforms.readPage(P.parse('https://www.youtube.com/watch?v=aircAruvnKk'),'','',0);
  assert.equal(data.title,'FromInit');
  assert.equal(data.duration,8);
});

test('侧栏换视频时不把上一支的标题写进 pending 顶栏', () => {
  const panel=panelSource();
  assert.match(panel,/function sameLastVideo/);
  assert.match(panel,/title: next\?\.title \|\| \(same \? lastVideo\?\.title : ""\) \|\| ""/);
  assert.match(panel,/BiliCaptionPlatforms\.headerLabel/);
});

function youtubeTranslationFixture({ translatable = true, chinese = false, languages = ['zh-Hans'] } = {}) {
  const base = 'https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=en&kind=asr&signature=test';
  const tracks = [{baseUrl:base,languageCode:'en',kind:'asr',isTranslatable:translatable}];
  if (chinese) tracks.push({baseUrl:base.replace('lang=en','lang=zh-Hans'),languageCode:'zh-Hans'});
  const player = {classList:{contains:()=>false},getPlayerResponse:()=>({videoDetails:{videoId:'aircAruvnKk'},captions:{playerCaptionsTracklistRenderer:{captionTracks:tracks,translationLanguages:languages.map(languageCode=>({languageCode}))}}})};
  const requests=[];
  const c=vm.createContext({URL,AbortSignal,location:{hostname:'www.youtube.com',href:'https://www.youtube.com/watch?v=aircAruvnKk'},window:{},document:{querySelector:()=>null,getElementById:()=>player},fetch:async(url)=>{requests.push(new URL(url));return {ok:true,text:async()=>JSON.stringify({events:[{tStartMs:0,dDurationMs:1000,segs:[{utf8:new URL(url).searchParams.has('tlang')?'你好':'Hello'}]}]})};}});
  vm.runInContext(fs.readFileSync(path.join(root,'lib/视频平台.js'),'utf8'),c);
  return {read:c.BiliCaptionPlatforms.readPage,page:P.parse('https://www.youtube.com/watch?v=aircAruvnKk'),requests,base};
}

test('YouTube 可翻译英文轨生成中文选项，并真实携带目标语言请求', async () => {
  const f=youtubeTranslationFixture();
  const data=await f.read(f.page);
  assert.equal(data.tracks.length,2);
  const zh=data.tracks.find(t=>t.lan==='zh-Hans');
  assert.equal(zh.autoTranslated,true);
  const result=await f.read(f.page,zh.url,f.base+'&pot=original-token');
  assert.equal(P.parseCues(result.raw)[0].content,'你好');
  assert.equal(f.requests[0].searchParams.get('tlang'),'zh-Hans');
  assert.equal(f.requests[0].searchParams.get('pot'),'original-token');
});

test('中文原生轨优先，不可翻译或未声明中文时不虚构中文轨', async () => {
  for (const options of [{chinese:true},{translatable:false},{languages:['fr']}]) {
    const f=youtubeTranslationFixture(options);
    const data=await f.read(f.page);
    assert.equal(data.tracks.filter(t=>t.autoTranslated).length,0);
  }
});

test('中文请求复用同语言播放器令牌，英文切换不能被中文污染', async () => {
  const f=youtubeTranslationFixture();
  const data=await f.read(f.page);
  const zh=data.tracks.find(t=>t.autoTranslated);
  await f.read(f.page,zh.url,zh.url+'&pot=chinese-token');
  assert.equal(f.requests[0].searchParams.get('pot'),'chinese-token');
  const en=await f.read(f.page,f.base,zh.url+'&pot=chinese-token');
  assert.equal(P.parseCues(en.raw)[0].content,'Hello');
  assert.equal(f.requests[1].searchParams.has('tlang'),false);
  assert.equal(f.requests[1].searchParams.has('pot'),false);
  const invalid=await f.read(f.page,'https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=no-such');
  assert.match(invalid.error,/失效/);
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

test('无 pot 的自拼地址为空时，改用播放器真实 timedtext', async () => {
  const base='https://www.youtube.com/api/timedtext?v=tYvu6IpSfiM&lang=zh&signature=listed';
  const playerBody=JSON.stringify({events:[{tStartMs:1666,dDurationMs:1667,segs:[{utf8:'大家好，我是小木头'}]}]});
  const requests=[];
  const asked=[];
  const XHR=mockXHR((href)=>{
    const u=new URL(href);
    return u.searchParams.get('pot')==='player-tok' ? playerBody : '';
  });
  const player={
    classList:{contains:()=>false},
    getPlayerResponse:()=>({videoDetails:{videoId:'tYvu6IpSfiM'},captions:{playerCaptionsTracklistRenderer:{captionTracks:[{baseUrl:base,languageCode:'zh',kind:'',isTranslatable:true}]}}}),
    loadModule(name){ asked.push(['load',name]); },
    setOption(mod,key,val){
      asked.push([mod,key,val]);
      if (mod==='captions' && key==='track') {
        const xhr=new XHR();
        xhr.open('GET', `${base}&pot=player-tok&fmt=json3`);
        xhr.send();
      }
    }
  };
  const c=vm.createContext({
    URL,AbortSignal,setTimeout,clearTimeout,queueMicrotask,
    location:{hostname:'www.youtube.com',href:'https://www.youtube.com/watch?v=tYvu6IpSfiM'},
    window:{},
    document:{querySelector:()=>null,getElementById:()=>player},
    XMLHttpRequest:XHR,
    fetch:async(href)=>{ requests.push(new URL(href)); return {ok:true,text:async()=>''}; }
  });
  c.window.fetch = c.fetch;
  vm.runInContext(fs.readFileSync(path.join(root,'lib/视频平台.js'),'utf8'),c);
  const page=P.parse('https://www.youtube.com/watch?v=tYvu6IpSfiM');
  const result=await c.BiliCaptionPlatforms.readPage(page,base);
  assert.equal(P.parseCues(result.raw)[0].content,'大家好，我是小木头');
  assert.equal(requests.length,0);
  assert.deepEqual(asked[0],['load','captions']);
  assert.equal(asked[1][2].languageCode,'zh');
});

test('json3 空 body 时回退到播放器未带 fmt 的 vtt', async () => {
  const base='https://www.youtube.com/api/timedtext?v=tYvu6IpSfiM&lang=zh&signature=listed';
  const fmts=[];
  const player={classList:{contains:()=>false},getPlayerResponse:()=>({videoDetails:{videoId:'tYvu6IpSfiM'},captions:{playerCaptionsTracklistRenderer:{captionTracks:[{baseUrl:base,languageCode:'zh'}]}}})};
  const c=vm.createContext({
    URL,AbortSignal,setTimeout,clearTimeout,
    location:{hostname:'www.youtube.com',href:'https://www.youtube.com/watch?v=tYvu6IpSfiM'},
    window:{},
    document:{querySelector:()=>null,getElementById:()=>player},
    fetch:async(href)=>{
      const u=new URL(href);
      fmts.push(u.searchParams.get('fmt'));
      if (u.searchParams.get('fmt')==='vtt') return {ok:true,text:async()=>'WEBVTT\n\n00:00.000 --> 00:01.000\n回退成功\n'};
      return {ok:true,text:async()=>''};
    }
  });
  vm.runInContext(fs.readFileSync(path.join(root,'lib/视频平台.js'),'utf8'),c);
  const result=await c.BiliCaptionPlatforms.readPage(P.parse('https://www.youtube.com/watch?v=tYvu6IpSfiM'),base);
  assert.equal(P.parseCues(result.raw)[0].content,'回退成功');
  assert.deepEqual(fmts,['json3',null,'vtt']);
});

test('自动翻译轨只接受带 tlang 的播放器请求，先开原轨不够', async () => {
  const base='https://www.youtube.com/api/timedtext?v=tYvu6IpSfiM&lang=en&kind=asr&signature=listed';
  const playerBody=JSON.stringify({events:[{tStartMs:0,dDurationMs:1000,segs:[{utf8:'你好木头'}]}]});
  const XHR=mockXHR((href)=>{
    const u=new URL(href);
    if (u.searchParams.get('tlang')==='zh-Hans' && u.searchParams.get('pot')==='zh') return playerBody;
    return JSON.stringify({events:[{tStartMs:0,dDurationMs:1000,segs:[{utf8:'Hello wood'}]}]});
  });
  const player={
    classList:{contains:()=>false},
    getPlayerResponse:()=>({videoDetails:{videoId:'tYvu6IpSfiM'},captions:{playerCaptionsTracklistRenderer:{captionTracks:[{baseUrl:base,languageCode:'en',kind:'asr',isTranslatable:true}],translationLanguages:[{languageCode:'zh-Hans'}]}}}),
    loadModule(){},
    setOption(mod,key,val){
      if (mod!=='captions' || key!=='track') return;
      const original=new XHR();
      original.open('GET', `${base}&pot=en&fmt=json3`);
      original.send();
      if (val?.translationLanguage) {
        const translated=new XHR();
        translated.open('GET', `${base}&tlang=${val.translationLanguage}&pot=zh&fmt=json3`);
        translated.send();
      }
    }
  };
  const c=vm.createContext({
    URL,AbortSignal,setTimeout,clearTimeout,queueMicrotask,
    location:{hostname:'www.youtube.com',href:'https://www.youtube.com/watch?v=tYvu6IpSfiM'},
    window:{},
    document:{querySelector:()=>null,getElementById:()=>player},
    XMLHttpRequest:XHR,
    fetch:async()=>({ok:true,text:async()=>''})
  });
  c.window.fetch = c.fetch;
  vm.runInContext(fs.readFileSync(path.join(root,'lib/视频平台.js'),'utf8'),c);
  const page=P.parse('https://www.youtube.com/watch?v=tYvu6IpSfiM');
  const listed=await c.BiliCaptionPlatforms.readPage(page);
  const zh=listed.tracks.find(t=>t.autoTranslated);
  const result=await c.BiliCaptionPlatforms.readPage(page,zh.url);
  assert.equal(P.parseCues(result.raw)[0].content,'你好木头');
});

test('已有播放器 pot 时直接拉取，不再等 CC', async () => {
  const base='https://www.youtube.com/api/timedtext?v=tYvu6IpSfiM&lang=zh&signature=listed';
  const asked=[];
  const player={
    classList:{contains:()=>false},
    getPlayerResponse:()=>({videoDetails:{videoId:'tYvu6IpSfiM'},captions:{playerCaptionsTracklistRenderer:{captionTracks:[{baseUrl:base,languageCode:'zh'}]}}}),
    loadModule(){ asked.push('load'); },
    setOption(){ asked.push('set'); }
  };
  const c=vm.createContext({
    URL,AbortSignal,setTimeout,clearTimeout,
    location:{hostname:'www.youtube.com',href:'https://www.youtube.com/watch?v=tYvu6IpSfiM'},
    window:{},
    document:{querySelector:()=>null,getElementById:()=>player},
    fetch:async(href)=>{
      const u=new URL(href);
      if (u.searchParams.get('pot')!=='captured') return {ok:true,text:async()=>''};
      return {ok:true,text:async()=>JSON.stringify({events:[{tStartMs:0,dDurationMs:1000,segs:[{utf8:'已捕获'}]}]})};
    }
  });
  vm.runInContext(fs.readFileSync(path.join(root,'lib/视频平台.js'),'utf8'),c);
  const result=await c.BiliCaptionPlatforms.readPage(P.parse('https://www.youtube.com/watch?v=tYvu6IpSfiM'),base,base+'&pot=captured');
  assert.equal(P.parseCues(result.raw)[0].content,'已捕获');
  assert.deepEqual(asked,[]);
});

test('列出时的 url 和拉取时查询参数不同仍按 v/lang/kind 对齐', async () => {
  const listed='https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=en&kind=asr&signature=old&expire=1';
  const fresh='https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=en&kind=asr&signature=new&expire=9&pot=tok';
  const player={classList:{contains:()=>false},getPlayerResponse:()=>({videoDetails:{videoId:'aircAruvnKk'},captions:{playerCaptionsTracklistRenderer:{captionTracks:[{baseUrl:fresh,languageCode:'en',kind:'asr',isTranslatable:true}],translationLanguages:[{languageCode:'zh-Hans'}]}}})};
  const requests=[];
  const c=vm.createContext({URL,AbortSignal,location:{hostname:'www.youtube.com',href:'https://www.youtube.com/watch?v=aircAruvnKk'},window:{},document:{querySelector:()=>null,getElementById:()=>player},fetch:async(href)=>{requests.push(new URL(href));return {ok:true,text:async()=>JSON.stringify({events:[{tStartMs:0,dDurationMs:1000,segs:[{utf8:'Hello'}]}]})};}});
  vm.runInContext(fs.readFileSync(path.join(root,'lib/视频平台.js'),'utf8'),c);
  const page=P.parse('https://www.youtube.com/watch?v=aircAruvnKk');
  const listedZh=`${listed}&tlang=zh-Hans`;
  const result=await c.BiliCaptionPlatforms.readPage(page,listedZh);
  assert.equal(P.parseCues(result.raw)[0].content,'Hello');
  assert.equal(requests[0].searchParams.get('signature'),'new');
  assert.equal(requests[0].searchParams.get('tlang'),'zh-Hans');
  assert.equal(requests[0].searchParams.get('lang'),'en');
});

test('广告中只要正片身份已对齐就立刻读字幕，不把 throw 留给 executeScript', async () => {
  const url='https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=en';
  const player={
    classList:{contains:(name)=>name==='ad-showing'||name==='ad-interrupting'},
    getPlayerResponse:()=>({videoDetails:{videoId:'aircAruvnKk',title:'DuringAd',author:'A',lengthSeconds:'12'},captions:{playerCaptionsTracklistRenderer:{captionTracks:[{baseUrl:url,languageCode:'en'}]}}}),
    getVideoData:()=>({video_id:'aircAruvnKk'})
  };
  const c=vm.createContext({URL,AbortSignal,setTimeout,location:{hostname:'www.youtube.com',href:'https://www.youtube.com/watch?v=aircAruvnKk'},window:{},document:{querySelector:()=>null,getElementById:()=>player}});
  vm.runInContext(fs.readFileSync(path.join(root,'lib/视频平台.js'),'utf8'),c);
  const data=await c.BiliCaptionPlatforms.readPage(P.parse('https://www.youtube.com/watch?v=aircAruvnKk'),'','',0);
  assert.equal(data.title,'DuringAd');
  assert.equal(data.pending,undefined);
  assert.equal(data.tracks[0].url,url);
});

test('content.js 默认 12 秒结束 pending，侧栏也有同等超时', () => {
  const content=contentSource();
  const panel=panelSource();
  assert.match(content,/pendingGiveUpMs = 12000/);
  assert.match(panel,/Date\.now\(\) - pendingShownAt >= 12000/);
});

test('YouTube timedtext 429 立即停，不连打多格式', async () => {
  const url='https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=en';
  let requested=0;
  const player={
    classList:{contains:()=>false},
    getPlayerResponse:()=>({videoDetails:{videoId:'aircAruvnKk'},captions:{playerCaptionsTracklistRenderer:{captionTracks:[{baseUrl:url,languageCode:'en'}]}}}),
    loadModule(){},
    setOption(){}
  };
  const c=vm.createContext({
    URL,AbortSignal,setTimeout,clearTimeout,
    location:{hostname:'www.youtube.com',href:'https://www.youtube.com/watch?v=aircAruvnKk'},
    window:{},
    document:{querySelector:()=>null,getElementById:()=>player},
    fetch:async()=>{requested++;return {ok:false,status:429,text:async()=>''};}
  });
  vm.runInContext(fs.readFileSync(path.join(root,'lib/视频平台.js'),'utf8'),c);
  const result=await c.BiliCaptionPlatforms.readPage(P.parse('https://www.youtube.com/watch?v=aircAruvnKk'),url,url+'&pot=tok');
  assert.match(result.error,/限流/);
  assert.equal(requested,1);
});

test('X 媒体弹层把浮窗挂进 dialog，B 站和 YouTube 宿主逻辑仍在', () => {
  const content=contentSource();
  assert.match(content,/function isXMediaOverlay/);
  assert.match(content,/function getXDockHost/);
  assert.match(content,/\[role="dialog"\]/);
  assert.match(content,/isXMediaOverlay\(\)/);
  assert.match(content,/bpx-player-container/);
  assert.match(content,/#movie_player/);
  assert.match(content,/bc-dock-sidebar/);
  assert.match(content,/OPEN_FLOAT/);
  assert.match(content,/canGenerate = allowsAsr\(parsePage\(\)\.kind\)/);
  assert.doesNotMatch(content,/canGenerate = !\["youtube", "x"\]/);
});

test('切站点有缓存立刻出标题字幕，没缓存才 pending', () => {
  const panel=panelSource();
  assert.match(panel,/function siteSwitchLoadingState/);
  assert.match(panel,/function officialCacheIdentity/);
  assert.match(panel,/function stateFromOfficialCache/);
  assert.match(panel,/async function peekOfficialCache/);
  assert.match(panel,/const cached = await peekOfficialCache/);
  assert.match(panel,/renderState\(cached \|\| siteSwitchLoadingState/);
  assert.doesNotMatch(panel,/if \(switched\) \{\s*stopJobsForVideoSwitch\(\);\s*renderState\(siteSwitchLoadingState/);
  assert.match(panel,/const bypassCache = Boolean\(options\.force\)/);
  assert.match(panel,/force: bypassCache/);
  assert.match(panel,/type: bypassCache \|\| force \? "REFRESH" : "GET_STATE"/);
  const start=panel.indexOf('function officialCacheIdentity');
  const end=panel.indexOf('async function peekOfficialCache');
  const c=vm.createContext({ BiliCaptionPlatforms: P });
  vm.runInContext(panel.slice(start, end), c);
  const id=c.officialCacheIdentity('https://www.youtube.com/watch?v=aircAruvnKk');
  assert.equal(id.bvid,'yt_aircAruvnKk');
  const cached=c.stateFromOfficialCache({
    cues:[{from:0,to:1,content:'Hello'}],
    title:'Cached Title',
    up:'Uploader',
    pic:'https://i.ytimg.com/x.jpg',
    durationMeta:12,
    source:'youtube',
    activeLan:'en'
  }, id);
  assert.equal(cached.page,'video');
  assert.equal(cached.title,'Cached Title');
  assert.equal(cached.up,'Uploader');
  assert.equal(cached.cues[0].content,'Hello');
  assert.equal(cached.subtitleStatus,'');
  assert.equal(cached.notice,'');
  assert.notEqual(cached.page,'loading');
  assert.equal(c.stateFromOfficialCache({cues:[]}, id), null);
});

test('点重试立刻进入 pending，并挡住连点', () => {
  const panel=panelSource();
  assert.match(panel,/async function retrySubtitles/);
  assert.match(panel,/function retryLoadingState/);
  assert.match(panel,/if \(retrying\) return/);
  assert.match(panel,/subtitleStatus: "pending"/);
  assert.match(panel,/正在重试…/);
  assert.match(panel,/emptyRetryLink"\)\?\.addEventListener\("click", \(\) => retrySubtitles\(\)\)/);
  assert.match(panel,/else if \(errorMode === "retryState"\) retrySubtitles\(\)/);
  assert.match(panel,/await refresh\(true, \{ force: true \}\)/);
  assert.match(panel,/show\(ui\.emptyFetchHint, retrying\)/);
});

test('X 顶栏只用第一句并截到约 40 字，悬停保留更完整正文', () => {
  const body = `${'字'.repeat(60)}。后面这段不该出现在顶栏，但悬停要能看到。`;
  const headline = P.xHeadline({ text: body });
  assert.equal(Array.from(headline.title).length, 41);
  assert.match(headline.title, /…$/);
  assert.doesNotMatch(headline.title, /后面/);
  assert.match(headline.titleFull, /悬停/);
  assert.ok(Array.from(headline.titleFull).length <= 200);
  assert.equal(P.xHeadline({ author: '小由' }).title, '小由的视频');
  assert.equal(P.xHeadline({ pageTitle: 'X' }).title, '');
  assert.equal(P.xHeadline({ pageTitle: '开场白 / X' }).title, '开场白');
});

test('有字幕时不再显示等待视频，YouTube 标题不被推文规则截断', () => {
  const youtube = 'Hello. World is a long title that should stay intact for youtube videos and not be cut at the period or at forty characters.';
  assert.equal(P.headerLabel({ platform: 'youtube', page: 'video', bvid: 'yt_aircAruvnKk', title: youtube, cues: [{ content: 'a' }] }).text, youtube);
  assert.equal(P.headerLabel({ platform: 'x', page: 'video', bvid: 'x_1_1', cues: [{ content: 'a' }], up: '小由' }).text, '小由的视频');
  assert.equal(P.headerLabel({ platform: 'x', page: 'video', bvid: 'x_1_1', cues: [{ content: 'a' }] }).text, '视频');
  assert.equal(P.headerLabel({ page: 'video' }).text, '等待视频');
  assert.equal(P.headerLabel({ platform: 'youtube', page: 'loading' }).text, '正在读取视频信息…');
  const long = `${'字'.repeat(60)}。后面`;
  const label = P.headerLabel({ platform: 'x', page: 'video', bvid: 'x_1_1', title: long, cues: [{ content: 'a' }] });
  assert.equal(Array.from(label.text).length, 41);
  assert.match(label.tip, /后面/);
});

test('空态和限流不显示底栏行动条，分栏按视频页常驻', () => {
  const panel=panelSource();
  const draft=fs.readFileSync(path.join(root,'BiliCaption/BiliCaption Sidebar.dc.html'),'utf8');
  assert.match(draft,/showActionBar: !selActive/);
  assert.match(draft,/const hasList = !empty && !gen && !err/);
  assert.match(panel,/show\(ui\.actionBar, onCaptions && !hasSummary && !selectOpen\)/);
  assert.match(panel,/onCaptions = hasList && view === "captions"/);
  assert.match(panel,/hasList = onVideoReady && \(hasCues \|\| generating\)/);
  assert.match(panel,/show\(\$\("markerBar"\), onMarkers && markers\.length > 0\)/);
  assert.match(panel,/show\(ui\.viewTabs, !noScript && \(hasList \|\| onMarkers \|\| generating \|\| translating \|\| isEmpty \|\| isPending\)\)/);
  assert.match(panel,/view = "captions"/);
});
