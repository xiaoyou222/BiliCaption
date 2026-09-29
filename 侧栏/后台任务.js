// 侧栏 · 后台任务：转写 / 翻译任务的进度胶囊、分片列表、暂停与重试，以及轮询确认任务还活着。

// 胶囊处于失败态时待重试的分段序号（从 1 起），点胶囊或「重试失败段」时用
let asrFailedIndexes = [];

function sameAsrVideo(info) {
  if (!info || !state) return false;
  const hasIdentity = Boolean(info.bvid || info.cid);
  const expectedBvid = state.bvid || "";
  const expectedCid = Number(state.cid) || 0;
  if (!hasIdentity || (!expectedBvid && !expectedCid)) return false;
  if (info.bvid && (!expectedBvid || info.bvid !== expectedBvid)) return false;
  if (info.cid && (!expectedCid || Number(info.cid) !== expectedCid)) return false;
  return true;
}

function tickAsrWait() {
  clearInterval(asrWaitTimer);
  asrWaitTimer = 0;
  if (!asrProgress?.waitUntil || asrProgress.waitUntil <= Date.now()) return;
  asrWaitTimer = setInterval(() => {
    if (!asrProgress?.waitUntil || asrProgress.waitUntil <= Date.now()) {
      clearInterval(asrWaitTimer);
      asrWaitTimer = 0;
    }
    renderAsrJobBar();
  }, 1000);
}

function stopAsrWatch() {
  clearInterval(asrWatchTimer);
  asrWatchTimer = 0;
  asrMissingChecks = 0;
}

function startAsrWatch() {
  stopAsrWatch();
  let checking = false;
  asrWatchTimer = setInterval(async () => {
    if (!generating || checking) {
      if (!generating) stopAsrWatch();
      return;
    }
    checking = true;
    try {
      const status = await chrome.runtime.sendMessage({
        type: "GET_ASR_JOB",
        jobId: asrJobId,
        tabId: boundTabId || myTabId,
        bvid: state?.bvid,
        cid: state?.cid
      });
      if (status?.running) {
        asrMissingChecks = 0;
        if (status.stage !== "done") applyAsrProgress(status);
        return;
      }
      asrMissingChecks += 1;
      if (asrMissingChecks < 2) return;
      stopAsrWatch();
      generating = false;
      asrJobId = "";
      clearInterval(asrWaitTimer);
      asrStopReason = "Chrome 后台任务已中断";
      if (state) {
        state = {
          ...state,
          partial: true,
          asrDone: Math.max(Number(asrProgress?.done) || 0, Number(state.asrDone) || 0),
          asrTotal: Math.max(Number(asrProgress?.total) || 0, Number(state.asrTotal) || 0)
        };
      }
      renderAsrJobBar();
      if (state?.partial) flash("后台任务已中断，已保留进度，可继续生成", 6000);
    } catch {
      // 下一轮再确认，避免一次消息失败就误判任务中断
    } finally {
      checking = false;
    }
  }, 20 * 1000);
}

function chunkStatusLabel(status) {
  if (status === "fail") return "失败";
  if (status === "run") return "转写中";
  if (status === "pause") return "已暂停";
  if (status === "done") return "✓ 完成";
  return "排队";
}

/**
 * 转写胶囊的失败态：有失败段、且没有正在转写 / 排队的段时，任务其实在等用户重试，
 * 胶囊不能再显示「转写 0/2」加转圈，要明确告诉用户失败了、可以点重试。
 * stalled：只剩失败段在等重试；label：胶囊上的文字（没有失败段时为空，沿用原来的显示）。
 */
function asrFailSummary(chunks) {
  const rows = Array.isArray(chunks) ? chunks : [];
  const total = rows.length;
  const failed = rows.filter((c) => c.status === "fail").map((c) => Number(c.i));
  const done = rows.filter((c) => c.status === "done").length;
  const busy = rows.some((c) => c.status === "run" || c.status === "pause" || c.status === "wait");
  const stalled = failed.length > 0 && !busy;
  let label = "";
  if (failed.length) {
    label = stalled && !done
      ? "转写失败 · 重试"
      : `${done}/${total} · ${failed.length} 段失败`;
  }
  return { failed, done, total, stalled, label };
}

/** 把所有失败段重新提交（胶囊失败态的点击、展开面板里的「重试失败段」） */
async function retryFailedAsrChunks(indexes) {
  for (const i of indexes || []) await retryAsrChunk(i);
}

function synthesizeChunks(done, total, current, duration, failed = []) {
  const n = Math.max(0, Number(total) || 0);
  if (!n || n > 400) return [];
  const dur = Math.max(0, Number(duration) || 0);
  const slice = dur && n ? dur / n : 0;
  const failSet = new Set((failed || []).map((i) => Number(i)));
  const running = Math.max(0, Number(current) || (done < n ? done + 1 : 0));
  return Array.from({ length: n }, (_, idx) => {
    const i = idx + 1;
    const start = slice ? slice * idx : 0;
    const end = slice ? slice * i : 0;
    let status = "wait";
    if (failSet.has(i) || failSet.has(idx)) status = "fail";
    else if (i <= done) status = "done";
    else if (i === running && generating && !asrPaused) status = "run";
    else if (i === running && asrPaused) status = "pause";
    return { i, start, end, status };
  });
}

function renderChunkRows(host, rows) {
  if (!host) return;
  // 冷却倒计时每秒重渲染整个胶囊，行没变就跳过，避免点阵球每秒重启闪一下
  const sig = rows.map((c) => `${c.i}:${c.status}:${Math.round(c.start || 0)}-${Math.round(c.end || 0)}`).join("|");
  if (host._chunkSig === sig) return;
  host._chunkSig = sig;
  (host._chunkOrbStops || []).forEach((stop) => stop());
  host._chunkOrbStops = [];
  host.replaceChildren();
  for (const c of rows) {
    const row = document.createElement("div");
    row.className = `chunk-row is-${c.status}`;
    const idx = document.createElement("span");
    idx.className = "chunk-idx";
    idx.textContent = `#${String(c.i).padStart(2, "0")}`;
    const range = document.createElement("span");
    range.className = "chunk-range";
    range.textContent = c.end
      ? `${formatClock(c.start)}–${formatClock(c.end)}`
      : "";
    row.append(idx, range);
    if (c.status === "fail") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "chunk-retry";
      retry.textContent = "重试";
      retry.addEventListener("click", (e) => {
        e.stopPropagation();
        retryAsrChunk(c.i);
      });
      row.appendChild(retry);
    } else {
      const st = document.createElement("span");
      st.className = `chunk-status ${c.status}`;
      if (c.status === "run") {
        const orbHost = document.createElement("span");
        orbHost.className = "chunk-orb";
        st.appendChild(orbHost);
        host._chunkOrbStops.push(startOrb(orbHost, {
          state: "searching",
          size: 13,
          speed: 0.9,
          iconOnly: true,
          label: ""
        }));
      }
      const label = document.createElement("span");
      label.textContent = chunkStatusLabel(c.status);
      st.appendChild(label);
      row.appendChild(st);
    }
    host.appendChild(row);
  }
}

const PILL_MORPH_MS = 340;
const PILL_MAX_H = () => Math.min(Math.round(window.innerHeight * 0.72), 420);

function cacheJobPillChipWidth(pill) {
  if (!pill || jobPillOpen || jobPillAnimating || pill.classList.contains("hidden")) return;
  const w = Math.ceil(pill.getBoundingClientRect().width);
  if (w > 24) jobPillChipW = w;
}

function pillMorphEnd(pill, done) {
  let called = false;
  const finish = () => {
    if (called) return;
    called = true;
    pill.removeEventListener("transitionend", onEnd);
    clearTimeout(timer);
    done();
  };
  // 宽和高谁先结束都行，只认 height，避免宽度先到就把展开类拆掉，箭头会在最后一帧抖一下
  const onEnd = (e) => {
    if (e.target === pill && e.propertyName === "height") finish();
  };
  pill.addEventListener("transitionend", onEnd);
  const timer = setTimeout(finish, PILL_MORPH_MS + 80);
}

function expandJobPill() {
  const pill = ui.jobPill;
  if (!pill || jobPillAnimating || jobPillOpen) return;
  const startW = Math.ceil(pill.getBoundingClientRect().width);
  if (startW > 24) jobPillChipW = startW;
  jobPillOpen = true;
  jobPillAnimating = true;
  // 先把展开态内容渲染出来并测量最终盒（含边框），避免结束时从 px 切回 max-content 跳一下
  renderAsrJobBar();
  pill.style.transition = "none";
  pill.style.width = "";
  pill.style.height = "auto";
  pill.offsetHeight;
  const openBox = pill.getBoundingClientRect();
  const targetW = openBox.width;
  const targetH = Math.min(openBox.height, PILL_MAX_H());
  // 从收起尺寸起步
  pill.style.width = `${startW}px`;
  pill.style.height = "20px";
  pill.offsetWidth; // reflow
  pill.style.transition = "";
  requestAnimationFrame(() => {
    pill.style.width = `${targetW}px`;
    pill.style.height = `${targetH}px`;
  });
  pillMorphEnd(pill, () => {
    pill.style.transition = "none";
    pill.style.width = "";
    pill.style.height = "";
    pill.offsetWidth;
    pill.style.transition = "";
    jobPillAnimating = false;
  });
}

function resetJobPillClosed() {
  jobPillOpen = false;
  jobPillAnimating = false;
  const pill = ui.jobPill;
  if (!pill) return;
  pill.classList.remove("is-open", "is-collapsing");
  pill.style.width = "";
  pill.style.height = "";
  pill.style.transition = "";
}

function collapseJobPill() {
  const pill = ui.jobPill;
  if (!pill || jobPillAnimating || !jobPillOpen) return;
  const startW = Math.ceil(pill.getBoundingClientRect().width);
  const startH = Math.ceil(pill.getBoundingClientRect().height);
  const chipW = jobPillChipW > 24 ? jobPillChipW : 80;
  jobPillAnimating = true;
  pill.classList.add("is-collapsing");
  renderAsrJobBar();
  pill.style.transition = "none";
  pill.style.width = `${startW}px`;
  pill.style.height = `${startH}px`;
  pill.offsetWidth;
  pill.style.transition = "";
  requestAnimationFrame(() => {
    pill.style.width = `${chipW}px`;
    pill.style.height = "20px";
  });
  pillMorphEnd(pill, () => {
    jobPillOpen = false;
    pill.classList.remove("is-open");
    pill.classList.remove("is-collapsing");
    pill.style.transition = "none";
    pill.style.width = "";
    pill.style.height = "";
    pill.offsetWidth;
    pill.style.transition = "";
    jobPillAnimating = false;
    renderAsrJobBar();
  });
}

function renderAsrJobBar() {
  ensureRecommendation(state);
  const pill = ui.jobPill;
  const bar = ui.asrJobBar;
  const trBar = ui.trJobBar;
  const hasCues = Boolean(state?.cues?.length);
  const partial = Boolean(state?.partial);
  const showAsr = Boolean(generating || (partial && (asrProgress?.total || state?.asrTotal)));
  const showTr = Boolean(translating);
  const progress = asrProgress || {};
  const waitLeft = Math.max(0, (Number(progress.waitUntil) || 0) - Date.now());
  const waiting = generating && waitLeft > 0;
  // 头部计数与分片列表必须同源，否则会出现「8/13 但列表 0 完成」
  const chunkRows = generating && Array.isArray(progress.chunks) && progress.chunks.length
    ? progress.chunks
    : null;
  const chunkDoneN = chunkRows ? chunkRows.filter((c) => c.status === "done").length : 0;
  const chunkRunIdx = chunkRows
    ? chunkRows.findIndex((c) => c.status === "run" || c.status === "pause") + 1
    : 0;
  const asrDone = chunkRows
    ? chunkDoneN
    : Number(generating ? progress.done ?? state?.asrDone : state?.asrDone) || 0;
  const asrTotal = chunkRows
    ? chunkRows.length
    : Number(generating ? progress.total ?? state?.asrTotal : state?.asrTotal) || 0;
  const asrCurrent = chunkRows ? chunkRunIdx : Number(progress.current) || 0;
  const asrShown = asrDone;
  const trDone = Number(translateProgress.done) || 0;
  const trTotal = Number(translateProgress.total) || 0;
  const failed = progress.failed || [];
  const chunks = chunkRows
    || synthesizeChunks(asrDone, asrTotal, asrCurrent, state?.duration, failed);
  const failInfo = asrFailSummary(generating ? chunks : []);
  // 只剩失败段在等重试：胶囊显示失败态，点阵球停下
  const failStalled = Boolean(showAsr && generating && !waiting && failInfo.stalled);
  asrFailedIndexes = failStalled ? failInfo.failed : [];

  const coolLabel = (() => {
    const ms = waitLeft || 0;
    const sec = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  })();

  const collapsing = Boolean(pill?.classList.contains("is-collapsing"));
  if (ui.jobPillLabel) {
    if (jobPillOpen && !collapsing) ui.jobPillLabel.textContent = "后台任务";
    else if (showAsr && showTr) ui.jobPillLabel.textContent = "2 个任务";
    else if (showAsr && waiting) ui.jobPillLabel.textContent = `冷却 ${coolLabel}`;
    else if (showAsr && failInfo.label) ui.jobPillLabel.textContent = failInfo.label;
    else if (showAsr) ui.jobPillLabel.textContent = asrTotal ? `转写 ${asrShown}/${asrTotal}` : "转写中";
    else if (showTr) ui.jobPillLabel.textContent = trTotal ? `翻译 ${trDone}/${trTotal}` : "翻译中";
  }

  if (pill) {
    const visible = showAsr || showTr;
    const wasHidden = pill.classList.contains("hidden");
    if (!visible || (visible && wasHidden)) resetJobPillClosed();
    show(pill, visible);
    pill.classList.toggle("is-wait", waiting);
    pill.classList.toggle("is-fail", failStalled);
    if (ui.jobPillHead) ui.jobPillHead.setAttribute("aria-expanded", jobPillOpen && visible ? "true" : "false");
    if (!collapsing) pill.classList.toggle("is-open", jobPillOpen && visible);
    if (visible && !jobPillOpen && !jobPillAnimating) cacheJobPillChipWidth(pill);
  }
  showPillOrb(Boolean((showAsr && generating && !waiting && !asrPaused && !failStalled) || showTr));
  updateTranslateLock();

  if (bar) {
    show(bar, showAsr);
    if (!showAsr && ui.asrSwitchNote) show(ui.asrSwitchNote, false);
    if (showAsr) {
      const pauseBtn = $("btnPauseAsr");
      if (pauseBtn) {
        pauseBtn.textContent = failStalled
          ? "重试失败段"
          : generating ? (asrPaused ? "继续" : "暂停") : "继续生成";
        pauseBtn.dataset.mode = failStalled ? "retry" : generating ? "pause" : "resume";
        show(pauseBtn, generating || partial);
      }
      show($("btnCancelAsrJob"), generating || partial);
      showAsrSegOrb(false);
      if (ui.asrSwitchNote) {
        const on = Boolean(asrSwitchNote);
        ui.asrSwitchNote.textContent = asrSwitchNote;
        show(ui.asrSwitchNote, on);
      }
      if (ui.asrJobTitle) {
        const activeProvider = String(asrProgress?.provider || "").trim();
        ui.asrJobTitle.textContent = waiting
          ? `所有通道都在冷却，${coolLabel} 后继续`
          : failStalled
            ? `${failInfo.failed.length} 段转写失败，可点重试`
            : asrPaused
              ? "已暂停"
              : generating
                ? (activeProvider ? `转写中 · ${activeProvider}` : "转写中")
                : "继续生成";
      }
      if (ui.asrSegPct) ui.asrSegPct.textContent = asrTotal ? `${asrShown}/${asrTotal}` : "";
      if (ui.asrJobFill) {
        const pct = asrTotal ? Math.max(0, Math.min(100, Math.round((asrShown / asrTotal) * 100))) : 0;
        ui.asrJobFill.style.width = `${pct}%`;
        ui.asrJobFill.style.background = asrPaused ? "#8A9099" : "";
        const track = $("asrJobTrack");
        if (track) {
          track.setAttribute("aria-valuenow", String(pct));
          track.setAttribute("aria-valuetext", asrTotal ? `${asrShown}/${asrTotal} 个分片已完成` : "正在准备转写");
        }
      }
      const live = chunks.filter((c) => c.status === "fail" || c.status === "run" || c.status === "pause");
      const doneRows = chunks.filter((c) => c.status === "done" || c.status === "wait");
      renderChunkRows(ui.chunkLiveList, live);
      const queued = chunks.filter((c) => c.status === "wait").length;
      const doneN = chunks.filter((c) => c.status === "done").length;
      if (ui.btnChunkFold) {
        show(ui.btnChunkFold, doneRows.length > 0);
        ui.btnChunkFold.textContent = chunkListExpanded
          ? "收起 ▴"
          : `已完成 ${doneN} 片 · 排队 ${queued} 片 ▸`;
      }
      show(ui.chunkDoneList, chunkListExpanded);
      if (chunkListExpanded) renderChunkRows(ui.chunkDoneList, doneRows);
    }
  }

  if (trBar) {
    show(trBar, showTr);
    if (showTr) {
      if (ui.trJobTitle) ui.trJobTitle.textContent = "翻译中";
      if (ui.trSegPct) ui.trSegPct.textContent = trTotal ? `${trDone}/${trTotal}` : "";
    }
  }

  renderCueGhosts(generating && view === "captions");
}

function renderCueGhosts(on) {
  const host = ui.cueGhosts;
  if (!host) return;
  show(host, on);
  if (!on) {
    host.replaceChildren();
    return;
  }
  if (host.childElementCount) return;
  for (let i = 0; i < 3; i += 1) {
    const row = document.createElement("div");
    row.className = "cue-ghost";
    row.innerHTML = `<span class="cue-ghost-time"></span><span class="cue-ghost-bar"></span>`;
    host.appendChild(row);
  }
}

async function pauseAsr(paused) {
  try {
    await chrome.runtime.sendMessage({
      type: "PAUSE_ASR",
      paused: paused !== false,
      jobId: asrJobId,
      bvid: state?.bvid,
      cid: state?.cid,
      tabId: boundTabId || myTabId
    });
    asrPaused = paused !== false;
    renderAsrJobBar();
  } catch (error) {
    flash(error.message || "无法暂停");
  }
}

async function retryAsrChunk(index) {
  try {
    const result = await chrome.runtime.sendMessage({
      type: "RETRY_ASR_CHUNK",
      index,
      jobId: asrJobId,
      bvid: state?.bvid,
      cid: state?.cid,
      tabId: boundTabId || myTabId
    });
    if (result?.error) flash(result.error);
  } catch (error) {
    flash(error.message || "重试失败");
  }
}

function setAsrSwitchNote(text) {
  asrSwitchNote = String(text || "").replace(/（冷却结束自动切回）$/, "").trim();
  clearTimeout(asrSwitchNoteTimer);
  if (!asrSwitchNote) return;
  asrSwitchNoteTimer = setTimeout(() => {
    asrSwitchNote = "";
    renderAsrJobBar();
  }, 8000);
}

function applyAsrProgress(info) {
  if (!info || !sameAsrVideo(info)) return;
  cancelCueEdit();
  const hadCues = Boolean(state?.cues?.length);
  const sameJob = !info.jobId || !asrProgress?.jobId || info.jobId === asrProgress.jobId;
  const prevDone = sameJob ? Number(asrProgress?.done) || 0 : 0;
  const prevTotal = sameJob ? Number(asrProgress?.total) || 0 : 0;
  const prevCurrent = sameJob ? Number(asrProgress?.current) || 0 : 0;
  // 后台的 done/chunks 都是从任务实况现算的，直接信任；本地再取 max 会把重开任务的旧计数残留下来
  asrProgress = {
    jobId: info.jobId || asrProgress?.jobId || "",
    done: info.done != null ? Number(info.done) || 0 : prevDone,
    total: info.total != null ? Number(info.total) || 0 : prevTotal,
    waitUntil: Number(info.waitUntil) || 0,
    message: info.message || asrProgress?.message || "",
    stage: info.stage || "",
    current: Number(info.current) > 0 ? Number(info.current) : prevCurrent,
    waitKind: info.stage === "wait" ? (info.waitKind || asrProgress?.waitKind || "") : "",
    provider: info.provider || asrProgress?.provider || "",
    running: info.running !== false && info.stage !== "done",
    chunks: Array.isArray(info.chunks) ? info.chunks : asrProgress?.chunks,
    failed: Array.isArray(info.failed) ? info.failed : asrProgress?.failed || [],
    paused: info.paused != null ? Boolean(info.paused) : asrProgress?.paused
  };
  const noteMsg = String(info.message || "");
  if (/已切到/.test(noteMsg)) setAsrSwitchNote(noteMsg);
  if (info.paused != null) asrPaused = Boolean(info.paused);
  if (info.cues?.length) {
    const cues = applyRememberedTranslations(info.cues);
    const translated = translatedCueText.size > 0 || translatedCueRanges.length > 0 || info.source === "translated";
    state = {
      ...(state || {}),
      cues,
      source: translated ? "translated" : (info.source || "groq"),
      activeLan: translated ? "translated" : (info.activeLan || "groq-asr"),
      origin: "asr",
      partial: info.partial !== false,
      asrDone: asrProgress.done,
      asrTotal: asrProgress.total
    };
  }
  tickAsrWait();
  if (info.cues?.length && !hadCues) {
    renderState(state);
    return;
  }
  renderAsrJobBar();
  if (info.cues?.length) {
    renderCues();
    renderCaptionLang();
  }
}

async function attachRunningAsr(next) {
  try {
    const status = await chrome.runtime.sendMessage({
      type: "GET_ASR_JOB",
      tabId: boundTabId || myTabId,
      bvid: next?.bvid || state?.bvid,
      cid: next?.cid || state?.cid
    });
    if (!status?.running) return false;
    generating = true;
    asrJobId = status.jobId || asrJobId;
    applyAsrProgress(status);
    startAsrWatch();
    return true;
  } catch {
    return false;
  }
}

function stopTranslateWatch() {
  clearInterval(translateWatchTimer);
  translateWatchTimer = 0;
  translateMissingChecks = 0;
}

function startTranslateWatch() {
  if (translateWatchTimer) return;
  stopTranslateWatch();
  let checking = false;
  translateWatchTimer = setInterval(async () => {
    if (!translating || checking) {
      if (!translating) stopTranslateWatch();
      return;
    }
    checking = true;
    try {
      // 轮询只确认任务还活着、同步进度数字；整份字幕靠开始 / 结束广播和行数不一致时补要。
      const status = await chrome.runtime.sendMessage({
        type: "GET_TRANSLATE_JOB",
        jobId: translateJobId,
        tabId: boundTabId || myTabId,
        bvid: state?.bvid,
        cid: state?.cid,
        lite: true
      });
      if (status?.running) {
        translateMissingChecks = 0;
        if (status.stage !== "done") applyTranslateProgress(status);
        if (Number(status.cueCount) && state?.cues?.length !== Number(status.cueCount)) requestTranslateSnapshot();
        return;
      }
      translateMissingChecks += 1;
      if (translateMissingChecks < 2) return;
      stopTranslateWatch();
      translating = false;
      translateJobId = "";
      translateProgress = { done: 0, total: 0 };
      renderAsrJobBar();
      if (!state?.cues?.length) await refresh(true);
      flash("后台翻译已中断，已保留进度，可再点一次", 6000);
    } catch {
      // 下一轮再确认
    } finally {
      checking = false;
    }
  }, 20 * 1000);
}

function rememberCuesFromJob(cues) {
  if (!Array.isArray(cues)) return;
  resetTranslationsFor(state);
  for (const cue of cues) {
    if (cueHasCjk(cue.content)) rememberTranslatedCue(cue, cue.content, cue.original);
  }
}

function applyTranslateProgress(info) {
  if (!info || (state && !sameAsrVideo(info))) return;
  const running = info.running !== false && info.stage !== "done" && info.stage !== "canceled" && info.stage !== "error";
  if (running) cancelCueEdit();
  translating = running;
  if (info.jobId) translateJobId = info.jobId;
  translateProgress = {
    done: Number(info.done) || 0,
    total: Number(info.total) || 0,
    stage: info.stage || ""
  };
  if (info.cues?.length) {
    rememberCuesFromJob(info.cues);
    state = {
      ...(state || {}),
      cues: hydrateCueOriginals(info.cues),
      source: "translated",
      activeLan: "translated"
    };
    revealChineseIfReady(state.cues);
    renderCues();
    renderCaptionLang();
  } else if (info.patch?.length && !applyTranslatePatch(info.patch, info.cueCount)) {
    requestTranslateSnapshot();
  }
  renderAsrJobBar();
}

/**
 * 运行中的翻译广播只带本批变化的行 [[行索引, 译文, 英文原文], …]。
 * 本地行数与后台一致才打补丁，只记住、只重画这几行；对不上返回 false，由调用方补要整份。
 */
function applyTranslatePatch(patch, cueCount) {
  const cues = state?.cues;
  if (!cues?.length || (Number(cueCount) && cues.length !== Number(cueCount))) return false;
  resetTranslationsFor(state);
  const next = cues.slice();
  const touched = [];
  for (const [index, content, original] of patch) {
    const cue = next[index];
    if (!cue || typeof content !== "string") continue;
    const orig = String(cue.original || "").trim() || String(original || "").trim();
    const row = orig ? { ...cue, content, original: orig } : { ...cue, content };
    next[index] = row;
    rememberTranslatedCue(row, content, orig);
    touched.push(index);
  }
  const wasTranslated = state.source === "translated";
  state = { ...state, cues: next, source: "translated", activeLan: "translated" };
  if (revealChineseIfReady(touched.map((i) => next[i])) || !wasTranslated) {
    // 显示语言或字幕来源刚变：整表重画一次，之后都只补行。
    renderCues();
    renderCaptionLang();
  } else {
    patchCueRows(touched);
  }
  return true;
}

function patchCueRows(indices) {
  const cues = state?.cues || [];
  if (cueRowEls.length !== cues.length) {
    renderCues();
    return;
  }
  for (const i of indices) {
    if (cueEdit && cueEdit.index === i) continue;
    const text = cueRowEls[i]?.querySelector(".cue-text");
    const shown = cueDisplayText(cues[i]);
    if (text && text.textContent !== shown) text.textContent = shown;
  }
  // 首尾行也可能被补丁改到：同步签名，免得下次 renderCues 误判为换了一份字幕而整表重建、跳动滚动。
  lastCuesSig = cuesSignature(cues);
}

async function requestTranslateSnapshot() {
  if (translateSnapshotPending) return;
  translateSnapshotPending = true;
  try {
    const status = await chrome.runtime.sendMessage({
      type: "GET_TRANSLATE_JOB",
      jobId: translateJobId,
      tabId: boundTabId || myTabId,
      bvid: state?.bvid,
      cid: state?.cid
    });
    if (status?.running && status.cues?.length) applyTranslateProgress(status);
  } catch {
    // 下一次补丁或轮询再补
  } finally {
    translateSnapshotPending = false;
  }
}

/** 播放进度跳转（拖进度条、点字幕跳转）时，让后台按新位置重排还没派发的翻译批次。 */
function noteTranslateSeek(time) {
  const t = Number(time);
  const prev = lastPlaybackTime;
  lastPlaybackTime = t;
  if (!translating || !Number.isFinite(t) || !Number.isFinite(prev)) return;
  // 正常播放两次 TIME 之间只走零点几秒，跳 5 秒以上才算拖动。
  if (Math.abs(t - prev) < 5) return;
  clearTimeout(translateSeekTimer);
  translateSeekTimer = setTimeout(() => {
    if (!translating) return;
    translateSeekAt = lastPlaybackTime;
    chrome.runtime.sendMessage({
      type: "TRANSLATE_SEEK",
      jobId: translateJobId,
      tabId: boundTabId || myTabId,
      bvid: state?.bvid,
      cid: state?.cid,
      time: translateSeekAt
    }).catch(() => {});
  }, 400);
}

async function attachRunningTranslate(next) {
  try {
    const status = await chrome.runtime.sendMessage({
      type: "GET_TRANSLATE_JOB",
      tabId: boundTabId || myTabId,
      bvid: next?.bvid || state?.bvid,
      cid: next?.cid || state?.cid,
      // 后台若从存档续跑，就从当前播放位置附近先译
      currentTime: Number(next?.currentTime ?? state?.currentTime) || 0
    });
    if (!status?.running) return false;
    translating = true;
    translateJobId = status.jobId || translateJobId;
    applyTranslateProgress(status);
    startTranslateWatch();
    return true;
  } catch {
    return false;
  }
}
