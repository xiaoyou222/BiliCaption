// YouTube 自动字幕（滚动式 ASR json3）拼句。夹具是真实视频字幕截取的前几十个 event：
// asr-grok-bot（Grok Bot Is Now Only $20 - Here Are 9 Wild Use Cases）、
// asr-slice-of-life（slice of life 🛋️ 12hr work days…，含 >> 说话人标记和 [music] [laughter]）、
// asr-cozy-day / manual-cozy-day（a cozy day in the life，同一视频的自动字幕与人工字幕）。
// manual-cozy-day.expected.json 是改动前的解析结果，人工字幕必须与之完全一致。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { runFile } = require('./源码加载.js');

const root = path.resolve(__dirname, '..');
const dir = path.join(root, '测试/夹具/youtube-json3');
const load = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const plain = (v) => JSON.parse(JSON.stringify(v));

const context = vm.createContext({ URL, console });
context.self = context;
context.globalThis = context;
for (const file of ['lib/视频平台.js', 'lib/translate.js', 'lib/zh-simp.js', '后台/切句.js']) runFile(context, file);
const P = context.BiliCaptionPlatforms;

const ASR = ['asr-grok-bot.json', 'asr-slice-of-life.json', 'asr-cozy-day.json'];
const letters = (text) => String(text).replace(/\s+/g, '').length;

test('滚动式自动字幕：时间单调、相邻句不重叠、句数远少于原始 event', () => {
  for (const name of ASR) {
    const data = load(name);
    const cues = P.parseCues(JSON.stringify(data));
    assert.ok(cues.length > 0, name);
    const lines = data.events.filter((e) => e.segs && !e.aAppend).length;
    assert.ok(cues.length < lines, `${name}：${cues.length} 句应少于 ${lines} 行`);
    assert.ok(cues.length <= data.events.length / 2, `${name}：${cues.length} 句 / ${data.events.length} event`);
    cues.forEach((cue, i) => {
      assert.equal(cue.sid, i + 1);
      assert.ok(cue.to > cue.from, `${name} 第 ${i + 1} 句时长为正`);
      if (i) {
        assert.ok(cue.from >= cues[i - 1].from, `${name} 第 ${i + 1} 句开始时间单调`);
        assert.ok(cue.from >= cues[i - 1].to, `${name} 第 ${i} / ${i + 1} 句不重叠`);
      }
      assert.ok(letters(cue.content) <= 72, `${name} 第 ${i + 1} 句过长：${cue.content}`);
      assert.ok(cue.to - cue.from <= 16, `${name} 第 ${i + 1} 句过久`);
      assert.doesNotMatch(cue.content, /\n|>>|\[[^\]]*\]/, `${name} 残留换行 / 说话人标记 / 声音标注：${cue.content}`);
    });
  }
});

test('滚动式自动字幕：逐词片段拼回完整句子，时间取首词开始、末词结束', () => {
  const cues = P.parseCues(load('asr-grok-bot.json'));
  const texts = cues.map((c) => c.content);
  assert.ok(texts.includes("The more I use it, the more I'm blown away by what it can do."));
  assert.ok(texts.includes('This video is sponsored by SpaceX, the company behind Grockbot.'));
  assert.ok(texts.includes("It's a deep dive into the bots that I use and how I set them up."));
  // 原始 event 把这句拆成三行（"The more I use it, the more I'm blown" 在 8320ms 开始）
  const one = cues.find((c) => c.content.startsWith('The more I use it'));
  assert.equal(one.from, 8.32);
  // 所有原文词都在，顺序不变（去掉标点比较）
  const words = (s) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
  const source = load('asr-grok-bot.json').events.flatMap((e) => (e.segs || []).map((s) => s.utf8)).join(' ');
  assert.deepEqual(words(texts.join(' ')), words(source));
  // 大部分句子以句末标点收尾（逗号处断开的长句除外）
  const ended = texts.filter((t) => /[.!?]$/.test(t)).length;
  assert.ok(ended / texts.length >= 0.5, `${ended}/${texts.length}`);
});

test('滚动式自动字幕：声音标注和说话人标记去掉，并在该处断句', () => {
  const cues = P.parseCues(load('asr-slice-of-life.json'));
  const texts = cues.map((c) => c.content);
  assert.equal(texts[0], 'Hey.');
  assert.equal(texts[1], 'Details back to SCHOOL SEASON.');
  assert.ok(!texts.some((t) => /music|laughter/i.test(t)));
  const cozy = P.parseCues(load('asr-cozy-day.json')).map((c) => c.content);
  assert.ok(!cozy.some((t) => /Music|Applause/.test(t)));
  assert.equal(cozy[0], 'for');
});

test('滚动式自动字幕：切出的每句都不会被 后台/切句.js 再按长度切开', () => {
  for (const name of ASR) {
    for (const cue of P.parseCues(load(name))) {
      const parts = context.splitLongCue(cue, []);
      assert.equal(parts.length, 1, `${name}：${cue.content}`);
    }
  }
});

test('人工字幕（无 aAppend / 词级偏移）解析结果与改动前完全一致', () => {
  const raw = fs.readFileSync(path.join(dir, 'manual-cozy-day.json'), 'utf8');
  assert.deepEqual(plain(P.parseCues(raw)), load('manual-cozy-day.expected.json'));
  assert.deepEqual(plain(P.parseCues(JSON.parse(raw))), load('manual-cozy-day.expected.json'));
});

test('构造的滚动式片段：aAppend 追加的词、词级偏移、声音标注与句末断句', () => {
  const cues = P.parseCues({ events: [
    { tStartMs: 0, dDurationMs: 90000, id: 1, wpWinPosId: 1, wsWinStyleId: 1 },
    { tStartMs: 1000, dDurationMs: 4000, wWinId: 1, segs: [{ utf8: 'so' }, { utf8: ' today', tOffsetMs: 300 }, { utf8: ' we', tOffsetMs: 700 }] },
    { tStartMs: 1900, dDurationMs: 3100, wWinId: 1, aAppend: 1, segs: [{ utf8: ' talk', tOffsetMs: 0 }, { utf8: ' about', tOffsetMs: 300 }] },
    { tStartMs: 2500, wWinId: 1, aAppend: 1, segs: [{ utf8: '\n' }] },
    { tStartMs: 2510, dDurationMs: 4000, wWinId: 1, segs: [{ utf8: 'cats.' }, { utf8: ' Dogs', tOffsetMs: 500 }, { utf8: ' too.', tOffsetMs: 800 }] },
    { tStartMs: 3600, wWinId: 1, aAppend: 1, segs: [{ utf8: '\n' }] },
    { tStartMs: 3610, dDurationMs: 2000, wWinId: 1, segs: [{ utf8: '[Applause]' }] },
    { tStartMs: 6000, dDurationMs: 2000, wWinId: 1, segs: [{ utf8: '>> Yes' }, { utf8: ' (laughs)', tOffsetMs: 200 }, { utf8: ' (really)', tOffsetMs: 400 }] }
  ] });
  assert.deepEqual(plain(cues), [
    // 末词结束取下一词开始；声音标注开始处也算上一词的结束
    { from: 1, to: 3.01, content: 'so today we talk about cats.', sid: 1 },
    { from: 3.01, to: 3.61, content: 'Dogs too.', sid: 2 },
    // (laughs) 是声音标注，去掉并断句；(really) 不是声音词，保留原文
    { from: 6, to: 6.2, content: 'Yes', sid: 3 },
    { from: 6.4, to: 7.9, content: '(really)', sid: 4 }
  ]);
});

test('识别规则：只有 aAppend 没有窗口 / 词偏移，或只有窗口没有 aAppend，都按普通字幕处理', () => {
  const plainRows = { events: [
    { tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: 'Hello' }] },
    { tStartMs: 1000, dDurationMs: 3000, aAppend: 1, segs: [{ utf8: 'world' }] }
  ] };
  assert.equal(P.parseCues(plainRows).length, 2);
  const windowOnly = { events: [
    { tStartMs: 0, dDurationMs: 3000, wWinId: 1, segs: [{ utf8: 'One.' }] },
    { tStartMs: 1000, dDurationMs: 3000, wWinId: 1, segs: [{ utf8: 'Two' }] }
  ] };
  assert.deepEqual(plain(P.parseCues(windowOnly)).map((c) => [c.from, c.to]), [[0, 3], [1, 4]]);
});

test('空 / 异常输入不报错', () => {
  for (const raw of [null, {}, { events: null }, { events: [] }, { events: [null, 1, 'x', { segs: null }] },
    { events: [{ wWinId: 1, aAppend: 1, segs: [{ utf8: '\n' }] }, { tStartMs: 'bad', wWinId: 1, segs: [{ utf8: 'x', tOffsetMs: 5 }] }] },
    { events: [{ tStartMs: 0, wWinId: 1, aAppend: 1, segs: [null, { utf8: '[Music]' }, {}] }, { tStartMs: 10, wWinId: 1, segs: [{ tOffsetMs: 3 }] }] }]) {
    assert.deepEqual(plain(P.parseCues(raw)), [], JSON.stringify(raw));
  }
  // 只有一个词、没有时长
  const one = P.parseCues({ events: [{ tStartMs: 500, wWinId: 1, segs: [{ utf8: 'hi', tOffsetMs: 0 }] }, { tStartMs: 900, wWinId: 1, aAppend: 1, segs: [{ utf8: '\n' }] }] });
  assert.deepEqual(plain(one), [{ from: 0.5, to: 2, content: 'hi', sid: 1 }]);
});
