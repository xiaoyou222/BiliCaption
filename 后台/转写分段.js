// 后台 · 转写分段：分片大小上限、断点续传时按旧进度复用已转完的分段，以及各段字幕的合并。

// 服务商没给上限时，单个分片的上传大小上限；时长只是软限制时，分片允许比时长上限多出的秒数
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;
const MAX_CHUNK_SLACK = 15;
// 第一段缩短，第一条字幕更快出来；相邻分段重叠几秒，合并时按重叠区中点裁开
const ASR_FIRST_CHUNK_SECONDS = 90;
const ASR_OVERLAP_SECONDS = 2.5;

function chunkStartKey(start) {
  return Math.round((Number(start) || 0) * 10) / 10;
}

function hydratePart(chunk, saved, index) {
  const duration = Math.max(0, (Number(chunk.end) || 0) - (Number(chunk.start) || 0));
  const cues = (saved?.cues || [])
    .filter((cue) => !(duration > 0) || Number(cue.from) < duration - 0.01)
    .map((cue) => ({
      ...cue,
      from: Math.max(0, Number(cue.from) || 0),
      to: duration > 0
        ? Math.min(duration, Math.max(Number(cue.from) + 0.15, Number(cue.to) || 0))
        : Math.max(Number(cue.from) + 0.15, Number(cue.to) || 0)
    }));
  return {
    i: index,
    start: chunk.start || 0,
    end: chunk.end || 0,
    overlap: chunk.overlap || 0,
    tail: chunk.tail || 0,
    cues,
    complete: true,
    silent: Boolean(saved?.silent),
    // 旧进度里的分段没按重叠区中点裁过，合并时仍要靠文本去重
    trimmed: Boolean(saved?.trimmed)
  };
}

function partCoversChunk(part, chunk) {
  const chunkStart = Number(chunk.start) || 0;
  const chunkEnd = Number(chunk.end) || 0;
  const chunkDur = chunkEnd - chunkStart;
  const savedStart = Number(part?.start) || 0;
  const savedEnd = Number(part?.end) || 0;
  // 旧分段的字幕时间是相对它自己起点的；起点对不上（分段方式变了）就不能拿来顶替，
  // 否则整段字幕会错位几分钟。这种情况交给下面按全局时间轴的字幕缓存匹配。
  if (Math.abs(savedStart - chunkStart) >= 1.5) return false;
  if (
    part?.complete === true
    && chunkDur > 0
    && savedEnd > savedStart
    && savedEnd >= chunkEnd - 1.5
  ) return true;
  const cues = part?.cues || [];
  if (!cues.length) return false;
  const lastTo = maxCueField(cues);
  const dur = chunkDur;
  if (!(dur > 0)) return false;
  const need = dur > 20 ? Math.max(dur - 8, dur * 0.7) : Math.max(dur * 0.8, dur - 0.4);
  return lastTo >= need;
}

function cuesForChunk(cues, chunk) {
  const start = Number(chunk.start) || 0;
  const end = Number(chunk.end) || 0;
  if (!cues?.length || !(end > start)) return [];
  return cues
    .filter((cue) => Number(cue.from) >= start - 0.8 && Number(cue.from) < end - 0.05)
    .map((cue) => ({
      from: Math.max(0, Number(cue.from) - start),
      to: Math.max(0, Number(cue.to) - start),
      content: cue.content
    }));
}

function matchSavedParts(chunks, saved, cachedCues) {
  const parts = chunks.map(() => null);
  const pool = (saved?.parts || []).filter(partIsComplete);
  const used = new Set();
  const sameLayout = Number(saved?.total) === chunks.length;

  const take = (index, part) => {
    if (parts[index] || !part) return;
    if (!partCoversChunk(part, chunks[index])) return;
    parts[index] = hydratePart(chunks[index], part, index);
    used.add(part);
  };

  if (sameLayout) {
    for (const part of pool) {
      const idx = Number(part.i);
      if (Number.isInteger(idx) && idx >= 0 && idx < chunks.length) take(idx, part);
    }
  }

  for (let i = 0; i < chunks.length; i += 1) {
    if (parts[i]) continue;
    const key = chunkStartKey(chunks[i].start);
    const found = pool.find((part) => !used.has(part) && chunkStartKey(part.start) === key);
    if (found) take(i, found);
  }

  for (let i = 0; i < chunks.length; i += 1) {
    if (parts[i]) continue;
    const start = Number(chunks[i].start) || 0;
    const end = Number(chunks[i].end) || start + 1;
    const found = pool.find((part) => {
      if (used.has(part)) return false;
      const at = Number(part.start) || 0;
      return at >= start - 2 && at < end - 0.05;
    });
    if (found) take(i, found);
  }

  if (sameLayout) {
    const leftover = pool
      .filter((part) => !used.has(part) && partIsComplete(part))
      .sort((a, b) => {
        const ai = Number.isInteger(Number(a.i)) ? Number(a.i) : 1e9;
        const bi = Number.isInteger(Number(b.i)) ? Number(b.i) : 1e9;
        if (ai !== bi) return ai - bi;
        return (Number(a.start) || 0) - (Number(b.start) || 0);
      });
    const holes = [];
    for (let i = 0; i < chunks.length; i += 1) if (!parts[i]) holes.push(i);
    for (let k = 0; k < leftover.length && k < holes.length; k += 1) {
      take(holes[k], leftover[k]);
    }
  }

  if (cachedCues?.length) {
    for (let i = 0; i < chunks.length; i += 1) {
      if (parts[i]) continue;
      const slice = cuesForChunk(cachedCues, chunks[i]);
      if (!slice.length) continue;
      const lastTo = maxCueField(slice);
      const dur = (Number(chunks[i].end) || 0) - (Number(chunks[i].start) || 0);
      const need = dur > 20 ? Math.max(dur - 8, dur * 0.7) : Math.max(dur * 0.8, dur - 0.4);
      if (dur > 0 && lastTo >= need) {
        parts[i] = {
          i,
          start: chunks[i].start || 0,
          overlap: chunks[i].overlap || 0,
          cues: slice,
          complete: true,
          silent: false
        };
      }
    }
  }

  return parts;
}

function resumeChunkPlan(saved, duration, estimated) {
  const savedTotal = Math.max(1, Number(saved?.total) || 0, Number(estimated) || 0);
  const byIndex = new Map();
  for (const part of saved?.parts || []) {
    const idx = Number(part?.i);
    if (Number.isInteger(idx) && idx >= 0) byIndex.set(idx, part);
  }
  const slice = Number(duration) > 0 ? Number(duration) / savedTotal : 0;
  const plan = [];
  for (let i = 0; i < savedTotal; i += 1) {
    const part = byIndex.get(i);
    const start = Number(part?.start);
    const end = Number(part?.end);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      plan.push({ start, end, overlap: Number(part.overlap) || 0 });
    } else {
      plan.push({ start: slice * i, end: slice * (i + 1), overlap: 0 });
    }
  }
  return { plan, total: savedTotal };
}

function seedResumeParts(saved, cachedCues, duration, estimated) {
  const guess = Math.max(1, Number(estimated) || 0);
  if (!saved?.parts?.length && !cachedCues?.length) {
    return { parts: [], total: guess, skipped: 0, plan: [] };
  }
  const { plan, total } = resumeChunkPlan(saved, duration, guess);
  const parts = matchSavedParts(plan, saved, cachedCues);
  while (parts.length < total) parts.push(null);
  return {
    parts,
    total,
    skipped: parts.filter(partIsComplete).length,
    plan
  };
}

/**
 * 分片上限取所有通道里最严的一家：任何一段都可能被派给链上任一通道。
 * 全是 ElevenLabs 这类支持大文件的通道时，分片才会放大到默认值之上。
 */
function asrChunkLimits(job) {
  const base = {
    maxSeconds: self.BiliCaptionMp4?.CHUNK_SECONDS || 8 * 60,
    maxBytes: self.BiliCaptionMp4?.CHUNK_BYTES || 20 * 1024 * 1024,
    uploadBytes: MAX_UPLOAD_BYTES,
    hardDuration: false
  };
  const cfgs = job?.channels?.length
    ? job.channels
    : [job?.sttCfg].filter(Boolean);
  let seen = false;
  for (const cfg of cfgs) {
    const next = self.BiliCaptionProviders?.sttLimits?.(cfg);
    if (!next) continue;
    const seconds = Number(next.maxSeconds) || base.maxSeconds;
    const bytes = Number(next.maxBytes) || base.maxBytes;
    const upload = Number(next.uploadBytes) || bytes;
    if (!seen) {
      base.maxSeconds = seconds;
      base.maxBytes = bytes;
      base.uploadBytes = Math.max(bytes, upload);
      seen = true;
    } else {
      base.maxSeconds = Math.min(base.maxSeconds, seconds);
      base.maxBytes = Math.min(base.maxBytes, bytes);
      base.uploadBytes = Math.min(base.uploadBytes, Math.max(bytes, upload));
    }
    base.hardDuration ||= Boolean(next.hardDuration);
  }
  return base;
}

function maxChunkSeconds(job) {
  const limits = asrChunkLimits(job);
  return limits.maxSeconds + (limits.hardDuration ? 1 : MAX_CHUNK_SLACK);
}

/**  服务商看的是文件大小；时间轴标签不准时不能据此整段报废 */
function chunkFitsLimits(chunk, job) {
  const limits = asrChunkLimits(job);
  const size = Number(chunk?.blob?.size) || 0;
  if (size <= 0 || size > limits.uploadBytes) return false;
  const dur = Number(chunk.end) - Number(chunk.start);
  if (Number.isFinite(dur) && dur > maxChunkSeconds(job)) {
    if (limits.hardDuration) return false;
    const minBytes = dur * 3000;
    if (size >= minBytes) return false;
  }
  return true;
}

function chunkLimitLabel(chunk) {
  const mb = ((Number(chunk?.blob?.size) || 0) / 1024 / 1024).toFixed(1);
  const dur = Number(chunk?.end) - Number(chunk?.start);
  const sec = Number.isFinite(dur) && dur > 0 ? `${Math.round(dur)} 秒` : "时长未知";
  return `${mb}MB / ${sec}`;
}

/** 第一段缩短到约 70–90 秒，第一条字幕更快出来；一段就能转完的短视频不拆 */
function asrFirstChunkSeconds(duration, job) {
  const { maxSeconds } = asrChunkLimits(job);
  const dur = Number(duration) || 0;
  if (dur > 0 && dur <= maxSeconds) return maxSeconds;
  return Math.min(maxSeconds, ASR_FIRST_CHUNK_SECONDS);
}

function estimatedChunkCount(duration, job) {
  const { maxSeconds } = asrChunkLimits(job);
  const dur = Number(duration) || 0;
  if (!(dur > 0)) return 1;
  const first = asrFirstChunkSeconds(dur, job);
  if (dur <= first) return 1;
  return 1 + Math.ceil((dur - first) / Math.max(1, maxSeconds - ASR_OVERLAP_SECONDS));
}

function audioIsShort(duration, size = 0, job) {
  const limits = asrChunkLimits(job);
  const dur = Number(duration) || 0;
  const bytes = Number(size) || 0;
  if (bytes > limits.uploadBytes) return false;
  if (dur > 0) return dur <= maxChunkSeconds(job);
  return bytes > 0 && bytes <= limits.maxBytes;
}

function normalizeCueText(text) {
  return String(text || "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/**
 * 合并各段字幕：加上分段起点换成全局时间轴，只做去重和边界拼接，不再整体重新切句
 * （切句已在每段转写完时用词级时间戳做过一次）。
 * 新分段已按重叠区中点裁过（trimmed）；旧进度里的分段仍靠文本去重兜底。
 */
function mergeChunkCues(parts) {
  const all = [];
  for (const part of parts) {
    if (!part?.cues?.length) continue;
    const start = Number(part.start) || 0;
    const overlap = Number(part.overlap) || 0;
    const middle = start + overlap / 2;
    let first = true;
    for (const cue of part.cues) {
      const from = Number(cue.from) + start;
      const to = Number(cue.to) + start;
      const content = String(cue.content || "").trim();
      if (!content) continue;
      const isFirst = first;
      first = false;
      // 重叠区不能一刀切掉：上一片末尾可能本来就是静音，盲删会漏掉
      // 下一片开头的第一句话。只在时间相邻且文本确实重复时去重。
      if (overlap && from < start + overlap + 0.35) {
        const normalized = normalizeCueText(content);
        const duplicate = [...all].reverse().find((item) => {
          if (Number(item.to) < start - 2 || Number(item.from) > to + 0.5) return false;
          const previous = normalizeCueText(item.content);
          if (!normalized || !previous) return false;
          if (normalized === previous) return true;
          const shorter = Math.min(normalized.length, previous.length);
          return shorter >= 6 && (normalized.includes(previous) || previous.includes(normalized));
        });
        if (duplicate) {
          if (normalized.length > normalizeCueText(duplicate.content).length) {
            duplicate.content = content;
          }
          duplicate.to = Math.max(Number(duplicate.to) || 0, to);
          continue;
        }
      }
      // 按中点裁剪后，同一句话可能被分到两段：前一段末尾、这一段开头都贴着中点，
      // 且前半句没有句末标点，就拼回一句
      const prev = all[all.length - 1];
      if (
        isFirst
        && part.trimmed
        && overlap > 0
        && prev
        && Math.abs(Number(prev.to) - middle) < 0.6
        && Math.abs(from - middle) < 0.6
        && !HARD_PUNCT.test(String(prev.content).slice(-1))
        && cueLen(prev.content) + cueLen(content) <= 72
      ) {
        prev.content = BiliCaptionTranslate.joinCueText(prev.content, content);
        prev.to = Math.max(Number(prev.to) || 0, to);
        continue;
      }
      all.push({
        from,
        to,
        content,
        sid: all.length + 1
      });
    }
  }
  return all;
}
