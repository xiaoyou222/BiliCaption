(function (global) {
  const SECRET_KEYS = ["groqApiKey", "sttKey", "sttCreds", "sttChannels", "apiKey", "backupKey", "davPass"];
  const DOCK_UI_DEFAULTS = { dockOpen: false, preferSidebar: true };
  const UI_FONT = '"Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

  function readDockUiPrefs(data = {}) {
    const preferSidebar = data.preferSidebar !== false;
    return {
      preferSidebar,
      dockOpen: data.dockOpen === true && !preferSidebar
    };
  }

  function hasSecretValue(key, value) {
    if (key === "sttCreds") {
      return Boolean(value && typeof value === "object" && Object.keys(value).length);
    }
    if (key === "sttChannels") {
      return Array.isArray(value) && value.length > 0;
    }
    return value != null && value !== "";
  }

  // 旧版把密钥存在 sync 里。每个页面 / 后台只查一次：确有旧键才搬到 local 并从 sync 删除，
  // 否则每次读设置都 remove 一遍，会白白占用 sync 的写入配额（每小时 1800 次）。
  let legacyChecked = null;

  function migrateLegacySecrets(local) {
    if (legacyChecked) return legacyChecked;
    legacyChecked = (async () => {
      const legacy = await chrome.storage.sync.get(SECRET_KEYS).catch(() => ({}));
      const found = SECRET_KEYS.filter((key) => legacy && Object.prototype.hasOwnProperty.call(legacy, key));
      if (!found.length) return {};
      const migrate = {};
      for (const key of found) {
        if (!hasSecretValue(key, local[key]) && hasSecretValue(key, legacy[key])) migrate[key] = legacy[key];
      }
      if (Object.keys(migrate).length) await chrome.storage.local.set(migrate);
      await chrome.storage.sync.remove(found).catch(() => {
        // 删除失败下次再试，已搬到 local 的值不受影响
        legacyChecked = null;
      });
      return migrate;
    })();
    return legacyChecked;
  }

  async function loadSettings(defaults = {}) {
    const [sync, local] = await Promise.all([
      chrome.storage.sync.get(defaults),
      chrome.storage.local.get(SECRET_KEYS)
    ]);
    const migrated = await migrateLegacySecrets(local);
    const out = { ...sync };
    for (const key of SECRET_KEYS) {
      if (hasSecretValue(key, local[key])) out[key] = local[key];
      else if (hasSecretValue(key, migrated[key])) out[key] = migrated[key];
      else if (hasSecretValue(key, sync[key])) out[key] = sync[key];
    }
    return out;
  }

  async function saveSettings(data) {
    const secrets = {};
    const rest = {};
    for (const [key, value] of Object.entries(data || {})) {
      if (SECRET_KEYS.includes(key)) secrets[key] = value;
      else rest[key] = value;
    }
    const tasks = [];
    if (Object.keys(secrets).length) tasks.push(chrome.storage.local.set(secrets));
    if (Object.keys(rest).length) tasks.push(chrome.storage.sync.set(rest));
    await Promise.all(tasks);
    if (Object.keys(secrets).length) {
      await chrome.storage.sync.remove(SECRET_KEYS.filter((key) => key in secrets)).catch(() => {});
    }
  }

  global.BiliCaptionPrefs = {
    SECRET_KEYS,
    DOCK_UI_DEFAULTS,
    UI_FONT,
    readDockUiPrefs,
    loadSettings,
    saveSettings
  };
})(globalThis);
