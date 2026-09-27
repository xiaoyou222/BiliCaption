// 侧栏 · 字幕助手：就当前视频的字幕向 AI 提问（底部操作栏的对话气泡按钮打开）。
// 上下文与提示词、多轮历史、每个视频一份的对话状态都在 lib/字幕助手.js（可单测），这里只管界面和接线。
// 对话存 chrome.storage.session：关浏览器即清，重新打开侧栏能恢复。浮窗是同一个页面（?embed=1），同样生效。
// 回答里的 [mm:ss] 时间点做成可点按钮（DOM 构造，不用 innerHTML），点了跳到那个播放位置。

const CHAT_TOGGLE_IDS = ["btnChat", "btnChatMarker", "btnChatOutline"];
const CHAT_INPUT_MAX_H = 96;

let chatOpen = false;
let chatCtl = null;
let chatPendingEl = null;
let chatStick = true;
let stopChatOrb = null;

function chatApi() {
  return globalThis.BiliCaptionChat;
}

function chatController() {
  if (chatCtl) return chatCtl;
  const api = chatApi();
  chatCtl = api.createChatController({
    storage: globalThis.chrome?.storage?.session || api.memoryStorage(),
    request: requestChatAnswer,
    hasConfig: chatServiceReady,
    onChange: onChatChange
  });
  return chatCtl;
}

async function chatServiceReady() {
  const cfg = await sumServiceConfig();
  return Boolean(cfg.key && cfg.base);
}

/**
 * 用设置里「总结服务」的主模型回答，走统一调用层（首字 + 空闲超时、去掉 <think>、按服务商决定参数）。
 * task 为 chat：不在降思考的任务里，保持服务商默认的思考方式。
 */
async function requestChatAnswer({ messages, signal, onDelta }) {
  const cfg = await sumServiceConfig();
  if (!cfg.key) throw new Error("请先在设置里配置总结服务和 API Key");
  if (!cfg.base) throw new Error("请先在设置里填写接口地址");
  await ensureApiOrigin(cfg.base);
  const result = await globalThis.BiliCaptionModelCall.chat({
    base: cfg.base,
    key: cfg.key,
    model: cfg.model,
    provider: cfg.provider,
    task: "chat",
    messages,
    signal,
    stream: true,
    onDelta
  });
  if (result.truncated) flash("模型输出达到长度上限，回答被截断", 5000);
  return result.text;
}

function chatContext() {
  return {
    cues: state?.cues || [],
    currentTime: Number(state?.currentTime),
    title: state?.title || "",
    outline: outline || [],
    videoSummary: videoSummary || ""
  };
}

function chatHasCues() {
  return Boolean(state?.cues?.length);
}

/** 渲染状态时跟上当前视频：换了视频就切到那个视频自己的对话（进行中的请求会被中止） */
function syncChatVideo(next) {
  const api = chatApi();
  const key = api?.chatStorageKey(next);
  if (!key) return;
  chatController().open(key).catch(() => {});
}

/** 指针在打开的对话面板上：面板盖在字幕列表上，按住划选键移动时不去选下面的字幕 */
function pointerInChat(event) {
  return chatOpen && Boolean(ui.chatPanel?.contains?.(event?.target));
}

function fillChatAnswer(el, text) {
  const nodes = chatApi().parseAnswerSegments(text).map((part) => {
    if (part.type !== "time") return document.createTextNode(part.text);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chat-time";
    btn.dataset.time = String(part.seconds);
    btn.title = `跳到 ${part.label}`;
    btn.textContent = part.label;
    return btn;
  });
  el.replaceChildren(...nodes);
}

function chatMessageRow(msg) {
  const row = document.createElement("div");
  if (msg.role === "user") {
    row.className = "chat-row user";
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble";
    bubble.textContent = msg.text;
    row.append(bubble);
    return { row, body: bubble };
  }
  row.className = "chat-row ai";
  const body = document.createElement("div");
  body.className = "chat-answer";
  if (msg.status === "error") {
    body.classList.add("is-error");
    body.textContent = msg.text || "请求失败，请稍后重试";
  } else {
    fillChatAnswer(body, msg.text);
    if (msg.status === "aborted") {
      const flag = document.createElement("span");
      flag.className = "chat-flag";
      flag.textContent = chatApi().ABORTED_MARK;
      body.append(flag);
    }
  }
  row.append(body);
  return { row, body };
}

function chatRetryButton() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "chat-retry";
  btn.dataset.chatAction = "retry";
  btn.textContent = "重新发送";
  return btn;
}

function renderChatList() {
  if (!ui.chatList) return;
  const ctl = chatController();
  const rows = ctl.messages.map((msg) => chatMessageRow(msg).row);
  chatPendingEl = null;
  const pending = ctl.pending;
  if (pending?.started) {
    const { row, body } = chatMessageRow({ role: "ai", text: pending.text });
    chatPendingEl = body;
    rows.push(row);
  }
  if (!ctl.busy && ctl.canRetry && rows.length) rows[rows.length - 1].append(chatRetryButton());
  ui.chatList.replaceChildren(...rows);
}

function showChatThinking(on) {
  if (ui.chatThinking) show(ui.chatThinking, on);
  if (on) {
    if (!stopChatOrb && ui.chatThinkOrb) {
      stopChatOrb = startOrb(ui.chatThinkOrb, { state: "connecting", size: 13, speed: 0.9, iconOnly: true, label: "" });
    }
    return;
  }
  stopChatOrb?.();
  stopChatOrb = null;
}

function renderChatSend() {
  const btn = ui.btnChatSend;
  if (!btn) return;
  const canSend = chatHasCues()
    && !chatController().busy
    && Boolean(String(ui.chatInput?.value || "").trim());
  btn.disabled = !canSend;
  btn.classList.toggle("ready", canSend);
}

/** 按钮高亮、面板显隐、空态 / 提示 / 输入框状态（不重建消息列表，renderState 每次都会调） */
function renderChatChrome() {
  for (const id of CHAT_TOGGLE_IDS) {
    const btn = $(id);
    if (!btn) continue;
    btn.classList.toggle("active", chatOpen);
    btn.setAttribute("aria-pressed", chatOpen ? "true" : "false");
  }
  if (!ui.chatPanel) return;
  show(ui.chatPanel, chatOpen);
  if (!chatOpen) {
    showChatThinking(false);
    return;
  }
  const ctl = chatController();
  const hasCues = chatHasCues();
  const hasMessages = ctl.messages.length > 0;
  if (ui.chatEmpty) show(ui.chatEmpty, !hasMessages && !ctl.pending);
  if (ui.chatEmptyTitle) ui.chatEmptyTitle.textContent = hasCues ? "问问这个视频" : "当前视频还没有字幕";
  if (ui.chatEmptyNote) show(ui.chatEmptyNote, hasCues);
  if (ui.chatNotice) show(ui.chatNotice, ctl.notice === "config");
  if (ui.btnChatClear) show(ui.btnChatClear, hasMessages);
  if (ui.chatInput) {
    ui.chatInput.disabled = !hasCues;
    ui.chatInput.placeholder = hasCues ? "问点关于这个视频的…" : "当前视频还没有字幕";
  }
  renderChatSend();
  showChatThinking(Boolean(ctl.pending && !ctl.pending.started));
}

function scrollChatToEnd(force = false) {
  const box = ui.chatScroll;
  if (!box || !chatOpen) return;
  if (force || chatStick) box.scrollTop = box.scrollHeight;
}

function onChatScroll() {
  const box = ui.chatScroll;
  if (!box) return;
  chatStick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
}

function onChatChange(kind) {
  if (!chatOpen) {
    renderChatChrome();
    return;
  }
  const pending = chatController().pending;
  if (kind === "delta" && chatPendingEl && pending?.started) fillChatAnswer(chatPendingEl, pending.text);
  else renderChatList();
  renderChatChrome();
  scrollChatToEnd();
}

function autoGrowChatInput(el = ui.chatInput) {
  if (!el?.style) return;
  el.style.height = "auto";
  const h = (Number(el.scrollHeight) || 0) + 2;
  el.style.height = `${Math.min(h, CHAT_INPUT_MAX_H)}px`;
  el.style.overflowY = h > CHAT_INPUT_MAX_H ? "auto" : "hidden";
}

function openChat() {
  chatOpen = true;
  // 打开助手时收起「更多」、倍速这些弹出层
  setMoreOpen(false);
  setMarkerMoreOpen(false);
  setSpeedMenuOpen(false);
  chatStick = true;
  renderChatList();
  renderChatChrome();
  autoGrowChatInput();
  scrollChatToEnd(true);
  chatController().checkConfig().catch(() => {});
  if (ui.chatInput && !ui.chatInput.disabled) ui.chatInput.focus();
}

/** 收起面板：进行中的请求一并中止，已收到的半截回答存成「已中断」 */
function closeChat() {
  if (!chatOpen) return;
  chatOpen = false;
  chatController().abort({ keep: true });
  renderChatChrome();
}

function toggleChat() {
  if (chatOpen) closeChat();
  else openChat();
}

function sendChat() {
  const text = String(ui.chatInput?.value || "").trim();
  if (!text || !chatHasCues()) return;
  const ctl = chatController();
  if (ctl.busy) return;
  chatStick = true;
  ctl.send(text, chatContext(), {
    onStart() {
      if (!ui.chatInput) return;
      ui.chatInput.value = "";
      autoGrowChatInput();
    }
  }).catch(() => {});
}

function retryChat() {
  const ctl = chatController();
  if (ctl.busy || !chatHasCues()) return;
  chatStick = true;
  ctl.retry(chatContext()).catch(() => {});
}

function clearChat() {
  chatController().clear().catch(() => {});
  if (ui.chatInput && !ui.chatInput.disabled) ui.chatInput.focus();
}

function onChatInput() {
  autoGrowChatInput();
  renderChatSend();
}

function onChatKey(event) {
  if (!chatApi()?.shouldSendOnKey(event)) return;
  event.preventDefault();
  sendChat();
}

function onChatAreaClick(event) {
  const time = event.target?.closest?.(".chat-time");
  if (time && ui.chatScroll?.contains(time)) {
    const seconds = Number(time.dataset.time);
    if (Number.isFinite(seconds)) seekOutlineTime(seconds);
    return;
  }
  const action = event.target?.closest?.("[data-chat-action]");
  if (!action || !ui.chatScroll?.contains(action)) return;
  if (action.dataset.chatAction === "retry") retryChat();
  else if (action.dataset.chatAction === "settings") openSettings("sum");
}
