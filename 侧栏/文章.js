// 侧栏 · 文章模式：任意网页识别正文、生成带段落定位的总结。
// 独立于字幕状态；按设计稿 BiliCaption Article.dc.html 实现。
(() => {
  const A = globalThis.BiliCaptionArticle;
  if (!A) return;

  // 同时保留的文章会话上限：超出时按最近使用淘汰，已完成的先淘汰，正在运行的最后淘汰
  const SESSION_MAX = 12;
  const RUNNING = new Set(["reading", "generating"]);

  let current = null;
  let root = null;
  let stopOrb = null;
  let poll = null;
  let toastTimer = null;
  let useCounter = 0;
  const sessions = new Map();
  // 每个标签页各一条连接：侧栏关闭（页面卸载）时连接断开，内容脚本据此清掉遮罩和高亮
  const ports = new Map();

  const node = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const button = (text, action, cls = "") => {
    const b = node("button", cls, text);
    b.type = "button";
    b.addEventListener("click", () => {
      try {
        Promise.resolve(action()).catch((e) => toast(e.message));
      } catch (e) {
        toast(e.message);
      }
    });
    return b;
  };

  function toast(text) {
    if (!root) return;
    root.querySelector(".article-toast")?.remove();
    const el = node("div", "article-toast", text);
    el.setAttribute("role", "status");
    root.append(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 3500);
  }

  function mount() {
    if (root) return;
    root = node("section", "");
    root.id = "articlePanel";
    root.setAttribute("aria-label", "文章总结");
    document.body.append(root);
  }

  // 任务在会话表里且没被中止就继续跑（切到别的标签页也在后台跑完）；界面只画当前会话。
  const alive = (j) => Boolean(j) && sessions.get(j.key) === j && !j.abort?.signal.aborted;

  /** 失败、中止写一条运行日志（scope 为 article），带标题、原因和文章地址 */
  function logEvent(level, title, reason, j) {
    try {
      const sent = chrome.runtime.sendMessage({
        type: "APPEND_LOG",
        level,
        scope: "article",
        message: `${title}：${String(reason || "").slice(0, 300)}`,
        extra: j?.url || ""
      });
      Promise.resolve(sent).catch(() => {});
    } catch {
      // 日志只为排查，发不出去不影响界面
    }
  }

  // ---- 与网页通信 ----

  async function message(j, type, more = {}) {
    const tab = await chrome.tabs.get(j.tabId);
    if (A.pageKey(tab.url) !== j.url) throw Error("页面已切换，请重新读取文章");
    const result = await chrome.tabs.sendMessage(j.tabId, { type, url: j.url, ...more });
    if (!result || result.error) throw Error(result?.error || "无法读取当前网页，请刷新后重试");
    return result;
  }

  function connect(tabId) {
    if (ports.has(tabId)) return;
    try {
      const port = chrome.tabs.connect(tabId, { name: "bc-article" });
      ports.set(tabId, port);
      port.onDisconnect.addListener(() => {
        if (ports.get(tabId) === port) ports.delete(tabId);
      });
    } catch {
      // 连不上时内容脚本仍会在下一次 ARTICLE_CLEAR 时清理
    }
  }

  function disconnect(tabId) {
    const port = ports.get(tabId);
    ports.delete(tabId);
    try {
      port?.disconnect();
    } catch {
      // 标签页已关闭
    }
  }

  async function ensureContent(j) {
    try {
      await message(j, "ARTICLE_PING");
    } catch {
      try {
        await chrome.scripting.executeScript({ target: { tabId: j.tabId }, files: A.CONTENT_FILES });
      } catch {
        throw Error("无法读取此页面。请点击浏览器工具栏的插件图标后重试；浏览器内部页面不支持文章读取。");
      }
    }
    if (!alive(j)) return;
    connect(j.tabId);
  }

  function clearPage(j) {
    if (j) message(j, "ARTICLE_CLEAR").catch(() => {});
  }

  // ---- 会话 ----

  function deactivate() {
    if (!current) return;
    const j = current;
    // 切到别的页面时不中止正在进行的识别和总结：在后台跑完，切回来直接看到结果。
    // 只有手动选择正文依赖页面上的交互，离开就退回可恢复的状态。
    clearTimeout(j.streamTimer);
    j.streamTimer = null;
    if (j.phase === "manual") leaveManual(j);
    clearPage(j);
    clearInterval(poll);
    poll = null;
    disconnect(j.tabId);
    stopOrb?.();
    stopOrb = null;
    current = null;
    document.body.classList.remove("article-mode");
    if (root) root.hidden = true;
  }

  /** 淘汰顺序：已完成 / 未开始的先淘汰，其次其它停住的状态，正在运行的最后；同类按最近使用从旧到新 */
  function evictionRank(j) {
    if (RUNNING.has(j.phase)) return 2;
    return j.phase === "done" || j.phase === "idle" ? 0 : 1;
  }

  function dropSession(j, reason) {
    if (current === j) deactivate();
    sessions.delete(j.key);
    if (RUNNING.has(j.phase) || j.phase === "manual") {
      j.abort?.abort();
      logEvent("warn", "文章总结已中止", reason, j);
    }
  }

  function evict() {
    while (sessions.size > SESSION_MAX) {
      const candidates = [...sessions.values()].filter((s) => s !== current);
      candidates.sort((a, b) => evictionRank(a) - evictionRank(b) || a.usedAt - b.usedAt);
      const old = candidates[0];
      if (!old) break;
      dropSession(old, `打开的文章超过 ${SESSION_MAX} 篇，最久未使用的「${old.title || old.url}」已丢弃`);
    }
  }

  function activate(tab) {
    if (!A.isArticleURL(tab?.url, tab?.articleMode)) {
      deactivate();
      return false;
    }
    const url = A.pageKey(tab.url);
    const key = `${tab.id}:${url}`;
    if (current?.key === key) {
      current.usedAt = ++useCounter;
      return true;
    }
    deactivate();
    mount();
    let j = sessions.get(key);
    const fresh = !j;
    if (!j) {
      j = {
        key,
        url,
        tabId: tab.id,
        title: tab.title || url,
        site: new URL(url).hostname,
        phase: "idle",
        doc: null,
        value: null,
        open: new Set(),
        fail: {}
      };
      sessions.set(key, j);
    }
    j.usedAt = ++useCounter;
    current = j;
    evict();
    root.hidden = false;
    document.body.classList.add("article-mode");
    render();
    if (fresh) loadCache(j);
    return true;
  }

  // 关闭标签页：中止并删掉该页的会话，不再调用模型
  chrome.tabs?.onRemoved?.addListener?.((tabId) => {
    for (const j of [...sessions.values()]) {
      if (j.tabId === tabId) dropSession(j, "标签页已关闭");
    }
    ports.delete(tabId);
  });

  async function resolveTab(tab) {
    if (!tab?.id || !tab.url) return tab;
    const u = new URL(tab.url);
    if (!/^(www\.)?(x|twitter)\.com$/.test(u.hostname) || !/\/status\/\d+/.test(u.pathname)) return tab;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: A.inspectXPage,
        args: [tab.url]
      });
      const mode = results?.[0]?.result?.mode;
      if (mode === "stale") return null;
      return { ...tab, articleMode: mode };
    } catch {
      return tab;
    }
  }

  // ---- 缓存：同一篇文章再次打开直接显示上次的总结 ----

  async function loadCache(j) {
    const area = chrome.storage?.local;
    if (!area) return;
    const key = A.cacheKey(j.url);
    let entry;
    try {
      entry = (await area.get(key))?.[key];
    } catch {
      return;
    }
    if (!entry?.value || !entry.doc || sessions.get(j.key) !== j || j.phase !== "idle") return;
    j.value = entry.value;
    j.doc = entry.doc;
    j.title = entry.doc.title || j.title;
    j.site = entry.doc.site || j.site;
    j.phase = "done";
    j.cached = { generatedAt: entry.generatedAt, model: entry.model || "" };
    render();
    // 手动选择范围的总结没法自动比对，其余在已授权时静默读一次正文，看看有没有更新
    if (!entry.doc.manual) verifyCache(j, entry.fingerprint);
  }

  async function verifyCache(j, fingerprint) {
    try {
      const origins = [new URL(j.url).origin + "/*"];
      if (!(await chrome.permissions?.contains?.({ origins }))) return;
      if (current !== j) return;
      await ensureContent(j);
      const { doc } = await message(j, "ARTICLE_EXTRACT", { quiet: true });
      if (!alive(j) || j.phase !== "done" || !j.cached) return;
      if (doc?.fingerprint && doc.fingerprint !== fingerprint) {
        j.stale = true;
        render();
      }
    } catch {
      // 读不到正文时照常显示缓存
    }
  }

  function saveCache(j) {
    const area = chrome.storage?.local;
    if (!area || !j.doc || !j.value) return;
    const entry = {
      url: j.url,
      title: j.title,
      fingerprint: j.doc.fingerprint,
      doc: j.doc,
      value: j.value,
      generatedAt: Date.now(),
      model: j.model || ""
    };
    Promise.resolve(area.set({ [A.cacheKey(j.url)]: entry }))
      .then(() => chrome.runtime.sendMessage?.({ type: "PRUNE_ARTICLE_CACHE" }))
      .catch(() => {});
  }

  // ---- 任务状态 ----

  /** 中止上一个操作，换一个新的控制器 */
  function restart(j) {
    j.abort?.abort();
    j.abort = new AbortController();
    return j.abort;
  }

  /** 重新总结开始时先收起上次的结果：失败或中止时还原 */
  function stash(j) {
    if (j.value) {
      j.oldValue = j.value;
      j.oldDoc = j.doc;
    }
    j.value = null;
    j.notice = "";
    j.changed = "";
    j.stale = false;
    j.cached = null;
  }

  function restoreOld(j, notice = "") {
    j.value = j.oldValue;
    j.doc = j.oldDoc || j.doc;
    j.oldValue = null;
    j.oldDoc = null;
    j.phase = "done";
    j.notice = notice;
    j.changed = "";
  }

  /**
   * 失败或中止：有上次结果就还原并提示，否则停在失败（有正文）或未开始（没有正文）。
   * log 为 false 时不写日志（调用方已写过）。
   */
  function settleFailure(j, reason, { log = true, title = "文章总结失败" } = {}) {
    if (log) logEvent("warn", title, reason, j);
    if (j.oldValue) {
      restoreOld(j, `重新总结失败，已保留上次结果（${reason}）`);
    } else if (j.doc || log) {
      j.phase = "failed";
      j.error = reason;
    } else {
      j.phase = "idle";
    }
    clearPage(j);
    render();
  }

  // ---- 识别与生成 ----

  async function read(j = current) {
    if (!j) return;
    const permission = chrome.permissions.request({ origins: [new URL(j.url).origin + "/*"] });
    const operation = restart(j);
    const active = () => alive(j) && j.abort === operation;
    stash(j);
    j.phase = "reading";
    j.error = "";
    j.fix = false;
    j.fail = {};
    render();
    try {
      if (!(await permission)) throw Error("需要允许读取当前网站，才能识别文章正文");
      await ensureContent(j);
      if (!active()) return;
      const { doc } = await message(j, "ARTICLE_EXTRACT");
      if (!active()) return;
      j.doc = doc;
      j.title = doc.title;
      j.site = doc.site;
      j.progress = "";
      if (doc.notArticle) {
        if (j.oldValue) {
          settleFailure(j, "没有找到文章正文");
          return;
        }
        j.phase = "notarticle";
        clearPage(j);
        render();
        return;
      }
      if (doc.warnings.length) {
        j.phase = doc.partial ? "partial" : "misread";
        await message(j, "ARTICLE_RANGE", { on: true });
        render();
        return;
      }
      await generate(j);
    } catch (e) {
      if (active()) settleFailure(j, e.message);
    }
  }

  function preview(raw) {
    return A.streamPreview(raw);
  }

  function combinePreviews(parts) {
    return {
      summary: parts
        .map((p) => p.summary)
        .filter(Boolean)
        .join("\n\n"),
      sections: parts.flatMap((p) => p.sections)
    };
  }

  function queuePreview(j, text, prefix, active) {
    j.streamPending = { text, prefix, active };
    if (j.streamTimer) return;
    j.streamTimer = setTimeout(() => {
      j.streamTimer = null;
      const pending = j.streamPending;
      if (!pending?.active() || j.phase !== "generating" || current !== j) return;
      const partial = preview(pending.text);
      if (!partial.summary && !partial.sections.length) return;
      j.preview = combinePreviews([...pending.prefix, partial]);
      paintPreview(j);
    }, 60);
  }

  function paintPreview(j) {
    if (current !== j) return;
    const body = root?.querySelector(".article-body");
    if (!body || !j.preview) return;
    let list = body.querySelector(".article-stream");
    if (!list) {
      list = node("div", "article-results article-stream");
      body.append(list);
    }
    const setText = (el, text) => {
      if (el.textContent !== text) el.textContent = text;
    };
    let overview = list.querySelector(".article-overview");
    if (!overview) {
      overview = node("div", "article-overview");
      overview.append(node("small", "", "文章总结"), node("span", ""));
      list.prepend(overview);
    }
    overview.hidden = !j.preview.summary;
    setText(overview.lastChild, j.preview.summary || "");
    const existing = [...list.querySelectorAll(".article-section")];
    j.preview.sections.forEach((section, i) => {
      let s = existing[i];
      if (!s) {
        s = node("section", "article-section");
        s.append(node("h3", ""));
        list.append(s);
      }
      setText(s.firstChild, section.title);
      const points = [...s.querySelectorAll(".article-point")];
      section.points.forEach((point, k) => {
        const p = points[k] || node("div", "article-point");
        if (!p.parentNode) s.append(p);
        setText(p, point.text);
      });
      points.slice(section.points.length).forEach((p) => p.remove());
    });
    existing.slice(j.preview.sections.length).forEach((s) => s.remove());
  }

  /**
   * 调一次模型。tier：smart（单段总结、最终汇总）/ fast（长文分段总结），
   * 模型按设置页的服务商和模型取（规则见 lib/providers.js 的 resolveTier），思考参数由调用层按 task 决定。
   */
  async function callModel(j, prompt, tier, onDelta) {
    const signal = j.abort.signal;
    const getConfig = typeof articleModelConfig === "function" ? articleModelConfig : sumServiceConfig;
    const cfg = await getConfig(tier);
    if (!cfg?.key || !cfg.base) throw Error("请先在设置中配置总结服务和 API Key");
    if (signal.aborted) throw Error("任务已取消");
    if (tier === "smart") j.model = cfg.model;
    const task = tier === "fast" ? "article-fast" : "article-summary";
    return requestPromptModel(prompt, { ...cfg, task, signal, onDelta });
  }

  /** 调模型并解析 JSON；解析失败自动重试一次。任务已被取代时返回 null */
  async function summarize(j, prompt, parseDoc, tier, prefix, active) {
    for (let attempt = 0; ; attempt += 1) {
      const raw = await callModel(j, prompt, tier, (text) => {
        if (active()) queuePreview(j, text, prefix, active);
      });
      if (!active()) return null;
      try {
        return A.parse(raw, parseDoc);
      } catch (error) {
        if (attempt >= 1) throw error;
      }
    }
  }

  /** 分段结果按字符数分组，逐级汇总成一份 */
  function reduceGroups(level) {
    const groups = [];
    let group = [];
    let size = 0;
    for (const item of level) {
      const length = JSON.stringify(item).length;
      if (group.length && size + length > A.REDUCE_CHARS) {
        groups.push(group);
        group = [];
        size = 0;
      }
      group.push(item);
      size += length;
    }
    if (group.length) groups.push(group);
    return groups;
  }

  async function generate(j = current) {
    if (!j?.doc) return read(j);
    const operation = restart(j);
    const active = () => alive(j) && j.abort === operation;
    stash(j);
    j.error = "";
    j.fix = false;
    j.preview = null;
    const doc = j.doc;
    let plan;
    try {
      plan = A.plan(doc);
    } catch (e) {
      settleFailure(j, e.message);
      return;
    }
    // 分段结果按正文指纹保存：失败后重试从失败的那段继续
    if (!j.resume || j.resume.fingerprint !== doc.fingerprint || j.resume.total !== plan.batches.length) {
      j.resume = { fingerprint: doc.fingerprint, total: plan.batches.length, parts: [] };
    }
    if (plan.calls > A.CONFIRM_CALLS && j.confirmed !== doc.fingerprint) {
      j.phase = "confirm";
      j.plan = plan;
      render();
      return;
    }
    j.phase = "generating";
    render();
    try {
      await ensureContent(j);
      if (!active()) return;
      await message(j, "ARTICLE_RANGE", { on: "scan", doc });
      const batches = plan.batches;
      const parts = j.resume.parts;
      const multi = batches.length > 1;
      for (let i = parts.length; i < batches.length; i++) {
        j.progress = multi ? `正在总结第 ${i + 1} / ${batches.length} 部分` : "正在生成总结";
        render();
        const part = multi ? `第 ${i + 1}/${batches.length} 部分` : "";
        const result = await summarize(
          j,
          A.prompt(doc, batches[i], part),
          { ...doc, blocks: batches[i] },
          multi ? "fast" : "smart",
          parts.slice(),
          active
        );
        if (!active()) return;
        parts.push(result);
        j.preview = combinePreviews(parts);
        render();
      }
      // 多级汇总控制输入长度，所有分段先完整覆盖，不截去后半篇。
      let level = parts;
      while (level.length > 1) {
        const groups = reduceGroups(level);
        if (groups.every((g) => g.length === 1)) throw Error("分段总结过长，请手动缩小文章范围后重试");
        const next = [];
        j.progress = "正在整理全文总结";
        render();
        for (const group of groups) {
          if (group.length === 1) {
            next.push(group[0]);
            continue;
          }
          const result = await summarize(j, A.reducePrompt(doc, group), doc, "smart", next.slice(), active);
          if (!active()) return;
          next.push(result);
        }
        level = next;
      }
      finish(j, level[0]);
    } catch (e) {
      if (active()) settleFailure(j, e.message);
    }
  }

  function finish(j, value) {
    const before = j.oldDoc;
    j.value = value;
    j.phase = "done";
    j.preview = null;
    j.changed = before ? A.describeChange(before, j.doc).text : "";
    j.oldValue = null;
    j.oldDoc = null;
    j.resume = null;
    j.notice = "";
    saveCache(j);
    clearPage(j);
    render();
  }

  /** 成本确认里点「取消」：不调用模型，有上次结果就还原 */
  function cancelConfirm(j) {
    logEvent("info", "文章总结已取消", `全文较长（预计调用模型 ${j.plan?.calls || 0} 次），用户取消`, j);
    j.plan = null;
    if (j.oldValue) restoreOld(j, "已取消重新总结，保留上次结果。");
    else j.phase = "idle";
    render();
  }

  // ---- 手动选择范围 ----

  /** 退出手选：原来在跑的任务已被中断，按中断处理；否则回到原阶段 */
  function leaveManual(j) {
    clearInterval(poll);
    poll = null;
    j.selection = null;
    const back = j.beforeManual;
    j.beforeManual = null;
    if (back?.interrupted) {
      settleFailure(j, "已中断，可重新生成", { log: false });
      return;
    }
    j.phase = back?.phase || (j.value ? "done" : "idle");
  }

  async function manual(j = current) {
    const permission = chrome.permissions.request({ origins: [new URL(j.url).origin + "/*"] });
    if (!(await permission)) throw Error("需要允许读取当前网站，才能选择正文");
    if (current !== j) return;
    const interrupted = RUNNING.has(j.phase);
    j.beforeManual = { phase: interrupted ? "" : j.phase, interrupted };
    if (interrupted) logEvent("info", "文章总结已中断", "切换到手动选择正文范围", j);
    restart(j);
    try {
      await ensureContent(j);
      if (!alive(j)) return;
      await message(j, "ARTICLE_PICK");
    } catch (e) {
      leaveManual(j);
      render();
      throw e;
    }
    j.phase = "manual";
    j.selection = null;
    render();
    clearInterval(poll);
    poll = setInterval(async () => {
      try {
        const r = await message(j, "ARTICLE_SELECTION");
        if (!alive(j) || j.phase !== "manual") return;
        if (!r.selection) {
          // 网页上按了 Esc
          leaveManual(j);
          render();
          return;
        }
        if (JSON.stringify(j.selection) !== JSON.stringify(r.selection)) {
          j.selection = r.selection;
          render();
        }
      } catch (e) {
        if (alive(j) && j.phase === "manual") {
          leaveManual(j);
          toast(e.message);
          render();
        }
      }
    }, 500);
  }

  async function confirmManual(j) {
    const r = await message(j, "ARTICLE_CONFIRM");
    clearInterval(poll);
    poll = null;
    if (!alive(j)) return;
    j.beforeManual = null;
    // 先收起上次的结果和正文，失败时连同旧正文一起还原
    stash(j);
    j.doc = r.doc;
    await generate(j);
  }

  // ---- 结果操作 ----

  async function locate(j, key, group, label) {
    j.active = key;
    delete j.fail[key];
    render();
    try {
      await ensureContent(j);
      if (!alive(j)) return;
      await message(j, "ARTICLE_LOCATE", { sources: group.map((b) => b.source), label });
    } catch (e) {
      if (current === j) {
        j.fail[key] = e.message;
        render();
      }
    }
  }

  function copy(j) {
    return navigator.clipboard.writeText(A.markdown(j.value, j.doc)).then(() => toast("总结已复制，包含原文链接"));
  }

  function download(j) {
    const blob = new Blob([A.markdown(j.value, j.doc)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (j.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 100) || "文章总结") + ".md";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast("已下载 Markdown");
  }

  // ---- 绘制 ----

  function formatGeneratedAt(ms) {
    const d = new Date(Number(ms) || 0);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function render() {
    if (!current || !root) return;
    const j = current;
    clearTimeout(j.streamTimer);
    j.streamTimer = null;
    const priorOrb = root.querySelector(".article-orb");
    const keepOrb = priorOrb && priorOrb.dataset.phase === j.phase;
    if (!keepOrb) {
      stopOrb?.();
      stopOrb = null;
    }
    const scroll = root.querySelector(".article-body")?.scrollTop || 0;
    root.replaceChildren();

    const head = node("header", "article-head");
    const settings = button("⋯", () => chrome.runtime.openOptionsPage(), "link");
    settings.title = "设置";
    const close = button(
      "×",
      async () => {
        deactivate();
        if (chrome.sidePanel?.close) await chrome.sidePanel.close({ tabId: j.tabId });
        else window.close();
      },
      "link"
    );
    close.title = "关闭";
    head.append(
      node("span", "article-symbol"),
      node("span", "article-site", j.site),
      node("span", "article-badge", "文章"),
      node("span", "article-spacer"),
      settings,
      close
    );
    root.append(head);

    const info = node("div", "article-info");
    info.append(node("div", "article-title", j.title));
    if (j.phase !== "idle") {
      const status = node("div", "article-status");
      status.setAttribute("role", "status");
      const recognized = `已识别正文 · ${j.doc?.blocks.length || 0} 段`;
      const labels = {
        reading: "正在识别正文",
        generating: recognized,
        confirm: recognized,
        done: recognized,
        partial: "只读取到部分正文",
        misread: "识别范围需要确认",
        notarticle: "没有找到文章正文",
        manual: "手动选择正文",
        failed: j.doc ? "正文已保留" : "读取未完成"
      };
      status.append(node("span", "article-dot"), node("span", "", labels[j.phase]), node("span", "article-spacer"));
      if (j.doc && ["done", "failed", "generating"].includes(j.phase)) {
        status.append(
          button(
            "不准确？",
            async () => {
              j.fix = !j.fix;
              await ensureContent(j);
              await message(j, "ARTICLE_RANGE", { on: j.phase === "generating" ? "scan" : j.fix, doc: j.doc });
              render();
            },
            "link"
          )
        );
      }
      info.append(status);
      if (j.fix) {
        const actions = node("div", "article-actions");
        actions.append(
          node("small", "", "识别范围不对时："),
          button("重新识别", () => read(j)),
          button("手动选择范围", () => manual(j))
        );
        info.append(actions);
      }
    }
    root.append(info);

    const busy = RUNNING.has(j.phase);
    let orb = null;
    if (j.phase === "generating") {
      const p = node("div", "article-progress");
      orb = node("span", "article-orb");
      p.append(orb, node("span", "article-busy-label", j.progress || "正在生成总结"));
      root.append(p);
    }
    const body = node("div", "article-body");
    root.append(body);
    const card = (title, text, cls = "") => {
      const c = node("div", `article-warning ${cls}`);
      c.append(node("strong", "", title));
      if (text) c.append(node("div", "", text));
      body.append(c);
      return c;
    };
    const actions = (parent, buttons) => {
      const a = node("div", "article-actions");
      a.append(...buttons);
      parent.append(a);
    };

    if (j.phase === "idle") {
      const c = node("div", "article-empty");
      c.append(button("总结文章", () => read(j), "primary"));
      body.append(c);
    }
    if (j.phase === "reading") {
      const c = node("div", "article-empty");
      orb = node("span", "article-orb big");
      c.append(orb, node("span", "article-busy-label", "正在识别正文"));
      body.append(c);
    }
    if (j.phase === "notarticle") {
      const c = node("div", "article-empty");
      c.append(
        node("strong", "", "这个页面没有适合总结的文章"),
        node("span", "", "没有找到足够的连续正文，页面可能是列表、登录提示或内容尚未加载。"),
        button("重新读取", () => read(j)),
        button("手动选择范围", () => manual(j))
      );
      body.append(c);
    }
    if (["partial", "misread"].includes(j.phase)) {
      const c = card(
        j.phase === "partial" ? "只读取到文章的一部分" : "识别出的正文可能不完整",
        j.doc.warnings.join("\n")
      );
      c.append(
        node(
          "small",
          "",
          `当前已读取 ${j.doc.blocks.length} 段、${j.doc.chars.toLocaleString()} 字符，网页上已标出范围。`
        )
      );
      const choices = [
        button("重新识别", () => read(j), "primary"),
        button("手动选择范围", () => manual(j)),
        button(
          "仍按当前范围总结",
          () => {
            j.doc.partial = true;
            return generate(j);
          },
          "link"
        )
      ];
      if (j.oldValue) {
        choices.push(
          button(
            "保留上次结果",
            () => {
              restoreOld(j);
              clearPage(j);
              render();
            },
            "link"
          )
        );
      }
      actions(c, choices);
    }
    if (j.phase === "confirm") {
      const n = j.plan?.batches.length || 0;
      const c = card(
        `全文较长，预计分 ${n} 段调用模型，继续吗？`,
        `共约 ${j.plan?.calls || 0} 次模型调用（分段总结后再汇总），${j.doc.chars.toLocaleString()} 字符。`
      );
      actions(c, [
        button(
          "继续",
          () => {
            j.confirmed = j.doc.fingerprint;
            return generate(j);
          },
          "primary"
        ),
        button("取消", () => cancelConfirm(j), "link")
      ]);
    }
    if (j.phase === "manual") {
      const c = card(
        "手动选择正文",
        "在网页上依次点击正文的第一段和最后一段，中间内容会一起选中。按 Esc 可以取消。",
        "manual"
      );
      c.append(
        node("div", "", `起点：${j.selection?.start || "等待选择"}`),
        node("div", "", `终点：${j.selection?.end || "等待选择"}`)
      );
      const ok = button(
        j.selection?.ready ? `总结所选 ${j.selection.count} 段` : "确认范围并总结",
        () => confirmManual(j),
        "primary"
      );
      ok.disabled = !j.selection?.ready;
      actions(c, [
        ok,
        button(
          "取消",
          () => {
            leaveManual(j);
            clearPage(j);
            render();
          },
          "link"
        )
      ]);
    }
    if (j.phase === "failed") {
      const c = card("总结没有生成", j.error || "任务已停止，可重新生成总结。", "error");
      const done = j.resume && j.resume.fingerprint === j.doc?.fingerprint ? j.resume.parts.length : 0;
      if (done) {
        c.append(
          node(
            "small",
            "",
            `已完成 ${done} / ${j.resume.total} 段，重试将从第 ${done + 1} 段继续，不重算已完成的部分。`
          )
        );
      } else if (j.doc) {
        c.append(node("small", "", "已识别正文保留，重试只会重新生成总结。"));
      }
      actions(c, [
        button("重试", () => (j.doc ? generate(j) : read(j)), "primary"),
        button("查看日志", () => openSettings("logs"), "link")
      ]);
    }
    if (j.value && j.phase === "done") renderResult(body, j);
    if (j.phase === "generating" && j.preview) paintPreview(j);
    if (j.phase === "done") {
      const foot = node("footer", "article-footer");
      foot.append(
        button("复制总结", () => copy(j)),
        button("下载 Markdown", () => download(j)),
        node("span", "article-spacer"),
        button("重新总结", () => read(j), "link")
      );
      root.append(foot);
    }
    body.scrollTop = scroll;
    if (busy && orb && keepOrb) {
      orb.replaceWith(priorOrb);
    } else if (busy && orb && typeof startOrb === "function") {
      orb.dataset.phase = j.phase;
      stopOrb = startOrb(orb, {
        state: j.phase === "reading" ? "weaving" : "solving",
        size: j.phase === "reading" ? 58 : 18,
        iconOnly: true
      });
    }
  }

  function renderResult(body, j) {
    const result = node("div", "article-results");
    body.append(result);
    if (j.stale) {
      const stale = node("div", "article-scope");
      stale.append(
        node("span", "", "正文已更新，可重新总结。"),
        button("重新总结", () => read(j), "link")
      );
      result.append(stale);
    }
    if (j.notice) result.append(node("div", "article-scope", j.notice));
    if (j.changed) result.append(node("div", "article-scope", j.changed));
    if (j.cached) {
      const model = j.cached.model ? `（${j.cached.model}）` : "";
      result.append(
        node(
          "div",
          "article-scope",
          `显示 ${formatGeneratedAt(j.cached.generatedAt)} 生成的总结${model}，未重新调用模型。`
        )
      );
    }
    if (j.doc.partial) {
      result.append(
        node(
          "div",
          "article-scope",
          `总结仅基于${j.doc.manual ? "手动选择的" : "当前读取的"} ${j.doc.blocks.length} 段正文，不代表网页未加载的内容。`
        )
      );
    }
    const summary = node("div", "article-overview");
    summary.append(node("small", "", "文章总结"), node("span", "", j.value.summary));
    result.append(summary);
    j.value.sections.forEach((section, si) => {
      const s = node("section", "article-section");
      s.append(node("h3", "", section.title));
      result.append(s);
      section.points.forEach((point, pi) => {
        const key = `${si}:${pi}`;
        const p = node("div", `article-point${j.active === key ? " selected" : ""}`);
        p.append(node("span", "", point.text));
        s.append(p);
        const groups = A.groups(point.sources, j.doc);
        const label = (g) => `${g[0].section} · 段落 ${g.map((b) => j.doc.blocks.indexOf(b) + 1).join("、")}`;
        if (groups.length === 1) {
          const b = button("查看原文", () => locate(j, key, groups[0], section.title), "source");
          b.append(node("small", "", label(groups[0])));
          p.append(b);
        } else if (groups.length > 1) {
          p.append(
            button(
              `查看原文 · ${groups.length} 处 ${j.open.has(key) ? "▴" : "▾"}`,
              () => {
                if (j.open.has(key)) j.open.delete(key);
                else j.open.add(key);
                render();
              },
              "source"
            )
          );
          if (j.open.has(key)) {
            const list = node("div", "article-sources");
            groups.forEach((g, i) =>
              list.append(
                button(
                  `${i + 1}  ${label(g)}`,
                  () => locate(j, key, g, `${section.title} · 原文 ${i + 1}/${groups.length}`),
                  "source"
                )
              )
            );
            p.append(list);
          }
        }
        if (j.fail[key]) {
          const error = node("div", "article-source-error");
          error.append(
            node("strong", "", "没找到这段原文"),
            node("span", "", j.fail[key]),
            button("重新读取文章", () => read(j)),
            button(
              "关闭",
              () => {
                delete j.fail[key];
                render();
              },
              "link"
            )
          );
          p.append(error);
        }
      });
    });
  }

  // 侧栏关闭：退出当前文章，并断开所有标签页的连接，内容脚本各自清掉遮罩和高亮
  window.addEventListener("pagehide", () => {
    deactivate();
    for (const tabId of [...ports.keys()]) disconnect(tabId);
  });

  globalThis.BiliCaptionArticlePanel = {
    activate,
    resolveTab,
    deactivate,
    isActive: () => Boolean(current),
    read,
    generate,
    preview
  };
})();
