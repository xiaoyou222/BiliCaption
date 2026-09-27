// 后台 · 切句：转写结果（segments / words）变成字幕行：过滤幻觉、按重叠区裁剪、
// 用词级时间戳切长句、合并碎句、繁体转简体。官方字幕和翻译结果也走这里的整理。

function normalizeWords(words) {
  return (Array.isArray(words) ? words : [])
    .map((w) => ({
      word: String(w.word || w.text || "").trim(),
      start: Number(w.start) || 0,
      end: Number(w.end) || 0
    }))
    .filter((w) => w.word);
}

function segmentsToCues(result) {
  const words = normalizeWords(result?.words);
  const segments = Array.isArray(result?.segments) ? result.segments : [];
  const cues = segments
    .map((seg, index) => {
      const from = Math.max(0, Number(seg.start) || 0);
      return {
        from,
        to: Math.max(from + 0.15, Number(seg.end) || 0),
        content: String(seg.text || seg.content || "").replace(/\s+/g, " ").trim(),
        sid: index + 1
      };
    })
    .filter((item) => item.content);

  // 有官方 segments 就用它当行，词级时间戳只在切开长段时对轴
  if (cues.length) return refineAsrCues(cues, words);

  if (words.length) return cuesFromWords(words);

  const whole = String(result?.text || "").trim();
  if (!whole) return [];
  return refineAsrCues([{ from: 0, to: Number(result.duration) || 0, content: whole, sid: 1 }], words);
}

// Whisper 在静音、片头片尾常编出的句子
const ASR_SILENCE_PHRASES = /明镜与点点|明鏡與點點|Amara\.org|字幕由.{0,12}提供|优优独播|優優獨播|请不吝点赞|點贊.{0,4}訂閱|谢谢观看|謝謝觀看|thanks? (?:you )?for watching|please subscribe/i;

/**
 * 明显的幻觉段（只看 Whisper verbose_json 带的质量指标：Groq、OpenAI whisper-1），阈值保守：
 * - 几乎肯定是静音（no_speech_prob ≥ 0.8）且整句置信度很低（avg_logprob ≤ -1）；
 * - 高度重复刷屏（compression_ratio ≥ 3）且置信度很低；
 * - 静音概率偏高（≥ 0.5）又正好是「谢谢观看」「字幕由…提供」这类典型幻觉文案。
 * 没有这些指标的服务商（Fish、ElevenLabs、gpt-4o 转写）不过滤。
 */
function isHallucinatedSegment(seg) {
  const has = (key) => seg?.[key] != null && seg[key] !== "" && Number.isFinite(Number(seg[key]));
  const noSpeech = Number(seg?.no_speech_prob);
  const logprob = Number(seg?.avg_logprob);
  const ratio = Number(seg?.compression_ratio);
  if (has("no_speech_prob") && has("avg_logprob") && noSpeech >= 0.8 && logprob <= -1) return true;
  if (has("compression_ratio") && has("avg_logprob") && ratio >= 3 && logprob <= -1) return true;
  if (has("no_speech_prob") && noSpeech >= 0.5 && ASR_SILENCE_PHRASES.test(String(seg?.text || ""))) return true;
  return false;
}

function asrLetterCount(text) {
  return (String(text || "").match(/[\p{L}\p{N}]/gu) || []).length;
}

/** 按字母、数字、汉字计数截取原句的第 [from, to) 个字，保留中间的标点和空格 */
function sliceByLetters(text, from, to) {
  const chars = Array.from(String(text || ""));
  const isLetter = (ch) => /[\p{L}\p{N}]/u.test(ch);
  const total = chars.filter(isLetter).length;
  let begin = from <= 0 ? 0 : -1;
  let end = to >= total ? chars.length : -1;
  let count = 0;
  for (let i = 0; i < chars.length && (begin < 0 || end < 0); i += 1) {
    if (!isLetter(chars[i])) continue;
    if (begin < 0 && count === from) begin = i;
    count += 1;
    if (end < 0 && count === to) end = i + 1;
  }
  if (begin < 0 || end < 0 || end <= begin) return "";
  return chars.slice(begin, end).join("").trim();
}

/**
 * 按重叠区中点裁剪一段的转写：只保留在 [from, to) 内开始的词。
 * 跨过裁剪点的句子用词级时间戳算出前后各去掉几个字，从原句里截取（保留标点）；
 * 原句和词对不上字数时改用词拼句；没有词级时间戳时按句子中点决定整句去留。
 */
function trimSegmentsToWindow(segments, words, from, to) {
  const out = [];
  for (const seg of segments) {
    const start = Number(seg.start) || 0;
    const end = Math.max(start, Number(seg.end) || 0);
    if (start >= from && end <= to) {
      out.push(seg);
      continue;
    }
    if (end <= from || start >= to) continue;
    const inSeg = words.filter((w) => {
      const mid = (w.start + w.end) / 2;
      return mid >= start - 0.05 && mid <= end + 0.05;
    });
    if (!inSeg.length) {
      const mid = (start + end) / 2;
      if (mid >= from && mid < to) out.push(seg);
      continue;
    }
    const kept = inSeg.filter((w) => w.start >= from && w.start < to);
    if (!kept.length) continue;
    if (kept.length === inSeg.length) {
      out.push(seg);
      continue;
    }
    const firstKept = inSeg.indexOf(kept[0]);
    const skip = inSeg.slice(0, firstKept).reduce((n, w) => n + asrLetterCount(w.word), 0);
    const keep = kept.reduce((n, w) => n + asrLetterCount(w.word), 0);
    const wordLetters = inSeg.reduce((n, w) => n + asrLetterCount(w.word), 0);
    const aligned = Math.abs(asrLetterCount(seg.text) - wordLetters) <= Math.max(1, Math.round(wordLetters * 0.1));
    const text = aligned
      ? sliceByLetters(seg.text, skip, skip + keep)
      : kept.reduce((acc, w) => BiliCaptionTranslate.joinCueText(acc, w.word), "");
    if (!text) continue;
    out.push({
      ...seg,
      start: Math.max(start, kept[0].start),
      end: Math.max(kept[0].start + 0.15, Math.min(end, kept[kept.length - 1].end)),
      text
    });
  }
  return out;
}

/**
 * 一段转写结果 → 这一段的字幕（时间相对分段起点）：
 * 过滤幻觉 → 按重叠区中点裁掉与相邻分段重复的部分 → 用词级时间戳切句。
 * 整个转写流程只在这里切一次句，合并时不再重切。
 */
function resultToPartCues(result, chunk = {}) {
  const dur = asrChunkSeconds(chunk);
  const from = Number(chunk.overlap) > 0 ? Number(chunk.overlap) / 2 : 0;
  const to = Number(chunk.tail) > 0 && dur > 0 ? dur - Number(chunk.tail) / 2 : Infinity;
  const segments = Array.isArray(result?.segments) ? result.segments : [];
  const dropped = segments.filter(isHallucinatedSegment);
  const clean = dropped.length ? segments.filter((seg) => !dropped.includes(seg)) : segments;
  let words = normalizeWords(result?.words);
  if (dropped.length) {
    // 幻觉段里的词也去掉，免得切句时又拼回来
    words = words.filter((w) => !dropped.some((seg) =>
      w.start >= (Number(seg.start) || 0) - 0.05 && w.end <= (Number(seg.end) || 0) + 0.05));
  }
  const windowed = from > 0 || Number.isFinite(to);
  return segmentsToCues({
    ...result,
    segments: windowed ? trimSegmentsToWindow(clean, words, from, to) : clean,
    words: windowed ? words.filter((w) => w.start >= from && w.start < to) : words,
    // 原本有分句或词时，裁剪、过滤后为空就是真没内容，不能退回整段原文
    text: segments.length || words.length ? "" : result?.text
  });
}

/** 中文按字、英文按词大致估算长度 */
function cueLen(text) {
  return String(text || "")
    .replace(/\s+/g, "")
    .length;
}

const HARD_PUNCT = /[。．.！？；!?\u2026]/;
const SOFT_PUNCT = /[，、,;：:]/;
const CLAUSE_MARKERS = [
  "大家都知道", "简单来说", "这种方式", "更简单",
  "再就是", "就是说", "首先是", "另外", "其次", "首先",
  "所以", "但是", "然后", "因此", "而且", "不过",
  "如果", "比如", "例如", "其实", "目前"
];

function shouldSplitCue(cue, maxChars = 56, maxDur = 12) {
  const dur = Math.max(0, (Number(cue.to) || 0) - (Number(cue.from) || 0));
  return cueLen(cue.content) > maxChars || dur > maxDur;
}

/** 中文句号，或英文句号后跟空格。4.8 / Dr. 这种中间点不切。 */
function splitBySentences(text) {
  const src = String(text || "").replace(/\s+/g, " ").trim();
  if (!src) return [];
  const parts = src
    .split(/(?<=[。！？；!?\u2026])|(?<=[.!?]["'”’]*)\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? parts : [src];
}

function mostlyLatin(text) {
  const raw = String(text || "");
  const latin = (raw.match(/[A-Za-z]/g) || []).length;
  const cjk = (raw.match(/[\u4e00-\u9fff]/g) || []).length;
  return latin >= 8 && latin > cjk;
}

/** 按句读切开，保留标点在上一片末尾 */
function splitByPunctuation(text) {
  const src = String(text || "").replace(/\s+/g, " ").trim();
  if (!src) return [];
  const hard = splitBySentences(src);
  if (hard.length > 1) return hard;

  const soft = src.split(/(?<=[，、,;：:])/).map((p) => p.trim()).filter(Boolean);
  if (soft.length > 1) return soft;

  const marked = splitByMarkers(src);
  return marked.length > 1 ? marked : [src];
}

function splitByMarkers(text) {
  const src = String(text || "");
  if (src.length < 18) return [src];
  const hits = [];
  for (const mark of CLAUSE_MARKERS) {
    let from = 1;
    while (from < src.length) {
      const at = src.indexOf(mark, from);
      if (at < 0) break;
      if (at >= 8) hits.push(at);
      from = at + mark.length;
    }
  }
  if (!hits.length) return [src];
  hits.sort((a, b) => a - b);
  const collapsed = [];
  for (const at of hits) {
    if (collapsed.length && at - collapsed[collapsed.length - 1] < 8) {
      collapsed[collapsed.length - 1] = at;
      continue;
    }
    collapsed.push(at);
  }
  const parts = [];
  let last = 0;
  for (const at of collapsed) {
    if (at - last < 10) continue;
    parts.push(src.slice(last, at).trim());
    last = at;
  }
  parts.push(src.slice(last).trim());
  return parts.filter(Boolean);
}

function allocateTimes(from, to, pieces) {
  const start = Number(from) || 0;
  const end = Math.max(start + 0.2, Number(to) || start + 0.2);
  const weights = pieces.map((p) => Math.max(1, cueLen(p)));
  const total = weights.reduce((a, b) => a + b, 0);
  const span = end - start;
  const result = [];
  let cursor = start;
  pieces.forEach((content, i) => {
    const ratio = weights[i] / total;
    const next = i === pieces.length - 1 ? end : cursor + span * ratio;
    result.push({
      from: Number(cursor.toFixed(3)),
      to: Number(Math.max(cursor + 0.15, next).toFixed(3)),
      content: content.trim()
    });
    cursor = next;
  });
  return result;
}

/** 切开长段时，用词级时间戳对齐，对不上再按字数比例估 */
function allocateTimesByWords(from, to, pieces, words) {
  const start = Number(from) || 0;
  const end = Math.max(start + 0.2, Number(to) || start + 0.2);
  const span = (Array.isArray(words) ? words : []).filter(
    (w) => w.end > start - 0.05 && w.start < end + 0.05
  );
  if (span.length < 2) return allocateTimes(from, to, pieces);

  const result = [];
  let i = 0;
  let cursor = start;
  pieces.forEach((content, p) => {
    const need = cueLen(content);
    const begin = i;
    let got = 0;
    while (i < span.length && (p === pieces.length - 1 || got < need)) {
      got += cueLen(span[i].word);
      i += 1;
      if (got >= need && p < pieces.length - 1) break;
    }
    if (i <= begin) i = Math.min(span.length, begin + 1);
    const next = p === pieces.length - 1
      ? end
      : Math.max(cursor + 0.15, Number(span[i - 1]?.end) || cursor + 0.15);
    result.push({
      from: Number(cursor.toFixed(3)),
      to: Number(next.toFixed(3)),
      content: content.trim()
    });
    cursor = next;
  });
  return result;
}

function splitByLength(text, maxChars = 56) {
  const src = String(text || "").trim();
  if (!src) return [];
  if (cueLen(src) <= maxChars) return [src];
  const parts = [];
  let buf = "";
  for (const ch of src) {
    buf += ch;
    if (cueLen(buf) >= maxChars) {
      parts.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

function splitOversized(pieces, maxChars = 72) {
  const out = [];
  for (const piece of pieces) {
    if (cueLen(piece) <= maxChars) {
      out.push(piece);
      continue;
    }
    const soft = piece.split(/(?<=[，、,;：:])/).map((p) => p.trim()).filter(Boolean);
    if (soft.length > 1) {
      out.push(...splitOversized(soft, maxChars));
      continue;
    }
    const marked = splitByMarkers(piece);
    if (marked.length > 1) {
      out.push(...splitOversized(marked, maxChars));
      continue;
    }
    if (mostlyLatin(piece)) {
      out.push(piece);
      continue;
    }
    out.push(...splitByLength(piece, 56));
  }
  return out;
}

function splitLongCue(cue, words) {
  if (!shouldSplitCue(cue)) return [cue];

  let pieces = splitBySentences(cue.content);

  if (pieces.length <= 1) {
    const dur = Math.max(0, (Number(cue.to) || 0) - (Number(cue.from) || 0));
    if (cueLen(cue.content) <= 72 && dur <= 16) return [cue];
    pieces = splitByPunctuation(cue.content);
  }
  pieces = splitOversized(pieces);
  if (pieces.length <= 1) return [cue];
  return allocateTimesByWords(cue.from, cue.to, pieces, words);
}

function mergeTinyCues(cues) {
  const out = [];
  for (const cue of cues) {
    const prev = out[out.length - 1];
    if (!prev) {
      out.push({ ...cue });
      continue;
    }
    const gap = (Number(cue.from) || 0) - (Number(prev.to) || 0);
    const mergedLen = cueLen(prev.content) + cueLen(cue.content);
    const nextStartsClause = CLAUSE_MARKERS.some((m) => cue.content.startsWith(m));
    const tiny = cueLen(prev.content) < 8 || cueLen(cue.content) < 6;
    if (tiny && !nextStartsClause && gap < 0.4 && mergedLen <= 40) {
      prev.content = BiliCaptionTranslate.joinCueText(prev.content, cue.content);
      prev.to = cue.to;
      if (prev.original || cue.original) {
        prev.original = BiliCaptionTranslate.joinCueText(prev.original || "", cue.original || "");
      }
      if (cue.edited === true) prev.edited = true;
      continue;
    }
    out.push({ ...cue });
  }
  return out.map((cue, i) => ({ ...cue, sid: i + 1 }));
}

function looksLikeHardWrap(cues) {
  if (!Array.isArray(cues) || cues.length < 4) return false;
  const mid = cues.filter((cue) => {
    const n = cueLen(cue.content);
    return n >= 18 && n <= 26 && !HARD_PUNCT.test(cue.content.slice(-1));
  }).length;
  return mid / cues.length >= 0.55;
}

/** 旧版按字数硬切的碎片先拼回去 */
function stitchBrokenWraps(cues) {
  const out = [];
  for (const cue of cues) {
    const prev = out[out.length - 1];
    const gap = prev ? (Number(cue.from) || 0) - (Number(prev.to) || 0) : 99;
    const prevEnds = HARD_PUNCT.test(prev?.content?.slice(-1) || "");
    if (prev && !prevEnds && gap < 0.55 && cueLen(prev.content) <= 26) {
      prev.content = BiliCaptionTranslate.joinCueText(prev.content, cue.content);
      prev.to = cue.to;
      if (prev.original || cue.original) {
        prev.original = BiliCaptionTranslate.joinCueText(prev.original || "", cue.original || "");
      }
      if (cue.edited === true) prev.edited = true;
      continue;
    }
    out.push({ ...cue });
  }
  return out;
}

/** Whisper 的 prompt 是上一句转写上下文，不是系统指令；静音时会把这句原样念进字幕。 */
function stripAsrInstructionLeak(text) {
  return String(text || "").replace(/^(请使用简体中文转写[。．.！!？?\s]*)+/, "").trim();
}

function flattenCueParts(cues, words = []) {
  const flat = [];
  for (const cue of cues || []) {
    for (const part of splitLongCue(cue, words)) {
      const content = BiliCaptionZh.toSimplified(stripAsrInstructionLeak(part.content));
      if (!content) continue;
      const row = {
        from: part.from,
        to: part.to,
        content,
        sid: flat.length + 1
      };
      const original = String(part.original || cue.original || "").trim();
      if (original) row.original = original;
      // 用户改过字的行（见 lib/字幕工具.js keepEditedCues）：切开后每一段都还算改过，
      // 否则翻译前的切句会丢掉标记，回写缓存时译文被改字前的文本换回去
      if (cue.edited === true || part.edited === true) row.edited = true;
      flat.push(row);
    }
  }
  return flat;
}

function refineAsrCues(cues, words = []) {
  const source = looksLikeHardWrap(cues) ? stitchBrokenWraps(cues) : cues;
  return mergeTinyCues(flattenCueParts(source, words));
}

function splitTranslatedCues(cues) {
  return flattenCueParts(cues);
}

function refineCues(cues) {
  return refineAsrCues(cues);
}

/** 没有 segments 时，才用词级时间戳按标点收成行 */
function cuesFromWords(words) {
  const cleaned = normalizeWords(words);
  if (!cleaned.length) return [];

  const cues = [];
  let buf = [];

  const bufText = () => {
    let out = "";
    for (const w of buf) out = BiliCaptionTranslate.joinCueText(out, w.word);
    return out;
  };

  const flush = () => {
    if (!buf.length) return;
    const content = bufText();
    if (!content) {
      buf = [];
      return;
    }
    cues.push({
      from: buf[0].start,
      to: Math.max(buf[0].start + 0.2, buf[buf.length - 1].end),
      content,
      sid: cues.length + 1
    });
    buf = [];
  };

  const startsClause = (word) => CLAUSE_MARKERS.some((m) => String(word || "").startsWith(m));

  for (const w of cleaned) {
    const chars = cueLen(bufText());
    const dur = buf.length ? w.end - buf[0].start : 0;
    const hitPunct = HARD_PUNCT.test(w.word.slice(-1));
    const hitSoft = SOFT_PUNCT.test(w.word.slice(-1));
    const atBoundary = buf.length && startsClause(w.word) && chars >= 14;

    if (buf.length && atBoundary) flush();
    else if (buf.length && (chars > 72 || dur > 16) && (hitPunct || hitSoft || atBoundary)) flush();

    buf.push(w);
    if (hitPunct || (hitSoft && cueLen(bufText()) >= 20)) flush();
  }
  flush();
  return refineAsrCues(cues, cleaned);
}
