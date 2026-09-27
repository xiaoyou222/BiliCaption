// 侧栏 · 中英字幕：英文原文与译文的对应、显示语言切换，以及按时间 / 原文记住已译出的句子。

function originalForCue(cue) {
  const tagged = String(cue?.original || "").trim();
  if (tagged) return tagged;
  const text = normCueText(cue?.content);
  if (!text) return "";
  for (const item of translatedCueRanges) {
    if (item.original && normCueText(item.translated) === text) return item.original;
  }
  for (const [key, zh] of translatedCueText.entries()) {
    if (key.startsWith("e:") && normCueText(zh) === text) return key.slice(2);
  }
  return "";
}

function hydrateCueOriginals(cues) {
  if (!Array.isArray(cues)) return [];
  return cues.map((cue) => {
    if (String(cue?.original || "").trim()) return cue;
    const original = originalForCue(cue);
    return original ? { ...cue, original } : cue;
  });
}

function cueDisplayText(cue) {
  if (captionLang === "en") {
    const original = originalForCue(cue);
    if (original) return original;
  }
  return window.BiliCaptionTranslate?.cueDisplayText?.(cue, captionLang)
    || String(cue?.content || "").trim();
}

function hasBilingualCaptions(cues = state?.cues) {
  return (cues || []).some((cue) => {
    const original = originalForCue(cue);
    return Boolean(original) && original !== String(cue?.content || "").trim();
  });
}

function trackLangKind(track) {
  return window.BiliCaptionTranslate?.trackLangKind?.(track) || "";
}

function pickTrackByLang(tracks, lang) {
  return window.BiliCaptionTranslate?.pickTrackByLang?.(tracks, lang) || null;
}

function isPluginCaptions(next = state) {
  return window.BiliCaptionTranslate?.isPluginCaptionSource?.(next?.source, next?.activeLan) === true;
}

function canShowCaptionLang(lang) {
  if (isPluginCaptions()) {
    return window.BiliCaptionTranslate?.captionListHasLang?.(state?.cues, lang) === true;
  }
  return Boolean(pickTrackByLang(state?.tracks, lang));
}

function persistCaptionLang() {
  chrome.storage.sync.set({ captionLang }).catch(() => {});
  sendToTab({ type: "SET_CAPTION_LANG", lang: captionLang }).catch(() => {});
}

function revealChineseIfReady(cues = state?.cues) {
  if (captionLangPinned || captionLang !== "en") return false;
  if (!isPluginCaptions()) return false;
  const hasZh = (cues || []).some((cue) => cueHasCjk(cue?.content));
  if (!hasZh) return false;
  captionLang = "zh";
  persistCaptionLang();
  return true;
}

function syncCaptionLangFromState(next = state) {
  if (isPluginCaptions(next)) {
    const cues = next?.cues || [];
    const hasZh = cues.some((cue) => cueHasCjk(cue.content));
    const hasEn = cues.some((cue) => String(cue.original || "").trim() || needsTranslation(cue.content));
    if (hasEn && !hasZh) {
      captionLang = "en";
      return;
    }
    if (hasZh && !hasEn) {
      captionLang = "zh";
      return;
    }
    revealChineseIfReady(cues);
    return;
  }
  if (hasBilingualCaptions(next?.cues)) return;
  const kind = trackLangKind({ lan: next?.activeLan || "", lanDoc: "" });
  if (kind) captionLang = kind;
}

function renderCaptionLang() {
  const el = ui.captionLang || $("captionLang");
  if (!el) return;
  const bilingual = view === "captions"
    && Boolean(state?.cues?.length)
    && canShowCaptionLang("zh")
    && canShowCaptionLang("en");
  show(el, bilingual);
  el.querySelectorAll("button[data-lang]").forEach((btn) => {
    const lang = btn.dataset.lang;
    const on = lang === captionLang;
    const enabled = canShowCaptionLang(lang);
    btn.classList.toggle("active", on);
    btn.disabled = !enabled;
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

async function setCaptionLang(lang) {
  const next = lang === "en" ? "en" : "zh";
  if (!canShowCaptionLang(next)) {
    if (isPluginCaptions() && next === "en") {
      flash("这份翻译没有留下英文原文，清理缓存后再翻译一次");
    } else if (isPluginCaptions() && next === "zh") {
      flash("还没有中文，请先翻译");
    } else {
      flash(next === "en" ? "没有英文字幕" : "没有中文字幕");
    }
    return;
  }
  cancelCueEdit();
  captionLang = next;
  captionLangPinned = true;
  chrome.storage.sync.set({ captionLang }).catch(() => {});
  // 自己转写/翻译的字幕绝不能切到 B 站官方轨，否则生成结果会被盖掉。
  if (!isPluginCaptions()) {
    const track = pickTrackByLang(state?.tracks, next);
    if (track && track.lan !== state?.activeLan) {
      const result = await sendToTab({ type: "SWITCH_TRACK", lan: track.lan });
      renderState(result);
      return;
    }
  }
  lastCuesSig = "";
  renderCaptionLang();
  renderCues();
  sendToTab({ type: "SET_CAPTION_LANG", lang: captionLang }).catch(() => {});
}

function translationVideoKey(value = state) {
  const id = value?.bvid || value?.aid || "";
  const cid = Number(value?.cid) || 0;
  return id || cid ? `${id}:${cid}` : "";
}

function cueTranslationKey(cue) {
  const from = Math.round((Number(cue?.from) || 0) * 100);
  const to = Math.round((Number(cue?.to) || 0) * 100);
  return `${from}-${to}`;
}

function normCueText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function resetTranslationsFor(value = state) {
  const key = translationVideoKey(value);
  if (translatedCueVideoKey && key && translatedCueVideoKey !== key) {
    translatedCueText = new Map();
    translatedCueRanges = [];
  }
  if (key) translatedCueVideoKey = key;
}

function rememberTranslatedCue(cue, content, original) {
  resetTranslationsFor(state);
  const translated = String(content || "");
  if (!translated) return;
  const key = cueTranslationKey(cue);
  const orig = normCueText(original);
  // 同一句同一译文已记过就不再追加区间：整份进度反复到达时，记忆表不会越积越长。
  if (translatedCueText.get(key) === translated && (!orig || translatedCueText.get(`e:${orig}`) === translated)) return;
  translatedCueText.set(key, translated);
  if (orig) translatedCueText.set(`e:${orig}`, translated);
  translatedCueRanges.push({
    from: Number(cue?.from) || 0,
    to: Number(cue?.to) || Number(cue?.from) || 0,
    original: orig,
    translated
  });
}

function applyRememberedTranslations(cues) {
  if (!Array.isArray(cues)) return [];
  const hasMemory = translatedCueText.size || translatedCueRanges.length;
  if (!hasMemory) return cues.map((cue) => ({ ...cue }));
  return cues.map((cue) => {
    const text = normCueText(cue.content);
    if (cueHasCjk(text) && !needsTranslation(text)) return { ...cue };
    const byOriginal = text ? translatedCueText.get(`e:${text}`) : null;
    if (byOriginal) return { ...cue, content: byOriginal, original: cue.original || text };
    const byTime = translatedCueText.get(cueTranslationKey(cue));
    if (byTime != null) return { ...cue, content: byTime, original: cue.original || text };
    for (const item of translatedCueRanges) {
      if (!item.original || item.original !== text) continue;
      const overlap = cueOverlap(cue, item);
      const dur = Math.max(0.2, (Number(cue.to) || 0) - (Number(cue.from) || 0));
      if (overlap >= dur * 0.8) {
        return { ...cue, content: item.translated, original: cue.original || text };
      }
    }
    return { ...cue };
  });
}

function needsTranslation(text) {
  return window.BiliCaptionTranslate?.needsTranslation?.(text) === true;
}
