const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { backgroundSource, contentSource, panelSource, loadBackgroundScripts, runFile } = require("./源码加载.js");

const root = path.resolve(__dirname, "..");

function loadTranslate() {
  const context = { console };
  context.self = context;
  context.window = context;
  vm.createContext(context);
  for (const file of ["lib/zh-simp.js", "lib/translate.js"]) runFile(context, file);
  return context.BiliCaptionTranslate;
}

function storageArea(store) {
  return {
    async get(keys) {
      if (keys == null) return { ...store };
      if (typeof keys === "string") return { [keys]: store[keys] };
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, store[key]]));
      }
      const out = { ...keys };
      for (const key of Object.keys(keys || {})) {
        if (Object.hasOwn(store, key)) out[key] = store[key];
      }
      return out;
    },
    async set(values) {
      Object.assign(store, values || {});
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
    },
    async setAccessLevel() {}
  };
}

function loadBackground(fetchImpl = globalThis.fetch) {
  const store = {};
  const noopEvent = { addListener() {} };
  const context = {
    console,
    URL,
    TextEncoder,
    TextDecoder,
    Blob,
    FormData,
    AbortController,
    AbortSignal,
    DOMException,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: fetchImpl,
    importScripts() {},
    chrome: {
      runtime: {
        id: "test-extension",
        onInstalled: noopEvent,
        onStartup: noopEvent,
        onMessage: noopEvent,
        async sendMessage() {},
        getURL(file) { return `chrome-extension://test/${file}`; },
        async getContexts() { return []; },
        lastError: null,
        async getPlatformInfo() { return {}; }
      },
      sidePanel: {
        async setPanelBehavior() {},
        async setOptions() {},
        async open() {}
      },
      tabs: {
        query(_query, callback) {
          if (callback) callback([]);
          return Promise.resolve([]);
        },
        async sendMessage() {}
      },
      declarativeNetRequest: { async updateDynamicRules() {} },
      storage: { local: storageArea(store) }
    },
    BiliCaptionPrefs: { async loadSettings(defaults) { return { ...defaults }; } },
    BiliCaptionProviders: {},
    BiliCaptionStt: {},
    BiliCaptionMp4: { CHUNK_SECONDS: 8 * 60, CHUNK_BYTES: 20 * 1024 * 1024 }
  };
  context.__store = store;
  context.self = context;
  vm.createContext(context);
  loadBackgroundScripts(context, ["lib/视频平台.js", "lib/字幕工具.js", "lib/zh-simp.js", "lib/translate.js", "lib/模型路由.js", "lib/模型调用.js"]);
  return context;
}

const T = loadTranslate();

test("短英文字幕会进入翻译，品牌名和中文行不会被误判", () => {
  assert.equal(T.needsTranslation("Hello!"), true);
  assert.equal(T.needsTranslation("Yes."), true);
  assert.equal(T.needsTranslation("Thank you"), true);
  assert.equal(T.needsTranslation("Exactly."), true);
  assert.equal(T.needsTranslation("Amazing!"), true);
  assert.equal(T.needsTranslation("No way!"), true);
  assert.equal(T.needsTranslation("OpenAI"), false);
  assert.equal(T.needsTranslation("ChatGPT"), false);
  assert.equal(T.needsTranslation("Claude"), false);
  assert.equal(T.needsTranslation("Windows"), false);
  assert.equal(T.needsTranslation("Python"), false);
  assert.equal(T.needsTranslation("npm install"), false);
  assert.equal(T.needsTranslation("API"), false);
  assert.equal(T.needsTranslation("这是 OpenAI API"), false);
  assert.equal(T.needsTranslation("ThereisoneparticularGitHubrepothatI'vebeeneyeing"), true);
  assert.equal(T.needsTranslation("TypeScript"), false);
});

test("编号完整时按编号映射", () => {
  assert.deepEqual(
    Array.from(T.parseTranslatedBatch("2. 第二句\n1. 第一句", 2)),
    ["第一句", "第二句"]
  );
});

test("编号整体偏移但行数正确时按行序映射，不会错位", () => {
  assert.deepEqual(
    Array.from(T.parseTranslatedBatch("2. 第一句\n3. 第二句", 2)),
    ["第一句", "第二句"]
  );
});

test("行数与编号都异常时只接纳唯一合法编号", () => {
  assert.deepEqual(
    Array.from(T.parseTranslatedBatch("1. 旧一\n1. 重复一\n2. 第二句", 2)),
    ["", "第二句"]
  );
});

test("翻译进度只统计真正包含中文的结果", () => {
  assert.equal(T.looksTranslated("好", "Yes."), true);
  assert.equal(T.looksTranslated("Okay", "Okay?"), false);
  assert.equal(T.looksTranslated("1.", "Hello"), false);
});

test("静音成功分片也属于已完成", () => {
  const B = loadBackground();
  assert.equal(B.partIsComplete({ complete: true, silent: true, cues: [] }), true);
  assert.equal(B.partIsComplete({ cues: [{ content: "字幕" }] }), true);
  assert.equal(B.partIsComplete({ failed: true, cues: [] }), false);
  const chunks = B.snapshotAsrChunks(
    { chunkPlan: [{ start: 0, end: 10 }], failedChunks: [], progress: { total: 1 } },
    [{ complete: true, silent: true, cues: [] }],
    1
  );
  assert.equal(chunks[0].status, "done");
});

test("前片静音时，当前唯一文本分片仍保留全局时间轴", async () => {
  const B = loadBackground();
  const cues = await B.persistAsrProgress({
    bvid: "BV-test",
    cid: 1,
    tabId: 0,
    fingerprint: "test",
    parts: [
      { i: 0, start: 0, end: 300, cues: [], complete: true, silent: true },
      { i: 1, start: 299.2, end: 400, overlap: 0.8, cues: [{ from: 1, to: 3, content: "第二片" }], complete: true }
    ],
    total: 2,
    language: "zh",
    onProgress() {},
    job: { sttCfg: { model: "test-asr" }, failedChunks: [] }
  });
  assert.ok(cues[0].from > 299);
  assert.equal(cues[0].content, "第二片");
});

test("英文短字幕合并时保留单词间空格，中文仍自然拼接", () => {
  const B = loadBackground();
  // 后台切句直接用 lib/translate.js 的 joinCueText，不再另留一份兜底副本
  assert.equal(B.BiliCaptionTranslate.joinCueText("Hello", "world"), "Hello world");
  assert.equal(B.BiliCaptionTranslate.joinCueText("你好", "世界"), "你好世界");
  const glued = B.segmentsToCues({
    duration: 1.5,
    words: [
      { word: "There", start: 0, end: 0.2 },
      { word: "is", start: 0.2, end: 0.4 },
      { word: "one", start: 0.4, end: 0.55 },
      { word: "repo.", start: 0.55, end: 0.9 }
    ]
  });
  assert.match(glued.map((cue) => cue.content).join(" "), /There is one repo/);
});

test("分片重叠区只去除真实重复，不会误删静音后的新句子", () => {
  const B = loadBackground();
  const merged = B.mergeChunkCues([
    { start: 0, overlap: 0, cues: [
      { from: 100, to: 102, content: "前文" },
      { from: 478.8, to: 480, content: "重复一句" }
    ] },
    { start: 479.2, overlap: 0.8, cues: [
      { from: 0, to: 0.8, content: "重复一句。" },
      { from: 0.1, to: 1.2, content: "全新一句" }
    ] }
  ]);
  assert.equal(merged.filter((cue) => cue.content.includes("重复一句")).length, 1);
  assert.equal(merged.some((cue) => cue.content.includes("全新一句")), true);
});

test("鉴权和配置错误会终止整项任务，普通音频错误仍可按片重试", () => {
  const B = loadBackground();
  assert.equal(B.isFatalSttError({ status: 401, message: "Unauthorized" }), true);
  assert.equal(B.isFatalSttError({ status: 403, message: "Forbidden" }), true);
  assert.equal(B.isFatalSttError(new Error("请填写 API Key")), true);
  assert.equal(B.isFatalSttError({ status: 400, message: "invalid audio file" }), false);
});

test("Fish 与 OpenAI 转写原样上传 M4A，不走转码", async () => {
  const uploaded = [];
  const B = loadBackground();
  B.BiliCaptionStt = {
    async transcribe(blob, cfg, extra) {
      uploaded.push({ type: blob.type, filename: extra.filename, provider: cfg.provider });
      return { text: "ok", segments: [] };
    }
  };

  await B.transcribeWithCfg(
    new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/mp4" }),
    { provider: "Fish Audio", kind: "fish", key: "test" },
    { signal: new AbortController().signal, filename: "audio.m4a" }
  );
  await B.transcribeWithCfg(
    new Blob([new Uint8Array([9])], { type: "audio/mp4" }),
    { provider: "OpenAI", kind: "openai", key: "test", base: "https://api.openai.com/v1" },
    { signal: new AbortController().signal, filename: "audio.m4a" }
  );

  assert.deepEqual(uploaded, [
    { type: "audio/mp4", filename: "audio.m4a", provider: "Fish Audio" },
    { type: "audio/mp4", filename: "audio.m4a", provider: "OpenAI" }
  ]);
  assert.equal(typeof B.decodeToWav, "undefined");
  assert.equal(typeof B.volcanoNeedsWav, "undefined");
});

test("并发翻译批次的提交阶段严格串行", async () => {
  const B = loadBackground();
  const job = {};
  const order = [];
  const first = B.enqueueTranslateCommit(job, async () => {
    order.push("一开始");
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push("一结束");
  });
  const second = B.enqueueTranslateCommit(job, async () => {
    order.push("二开始");
    order.push("二结束");
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ["一开始", "一结束", "二开始", "二结束"]);
});

test("50 句批量翻译即使三批乱序返回，也会逐句写回正确位置", async () => {
  const B = loadBackground(async (_url, options) => {
    const body = JSON.parse(options.body);
    const prompt = body.messages.at(-1).content;
    const ids = [...prompt.matchAll(/^\d+\. This is line (\d+)\.$/gm)].map((match) => Number(match[1]));
    const delay = ids[0] <= 24 ? 35 : ids[0] <= 48 ? 5 : 18;
    await new Promise((resolve) => setTimeout(resolve, delay));
    const content = ids.map((id, index) => `${index + 1}. 第${id}句`).join("\n");
    return {
      ok: true,
      status: 200,
      async json() { return { choices: [{ message: { content } }] }; }
    };
  });
  B.BiliCaptionPrefs.loadSettings = async () => ({
    sumProvider: "OpenAI",
    apiBase: "https://api.openai.com/v1",
    apiKey: "key",
    apiModel: "gpt-4o-mini",
    translateModel: "",
    translateConcurrency: 4
  });
  B.BiliCaptionProviders.resolveSum = (storage) => ({
    provider: storage.sumProvider,
    base: storage.apiBase,
    key: storage.apiKey,
    model: storage.apiModel
  });
  const input = Array.from({ length: 50 }, (_, index) => ({
    from: index,
    to: index + 0.8,
    content: `This is line ${index + 1}.`
  }));
  const prepared = B.BiliCaptionTranslate.prepareCues(input);
  const job = {
    jobId: "translate-50",
    controller: new AbortController(),
    tabId: 0,
    bvid: "BV-translate-50",
    cid: 50,
    cues: prepared.cues,
    done: 0,
    total: prepared.targets.length,
    pending: true
  };
  await B.runTranslateJob(job, prepared.targets);

  assert.equal(job.done, 50);
  assert.deepEqual(
    Array.from(job.cues, (cue) => cue.content),
    Array.from({ length: 50 }, (_, index) => `第${index + 1}句`)
  );
  assert.equal(B.__store["asr:BV-translate-50:50"].cues[49].content, "第50句");
  assert.equal(job.cues[0].original, "This is line 1.");
  assert.equal(job.cues[49].original, "This is line 50.");
});

test("断句浅拷贝的 job.cues，每批译完就能看到中文", async () => {
  const B = loadBackground(async (_url, options) => {
    const body = JSON.parse(options.body);
    const prompt = body.messages.at(-1).content;
    const ids = [...prompt.matchAll(/^\d+\. This is line (\d+)\.$/gm)].map((match) => Number(match[1]));
    const content = ids.map((id, index) => `${index + 1}. 第${id}句`).join("\n");
    return {
      ok: true,
      status: 200,
      async json() { return { choices: [{ message: { content } }] }; }
    };
  });
  const input = Array.from({ length: 30 }, (_, index) => ({
    from: index,
    to: index + 0.8,
    content: `This is line ${index + 1}.`
  }));
  const prepared = B.BiliCaptionTranslate.prepareCues(input);
  const later = { from: 99, to: 100, content: "Later English." };
  const job = {
    jobId: "translate-copy",
    controller: new AbortController(),
    tabId: 0,
    bvid: "BV-copy",
    cid: 1,
    cues: [...prepared.cues, later],
    done: 0,
    total: prepared.targets.length,
    pending: true,
    failed: false,
    commitChain: Promise.resolve()
  };
  await B.translatePreparedCues(job, prepared.cues, prepared.targets, {
    apiBase: "https://api.openai.com/v1",
    apiKey: "key",
    apiModel: "gpt-4o-mini",
    signal: job.controller.signal,
    conc: 1,
    T: B.BiliCaptionTranslate
  });
  assert.match(job.cues[0].content, /第1句/);
  assert.match(job.cues[23].content, /第24句/);
  assert.equal(job.cues[job.cues.length - 1].content, "Later English.");
});

test("分段转写与翻译并发回写时不会覆盖中文，单字译文也会保留", async () => {
  const B = loadBackground();
  const identity = ["BV-cache-race", 9];
  await Promise.all([
    B.saveCachedAsr(...identity, {
      cues: [{ from: 0, to: 2, content: "好" }],
      source: "translated",
      activeLan: "translated"
    }),
    B.saveCachedAsr(...identity, {
      cues: [{ from: 0, to: 2, content: "Okay" }],
      source: "groq",
      activeLan: "groq-asr"
    })
  ]);
  const saved = B.__store["asr:BV-cache-race:9"];
  assert.equal(saved.cues[0].content, "好");
  assert.equal(saved.source, "translated");
});

test("复述英文或缺号时只把缺的行带着说明小批重试一次，模型不变", async () => {
  const calls = [];
  const B = loadBackground(async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    const prompt = body.messages.at(-1).content;
    // 第一次：第 1 行复述英文、第 3 行缺号；重试：只收到这两行
    const content = calls.length === 1 ? "1. Hello there\n2. 第二句" : "1. 你好\n2. 第三句";
    assert.match(prompt, calls.length === 1 ? /只输出【待译】的 1-3 号/ : /上一次的输出缺了这 2 行/);
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content } }] };
      }
    };
  });
  const cues = [
    { from: 0, to: 1, content: "Earlier line.", original: "" },
    { from: 1, to: 2, content: "Hello there" },
    { from: 2, to: 3, content: "Second line here." },
    { from: 3, to: 4, content: "Third line here." }
  ];
  const batch = [1, 2, 3].map((index) => ({ index, text: cues[index].content }));
  const lines = await B.translateBatch(batch, cues, {
    apiBase: "https://api.openai.com/v1",
    apiKey: "key",
    apiModel: "gpt-4o-mini",
    provider: "OpenAI",
    signal: new AbortController().signal,
    title: "演示视频",
    T: B.BiliCaptionTranslate
  });

  assert.deepEqual(Array.from(lines), ["你好", "第二句", "第三句"]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((body) => body.model), ["gpt-4o-mini", "gpt-4o-mini"]);
  const firstPrompt = calls[0].messages.at(-1).content;
  assert.match(firstPrompt, /【视频标题】演示视频/);
  assert.match(firstPrompt, /^> Earlier line\.$/m);
  assert.equal([...firstPrompt.matchAll(/^\d+\. /gm)].length, 3);
  assert.equal([...calls[1].messages.at(-1).content.matchAll(/^\d+\. /gm)].length, 2);
  // OpenAI 默认模型不是推理模型：不发 reasoning_effort；翻译请求走流式
  assert.equal("reasoning_effort" in calls[0], false);
  assert.equal(calls[0].stream, true);
  assert.equal(calls[0].temperature, 0.3);
});

test("取消、配置错误和普通 4xx 不重试，限流、5xx、超时和结构异常可重试", () => {
  const context = { console, AbortController, setTimeout, clearTimeout, TextDecoder, URL };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "lib/模型调用.js"), "utf8"), context);
  const Call = context.BiliCaptionModelCall;
  const canceled = new Error("已取消");
  canceled.name = "AbortError";
  assert.equal(Call.isRetryable(canceled), false);
  assert.equal(Call.isRetryable({ status: 400, message: "bad input" }), false);
  assert.equal(Call.isRetryable({ status: 401, message: "bad key", fatal: true }), false);
  assert.equal(Call.isRetryable({ status: 429, message: "limited" }), true);
  assert.equal(Call.isRetryable({ status: 503, message: "busy" }), true);
  assert.equal(Call.isRetryable({ status: 408, message: "模型请求超时" }), true);
  assert.equal(Call.isRetryable({ invalidResponse: true }), true);
  assert.equal(Call.isRetryable({ name: "TypeError", message: "Failed to fetch" }), true);
  assert.equal(typeof context.BiliCaptionModelRoute, "undefined");
  const route = fs.readFileSync(path.join(root, "lib/模型路由.js"), "utf8");
  assert.doesNotMatch(route, /shouldFallback|fallbackFor/);
});

test("关键跨文件约束不会退回旧实现", () => {
  const background = backgroundSource();
  const content = contentSource();
  const panel = panelSource();
  const html = fs.readFileSync(path.join(root, "sidepanel.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "sidepanel.css"), "utf8");

  assert.doesNotMatch(background, /allFailed/);
  assert.doesNotMatch(panel, /btnRetryFailed|用备用重试/);
  assert.doesNotMatch(html, /btnRetryFailed|用备用重试/);
  assert.match(html, />翻译成中文</);
  // 发给页面的 SYNC_CUES 带视频身份、广播格式等改由下面的行为测试锁定
  assert.match(content, /if \(!hasIdentity \|\| !sameVideo\)/);
  assert.match(content, /APPLY_ASR_CUES[\s\S]{0,520}if \(!hasIdentity \|\| !sameVideo\)/);
  assert.match(panel, /function sameAsrVideo[\s\S]{0,320}!hasIdentity/);
  assert.match(content, /function onHotkey\(event\)\s*\{\s*if \(!isCurrentScript\(\)\) return/);
  // 转写缓存按视频串行写入：见「分段转写与翻译并发回写时不会覆盖中文」行为测试
  assert.match(panel, /type: "CLEAR_VIDEO_CACHE"/);
  assert.match(html, /id="captionLang"/);
  assert.match(panel, /SET_CAPTION_LANG/);
  assert.match(content, /SET_CAPTION_LANG/);
  assert.match(panel, /已清理本视频的转写、翻译和大纲缓存/);
  assert.match(panel, /已重新加载官方字幕/);
  assert.doesNotMatch(panel, /已清理本视频的字幕和翻译缓存/);
  assert.match(html, /不影响视频自带字幕/);
  assert.match(css, /\.chunk-done\s*\{[\s\S]*?overflow-x:\s*hidden/);
  assert.doesNotMatch(panel, /优化断句|断句 \$\{/);
  assert.match(panel, /trJobTitle\.textContent = "翻译中"/);
  assert.match(content, /bc-dock-glass/);
  assert.doesNotMatch(content, /BiliCaption · 生成字幕/);
  assert.doesNotMatch(content, /className = "bc-overlay-note"/);
  assert.match(content, /bc-overlay-note"\)\?\.remove/);
  assert.doesNotMatch(content, /\.bc-dock-win \{[\s\S]{0,320}opacity:\s*var\(--bc-dock-alpha\)/);
  assert.match(content, /function clampDockAlpha/);
  assert.match(content, /alpha\.min = "0"/);
  assert.doesNotMatch(content, /alpha\.min = "30"/);
  assert.match(content, /Math\.min\(1, Math\.max\(0, n\)\)/);
  assert.doesNotMatch(content, /Number\(dockAlpha\) \|\| 0\.82/);
  assert.match(panel, /visible && wasHidden[\s\S]{0,80}resetJobPillClosed/);
  assert.match(panel, /stage: started\.stage \|\| "run"/);
  assert.match(panel, /info\.status === "complete" \|\| info\.url/);
  assert.match(panel, /function tabVideoChanged/);
  assert.match(content, /if \(!runtimeAlive\(\)\)/);
  assert.match(content, /CLOSE_FLOAT/);
  assert.match(panel, /type: "CLOSE_FLOAT"/);
  assert.match(background, /function injectBiliContentScripts/);
  // 补注入与 manifest、侧栏共用 lib/视频平台.js 里的同一份清单
  assert.match(background, /files:\s*\[\.\.\.BiliCaptionPlatforms\.CONTENT_SCRIPT_FILES\]/);
  assert.match(content, /data-bilicaption-owner/);
  assert.match(content, /OWNER_ATTR/);
  assert.doesNotMatch(content, /window\.__BILI_CAPTION_GEN__/);
  assert.match(content, /\?embed=1/);
  assert.match(panel, /embed=1/);
  assert.match(panel, /if \(inFloatEmbed\(\)\) return false/);
  assert.match(
    content,
    /onMessage\.addListener\(\(message[\s\S]*?if \(message\?\.type === "PING"\)[\s\S]*?if \(!isCurrentScript\(\)\) return;/
  );
  // 转写任务查询、同视频加锁改由 测试/转写调度.test.js 的行为测试覆盖
  assert.match(background, /CLEAR_VIDEO_CACHE",\s*"DAV_SYNC_NOW"/);
  assert.match(
    panel,
    /renderKey !== lastRenderKey[\s\S]{0,280}range = \{ start: -1, end: -1 \}/
  );
  assert.match(content, /event\.origin !== `chrome-extension:\/\/\$\{chrome\.runtime\.id\}`/);
  assert.doesNotMatch(background, /xy-backup/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, "lib/模型路由.js"), "utf8"), /xy-backup|xy-fast|xy-smart/);
});

test("点划选是先点起点再点终点，松手不会结束划选", () => {
  const panel = panelSource();
  const down = panel.match(/function onCuePointerDown\([\s\S]*?\n\}\n/)?.[0] || "";
  assert.match(down, /if \(selecting\) return;/);
  assert.doesNotMatch(down, /dragSelect = \{/);
  const click = panel.match(/function onCueClick\([\s\S]*?\n\}\n/)?.[0] || "";
  assert.match(click, /if \(selecting\) \{/);
  assert.match(click, /range\.end = index/);
  const up = panel.match(/function onCuePointerUp\([\s\S]*?\n\}\n/)?.[0] || "";
  assert.match(up, /if \(dragSelect\.moved\) selecting = false/);
});

test("选区条有循环，回跳在播放器里做", () => {
  const html = fs.readFileSync(path.join(root, "sidepanel.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "sidepanel.css"), "utf8");
  const panel = panelSource();
  const content = contentSource();
  assert.match(html, /id="btnLoopSel"/);
  assert.match(html, />循环</);
  assert.match(css, /\.btn-loop\.on/);
  assert.match(panel, /function setLoopSel/);
  assert.match(panel, /type: "LOOP_SEL"/);
  assert.match(panel, /循环中/);
  assert.match(panel, /if \(loopSel\) return;/);
  assert.match(content, /function applyCueLoop/);
  assert.match(content, /function tickCueLoop/);
  assert.match(content, /LOOP_ENDED/);
  assert.match(panel, /toFixed\(2\)\.replace\(\/0\+\$\/, ""\)/);
  assert.match(css, /\.speed-menu\s*\{[^}]*z-index:\s*60/);
  assert.match(content, /message\?\.type === "LOOP_SEL"/);
  assert.doesNotMatch(panel, /video\.currentTime/);
});

test("按住划选键立刻点亮字幕列表，不必等开始滑动", () => {
  const html = fs.readFileSync(path.join(root, "sidepanel.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "sidepanel.css"), "utf8");
  const panel = panelSource();
  assert.match(html, /id="selKeyHint"/);
  assert.match(html, /划动选择字幕/);
  assert.match(css, /\.cues\.key-armed/);
  assert.match(css, /inset 0 0 0 1px rgba\(77,\s*142,\s*240,\s*\.42\)/);
  assert.match(panel, /function syncSelKeyArmed/);
  assert.match(panel, /selKeyHeldFromPage !== true/);
  assert.match(panel, /syncSelKeyArmed\(\)/);
  const paint = panel.match(/function paintSelection\([\s\S]*?\n\}\n/)?.[0] || "";
  assert.match(paint, /syncSelKeyArmed\(\)/);
});

test("英文长段按句号切开，不按 56 字硬切", () => {
  const B = loadBackground();
  const cues = B.refineAsrCues([{
    from: 0,
    to: 40,
    content: "This is the first complete sentence. This is the second complete sentence. This is the third complete sentence."
  }]);
  assert.ok(cues.length >= 3);
  assert.match(cues[0].content, /first complete sentence/);
  assert.equal(cues.some((cue) => /This is the fir$/.test(cue.content)), false);
});

test("翻译进度按英文字幕行计，一批可以超过一句", async () => {
  const sizes = [];
  const B = loadBackground(async (_url, options) => {
    const body = JSON.parse(options.body);
    const prompt = body.messages.at(-1).content;
    const lines = [...prompt.matchAll(/^\d+\. (.+)$/gm)].map((match) => match[1]);
    sizes.push(lines.length);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [{ message: { content: lines.map((line, index) => `${index + 1}. 译${line}`).join("\n") } }]
        };
      }
    };
  });
  B.BiliCaptionPrefs.loadSettings = async () => ({
    sumProvider: "OpenAI",
    apiKey: "key",
    apiModel: "gpt-4o-mini",
    translateConcurrency: 4
  });
  B.BiliCaptionProviders.resolveSum = () => ({
    provider: "OpenAI",
    base: "https://api.openai.com/v1",
    key: "key",
    model: "gpt-4o-mini"
  });
  const input = Array.from({ length: 30 }, (_, index) => ({
    from: index,
    to: index + 0.8,
    content: `This is line ${index + 1} for batching.`
  }));
  const prepared = B.BiliCaptionTranslate.prepareCues(input);
  const job = {
    jobId: "translate-batch-size",
    controller: new AbortController(),
    tabId: 0,
    bvid: "BV-batch-size",
    cid: 12,
    cues: prepared.cues,
    done: 0,
    total: prepared.targets.length,
    pending: true
  };
  await B.runTranslateJob(job, prepared.targets);
  assert.equal(job.done, 30);
  assert.equal(job.total, 30);
  // 当前位置第一批用小批让首屏更快，之后每批不超过 24 行
  assert.equal(sizes[0], 10);
  assert.equal(sizes.every((n) => n <= 24), true);
  assert.equal(sizes.reduce((a, b) => a + b, 0), 30);
  assert.equal(sizes.some((n) => n > 1), true);
});

test("中文超长字幕按句号切开，不会留成一段", () => {
  const B = loadBackground();
  const cues = B.refineAsrCues([{
    from: 1013,
    to: 1032,
    content: "最后的测试是像这样说一声你好，确保一切正常运行，然后你应该会收到你好的回复。看到这个后，设置就完成了。无论你使用 Claude Code、Codex 还是其他任何你喜欢的编程代理，都应该能够这样操作。做得好，我们下一节见。这门课程的运作方式是"
  }]);
  assert.ok(cues.length >= 4);
  assert.equal(cues[0].from, 1013);
  assert.equal(cues[cues.length - 1].to, 1032);
  assert.ok(cues.every((cue) => B.cueLen(cue.content) <= 80));
});

test("翻译完成后的中文长段也会再切开", async () => {
  const B = loadBackground(async () => {
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [{
            message: {
              content: "1. 最后的测试是说一声你好，确保一切正常运行。看到这个后，设置就完成了。无论你使用 Claude Code 还是 Codex，都应该能够这样操作。做得好我们下一节见。"
            }
          }]
        };
      }
    };
  });
  B.BiliCaptionPrefs.loadSettings = async () => ({
    sumProvider: "OpenAI",
    apiKey: "key",
    apiModel: "gpt-4o-mini",
    translateConcurrency: 1
  });
  B.BiliCaptionProviders.resolveSum = () => ({
    provider: "OpenAI",
    base: "https://api.openai.com/v1",
    key: "key",
    model: "gpt-4o-mini"
  });
  const input = [
    { from: 1013, to: 1022, content: "The last test is to say hello and make sure everything works." },
    { from: 1022, to: 1032, content: "After that setup is complete and you can use Claude Code or Codex." }
  ];
  const prepared = B.BiliCaptionTranslate.prepareCues(input);
  const job = {
    jobId: "translate-split-zh",
    controller: new AbortController(),
    tabId: 0,
    bvid: "BV-split-zh",
    cid: 8,
    cues: prepared.cues,
    done: 0,
    total: prepared.targets.length,
    pending: true
  };
  await B.runTranslateJob(job, prepared.targets);
  assert.ok(job.cues.length >= 3);
  assert.equal(job.cues[0].from, 1013);
  assert.equal(job.cues[job.cues.length - 1].to, 1032);
});

test("用户取消翻译后不保留 pending，重载不会自动续跑", async () => {
  const B = loadBackground(async (_url, options) => new Promise((_, reject) => {
    const fail = () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    };
    if (options?.signal?.aborted) {
      fail();
      return;
    }
    options?.signal?.addEventListener("abort", fail, { once: true });
  }));
  B.BiliCaptionPrefs.loadSettings = async () => ({
    sumProvider: "OpenAI",
    apiKey: "key",
    apiModel: "gpt-4o-mini"
  });
  B.BiliCaptionProviders.resolveSum = () => ({
    provider: "OpenAI",
    base: "https://api.openai.com/v1",
    key: "key",
    model: "gpt-4o-mini"
  });
  const started = await B.startTranslate({
    bvid: "BV-cancel",
    cid: 3,
    cues: [
      { from: 0, to: 1, content: "Hello there friends." },
      { from: 1, to: 2, content: "How are you today." }
    ]
  });
  assert.equal(started.started, true);
  assert.equal(await B.cancelTranslateJob(started.jobId, { bvid: "BV-cancel", cid: 3 }), true);
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && B.findTranslateJob({ jobId: started.jobId, bvid: "BV-cancel", cid: 3 })) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(B.__store["trJob:BV-cancel:3"], undefined);
  const status = await B.getTranslateJobStatus({ bvid: "BV-cancel", cid: 3 });
  assert.equal(status.running, false);
  await B.resumePendingTranslateJobs();
  const after = await B.getTranslateJobStatus({ bvid: "BV-cancel", cid: 3 });
  assert.equal(after.running, false);
});

test("点翻译后立刻进入翻译中，总数用原始英文字幕行数", async () => {
  const B = loadBackground(async (_url, options) => new Promise((_, reject) => {
    const fail = () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    };
    if (options?.signal?.aborted) {
      fail();
      return;
    }
    options?.signal?.addEventListener("abort", fail, { once: true });
  }));
  B.BiliCaptionPrefs.loadSettings = async () => ({
    sumProvider: "OpenAI",
    apiKey: "key",
    apiModel: "gpt-4o-mini"
  });
  B.BiliCaptionProviders.resolveSum = () => ({
    provider: "OpenAI",
    base: "https://api.openai.com/v1",
    key: "key",
    model: "gpt-4o-mini"
  });
  const started = await B.startTranslate({
    bvid: "BV-stage",
    cid: 1,
    cues: [
      { from: 0, to: 1, content: "Hello there." },
      { from: 1, to: 2, content: "How are you." }
    ]
  });
  assert.equal(started.stage, "run");
  assert.equal(started.total, 2);
  assert.equal(started.done, 0);
  B.cancelTranslateJob(started.jobId, { bvid: "BV-stage", cid: 1 });
});

test("续传时进度从已完成段数起步，而不是从 0", () => {
  const B = loadBackground();
  const duration = 32 * 480;
  const saved = {
    total: 32,
    pending: true,
    parts: Array.from({ length: 30 }, (_, i) => ({
      i,
      start: i * 480,
      end: (i + 1) * 480,
      complete: true,
      cues: [{ from: 0, to: 10, content: `p${i}` }]
    }))
  };
  const seeded = B.seedResumeParts(saved, [], duration, 32);
  assert.equal(seeded.total, 32);
  assert.equal(seeded.skipped, 30);
  assert.equal(seeded.parts.filter((part) => part && part.complete).length, 30);
  assert.equal(seeded.parts[30], null);
  assert.equal(seeded.parts[31], null);
});
