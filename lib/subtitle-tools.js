(function (global) {
  // 后台、侧栏、内容脚本、设置页和标记库共用的小工具。以前各处各抄一份，改一处漏一处。
  // 本文件也是内容脚本，同一页面可能被补注入多次：只挂全局命名空间，不留顶层 const。

  /** 至少含一个汉字 */
  function cueHasCjk(text) {
    return (String(text || "").match(/[一-鿿]/g) || []).length >= 1;
  }

  /** 两句字幕在时间轴上重叠的秒数，不重叠时为负数 */
  function cueOverlap(a, b) {
    return Math.min(Number(a?.to) || 0, Number(b?.to) || 0)
      - Math.max(Number(a?.from) || 0, Number(b?.from) || 0);
  }

  /**
   * 新到的一份字幕（重新转写、官方轨刷新）按时间重叠找回已有译文：已是中文的行原样保留；
   * 英文行与某句旧译文重叠够短句时长的 45% 就沿用那句译文，英文原文留在 original 上。
   */
  function preserveTranslatedCues(incoming, existing) {
    const prev = (Array.isArray(existing) ? existing : []).filter((cue) => cueHasCjk(cue.content));
    if (!prev.length) return incoming || [];
    return (Array.isArray(incoming) ? incoming : []).map((cue) => {
      if (cueHasCjk(cue.content)) return { ...cue };
      let best = null;
      let bestOverlap = 0;
      for (const item of prev) {
        const overlap = cueOverlap(cue, item);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          best = item;
        }
      }
      const dur = Math.max(
        0.2,
        Math.min(
          (Number(cue.to) || 0) - (Number(cue.from) || 0),
          best ? (Number(best.to) || 0) - (Number(best.from) || 0) : 0
        )
      );
      if (best && bestOverlap >= dur * 0.45) {
        const original = String(cue.original || cue.content || best.original || "").trim();
        return original
          ? { ...cue, content: best.content, original }
          : { ...cue, content: best.content };
      }
      return { ...cue };
    });
  }

  // ---- 本地字幕缓存（asr:*）的来源与改字标记 ----
  // 条目字段：origin 来源类别（"official" 平台官方字幕及其译文，可重新获取；"asr" 转写生成）；
  // editedAt 用户最后一次在侧栏 / 浮窗手动改字或批量替换的时间；cues[i].edited 标出改过的那几行。

  /** 平台自带、随时能重新拉取的官方字幕来源 */
  function isOfficialSubtitleSource(source) {
    return source === "bilibili" || source === "youtube" || source === "x";
  }

  /**
   * 缓存条目的来源类别。新条目写入时记在 origin 上；旧条目没有 origin，按 source 推断：
   * 官方来源 → official；source 为 translated、带官方字幕轨列表（tracks）且没有转写才会写的
   * provider / model → 官方字幕的译文，official；其余一律按转写处理（受保护）。
   */
  function subtitleCacheOrigin(entry) {
    if (!entry || typeof entry !== "object") return "asr";
    if (entry.origin === "official" || entry.origin === "asr") return entry.origin;
    if (isOfficialSubtitleSource(entry.source)) return "official";
    const officialTranslation = entry.source === "translated"
      && Array.isArray(entry.tracks) && entry.tracks.length > 0
      && !entry.provider && !entry.model;
    return officialTranslation ? "official" : "asr";
  }

  /** 受保护：转写生成或用户改过字。不参与自动淘汰，「清理可重新生成的缓存」也不碰 */
  function isProtectedSubtitleCache(entry) {
    return subtitleCacheOrigin(entry) === "asr" || Number(entry?.editedAt) > 0;
  }

  /** 按时间码（精确到 0.01 秒）认同一行字幕 */
  function cueTimeKey(cue) {
    return `${Math.round((Number(cue?.from) || 0) * 100)}-${Math.round((Number(cue?.to) || 0) * 100)}`;
  }

  /**
   * 自动写入（译文回写、续转写、侧栏状态落后时的保存）不能冲掉用户改过的行：
   * 新字幕里时间码相同、自己没带 edited 的行，换回已有的改字文本（content / original 一起换）。
   * 新字幕里带 edited 的行（刚改的，或带着改字标记译出来的）原样保留。
   */
  function keepEditedCues(incoming, existing) {
    // 同一时间码可能有好几行（官方字幕里屏幕文字和对白常共用时间）：按出现顺序一一对应，
    // 只换回真正改过的那一行，不把它的文本套到同时间的别的行上
    const rows = new Map();
    let edited = false;
    for (const cue of Array.isArray(existing) ? existing : []) {
      const key = cueTimeKey(cue);
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push(cue);
      if (cue?.edited) edited = true;
    }
    const list = Array.isArray(incoming) ? incoming : [];
    if (!edited) return list;
    const seen = new Map();
    return list.map((cue) => {
      if (!cue) return cue;
      const key = cueTimeKey(cue);
      const nth = seen.get(key) || 0;
      seen.set(key, nth + 1);
      if (cue.edited) return cue;
      const mine = rows.get(key)?.[nth];
      if (!mine?.edited) return cue;
      const next = { ...cue, content: mine.content, edited: true };
      if (String(mine.original || "").trim()) next.original = mine.original;
      else delete next.original;
      return next;
    });
  }

  /**
   * 两份字幕合并译文（WebDAV 备份两边不一致时用，免得哪一方花钱译出的中文丢掉）：
   * base 里还没译成中文、也不是用户改过的行，按时间重叠从 other 里没改过字的中文行找回译文
   * （匹配规则同 preserveTranslatedCues）。改过字的行两边都不动，也不从别人改过的行里取。
   * 没有能合并的行时原样返回 base（同一个数组），调用方可据此判断有没有变化。
   */
  function mergeCueTranslations(base, other) {
    const list = Array.isArray(base) ? base : [];
    const donors = (Array.isArray(other) ? other : []).filter((cue) => cue && !cue.edited && cueHasCjk(cue.content));
    if (!list.length || !donors.length) return list;
    const merged = preserveTranslatedCues(list, donors);
    let changed = false;
    const out = list.map((cue, i) => {
      if (!cue || cue.edited || cueHasCjk(cue.content)) return cue;
      const next = merged[i];
      if (!next || next.content === cue.content) return cue;
      changed = true;
      return next;
    });
    return changed ? out : list;
  }

  /** 时间标签：不足 1 小时显示 mm:ss，满 1 小时显示 h:mm:ss */
  function formatClock(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mmss = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return h ? `${h}:${mmss}` : mmss;
  }

  /** 焦点在输入框、下拉框或可编辑区域里：快捷键不该抢按键 */
  function isTypingTarget(el) {
    if (!el) return false;
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if (el.isContentEditable) return true;
    return Boolean(el.closest?.("[contenteditable='true'], input, textarea, select"));
  }

  /** 按键名显示用：单个字符转大写，Shift / Alt 这类原样 */
  function keyLabel(key) {
    return key.length === 1 ? key.toUpperCase() : key;
  }

  /** 这次按键是不是设置里的选择键（默认 Shift），不分大小写 */
  function matchesKey(event, key) {
    const pressed = event?.key;
    if (!pressed) return false;
    return pressed.toLowerCase() === String(key || "Shift").toLowerCase();
  }

  global.BiliCaptionCueTools = {
    cueHasCjk,
    cueOverlap,
    preserveTranslatedCues,
    isOfficialSubtitleSource,
    subtitleCacheOrigin,
    isProtectedSubtitleCache,
    cueTimeKey,
    keepEditedCues,
    mergeCueTranslations,
    formatClock,
    isTypingTarget,
    keyLabel,
    matchesKey
  };
})(globalThis);
