const BiliCaptionTranslate = (() => {
  function clampTranslateConcurrency(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return 4;
    return Math.min(16, Math.max(1, n));
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
      // 模型偶尔把只读上下文（> 开头）或段落标签抄回来，这些不是本批译文。
      .filter((line) => !/^(>|【(?:上文|待译|视频标题)】)/.test(line))
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

  const TRANSLATE_BATCH_SIZE = 24;
  // 当前播放位置的第一批用小批，首屏译文更快出来。
  const TRANSLATE_FIRST_BATCH = 10;
  // 第一批从当前句往前多带几句，用户常会回退一点重听。
  const TRANSLATE_LEAD = 2;
  const TRANSLATE_CONTEXT_LINES = 3;
  const TRANSLATE_SYSTEM = "你是字幕翻译。把英文字幕译成自然、简洁的简体中文，专有名词和术语前后保持一致。只输出译文。";

  function abortError() {
    const error = new Error("已取消");
    error.name = "AbortError";
    return error;
  }

  function cueEnd(cues, item) {
    const cue = cues?.[item.index];
    return Number(cue?.to) || Number(cue?.from) || 0;
  }

  /**
   * 按播放位置排翻译批次：先派当前位置那一批（小批，往前带 lead 句），
   * 再顺着往后，最后从近到远回头补前面。items 是 { index, text }，按 index 排序后切批。
   */
  function planTranslateBatches(items, cues, anchorTime, options = {}) {
    const size = Math.max(1, Math.round(Number(options.size) || TRANSLATE_BATCH_SIZE));
    const firstSize = Math.max(1, Math.min(size, Math.round(Number(options.firstSize) || TRANSLATE_FIRST_BATCH)));
    const lead = Math.max(0, Math.round(Number(options.lead ?? TRANSLATE_LEAD)));
    const list = (Array.isArray(items) ? items : []).slice().sort((a, b) => a.index - b.index);
    if (!list.length) return [];
    const time = Number(anchorTime);
    let pos = 0;
    if (Number.isFinite(time) && time > 0) {
      pos = list.findIndex((item) => cueEnd(cues, item) > time);
      // 落在两句之间时取下一句；已过最后一句就从最后一句往前补。
      if (pos < 0) pos = list.length - 1;
    }
    const start = Math.max(0, pos - lead);
    const forward = [list.slice(start, start + firstSize)];
    for (let i = start + firstSize; i < list.length; i += size) forward.push(list.slice(i, i + size));
    const backward = [];
    for (let end = start; end > 0; end -= size) backward.push(list.slice(Math.max(0, end - size), end));
    return [...forward, ...backward].filter((batch) => batch.length);
  }

  function defaultSleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener?.("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener?.("abort", onAbort, { once: true });
    });
  }

  /**
   * 跑翻译批次队列。queue 需要 take()（返回下一批或 null），可以在运行中重排。
   * - 单批失败按指数退避重试（尊重 Retry-After），遇 429 把并发减半；
   * - 重试仍失败的批次记下来，队列跑完后统一补翻一轮；
   * - 取消（AbortError）立即停；致命错误（鉴权、模型不存在等）或开局连续失败时不再派新批。
   * 返回 { failed: [batch], errors: [error], concurrency }。
   */
  async function runBatchQueue(queue, options = {}) {
    const {
      worker,
      signal,
      retries = 2,
      baseDelayMs = 1500,
      maxDelayMs = 30000,
      isRetryable = () => true,
      isFatal = () => false,
      retryAfterMs = (error) => Number(error?.retryAfter) || 0,
      sleep = defaultSleep,
      onRetry,
      onRateLimit,
      finalPass = true,
      breakerAfter = 3
    } = options;
    let cap = clampTranslateConcurrency(options.limit);
    let fatal = null;
    let successes = 0;
    let failStreak = 0;
    const failed = [];

    async function attempt(batch) {
      for (let tries = 0; ; tries += 1) {
        if (signal?.aborted) throw abortError();
        try {
          await worker(batch);
          successes += 1;
          failStreak = 0;
          return;
        } catch (error) {
          if (signal?.aborted || error?.name === "AbortError") throw error;
          if (isFatal(error)) {
            fatal = fatal || error;
            return;
          }
          const status = Number(error?.status) || 0;
          if (status === 429 && cap > 1) {
            cap = Math.max(1, Math.floor(cap / 2));
            onRateLimit?.(cap, error);
          }
          if (tries >= retries || !isRetryable(error)) {
            failed.push({ batch, error });
            failStreak += 1;
            // 一句都没译成就连续失败，多半是配置问题，别把剩下的批次全打一遍。
            if (!successes && failStreak >= breakerAfter) fatal = fatal || error;
            return;
          }
          const backoff = baseDelayMs * 2 ** tries;
          const wait = Math.min(maxDelayMs, Math.max(retryAfterMs(error) || 0, backoff + Math.random() * baseDelayMs * 0.3));
          onRetry?.({ batch, error, tries: tries + 1, wait });
          await sleep(wait, signal);
        }
      }
    }

    async function drain(source, width) {
      async function lane(id) {
        while (!fatal) {
          if (signal?.aborted) throw abortError();
          // 429 降并发后，多出来的通道做完手头这批就退出。
          if (id >= cap) return;
          const batch = source.take();
          if (!batch) return;
          await attempt(batch);
        }
      }
      const settled = await Promise.allSettled(
        Array.from({ length: Math.max(1, width) }, (_, id) => lane(id))
      );
      const rejected = settled.find((item) => item.status === "rejected");
      if (rejected) throw rejected.reason;
    }

    await drain(queue, cap);
    if (fatal) throw fatal;
    if (finalPass && failed.length) {
      const again = failed.splice(0).map((item) => item.batch);
      await drain({ take: () => again.shift() || null }, Math.min(cap, 2));
      if (fatal) throw fatal;
    }
    return {
      failed: failed.map((item) => item.batch),
      errors: failed.map((item) => item.error),
      concurrency: cap
    };
  }

  function clipLine(text, max = 200) {
    const raw = String(text || "").replace(/\s+/g, " ").trim();
    return raw.length > max ? `${raw.slice(0, max)}…` : raw;
  }

  /** 本批前几句的原文和已有译文，只给模型理解上下文。 */
  function translateContext(cues, firstIndex, count = TRANSLATE_CONTEXT_LINES) {
    const list = Array.isArray(cues) ? cues : [];
    const out = [];
    for (let i = Math.max(0, firstIndex - count); i < firstIndex; i += 1) {
      const cue = list[i];
      if (!cue) continue;
      const content = String(cue.content || "").trim();
      const hasZh = (content.match(/[一-鿿]/g) || []).length >= 1;
      const original = String(cue.original || "").trim() || (hasZh ? "" : content);
      if (!original && !content) continue;
      out.push({ original, translated: hasZh ? content : "" });
    }
    return out;
  }

  function buildTranslatePrompt(batch, { context = [], title = "", note = "" } = {}) {
    const n = batch.length;
    const lines = [
      `只把【待译】里的 ${n} 行英文字幕译成简体中文。必须保持编号，一行一条，只输出【待译】的 1-${n} 号，不要解释，不要输出英文原文。`
    ];
    if (note) lines.push(note);
    const name = clipLine(title, 120);
    if (name) lines.push("", `【视频标题】${name}`);
    const ctx = (context || []).filter((item) => item.original || item.translated);
    if (ctx.length) {
      lines.push("", "【上文】只用来理解指代和术语，不要翻译，也不要输出：");
      for (const item of ctx) {
        const original = clipLine(item.original);
        const translated = clipLine(item.translated);
        lines.push(`> ${original || translated}${original && translated ? ` ｜ ${translated}` : ""}`);
      }
    }
    lines.push("", "【待译】");
    batch.forEach((item, i) => lines.push(`${i + 1}. ${String(item.text || "").replace(/\s*\n\s*/g, " ")}`));
    return lines.join("\n");
  }

  /** 把模型输出对齐回本批：返回每行译文（没译成的是空串）和需要重试的行号（从 0 起）。 */
  function alignTranslatedBatch(batch, raw) {
    const parsed = parseTranslatedBatch(raw, batch.length);
    const lines = [];
    const missing = [];
    batch.forEach((item, i) => {
      // 繁体统一转简体（lib/zh-simp.js，需先加载）
      const got = BiliCaptionZh.toSimplified(parsed[i] || "");
      if (looksTranslated(got, item.text)) lines.push(got);
      else {
        lines.push("");
        missing.push(i);
      }
    });
    return { lines, missing };
  }

  function alignRetryNote(count) {
    return `上一次的输出缺了这 ${count} 行、编号对不上或仍是英文原文。这次请逐行译成中文，编号从 1 到 ${count}，不要合并或拆分行。`;
  }

  function prepareCues(cues) {
    const next = (Array.isArray(cues) ? cues : []).map((cue) => ({
      ...cue,
      content: BiliCaptionZh.toSimplified(cue.content)
    }));
    const targets = next
      .map((cue, index) => ({ index, text: cue.content }))
      .filter((item) => needsTranslation(item.text));
    return { cues: next, targets };
  }

  function joinCueText(left, right) {
    const a = String(left || "").trimEnd();
    const b = String(right || "").trimStart();
    const needsSpace = /[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b);
    return `${a}${needsSpace ? " " : ""}${b}`.replace(/\s+/g, " ").trim();
  }

  function cueDisplayText(cue, lang = "zh") {
    if (lang === "en") {
      const original = String(cue?.original || "").trim();
      if (original) return original;
    }
    return String(cue?.content || "").trim();
  }

  function cueEditField(cue, lang) {
    if (lang === "en" && String(cue?.original || "").trim()) return "original";
    return "content";
  }

  function cueFieldText(cue, field) {
    return String(cue?.[field] || "");
  }

  function countTerm(cues, field, term, draftIndex, draftText) {
    if (!term || /\n/.test(term)) return 0;
    const list = Array.isArray(cues) ? cues : [];
    let n = 0;
    for (let i = 0; i < list.length; i += 1) {
      const text = typeof draftIndex === "number" && i === draftIndex
        ? String(draftText ?? "")
        : cueFieldText(list[i], field);
      n += text.split(term).length - 1;
    }
    return n;
  }

  function replaceTerm(cues, field, term, to) {
    const list = Array.isArray(cues) ? cues.map((cue) => ({ ...cue })) : [];
    if (!term || /\n/.test(String(term)) || !String(to).trim()) {
      return { cues: list, n: 0 };
    }
    let n = 0;
    for (const cue of list) {
      const src = cueFieldText(cue, field);
      const parts = src.split(term);
      const c = parts.length - 1;
      if (!c) continue;
      n += c;
      cue[field] = parts.join(to);
    }
    return { cues: list, n };
  }

  function cueHasOriginal(cue) {
    const original = String(cue?.original || "").trim();
    return Boolean(original) && original !== String(cue?.content || "").trim();
  }

  function stampCueOriginal(cue, english) {
    if (!cue || typeof cue !== "object") return cue;
    if (String(cue.original || "").trim()) return cue;
    const src = String(english || "").trim();
    if (src) cue.original = src;
    return cue;
  }

  function trackLangKind(track) {
    const lan = String(track?.lan || "").toLowerCase();
    const doc = String(track?.lanDoc || "");
    if (/^en([a-z-]|$)/.test(lan) || lan === "ai-en" || /英文|英语|English/i.test(doc)) return "en";
    if (lan.includes("zh") || lan === "chi" || /中文|汉语/i.test(doc)) return "zh";
    return "";
  }

  function pickTrackByLang(tracks, lang) {
    const matched = (Array.isArray(tracks) ? tracks : []).filter((item) => trackLangKind(item) === lang);
    if (!matched.length) return null;
    if (lang === "zh") {
      return matched.find((item) => item.lan === "ai-zh" || /自动/.test(item.lanDoc || "")) || matched[0];
    }
    return matched.find((item) => item.lan === "ai-en") || matched[0];
  }

  function tracksAreZhEnOnly(tracks) {
    const list = Array.isArray(tracks) ? tracks : [];
    if (!list.length) return true;
    return list.every((item) => {
      const kind = trackLangKind(item);
      return kind === "zh" || kind === "en";
    });
  }

  function isPluginCaptionSource(source, activeLan) {
    const from = String(source || "");
    const lan = String(activeLan || "");
    return from === "groq" || from === "translated" || lan === "groq-asr" || lan === "translated";
  }

  function captionListHasLang(cues, lang) {
    const list = Array.isArray(cues) ? cues : [];
    if (lang === "zh") {
      return list.some((cue) => (String(cue?.content || "").match(/[\u4e00-\u9fff]/g) || []).length >= 1);
    }
    if (lang !== "en") return false;
    if (list.some((cue) => cueHasOriginal(cue))) return true;
    let english = 0;
    let chinese = 0;
    for (const cue of list) {
      const text = cue?.content;
      if ((String(text || "").match(/[\u4e00-\u9fff]/g) || []).length >= 1) chinese += 1;
      else if (needsTranslation(text)) english += 1;
    }
    return english > 0 && english >= chinese;
  }

  return {
    clampTranslateConcurrency,
    needsTranslation,
    stripModelFiller,
    looksTranslated,
    parseTranslatedBatch,
    TRANSLATE_BATCH_SIZE,
    TRANSLATE_FIRST_BATCH,
    TRANSLATE_CONTEXT_LINES,
    TRANSLATE_SYSTEM,
    planTranslateBatches,
    runBatchQueue,
    translateContext,
    buildTranslatePrompt,
    alignTranslatedBatch,
    alignRetryNote,
    prepareCues,
    joinCueText,
    cueDisplayText,
    cueEditField,
    cueFieldText,
    countTerm,
    replaceTerm,
    cueHasOriginal,
    stampCueOriginal,
    trackLangKind,
    pickTrackByLang,
    tracksAreZhEnOnly,
    isPluginCaptionSource,
    captionListHasLang
  };
})();

if (typeof self !== "undefined") self.BiliCaptionTranslate = BiliCaptionTranslate;
if (typeof window !== "undefined") window.BiliCaptionTranslate = BiliCaptionTranslate;
