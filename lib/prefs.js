(function (global) {
  const SECRET_KEYS = ["groqApiKey", "sttKey", "sttCreds", "sttChannels", "apiKey", "backupKey", "davPass"];

  function hasSecretValue(key, value) {
    if (key === "sttCreds") {
      return Boolean(value && typeof value === "object" && Object.keys(value).length);
    }
    if (key === "sttChannels") {
      return Array.isArray(value) && value.length > 0;
    }
    return value != null && value !== "";
  }

  async function loadSettings(defaults = {}) {
    const [sync, local] = await Promise.all([
      chrome.storage.sync.get(defaults),
      chrome.storage.local.get(SECRET_KEYS)
    ]);
    const out = { ...sync };
    const migrate = {};
    for (const key of SECRET_KEYS) {
      if (hasSecretValue(key, local[key])) out[key] = local[key];
      else if (hasSecretValue(key, sync[key])) {
        out[key] = sync[key];
        migrate[key] = sync[key];
      }
    }
    if (Object.keys(migrate).length) {
      await chrome.storage.local.set(migrate);
    }
    await chrome.storage.sync.remove(SECRET_KEYS).catch(() => {});
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

  global.BiliCaptionPrefs = { SECRET_KEYS, loadSettings, saveSettings };
})(globalThis);
