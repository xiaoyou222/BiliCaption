// 侧栏 · 标签页通信：找到绑定的视频标签页，给内容脚本发消息（收不到时补注入），
// 以及与内容脚本的播放进度长连接。

async function loadDockUiPrefs() {
  const data = await chrome.storage.sync.get(BiliCaptionPrefs.DOCK_UI_DEFAULTS);
  return BiliCaptionPrefs.readDockUiPrefs(data);
}

async function hideChromePanelIfFloating() {
  if (inFloatEmbed()) return;
  const prefs = await loadDockUiPrefs();
  if (prefs.preferSidebar) return;
  const tab = await getActiveTab().catch(() => null);
  const articleTab = globalThis.BiliCaptionArticlePanel?.resolveTab ? await globalThis.BiliCaptionArticlePanel.resolveTab(tab) : tab;
  if (!articleTab || articleTab.articleMode === 'pending' || globalThis.BiliCaptionArticle?.isArticleURL(articleTab.url, articleTab.articleMode)) return false;
  if (tab?.id && typeof chrome.sidePanel?.close === "function") {
    chrome.sidePanel.close({ tabId: tab.id }).catch(() => {});
    return true;
  }
  if (panelWindowId && typeof chrome.sidePanel?.close === "function") {
    chrome.sidePanel.close({ windowId: panelWindowId }).catch(() => {});
    return true;
  }
}

function isForThisPanel(message, sender) {
  const tabId = Number(message?.tabId || sender?.tab?.id) || 0;
  if (inFloatEmbed()) {
    if (myTabId && tabId && tabId !== myTabId) return false;
    return true;
  }
  if (boundTabId && tabId && tabId !== boundTabId) return false;
  return true;
}

async function getActiveTab() {
  if (inFloatEmbed() && myTabId) {
    try {
      return await chrome.tabs.get(myTabId);
    } catch {
      // fall through
    }
  }
  if (boundTabId) {
    try {
      const tab = await chrome.tabs.get(boundTabId);
      if (tab) return tab;
    } catch {
      // fall through
    }
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function pingTab(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return Boolean(res?.ok);
  } catch {
    return false;
  }
}

async function ensureContentScript(tabId) {
  if (!tabId) return false;
  if (await pingTab(tabId)) return true;
  // 浮窗就在 content script 挂的 iframe 里。PING 瞬时失败再注入会拆掉
  // #bilicaption-dock，当前页跟着卸掉，于是再挂、再 PING、再闪。
  if (inFloatEmbed()) return false;
  if (!chrome.scripting?.executeScript) return false;
  try {
    // 与 manifest、后台补注入同一份清单：平台模块必须和 content.js 一起补，
    // 扩展停用再启用不会触发 onInstalled，只注入 content.js 时 YouTube / X 会被当成非视频页。
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [...BiliCaptionPlatforms.CONTENT_SCRIPT_FILES]
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    return pingTab(tabId);
  } catch {
    return false;
  }
}

// 只有「页面里没有内容脚本接收」才值得补注入重试；其它错误原样抛出。
function isNoReceiverError(error) {
  return /Receiving end does not exist|Could not establish connection/i.test(error?.message || String(error || ""));
}

function waitTabComplete(tabId, timeout = 20000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const timer = setTimeout(finish, timeout);
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        finish();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab?.status === "complete") {
        clearTimeout(timer);
        finish();
      }
    }).catch(() => {
      clearTimeout(timer);
      finish();
    });
  });
}

// 直接发；失败且是「没有接收方」时才补注入再发一次，不再每条消息前先 PING。
async function sendToTab(message, tabId = 0) {
  let id = tabId || (inFloatEmbed() ? myTabId : boundTabId);
  if (!id) {
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error("没有活动标签页");
    if (!inFloatEmbed()) boundTabId = tab.id;
    id = tab.id;
  }
  try {
    return await chrome.tabs.sendMessage(id, message);
  } catch (error) {
    if (!isNoReceiverError(error)) throw error;
    if (!(await ensureContentScript(id))) throw error;
    return chrome.tabs.sendMessage(id, message);
  }
}

// 播放进度：TIME 来自与内容脚本的长连接，RATE 仍来自广播，处理方式相同。
function applyPlaybackTick(message) {
  if (message.currentTime != null) noteTranslateSeek(message.currentTime);
  if (state) {
    if (message.currentTime != null) state.currentTime = message.currentTime;
    if (message.duration != null) state.duration = message.duration;
    if (message.rate != null) state.rate = message.rate;
  }
  if (message.currentTime != null) {
    highlight(message.currentTime || 0);
    if (view === "markers" || view === "captions") renderMarkerBar();
  }
  if (message.rate != null) renderSpeed(message.rate);
}

// 与当前标签页内容脚本的进度长连接（port 名 "bc-time"）。内容脚本只在有连接时才推送 TIME，
// 侧栏关掉、页面卸载时连接自动断开；断开后按退避重连，换标签页时改连新标签页。
const TIME_PORT_NAME = "bc-time";
let timePort = null;
let timePortTabId = 0;
let timePortRetryTimer = 0;
let timePortFails = 0;

function timePortTarget() {
  return inFloatEmbed() ? myTabId : boundTabId;
}

function dropTimePort() {
  clearTimeout(timePortRetryTimer);
  timePortRetryTimer = 0;
  const port = timePort;
  timePort = null;
  timePortTabId = 0;
  if (port) {
    try {
      port.disconnect();
    } catch {
      // ignore
    }
  }
}

function scheduleTimePortRetry() {
  clearTimeout(timePortRetryTimer);
  // 非视频页、页面没有内容脚本时别一直重连；refresh() 成功后会再连
  if (!timePortTarget() || !state || state.page === "other" || state.page === "no-script") return;
  if (timePortFails >= 6) return;
  const delay = Math.min(8000, 500 * 2 ** timePortFails);
  timePortFails += 1;
  timePortRetryTimer = setTimeout(() => {
    timePortRetryTimer = 0;
    connectTimePort();
  }, delay);
}

function connectTimePort(tabId = timePortTarget()) {
  if (!tabId || !chrome.tabs?.connect) return;
  if (timePort && timePortTabId === tabId) return;
  dropTimePort();
  let port;
  try {
    port = chrome.tabs.connect(tabId, { name: TIME_PORT_NAME });
  } catch {
    scheduleTimePortRetry();
    return;
  }
  timePort = port;
  timePortTabId = tabId;
  port.onMessage.addListener((message) => {
    if (timePort !== port || message?.type !== "TIME") return;
    timePortFails = 0;
    applyPlaybackTick(message);
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (timePort !== port) return;
    timePort = null;
    timePortTabId = 0;
    scheduleTimePortRetry();
  });
}

async function reloadBoundTab() {
  try {
    const tab = await getActiveTab();
    const tabId = tab?.id || boundTabId || myTabId;
    if (!tabId) {
      flash("找不到要刷新的标签");
      return;
    }
    if (!inFloatEmbed()) boundTabId = tabId;
    await chrome.tabs.reload(tabId);
    await waitTabComplete(tabId);
    await ensureContentScript(tabId);
    await refresh(true, { force: true });
  } catch (error) {
    flash(error.message || "刷新失败");
  }
}

async function bindFloatTab() {
  if (!inFloatEmbed()) return;
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id) {
      myTabId = tab.id;
      boundTabId = tab.id;
      return;
    }
  } catch {
    // ignore
  }
  try {
    const me = await chrome.runtime.sendMessage({ type: "WHOAMI" });
    myTabId = Number(me?.tabId) || 0;
    boundTabId = myTabId;
  } catch {
    // ignore
  }
}
