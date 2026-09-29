importScripts("lib/视频平台.js", "lib/字幕工具.js", "lib/md5.js", "lib/wbi.js", "lib/mp4-aac.js", "lib/zh-simp.js", "lib/translate.js", "lib/模型路由.js", "lib/模型调用.js", "lib/providers.js", "lib/stt.js", "lib/prefs.js", "lib/markers.js", "lib/webdav.js", "后台/基础.js", "后台/启动设置.js", "后台/同步.js", "后台/字幕备份.js", "后台/缓存.js", "后台/B站接口.js", "后台/YouTube与X.js", "后台/字幕获取.js", "后台/音频下载.js", "后台/翻译任务.js", "后台/转写通道.js", "后台/转写分段.js", "后台/切句.js", "后台/转写调度.js", "后台/转写任务.js");

// 后台入口。上面按顺序加载 lib/ 和 后台/ 下的各模块（共享同一个全局作用域，后台/ 里只做声明）；
// 这里只留三件事：消息来源校验、service worker 启动时必须同步注册的事件监听、消息路由。

// ---- 消息来源校验 ----

function isExtensionPage(sender) {
  const url = String(sender?.url || "");
  // 浮窗 iframe 用了 use_dynamic_url：随机 ID 的地址在浏览器里会被 307 到真实扩展 ID，
  // 所以 sender.url 仍是 chrome-extension://<扩展 ID>/…
  return url.startsWith(`chrome-extension://${chrome.runtime.id}/`);
}

function isBiliContent(sender) {
  const url = String(sender?.url || sender?.tab?.url || "");
  try {
    return BiliCaptionPlatforms.isSupportedHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

// 内容脚本真实会发给后台的消息（grep content.js 的 sendMessage / askBackground / postRuntime 核对过）。
// RATE、STATE、SEL_KEY_STATE、PANEL_KEY、LOOP_ENDED 是发给侧栏的，后台不处理。
const CONTENT_MESSAGE_TYPES = new Set([
  "WHOAMI",
  "LOAD_SUBTITLES",
  "FETCH_CUES",
  "SAVE_CUES_CACHE",
  "GET_MARKERS",
  "CLOSE_SIDE_PANEL",
  "RESTORE_SIDE_PANEL"
]);

// 只接受扩展页（侧栏、浮窗 iframe、设置页）。列在这里是为了给内容脚本回「无权调用」；
// 不在任何清单里的类型，内容脚本发来也一律不处理。
const EXTENSION_MESSAGE_TYPES = new Set([
  "GET_LOGIN",
  "GET_ASR_JOB",
  "CANCEL_ASR",
  "PAUSE_ASR",
  "RETRY_ASR_CHUNK",
  "GENERATE_ASR",
  "GET_TRANSLATE_JOB",
  "GET_LOGS",
  "CLEAR_LOGS",
  "APPEND_LOG",
  "START_TRANSLATE",
  "CANCEL_TRANSLATE",
  "TRANSLATE_SEEK",
  "CLEAR_VIDEO_CACHE",
  "DAV_SYNC_NOW",
  "GET_CACHE_USAGE",
  "CLEAR_RENEWABLE_CACHE",
  "PRUNE_ARTICLE_CACHE",
  "GET_SUBTITLE_BACKUP_STATUS",
  "GET_HOT_COMMENTS"
]);

function allowMessage(type, sender) {
  if (isExtensionPage(sender)) return true;
  if (isBiliContent(sender) && CONTENT_MESSAGE_TYPES.has(type)) return true;
  return false;
}

// ---- 启动：以下都在 service worker 首次同步执行时完成 ----

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.warn("[BiliCaption]", error));

enableAllBiliPanels();
installAudioRefererRules();
resumePendingTranslateJobs();
chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});
// onInstalled / onStartup 各只注册一次；WebDAV 定时同步、缓存淘汰（字幕缓存分层淘汰 + 大纲 / 索引）也在这里一起做。
chrome.runtime.onInstalled.addListener(() => {
  enableAllBiliPanels();
  installAudioRefererRules();
  chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});
  injectBiliContentScripts();
  armDavAlarm();
  runDavSync("install").catch(() => {});
  pruneLocalCaches().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  enableAllBiliPanels();
  installAudioRefererRules();
  resumePendingTranslateJobs();
  armDavAlarm();
  runDavSync("startup").catch(() => {});
  pruneLocalCaches().catch(() => {});
});

chrome.alarms?.onAlarm?.addListener(onDavAlarm);
chrome.storage.onChanged?.addListener(onDavStorageChanged);

// 只监听 YouTube 播放器的字幕请求和 X 的 HLS 清单（.m3u8），视频 / 音频分片不会每片唤醒一次 service worker。
chrome.webRequest?.onCompleted?.addListener(onYoutubeCueCompleted, { urls: [...BiliCaptionPlatforms.YOUTUBE_CUE_URL_PATTERNS] });
chrome.webRequest?.onCompleted?.addListener(onXManifestCompleted, X_MANIFEST_FILTER);
// 关标签页：丢掉该页捕获的字幕 / 清单地址，并取消该页上暂停中的转写
chrome.tabs.onRemoved?.addListener((tabId) => {
  forgetTabCaptures(tabId);
  cancelPausedAsrForTab(tabId);
});

// service worker 每次启动都检查一次；GET_ASR_JOB 会先等它做完
const asrResumeScan = resumeInterruptedAsrJobs().catch(() => {});

// ---- 消息路由 ----

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = message?.type;
  // 默认拒绝：内容脚本只能调白名单里的类型；扩展页专用的类型回「无权调用」，其余（发给侧栏的广播）直接忽略。
  if (!allowMessage(type, _sender)) {
    if (EXTENSION_MESSAGE_TYPES.has(type)) {
      sendResponse({ error: "无权调用" });
      return true;
    }
    return false;
  }
  const tabId = isExtensionPage(_sender)
    ? (Number(message?.tabId) || _sender.tab?.id || 0)
    : (Number(_sender.tab?.id) || 0);
  const reply = (promise) => {
    Promise.resolve(promise)
      .then(sendResponse)
      .catch((error) => sendResponse({ error: error.message || String(error) }));
    return true;
  };

  if (message?.type === "WHOAMI") {
    sendResponse({ tabId: _sender.tab?.id || 0, windowId: _sender.tab?.windowId });
    return true;
  }
  if (message?.type === "LOAD_SUBTITLES") {
    return reply(loadSubtitles(message.page, tabId, { force: Boolean(message.force) }));
  }
  if (message?.type === "GET_HOT_COMMENTS") {
    // 生成大纲时取一次热评；fetchHotComments 自带超时，失败回空列表
    return reply(fetchHotComments(message.aid));
  }
  if (message?.type === "GET_LOGIN") {
    return reply(fetchLoginStatus());
  }
  if (message?.type === "GET_MARKERS") {
    const loading = self.BiliCaptionMarkers
      ? self.BiliCaptionMarkers.load(message.bvid || "", Number(message.cid) || 0)
      : [];
    return reply(
      Promise.resolve(loading).then((list) => ({
        markers: (list || []).map((m) => ({
          id: m.id,
          time: Number(m.time) || 0,
          text: String(m.text || "")
        }))
      }))
    );
  }
  if (message?.type === "SAVE_CUES_CACHE") {
    // edited：侧栏 / 浮窗里用户手动改字或批量替换才带 true，后台据此记 editedAt；翻译回写等其它保存不带。
    // origin：页面加载字幕时记下的来源类别，本地还没有条目时据此建（不再把没带来源的保存默认成转写）
    return reply(saveCachedAsr(message.bvid, message.cid, {
      cues: clampCues(message.cues),
      activeLan: message.activeLan || "",
      source: message.source || ""
    }, { edited: message.edited === true, originHint: message.origin }).then(() => ({ ok: true })));
  }
  if (message?.type === "CLEAR_VIDEO_CACHE") {
    // deleteRemote：侧栏确认过「会同时删除网盘上的字幕备份」才带 true
    return reply(clearVideoCache(message.bvid || "", Number(message.cid) || 0, { deleteRemote: message.deleteRemote === true }));
  }
  if (message?.type === "GET_SUBTITLE_BACKUP_STATUS") {
    return reply(subtitleBackupStatus(message.bvid || "", Number(message.cid) || 0));
  }
  if (message?.type === "GET_CACHE_USAGE") {
    return reply(getSubtitleCacheUsage());
  }
  if (message?.type === "CLEAR_RENEWABLE_CACHE") {
    return reply(clearRenewableSubtitleCache());
  }
  if (message?.type === "PRUNE_ARTICLE_CACHE") {
    // 侧栏写入一篇文章总结后调用：文章缓存超出数量 / 体积上限时删最旧的
    return reply(pruneArticleCache());
  }
  if (message?.type === "GET_LOGS") {
    // keep：分级保留规则，设置页据此写「保留 7 天 / 24 小时」并在收到新日志时同样裁剪
    return reply(getAppLogs().then((logs) => ({ logs, keep: LOG_KEEP })));
  }
  if (message?.type === "CLEAR_LOGS") {
    return reply(clearAppLogs());
  }
  if (message?.type === "APPEND_LOG") {
    return reply(appLog(message.level || "info", message.scope || "set", message.message || "", message.extra));
  }
  if (message?.type === "GET_ASR_JOB") {
    return reply(getAsrJobStatus(message));
  }
  if (message?.type === "CANCEL_ASR") {
    const ok = cancelAsrJob(message.jobId, {
      bvid: message.bvid,
      cid: message.cid,
      tabId: message.tabId
    });
    sendResponse({ ok });
    return true;
  }
  if (message?.type === "PAUSE_ASR") {
    sendResponse(pauseAsrJob({
      jobId: message.jobId,
      bvid: message.bvid,
      cid: message.cid,
      tabId: message.tabId
    }, message.paused !== false));
    return true;
  }
  if (message?.type === "RETRY_ASR_CHUNK") {
    sendResponse(retryAsrChunks({
      jobId: message.jobId,
      bvid: message.bvid,
      cid: message.cid,
      tabId: message.tabId
    }, {
      index: message.index
    }));
    return true;
  }
  if (message?.type === "FETCH_CUES") {
    return reply(
      fetchTrackCues(message, tabId).catch((error) => ({
        error: error.message || String(error),
        cues: []
      }))
    );
  }
  if (message?.type === "GENERATE_ASR") {
    sendResponse(startAsr({
      jobId: message.jobId,
      tabId,
      aid: message.aid,
      cid: message.cid,
      bvid: message.bvid,
      p: message.p,
      epId: message.epId,
      seasonId: message.seasonId,
      title: message.title,
      part: message.part,
      force: Boolean(message.force)
    }, _sender));
    return true;
  }
  if (message?.type === "GET_TRANSLATE_JOB") {
    return reply(getTranslateJobStatus(message));
  }
  if (message?.type === "CANCEL_TRANSLATE") {
    return reply(cancelTranslateJob(message.jobId, {
      bvid: message.bvid,
      cid: message.cid,
      tabId: message.tabId
    }).then((ok) => ({ ok })));
  }
  if (message?.type === "START_TRANSLATE") {
    return reply(startTranslate({
      jobId: message.jobId,
      tabId,
      bvid: message.bvid,
      cid: message.cid,
      title: message.title,
      currentTime: message.currentTime,
      cues: clampCues(message.cues),
      // 侧栏上这份字幕的来源：本地条目已不在（刚清掉可再生缓存）时，译文按它记来源类别
      source: message.source || "",
      origin: message.origin || ""
    }, _sender));
  }
  if (message?.type === "TRANSLATE_SEEK") {
    sendResponse(reprioritizeTranslateJob(message));
    return true;
  }
  if (message?.type === "CLOSE_SIDE_PANEL") {
    const tabId = _sender.tab?.id;
    const windowId = _sender.tab?.windowId;
    hideChromeSidePanel(tabId, windowId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === "DAV_SYNC_NOW") {
    return reply(runDavSync(message.reason || "manual"));
  }
  if (message?.type === "RESTORE_SIDE_PANEL") {
    const tabId = _sender.tab?.id;
    const windowId = _sender.tab?.windowId;
    // 必须立刻 open()，前面不能 await，否则点「侧栏」会丢掉用户手势
    showChromeSidePanel(tabId, windowId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  return false;
});
