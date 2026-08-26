const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

function loadOutline() {
  const context = { console };
  context.self = context;
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "lib/outline.js"), "utf8"), context);
  return context.BiliCaptionOutline;
}

function cues(n, step = 20) {
  return Array.from({ length: n }, (_, i) => ({
    from: i * step,
    to: (i + 1) * step,
    content: `cue ${i + 1}`
  }));
}

test("模型返回序号时，章节时间取自真实字幕", () => {
  const O = loadOutline();
  const list = O.finalizeOutline([
    { title: "开场", synopsis: "介绍", from: 1, to: 3 },
    { title: "正片", synopsis: "展开", from: 4, to: 8 }
  ], cues(8, 30));
  assert.equal(list[0].start, 0);
  assert.equal(list[0].end, 90);
  assert.equal(list[1].start, 90);
  assert.equal(list[1].end, 240);
});

test("末章序号缺失、为 0 或越界时接到上一章结尾，而不是 00:00", () => {
  const O = loadOutline();
  const list = cues(50, 12);
  const zero = O.finalizeOutline([
    { title: "前", synopsis: "a", from: 1, to: 20 },
    { title: "中", synopsis: "b", from: 21, to: 40 },
    { title: "后", synopsis: "c", from: 0, to: 0 }
  ], list);
  assert.ok(zero[2].start >= zero[1].end - 0.01);
  assert.ok(zero[2].end >= 50 * 12 - 1);
  assert.ok(zero[2].end - zero[2].start > 10);

  const missing = O.finalizeOutline([
    { title: "前", synopsis: "a", from: 1, to: 20 },
    { title: "后", synopsis: "c", title2: "x" }
  ], list);
  assert.ok(missing[1].start >= missing[0].end - 0.01);
  assert.ok(missing[1].end >= 50 * 12 - 1);

  const overflow = O.finalizeOutline([
    { title: "前", synopsis: "a", from: 1, to: 20 },
    { title: "后", synopsis: "c", from: 900, to: 999 }
  ], list);
  assert.ok(overflow[1].start >= overflow[0].end - 0.01);
  assert.ok(overflow[1].end >= 50 * 12 - 1);
});

test("空时间码不是 0 秒", () => {
  const O = loadOutline();
  assert.equal(Number.isNaN(O.parseClock(undefined)), true);
  assert.equal(Number.isNaN(O.parseClock("")), true);
  assert.equal(O.parseClock(0), 0);
});

test("模型把整段视频编成十几秒时，按字幕均分时间", () => {
  const O = loadOutline();
  const list = O.finalizeOutline([
    { title: "A", synopsis: "a", start: 0, end: 2 },
    { title: "B", synopsis: "b", start: 2, end: 4 },
    { title: "C", synopsis: "c", start: 4, end: 6 },
    { title: "D", synopsis: "d", start: 6, end: 8 }
  ], cues(40, 15));
  assert.ok(list[0].end - list[0].start >= 100);
  assert.ok(list[list.length - 1].end >= 500);
  assert.ok(list[0].start < list[1].start);
});

test("大纲提示词要求输出序号而不是秒数", () => {
  const O = loadOutline();
  const prompt = O.buildOutlinePrompt(cues(2, 10));
  assert.match(prompt, /from \/ to 必须是字幕行的序号/);
  assert.match(prompt, /1\t0\.0\t10\.0\tcue 1/);
  assert.match(prompt, /字段顺序必须是 summary、chapters/);
  assert.match(prompt, /80-150/);
});

test("解析新对象和旧数组缓存", () => {
  const O = loadOutline();
  const fromObject = O.parseOutlinePayload(JSON.stringify({
    summary: "  全片总览  ",
    chapters: [{ title: "开场", synopsis: "介绍", from: 1, to: 2 }]
  }));
  assert.equal(fromObject.summary, "全片总览");
  assert.equal(fromObject.chapters.length, 1);
  assert.equal(fromObject.chapters[0].title, "开场");

  const fromArray = O.parseOutlinePayload(JSON.stringify([
    { title: "旧章", synopsis: "旧摘要", from: 1, to: 3 }
  ]));
  assert.equal(fromArray.summary, "");
  assert.equal(fromArray.chapters[0].title, "旧章");

  const cached = O.normalizeOutlineRecord([
    { title: "缓存", start: 0, end: 12, synopsis: "x" }
  ]);
  assert.equal(cached.summary, "");
  assert.equal(cached.chapters.length, 1);
  assert.equal(cached.chapters[0].title, "缓存");
});

test("流式解析先取 summary 再扫 chapters", () => {
  const O = loadOutline();
  const partial = O.parseStreamingOutline(
    '{"summary": "从空场景搭建 Geometry Nodes',
    cues(4, 10)
  );
  assert.match(partial.summary, /Geometry Nodes/);
  assert.equal(partial.chapters.length, 0);

  const mixed = O.parseStreamingOutline(
    '{"summary": "总览一段话","chapters":[{"title":"环境搭建","synopsis":"搭场景","from":1,"to":2}',
    cues(4, 10)
  );
  assert.equal(mixed.summary, "总览一段话");
  assert.equal(mixed.chapters[0].title, "环境搭建");
  assert.equal(mixed.chapters[0].start, 0);
  assert.equal(mixed.chapters[0].end, 20);
});

test("超长字幕按约 20000 字切块，单行超长才硬切", () => {
  const O = loadOutline();
  const many = Array.from({ length: 6 }, (_, i) => ({
    from: i * 10,
    to: i * 10 + 10,
    content: "字".repeat(30)
  }));
  const chunks = O.chunkCueLines(many, 80);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((chunk) => chunk.length <= 80));
  assert.equal(chunks.join("\n"), many.map(O.formatCueLine).join("\n"));

  const long = [{ from: 0, to: 1, content: "x".repeat(250) }];
  const hard = O.chunkCueLines(long, 100);
  assert.ok(hard.length >= 3);
  assert.ok(hard.every((chunk) => chunk.length <= 100));
  assert.equal(hard.join(""), long.map(O.formatCueLine).join(""));
});

test("复制和 Markdown 在有总结时放最前，无总结时与现在一致", () => {
  const O = loadOutline();
  const chapters = [
    { start: 0, end: 12, title: "开场", synopsis: "介绍主题" },
    { start: 12, end: 40, title: "正片", synopsis: "展开内容" }
  ];
  const copyNow = O.formatOutlineCopy("", chapters);
  assert.equal(copyNow, "00:00–00:12 开场\n介绍主题\n\n00:12–00:40 正片\n展开内容");
  assert.equal(
    O.formatOutlineCopy("全片总览一段话", chapters),
    `全片总览一段话\n\n${copyNow}`
  );

  const mdNow = O.formatOutlineMarkdown("视频标题", "", chapters);
  assert.equal(mdNow, "# 视频标题\n\n## 00:00–00:12 开场\n\n介绍主题\n\n## 00:12–00:40 正片\n\n展开内容\n");
  assert.equal(
    O.formatOutlineMarkdown("视频标题", "全片总览一段话", chapters),
    "# 视频标题\n\n全片总览一段话\n\n## 00:00–00:12 开场\n\n介绍主题\n\n## 00:12–00:40 正片\n\n展开内容\n"
  );
});
