const M = window.BiliCaptionMarkers;
const $ = (id) => document.getElementById(id);

let index = [];
let selectedId = "";
let marks = [];
let query = "";
let trash = [];
let trashOpen = false;
let trashSel = null;
let undoTimer = 0;
let undoIds = [];

function show(el, on) {
  el.classList.toggle("hidden", !on);
}

function clip(text, n = 12) {
  const s = String(text || "");
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function videoKey(v) {
  return v?.id || `${v?.bvid || ""}:${Number(v?.cid) || 0}`;
}

function groupTrash(list) {
  const videos = list.filter((item) => item.kind === "video");
  const groups = new Map();
  for (const item of list.filter((row) => row.kind === "mark")) {
    const key = videoKey(item.entry);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return { videos, markGroups: [...groups.entries()].map(([key, items]) => ({ key, items, entry: items[0].entry })) };
}

function resolveTrashSel() {
  if (!trashSel) return null;
  const grouped = groupTrash(trash);
  if (trashSel.kind === "video") {
    const item = grouped.videos.find((row) => row.id === trashSel.id);
    if (!item) return null;
    return {
      kind: "video",
      id: item.id,
      entry: item.entry,
      title: item.entry?.title || item.entry?.bvid || "",
      marks: item.marks || [],
      days: M.daysLeft(item.deletedAt),
      restoreAll: () => M.restoreTrashItem(item.id)
    };
  }
  const group = grouped.markGroups.find((row) => row.key === trashSel.key);
  if (!group) return null;
  const oldest = Math.min(...group.items.map((item) => Number(item.deletedAt) || 0));
  return {
    kind: "marks",
    key: group.key,
    entry: group.entry,
    title: group.entry?.title || group.entry?.bvid || "",
    marks: group.items.map((item) => item.mark).filter(Boolean),
    days: M.daysLeft(oldest),
    restoreAll: async () => {
      for (const item of group.items) await M.restoreTrashItem(item.id);
    },
    restoreMark: async (markId) => {
      const item = group.items.find((row) => String(row.mark?.id) === String(markId));
      if (item) await M.restoreTrashItem(item.id);
    }
  };
}

function dismissUndo() {
  clearTimeout(undoTimer);
  undoIds = [];
  show($("libUndo"), false);
}

function armUndo(msg, ids) {
  undoIds = ids.filter(Boolean);
  $("libUndoLabel").textContent = msg;
  show($("libUndo"), undoIds.length > 0);
  clearTimeout(undoTimer);
  undoTimer = setTimeout(dismissUndo, 6000);
}

async function refresh() {
  index = (await M.loadIndex()).filter((v) => Number(v.count) > 0);
  trash = await M.loadTrash();
  const settings = await chrome.storage.sync.get({ syncOn: false, davLast: "", davAt: 0 });
  const ago = window.BiliCaptionDav?.formatSyncAgo?.(settings.davAt) || settings.davLast;
  $("libSyncDot").classList.toggle("on", Boolean(settings.syncOn));
  $("libSyncLabel").textContent = settings.syncOn
    ? (ago ? `WebDAV 已同步 · ${ago}` : "WebDAV 已开启 · 尚未同步")
    : "未开启同步";
}

async function fillMissingCovers(videos) {
  const need = (videos || []).filter((v) => v.bvid && !String(v.pic || "").trim());
  if (!need.length) return false;
  let changed = false;
  await Promise.all(need.slice(0, 24).map(async (v) => {
    try {
      const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(v.bvid)}`, {
        credentials: "include"
      });
      const json = await res.json();
      const data = json?.data || {};
      const pic = M.coverUrl(data.pic);
      const up = String(data.owner?.name || "").trim();
      if (!pic && !up) return;
      v.pic = pic || v.pic;
      if (up) v.up = up;
      await M.patchIndex(v.bvid, v.cid, { pic: v.pic, up: v.up });
      changed = true;
    } catch {
      // 单条封面失败不影响列表
    }
  }));
  return changed;
}

async function load() {
  await refresh();
  const want = new URLSearchParams(location.search).get("id");
  if (want && index.some((v) => videoKey(v) === want)) selectedId = want;
  if (!selectedId && index[0]) selectedId = videoKey(index[0]);
  await render();
  if (await fillMissingCovers(index)) {
    index = (await M.loadIndex()).filter((v) => Number(v.count) > 0);
    await render();
  }
}

function filteredVideos() {
  const q = query.trim();
  if (!q) return index;
  return index.filter((v) => `${v.title} ${v.up} ${v.bvid}`.includes(q));
}

function renderVideos(videos) {
  const host = $("libVideos");
  host.replaceChildren();
  videos.forEach((v) => {
    const id = videoKey(v);
    const row = document.createElement("div");
    row.className = `v-row${id === selectedId && !trashSel ? " on" : ""}`;
    row.innerHTML = `<div class="v-thumb"></div><div style="min-width:0;flex:1"><div class="v-title"></div><div class="v-meta"></div></div>`;
    const thumb = row.querySelector(".v-thumb");
    const pic = M.coverUrl(v.pic);
    if (pic) {
      thumb.classList.add("has-cover");
      const img = document.createElement("img");
      img.src = pic;
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      img.draggable = false;
      thumb.appendChild(img);
    }
    const dur = document.createElement("span");
    dur.className = "v-dur";
    dur.textContent = v.dur || "";
    thumb.appendChild(dur);
    row.querySelector(".v-title").textContent = v.title || v.bvid;
    row.querySelector(".v-meta").textContent = `${v.up || "未知"} · ${v.part || "P1"} · ${v.count || 0} 条 · ${v.when || ""}`;
    row.addEventListener("click", async () => {
      selectedId = id;
      trashSel = null;
      await render();
    });
    host.appendChild(row);
  });
}

function renderTrash() {
  const grouped = groupTrash(trash);
  const items = grouped.videos.length + grouped.markGroups.length;
  show($("libTrashWrap"), items > 0);
  $("libTrashCount").textContent = `${items} 项`;
  $("libTrashCaret").classList.toggle("open", trashOpen);
  const list = $("libTrashList");
  show(list, trashOpen && items > 0);
  list.replaceChildren();
  if (!trashOpen || !items) return;

  const addRow = (sel, title, meta, onRestore) => {
    const row = document.createElement("div");
    const on = (trashSel?.kind === "video" && trashSel.id === sel.id)
      || (trashSel?.kind === "marks" && trashSel.key === sel.key);
    row.className = `t-row${on ? " on" : ""}`;
    row.innerHTML = `<div style="display:flex;flex-direction:column;gap:2px;min-width:0;flex:1"><span class="t-title"></span><span class="t-meta"></span></div><button type="button" class="t-restore">恢复</button>`;
    row.querySelector(".t-title").textContent = title;
    row.querySelector(".t-meta").textContent = meta;
    row.addEventListener("click", async () => {
      trashSel = sel;
      await render();
    });
    row.querySelector(".t-restore").addEventListener("click", async (e) => {
      e.stopPropagation();
      await onRestore();
    });
    list.appendChild(row);
  };

  for (const item of grouped.videos) {
    addRow(
      { kind: "video", id: item.id },
      item.entry?.title || item.entry?.bvid || "未命名视频",
      `全部标记 · ${(item.marks || []).length} 条 · 剩余 ${M.daysLeft(item.deletedAt)} 天`,
      async () => {
        dismissUndo();
        await M.restoreTrashItem(item.id);
        selectedId = videoKey(item.entry);
        trashSel = null;
        await refresh();
        await render();
      }
    );
  }
  for (const group of grouped.markGroups) {
    const oldest = Math.min(...group.items.map((item) => Number(item.deletedAt) || 0));
    addRow(
      { kind: "marks", key: group.key },
      group.entry?.title || group.entry?.bvid || "未命名视频",
      `部分标记 · ${group.items.length} 条 · 剩余 ${M.daysLeft(oldest)} 天`,
      async () => {
        dismissUndo();
        for (const item of group.items) await M.restoreTrashItem(item.id);
        selectedId = videoKey(group.entry);
        trashSel = null;
        await refresh();
        await render();
      }
    );
  }

  const hint = document.createElement("span");
  hint.className = "lib-trash-hint";
  hint.textContent = "删除 30 天后自动清除";
  list.appendChild(hint);
}

function renderMarkRows(list, rows, { dim, onClick, onDelete, onRestore }) {
  list.replaceChildren();
  for (const m of rows) {
    const row = document.createElement("div");
    row.className = `m-row${dim ? " dim" : ""}`;
    row.innerHTML = `<span class="m-time"></span><span class="m-text"></span>`;
    row.querySelector(".m-time").textContent = M.fmt(m.time);
    row.querySelector(".m-text").textContent = m.text || "（空）";
    if (onDelete) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "m-del";
      btn.title = "删除这条标记";
      btn.textContent = "×";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        onDelete(m);
      });
      row.appendChild(btn);
    }
    if (onRestore) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "m-restore";
      btn.textContent = "恢复";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        onRestore(m);
      });
      row.appendChild(btn);
    }
    if (onClick) row.addEventListener("click", () => onClick(m));
    list.appendChild(row);
  }
}

async function renderLive(videos) {
  const cur = videos.find((v) => videoKey(v) === selectedId) || videos[0] || null;
  if (cur) selectedId = videoKey(cur);
  show($("libToolbar"), Boolean(cur));
  show($("libTrashBar"), false);
  show($("libNone"), !videos.length);
  if (!cur) {
    $("libCurCount").textContent = "0 条标记";
    $("libMarks").replaceChildren();
    show($("libMarks"), false);
    show($("libEmpty"), false);
    return;
  }
  marks = await M.load(cur.bvid, cur.cid);
  const q = query.trim();
  const shown = q ? marks.filter((m) => (m.text || "").includes(q) || (cur.title || "").includes(q)) : marks;
  $("libCurCount").textContent = `${shown.length} 条标记`;
  show($("libEmpty"), !shown.length);
  show($("libMarks"), shown.length > 0);
  renderMarkRows($("libMarks"), shown, {
    onClick: (m) => chrome.tabs.create({ url: M.biliUrl(cur.bvid, m.time) }),
    onDelete: async (m) => {
      const item = await M.trashMark(cur.bvid, cur.cid, m.id);
      armUndo(`已移入最近删除 · ${clip(m.text)}`, [item?.id]);
      await refresh();
      if (!index.some((v) => videoKey(v) === selectedId)) {
        selectedId = index[0] ? videoKey(index[0]) : "";
      }
      await render();
    }
  });
}

async function renderTrashView(view) {
  show($("libToolbar"), false);
  show($("libTrashBar"), true);
  show($("libNone"), false);
  show($("libEmpty"), false);
  show($("libMarks"), true);
  $("libTrashSelTitle").textContent = view.title;
  $("libTrashSelMeta").textContent = `已删除 · ${view.marks.length} 条 · 剩余 ${view.days} 天`;
  renderMarkRows($("libMarks"), view.marks, {
    dim: true,
    onRestore: async (m) => {
      dismissUndo();
      if (view.kind === "video") await M.restoreTrashMark(view.id, m.id);
      else await view.restoreMark(m.id);
      await refresh();
      selectedId = videoKey(view.entry);
      if (!resolveTrashSel()?.marks.length) trashSel = null;
      await render();
    }
  });
}

async function render() {
  const videos = filteredVideos();
  if (videos.length && !videos.some((v) => videoKey(v) === selectedId) && !trashSel) {
    selectedId = videoKey(videos[0]);
  }
  renderVideos(videos);
  renderTrash();
  const view = resolveTrashSel();
  if (view) await renderTrashView(view);
  else await renderLive(videos);
}

$("libQuery").addEventListener("input", async (e) => {
  query = e.target.value;
  await render();
});
$("libOpen").addEventListener("click", () => {
  const cur = filteredVideos().find((v) => videoKey(v) === selectedId);
  if (cur) chrome.tabs.create({ url: M.biliUrl(cur.bvid, 0) });
});
$("libExport").addEventListener("click", () => {
  const cur = filteredVideos().find((v) => videoKey(v) === selectedId);
  if (!cur) return;
  const blob = new Blob([M.toMarkdown(cur, marks)], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${cur.bvid}-marks.md`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$("libDeleteAll").addEventListener("click", async () => {
  const cur = filteredVideos().find((v) => videoKey(v) === selectedId);
  if (!cur) return;
  const n = marks.length;
  const item = await M.trashVideo(cur.bvid, cur.cid);
  armUndo(`已移入最近删除 · ${n} 条标记`, [item?.id]);
  await refresh();
  selectedId = index[0] ? videoKey(index[0]) : "";
  trashSel = null;
  await render();
});
$("libTrashToggle").addEventListener("click", async () => {
  trashOpen = !trashOpen;
  await render();
});
$("libTrashRestoreAll").addEventListener("click", async () => {
  const view = resolveTrashSel();
  if (!view) return;
  dismissUndo();
  await view.restoreAll();
  const entry = view.entry;
  trashSel = null;
  await refresh();
  selectedId = videoKey(entry) || (index[0] ? videoKey(index[0]) : "");
  await render();
});
$("libTrashClose").addEventListener("click", async () => {
  trashSel = null;
  await render();
});
$("libUndoBtn").addEventListener("click", async () => {
  const ids = undoIds.slice();
  dismissUndo();
  for (const id of ids) await M.restoreTrashItem(id);
  await refresh();
  if (index[0] && !index.some((v) => videoKey(v) === selectedId)) selectedId = videoKey(index[0]);
  await render();
});
$("libUndoDismiss").addEventListener("click", dismissUndo);

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "DAV_SYNCED") load().catch(() => {});
});

load().then(() => {
  chrome.runtime.sendMessage({ type: "DAV_SYNC_NOW", reason: "library" }).catch(() => {});
});
