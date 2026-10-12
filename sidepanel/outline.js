// 侧栏 · 大纲：章节列表的渲染与高亮、大纲缓存，以及分段并行生成大纲。

function outlineApi() {
  return globalThis.BiliCaptionOutline;
}

function outlineKey(next = state) {
  if (!next?.bvid && !next?.cid) return "";
  return `outline:v2:${next.bvid || ""}:${next.cid || ""}`;
}

function chapterSubs(ch) {
  return (ch?.subs || []).filter((sub) => String(sub?.title || "").trim());
}

function resetOutlineTree() {
  outlineDensity = "brief";
  chOpen = {};
}

function renderOutlineMeta() {
  const box = ui.outlineMeta;
  if (!box) return;
  const on = view === "outline" && Boolean(outline?.length) && Boolean(outlineApi()?.outlineHasSubs?.(outline));
  show(box, on);
  if (!on) return;
  const segs = outlineApi()?.outlineSubCount?.(outline) || 0;
  if (ui.outlineMetaLabel) ui.outlineMetaLabel.textContent = `${outline.length} 段 · ${segs} 小节`;
  const nestedIdx = [];
  (outline || []).forEach((ch, i) => {
    if (chapterSubs(ch).length) nestedIdx.push(i);
  });
  const openCount = nestedIdx.filter((i) => chOpen[i]).length;
  ui.outlineDensity?.querySelectorAll("[data-density]").forEach((btn) => {
    const key = btn.getAttribute("data-density");
    const selected = key === "detail"
      ? nestedIdx.length > 0 && openCount === nestedIdx.length
      : openCount === 0;
    btn.classList.toggle("active", selected);
  });
}

function setOutlineDensity(mode) {
  outlineDensity = mode === "detail" ? "detail" : "brief";
  const next = {};
  if (outlineDensity === "detail") {
    (outline || []).forEach((ch, i) => {
      if (chapterSubs(ch).length) next[i] = true;
    });
  }
  chOpen = next;
  lastOutlineIndex = -1;
  renderOutline();
  renderOutlineActive(state?.currentTime || 0);
}

function outlineRowInView(el) {
  const list = ui.outlineList;
  if (!el || !list) return true;
  const listRect = list.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const pad = 12;
  return elRect.bottom > listRect.top + pad && elRect.top < listRect.bottom - pad;
}

function scrollOutlineIntoView(el) {
  const list = ui.outlineList;
  if (!el || !list) return;
  const listRect = list.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const pad = 12;
  let next = list.scrollTop;
  if (elRect.top < listRect.top + pad) next -= listRect.top + pad - elRect.top;
  else if (elRect.bottom > listRect.bottom - pad) next += elRect.bottom - (listRect.bottom - pad);
  else return;
  list.scrollTo({ top: Math.max(0, next), behavior: "auto" });
}

function outlinePositionAt(currentTime) {
  return outlineApi()?.activeOutlinePosition?.(outline, currentTime)
    || { chapterIndex: -1, subIndex: -1 };
}

function renderOutlineActive(currentTime, { forceScroll = false } = {}) {
  if (!outline?.length || ui.outlineList.classList.contains("hidden") || outlineLoading) return;
  const { chapterIndex: idx, subIndex } = outlinePositionAt(currentTime);
  if (idx < 0) return;

  const blocks = ui.outlineList.querySelectorAll(".chapter-block");
  let activeEl = null;
  let activeKey = "";
  blocks.forEach((block, i) => {
    const row = block.querySelector(".chapter");
    const subEls = block.querySelectorAll(".chapter-sub");
    const open = Boolean(chOpen[i]) && chapterSubs(outline[i]).length > 0;
    const subHit = open && i === idx ? subIndex : -1;
    row?.classList.toggle("active", i === idx && !open);
    subEls.forEach((el, si) => el.classList.toggle("active", si === subHit));
    if (i === idx) {
      activeEl = subHit >= 0 ? subEls[subHit] : row;
      activeKey = `${idx}:${subHit}`;
    }
  });
  if (!activeEl) return;
  if (activeKey === lastOutlineIndex && !forceScroll) return;
  lastOutlineIndex = activeKey;
  if (!forceScroll && Date.now() - userOutlineScrollAt < 2500) return;
  if (!forceScroll && outlineRowInView(activeEl)) return;
  scrollOutlineIntoView(activeEl);
}

function renderVideoSummary({ streaming = false } = {}) {
  const box = ui.videoSummary;
  const body = ui.videoSummaryBody;
  if (!box) return;
  const text = String(videoSummary || "").trim();
  const onOutline = view === "outline";
  const visible = onOutline && Boolean(text);
  show(box, visible);
  if (!visible) return;
  if (body) {
    const textEl = ui.videoSummaryText || body;
    if (textEl.textContent !== videoSummary) textEl.textContent = videoSummary;
    body.classList.toggle("is-streaming", Boolean(streaming || outlineLoading));
    show(body, videoSummaryOpen);
  }
  ui.videoSummaryChevron?.classList.toggle("is-collapsed", !videoSummaryOpen);
  ui.videoSummaryToggle?.setAttribute("aria-expanded", videoSummaryOpen ? "true" : "false");
}

function ensureChapterBlock() {
  const block = document.createElement("div");
  block.className = "chapter-block";
  block.innerHTML = `
    <div class="chapter">
      <div class="chapter-time">
        <span class="chapter-start"></span>
        <div class="chapter-line"></div>
        <span class="chapter-end"></span>
      </div>
      <div class="chapter-body">
        <div class="chapter-title-row">
          <span class="chapter-title"></span>
          <span class="chapter-sub-count"></span>
        </div>
        <span class="chapter-synopsis"></span>
      </div>
      <button type="button" class="chapter-expand" aria-label="展开小节">▾</button>
    </div>
    <div class="chapter-subs" hidden></div>`;
  return block;
}

function renderOutline() {
  if (!outline?.length) {
    ui.outlineList.innerHTML = "";
    renderOutlineMeta();
    return;
  }
  const t = Number(state?.currentTime) || 0;
  const activePosition = outlinePositionAt(t);
  while (ui.outlineList.children.length > outline.length) {
    ui.outlineList.lastElementChild.remove();
  }
  outline.forEach((ch, i) => {
    const streaming = outlineLoading && i === outline.length - 1;
    const subs = chapterSubs(ch);
    const open = Boolean(chOpen[i]) && subs.length > 0;
    const active = !outlineLoading && activePosition.chapterIndex === i && !open;
    let block = ui.outlineList.children[i];
    if (!block?.classList.contains("chapter-block")) {
      block = ensureChapterBlock();
      if (ui.outlineList.children[i]) ui.outlineList.replaceChild(block, ui.outlineList.children[i]);
      else ui.outlineList.appendChild(block);
    }
    const row = block.querySelector(".chapter");
    row.dataset.start = String(ch.start);
    row.dataset.end = String(ch.end);
    row.dataset.index = String(i);
    const startEl = row.querySelector(".chapter-start");
    const endEl = row.querySelector(".chapter-end");
    if (startEl) {
      if (startEl.textContent !== formatClock(ch.start)) startEl.textContent = formatClock(ch.start);
      startEl.dataset.time = String(ch.start);
    }
    if (endEl) {
      if (endEl.textContent !== formatClock(ch.end)) endEl.textContent = formatClock(ch.end);
      endEl.dataset.time = String(ch.end);
    }
    const titleEl = row.querySelector(".chapter-title");
    const synEl = row.querySelector(".chapter-synopsis");
    if (titleEl && titleEl.textContent !== ch.title) titleEl.textContent = ch.title;
    if (synEl && synEl.textContent !== ch.synopsis) synEl.textContent = ch.synopsis;
    const count = row.querySelector(".chapter-sub-count");
    if (count) {
      count.hidden = !(subs.length && !open);
      if (subs.length) count.textContent = `${subs.length} 节`;
    }
    const expand = row.querySelector(".chapter-expand");
    if (expand) {
      expand.hidden = subs.length === 0;
      expand.classList.toggle("is-open", open);
      expand.setAttribute("aria-expanded", open ? "true" : "false");
    }
    const subWrap = block.querySelector(".chapter-subs");
    if (subWrap) {
      if (!open) {
        subWrap.hidden = true;
        subWrap.innerHTML = "";
      } else {
        subWrap.hidden = false;
        while (subWrap.children.length > subs.length) subWrap.lastElementChild.remove();
        subs.forEach((sub, si) => {
          let el = subWrap.children[si];
          if (!el) {
            el = document.createElement("div");
            el.className = "chapter-sub";
            el.innerHTML = `<span class="chapter-sub-time"></span><span class="chapter-sub-title"></span>`;
            subWrap.appendChild(el);
          }
          el.dataset.start = String(sub.start);
          const subActive = !outlineLoading
            && activePosition.chapterIndex === i
            && activePosition.subIndex === si;
          el.classList.toggle("active", subActive);
          const timeEl = el.querySelector(".chapter-sub-time");
          const titleSub = el.querySelector(".chapter-sub-title");
          if (timeEl) timeEl.textContent = formatClock(sub.start);
          if (titleSub) titleSub.textContent = sub.title;
        });
      }
    }
    const nextClass = `chapter${active ? " active" : ""}${streaming ? " streaming" : ""}${open ? " is-open" : ""}`;
    if (row.className !== nextClass) row.className = nextClass;
  });
  renderOutlineMeta();
}

function outlineText() {
  return outlineApi().formatOutlineCopy(videoSummary, outline);
}

function outlineMarkdown() {
  const title = state?.title || "大纲";
  return outlineApi()?.formatOutlineMarkdown(title, videoSummary, outline) || `# ${title}\n`;
}

async function loadOutlineCache(next) {
  const key = outlineKey(next);
  if (!key) {
    outline = null;
    videoSummary = "";
    resetOutlineTree();
    return;
  }
  const startedRequest = outlineAbort;
  const data = await chrome.storage.local.get({ [key]: null });
  if (outlineKey(state) !== key || outlineAbort !== startedRequest || outlineLoading) return;
  const rec = outlineApi()?.normalizeOutlineRecord(data[key]) || { summary: "", chapters: [] };
  const chapters = Array.isArray(rec.chapters) ? rec.chapters : [];
  const cues = next?.cues || [];
  const fixed = chapters.length
    ? (outlineApi()?.finalizeOutline(chapters, cues) || chapters)
    : [];
  outline = fixed.length ? fixed : null;
  videoSummary = rec.summary || "";
  videoSummaryOpen = true;
  resetOutlineTree();
}

function outlineCues() {
  return state?.cues || [];
}

function parseOutlineRecord(text) {
  const rec = outlineApi()?.parseOutlinePayload(text);
  if (!rec) throw new Error("大纲格式无法解析");
  return {
    summary: rec.summary || "",
    chapters: outlineApi().finalizeOutline(rec.chapters, outlineCues())
  };
}

function parseStreamingOutline(text) {
  return outlineApi()?.parseStreamingOutline(text, outlineCues()) || { summary: "", chapters: [] };
}

function paintOutlineStream() {
  if (view !== "outline") return;
  const hasSummary = Boolean(String(videoSummary || "").trim());
  const hasChapters = Boolean(outline?.length);
  if (!hasSummary && !hasChapters) return;
  show(ui.outlineEmpty, false);
  showOutlineEmptyOrb(false);
  show(ui.outlineHead, true);
  showOutlineThinking(true);
  if (ui.outlineHeadLabel) {
    const n = Math.max(1, outline?.length || 1);
    setShimmer(ui.outlineHeadLabel, true, hasChapters ? `正在生成大纲 · 第 ${n} 段` : "正在生成大纲");
  }
  renderVideoSummary({ streaming: true });
  show(ui.outlineList, hasChapters);
  renderOutlineMeta();
  show(ui.outlineBar, true);
  const copyBtn = $("btnCopyOutline");
  if (copyBtn) copyBtn.textContent = "停止生成";
  if (hasChapters && !outlineRaf) {
    outlineRaf = requestAnimationFrame(() => {
      outlineRaf = 0;
      if (view === "outline") renderOutline();
    });
  }
}

// 超长字幕分段并行生成大纲时的并发上限。
const OUTLINE_CHUNK_CONCURRENCY = 3;

/** 大纲请求失败时，可重试的错误（超时、限流、结构校验失败等）再试一次。 */
async function runOutlineModel(prompt, signal, options = {}) {
  const Call = globalThis.BiliCaptionModelCall;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runModel(prompt, { ...options, signal, task: "outline" });
    } catch (error) {
      if (attempt >= 1 || signal?.aborted || !Call?.isRetryable?.(error)) throw error;
    }
  }
}

async function runOutlineChunks(ranges, limit, worker) {
  const results = new Array(ranges.length);
  let cursor = 0;
  let failure = null;
  const lane = async () => {
    while (!failure && cursor < ranges.length) {
      const i = cursor;
      cursor += 1;
      try {
        results[i] = await worker(ranges[i], i);
      } catch (error) {
        failure = failure || error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, ranges.length)) }, lane));
  if (failure) throw failure;
  return results;
}

/**
 * 超长字幕（超过 10 万字符）按 map-reduce 生成大纲：
 * 分块并行（有并发上限），每块直接产出本块概括和章节；章节超过上限时再请模型合并相邻章节，
 * 全片总结复用各块概括。最终请求里不再塞字幕全文。
 */
async function generateLongOutline(cues, signal, paint) {
  const O = outlineApi();
  const layout = O.outlineLayout(cues);
  const ranges = O.planOutlineChunks(cues);
  const parts = new Array(ranges.length).fill(null);
  const showDonePrefix = () => {
    // 只画从头连续完成的几段，免得中间缺一段时章节边界被硬接起来。
    const done = [];
    for (const part of parts) {
      if (!part) break;
      done.push(...part.chapters);
    }
    if (done.length) paint("", O.finalizeOutline(done, cues, { partial: true }));
  };
  await runOutlineChunks(ranges, OUTLINE_CHUNK_CONCURRENCY, async (range, i) => {
    const text = await runOutlineModel(O.buildChunkOutlinePrompt(cues, range, { part: i + 1, parts: ranges.length }), signal, {
      validate(raw) {
        try {
          return O.parseOutlinePayload(raw).chapters.length > 0;
        } catch {
          return false;
        }
      }
    });
    if (signal.aborted) return;
    const rec = O.parseOutlinePayload(text);
    parts[i] = {
      summary: rec.summary,
      chapters: rec.chapters.map((ch) => O.normalizeChapter(ch, cues))
    };
    showDonePrefix();
  });
  if (signal.aborted) return { summary: "", chapters: [] };

  const combined = O.finalizeOutline(parts.flatMap((part) => part?.chapters || []), cues);
  const summaries = parts.map((part) => part?.summary || "").filter(Boolean);
  const needMerge = combined.length > layout.chapterMax;
  let lastPreview = "";
  const result = await runOutlineModel(
    needMerge ? O.buildOutlineMergePrompt(combined, summaries, layout) : O.buildSummaryReducePrompt(summaries),
    signal,
    {
      validate: needMerge
        ? (raw) => {
          try {
            return O.parseOutlineMerge(raw).groups.length > 0;
          } catch {
            return false;
          }
        }
        : undefined,
      onDelta(full) {
        // 汇总现在也输出 JSON；模型只回一段纯文本时照旧整段当总结预览
        const summary = O.parseStreamingOutline(full, cues).summary
          || (needMerge || /^\s*[{`]/.test(full) ? "" : full);
        if (!summary || summary === lastPreview) return;
        lastPreview = summary;
        paint(summary, null);
      }
    }
  );
  if (!needMerge) {
    const reduced = O.parseSummaryReduce(result);
    return { summary: reduced.summary, chapters: combined };
  }
  const merged = O.parseOutlineMerge(result);
  return {
    summary: merged.summary,
    chapters: O.finalizeOutline(O.mergeOutlineGroups(combined, merged.groups), cues)
  };
}

async function generateOutline() {
  if (!state?.cues?.length || outlineLoading) return;
  outlineAbort?.abort();
  outlineAbort = new AbortController();
  const ac = outlineAbort;
  outlineLoading = true;
  outline = null;
  videoSummary = "";
  videoSummaryOpen = true;
  resetOutlineTree();
  lastOutlineIndex = -1;
  view = "outline";
  renderState(state);
  const startedOutlineKey = outlineKey(state);
  const cues = state.cues;
  const O = outlineApi();
  // 流式期间已经画出来的总结和章节；校验失败或中途出错时保留它们，不清空。
  let streamed = false;
  const paint = (summary, chapters) => {
    if (ac.signal.aborted || outlineKey(state) !== startedOutlineKey) return;
    if (summary) videoSummary = summary;
    if (chapters?.length) outline = chapters;
    if (!summary && !chapters?.length) return;
    streamed = true;
    paintOutlineStream();
  };
  try {
    let summary = "";
    let chapters = [];
    const corpus = O?.cueCorpus?.(cues) || "";
    const overBudget = corpus.length > (O?.SUMMARY_CUE_CHAR_BUDGET || 100000);

    if (overBudget) {
      ({ summary, chapters } = await generateLongOutline(cues, ac.signal, paint));
    } else {
      let lastPreview = "";
      if (ac.signal.aborted) return;
      const result = await runModel(O?.buildOutlinePrompt(cues) || "", {
        signal: ac.signal,
        task: "outline",
        validate(text) {
          try {
            const rec = parseOutlineRecord(text);
            return Boolean(rec.summary) || rec.chapters.length > 0;
          } catch {
            return false;
          }
        },
        onDelta(full) {
          const rec = parseStreamingOutline(full);
          const preview = `${rec.summary}\n${JSON.stringify(rec.chapters)}`;
          if (preview === lastPreview) return;
          lastPreview = preview;
          paint(rec.summary, rec.chapters);
        }
      });
      if (ac.signal.aborted) return;
      const rec = parseOutlineRecord(result);
      summary = rec.summary;
      chapters = rec.chapters;
    }

    if (ac.signal.aborted) return;
    summary = String(summary || "").trim();
    if (!summary || !chapters.length) throw new Error("大纲结果结构校验失败");
    const key = startedOutlineKey;
    if (key) await chrome.storage.local.set({ [key]: { summary, chapters } });
    if (ac.signal.aborted || outlineAbort !== ac || outlineKey(state) !== startedOutlineKey) return;
    videoSummary = summary;
    outline = chapters;
    flash("大纲已生成");
  } catch (error) {
    if (ac.signal.aborted || error?.name === "AbortError") return;
    if (outlineKey(state) !== startedOutlineKey) return;
    if (!streamed) {
      outline = null;
      videoSummary = "";
    }
    flash(streamed
      ? `${error.message || "生成大纲失败"}，已保留生成出来的部分`
      : (error.message || "生成大纲失败"), 6000);
  } finally {
    if (outlineAbort === ac) {
      outlineLoading = false;
      showOutlineThinking(false);
      renderState(state);
    }
  }
}

function stopOutline() {
  outlineAbort?.abort();
  outlineLoading = false;
  if (!outline?.length && !String(videoSummary || "").trim()) {
    videoSummary = "";
  }
  showOutlineThinking(false);
  renderState(state);
}

function seekOutlineTime(time) {
  if (!Number.isFinite(time)) return;
  const token = ++outlineSeekToken;
  const previousTime = Number(state?.currentTime) || 0;

  // 点击目标是确定的，先更新高亮；播放器随后用 seeked/TIME 回传实际时间校准。
  if (state) state.currentTime = time;
  renderOutlineActive(time);

  sendToTab({ type: "SEEK", time })
    .then((next) => {
      if (token !== outlineSeekToken) return;
      const confirmedTime = Number(next?.currentTime);
      if (!Number.isFinite(confirmedTime)) return;
      if (state) state.currentTime = confirmedTime;
      renderOutlineActive(confirmedTime);
    })
    .catch((error) => {
      if (token !== outlineSeekToken) return;
      if (state) state.currentTime = previousTime;
      renderOutlineActive(previousTime);
      flash(error.message || "跳转失败，请先点一下视频页");
    });
}
