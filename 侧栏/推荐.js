// 侧栏 · 推荐：字幕就绪后独立评估，独立缓存；不创建、不读取大纲。

// 价值标签两档的图标（设计稿 verdictIcon），推荐强弱由分数表达。
const RECOMMENDATION_ICONS = {
  yes: "M3.5 8.5l3 3 6-7",
  no: "M4 4l8 8M12 4l-8 8"
};

/** 价值标签要显示的内容；流式生成期间、没有判断结果（含旧缓存）时返回 null */
function recommendationView(value, { streaming = false } = {}) {
  if (streaming || !value) return null;
  const checked = outlineApi()?.normalizeOutlineValue(value);
  if (!checked) return null;
  const level = checked.level;
  const icon = RECOMMENDATION_ICONS[level];
  const label = outlineApi()?.VALUE_LABELS?.[level] || "";
  return { ...checked, label, icon };
}

let stopRecommendationOrb = null;
let recommendationOrbIdleTimer = 0;

/** 评估中：点阵球（CSS 染成金色）+ 扫光文字（CSS 按 data-state 驱动）。已在转的点阵球不重启。 */
function showRecommendationThinking(on) {
  clearTimeout(recommendationOrbIdleTimer);
  show(ui.videoVerdictOrb, on);
  if (on) {
    if (!stopRecommendationOrb && ui.videoVerdictOrb) {
      stopRecommendationOrb = startOrb(ui.videoVerdictOrb, { state: "composing", size: 13, speed: 0.9, iconOnly: true, label: "" });
    }
    return;
  }
  stopRecommendationOrb?.();
  stopRecommendationOrb = null;
  ui.videoVerdictOrb?.replaceChildren();
}

/** 徽标暂时不显示（换标签页、等字幕稳定）时，点阵球稍后再停：很快又回到评估中就接着转，不从头播放 */
function pauseRecommendationThinking() {
  clearTimeout(recommendationOrbIdleTimer);
  if (!stopRecommendationOrb) return;
  recommendationOrbIdleTimer = setTimeout(() => showRecommendationThinking(false), 1500);
}

function renderRecommendation() {
  if (!ui.videoVerdict) return;
  const job = recommendationJob;
  // checking：新任务先查缓存，这几毫秒不显示，命中就直接出分数，不闪「评估中」
  const visible = recommendationReady(state) && Boolean(job) && !job.checking;
  show(ui.videoVerdict, visible);
  if (!visible) { pauseRecommendationThinking(); closeRecommendationDetails(); return; }
  const v = recommendationView(job.value);
  const phase = v ? "ready" : job.loading ? "loading" : "error";
  ui.videoVerdict.setAttribute("data-state", phase);
  ui.videoVerdict.setAttribute("data-level", v?.level || "");
  show(ui.videoVerdictResult, Boolean(v));
  show(ui.videoVerdictStatus, !v);
  if (ui.videoVerdictStatus) ui.videoVerdictStatus.textContent = job.loading ? "评估中…" : "评估失败 · 重试";
  showRecommendationThinking(phase === "loading");
  if (ui.videoVerdictTrigger) {
    ui.videoVerdictTrigger.title = job.error || (v ? "查看推荐依据" : "正在独立评估视频");
    ui.videoVerdictTrigger.setAttribute("aria-busy", job.loading ? "true" : "false");
    ui.videoVerdictTrigger.setAttribute("aria-label", v ? `推荐指数 ${v.score.toFixed(1)} / 10，查看评分依据` : job.loading ? "评估中" : "评估失败，点击重试");
  }
  if (!v) { closeRecommendationDetails(); return; }
  ui.videoVerdictIcon?.setAttribute("d", v.icon);
  if (ui.videoVerdictLabel) ui.videoVerdictLabel.textContent = v.label;
  if (ui.videoVerdictScore) ui.videoVerdictScore.textContent = v.score.toFixed(1);
}

let verdictPinned = false;
let verdictCloseTimer = 0;

function closeRecommendationDetails() {
  clearTimeout(verdictCloseTimer);
  verdictPinned = false;
  show(ui.videoVerdictPopover, false);
  ui.videoVerdictTrigger?.setAttribute("aria-expanded", "false");
}

function leaveRecommendationDetails() {
  clearTimeout(verdictCloseTimer);
  if (!verdictPinned) verdictCloseTimer = setTimeout(closeRecommendationDetails, 180);
}

function positionRecommendationDetails() {
  const pop = ui.videoVerdictPopover;
  const trigger = ui.videoVerdictTrigger;
  if (!pop || !trigger || pop.classList.contains("hidden")) return;
  const rect = trigger.getBoundingClientRect();
  const w = window.innerWidth;
  const h = window.innerHeight;
  const below = h - rect.bottom - 18;
  const above = rect.top - 18;
  const cap = Math.min(480, h * 0.72);
  const downward = below >= Math.min(pop.scrollHeight, cap) || below >= above;
  pop.style.maxHeight = `${Math.max(60, Math.min(cap, downward ? below : above))}px`;
  pop.style.left = `${Math.max(12, Math.min(rect.left - 8, w - pop.offsetWidth - 12))}px`;
  pop.style.top = `${Math.max(12, downward ? rect.bottom + 6 : rect.top - pop.offsetHeight - 6)}px`;
}

function openRecommendationDetails({ pin = false } = {}) {
  clearTimeout(verdictCloseTimer);
  const v = recommendationView(recommendationJob?.value, { streaming: recommendationJob?.loading });
  if (!v || !recommendationReady(state) || !ui.videoVerdictPopover || !ui.videoVerdictDimensions) return;
  if (pin && verdictPinned) { closeRecommendationDetails(); return; }
  if (pin) verdictPinned = true;
  const make = (name, text) => {
    const node = document.createElement("span");
    node.className = name;
    if (text != null) node.textContent = text;
    return node;
  };
  const tone = (n) => n >= 7 ? "good" : n >= 5 ? "mid" : "bad";
  const dims = [["sufficiency", "充分性"], ["logic", "逻辑性"], ["density", "干货度"], ["clickbait", "标题党"]].map(([key, name]) => ({
    ...v.review[key], name, hint: key === "clickbait" ? "越低越好" : "越高越好",
    score: v.review[key].score.toFixed(1), tone: tone(key === "clickbait" ? 10 - v.review[key].score : v.review[key].score)
  }));
  const evidenceButton = (e) => {
    const time = Number(state?.cues?.[e.from - 1]?.from);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "video-verdict-evidence";
    if (Number.isFinite(time)) {
      button.title = `跳到 ${formatClock(time)}：${e.reason}`;
      button.addEventListener("click", () => { sendToTab({ type: "SEEK", time }).catch((error) => flash(error.message || "跳转失败")); });
      button.append(make("video-verdict-evidence-time", formatClock(time)));
    } else {
      button.disabled = true;
    }
    button.append(make("video-verdict-evidence-reason", e.reason));
    return button;
  };
  const rows = dims.map((d) => {
    const row = make("video-verdict-dimension");
    const head = make("video-verdict-dimension-head");
    const score = make("video-verdict-dimension-score", d.score);
    score.setAttribute("data-tone", d.tone);
    head.append(make("video-verdict-dimension-name", d.name), make("video-verdict-hint", d.hint), score);
    row.append(head);
    if (d.reason) row.append(make("video-verdict-why", d.reason));
    const evidence = d.evidence;
    if (evidence.length) {
      const list = make("video-verdict-evidence-list");
      list.append(...evidence.map(evidenceButton));
      row.append(list);
    }
    return row;
  });
  ui.videoVerdictDimensions.replaceChildren(...rows);
  if (ui.videoVerdictNote) ui.videoVerdictNote.textContent = recommendationIsBili()
    ? "依据字幕，B 站互动与热评仅辅助；不含画面，未经外部事实核查。"
    : "依据字幕；不含画面，未经外部事实核查。";
  // 列表元素是复用的，替换内容不会重置滚动位置：从关闭状态打开时回到顶部；
  // 已打开（鼠标移出又移回）时保持用户当前的滚动位置。
  const wasHidden = ui.videoVerdictPopover.classList.contains("hidden");
  show(ui.videoVerdictPopover, true);
  if (wasHidden) ui.videoVerdictDimensions.scrollTop = 0;
  ui.videoVerdictTrigger?.setAttribute("aria-expanded", "true");
  positionRecommendationDetails();
}

// ---- 独立推荐的附加参考：B 站互动数据和热评（YouTube / X 只按字幕判断） ----

function recommendationIsBili(next = state) {
  const platform = next?.platform || "bilibili";
  return platform === "bilibili" && !/^(yt_|x_)/.test(String(next?.bvid || ""));
}

/** 标题（判断标题是否兑现）和 B 站数据比率；数据来自读字幕时后台 view 接口带回的 stat，不另发请求 */
function recommendationContext(next = state) {
  const title = [next?.title, next?.part].map((item) => String(item || "").trim()).filter(Boolean).join(" · ");
  const stats = recommendationIsBili(next) ? (outlineApi()?.formatStatLine?.(next?.stat) || "") : "";
  return { title, stats };
}

// 后台自己 5 秒超时；这里再兜一层，后台没回也不卡住评估。
const RECOMMENDATION_COMMENT_TIMEOUT_MS = 6000;

/** 评估视频时取一次热评；失败、超时或不是 B 站视频都回空数组 */
async function fetchRecommendationComments(next = state) {
  const aid = Number(next?.aid) || 0;
  if (!recommendationIsBili(next) || !aid) return [];
  let timer = 0;
  try {
    const res = await Promise.race([
      chrome.runtime.sendMessage({ type: "GET_HOT_COMMENTS", aid }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), RECOMMENDATION_COMMENT_TIMEOUT_MS);
      })
    ]);
    return Array.isArray(res?.comments) ? res.comments : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// 相同输入只自动尝试一次；失败由用户点击重试。
// 每个视频一个评估任务，按缓存键存在 recommendationJobs：侧栏切到别的标签页时不中止，
// 原视频的评估在后台跑完并写缓存；切回来接上同一个任务，胶囊不重新渲染、模型不重复调用。
// 只有同一标签页换了视频（cancelRecommendation）、字幕或标题变了、点「重新评估」时才中止旧任务。
const RECOMMENDATION_DELAY_MS = 800;
// 评分标准改变时更新指纹版本，避免继续展示旧标准下的高分。
const RECOMMENDATION_RULE_VERSION = 7;
// 内存里最多留这么多个视频的任务（含已完成的结果）。
// 同时调用模型的评估最多 RECOMMENDATION_RUNNING_MAX 个，多出来的排队，不中止已开始的；当前显示的视频优先。
const RECOMMENDATION_JOBS_MAX = 30;
const RECOMMENDATION_RUNNING_MAX = 3;
const recommendationJobs = new Map();
const recommendationQueue = [];
let recommendationRunning = 0;
let recommendationJob = null;

function recommendationReady(next) {
  return next?.page === "video" && Boolean(next?.bvid || next?.cid) && Boolean(next?.cues?.length)
    && Boolean(recommendationContext(next).title) && !next.partial && !generating && !translating
    && !["pending", "fetch_failed", "login"].includes(next.subtitleStatus) && !next.error;
}

function recommendationKey(next) {
  return `recommendation:v1:${next?.bvid || ""}:${next?.cid || ""}`;
}

function recommendationInput(next) {
  // 同一份字幕在翻译完成前后使用同一原文，避免 EN/中切换或译文刷新重复计费。
  const cues = next.cues.map((cue) => ({ from: cue.from, to: cue.to, content: String(cue.original || cue.content || "").trim() }));
  const context = recommendationContext(next);
  const source = JSON.stringify([RECOMMENDATION_RULE_VERSION, next.platform || "bilibili", context.title, cues]);
  // 两路 32 位摘要和原文长度共同标识输入；不把整份字幕重复写入评分缓存。
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let i = 0; i < source.length; i += 1) {
    a = Math.imul(a ^ source.charCodeAt(i), 0x01000193);
    b = Math.imul(b ^ source.charCodeAt(i), 0x85ebca6b);
  }
  const fingerprint = `${source.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`;
  const key = recommendationKey(next);
  return { key, fingerprint, identity: `${key}:${fingerprint}`, context, cues,
    video: { platform: next.platform, bvid: next.bvid, cid: next.cid, aid: next.aid } };
}

function recommendationAlive(job) {
  return Boolean(job) && recommendationJobs.get(job.input.key) === job && !job.controller.signal.aborted;
}

function abortRecommendationJob(job) {
  if (!job) return;
  clearTimeout(job.timer);
  job.controller.abort();
  if (recommendationJobs.get(job.input.key) === job) recommendationJobs.delete(job.input.key);
  if (recommendationJob === job) recommendationJob = null;
}

/** 只是不再显示当前任务（换到非视频页、等字幕稳定等），任务本身继续 */
function detachRecommendation() {
  recommendationJob = null;
  pauseRecommendationThinking();
  closeRecommendationDetails();
}

/** 同一标签页换了视频：中止它原来那个视频还在进行的评估 */
function cancelRecommendation() {
  const job = recommendationJob;
  if (job?.loading) abortRecommendationJob(job);
  detachRecommendation();
}

/** 排队：等前面的评估完成再开始，当前显示的视频插到最前 */
function enqueueRecommendation(job) {
  if (!recommendationAlive(job) || job.started || recommendationQueue.includes(job)) return;
  recommendationQueue.push(job);
  pumpRecommendationQueue();
}

function pumpRecommendationQueue() {
  while (recommendationRunning < RECOMMENDATION_RUNNING_MAX && recommendationQueue.length) {
    const shownAt = recommendationQueue.indexOf(recommendationJob);
    const [job] = recommendationQueue.splice(shownAt >= 0 ? shownAt : 0, 1);
    if (!recommendationAlive(job) || job.started) continue;
    recommendationRunning += 1;
    job.promise = runRecommendation(job).finally(() => {
      recommendationRunning -= 1;
      pumpRecommendationQueue();
    });
  }
}

/** 控制内存：已完成的旧结果超出上限就丢掉（进行中和排队中的不动） */
function trimRecommendationJobs() {
  for (const job of [...recommendationJobs.values()]) {
    if (recommendationJobs.size <= RECOMMENDATION_JOBS_MAX) break;
    if (!job.loading && job !== recommendationJob) recommendationJobs.delete(job.input.key);
  }
}

function renderRecommendationIfShown(job) {
  if (recommendationJob === job) renderRecommendation();
}

/** 评分缓存命中且指纹一致才返回结果 */
async function readRecommendationCache(input) {
  try {
    const data = await chrome.storage.local.get({ [input.key]: null });
    const record = data[input.key];
    if (record?.fingerprint !== input.fingerprint) return null;
    return outlineApi().normalizeOutlineValue(record.value, input.cues) || null;
  } catch {
    return null;
  }
}

function ensureRecommendation(next = state, { force = false } = {}) {
  if (!recommendationReady(next)) {
    detachRecommendation();
    renderRecommendation();
    return null;
  }
  const input = recommendationInput(next);
  let job = recommendationJobs.get(input.key);
  if (job && (force || job.input.identity !== input.identity)) {
    abortRecommendationJob(job);
    job = null;
  }
  if (!job) {
    trimRecommendationJobs();
    job = { input, controller: new AbortController(), loading: true, checking: !force, value: null, error: "", timer: 0, force, started: false };
    recommendationJobs.set(input.key, job);
    const created = job;
    if (force) {
      created.timer = setTimeout(() => enqueueRecommendation(created), 0);
    } else {
      readRecommendationCache(input).then((value) => {
        if (!recommendationAlive(created) || created.started) return;
        created.checking = false;
        if (value) {
          created.value = value;
          created.loading = false;
        } else {
          created.timer = setTimeout(() => enqueueRecommendation(created), RECOMMENDATION_DELAY_MS);
        }
        renderRecommendationIfShown(created);
      });
    }
  }
  recommendationJob = job;
  renderRecommendation();
  pumpRecommendationQueue();
  return job;
}

function retryRecommendation() {
  return ensureRecommendation(state, { force: true });
}

async function recommendationModel(prompt, job) {
  const text = await runModel(prompt, { signal: job.controller.signal, task: "recommendation" });
  if (!recommendationAlive(job)) throw new DOMException("评估已取消", "AbortError");
  return outlineApi().parseRecommendationPayload(text);
}

async function evaluateRecommendation(job) {
  const O = outlineApi();
  const { input } = job;
  const { cues, context } = input;
  const commentsTask = fetchRecommendationComments(input.video);
  let payload;
  if (O.cueCorpus(cues).length <= O.SUMMARY_CUE_CHAR_BUDGET) {
    const comments = await commentsTask;
    if (!recommendationAlive(job)) return null;
    payload = await recommendationModel(O.buildRecommendationPrompt(cues, { ...context, comments }), job);
  } else {
    const ranges = O.planOutlineChunks(cues);
    const observations = new Array(ranges.length);
    // 独立评估的长视频分段只收观察，不让模型顺带写章节。
    await runOutlineChunks(ranges, 2, async (range, i) => {
      if (!recommendationAlive(job)) return;
      const part = await recommendationModel(O.buildRecommendationChunkPrompt(cues, range, {
        part: i + 1, parts: ranges.length, title: context.title
      }), job);
      const notes = typeof part?.reviewNotes === "string" ? part.reviewNotes.trim() : "";
      if (!notes || notes.length > 2800) throw new Error(`第 ${i + 1} 段评估依据不完整，请重试`);
      observations[i] = { part: i + 1, from: range.from + 1, to: range.to + 1,
        seconds: Math.round(O.videoSpan(cues.slice(range.from, range.to + 1)).span), notes };
    });
    const comments = await commentsTask;
    if (!recommendationAlive(job)) return null;
    payload = await recommendationModel(O.buildRecommendationReducePrompt({ ...context, comments, observations }), job);
  }
  const value = O.resolveOutlineValue(payload, cues);
  if (!value) throw new Error(payload?.review === null
    ? "模型未提供足够的评分依据，请重试"
    : "评分字段不完整或字幕证据无效，请重试");
  return value;
}

async function runRecommendation(job) {
  // 切到别的标签页时任务不在显示，但仍跑完并写缓存；只有被中止（换视频、字幕变、重新评估）才停
  const active = () => recommendationAlive(job);
  job.started = true;
  job.checking = false;
  const work = async () => {
    if (!active()) return;
    if (!job.force) {
      const data = await chrome.storage.local.get({ [job.input.key]: null });
      if (!active()) return;
      const record = data[job.input.key];
      if (record?.fingerprint === job.input.fingerprint) {
        const value = outlineApi().normalizeOutlineValue(record.value, job.input.cues);
        if (value) { job.value = value; return; }
      }
    }
    const value = await evaluateRecommendation(job);
    if (!active() || !value) return;
    job.value = value;
    // 写完后再读回时会核对指纹；即使字幕随后变化，也不会误用本次评分。
    try {
      await chrome.storage.local.set({ [job.input.key]: {
        fingerprint: job.input.fingerprint, value, savedAt: Date.now()
      } });
    } catch {
      // 缓存写入失败仍可查看本次结果，不为此重复调用模型。
    }
  };
  try {
    // 侧栏和浮窗共享同源锁。排队者拿到锁后重读缓存，避免同一视频双重计费。
    if (globalThis.navigator?.locks?.request) {
      await navigator.locks.request(job.input.key, { signal: job.controller.signal }, work);
    } else await work();
  } catch (error) {
    if (!active()) return;
    job.error = error.message || "评估失败，请重试";
    // 只记录失败原因与视频标识，不写入字幕、热评或模型原始响应。
    try {
      await chrome.runtime.sendMessage({ type: "APPEND_LOG", level: "warn", scope: "recommendation",
        message: job.error, extra: { bvid: job.input.video.bvid, cid: job.input.video.cid, cues: job.input.cues.length } });
    } catch { /* 日志失败不影响重试入口 */ }
  } finally {
    if (active()) { job.loading = false; renderRecommendationIfShown(job); }
  }
}
