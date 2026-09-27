// 后台 · WebDAV 同步：定时同步、改动后防抖同步。alarm 和存储变更的监听在 background.js 注册。

const DAV_ALARM = "dav-auto-sync";
const DAV_SOON = "dav-sync-soon";
let davTimer = 0;
let davRunning = null;
let davApplying = false;

function davCfgOf(settings) {
  return {
    url: String(settings.davUrl || "").trim(),
    user: String(settings.davUser || "").trim(),
    pass: String(settings.davPass || "")
  };
}

function davLastLabel(at) {
  return self.BiliCaptionDav.formatSyncAgo(at) || "刚刚";
}

/**
 * 一轮同步实际改了什么：标记、回收站、设置、字幕备份各自的上传 / 下载 / 删除 / 冲突数。
 * 全是 0 时返回空串（这轮同步不写日志）。
 */
function davSyncChanges(result) {
  const groups = [
    ["标记", result?.marks, [["pushed", "上传"], ["pulled", "下载"], ["conflicts", "冲突"]]],
    ["回收站", result?.trash, [["pushed", "上传"], ["pulled", "下载"], ["conflicts", "冲突"]]],
    ["设置", result?.config, [["pushed", "上传"], ["pulled", "下载"]]],
    ["字幕备份", result?.subs, [["pushed", "上传"], ["deleted", "删除"], ["conflicts", "冲突副本"]]]
  ];
  const out = [];
  for (const [label, counts, fields] of groups) {
    const bits = fields
      .map(([key, word]) => [word, Number(counts?.[key]) || 0])
      .filter(([, n]) => n > 0)
      .map(([word, n]) => `${word} ${n}`);
    if (bits.length) out.push(`${label} ${bits.join("、")}`);
  }
  return out.join("；");
}

async function loadDavSettings() {
  return self.BiliCaptionPrefs.loadSettings({
    syncOn: false,
    syncMarks: true,
    syncConfig: true,
    syncKeys: false,
    syncSubs: true,
    davUrl: "",
    davUser: "",
    davPass: "",
    davConfigAt: 0,
    davLast: "",
    sttProvider: "",
    sttModel: "",
    sttChannels: [],
    backupProvider: "",
    sumProvider: "",
    apiBase: "",
    apiModel: "",
    apiKey: "",
    backupKey: "",
    sttCreds: {},
    selKey: "Shift",
    summaryPad: 10,
    translateConcurrency: 4
  });
}

async function runDavSync(reason = "auto") {
  const settings = await loadDavSettings();
  if (!settings.syncOn || !String(settings.davUrl || "").trim()) {
    return { skipped: true };
  }
  if (davRunning) return davRunning;
  davRunning = (async () => {
    davApplying = true;
    try {
      const result = await self.BiliCaptionDav.autoSync(davCfgOf(settings), settings);
      // 转写字幕与改字的备份（后台/字幕备份.js）：补传待办、顺带拉一次 subs/index.json。
      // 改标记后的防抖同步不做，免得字幕备份跟着进高频路径；它出错不算整轮同步失败。
      if (!SUB_SKIP_SYNC_REASONS.has(reason)) {
        // quiet：字幕备份的上传 / 删除数并进下面这一条同步摘要，不再另记一条
        result.subs = await syncSubtitleBackups(settings, { manual: reason === "manual", quiet: true }).catch((error) => {
          appLog("warn", "dav", `字幕备份同步失败：${error.message || error}`);
          return { error: error.message || String(error) };
        });
      }
      await self.BiliCaptionPrefs.saveSettings({
        davLast: davLastLabel(result.at),
        davAt: result.at
      });
      // 没有任何实际变化（定时同步的常态）不写日志；有变化时写一条摘要
      const changes = davSyncChanges(result);
      if (changes) appLog("info", "dav", `同步完成（${reason}）：${changes}`);
      broadcast({ type: "DAV_SYNCED", reason, ...result });
      return result;
    } catch (error) {
      const message = error.message || String(error);
      appLog("error", "dav", `同步失败：${message}`);
      broadcast({ type: "DAV_SYNC_ERROR", error: message });
      throw error;
    } finally {
      davApplying = false;
      davRunning = null;
    }
  })();
  return davRunning;
}

// 4 秒防抖定时器是主路径；alarm 只兜底 service worker 在定时器触发前被回收的情况
// （Chrome 会把短于 30 秒的 alarm 推到 30 秒）。定时器一跑就清掉 alarm，一次改动只同步一次。
function scheduleDavSync() {
  clearTimeout(davTimer);
  davTimer = setTimeout(() => {
    davTimer = 0;
    try {
      chrome.alarms?.clear?.(DAV_SOON)?.catch?.(() => {});
    } catch {
      // ignore
    }
    runDavSync("debounce").catch(() => {});
  }, 4000);
  try {
    chrome.alarms.create(DAV_SOON, { when: Date.now() + 30000 });
  } catch {
    // alarms 在部分环境不可用
  }
}

function armDavAlarm() {
  try {
    chrome.alarms.create(DAV_ALARM, { periodInMinutes: 15 });
  } catch {
    // ignore
  }
}

function onDavAlarm(alarm) {
  if (alarm?.name === DAV_SOON && davTimer) return; // 防抖定时器还在，交给它
  if (alarm?.name === DAV_ALARM || alarm?.name === DAV_SOON) {
    runDavSync(alarm.name).catch(() => {});
  }
}

// 只有真正会上传的键才触发同步（见 BiliCaptionDav.shouldSyncOnChange）：
// 浮窗透明度、位置、字幕语言这类界面偏好不进 WebDAV，改了也不该跑一次同步。
function onDavStorageChanged(changes, area) {
  if (davApplying) return;
  if (self.BiliCaptionDav?.shouldSyncOnChange?.(changes, area)) scheduleDavSync();
}
