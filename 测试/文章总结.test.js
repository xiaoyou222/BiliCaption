// 文章模式基础回归：正文提取与段落来源、内容脚本消息、侧栏生成流程、流式预览、X 页面识别。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const A = require("../lib/article.js");
const root = path.join(__dirname, "..");
const source = (f) => fs.readFileSync(path.join(root, f), "utf8");
function page() {
  const dom = new JSDOM(source("测试/夹具/文章正文.html"), {
    url: "https://example.com/article",
    runScripts: "outside-only",
    pretendToBeVisual: true
  });
  dom.window.eval(source("lib/vendor/defuddle.js"));
  return dom;
}
function extracted() {
  const dom = page();
  return { dom, doc: A.extract(dom.window.document, dom.window.Defuddle) };
}
test("真实 Defuddle 提取正文并映射表格、代码及段落，保留原网页", () => {
  const { dom, doc } = extracted();
  const before = dom.window.document.body.innerHTML;
  assert.equal(doc.notArticle, false);
  assert.deepEqual(doc.warnings, []);
  assert.ok(doc.blocks.some((b) => b.type === "pre"));
  assert.ok(doc.blocks.some((b) => b.type === "table"));
  assert.ok(
    doc.blocks.every((b) => b.source),
    JSON.stringify(doc.blocks.filter((b) => !b.source))
  );
  assert.doesNotMatch(doc.blocks.map((b) => b.text).join(""), /推荐文章|版权所有/);
  A.extract(dom.window.document, dom.window.Defuddle);
  assert.equal(dom.window.document.body.innerHTML, before);
  dom.window.close();
});
test("未展开内容标记范围，短页不当作文章", () => {
  const dom = page();
  dom.window.document.body.insertAdjacentHTML(
    "beforeend",
    "<button>展开全文</button><div hidden><p>隐藏内容</p></div>"
  );
  const doc = A.extract(dom.window.document, dom.window.Defuddle);
  assert.equal(doc.partial, true);
  assert.ok(doc.warnings.length);
  assert.ok(!A.scan(dom.window.document).some((b) => b.text === "隐藏内容"));
  dom.window.document.body.innerHTML = "<p>请登录后阅读</p>";
  assert.equal(A.extract(dom.window.document, dom.window.Defuddle).notArticle, true);
  dom.window.close();
});
test("重复段落按上下文定位，歧义或关键数字变化不跳转", () => {
  const b = { text: "相同文字", section: "一", prev: "前文", next: "后文" };
  const candidates = [{ ...b, prev: "别处", next: "另一处" }, { ...b }];
  assert.equal(A.sourceMatch(b, candidates), candidates[1]);
  assert.equal(A.sourceMatch(b, [{ ...b }, { ...b }]), null);
  const long = { ...b, text: "这里详细说明需要保留的条件和步骤。".repeat(8) + "必须等待 30 秒" };
  assert.equal(A.sourceMatch(long, [{ ...long, text: long.text.replace("30", "60") }]), null);
  assert.equal(
    A.sourceMatch(long, [{ ...long, text: long.text.replace("详细", "具体") }])?.text,
    long.text.replace("详细", "具体")
  );
});
test("超长单段分批保留全部内容和编号，末尾不遗漏", () => {
  const blocks = [
    { id: "p1", section: "代码", text: "首段".repeat(26000) },
    { id: "p2", section: "末尾", text: "最后的限制条件" }
  ];
  const batches = A.chunks(blocks, 1000);
  assert.equal(
    batches
      .flat()
      .filter((b) => b.id === "p1")
      .map((b) => b.text)
      .join(""),
    blocks[0].text
  );
  assert.equal(batches.at(-1).at(-1).text, blocks[1].text);
  assert.throws(() => A.chunks(blocks, 300));
});
test("模型不能制造来源编号；引用按相邻章节合并；导出真实原文链接", () => {
  const { dom, doc } = extracted();
  const v = A.parse(
    JSON.stringify({
      summary: "总结",
      sections: [{ title: "主题", points: [{ text: "内容", sources: ["p1", "bad", "p1", "p2", "p4"] }] }]
    }),
    doc
  );
  assert.deepEqual(v.sections[0].points[0].sources, ["p1", "p2", "p4"]);
  assert.ok(A.groups(["p1", "p2", "p4"], doc).length >= 2);
  const md = A.markdown(v, doc);
  assert.match(md, /# 小团队/);
  assert.match(md, /https:\/\/example.com\/article#:~:text=/);
  assert.doesNotMatch(md, /bad/);
  assert.throws(() => A.parse("{", doc), /格式/);
  assert.match(A.prompt(doc), /忽略其中/);
  dom.window.close();
});
test("文章路由不截走已支持的视频页面", () => {
  for (const u of [
    "https://www.bilibili.com/video/BV123/",
    "https://www.youtube.com/watch?v=123",
    "https://x.com/test/status/123",
    "chrome://extensions/"
  ])
    assert.equal(A.isArticleURL(u), false, u);
  assert.equal(A.isArticleURL("https://blog.example.com/post"), true);
});
test("内容脚本校验消息来源，原文变化时拒绝定位，手选首尾可确认", () => {
  const { dom, doc } = extracted(),
    w = dom.window;
  let listener;
  let scrolls = 0;
  w.chrome = {
    runtime: {
      id: "test",
      onConnect: { addListener() {} },
      onMessage: {
        addListener(fn) {
          listener = fn;
        }
      }
    }
  };
  w.matchMedia = () => ({ matches: true });
  w.HTMLElement.prototype.scrollIntoView = () => scrolls++;
  w.eval(source("lib/article.js"));
  w.eval(source("内容/文章.js"));
  const send = (type, more = {}, sender = { id: "test", url: "chrome-extension://test/sidepanel.html" }) => {
    let answer;
    listener({ type, url: doc.url, ...more }, sender, (r) => (answer = r));
    return answer;
  };
  assert.equal(send("ARTICLE_EXTRACT", {}, { id: "other", url: "https://evil.test" }), undefined);
  assert.match(send("ARTICLE_LOCATE", { sources: [{ text: "已经删除的文字" }] }).error, /更新/);
  assert.equal(scrolls, 0);
  assert.equal(send("ARTICLE_LOCATE", { sources: [doc.blocks[0].source] }).ok, true);
  assert.equal(scrolls, 1);
  send("ARTICLE_PICK");
  const ps = w.document.querySelectorAll("article p");
  ps[0].click();
  ps[2].click();
  assert.equal(send("ARTICLE_SELECTION").selection.ready, true);
  const selected = send("ARTICLE_CONFIRM").doc;
  assert.equal(selected.manual, true);
  assert.ok(selected.blocks.length >= 3);
  send("ARTICLE_CLEAR");
  dom.window.close();
});
function sidebar({ partial = false, deny = false, fail = false } = {}) {
  const dom = new JSDOM('<body><div class="panel"></div></body>', {
      url: "chrome-extension://test/sidepanel.html",
      runScripts: "outside-only",
      pretendToBeVisual: true
    }),
    w = dom.window;
  const doc = {
    url: "https://example.com/article",
    title: "测试文章",
    site: "example.com",
    blocks: [{ id: "p1", section: "主题", text: "正文", source: { text: "正文", quote: "正文" } }],
    chars: 2,
    partial,
    warnings: partial ? ["存在折叠"] : [],
    notArticle: false
  };
  const calls = [];
  let modelCalls = 0,
    connections = 0;
  w.chrome = {
    permissions: { request: async () => !deny },
    tabs: {
      get: async () => ({ url: doc.url }),
      sendMessage: async (id, msg) => {
        calls.push(msg);
        return msg.type === "ARTICLE_EXTRACT" ? { doc } : { ok: true };
      },
      connect: () => {
        connections++;
        return { disconnect() {}, onDisconnect: { addListener() {} } };
      }
    },
    runtime: { openOptionsPage: async () => {} },
    scripting: { executeScript: async () => {} }
  };
  w.articleModelConfig = async (tier) => ({ key: "test", base: "https://api.example.com/v1", model: `${tier}-model` });
  w.requestPromptModel = async (prompt, cfg) => {
    modelCalls++;
    assert.equal(cfg.model, "smart-model");
    if (fail && modelCalls === 1) throw Error("暂时失败");
    return JSON.stringify({
      summary: "全文摘要",
      sections: [{ title: "主题", points: [{ text: "概括", sources: ["p1"] }] }]
    });
  };
  w.eval(source("lib/article.js"));
  w.eval(source("侧栏/文章.js"));
  const panel = w.BiliCaptionArticlePanel;
  panel.activate({ id: 1, url: doc.url, title: doc.title });
  return { dom, w, panel, calls, models: () => modelCalls, connections: () => connections };
}
test("打开文章不调用模型，点击后完整生成且复用通信连接", async () => {
  const h = sidebar();
  assert.equal(h.models(), 0);
  assert.equal(h.calls.length, 0);
  await h.panel.read();
  assert.equal(h.models(), 1);
  assert.match(h.w.document.body.textContent, /全文摘要/);
  assert.match(h.w.document.body.textContent, /查看原文/);
  assert.equal(h.connections(), 1);
  h.panel.deactivate();
  h.dom.window.close();
});
test("拒绝网站权限和部分正文都不会直接发模型", async () => {
  for (const opts of [{ deny: true }, { partial: true }]) {
    const h = sidebar(opts);
    await h.panel.read();
    assert.equal(h.models(), 0);
    assert.match(h.w.document.body.textContent, opts.deny ? /需要允许/ : /当前范围总结/);
    h.panel.deactivate();
    h.dom.window.close();
  }
});
test("模型失败重试复用正文，切换页面会丢弃迟到响应", async () => {
  const h = sidebar({ fail: true });
  await h.panel.read();
  assert.match(h.w.document.body.textContent, /暂时失败/);
  await h.panel.generate();
  assert.equal(h.calls.filter((m) => m.type === "ARTICLE_EXTRACT").length, 1);
  assert.equal(h.models(), 2);
  let finish;
  h.w.requestPromptModel = () => new Promise((resolve) => (finish = resolve));
  const pending = h.panel.generate();
  while (!finish) await new Promise((r) => setTimeout(r, 0));
  h.panel.activate({ id: 2, url: "https://example.com/second", title: "第二篇" });
  finish(JSON.stringify({ summary: "旧文章结果", sections: [] }));
  await pending;
  assert.doesNotMatch(h.w.document.body.textContent, /旧文章结果/);
  assert.match(h.w.document.body.textContent, /第二篇/);
  h.panel.deactivate();
  h.dom.window.close();
});
test("来源按钮实际发送定位，复制和下载输出 Markdown", async () => {
  const h = sidebar();
  let copied = "",
    downloaded = false,
    downloadBlob;
  Object.defineProperty(h.w.navigator, "clipboard", {
    value: {
      writeText: async (text) => {
        copied = text;
      }
    }
  });
  h.w.URL.createObjectURL = (blob) => {
    downloadBlob = blob;
    return "blob:test";
  };
  h.w.URL.revokeObjectURL = () => {};
  h.w.HTMLAnchorElement.prototype.click = function () {
    downloaded = this.download.endsWith(".md");
  };
  await h.panel.read();
  const click = (text) =>
    [...h.w.document.querySelectorAll("button")].find((b) => b.textContent.startsWith(text)).click();
  click("查看原文");
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(h.calls.some((m) => m.type === "ARTICLE_LOCATE" && m.sources[0].text === "正文"));
  click("复制总结");
  await new Promise((r) => setTimeout(r, 0));
  assert.match(copied, /全文摘要/);
  assert.match(copied, /#:~:text=/);
  click("下载 Markdown");
  assert.equal(downloaded, true);
  assert.ok(downloadBlob.size > 0);
  h.panel.deactivate();
  h.dom.window.close();
});
test("同页重新生成后，上一轮迟到的错误不覆盖新结果", async () => {
  const h = sidebar();
  await h.panel.read();
  let rejectOld;
  h.w.requestPromptModel = () => new Promise((_, reject) => (rejectOld = reject));
  const old = h.panel.generate();
  while (!rejectOld) await new Promise((r) => setTimeout(r, 0));
  h.w.requestPromptModel = async () => JSON.stringify({ summary: "最新结果", sections: [] });
  await h.panel.generate();
  rejectOld(Error("旧错误"));
  await old;
  assert.match(h.w.document.body.textContent, /最新结果/);
  assert.doesNotMatch(h.w.document.body.textContent, /旧错误/);
  h.panel.deactivate();
  h.dom.window.close();
});
test("文章输出被截断时拒绝显示成功，普通字幕总结保持原行为", async () => {
  const vm = require("node:vm");
  let notices = 0;
  const context = vm.createContext({
    BiliCaptionModelCall: { chat: async () => ({ text: "{}", truncated: true }) },
    flash: () => notices++
  });
  vm.runInContext(source("侧栏/总结与模型.js"), context);
  await assert.rejects(context.requestPromptModel("test", { task: "article-summary" }), /输出长度/);
  assert.equal(await context.requestPromptModel("test", { task: "summary" }), "{}");
  assert.equal(notices, 1);
});
function xMode(html, url = "https://x.com/author/status/123") {
  const d = new JSDOM(html, { url, runScripts: "outside-only" });
  const mode = d.window.eval(`(${A.inspectXPage.toString()})(${JSON.stringify(url)})`);
  d.window.close();
  return mode.mode;
}
test("X status 根据当前帖子内容识别文章，长文内有演示视频仍为文章", () => {
  for (const media of ["", "<video></video>"])
    assert.equal(
      xMode(
        `<article data-testid="tweet"><article data-testid="twitterArticleReadView"><a href="/author/article/123/media/789">封面</a><div data-testid="twitterArticleRichTextView">长文正文</div>${media}</article></article>`
      ),
      "article"
    );
  assert.equal(A.isArticleURL("https://x.com/author/status/123", "article"), true);
  assert.equal(A.isArticleURL("https://x.com/author/status/123/video/1", "article"), false);
});
test("X 不把回复和引用里的文章或视频当成当前帖内容，加载中不推测", () => {
  const main =
    '<article data-testid="tweet"><a href="/author/status/123"><time>今天</time></a><div data-testid="tweetText">文字帖</div>';
  assert.equal(xMode(main + '<div data-testid="quoteTweet"><video></video></div></article>'), "article");
  assert.equal(
    xMode(
      main +
        '<video></video></article><article data-testid="tweet"><article data-testid="twitterArticleReadView"><a href="/other/article/999">另一篇文章</a></article></article>'
    ),
    "video"
  );
  assert.equal(xMode("<main>加载中</main>"), "pending");
  assert.equal(
    xMode(
      main +
        '<div data-testid="quoteTweet"><article data-testid="twitterArticleReadView"><a href="/other/article/999">引用</a></article></div><video></video></article>'
    ),
    "video"
  );
});
test("侧栏 X 分类探测只读页面，不发模型请求，文章进入文章模式", async () => {
  const h = sidebar();
  h.w.chrome.scripting.executeScript = async (options) => {
    assert.equal(options.args[0], "https://x.com/author/status/123");
    return [{ result: { mode: "article" } }];
  };
  const tab = await h.panel.resolveTab({ id: 2, url: "https://x.com/author/status/123", title: "长文" });
  assert.equal(tab.articleMode, "article");
  assert.equal(h.panel.activate(tab), true);
  assert.match(h.w.document.body.textContent, /总结文章/);
  assert.equal(h.models(), 0);
  h.panel.deactivate();
  h.dom.window.close();
});
test("浮窗偏好不关闭文章侧栏或未加载的 X 页面，视频侧栏仍关闭", async () => {
  const vm = require("node:vm");
  let closes = 0;
  const ctx = vm.createContext({
    inFloatEmbed: () => false,
    BiliCaptionArticle: A,
    BiliCaptionArticlePanel: { resolveTab: async (tab) => tab },
    chrome: {
      sidePanel: {
        close: async () => {
          closes++;
        }
      }
    }
  });
  vm.runInContext(source("侧栏/标签页通信.js"), ctx);
  ctx.loadDockUiPrefs = async () => ({ preferSidebar: false });
  for (const mode of ["article", "pending"]) {
    ctx.getActiveTab = async () => ({ id: 1, url: "https://x.com/author/status/123", articleMode: mode });
    assert.equal(await ctx.hideChromePanelIfFloating(), false);
  }
  assert.equal(closes, 0);
  ctx.getActiveTab = async () => ({ id: 1, url: "https://x.com/author/status/123", articleMode: "video" });
  assert.equal(await ctx.hideChromePanelIfFloating(), true);
  assert.equal(closes, 1);
});
test("X 文章忽略趋势栏展开控件，嵌套标题只保留一次用于准确定位", () => {
  const dom = page(),
    d = dom.window.document;
  dom.reconfigure({ url: "https://x.com/author/status/123" });
  d.querySelector("article").setAttribute("data-testid", "twitterArticleReadView");
  d.querySelector("h2").innerHTML = "<div>嵌套标题</div>";
  d.body.insertAdjacentHTML("beforeend", '<aside data-testid="sidebarColumn"><button>Show more</button></aside>');
  const doc = A.extract(d, dom.window.Defuddle);
  assert.equal(doc.partial, false);
  assert.equal(A.scan(d).filter((b) => b.text === "嵌套标题").length, 1);
  dom.window.close();
});
test("流式 JSON 未闭合时显示摘要和要点，不泄露协议或残缺转义", () => {
  assert.equal(A.streamPreview('{"summary":"正在生成').summary, "正在生成");
  assert.equal(A.streamPreview('{"summary":"转义\\u4e').summary, "转义");
  assert.equal(A.streamPreview('{"summary":"换行\\n内容').summary, "换行\n内容");
  const raw = JSON.stringify({
    summary: "主题",
    sections: [{ title: "章节", points: [{ text: "第一个要点", sources: ["p1"] }] }]
  });
  for (let i = 0; i <= raw.length; i++) {
    const p = A.streamPreview(raw.slice(0, i));
    assert.ok("主题".startsWith(p.summary));
    assert.ok(p.sections.every((s) => "章节".startsWith(s.title)));
  }
  assert.equal(A.streamPreview(raw.slice(0, raw.indexOf("个要点"))).sections[0].points[0].text, "第一");
  assert.deepEqual(A.streamPreview(raw).sections[0].points[0].sources, []);
});
test("流式输出增量更新文字，保留进度文字、思考球容器及已显示要点节点", async () => {
  const h = sidebar();
  let emit, finish;
  h.w.requestPromptModel = (_, cfg) => {
    emit = cfg.onDelta;
    return new Promise((r) => (finish = r));
  };
  const running = h.panel.read();
  while (!emit) await new Promise((r) => setTimeout(r, 0));
  const label = h.w.document.querySelector(".article-busy-label"),
    orb = h.w.document.querySelector(".article-orb");
  emit('{"summary":"核心结');
  await new Promise((r) => setTimeout(r, 85));
  assert.match(h.w.document.body.textContent, /核心结/);
  emit('{"summary":"核心结论","sections":[{"title":"主题","points":[{"text":"逐字');
  await new Promise((r) => setTimeout(r, 85));
  const point = h.w.document.querySelector(".article-stream .article-point");
  assert.equal(point.textContent, "逐字");
  emit('{"summary":"核心结论","sections":[{"title":"主题","points":[{"text":"逐字输出');
  await new Promise((r) => setTimeout(r, 85));
  assert.equal(point.textContent, "逐字输出");
  assert.equal(h.w.document.querySelector(".article-busy-label"), label);
  assert.equal(h.w.document.querySelector(".article-orb"), orb);
  finish(
    JSON.stringify({
      summary: "核心结论",
      sections: [{ title: "主题", points: [{ text: "逐字输出", sources: ["p1"] }] }]
    })
  );
  await running;
  h.panel.deactivate();
  h.dom.window.close();
});
test("长文分段与最终汇总都实时输出，开始下一段时保留前面内容", async () => {
  const h = sidebar();
  h.w.BiliCaptionArticle.plan = (doc) => ({ batches: [doc.blocks, doc.blocks], calls: 3 });
  const calls = [];
  h.w.requestPromptModel = (_, cfg) => new Promise((resolve) => calls.push({ cfg, resolve }));
  const running = h.panel.read();
  const wait = async (n) => {
    while (calls.length < n) await new Promise((r) => setTimeout(r, 0));
  };
  const result = (text) =>
    JSON.stringify({ summary: text, sections: [{ title: "主题", points: [{ text, sources: ["p1"] }] }] });
  await wait(1);
  calls[0].resolve(result("第一部分"));
  await wait(2);
  assert.match(h.w.document.body.textContent, /第一部分/);
  calls[1].cfg.onDelta('{"summary":"第二部分');
  await new Promise((r) => setTimeout(r, 85));
  assert.match(h.w.document.body.textContent, /第一部分/);
  assert.match(h.w.document.body.textContent, /第二部分/);
  calls[1].resolve(result("第二部分"));
  await wait(3);
  assert.equal(typeof calls[2].cfg.onDelta, "function");
  calls[2].cfg.onDelta('{"summary":"合并后的简短');
  await new Promise((r) => setTimeout(r, 85));
  assert.match(h.w.document.body.textContent, /合并后的简短/);
  calls[2].resolve(result("最终结论"));
  await running;
  h.panel.deactivate();
  h.dom.window.close();
});
test("万字文章紧凑请求可一次总结，提示词要求压缩而非逐段改写", () => {
  const blocks = Array.from({ length: 150 }, (_, i) => ({
    id: `p${i}`,
    section: "章节标题".repeat(8) + Math.floor(i / 25),
    type: "p",
    text: "正文内容".repeat(17)
  }));
  assert.equal(A.chunks(blocks).length, 1);
  const prompt = A.prompt({ title: "万字文章", blocks }, blocks);
  assert.ok(prompt.length < 24000);
  assert.match(prompt, /合计最多 10 条要点/);
  assert.match(prompt, /合计不超过 1200 字/);
  assert.match(prompt, /不是逐段改写/);
});
test("正文聚焦在滚动期间不重新扫描网页或匹配段落", async () => {
  const { dom, doc } = extracted(),
    w = dom.window;
  let listener,
    scans = 0;
  w.chrome = {
    runtime: {
      id: "test",
      onConnect: { addListener() {} },
      onMessage: {
        addListener(fn) {
          listener = fn;
        }
      }
    }
  };
  w.eval(source("lib/article.js"));
  const scan = w.BiliCaptionArticle.scan;
  w.BiliCaptionArticle.scan = (...args) => {
    scans++;
    return scan(...args);
  };
  w.eval(source("内容/文章.js"));
  const send = (type, more = {}) =>
    listener({ type, url: doc.url, ...more }, { id: "test", url: "chrome-extension://test/sidepanel.html" }, () => {});
  send("ARTICLE_EXTRACT");
  send("ARTICLE_RANGE", { on: "scan", doc });
  const before = scans;
  for (let i = 0; i < 5; i++) {
    w.document.dispatchEvent(new w.Event("scroll"));
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(scans, before);
  send("ARTICLE_CLEAR");
  dom.window.close();
});
