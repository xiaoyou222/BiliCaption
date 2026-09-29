// 文章模式：审查发现的问题回归测试，以及分档模型、成本确认、缓存、失败续跑。
// 侧栏用 jsdom 跑真实的 lib/article.js + 侧栏/文章.js，chrome 接口按需打桩。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const A = require("../lib/article.js");

const root = path.join(__dirname, "..");
const source = (file) => fs.readFileSync(path.join(root, file), "utf8");
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, label = "条件") {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await tick(2);
  }
  throw new Error(`等待超时：${label}`);
}

// ---- 侧栏测试台 ----

function makeDoc(url, texts = ["正文"], extra = {}) {
  const blocks = texts.map((text, i) => ({
    id: `p${i + 1}`,
    type: "p",
    section: "主题",
    text,
    source: { text, quote: text, section: "主题", prev: "", next: "" }
  }));
  return {
    url,
    title: "测试文章",
    site: "e.com",
    blocks,
    chars: texts.join("").length,
    partial: false,
    warnings: [],
    notArticle: false,
    fingerprint: A.fingerprint(JSON.stringify(texts)),
    ...extra
  };
}

const answer = (text, sources = ["p1"]) =>
  JSON.stringify({ summary: text, sections: [{ title: "主题", points: [{ text, sources }] }] });

function sidebar({ store = {}, granted = true } = {}) {
  const dom = new JSDOM('<body><div class="panel"></div></body>', {
    url: "chrome-extension://t/sidepanel.html",
    runScripts: "outside-only",
    pretendToBeVisual: true
  });
  const w = dom.window;
  const h = {
    dom,
    w,
    store,
    tabs: { 1: "https://e.com/a", 2: "https://e.com/b" },
    docs: {},
    calls: [],
    logs: [],
    ports: [],
    models: [],
    pick: null,
    removed: null
  };
  h.docFor = (id) => h.docs[id] || makeDoc(h.tabs[id]);
  w.chrome = {
    permissions: { request: async () => true, contains: async () => granted },
    tabs: {
      get: async (id) => {
        if (!h.tabs[id]) throw new Error("No tab with id");
        return { id, url: h.tabs[id] };
      },
      sendMessage: async (id, message) => {
        h.calls.push([id, message.type, message]);
        if (message.type === "ARTICLE_EXTRACT") return { doc: h.docFor(id) };
        if (message.type === "ARTICLE_SELECTION") return { ok: true, selection: h.pick };
        if (message.type === "ARTICLE_CONFIRM") return { doc: h.docFor(id) };
        return { ok: true };
      },
      connect: (id) => {
        const port = {
          tabId: id,
          closed: false,
          disconnect() {
            this.closed = true;
          },
          onDisconnect: { addListener() {} }
        };
        h.ports.push(port);
        return port;
      },
      onRemoved: {
        addListener(fn) {
          h.removed = fn;
        }
      }
    },
    runtime: {
      openOptionsPage: async () => {},
      sendMessage: async (message) => {
        if (message.type === "APPEND_LOG") h.logs.push(message);
        return { ok: true };
      }
    },
    scripting: { executeScript: async () => {} },
    storage: {
      local: {
        async get(key) {
          return key in store ? { [key]: store[key] } : {};
        },
        async set(values) {
          Object.assign(store, JSON.parse(JSON.stringify(values)));
        },
        async remove(key) {
          delete store[key];
        }
      }
    }
  };
  w.articleModelConfig = async (tier) => ({
    key: "k",
    base: "https://api.example.com/v1",
    provider: "OpenAI",
    model: tier === "fast" ? "fast-model" : "smart-model"
  });
  h.reply = async (prompt, cfg) => answer("全文摘要");
  w.requestPromptModel = (prompt, cfg) => {
    h.models.push({ prompt, cfg });
    return h.reply(prompt, cfg, h.models.length);
  };
  w.eval(source("lib/article.js"));
  w.eval(source("侧栏/文章.js"));
  h.P = w.BiliCaptionArticlePanel;
  h.text = () => w.document.body.textContent;
  h.button = (label) => [...w.document.querySelectorAll("button")].find((b) => b.textContent.startsWith(label));
  h.click = async (label) => {
    const b = h.button(label);
    assert.ok(b, `找不到按钮：${label}`);
    b.click();
    await tick(5);
  };
  h.open = (id) => h.P.activate({ id, url: h.tabs[id], title: `文章 ${id}` });
  h.close = () => {
    h.P.deactivate();
    dom.window.close();
  };
  return h;
}

// ---- 1. 生成中手动选择范围 ----

test("生成中切到手动选择再取消，不会卡在没有任务的生成中状态", async () => {
  const h = sidebar();
  let finish;
  h.reply = () => new Promise((resolve) => (finish = resolve));
  h.open(1);
  h.P.read();
  await until(() => finish, "开始生成");
  await h.click("不准确？");
  await h.click("手动选择范围");
  await until(() => h.text().includes("手动选择正文"), "进入手选");
  await h.click("取消");
  assert.equal(h.w.document.querySelector(".article-progress"), null);
  assert.match(h.text(), /已中断，可重新生成/);
  assert.ok(h.button("重试"));
  finish(answer("迟到的结果"));
  await tick(10);
  assert.doesNotMatch(h.text(), /迟到的结果/);
  assert.ok(h.logs.some((log) => log.scope === "article" && /中断/.test(log.message)));
  h.close();
});

test("手选时按 Esc（页面清空选择）或切走，同样退回可恢复的状态", async () => {
  const h = sidebar();
  let finish;
  h.reply = () => new Promise((resolve) => (finish = resolve));
  h.open(1);
  h.P.read();
  await until(() => finish, "开始生成");
  await h.click("不准确？");
  await h.click("手动选择范围");
  h.pick = { start: "第一段", end: "", ready: false, count: 0 };
  await tick(600);
  h.pick = null;
  await until(() => !h.text().includes("手动选择正文"), "Esc 后退出手选");
  assert.equal(h.w.document.querySelector(".article-progress"), null);
  assert.match(h.text(), /已中断，可重新生成/);
  h.close();

  const g = sidebar();
  g.reply = () => new Promise(() => {});
  g.open(1);
  g.P.read();
  await until(() => g.models.length, "开始生成");
  await g.click("不准确？");
  await g.click("手动选择范围");
  g.open(2);
  g.open(1);
  assert.equal(g.w.document.querySelector(".article-progress"), null);
  assert.match(g.text(), /已中断，可重新生成/);
  g.close();
});

// ---- 2. 视频页不进入文章模式 ----

test("B 站、YouTube、X 的各种视频地址都不进入文章模式", () => {
  const videos = [
    "https://www.bilibili.com/video/BV1xx411c7mD/",
    "https://www.bilibili.com/list/ml123456?bvid=BV1xx411c7mD&oid=1",
    "https://www.bilibili.com/list/watchlater?bvid=BV1xx411c7mD",
    "https://www.bilibili.com/festival/2025bnj?bvid=BV1xx411c7mD",
    "https://m.bilibili.com/video/BV1xx411c7mD",
    "https://www.bilibili.com/bangumi/play/ep12345",
    "https://www.youtube.com/watch?v=abcdefghijk",
    "https://m.youtube.com/watch?v=abcdefghijk",
    "https://youtu.be/abcdefghijk",
    "https://www.youtube.com/shorts/abcdefghijk",
    "https://x.com/a/status/123/video/1",
    "https://x.com/a/status/123"
  ];
  for (const url of videos) assert.equal(A.isArticleURL(url), false, url);
  assert.equal(A.isArticleURL("https://www.bilibili.com/read/cv123456"), true);
  assert.equal(A.isArticleURL("https://x.com/a/status/123", "article"), true);
});

// ---- 3. 重新总结失败保留旧结果 ----

test("重新总结失败、非文章或中止时保留上次结果并提示", async () => {
  const h = sidebar();
  h.reply = async () => answer("旧的好结果");
  h.open(1);
  await h.P.read();
  assert.match(h.text(), /旧的好结果/);

  h.reply = async () => {
    throw new Error("网络错误");
  };
  await h.P.read();
  assert.match(h.text(), /旧的好结果/);
  assert.match(h.text(), /重新总结失败，已保留上次结果/);
  assert.ok(h.button("复制总结"));

  h.docs[1] = makeDoc(h.tabs[1], ["请登录"], { notArticle: true });
  await h.P.read();
  assert.match(h.text(), /旧的好结果/);
  assert.match(h.text(), /重新总结失败，已保留上次结果/);
  assert.ok(h.logs.every((log) => log.scope === "article"));
  h.close();
});

// ---- 4. 重新总结的变化提示 ----

test("正文未变时提示正文未变化；正文变了按段落增删说明", async () => {
  const h = sidebar();
  let n = 0;
  h.reply = async () => answer(`措辞 ${n++}`);
  h.open(1);
  await h.P.read();
  await h.P.read();
  const scope = () => [...h.w.document.querySelectorAll(".article-scope")].map((el) => el.textContent).join("\n");
  assert.match(scope(), /正文未变化/);
  assert.doesNotMatch(scope(), /旧要点被替换/);

  h.docs[1] = makeDoc(h.tabs[1], ["正文", "新增的一段"]);
  await h.P.read();
  assert.match(scope(), /新增 1 段/);
  h.docs[1] = makeDoc(h.tabs[1], ["改过的正文", "新增的一段"]);
  await h.P.read();
  assert.match(scope(), /修改 1 段/);
  h.close();
});

test("段落变化统计：新增、删除、修改分别计数", () => {
  const before = makeDoc("https://e.com/a", ["一", "二", "三"]);
  assert.deepEqual(A.describeChange(before, before).same, true);
  const change = A.describeChange(before, makeDoc("https://e.com/a", ["一", "二改", "三", "四"]));
  assert.equal(change.same, false);
  assert.equal(change.added, 1);
  assert.equal(change.modified, 1);
  assert.equal(change.removed, 0);
  const dropped = A.describeChange(before, makeDoc("https://e.com/a", ["一"]));
  assert.equal(dropped.removed, 2);
  assert.match(dropped.text, /删除 2 段/);
});

// ---- 5. 每个标签页各自的连接 ----

test("后台任务先连了别的标签页，当前标签页仍单独连接；关闭侧栏断开全部连接", async () => {
  const h = sidebar();
  let finish;
  h.reply = () => new Promise((resolve) => (finish = resolve));
  let allow;
  h.w.chrome.permissions.request = () => new Promise((resolve) => (allow = resolve));
  h.open(1);
  const first = h.P.read();
  h.open(2);
  allow(true);
  await until(() => finish, "第一篇开始生成");
  h.w.chrome.permissions.request = async () => true;
  h.reply = async () => answer("第二篇");
  await h.P.read();
  assert.ok(
    h.ports.some((p) => p.tabId === 2),
    JSON.stringify(h.ports.map((p) => p.tabId))
  );
  assert.ok(h.ports.some((p) => p.tabId === 1));
  finish(answer("第一篇"));
  await first;
  h.w.dispatchEvent(new h.w.Event("pagehide"));
  assert.ok(
    h.ports.every((p) => p.closed),
    "关闭侧栏后所有标签页的连接都断开"
  );
  h.dom.window.close();
});

// ---- 6. 关闭标签页、会话淘汰 ----

test("关闭标签页中止该页的任务并记日志，不再调用模型", async () => {
  const h = sidebar();
  let signal;
  h.reply = (prompt, cfg) => {
    signal = cfg.signal;
    return new Promise(() => {});
  };
  h.open(1);
  h.P.read();
  await until(() => signal, "开始生成");
  h.open(2);
  assert.equal(typeof h.removed, "function", "监听了 chrome.tabs.onRemoved");
  h.removed(1);
  assert.equal(signal.aborted, true);
  assert.ok(h.logs.some((log) => log.scope === "article" && /标签页已关闭/.test(log.message)));
  h.open(1);
  assert.match(h.text(), /总结文章/, "重新打开是全新的会话");
  h.close();
});

test("会话超过上限按最近使用淘汰，正在运行的最后淘汰", async () => {
  const h = sidebar();
  // 不写缓存：被淘汰的会话重新打开时应是全新的
  h.w.chrome.storage.local.set = async () => {};
  for (let i = 1; i <= 13; i++) h.tabs[i] = `https://e.com/${i}`;
  let signal;
  h.reply = (prompt, cfg) => {
    signal = cfg.signal;
    return new Promise(() => {});
  };
  h.open(1);
  h.P.read();
  await until(() => signal, "第一篇开始生成");
  h.reply = async () => answer("完成");
  for (let i = 2; i <= 12; i++) {
    h.open(i);
    await h.P.read();
  }
  h.open(2); // 最近用过第 2 篇
  h.open(13);
  assert.equal(signal.aborted, false, "正在运行的第一篇不被淘汰");
  h.open(2);
  assert.match(h.text(), /完成/, "最近用过的第 2 篇仍在");
  h.open(3);
  assert.match(h.text(), /总结文章/, "最久没用的已完成会话（第 3 篇）被淘汰");
  h.close();
});

// ---- 7. 段落对应 ----

function layoutPage() {
  const dom = new JSDOM(source("测试/夹具/文章排版.html"), {
    url: "https://mp.weixin.qq.com/s/abc",
    runScripts: "outside-only",
    pretendToBeVisual: true
  });
  dom.window.eval(source("lib/vendor/defuddle.js"));
  return dom;
}

test("公众号式 section/span、嵌套列表、<br> 分段、图注和定义都能对应回原网页", () => {
  const dom = layoutPage();
  const doc = A.extract(dom.window.document, dom.window.Defuddle);
  const missing = doc.blocks.filter((b) => !b.source);
  assert.deepEqual(
    missing.map((b) => b.text),
    []
  );
  assert.ok(!doc.warnings.some((w) => /无法与原网页段落对应/.test(w)), doc.warnings.join());
  const all = doc.blocks.map((b) => b.text).join("\n");
  assert.match(all, /图 1：模块化单体的分层结构/);
  assert.match(all, /一个部署单元内部按业务划分模块/);
  assert.match(all, /子项：一个三人团队/);
  assert.match(A.prompt(doc), /图 1：模块化单体/);
  assert.ok(doc.blocks.filter((b) => /换行分隔的正文/.test(b.text)).length >= 3, "<br><br> 分开的段落各自成段");
  const code = doc.blocks.find((b) => b.type === "pre");
  assert.ok(code && !/\d\s*$/.test(code.source.text), "代码行号不参与比对");
  dom.window.close();
});

test("比对忽略所有空白、不间断空格和全半角标点差异", () => {
  assert.equal(A.matchKey("误区一：认为 服务 越多"), A.matchKey("误区一:认为服务越多"));
  assert.equal(A.matchKey("Ｈｅｌｌｏ， world！"), A.matchKey("Hello,world!"));
  const block = { text: "小团队 在业务边界 尚未稳定时", section: "一", prev: "", next: "" };
  const candidates = [{ text: "小团队在业务边界尚未稳定时", section: "一", prev: "", next: "" }];
  assert.equal(A.sourceMatch(block, candidates), candidates[0]);
});

// ---- 8. 折叠控件只看正文附近 ----

test("评论和相关推荐里的展开、Read more 不把正文判为部分；正文末尾的展开阅读全文才算", () => {
  const dom = layoutPage();
  const doc = A.extract(dom.window.document, dom.window.Defuddle);
  assert.equal(doc.partial, false, doc.warnings.join());
  dom.window.document
    .querySelector("#js_content")
    .insertAdjacentHTML(
      "afterend",
      '<div class="hide-article-box"><a class="btn-readmore">展开阅读全文 <svg></svg></a></div>'
    );
  const folded = A.extract(dom.window.document, dom.window.Defuddle);
  assert.equal(folded.partial, true);
  dom.window.close();
  for (const label of ["阅读全文", "展开全文", "查看全部", "继续阅读", "展开剩余 85%"]) {
    const page = layoutPage();
    page.window.document.querySelector("#js_content").insertAdjacentHTML("beforeend", `<button>${label}</button>`);
    assert.equal(A.extract(page.window.document, page.window.Defuddle).partial, true, label);
    page.window.close();
  }
});

// ---- 9. 模型分档 ----

test("模型分档：自定义网关按 xy 别名，其它服务商用主模型 / 翻译模型", () => {
  const ctx = vm.createContext({});
  vm.runInContext(source("lib/providers.js"), ctx);
  const P = ctx.BiliCaptionProviders;
  const gateway = {
    sumProvider: "自定义",
    apiBase: "https://gw.example/v1",
    apiKey: "k",
    apiModel: "xy-smart",
    translateModel: ""
  };
  // 完全按设置走：主模型填什么，智能档就用什么；不再把别名替换成 xy-smart
  assert.equal(P.resolveTier(gateway, "smart").model, "xy-smart");
  assert.equal(P.resolveTier(gateway, "fast").model, "xy-smart");
  const fastOnly = { ...gateway, apiModel: "xy-fast" };
  assert.equal(P.resolveTier(fastOnly, "smart").model, "xy-fast");
  assert.equal(P.resolveTier(fastOnly, "fast").model, "xy-fast");
  assert.equal(
    P.resolveTier({ ...gateway, apiModel: "my-model", translateModel: "xy-fast" }, "smart").model,
    "my-model"
  );
  assert.equal(
    P.resolveTier({ ...gateway, apiModel: "my-model", translateModel: "xy-fast" }, "fast").model,
    "xy-fast"
  );
  const custom = { ...gateway, apiModel: "my-model", translateModel: "my-fast" };
  assert.equal(P.resolveTier(custom, "smart").model, "my-model");
  assert.equal(P.resolveTier(custom, "fast").model, "my-fast");
  const openai = { sumProvider: "OpenAI", apiKey: "k", apiModel: "gpt-6-luna", translateModel: "" };
  assert.equal(P.resolveTier(openai, "fast").model, "gpt-6-luna");
  assert.equal(P.resolveTier({ ...openai, translateModel: "gpt-5.4-mini" }, "fast").model, "gpt-5.4-mini");
  assert.equal(P.resolveTier({ ...openai, translateModel: "gpt-5.4-mini" }, "smart").model, "gpt-6-luna");
  assert.equal(P.resolveTier(openai, "smart").base, "https://api.openai.com/v1");
});

test("快速档按翻译类任务降思考，智能档保持服务商默认", () => {
  const ctx = vm.createContext({});
  vm.runInContext(source("lib/模型路由.js"), ctx);
  const R = ctx.BiliCaptionModelRoute;
  assert.deepEqual(
    { ...R.requestFields({ provider: "Gemini", model: "gemini-3.8-flash", task: "article-fast" }) },
    { reasoning_effort: "low" }
  );
  assert.deepEqual(
    { ...R.requestFields({ provider: "Gemini", model: "gemini-3.8-flash", task: "article-summary" }) },
    {}
  );
  assert.deepEqual({ ...R.requestFields({ provider: "自定义", model: "xy-fast", task: "article-fast" }) }, {});
});

test("长文分段走快速档、汇总走智能档；单段直接走智能档；不按域名写死模型", async () => {
  assert.doesNotMatch(source("侧栏/文章.js"), /cpa\.xiaoyou\.love|xy-smart/);
  const h = sidebar();
  h.w.BiliCaptionArticle.plan = (doc) => ({ batches: [doc.blocks, doc.blocks], calls: 3 });
  h.reply = async (prompt, cfg, i) => answer(`第 ${i} 次`);
  h.open(1);
  await h.P.read();
  assert.deepEqual(
    h.models.map((m) => [m.cfg.model, m.cfg.task]),
    [
      ["fast-model", "article-fast"],
      ["fast-model", "article-fast"],
      ["smart-model", "article-summary"]
    ]
  );
  h.close();
  const single = sidebar();
  single.open(1);
  await single.P.read();
  assert.deepEqual(
    single.models.map((m) => [m.cfg.model, m.cfg.task]),
    [["smart-model", "article-summary"]]
  );
  single.close();
});

// ---- 10. 成本保护 ----

test("按 token 估算分段：中文约 1 字 1 token，英文约 4 字符 1 token", () => {
  assert.equal(A.estimateTokens("中文字符"), 4);
  assert.equal(A.estimateTokens("abcdefgh"), 2);
  const blocks = Array.from({ length: 300 }, (_, i) => ({
    id: `p${i + 1}`,
    section: "章",
    type: "p",
    text: "中".repeat(100)
  }));
  const batches = A.chunks(blocks);
  assert.equal(batches.length, 3);
  for (const batch of batches) assert.ok(batch.reduce((n, b) => n + A.estimateTokens(b.text), 0) <= A.CHUNK_TOKENS);
  const english = Array.from({ length: 300 }, (_, i) => ({
    id: `p${i + 1}`,
    section: "s",
    type: "p",
    text: "word ".repeat(20)
  }));
  assert.equal(A.chunks(english).length, 1, "同样字数的英文按 4 字符 1 token 估算，一段装得下");
  assert.equal(A.plan({ blocks }).calls, 4);
  assert.equal(A.plan({ blocks: blocks.slice(0, 100) }).calls, 1);
});

test("总正文超过约 20 万字时拒绝，提示手动选择范围", () => {
  assert.ok(A.MAX_CHARS <= 200000);
  const paragraphs = Array.from({ length: 45 }, () => `<p>${"长文".repeat(2500)}</p>`).join("");
  const dom = new JSDOM(`<html><head><title>T</title></head><body><article>${paragraphs}</article></body></html>`, {
    url: "https://e.com/long",
    runScripts: "outside-only",
    pretendToBeVisual: true
  });
  dom.window.eval(source("lib/vendor/defuddle.js"));
  assert.throws(() => A.extract(dom.window.document, dom.window.Defuddle), /手动选择/);
  dom.window.close();
});

test("预计调用超过 3 次先确认；取消不调用模型并记日志，继续后才开始", async () => {
  const h = sidebar();
  h.w.BiliCaptionArticle.plan = (doc) => ({ batches: [doc.blocks, doc.blocks, doc.blocks], calls: 4 });
  h.open(1);
  await h.P.read();
  assert.equal(h.models.length, 0);
  assert.match(h.text(), /全文较长，预计分 3 段调用模型/);
  await h.click("取消");
  assert.equal(h.models.length, 0);
  assert.ok(h.logs.some((log) => log.scope === "article" && /取消/.test(log.message)));
  await h.P.read();
  await h.click("继续");
  await until(() => h.text().includes("复制总结"), "确认后生成完成");
  assert.equal(h.models.length, 4);
  h.close();
});

// ---- 11. 缓存 ----

test("缓存键去掉跟踪参数和 hash", () => {
  assert.equal(
    A.cacheKey("https://e.com/post?id=7&utm_source=x&utm_medium=y&fbclid=1#top"),
    "article:v1:https://e.com/post?id=7"
  );
  assert.equal(A.cacheKey("https://e.com/post?b=2&a=1"), A.cacheKey("https://e.com/post?a=1&b=2"));
});

test("生成后写入缓存；再次打开直接显示上次总结不调用模型；正文变化只提示", async () => {
  const store = {};
  const h = sidebar({ store });
  h.reply = async () => answer("缓存里的总结");
  h.open(1);
  await h.P.read();
  await until(() => store[A.cacheKey(h.tabs[1])], "写入缓存");
  const entry = store[A.cacheKey(h.tabs[1])];
  assert.equal(entry.fingerprint, h.docFor(1).fingerprint);
  assert.equal(entry.model, "smart-model");
  assert.ok(entry.generatedAt > 0);
  assert.equal(entry.value.summary, "缓存里的总结");
  h.close();

  const again = sidebar({ store });
  again.open(1);
  await until(() => again.text().includes("缓存里的总结"), "显示缓存");
  assert.equal(again.models.length, 0);
  assert.doesNotMatch(again.text(), /正文已更新/);
  again.close();

  const changed = sidebar({ store });
  changed.docs[1] = makeDoc(changed.tabs[1], ["正文已经改写"]);
  changed.open(1);
  await until(() => changed.text().includes("正文已更新，可重新总结"), "提示正文已更新");
  assert.match(changed.text(), /缓存里的总结/);
  assert.equal(changed.models.length, 0);
  changed.close();
});

function backgroundWithStore(store) {
  const { loadBackgroundScripts } = require("./源码加载.js");
  const noop = { addListener() {} };
  const area = {
    async get(keys) {
      if (keys == null) return { ...store };
      const list = typeof keys === "string" ? [keys] : keys;
      return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, store[k]]));
    },
    async getKeys() {
      return Object.keys(store);
    },
    async set(values) {
      Object.assign(store, values);
    },
    async remove(keys) {
      for (const key of [].concat(keys)) delete store[key];
    },
    async setAccessLevel() {}
  };
  const context = {
    console,
    URL,
    TextEncoder,
    TextDecoder,
    Blob,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async () => {
      throw new Error("不应联网");
    },
    chrome: {
      runtime: {
        id: "t",
        onInstalled: noop,
        onStartup: noop,
        onMessage: {
          addListener(fn) {
            context.__onMessage = fn;
          }
        },
        async sendMessage() {},
        getURL: (f) => f
      },
      sidePanel: { async setPanelBehavior() {}, async setOptions() {} },
      scripting: {
        async executeScript() {
          return [];
        }
      },
      tabs: {
        async get() {
          return {};
        },
        query: async () => [],
        async sendMessage() {}
      },
      declarativeNetRequest: { async updateDynamicRules() {} },
      storage: { local: area, session: area }
    },
    BiliCaptionPrefs: {
      async loadSettings(d) {
        return { ...d };
      }
    },
    BiliCaptionProviders: {},
    BiliCaptionStt: {},
    BiliCaptionMp4: { CHUNK_SECONDS: 480, CHUNK_BYTES: 1 }
  };
  context.self = context;
  vm.createContext(context);
  loadBackgroundScripts(context, [
    "lib/视频平台.js",
    "lib/字幕工具.js",
    "lib/zh-simp.js",
    "lib/translate.js",
    "lib/模型路由.js",
    "lib/webdav.js"
  ]);
  return context;
}

test("文章缓存单独按数量和体积淘汰（先删最旧），设置页统计单列、不算进字幕", async () => {
  const store = {};
  for (let i = 0; i < 105; i++) {
    store[`article:v1:https://e.com/${i}`] = {
      url: `https://e.com/${i}`,
      generatedAt: 1000 + i,
      fingerprint: "f",
      value: { summary: "s", sections: [] }
    };
  }
  const bg = backgroundWithStore(store);
  const max = vm.runInContext("ARTICLE_CACHE_MAX", bg);
  assert.equal(max, 100);
  assert.equal(vm.runInContext("ARTICLE_CACHE_MAX_BYTES", bg), 5 * 1024 * 1024);
  await bg.pruneArticleCache();
  const left = Object.keys(store).filter((k) => k.startsWith("article:v1:"));
  assert.equal(left.length, 100);
  assert.ok(!("article:v1:https://e.com/0" in store) && "article:v1:https://e.com/104" in store);
  const usage = await bg.getSubtitleCacheUsage();
  assert.equal(usage.article.count, 100);
  assert.equal(usage.article.maxCount, 100);
  assert.equal(usage.renewable.videos, 0);
  assert.equal(usage.protected.videos, 0);
  const reply = await new Promise((resolve) => {
    const handled = bg.__onMessage(
      { type: "PRUNE_ARTICLE_CACHE" },
      { url: "chrome-extension://t/sidepanel.html" },
      resolve
    );
    if (handled !== true) resolve({ ignored: true });
  });
  assert.equal(reply.ignored, undefined);
});

// ---- 12. 失败续跑、JSON 自动重试 ----

test("分段失败后重试从失败段继续，不重算已完成的段", async () => {
  const h = sidebar();
  h.w.BiliCaptionArticle.plan = (doc) => ({ batches: [doc.blocks, doc.blocks, doc.blocks], calls: 3 });
  h.reply = async (prompt, cfg, i) => {
    if (i === 2) throw new Error("第二段超时");
    return answer(`第 ${i} 次`);
  };
  h.open(1);
  await h.P.read();
  assert.match(h.text(), /第二段超时/);
  assert.match(h.text(), /已完成 1 \/ 3 段/);
  assert.equal(h.models.length, 2);
  h.reply = async (prompt, cfg, i) => answer(`第 ${i} 次`);
  await h.click("重试");
  await until(() => h.text().includes("复制总结"), "续跑完成");
  assert.equal(h.models.length, 5, "续跑只调用第 2、3 段和汇总");
  h.close();
});

test("模型返回的 JSON 无法解析时自动重试一次", async () => {
  const h = sidebar();
  h.reply = async (prompt, cfg, i) => (i === 1 ? "这不是 JSON" : answer("第二次成功"));
  h.open(1);
  await h.P.read();
  assert.equal(h.models.length, 2);
  assert.match(h.text(), /第二次成功/);
  h.close();
  const g = sidebar();
  g.reply = async () => "{";
  g.open(1);
  await g.P.read();
  assert.equal(g.models.length, 2, "只重试一次");
  assert.match(g.text(), /格式无法解析/);
  assert.ok(g.logs.some((log) => log.scope === "article" && /格式无法解析/.test(log.message)));
  g.close();
});
