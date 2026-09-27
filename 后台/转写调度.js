// 后台 · 转写调度：一条音轨从边下边切、多通道并发转写到合并收尾。

// 字幕缓存里记下的模型名：通道没写模型时按 Groq 的默认模型记
const GROQ_MODEL = "whisper-large-v3-turbo";

function emitProgress(onProgress, extra) {
  if (!onProgress) return;
  if (typeof extra === "string") {
    onProgress({ message: extra });
    return;
  }
  onProgress(extra);
}

/** 单个转写请求：统一走 stt.js（Groq / OpenAI / Fish / ElevenLabs 同一套实现），这里只管超时、保活和日志 */
async function transcribeWithCfg(blob, cfg, options = {}) {
  if (!cfg) throw new Error("未配置转写服务");
  const Stt = self.BiliCaptionStt;
  if (!Stt?.transcribe) throw new Error("转写模块未加载");
  const label = asrChannelLabel(cfg);
  const started = Date.now();
  const stopHeartbeat = startWorkerHeartbeat();
  const timed = abortAfter(options.signal, asrRequestTimeoutMs(options.duration));
  const waitLog = setInterval(() => {
    appLog("info", "asr", `仍在等 ${label} 第 ${options.current || 1} 段，已 ${Math.round((Date.now() - started) / 1000)} 秒`, {
      ms: Date.now() - started,
      current: options.current,
      total: options.total
    });
  }, 30 * 1000);
  try {
    const result = await Stt.transcribe(blob, cfg, {
      language: options.language,
      signal: timed.signal,
      filename: options.filename,
      duration: options.duration
    });
    const count = Array.isArray(result?.segments) ? result.segments.length : 0;
    appLog("info", "asr", `第 ${options.current || 1}/${options.total || 1} 段 ${label} 完成，${count} 句，${Math.round((Date.now() - started) / 1000)} 秒`, {
      ms: Date.now() - started,
      current: options.current,
      total: options.total
    });
    return result;
  } catch (error) {
    if (error?.name === "AbortError" || timed.signal.aborted) {
      if (options.signal?.aborted) throw error;
      const timeout = new Error(`${label} 响应超时`);
      timeout.status = 504;
      timeout.retryable = true;
      appLog("error", "asr", `${label} ${Math.round((Date.now() - started) / 1000)} 秒没有返回，按超时重试`, {
        status: 504,
        current: options.current,
        total: options.total
      });
      throw timeout;
    }
    appLog("error", "asr", error?.network
      ? `${error.message}。扩展可能没走系统代理，或当前网络访问不了该服务`
      : `${label} HTTP ${error?.status || "?"}：${String(error?.message || error).slice(0, 220)}`, {
      status: Number(error?.status) || 0,
      current: options.current,
      total: options.total
    });
    throw error;
  } finally {
    clearInterval(waitLog);
    timed.cleanup();
    stopHeartbeat?.();
  }
}

async function persistAsrProgress({ bvid, cid, tabId, fingerprint, parts, total, language, onProgress, job }) {
  const ready = parts.filter(partIsComplete);
  const textParts = ready.filter((item) => item.cues?.length);
  // 总分片数大于 1 时，即使当前只有一个非静音分片，也必须加上
  // 该分片在整条音轨中的 start。否则“前一片静音/失败”时，后一片字幕
  // 会在任务进行期被错写到 00:00。
  let cues = total > 1 ? mergeChunkCues(textParts) : (textParts[0]?.cues || []);
  const pending = ready.length < total;
  await saveAsrJob(bvid, cid, {
    fingerprint,
    parts: ready,
    total,
    done: ready.length,
    pending
  });
  let stored = null;
  if (cues.length) {
    stored = await saveCachedAsr(bvid, cid, {
      cues,
      language: language || "",
      model: job?.lastSttModel || job?.sttCfg?.model || GROQ_MODEL,
      provider: job?.lastSttProvider || job?.sttCfg?.provider || "Groq",
      activeLan: "groq-asr",
      source: "groq",
      partial: pending
    });
    cues = stored.cues || cues;
  }
  if (tabId && cues.length) {
    chrome.tabs.sendMessage(tabId, {
      type: "APPLY_ASR_CUES",
      cues,
      activeLan: stored?.activeLan || "groq-asr",
      source: stored?.source || "groq",
      partial: pending,
      bvid,
      cid
    }).catch(() => {});
  }
  emitProgress(onProgress, {
    stage: "upload",
    message: pending
      ? `已完成 ${ready.length}/${total} 段，可先看前面的字幕`
      : `已完成 ${ready.length}/${total} 段`,
    done: ready.length,
    total: Math.max(Number(total) || 0, ready.length),
    current: pending ? ready.length + 1 : ready.length,
    cues,
    source: stored?.source || "groq",
    activeLan: stored?.activeLan || "groq-asr",
    partial: pending,
    failed: job?.failedChunks || [],
    paused: Boolean(job?.paused),
    waitUntil: 0
  });
  return cues;
}

// ---- 转写调度：分段来源 → 统一调度 → 统一收尾 ----
// 下载持续读取，切好的分段进队列（下载不等转写，服务器不会因为读停而断开）；
// 调度器按各通道空位最多 3 路并发消费。边下边切与整段下载走同一套调度和收尾。

// 同一段遇到超时、5xx、网络中断最多重试几次
const ASR_TRANSIENT_TRIES = 6;
// 同一段被限流退回的次数上限，防止「秒回 429」无限循环
const ASR_QUOTA_BOUNCES = 12;
// 所有通道同时冷却时，整个任务最多累计等这么久；再久就按部分完成收尾，稍后可继续
const ASR_WAIT_BUDGET_MS = 30 * 60 * 1000;
// 单次冷却最长记这么久（每日额度用完之类），更长的由上面的等待预算兜住
const ASR_MAX_COOL_MS = 6 * 60 * 60 * 1000;
// 只剩失败段时等用户点重试的时长；超时按部分完成结束，释放锁和音频内存
const ASR_FAILED_WAIT_MS = 10 * 60 * 1000;
// 暂停最长保留这么久；一直不点继续就按部分完成结束，进度留着下次接着转
const ASR_PAUSE_MAX_MS = 30 * 60 * 1000;

function asrAbortError() {
  const error = new Error("已取消生成");
  error.name = "AbortError";
  return error;
}

function asrChunkSeconds(chunk) {
  const dur = Number(chunk?.end) - Number(chunk?.start);
  return Number.isFinite(dur) && dur > 0 ? dur : 0;
}

/** 单个请求的超时：默认 3 分钟，ElevenLabs 这类大分片按时长放宽，最多 15 分钟 */
function asrRequestTimeoutMs(seconds) {
  const dur = Number(seconds) || 0;
  return Math.min(15 * 60 * 1000, Math.max(3 * 60 * 1000, dur * 500));
}

/** 分段总数：音轨切完才是准数；之前（或下载中途停了）按时长估算，至少比已切出的多一段 */
function asrRunTotal(run) {
  if (run.sourceComplete) return run.chunks.length;
  const known = run.chunks.length + (run.producerDone ? 1 : 0);
  return Math.max(known, run.estimated || 0, run.seededTotal || 0);
}

function asrChunkTries(run, index) {
  let tries = run.tries.get(index);
  if (!tries) {
    tries = { transient: 0, quota: 0, tried: new Set(), lastError: "" };
    run.tries.set(index, tries);
  }
  return tries;
}

/** 等调度事件（新分段、请求结束、暂停 / 重试）或超时；ms 为 0 时只等事件 */
function asrWaitEvent(run, ms = 0) {
  return new Promise((resolve, reject) => {
    let timer = 0;
    let onAbort = null;
    const finish = (error) => {
      clearTimeout(timer);
      run.signal?.removeEventListener?.("abort", onAbort);
      const at = run.waiters.indexOf(wake);
      if (at >= 0) run.waiters.splice(at, 1);
      if (error) reject(error);
      else resolve();
    };
    const wake = () => finish();
    onAbort = () => finish(asrAbortError());
    if (run.signal?.aborted) {
      onAbort();
      return;
    }
    run.waiters.push(wake);
    run.signal?.addEventListener?.("abort", onAbort, { once: true });
    if (ms > 0) timer = setTimeout(wake, ms);
  });
}

/** 队列里最早一段可以重发的剩余毫秒（退避中）；没有退避时为 0 */
function asrQueueWakeMs(run) {
  const now = Date.now();
  let soonest = 0;
  for (const index of run.queue) {
    const at = Number(run.notBefore.get(index)) || 0;
    if (at > now && (!soonest || at < soonest)) soonest = at;
  }
  return soonest ? Math.max(50, soonest - now) : 0;
}

function createAsrRun(job, { meta, stream, signal, language, duration, tabId, onProgress, saved, cachedCues, seeded, estimated }) {
  const run = {
    job,
    meta,
    stream,
    signal,
    language,
    duration,
    tabId,
    onProgress,
    saved,
    cachedCues,
    fingerprint: `v2:${Math.round(Number(duration) || 0)}`,
    chunks: [],
    parts: seeded.parts,
    seededTotal: seeded.total,
    estimated,
    queue: [],
    inflight: new Map(),
    notBefore: new Map(),
    tries: new Map(),
    waiters: [],
    producerDone: false,
    sourceComplete: false,
    producerError: null,
    fatal: null,
    stopReason: "",
    persistChain: Promise.resolve(),
    totalBytes: 0
  };
  run.wake = () => {
    for (const wake of run.waiters.slice()) wake();
  };
  return run;
}

/** 进度落盘按顺序排队，并发完成的几段不会互相覆盖 */
function queueAsrPersist(run) {
  run.persistChain = run.persistChain
    .then(() => persistAsrProgress({
      bvid: run.meta.bvid,
      cid: run.meta.cid,
      tabId: run.tabId,
      fingerprint: run.fingerprint,
      parts: run.parts,
      total: asrRunTotal(run),
      language: run.language,
      onProgress: run.onProgress,
      job: run.job
    }))
    .catch((error) => {
      appLog("warn", "asr", `保存转写进度失败：${error.message || error}`);
    });
  return run.persistChain;
}

function asrDownloadProgress(run, received) {
  const total = asrRunTotal(run);
  const done = run.parts.filter(partIsComplete).length;
  const pct = run.totalBytes ? Math.min(99, Math.round((received / run.totalBytes) * 100)) : 0;
  const got = pct ? `音频已下载 ${pct}%` : `音频已下载 ${mbOf(received)}MB`;
  const busy = run.inflight.size > 0 || done > 0;
  emitProgress(run.onProgress, {
    stage: busy ? "upload" : "download",
    message: busy ? `已转写 ${done}/${total} 段 · ${got}` : `${got} · 已切 ${run.chunks.length}/${total} 段`,
    total
  });
}

/** 新切出的分段：能对上旧进度的直接复用，其余进转写队列 */
function addAsrChunk(run, chunk) {
  const { job, parts } = run;
  const index = run.chunks.length;
  run.chunks.push(chunk);
  job.chunkPlan[index] = { start: chunk.start || 0, end: chunk.end || 0 };
  if (index === 0) {
    appLog("info", "asr", `已切出第 1 段 ${mbOf(chunk.blob?.size || 0)}MB（约 ${Math.round(asrChunkSeconds(chunk))} 秒），开始边下边转`, {
      estimated: run.estimated
    });
  }
  const reused = run.saved?.parts?.length || run.cachedCues?.length
    ? matchSavedParts(run.chunks, run.saved, run.cachedCues)[index]
    : null;
  if (partIsComplete(reused)) {
    parts[index] = reused;
    chunk.blob = null;
  } else {
    parts[index] = null;
    run.queue.push(index);
  }
  job.chunkTotal = asrRunTotal(run);
  run.wake();
}

/** 流式切出的分段仍超服务商上限时（时间轴不准等），再切开 */
async function fitAsrChunk(chunk, job, options) {
  if (chunkFitsLimits(chunk, job)) return [chunk];
  appLog("warn", "asr", `分段 ${chunkLimitLabel(chunk)} 超过上限，再切开后继续`);
  const pieces = await BiliCaptionMp4.splitAudio(chunk.blob, { ...options, firstSeconds: 0 }).catch(() => []);
  if (!pieces.length || (pieces.length === 1 && (pieces[0].blob?.size || 0) >= (chunk.blob?.size || 1))) {
    throw new Error(`切片后仍超过当前服务商限制（${chunkLimitLabel(chunk)}）`);
  }
  const base = Number(chunk.start) || 0;
  const out = pieces.map((piece, i) => ({
    ...piece,
    start: base + (Number(piece.start) || 0),
    end: base + (Number(piece.end) || 0),
    overlap: i === 0 ? Number(chunk.overlap) || 0 : piece.overlap,
    tail: i === pieces.length - 1 ? Number(chunk.tail) || 0 : piece.tail
  }));
  const oversized = out.find((piece) => !chunkFitsLimits(piece, job));
  if (oversized) throw new Error(`切片后仍超过当前服务商限制（${chunkLimitLabel(oversized)}）`);
  return out;
}

/** 非分片封装：整段在手里再切 */
async function* splitWholeAudio(blob, run, options) {
  const { job } = run;
  const limits = asrChunkLimits(job);
  const dur = Number(run.duration) || 0;
  const mustSplit = blob.size > limits.uploadBytes || dur > maxChunkSeconds(job);
  let chunks = [];
  if (!audioIsShort(dur, blob.size, job)) {
    emitProgress(run.onProgress, { message: `音频约 ${Math.round(dur) || "?"} 秒，按服务商上限切片…` });
    try {
      chunks = await BiliCaptionMp4.splitAudio(blob, options);
    } catch (error) {
      if (mustSplit) throw error;
    }
  }
  if (!chunks.length) {
    if (mustSplit || (!(dur > 0) && blob.size > limits.maxBytes)) {
      throw new Error("音频太长或无法按当前服务商限制切片");
    }
    const ext = self.BiliCaptionStt?.guessExt?.(blob.type) || "m4a";
    chunks = [{ blob, filename: `audio.${ext}`, start: 0, end: dur, overlap: 0, tail: 0 }];
  }
  const oversized = chunks.find((chunk) => !chunkFitsLimits(chunk, job));
  if (oversized) throw new Error(`切片后仍超过当前服务商限制（${chunkLimitLabel(oversized)}）`);
  appLog("info", "asr", `音频 ${mbOf(blob.size)}MB / ${Math.round(dur)} 秒，切成 ${chunks.length} 段`, {
    mb: mbOf(blob.size),
    chunks: chunks.length
  });
  yield* chunks;
}

/** 分段来源：边下边切；非分片封装或流式解析失败时整段下载再切。只产出分段，不等转写 */
async function* asrChunkSource(run) {
  const { job } = run;
  const signal = run.downloadSignal || run.signal;
  const limits = asrChunkLimits(job);
  const chunkOptions = {
    maxBytes: limits.maxBytes,
    maxSeconds: limits.maxSeconds,
    firstSeconds: asrFirstChunkSeconds(run.duration, job),
    overlapSeconds: ASR_OVERLAP_SECONDS
  };
  const downloadOptions = {
    refresh: run.refreshStream,
    onReconnect: (n) => emitProgress(run.onProgress, {
      message: `音频下载断开，正在续传（第 ${n} 次）…`,
      total: asrRunTotal(run)
    })
  };
  const opened = await openAudioDownload(run.stream, signal, downloadOptions);
  run.totalBytes = opened.total;
  let produced = 0;
  try {
    for await (const item of BiliCaptionMp4.iterateFmp4Chunks(opened.reader, {
      ...chunkOptions,
      signal,
      onBytes: (n) => asrDownloadProgress(run, n)
    })) {
      throwIfAborted(signal);
      if (item.fallback) {
        if (opened.total > 0 && item.blob.size < opened.total - 512 * 1024) {
          throw new Error(`音频下载不完整（${mbOf(item.blob.size)}MB/${mbOf(opened.total)}MB），请点「生成字幕」重试`);
        }
        appLog("info", "asr", "音频不是分片封装，改走整段切片");
        yield* splitWholeAudio(item.blob, run, chunkOptions);
        return;
      }
      for (const piece of await fitAsrChunk(item, job, chunkOptions)) {
        produced += 1;
        yield piece;
      }
    }
  } catch (error) {
    if (error?.name === "AbortError" || signal?.aborted) throw error;
    if (!produced && /DataView|Offset is outside|RangeError|Invalid typed array/i.test(`${error?.name} ${error?.message}`)) {
      appLog("warn", "asr", `边下边切失败，改走整段下载：${error.message || error}`);
      await opened.reader.cancel?.();
      const blob = await downloadAudio(run.stream, (message) => {
        emitProgress(run.onProgress, { stage: "download", message });
      }, signal, downloadOptions);
      yield* splitWholeAudio(blob, run, chunkOptions);
      return;
    }
    throw error;
  } finally {
    await opened.reader.cancel?.().catch?.(() => {});
  }
}

async function runAsrProducer(run) {
  try {
    for await (const chunk of asrChunkSource(run)) addAsrChunk(run, chunk);
    run.sourceComplete = true;
  } catch (error) {
    if (error?.name !== "AbortError" && !run.downloadSignal?.aborted) {
      run.producerError = error;
      appLog("warn", "asr", `音频下载或切片中断：${error.message || error}`, { chunks: run.chunks.length });
    }
  } finally {
    run.producerDone = true;
    const { job } = run;
    if (run.sourceComplete) {
      // 实际分段数以切出来的为准，去掉按时长估算的多余占位
      run.parts.length = run.chunks.length;
      job.chunkPlan.length = run.chunks.length;
      const lastEnd = Number(run.chunks[run.chunks.length - 1]?.end) || 0;
      if (Number(run.duration) > 0 && lastEnd > 0 && lastEnd < Number(run.duration) - 90) {
        appLog("warn", "asr", `音轨只切到 ${Math.round(lastEnd)}s / ${Math.round(Number(run.duration))}s`);
      }
    }
    job.chunkTotal = asrRunTotal(run);
    run.wake();
  }
}

function markAsrChunkFailed(run, index, reason) {
  const { job } = run;
  const chunk = run.chunks[index] || {};
  run.parts[index] = {
    i: index,
    start: chunk.start || 0,
    end: chunk.end || 0,
    overlap: chunk.overlap || 0,
    failed: true
  };
  job.failedChunks = job.failedChunks || [];
  if (!job.failedChunks.includes(index + 1)) job.failedChunks.push(index + 1);
  appLog("warn", "asr", `第 ${index + 1} 段失败：${reason}`, { bvid: run.meta.bvid, cid: run.meta.cid, chunk: index + 1 });
  emitProgress(run.onProgress, {
    stage: "upload",
    message: `第 ${index + 1} 段失败，可稍后重试`,
    total: asrRunTotal(run),
    failed: job.failedChunks,
    urgent: true
  });
  queueAsrPersist(run);
}

/** 把用户点了重试的失败段放回队首 */
function takeAsrRetries(run) {
  const { job } = run;
  while (job.retryQueue?.length) {
    const index = job.retryQueue.shift();
    if (!run.chunks[index]?.blob || run.inflight.has(index) || run.queue.includes(index)) continue;
    run.tries.delete(index);
    run.notBefore.delete(index);
    run.queue.unshift(index);
  }
}

async function transcribeAsrChunk(run, index, { cfg, idx }) {
  const { job } = run;
  const chunk = run.chunks[index];
  const total = asrRunTotal(run);
  const seconds = asrChunkSeconds(chunk);
  const label = asrChannelLabel(cfg);
  const multi = (job.channels?.length || 0) > 1;
  emitProgress(run.onProgress, {
    stage: "upload",
    message: total > 1
      ? `正在转写第 ${index + 1}/${total} 段${multi ? ` · ${label}` : ""}`
      : `正在转写（${mbOf(chunk.blob.size)}MB）`,
    current: index + 1,
    total,
    waitUntil: 0
  });
  appLog("info", "asr", `上传第 ${index + 1}/${total} 段 ${mbOf(chunk.blob.size)}MB · ${label}${multi ? `（通道${idx + 1}）` : ""}`, {
    mb: mbOf(chunk.blob.size),
    current: index + 1,
    total
  });
  const result = await transcribeWithCfg(chunk.blob, cfg, {
    language: run.language,
    signal: run.requestSignal || run.signal,
    filename: chunk.filename,
    duration: seconds,
    current: index + 1,
    total
  });
  noteGroqAudio(cfg, seconds);
  noteGroqRateHeaders(job, idx, result?.rateLimit);
  const cues = resultToPartCues(result, chunk);
  run.parts[index] = {
    i: index,
    start: chunk.start || 0,
    end: chunk.end || 0,
    overlap: chunk.overlap || 0,
    tail: chunk.tail || 0,
    cues,
    complete: true,
    silent: cues.length === 0,
    trimmed: true
  };
  // 转完就释放这段音频；失败段保留，等重试
  chunk.blob = null;
  run.tries.delete(index);
  job.failedChunks = (job.failedChunks || []).filter((n) => n !== index + 1);
  job.lastSttModel = cfg.model || "";
  job.lastSttProvider = cfg.provider || "";
  queueAsrPersist(run);
}

/** 按错误类别处理失败的一次请求；这里绝不抛错，致命问题记到 run.fatal 由调度器抛出 */
function handleAsrChunkError(run, index, picked, error) {
  const { job } = run;
  const signal = run.requestSignal || run.signal;
  if (signal?.aborted || error?.name === "AbortError") return;
  const verdict = classifyAsrError(error, picked.cfg, { maxSeconds: maxChunkSeconds(job) });
  const label = asrChannelLabel(picked.cfg);
  const tries = asrChunkTries(run, index);
  tries.lastError = verdict.message || String(error?.message || error);
  if (verdict.kind === "job") {
    run.fatal = new Error(verdict.message);
    return;
  }
  if (verdict.kind === "dead") {
    job.lastChannelError = verdict.message;
    markChannelDead(job, picked.idx, verdict.message);
    run.queue.unshift(index);
    const next = asrAliveChannels(job);
    emitProgress(run.onProgress, {
      stage: "upload",
      message: next.length
        ? `${label} 不可用，已切到 ${asrChannelLabel(job.channels[next[0]])} 继续`
        : `${label} 不可用`,
      urgent: true
    });
    return;
  }
  if (verdict.kind === "quota") {
    tries.quota += 1;
    learnGroqQuota(picked.cfg, error);
    markChannelCool(job, picked.idx, verdict.waitMs);
    if (tries.quota > ASR_QUOTA_BOUNCES) {
      markAsrChunkFailed(run, index, `多次被限流：${verdict.message}`);
      return;
    }
    run.queue.unshift(index);
    const next = pickAsrChannel(job, { seconds: asrChunkSeconds(run.chunks[index]) });
    appLog("warn", "asr", `${label} 限流冷却 ${formatWait(verdict.waitMs)}${next ? `，第 ${index + 1} 段改由 ${asrChannelLabel(next.cfg)} 继续` : ""}`, {
      waitMs: verdict.waitMs,
      current: index + 1
    });
    if (next) {
      emitProgress(run.onProgress, {
        stage: "upload",
        message: `${label} 限流，已切到 ${asrChannelLabel(next.cfg)} 继续（冷却结束自动切回）`,
        waitUntil: 0
      });
    }
    return;
  }
  if (verdict.kind === "transient") {
    tries.transient += 1;
    if (tries.transient > ASR_TRANSIENT_TRIES) {
      markAsrChunkFailed(run, index, `${verdict.message}（已重试 ${ASR_TRANSIENT_TRIES} 次）`);
      return;
    }
    const backoff = Math.max(verdict.waitMs || 0, Math.min(60 * 1000, 8000 * 2 ** (tries.transient - 1)));
    run.notBefore.set(index, Date.now() + backoff);
    run.queue.unshift(index);
    appLog("warn", "asr", `第 ${index + 1} 段失败（${error?.status || "网络中断"}），${formatWait(backoff)} 后第 ${tries.transient} 次重试：${verdict.message}`, {
      status: Number(error?.status) || 0,
      waitMs: backoff,
      current: index + 1
    });
    emitProgress(run.onProgress, {
      stage: "upload",
      message: `${label} 繁忙（${error?.status || "临时故障"}），${formatWait(backoff)} 后重试第 ${index + 1} 段`
    });
    return;
  }
  // 音频被这条通道拒了：换一条没试过的通道再试，都不行调度器会记为失败段
  tries.tried.add(picked.idx);
  run.queue.unshift(index);
}

function launchAsrChunk(run, index, picked) {
  const { job } = run;
  job.channelBusy = job.channelBusy || [];
  job.channelBusy[picked.idx] = asrChannelBusy(job, picked.idx) + 1;
  job.activeChunks.add(index);
  job.activeChannel = picked.idx;
  // 先清掉这次请求的在途记录，再按错误把分段放回队列：两步在同一个回调里同步做完，
  // 调度器不会在中间醒来把同一段又派一次；清记录前还确认它仍是自己的，不会误删新请求的记录。
  const task = transcribeAsrChunk(run, index, picked)
    .then(() => null, (error) => error || new Error("转写失败"))
    .then((error) => {
      job.channelBusy[picked.idx] = Math.max(0, asrChannelBusy(job, picked.idx) - 1);
      if (run.inflight.get(index) === task) {
        run.inflight.delete(index);
        job.activeChunks.delete(index);
      }
      try {
        if (error) handleAsrChunkError(run, index, picked, error);
      } finally {
        run.wake();
      }
    });
  run.inflight.set(index, task);
}

/** 统一调度：按通道空位派发分段，处理暂停、重试、冷却等待和失败段收尾 */
async function driveAsrRun(run) {
  const { job, signal } = run;
  let failedSince = 0;
  let pausedSince = 0;
  for (;;) {
    throwIfAborted(signal);
    if (run.fatal) throw run.fatal;
    if (!job.paused) pausedSince = 0;
    takeAsrRetries(run);
    if (!run.queue.length) {
      if (run.producerDone && !run.inflight.size) {
        const failed = job.failedChunks || [];
        if (!failed.length) break;
        // 只剩失败段：等用户点重试；超时就按部分完成收尾，释放锁和内存
        failedSince ||= Date.now();
        const left = ASR_FAILED_WAIT_MS - (Date.now() - failedSince);
        if (left <= 0) {
          run.stopReason = `${failed.length} 段转写失败`;
          break;
        }
        emitProgress(run.onProgress, {
          stage: "upload",
          message: `${failed.length} 段失败，可点重试；${formatWait(left)} 内不处理就先按部分完成结束`,
          total: asrRunTotal(run),
          failed
        });
        await asrWaitEvent(run, Math.min(left, 5000));
        continue;
      }
      await asrWaitEvent(run, asrQueueWakeMs(run));
      continue;
    }
    failedSince = 0;
    if (job.paused) {
      // 暂停不能无限期：关了页面心跳仍让后台活着、音频分片一直占内存
      pausedSince ||= Date.now();
      const left = ASR_PAUSE_MAX_MS - (Date.now() - pausedSince);
      if (left <= 0) {
        run.stopReason = `暂停超过 ${Math.round(ASR_PAUSE_MAX_MS / 60000)} 分钟未继续`;
        break;
      }
      emitProgress(run.onProgress, {
        stage: "pause",
        paused: true,
        message: run.inflight.size ? "已暂停，进行中的分段转完就停" : "已暂停",
        total: asrRunTotal(run)
      });
      await asrWaitEvent(run, Math.min(left, 5000));
      continue;
    }
    if (run.inflight.size >= ASR_MAX_CONCURRENCY) {
      await asrWaitEvent(run);
      continue;
    }
    const now = Date.now();
    const pos = run.queue.findIndex((i) => (Number(run.notBefore.get(i)) || 0) <= now);
    if (pos < 0) {
      await asrWaitEvent(run, asrQueueWakeMs(run));
      continue;
    }
    const index = run.queue[pos];
    const tries = asrChunkTries(run, index);
    const picked = pickAsrChannel(job, { seconds: asrChunkSeconds(run.chunks[index]), skip: tries.tried });
    if (picked) {
      run.queue.splice(pos, 1);
      launchAsrChunk(run, index, picked);
      continue;
    }
    const alive = asrAliveChannels(job);
    if (!alive.length) {
      throw new Error(`所有转写通道都不可用：${job.lastChannelError || "请在设置里检查通道的 Key 与额度"}`);
    }
    if (tries.tried.size && alive.every((i) => tries.tried.has(i))) {
      // 所有还能用的通道都拒了这段音频
      run.queue.splice(pos, 1);
      markAsrChunkFailed(run, index, tries.lastError || "音频被拒");
      continue;
    }
    if (run.inflight.size) {
      // 有请求在途：等它结束腾出空位，或等最近的冷却结束
      await asrWaitEvent(run, asrChainRevivalMs(job));
      continue;
    }
    // 没有在途请求、能用的通道都在冷却：计入整个任务的等待预算
    const revive = asrChainRevivalMs(job) || 2000;
    const spent = Number(job.quotaWaitMs) || 0;
    if (spent + revive > ASR_WAIT_BUDGET_MS) {
      run.stopReason = `所有通道都在限流冷却（约 ${formatWait(revive)} 后恢复）`;
      break;
    }
    emitProgress(run.onProgress, {
      stage: "wait",
      waitKind: "quota",
      message: `所有通道都在冷却，${formatWait(revive)} 后继续`,
      waitUntil: Date.now() + revive,
      total: asrRunTotal(run)
    });
    const started = Date.now();
    await asrWaitEvent(run, revive);
    job.quotaWaitMs = spent + (Date.now() - started);
  }
}

/** 统一收尾：合并已完成的分段；有没转完的段按「部分完成」返回，进度留着下次继续 */
async function finishAsrRun(run) {
  await run.persistChain;
  const { parts, meta } = run;
  const total = run.chunks.length;
  const complete = parts.slice(0, total).filter(partIsComplete).length;
  const ready = parts.filter((part) => partIsComplete(part) && part.cues?.length);
  // 续跑时下载早断（只切出第一段），断点里已转好的其它段也在 ready 里：
  // 按整条音轨的分段数判断，多段一律按各自起点合并，不能只取第一段。
  const cues = ready.length > 1 || asrRunTotal(run) > 1 ? mergeChunkCues(ready) : (ready[0]?.cues || []);
  // 音轨没切完（下载中断或提前收尾）时，后面还有没切出来的部分
  const missing = Math.max(0, total - complete) + (run.sourceComplete ? 0 : 1);
  if (!missing) {
    await clearAsrJob(meta.bvid, meta.cid);
    if (!cues.length) throw new Error("没有识别出有效文本");
    return { cues, partial: false, done: complete, total };
  }
  const reason = run.stopReason || run.producerError?.message || `还有 ${missing} 段没有转写`;
  if (!cues.length) throw new Error(reason);
  return { cues, partial: true, reason, done: complete, total: asrRunTotal(run) };
}

/**
 * 转写整条音轨：分段来源（边下边切 / 整段兜底）→ 统一调度（多通道并发）→ 统一收尾。
 * 返回 { cues, partial, reason }；一段都没转出来时抛错。
 */
async function transcribeAudio(stream, { meta, language, signal, onProgress, duration, tabId, forceRestart, job }) {
  const estimated = estimatedChunkCount(duration, job);
  const saved = forceRestart ? null : await loadAsrJob(meta.bvid, meta.cid);
  const cachedAsr = forceRestart ? null : await loadCachedAsr(meta.bvid, meta.cid);
  const cachedCues = cachedAsr?.cues || [];
  const seeded = seedResumeParts(saved, cachedCues, duration, estimated);
  job.duration = Number(duration) || 0;
  job.partsRef = seeded.parts;
  job.chunkPlan = seeded.plan.slice();
  job.failedChunks = [];
  job.retryQueue = [];
  job.activeChunks = new Set();
  job.channelBusy = [];
  job.quotaWaitMs = 0;
  const run = createAsrRun(job, {
    meta, stream, signal, language, duration, tabId, onProgress, saved, cachedCues, seeded, estimated
  });
  run.refreshStream = async (old) => pickAudioStream(await fetchPlayurl(meta), { sameAs: old });
  job.wake = run.wake;
  job.chunkTotal = asrRunTotal(run);
  if (seeded.skipped) {
    appLog("info", "asr", `从断点继续，已有 ${seeded.skipped}/${seeded.total} 段`, { done: seeded.skipped, chunks: seeded.total });
  }
  emitProgress(onProgress, {
    stage: "download",
    message: seeded.skipped ? `从断点继续 ${seeded.skipped}/${seeded.total}，继续拉取音轨…` : "开始拉取音轨…",
    total: job.chunkTotal
  });

  // 下载与在途请求各用一个子信号：提前收尾时停掉下载、放弃在途请求，释放音频内存
  const download = new AbortController();
  const requests = new AbortController();
  const stopAll = () => {
    download.abort();
    requests.abort();
  };
  if (signal?.aborted) stopAll();
  else signal?.addEventListener?.("abort", stopAll, { once: true });
  run.downloadSignal = download.signal;
  run.requestSignal = requests.signal;
  const producer = runAsrProducer(run);
  let failed = false;
  try {
    await driveAsrRun(run);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    download.abort();
    if (failed) requests.abort();
    signal?.removeEventListener?.("abort", stopAll);
    await producer;
    await Promise.allSettled([...run.inflight.values()]);
    await run.persistChain;
    for (const chunk of run.chunks) chunk.blob = null;
    job.wake = null;
  }
  return finishAsrRun(run);
}
