// 侧栏 · 字幕视图底部快捷栏（设计稿 actions / moreActions / customizing）：
// 8 个操作里最多 3 个「放在外面」，其余进「更多 ⋯」菜单；菜单里可切到自定义状态勾选。
// 各操作按钮本身（事件、禁用、文字、高亮）都不动，这里只把同一个按钮挪到快捷栏或菜单里，
// 所以原有的处理函数、禁用条件照旧生效。侧栏和浮窗（sidepanel.html?embed=1）是同一页面，共用这份实现。
// 选择存在 chrome.storage.sync 的 quickBarPins：和 overlayOn / captionLang 这类界面偏好放一起，
// 随 Chrome 账号同步、侧栏与浮窗经 storage.onChanged 即时一致；不进 WebDAV 的 config.json（那里只收服务配置）。

const QUICK_BAR_KEY = "quickBarPins";
const QUICK_BAR_MAX = 3;
const QUICK_BAR_DEFAULT = ["sel", "mark", "overlay"];
const QUICK_BAR_ACTIONS = [
  { id: "sel", btn: "btnSelect", name: "划选" },
  { id: "mark", btn: "btnMarkNow", name: "添加标记" },
  { id: "overlay", btn: "btnOverlay", name: "显示字幕" },
  { id: "gen", btn: "btnGenerate", name: "生成字幕" },
  { id: "srt", btn: "btnSrt", name: "下载 SRT" },
  { id: "txt", btn: "btnTxt", name: "下载纯文本" },
  { id: "tr", btn: "btnTranslate", name: "翻译成中文" },
  { id: "clear", btn: "btnClearCache", name: "清理缓存" }
];

let quickPins = ["sel", "mark", "overlay"];
let quickCustomizing = false;

/** 读到的配置 → 合法的固定清单：没存过用默认；去掉未知 id 和重复，超过 3 个截断 */
function normalizeQuickPins(value) {
  if (!Array.isArray(value)) return QUICK_BAR_DEFAULT.slice();
  const known = new Set(QUICK_BAR_ACTIONS.map((item) => item.id));
  const out = [];
  for (const id of value) {
    if (known.has(id) && !out.includes(id)) out.push(id);
  }
  return out.slice(0, QUICK_BAR_MAX);
}

/** 没固定的操作，按操作清单顺序进「更多」 */
function quickMenuIds(pins = quickPins) {
  return QUICK_BAR_ACTIONS.map((item) => item.id).filter((id) => !pins.includes(id));
}

/** 勾选 / 取消一个操作后的清单；已满 3 个时未勾选的点了不变 */
function toggleQuickPinList(pins, id) {
  if (pins.includes(id)) return pins.filter((item) => item !== id);
  if (pins.length >= QUICK_BAR_MAX) return pins;
  return [...pins, id];
}

function quickActionButton(id) {
  const item = QUICK_BAR_ACTIONS.find((action) => action.id === id);
  return item ? $(item.btn) : null;
}

/** 自定义列表里的名称；生成字幕跟按钮当前文字走（已生成过是「重新生成字幕」） */
function quickActionName(item) {
  if (item.id === "gen" && /重新/.test(ui.btnGenerate?.textContent || "")) return "重新生成字幕";
  return item.name;
}

/** 按 quickPins 把按钮摆进快捷栏（字幕助手按钮之前）或「更多」菜单 */
function renderQuickBar() {
  const bar = ui.actionBar;
  const chat = $("btnChat");
  const list = $("moreActions");
  if (bar && chat && list) {
    for (const id of quickPins) {
      const btn = quickActionButton(id);
      if (!btn) continue;
      btn.classList.add("btn-outline");
      bar.insertBefore(btn, chat);
    }
    for (const id of quickMenuIds()) {
      const btn = quickActionButton(id);
      if (!btn) continue;
      btn.classList.remove("btn-outline");
      list.appendChild(btn);
    }
  }
  renderQuickCustom();
}

/** 菜单的两种状态：操作列表 +「自定义快捷栏…」，或「放在外面」勾选列表 */
function renderQuickCustom() {
  show($("moreNormal"), !quickCustomizing);
  show($("quickCustom"), quickCustomizing);
  const count = $("quickPinCount");
  if (count) count.textContent = `${quickPins.length}/${QUICK_BAR_MAX}`;
  const rows = $("quickPinRows");
  if (!rows || !quickCustomizing) return;
  const full = quickPins.length >= QUICK_BAR_MAX;
  rows.replaceChildren(...QUICK_BAR_ACTIONS.map((item) => {
    const on = quickPins.includes(item.id);
    const off = !on && full;
    const row = document.createElement("button");
    row.type = "button";
    row.className = `quick-pin-row${on ? " on" : ""}${off ? " off" : ""}`;
    row.dataset.pin = item.id;
    row.setAttribute("role", "menuitemcheckbox");
    row.setAttribute("aria-checked", String(on));
    row.setAttribute("aria-disabled", String(off));
    const box = document.createElement("span");
    box.className = "quick-pin-box";
    box.textContent = on ? "✓" : "";
    const name = document.createElement("span");
    name.textContent = quickActionName(item);
    row.append(box, name);
    row.addEventListener("click", () => toggleQuickPin(item.id));
    return row;
  }));
}

function applyQuickPins(value) {
  quickPins = normalizeQuickPins(value);
  renderQuickBar();
}

async function loadQuickPins() {
  const data = await chrome.storage.sync.get({ [QUICK_BAR_KEY]: null });
  applyQuickPins(data?.[QUICK_BAR_KEY]);
}

/** 勾选即时生效并保存 */
function saveQuickPins(next) {
  applyQuickPins(next);
  chrome.storage.sync.set({ [QUICK_BAR_KEY]: quickPins.slice() }).catch(() => {});
}

function toggleQuickPin(id) {
  const next = toggleQuickPinList(quickPins, id);
  if (next === quickPins) return;
  saveQuickPins(next);
}

function resetQuickPins() {
  saveQuickPins(QUICK_BAR_DEFAULT);
}

function setQuickCustomizing(on) {
  quickCustomizing = Boolean(on);
  renderQuickCustom();
}

/** Esc 收起「更多」菜单（连同自定义状态） */
function closeMoreOnEscape(event) {
  if (event?.key !== "Escape" || !moreOpen) return;
  setMoreOpen(false);
}
