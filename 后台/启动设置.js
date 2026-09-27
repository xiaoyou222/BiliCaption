// 后台 · 启动设置：侧栏在支持的站点上可用、下载音频时改 Referer 的规则、安装后给已开标签页补注入
// 内容脚本，以及浮窗切换时关闭 / 打开 Chrome 侧栏。调用都在 background.js 的启动代码和消息路由里。

function enableSidePanel(tabId) {
  const options = { enabled: true, path: "sidepanel.html" };
  const task = tabId
    ? chrome.sidePanel.setOptions({ ...options, tabId })
    : chrome.sidePanel.setOptions(options);
  return task.catch(() => {});
}

function enableAllBiliPanels() {
  enableSidePanel();
  chrome.tabs.query({ url: [...BiliCaptionPlatforms.TAB_URL_PATTERNS] }, (tabs) => {
    for (const tab of tabs) enableSidePanel(tab.id);
  });
}

async function installAudioRefererRules() {
  const rule = {
    id: 1001,
    priority: 2,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "Referer", operation: "set", value: "https://www.bilibili.com/" }
      ]
    },
    condition: {
      requestDomains: ["bilivideo.com", "bilivideo.cn", "akamaized.net", "hdslb.com"],
      resourceTypes: ["xmlhttprequest", "other"],
      initiatorDomains: [chrome.runtime.id]
    }
  };
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1001],
      addRules: [rule]
    });
  } catch (error) {
    // 不去掉 initiatorDomains 降级重试：那会把 Referer 改写扩大到全浏览器流量
    console.warn("[BiliCaption] dnr rules", error);
    appLog("warn", "net", `改 Referer 规则安装失败：${error.message || error}`);
  }
}

function injectBiliContentScripts() {
  chrome.tabs.query({ url: [...BiliCaptionPlatforms.TAB_URL_PATTERNS] }, (tabs) => {
    for (const tab of tabs) {
      if (!tab.id) continue;
      // 与 manifest、侧栏补注入共用同一份清单（lib/视频平台.js）
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [...BiliCaptionPlatforms.CONTENT_SCRIPT_FILES]
      }).catch(() => {});
    }
  });
}

// 关掉已打开的侧栏必须用 close()。setOptions({enabled:false}) 只禁止下次打开，
// 当前面板常常还挂在那里，于是浮窗和侧栏会叠在一起。
function hideChromeSidePanel(tabId, windowId) {
  if (typeof chrome.sidePanel?.close === "function") {
    if (tabId) return chrome.sidePanel.close({ tabId }).catch(() => {});
    if (windowId) return chrome.sidePanel.close({ windowId }).catch(() => {});
    return Promise.resolve();
  }
  if (!tabId) return Promise.resolve();
  return chrome.sidePanel.setOptions({ tabId, enabled: false }).catch(() => {});
}

function showChromeSidePanel(tabId, windowId) {
  if (tabId) enableSidePanel(tabId);
  if (tabId) return chrome.sidePanel.open({ tabId });
  if (windowId) return chrome.sidePanel.open({ windowId });
  return Promise.resolve();
}
