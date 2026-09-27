// 侧栏 · 字幕列表：字幕行的构建与增量重绘、双击改字与批量替换、跟随播放的高亮和滚动。

function cuesSignature(cues) {
  if (!cues?.length) return "";
  const head = cues[0];
  const tail = cues[cues.length - 1];
  return `${cues.length}:${head.from}:${tail.to}:${head.content}:${tail.content}`;
}

function cueRowAt(index) {
  return cueRowEls[index] || null;
}

function cueTargetTop(index) {
  const row = cueRowAt(index);
  if (!row) return ui.cueList.scrollTop;
  const center = row.offsetTop + row.offsetHeight / 2;
  const max = Math.max(0, ui.cueList.scrollHeight - ui.cueList.clientHeight);
  return Math.min(max, Math.max(0, center - ui.cueList.clientHeight * 0.4));
}

function cueIndexFromOffset(y) {
  const n = cueRowEls.length;
  if (!n) return -1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const row = cueRowEls[mid];
    if (row.offsetTop + row.offsetHeight <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// 已经画到行上的高亮 / 选区。字幕最多 8000 条，每次换高亮行、每次拖动划选都遍历整张表太重：
// 这里记住上次画的状态，只改前后两次有差别的行。行节点一重建（cueRowEls 换成新数组）就作废，
// 新建的行本来就不带 active / picked。
let paintedRows = null;
let paintedActive = -1;
let paintedPick = null;

function setCueRowClass(index, name, on) {
  const row = cueRowEls[index];
  if (row) row.classList.toggle(name, on);
}

function paintPickRows(from, to, pick) {
  const last = Math.min(to, cueRowEls.length - 1);
  for (let i = Math.max(0, from); i <= last; i += 1) {
    setCueRowClass(i, "picked", Boolean(pick) && i >= pick.from && i <= pick.to && i !== pick.skip);
  }
}

function paintVisibleCues() {
  if (paintedRows !== cueRowEls) {
    paintedRows = cueRowEls;
    paintedActive = -1;
    paintedPick = null;
  }
  if (paintedActive !== lastActiveIndex) {
    if (paintedActive >= 0) setCueRowClass(paintedActive, "active", false);
    if (lastActiveIndex >= 0) setCueRowClass(lastActiveIndex, "active", true);
    paintedActive = lastActiveIndex;
  }
  const start = range.start;
  const end = range.end >= 0 ? range.end : start;
  const next = start >= 0
    ? { from: Math.min(start, end), to: Math.max(start, end), skip: cueEdit ? cueEdit.index : -1 }
    : null;
  const prev = paintedPick;
  if (prev === next || (prev && next && prev.from === next.from && prev.to === next.to && prev.skip === next.skip)) return;
  if (!prev) {
    paintPickRows(next.from, next.to, next);
  } else if (!next) {
    paintPickRows(prev.from, prev.to, null);
  } else if (prev.to < next.from || next.to < prev.from) {
    paintPickRows(prev.from, prev.to, next);
    paintPickRows(next.from, next.to, next);
  } else {
    // 两段有重叠：中间共有的行不变，只改两端伸缩出来的部分
    paintPickRows(Math.min(prev.from, next.from), Math.max(prev.from, next.from) - 1, next);
    paintPickRows(Math.min(prev.to, next.to) + 1, Math.max(prev.to, next.to), next);
    // 正在编辑的行不算选中，编辑行变了也要补画
    for (const index of [prev.skip, next.skip]) {
      if (index >= 0) paintPickRows(index, index, next);
    }
  }
  paintedPick = next;
}

function stopCueEditBubble(event) {
  event.stopPropagation();
}

function autoGrowCueEdit(el) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

function cueEditFieldFor(cue) {
  return window.BiliCaptionTranslate?.cueEditField?.(cue, captionLang)
    || (captionLang === "en" && String(cue?.original || "").trim() ? "original" : "content");
}

function closeSelectionForCueEdit() {
  selecting = false;
  selectHeld = false;
  dragSelect = null;
  hoverSelectFrom = null;
  range = { start: -1, end: -1 };
  anchor = -1;
  setLoopSel(false);
  hasSummary = false;
  show(ui.summaryBox, false);
  clearTrail();
  paintSelection();
}

/**
 * 用户手动改字 / 批量替换后保存。edited: true 让页面转给后台时带上改字标志，后台据此记 editedAt，
 * 这份缓存从此受保护、不被自动清理；改过的行自己带 cue.edited，之后的译文回写不会冲掉它们。
 */
function persistEditedCues(next) {
  state = { ...state, cues: next };
  lastCuesSig = "";
  renderCues();
  sendToTab({
    type: "SYNC_CUES",
    cues: state.cues,
    source: state.source,
    activeLan: state.activeLan,
    bvid: state.bvid || "",
    cid: Number(state.cid) || 0,
    edited: true
  }).catch(() => {});
}

function rebuildCueRows() {
  const cues = state?.cues || [];
  lastCuesSig = cuesSignature(cues);
  if (!cues.length) {
    cueRowEls = [];
    ui.cueList.replaceChildren();
    return;
  }
  buildCueRows(cues);
  paintVisibleCues();
}

function cancelCueEdit() {
  if (!cueEdit) return;
  cueEdit = null;
  rebuildCueRows();
}

function commitCueEdit() {
  if (!cueEdit) return;
  const { index, field, before } = cueEdit;
  const written = String(cueEdit.draft || "").trim() || before;
  cueEdit = null;
  const cues = state?.cues || [];
  const cue = cues[index];
  if (!cue || written === before) {
    lastCuesSig = cuesSignature(cues);
    if (cues.length) buildCueRows(cues);
    paintVisibleCues();
    return;
  }
  persistEditedCues(cues.map((item, i) => (i === index ? { ...item, [field]: written, edited: true } : item)));
}

function replaceAllCues() {
  if (!cueEdit) return;
  const term = cueEdit.term;
  const to = String(cueEdit.replaceTo || "");
  const field = cueEdit.field;
  if (!String(to).trim()) {
    flash("先输入要替换成什么");
    return;
  }
  const working = (state.cues || []).map((item, i) => (
    i === cueEdit.index ? { ...item, [field]: cueEdit.draft } : { ...item }
  ));
  const { cues, n } = window.BiliCaptionTranslate.replaceTerm(working, field, term, to);
  cueEdit = null;
  if (!n) {
    lastCuesSig = "";
    renderCues();
    return;
  }
  const before = state.cues || [];
  persistEditedCues(cues.map((cue, i) => (
    cue[field] !== before[i]?.[field] ? { ...cue, edited: true } : cue
  )));
  flash(`已替换 ${n} 处「${term}」`);
}

function hideCueReplaceBarSoon(el) {
  requestAnimationFrame(() => {
    if (!cueEdit?.term) return;
    const wrap = el.closest?.(".cue-edit");
    if (wrap?.querySelector(".cue-replace")?.contains(document.activeElement)) return;
    const term = String(el.value || "").slice(el.selectionStart ?? 0, el.selectionEnd ?? 0).trim();
    if (term && !/\n/.test(term)) return;
    cueEdit.term = "";
    cueEdit.termCount = 0;
    refreshReplaceBar();
  });
}

function onCueEditSelect(event) {
  if (!cueEdit) return;
  const el = event.target;
  cueEdit.draft = el.value;
  cueEdit.selStart = el.selectionStart;
  cueEdit.selEnd = el.selectionEnd;
  const term = el.value.slice(el.selectionStart, el.selectionEnd).trim();
  if (!term || /\n/.test(term)) {
    hideCueReplaceBarSoon(el);
    return;
  }
  const n = window.BiliCaptionTranslate.countTerm(
    state.cues, cueEdit.field, term, cueEdit.index, el.value
  );
  if (n >= 2) {
    cueEdit.term = term;
    cueEdit.termCount = n;
    refreshReplaceBar();
    return;
  }
  cueEdit.term = "";
  cueEdit.termCount = 0;
  refreshReplaceBar();
}

function onCueEditInput(event) {
  if (!cueEdit) return;
  cueEdit.draft = event.target.value;
  autoGrowCueEdit(event.target);
  onCueEditSelect(event);
}

function onCueEditKey(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    cancelCueEdit();
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    commitCueEdit();
  }
}

function buildReplaceBar() {
  const bar = document.createElement("div");
  bar.className = "cue-replace";
  const label = document.createElement("span");
  label.className = "cue-replace-label";
  label.textContent = `「${cueEdit.term}」· 共 ${cueEdit.termCount} 处`;
  const input = document.createElement("input");
  input.className = "cue-replace-input";
  input.placeholder = "替换为";
  input.value = cueEdit.replaceTo || "";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-primary cue-replace-btn";
  btn.textContent = "全部替换";
  btn.disabled = !String(cueEdit.replaceTo || "").trim();
  input.addEventListener("input", () => {
    if (!cueEdit) return;
    cueEdit.replaceTo = input.value;
    btn.disabled = !String(input.value || "").trim();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      replaceAllCues();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!cueEdit) return;
      cueEdit.term = "";
      cueEdit.termCount = 0;
      bar.remove();
    }
  });
  btn.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    replaceAllCues();
  });
  bar.append(label, input, btn);
  return bar;
}

function refreshReplaceBar() {
  const wrap = cueRowEls[cueEdit?.index]?.querySelector(".cue-edit");
  if (!wrap) return;
  const existing = wrap.querySelector(".cue-replace");
  if (!(cueEdit.term && cueEdit.termCount >= 2)) {
    existing?.remove();
    return;
  }
  if (existing) {
    existing.querySelector(".cue-replace-label").textContent = `「${cueEdit.term}」· 共 ${cueEdit.termCount} 处`;
    existing.querySelector(".cue-replace-btn").disabled = !String(cueEdit.replaceTo || "").trim();
    return;
  }
  wrap.append(buildReplaceBar());
}

function restoreCueEditCaret(ta) {
  if (!ta || !cueEdit) return;
  autoGrowCueEdit(ta);
  ta.focus();
  const start = cueEdit.selStart;
  const end = cueEdit.selEnd;
  if (Number.isInteger(start) && Number.isInteger(end)) {
    ta.setSelectionRange(start, end);
  } else {
    const n = ta.value.length;
    ta.setSelectionRange(n, n);
  }
}

function buildCueEditor() {
  const wrap = document.createElement("div");
  wrap.className = "cue-edit";
  wrap.addEventListener("mousedown", stopCueEditBubble);
  wrap.addEventListener("click", stopCueEditBubble);
  wrap.addEventListener("dblclick", stopCueEditBubble);
  wrap.addEventListener("pointerdown", stopCueEditBubble);
  const token = cueEdit.token;
  wrap.addEventListener("focusout", (event) => {
    if (wrap.contains(event.relatedTarget)) return;
    const saved = token;
    setTimeout(() => {
      if (!cueEdit || cueEdit.token !== saved) return;
      if (wrap.isConnected && wrap.contains(document.activeElement)) return;
      commitCueEdit();
    }, 0);
  });
  const ta = document.createElement("textarea");
  ta.className = "cue-edit-text";
  ta.rows = 1;
  ta.value = cueEdit.draft;
  ta.addEventListener("input", onCueEditInput);
  ta.addEventListener("select", onCueEditSelect);
  ta.addEventListener("keyup", onCueEditSelect);
  ta.addEventListener("mouseup", onCueEditSelect);
  ta.addEventListener("keydown", onCueEditKey);
  wrap.append(ta);
  if (cueEdit.term && cueEdit.termCount >= 2) wrap.append(buildReplaceBar());
  return wrap;
}

function mountCueEditorOnRow(index) {
  const row = cueRowEls[index];
  if (!row || !cueEdit) return;
  row.classList.add("editing");
  const time = row.querySelector("time");
  const editor = buildCueEditor();
  while (row.lastChild && row.lastChild !== time) row.removeChild(row.lastChild);
  row.append(editor);
  const ta = editor.querySelector("textarea");
  requestAnimationFrame(() => restoreCueEditCaret(ta));
}

function startCueEdit(index) {
  if (generating || translating) return;
  if (cueEdit) {
    if (cueEdit.index === index) return;
    commitCueEdit();
  }
  let cues = state?.cues;
  if (!cues?.length) return;
  let cue = cues[index];
  if (!cue) return;
  closeSelectionForCueEdit();
  if (captionLang === "en") {
    const recovered = originalForCue(cue);
    if (recovered && !String(cue.original || "").trim()) {
      cue = { ...cue, original: recovered };
      cues = cues.map((item, i) => (i === index ? cue : item));
      state = { ...state, cues };
    }
  }
  const field = cueEditFieldFor(cue);
  const before = String(cue[field] || "").trim() || cueDisplayText(cue);
  cueEdit = {
    index,
    draft: before,
    field,
    before,
    term: "",
    termCount: 0,
    replaceTo: "",
    token: ++cueEditToken
  };
  if (cueRowEls[index] && cueRowEls.length === cues.length) {
    mountCueEditorOnRow(index);
    return;
  }
  lastCuesSig = cuesSignature(cues);
  lastActiveIndex = -1;
  buildCueRows(cues);
  // 行是新建的：补画当前播放句的高亮和选区（编辑中不会滚动列表）
  highlight(state.currentTime || 0);
  paintVisibleCues();
}

function buildCueRows(cues) {
  if (cueEdit && (cueEdit.index < 0 || cueEdit.index >= cues.length)) cueEdit = null;
  const frag = document.createDocumentFragment();
  cueRowEls = new Array(cues.length);
  for (let i = 0; i < cues.length; i += 1) {
    const row = document.createElement("div");
    const editing = Boolean(cueEdit && cueEdit.index === i);
    row.className = editing ? "cue editing" : "cue";
    row.dataset.index = String(i);
    const time = document.createElement("time");
    time.textContent = formatClock(cues[i].from);
    if (editing) {
      row.append(time, buildCueEditor());
    } else {
      const text = document.createElement("div");
      text.className = "cue-text";
      text.textContent = cueDisplayText(cues[i]);
      row.append(time, text);
    }
    cueRowEls[i] = row;
    frag.append(row);
  }
  ui.cueList.replaceChildren(frag);
  if (cueEdit) {
    const ta = cueRowEls[cueEdit.index]?.querySelector(".cue-edit-text");
    requestAnimationFrame(() => restoreCueEditCaret(ta));
  }
}

function patchCueTexts(cues) {
  if (!cues?.length) return;
  if (cueRowEls.length !== cues.length) {
    lastCuesSig = cuesSignature(cues);
    lastActiveIndex = -1;
    buildCueRows(cues);
    return;
  }
  for (let i = 0; i < cues.length; i += 1) {
    if (cueEdit && i === cueEdit.index) continue;
    const text = cueRowEls[i]?.querySelector(".cue-text");
    const shown = cueDisplayText(cues[i]);
    if (text && text.textContent !== shown) text.textContent = shown;
  }
}

function renderCues() {
  const cues = state?.cues || [];
  if (!cues.length) {
    cueEdit = null;
    lastCuesSig = "";
    cueRowEls = [];
    ui.cueList.replaceChildren();
    return;
  }
  const sig = cuesSignature(cues);
  const changed = sig !== lastCuesSig;
  const keepEdit = Boolean(cueEdit)
    && cueRowEls.length === cues.length
    && cueEdit.index >= 0
    && cueEdit.index < cues.length
    && cueRowEls[cueEdit.index]?.classList.contains("editing");
  if (changed && !keepEdit) {
    lastCuesSig = sig;
    lastActiveIndex = -1;
    buildCueRows(cues);
  } else {
    if (changed) lastCuesSig = sig;
    patchCueTexts(cues);
  }
  highlight(state.currentTime || 0, { forceScroll: changed && !keepEdit });
  paintSelection();
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function stepCueScroll(now) {
  cueScrollRaf = 0;
  const anim = cueScrollAnim;
  if (!anim || selecting || selectHeld) return;
  const t = Math.min(1, (now - anim.start) / anim.dur);
  ui.cueList.scrollTop = anim.from + (anim.to - anim.from) * easeInOutCubic(t);
  if (t >= 1) {
    cueScrollAnim = null;
    return;
  }
  cueScrollRaf = requestAnimationFrame(stepCueScroll);
}

// 按行滚动：只有高亮句切换时才平滑滑动一次，滑到位就停（歌词/字幕通用做法）
function scrollActiveCueIntoView(index, { immediate = false } = {}) {
  if (selecting || selectHeld || hasSummary || cueEdit) return;
  if (index < 0 || index >= (state?.cues?.length || 0)) return;
  const target = cueTargetTop(index);

  if (immediate) {
    cueScrollAnim = null;
    if (cueScrollRaf) cancelAnimationFrame(cueScrollRaf);
    cueScrollRaf = 0;
    ui.cueList.scrollTop = target;
    return;
  }

  if (Date.now() - userCueScrollAt < 2500) return;
  if (Math.abs(target - ui.cueList.scrollTop) < 2) return;

  const distance = Math.abs(target - ui.cueList.scrollTop);
  cueScrollAnim = {
    from: ui.cueList.scrollTop,
    to: target,
    start: performance.now(),
    dur: Math.min(620, Math.max(260, distance * 1.4))
  };
  if (!cueScrollRaf) cueScrollRaf = requestAnimationFrame(stepCueScroll);
}

function highlight(currentTime, { forceScroll = false } = {}) {
  renderOutlineActive(currentTime, { forceScroll });
  const cues = state?.cues || [];
  if (!cues.length || ui.cueWrap?.classList.contains("hidden")) return;
  let index = cues.findIndex((cue) => currentTime >= cue.from && currentTime < cue.to);
  if (index < 0) index = cues.findLastIndex((cue) => currentTime >= cue.from);
  if (index < 0) return;

  const changed = index !== lastActiveIndex;
  if (changed) lastActiveIndex = index;
  if (changed) paintVisibleCues();
  if (changed || forceScroll) scrollActiveCueIntoView(index, { immediate: forceScroll });
}

const markUserCueScroll = () => {
  userCueScrollAt = Date.now();
  cueScrollAnim = null;
  if (cueScrollRaf) {
    cancelAnimationFrame(cueScrollRaf);
    cueScrollRaf = 0;
  }
};
