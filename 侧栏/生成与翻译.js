// 侧栏 · 生成与翻译：发起 / 取消无字幕转写和批量翻译（任务本身在后台跑）。

async function generateSubtitles() {
  if (state?.canGenerate === false) { flash("该平台暂不支持无字幕音频转写"); return; }
  if (generating) return;
  cancelCueEdit();

  const sttSettings = await BiliCaptionPrefs.loadSettings({
    groqApiKey: "",
    sttKey: "",
    sttProvider: "Groq",
    sttCreds: {},
    sttChannels: []
  });
  const P = globalThis.BiliCaptionProviders;
  const channels = P?.resolveChannels?.(sttSettings) || [];
  const usable = channels.filter((cfg) => P?.channelUsable?.(cfg));
  if (!usable.length) {
    flash("请先在设置里添加并配置好转写通道");
    openSettings();
    return;
  }

  const token = ++generateToken;
  const jobId = `${Date.now()}-${token}`;
  asrJobId = jobId;
  generating = true;
  genError = "";
  asrStopReason = "";
  if (state?.cues?.length) {
    asrProgress = {
      done: Number(state.asrDone) || 0,
      total: Number(state.asrTotal) || 0,
      waitUntil: 0,
      message: "准备继续转写…",
      stage: "start"
    };
  }
  renderGenProgress("start", "准备生成字幕…", 4);
  renderState(state || { page: "video" });

  let backgroundStarted = false;
  try {
    const tab = await getActiveTab();
    const frozenTabId = tab?.id || boundTabId || myTabId;
    let meta = {
      aid: Number(state?.aid) || 0,
      cid: Number(state?.cid) || 0,
      bvid: state?.bvid || extractBvidFromUrl(tab?.url || ""),
      p: 1,
      epId: extractEpIdFromUrl(tab?.url || ""),
      seasonId: extractSeasonIdFromUrl(tab?.url || ""),
      title: state?.title || ""
    };

    try {
      const snap = await sendToTab({ type: "GET_META" }, frozenTabId);
      if (snap) {
        meta = {
          aid: Number(snap.aid) || meta.aid,
          cid: Number(snap.cid) || meta.cid,
          bvid: snap.bvid || meta.bvid || extractBvidFromUrl(snap.href || ""),
          p: Number(snap.p || snap.page?.p) || meta.p,
          epId: snap.epId || snap.page?.epId || meta.epId,
          seasonId: snap.seasonId || snap.page?.seasonId || "",
          title: snap.title || meta.title
        };
      }
    } catch {
      // background 再补
    }

    if (!meta.bvid && !meta.epId && !meta.seasonId && (!meta.aid || !meta.cid)) {
      const site = platformLabels(state).site;
      throw new Error(["youtube", "x"].includes(state?.platform)
        ? `${site}暂不支持无字幕转写`
        : "请先打开 B 站视频播放页，再点生成");
    }
    if (!meta.cid && !meta.epId && !meta.seasonId) {
      throw new Error("无法确认当前分 P，请刷新后再生成");
    }
    if (token !== generateToken) return;

    const data = await chrome.runtime.sendMessage({
      type: "GENERATE_ASR",
      jobId,
      tabId: frozenTabId,
      aid: meta.aid,
      cid: meta.cid,
      bvid: meta.bvid,
      p: meta.p,
      epId: meta.epId,
      seasonId: meta.seasonId,
      title: meta.title,
      force: Boolean(state?.source === "groq" && !state?.partial && state?.cues?.length)
    });
    if (token !== generateToken) return;
    if (data?.error) throw new Error(data.error);
    if (data?.started) {
      backgroundStarted = true;
      asrJobId = data.jobId || asrJobId;
      startAsrWatch();
      return;
    }

    const merged = {
      ...(state || {}),
      page: "video",
      aid: data.aid || meta.aid,
      cid: data.cid || meta.cid,
      bvid: data.bvid || meta.bvid,
      title: data.title || meta.title || state?.title || "",
      part: data.part || state?.part || "",
      cues: data.cues || [],
      activeLan: data.activeLan || "groq-asr",
      source: data.source || "groq",
      error: "",
      canGenerate: true,
      partial: false
    };

    try {
      await sendToTab({
        type: "APPLY_ASR_CUES",
        cues: data.cues,
        activeLan: data.activeLan,
        source: data.source,
        partial: false,
        aid: merged.aid,
        cid: merged.cid,
        bvid: merged.bvid,
        title: merged.title
      }, frozenTabId);
    } catch {
      // 贴到生成时的那个标签；侧栏可能已经切走
    }
    generating = false;
    if (boundTabId && frozenTabId && Number(boundTabId) !== Number(frozenTabId)) {
      await refresh(true);
    } else {
      try {
        const next = await sendToTab({ type: "GET_STATE" }, frozenTabId);
        renderState(next?.page ? { ...merged, ...next } : merged);
      } catch {
        renderState(merged);
      }
    }
    flash(`已生成 ${data.cues?.length || 0} 条字幕`);
  } catch (error) {
    if (token !== generateToken) return;
    generating = false;
    if (state?.cues?.length) {
      state = { ...state, partial: true };
      flash(error.message || "转写中断，已保存进度，可继续生成");
      renderState(state);
    } else {
      genError = error.message || String(error);
      renderState(state || { page: "video" });
    }
  } finally {
    if (token === generateToken && !backgroundStarted) {
      generating = false;
      asrJobId = "";
      asrProgress = null;
      clearInterval(asrWaitTimer);
      stopAsrWatch();
    }
  }
}

function cancelGenerate() {
  const jobId = asrJobId;
  generateToken += 1;
  generating = false;
  genError = "";
  asrStopReason = "";
  asrProgress = null;
  clearInterval(asrWaitTimer);
  stopAsrWatch();
  if (jobId) {
    chrome.runtime.sendMessage({
      type: "CANCEL_ASR",
      jobId,
      bvid: state?.bvid,
      cid: state?.cid,
      tabId: boundTabId || myTabId
    }).catch(() => {});
  }
  asrJobId = "";
  flash("已取消，已完成的段落会留着");
  refresh(true).catch(() => renderState(state || { page: "video" }));
}

function commitTranslatedCues(next) {
  state = {
    ...state,
    cues: next.map((cue) => ({ ...cue })),
    source: "translated",
    activeLan: "translated"
  };
  renderCues();
  sendToTab({
    type: "SYNC_CUES",
    cues: state.cues,
    source: "translated",
    activeLan: "translated",
    bvid: state.bvid || "",
    cid: Number(state.cid) || 0
  }).catch(() => {});
}

function updateTranslateLock() {
  const btn = $("btnTranslate");
  if (!btn) return;
  const lock = Boolean(generating);
  btn.disabled = lock;
  btn.title = lock ? "转写完成后再翻译，否则只会译到当前已有的句子" : "";
}

async function translateCues() {
  if (!state?.cues?.length || translating) return;
  if (generating) {
    flash("请等转写完成后再翻译");
    return;
  }
  cancelCueEdit();
  setMoreOpen(false);

  const settings = await BiliCaptionPrefs.loadSettings({
    sumProvider: "OpenAI",
    apiBase: "",
    apiKey: ""
  });
  const cfg = globalThis.BiliCaptionProviders.resolveSum(settings);
  if (!cfg.key) {
    flash("请先在设置里配置总结服务和 API Key");
    openSettings();
    return;
  }
  if (!cfg.base) {
    flash("请先在设置里填写接口地址");
    openSettings();
    return;
  }
  await ensureApiOrigin(cfg.base);

  try {
    // 带上当前播放位置：后台先译这附近的批次，再往后，最后回头补前面。
    translateSeekAt = Number(state.currentTime) || 0;
    const started = await chrome.runtime.sendMessage({
      type: "START_TRANSLATE",
      tabId: boundTabId || myTabId,
      bvid: state.bvid,
      cid: state.cid,
      title: state.title || "",
      currentTime: translateSeekAt,
      cues: state.cues
    });
    if (started?.error) {
      flash(started.error);
      return;
    }
    if (started?.empty) {
      if (started.cues?.length) commitTranslatedCues(started.cues);
      flash("已经是中文，不用翻译");
      return;
    }
    translating = true;
    translateJobId = started.jobId || "";
    translateProgress = {
      done: Number(started.done) || 0,
      total: Number(started.total) || 0,
      stage: started.stage || "run"
    };
    if (started.cues?.length) {
      rememberCuesFromJob(started.cues);
      state = {
        ...state,
        cues: started.cues,
        source: "translated",
        activeLan: "translated"
      };
      renderCues();
    }
    renderAsrJobBar();
    startTranslateWatch();
  } catch (error) {
    flash(error.message || "翻译启动失败");
  }
}

function cancelTranslate() {
  const jobId = translateJobId;
  translating = false;
  translateProgress = { done: 0, total: 0 };
  stopTranslateWatch();
  renderAsrJobBar();
  if (jobId || state?.bvid || state?.cid) {
    chrome.runtime.sendMessage({
      type: "CANCEL_TRANSLATE",
      jobId,
      bvid: state?.bvid,
      cid: state?.cid,
      tabId: boundTabId || myTabId
    }).catch(() => {});
  }
  translateJobId = "";
  flash("已取消翻译，已译出的句子会留着");
}
