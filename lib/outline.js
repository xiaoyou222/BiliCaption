const BiliCaptionOutline = (() => {
  const SUMMARY_CUE_CHAR_BUDGET = 100000;
  const SUMMARY_CHUNK_CHAR_TARGET = 20000;
  const BRIEF_MAX_SECONDS = 20 * 60;
  // HTMLMediaElement seek 可能落在目标时间前一个媒体帧；高亮允许 50ms 误差。
  const OUTLINE_ACTIVE_EPSILON = 0.05;

  function cueTime(cue, edge) {
    if (!cue) return 0;
    if (edge === "end") return Number(cue.to) || Number(cue.from) || 0;
    return Number(cue.from) || 0;
  }

  function videoSpan(cues) {
    if (!cues?.length) return { start: 0, end: 0, span: 0 };
    const start = cueTime(cues[0], "start");
    const end = cueTime(cues[cues.length - 1], "end");
    return { start, end, span: Math.max(0, end - start) };
  }

  function parseClock(value) {
    if (value == null || value === "") return NaN;
    if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
    const raw = String(value).trim();
    if (!raw) return NaN;
    const clock = raw.match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
    if (clock) {
      const hours = clock[1] ? Number(clock[1]) : 0;
      return hours * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
    }
    const n = Number(raw);
    return raw !== "" && Number.isFinite(n) ? n : NaN;
  }

  function cueIndex(value, count) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n) || count < 1) return -1;
    if (n > count) return count - 1;
    if (n >= 1) return n - 1;
    return -1;
  }

  function nearestCue(cues, seconds, edge) {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < cues.length; i += 1) {
      const dist = Math.abs(cueTime(cues[i], edge) - seconds);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return best;
  }

  function timesFromIndices(cues, from, to) {
    const a = Math.max(0, Math.min(from, to));
    const b = Math.min(cues.length - 1, Math.max(from, to));
    return { start: cueTime(cues[a], "start"), end: cueTime(cues[b], "end") };
  }

  function resolveChapterTimes(item, cues) {
    if (!cues?.length) {
      const start = parseClock(item.start ?? item.from);
      const end = parseClock(item.end ?? item.to);
      const knownStart = Number.isFinite(start) ? start : 0;
      const knownEnd = Number.isFinite(end) ? end : knownStart;
      return { start: knownStart, end: Math.max(knownEnd, knownStart) };
    }
    const count = cues.length;
    const namedFrom = item.from ?? item.start_index ?? item.startIndex;
    const namedTo = item.to ?? item.end_index ?? item.endIndex;
    const from = namedFrom == null || namedFrom === "" ? -1 : cueIndex(namedFrom, count);
    const to = namedTo == null || namedTo === "" ? -1 : cueIndex(namedTo, count);
    if (from >= 0 && to >= 0) return timesFromIndices(cues, from, to);
    const startSec = parseClock(item.start);
    const endSec = parseClock(item.end);
    if (Number.isFinite(startSec) && Number.isFinite(endSec) && Math.abs(endSec - startSec) >= 1) {
      return {
        start: cueTime(cues[nearestCue(cues, startSec, "start")], "start"),
        end: cueTime(cues[nearestCue(cues, endSec, "end")], "end")
      };
    }
    return { start: 0, end: 0 };
  }

  function distributeEven(chapters, cues) {
    const n = Math.max(1, chapters.length);
    return chapters.map((ch, i) => {
      const from = Math.floor((i / n) * cues.length);
      const to = Math.max(from, Math.floor(((i + 1) / n) * cues.length) - 1);
      return { ...ch, ...timesFromIndices(cues, from, to) };
    });
  }

  function outlineLayout(cues) {
    const span = videoSpan(cues).span;
    if (span < BRIEF_MAX_SECONDS) {
      return {
        mode: "flat",
        span,
        chapterMin: 3,
        chapterMax: 6,
        subsMin: 0,
        subsMax: 0,
        chapterTargetMin: 0,
        chapterTargetMax: 0
      };
    }
    if (span < 45 * 60) {
      return {
        mode: "nested",
        span,
        chapterMin: 3,
        chapterMax: 6,
        subsMin: 2,
        subsMax: 4,
        chapterTargetMin: 5 * 60,
        chapterTargetMax: 15 * 60
      };
    }
    if (span < 2 * 3600) {
      return {
        mode: "nested",
        span,
        chapterMin: 4,
        chapterMax: 8,
        subsMin: 3,
        subsMax: 5,
        chapterTargetMin: 15 * 60,
        chapterTargetMax: 30 * 60
      };
    }
    return {
      mode: "nested",
      span,
      chapterMin: 6,
      chapterMax: 12,
      subsMin: 3,
      subsMax: 5,
      chapterTargetMin: 15 * 60,
      chapterTargetMax: 30 * 60
    };
  }

  function formatSpanLabel(span) {
    const total = Math.max(0, Math.round(Number(span) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.round((total % 3600) / 60);
    if (hours > 0) return minutes > 0 ? `约 ${hours} 小时 ${minutes} 分钟` : `约 ${hours} 小时`;
    return `约 ${Math.max(1, minutes || Math.round(total / 60) || 1)} 分钟`;
  }

  function chapterHasSubs(ch) {
    return Array.isArray(ch?.subs) && ch.subs.some((sub) => String(sub?.title || "").trim());
  }

  function outlineHasSubs(chapters) {
    return (chapters || []).some(chapterHasSubs);
  }

  function outlineSubCount(chapters) {
    return (chapters || []).reduce((n, ch) => n + (Array.isArray(ch?.subs) ? ch.subs.filter((sub) => String(sub?.title || "").trim()).length : 0), 0);
  }

  function activeOutlinePosition(chapters, currentTime, epsilon = OUTLINE_ACTIVE_EPSILON) {
    const time = Number(currentTime);
    if (!Number.isFinite(time)) return { chapterIndex: -1, subIndex: -1 };
    const t = time + Math.max(0, Number(epsilon) || 0);
    const list = chapters || [];
    let chapterIndex = -1;
    for (let i = 0; i < list.length; i += 1) {
      const start = Number(list[i]?.start);
      if (Number.isFinite(start) && t >= start) chapterIndex = i;
    }
    if (chapterIndex < 0) return { chapterIndex: -1, subIndex: -1 };

    const subs = Array.isArray(list[chapterIndex]?.subs) ? list[chapterIndex].subs : [];
    // 展开章在首个小节起点有微小缺口时，也应落到首个小节而不是无高亮。
    let subIndex = subs.length ? 0 : -1;
    for (let i = 0; i < subs.length; i += 1) {
      const start = Number(subs[i]?.start);
      if (Number.isFinite(start) && t >= start) subIndex = i;
    }
    return { chapterIndex, subIndex };
  }

  function outlineLooksTiny(chapters, cues) {
    const video = videoSpan(cues);
    if (video.span < 90 || !chapters.length) return false;
    const start = Math.min(...chapters.map((ch) => Number(ch.start) || 0));
    const end = Math.max(...chapters.map((ch) => Number(ch.end) || 0));
    const span = Math.max(0, end - start);
    return span < 30 || span < video.span * 0.2;
  }

  function normalizeSub(item, cues) {
    const times = resolveChapterTimes(item || {}, cues);
    return {
      start: times.start,
      end: Math.max(times.end, times.start),
      title: String(item?.title || "").trim()
    };
  }

  function normalizeChapter(item, cues) {
    const times = resolveChapterTimes(item || {}, cues);
    const rawSubs = Array.isArray(item?.subs) ? item.subs : [];
    const chapter = {
      start: times.start,
      end: Math.max(times.end, times.start),
      title: String(item?.title || "").trim() || "未命名章节",
      synopsis: String(item?.synopsis || item?.summary || "").trim()
    };
    if (rawSubs.length) chapter.subs = rawSubs.map((sub) => normalizeSub(sub, cues));
    return chapter;
  }

  function clampTime(value, lo, hi) {
    return Math.min(hi, Math.max(lo, Number(value) || 0));
  }

  function finalizeSubs(subs, chapter) {
    const lo = Number(chapter?.start) || 0;
    const hi = Math.max(Number(chapter?.end) || 0, lo);
    const cleaned = (subs || [])
      .map((sub) => {
        let start = clampTime(sub.start, lo, hi);
        let end = clampTime(sub.end, lo, hi);
        if (end < start) end = start;
        return { start, end, title: String(sub.title || "").trim() };
      })
      .filter((sub) => sub.title || chapterSpan(sub) >= 1)
      .sort((a, b) => a.start - b.start);
    for (let i = 1; i < cleaned.length; i += 1) {
      if (cleaned[i].start < cleaned[i - 1].end) cleaned[i].start = cleaned[i - 1].end;
      if (cleaned[i].end < cleaned[i].start) cleaned[i].end = cleaned[i].start;
    }
    return cleaned.filter((sub) => sub.title);
  }

  function cuesInSpan(cues, start, end) {
    const lo = Number(start) || 0;
    const hi = Math.max(Number(end) || 0, lo);
    const list = cues || [];
    let from = 0;
    let to = list.length - 1;
    for (let i = 0; i < list.length; i += 1) {
      if (cueTime(list[i], "start") >= lo - 0.01) {
        from = i;
        break;
      }
    }
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (cueTime(list[i], "end") <= hi + 0.01) {
        to = i;
        break;
      }
    }
    return list.slice(from, Math.max(from, to) + 1);
  }

  function distributeEvenSubs(chapter, cues) {
    const subs = chapter.subs || [];
    if (!subs.length || !cues?.length) return chapter;
    const slice = cuesInSpan(cues, chapter.start, chapter.end);
    if (!slice.length) return chapter;
    const n = subs.length;
    return {
      ...chapter,
      subs: subs.map((sub, i) => {
        const from = Math.floor((i / n) * slice.length);
        const to = Math.max(from, Math.floor(((i + 1) / n) * slice.length) - 1);
        return { ...sub, ...timesFromIndices(slice, from, to) };
      })
    };
  }

  function chapterSpan(ch) {
    return (Number(ch?.end) || 0) - (Number(ch?.start) || 0);
  }

  function chapterJumpedBack(ch, prev) {
    if (!prev) return false;
    return (Number(ch.start) || 0) + 1 < (Number(prev.start) || 0);
  }

  function repairChapterTimes(chapters, cues) {
    if (!chapters?.length) return chapters;
    const video = videoSpan(cues);
    const out = chapters.map((ch) => ({ ...ch }));
    const usable = (ch, i) => chapterSpan(ch) >= 1 && !chapterJumpedBack(ch, i > 0 ? out[i - 1] : null);

    const fill = (i) => {
      let prevEnd = video.start;
      for (let j = i - 1; j >= 0; j -= 1) {
        if (usable(out[j], j)) {
          prevEnd = Number(out[j].end) || video.start;
          break;
        }
      }
      let nextStart = video.end;
      for (let j = i + 1; j < out.length; j += 1) {
        if (usable(out[j], j)) {
          nextStart = Number(out[j].start) || video.end;
          break;
        }
      }
      out[i].start = prevEnd;
      out[i].end = Math.max(prevEnd + 1, nextStart);
    };

    const lastOrig = chapters[chapters.length - 1];
    const lastOrigBroken = chapterSpan(lastOrig) < 1
      || chapterJumpedBack(lastOrig, chapters[chapters.length - 2]);

    for (let i = 0; i < out.length; i += 1) {
      if (!usable(out[i], i)) fill(i);
    }

    if (cues?.length && lastOrigBroken) {
      out[out.length - 1].end = video.end;
    }

    for (let i = 1; i < out.length; i += 1) {
      const prevEnd = Number(out[i - 1].end) || 0;
      // 字幕 cue 可能首尾重叠；章节必须共享同一个边界，否则点击后一章
      // 的 start 时会先命中仍未结束的上一章。
      out[i].start = prevEnd;
      if (out[i].end < out[i].start) out[i].end = out[i].start;
    }
    return out;
  }

  function stripEmptySubs(chapter) {
    if (!chapterHasSubs(chapter)) {
      return {
        start: chapter.start,
        end: chapter.end,
        title: chapter.title,
        synopsis: chapter.synopsis
      };
    }
    return chapter;
  }

  function finalizeOutline(list, cues) {
    let chapters = (list || []).map((item) => normalizeChapter(item, cues));
    if (!chapters.length) return [];
    if (cues?.length && outlineLooksTiny(chapters, cues)) {
      chapters = distributeEven(chapters, cues).map((ch) => distributeEvenSubs(ch, cues));
    } else {
      chapters = repairChapterTimes(chapters, cues);
    }
    const dropSubs = outlineLayout(cues).mode === "flat";
    return chapters.map((ch) => {
      if (dropSubs) return stripEmptySubs({ ...ch, subs: [] });
      return stripEmptySubs({ ...ch, subs: finalizeSubs(ch.subs, ch) });
    });
  }

  function formatCueLine(cue, index) {
    const from = Number(cue?.from) || 0;
    const to = Number(cue?.to) || from;
    return `${index + 1}\t${from.toFixed(1)}\t${to.toFixed(1)}\t${String(cue?.content || "").replace(/\s+/g, " ").trim()}`;
  }

  function cueCorpus(cues) {
    return (cues || []).map(formatCueLine).join("\n");
  }

  function formatClock(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function stripFence(text) {
    const raw = String(text || "").trim();
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    return fenced ? fenced[1].trim() : raw;
  }

  function sliceBalanced(text, start, open, close) {
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inStr) {
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === "\\") {
          escape = true;
          continue;
        }
        if (ch === "\"") inStr = false;
        continue;
      }
      if (ch === "\"") {
        inStr = true;
        continue;
      }
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return "";
  }

  function looksLikeOutlineObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return typeof value.summary === "string" || Array.isArray(value.chapters);
  }

  function parseJsonValue(text) {
    const raw = stripFence(text);
    const objStart = raw.indexOf("{");
    const arrStart = raw.indexOf("[");
    if (objStart >= 0 && (arrStart < 0 || objStart < arrStart || looksLikeOutlinePrefix(raw))) {
      const sliced = sliceBalanced(raw, objStart, "{", "}");
      if (sliced) {
        try {
          const parsed = JSON.parse(sliced);
          if (looksLikeOutlineObject(parsed)) return parsed;
        } catch {
          // 再试数组
        }
      }
    }
    if (arrStart >= 0) {
      const sliced = sliceBalanced(raw, arrStart, "[", "]");
      if (sliced) {
        try {
          return JSON.parse(sliced);
        } catch {
          // 下面统一报格式错误
        }
      }
    }
    throw new Error("大纲格式无法解析");
  }

  function looksLikeOutlinePrefix(raw) {
    return /"summary"\s*:/.test(raw) || /"chapters"\s*:/.test(raw);
  }

  function normalizeOutlineRecord(value) {
    if (Array.isArray(value)) {
      return { summary: "", chapters: value };
    }
    if (value && typeof value === "object") {
      return {
        summary: String(value.summary || "").trim(),
        chapters: Array.isArray(value.chapters) ? value.chapters : []
      };
    }
    return { summary: "", chapters: [] };
  }

  function parseOutlinePayload(text) {
    const rec = normalizeOutlineRecord(parseJsonValue(text));
    if (!rec.summary && !rec.chapters.length) throw new Error("大纲为空");
    return rec;
  }

  function takeJsonString(src, key) {
    const hit = String(src).match(new RegExp(`"${key}"\\s*:\\s*"`));
    if (!hit) return "";
    let i = hit.index + hit[0].length;
    let out = "";
    while (i < src.length) {
      const ch = src[i];
      if (ch === "\\" && i + 1 < src.length) {
        const next = src[i + 1];
        out += next === "n" ? "\n" : next === "t" ? " " : next;
        i += 2;
        continue;
      }
      if (ch === "\"") break;
      out += ch;
      i += 1;
    }
    return out;
  }

  function takeJsonNumber(src, key) {
    const hit = String(src).match(new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
    return hit ? Number(hit[1]) : NaN;
  }

  function parseSubObjects(src, cues) {
    const hit = String(src).match(/"subs"\s*:\s*\[/);
    if (!hit) return [];
    const arrStart = hit.index + hit[0].length - 1;
    const complete = sliceBalanced(src, arrStart, "[", "]");
    const body = complete ? complete.slice(1, -1) : src.slice(arrStart + 1);
    const out = [];
    let i = 0;
    while (i < body.length) {
      const start = body.indexOf("{", i);
      if (start < 0) break;
      const sliced = sliceBalanced(body, start, "{", "}");
      if (!sliced) break;
      try {
        const obj = JSON.parse(sliced);
        if (obj && obj.title) out.push(obj);
      } catch {
        // 半截小节丢掉
      }
      i = start + sliced.length;
    }
    return out;
  }

  function chapterFromFragment(frag, cues) {
    const title = takeJsonString(frag, "title");
    const synopsis = takeJsonString(frag, "synopsis") || takeJsonString(frag, "summary");
    if (!title && !synopsis) return null;
    const fromIdx = takeJsonNumber(frag, "from");
    const toIdx = takeJsonNumber(frag, "to");
    const startSec = takeJsonNumber(frag, "start");
    const endSec = takeJsonNumber(frag, "end");
    const subs = parseSubObjects(frag, cues);
    return normalizeChapter({
      title: title || "…",
      synopsis,
      ...(Number.isFinite(fromIdx) ? { from: fromIdx } : {}),
      ...(Number.isFinite(toIdx) ? { to: toIdx } : {}),
      ...(Number.isFinite(startSec) ? { start: startSec } : {}),
      ...(Number.isFinite(endSec) ? { end: endSec } : {}),
      ...(subs.length ? { subs } : {})
    }, cues);
  }

  function parseStreamingChapters(text, cues) {
    const raw = String(text || "");
    const arrayStart = raw.indexOf("[");
    let body = raw;
    let allowPartial = true;
    if (arrayStart >= 0) {
      const complete = sliceBalanced(raw, arrayStart, "[", "]");
      if (complete) {
        body = complete.slice(1, -1);
        allowPartial = false;
      } else {
        body = raw.slice(arrayStart + 1);
      }
    }
    const out = [];
    let i = 0;
    while (i < body.length) {
      const start = body.indexOf("{", i);
      if (start < 0) break;
      const sliced = sliceBalanced(body, start, "{", "}");
      if (sliced) {
        try {
          const obj = JSON.parse(sliced);
          if (obj && (obj.title || obj.synopsis || obj.summary)) {
            out.push(normalizeChapter(obj, cues));
          }
        } catch {
          const partial = chapterFromFragment(sliced, cues);
          if (partial) out.push(partial);
        }
        i = start + sliced.length;
        continue;
      }
      if (allowPartial) {
        const partial = chapterFromFragment(body.slice(start), cues);
        if (partial) out.push(partial);
      }
      break;
    }
    return finalizeOutline(out, cues);
  }

  function parseStreamingOutline(text, cues) {
    const raw = String(text || "");
    const summary = takeJsonString(raw, "summary");
    const chaptersHit = raw.match(/"chapters"\s*:\s*\[/);
    let chapterSrc = "";
    if (chaptersHit) {
      chapterSrc = raw.slice(chaptersHit.index + chaptersHit[0].length - 1);
    } else if (!/"summary"\s*:/.test(raw)) {
      chapterSrc = raw;
    }
    const chapters = chapterSrc ? parseStreamingChapters(chapterSrc, cues) : [];
    return { summary, chapters };
  }

  function chunkCueLines(cues, target = SUMMARY_CHUNK_CHAR_TARGET) {
    const limit = Math.max(1, Number(target) || SUMMARY_CHUNK_CHAR_TARGET);
    const chunks = [];
    let buf = "";
    const push = (text) => {
      if (text) chunks.push(text);
    };
    const hardSplit = (line) => {
      let rest = line;
      while (rest.length > limit) {
        chunks.push(rest.slice(0, limit));
        rest = rest.slice(limit);
      }
      return rest;
    };
    for (const line of (cues || []).map(formatCueLine)) {
      if (!buf) {
        buf = line.length > limit ? hardSplit(line) : line;
        continue;
      }
      if (buf.length + 1 + line.length <= limit) {
        buf += `\n${line}`;
        continue;
      }
      push(buf);
      buf = line.length > limit ? hardSplit(line) : line;
    }
    push(buf);
    return chunks;
  }

  function cueLinesBlock() {
    return "每行格式：序号<TAB>开始秒<TAB>结束秒<TAB>文本";
  }

  function indexRules() {
    return [
      "from / to 必须是字幕行的序号（从 1 开始的整数），必须落在 1 到最后一行之间。",
      "最后一章的 to 必须是最后一行序号，不要输出 0，也不要自己编秒数或时间码。"
    ];
  }

  function flatChapterRules(layout) {
    return [
      `这支视频${formatSpanLabel(layout.span)}。只切 ${layout.chapterMin}-${layout.chapterMax} 个章节，不要小节，不要 subs 字段。`,
      "每个对象字段顺序必须是 title、synopsis、from、to。",
      "跟着主题切，不要按固定分钟数切。",
      "title 是短标题，synopsis 是一两句摘要。"
    ];
  }

  function nestedChapterRules(layout) {
    const tMin = Math.max(1, Math.round(layout.chapterTargetMin / 60));
    const tMax = Math.max(tMin, Math.round(layout.chapterTargetMax / 60));
    return [
      `这支视频${formatSpanLabel(layout.span)}。按主题切两层，不要按固定时钟切。`,
      `chapters 约 ${layout.chapterMin}-${layout.chapterMax} 个，每章大约 ${tMin}-${tMax} 分钟（主题到了就切，可以略短略长）。`,
      "每个对象字段顺序必须是 title、synopsis、from、to、subs。",
      "title 是短标题，synopsis 是一两句摘要。",
      `subs 是该章的小节数组，每章 ${layout.subsMin}-${layout.subsMax} 个。`,
      "小节对象字段顺序必须是 title、from、to。小节只要一句就能看懂的短 title，不要再写 synopsis。",
      "小节的 from / to 也是字幕行序号，必须落在所属章的 from-to 之内，并按时间顺序排。"
    ];
  }

  function buildOutlinePrompt(cues) {
    const layout = outlineLayout(cues);
    const nested = layout.mode === "nested";
    return [
      nested
        ? "请根据下面带时间戳的视频字幕，生成全片总结和带小节的章节大纲。"
        : `请根据下面带时间戳的视频字幕，生成全片总结和 ${layout.chapterMin}-${layout.chapterMax} 个章节大纲。`,
      "只输出一个 JSON 对象。字段顺序必须是 summary、chapters。",
      "summary 是一句或两句中文总览，约 80-150 个中文字，不要标题、不要列表、不要时间码。",
      "chapters 是数组。",
      ...(nested ? nestedChapterRules(layout) : flatChapterRules(layout)),
      ...indexRules(),
      "不要输出其他文字。",
      "",
      cueLinesBlock(),
      cueCorpus(cues)
    ].join("\n");
  }

  function buildChaptersPrompt(cues) {
    const layout = outlineLayout(cues);
    const nested = layout.mode === "nested";
    return [
      nested
        ? `请根据下面带时间戳的视频字幕，生成带小节的章节大纲，约 ${layout.chapterMin}-${layout.chapterMax} 个章。`
        : `请根据下面带时间戳的视频字幕，生成 ${layout.chapterMin}-${layout.chapterMax} 个章节大纲。`,
      "只输出 JSON 数组。",
      ...(nested ? nestedChapterRules(layout) : flatChapterRules(layout)),
      ...indexRules(),
      "不要输出其他文字。",
      "",
      cueLinesBlock(),
      cueCorpus(cues)
    ].join("\n");
  }

  function buildSummaryMapPrompt(chunkText) {
    return [
      "请根据下面这段视频字幕，用三四句中文概括这段内容。",
      "不要时间码，不要标题，不要列表，不要输出其他文字。",
      "",
      String(chunkText || "")
    ].join("\n");
  }

  function buildSummaryReducePrompt(partials) {
    const body = (partials || []).map((text, i) => `【第${i + 1}段】\n${text}`).join("\n\n");
    return [
      "下面是同一支视频各段字幕的要点。请收成一段 80-150 个中文字的全片总览。",
      "只要一段话，不要标题、不要列表、不要时间码，不要输出其他文字。",
      "",
      body
    ].join("\n");
  }

  function formatChapterCopy(ch) {
    const head = `${formatClock(ch.start)}–${formatClock(ch.end)} ${ch.title}\n${ch.synopsis}`;
    const subs = (ch.subs || []).filter((sub) => String(sub?.title || "").trim());
    if (!subs.length) return head;
    return `${head}\n${subs.map((sub) => `  ${formatClock(sub.start)} ${sub.title}`).join("\n")}`;
  }

  function formatChapterMarkdown(ch) {
    const head = `## ${formatClock(ch.start)}–${formatClock(ch.end)} ${ch.title}\n\n${ch.synopsis}`;
    const subs = (ch.subs || []).filter((sub) => String(sub?.title || "").trim());
    if (!subs.length) return head;
    return `${head}\n\n${subs.map((sub) => `- ${formatClock(sub.start)} ${sub.title}`).join("\n")}`;
  }

  function formatOutlineCopy(summary, chapters) {
    const body = (chapters || []).map(formatChapterCopy).join("\n\n");
    const sum = String(summary || "").trim();
    if (sum && body) return `${sum}\n\n${body}`;
    return sum || body;
  }

  function formatOutlineMarkdown(title, summary, chapters) {
    const heading = `# ${title || "大纲"}`;
    const sum = String(summary || "").trim();
    const body = (chapters || []).map(formatChapterMarkdown).join("\n\n");
    const parts = [heading];
    if (sum) parts.push(sum);
    if (body) parts.push(body);
    return `${parts.join("\n\n")}\n`;
  }

  return {
    SUMMARY_CUE_CHAR_BUDGET,
    SUMMARY_CHUNK_CHAR_TARGET,
    BRIEF_MAX_SECONDS,
    OUTLINE_ACTIVE_EPSILON,
    cueTime,
    videoSpan,
    parseClock,
    cueIndex,
    nearestCue,
    resolveChapterTimes,
    outlineLayout,
    chapterHasSubs,
    outlineHasSubs,
    outlineSubCount,
    activeOutlinePosition,
    normalizeSub,
    normalizeChapter,
    repairChapterTimes,
    finalizeOutline,
    formatCueLine,
    cueCorpus,
    chunkCueLines,
    normalizeOutlineRecord,
    parseOutlinePayload,
    parseStreamingChapters,
    parseStreamingOutline,
    buildOutlinePrompt,
    buildChaptersPrompt,
    buildSummaryMapPrompt,
    buildSummaryReducePrompt,
    formatClock,
    formatOutlineCopy,
    formatOutlineMarkdown
  };
})();

if (typeof self !== "undefined") self.BiliCaptionOutline = BiliCaptionOutline;
if (typeof window !== "undefined") window.BiliCaptionOutline = BiliCaptionOutline;
if (typeof module !== "undefined") module.exports = BiliCaptionOutline;
