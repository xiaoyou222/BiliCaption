// 后台 · 转写通道：多通道调度用的通道状态（并发、冷却、停用），转写任务的进度广播与查询，
// 以及转写错误分类和 Groq 每小时音频额度前瞻。

// ---- 通道链：sttChannels 顺序即优先级。每条通道有并发上限，前面的占满、限流或失效时，
// 后面的通道同时分担，而不是等前一条彻底不可用才顶上 ----

// 整个任务同时在途的转写请求上限
const ASR_MAX_CONCURRENCY = 3;
// 下载进度这类高频广播的最小间隔（每秒最多约 4 次）
const ASR_BROADCAST_GAP_MS = 250;

function asrChannelLabel(cfg, fallback = "转写") {
  return self.BiliCaptionProviders?.channelLabel?.(cfg, fallback) || cfg?.provider || fallback;
}

function asrChannelState(job, idx) {
  if (!job) return "ok";
  if ((job.deadChannels || []).includes(idx)) return "dead";
  const until = Number(job.channelCools?.[idx]) || 0;
  return until > Date.now() ? "cool" : "ok";
}

/** 单条通道同时在途的请求数上限，各服务商默认值见 providers.sttLimits */
function asrChannelSlots(job, idx) {
  const limit = Number(self.BiliCaptionProviders?.sttLimits?.(job?.channels?.[idx])?.concurrency) || 2;
  return Math.max(1, Math.min(ASR_MAX_CONCURRENCY, limit));
}

function asrChannelBusy(job, idx) {
  return Number(job?.channelBusy?.[idx]) || 0;
}

/**
 * 按优先级找「未停用、未冷却、还有空位」的通道，高优先级冷却恢复后自动回归。
 * seconds 是这一段的音频时长，Groq 通道据此做每小时额度前瞻；
 * skip 是这一段已经试过、音频被拒的通道。
 */
function pickAsrChannel(job, { seconds = 0, skip = null } = {}) {
  const channels = job?.channels || [];
  for (let i = 0; i < channels.length; i += 1) {
    if (skip?.has?.(i)) continue;
    if (asrChannelState(job, i) !== "ok") continue;
    if (asrChannelBusy(job, i) >= asrChannelSlots(job, i)) continue;
    const quotaWait = groqQuotaWaitMs(channels[i], seconds);
    if (quotaWait > 0) {
      // 这个 Groq 账号剩下的每小时音频额度装不下这一段：先记冷却，让后面的通道接手
      markChannelCool(job, i, quotaWait);
      continue;
    }
    return { cfg: channels[i], idx: i };
  }
  return null;
}

function asrAliveChannels(job) {
  const dead = job?.deadChannels || [];
  return (job?.channels || []).map((_, i) => i).filter((i) => !dead.includes(i));
}

/** 全部通道不可用时：有冷却中的返回最近剩余毫秒，全 dead 返回 0 */
function asrChainRevivalMs(job) {
  const channels = job?.channels || [];
  const now = Date.now();
  let soonest = 0;
  for (let i = 0; i < channels.length; i += 1) {
    if ((job.deadChannels || []).includes(i)) continue;
    const until = Number(job.channelCools?.[i]) || 0;
    if (until > now && (!soonest || until < soonest)) soonest = until;
  }
  return soonest ? Math.max(2000, soonest - now) : 0;
}

function markChannelCool(job, idx, ms) {
  if (!job) return;
  job.channelCools = job.channelCools || [];
  const until = Date.now() + Math.max(2000, Number(ms) || 5000);
  // 已有更长的冷却就保留，免得一次短冷却把长冷却盖掉
  job.channelCools[idx] = Math.max(Number(job.channelCools[idx]) || 0, until);
}

function markChannelDead(job, idx, reason) {
  if (!job) return;
  job.deadChannels = job.deadChannels || [];
  if (!job.deadChannels.includes(idx)) job.deadChannels.push(idx);
  appLog("warn", "asr", `通道 ${idx + 1}（${asrChannelLabel(job.channels?.[idx], "?")}）已停用：${reason || "不可用"}`);
}

function partIsComplete(part) {
  return Boolean(
    part
    && !part.failed
    && (part.complete === true || (Array.isArray(part.cues) && part.cues.length > 0))
  );
}

function snapshotAsrChunks(job, parts, current) {
  const plan = job?.chunkPlan || [];
  const failed = job?.failedChunks || [];
  // 并发转写时可能有几段同时在跑；没有调度器信息的旧调用仍按 current 判断
  const active = typeof job?.activeChunks?.has === "function" ? job.activeChunks : null;
  const known = Number(job?.chunkTotal) || Number(job?.progress?.total) || 0;
  const total = Math.max(plan.length, (parts || []).length, known);
  // 流式转写时后面的分段还没切出来，用视频时长均分兜底，让列表能显示时间范围
  const slice = Number(job?.duration) > 0 && total > 0 ? Number(job.duration) / total : 0;
  const out = [];
  for (let i = 0; i < total; i += 1) {
    const part = parts?.[i];
    const item = plan[i] || {};
    const running = active ? active.has(i) : i + 1 === current;
    const status = part?.failed || failed.includes(i + 1)
      ? "fail"
      : partIsComplete(part)
        ? "done"
        : (running
          ? (job?.paused ? "pause" : "run")
          : "wait");
    const rawStart = part?.start ?? item.start;
    const rawEnd = Number(item.end) || 0;
    out.push({
      i: i + 1,
      start: rawStart != null && Number.isFinite(Number(rawStart)) ? Number(rawStart) : (slice ? slice * i : 0),
      end: rawEnd > 0 ? rawEnd : (slice ? slice * (i + 1) : 0),
      status
    });
  }
  return out;
}

function pauseAsrJob(query, paused) {
  const job = findAsrJob(query);
  if (!job) return { error: "没有进行中的转写" };
  job.paused = Boolean(paused);
  // 暂停只是不再派发新分段，已经在途的请求会先转完
  job.wake?.();
  jobBroadcast(job, {
    paused: job.paused,
    stage: job.paused ? "pause" : "upload",
    message: job.paused ? "已暂停" : "继续转写"
  });
  return { ok: true, paused: job.paused };
}

function retryAsrChunks(query, { index } = {}) {
  const job = findAsrJob(query);
  if (!job) return { error: "没有进行中的转写" };
  const parts = job.partsRef || [];
  const queue = job.retryQueue || [];
  const want = [Math.max(0, Number(index) - 1)].filter((i) => parts[i]?.failed);
  if (!want.length) return { error: "没有可重试的分片" };
  for (const i of want) {
    parts[i] = null;
    if (!queue.includes(i)) queue.push(i);
  }
  job.failedChunks = (job.failedChunks || []).filter((n) => !want.includes(n - 1));
  job.retryQueue = queue;
  job.paused = false;
  job.wake?.();
  jobBroadcast(job, {
    paused: false,
    failed: job.failedChunks,
    message: `已重新提交 ${want.length} 片`,
    urgent: true
  });
  return { ok: true, count: want.length };
}

function asrChannelFlags(job) {
  const idx = Number(job?.activeChannel) || 0;
  return {
    usingBackup: (job?.channels?.length || 0) > 1 && idx > 0,
    provider: asrChannelLabel(job?.channels?.[idx] || job?.sttCfg, "")
  };
}

/**
 * 广播转写进度。字幕只在有新结果或任务结束时才带（不再每条消息都带全部字幕）；
 * 下载进度这类高频消息最多每 250ms 发一次，最后一次一定会补发。
 * done / chunks 一律从 partsRef 现算，避免旧广播残留导致「头部 8/13、列表 0 完成」这种错位。
 */
function jobBroadcast(job, extra) {
  const prev = job.progress || {};
  const { job: _ignoreJob, cues: nextCues, chunks: _staleChunks, urgent, ...safe } = extra || {};
  const terminal = safe.stage === "done" || safe.stage === "error" || safe.stage === "canceled";
  // 任务结束后，迟到的在途请求不能再把侧栏拉回「转写中」
  if (job.finished && !terminal) return;
  const partsRef = Array.isArray(job.partsRef) ? job.partsRef : null;
  const doneLive = partsRef ? partsRef.filter(partIsComplete).length : null;
  const done = doneLive != null
    ? doneLive
    : (safe.done != null ? Number(safe.done) || 0 : Number(prev.done) || 0);
  const total = safe.total != null ? Number(safe.total) || 0 : Number(prev.total) || 0;
  const current = Number(safe.current) > 0
    ? Number(safe.current)
    : (Number(prev.current) || 0);
  const hasCues = Array.isArray(nextCues) && nextCues.length > 0;
  const freshCues = hasCues && nextCues !== prev.cues ? nextCues : null;
  job.progress = {
    ...prev,
    ...safe,
    done,
    total,
    current,
    cues: hasCues ? nextCues : prev.cues,
    paused: Boolean(job.paused),
    failed: job.failedChunks || safe.failed || prev.failed || [],
    ...asrChannelFlags(job),
    at: Date.now()
  };
  if (terminal) job.finished = true;
  const sendCues = terminal ? job.progress.cues : freshCues;
  const stageChanged = job.progress.stage !== job.lastBroadcastStage;
  const now = Date.now();
  const since = now - (Number(job.lastBroadcastAt) || 0);
  if (!terminal && !sendCues && !urgent && !stageChanged && since < ASR_BROADCAST_GAP_MS) {
    if (!job.broadcastTimer) {
      job.broadcastTimer = setTimeout(() => {
        job.broadcastTimer = 0;
        if (!job.finished) sendAsrProgress(job, null);
      }, Math.max(20, ASR_BROADCAST_GAP_MS - since));
    }
    return;
  }
  clearTimeout(job.broadcastTimer);
  job.broadcastTimer = 0;
  sendAsrProgress(job, sendCues);
}

function sendAsrProgress(job, cues) {
  const progress = job.progress || {};
  job.lastBroadcastAt = Date.now();
  job.lastBroadcastStage = progress.stage;
  const {
    parts: _parts,
    partsRef: _partsRef,
    chunkPlan: _chunkPlan,
    cues: allCues,
    ...rest
  } = progress;
  const partsRef = Array.isArray(job.partsRef) ? job.partsRef : null;
  broadcast({
    type: "ASR_PROGRESS",
    tabId: job?.tabId || 0,
    jobId: job?.jobId || "",
    bvid: job?.bvid || "",
    cid: job?.cid || 0,
    ...rest,
    chunks: partsRef ? snapshotAsrChunks(job, partsRef, rest.current) : [],
    ...(cues?.length ? { cues } : {}),
    cueCount: Array.isArray(allCues) ? allCues.length : 0
  });
}

function findAsrJob({ jobId, tabId, bvid, cid }) {
  if (jobId && asrJobs.has(jobId)) return asrJobs.get(jobId);
  for (const job of asrJobs.values()) {
    if (bvid && job.bvid && job.bvid !== bvid) continue;
    // 任务刚建、bvid 还没解析出来时，必须 cid 也一致才算同一个视频
    if (bvid && !job.bvid && !(cid && job.cid && Number(job.cid) === Number(cid))) continue;
    if (cid && job.cid && Number(job.cid) !== Number(cid)) continue;
    if (!bvid && tabId && job.tabId && Number(job.tabId) !== Number(tabId)) continue;
    if (bvid || jobId || tabId) return job;
  }
  return null;
}

async function getAsrJobStatus(query = {}) {
  // 后台刚被唤醒时先等「中断续跑」检查做完，免得侧栏把正要续跑的任务误判成已中断
  await asrResumeScan;
  const job = findAsrJob(query);
  if (!job) return { running: false };
  return {
    running: true,
    jobId: job.jobId,
    tabId: job.tabId || 0,
    bvid: job.bvid || "",
    cid: job.cid || 0,
    ...(job.progress || {}),
    ...asrChannelFlags(job),
    paused: Boolean(job.paused),
    failed: job.failedChunks || job.progress?.failed || [],
    done: Array.isArray(job.partsRef)
      ? job.partsRef.filter(partIsComplete).length
      : (Number(job.progress?.done) || 0),
    chunks: (Array.isArray(job.partsRef)
      ? snapshotAsrChunks(job, job.partsRef, job.progress?.current)
      : (job.progress?.chunks || []))
  };
}

function formatWait(ms) {
  const sec = Math.max(1, Math.ceil(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m} 分 ${s} 秒` : `${m} 分钟`;
}

/** 解析 Groq 限流文案里的 Limit / Used / Requested 和「try again in 1m24.5s」（毫秒） */
function parseGroqLimit(message) {
  const text = String(message || "");
  const wait = text.match(/try again in\s+((?:\d+(?:\.\d+)?(?:ms|h|m|s))+)/i);
  const waitMs = wait ? Number(self.BiliCaptionStt?.parseDurationMs?.(wait[1])) || 0 : 0;
  const num = (re) => Number(text.match(re)?.[1] || 0);
  return {
    waitMs: Number.isFinite(waitMs) ? waitMs : 0,
    limit: num(/\bLimit\s+(\d+)/i),
    used: num(/\bUsed\s+(\d+)/i),
    requested: num(/\bRequested\s+(\d+)/i),
    // 只认 Groq 的「seconds of audio per hour (ASH)」写法；旧的 /ASH/i 会误中 crash、flash
    hourly: /seconds of audio per hour|audio per hour/i.test(text) || /\((?:ASH|ASPH)\)|\bASP?H\b/.test(text),
    daily: /seconds of audio per day|audio per day/i.test(text) || /\(ASD\)|\bASD\b/.test(text)
  };
}

/** 额度或余额用完：等多久都不会恢复，本任务内停用该通道 */
function isAsrBillingError(error) {
  if (Number(error?.status) === 402) return true;
  const code = `${error?.code || ""} ${error?.type || ""}`;
  if (/insufficient_quota|billing_hard_limit|billing_not_active|quota_exceeded|payment_required/i.test(code)) return true;
  // 注意 Groq 的限流提示里也带 console.groq.com/settings/billing 链接，不能只看 billing 字样
  return /insufficient[_ ]quota|exceeded your current quota|billing hard limit|payment required|exceeds your quota|余额不足|欠费/i
    .test(String(error?.message || ""));
}

function isAsrRateLimit(error) {
  if (Number(error?.status) === 429 || error?.quota) return true;
  if (/rate_limit/i.test(String(error?.code || ""))) return true;
  const raw = String(error?.message || "");
  return /rate limit|too many requests|try again in \d|限流|额度|quota|seconds of audio per (?:hour|day)/i.test(raw)
    || /\((?:ASH|ASPH|ASD)\)|\bASP?H\b|\bASD\b/.test(raw);
}

function isAsrTransient(error) {
  const status = Number(error?.status) || 0;
  if ([408, 409, 425, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529].includes(status)) return true;
  if (error?.retryable || error?.network) return true;
  return /timeout|timed out|unavailable|bad gateway|overloaded|network|Failed to fetch|ECONNRESET|响应超时|连不上/i
    .test(String(error?.message || ""));
}

function isFatalSttError(error) {
  const status = Number(error?.status) || 0;
  if ([401, 403, 404, 405].includes(status)) return true;
  const raw = String(error?.message || error || "");
  return /未配置转写服务|转写模块未加载|未选择转写服务商|未接通的转写服务|未知服务商|不支持.*音频|无法直接转写|请填写.*(?:API\s*Key|AppID|SecretId|SecretKey)|先填写 API Key|签名.*失败|鉴权|未授权|未开通|invalid api key|incorrect api key|unauthorized|authentication|forbidden|model .*not found/i.test(raw);
}

/**
 * 转写错误分类，决定调度器怎么处理这一段：
 * - dead：Key 无效、额度或余额用完，本任务内停用该通道，这段交给其他通道；
 * - quota：限流，通道冷却（冷却期间其他通道接手），这段稍后重发；
 * - transient：超时、5xx、网络中断，这段退避后重试，有次数上限；
 * - media：服务端说不是有效媒体文件，属于本地切片问题，直接记为失败段、不再换通道；
 * - chunk：音频本身被拒（400/413 等），换一条没试过的通道，都不行就记为失败段；
 * - job：分片明显超长，整个任务停下以免浪费额度。
 */
function classifyAsrError(error, cfg, { maxSeconds = 0 } = {}) {
  const raw = String(error?.message || error || "");
  if (error?.name === "AbortError") return { kind: "abort", message: raw };
  const groq = cfg?.provider === "Groq" ? parseGroqLimit(raw) : null;
  const requested = Number(error?.requested) || (groq && (groq.hourly || groq.daily) ? groq.requested : 0);
  if (requested > 0 && maxSeconds > 0 && requested > maxSeconds + 20) {
    return {
      kind: "job",
      message: `这一段实际约 ${Math.round(requested / 60)} 分钟，超过分片上限，已停下以免浪费额度`
    };
  }
  if (isAsrBillingError(error)) return { kind: "dead", message: `额度或余额已用完：${raw}` };
  if (isFatalSttError(error)) return { kind: "dead", message: raw };
  if (isAsrRateLimit(error)) {
    // retryAfter 统一是毫秒（stt.js 已把 Retry-After 头换算好），不再猜是秒还是毫秒
    const retryAfter = Math.max(Number(error?.retryAfter) || 0, groq?.waitMs || 0);
    const fallback = groq?.daily ? 60 * 60 * 1000 : groq?.hourly ? 30 * 60 * 1000 : 60 * 1000;
    return {
      kind: "quota",
      waitMs: Math.min(ASR_MAX_COOL_MS, Math.max(2000, retryAfter || fallback)),
      hourly: Boolean(groq?.hourly),
      daily: Boolean(groq?.daily),
      message: raw
    };
  }
  if (isAsrTransient(error)) {
    return { kind: "transient", waitMs: Math.min(60 * 1000, Number(error?.retryAfter) || 0), message: raw };
  }
  if (isAsrMediaRejected(error)) {
    return { kind: "media", message: `服务端无法解码这段音频（${raw.slice(0, 120)}），是本地切片出了问题，换通道重试也没用` };
  }
  return { kind: "chunk", message: raw };
}

/**
 * 服务端说「不是有效媒体文件 / 无法解码」：同一个分片换哪条通道都一样，属于本地切片问题，
 * 不该在各通道之间来回重试、白耗额度。
 */
function isAsrMediaRejected(error) {
  const status = Number(error?.status) || 0;
  if (status && ![400, 415, 422].includes(status)) return false;
  return /could not process file|valid media file|not a valid (?:media|audio)|invalid (?:media|audio) file|unsupported (?:audio|media|file) (?:format|type)|failed to decode|(?:audio|media) file (?:is )?(?:corrupt|invalid)|无法解码|不是有效的?(?:媒体|音频)/i
    .test(String(error?.message || error || ""));
}

// ---- Groq 每小时音频额度前瞻 ----
// Groq 官方文档（console.groq.com/docs/rate-limits）：响应头只有 x-ratelimit-*-requests（每日请求数）
// 和 *-tokens（每分钟 token），没有「每小时音频秒数（ASH）」对应的头。所以 ASH 上限只能从 429 文案
// （Limit / Used / Requested）学到，再按本机已发送的音频秒数估算余量：装不下下一段就先交给其他通道。

const GROQ_ASH_WINDOW_MS = 60 * 60 * 1000;
const groqAudioLedgers = new Map();

function groqLedger(cfg) {
  if (cfg?.provider !== "Groq" || !cfg.key) return null;
  let ledger = groqAudioLedgers.get(cfg.key);
  if (!ledger) {
    ledger = { limit: 0, entries: [] };
    groqAudioLedgers.set(cfg.key, ledger);
  }
  return ledger;
}

function groqLedgerUsed(ledger, now = Date.now()) {
  ledger.entries = ledger.entries.filter((entry) => now - entry.at < GROQ_ASH_WINDOW_MS);
  return ledger.entries.reduce((sum, entry) => sum + entry.sec, 0);
}

function noteGroqAudio(cfg, seconds) {
  const ledger = groqLedger(cfg);
  if (!ledger) return;
  // Groq 不足 10 秒按 10 秒计费
  ledger.entries.push({ at: Date.now(), sec: Math.max(10, Number(seconds) || 0) });
}

/** 从 ASH 限流文案学到上限；别处用掉的额度按 Groq 给的等待时间到期 */
function learnGroqQuota(cfg, error) {
  const ledger = groqLedger(cfg);
  if (!ledger) return;
  const info = parseGroqLimit(error?.message);
  if (!info.hourly || !(info.limit > 0)) return;
  ledger.limit = info.limit;
  const now = Date.now();
  const mine = groqLedgerUsed(ledger, now);
  if (info.used > mine) {
    const wait = Math.min(GROQ_ASH_WINDOW_MS, info.waitMs || GROQ_ASH_WINDOW_MS);
    ledger.entries.push({ at: now + wait - GROQ_ASH_WINDOW_MS, sec: info.used - mine });
  }
}

/** 这条 Groq 通道还要等多久才装得下 seconds 秒音频；还不知道上限时返回 0 */
function groqQuotaWaitMs(cfg, seconds) {
  const ledger = groqLedger(cfg);
  if (!ledger?.limit || !(Number(seconds) > 0)) return 0;
  const now = Date.now();
  let used = groqLedgerUsed(ledger, now);
  const need = Math.max(10, Number(seconds));
  if (need > ledger.limit || used + need <= ledger.limit) return 0;
  for (const entry of [...ledger.entries].sort((a, b) => a.at - b.at)) {
    used -= entry.sec;
    if (used + need <= ledger.limit) return Math.max(1000, entry.at + GROQ_ASH_WINDOW_MS - now);
  }
  return 0;
}

/** 响应头显示今日请求次数用完：冷却到重置时间，其间交给其他通道 */
function noteGroqRateHeaders(job, idx, rateLimit) {
  if (!rateLimit || !Number.isFinite(Number(rateLimit.remainingRequests))) return;
  if (Number(rateLimit.remainingRequests) > 0) return;
  const wait = Number(rateLimit.resetRequestsMs) || 60 * 60 * 1000;
  markChannelCool(job, idx, wait);
  appLog("warn", "asr", `${asrChannelLabel(job?.channels?.[idx])} 今日请求次数已用完，${formatWait(wait)} 内交给其他通道`);
}
