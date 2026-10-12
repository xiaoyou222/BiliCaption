// 侧栏 · 选区：按住选择键滑动选句、点击选区、循环播放选区，以及滑动轨迹。

function syncSelectChrome(onCaptions = view === "captions") {
  // 设计稿：底栏行动条挂在 hasList 里，空态/限流/读取中不出现。
  const selectOpen = onCaptions && !hasSummary && range.start >= 0;
  show(ui.selectBar, selectOpen);
  show(ui.actionBar, onCaptions && !hasSummary && !selectOpen);
}

function selKeyIsHeld() {
  return selKeyHeldFromPage === true;
}

function syncSelKeyArmed() {
  const armed = Boolean(
    selKeyIsHeld()
    && view === "captions"
    && state?.cues?.length
    && !selecting
    && !cueEdit
  );
  const hint = armed && !selectHeld && !dragSelect;
  ui.cueList?.classList.toggle("key-armed", armed);
  if (ui.selKeyHint) {
    show(ui.selKeyHint, hint);
    ui.selKeyHint.setAttribute("aria-hidden", hint ? "false" : "true");
  }
}

/** 字幕行数变少（换了一份字幕、重新断句）后，旧选区可能越界：清掉，免得读到不存在的行 */
function dropStaleSelection() {
  const count = state?.cues?.length || 0;
  if (range.start < count && range.end < count) return;
  range = { start: -1, end: -1 };
  anchor = -1;
  setLoopSel(false);
}

function paintSelection() {
  dropStaleSelection();
  paintVisibleCues();
  const start = range.start;
  const ready = start >= 0;

  ui.cueList.classList.toggle("selecting", selectHeld || selecting);
  syncSelKeyArmed();
  renderLoopBtn();
  syncLoopRange();

  if (!ready && !selecting) {
    syncSelectChrome();
    ui.btnSelect.textContent = "划选";
    ui.btnSelect.classList.remove("active");
    return;
  }

  if (view !== "captions") {
    syncSelectChrome(false);
    return;
  }

  syncSelectChrome(true);
  ui.btnSelect.textContent = selecting ? (start < 0 ? "点起点…" : "点终点…") : "划选";
  ui.btnSelect.classList.toggle("active", selecting);

  if (start < 0) {
    ui.selectInfo.textContent = selectHeld
      ? `鼠标放在起点，按住 ${keyLabel(selKey)} 再滑动`
      : "点第一行作为起点";
  } else if (range.end < 0) {
    ui.selectInfo.textContent = selecting
      ? `起点 ${formatClock(state.cues[start].from)} · 再点终点`
      : `起点 ${formatClock(state.cues[start].from)} · 滑到终点`;
  } else {
    const a = Math.min(start, range.end);
    const b = Math.max(start, range.end);
    ui.selectInfo.textContent = `已选 ${b - a + 1} 句 · ${formatClock(state.cues[a].from)}–${formatClock(state.cues[b].from)}`;
  }
}

function pausePlayback() {
  if (loopSel) return;
  sendToTab({ type: "PAUSE" }).catch(() => {});
}

function selectedLoopRange() {
  if (!state?.cues?.length || range.start < 0) return null;
  const end = range.end >= 0 ? range.end : range.start;
  const a = Math.min(range.start, end);
  const b = Math.max(range.start, end);
  const startCue = state.cues[a];
  const lastCue = state.cues[b];
  if (!startCue || !lastCue) return null;
  const from = Number(startCue.from);
  const next = state.cues[b + 1];
  const to = next ? Number(next.from) : Number(lastCue.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  return { from, to };
}

function renderLoopBtn() {
  const btn = ui.btnLoopSel;
  if (!btn) return;
  btn.textContent = loopSel ? "循环中" : "循环";
  btn.classList.toggle("on", loopSel);
  btn.setAttribute("aria-pressed", loopSel ? "true" : "false");
}

function syncLoopRange() {
  if (!loopSel) return;
  const span = selectedLoopRange();
  if (!span) return;
  const key = `${span.from}:${span.to}`;
  if (key === lastLoopSent) return;
  lastLoopSent = key;
  sendToTab({ type: "LOOP_SEL", from: span.from, to: span.to }).catch(() => {});
}

function setLoopSel(on) {
  if (on) {
    const span = selectedLoopRange();
    if (!span) {
      flash("先划选一段字幕再循环");
      return;
    }
    loopSel = true;
    lastLoopSent = `${span.from}:${span.to}`;
    renderLoopBtn();
    sendToTab({ type: "LOOP_SEL", from: span.from, to: span.to, seek: true, play: true })
      .catch((error) => flash(error.message || "循环失败，请先点一下视频页"));
    return;
  }
  if (!loopSel) {
    renderLoopBtn();
    return;
  }
  loopSel = false;
  lastLoopSent = "";
  renderLoopBtn();
  sendToTab({ type: "LOOP_SEL" }).catch(() => {});
}

function notifyPageSelKey(held) {
  if (window.parent === window) return;
  try {
    window.parent.postMessage({ type: "BC_SEL_KEY", held: Boolean(held) }, "*");
  } catch {
    // ignore
  }
}

function pointerSelKeyState(event) {
  const key = String(selKey || "Shift").toLowerCase();
  if (key === "shift") return Boolean(event.shiftKey);
  if (key === "control" || key === "ctrl") return Boolean(event.ctrlKey);
  if (key === "alt" || key === "option") return Boolean(event.altKey);
  if (key === "meta" || key === "command") return Boolean(event.metaKey);
  return null;
}

function selKeyDownNow(event) {
  const fromPointer = pointerSelKeyState(event);
  if (inFloatEmbed()) {
    if (fromPointer === false) return false;
    return selKeyHeldFromPage === true;
  }
  if (selKeyHeldFromPage === true) return true;
  if (selKeyHeldFromPage === false) return false;
  return fromPointer === true;
}

function selKeyReleasedNow(event) {
  const fromPointer = pointerSelKeyState(event);
  if (inFloatEmbed()) {
    if (fromPointer === false) return true;
    return selKeyHeldFromPage === false;
  }
  if (selKeyHeldFromPage === false) return true;
  if (selKeyHeldFromPage === true) return false;
  return fromPointer === false;
}

function cueIndexFromPoint(clientX, clientY) {
  const stack = document.elementsFromPoint(clientX, clientY);
  const row = stack.find((el) => el.classList?.contains("cue") || el.closest?.(".cue"));
  const cue = row?.classList?.contains("cue") ? row : row?.closest?.(".cue");
  if (cue && ui.cueList.contains(cue)) {
    const index = Number(cue.dataset.index);
    if (Number.isFinite(index)) return index;
  }
  const box = ui.cueList.getBoundingClientRect();
  if (clientX < box.left || clientX > box.right || clientY < box.top || clientY > box.bottom) {
    if (!selectHeld && !dragSelect) return -1;
  }
  const y = ui.cueList.scrollTop + (clientY - box.top);
  return cueIndexFromOffset(y);
}

function trailPoint(x, y) {
  const box = ui.selectTrail?.getBoundingClientRect();
  if (!box) return { x: 0, y: 0 };
  return { x: x - box.left, y: y - box.top };
}

function trailPointFromEvent(event) {
  return trailPoint(event.clientX, event.clientY);
}

function prepareTrailCanvas() {
  const canvas = ui.selectTrail;
  if (!canvas) return null;
  const box = canvas.getBoundingClientRect();
  const width = Math.max(1, box.width);
  const height = Math.max(1, box.height);
  const dpr = window.devicePixelRatio || 1;
  const nextW = Math.max(1, Math.round(width * dpr));
  const nextH = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== nextW || canvas.height !== nextH) {
    canvas.width = nextW;
    canvas.height = nextH;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

function drawTrail() {
  show(ui.selectTrail, true);
  const ready = prepareTrailCanvas();
  if (!ready) return;
  const { ctx, width, height } = ready;
  ctx.clearRect(0, 0, width, height);
  if (trailPoints.length < 2) {
    if (trailPoints[0]) {
      ctx.fillStyle = "rgba(255,255,255,.9)";
      ctx.beginPath();
      ctx.arc(trailPoints[0].x, trailPoints[0].y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let i = 1; i < trailPoints.length; i += 1) {
    const t = i / (trailPoints.length - 1);
    ctx.strokeStyle = `rgba(77, 142, 240, ${0.18 + t * 0.72})`;
    ctx.lineWidth = 2 + t * 3.2;
    ctx.beginPath();
    ctx.moveTo(trailPoints[i - 1].x, trailPoints[i - 1].y);
    ctx.lineTo(trailPoints[i].x, trailPoints[i].y);
    ctx.stroke();
  }
  const last = trailPoints[trailPoints.length - 1];
  ctx.fillStyle = "rgba(255,255,255,.92)";
  ctx.beginPath();
  ctx.arc(last.x, last.y, 3.5, 0, Math.PI * 2);
  ctx.fill();
}

function clearTrail() {
  trailPoints = [];
  const ready = prepareTrailCanvas();
  if (ready) ready.ctx.clearRect(0, 0, ready.width, ready.height);
  show(ui.selectTrail, false);
}

function autoScrollCues(clientY) {
  const box = ui.cueList.getBoundingClientRect();
  const edge = 36;
  if (clientY < box.top + edge) {
    ui.cueList.scrollTop -= 18;
  } else if (clientY > box.bottom - edge) {
    ui.cueList.scrollTop += 18;
  }
}

function rememberPointer(event) {
  lastPointer = { x: event.clientX, y: event.clientY };
}

function extendHoverSelect(event) {
  if (!selectHeld) return;
  rememberPointer(event);
  const point = trailPointFromEvent(event);
  const last = trailPoints[trailPoints.length - 1];
  if (!last || Math.hypot(point.x - last.x, point.y - last.y) >= 1.5) {
    trailPoints.push(point);
    if (trailPoints.length > 90) trailPoints.shift();
    drawTrail();
  }
  autoScrollCues(event.clientY);
  const index = cueIndexFromPoint(event.clientX, event.clientY);
  if (index < 0) return;
  if (range.start < 0) {
    if (hoverSelectFrom) {
      const dist = Math.hypot(event.clientX - hoverSelectFrom.x, event.clientY - hoverSelectFrom.y);
      if (dist < 8) return;
    }
    hoverSelectFrom = null;
    range = { start: index, end: index };
    anchor = index;
    pausePlayback();
    paintSelection();
    return;
  }
  if (index !== range.end) {
    range.end = index;
    paintSelection();
  }
}

function beginHoverSelect() {
  hasSummary = false;
  show(ui.summaryBox, false);
  trailPoints = [];
  hoverSelectFrom = { x: lastPointer.x, y: lastPointer.y };
  range = { start: -1, end: -1 };
  anchor = -1;
  paintSelection();
}

function onCuePointerDown(event, index) {
  if (cueEdit) {
    if (index === cueEdit.index) event.preventDefault();
    else ignoreCueClickUntil = Date.now() + 400;
    return;
  }
  if (selectHeld) {
    event.preventDefault();
    return;
  }
  if (selecting) return;
}

function onCuePointerMove(event) {
  rememberPointer(event);
  if (cueEdit) return;
  if (selKeyDownNow(event) && !selectHeld) {
    selectHeld = true;
    beginHoverSelect();
  } else if (selKeyReleasedNow(event) && selectHeld) {
    finishHeldSelect();
    return;
  }
  if (selectHeld) {
    extendHoverSelect(event);
    return;
  }
  if (!dragSelect) return;
  const point = trailPointFromEvent(event);
  const last = trailPoints[trailPoints.length - 1];
  if (!last || Math.hypot(point.x - last.x, point.y - last.y) >= 1.5) {
    trailPoints.push(point);
    if (trailPoints.length > 90) trailPoints.shift();
    drawTrail();
  }
  autoScrollCues(event.clientY);
  const index = cueIndexFromPoint(event.clientX, event.clientY);
  if (index < 0) return;
  if (index !== range.end) {
    dragSelect.moved = true;
    range.end = index;
    paintSelection();
  }
}

function onCuePointerUp(event) {
  if (!dragSelect) return;
  const index = cueIndexFromPoint(event.clientX, event.clientY);
  if (index >= 0) range.end = index;
  if (range.end < 0) range.end = range.start;
  if (dragSelect.moved) selecting = false;
  dragSelect = null;
  paintSelection();
  window.setTimeout(clearTrail, 280);
}

function onCueClick(index, cue, event) {
  if (cueEdit) {
    event.preventDefault();
    return;
  }
  if (selectHeld || Date.now() < ignoreCueClickUntil) {
    event.preventDefault();
    return;
  }
  if (selecting) {
    event.preventDefault();
    pausePlayback();
    hasSummary = false;
    show(ui.summaryBox, false);
    if (range.start < 0) {
      range = { start: index, end: -1 };
      anchor = index;
    } else {
      range.end = index;
      selecting = false;
    }
    paintSelection();
    return;
  }

  range = { start: -1, end: -1 };
  anchor = -1;
  hasSummary = false;
  show(ui.summaryBox, false);
  setLoopSel(false);
  paintSelection();
  sendToTab({ type: "SEEK", time: cue.from }).catch(() => {});
}
