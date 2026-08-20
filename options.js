const P = window.BiliCaptionProviders;
const Stt = window.BiliCaptionStt;
const Dav = window.BiliCaptionDav;
const Prefs = window.BiliCaptionPrefs;

const $ = (id) => document.getElementById(id);
const SCOPE = { groq: "转写", asr: "转写", bili: "B站", net: "网络", set: "设置", app: "应用", sum: "总结", dav: "同步" };

let tab = new URLSearchParams(location.search).get("tab") || "stt";
let selKey = "Shift";
let recording = false;
// 转写通道链：数组顺序即优先级，同一服务商可多条（多账号）
let sttChannels = [];
let sumProvider = "OpenAI";
let settings = {};
let appLogs = [];
let logOpen = {};
let logFilter = "全部";
let modelPanel = null;
let sumFetch = "idle";
let sumModels = [];

function show(el, on) {
  if (el) el.classList.toggle("hidden", !on);
}

function keyLabel(key) {
  return key.length === 1 ? key.toUpperCase() : key;
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
  tab = next;
  document.querySelectorAll(".nav-item").forEach((btn) => btn.classList.toggle("on", btn.dataset.tab === next));
  ["stt", "sum", "sync", "keys", "logs"].forEach((id) => show($( `tab-${id}`), id === next));
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

function startOptionsOrb(host, options) {
  try {
    return globalThis.mountThinkingOrb?.(host, options) || (() => {});
  } catch {
    return () => {};
  }
}

/** 测试按钮文案 + 请求期间的 13px connecting 点阵球（见 HANDOFF-加载动画） */
function setTestBtn(id, state, idle = "测连通") {
  const btn = typeof id === "string" ? $(id) : id;
  if (!btn) return;
  btn.classList.remove("ok", "fail");
  const label = btn.querySelector(".btn-label");
  const orb = btn.querySelector(".btn-orb");
  const setText = (text) => {
    if (label) label.textContent = text;
    else btn.textContent = text;
  };
  if (state === "testing") {
    setText("测试中…");
    if (orb) {
      orb.hidden = false;
      btn._orbStop?.();
      btn._orbStop = startOptionsOrb(orb, { state: "connecting", size: 13, speed: 0.9, iconOnly: true, label: "" });
    }
    return;
  }
  btn._orbStop?.();
  btn._orbStop = null;
  if (orb) orb.hidden = true;
  if (state === "ok") { setText("✓ 已连通"); btn.classList.add("ok"); }
  else if (state === "fail") { setText(id === "testDav" ? "✕ 连接失败" : "✕ 失败"); btn.classList.add("fail"); }
  else setText(idle);
}

// ---- 转写通道列表：顺序即优先级 ----

function channelTail(ch) {
  const schema = P.schema(ch.provider);
  const key = String(ch.key || "").trim();
  if (key) return key.length > 9 ? `· ${key.slice(0, 3)}…${key.slice(-4)}` : `· ${key}`;
  return schema.keyless ? "· 免 Key" : "· 未填 Key";
}

function renderChannels() {
  const host = $("channelList");
  if (!host) return;
  host.replaceChildren();
  sttChannels.forEach((ch, i) => {
    const schema = P.schema(ch.provider);
    const row = document.createElement("div");
    row.className = "channel-row";

    const rank = document.createElement("span");
    rank.className = "channel-rank";
    rank.textContent = String(i + 1);
    rank.title = i === 0 ? "最高优先级（主通道）" : `优先级 ${i + 1}`;
    row.appendChild(rank);

    const name = document.createElement("div");
    name.className = "channel-name";
    const title = document.createElement("span");
    title.className = "channel-provider";
    title.textContent = ch.provider;
    const tail = document.createElement("span");
    tail.className = "channel-tail";
    tail.textContent = channelTail(ch);
    name.append(title, tail);
    if (schema.keyless) {
      name.title = "Key 选填：不填走免 Key 演示通道（按 IP 限次），填了走官方正式通道";
    }
    row.appendChild(name);

    const keyInput = document.createElement("input");
    keyInput.type = "password";
    keyInput.className = "channel-key";
    keyInput.placeholder = schema.keyless ? "API Key（选填）" : (schema.fields?.[0]?.[2] || "API Key");
    keyInput.value = ch.key || "";
    keyInput.addEventListener("input", () => {
      ch.key = keyInput.value;
      tail.textContent = channelTail(ch);
    });
    row.appendChild(keyInput);

    const modelInput = document.createElement("input");
    modelInput.type = "text";
    modelInput.className = "channel-model";
    modelInput.placeholder = schema.model || "默认模型";
    modelInput.value = ch.model || "";
    modelInput.title = "留空用该服务商默认模型";
    modelInput.addEventListener("input", () => {
      ch.model = modelInput.value;
    });
    row.appendChild(modelInput);

    const test = document.createElement("button");
    test.type = "button";
    test.className = "btn-ghost channel-test";
    const orb = document.createElement("span");
    orb.className = "btn-orb think-host";
    orb.hidden = true;
    const label = document.createElement("span");
    label.className = "btn-label";
    label.textContent = "测连通";
    test.append(orb, label);
    test.addEventListener("click", () => testChannel(i, test));
    row.appendChild(test);

    const ops = document.createElement("div");
    ops.className = "channel-ops";
    const up = document.createElement("button");
    up.type = "button";
    up.className = "channel-op";
    up.textContent = "↑";
    up.disabled = i === 0;
    up.title = "提高优先级";
    up.addEventListener("click", () => moveChannel(i, -1));
    const down = document.createElement("button");
    down.type = "button";
    down.className = "channel-op";
    down.textContent = "↓";
    down.disabled = i === sttChannels.length - 1;
    down.title = "降低优先级";
    down.addEventListener("click", () => moveChannel(i, 1));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "channel-op danger";
    del.textContent = "×";
    del.title = "删除该通道";
    del.addEventListener("click", () => {
      sttChannels.splice(i, 1);
      renderChannels();
    });
    ops.append(up, down, del);
    row.appendChild(ops);

    host.appendChild(row);
  });
  if (!sttChannels.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "还没有转写通道，先在下面选择服务商添加一条";
    host.appendChild(empty);
  }
}

function moveChannel(i, delta) {
  const j = i + delta;
  if (j < 0 || j >= sttChannels.length) return;
  [sttChannels[i], sttChannels[j]] = [sttChannels[j], sttChannels[i]];
  renderChannels();
}

function renderAddChannelOptions() {
  const sel = $("addChannelProvider");
  if (!sel) return;
  sel.replaceChildren(...P.STT_PROVIDERS.map((p) => {
    const o = document.createElement("option");
    o.value = p;
    o.textContent = p;
    return o;
  }));
}

async function testChannel(i, btn) {
  const ch = sttChannels[i];
  if (!ch) return;
  const cfg = P.normalizeChannel(ch);
  if (!cfg) return;
  setTestBtn(btn, "testing");
  try {
    const result = await Stt.testConnection(cfg);
    setTestBtn(btn, "ok");
    btn.title = result?.label || "已连通";
    noteLog("info", "set", `通道 ${i + 1}（${ch.provider}）${result?.label || "测试成功"}`);
  } catch (error) {
    setTestBtn(btn, "fail");
    btn.title = error.message || String(error);
    noteLog("error", "set", `通道 ${i + 1}（${ch.provider}）测试失败：${error.message || error}`);
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
  if (fetchState === "loading") {
    const orbHost = document.createElement("span");
    orbHost.className = "combo-orb think-host";
    head.appendChild(orbHost);
    startOptionsOrb(orbHost, { state: "connecting", size: 13, speed: 0.9, iconOnly: true, label: "" });
  }
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
    const res = await fetch(`${cfg.base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        max_tokens: 8,
        ...(globalThis.BiliCaptionModelRoute?.requestFields(cfg.model, "none") || {}),
        messages: [{ role: "user", content: "只回复 ok" }]
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

function renderSync() {
  $("syncToggle").classList.toggle("on", Boolean(settings.syncOn));
  $("syncToggle").setAttribute("aria-pressed", String(Boolean(settings.syncOn)));
  $("syncMarks").classList.toggle("on", settings.syncMarks !== false);
  $("syncMarks").textContent = (settings.syncMarks !== false ? "✓ " : "") + "标记";
  $("syncConfig").classList.toggle("on", Boolean(settings.syncConfig));
  $("syncConfig").textContent = (settings.syncConfig ? "✓ " : "") + "设置（服务商 / 模型 / 快捷键）";
  $("syncKeys").classList.toggle("on", Boolean(settings.syncKeys));
  $("syncKeys").textContent = (settings.syncKeys ? "✓ " : "") + "API Key";
  show($("syncKeysWarn"), Boolean(settings.syncKeys));
  $("davStatus").textContent = settings.syncOn
    ? (settings.davLast ? `上次同步 ${settings.davLast}` : "已开启，尚未同步")
    : "同步已关闭";
  $("davStatus").classList.remove("syncing");
}

function collect() {
  const sum = currentSumCfg();
  const channels = sttChannels.map((ch) => ({
    provider: ch.provider,
    key: String(ch.key || "").trim(),
    model: String(ch.model || "").trim(),
    url: String(ch.url || "").trim()
  }));
  const first = channels[0] || {};
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
    davUrl: $("davUrl").value.trim(),
    davUser: $("davUser").value.trim(),
    davPass: $("davPass").value,
    davLast: settings.davLast || ""
  };
}

async function saveSettings() {
  const data = collect();
  const usable = data.sttChannels.some((ch) => P.channelUsable(P.normalizeChannel(ch)));
  await Prefs.saveSettings(data);
  settings = { ...settings, ...data };
  $("settingsMsg").className = usable ? "" : "warn";
  $("settingsMsg").textContent = usable
    ? "已保存"
    : "已保存（还没有可用的转写通道：第 1 条未填 Key，生成字幕前需补填或添加通道）";
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
    davUrl: "",
    davUser: "",
    davPass: "",
    davLast: ""
  });
  // 通道链：优先读 sttChannels；为空则把旧的主 + 备用配置迁移成链
  sttChannels = (Array.isArray(settings.sttChannels) ? settings.sttChannels : [])
    .map((ch) => ({
      provider: ch?.provider,
      key: String(ch?.key || ""),
      model: String(ch?.model || ""),
      url: String(ch?.url || "")
    }))
    .filter((ch) => P.STT_PROVIDERS.includes(ch.provider));
  if (!sttChannels.length) {
    const chain = P.resolveChannels(settings);
    sttChannels = chain.map((cfg) => {
      const meta = P.schema(cfg.provider);
      return {
        provider: cfg.provider,
        key: cfg.key || "",
        // 迁移时保留用户旧模型选择，否则留空走默认
        model: cfg.provider === (settings.sttProvider || "Groq") && settings.sttModel ? settings.sttModel : "",
        url: meta.editableUrl && cfg.base && cfg.base !== meta.url ? cfg.base : ""
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
    sumProvider = p;
    sumFetch = "idle";
    $("sumModel").value = P.SUM_MODELS[p] || "";
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

function logTime(ts) {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

function filteredLogs() {
  const q = $("logQuery").value.trim();
  return appLogs.filter((item) => {
    const level = String(item.level || "info").toUpperCase();
    if (logFilter === "异常" && level === "INFO") return false;
    if (q && !`${item.message || ""}${item.scope || ""}`.includes(q)) return false;
    return true;
  });
}

function renderLogs() {
  const rows = filteredLogs();
  $("logCount").textContent = `${appLogs.length} 条 · 最近 24 小时`;
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
      const lines = String(item.detail).split(/\n/).filter(Boolean);
      if (!lines.length) {
        const d = document.createElement("div");
        d.innerHTML = `<span class="k">详情</span><span class="v"></span>`;
        d.querySelector(".v").textContent = item.detail;
        box.appendChild(d);
      } else {
        for (const line of lines) {
          const [k, ...rest] = line.split(":");
          const d = document.createElement("div");
          d.innerHTML = `<span class="k"></span><span class="v"></span>`;
          d.querySelector(".k").textContent = rest.length ? k : "详情";
          d.querySelector(".v").textContent = rest.length ? rest.join(":").trim() : line;
          box.appendChild(d);
        }
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
$("btnAddChannel").addEventListener("click", () => {
  const provider = $("addChannelProvider").value || P.STT_PROVIDERS[0];
  sttChannels.push({ provider, key: "", model: "", url: "" });
  renderChannels();
  const rows = $("channelList").querySelectorAll(".channel-row");
  rows[rows.length - 1]?.querySelector(".channel-key")?.focus();
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
});
$("ctxDec").addEventListener("click", () => { $("sumCtx").value = String(clampCtx(Number($("sumCtx").value) - 1)); });
$("ctxInc").addEventListener("click", () => { $("sumCtx").value = String(clampCtx(Number($("sumCtx").value) + 1)); });
$("trDec").addEventListener("click", () => { $("trConc").value = String(clampConc(Number($("trConc").value) - 1)); });
$("trInc").addEventListener("click", () => { $("trConc").value = String(clampConc(Number($("trConc").value) + 1)); });
$("syncToggle").addEventListener("click", () => { settings.syncOn = !settings.syncOn; renderSync(); });
$("syncMarks").addEventListener("click", () => { settings.syncMarks = settings.syncMarks === false; renderSync(); });
$("syncConfig").addEventListener("click", () => { settings.syncConfig = !settings.syncConfig; renderSync(); });
$("syncKeys").addEventListener("click", () => { settings.syncKeys = !settings.syncKeys; renderSync(); });
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
let davSyncOrbStop = null;
function setDavSyncing(on) {
  const host = $("davSyncOrb");
  const status = $("davStatus");
  if (!host) return;
  if (on) {
    host.hidden = false;
    status?.classList.add("syncing");
    if (!davSyncOrbStop) {
      davSyncOrbStop = startOptionsOrb(host, { state: "connecting", size: 13, speed: 0.9, iconOnly: true, label: "" });
    }
    return;
  }
  davSyncOrbStop?.();
  davSyncOrbStop = null;
  host.hidden = true;
  status?.classList.remove("syncing");
}

$("syncNow").addEventListener("click", async () => {
  $("davStatus").textContent = "同步中…";
  setDavSyncing(true);
  try {
    const data = collect();
    await Prefs.saveSettings(data);
    const result = await Dav.syncNow(davCfg(), data);
    const label = "刚刚";
    settings.davLast = label;
    await chrome.storage.sync.set({ davLast: label, davAt: result.at });
    $("davStatus").textContent = "上次同步 刚刚";
  } catch (error) {
    $("davStatus").textContent = error.message || String(error);
  } finally {
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
  const text = rows.map((item) => `${logTime(item.t)}  ${(item.level || "info").toUpperCase()}  ${item.scope || "-"}  ${item.message || ""}`).join("\n");
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
  const text = filteredLogs().map((item) => `${logTime(item.t)}  ${(item.level || "info").toUpperCase()}  ${item.scope || "-"}  ${item.message || ""}`).join("\n");
  const blob = new Blob([text || "（没有日志）"], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `bilicaption-${new Date().toISOString().slice(0, 10)}.log`;
  a.click();
  URL.revokeObjectURL(a.href);
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "APP_LOG" || !message.entry) return;
  appLogs.push(message.entry);
  if (appLogs.length > 200) appLogs = appLogs.slice(-200);
  renderLogs();
});

  const $ver = $("appVer");
  if ($ver) $ver.textContent = `v${chrome.runtime.getManifest().version}`;
  loadSettings();
loadLogs();
