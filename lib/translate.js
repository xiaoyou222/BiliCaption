const BiliCaptionTranslate = (() => {
  function clampTranslateConcurrency(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return 4;
    return Math.min(16, Math.max(1, n));
  }

  function toSimplified(text) {
    const zh = (typeof self !== "undefined" && self.BiliCaptionZh)
      || (typeof window !== "undefined" && window.BiliCaptionZh);
    return zh?.toSimplified?.(text) || String(text || "");
  }

  function needsTranslation(text) {
    const raw = String(text || "").trim();
    if (!raw) return false;
    const latin = (raw.match(/[A-Za-z]/g) || []).length;
    const cjk = (raw.match(/[\u4e00-\u9fff]/g) || []).length;
    const shortEnglish = /^(?:i|yes|no|hi|hello|thanks|thank you|ok|okay|sorry|please|welcome|goodbye|bye|wait|stop|go|look|listen|really|right|sure|great|nice|wow)(?:[.!?,…]+)?$/i.test(raw);
    if (cjk === 0 && shortEnglish) return true;
    const englishPhrase = /^[A-Za-z][A-Za-z'’-]*(?:\s+[A-Za-z][A-Za-z'’-]*)*[.!?,…]*$/.test(raw);
    const wordsOnly = raw.replace(/[.!?,…]+$/g, "");
    const protectedName = /^(?:OpenAI|ChatGPT|Claude|Codex|Gemini|Windows|Linux|Python|JavaScript|TypeScript|GitHub|GitLab|Vercel|Docker|Kubernetes|Bilibili|BiliCaption)$/i.test(wordsOnly);
    const identifierLike = /[a-z][A-Z]|[_/@#={}<>`]|\.[A-Za-z]{2,}(?:\/|$)/.test(wordsOnly)
      || (wordsOnly.length > 1 && wordsOnly === wordsOnly.toUpperCase());
    const commandLike = /^(?:npm|npx|pnpm|yarn|git|pip|curl|brew|docker)\s/i.test(wordsOnly);
    // 字幕里“Exactly.”“Amazing!”这类普通短句也要翻译；同时避开
    // OpenAI / ChatGPT / API / 命令行等品牌或代码标识。
    // 短 camelCase / 全大写单词不当句子；整句里夹着 GitHub 仍要译。
    if (protectedName || (cjk === 0 && commandLike)) return false;
    if (cjk === 0 && identifierLike && latin < 16 && !/\s/.test(wordsOnly)) return false;
    if (cjk === 0 && englishPhrase && !identifierLike && !commandLike) return true;
    if (latin < 4) return false;
    if (cjk > 0 && latin <= Math.max(cjk * 1.5, 12)) return false;

    const zhPunct = /[、。！？；：…「」『』《》]/.test(raw);
    const englishSentence =
      /\b(the|a|an|is|are|was|were|be|been|to|of|and|or|in|on|for|with|this|that|it|you|we|i|can|will|have|has|do|does|not|but|if|as|at|from|your|our|they|their|what|how|why|when|all|just|about|into|than|then|so|my|me|no|yes|let|get|got|make|use|using)\b/i.test(raw)
      || /[A-Za-z]{3,}(?:\s+[A-Za-z]{2,}){2,}/.test(raw)
      || (cjk === 0 && latin >= 12);

    if (zhPunct && !englishSentence) return false;
    if (cjk === 0) return englishSentence;
    return englishSentence && latin > cjk * 1.5;
  }

  function stripModelFiller(text) {
    return String(text || "")
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/<think>[\s\S]*$/gi, "")
      .trim();
  }

  function looksTranslated(zh, en) {
    const t = String(zh || "").replace(/^["「『]|["」』]$/g, "").trim();
    if (!t || t === en) return false;
    const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
    // 进度只统计真正落成中文的行；模型复述英文、编号或标点都不算成功。
    return cjk >= 1;
  }

  function parseTranslatedBatch(raw, count) {
    const text = stripModelFiller(raw);
    const lines = text
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^(以下|翻译|译文|中文|english|note[:：])/i.test(line))
      .filter((line) => !/^[\d\.、\)\s]+$/.test(line));
    const out = new Array(count).fill("");
    const parsed = lines.map((line) => {
      const match = line.match(/^(?:\[|【)?(\d+)(?:[\.、\):：\]\-]|】)\s*(.+)$/);
      return match
        ? { number: Number(match[1]), text: match[2].trim() }
        : { number: null, text: line };
    });
    const numbered = parsed.filter((item) => Number.isInteger(item.number));
    const unique = new Set(numbered.map((item) => item.number));
    const exactNumbering = numbered.length === count
      && unique.size === count
      && Array.from({ length: count }, (_, i) => i + 1).every((n) => unique.has(n));

    if (exactNumbering) {
      for (const item of numbered) out[item.number - 1] = item.text;
      return out;
    }

    // 模型偶尔会从 0、2 或上一批编号接着写。只要行数仍精确一致，
    // 就按输出顺序对齐，避免把第 1 句静默写到第 2 句上。
    if (parsed.length === count) {
      return parsed.map((item) => item.text);
    }

    // 行数也异常时不再猜顺序，只接纳唯一且范围合法的编号。
    const counts = new Map();
    for (const item of numbered) counts.set(item.number, (counts.get(item.number) || 0) + 1);
    for (const item of numbered) {
      if (item.number < 1 || item.number > count || counts.get(item.number) !== 1) continue;
      out[item.number - 1] = item.text;
    }
    return out;
  }

  async function runPool(items, limit, worker, signal) {
    const results = new Array(items.length);
    let cursor = 0;
    let stopped = false;
    let firstError = null;
    async function run() {
      while (!stopped && cursor < items.length) {
        if (signal?.aborted) {
          const error = new Error("已取消");
          error.name = "AbortError";
          throw error;
        }
        const i = cursor;
        cursor += 1;
        try {
          results[i] = await worker(items[i], i);
        } catch (error) {
          stopped = true;
          firstError = firstError || error;
          throw error;
        }
      }
    }
    const n = Math.max(1, Math.min(limit, items.length));
    const settled = await Promise.allSettled(Array.from({ length: n }, () => run()));
    if (firstError) throw firstError;
    const rejected = settled.find((item) => item.status === "rejected");
    if (rejected) throw rejected.reason;
    return results;
  }

  function prepareCues(cues) {
    const next = (Array.isArray(cues) ? cues : []).map((cue) => ({
      ...cue,
      content: toSimplified(cue.content)
    }));
    const targets = next
      .map((cue, index) => ({ index, text: cue.content }))
      .filter((item) => needsTranslation(item.text));
    return { cues: next, targets };
  }

  const REGROUP_CHUNK_SIZE = 80;
  const REGROUP_SYSTEM = "你是字幕断句军师。只输出 MERGE / KEEP 指令，不要输出时间码、译文或解释。";

  function joinCueText(left, right) {
    const a = String(left || "").trimEnd();
    const b = String(right || "").trimStart();
    const needsSpace = /[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b);
    return `${a}${needsSpace ? " " : ""}${b}`.replace(/\s+/g, " ").trim();
  }

  function speakerKey(cue) {
    const value = cue?.speaker ?? cue?.spk ?? cue?.speaker_id ?? cue?.speakerId;
    return value == null || value === "" ? "" : String(value);
  }

  function isChineseCue(cue) {
    const text = String(cue?.content || "").trim();
    if (!text) return false;
    return looksTranslated(text, "") || (text.match(/[\u4e00-\u9fff]/g) || []).length >= 1;
  }

  function mustCutRegroup(prev, next) {
    if (isChineseCue(prev) || isChineseCue(next)) return true;
    const left = speakerKey(prev);
    const right = speakerKey(next);
    return Boolean(left && right && left !== right);
  }

  function chunkCues(cues, size = REGROUP_CHUNK_SIZE) {
    const list = Array.isArray(cues) ? cues : [];
    const n = Math.max(1, Math.round(Number(size)) || REGROUP_CHUNK_SIZE);
    const out = [];
    for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
    return out;
  }

  function parseRegroupCommands(raw, count) {
    const n = Math.max(0, Math.round(Number(count)) || 0);
    const text = stripModelFiller(raw);
    if (!n || !text.trim()) return { ok: false, reason: "empty" };

    const merges = [];
    const seenMerge = new Set();
    let recognized = 0;
    let hasSplit = false;

    for (const line of text.split(/\n/)) {
      const cleaned = String(line || "")
        .trim()
        .replace(/^[-*•]\s+/, "")
        .replace(/^[`]+|[`]+$/g, "");
      if (!cleaned || /^```/.test(cleaned)) continue;
      const match = cleaned.match(/^(MERGE|KEEP|SPLIT)\s+(\d+)(?:\s*[-–—~]\s*(\d+))?\s*$/i);
      if (!match) continue;

      const kind = match[1].toUpperCase();
      const start = Number(match[2]);
      const end = match[3] ? Number(match[3]) : start;
      if (kind === "SPLIT") {
        hasSplit = true;
        continue;
      }
      if (kind === "KEEP") {
        if (start >= 1 && start <= n) recognized += 1;
        continue;
      }
      if (!(start < end) || start < 1 || end > n) continue;
      recognized += 1;
      for (let i = start; i <= end; i += 1) {
        if (seenMerge.has(i)) return { ok: false, reason: "conflict" };
        seenMerge.add(i);
      }
      merges.push([start - 1, end - 1]);
    }

    if (hasSplit) return { ok: false, reason: "split" };
    if (!recognized) return { ok: false, reason: "unparsed" };

    merges.sort((a, b) => a[0] - b[0]);
    const ranges = [];
    let cursor = 0;
    for (const range of merges) {
      while (cursor < range[0]) {
        ranges.push([cursor, cursor]);
        cursor += 1;
      }
      ranges.push(range);
      cursor = range[1] + 1;
    }
    while (cursor < n) {
      ranges.push([cursor, cursor]);
      cursor += 1;
    }
    return { ok: true, ranges };
  }

  function splitHardCuts(cues, ranges) {
    const out = [];
    for (const [start, end] of ranges) {
      let from = start;
      for (let i = start + 1; i <= end; i += 1) {
        if (mustCutRegroup(cues[i - 1], cues[i])) {
          out.push([from, i - 1]);
          from = i;
        }
      }
      out.push([from, end]);
    }
    return out;
  }

  function applyRegroupRanges(cues, ranges) {
    const out = [];
    for (const [start, end] of ranges) {
      if (start === end) {
        out.push({ ...cues[start] });
        continue;
      }
      let content = String(cues[start].content || "");
      for (let i = start + 1; i <= end; i += 1) {
        content = joinCueText(content, cues[i].content);
      }
      out.push({
        ...cues[start],
        from: cues[start].from,
        to: cues[end].to,
        content
      });
    }
    return out;
  }

  function applyRegroupText(cues, raw) {
    const list = Array.isArray(cues) ? cues : [];
    const parsed = parseRegroupCommands(raw, list.length);
    if (!parsed.ok) {
      return { cues: list.map((cue) => ({ ...cue })), fallback: true, reason: parsed.reason };
    }
    return {
      cues: applyRegroupRanges(list, splitHardCuts(list, parsed.ranges)),
      fallback: false
    };
  }

  function buildRegroupPrompt(cues) {
    const lines = (Array.isArray(cues) ? cues : []).map((cue, index) => {
      const speaker = speakerKey(cue);
      const tag = speaker ? `[${speaker}] ` : "";
      return `${index + 1}. ${tag}${String(cue.content || "").trim()}`;
    }).join("\n");
    return `把下面按行编号的字幕收成语义完整句。只输出指令，必须覆盖全部序号。

规则：
- 同一说话人、同一句子或意群的相邻行用 MERGE
- 换说话人必须断开
- 不要因为句子偏长就不合并；显示长度由程序处理
- 已是中文的行必须 KEEP，禁止把中文 MERGE 进英文
- 禁止输出时间码或译文
- 格式：
MERGE 1-5
KEEP 6

字幕：
${lines}`;
  }

  return {
    clampTranslateConcurrency,
    toSimplified,
    needsTranslation,
    stripModelFiller,
    looksTranslated,
    parseTranslatedBatch,
    runPool,
    prepareCues,
    REGROUP_CHUNK_SIZE,
    REGROUP_SYSTEM,
    joinCueText,
    speakerKey,
    isChineseCue,
    chunkCues,
    parseRegroupCommands,
    applyRegroupText,
    buildRegroupPrompt
  };
})();

if (typeof self !== "undefined") self.BiliCaptionTranslate = BiliCaptionTranslate;
if (typeof window !== "undefined") window.BiliCaptionTranslate = BiliCaptionTranslate;
