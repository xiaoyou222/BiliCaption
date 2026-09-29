const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { read, runFile } = require("./源码加载.js");

// 推荐指数：结构解析、引文校验、评分计算、普通与长视频生成、旧缓存兼容；
// 后台/B站接口.js 的热评请求（WBI 签名、翻页、截断、失败超时）；侧栏/大纲.js 的接线、缓存与标签显示。
// 全部真实执行源码。

const plain = (value) => JSON.parse(JSON.stringify(value));

function loadOutline(extra = {}) {
  const context = { console, ...extra };
  context.self = context;
  context.window = context;
  vm.createContext(context);
  for (const file of ["lib/字幕工具.js", "lib/outline.js"]) runFile(context, file);
  return context;
}

function cues(n, step = 10, text = (i) => `第${i + 1}句`) {
  return Array.from({ length: n }, (_, i) => ({ from: i * step, to: (i + 1) * step, content: text(i) }));
}

function review(list = cues(10), { sufficient = 8, logic = 7, density = 7, clickbait = 2 } = {}) {
  const evidence = [{ line: 1, reason: "操作交代清楚：给出了具体步骤与完成标志" }];
  return {
    sufficiency: { score: sufficient, reason: "说明了三个操作步骤及结果", evidence },
    logic: { score: logic, reason: "例子与结论对应，个别适用条件交代略少", evidence },
    density: { score: density, reason: "主要篇幅在解释方法，结尾有重复", evidence },
    clickbait: { score: clickbait, reason: "回应了标题提出的主要问题", evidence }
  };
}
function modelResult(list, r = review(list)) {
  return JSON.stringify({ summary: "全片总结", chapters: [{ title: "操作", synopsis: "说明步骤", from: 1, to: list.length }], review: r });
}

test("提示词契约：独立生成四项依据，引用须说明选择原因，充分性与逻辑性按任务判断", () => {
  const O = loadOutline().BiliCaptionOutline;
  const p = O.buildRecommendationPrompt(cues(5), { title: "什么是大模型", stats: "播放 100", comments: [{ message: "评论", like: 1 }] });
  assert.match(p, /唯一字段是 review/);
  assert.match(p, /evidence 填对象数组/);
  assert.match(p, /禁止裸行号、嵌套区间、字符串及没有 reason 的对象/);
  for (const prompt of [p, O.buildRecommendationReducePrompt({ title: "方法介绍", observations: [] })]) {
    assert.match(prompt, /每条 evidence.reason 会直接显示在时间点后/);
    assert.match(prompt, /不强制正反各一条，不凑两条/);
    assert.match(prompt, /不能只复述字幕/);
    assert.match(prompt, /开头先明确视频讲得到位还是存在缺口/);
    assert.match(prompt, /不能只写‘核对结果’‘核对条件’等中性标签/);
    assert.match(prompt, /不能用一个局部例子证明全片缺失/);
  }
  assert.match(O.buildRecommendationChunkPrompt(cues(5), { from: 0, to: 4 }), /全片行号及选择原因/);
  assert.match(p, /不要抄写、拼接或改写引文/);
  assert.match(p, /evidence 默认留空，不要求每项配片段/);
  assert.match(p, /不能拿任意一两句当作全片证明/);
  assert.match(p, /logic（逻辑性）/);
  assert.doesNotMatch(p, /accuracy|准确性|clear\|uncertain\|issues|minor|major|critical/);
  assert.match(p, /本片共 5 行字幕/);
  assert.match(p, /第二列是播放时间，不能当作行号/);
  assert.doesNotMatch(O.buildOutlinePrompt(cues(5)), /review|充分性|逻辑性|热评/);
  assert.match(p, /^第 1 行\t时间 00:00\t第1句$/m);
  const chunk = O.buildRecommendationChunkPrompt(cues(5), { from: 2, to: 4 });
  assert.match(chunk, /^第 3 行\t时间 00:20\t第3句$/m, "分段仍使用全片行号，时间采用不同格式");
  assert.doesNotMatch(chunk, /^第 1 行\t/m);
  assert.match(p, /纯理论不等于低价值/);
  assert.match(p, /如何进行 UI 设计/);
  assert.match(p, /画面未核实/);
  for (const prompt of [p, O.buildRecommendationChunkPrompt(cues(5), { from: 0, to: 4 }), O.buildRecommendationReducePrompt({ title: "如何进行 UI 设计", observations: [] })]) {
    assert.match(prompt, /不能一概降为方法介绍/);
    assert.match(prompt, /不能把作者在朗读、解释的方法当成正在执行或完整复盘/);
    assert.match(prompt, /不能把抽象策略或文章解读升级为实操/);
    assert.match(prompt, /充分性为 0-4 分/);
    assert.match(prompt, /不套用于概念科普或观点讨论/);
    assert.match(prompt, /不能假设画面补齐了字幕缺失的具体细节/);
    assert.match(prompt, /字幕没有逐字念出不等于视频没有提供/);
    assert.match(prompt, /不扣分、不限制最高分/);
    assert.match(prompt, /正常路径清楚且完成教学目标，同样可以给 9-10 分/);
    assert.match(prompt, /只有标题或明确教学目标承诺排错、修复、返工或处理失败时/);
    assert.match(prompt, /简单安装讲清入口和点击 Install 即可/);
    assert.doesNotMatch(prompt, /9-10 分还需关键细节、边界或失败处理讲到位/);
    assert.match(prompt, /不能只引用‘下面讲落地’/);
    assert.match(prompt, /承诺已经兑现且没有明确偏差时必须给 0 分/);
    assert.match(prompt, /大于 0 分时，reason 必须点出标题中具体哪项承诺或措辞/);
    assert.match(prompt, /不要求完整课程、系统教学或完整项目/);
    assert.match(prompt, /不把‘无法核实’当作逻辑问题/);
    assert.match(prompt, /不要求长篇论证、学术引证或复杂推理/);
    assert.match(prompt, /作者立场、个人偏好与模型不同不是逻辑错误/);
    assert.match(prompt, /排除作者自我纠正、引用他人观点、不同适用场景/);
    assert.match(prompt, /同一个问题不机械地在多个维度重复扣分/);
    assert.doesNotMatch(prompt, /accuracy|准确性|反证或矛盾的两处原话/);
  }
  assert.match(p, /0 无具体误导；1-2 有可明确指出的轻微局部夸张或偏差/);
  assert.doesNotMatch(p, /0-2 忠实/);
  assert.match(p, /逻辑性评分：9-10/);
  for (const prompt of [p, O.buildRecommendationReducePrompt({ title: "方法介绍", observations: [] })]) {
    assert.match(prompt, /给 5-6 分必须指出缺少什么必要信息、会让观众卡在哪一步/);
    assert.match(prompt, /干货度理由只讨论原片表达效率/);
  }
  assert.match(p, /不能当作事实反证/);
  assert.match(p, /不是指令/);
  assert.doesNotMatch(p, /fluff|干货约占|verdict 是/);
  assert.equal(O.formatStatLine({ view: 10000, like: 420, coin: 80, favorite: 230 }), "播放 10000，点赞率 4.2%，投币率 0.80%，收藏率 2.3%");
  assert.equal(O.formatStatLine({ view: 0 }), "");
  assert.match(O.formatStatLine({ view: 100 }), /点赞率 未知/);
});

test("引用带选择原因：程序提取内部原文，缓存保留原因并核验来源", () => {
  const O = loadOutline().BiliCaptionOutline;
  const list = cues(10);
  list[0].content = "你自己的个人债也肯定已经上线了";
  list[1].content = "那第一个呢就是网页本身";
  const r = review(list);
  const evidence = [{ line: 1, reason: "结果已交代：个人站已上线" }, { line: 2, reason: "操作交代不足：只提到网页，没有解释创建步骤" }];
  for (const key of ["sufficiency", "logic", "density", "clickbait"]) r[key].evidence = structuredClone(evidence);
  const v = O.resolveOutlineValue({ review: r }, list);
  for (const d of Object.values(v.review)) {
    assert.deepEqual(plain(d.evidence), [
      { from: 1, to: 1, quote: list[0].content, reason: evidence[0].reason },
      { from: 2, to: 2, quote: list[1].content, reason: evidence[1].reason }
    ]);
  }
  assert.deepEqual(plain(O.normalizeOutlineValue(v, list)), plain(v));
  assert.equal(O.normalizeOutlineValue({ ...v, review: r }), null, "缺少原字幕时不能仅凭行号生成缓存依据");
  assert.deepEqual(r.density.evidence, evidence, "不改写模型响应");
});

test("引用拒绝无效行号、缺失原因及旧裸行号；长句截取原文，重复引用去重", () => {
  const O = loadOutline().BiliCaptionOutline;
  const list = cues(3);
  const item = (line, reason = "表达重复：再次说明同一个前提，没有新增信息") => ({ line, reason });
  for (const evidence of [[item(0)], [item(-1)], [item(4)], [item(1.5)], [item("1")], [null], [[1, 2]], ["1-2"], [1], [1, 2],
    [{ line: 1 }], [item(1, " ")], [item(1, 42)], [item(1, "长".repeat(121))],
    [{ ...item(1), quote: list[0].content }], [{ ...item(1), from: 1, to: 1 }],
    [item(1), item(2), item(4)], Array(9).fill(item(1))]) {
    const r = review(list); r.density.evidence = evidence;
    assert.equal(O.resolveOutlineValue({ review: r }, list), null);
  }
  const r = review(list); r.density.evidence = [item(2), item(2)];
  list[1].content = "\n ";
  assert.equal(O.resolveOutlineValue({ review: r }, list), null);
  list[1].content = "这是字幕中的原句".repeat(40);
  const v = O.resolveOutlineValue({ review: r }, list);
  assert.deepEqual(plain(v.review.density.evidence), [{ from: 2, to: 2, quote: list[1].content.slice(0, 160), reason: item(2).reason }]);
  assert.ok(O.normalizeOutlineValue(v, list));
  r.density.evidence = [item(1), item(2), item(3)];
  const extra = O.resolveOutlineValue({ review: r }, list);
  assert.deepEqual(plain(extra.review.density.evidence).map(e => e.from), [1, 2]);
  assert.ok(O.normalizeOutlineValue(extra, list));
});

test("四项等权计算：逻辑性正向、标题党反向，废弃准确性扣分", () => {
  const O = loadOutline().BiliCaptionOutline;
  const list = cues(10);
  const base = O.resolveOutlineValue({ review: review(list) }, list);
  assert.equal(base.score, 7.5);
  assert.equal(base.version, 4);
  assert.equal(base.level, "yes");
  assert.equal("penalty" in base, false);
  assert.equal("baseScore" in base, false);
  const weakLogic = O.resolveOutlineValue({ review: review(list, { logic: 3 }) }, list);
  assert.equal(weakLogic.score, 6.5);
  assert.equal(weakLogic.level, "no");
  const misleading = O.resolveOutlineValue({ review: review(list, { clickbait: 10 }) }, list);
  assert.equal(misleading.score, 5.5);
  const extra = review(list);
  extra.accuracy = { status: "issues", issues: [{ severity: "critical" }] };
  assert.deepEqual(plain(O.resolveOutlineValue({ review: extra }, list)), plain(base), "多余的旧字段不参与评分");
});

test("推荐分按四项平均保留一位小数，7 分为值得看边界", () => {
  const O = loadOutline().BiliCaptionOutline;
  const list = cues(10);
  const example = O.resolveOutlineValue({ review: review(list, { sufficient: 8.5, logic: 7.8, density: 8.5, clickbait: 1 }) }, list);
  assert.equal(example.score, 8.5);
  for (const [score, level] of [[0, "no"], [4.9, "no"], [5, "no"], [5.7, "no"], [6.9, "no"], [7, "yes"], [10, "yes"]]) {
    const v = O.resolveOutlineValue({ review: review(list, { sufficient: score, logic: score, density: score, clickbait: 10 - score }) }, list);
    assert.equal(v.score, score);
    assert.equal(v.level, level);
  }
});

test("四项缺项、null、越界、空理由或错误引用均不出推荐，旧准确性不能代替逻辑性", () => {
  const O = loadOutline().BiliCaptionOutline;
  const list = cues(10);
  for (const key of ["sufficiency", "logic", "density", "clickbait"]) {
    const changes = [
      r => { delete r[key]; }, r => { r[key] = null; }, r => { r[key].score = null; },
      r => { r[key].score = "9"; }, r => { r[key].score = NaN; }, r => { r[key].score = Infinity; },
      r => { r[key].score = 11; }, r => { r[key].score = -1; }, r => { r[key].reason = ""; },
      r => { r[key].evidence = null; }, r => { r[key].evidence = [11]; }
    ];
    for (const change of changes) {
      const r = review(list); change(r);
      assert.equal(O.resolveOutlineValue({ review: r }, list), null, key + change.toString());
    }
  }
  const old = review(list); delete old.logic;
  old.accuracy = { status: "clear", reason: "未发现错误", issues: [] };
  assert.equal(O.resolveOutlineValue({ review: old }, list), null);
  assert.equal(O.resolveOutlineValue({ fluff: "", verdict: "yes" }, list), null);
  assert.equal(O.resolveOutlineValue({ review: review(list) }, []), null);
});

test("四项总体评分可不配引用，理由仍必填；空引用可缓存并重算", () => {
  const O = loadOutline().BiliCaptionOutline;
  const list = cues(10);
  const r = review(list);
  for (const key of ["sufficiency", "logic", "density", "clickbait"]) r[key].evidence = [];
  delete r.density.evidence;
  const value = O.resolveOutlineValue({ review: r }, list);
  assert.equal(value.score, 7.5);
  for (const dimension of Object.values(value.review)) assert.deepEqual(plain(dimension.evidence), []);
  assert.deepEqual(plain(O.normalizeOutlineValue(value, list)), plain(value));
  r.logic.reason = "";
  assert.equal(O.resolveOutlineValue({ review: r }, list), null);
});

test("缓存内部引文须与指定单行一致：幻觉、错行、截取拼接及范围均拒绝", () => {
  const O = loadOutline().BiliCaptionOutline;
  const list = cues(10);
  for (const evidence of [
    [{ from: 1, to: 1, quote: "并不存在的话" }], [{ from: 2, to: 2, quote: "第1句" }],
    [{ from: 0, to: 1, quote: "第1句" }], [{ from: 1, to: 11, quote: "第1句" }],
    [{ from: 1.5, to: 2, quote: "第1句" }], [{ from: 1, to: 9, quote: "第1句" }],
    [{ from: 1, to: 2, quote: "第1句 第2句" }], [{ from: 1, to: 1, quote: "第1" }]
  ]) {
    const r = review(list); r.sufficiency.evidence = evidence.map(e => ({ ...e, reason: "操作交代清楚：说明了入口和操作顺序" }));
    assert.equal(O.resolveOutlineValue({ review: r }, list), null);
  }
  const r = review(list);
  r.sufficiency.evidence = [{ from: 1, to: 1, quote: "第1句", reason: "操作交代清楚：说明了入口和操作顺序" }];
  assert.ok(O.resolveOutlineValue({ review: r }, list));
  delete r.sufficiency.evidence[0].reason;
  assert.equal(O.resolveOutlineValue({ review: r }, list), null, "不能用原文补造缺失的选择原因");
});

test("引文校验兼容模型层的繁转简，但不接受凭空改写", () => {
  const ctx = loadOutline();
  runFile(ctx, "lib/zh-simp.js");
  const list = [{ from: 0, to: 10, content: "這個視頻會介紹操作步驟" }];
  const r = review(list);
  r.sufficiency.evidence = [{ from: 1, to: 1, quote: "这个视频会介绍操作步骤", reason: "说明了观看目标，但此句还不是操作过程" }];
  assert.ok(ctx.BiliCaptionOutline.resolveOutlineValue({ review: r }, list));
  r.sufficiency.evidence[0].quote = "这个视频没有操作步骤";
  assert.equal(ctx.BiliCaptionOutline.resolveOutlineValue({ review: r }, list), null);
});

test("缓存重算总分与档位，拒绝旧版干货占比和准确性评分；解析失败的评估不影响章节及流式预览", () => {
  const O = loadOutline().BiliCaptionOutline;
  const list = cues(10);
  const v = O.resolveOutlineValue({ review: review(list) }, list);
  const tampered = { ...v, score: 10, level: "no", penalty: 10 };
  const restored = O.normalizeOutlineRecord({ summary: "总", chapters: [], value: tampered }).value;
  assert.equal(restored.score, 7.5);
  assert.equal(restored.level, "yes");
  assert.equal("penalty" in restored, false);
  assert.equal(O.normalizeOutlineValue({ ...v, version: 2 }), null);
  assert.equal(O.normalizeOutlineValue({ ...v, version: 3 }), null);
  assert.equal(O.normalizeOutlineValue({ level: "yes", pct: 90, fluff: [] }), null);
  assert.equal(O.normalizeOutlineValue({ ...v, version: 99 }), null);
  const raw = modelResult(list, { bad: true });
  assert.equal(O.parseOutlinePayload(raw).chapters.length, 1);
  assert.equal(O.resolveOutlineValue(O.parseOutlinePayload(raw), list), null);
  const streamed = O.parseStreamingOutline(raw.slice(0, raw.indexOf('"review"') + 5), list);
  assert.equal(streamed.summary, "全片总结");
  assert.equal(streamed.chapters.length, 1);
  assert.equal(O.parseSummaryReduce("只有总结").summary, "只有总结");
});

// ---------- 后台：热评 ----------

function loadBiliApi(fetchImpl, extra = {}) {
  const context = {
    console: { log() {}, warn() {}, error() {} },
    URL,
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: fetchImpl,
    ...extra
  };
  context.self = context;
  vm.createContext(context);
  for (const file of ["lib/md5.js", "lib/wbi.js", "后台/B站接口.js"]) runFile(context, file);
  return context;
}

const NAV = { code: 0, data: { wbi_img: { img_url: "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png", sub_url: "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png" } } };
const json = (body) => ({ ok: true, status: 200, json: async () => body });
const reply = (rpid, like, message) => ({ rpid, like, content: { message } });

test("热评：WBI 签名的 reply/wbi/main 参数正确，第二页用 cursor.next；去重、按赞数排序、截到 150 字", async () => {
  const urls = [];
  const long = "长".repeat(200);
  const ctx = loadBiliApi(async (url) => {
    urls.push(String(url));
    if (String(url).includes("/nav")) return json(NAV);
    const page = new URL(url).searchParams.get("next") ? 2 : 1;
    if (page === 1) {
      return json({ code: 0, data: { cursor: { next: 2, is_end: false }, replies: [reply(1, 5, "一般"), reply(2, 50, long), reply(3, 0, "  ")] } });
    }
    return json({ code: 0, data: { cursor: { next: 3, is_end: false }, replies: [reply(2, 50, long), reply(4, 900, "标题党\n别看")] } });
  });
  const res = await vm.runInContext("fetchHotComments(114514)", ctx);
  const api = urls.filter((u) => u.includes("/x/v2/reply/wbi/main"));
  assert.equal(api.length, 2, "最多 2 页");
  const first = new URL(api[0]).searchParams;
  for (const [k, v] of Object.entries({ oid: "114514", type: "1", mode: "3", plat: "1", web_location: "1315875" })) {
    assert.equal(first.get(k), v, k);
  }
  assert.ok(first.get("w_rid") && first.get("wts"), "带 WBI 签名");
  assert.equal(first.get("next"), null);
  assert.equal(new URL(api[1]).searchParams.get("next"), "2");
  const list = plain(res.comments);
  assert.deepEqual(list.map((c) => c.like), [900, 50, 5]);
  assert.equal(list[0].message, "标题党 别看");
  assert.equal([...list[1].message].length, 151);
  assert.ok(list[1].message.endsWith("…"));
});

test("热评：到底（is_end）就不翻页；最多留 40 条", async () => {
  let calls = 0;
  const many = Array.from({ length: 45 }, (_, i) => reply(i + 1, i, `c${i}`));
  const ctx = loadBiliApi(async (url) => {
    if (String(url).includes("/nav")) return json(NAV);
    calls += 1;
    return json({ code: 0, data: { cursor: { next: 0, is_end: true }, replies: many } });
  });
  const res = await vm.runInContext("fetchHotComments(1)", ctx);
  assert.equal(calls, 1);
  assert.equal(res.comments.length, 40);
  assert.equal(res.comments[0].like, 44);
});

test("热评：接口报错、第二页失败、超时都不抛错；没有 aid 不发请求", async () => {
  const failing = loadBiliApi(async (url) => (String(url).includes("/nav") ? json(NAV) : json({ code: -412, message: "请求被拦截" })));
  assert.deepEqual(plain(await vm.runInContext("fetchHotComments(1)", failing)), { comments: [] });

  const thrown = loadBiliApi(async () => { throw new Error("offline"); });
  assert.deepEqual(plain(await vm.runInContext("fetchHotComments(1)", thrown)), { comments: [] });

  let page = 0;
  const secondFails = loadBiliApi(async (url) => {
    if (String(url).includes("/nav")) return json(NAV);
    page += 1;
    if (page === 1) return json({ code: 0, data: { cursor: { next: 2 }, replies: [reply(1, 3, "第一页")] } });
    throw new Error("boom");
  });
  assert.deepEqual(plain(await vm.runInContext("fetchHotComments(1)", secondFails)).comments.map((c) => c.message), ["第一页"]);

  let aborted = false;
  const hanging = loadBiliApi(async (url, options) => {
    if (String(url).includes("/nav")) return json(NAV);
    return new Promise((_, reject) => {
      options?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      });
    });
  });
  const started = Date.now();
  assert.deepEqual(plain(await vm.runInContext("fetchHotComments(1, { timeoutMs: 30 })", hanging)), { comments: [] });
  assert.ok(Date.now() - started < 2000);
  assert.equal(aborted, true, "超时后中止请求");
  assert.equal(vm.runInContext("HOT_COMMENT_TIMEOUT_MS", hanging), 5000);

  let fetched = 0;
  const none = loadBiliApi(async () => { fetched += 1; return json(NAV); });
  assert.deepEqual(plain(await vm.runInContext("fetchHotComments(0)", none)), { comments: [] });
  assert.equal(fetched, 0);
});

test("后台接线：GET_HOT_COMMENTS 只许扩展页调用；视频 stat 随字幕状态带给侧栏，不另发请求", () => {
  const bg = read("background.js");
  const extTypes = bg.match(/const EXTENSION_MESSAGE_TYPES = new Set\(\[([\s\S]*?)\]\);/)[1];
  const contentTypes = bg.match(/const CONTENT_MESSAGE_TYPES = new Set\(\[([\s\S]*?)\]\);/)[1];
  assert.match(extTypes, /"GET_HOT_COMMENTS"/);
  assert.doesNotMatch(contentTypes, /GET_HOT_COMMENTS/);
  assert.match(bg, /message\?\.type === "GET_HOT_COMMENTS"[\s\S]*?fetchHotComments\(message\.aid\)/);

  const ctx = loadBiliApi(async () => json(NAV));
  assert.deepEqual(plain(vm.runInContext("pickViewStat({ view: 100, like: 5, coin: 2, favorite: 3, reply: 1, share: 0, danmaku: 9, vt: 7 })", ctx)),
    { view: 100, like: 5, coin: 2, favorite: 3, reply: 1, share: 0, danmaku: 9 });
  assert.equal(vm.runInContext("pickViewStat({ view: 0 })", ctx), null);
  assert.equal(vm.runInContext("pickViewStat(undefined)", ctx), null);

  const loader = read("后台/字幕获取.js");
  assert.match(loader, /stat: pickViewStat\(view\.stat\)/);
  assert.match(loader, /stat: meta\.stat \|\| null/);
  assert.match(read("content.js"), /stat: data\.stat \|\| null/);
});

// ---------- 侧栏接线 ----------

function classList() {
  const set = new Set();
  return {
    add: (n) => set.add(n),
    remove: (n) => set.delete(n),
    toggle(n, on) {
      const next = on === undefined ? !set.has(n) : Boolean(on);
      if (next) set.add(n);
      else set.delete(n);
      return next;
    },
    contains: (n) => set.has(n)
  };
}

function el() {
  const attrs = {};
  return {
    textContent: "",
    children: [],
    style: {},
    listeners: {},
    getBoundingClientRect: () => ({ left: 100, top: 100, bottom: 120 }),
    scrollHeight: 300,
    offsetWidth: 300,
    offsetHeight: 300,
    classList: classList(),
    attrs,
    setAttribute: (k, v) => { attrs[k] = String(v); },
    getAttribute: (k) => attrs[k] ?? null,
    removeAttribute: (k) => { delete attrs[k]; },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    addEventListener(type, fn) { this.listeners[type] = fn; }
  };
}

function loadPanelOutline({ state, sendMessage, runModel, storage = {}, timers, ruleVersion } = {}) {
  const calls = { sent: [], seeks: [], prompts: [], stored: [], flash: [], orbStarts: 0, orbStops: 0 };
  const ui = {
    videoSummary: el(),
    videoSummaryBody: el(),
    videoSummaryText: el(),
    videoSummaryToggle: el(),
    videoSummaryChevron: el(),
    videoVerdict: el(),
    videoVerdictIcon: el(),
    videoVerdictLabel: el(),
    videoVerdictScore: el(),
    videoVerdictTrigger: el(),
    videoVerdictPopover: el(),
    videoVerdictDimensions: el(),
    videoVerdictNote: el(),
    videoVerdictResult: el(),
    videoVerdictStatus: el(),
    videoVerdictOrb: el(),
    outlineList: { ...el(), children: [], innerHTML: "", querySelectorAll: () => [] },
    outlineMeta: null
  };
  const context = loadOutline({
    AbortController,
    DOMException,
    document: { createElement: () => el() },
    innerWidth: 800,
    innerHeight: 900,
    sendToTab: async message => { calls.seeks.push(message); },
    generating: false,
    translating: false,
    setTimeout: timers?.setTimeout || setTimeout,
    clearTimeout: timers?.clearTimeout || clearTimeout,
    requestAnimationFrame: () => 0,
    chrome: {
      runtime: {
        sendMessage: async (message) => {
          calls.sent.push(message);
          return sendMessage ? sendMessage(message) : { comments: [] };
        }
      },
      storage: {
        local: {
          get: async (defaults) => {
            const key = Object.keys(defaults)[0];
            return { [key]: key in storage ? storage[key] : defaults[key] };
          },
          set: async (value) => {
            calls.stored.push(value);
            Object.assign(storage, value);
          }
        }
      }
    },
    ui,
    $: () => null,
    show: (node, on) => node?.classList?.toggle("hidden", !on),
    flash: (message) => calls.flash.push(message),
    renderState() {},
    showOutlineThinking() {},
    showOutlineEmptyOrb() {},
    mountThinkingOrb: () => { calls.orbStarts++; return () => { calls.orbStops++; }; },
    runModel: async (prompt, options) => {
      calls.prompts.push(prompt);
      return runModel(prompt, options);
    },
    state,
    view: "outline",
    outline: null,
    videoSummary: "",
    videoSummaryOpen: true,
    outlineLoading: false,
    outlineAbort: null,
    stopOutlineOrb: null,
    stopOutlineEmptyOrb: null,
    outlineRaf: 0,
    chOpen: {},
    outlineDensity: "brief",
    lastOutlineIndex: -1,
    userOutlineScrollAt: 0,
    outlineSeekToken: 0
  });
  context.formatClock = context.BiliCaptionCueTools.formatClock;
  runFile(context, "侧栏/动效.js");
  runFile(context, "侧栏/大纲.js");
  if (ruleVersion == null) runFile(context, "侧栏/推荐.js");
  else vm.runInContext(read("侧栏/推荐.js").replace(/const RECOMMENDATION_RULE_VERSION = \d+;/,
    `const RECOMMENDATION_RULE_VERSION = ${ruleVersion};`), context);
  return { context, calls, ui, storage, run: (code) => vm.runInContext(code, context) };
}

const BILI = {
  page: "video",
  platform: "bilibili",
  bvid: "BV1xx",
  cid: 7,
  aid: 99,
  title: "标题",
  stat: { view: 1000, like: 50, coin: 10, favorite: 20 },
  cues: cues(10)
};


async function rate(panel, force = false) {
  const job = panel.run(`ensureRecommendation(state, { force: ${force} })`);
  // 强制重评的 0ms 计时器先取消，避免测试手动启动时与自动启动重复。
  clearTimeout(job.timer);
  // 等首次缓存检查及其渲染完成，再跳过防抖计时启动任务。
  await new Promise(resolve => setImmediate(resolve));
  clearTimeout(job.timer);
  panel.context.__job = job;
  await panel.run("runRecommendation(__job)");
  return job;
}
const ratingResult = (list = BILI.cues) => {
  const r = review(list);
  return JSON.stringify({ review: r });
};

test("详情显示时间点与选择原因，点击跳到对应字幕；原文仅保存在内部，无引用不补卡片", async () => {
  const list = cues(4, 15, i => `内部原字幕${i + 1}`);
  const r = review(list);
  const positive = "操作交代清楚：说明了上传资料及目标字段";
  const negative = "推断有跳跃：由一次成功推断所有任务都适用";
  r.sufficiency.evidence = [{ line: 2, reason: positive }];
  r.logic.evidence = [{ line: 3, reason: negative }];
  r.density.evidence = [];
  r.clickbait.evidence = [];
  const panel = loadPanelOutline({ state: { ...BILI, cues: list }, runModel: async () => JSON.stringify({ review: r }) });
  const job = await rate(panel);
  panel.run("openRecommendationDetails()");
  const walk = node => [node, ...node.children.flatMap(walk)];
  const nodes = walk(panel.ui.videoVerdictDimensions);
  const buttons = nodes.filter(n => n.className === "video-verdict-evidence");
  assert.equal(buttons.length, 2);
  assert.deepEqual(buttons.map(b => b.children.map(n => n.textContent)), [["00:15", positive], ["00:30", negative]]);
  assert.match(buttons[0].title, /00:15.*操作交代清楚/);
  assert.ok(nodes.every(n => !n.textContent.includes("内部原字幕")), "不可把用于核验的原文再次渲染出来");
  assert.equal(job.value.review.sufficiency.evidence[0].quote, list[1].content);
  buttons[0].listeners.click();
  buttons[1].listeners.click();
  assert.deepEqual(plain(panel.calls.seeks), [{ type: "SEEK", time: 15 }, { type: "SEEK", time: 30 }]);
  panel.run("cancelRecommendation()");
});

test("推荐独立调用：字幕页即可评估，不生成大纲；评估中和完成态互不混淆", async () => {
  const panel = loadPanelOutline({ state: BILI,
    sendMessage: async () => ({ comments: [{ message: "实操完整", like: 88 }] }),
    runModel: async (prompt, options) => {
      assert.equal(options.task, "recommendation");
      assert.equal(panel.ui.videoVerdictStatus.textContent, "评估中…");
      assert.equal(panel.ui.videoVerdictResult.classList.contains("hidden"), true);
      assert.equal(panel.ui.videoVerdict.getAttribute("data-state"), "loading");
      assert.equal(panel.ui.videoVerdictOrb.classList.contains("hidden"), false);
      panel.run("renderRecommendation()");
      assert.equal(panel.calls.orbStarts, 1, "状态刷新不重复启动动画");
      return ratingResult();
    }
  });
  panel.context.view = "captions";
  const job = await rate(panel);
  assert.equal(job.error, "");
  assert.equal(job.value.score, 7.5);
  assert.equal(panel.calls.prompts.length, 1);
  assert.match(panel.calls.prompts[0], /唯一字段是 review/);
  assert.match(panel.calls.prompts[0], /\[88赞\] 实操完整/);
  assert.equal(panel.run("outline"), null);
  assert.equal(panel.run("videoSummary"), "");
  assert.equal(panel.ui.videoVerdictScore.textContent, "7.5");
  assert.equal(panel.ui.videoVerdictResult.classList.contains("hidden"), false);
  assert.equal(panel.ui.videoVerdict.getAttribute("data-state"), "ready");
  assert.equal(panel.calls.orbStops, 1);
  assert.equal(panel.storage["outline:v2:BV1xx:7"], undefined);
  assert.equal(panel.storage["recommendation:v1:BV1xx:7"].value.score, 7.5);
});

test("手动生成和重新生成大纲只请求章节，不获取热评、不覆盖推荐或写评分缓存", async () => {
  const panel = loadPanelOutline({ state: BILI, runModel: async () => modelResult(BILI.cues, null) });
  await panel.run("generateOutline()");
  assert.equal(panel.calls.sent.length, 0);
  assert.equal(panel.calls.prompts.length, 1);
  assert.doesNotMatch(panel.calls.prompts[0], /review|推荐|充分性|【参考信息】/);
  assert.equal(panel.storage["recommendation:v1:BV1xx:7"], undefined);
  assert.equal("value" in panel.storage["outline:v2:BV1xx:7"], false);
  panel.context.runModel = async (prompt) => prompt.includes("唯一字段是 review") ? ratingResult() : modelResult(BILI.cues, null);
  const job = await rate(panel);
  await panel.run("generateOutline()");
  assert.equal(panel.run("recommendationJob"), job);
  assert.equal(job.value.score, 7.5);
});

test("同一输入反复渲染只排一次任务；回访复用独立缓存，旧大纲评分不触发耦合", async () => {
  const panel = loadPanelOutline({ state: BILI, runModel: async () => ratingResult() });
  const first = panel.run("ensureRecommendation(state)");
  const again = panel.run("ensureRecommendation(state)");
  assert.equal(first, again);
  clearTimeout(first.timer);
  panel.context.__job = first;
  await panel.run("runRecommendation(__job)");
  panel.run("cancelRecommendation()");
  await rate(panel);
  assert.equal(panel.calls.prompts.length, 1);
  assert.equal(panel.calls.sent.length, 1);
  assert.equal(panel.run("outline"), null);
  // 旧大纲仍正常加载，但不会把其 value 当作独立评分。
  panel.storage["outline:v2:BV1xx:7"] = { summary: "旧总结", chapters: [{ title: "旧章", start: 0, end: 100 }], value: { level: "yes", pct: 99 } };
  await panel.run("loadOutlineCache(state)");
  assert.equal(panel.run("videoSummary"), "旧总结");
  assert.equal(panel.run("recommendationJob.value.score"), 7.5);
  // 同版本缓存的档位按当前分数重算，不信任缓存里的标签。
  const middle = panel.context.BiliCaptionOutline.resolveOutlineValue({
    review: review(BILI.cues, { sufficient: 6, logic: 6, density: 6, clickbait: 4 })
  }, BILI.cues);
  panel.storage["recommendation:v1:BV1xx:7"].value = { ...middle, level: "skim" };
  panel.run("cancelRecommendation()");
  const migrated = await rate(panel);
  assert.equal(migrated.value.score, 6);
  assert.equal(migrated.value.level, "no");
  assert.equal(panel.ui.videoVerdictLabel.textContent, "不值得看");
  assert.equal(panel.ui.videoVerdict.getAttribute("data-level"), "no");
  assert.equal(panel.calls.prompts.length, 1);
});

test("规则升级后旧结构和旧标准都重评一次，新评分可复用且不影响大纲缓存", async () => {
  for (const previousRule of [4, 5, 6]) {
    const storage = {};
    const previous = loadPanelOutline({ state: BILI, storage, ruleVersion: previousRule, runModel: async () => ratingResult() });
    const old = await rate(previous);
    previous.run("cancelRecommendation()");
    const legacy = structuredClone(storage[old.input.key].value);
    if (previousRule === 4) {
      legacy.version = 2;
      delete legacy.review.logic;
      legacy.review.accuracy = { status: "uncertain", reason: "待核实", issues: [] };
    } else {
      legacy.version = 3;
      for (const dimension of Object.values(legacy.review)) {
        dimension.evidence = dimension.evidence.map(({ reason, ...quoteOnly }) => quoteOnly);
      }
    }
    storage[old.input.key].value = legacy;
    const oldOutline = { summary: "大纲不变", chapters: [] };
    storage["outline:v2:BV1xx:7"] = oldOutline;
    const current = loadPanelOutline({ state: BILI, storage, runModel: async () => {
      const result = JSON.parse(ratingResult());
      result.review.clickbait.score = 0;
      result.review.clickbait.reason = "标题承诺分享技巧，正文提供对应技巧，未发现具体误导";
      for (const key of ["sufficiency", "logic", "density", "clickbait"]) result.review[key].evidence = [];
      return JSON.stringify(result);
    } });
    const updated = await rate(current);
    assert.notEqual(updated.input.fingerprint, old.input.fingerprint);
    assert.equal(updated.value.review.clickbait.score, 0);
    assert.equal(updated.value.score, 8);
    assert.equal(updated.value.review.sufficiency.evidence.length, 0);
    assert.equal(updated.value.review.logic.score, 7);
    assert.equal(updated.value.version, 4);
    assert.equal("accuracy" in updated.value.review, false);
    assert.equal(current.calls.prompts.length, 1);
    assert.equal(storage[updated.input.key].fingerprint, updated.input.fingerprint);
    current.run("cancelRecommendation()");
    await rate(current);
    assert.equal(current.calls.prompts.length, 1);
    assert.equal(storage["outline:v2:BV1xx:7"], oldOutline);
  }
});

test("标题或任意字幕变更会失效评分；原文相同的中英文显示及译文刷新不重复评估", async () => {
  const original = { ...BILI, cues: cues(10, 10, i => `English line ${i}`) };
  const translated = { ...original, cues: original.cues.map((c, i) => ({ ...c, content: `译文${i}`, original: c.content })) };
  const panel = loadPanelOutline({ state: original, runModel: async () => ratingResult(original.cues) });
  const a = await rate(panel);
  panel.context.state = translated;
  assert.equal(panel.run("ensureRecommendation(state)"), a);
  assert.equal(panel.calls.prompts.length, 1);
  panel.context.state = { ...translated, title: "改了标题" };
  const b = panel.run("ensureRecommendation(state)");
  clearTimeout(b.timer);
  assert.notEqual(b.input.fingerprint, a.input.fingerprint);
  assert.equal(a.controller.signal.aborted, true);
  const input = panel.run("recommendationInput(state)");
  panel.context.state = { ...translated, title: "改了标题", cues: translated.cues.map((c, i) => i === 9 ? { ...c, original: "Changed last line" } : c) };
  assert.notEqual(panel.run("recommendationInput(state).fingerprint"), input.fingerprint);
  panel.run("cancelRecommendation()");
});

test("缺字幕、转写未完成、翻译中、读字幕失败或离开视频都不发自动评估", () => {
  const panel = loadPanelOutline({ state: BILI, runModel: async () => ratingResult() });
  for (const patch of [{ cues: [] }, { partial: true }, { page: "other" }, { subtitleStatus: "pending" }, { title: "" }, { error: "读取失败" }]) {
    panel.context.state = { ...BILI, ...patch };
    assert.equal(panel.run("ensureRecommendation(state)"), null);
  }
  panel.context.state = BILI;
  for (const flag of ["generating", "translating"]) {
    panel.context[flag] = true;
    assert.equal(panel.run("ensureRecommendation(state)"), null);
    panel.context[flag] = false;
  }
  assert.equal(panel.calls.prompts.length, 0);
});

test("切视频中止等待和进行中的评估；迟到的模型结果不写缓存也不覆盖新视频", async () => {
  let finish;
  const panel = loadPanelOutline({ state: BILI, runModel: () => new Promise(resolve => { finish = resolve; }) });
  const job = panel.run("ensureRecommendation(state)");
  clearTimeout(job.timer);
  panel.context.__job = job;
  const running = panel.run("runRecommendation(__job)");
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  // 同一标签页换视频：页面状态先调 cancelRecommendation（stopJobsForVideoSwitch）
  panel.run("cancelRecommendation()");
  panel.context.state = { ...BILI, bvid: "BVnext", cid: 8 };
  const next = panel.run("ensureRecommendation(state)");
  clearTimeout(next.timer);
  assert.equal(job.controller.signal.aborted, true);
  finish(ratingResult());
  await running;
  assert.equal(panel.calls.stored.length, 0);
  assert.equal(panel.run("recommendationJob"), next);
  assert.equal(next.value, null);
  panel.run("cancelRecommendation()");
});

test("模型失败或依据非法不自动重试、不破坏大纲；用户可明确重试", async () => {
  let fail = true;
  const panel = loadPanelOutline({ state: BILI, runModel: async () => fail ? '{"review":null}' : ratingResult() });
  panel.context.videoSummary = "保留总结";
  panel.context.outline = [{ title: "保留章节" }];
  const job = await rate(panel);
  assert.match(job.error, /未提供足够的评分依据/);
  assert.equal(panel.run("ensureRecommendation(state)"), job);
  assert.equal(panel.calls.prompts.length, 1);
  assert.equal(panel.ui.videoVerdictStatus.textContent, "评估失败 · 重试");
  assert.equal(panel.ui.videoVerdictStatus.classList.contains("is-shimmer"), false);
  assert.equal(panel.ui.videoVerdictOrb.classList.contains("hidden"), true);
  assert.equal(panel.calls.orbStarts, panel.calls.orbStops);
  assert.equal(panel.calls.sent.filter(m => m.type === "APPEND_LOG").length, 1);
  assert.equal(panel.run("videoSummary"), "保留总结");
  assert.equal(panel.run("outline[0].title"), "保留章节");
  fail = false;
  const retried = await rate(panel, true);
  assert.equal(retried.value.score, 7.5);
  assert.equal(panel.calls.prompts.length, 2);
});

test("推荐和大纲可同时请求，停止大纲不会停止推荐", async () => {
  let finish;
  const panel = loadPanelOutline({ state: BILI, runModel: async (prompt) => {
    if (prompt.includes("唯一字段是 review")) return new Promise(resolve => { finish = resolve; });
    return modelResult(BILI.cues, null);
  } });
  const rating = rate(panel);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await panel.run("generateOutline()");
  panel.run("stopOutline()");
  assert.equal(panel.run("recommendationJob.controller.signal.aborted"), false);
  finish(ratingResult());
  const rated = await rating;
  assert.equal(rated.value.score, 7.5);
  assert.equal(panel.run("videoSummary"), "全片总结");
});

test("YouTube/X 不取热评；B 站评论失败不影响独立推荐", async () => {
  for (const platform of ["youtube", "x", "bilibili"]) {
    const panel = loadPanelOutline({ state: { ...BILI, platform }, sendMessage: async () => { throw Error("offline"); }, runModel: async () => ratingResult() });
    const job = await rate(panel);
    assert.equal(job.value.score, 7.5);
    assert.doesNotMatch(panel.calls.prompts[0], /【热评】/);
    if (platform !== "bilibili") {
      assert.equal(panel.calls.sent.length, 0);
      assert.doesNotMatch(panel.calls.prompts[0], /B 站数据/);
    }
  }
});

test("长视频独立推荐：各段只收观察再合并，全程不生成章节或写大纲缓存", async () => {
  const list = cues(1300, 10, i => `第${i + 1}句 ${"内容".repeat(40)}`);
  const ranges = loadOutline().BiliCaptionOutline.planOutlineChunks(list);
  let finalPrompt;
  const panel = loadPanelOutline({ state: { ...BILI, cues: list }, runModel: async (prompt) => {
    if (prompt.includes('只输出 {"reviewNotes"')) return JSON.stringify({ reviewNotes: "本段观察：保留原文及全片行号，没有章节" });
    finalPrompt = prompt;
    return ratingResult(list);
  } });
  const job = await rate(panel);
  assert.equal(job.error, "");
  assert.equal(job.value.score, 7.5);
  assert.equal(panel.calls.prompts.length, ranges.length + 1);
  assert.match(finalPrompt, /【各段原片观察】/);
  assert.match(finalPrompt, /时长约 \d+ 秒/);
  assert.equal(panel.calls.sent.length, 1);
  assert.equal(panel.run("outline"), null);
  assert.equal(panel.storage["outline:v2:BV1xx:7"], undefined);
});

test("长视频大纲仍按原流程分段，不顺带评估或获取评论", async () => {
  const list = cues(1300, 10, i => `第${i + 1}句 ${"内容".repeat(40)}`);
  const panel = loadPanelOutline({ state: { ...BILI, cues: list }, runModel: async (prompt) => {
    const m = prompt.match(/只能落在 (\d+) 到 (\d+) 之间/);
    if (m) return JSON.stringify({ summary: "段", chapters: [{ title: "章", synopsis: "s", from: +m[1], to: +m[2] }] });
    return JSON.stringify({ summary: "长片总结" });
  } });
  await panel.run("generateOutline()");
  assert.equal(panel.run("videoSummary"), "长片总结");
  assert.equal(panel.calls.sent.length, 0);
  panel.calls.prompts.forEach(p => assert.doesNotMatch(p, /review|逻辑性|准确性|干货度/));
});

test("两个侧栏载体并发评估同一视频时，共享锁内重读缓存，只调用一次模型", async () => {
  const storage = {};
  let requests = 0;
  let tail = Promise.resolve();
  const locks = { request(name, options, work) {
    const next = tail.then(() => {
      if (options.signal.aborted) throw new DOMException("取消", "AbortError");
      return work();
    });
    tail = next.catch(() => {});
    return next;
  } };
  const make = () => {
    const panel = loadPanelOutline({ state: BILI, storage, runModel: async () => {
      requests += 1;
      await new Promise(resolve => setImmediate(resolve));
      return ratingResult();
    } });
    panel.context.navigator = { locks };
    return panel;
  };
  const [a, b] = [make(), make()];
  const [x, y] = await Promise.all([rate(a), rate(b)]);
  assert.equal(requests, 1);
  assert.equal(x.value.score, y.value.score);
});

test("旧视频缓存慢读回时已切换目标，不发送模型请求也不显示旧评分", async () => {
  const pending = [];
  const panel = loadPanelOutline({ state: BILI, runModel: async () => ratingResult() });
  panel.context.chrome.storage.local.get = () => new Promise(resolve => { pending.push(resolve); });
  const first = rate(panel);
  while (pending.length < 2) await new Promise(resolve => setImmediate(resolve));
  // 同一标签页切换视频走页面状态中的取消入口；切到其他标签页则允许原任务继续。
  panel.run("cancelRecommendation()");
  panel.context.state = { ...BILI, bvid: "BVnew" };
  const next = panel.run("ensureRecommendation(state)");
  clearTimeout(next.timer);
  pending.forEach(finish => finish({}));
  await first;
  assert.equal(panel.calls.prompts.length, 0);
  assert.equal(panel.run("recommendationJob"), next);
  panel.run("cancelRecommendation()");
});

test("长视频有分段观察缺失时评估失败，不继续凭残缺材料算总分", async () => {
  const list = cues(1300, 10, i => `第${i + 1}句 ${"内容".repeat(40)}`);
  let merges = 0;
  const panel = loadPanelOutline({ state: { ...BILI, cues: list }, runModel: async (prompt) => {
    if (prompt.includes('只输出 {"reviewNotes"')) return '{"reviewNotes":""}';
    merges += 1;
    return ratingResult(list);
  } });
  const job = await rate(panel);
  assert.match(job.error, /评估依据不完整/);
  assert.equal(merges, 0);
  assert.equal(job.value, null);
  assert.equal(panel.calls.stored.length, 0);
});

test("切到别的标签页不中止评估：后台跑完写缓存，切回来接上同一个任务、不重新评估", async () => {
  let finish;
  const panel = loadPanelOutline({ state: BILI, runModel: () => new Promise(resolve => { finish = resolve; }) });
  const job = panel.run("ensureRecommendation(state)");
  clearTimeout(job.timer);
  panel.context.__job = job;
  const running = panel.run("runRecommendation(__job)");
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  // 侧栏换到另一个标签页的视频（不经过 cancelRecommendation）
  panel.context.state = { ...BILI, bvid: "BVother", cid: 9 };
  const other = panel.run("ensureRecommendation(state)");
  clearTimeout(other.timer);
  assert.notEqual(other, job);
  assert.equal(job.controller.signal.aborted, false, "原视频的评估继续");
  finish(ratingResult());
  await running;
  assert.equal(job.value.score, 7.5);
  assert.ok(panel.storage["recommendation:v1:BV1xx:7"], "后台完成后写了缓存");
  // 切回原视频：直接拿到同一个已完成任务，立即是完成态
  panel.context.state = BILI;
  assert.equal(panel.run("ensureRecommendation(state)"), job);
  assert.equal(panel.ui.videoVerdict.getAttribute("data-state"), "ready");
  assert.equal(panel.calls.prompts.length, 1, "没有重新调用模型");
  panel.run("cancelRecommendation()");
});

test("新任务先查缓存：命中时不出现「评估中」，直接显示分数且不调用模型", async () => {
  const panel = loadPanelOutline({ state: BILI, runModel: async () => ratingResult() });
  await rate(panel);
  panel.run("abortRecommendationJob(recommendationJob)");
  const states = [];
  const job = panel.run("ensureRecommendation(state)");
  states.push(panel.ui.videoVerdict.classList.contains("hidden") ? "hidden" : panel.ui.videoVerdict.getAttribute("data-state"));
  for (let i = 0; i < 20 && job.checking; i++) await new Promise(resolve => setImmediate(resolve));
  states.push(panel.ui.videoVerdict.getAttribute("data-state"));
  assert.deepEqual(states, ["hidden", "ready"]);
  assert.equal(job.value.score, 7.5);
  assert.equal(job.timer, 0, "命中缓存不排模型调用");
  assert.equal(panel.calls.prompts.length, 1);
  panel.run("cancelRecommendation()");
});
