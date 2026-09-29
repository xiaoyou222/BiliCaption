// 侧栏 · 页面状态：把后台 / 内容脚本给的字幕状态画到界面上，切视频、刷新和出错重试。

function renderState(next) {
  resetTranslationsFor(next);
  if (next?.cues?.length && translatedCueText.size) {
    next = {
      ...next,
      cues: hydrateCueOriginals(applyRememberedTranslations(next.cues)),
      source: "translated",
      activeLan: "translated"
    };
  } else if (next?.cues?.length) {
    next = { ...next, cues: hydrateCueOriginals(next.cues) };
  }
  state = next;
  ensureRecommendation(next);
  // 字幕助手跟上当前视频：换视频就切到那个视频自己的对话
  syncChatVideo(next);
  applyPlatformChrome(next);
  renderLogin(next?.login || lastLogin, next);
  renderHeaderTitle(next);

  const noScript = Boolean(
    next?.page === "no-script" || next?.error?.includes("Could not establish connection")
  );
  const isOther = !next || next.page === "other";

  if (isOther && !noScript) {
    setLoopSel(false);
    show(ui.noVideoView, true);
    show(ui.videoView, false);
    show(ui.speedSelect, false);
    if (ui.noVideoTitle) ui.noVideoTitle.textContent = platformLabels(next).other;
    return;
  }

  show(ui.noVideoView, false);
  show(ui.videoView, true);
  persistLastVideo(next);

  const renderKey = `${next?.bvid || ""}:${next?.cid || ""}:${next?.aid || ""}`;
  if (renderKey && renderKey !== lastRenderKey) {
    view = "captions";
    cancelCueEdit();
    selecting = false;
    selectHeld = false;
    dragSelect = null;
    hoverSelectFrom = null;
    range = { start: -1, end: -1 };
    anchor = -1;
    captionLangPinned = false;
    setLoopSel(false);
    hasSummary = false;
    summaryMarkTime = NaN;
    ui.summaryText.textContent = "";
    if (outlineLoading) {
      outlineAbort?.abort();
      outlineAbort = null;
      outlineLoading = false;
    }
    outline = null;
    videoSummary = "";
    videoSummaryOpen = true;
    resetOutlineTree();
    lastRenderKey = renderKey;
    loadOutlineCache(next).then(() => {
      if (outlineKey(state) === outlineKey(next)) renderState(state);
    });
    loadMarkers(next).then(() => {
      if (marksVideoKey(state) === marksVideoKey(next)) {
        if (view === "markers") renderMarkers();
        updateSummaryMarkerBtn();
      }
    });
  }

  const loggedIn = Boolean(lastLogin?.isLogin);
  const hasCues = Boolean(next?.cues?.length);
  const copy = platformLabels(next);
  let isPending = next?.subtitleStatus === "pending" || next?.page === "loading";
  if (isPending) {
    if (!pendingShownAt) pendingShownAt = Date.now();
    if (Date.now() - pendingShownAt >= 12000) {
      isPending = false;
      next = {
        ...next,
        page: next.page === "loading" ? "video" : next.page,
        subtitleStatus: "fetch_failed",
        error: next.error || next.notice || "读取视频信息超时，请确认已开始播放正片后重试",
        notice: ""
      };
      state = next;
    } else if (!pendingUiTimer) {
      pendingUiTimer = setTimeout(() => {
        pendingUiTimer = 0;
        if (state && (state.subtitleStatus === "pending" || state.page === "loading")) renderState(state);
      }, Math.max(200, 12000 - (Date.now() - pendingShownAt)));
    }
  } else {
    pendingShownAt = 0;
    if (pendingUiTimer) {
      clearTimeout(pendingUiTimer);
      pendingUiTimer = 0;
    }
  }
  const combinedError = `${genError || ""} ${next?.error || ""} ${lastLogin?.error || ""}`;
  const netLogin = /无法确认登录|请求失败|Failed to fetch|NetworkError|网络/i.test(combinedError);
  const loginError = noScript ? false : Boolean(genError && /登录/.test(genError) && !loggedIn && !netLogin);
  const showLoginEmpty = !isPending && !["youtube", "x"].includes(next?.platform) && !generating && !hasCues && !loggedIn && !netLogin && (loginError || (Boolean(next?.error) && /登录/.test(next.error || "") && !/无法确认登录/.test(next.error || "")));
  const showNetLogin = !isPending && !generating && !hasCues && !noScript && netLogin;
  const showGenError = !isPending && !generating && Boolean(genError) && !hasCues && !showLoginEmpty && !showNetLogin;
  const onVideoReady = !isPending && !showLoginEmpty && !showNetLogin && !showGenError && !noScript;
  const isEmpty = onVideoReady && !hasCues && !generating && view !== "markers";
  const hasList = onVideoReady && (hasCues || generating);
  const onCaptions = hasList && view === "captions";
  const onOutline = hasList && view === "outline";
  const onMarkers = onVideoReady && view === "markers";

  show(ui.speedSelect, true);
  show(ui.viewTabs, !noScript && (hasList || onMarkers || generating || translating || isEmpty || isPending));

  ui.viewTabs.querySelectorAll("button[data-view]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
  syncCaptionLangFromState(next);
  renderCaptionLang();

  renderSpeed(next.rate || 1);

  const fetchFailed = isEmpty && (
    next?.subtitleStatus === "fetch_failed"
    || String(next?.error || "") === "没拿到字幕列表"
  );
  if (ui.emptyTitle) {
    // B 站：「要登录才有字幕」「字幕与时长对不上 / 下载失败」「读不到当前集」都不能说成「这个视频没有字幕」
    const bili = (next?.platform || "bilibili") === "bilibili";
    const biliNotice = bili ? String(next?.notice || "").trim() : "";
    const biliError = bili && !next?.subtitleStatus ? String(next?.error || "").trim() : "";
    ui.emptyTitle.textContent = isEmpty && next?.subtitleStatus === "login"
      ? (biliNotice || "登录 B 站后才能获取字幕")
      : fetchFailed
        ? (biliNotice || "没拿到字幕列表")
        : (isEmpty && biliError) || "这个视频没有字幕";
  }
  show(ui.emptyView, isEmpty);
  if (ui.emptyFetchHint) show(ui.emptyFetchHint, fetchFailed || (isEmpty && next.canGenerate === false));
  show(ui.btnGenerateEmpty, next.canGenerate !== false);
  if (isEmpty && next.canGenerate === false && ui.emptyTitle) ui.emptyTitle.textContent = next.error || next.notice || "未发现可读取的字幕，请开启播放器字幕后刷新";
  if (isPending) {
    if (ui.emptyTitle) {
      const text = `${next.notice || ""}${next.error || ""}`;
      ui.emptyTitle.textContent = retrying
        ? copy.waiting
        : /广告/.test(text)
          ? copy.ad
          : /请先播放/.test(text)
            ? (next.notice || next.error || copy.waiting)
            : copy.waiting;
    }
    show(ui.emptyView, true);
    show(ui.emptyFetchHint, retrying);
    show(ui.btnGenerateEmpty, false);
    show(ui.emptyKeyHint, false);
    show(ui.errorView, false);
    if (retrying) paintRetryChrome(true);
  }
  if (isEmpty) show(ui.emptyKeyHint, !hasSttKey && next.canGenerate !== false);
  else if (!isPending) show(ui.emptyKeyHint, false);

  show(ui.generatingView, false);
  showGenerateThinking(false);
  renderAsrJobBar();

  errorMode = "";
  if (noScript) {
    errorMode = "refresh";
    show(ui.errorView, true);
    ui.errorTitle.textContent = "请刷新这个视频标签页";
    ui.errorPrimary.textContent = "刷新";
    show(ui.emptyView, false);
  } else if (showNetLogin) {
    errorMode = "retryState";
    show(ui.errorView, true);
    ui.errorTitle.textContent = ["youtube", "x"].includes(next.platform) ? (next.error || "字幕请求失败，请刷新后重试") : "无法确认登录状态，请检查网络后重试";
    ui.errorPrimary.textContent = "重试";
  } else if (showLoginEmpty) {
    errorMode = "login";
    show(ui.errorView, true);
    ui.errorTitle.textContent = copy.loginError;
    ui.errorPrimary.textContent = "去登录";
  } else if (showGenError) {
    errorMode = "retry";
    show(ui.errorView, true);
    ui.errorTitle.textContent = genError;
    ui.errorPrimary.textContent = "重试";
  } else {
    show(ui.errorView, false);
  }

  const outlineRows = Boolean(outline?.length);
  const hasVideoSummary = Boolean(String(videoSummary || "").trim());
  const outlineContent = outlineRows || hasVideoSummary;
  const outlineBoot = onOutline && outlineLoading && !outlineContent;
  show(ui.outlineHead, onOutline && outlineLoading && outlineContent);
  if (ui.outlineHeadLabel && outlineLoading && outlineContent) {
    const n = Math.max(1, outline?.length || 1);
    setShimmer(ui.outlineHeadLabel, true, outlineRows ? `正在生成大纲 · 第 ${n} 段` : "正在生成大纲");
  } else if (ui.outlineHeadLabel) {
    setShimmer(ui.outlineHeadLabel, false);
  }
  showOutlineThinking(onOutline && outlineLoading && outlineContent);

  const outlineEmptyShown = onOutline && !outlineLoading && !outlineContent;
  show(ui.outlineEmpty, outlineEmptyShown || outlineBoot);
  if (outlineBoot) {
    setShimmer(ui.outlineEmptyLabel, true, "AI 正在阅读全文字幕…");
    show($("btnGenOutline"), false);
    showOutlineEmptyOrb(true);
  } else {
    showOutlineEmptyOrb(false);
    if (outlineEmptyShown) {
      // 设计稿：大纲为空且不在生成时不显示提示文字，只留「生成大纲」按钮
      setShimmer(ui.outlineEmptyLabel, false, "");
      show($("btnGenOutline"), true);
    } else {
      setShimmer(ui.outlineEmptyLabel, false);
    }
  }
  if (ui.outlineEmptyLabel) show(ui.outlineEmptyLabel, Boolean(ui.outlineEmptyLabel.textContent));

  renderVideoSummary({ streaming: outlineLoading && hasVideoSummary });
  show(ui.outlineList, onOutline && outlineRows);
  if (onOutline && outlineRows) {
    renderOutline();
    renderOutlineActive(next.currentTime || 0);
  } else {
    renderOutlineMeta();
  }

  show(ui.cueWrap || ui.cueList, onCaptions);
  show(ui.summaryBox, onCaptions && hasSummary);
  syncSelectChrome(onCaptions);
  // 流式期间底部条也在：第一个按钮变「停止生成」（设计稿 outlineActions）
  show(ui.outlineBar, onOutline && outlineContent);
  if (onOutline && outlineContent) {
    const copyBtn = $("btnCopyOutline");
    if (copyBtn) copyBtn.textContent = outlineLoading ? "停止生成" : "复制大纲";
  }
  show($("markerView"), onMarkers);
  show($("markerBar"), onMarkers && markers.length > 0);
  if (onMarkers) renderMarkers();
  else if (hasSummary) updateSummaryMarkerBtn();

  if (onCaptions) {
    const generated = next.source === "groq" || next.activeLan === "groq-asr";
    show(ui.btnGenerate, !next.partial && next.canGenerate !== false);
    ui.btnGenerate.textContent = generating ? "转写中" : generated ? "重新生成" : "生成字幕";
    ui.btnGenerate.disabled = generating;
    if (typeof next.overlayOn === "boolean") overlayOn = next.overlayOn;
    renderOverlayBtn();
    renderCues();
  } else if (!onCaptions) {
    ui.cueList.classList.remove("selecting");
    syncSelKeyArmed();
  }
  renderChatChrome();
}

async function refreshLoginOnly(platform) {
  if (["youtube", "x"].includes(platform)) {
    renderLogin({ platform }, { platform });
    return;
  }
  try {
    renderLogin(await chrome.runtime.sendMessage({ type: "GET_LOGIN" }));
  } catch {
    renderLogin(null);
  }
}

function siteSwitchLoadingState(tabUrl = "") {
  const site = BiliCaptionPlatforms.platform(tabUrl || "") || "";
  const parsed = BiliCaptionPlatforms.parse(tabUrl || "");
  const copy = BiliCaptionPlatforms.labels(site);
  return {
    page: "loading",
    platform: site || parsed?.platform || "",
    bvid: parsed?.bvid || extractBvidFromUrl(tabUrl || ""),
    cid: parsed && parsed.kind !== "other" ? 1 : 0,
    title: "",
    cues: [],
    tracks: [],
    login: ["youtube", "x"].includes(site) ? { platform: site } : undefined,
    canGenerate: site === "x",
    subtitleStatus: "pending",
    notice: copy.waiting,
    error: ""
  };
}

function officialCacheIdentity(tabUrl = "") {
  const parsed = BiliCaptionPlatforms.parse(tabUrl || "");
  if (parsed && (parsed.kind === "youtube" || parsed.kind === "x") && parsed.bvid) {
    return { bvid: parsed.bvid, cid: 1, platform: parsed.kind };
  }
  const bvid = extractBvidFromUrl(tabUrl || "");
  if (!bvid || /^yt_|^x_/.test(bvid)) return null;
  return { bvid, cid: 0, platform: "bilibili" };
}

function stateFromOfficialCache(cached, identity) {
  if (!cached?.cues?.length || !identity?.bvid) return null;
  const platform = identity.platform || "";
  return {
    page: "video",
    platform,
    bvid: identity.bvid,
    cid: Number(identity.cid) || 1,
    title: cached.title || "",
    titleFull: cached.titleFull || "",
    up: cached.up || "",
    pic: cached.pic || "",
    duration: Number(cached.durationMeta) || 0,
    durationMeta: Number(cached.durationMeta) || 0,
    cues: cached.cues,
    tracks: Array.isArray(cached.tracks) ? cached.tracks : [],
    activeLan: cached.activeLan || "",
    source: cached.source || platform,
    canGenerate: platform === "x",
    partial: Boolean(cached.partial),
    subtitleStatus: "",
    notice: "",
    error: "",
    login: ["youtube", "x"].includes(platform) ? { platform } : undefined
  };
}

async function peekOfficialCache(tabUrl = "") {
  const identity = officialCacheIdentity(tabUrl);
  if (!identity) return null;
  if (identity.platform === "bilibili" && !identity.cid) {
    const index = await chrome.storage.local.get(`asrIndex:${identity.bvid}`);
    identity.cid = Number(index[`asrIndex:${identity.bvid}`]) || 0;
    if (!identity.cid) return null;
  }
  const key = `asr:${identity.bvid}:${identity.cid}`;
  const data = await chrome.storage.local.get(key);
  return stateFromOfficialCache(data[key], identity);
}

function tabVideoChanged(tabUrl) {
  const site = BiliCaptionPlatforms.platform(tabUrl || "");
  if (state?.platform && site && site !== state.platform) return true;
  if (state?.page === "video" && site !== (state.platform || "bilibili")) return true;
  const external = BiliCaptionPlatforms.parse(tabUrl || "");
  if (external?.kind === "other" && state?.page === "video") return true;
  if (external?.kind === "x" && !external.explicitMedia && state?.bvid?.startsWith(`x_${external.videoId}_`)) return false;
  const bvid = extractBvidFromUrl(tabUrl || "");
  const epId = extractEpIdFromUrl(tabUrl || "");
  if (bvid && state?.bvid && bvid !== state.bvid) return true;
  if (epId && state?.epId && epId !== state.epId) return true;
  if (bvid && !state?.bvid && state?.page === "video") return true;
  return false;
}

function stopJobsForVideoSwitch() {
  cancelRecommendation();
  cancelCueEdit();
  translating = false;
  generating = false;
  asrProgress = null;
  translateProgress = { done: 0, total: 0 };
  stopTranslateWatch();
  stopAsrWatch();
  outlineAbort?.abort();
  outlineLoading = false;
}

async function refresh(force = false, options = {}) {
  genError = "";
  try {
    const tab = await getActiveTab();
    if (tab?.id && !inFloatEmbed()) boundTabId = tab.id;
    const switched = tabVideoChanged(tab?.url || "");
    // 任务进行中不重读页面，但前提是已经在显示视频页；启动途中先读到页面状态再说
    if ((outlineLoading || generating || translating) && !force && !switched && state?.page === "video") {
      if (tab?.id && BiliCaptionPlatforms.platform(tab?.url || "")) connectTimePort(tab.id);
      return;
    }
    if (switched) {
      stopJobsForVideoSwitch();
      const cached = await peekOfficialCache(tab?.url || "");
      renderState(cached || siteSwitchLoadingState(tab?.url || ""));
    }
    const site = BiliCaptionPlatforms.platform(tab?.url || "");
    if (!site) {
      dropTimePort();
      renderState({ page: "other" });
      await refreshLoginOnly();
      return;
    }
    const bypassCache = Boolean(options.force);
    const next = await sendToTab({
      type: bypassCache || force ? "REFRESH" : "GET_STATE",
      force: bypassCache
    }, tab.id);
    renderState(next);
    // 内容脚本已确认在线：连上进度长连接（同一标签页已连着就什么都不做）
    timePortFails = 0;
    connectTimePort(tab.id);
    const asrOn = await attachRunningAsr(next);
    const trOn = await attachRunningTranslate(next);
    if (asrOn || trOn) renderState(state || next);
    if (!next?.login && site === "bilibili") await refreshLoginOnly();
  } catch (error) {
    // 读不到这个标签页：断开之前那个标签页的播放进度连接，免得旧页面的进度还在驱动高亮
    dropTimePort();
    const tab = await getActiveTab().catch(() => null);
    const site = BiliCaptionPlatforms.platform(tab?.url || "");
    renderState({ page: "no-script", error: error.message, platform: site || undefined });
    await refreshLoginOnly(site);
  }
}

function extractBvidFromUrl(url = "") {
  const external = globalThis.BiliCaptionPlatforms?.parse(url);
  if (external) return external.bvid || "";
  const fromPath = url.match(/\/video\/(BV[\w]+)/i)?.[1];
  if (fromPath) return fromPath;
  try {
    return new URL(url).searchParams.get("bvid") || "";
  } catch {
    return "";
  }
}

function extractEpIdFromUrl(url = "") {
  return url.match(/\/bangumi\/play\/ep(\d+)/)?.[1] || "";
}

function extractSeasonIdFromUrl(url = "") {
  return url.match(/\/bangumi\/play\/ss(\d+)/)?.[1] || "";
}

function paintRetryChrome(on) {
  const link = $("emptyRetryLink");
  if (link) {
    link.disabled = on;
    link.textContent = on ? "正在重试…" : "重试";
  }
  if (ui.errorPrimary && (errorMode === "retryState" || !errorMode)) {
    ui.errorPrimary.disabled = on;
    if (on) ui.errorPrimary.textContent = "正在重试…";
  }
}

function retryLoadingState() {
  const site = state?.platform || "";
  const copy = BiliCaptionPlatforms.labels(site);
  return {
    ...(state || {}),
    page: "loading",
    subtitleStatus: "pending",
    cues: [],
    notice: copy.waiting,
    error: ""
  };
}

async function retrySubtitles() {
  if (retrying) return;
  retrying = true;
  renderState(retryLoadingState());
  paintRetryChrome(true);
  try {
    await refresh(true, { force: true });
  } finally {
    retrying = false;
    paintRetryChrome(false);
    if (state) renderState(state);
  }
}

function onErrorPrimary() {
  if (errorMode === "login") openBiliLogin();
  else if (errorMode === "retry") generateSubtitles();
  else if (errorMode === "refresh") reloadBoundTab();
  else if (errorMode === "retryState") retrySubtitles();
  else retrySubtitles();
}
