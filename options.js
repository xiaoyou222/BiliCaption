const P = window.BiliCaptionProviders;
const Stt = window.BiliCaptionStt;
const Dav = window.BiliCaptionDav;
const Prefs = window.BiliCaptionPrefs;
const { keyLabel } = window.BiliCaptionCueTools;

const $ = (id) => document.getElementById(id);
const SCOPE = { groq: "转写", asr: "转写", bili: "B站", net: "网络", set: "设置", app: "应用", sum: "总结", dav: "同步", cache: "缓存", sub: "字幕", x: "X", article: "文章" };

const TABS = ["stt", "sum", "sync", "keys", "logs"];
let tab = TABS.includes(new URLSearchParams(location.search).get("tab"))
  ? new URLSearchParams(location.search).get("tab")
  : "stt";
let selKey = "Shift";
let recording = false;
// 转写通道链：数组顺序即优先级，同一服务商可多条（多账号）
let sttChannels = [];
let sumProvider = "OpenAI";
let settings = {};
let appLogs = [];
// 日志分级保留规则，以后台 GET_LOGS 带回来的为准；这里是后台没回时的兜底（与 后台/基础.js 的 LOG_KEEP 一致）
let logKeep = {
  issue: { ms: 7 * 24 * 60 * 60 * 1000, max: 200 },
  info: { ms: 24 * 60 * 60 * 1000, max: 100 }
};
let logOpen = {};
let logFilter = "全部";
let modelPanel = null;
let sumFetch = "idle";
let sumModels = [];

function show(el, on) {
  if (el) el.classList.toggle("hidden", !on);
}

function clampCtx(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 10;
  return Math.min(50, Math.max(0, n));
}

function clampConc(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 4;
  return Math.min(16, Math.max(1, n));
}

function setTab(next) {
  tab = TABS.includes(next) ? next : "stt";
  document.querySelectorAll(".nav-item").forEach((btn) => btn.classList.toggle("on", btn.dataset.tab === tab));
  TABS.forEach((id) => show($(`tab-${id}`), id === tab));
  // 每次切到「数据同步」都重新统计一次本地字幕缓存
  if (tab === "sync") loadCacheUsage();
}

function renderSeg(host, list, current, onPick) {
  host.replaceChildren();
  for (const label of list) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.classList.toggle("on", label === current);
    const disabledReason = host.id === "sttSeg" ? P.schema(label)?.disabledReason : "";
    if (disabledReason) {
      btn.disabled = true;
      btn.title = disabledReason;
    }
    btn.addEventListener("click", () => onPick(label));
    host.appendChild(btn);
  }
}

function setTestBtn(id, state, idle = "测试") {
  const btn = typeof id === "string" ? $(id) : id;
  if (!btn) return;
  btn.classList.remove("ok", "fail");
  const label = btn.querySelector(".btn-label");
  const setText = (text) => {
    if (label) label.textContent = text;
    else btn.textContent = text;
  };
  if (state === "testing") {
    setText("测试中…");
    return;
  }
  if (state === "ok") {
    setText(btn.id === "runAddTest" ? "✓ 已通过" : "✓ 已连通");
    btn.classList.add("ok");
  } else if (state === "fail") {
    setText(btn.id === "testDav" ? "✕ 连接失败" : "✕ 失败");
    btn.classList.add("fail");
  } else setText(idle);
}

// ---- 转写通道列表：顺序即优先级 ----

let draggingChannel = null;
let dragArmed = false;
let dragOverKey = "";
let editingChannel = null;
let addTestState = null;
let addProvider = "Groq";
let addProvBound = false;

function channelKeyTail(key) {
  const raw = String(key || "").trim();
  if (!raw) return "";
  return raw.length > 9 ? `${raw.slice(0, 3)}…${raw.slice(-4)}` : raw;
}

function channelNote(ch) {
  return P.channelNote(ch);
}

function clearDropLines() {
  dragOverKey = "";
  document.querySelectorAll(".channel-drop-line.is-on").forEach((el) => el.classList.remove("is-on"));
}

function setDropTarget(i, pos) {
  const key = `${i}:${pos}`;
  if (dragOverKey === key) return;
  dragOverKey = key;
  document.querySelectorAll(".channel-drop-line.is-on").forEach((el) => el.classList.remove("is-on"));
  const line = document.querySelector(`.channel-drop-line[data-i="${i}"][data-pos="${pos}"]`);
  line?.classList.add("is-on");
}

function moveChannel(from, to) {
  if (from == null || from === to || to < 0 || to >= sttChannels.length) return;
  const [moved] = sttChannels.splice(from, 1);
  sttChannels.splice(to, 0, moved);
  shiftEditingIndex(from, to);
}

function shiftEditingIndex(from, to) {
  if (editingChannel == null) return;
  if (editingChannel === from) {
    editingChannel = to;
    return;
  }
  if (from < editingChannel && to >= editingChannel) editingChannel -= 1;
  else if (from > editingChannel && to <= editingChannel) editingChannel += 1;
}

function makeDropLine(i, pos) {
  const line = document.createElement("div");
  line.className = `channel-drop-line is-${pos}`;
  line.dataset.i = String(i);
  line.dataset.pos = pos;
  return line;
}

function finishChannelDrag() {
  draggingChannel = null;
  dragArmed = false;
  clearDropLines();
  document.querySelectorAll(".channel-card.is-dragging").forEach((el) => {
    el.classList.remove("is-dragging");
    el.draggable = false;
  });
}

function dropChannelOn(i) {
  const from = draggingChannel;
  const [, pos] = dragOverKey.split(":");
  finishChannelDrag();
  if (from == null || from === i) {
    renderChannels();
    return;
  }
  let to = pos === "after" ? i + 1 : i;
  if (from < to) to -= 1;
  moveChannel(from, to);
  renderChannels();
  saveSettings();
}

function renderChannels() {
  const host = $("channelList");
  if (!host) return;
  sttChannels = sttChannels.filter((ch) => ch && P.STT_PROVIDERS.includes(ch.provider));
  host.replaceChildren();
  sttChannels.forEach((ch, i) => {
    const schema = P.schema(ch.provider);
    const key = String(ch.key || "").trim();
    const editing = editingChannel === i;
    const off = Boolean(ch.off);
    const rank = sttChannels.slice(0, i).filter((item) => !item.off).length + 1;
    const slot = document.createElement("div");
    slot.className = "channel-slot";
    const card = document.createElement("div");
    card.className = `channel-card${editing ? " is-editing" : ""}${off ? " is-off" : ""}`;

    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (draggingChannel == null || draggingChannel === i) {
        clearDropLines();
        return;
      }
      const r = card.getBoundingClientRect();
      setDropTarget(i, (e.clientY - r.top) < r.height / 2 ? "before" : "after");
    });
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      dropChannelOn(i);
    });
    card.addEventListener("dragend", () => {
      finishChannelDrag();
    });
    card.addEventListener("dragstart", (e) => {
      if (!dragArmed) {
        e.preventDefault();
        return;
      }
      draggingChannel = i;
      card.classList.add("is-dragging");
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", String(i)); } catch { /* ignore */ }
      try { e.dataTransfer.setDragImage(card, 24, card.offsetHeight / 2); } catch { /* ignore */ }
    });

    const summary = document.createElement("div");
    summary.className = "channel-summary";
    summary.addEventListener("click", () => {
      editingChannel = editing ? null : i;
      renderChannels();
    });

    const handle = document.createElement("span");
    handle.className = "channel-handle";
    handle.textContent = "⣿";
    handle.title = "拖动调整优先级";
    handle.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      dragArmed = true;
      card.draggable = true;
    });
    handle.addEventListener("click", (e) => e.stopPropagation());

    const num = document.createElement("span");
    num.className = `channel-rank${off ? " is-off" : rank === 1 ? " is-first" : ""}`;
    num.textContent = off ? "—" : String(rank);
    const name = document.createElement("span");
    name.className = "channel-provider";
    name.textContent = ch.provider;
    const noteBadge = document.createElement("span");
    noteBadge.className = "channel-note";
    const syncNoteBadge = () => {
      const text = channelNote(sttChannels[i]);
      noteBadge.textContent = text;
      noteBadge.hidden = !text;
    };
    syncNoteBadge();
    const tail = document.createElement("span");
    tail.className = "channel-tail";
    tail.textContent = channelKeyTail(key) || "未填 Key";
    const spacer = document.createElement("div");
    spacer.style.cssText = "flex:1;min-width:8px";
    const model = document.createElement("span");
    model.className = "channel-model-label";
    model.textContent = String(ch.model || "").trim() || schema.model || "";
    const caret = document.createElement("span");
    caret.className = editing ? "chevron open" : "chevron";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = `channel-switch${off ? " is-off" : ""}`;
    toggle.title = off ? "启用通道" : "停用通道";
    toggle.appendChild(document.createElement("span"));
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      sttChannels[i].off = !sttChannels[i].off;
      renderChannels();
      saveSettings();
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "channel-op danger";
    del.textContent = "✕";
    del.title = "删除通道";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      sttChannels.splice(i, 1);
      if (editingChannel === i) editingChannel = null;
      else if (editingChannel > i) editingChannel -= 1;
      renderChannels();
      saveSettings();
    });
    summary.append(handle, num, name, noteBadge, tail, spacer, model, toggle, caret, del);
    card.appendChild(summary);

    if (editing) {
      const edit = document.createElement("div");
      edit.className = "channel-edit";
      edit.addEventListener("click", (e) => e.stopPropagation());

      const noteInput = document.createElement("input");
      noteInput.className = "channel-note-input";
      noteInput.value = ch.note || "";
      noteInput.placeholder = "备注，如：账号A";
      noteInput.addEventListener("input", () => {
        sttChannels[i].note = noteInput.value;
        syncNoteBadge();
      });
      edit.appendChild(noteInput);

      const keyInput = document.createElement("input");
      keyInput.type = "password";
      keyInput.value = ch.key || "";
      keyInput.placeholder = schema.fields?.[0]?.[2] || "API Key";
      keyInput.addEventListener("input", () => {
        sttChannels[i].key = keyInput.value;
        tail.textContent = channelKeyTail(keyInput.value) || "未填 Key";
      });
      edit.appendChild(keyInput);

      if (schema.model) {
        const modelInput = document.createElement("input");
        modelInput.value = ch.model || "";
        modelInput.placeholder = schema.model;
        modelInput.addEventListener("input", () => {
          sttChannels[i].model = modelInput.value;
          model.textContent = String(modelInput.value || "").trim() || schema.model;
        });
        edit.appendChild(modelInput);
      }

      const test = document.createElement("button");
      test.type = "button";
      test.className = "channel-test";
      test.textContent = "测试";
      test.addEventListener("click", (e) => {
        e.stopPropagation();
        testChannel(i, test);
      });
      edit.appendChild(test);

      if (schema.editableUrl) {
        const urlInput = document.createElement("input");
        urlInput.className = "channel-url";
        urlInput.value = ch.url || "";
        urlInput.placeholder = schema.url || "接口地址（留空用官方）";
        urlInput.addEventListener("input", () => { sttChannels[i].url = urlInput.value; });
        edit.appendChild(urlInput);
      }
      card.appendChild(edit);
    }

    slot.append(makeDropLine(i, "before"), card, makeDropLine(i, "after"));
    host.appendChild(slot);
  });
  if (!sttChannels.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "还没有转写通道，在下方填好参数并测试通过后添加";
    host.appendChild(empty);
  }
}

function currentAddCfg() {
  return P.normalizeChannel({
    provider: addProvider || P.STT_PROVIDERS[0],
    key: $("addKey").value,
    model: $("addModel").value,
    url: $("addUrl")?.value || ""
  });
}

function setAddState(state, note) {
  addTestState = state;
  const btn = $("addChannel");
  btn.disabled = state !== "ok";
  const noteEl = $("addNote");
  noteEl.textContent = note || "";
  noteEl.classList.toggle("hidden", !note);
}

function closeAddProv() {
  $("addProvWrap")?.classList.remove("is-open");
  show($("addProvPanel"), false);
  $("addProvBtn")?.setAttribute("aria-expanded", "false");
}

function syncAddFields() {
  const schema = P.schema(addProvider);
  if ($("addProvLabel")) $("addProvLabel").textContent = addProvider;
  $("addKey").placeholder = schema.fields?.[0]?.[2] || "API Key";
  show($("addModel"), Boolean(schema.model));
  if (schema.model) $("addModel").placeholder = schema.model;
  show($("addUrlRow"), Boolean(schema.editableUrl));
  if ($("addUrl")) $("addUrl").placeholder = schema.url || "接口地址（留空用官方）";
}

function fillAddProvPanel() {
  const panel = $("addProvPanel");
  if (!panel) return;
  panel.replaceChildren(...P.STT_PROVIDERS.map((p) => {
    const item = document.createElement("button");
    item.type = "button";
    item.setAttribute("role", "option");
    item.textContent = p;
    item.classList.toggle("on", p === addProvider);
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      addProvider = p;
      $("addModel").value = "";
      if ($("addUrl")) $("addUrl").value = "";
      closeAddProv();
      fillAddProvPanel();
      syncAddFields();
      setAddState(null, "");
      setTestBtn("runAddTest", "idle", "测试");
    });
    return item;
  }));
}

function renderAddChannelOptions() {
  if (!addProvBound) {
    addProvBound = true;
    $("addProvBtn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      const wrap = $("addProvWrap");
      const open = !wrap.classList.contains("is-open");
      wrap.classList.toggle("is-open", open);
      show($("addProvPanel"), open);
      $("addProvBtn").setAttribute("aria-expanded", String(open));
      if (open) fillAddProvPanel();
    });
  }
  if (!P.STT_PROVIDERS.includes(addProvider)) addProvider = P.STT_PROVIDERS[0];
  fillAddProvPanel();
  syncAddFields();
}

async function testChannel(i, btn) {
  const ch = sttChannels[i];
  if (!ch) return;
  const cfg = P.normalizeChannel(ch);
  if (!cfg) return;
  const prev = "测试";
  btn.textContent = "测试中";
  btn.disabled = true;
  try {
    const result = await Stt.testConnection(cfg);
    btn.textContent = "✓ 成功";
    btn.title = result?.label || "已连通";
    noteLog("info", "set", `通道 ${i + 1}（${P.channelLabel(ch)}）${result?.label || "测试成功"}`);
  } catch (error) {
    btn.textContent = "✗ 失败";
    btn.title = error.message || String(error);
    noteLog("error", "set", `通道 ${i + 1}（${P.channelLabel(ch)}）测试失败：${error.message || error}`);
  } finally {
    btn.disabled = false;
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { btn.textContent = prev; }, 1600);
  }
}

function currentSumCfg() {
  return P.resolveSum({
    sumProvider,
    apiBase: $("sumUrl").value,
    apiKey: $("sumKey").value,
    apiModel: $("sumModel").value
  });
}

function fillCombo(kind) {
  const panelId = kind === "tr" ? "trModelPanel" : "sumModelPanel";
  const inputId = kind === "tr" ? "trModel" : "sumModel";
  const panel = $(panelId);
  const text = $(inputId).value.trim();
  const fetchState = sumFetch;
  const provider = sumProvider;
  const all = sumModels;
  const hint = fetchState === "nokey" ? "未填写 Key"
    : !P.FETCHABLE[provider] ? "该服务商不提供模型列表，直接输入"
    : fetchState === "loading" ? "正在拉取…"
    : fetchState === "fail" ? "拉取失败 · 可直接输入"
    : `共 ${all.length} 个可用模型`;
  const list = all.filter((m) => !text || m.toLowerCase().includes(text.toLowerCase()));
  panel.replaceChildren();
  const head = document.createElement("div");
  head.className = "combo-hint";
  const hintText = document.createElement("span");
  hintText.textContent = hint;
  head.appendChild(hintText);
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.textContent = "⟳ 刷新";
  refresh.addEventListener("click", (e) => { e.stopPropagation(); fetchModels(kind); });
  head.appendChild(refresh);
  panel.appendChild(head);
  if (fetchState === "nokey") {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "item muted";
    row.textContent = "先填写上面的 Key，才能拉取模型列表";
    panel.appendChild(row);
    return;
  }
  for (const m of list) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `item${m === text ? " on" : ""}`;
    row.textContent = m;
    row.addEventListener("click", () => {
      (kind === "tr" ? $("trModel") : $("sumModel")).value = m;
      if (kind === "sum") updateTrPlaceholder();
      closePanels();
    });
    panel.appendChild(row);
  }
  if (text && !all.includes(text)) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "item custom";
    row.textContent = `使用自定义模型 “${text}”`;
    row.addEventListener("click", closePanels);
    panel.appendChild(row);
  }
  if (!panel.querySelector(".item")) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "item muted";
    row.textContent = all.length ? "没有匹配的模型" : "没有可用列表，直接输入模型名";
    panel.appendChild(row);
  }
}

function closePanels() {
  modelPanel = null;
  show($("sumModelPanel"), false);
  show($("trModelPanel"), false);
  document.querySelectorAll(".combo").forEach((el) => el.classList.remove("is-open"));
}

async function fetchModels(kind) {
  const cfg = currentSumCfg();
  if (!cfg.key) {
    sumFetch = "nokey";
    fillCombo(kind === "tr" ? "tr" : "sum");
    return;
  }
  sumFetch = "loading";
  fillCombo(kind === "tr" ? "tr" : "sum");
  try {
    const ids = await Stt.listModels("sum", { ...cfg, kind: "openai", provider: sumProvider });
    sumModels = ids.length ? ids : (P.MODEL_HINTS[sumProvider] || []);
    sumFetch = "ok";
  } catch {
    sumModels = P.MODEL_HINTS[sumProvider] || [];
    sumFetch = "fail";
  }
  fillCombo(kind === "tr" ? "tr" : "sum");
  if (modelPanel && modelPanel !== kind) fillCombo(modelPanel);
}

function openCombo(kind) {
  modelPanel = kind;
  show($("sumModelPanel"), kind === "sum");
  show($("trModelPanel"), kind === "tr");
  document.querySelectorAll(".combo").forEach((el) => el.classList.remove("is-open"));
  const inputId = kind === "tr" ? "trModel" : "sumModel";
  $(inputId)?.closest(".combo")?.classList.add("is-open");
  fillCombo(kind);
  if (sumFetch === "idle" || sumFetch === "nokey") fetchModels(kind);
}

async function testKind(kind) {
  if (kind !== "sum") return;
  const id = "testSum";
  setTestBtn(id, "testing");
  try {
    const cfg = currentSumCfg();
    if (!cfg.key) throw new Error("请先填写 API Key");
    if (!cfg.base) throw new Error("请先填写接口地址");
    await Stt.ensureOrigin(cfg.base);
    // 走统一调用层：同样的 URL 检查、鉴权头和错误信息；按翻译档降思考，测试又快又省。
    // 只验证连通，允许空正文（思考模型在 8 个 token 内可能还没写正文）。
    await globalThis.BiliCaptionModelCall.chat({
      base: cfg.base,
      key: cfg.key,
      model: cfg.model,
      provider: cfg.provider,
      task: "translate",
      temperature: 0,
      maxTokens: 8,
      allowEmpty: true,
      messages: [{ role: "user", content: "只回复 ok" }]
    });
    setTestBtn(id, "ok");
    noteLog("info", "set", "测试总结连接成功");
  } catch (error) {
    setTestBtn(id, "fail");
    noteLog("error", "set", `测试失败：${error.message || error}`);
  }
}

function davCfg() {
  return { url: $("davUrl").value.trim(), user: $("davUser").value.trim(), pass: $("davPass").value };
}

// 同步内容的 4 个开关：[按钮 id / 设置键, 文字, 是否开启]。「转写与改字」即 syncSubs（默认开）
const SYNC_CHIPS = [
  ["syncMarks", "标记", (s) => s.syncMarks !== false],
  ["syncConfig", "设置", (s) => Boolean(s.syncConfig)],
  ["syncSubs", "转写与改字", (s) => s.syncSubs !== false],
  ["syncKeys", "API Key", (s) => Boolean(s.syncKeys)]
];

function renderSync() {
  const syncOn = Boolean(settings.syncOn);
  $("syncToggle").classList.toggle("on", syncOn);
  $("syncToggle").setAttribute("aria-pressed", String(syncOn));
  // 关掉同步时，同步内容、服务器与账号、测试 / 立即同步整块收起
  show($("syncDetails"), syncOn);
  for (const [id, label, isOn] of SYNC_CHIPS) {
    const on = isOn(settings);
    $(id).classList.toggle("on", on);
    $(id).setAttribute("aria-pressed", String(on));
    $(id).textContent = (on ? "✓ " : "") + label;
  }
  show($("syncKeysWarn"), Boolean(settings.syncKeys));
  const ago = Dav.formatSyncAgo(settings.davAt) || settings.davLast;
  $("davStatus").textContent = settings.syncOn
    ? (ago ? `上次同步 ${ago}` : "已开启，尚未同步")
    : "同步已关闭";
  $("davStatus").classList.remove("syncing");
}

function collect() {
  const sum = currentSumCfg();
  const channels = sttChannels.map((ch) => ({
    provider: ch.provider,
    note: channelNote(ch),
    key: String(ch.key || "").trim(),
    model: String(ch.model || "").trim(),
    url: String(ch.url || "").trim(),
    off: Boolean(ch.off)
  }));
  const first = channels.find((ch) => !ch.off) || channels[0] || {};
  const firstKey = String(first.key || "");
  return {
    sttChannels: channels,
    // 兼容旧字段：第一条通道同步成"主服务商"，避免旧读取路径失配
    sttProvider: first.provider || "Groq",
    sttCreds: first.provider ? { [first.provider]: { key: firstKey } } : {},
    sttModel: String(first.model || ""),
    sttKey: firstKey,
    groqApiKey: first.provider === "Groq" ? firstKey : "",
    backupProvider: "不启用",
    backupKey: "",
    sumProvider,
    apiBase: sum.base,
    apiKey: sum.key,
    apiModel: sum.model,
    translateModel: $("trModel").value.trim(),
    selKey,
    summaryPad: clampCtx($("sumCtx").value),
    translateConcurrency: clampConc($("trConc").value),
    syncOn: Boolean(settings.syncOn),
    syncMarks: settings.syncMarks !== false,
    syncConfig: Boolean(settings.syncConfig),
    syncKeys: Boolean(settings.syncKeys),
    syncSubs: settings.syncSubs !== false,
    davUrl: $("davUrl").value.trim(),
    davUser: $("davUser").value.trim(),
    davPass: $("davPass").value,
    davLast: settings.davLast || "",
    davAt: Number(settings.davAt) || 0,
    davConfigAt: Date.now()
  };
}

function configStamp(data) {
  return JSON.stringify({
    sttChannels: data.sttChannels,
    sttProvider: data.sttProvider,
    sttModel: data.sttModel,
    sumProvider: data.sumProvider,
    apiBase: data.apiBase,
    apiModel: data.apiModel,
    translateModel: data.translateModel,
    selKey: data.selKey,
    summaryPad: data.summaryPad,
    translateConcurrency: data.translateConcurrency,
    syncOn: data.syncOn,
    syncMarks: data.syncMarks,
    syncConfig: data.syncConfig,
    syncKeys: data.syncKeys,
    syncSubs: data.syncSubs,
    davUrl: data.davUrl,
    davUser: data.davUser,
    davPass: data.davPass
  });
}

async function saveSettings() {
  const data = collect();
  if (configStamp(data) === configStamp(settings)) {
    data.davConfigAt = Number(settings.davConfigAt) || data.davConfigAt;
  }
  const usable = data.sttChannels.some((ch) => P.channelUsable(P.normalizeChannel(ch)));
  await Prefs.saveSettings(data);
  settings = { ...settings, ...data };
  const el = $("settingsMsg");
  const text = usable
    ? "已保存"
    : "已保存（还没有可用的转写通道：请至少填好一条通道的 Key）";
  el.className = usable ? "" : "warn";
  el.textContent = "";
  el.offsetWidth;
  el.textContent = text;
  clearTimeout(saveSettings._hide);
  saveSettings._hide = setTimeout(() => {
    if (el.textContent === text) {
      el.textContent = "";
      el.className = "";
    }
  }, 1600);
}

function updateTrPlaceholder() {
  const model = ($("sumModel").value || "").trim() || P.SUM_MODELS[sumProvider] || "";
  $("trModel").placeholder = model ? `跟随总结模型（${model}）` : "留空则跟随总结模型";
}

async function loadSettings() {
  settings = await Prefs.loadSettings({
    sttProvider: "Groq",
    sttCreds: {},
    sttModel: "",
    sttKey: "",
    groqApiKey: "",
    sttChannels: [],
    backupProvider: "不启用",
    backupKey: "",
    sumProvider: "OpenAI",
    apiBase: "",
    apiKey: "",
    apiModel: "",
    translateModel: "",
    selKey: "Shift",
    summaryPad: 10,
    translateConcurrency: 4,
    syncOn: false,
    syncMarks: true,
    syncConfig: true,
    syncKeys: false,
    syncSubs: true,
    davUrl: "",
    davUser: "",
    davPass: "",
    davLast: "",
    davAt: 0
  });
  // 通道链：优先读 sttChannels；为空则把旧的主 + 备用配置迁移成链
  sttChannels = (Array.isArray(settings.sttChannels) ? settings.sttChannels : [])
    .map((ch) => ({
      provider: ch?.provider,
      note: String(ch?.note || ""),
      key: String(ch?.key || ""),
      // 已下线的转写模型（如 scribe_v1）显示成当前默认，下次保存时写回
      model: P.migrateSttModel(ch?.provider, ch?.model),
      url: String(ch?.url || ""),
      off: Boolean(ch?.off)
    }))
    .filter((ch) => P.STT_PROVIDERS.includes(ch.provider));
  if (!sttChannels.length) {
    const chain = P.resolveChannels(settings);
    sttChannels = chain.map((cfg) => {
      const meta = P.schema(cfg.provider);
      return {
        provider: cfg.provider,
        note: "",
        key: cfg.key || "",
        // 迁移时保留用户旧模型选择，否则留空走默认
        model: cfg.provider === (settings.sttProvider || "Groq") ? P.migrateSttModel(cfg.provider, settings.sttModel) : "",
        url: meta.editableUrl && cfg.base && cfg.base !== meta.url ? cfg.base : "",
        off: false
      };
    });
  }
  const migrated = P.migrateSum(settings);
  const sumPatch = {};
  for (const key of ["sumProvider", "apiBase", "apiModel", "translateModel"]) {
    if (migrated[key] !== settings[key]) sumPatch[key] = migrated[key] ?? "";
  }
  settings = { ...settings, ...migrated };
  sumProvider = P.SUM_PROVIDERS.includes(settings.sumProvider) ? settings.sumProvider : "OpenAI";
  selKey = settings.selKey || "Shift";
  if (Object.keys(sumPatch).length) {
    await Prefs.saveSettings(sumPatch);
  }
  $("sumKey").value = settings.apiKey || "";
  $("sumUrl").value = settings.apiBase || "";
  $("sumModel").value = settings.apiModel || P.SUM_MODELS[sumProvider] || "";
  $("trModel").value = settings.translateModel || "";
  updateTrPlaceholder();
  $("sumCtx").value = String(clampCtx(settings.summaryPad));
  $("trConc").value = String(clampConc(settings.translateConcurrency));
  $("davUrl").value = settings.davUrl || "";
  $("davUser").value = settings.davUser || "";
  $("davPass").value = settings.davPass || "";
  show($("sumCustom"), sumProvider === "自定义");
  $("sumKey").placeholder = P.SUM_KEY_HINT[sumProvider] || "sk-...";
  $("recordKey").textContent = keyLabel(selKey);
  function pickSum(p) {
    // 再点一次当前服务商：什么都不改，免得把手填的总结 / 翻译模型换回默认
    if (p === sumProvider) return;
    sumProvider = p;
    sumFetch = "idle";
    $("sumModel").value = P.SUM_MODELS[p] || "";
    // 换服务商时翻译模型跟着换：有官方速度档（如 Gemini Flash-Lite）就预填，否则留空跟随总结模型，
    // 免得留下上一家的模型名。
    $("trModel").value = P.SUM_TRANSLATE_MODELS[p] || "";
    updateTrPlaceholder();
    show($("sumCustom"), p === "自定义");
    $("sumKey").placeholder = P.SUM_KEY_HINT[p] || "sk-...";
    renderSeg($("sumSeg"), P.SUM_PROVIDERS, sumProvider, pickSum);
  }
  renderSeg($("sumSeg"), P.SUM_PROVIDERS, sumProvider, pickSum);
  renderAddChannelOptions();
  renderChannels();
  renderSync();
  setTab(tab);
}

const pad2 = (n) => String(n).padStart(2, "0");

/** 列表里的时间：今天的只显示时分秒，更早的（异常最多留 7 天）带上月-日 */
function logTime(ts) {
  const d = new Date(ts);
  const clock = [d.getHours(), d.getMinutes(), d.getSeconds()].map(pad2).join(":");
  return d.toDateString() === new Date().toDateString() ? clock : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clock}`;
}

/** 复制、导出用：一律带月-日 */
function logStamp(ts) {
  const d = new Date(ts);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${[d.getHours(), d.getMinutes(), d.getSeconds()].map(pad2).join(":")}`;
}

function logLine(item) {
  const detail = item.detail ? `  ${item.detail}` : "";
  return `${logStamp(item.t)}  ${(item.level || "info").toUpperCase()}  ${item.scope || "-"}  ${item.message || ""}${detail}`;
}

function logIsIssue(item) {
  return item?.level === "error" || item?.level === "warn";
}

/** 与后台相同的分级裁剪：设置页开着时收到的新日志也按规则去掉过期和超出条数的 */
function pruneLogs(list, now = Date.now()) {
  const kept = [];
  let issues = 0;
  let infos = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const item = list[i];
    if (!item) continue;
    const issue = logIsIssue(item);
    const rule = issue ? logKeep.issue : logKeep.info;
    if (now - (Number(item.t) || 0) > rule.ms) continue;
    if ((issue ? issues : infos) >= rule.max) continue;
    if (issue) issues += 1;
    else infos += 1;
    kept.push(item);
  }
  return kept.reverse();
}

function keepLabel(ms) {
  const hours = Math.round((Number(ms) || 0) / 3600000);
  return hours >= 48 && hours % 24 === 0 ? `${hours / 24} 天` : `${hours} 小时`;
}

function logCountText() {
  const issues = appLogs.filter(logIsIssue).length;
  const infos = appLogs.length - issues;
  return `异常 ${issues} 条（保留 ${keepLabel(logKeep.issue.ms)}）· 信息 ${infos} 条（保留 ${keepLabel(logKeep.info.ms)}）`;
}

const LOG_DETAIL_LABEL = {
  status: "状态码", ms: "耗时", mb: "大小", done: "已完成", total: "总数", current: "段号", chunk: "段号",
  bvid: "视频", cid: "cid", host: "主机", waitMs: "等待", chunks: "分段", cues: "句数", left: "剩余", path: "路径", try: "次数"
};

/** 详情：后台存的是 JSON（{"status":429,"current":3}），拆成「状态码 429」这样一行一项 */
function logDetailRows(detail) {
  const text = String(detail || "");
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return Object.entries(obj).map(([key, value]) => {
        let shown = typeof value === "object" ? JSON.stringify(value) : String(value);
        if ((key === "ms" || key === "waitMs") && Number(value) >= 0) shown = `${Math.round(Number(value) / 1000)} 秒`;
        else if (key === "mb") shown = `${value} MB`;
        return [LOG_DETAIL_LABEL[key] || key, shown];
      });
    }
  } catch {
    // 不是 JSON，按行拆
  }
  return text.split(/\n/).filter(Boolean).map((line) => {
    const [k, ...rest] = line.split(":");
    return rest.length ? [k, rest.join(":").trim()] : ["详情", line];
  });
}

function filteredLogs() {
  const q = $("logQuery").value.trim();
  return appLogs.filter((item) => {
    const level = String(item.level || "info").toUpperCase();
    if (logFilter === "异常" && level === "INFO") return false;
    if (q && !`${item.message || ""}${item.scope || ""}${item.detail || ""}`.includes(q)) return false;
    return true;
  });
}

function renderLogs() {
  const rows = filteredLogs();
  $("logCount").textContent = logCountText();
  const host = $("logList");
  host.replaceChildren();
  for (const item of [...rows].reverse()) {
    const id = `${item.t}:${item.message}`;
    const level = String(item.level || "info").toUpperCase();
    const safeLevel = ["INFO", "WARN", "ERROR"].includes(level) ? level : "INFO";
    const open = Boolean(logOpen[id]);
    const row = document.createElement("div");
    row.className = `log-row${open ? " open" : ""}${safeLevel === "INFO" ? " info" : ""}`;
    const top = document.createElement("div");
    top.className = "log-top";
    const timeEl = document.createElement("span");
    timeEl.className = "log-time";
    timeEl.textContent = logTime(item.t);
    const levelEl = document.createElement("span");
    levelEl.className = `log-level ${safeLevel}`;
    levelEl.textContent = safeLevel;
    const srcEl = document.createElement("span");
    srcEl.className = "log-src";
    srcEl.textContent = SCOPE[item.scope] || String(item.scope || "");
    top.append(timeEl, levelEl, srcEl);
    const msg = document.createElement("span");
    msg.className = "log-msg";
    msg.textContent = item.message || "";
    top.appendChild(msg);
    row.appendChild(top);
    if (open && item.detail) {
      const box = document.createElement("div");
      box.className = "log-detail";
      for (const [k, v] of logDetailRows(item.detail)) {
        const d = document.createElement("div");
        d.innerHTML = `<span class="k"></span><span class="v"></span>`;
        d.querySelector(".k").textContent = k;
        d.querySelector(".v").textContent = v;
        box.appendChild(d);
      }
      row.appendChild(box);
    }
    row.addEventListener("click", () => {
      logOpen[id] = !logOpen[id];
      renderLogs();
    });
    host.appendChild(row);
  }
}

async function loadLogs() {
  try {
    const data = await chrome.runtime.sendMessage({ type: "GET_LOGS" });
    if (data?.keep?.issue?.ms && data?.keep?.info?.ms) logKeep = data.keep;
    appLogs = Array.isArray(data?.logs) ? data.logs : [];
  } catch {
    appLogs = [];
  }
  renderLogs();
}

function noteLog(level, scope, message) {
  chrome.runtime.sendMessage({ type: "APPEND_LOG", level, scope, message }).catch(() => {});
}

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => setTab(btn.dataset.tab));
});
$("runAddTest").addEventListener("click", async () => {
  const cfg = currentAddCfg();
  const btn = $("runAddTest");
  setTestBtn(btn, "testing", "测试");
  if (!cfg.key) {
    setAddState("nokey", "请先填写 API Key");
    setTestBtn(btn, "idle", "测试");
    return;
  }
  try {
    await Stt.testConnection(cfg);
    setTestBtn(btn, "ok", "测试");
    setAddState("ok", "");
  } catch (error) {
    setTestBtn(btn, "fail", "测试");
    setAddState("fail", error.message || String(error));
  }
});
$("addKey").addEventListener("input", () => setAddState(null, ""));
$("addModel").addEventListener("input", () => setAddState(null, ""));
$("addUrl")?.addEventListener("input", () => setAddState(null, ""));
$("addChannel").addEventListener("click", () => {
  if (addTestState !== "ok") return;
  const cfg = currentAddCfg();
  sttChannels.push({
    provider: cfg.provider,
    note: String($("addChanNote")?.value || "").trim(),
    key: String(cfg.key || "").trim(),
    model: String($("addModel").value || "").trim(),
    url: String($("addUrl")?.value || "").trim(),
    off: false
  });
  $("addKey").value = "";
  $("addModel").value = "";
  if ($("addChanNote")) $("addChanNote").value = "";
  if ($("addUrl")) $("addUrl").value = "";
  setAddState(null, "");
  setTestBtn("runAddTest", "idle", "测试");
  renderChannels();
  saveSettings();
});
$("testSum").addEventListener("click", () => testKind("sum"));
$("sumModel").addEventListener("focus", () => openCombo("sum"));
$("sumModel").addEventListener("input", () => {
  updateTrPlaceholder();
  if (modelPanel === "sum") fillCombo("sum");
});
$("sumModelCaret").addEventListener("click", () => openCombo("sum"));
$("trModel").addEventListener("focus", () => openCombo("tr"));
$("trModel").addEventListener("input", () => { if (modelPanel === "tr") fillCombo("tr"); });
$("trModelCaret").addEventListener("click", () => openCombo("tr"));
document.addEventListener("click", (e) => {
  if (!e.target.closest(".combo")) closePanels();
  if (!e.target.closest(".add-prov")) closeAddProv();
});
document.addEventListener("mouseup", () => {
  if (draggingChannel != null) return;
  dragArmed = false;
  document.querySelectorAll(".channel-card").forEach((el) => { el.draggable = false; });
});
$("ctxDec").addEventListener("click", () => { $("sumCtx").value = String(clampCtx(Number($("sumCtx").value) - 1)); });
$("ctxInc").addEventListener("click", () => { $("sumCtx").value = String(clampCtx(Number($("sumCtx").value) + 1)); });
$("trDec").addEventListener("click", () => { $("trConc").value = String(clampConc(Number($("trConc").value) - 1)); });
$("trInc").addEventListener("click", () => { $("trConc").value = String(clampConc(Number($("trConc").value) + 1)); });
$("syncToggle").addEventListener("click", () => { settings.syncOn = !settings.syncOn; renderSync(); });
$("syncMarks").addEventListener("click", () => { settings.syncMarks = settings.syncMarks === false; renderSync(); });
$("syncConfig").addEventListener("click", () => { settings.syncConfig = !settings.syncConfig; renderSync(); });
$("syncKeys").addEventListener("click", () => { settings.syncKeys = !settings.syncKeys; renderSync(); });
$("syncSubs").addEventListener("click", () => { settings.syncSubs = settings.syncSubs === false; renderSync(); });
$("testDav").addEventListener("click", async () => {
  setTestBtn("testDav", "testing");
  try {
    await Dav.test(davCfg());
    setTestBtn("testDav", "ok");
  } catch (error) {
    setTestBtn("testDav", "fail");
    $("davStatus").textContent = error.message || String(error);
  }
});
function setDavSyncing(on) {
  $("davStatus")?.classList.toggle("syncing", Boolean(on));
}

$("syncNow").addEventListener("click", async () => {
  $("davStatus").textContent = "同步中…";
  setDavSyncing(true);
  try {
    await Prefs.saveSettings(collect());
    const result = await chrome.runtime.sendMessage({ type: "DAV_SYNC_NOW", reason: "manual" });
    if (result?.error) throw new Error(result.error);
    if (result?.skipped) {
      $("davStatus").textContent = "同步已关闭或未填写地址";
      return;
    }
    settings.davAt = Number(result.at) || Date.now();
    settings.davLast = Dav.formatSyncAgo(settings.davAt);
    renderSync();
  } catch (error) {
    $("davStatus").textContent = error.message || String(error);
  } finally {
    setDavSyncing(false);
  }
});

// ---- 本地缓存：字幕两张卡片 + 文章总结一张（统计、删除和上限都在后台，见 后台/缓存.js） ----

const CACHE_MB = 1024 * 1024;
const CACHE_CLEARED_TEXT = "已清理可重新获取的字幕";
let cacheRenewableVideos = 0;
let cacheClearing = false;
// 切到本页时的统计和清理结果可能交错返回：只用最后发起的那次
let cacheUsageSeq = 0;

function formatCacheMB(bytes) {
  const mb = (Number(bytes) || 0) / CACHE_MB;
  if (!mb) return "0 MB";
  return `${mb < 10 ? mb.toFixed(2) : mb.toFixed(1)} MB`;
}

/** 进度条旁的容量只写数字，单位跟在分母后面（如「0.27 / 上限 MB」） */
function cacheMBNumber(bytes) {
  const mb = (Number(bytes) || 0) / CACHE_MB;
  if (!mb) return "0";
  if (mb < 0.01) return "<0.01";
  return mb < 10 ? mb.toFixed(2) : mb.toFixed(1);
}

/** 上限写成 6、1.5 这样，不补多余的 0 */
function cacheLimitMB(bytes) {
  return String(Number(((Number(bytes) || 0) / CACHE_MB).toFixed(2)));
}

/** 数字 + 灰色分母；后台没给上限时只写数字 */
function setCacheNum(id, value, den = "") {
  const el = $(id);
  el.textContent = value;
  el.title = "";
  if (!den) return;
  const span = document.createElement("span");
  span.className = "cache-den";
  span.textContent = ` / ${den}`;
  el.appendChild(span);
}

function setCacheBar(id, value, max) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (Number(value) || 0) / max * 100)) : 0;
  $(id).style.width = `${pct}%`;
}

/** 清理进行中、或没有可清理的条目时，「清理」置灰 */
function syncClearCacheBtn() {
  $("clearCache").disabled = cacheClearing || !cacheRenewableVideos;
}

function renderCacheUsage(usage) {
  const regen = usage?.renewable || {};
  const kept = usage?.protected || {};
  const maxVideos = Number(regen.maxVideos) || 0;
  const maxBytes = Number(regen.maxBytes) || 0;
  cacheRenewableVideos = Number(regen.videos) || 0;
  setCacheNum("cacheRegenCount", String(cacheRenewableVideos), maxVideos ? String(maxVideos) : "");
  setCacheNum("cacheRegenSize", maxBytes ? cacheMBNumber(regen.bytes) : formatCacheMB(regen.bytes), maxBytes ? `${cacheLimitMB(maxBytes)} MB` : "");
  setCacheBar("cacheRegenCountBar", cacheRenewableVideos, maxVideos);
  setCacheBar("cacheRegenSizeBar", regen.bytes, maxBytes);
  setCacheNum("cacheKeepCount", String(Number(kept.videos) || 0));
  setCacheNum("cacheKeepSize", formatCacheMB(kept.bytes));
  // 文章总结缓存单独一张卡片，不算进字幕
  const article = usage?.article || {};
  const articleMax = Number(article.maxCount) || 0;
  const articleMaxBytes = Number(article.maxBytes) || 0;
  setCacheNum("cacheArticleCount", String(Number(article.count) || 0), articleMax ? String(articleMax) : "");
  setCacheNum(
    "cacheArticleSize",
    articleMaxBytes ? cacheMBNumber(article.bytes) : formatCacheMB(article.bytes),
    articleMaxBytes ? `${cacheLimitMB(articleMaxBytes)} MB` : ""
  );
  setCacheBar("cacheArticleCountBar", article.count, articleMax);
  setCacheBar("cacheArticleSizeBar", article.bytes, articleMaxBytes);
  syncClearCacheBtn();
}

function renderCacheError(error) {
  const text = error?.message || String(error);
  for (const id of ["cacheRegenCount", "cacheRegenSize", "cacheKeepCount", "cacheKeepSize", "cacheArticleCount", "cacheArticleSize"]) {
    setCacheNum(id, "读取失败");
    $(id).title = text;
  }
  setCacheBar("cacheRegenCountBar", 0, 0);
  setCacheBar("cacheRegenSizeBar", 0, 0);
  setCacheBar("cacheArticleCountBar", 0, 0);
  setCacheBar("cacheArticleSizeBar", 0, 0);
  cacheRenewableVideos = 0;
  syncClearCacheBtn();
}

async function loadCacheUsage() {
  const seq = ++cacheUsageSeq;
  try {
    const usage = await chrome.runtime.sendMessage({ type: "GET_CACHE_USAGE" });
    if (usage?.error) throw new Error(usage.error);
    if (seq === cacheUsageSeq) renderCacheUsage(usage);
  } catch (error) {
    if (seq === cacheUsageSeq) renderCacheError(error);
  }
}

/** 页脚上方的轻提示，和设计稿的 flash 一样 1.5 秒后消失 */
function showToast(text, ms = 1500) {
  const el = $("toast");
  el.textContent = text;
  show(el, true);
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => show(el, false), ms);
}

/** 正在转写或翻译的视频后台会跳过，提示里带上 */
function clearCacheMessage(result) {
  const busy = Number(result?.skipped) || 0;
  const busyText = busy ? `${busy} 个视频正在转写或翻译，稍后再清` : "";
  if (result?.removed) return busyText ? `${CACHE_CLEARED_TEXT}；${busyText}` : CACHE_CLEARED_TEXT;
  return busyText || "没有可清理的字幕";
}

// 单击直接清理：只删官方字幕与译文，这些都能重新获取；转写与改字一条不碰
$("clearCache").addEventListener("click", async () => {
  if (cacheClearing || !cacheRenewableVideos) return;
  cacheClearing = true;
  syncClearCacheBtn();
  const seq = ++cacheUsageSeq;
  try {
    const result = await chrome.runtime.sendMessage({ type: "CLEAR_RENEWABLE_CACHE" });
    if (result?.error) throw new Error(result.error);
    if (seq === cacheUsageSeq && result?.usage) renderCacheUsage(result.usage);
    const text = clearCacheMessage(result);
    showToast(text, text === CACHE_CLEARED_TEXT ? 1500 : 3000);
    if (!result?.usage) loadCacheUsage();
  } catch (error) {
    showToast(`清理失败：${error.message || error}`, 3000);
  } finally {
    cacheClearing = false;
    syncClearCacheBtn();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "DAV_SYNCED") {
    settings.davAt = Number(message.at) || Date.now();
    settings.davLast = Dav.formatSyncAgo(settings.davAt);
    renderSync();
    setDavSyncing(false);
  }
  if (message?.type === "DAV_SYNC_ERROR") {
    $("davStatus").textContent = message.error || "同步失败";
    setDavSyncing(false);
  }
});
$("recordKey").addEventListener("click", () => {
  recording = !recording;
  $("recordKey").textContent = recording ? "按下新按键…" : keyLabel(selKey);
  $("recordKey").classList.toggle("recording", recording);
});
window.addEventListener("keydown", (event) => {
  if (!recording) return;
  event.preventDefault();
  if (event.key === "Escape") {
    recording = false;
  } else {
    selKey = event.key;
    recording = false;
  }
  $("recordKey").textContent = recording ? "按下新按键…" : keyLabel(selKey);
  $("recordKey").classList.toggle("recording", recording);
}, true);
$("saveSettings").addEventListener("click", saveSettings);
window.addEventListener("mouseup", () => { dragArmed = false; });
$("logFilter").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-filter]");
  if (!btn) return;
  logFilter = btn.dataset.filter;
  $("logFilter").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === btn));
  renderLogs();
});
$("logQuery").addEventListener("input", renderLogs);
$("copyLogsN").addEventListener("click", async () => {
  const btn = $("copyLogsN");
  const rows = appLogs.slice(-50);
  if (!rows.length) {
    flashSettingsMsg(btn, "没有日志");
    return;
  }
  const text = rows.map(logLine).join("\n");
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      throw new Error("no clipboard");
    }
    flashSettingsMsg(btn, "已复制");
  } catch {
    flashSettingsMsg(btn, "复制失败");
  }
});
function flashSettingsMsg(btn, text) {
  if (!btn) return;
  const prev = btn.textContent;
  btn.textContent = text;
  btn.classList.add("copied");
  clearTimeout(btn._t);
  btn._t = setTimeout(() => {
    btn.textContent = prev;
    btn.classList.remove("copied");
  }, 1500);
}
$("clearLogs").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "CLEAR_LOGS" });
  appLogs = [];
  renderLogs();
});
$("exportLogs").addEventListener("click", () => {
  const text = filteredLogs().map(logLine).join("\n");
  const blob = new Blob([text || "（没有日志）"], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `bilicaption-${new Date().toISOString().slice(0, 10)}.log`;
  a.click();
  URL.revokeObjectURL(a.href);
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "APP_LOG" || !message.entry) return;
  appLogs = pruneLogs([...appLogs, message.entry]);
  renderLogs();
});

  const $ver = $("appVer");
  if ($ver) $ver.textContent = `v${chrome.runtime.getManifest().version}`;
  loadSettings().then(() => {
    if (settings.syncOn) {
      chrome.runtime.sendMessage({ type: "DAV_SYNC_NOW", reason: "options" }).catch(() => {});
    }
    setInterval(() => {
      if ($("davStatus")?.classList.contains("syncing")) return;
      if (settings.syncOn && Number(settings.davAt)) renderSync();
    }, 30 * 1000);
  });
loadLogs();
