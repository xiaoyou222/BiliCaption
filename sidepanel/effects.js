// 侧栏 · 动效：思考中的点阵球、边框光效、文字流光，以及生成字幕时的步骤提示。

function startOrb(host, options) {
  try {
    return globalThis.mountThinkingOrb?.(host, options) || (() => {});
  } catch {
    return () => {};
  }
}

function setBeam(el, on) {
  const api = globalThis.BiliCaptionBorderBeam;
  if (!api || !el) return;
  if (on) api.attach(el, { strength: 0.7 });
  else api.detach(el);
}

function showSummaryThinking(on) {
  if (on) {
    if (stopSummaryOrb) return;
    if (!ui.summaryThink) return;
    show(ui.summaryThink, true);
    stopSummaryOrb = startOrb(ui.summaryThink, { state: "composing", size: 20, speed: 0.7, iconOnly: true, label: "" });
    setShimmer(ui.summaryTitle, true, "正在总结…");
    return;
  }
  stopSummaryOrb?.();
  stopSummaryOrb = null;
  if (ui.summaryThink) show(ui.summaryThink, false);
  setShimmer(ui.summaryTitle, false, "选区总结");
}

function showOutlineThinking(on) {
  if (on) {
    if (stopOutlineOrb) return;
    if (ui.outlineThink) {
      stopOutlineOrb = startOrb(ui.outlineThink, { state: "composing", size: 20, speed: 0.7, iconOnly: true, label: "" });
    }
    return;
  }
  stopOutlineOrb?.();
  stopOutlineOrb = null;
}

function setShimmer(el, on, text) {
  if (!el) return;
  if (text != null) el.textContent = text;
  el.classList.toggle("is-shimmer", Boolean(on));
  if (on) el.setAttribute("data-shimmer", el.textContent || "");
  else el.removeAttribute("data-shimmer");
}

function setOrbLabel(host, label) {
  const text = host?.querySelector(".think-pill-label");
  if (!text) return;
  text.dataset.text = label;
  text.textContent = label;
}

function showAsrSegOrb(on) {
  if (!on) {
    stopAsrSegOrb?.();
    stopAsrSegOrb = null;
    if (ui.asrSegOrb) ui.asrSegOrb.replaceChildren();
    return;
  }
  if (stopAsrSegOrb || !ui.asrSegOrb) return;
  stopAsrSegOrb = startOrb(ui.asrSegOrb, {
    state: "searching",
    size: 13,
    speed: 0.9,
    iconOnly: true,
    label: ""
  });
}

function showOutlineEmptyOrb(on) {
  if (!on) {
    stopOutlineEmptyOrb?.();
    stopOutlineEmptyOrb = null;
    if (ui.outlineEmptyOrb) {
      ui.outlineEmptyOrb.replaceChildren();
      show(ui.outlineEmptyOrb, false);
    }
    return;
  }
  if (!ui.outlineEmptyOrb) return;
  show(ui.outlineEmptyOrb, true);
  if (stopOutlineEmptyOrb) return;
  stopOutlineEmptyOrb = startOrb(ui.outlineEmptyOrb, { state: "composing", size: 64, speed: 0.6, iconOnly: true, label: "" });
}

function showPillOrb(on) {
  if (!on) {
    stopPillOrb?.();
    stopPillOrb = null;
    if (ui.jobPillOrb) ui.jobPillOrb.replaceChildren();
    return;
  }
  if (stopPillOrb || !ui.jobPillOrb) return;
  stopPillOrb = startOrb(ui.jobPillOrb, {
    state: "searching",
    size: 13,
    speed: 0.9,
    iconOnly: true,
    label: ""
  });
}

function showGenerateThinking(on, label) {
  if (label) lastGenLabel = label;
  if (!on) {
    stopGenerateOrb?.();
    stopGenerateOrb = null;
    return;
  }
  const text = lastGenLabel || `${GEN_STEPS[0]}…`;
  if (stopGenerateOrb) {
    setOrbLabel(ui.genThink, text);
    return;
  }
  if (ui.genThink) {
    stopGenerateOrb = startOrb(ui.genThink, { state: "searching", size: 20, speed: 0.6, label: text });
  }
}

function renderGenProgress(stage = "start", message = "") {
  if (message) {
    showGenerateThinking(true, message);
    return;
  }
  let step = 0;
  if (stage === "upload") step = 1;
  else if (stage === "done") step = 2;
  showGenerateThinking(true, `${GEN_STEPS[step]}…`);
}
