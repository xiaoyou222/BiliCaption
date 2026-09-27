// 侧栏 · 顶栏与标记：倍速菜单、站点图标与登录状态、标题，更多菜单，
// 时间标记的增删改、AI 润色、导出，以及打开设置页 / 标记库。

const SPEED_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

function snapRate(rate) {
  const n = Number(rate) || 1;
  return Math.min(10, Math.max(0.1, Math.round(n * 100) / 100));
}

function currentRate() {
  return snapRate(state?.rate || 1);
}

function formatRate(rate) {
  const n = snapRate(rate);
  if (Number.isInteger(n)) return `${n}×`;
  return `${n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}×`;
}

function renderSpeed(rate) {
  const value = snapRate(rate);
  if (state) state.rate = value;
  if (ui.speedValue) ui.speedValue.textContent = formatRate(value);
  ui.speedBtn?.classList.toggle("boosted", Math.abs(value - 1) > 0.001);
  if (!ui.speedMenu) return;
  const rates = SPEED_PRESETS.slice();
  if (!rates.some((item) => Math.abs(item - value) < 0.001)) rates.push(value);
  const html = rates.map((item) => {
    const on = Math.abs(item - value) < 0.001 ? " on" : "";
    return `<button type="button" role="option" aria-selected="${on ? "true" : "false"}" data-rate="${item}" class="${on.trim()}">${formatRate(item)}</button>`;
  }).join("");
  if (ui.speedMenu.dataset.html !== html) {
    ui.speedMenu.dataset.html = html;
    ui.speedMenu.innerHTML = html;
  } else {
    ui.speedMenu.querySelectorAll("button").forEach((btn) => {
      const selected = Math.abs(Number(btn.dataset.rate) - value) < 0.001;
      btn.classList.toggle("on", selected);
      btn.setAttribute("aria-selected", selected ? "true" : "false");
    });
  }
}

function setSpeedMenuOpen(open) {
  show(ui.speedMenu, open);
  ui.speedBtn?.setAttribute("aria-expanded", open ? "true" : "false");
}

function platformOf(next = state) {
  return next?.platform || next?.login?.platform || "";
}

function platformLabels(next = state) {
  return BiliCaptionPlatforms.labels(platformOf(next));
}

function applyPlatformChrome(next = state) {
  const copy = platformLabels(next);
  if (document.title !== copy.panel) document.title = copy.panel;
  const tabId = boundTabId || myTabId;
  if (tabId && chrome.action?.setTitle) {
    chrome.action.setTitle({ tabId, title: copy.action }).catch(() => {});
  }
}

function setSiteIcon(platform, on) {
  show(ui.siteIconB, on && platform === "bilibili");
  show(ui.siteIconY, on && platform === "youtube");
  show(ui.siteIconX, on && platform === "x");
}

function renderLogin(login, next = state) {
  const hinted = login?.platform || next?.platform || "";
  if (["youtube", "x"].includes(hinted)) lastLogin = { platform: hinted };
  else lastLogin = login || lastLogin;
  const data = lastLogin;
  const platform = hinted || data?.platform || (data?.isLogin || data?.uname ? "bilibili" : "");
  const external = platform === "youtube" || platform === "x";
  const loggedIn = external || Boolean(data?.isLogin);
  const showIcon = Boolean(platform) && loggedIn;
  setSiteIcon(platform, showIcon);
  ui.header.classList.toggle("warn", !loggedIn);
  ui.loginDot.className = showIcon ? "login-dot" : "login-dot warn";
  show(ui.loginDot, !showIcon);
  ui.loginLabel.textContent = !data && !external ? "登录未知" : "未登录";
  show(ui.loginLabel, !showIcon);
}

function sameLastVideo(next) {
  return !next?.bvid || !lastVideo?.bvid || next.bvid === lastVideo.bvid;
}

function renderHeaderTitle(next) {
  const same = sameLastVideo(next);
  const label = BiliCaptionPlatforms.headerLabel({
    ...next,
    title: next?.title || (same ? lastVideo?.title : "") || "",
    titleFull: next?.titleFull || (same && !next?.title ? lastVideo?.titleFull : "") || "",
    part: next?.part || (same ? lastVideo?.part : "") || "",
    up: next?.up || (same ? lastVideo?.up : "") || ""
  });
  ui.headerTitle.textContent = label.text;
  ui.headerTitle.title = label.tip || "";
}

function persistLastVideo(next) {
  if (!next?.bvid && !next?.title) return;
  if (next.page === "loading" || next.subtitleStatus === "pending") return;
  const same = sameLastVideo(next);
  if (!same && !next.title) return;
  lastVideo = {
    title: next.title || (same ? lastVideo?.title : "") || "",
    titleFull: next.titleFull || (same ? lastVideo?.titleFull : "") || "",
    part: next.part || (same ? lastVideo?.part : "") || "",
    bvid: next.bvid || (same ? lastVideo?.bvid : "") || "",
    pic: next.pic || (same ? lastVideo?.pic : "") || "",
    up: next.up || (same ? lastVideo?.up : "") || ""
  };
  chrome.storage.local.set({ lastVideo }).catch(() => {});
}

function renderLastVideoHint() {
  if (!lastVideo?.bvid && !lastVideo?.part) {
    ui.lastVideoHint.textContent = "";
    return;
  }
  const bits = [lastVideo.bvid, lastVideo.part].filter(Boolean);
  ui.lastVideoHint.textContent = bits.length ? `上次：${bits.join(" · ")}` : "";
}

function setMoreOpen(open) {
  moreOpen = open;
  show(ui.moreMenu, open);
  ui.btnMore.classList.toggle("active", open);
  if (open) {
    setSpeedMenuOpen(false);
    setMarkerMoreOpen(false);
  }
}

function setMarkerMoreOpen(open) {
  markerMoreOpen = open;
  show($("markerMoreMenu"), open);
  $("btnMarkerMore")?.classList.toggle("active", open);
  if (open) {
    moreOpen = false;
    show(ui.moreMenu, false);
    ui.btnMore?.classList.remove("active");
    setSpeedMenuOpen(false);
  }
}

function markersApi() {
  return globalThis.BiliCaptionMarkers;
}

function marksVideoKey(next = state) {
  if (!next?.bvid && next?.cid == null) return "";
  return `${next?.bvid || ""}:${Number(next?.cid) || 0}`;
}

function markerMeta(next = state) {
  const same = sameLastVideo(next);
  return {
    title: next?.title || (same ? lastVideo?.title : "") || "",
    up: next?.up || (same ? lastVideo?.up : "") || "",
    part: next?.part || (same ? lastVideo?.part : "") || "",
    dur: formatClock(next?.duration || next?.durationMeta || (same ? lastVideo?.duration : 0) || 0),
    pic: next?.pic || (same ? lastVideo?.pic : "") || ""
  };
}

async function loadMarkers(next = state) {
  const M = markersApi();
  const key = marksVideoKey(next);
  if (!M || !key) {
    markers = [];
    markerKey = "";
    editingMarkerId = null;
    markerDrafts.clear();
    return;
  }
  if (key !== markerKey) {
    editingMarkerId = null;
    markerDrafts.clear();
    markerKey = key;
  }
  const list = await M.load(next.bvid, next.cid);
  if (marksVideoKey(state) !== key && marksVideoKey(next) !== marksVideoKey(state)) return;
  markers = list;
  syncProgressMarks(list, next);
}

function syncProgressMarks(list = markers, next = state) {
  sendToTab({
    type: "SYNC_MARKERS",
    bvid: next?.bvid || "",
    cid: Number(next?.cid) || 0,
    markers: (list || []).map((m) => ({
      id: m.id,
      time: Number(m.time) || 0,
      text: String(m.text || "")
    }))
  }).catch(() => {});
}

function sameMarkerId(a, b) {
  return String(a) === String(b);
}

function renderMarkerBar() {
  const label = `+ 标记 ${formatClock(state?.currentTime || 0)}`;
  const add = $("btnAddMarker");
  if (add) add.textContent = label;
  const now = $("btnMarkNow");
  if (now) now.textContent = label;
}

function renderMarkers() {
  const host = $("markerList");
  const empty = $("markerEmpty");
  if (!host || !empty) return;
  const has = markers.length > 0;
  show(host, has);
  show(empty, !has);
  host.replaceChildren();
  renderMarkerBar();
  updateSummaryMarkerBtn();
  if (!has) return;

  for (const m of markers) {
    const row = document.createElement("div");
    const polishing = polishingIds.has(String(m.id));
    row.className = polishing ? "marker-row is-polishing" : "marker-row";
    row.dataset.id = String(m.id);

    const time = document.createElement("time");
    time.textContent = formatClock(m.time);

    const body = document.createElement("div");
    body.style.cssText = "flex:1;min-width:0";

    if (sameMarkerId(editingMarkerId, m.id)) {
      const ta = document.createElement("textarea");
      ta.rows = 2;
      ta.placeholder = "写点什么…";
      ta.value = markerDrafts.has(m.id) ? markerDrafts.get(m.id) : (m.text || "");
      ta.addEventListener("click", (e) => e.stopPropagation());
      ta.addEventListener("pointerdown", (e) => e.stopPropagation());
      ta.addEventListener("input", () => {
        markerDrafts.set(m.id, ta.value);
        ta.style.height = "auto";
        ta.style.height = `${ta.scrollHeight}px`;
      });
      ta.addEventListener("blur", () => commitMarker(m.id));
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          ta.blur();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          markerDrafts.delete(m.id);
          editingMarkerId = null;
          renderMarkers();
        }
      });
      body.appendChild(ta);
      requestAnimationFrame(() => {
        ta.focus();
        ta.style.height = "auto";
        ta.style.height = `${ta.scrollHeight}px`;
        const end = ta.value.length;
        ta.setSelectionRange(end, end);
      });
    } else {
      const p = document.createElement("span");
      const live = polishing ? (polishDrafts.get(String(m.id)) ?? m.text) : m.text;
      p.className = `marker-text${live ? "" : " empty"}${polishing ? " streaming" : ""}`;
      p.textContent = live || "（空）";
      p.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        startEditMarker(m.id);
      });
      body.appendChild(p);
    }

    const tools = document.createElement("div");
    tools.className = "marker-tools";
    const ai = document.createElement("button");
    ai.type = "button";
    ai.className = "marker-ai";
    ai.textContent = "AI";
    ai.title = "用 AI 润色这条笔记";
    ai.addEventListener("click", (e) => {
      e.stopPropagation();
      polishMarker(m.id);
    });
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "×";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteMarker(m.id);
    });
    tools.append(ai, del);

    row.append(time, body, tools);
    if (polishing) {
      const cover = document.createElement("div");
      cover.className = "marker-polish";
      row.appendChild(cover);
      setBeam(cover, true);
    }
    row.addEventListener("click", () => {
      if (sameMarkerId(editingMarkerId, m.id) || polishing) return;
      sendToTab({ type: "SEEK", time: m.time }).catch((error) => {
        flash(error.message || "跳转失败，请先点一下视频页");
      });
    });
    host.appendChild(row);
  }
}

function startEditMarker(id) {
  editingMarkerId = id;
  const m = markers.find((x) => sameMarkerId(x.id, id));
  if (m && !markerDrafts.has(m.id)) markerDrafts.set(m.id, m.text || "");
  renderMarkers();
}

async function commitMarker(id) {
  const M = markersApi();
  if (!M || !state) {
    editingMarkerId = null;
    return;
  }
  const draft = String(markerDrafts.get(id) ?? "").trim();
  markerDrafts.delete(id);
  if (sameMarkerId(editingMarkerId, id)) editingMarkerId = null;
  try {
    markers = await M.update(state.bvid, state.cid, id, draft, markerMeta());
    syncProgressMarks();
  } catch {
    await loadMarkers(state);
  }
  renderMarkers();
}

const POLISH_SYSTEM = [
  "你是中文文字编辑。把口语、随意的笔记改写成标准、专业、准确的书面描述。",
  "去掉口语风格，信息点全部保留，不总结、不省略。只输出正文。"
].join("");

function buildPolishPrompt(text) {
  return [
    "请把下面这段中文笔记润色成标准、专业的书面描述。",
    "原文多半是随手记、口语化的。请改成更精准的表述：去掉「呃、那个、就是、然后、我觉得」这类口头禅和含糊说法，用书面语把意思写清楚。",
    "可以调整语序、合并重复、拆开含糊的长句。术语、数字、人名、例子、条件、对比都要留下。",
    "口头禅去掉后可以略短，但每个信息点都要在，不要收成摘要，不要只留中心思想。",
    "不要标题、不要列表、不要加粗、不要解释你改了什么。只输出润色后的正文。",
    "",
    "【原文】",
    String(text || "").trim()
  ].join("\n");
}

async function polishMarker(id) {
  const m = markers.find((x) => sameMarkerId(x.id, id));
  if (!m || polishingIds.has(String(id))) return;
  const text = String(m.text || "").trim();
  if (!text) {
    flash("这条还没有内容，先写点什么再润色");
    return;
  }
  polishingIds.add(String(id));
  polishDrafts.set(String(id), text);
  if (sameMarkerId(editingMarkerId, id)) editingMarkerId = null;
  renderMarkers();
  const ac = new AbortController();
  polishAbort.set(String(id), ac);
  const paint = (full) => {
    polishDrafts.set(String(id), full);
    const node = document.querySelector(`#markerList .marker-row[data-id="${CSS.escape(String(id))}"] .marker-text`);
    if (!node) return;
    node.textContent = full || "（空）";
    node.classList.toggle("empty", !full);
    node.classList.add("streaming");
  };
  try {
    const out = String(await runModel(buildPolishPrompt(text), {
      signal: ac.signal,
      task: "polish",
      system: POLISH_SYSTEM,
      onDelta(full) { paint(full); }
    }) || "").trim();
    if (!out) throw new Error("润色结果是空的");
    const M = markersApi();
    if (!M || !state) return;
    markers = await M.update(state.bvid, state.cid, id, out, markerMeta());
    syncProgressMarks();
    flash(`已润色 · ${formatClock(m.time)}`);
  } catch (error) {
    if (error?.name === "AbortError" || error?.canceled) return;
    flash(error.message || "润色失败");
  } finally {
    polishingIds.delete(String(id));
    polishAbort.delete(String(id));
    polishDrafts.delete(String(id));
    renderMarkers();
  }
}

async function deleteMarker(id) {
  polishAbort.get(String(id))?.abort();
  polishingIds.delete(String(id));
  polishAbort.delete(String(id));
  polishDrafts.delete(String(id));
  const M = markersApi();
  if (!M || !state) return;
  if (sameMarkerId(editingMarkerId, id)) editingMarkerId = null;
  markerDrafts.delete(id);
  markers = await M.remove(state.bvid, state.cid, id, markerMeta());
  syncProgressMarks();
  renderMarkers();
}

async function addManualMarker() {
  if (!state) return;
  const time = Math.floor(Number(state.currentTime) || 0);
  const M = markersApi();
  if (!M) return;
  try {
    markers = await M.add(state.bvid, state.cid, { time, text: "" }, markerMeta());
    syncProgressMarks();
    const added = markers.find((m) => Math.floor(m.time) === time);
    editingMarkerId = added?.id ?? null;
    if (editingMarkerId != null) markerDrafts.set(editingMarkerId, "");
    view = "markers";
    renderState(state);
  } catch (error) {
    flash(error.message || "添加失败");
    if (error.duplicate) {
      view = "markers";
      renderState(state);
    }
  }
}

function summaryMarkerText() {
  const edit = $("summaryEdit");
  if (edit && !edit.classList.contains("hidden")) return edit.value.trim();
  return (ui.summaryText?.innerText || ui.summaryText?.textContent || "").trim();
}

function summaryMarkerTime() {
  if (Number.isFinite(summaryMarkTime)) return summaryMarkTime;
  const from = Math.min(range.start, range.end >= 0 ? range.end : range.start);
  if (from >= 0 && state?.cues?.[from]) return Number(state.cues[from].from) || 0;
  return Number(state?.currentTime) || 0;
}

async function addMarkerFromSummary() {
  const text = summaryMarkerText();
  if (!text) {
    flash("还没有总结内容");
    return;
  }
  const time = summaryMarkerTime();
  const M = markersApi();
  if (!M || !state) return;
  try {
    markers = await M.add(state.bvid, state.cid, { time, text }, markerMeta());
    syncProgressMarks();
    flash(`已添加标记 · ${formatClock(time)}`);
    updateSummaryMarkerBtn();
  } catch (error) {
    flash(error.message || "添加失败");
  }
}

function updateSummaryMarkerBtn() {
  const btn = $("btnAddMarkerSummary");
  if (!btn) return;
  if (!hasSummary) {
    btn.textContent = "+ 标记";
    btn.classList.remove("active");
    return;
  }
  const time = summaryMarkerTime();
  const exists = markers.some((m) => Math.floor(m.time) === Math.floor(time));
  btn.textContent = exists ? "已标记" : "+ 标记";
  btn.classList.toggle("active", exists);
}

function openLibrary() {
  const id = marksVideoKey();
  openExtensionPage("library.html", id ? `?id=${encodeURIComponent(id)}` : "");
}

function markerEntry() {
  return {
    bvid: state?.bvid || "",
    cid: Number(state?.cid) || 0,
    title: state?.title || "",
    part: state?.part || "",
    dur: formatClock(state?.duration || 0)
  };
}

async function copyMarkers() {
  const M = markersApi();
  if (!M || !markers.length) {
    flash("还没有标记");
    return;
  }
  try {
    await copyText(M.copyText(markers, state?.bvid || ""));
    flash(`已复制 ${markers.length} 条标记（时间戳为可点链接）`);
  } catch {
    flash("复制失败");
  }
}

function exportMarkers(kind) {
  const M = markersApi();
  if (!M || !markers.length) {
    flash("还没有标记");
    return;
  }
  const entry = markerEntry();
  if (kind === "md") {
    const name = `${fileBase()}-marks.md`;
    downloadText(name, M.toMarkdown(entry, markers));
    flash(`已保存 ${name} · 时间戳链接可打开原视频`);
  } else {
    const name = `${fileBase()}-marks.csv`;
    downloadText(name, M.toCsv(entry, markers));
    flash(`已保存 ${name} · 含 URL 列`);
  }
}

function openExtensionPage(file, query = "") {
  const url = chrome.runtime.getURL(file) + query;
  chrome.tabs.create({ url }).catch(() => {
    chrome.runtime.openOptionsPage();
  });
}

const SETTINGS_TABS = ["stt", "sum", "sync", "keys", "logs"];

function openSettings(tab) {
  const name = SETTINGS_TABS.includes(tab) ? tab : "";
  const query = name ? `?tab=${encodeURIComponent(name)}` : "";
  openExtensionPage("options.html", query);
}

function openBiliLogin() {
  chrome.tabs.create({ url: "https://passport.bilibili.com/login" });
}
