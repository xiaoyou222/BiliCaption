const M = window.BiliCaptionMarkers;
const $ = (id) => document.getElementById(id);

let index = [];
let selected = 0;
let marks = [];
let query = "";

function show(el, on) {
  el.classList.toggle("hidden", !on);
}

async function load() {
  index = await M.loadIndex();
  const settings = await chrome.storage.sync.get({ syncOn: false, davLast: "" });
  $("libSyncDot").classList.toggle("on", Boolean(settings.syncOn));
  $("libSyncLabel").textContent = settings.syncOn
    ? (settings.davLast ? `WebDAV 已同步 · ${settings.davLast}` : "WebDAV 已开启 · 尚未同步")
    : "未开启同步";
  const want = new URLSearchParams(location.search).get("id");
  if (want) selected = Math.max(0, index.findIndex((v) => v.id === want));
  await render();
}

function filteredVideos() {
  const q = query.trim();
  if (!q) return index;
  return index.filter((v) => `${v.title} ${v.up} ${v.bvid}`.includes(q));
}

async function render() {
  const videos = filteredVideos();
  if (!videos.length) selected = 0;
  else if (selected >= videos.length) selected = 0;
  const host = $("libVideos");
  host.replaceChildren();
  videos.forEach((v, i) => {
    const row = document.createElement("div");
    row.className = `v-row${i === selected ? " on" : ""}`;
    row.innerHTML = `<div class="v-thumb"></div><div style="min-width:0;flex:1"><div class="v-title"></div><div class="v-meta"></div></div>`;
    row.querySelector(".v-thumb").textContent = v.dur || "";
    row.querySelector(".v-title").textContent = v.title || v.bvid;
    row.querySelector(".v-meta").textContent = `${v.up || "未知"} · ${v.part || "P1"} · ${v.count || 0} 条 · ${v.when || ""}`;
    row.addEventListener("click", async () => { selected = i; await render(); });
    host.appendChild(row);
  });

  const cur = videos[selected];
  if (!cur) {
    $("libCurCount").textContent = "0 条标记";
    $("libMarks").replaceChildren();
    show($("libEmpty"), true);
    return;
  }
  marks = await M.load(cur.bvid, cur.cid);
  const q = query.trim();
  const shown = q ? marks.filter((m) => (m.text || "").includes(q) || (cur.title || "").includes(q)) : marks;
  $("libCurCount").textContent = `${shown.length} 条标记`;
  show($("libEmpty"), !shown.length);
  const list = $("libMarks");
  list.replaceChildren();
  for (const m of shown) {
    const row = document.createElement("div");
    row.className = "m-row";
    row.innerHTML = `<span class="m-time"></span><span class="m-text"></span>`;
    row.querySelector(".m-time").textContent = M.fmt(m.time);
    row.querySelector(".m-text").textContent = m.text || "（空）";
    row.addEventListener("click", () => {
      chrome.tabs.create({ url: M.biliUrl(cur.bvid, m.time) });
    });
    list.appendChild(row);
  }
}

$("libQuery").addEventListener("input", async (e) => {
  query = e.target.value;
  await render();
});
$("libOpen").addEventListener("click", () => {
  const cur = filteredVideos()[selected];
  if (cur) chrome.tabs.create({ url: M.biliUrl(cur.bvid, 0) });
});
$("libExport").addEventListener("click", () => {
  const cur = filteredVideos()[selected];
  if (!cur) return;
  const blob = new Blob([M.toMarkdown(cur, marks)], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${cur.bvid}-marks.md`;
  a.click();
  URL.revokeObjectURL(a.href);
});

load();
