// 内容脚本 · 文章模式：按用户操作注入普通网页，负责正文识别、范围遮罩、手动选择和原文定位。
// 没有自动模型调用，也不发送整页 HTML。
(() => {
  if (globalThis.__bcArticleContent) return;
  globalThis.__bcArticleContent = true;
  const A = globalThis.BiliCaptionArticle;
  let focusNodes = [];
  let doc = null;
  let manual = null;
  let rangeOn = false;
  let highlights = [];
  let timer = 0;
  let frame = 0;
  const host = document.createElement("div");
  host.setAttribute("data-bc-article-ui", "");
  host.style.cssText = "position:fixed;inset:0;z-index:2147483646;pointer-events:none";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    .box{position:fixed;box-sizing:border-box;pointer-events:none;border-radius:5px}
    .frost{position:fixed;inset:0;pointer-events:none;background:rgba(128,132,140,.12);backdrop-filter:blur(3.5px);-webkit-backdrop-filter:blur(3.5px)}
    .focus{position:fixed;box-sizing:border-box;pointer-events:none;border:1px solid rgba(77,142,240,.4);border-radius:10px;overflow:hidden}
    .range{outline:1px solid #4D8EF088;background:#4D8EF009}
    .pick{background:#4D8EF030;outline:1px solid #4D8EF0}
    .hit{background:#4D8EF040;outline:2px solid #4D8EF080;animation:fade 2.4s .25s both}
    .tag{position:absolute;right:0;top:0;max-width:90%;font:11px/1.5 system-ui;color:white;background:#356EC5;padding:2px 7px;border-radius:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .scan{position:absolute;left:0;right:0;top:-140px;height:140px;background:linear-gradient(to bottom,rgba(77,142,240,0),rgba(77,142,240,.2) 82%,rgba(77,142,240,.5) 98%,#4D8EF0 100%);animation:bcScanBand 1.6s cubic-bezier(.45,.05,.4,.95) infinite}
    .scan[hidden]{display:none}
    @keyframes bcScanBand{from{transform:translateY(0)}to{transform:translateY(var(--scan-distance))}}
    @keyframes fade{0%,65%{opacity:1}100%{opacity:0}}
    @media(prefers-reduced-motion:reduce){.scan{animation:none;top:0;height:2px}.hit{animation:none}}
  `;
  shadow.append(style);
  const layer = document.createElement("div");
  shadow.append(layer);
  const frost = document.createElement("div");
  frost.className = "frost";
  const focus = document.createElement("div");
  focus.className = "focus";
  const scanBand = document.createElement("div");
  scanBand.className = "scan";
  focus.append(scanBand);
  function drawFocus(nodes) {
    // 一个连续的正文区域，保留段间空白和插图；遮罩在正文外挖空，不给文字逐块上色。
    const rects = nodes.map((n) => n.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length) {
      layer.replaceChildren();
      return;
    }
    const left = Math.max(0, Math.min(innerWidth, Math.min(...rects.map((r) => r.left)) - 18));
    const right = Math.max(left, Math.min(innerWidth, Math.max(...rects.map((r) => r.right)) + 18));
    const top = Math.max(0, Math.min(innerHeight, Math.min(...rects.map((r) => r.top)) - 12));
    const bottom = Math.max(top, Math.min(innerHeight, Math.max(...rects.map((r) => r.bottom)) + 12));
    frost.style.clipPath = `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${left}px ${top}px, ${right}px ${top}px, ${right}px ${bottom}px, ${left}px ${bottom}px, ${left}px ${top}px)`;
    focus.style.cssText = `--scan-distance:${bottom - top + 140}px;left:${left}px;top:${top}px;width:${right - left}px;height:${bottom - top}px`;
    scanBand.hidden = rangeOn !== "scan";
    // 滚动时只更新边界，保留光带节点，避免扫描动画反复从头开始。
    if (frost.parentNode !== layer) layer.replaceChildren(frost, focus);
  }
  function mount() {
    if (!host.isConnected) document.documentElement.append(host);
  }
  function addBox(node, name, tag = "") {
    const r = node.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || !r.width || !r.height) return;
    const box = document.createElement("div");
    box.className = `box ${name}`;
    box.style.cssText = `left:${r.left - 3}px;top:${r.top - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;overflow:hidden`;
    if (tag) {
      const t = document.createElement("span");
      t.className = "tag";
      t.textContent = tag;
      box.append(t);
    }
    layer.append(box);
  }
  function redraw() {
    frame = 0;
    if (!rangeOn || manual) layer.replaceChildren();
    if (!rangeOn && !manual && !highlights.length) {
      host.remove();
      return;
    }
    mount();
    const candidates = manual?.items || [];
    if (manual) {
      const lo = Math.min(manual.start ?? -1, manual.end ?? manual.start ?? -1);
      const hi = Math.max(manual.start ?? -1, manual.end ?? manual.start ?? -1);
      // 同一节点断成几段时只画一个框
      const picked = new Set();
      candidates.forEach((b, i) => {
        if (i >= lo && i <= hi) picked.add(b.node);
      });
      picked.forEach((n) => addBox(n, "pick"));
      if (manual.hover != null)
        addBox(candidates[manual.hover].node, "range", manual.start == null ? "点击设为起点" : "点击设为终点");
    } else if (rangeOn && doc) {
      drawFocus(focusNodes.filter((n) => n.isConnected));
    }
    for (const hit of highlights) if (hit.node.isConnected) addBox(hit.node, "hit", hit.label);
  }
  function schedule() {
    if (!rangeOn && !manual && !highlights.length) return;
    if (!frame) frame = requestAnimationFrame(redraw);
  }
  document.addEventListener("scroll", schedule, { passive: true, capture: true });
  window.addEventListener("resize", schedule);
  function cacheFocus() {
    const candidates = A.scan(document);
    focusNodes = [
      ...new Set((doc?.blocks || []).map((b) => b.source && A.sourceMatch(b.source, candidates)?.node).filter(Boolean))
    ];
  }
  function cleanup() {
    rangeOn = false;
    manual = null;
    highlights = [];
    clearTimeout(timer);
    redraw();
  }
  function ensureURL(url) {
    if (A.pageKey(location.href) !== url) throw Error("页面已切换，请重新读取文章");
  }
  function selection() {
    if (!manual) return null;
    const { items, start, end } = manual;
    return {
      start: start == null ? "" : items[start].text.slice(0, 100),
      end: end == null ? "" : items[end].text.slice(0, 100),
      ready: start != null && end != null,
      count: start != null && end != null ? Math.abs(start - end) + 1 : 0
    };
  }
  /**
   * 鼠标所在的段落：从目标往上找最近的一个段落节点（嵌套列表点子项时选子项）。
   * 同一个节点被 <br><br> 分成几段时返回 [第一段, 最后一段] 的下标。
   */
  function itemRange(target) {
    for (let n = target; n && n !== document.documentElement; n = n.parentElement) {
      const first = manual.items.findIndex((b) => b.node === n);
      if (first < 0) continue;
      let last = first;
      while (manual.items[last + 1]?.node === n) last += 1;
      return [first, last];
    }
    return null;
  }
  document.addEventListener(
    "mouseover",
    (e) => {
      if (!manual) return;
      const found = itemRange(e.target);
      if (found && manual.hover !== found[0]) {
        manual.hover = found[0];
        schedule();
      }
    },
    true
  );
  document.addEventListener(
    "click",
    (e) => {
      if (!manual) return;
      const found = itemRange(e.target);
      if (!found) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const [first, last] = found;
      if (manual.start == null || manual.end != null) {
        manual.start = first;
        manual.end = null;
      } else {
        // 终点在起点之后时取这个节点的最后一段，在之前时取第一段
        manual.end = first >= manual.start ? last : first;
      }
      redraw();
    },
    true
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape") cleanup();
    },
    true
  );
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === "bc-article" && port.sender?.id === chrome.runtime.id) port.onDisconnect.addListener(cleanup);
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!String(message?.type || "").startsWith("ARTICLE_")) return;
    if (
      sender.id !== chrome.runtime.id ||
      !String(sender.url || "").startsWith(`chrome-extension://${chrome.runtime.id}/`)
    )
      return;
    try {
      if (message.type === "ARTICLE_PING") {
        respond({ ok: true, url: A.pageKey(location.href) });
        return;
      }
      if (message.type === "ARTICLE_CLEAR") {
        cleanup();
        respond({ ok: true });
        return;
      }
      ensureURL(message.url);
      if (message.type === "ARTICLE_EXTRACT") {
        // quiet：侧栏打开缓存的总结时静默比对正文有没有更新，不画扫描遮罩、不动当前状态
        if (message.quiet) {
          respond({ ok: true, doc: A.extract(document, globalThis.Defuddle) });
          return;
        }
        cleanup();
        doc = A.extract(document, globalThis.Defuddle);
        cacheFocus();
        rangeOn = "scan";
        redraw();
        respond({ ok: true, doc });
        return;
      }
      if (message.type === "ARTICLE_RANGE") {
        if (message.doc) {
          if (message.doc.url !== message.url) throw Error("文章来源不一致");
          const changed = doc?.fingerprint !== message.doc.fingerprint;
          doc = message.doc;
          if (changed || !focusNodes.length) cacheFocus();
        }
        rangeOn = message.on;
        redraw();
        respond({ ok: true });
        return;
      }
      if (message.type === "ARTICLE_PICK") {
        cleanup();
        manual = { items: A.scan(document), start: null, end: null };
        redraw();
        respond({ ok: true });
        return;
      }
      if (message.type === "ARTICLE_SELECTION") {
        respond({ ok: true, selection: selection() });
        return;
      }
      if (message.type === "ARTICLE_CONFIRM") {
        if (!selection()?.ready) throw Error("请先选择起点和终点");
        const from = Math.min(manual.start, manual.end);
        const to = Math.max(manual.start, manual.end);
        const selected = manual.items.slice(from, to + 1);
        if (selected.some((b) => !b.node.isConnected || !A.visible(b.node)))
          throw Error("选中的正文已变化，请重新选择范围");
        doc = A.manualDocument(document, selected);
        focusNodes = [...new Set(selected.map((b) => b.node))];
        manual = null;
        rangeOn = true;
        redraw();
        respond({ ok: true, doc });
        return;
      }
      if (message.type === "ARTICLE_LOCATE") {
        const candidates = A.scan(document);
        const blocks = message.sources;
        if (!Array.isArray(blocks) || !blocks.length || blocks.length > 100) throw Error("原文定位信息无效");
        const found = blocks.map((b) => A.sourceMatch(b, candidates));
        if (found.some((b) => !b)) throw Error("原文可能已更新或存在多个相同段落，请重新读取文章");
        cleanup();
        highlights = found.map((b, i) => ({ node: b.node, label: i === 0 ? String(message.label || "原文") : "" }));
        found[0].node.scrollIntoView({
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
          block: "center"
        });
        redraw();
        timer = setTimeout(() => {
          highlights = [];
          redraw();
        }, 2800);
        respond({ ok: true });
        return;
      }
      respond({ error: "不支持的文章操作" });
    } catch (error) {
      respond({ error: error.message || String(error) });
    }
  });
})();
