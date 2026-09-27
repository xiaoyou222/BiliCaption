// 后台 · 转写任务：生成字幕任务的入口（GENERATE_ASR）、同视频加锁、取消，
// 以及 service worker 被回收后自动续跑被打断的转写。

async function resolveVideoMeta(input = {}) {
  if (/^yt_/.test(input.bvid || "")) throw new Error("该平台暂不支持无字幕音频转写");
  if (/^x_/.test(input.bvid || "")) {
    if (!/^x_\d+_[1-4]$/.test(input.bvid)) throw new Error("视频编号无效");
    return {
      aid: 0,
      cid: Number(input.cid) || 1,
      bvid: input.bvid,
      title: input.title || "",
      part: input.part || "",
      duration: Number(input.duration) || 0,
      tabId: Number(input.tabId) || 0
    };
  }
  let aid = Number(input.aid) || 0;
  let cid = Number(input.cid) || 0;
  let bvid = input.bvid || "";
  let title = input.title || "";
  let part = input.part || "";

  if (bvid && (!aid || !cid)) {
    const view = await fetchView(bvid);
    const p = Math.max(1, Number(input.p) || 1);
    const page = view.pages?.[p - 1];
    aid = aid || view.aid;
    title = title || view.title || "";
    bvid = view.bvid || bvid;
    if (!cid) {
      if (page?.cid) cid = page.cid;
      else if (view.pages?.length === 1) cid = view.pages[0].cid || view.cid;
    }
    if (page?.part && view.pages?.length > 1) part = part || page.part;
  }

  if ((!aid || !cid) && (input.epId || input.seasonId)) {
    const bangumi = await fetchBangumi(input);
    aid = bangumi.aid;
    cid = bangumi.cid;
    bvid = bangumi.bvid || bvid;
    title = title || bangumi.title || "";
    part = part || bangumi.part || "";
  }

  if (!aid || !cid) {
    throw new Error("无法解析当前分 P 的 aid/cid，请确认在对应一集/一 P 再生成");
  }

  return { aid, cid, bvid, title, part, duration: Number(input.duration) || 0 };
}

function cancelAsrJob(jobId, extra = {}) {
  const job = findAsrJob({ jobId, bvid: extra.bvid, cid: extra.cid, tabId: extra.tabId });
  if (!job) return false;
  // 取消由任务结束时的汇总日志记下（generateAsr），这里不再单独写一条
  job.controller.abort();
  return true;
}

/** 用时：6 分 12 秒、1 小时 3 分 */
function formatElapsed(ms) {
  const sec = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (sec < 60) return `${sec} 秒`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
  return s ? `${m} 分 ${s} 秒` : `${m} 分钟`;
}

/**
 * 转写任务结束时写一条汇总日志，代替原来逐段的「上传第 N 段」「第 N 段完成」「仍在等」和下载开始 / 完成。
 * outcome：done 完成（info）、partial 部分完成（warn）、error 失败（error）、canceled 取消（info）。
 * 限流冷却、通道停用、重连、地址刷新、失败段等异常仍在发生时单独记 warn / error。
 */
function logAsrSummary(job, outcome, info = {}) {
  const stats = job?.asrStats || {};
  const parts = Array.isArray(job?.partsRef) ? job.partsRef : [];
  const total = Number(info.total) || Number(job?.chunkTotal) || parts.length || 0;
  const done = info.done != null ? Number(info.done) || 0 : parts.filter(partIsComplete).length;
  const facts = [];
  if (total) facts.push(outcome === "done" ? `${total} 段` : `已完成 ${done}/${total} 段`);
  if (Number(info.cues) > 0) facts.push(`${info.cues} 句`);
  const elapsed = stats.startedAt ? Date.now() - stats.startedAt : 0;
  if (elapsed >= 1000) facts.push(`用时 ${formatElapsed(elapsed)}`);
  const channels = Object.entries(stats.byChannel || {}).filter(([, n]) => n > 0);
  if (channels.length) facts.push(channels.map(([label, n]) => `${label} ${n} 段`).join("、"));
  if (stats.reused) facts.push(`断点复用 ${stats.reused} 段`);
  if (stats.retries) facts.push(`重试 ${stats.retries} 次`);
  const failed = (job?.failedChunks || []).slice(0, 12);
  if (outcome !== "done" && failed.length) facts.push(`失败段 ${failed.join("、")}`);
  const dl = stats.download || {};
  if (Number(dl.bytes) > 0) {
    const notes = [];
    if (dl.resumes) notes.push(`续传 ${dl.resumes} 次`);
    if (dl.refreshes) notes.push(`刷新地址 ${dl.refreshes} 次`);
    if (stats.wholeFile) notes.push("整段切片");
    facts.push(`音频 ${mbOf(dl.bytes)}MB${notes.length ? `（${notes.join("、")}）` : ""}`);
  }
  if (Number(job?.resumes) > 0) facts.push(`后台重启后第 ${job.resumes} 次续跑`);
  const tail = facts.join("，");
  const reason = String(info.reason || "").trim();
  let level = "info";
  let message;
  if (outcome === "done") {
    message = `转写完成：${tail}`;
  } else if (outcome === "partial") {
    level = "warn";
    message = `转写部分完成：${reason || "有分段没转完"}${tail ? `；${tail}` : ""}`;
  } else if (outcome === "canceled") {
    message = `转写已取消${reason ? `（${reason}）` : ""}${tail ? `：${tail}` : ""}`;
  } else {
    level = "error";
    message = `转写失败：${reason || "未知错误"}${tail ? `；${tail}` : ""}`;
  }
  return appLog(level, "asr", message, {
    status: info.status,
    bvid: info.bvid || job?.bvid || "",
    cid: info.cid || job?.cid || 0,
    done: total ? done : undefined,
    total: total || undefined,
    cues: info.cues,
    ms: elapsed || undefined,
    mb: Number(dl.bytes) > 0 ? mbOf(dl.bytes) : undefined,
    host: dl.host || undefined
  });
}

async function generateAsr(input, sender) {
  const jobId = String(input.jobId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const controller = new AbortController();
  const job = {
    jobId,
    controller,
    tabId: Number(input.tabId || sender?.tab?.id) || 0,
    bvid: input.bvid || "",
    cid: Number(input.cid) || 0,
    resumes: Number(input.resumes) || 0
  };
  asrStatsOf(job);
  asrJobs.set(jobId, job);
  const { signal } = controller;

  try {
    // 开始不单独记日志：任务结束时有一条汇总（含是否为后台重启后的续跑）
    jobBroadcast(job, {
      stage: "start",
      message: input.resumes ? "后台重启后自动继续转写…" : "准备生成字幕…"
    });

    const storage = await BiliCaptionPrefs.loadSettings({
      groqApiKey: "",
      sttKey: "",
      sttProvider: "Groq",
      sttCreds: {},
      sttModel: "",
      backupProvider: "不启用",
      backupKey: "",
      asrLanguage: ""
    });
    throwIfAborted(signal);
    const P = self.BiliCaptionProviders;
    // 预过滤掉不可用通道（没填 Key 的付费通道），链里至少留一条可用的
    const channels = P.resolveChannels(storage).filter((cfg) => P.channelUsable(cfg));
    if (!channels.length) {
      throw new Error("请先在设置里添加并配置好转写通道（至少一条填好 Key）");
    }
    job.channels = channels;
    job.channelCools = [];
    job.deadChannels = [];
    job.channelBusy = [];
    job.activeChannel = 0;
    // 日志与缓存元信息用
    job.sttCfg = channels[0];

    const meta = await resolveVideoMeta({ ...input, tabId: job.tabId || input.tabId });
    throwIfAborted(signal);
    job.bvid = meta.bvid || job.bvid;
    job.cid = meta.cid || job.cid;
    const lockKey = asrLockKey(meta.bvid, meta.cid);
    const owner = await acquireAsrLock(lockKey, jobId, signal);
    if (owner) {
      // 同一视频已有任务在跑：加入等它的结果，不再另起一个
      job.joined = true;
      asrJobs.delete(jobId);
      return await owner.work;
    }
    try {
      const existingJob = await loadAsrJob(meta.bvid, meta.cid);
      const cachedAsr = await loadCachedAsr(meta.bvid, meta.cid);
      const lastCueTo = maxCueField(cachedAsr?.cues);
      const looksIncomplete = cachedAsr?.partial == null
        && lastCueTo > 20
        && Number(meta.duration) > 0
        && lastCueTo < Number(meta.duration) - 90;
      const resume = Boolean(
        (existingJob?.parts?.length && existingJob.pending !== false)
        || cachedAsr?.partial
        || looksIncomplete
      );
      const forceRestart = Boolean(input.force) && !resume;
      if (forceRestart) await clearAsrJob(meta.bvid, meta.cid);

      await markAsrRunning(job, input, meta);
      const work = runAsrJob(job, {
        meta,
        signal,
        asrLanguage: storage.asrLanguage,
        forceRestart
      });
      asrJobLocks.set(lockKey, { jobId, work });
      return await work;
    } finally {
      const cur = asrJobLocks.get(lockKey);
      if (cur?.jobId === jobId) asrJobLocks.delete(lockKey);
    }
  } catch (error) {
    if (signal.aborted || error?.name === "AbortError") {
      const canceled = new Error("已取消生成");
      canceled.canceled = true;
      if (!job.joined) {
        logAsrSummary(job, "canceled", { reason: job.cancelReason });
        jobBroadcast(job, {
          stage: "canceled",
          message: canceled.message,
          running: false,
          waitUntil: 0
        });
      }
      throw canceled;
    }
    if (!job.joined) {
      logAsrSummary(job, "error", { reason: error.message || String(error), status: Number(error?.status) || undefined });
      jobBroadcast(job, {
        stage: "error",
        message: error.message || String(error),
        running: false,
        partial: Boolean(job.progress?.cues?.length),
        cues: job.progress?.cues || [],
        waitUntil: 0
      });
    }
    throw error;
  } finally {
    asrJobs.delete(jobId);
    clearTimeout(job.broadcastTimer);
    // 任务正常结束、取消或出错都清掉「运行中」标记；只有后台被回收时它才会留下来，供续跑
    if (!job.joined && job.runKey) clearAsrRunning(job.runKey);
    // 续跑的任务在记下标记前就出错（设置里删了 Key、取不到视频信息等）：旧标记也要清，
    // 否则每次后台启动都会再续跑、再报错。同一视频另有任务在跑时标记归它，不动。
    if (!job.joined && !job.runKey && input.resumes && !findAsrJob({ bvid: input.bvid, cid: input.cid })) {
      clearAsrRunning(`${ASR_RUN_PREFIX}${asrLockKey(input.bvid, input.cid)}`);
    }
    const keys = new Set([
      asrLockKey(input.bvid, input.cid),
      asrLockKey(job.bvid, job.cid)
    ]);
    for (const key of keys) {
      const cur = asrJobLocks.get(key);
      if (cur?.jobId === jobId && !cur.work) asrJobLocks.delete(key);
    }
  }
}

/**
 * 视频标签页关掉时，取消这个标签页上暂停中的转写：没人会再点继续，别让心跳一直保活、音频分片占着内存。
 * 已完成的分段都已落盘，下次在该视频点「生成字幕」从断点接着转。运行中的任务不受影响。
 */
function cancelPausedAsrForTab(tabId) {
  for (const job of asrJobs.values()) {
    if (!job.paused || !job.tabId || Number(job.tabId) !== Number(tabId)) continue;
    // 原因并进取消时的汇总日志
    job.cancelReason = "视频页已关闭，暂停中的转写不再等待，进度已保存";
    job.controller?.abort();
  }
}

function asrLockKey(bvid, cid) {
  return `${bvid || "bv"}:${Number(cid) || 0}`;
}

/**
 * 同一视频只跑一个转写任务。锁被别的任务占着时返回 { jobId, work }（调用方加入等它的结果）；
 * 对方还在解析视频信息就等它挂上 work 或释放锁——绝不覆盖别人的锁。
 * 只有锁的主人已经不在（异常退出没清理）时才接手。拿到锁返回 null。
 */
async function acquireAsrLock(lockKey, jobId, signal) {
  for (;;) {
    throwIfAborted(signal);
    const live = asrJobLocks.get(lockKey);
    if (!live || live.jobId === jobId || !asrJobs.has(live.jobId)) {
      asrJobLocks.set(lockKey, { jobId });
      return null;
    }
    if (live.work) return { jobId: live.jobId, work: live.work };
    await sleep(40, signal);
  }
}

function startAsr(input, sender) {
  const existing = findAsrJob({
    bvid: input.bvid,
    cid: input.cid,
    tabId: input.tabId || sender?.tab?.id
  });
  if (existing) {
    return { started: true, joined: true, jobId: existing.jobId };
  }

  const lockKey = (input.bvid || input.cid) ? asrLockKey(input.bvid, input.cid) : "";
  if (lockKey && asrJobLocks.has(lockKey)) {
    const live = asrJobLocks.get(lockKey);
    return { started: true, joined: true, jobId: live?.jobId || "" };
  }

  const jobId = String(input.jobId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  if (lockKey) asrJobLocks.set(lockKey, { jobId });
  generateAsr({ ...input, jobId }, sender).catch(() => {
    // 结果通过 ASR_PROGRESS 广播，避免单个消息请求持续数小时
  });
  return { started: true, jobId };
}

async function runAsrJob(job, { meta, signal, asrLanguage, forceRestart }) {
  // 整个任务期间保活：等冷却、等重试时 service worker 也不会因空闲被回收
  const stopHeartbeat = startWorkerHeartbeat();
  try {
    jobBroadcast(job, { stage: "playurl", message: "正在获取音频地址…" });
    const playurl = await fetchPlayurl(meta);
    throwIfAborted(signal);
    const stream = pickAudioStream(playurl);

    const duration = Number(playurl.timelength) > 1000
      ? Number(playurl.timelength) / 1000
      : Number(meta.duration) || 0;
    const result = await transcribeAudio(stream, {
      meta,
      language: asrLanguage || undefined,
      signal,
      duration,
      tabId: job.tabId,
      forceRestart,
      job,
      onProgress: (info) => {
        const extra = typeof info === "string" ? { message: info } : info;
        const { job: _j, ...safe } = extra || {};
        jobBroadcast(job, { stage: extra.stage || job.progress?.stage || "upload", ...safe });
      }
    });

    throwIfAborted(signal);
    const partial = Boolean(result.partial);
    const stored = await saveCachedAsr(meta.bvid, meta.cid, {
      cues: result.cues,
      language: asrLanguage || "",
      model: job.lastSttModel || job.sttCfg?.model || GROQ_MODEL,
      provider: job.lastSttProvider || job.sttCfg?.provider || "Groq",
      activeLan: "groq-asr",
      source: "groq",
      origin: "asr",
      partial
    });
    const cues = stored.cues || result.cues;
    // 转写完成（含部分完成）：备份到 WebDAV（没开字幕同步时什么都不做）
    queueSubtitleBackup(meta.bvid, meta.cid, "asr").catch(() => {});
    const message = partial
      ? `已生成 ${cues.length} 条字幕，${result.reason}。已保存进度，可点「继续生成」补齐`
      : `已生成 ${cues.length} 条字幕`;

    logAsrSummary(job, partial ? "partial" : "done", {
      reason: result.reason,
      done: result.done,
      total: result.total,
      cues: cues.length,
      bvid: meta.bvid,
      cid: meta.cid
    });
    jobBroadcast(job, {
      stage: "done",
      message,
      done: result.done,
      total: result.total,
      cues,
      source: stored.source || "groq",
      activeLan: stored.activeLan || "groq-asr",
      partial,
      waitUntil: 0
    });

    return {
      cues,
      partial,
      activeLan: stored.activeLan || "groq-asr",
      source: stored.source || "groq",
      language: asrLanguage || "",
      model: job.lastSttModel || job.sttCfg?.model || GROQ_MODEL,
      provider: job.lastSttProvider || job.sttCfg?.provider || "Groq",
      aid: meta.aid,
      cid: meta.cid,
      bvid: meta.bvid,
      title: meta.title,
      part: meta.part,
      jobId: job.jobId,
      tabId: job.tabId
    };
  } catch (error) {
    if (signal.aborted || error?.name === "AbortError") {
      const canceled = new Error("已取消生成");
      canceled.canceled = true;
      throw canceled;
    }
    throw error;
  } finally {
    stopHeartbeat?.();
  }
}

// ---- 后台被回收后的续跑 ----
// 方案：任务开始时在 chrome.storage.session 记一个「运行中」标记，正常结束（完成 / 取消 / 出错 /
// 部分完成）都会清掉。service worker 被 Chrome 回收后再次启动时，标记还在就说明任务是被打断的；
// 只有该视频的标签页仍打开且还停在这个视频上才自动续跑（避免用户离开后继续花 API 费用）。
// session 存储在浏览器重启后会清空，所以重启浏览器不会自动开始转写。已完成的分段从断点复用。

const ASR_RUN_PREFIX = "asrRun:";
const ASR_RESUME_MAX = 3;
const ASR_RESUME_MAX_AGE_MS = 12 * 60 * 60 * 1000;

async function markAsrRunning(job, input, meta) {
  const area = chrome.storage?.session;
  if (!area?.set) return;
  job.runKey = `${ASR_RUN_PREFIX}${asrLockKey(meta.bvid, meta.cid)}`;
  const record = {
    tabId: job.tabId || 0,
    startedAt: Date.now(),
    resumes: Number(input.resumes) || 0,
    input: {
      tabId: job.tabId || 0,
      aid: meta.aid || input.aid || 0,
      cid: meta.cid || input.cid || 0,
      bvid: meta.bvid || input.bvid || "",
      p: input.p || 1,
      epId: input.epId || "",
      seasonId: input.seasonId || "",
      title: input.title || meta.title || "",
      part: input.part || meta.part || ""
    }
  };
  await area.set({ [job.runKey]: record }).catch(() => {});
}

function clearAsrRunning(runKey) {
  chrome.storage?.session?.remove?.(runKey)?.catch?.(() => {});
}

/** 标签页还停在这个视频上（同一个 BV 号 / 同一集 / 同一条 X 帖子，多 P 时分 P 也要一致） */
function tabShowsAsrVideo(tab, input = {}) {
  let url;
  try {
    url = new URL(String(tab?.url || ""));
  } catch {
    return false;
  }
  const bvid = String(input.bvid || "");
  const x = bvid.match(/^x_(\d+)_[1-4]$/);
  if (x) return new RegExp(`/status/${x[1]}(?:/|$)`).test(url.pathname);
  if (bvid && url.pathname.includes(`/video/${bvid}`)) {
    const p = Number(url.searchParams.get("p")) || 1;
    return !(Number(input.p) > 0) || Number(input.p) === p;
  }
  // 番剧按编号精确比对：ep12 不能匹配 ep123
  const ep = url.pathname.match(/\/bangumi\/play\/ep(\d+)\/?$/)?.[1];
  const ss = url.pathname.match(/\/bangumi\/play\/ss(\d+)\/?$/)?.[1];
  if (input.epId && ep && ep === String(input.epId)) return true;
  if (input.seasonId && ss && ss === String(input.seasonId)) return true;
  return false;
}

async function resumeInterruptedAsrJobs() {
  const area = chrome.storage?.session;
  if (!area?.get) return;
  let all;
  try {
    all = await area.get(null);
  } catch {
    return;
  }
  for (const [key, record] of Object.entries(all || {})) {
    if (!key.startsWith(ASR_RUN_PREFIX)) continue;
    const input = record?.input;
    const tooOld = Date.now() - (Number(record?.startedAt) || 0) > ASR_RESUME_MAX_AGE_MS;
    if (!input || tooOld || (Number(record.resumes) || 0) >= ASR_RESUME_MAX) {
      clearAsrRunning(key);
      continue;
    }
    let tab = null;
    try {
      tab = await chrome.tabs.get(Number(input.tabId));
    } catch {
      tab = null;
    }
    if (!tab || !tabShowsAsrVideo(tab, input)) {
      clearAsrRunning(key);
      appLog("info", "asr", "后台重启时视频页已关闭或已切走，不再续跑转写", { bvid: input.bvid, cid: input.cid });
      continue;
    }
    appLog("warn", "asr", "转写被 Chrome 后台回收打断，视频页仍打开，自动续跑", { bvid: input.bvid, cid: input.cid });
    const resumes = (Number(record.resumes) || 0) + 1;
    // 先把续跑次数写回标记：任务还没走到 markAsrRunning 后台就又被回收，下次启动也照样计数，不会无限续跑
    await area.set({ [key]: { ...record, resumes } }).catch(() => {});
    startAsr({ ...input, resumes, force: false }, null);
  }
}
