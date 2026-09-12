const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
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
  vm.runInContext(fs.readFileSync(path.join(root,'lib/markers.js'),'utf8'),context);
  const M=context.BiliCaptionMarkers;
  const md=M.toMarkdown({bvid:'yt_aircAruvnKk',title:'测试'},[{time:3,text:'重点'}]);
  assert.match(md,/youtube\.com\/watch\?v=aircAruvnKk&t=3s/);
  assert.doesNotMatch(md,/bilibili\.com/);
});

test('MAIN world 拒绝过期播放器身份，空字幕响应明确报错', async () => {
  let requested = 0;
  const player = {classList:{contains:()=>false},getPlayerResponse:()=>({videoDetails:{videoId:'oldvideo000'},captions:{}})};
  const c=vm.createContext({URL,AbortSignal, location:{hostname:'www.youtube.com',href:'https://www.youtube.com/watch?v=aircAruvnKk'},window:{},document:{querySelector:()=>null,getElementById:()=>player},fetch:async()=>{requested++;return {ok:true,text:async()=>''};}});
  vm.runInContext(fs.readFileSync(path.join(root,'lib/视频平台.js'),'utf8'),c);
  const page=P.parse('https://www.youtube.com/watch?v=aircAruvnKk');
  await assert.rejects(c.BiliCaptionPlatforms.readPage(page),/尚未就绪/);
  assert.equal(requested,0);
  const url='https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=en';
  player.getPlayerResponse=()=>({videoDetails:{videoId:page.videoId},captions:{playerCaptionsTracklistRenderer:{captionTracks:[{baseUrl:url,languageCode:'en'}]}}});
  await assert.rejects(c.BiliCaptionPlatforms.readPage(page,url),/未返回字幕内容/);
  assert.equal(requested,1);
  await assert.rejects(c.BiliCaptionPlatforms.readPage(page,'https://evil.test/'),/字幕轨已失效/);
  assert.equal(requested,1);
});

test('切换视频时清掉旧字幕，旧异步响应不能覆盖新视频', async () => {
  const code=fs.readFileSync(path.join(root,'content.js'),'utf8');
  const fn=code.slice(code.indexOf('  async function loadState()'),code.indexOf('  async function switchTrack'));
  let page={kind:'youtube',bvid:'yt_video000001',cid:1}, resolveFirst;
  const c=vm.createContext({loadToken:0,loadingPageKey:'',lastStateKey:'old',cachedState:{cues:[{content:'旧字幕'}]},targetRate:1,
    parsePage:()=>page,pageKey:(p=page)=>p.bvid,clearCueLoop(){},setOverlayCues(){},setProgressMarks(){},emptyState:(page,extra)=>({page,cues:[],...extra}),getVideo:()=>null,hookVideo(){},pullProgressMarks(){},
    askBackground:()=>new Promise(resolve=>{resolveFirst=resolve;})});
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
