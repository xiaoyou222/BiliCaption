// 后台 · 对话记录：本机长期保存，与字幕缓存和 WebDAV 同步分开。
// 所有读写共用一个队列；revision 防同一对话被旧页面覆盖，generation 防清空全部后旧页面写回。
// 这里只声明函数，首次收到对话消息时才迁移旧 session 记录。
const CHAT_HISTORY_PREFIX = "chat:";
const CHAT_HISTORY_STATE_KEY = "chatHistoryState";
let chatHistoryQueue = Promise.resolve();
let chatHistoryInitialized = false;

function chatHistoryKey(value) {
  const key = String(value || "");
  if (!key.startsWith(CHAT_HISTORY_PREFIX) || !key.slice(CHAT_HISTORY_PREFIX.length).trim()) {
    throw new Error("对话记录标识无效");
  }
  return key;
}

function chatHistoryNumber(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function chatHistoryMessages(value) {
  const result = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (!item || (item.role !== "user" && item.role !== "ai")) continue;
    const text = String(item.text ?? "");
    if (item.role === "user" && !text.trim()) continue;
    const next = { id: String(item.id || ""), role: item.role, text, at: Number(item.at) || 0 };
    if (item.role === "ai" && (item.status === "error" || item.status === "aborted")) next.status = item.status;
    result.push(next);
  }
  return result;
}

async function chatHistoryKeys(area) {
  if (!area) return [];
  const keys = typeof area.getKeys === "function" ? await area.getKeys() : Object.keys(await area.get(null) || {});
  return keys.filter((key) => key.startsWith(CHAT_HISTORY_PREFIX));
}

async function chatHistoryState() {
  const raw = (await chrome.storage.local.get(CHAT_HISTORY_STATE_KEY))?.[CHAT_HISTORY_STATE_KEY];
  return { generation: chatHistoryNumber(raw?.generation), clientId: String(raw?.clientId || "") };
}

async function initializeChatHistory() {
  if (chatHistoryInitialized) return;
  const area = chrome.storage.local;
  const state = await chatHistoryState();
  const legacy = chrome.storage.session;
  const keys = await chatHistoryKeys(legacy);
  if (keys.length && state.generation === 0) {
    const [old, local] = await Promise.all([legacy.get(keys), area.get(keys)]);
    const additions = {};
    for (const key of keys) {
      // 空记录也是用户清空后的有效记录，不能被旧 session 覆盖。
      if (Object.prototype.hasOwnProperty.call(local, key)) continue;
      const messages = chatHistoryMessages(old?.[key]);
      additions[key] = { messages, revision: 1, generation: state.generation, clientId: "migration" };
    }
    if (Object.keys(additions).length) await area.set(additions);
  }
  // 仅在新记录写成功后删除旧记录。清空全部后的新世代只清旧 session，绝不再导入。
  if (keys.length) await legacy.remove(keys);
  chatHistoryInitialized = true;
}

function withChatHistory(task) {
  const next = chatHistoryQueue.then(async () => {
    await initializeChatHistory();
    return task();
  });
  chatHistoryQueue = next.catch(() => {});
  return next;
}

function chatHistoryRecord(raw, generation) {
  // 兼容迁移前曾直接写入 local 的数组，首次正式写入即升级为带版本的记录。
  if (Array.isArray(raw) && generation === 0) {
    return { messages: chatHistoryMessages(raw), revision: 0, generation, clientId: "" };
  }
  if (!raw || raw.generation !== generation) return { messages: [], revision: 0, generation, clientId: "" };
  return {
    messages: chatHistoryMessages(raw.messages),
    revision: chatHistoryNumber(raw.revision),
    generation,
    clientId: String(raw.clientId || "")
  };
}

async function loadChatHistoryRecord(key) {
  const state = await chatHistoryState();
  const raw = (await chrome.storage.local.get(key))?.[key];
  return chatHistoryRecord(raw, state.generation);
}

function readChatHistory(message) {
  return withChatHistory(async () => loadChatHistoryRecord(chatHistoryKey(message?.key)));
}

function writeChatHistory(message) {
  return withChatHistory(async () => {
    const key = chatHistoryKey(message?.key);
    const current = await loadChatHistoryRecord(key);
    if (message?.generation !== current.generation || message?.revision !== current.revision) {
      return { conflict: true, ...current };
    }
    if (!Array.isArray(message?.messages)) throw new Error("对话记录格式无效");
    const next = {
      messages: chatHistoryMessages(message.messages),
      revision: current.revision + 1,
      generation: current.generation,
      clientId: String(message.clientId || "")
    };
    await chrome.storage.local.set({ [key]: next });
    return { ok: true, ...next };
  });
}

function clearChatHistory(message) {
  return withChatHistory(async () => {
    const key = chatHistoryKey(message?.key);
    const current = await loadChatHistoryRecord(key);
    const next = { messages: [], revision: current.revision + 1, generation: current.generation, clientId: String(message?.clientId || "") };
    await chrome.storage.local.set({ [key]: next });
    return { ok: true, ...next };
  });
}

function clearAllChatHistory(message = {}) {
  return withChatHistory(async () => {
    const area = chrome.storage.local;
    const state = await chatHistoryState();
    const keys = await chatHistoryKeys(area);
    let count = 0;
    // 分批计数，避免把所有长对话同时读入内存。
    for (let i = 0; i < keys.length; i += 40) {
      const values = await area.get(keys.slice(i, i + 40));
      for (const raw of Object.values(values)) if (chatHistoryRecord(raw, state.generation).messages.length) count += 1;
    }
    // 先写新世代：即使之后删除失败或 worker 中断，旧数据也不可读，旧页面也不能写回。
    await area.set({ [CHAT_HISTORY_STATE_KEY]: { generation: state.generation + 1, clientId: String(message.clientId || "") } });
    if (keys.length) await area.remove(keys);
    const legacyKeys = await chatHistoryKeys(chrome.storage.session);
    if (legacyKeys.length) await chrome.storage.session.remove(legacyKeys);
    return { ok: true, count };
  });
}

function getChatHistoryUsage() {
  return withChatHistory(async () => {
    const area = chrome.storage.local;
    const state = await chatHistoryState();
    const keys = await chatHistoryKeys(area);
    const result = { count: 0, messages: 0, bytes: 0 };
    for (let i = 0; i < keys.length; i += 40) {
      const values = await area.get(keys.slice(i, i + 40));
      for (const [key, raw] of Object.entries(values)) {
        const record = chatHistoryRecord(raw, state.generation);
        if (!record.messages.length) continue;
        result.count += 1;
        result.messages += record.messages.length;
        result.bytes += new TextEncoder().encode(key + JSON.stringify(raw)).byteLength;
      }
    }
    return result;
  });
}
