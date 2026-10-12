// 侧栏 · 快捷键与设置：倍速和选择键快捷键（含浮窗转发来的按键）、浮层字幕开关、读取设置。

async function setRateFromHotkey(rate) {
  const next = Math.min(10, Math.max(0.1, Math.round((Number(rate) || 1) * 10) / 10));
  renderSpeed(next);
  try {
    const result = await sendToTab({ type: "SET_RATE", rate: next });
    if (result?.rate != null) {
      state = { ...(state || {}), ...result };
      renderSpeed(result.rate);
    }
  } catch (error) {
    flash(error.message || "调速失败，请先点一下视频页");
  }
}

function onSidepanelHotkey(event) {
  if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return;
  if (globalThis.BiliCaptionArticlePanel?.isActive()) return;
  if (event.isComposing || event.key === "Process") return;

  if (matchesKey(event, selKey)) {
    event.preventDefault();
    if (selKeyHeldFromPage !== true) {
      selKeyHeldFromPage = true;
      notifyPageSelKey(true);
      syncSelKeyArmed();
    }
    return;
  }

  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const code = event.code;
  const key = event.key?.toLowerCase();
  if (code === "KeyZ" || key === "z") {
    event.preventDefault();
    setRateFromHotkey(1);
    return;
  }
  if (code === "KeyX" || key === "x") {
    event.preventDefault();
    setRateFromHotkey(currentRate() - 0.1);
    return;
  }
  if (code === "KeyC" || key === "c") {
    event.preventDefault();
    setRateFromHotkey(currentRate() + 0.1);
  }
}

function finishHeldSelect() {
  if (selectHeld) {
    ignoreCueClickUntil = Date.now() + 400;
    if (range.start >= 0 && range.end < 0) range.end = range.start;
  }
  selectHeld = false;
  hoverSelectFrom = null;
  clearTrail();
  paintSelection();
}

function onSelKeyUp(event) {
  if (globalThis.BiliCaptionArticlePanel?.isActive()) return;
  if (event.type === "blur") {
    selKeyHeldFromPage = false;
    notifyPageSelKey(false);
    finishHeldSelect();
    return;
  }
  if (!matchesKey(event, selKey)) return;
  selKeyHeldFromPage = false;
  notifyPageSelKey(false);
  finishHeldSelect();
}

function renderOverlayBtn() {
  if (!ui.btnOverlay) return;
  ui.btnOverlay.textContent = "显示字幕";
  ui.btnOverlay.classList.toggle("active", overlayOn);
}

async function setOverlayOn(on) {
  overlayOn = on !== false;
  renderOverlayBtn();
  chrome.storage.sync.set({ overlayOn }).catch(() => {});
  sendToTab({ type: "SET_OVERLAY", on: overlayOn }).catch(() => {});
}

async function loadPrefs() {
  const data = await BiliCaptionPrefs.loadSettings({
    groqApiKey: "",
    sttKey: "",
    sttProvider: "Groq",
    sttCreds: {},
    sttChannels: [],
    selKey: "Shift",
    overlayOn: true,
    captionLang: "zh",
    summaryPad: 10
  });
  const P = globalThis.BiliCaptionProviders;
  const channels = P?.resolveChannels?.(data) || [];
  hasSttKey = channels.some((cfg) => P?.channelUsable?.(cfg));
  selKey = data.selKey || "Shift";
  overlayOn = data.overlayOn !== false;
  captionLang = data.captionLang === "en" ? "en" : "zh";
  summaryPad = Math.min(50, Math.max(0, Math.round(Number(data.summaryPad) || 10)));
  renderOverlayBtn();
  renderCaptionLang();
}

function applySelKeyState(held) {
  const next = Boolean(held);
  const changed = selKeyHeldFromPage !== next;
  selKeyHeldFromPage = next;
  if (!next && selectHeld) finishHeldSelect();
  else if (changed) syncSelKeyArmed();
}

function applyForwardedKey(data) {
  const fake = {
    key: data.key,
    code: data.code,
    metaKey: data.metaKey,
    ctrlKey: data.ctrlKey,
    altKey: data.altKey,
    shiftKey: data.shiftKey,
    type: data.phase,
    target: document.body,
    preventDefault() {}
  };
  if (data.phase === "keydown") onSidepanelHotkey(fake);
  else onSelKeyUp(fake);
}
