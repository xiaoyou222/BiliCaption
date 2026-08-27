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

test("相邻字幕时间重叠时，章节仍共用唯一边界", () => {
  const O = loadOutline();
  const list = O.finalizeOutline([
    { title: "前章", synopsis: "前", from: 1, to: 2 },
    { title: "后章", synopsis: "后", from: 3, to: 4 }
  ], [
    { from: 0, to: 10, content: "a" },
    { from: 10, to: 20.6, content: "b" },
    { from: 20.1, to: 30, content: "c" },
    { from: 30, to: 40, content: "d" }
  ]);

  assert.equal(list[0].end, 20.6);
  assert.equal(list[1].start, list[0].end);
  const clickedTime = list[1].start;
  const active = list.findIndex((ch) => clickedTime >= ch.start && clickedTime < ch.end);
  assert.equal(active, 1);
});

test("播放器落点比章节起点早一个媒体帧时，高亮点击的后一章小节", () => {
  const O = loadOutline();
  const chapters = [
    {
      start: 3799,
      end: 4821.6,
      title: "状态、成本与幻觉",
      subs: [
        { start: 4653, end: 4821.6, title: "忠实性幻觉与处理决策树" }
      ]
    },
    {
      start: 4821.11,
      end: 5762,
      title: "工作量、模型选择与子代理",
      subs: [
        { start: 4821.11, end: 4939, title: "工作量级别的质量与成本权衡" }
      ]
    }
  ];
  const playerTime = 4821.10984;

  // 旧的区间 findIndex 会先命中仍未结束的上一章。
  assert.equal(chapters.findIndex((ch) => playerTime >= ch.start && playerTime < ch.end), 0);
  const activePosition = O.activeOutlinePosition(chapters, playerTime);
  assert.equal(activePosition.chapterIndex, 1);
  assert.equal(activePosition.subIndex, 0);

  const clearlyBefore = O.activeOutlinePosition(chapters, 4821.05);
  assert.equal(clearlyBefore.chapterIndex, 0);
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

function longCues() {
  return cues(24, 60);
}

test("满 20 分钟才出两级，短片提示词不要小节", () => {
  const O = loadOutline();
  assert.equal(O.BRIEF_MAX_SECONDS, 20 * 60);
  assert.equal(O.outlineLayout([{ from: 0, to: 1199, content: "a" }]).mode, "flat");
  assert.equal(O.outlineLayout([{ from: 0, to: 1200, content: "a" }]).mode, "nested");

  const shortPrompt = O.buildOutlinePrompt(cues(2, 10));
  assert.match(shortPrompt, /不要小节/);
  assert.doesNotMatch(shortPrompt, /不要按固定时钟切/);

  const longPrompt = O.buildOutlinePrompt(longCues());
  assert.match(longPrompt, /subs/);
  assert.match(longPrompt, /不要按固定时钟切/);
  assert.match(longPrompt, /from \/ to 必须是字幕行的序号/);
  assert.doesNotMatch(longPrompt, /不要小节，不要 subs/);
});

test("解析带小节的章节，行号超出章范围时夹紧", () => {
  const O = loadOutline();
  const list = O.finalizeOutline([
    {
      title: "章一",
      synopsis: "摘",
      from: 1,
      to: 10,
      subs: [
        { title: "点一", from: 1, to: 3 },
        { title: "点二", from: 4, to: 99 }
      ]
    }
  ], longCues());
  assert.equal(list[0].title, "章一");
  assert.equal(list[0].subs.length, 2);
  assert.equal(list[0].subs[0].title, "点一");
  assert.ok(list[0].subs[1].end <= list[0].end + 0.01);
  assert.ok(list[0].subs[1].start >= list[0].start - 0.01);
});

test("短视频 finalize 丢掉模型多写的小节", () => {
  const O = loadOutline();
  const list = O.finalizeOutline([
    {
      title: "开场",
      synopsis: "介绍",
      from: 1,
      to: 3,
      subs: [{ title: "不该出现", from: 1, to: 2 }]
    }
  ], cues(8, 10));
  assert.equal(list[0].title, "开场");
  assert.equal(list[0].subs, undefined);
});

test("流式解析能收嵌套小节，半截对象也能出章", () => {
  const O = loadOutline();
  const full = O.parseOutlinePayload(JSON.stringify({
    summary: "总览一段话",
    chapters: [{
      title: "章一",
      synopsis: "摘",
      from: 1,
      to: 8,
      subs: [
        { title: "小节A", from: 1, to: 4 },
        { title: "小节B", from: 5, to: 8 }
      ]
    }]
  }));
  const done = O.finalizeOutline(full.chapters, longCues());
  assert.equal(full.summary, "总览一段话");
  assert.equal(done[0].subs.length, 2);
  assert.equal(done[0].subs[0].title, "小节A");

  const mixed = O.parseStreamingOutline(
    '{"summary":"总览一段话","chapters":[{"title":"章一","synopsis":"摘","from":1,"to":8,"subs":[{"title":"小节A","from":1,"to":4},{"title":"小节B","from":5,"to":8}]}]}',
    longCues()
  );
  assert.equal(mixed.summary, "总览一段话");
  assert.equal(mixed.chapters[0].title, "章一");
  assert.equal(mixed.chapters[0].subs.length, 2);

  const partial = O.parseStreamingOutline(
    '{"summary":"总览一段话","chapters":[{"title":"章一","synopsis":"摘","from":1,"to":8,"subs":[{"title":"小节A","from":1,"to":4}',
    longCues()
  );
  assert.equal(partial.chapters[0].title, "章一");
  assert.equal(partial.chapters[0].subs.length, 1);
  assert.equal(partial.chapters[0].subs[0].title, "小节A");
});

test("侧栏有简略详情切换和章节小节结构", () => {
  const html = fs.readFileSync(path.join(root, "sidepanel.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "sidepanel.css"), "utf8");
  const panel = fs.readFileSync(path.join(root, "sidepanel.js"), "utf8");
  const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
  assert.match(html, /id="outlineMeta"/);
  assert.match(html, /data-density="brief"/);
  assert.match(html, /data-density="detail"/);
  assert.match(css, /\.outline-density button\.active/);
  assert.match(css, /\.chapter-sub\b/);
  assert.match(panel, /function setOutlineDensity/);
  assert.match(panel, /chapter-expand/);
  assert.match(panel, /outlineHasSubs/);
  assert.match(panel, /closest\("\.chapter-start, \.chapter-end"\)/);
  assert.match(panel, /function scrollOutlineIntoView/);
  assert.match(panel, /activeOutlinePosition\?\.\(outline, currentTime\)/);
  assert.match(panel, /state\.currentTime = time;\s*renderOutlineActive\(time\);/);
  assert.match(content, /const sendTime = \(\{ force = false \} = \{\}\) =>/);
  assert.match(content, /if \(!force && now - lastSent < 120\) return;/);
  assert.match(content, /sendTime\(\{ force: true \}\);/);
  assert.doesNotMatch(panel, /querySelectorAll\("\.chapter"\)/);
  assert.doesNotMatch(panel, /renderOutlineActive\(next\.currentTime \|\| 0, \{ forceScroll: true \}\)/);
});

test("旧缓存无小节仍能 parse，复制和 Markdown 有小节时缩进", () => {
  const O = loadOutline();
  const cached = O.normalizeOutlineRecord({
    summary: "旧总结",
    chapters: [{ title: "缓存", start: 0, end: 12, synopsis: "x" }]
  });
  assert.equal(cached.summary, "旧总结");
  assert.equal(cached.chapters[0].subs, undefined);

  const withSubs = [
    {
      start: 48,
      end: 97,
      title: "字段与点云分布",
      synopsis: "字段是逐元素求值。",
      subs: [
        { start: 48, end: 62, title: "字段不是单个数值" },
        { start: 62, end: 79, title: "Distribute Points 生成点云" }
      ]
    }
  ];
  assert.equal(
    O.formatOutlineCopy("", withSubs),
    "00:48–01:37 字段与点云分布\n字段是逐元素求值。\n  00:48 字段不是单个数值\n  01:02 Distribute Points 生成点云"
  );
  assert.equal(
    O.formatOutlineMarkdown("视频标题", "", withSubs),
    "# 视频标题\n\n## 00:48–01:37 字段与点云分布\n\n字段是逐元素求值。\n\n- 00:48 字段不是单个数值\n- 01:02 Distribute Points 生成点云\n"
  );
});
