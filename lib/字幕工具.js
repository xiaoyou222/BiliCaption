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
    formatClock,
    isTypingTarget,
    keyLabel,
    matchesKey
  };
})(globalThis);
