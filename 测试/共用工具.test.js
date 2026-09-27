const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { read, runFile, backgroundSource, panelSource, contentSource } = require("./源码加载.js");

function load(files, extra = {}) {
  const context = vm.createContext({ URL, ...extra });
  for (const file of files) runFile(context, file);
  return context;
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test("时间标签统一：不足 1 小时 mm:ss，满 1 小时 h:mm:ss", () => {
  const { formatClock } = load(["lib/字幕工具.js"]).BiliCaptionCueTools;
  assert.equal(formatClock(0), "00:00");
  assert.equal(formatClock(59.9), "00:59");
  assert.equal(formatClock(754), "12:34");
  assert.equal(formatClock(3599), "59:59");
  assert.equal(formatClock(3600), "1:00:00");
  assert.equal(formatClock(3725), "1:02:05");
  assert.equal(formatClock(36000 + 61), "10:01:01");
  assert.equal(formatClock(-5), "00:00");
  assert.equal(formatClock("abc"), "00:00");
});

test("标记导出、大纲复制也用同一个时间格式（超过 1 小时带小时）", () => {
  const store = {};
  const context = load(["lib/字幕工具.js", "lib/markers.js", "lib/outline.js"], {
    chrome: { storage: { local: { async get(key) { return { [key]: store[key] }; }, async set(values) { Object.assign(store, values); } } } }
  });
  const M = context.BiliCaptionMarkers;
  assert.match(M.toMarkdown({ bvid: "BV1xx411c7mD", title: "长视频" }, [{ time: 3725, text: "后半段" }]), /\[1:02:05\]/);
  assert.match(M.copyText([{ time: 65, text: "开头" }], "BV1xx411c7mD"), /^01:05 {2}开头/);
  const O = vm.runInContext("BiliCaptionOutline", context);
  assert.equal(O.formatOutlineCopy("", [{ start: 3600, end: 3725, title: "章", synopsis: "要" }]), "1:00:00–1:02:05 章\n要");
});

test("找回译文：后台写缓存和内容脚本收字幕共用一份实现", () => {
  const { preserveTranslatedCues, cueHasCjk, cueOverlap } = load(["lib/字幕工具.js"]).BiliCaptionCueTools;
  assert.equal(cueHasCjk("hello"), false);
  assert.equal(cueHasCjk("你好 hello"), true);
  assert.equal(cueOverlap({ from: 0, to: 2 }, { from: 1, to: 3 }), 1);
  assert.ok(cueOverlap({ from: 0, to: 1 }, { from: 2, to: 3 }) < 0);
  const incoming = [
    { from: 0, to: 2, content: "hello there" },
    { from: 2, to: 4, content: "已经是中文" },
    { from: 10, to: 12, content: "no match" }
  ];
  const existing = [{ from: 0.1, to: 2, content: "你好", original: "hi" }];
  assert.deepEqual(plain(preserveTranslatedCues(incoming, existing)), [
    { from: 0, to: 2, content: "你好", original: "hello there" },
    { from: 2, to: 4, content: "已经是中文" },
    { from: 10, to: 12, content: "no match" }
  ]);
  // 没有旧译文时原样返回；传进来的不是数组也不报错
  assert.equal(preserveTranslatedCues(incoming, []), incoming);
  assert.deepEqual(plain(preserveTranslatedCues(null, existing)), []);
});

test("选择键和输入框判断：侧栏与内容脚本共用", () => {
  const { isTypingTarget, keyLabel, matchesKey } = load(["lib/字幕工具.js"]).BiliCaptionCueTools;
  assert.equal(keyLabel("a"), "A");
  assert.equal(keyLabel("Shift"), "Shift");
  assert.equal(matchesKey({ key: "shift" }, "Shift"), true);
  assert.equal(matchesKey({ key: "Alt" }, ""), false);
  assert.equal(matchesKey({ key: "Shift" }, ""), true);
  assert.equal(matchesKey({}, "Shift"), false);
  assert.equal(isTypingTarget(null), false);
  assert.equal(isTypingTarget({ tagName: "TEXTAREA" }), true);
  assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: "DIV", closest: () => null }), false);
});

test("重复实现已合并：各处不再各留一份", () => {
  const background = backgroundSource();
  const panel = panelSource();
  const content = contentSource();
  const libs = ["lib/markers.js", "lib/outline.js", "lib/translate.js", "lib/webdav.js"].map(read).join("\n");
  const everywhere = [background, panel, content, read("options.js"), read("library.js"), libs].join("\n");
  for (const name of ["cueHasCjk", "cueOverlap", "mergeTranslatedCues", "preserveCueText", "formatTime", "formatMarkClock", "fmt", "formatClock", "isTypingTarget", "matchesSelKey", "keyLabel", "toSimplified"]) {
    assert.doesNotMatch(everywhere, new RegExp(`function ${name}\\(`), `${name} 还有副本`);
  }
  // joinCueText 只在 lib/translate.js；toSimplified 只在 lib/zh-simp.js；listLocalKeys 只在 lib/webdav.js
  assert.doesNotMatch(background, /function joinCueText\(|function listLocalKeys\(|function readDockUiPrefs\(/);
  assert.doesNotMatch(panel, /function readDockUiPrefs\(|function formatWait\(|function cueLooksEnglish\(|function normalizeChapter\(/);
  // 转写进度的「已完成 / 总段数」只有一处算法
  assert.equal((background.match(/lastCueTo \/ \(8 \* 60\)/g) || []).length, 1);
});

test("支持站点的域名只在 lib/视频平台.js 列一份（manifest 和注入页面的函数除外）", () => {
  const P = load(["lib/视频平台.js"]).BiliCaptionPlatforms;
  assert.deepEqual(plain(P.TAB_URL_PATTERNS), [
    "*://*.bilibili.com/*", "*://*.youtube.com/*", "*://youtube.com/*",
    "*://x.com/*", "*://www.x.com/*", "*://twitter.com/*", "*://www.twitter.com/*"
  ]);
  assert.deepEqual(plain(P.YOUTUBE_CUE_URL_PATTERNS), [
    "https://www.youtube.com/api/timedtext*", "https://youtube.com/api/timedtext*", "https://m.youtube.com/api/timedtext*"
  ]);
  assert.equal(P.isSupportedHost("space.bilibili.com"), true);
  assert.equal(P.isSupportedHost("M.YOUTUBE.COM"), true);
  assert.equal(P.isSupportedHost("twitter.com"), true);
  assert.equal(P.isSupportedHost("evil-bilibili.com"), false);
  assert.equal(P.isSupportedHost("youtube.com.evil.io"), false);
  for (const source of [backgroundSource(), panelSource(), contentSource()]) {
    assert.doesNotMatch(source, /youtube\.com|twitter\.com|["']x\.com/);
  }
});
