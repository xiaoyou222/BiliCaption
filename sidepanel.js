// 侧栏入口。前面的 script 标签已按顺序加载 lib/ 和 侧栏/ 下的各模块（共享同一个全局作用域）；
// 这里只做界面事件绑定、消息 / 存储变更监听和启动。

ui.btnSettings.addEventListener("click", openSettings);
ui.btnFloat?.addEventListener("click", () => {
  if (inFloatEmbed()) return;
  const tabId = boundTabId;
  // 必须在这次点击里关掉 Chrome 侧栏。消息绕一圈再 close 会丢掉用户手势，
  // enabled:false 也不会收掉已经打开的面板，于是浮窗和侧栏叠在一起。
  if (tabId && typeof chrome.sidePanel?.close === "function") {
    chrome.sidePanel.close({ tabId }).catch(() => {});
  }
  sendToTab({ type: "OPEN_FLOAT" }).catch(() => {});
  getActiveTab().then((tab) => {
    if (tab?.windowId) chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    if (tab?.id) chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  }).catch(() => {});
});
$("openSettingsLink").addEventListener("click", openSettings);
ui.speedBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  const open = ui.speedMenu.classList.contains("hidden");
  setMoreOpen(false);
  setSpeedMenuOpen(open);
});
ui.speedMenu.addEventListener("click", (event) => {
  event.stopPropagation();
  const btn = event.target.closest("button[data-rate]");
  if (!btn) return;
  setSpeedMenuOpen(false);
  setRateFromHotkey(Number(btn.dataset.rate) || 1);
});
ui.errorPrimary.addEventListener("click", onErrorPrimary);

ui.viewTabs.addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-view]");
  if (!btn) return;
  view = btn.dataset.view;
  if (view === "outline" && !outline && state?.cues?.length) {
    // stay empty until user clicks 生成大纲
  }
  renderState(state);
});
ui.captionLang?.addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-lang]");
  if (!btn) return;
  setCaptionLang(btn.dataset.lang).catch((error) => flash(error.message || "切换字幕失败"));
});

ui.btnGenerate.addEventListener("click", generateSubtitles);
ui.btnGenerateEmpty.addEventListener("click", generateSubtitles);
$("btnCancelGen").addEventListener("click", cancelGenerate);
$("btnCancelAsrJob")?.addEventListener("click", cancelGenerate);
$("btnCancelTrJob")?.addEventListener("click", cancelTranslate);
ui.jobPillHead?.addEventListener("click", (event) => {
  event.stopPropagation();
  if (jobPillAnimating) return;
  if (jobPillOpen) collapseJobPill();
  else expandJobPill();
});
$("btnPauseAsr")?.addEventListener("click", (event) => {
  event.stopPropagation();
  if ($("btnPauseAsr")?.dataset.mode === "resume") {
    generateSubtitles();
    return;
  }
  pauseAsr(!asrPaused);
});
ui.btnChunkFold?.addEventListener("click", (event) => {
  event.stopPropagation();
  chunkListExpanded = !chunkListExpanded;
  renderAsrJobBar();
});
$("btnStopOutline")?.addEventListener("click", stopOutline);
$("btnGenOutline").addEventListener("click", generateOutline);
$("btnRegenOutline").addEventListener("click", () => {
  outline = null;
  videoSummary = "";
  resetOutlineTree();
  generateOutline();
});
$("btnCopyOutline").addEventListener("click", async () => {
  if (outlineLoading) {
    stopOutline();
    return;
  }
  if (!outline?.length && !String(videoSummary || "").trim()) return;
  await copyText(outlineText());
  flash("大纲已复制（含时间戳）");
});
$("btnOutlineMd").addEventListener("click", () => {
  if (!outline?.length && !String(videoSummary || "").trim()) return;
  const name = `${fileBase()}-outline.md`;
  downloadText(name, outlineMarkdown());
  flash(`已保存 ${name}`);
});
ui.videoSummaryToggle?.addEventListener("click", () => {
  videoSummaryOpen = !videoSummaryOpen;
  renderVideoSummary({ streaming: outlineLoading });
});
$("emptyRetryLink")?.addEventListener("click", () => retrySubtitles());

ui.outlineDensity?.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-density]");
  if (!btn || !ui.outlineDensity.contains(btn)) return;
  setOutlineDensity(btn.getAttribute("data-density"));
});

ui.outlineList.addEventListener("wheel", () => {
  userOutlineScrollAt = Date.now();
}, { passive: true });

ui.outlineList.addEventListener("click", (event) => {
  const expand = event.target.closest(".chapter-expand");
  if (expand && ui.outlineList.contains(expand)) {
    event.preventDefault();
    const row = expand.closest(".chapter");
    const i = Number(row?.dataset.index);
    if (!Number.isFinite(i)) return;
    chOpen = { ...chOpen, [i]: !chOpen[i] };
    lastOutlineIndex = -1;
    renderOutline();
    renderOutlineActive(state?.currentTime || 0);
    return;
  }
  const clock = event.target.closest(".chapter-start, .chapter-end");
  if (clock && ui.outlineList.contains(clock)) {
    event.stopPropagation();
    seekOutlineTime(Number(clock.dataset.time));
    return;
  }
  const hit = event.target.closest(".chapter-sub") || event.target.closest(".chapter");
  if (!hit || !ui.outlineList.contains(hit)) return;
  seekOutlineTime(Number(hit.dataset.start));
});

ui.cueList.addEventListener("wheel", markUserCueScroll, { passive: true });
ui.cueList.addEventListener("touchmove", markUserCueScroll, { passive: true });
ui.cueList.addEventListener("click", (event) => {
  const row = event.target.closest(".cue");
  if (!row || !ui.cueList.contains(row)) return;
  const index = Number(row.dataset.index);
  const cue = state?.cues?.[index];
  if (!cue) return;
  onCueClick(index, cue, event);
});
ui.cueList.addEventListener("dblclick", (event) => {
  const row = event.target.closest(".cue");
  if (!row || !ui.cueList.contains(row)) return;
  if (event.target.closest(".cue-edit")) return;
  const index = Number(row.dataset.index);
  startCueEdit(index);
});
ui.cueList.addEventListener("pointerdown", (event) => {
  const row = event.target.closest(".cue");
  if (row && ui.cueList.contains(row)) {
    onCuePointerDown(event, Number(row.dataset.index));
    return;
  }
  if (event.pointerType === "mouse" && event.button === 0 && !selectHeld && !selecting) {
    if (event.target === ui.cueList) markUserCueScroll();
  }
});

ui.cueList.addEventListener("pointermove", onCuePointerMove);
ui.cueList.addEventListener("pointerenter", onCuePointerMove);
ui.cueList.addEventListener("pointerup", onCuePointerUp);
ui.cueList.addEventListener("pointercancel", onCuePointerUp);
window.addEventListener("pointermove", (event) => {
  rememberPointer(event);
  if (cueEdit) return;
  // 对话面板盖在字幕列表上：在面板里按着 Shift 打字、移动鼠标，不去划选下面的字幕
  if (!selectHeld && !dragSelect && pointerInChat(event)) return;
  if (selKeyReleasedNow(event) && selectHeld) {
    finishHeldSelect();
    return;
  }
  if (selectHeld) extendHoverSelect(event);
  else if (dragSelect || selKeyDownNow(event)) onCuePointerMove(event);
});
window.addEventListener("pointerup", (event) => {
  if (dragSelect) onCuePointerUp(event);
});

ui.btnOverlay.addEventListener("click", () => setOverlayOn(!overlayOn));
ui.btnSelect.addEventListener("click", () => {
  selecting = !selecting;
  range = { start: -1, end: -1 };
  anchor = -1;
  hasSummary = false;
  show(ui.summaryBox, false);
  setLoopSel(false);
  if (selecting) pausePlayback();
  paintSelection();
});
$("btnLoopSel")?.addEventListener("click", () => setLoopSel(!loopSel));
$("btnClearSelect").addEventListener("click", () => {
  selecting = false;
  range = { start: -1, end: -1 };
  hasSummary = false;
  show(ui.summaryBox, false);
  setLoopSel(false);
  paintSelection();
});
$("btnCopy").addEventListener("click", async () => {
  const cues = selectedCues();
  if (!cues.length) return;
  try {
    await copyText(cues.map((item) => cueDisplayText(item)).join("\n"));
    markCopied($("btnCopy"), true);
  } catch {
    markCopied($("btnCopy"), false);
  }
});
$("btnSummary").addEventListener("click", summarizeSelection);
$("btnCloseSummary").addEventListener("click", closeSummary);
ui.summaryText.addEventListener("dblclick", startSummaryEdit);
$("summaryEdit")?.addEventListener("input", (event) => autoGrowSummaryEdit(event.target));
$("summaryEdit")?.addEventListener("blur", () => endSummaryEdit(false));
$("summaryEdit")?.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    endSummaryEdit(true);
  }
});
$("btnCopySummary").addEventListener("click", async () => {
  const thinking = ui.summaryThink && !ui.summaryThink.classList.contains("hidden");
  const text = ui.summaryText.textContent.trim();
  if (!text || thinking) return;
  try {
    await copyText(text);
    markCopied($("btnCopySummary"), true);
  } catch {
    markCopied($("btnCopySummary"), false);
  }
});
$("btnAddMarkerSummary")?.addEventListener("click", addMarkerFromSummary);
$("btnAddMarker")?.addEventListener("click", addManualMarker);
$("btnAddMarkerEmpty")?.addEventListener("click", addManualMarker);
$("btnMarkNow")?.addEventListener("click", addManualMarker);
$("btnLibrary")?.addEventListener("click", openLibrary);
$("btnLibraryEmpty")?.addEventListener("click", openLibrary);
$("btnMarkerMore")?.addEventListener("click", (event) => {
  event.stopPropagation();
  setMarkerMoreOpen(!markerMoreOpen);
});
$("btnCopyMarkers")?.addEventListener("click", () => {
  setMarkerMoreOpen(false);
  copyMarkers();
});
$("btnMarkerMd")?.addEventListener("click", () => {
  setMarkerMoreOpen(false);
  exportMarkers("md");
});
$("btnMarkerCsv")?.addEventListener("click", () => {
  setMarkerMoreOpen(false);
  exportMarkers("csv");
});

ui.btnMore.addEventListener("click", (event) => {
  event.stopPropagation();
  setMoreOpen(!moreOpen);
});

// 字幕助手：三个视图底部操作栏各有一个入口按钮（侧栏与浮窗是同一页面）
for (const id of CHAT_TOGGLE_IDS) $(id)?.addEventListener("click", toggleChat);
$("btnChatClose")?.addEventListener("click", closeChat);
ui.btnChatClear?.addEventListener("click", clearChat);
ui.btnChatSend?.addEventListener("click", sendChat);
ui.chatInput?.addEventListener("input", onChatInput);
ui.chatInput?.addEventListener("keydown", onChatKey);
ui.chatScroll?.addEventListener("click", onChatAreaClick);
ui.chatScroll?.addEventListener("scroll", onChatScroll, { passive: true });
document.addEventListener("click", () => {
  if (moreOpen) setMoreOpen(false);
  if (markerMoreOpen) setMarkerMoreOpen(false);
  setSpeedMenuOpen(false);
});
$("btnSrt").addEventListener("click", () => {
  if (!state?.cues?.length) return;
  const name = `${fileBase()}.srt`;
  downloadText(name, toSrt(state.cues));
  flash(`已保存 ${name}`);
  setMoreOpen(false);
});
$("btnTxt").addEventListener("click", () => {
  if (!state?.cues?.length) return;
  const name = `${fileBase()}.txt`;
  downloadText(name, state.cues.map((item) => cueDisplayText(item)).join("\n"));
  flash(`已保存 ${name}`);
  setMoreOpen(false);
});
$("btnTranslate").addEventListener("click", translateCues);
function videoCacheClearWarning(status) {
  const lines = ["清理本视频缓存会同时删除网盘上的字幕备份（转写结果和改过的字），其他电脑也取不回来了。"];
  if (status?.local === false) {
    lines.push("注意：网盘上的备份还没取回到本机，现在显示的只是官方字幕；删掉后这份转写 / 改字就找不回来了。");
  }
  lines.push("确定要清理吗？");
  return lines.join("\n\n");
}

/**
 * 「清理本视频缓存」发给后台的请求。先问后台清理会不会连带删掉网盘上的字幕备份（开了字幕同步、
 * 网盘上有这个视频的备份，包括本机取回超时、只显示了官方字幕的情况）：会的话二次确认，
 * 用户确认后消息里才带 deleteRemote: true；取消则什么都不清，返回 { canceled: true }。
 * 没开字幕同步、网盘上没有备份或查询失败时不问，也不删网盘。
 */
async function requestVideoCacheClear(bvid, cid) {
  let status = null;
  try {
    status = await chrome.runtime.sendMessage({ type: "GET_SUBTITLE_BACKUP_STATUS", bvid, cid });
  } catch {
    status = null;
  }
  const deleteRemote = Boolean(status?.remote);
  if (deleteRemote && !confirm(videoCacheClearWarning(status))) return { canceled: true };
  return chrome.runtime.sendMessage({ type: "CLEAR_VIDEO_CACHE", bvid, cid, deleteRemote });
}

$("btnClearCache")?.addEventListener("click", async () => {
  setMoreOpen(false);
  const bvid = state?.bvid || "";
  const cid = Number(state?.cid) || 0;
  if (!bvid && !cid) {
    flash("当前没有视频");
    return;
  }
  let cleared;
  try {
    cleared = await requestVideoCacheClear(bvid, cid);
  } catch (error) {
    flash(error.message || "清理缓存失败");
    return;
  }
  if (cleared?.canceled) {
    flash("已取消，本视频缓存和网盘备份都没动");
    return;
  }
  if (!cleared?.ok) {
    flash(cleared?.error || "清理缓存失败");
    return;
  }
  cancelCueEdit();
  generating = false;
  translating = false;
  asrJobId = "";
  translateJobId = "";
  asrProgress = null;
  translateProgress = { done: 0, total: 0 };
  stopAsrWatch();
  stopTranslateWatch();
  translatedCueText = new Map();
  translatedCueRanges = [];
  translatedCueVideoKey = translationVideoKey(state);
  outline = null;
  lastRenderKey = "";
  await refresh(true).catch(() => renderState({ page: "video" }));
  if (state?.cues?.length && ["bilibili", "youtube", "x"].includes(state.source)) {
    flash("已清理转写、翻译和大纲缓存，已重新加载官方字幕");
  } else {
    flash("已清理本视频的转写、翻译和大纲缓存");
  }
});

/**
 * 后台处理 WebDAV 字幕备份冲突后的通知（SUBS_BACKUP_NOTICE）：是当前视频就提示一句（含冲突副本在网盘上的路径）；
 * 本机字幕已被换成网盘上的版本（replaced）时放弃正在改的那一行、重读字幕，免得拿旧字幕回写盖掉别人的改字。
 */
function onSubsBackupNotice(message) {
  if (!state || message.bvid !== state.bvid || Number(message.cid) !== Number(state.cid)) return;
  if (message.notice) flash(message.notice, 8000);
  if (message.replaced && !generating && !translating) {
    cancelCueEdit();
    refresh(true).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!isForThisPanel(message, sender)) return;
  if (message?.type === "SUBS_BACKUP_NOTICE") {
    onSubsBackupNotice(message);
    return;
  }
  if (message?.type === "DAV_SYNCED") {
    loadMarkers(state).then(() => {
      if (view === "markers") renderMarkers();
    }).catch(() => {});
    return;
  }
  if (message?.type === "SEL_KEY_STATE") {
    applySelKeyState(Boolean(message.held));
    return;
  }
  if (message?.type === "LOOP_ENDED") {
    loopSel = false;
    lastLoopSent = "";
    renderLoopBtn();
    return;
  }
  if (message?.type === "PANEL_KEY" || message?.type === "BC_DOCK_KEY") {
    applyForwardedKey(message);
    return;
  }
  // TIME 现在走 connectTimePort 的长连接；RATE（倍速变化，低频）仍走广播。
  if (message?.type === "TIME" || message?.type === "RATE") {
    applyPlaybackTick(message);
  }
  if (message?.type === "ASR_PROGRESS") {
    if (message.tabId && boundTabId && message.tabId !== boundTabId && !inFloatEmbed()) {
      if (!(message.bvid && state?.bvid && message.bvid === state.bvid)) return;
    }
    if (state?.bvid && !sameAsrVideo(message)) return;
    if (message.jobId) asrJobId = message.jobId;
    if (message.stage === "error" || message.stage === "canceled") {
      generating = false;
      asrProgress = null;
      asrJobId = "";
      asrSwitchNote = "";
      clearTimeout(asrSwitchNoteTimer);
      clearInterval(asrWaitTimer);
      stopAsrWatch();
      if (message.cues?.length) {
        const cues = applyRememberedTranslations(message.cues);
        const translated = translatedCueText.size > 0;
        state = {
          ...(state || {}),
          cues,
          source: translated ? "translated" : "groq",
          activeLan: translated ? "translated" : "groq-asr",
          origin: "asr",
          partial: true,
          asrDone: Number(message.done) || Number(state?.asrDone) || 0,
          asrTotal: Number(message.total) || Number(state?.asrTotal) || 0
        };
      }
      if (message.stage === "error") {
        asrStopReason = message.message || "转写失败";
        if (state?.cues?.length) {
          flash(`转写已停止：${asrStopReason}`, 6000);
        }
        else genError = message.message || "转写失败";
      }
      renderState(state || { page: "video" });
      return;
    }
    if (message.stage === "done") {
      // partial：有分段失败或额度等待超时，按部分完成收尾，进度已保存，可点「继续生成」补齐
      const partial = message.partial === true;
      generating = false;
      asrProgress = null;
      asrJobId = "";
      asrStopReason = partial ? (message.message || "") : "";
      asrSwitchNote = "";
      clearTimeout(asrSwitchNoteTimer);
      clearInterval(asrWaitTimer);
      stopAsrWatch();
      if (message.cues?.length) {
        const cues = applyRememberedTranslations(message.cues);
        const translated = translatedCueText.size > 0;
        state = {
          ...(state || {}),
          cues,
          source: translated ? "translated" : "groq",
          activeLan: translated ? "translated" : "groq-asr",
          origin: "asr",
          partial,
          ...(partial
            ? {
              asrDone: Number(message.done) || Number(state?.asrDone) || 0,
              asrTotal: Number(message.total) || Number(state?.asrTotal) || 0
            }
            : {})
        };
      }
      renderState(state || { page: "video" });
      flash(message.message || "字幕生成完成", partial ? 6000 : undefined);
      return;
    }
    generating = true;
    applyAsrProgress(message);
    // 后台被回收后自动续跑的任务，侧栏之前可能已判定中断、停了轮询，这里重新盯上
    if (!asrWatchTimer) startAsrWatch();
    if (!state?.cues?.length) renderGenProgress(message.stage, message.message || "");
  }
  if (message?.type === "TRANSLATE_PROGRESS") {
    if (message.tabId && boundTabId && message.tabId !== boundTabId && !inFloatEmbed()) return;
    // 还没拿到页面状态（侧栏启动途中）时不接管：否则 translating 先变 true，refresh 提前返回、
    // 不去读页面状态，界面卡在「不是视频页」。进行中的翻译由 refresh 里的 attachRunningTranslate 接上。
    if (!sameAsrVideo(message)) return;
    if (message.jobId) translateJobId = message.jobId;
    if (message.stage === "error" || message.stage === "canceled" || message.stage === "done") {
      translating = false;
      translateJobId = "";
      translateProgress = { done: 0, total: 0 };
      stopTranslateWatch();
      applyTranslateProgress({ ...message, running: false });
      translating = false;
      renderAsrJobBar();
      if (message.stage === "error") flash(message.message || "翻译失败", 6000);
      else if (message.stage === "done") flash(message.message || "翻译完成");
      return;
    }
    translating = true;
    applyTranslateProgress(message);
    startTranslateWatch();
  }
  if (message?.type === "STATE" && message.payload) {
    const incoming = message.payload;
    const incomingPending = incoming.subtitleStatus === "pending" || incoming.page === "loading";
    if (
      incomingPending
      && !incoming.cues?.length
      && state?.cues?.length
      && incoming.bvid
      && incoming.bvid === state.bvid
    ) {
      return;
    }
    const switched = Boolean(
      (incoming.bvid && state?.bvid && incoming.bvid !== state.bvid)
      || (incoming.bvid && incoming.bvid === state?.bvid && incoming.cid && state?.cid
        && Number(incoming.cid) !== Number(state.cid))
    );
    if (switched) stopJobsForVideoSwitch();
    else if (outlineLoading) return;
    else if (translating) {
      // 页面缓存仍是断句前的英文字幕。翻译进度自己带 cues，
      // 这里若再套上去，滑动列表时会把已译中文整表打回英文。
      return;
    }
    if (generating && !switched) {
      if (incoming.cues?.length && sameAsrVideo(incoming)) {
        const cues = applyRememberedTranslations(incoming.cues);
        const translated = translatedCueText.size > 0;
        state = {
          ...state,
          ...incoming,
          cues,
          source: translated ? "translated" : incoming.source,
          activeLan: translated ? "translated" : incoming.activeLan
        };
        renderCues();
        renderAsrJobBar();
      }
      return;
    }
    renderState(incoming);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  // 字幕助手开着时，在设置页配好总结服务就收起「还没配置」的提示
  if (chatOpen && (changes.apiKey || changes.sumProvider || changes.apiBase)) {
    chatController().checkConfig().catch(() => {});
  }
  if (area === "local") {
    if (changes.groqApiKey || changes.sttKey || changes.sttCreds) {
      loadPrefs().catch(() => {});
    }
  }
  if (area !== "sync") return;
  if (changes.preferSidebar && changes.preferSidebar.newValue === false) {
    hideChromePanelIfFloating();
  }
  if (changes.sttProvider) loadPrefs().catch(() => {});
  if (changes.selKey) selKey = changes.selKey.newValue || "Shift";
  if (changes.overlayOn) {
    overlayOn = changes.overlayOn.newValue !== false;
    renderOverlayBtn();
  }
  if (changes.captionLang) {
    const next = changes.captionLang.newValue === "en" ? "en" : "zh";
    if (next !== captionLang) {
      cancelCueEdit();
      captionLang = next;
      lastCuesSig = "";
      renderCaptionLang();
      renderCues();
    }
  }
  if (changes.summaryPad) {
    summaryPad = Math.min(50, Math.max(0, Math.round(Number(changes.summaryPad.newValue) || 10)));
  }
});

if (!inFloatEmbed()) {
  chrome.windows.getCurrent().then((win) => {
    panelWindowId = win?.id || 0;
  }).catch(() => {});
  chrome.tabs.onActivated.addListener((info) => {
    if (panelWindowId && info.windowId && info.windowId !== panelWindowId) return;
    boundTabId = info.tabId;
    hideChromePanelIfFloating();
    refresh(false);
  });
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (tabId !== boundTabId) return;
    if (info.status === "complete" || info.url) {
      if (info.url) hideChromePanelIfFloating();
      refresh(Boolean(info.url) || tabVideoChanged(info.url || tab?.url || ""));
    }
  });
  setInterval(() => {
    if (!boundTabId || inFloatEmbed() || retrying) return;
    if (BiliCaptionPlatforms.isRateLimited(`${state?.error || ""}${state?.notice || ""}`)) return;
    chrome.tabs.get(boundTabId).then((tab) => {
      if (tabVideoChanged(tab?.url || "") || state?.subtitleStatus === "pending" || state?.page === "loading") refresh(true);
    }).catch(() => {});
  }, 1500);
}

chrome.storage.local.get({ lastVideo: null }).then((data) => {
  lastVideo = data.lastVideo;
  renderLastVideoHint();
});

loadPrefs().then(() => {
  if (state) renderState(state);
});
bindFloatTab().then(async () => {
  if (!inFloatEmbed()) {
    const prefs = await loadDockUiPrefs();
    if (prefs.preferSidebar) {
      await sendToTab({ type: "CLOSE_FLOAT" }).catch(() => {});
    } else {
      await hideChromePanelIfFloating();
      return;
    }
  }
  await refresh(false);
});
window.addEventListener("keydown", onSidepanelHotkey, true);
window.addEventListener("keyup", onSelKeyUp, true);
window.addEventListener("blur", onSelKeyUp);
