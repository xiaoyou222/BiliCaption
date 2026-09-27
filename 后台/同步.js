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

async function loadDavSettings() {
  return self.BiliCaptionPrefs.loadSettings({
    syncOn: false,
    syncMarks: true,
    syncConfig: true,
    syncKeys: false,
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
      await self.BiliCaptionPrefs.saveSettings({
        davLast: davLastLabel(result.at),
        davAt: result.at
      });
      appLog("info", "dav", `同步完成（${reason}）`, result.marks);
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
