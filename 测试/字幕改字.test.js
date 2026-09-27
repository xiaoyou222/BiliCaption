const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("path");
const vm = require("node:vm");
const { panelSource, runFile } = require("./源码加载.js");

const root = path.resolve(__dirname, "..");

function loadTranslate() {
  const context = { console };
  context.self = context;
  context.window = context;
  vm.createContext(context);
  for (const file of ["lib/zh-simp.js", "lib/translate.js"]) runFile(context, file);
  return context.BiliCaptionTranslate;
}

function bilingual() {
  return [
    { from: 1, to: 2, content: "所以接到 Set Position", original: "so plug into Set Position" },
    { from: 2, to: 3, content: "再接到 Set Position", original: "then plug into Set Position" },
    { from: 3, to: 4, content: "完成", original: "done" }
  ];
}

test("cueEditField：中文改 content，有原文的 EN 改 original，没有则改 content", () => {
  const T = loadTranslate();
  const both = { content: "中文", original: "English" };
  assert.equal(T.cueEditField(both, "zh"), "content");
  assert.equal(T.cueEditField(both, "en"), "original");
  assert.equal(T.cueEditField({ content: "hello" }, "en"), "content");
  assert.equal(T.cueEditField({ content: "中文", original: "  " }, "en"), "content");
});

test("countTerm 含草稿覆盖；1 次仍是 1；空或换行词为 0；不扫另一语言", () => {
  const T = loadTranslate();
  const cues = bilingual();
  assert.equal(T.countTerm(cues, "content", "接到"), 2);
  assert.equal(T.countTerm(cues, "content", "接到", 0, "没有这个词"), 1);
  assert.equal(T.countTerm(cues, "content", "接到", 0, "接到 接到 接到"), 4);
  assert.equal(T.countTerm(cues, "original", "plug"), 2);
  assert.equal(T.countTerm(cues, "original", "接到"), 0);
  assert.equal(T.countTerm(cues, "content", "plug"), 0);
  assert.equal(T.countTerm([{ content: "hello world" }], "content", "hello"), 1);
  assert.equal(T.countTerm(cues, "content", ""), 0);
  assert.equal(T.countTerm(cues, "content", "接\n到"), 0);
  assert.equal(T.countTerm(cues, "content", null), 0);
});

test("replaceTerm 精确计数，不改另一语言字段和 from/to", () => {
  const T = loadTranslate();
  const cues = bilingual();
  const first = cues[0];
  const { cues: next, n } = T.replaceTerm(cues, "content", "接到", "连到");
  assert.equal(n, 2);
  assert.equal(next[0].content, "所以连到 Set Position");
  assert.equal(next[1].content, "再连到 Set Position");
  assert.equal(next[2].content, "完成");
  assert.equal(next[0].original, "so plug into Set Position");
  assert.equal(next[1].original, "then plug into Set Position");
  assert.equal(next[0].from, 1);
  assert.equal(next[0].to, 2);
  assert.equal(cues[0].content, "所以接到 Set Position");
  assert.equal(first.content, "所以接到 Set Position");
  assert.notEqual(next, cues);
  assert.notEqual(next[0], cues[0]);

  const en = T.replaceTerm(cues, "original", "plug", "jack");
  assert.equal(en.n, 2);
  assert.equal(en.cues[0].original, "so jack into Set Position");
  assert.equal(en.cues[0].content, "所以接到 Set Position");
});

test("replaceTerm 空 to 或换行 term 不替换", () => {
  const T = loadTranslate();
  const cues = bilingual();
  const empty = T.replaceTerm(cues, "content", "接到", "  ");
  assert.equal(empty.n, 0);
  assert.equal(empty.cues[0].content, "所以接到 Set Position");
  assert.notEqual(empty.cues, cues);

  const blank = T.replaceTerm(cues, "content", "接到", "");
  assert.equal(blank.n, 0);
  assert.equal(blank.cues[0].content, "所以接到 Set Position");

  const nl = T.replaceTerm(cues, "content", "接\n到", "连到");
  assert.equal(nl.n, 0);
  assert.equal(nl.cues[0].content, "所以接到 Set Position");
});

test("replaceTerm 不循环替换，to 可含 term", () => {
  const T = loadTranslate();
  const cues = [{ from: 0, to: 1, content: "aa aa", original: "keep" }];
  const { cues: next, n } = T.replaceTerm(cues, "content", "aa", "aaX");
  assert.equal(n, 2);
  assert.equal(next[0].content, "aaX aaX");
  assert.equal(next[0].original, "keep");
});

test("replaceTerm 按字面量子串，不走正则", () => {
  const T = loadTranslate();
  const cues = [{ from: 0, to: 1, content: "a.b a.b axb", original: "keep" }];
  const { cues: next, n } = T.replaceTerm(cues, "content", "a.b", "X");
  assert.equal(n, 2);
  assert.equal(next[0].content, "X X axb");
  assert.equal(next[0].original, "keep");
});

test("侧栏：双击进入编辑，SYNC_CUES 带身份，生成中禁止，选区出替换条，时间码不是 input", () => {
  const panel = panelSource();
  assert.match(panel, /ui\.cueList\.addEventListener\("dblclick"/);
  assert.match(panel, /function startCueEdit/);
  assert.match(panel, /function startCueEdit\([\s\S]*?if \(generating \|\| translating\) return;/);
  assert.match(panel, /function persistEditedCues\([\s\S]*?type: "SYNC_CUES"[\s\S]*?bvid:[\s\S]*?cid:/);
  const persist = panel.match(/function persistEditedCues\([\s\S]*?\n\}\n/)?.[0] || "";
  assert.doesNotMatch(persist, /SWITCH_TRACK/);
  assert.match(panel, /ta\.addEventListener\("select", onCueEditSelect\)/);
  assert.match(panel, /function onCueEditSelect/);
  assert.match(panel, /「\$\{cueEdit\.term\}」· 共 \$\{cueEdit\.termCount\} 处/);
  assert.match(panel, /全部替换/);
  assert.match(panel, /已替换 \$\{n\} 处「\$\{term\}」/);
  assert.match(panel, /先输入要替换成什么/);
  assert.match(panel, /function cancelCueEdit/);
  assert.match(panel, /if \(cueEdit\) \{\s*event\.preventDefault\(\);\s*return;/);
  assert.match(panel, /if \(index === cueEdit\.index\) event\.preventDefault\(\);\s*else ignoreCueClickUntil/);
  assert.match(panel, /function startCueEdit\([\s\S]*?commitCueEdit\(\);[\s\S]*?state\?\.cues/);
  assert.match(panel, /function startCueEdit\([\s\S]*?originalForCue/);
  assert.match(panel, /wrap\.contains\(event\.relatedTarget\)/);
  assert.match(panel, /function patchCueTexts\([\s\S]*?cueEdit\.index\) continue/);
  assert.match(panel, /placeholder = "替换为"/);
  assert.doesNotMatch(panel, /编辑模式|btnEditCaptions|查找替换/);

  const build = panel.match(/function buildCueRows\([\s\S]*?\n\}\n\nfunction patchCueTexts/)?.[0] || "";
  assert.match(build, /createElement\("time"\)/);
  assert.doesNotMatch(build, /createElement\("input"\)/);
  assert.match(build, /className = "cue-text"/);
});

test("更多菜单仍无导入 / 查找替换", () => {
  const html = fs.readFileSync(path.join(root, "sidepanel.html"), "utf8");
  const more = html.match(/id="moreMenu"[\s\S]*?<\/div>/)?.[0] || "";
  assert.match(more, /btnSrt/);
  assert.match(more, /btnTranslate/);
  assert.doesNotMatch(more, /导入/);
  assert.doesNotMatch(more, /查找替换/);
  assert.doesNotMatch(html, /查找替换|导入字幕/);
});

test("CSS：编辑行与替换条样式", () => {
  const css = fs.readFileSync(path.join(root, "sidepanel.css"), "utf8");
  assert.match(css, /\.cue\.editing/);
  assert.match(css, /content-visibility:\s*visible/);
  assert.match(css, /\.cue-edit-text/);
  assert.match(css, /border:\s*1px solid rgba\(77,142,240,\.5\)/);
  assert.match(css, /background:\s*#0F1114/);
  assert.match(css, /\.cue-replace/);
  assert.match(css, /\.cue-replace-label/);
  assert.match(css, /font-size:\s*10\.5px/);
  assert.match(css, /\.cue-replace-btn:disabled/);
  assert.match(css, /opacity:\s*\.45/);
});
