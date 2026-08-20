const SUM_BASES = {
  OpenAI: "https://api.openai.com/v1",
  硅基流动: "https://api.siliconflow.cn/v1"
};

const $ = (id) => document.getElementById(id);

const ui = {
  sttKey: $("sttKey"),
  sumProvider: $("sumProvider"),
  sumCustomFields: $("sumCustomFields"),
  sumUrl: $("sumUrl"),
  sumModel: $("sumModel"),
  sumKeyField: $("sumKeyField"),
  sumKey: $("sumKey"),
  summaryPad: $("summaryPad"),
  recordKey: $("recordKey"),
  settingsMsg: $("settingsMsg"),
  testStt: $("testStt"),
  testSum: $("testSum"),
  sttTestMsg: $("sttTestMsg"),
  sumTestMsg: $("sumTestMsg"),
  logFilter: $("logFilter"),
  logEmpty: $("logEmpty"),
  logList: $("logList"),
  copyLogs: $("copyLogs"),
  clearLogs: $("clearLogs")
};

const SCOPE_LABEL = {
  groq: "Groq",
  asr: "转写",
  bili: "B站",
  net: "网络",
  set: "设置",
  app: "应用"
};

let appLogs = [];
let logsReady = false;

const STT_BASE = "https://api.groq.com/openai/v1";

let selKey = "Shift";
let recording = false;

function show(el, on) {
  el.classList.toggle("hidden", !on);
}

function keyLabel(key) {
  return key.length === 1 ? key.toUpperCase() : key;
}


function updateSumFields() {
  const provider = ui.sumProvider.value;
  show(ui.sumCustomFields, provider === "自定义");
  show(ui.sumKeyField, true);
}

function renderRecord() {
  ui.recordKey.textContent = recording ? "按下新按键…" : keyLabel(selKey);
  ui.recordKey.classList.toggle("recording", recording);
}

async function loadSettings() {
  const data = await chrome.storage.sync.get({
    apiBase: "",
    apiKey: "",
    apiModel: "",
    groqApiKey: "",
    sttKey: "",
    sumProvider: "",
    selKey: "Shift",
    summaryPad: 10
  });

  ui.sttKey.value = data.groqApiKey || data.sttKey || "";

  let sumProvider = data.sumProvider;
  if (!sumProvider || sumProvider === "浏览器内置") {
    sumProvider = data.apiBase?.includes("siliconflow") ? "硅基流动" : "OpenAI";
    chrome.storage.sync.set({ sumProvider });
  }
  ui.sumProvider.value = sumProvider;
  ui.sumUrl.value = data.apiBase || "";
  ui.sumModel.value = data.apiModel || "";
  ui.sumKey.value = data.apiKey || "";
  updateSumFields();

  selKey = data.selKey || "Shift";
  ui.summaryPad.value = clampSummaryPad(data.summaryPad);
  renderRecord();
}

function clampSummaryPad(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 10;
  return Math.min(50, Math.max(0, n));
}

async function saveSettings() {
  const sttKey = ui.sttKey.value.trim();
  const sttOk = Boolean(sttKey);

  const sumProvider = ui.sumProvider.value;
  const sumUrl = sumProvider === "自定义"
    ? ui.sumUrl.value.trim()
    : (SUM_BASES[sumProvider] || "");
  const sumKey = ui.sumKey.value.trim();
  const sumModel = ui.sumModel.value.trim();

  if (sumUrl) {
    try {
      await chrome.permissions.request({ origins: [`${new URL(sumUrl).origin}/*`] });
    } catch (error) {
      ui.settingsMsg.className = "fail";
      ui.settingsMsg.textContent = error.message;
      return;
    }
  }

  await chrome.storage.sync.set({
    sttProvider: "Groq",
    sttKey,
    groqApiKey: sttKey,
    sumProvider,
    apiBase: sumUrl,
    apiKey: sumKey,
    apiModel: sumModel,
    selKey,
    summaryPad: clampSummaryPad(ui.summaryPad.value)
  });

  ui.settingsMsg.className = sttOk ? "" : "fail";
  ui.settingsMsg.textContent = sttOk ? "已保存" : "保存失败：Key 不能为空";
}

function setTestMsg(el, text, kind = "") {
  el.textContent = text;
  el.className = `test-msg${kind ? " " + kind : ""}`;
}

function normalizeBase(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

async function ensureOrigin(url) {
  const origin = `${new URL(url).origin}/*`;
  const ok = await chrome.permissions.request({ origins: [origin] });
  if (!ok) throw new Error("没有该接口的访问权限");
}

async function apiFetch(url, key, options = {}) {
  await ensureOrigin(url);
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) {
    throw new Error(json?.error?.message || json?.message || `HTTP ${res.status}`);
  }
  return json;
}

function sttConfig() {
  const key = ui.sttKey.value.trim();
  if (!key) throw new Error("请先填写 Groq API Key");
  return { key, base: STT_BASE };
}

function sumConfig() {
  const provider = ui.sumProvider.value;
  const key = ui.sumKey.value.trim();
  const base = provider === "自定义" ? normalizeBase(ui.sumUrl.value) : SUM_BASES[provider];
  const model = ui.sumModel.value.trim() || (provider === "硅基流动" ? "Qwen/Qwen2.5-7B-Instruct" : "gpt-4o-mini");
  if (!key) throw new Error("请先填写 API Key");
  if (!base) throw new Error("请先填写接口地址");
  return { provider, key, base, model };
}

async function testStt() {
  const btn = ui.testStt;
  btn.disabled = true;
  setTestMsg(ui.sttTestMsg, "测试中…", "pending");
  try {
    const { key, base } = sttConfig();
    const json = await apiFetch(`${base}/models`, key);
    const ids = (json?.data || []).map((item) => item.id).filter(Boolean);
    setTestMsg(ui.sttTestMsg, ids.length ? `Groq 可用，已读到 ${ids.length} 个模型` : "Groq 可用");
    noteLog("info", "set", ids.length ? `测试 Groq 连接成功，${ids.length} 个模型` : "测试 Groq 连接成功");
  } catch (error) {
    setTestMsg(ui.sttTestMsg, error.message || String(error), "fail");
    noteLog("error", "set", `测试 Groq 失败：${error.message || error}`);
  } finally {
    btn.disabled = false;
  }
}

async function testSum() {
  const btn = ui.testSum;
  btn.disabled = true;
  setTestMsg(ui.sumTestMsg, "测试中…", "pending");
  try {
    const { key, base, model } = sumConfig();
    const json = await apiFetch(`${base}/chat/completions`, key, {
      method: "POST",
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 8,
        messages: [{ role: "user", content: "只回复 ok" }]
      })
    });
    const text = json?.choices?.[0]?.message?.content?.trim();
    setTestMsg(ui.sumTestMsg, text ? `可用 · ${model}` : `可用 · ${model}（无文本返回）`);
    noteLog("info", "set", `测试总结连接成功 · ${model}`);
  } catch (error) {
    setTestMsg(ui.sumTestMsg, error.message || String(error), "fail");
    noteLog("error", "set", `测试总结失败：${error.message || error}`);
  } finally {
    btn.disabled = false;
  }
}

ui.sumProvider.addEventListener("change", updateSumFields);
ui.testStt.addEventListener("click", testStt);
ui.testSum.addEventListener("click", testSum);
ui.recordKey.addEventListener("click", () => {
  recording = !recording;
  renderRecord();
});
$("saveSettings").addEventListener("click", saveSettings);

window.addEventListener("keydown", (event) => {
  if (!recording) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === "Escape") {
    recording = false;
    renderRecord();
    return;
  }
  selKey = event.key;
  recording = false;
  renderRecord();
}, true);

function logTime(ts) {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

function filteredLogs() {
  const mode = ui.logFilter.value;
  if (mode === "error") return appLogs.filter((item) => item.level === "error");
  if (mode === "warn") return appLogs.filter((item) => item.level === "error" || item.level === "warn");
  return appLogs;
}

function renderLogs() {
  const rows = filteredLogs();
  show(ui.logEmpty, !appLogs.length);
  show(ui.logList, Boolean(appLogs.length));
  ui.logEmpty.textContent = appLogs.length
    ? "没有符合筛选的日志。"
    : "还没有日志。在侧栏点一次「生成字幕」后，失败和重试会出现在这里。";
  show(ui.logEmpty, !rows.length);
  show(ui.logList, Boolean(rows.length));
  ui.logList.replaceChildren();
  const frag = document.createDocumentFragment();
  for (const item of [...rows].reverse()) {
    const row = document.createElement("div");
    row.className = `log-row ${item.level || "info"}`;
    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = logTime(item.t);
    const scope = document.createElement("span");
    scope.className = "log-scope";
    scope.textContent = SCOPE_LABEL[item.scope] || item.scope || "";
    const body = document.createElement("div");
    body.className = "log-body";
    const msg = document.createElement("div");
    msg.className = "log-msg";
    msg.textContent = item.message || "";
    body.appendChild(msg);
    if (item.detail) {
      const detail = document.createElement("div");
      detail.className = "log-detail";
      detail.textContent = item.detail;
      body.appendChild(detail);
    }
    row.append(time, scope, body);
    frag.appendChild(row);
  }
  ui.logList.appendChild(frag);
}

async function loadLogs() {
  try {
    const data = await chrome.runtime.sendMessage({ type: "GET_LOGS" });
    appLogs = Array.isArray(data?.logs) ? data.logs : [];
  } catch {
    appLogs = [];
  }
  logsReady = true;
  renderLogs();
}

function noteLog(level, scope, message) {
  chrome.runtime.sendMessage({ type: "APPEND_LOG", level, scope, message }).catch(() => {});
}

function formatLogLine(item) {
  const detail = item.detail ? `  ${item.detail}` : "";
  return `${logTime(item.t)}  ${(item.level || "info").toUpperCase().padEnd(5)}  ${item.scope || "-"}  ${item.message || ""}${detail}`;
}

ui.logFilter.addEventListener("change", renderLogs);
ui.copyLogs.addEventListener("click", async () => {
  const text = filteredLogs().map(formatLogLine).join("\n");
  try {
    await navigator.clipboard.writeText(text || "（没有日志）");
    ui.copyLogs.textContent = "已复制";
    setTimeout(() => { ui.copyLogs.textContent = "复制"; }, 1200);
  } catch {
    ui.copyLogs.textContent = "复制失败";
    setTimeout(() => { ui.copyLogs.textContent = "复制"; }, 1200);
  }
});
ui.clearLogs.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "CLEAR_LOGS" });
  appLogs = [];
  renderLogs();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "APP_LOG" || !message.entry || !logsReady) return;
  const next = message.entry;
  if (appLogs.some((item) => item.t === next.t && item.message === next.message)) return;
  appLogs.push(next);
  if (appLogs.length > 200) appLogs = appLogs.slice(-200);
  renderLogs();
});

loadSettings();
loadLogs();
