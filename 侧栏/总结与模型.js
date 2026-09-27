// 侧栏 · 总结与模型：选区总结和它的编辑，以及总结、润色、大纲共用的大模型请求。

function selectedCues() {
  if (!state?.cues?.length || range.start < 0 || range.end < 0) return [];
  const from = Math.min(range.start, range.end);
  const to = Math.max(range.start, range.end);
  return state.cues.slice(from, to + 1);
}

function cueLines(list) {
  return list.map((cue) => String(cue?.content || "").trim()).join("\n");
}

function buildSummaryPrompt(from, to) {
  const all = state.cues;
  const selected = all.slice(from, to + 1);
  const pad = Math.min(50, Math.max(0, Math.round(Number(summaryPad) || 0)));
  const before = pad ? all.slice(Math.max(0, from - pad), from) : [];
  const after = pad ? all.slice(to + 1, to + 1 + pad) : [];
  const parts = [
    "请用中文总结【选区】这段视频字幕，保留关键术语。不要加粗、不要标题。",
    "默认写成一段连贯的话。只有选区里确实有多个互不从属的并列要点时，才用列表：每条一行，以 \"- \" 开头，有几条写几条。不要凑条数，不要把一段讲解拆成「背景 / 过程 / 结论」这种假要点。",
    "【上文】和【下文】只用来理解指代和背景，不要写进总结，也不要总结它们。"
  ];
  if (before.length) parts.push(`【上文】\n${cueLines(before)}`);
  parts.push(`【选区】\n${cueLines(selected)}`);
  if (after.length) parts.push(`【下文】\n${cueLines(after)}`);
  return parts.join("\n\n");
}

async function ensureApiOrigin(url) {
  try {
    await chrome.permissions.request({ origins: [`${new URL(url).origin}/*`] });
  } catch {
    // 已授权或用户拒绝时继续，后面的 fetch 会给出明确错误
  }
}

/**
 * 总结 / 大纲 / 润色共用的模型请求，统一走 lib/模型调用.js：
 * 一律流式（首字超时 + 空闲超时，长大纲不会被总时限中途掐断），正文已去掉 <think>。
 */
async function requestPromptModel(prompt, { base, key, model, provider, task, onDelta, signal, validate, system } = {}) {
  const result = await globalThis.BiliCaptionModelCall.chat({
    base,
    key,
    model,
    provider,
    task: task || "summary",
    prompt,
    system,
    signal,
    stream: true,
    onDelta,
    validate
  });
  if (result.truncated) flash("模型输出达到长度上限，结果被截断", 5000);
  return result.text;
}

async function openaiPrompt(prompt, { onDelta, signal, validate, system, task } = {}) {
  const settings = await BiliCaptionPrefs.loadSettings({
    sumProvider: "OpenAI",
    apiBase: "",
    apiKey: "",
    apiModel: ""
  });
  const cfg = globalThis.BiliCaptionProviders.resolveSum(settings);
  if (!cfg.key) return null;
  if (!cfg.base) throw new Error("请先在设置里填写接口地址");
  await ensureApiOrigin(cfg.base);
  return requestPromptModel(prompt, {
    base: cfg.base,
    key: cfg.key,
    model: cfg.model,
    provider: cfg.provider,
    task,
    onDelta,
    signal,
    validate,
    system
  });
}

async function runModel(prompt, options) {
  const remote = await openaiPrompt(prompt, options);
  if (remote) return remote;
  throw new Error("请先在设置里配置总结服务和 API Key");
}

async function summarizeSelection() {
  const cues = selectedCues();
  if (!cues.length) {
    ui.selectInfo.textContent = "先划选一段字幕";
    return;
  }
  const from = Math.min(range.start, range.end);
  const to = Math.max(range.start, range.end);
  const prompt = buildSummaryPrompt(from, to);
  const span = `${formatClock(state.cues[from].from)}–${formatClock(state.cues[to].from)}`;
  hasSummary = true;
  summaryMarkTime = Number(state.cues[from].from) || 0;
  updateSummaryMarkerBtn();
  cueScrollAnim = null;
  if (cueScrollRaf) cancelAnimationFrame(cueScrollRaf);
  cueScrollRaf = 0;
  show(ui.summaryBox, true);
  syncSelectChrome(true);
  ui.summaryTitle.textContent = "选区总结";
  ui.summaryMeta.textContent = span;
  setSummaryBody("");
  ui.summaryText.classList.remove("streaming");
  // 连点时先中止上一次请求，免得两路流交错写进同一个框。
  summaryAbort?.abort();
  const ac = new AbortController();
  summaryAbort = ac;
  const current = () => summaryAbort === ac && !ac.signal.aborted;
  try {
    showSummaryThinking(true);
    let started = false;
    const result = await runModel(prompt, {
      signal: ac.signal,
      task: "summary",
      onDelta(full) {
        if (!current()) return;
        if (!started) {
          started = true;
          ui.summaryText.classList.add("streaming");
        }
        setSummaryBody(full);
      }
    });
    if (!current()) return;
    ui.summaryText.classList.remove("streaming");
    showSummaryThinking(false);
    setSummaryBody(result);
    ui.summaryMeta.textContent = span;
    flash("总结完成");
  } catch (error) {
    if (!current() || error?.name === "AbortError") return;
    showSummaryThinking(false);
    ui.summaryText.classList.remove("streaming");
    ui.summaryText.textContent = error.message || String(error);
  } finally {
    if (summaryAbort === ac) summaryAbort = null;
  }
}

function closeSummary() {
  summaryAbort?.abort();
  summaryAbort = null;
  hasSummary = false;
  summaryMarkTime = NaN;
  showSummaryThinking(false);
  ui.summaryText?.classList.remove("streaming");
  endSummaryEdit(true);
  show(ui.summaryBox, false);
  paintSelection();
}

/** 双击总结正文进入编辑，失焦后保留文本（不重新请求） */
function startSummaryEdit() {
  const edit = $("summaryEdit");
  if (!edit || !hasSummary) return;
  if (!edit.classList.contains("hidden")) return;
  edit.value = ui.summaryText.innerText || ui.summaryText.textContent || "";
  show(ui.summaryText, false);
  show(edit, true);
  autoGrowSummaryEdit(edit);
  requestAnimationFrame(() => {
    edit.focus();
    const end = edit.value.length;
    edit.setSelectionRange(end, end);
  });
}

function endSummaryEdit(silent = false) {
  const edit = $("summaryEdit");
  if (!edit || edit.classList.contains("hidden")) return;
  const text = edit.value.trim();
  show(edit, false);
  show(ui.summaryText, true);
  if (!silent && text) setSummaryBody(text);
}

function autoGrowSummaryEdit(edit) {
  edit.style.height = "auto";
  edit.style.height = `${edit.scrollHeight}px`;
}
