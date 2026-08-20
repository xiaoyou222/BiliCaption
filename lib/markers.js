(function (global) {
  const INDEX_KEY = "markerIndex";

  function videoKey(bvid, cid) {
    return `marks:${bvid || ""}:${Number(cid) || 0}`;
  }

  function nowLabel(ts = Date.now()) {
    const d = new Date(ts);
    const today = new Date();
    const one = 24 * 60 * 60 * 1000;
    const diff = Math.floor((today.setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / one);
    if (diff <= 0) return "今天";
    if (diff === 1) return "昨天";
    if (diff < 7) return `${diff} 天前`;
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  function fmt(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  }

  async function load(bvid, cid) {
    const key = videoKey(bvid, cid);
    const data = await chrome.storage.local.get(key);
    return Array.isArray(data[key]) ? data[key] : [];
  }

  async function save(bvid, cid, marks, meta = {}) {
    const key = videoKey(bvid, cid);
    const next = (marks || []).slice().sort((a, b) => a.time - b.time);
    const index = await loadIndex();
    const id = `${bvid || ""}:${Number(cid) || 0}`;
    const row = {
      id,
      bvid: bvid || "",
      cid: Number(cid) || 0,
      title: meta.title || "",
      up: meta.up || "",
      part: meta.part || "",
      dur: meta.dur || "",
      when: nowLabel(),
      updatedAt: Date.now(),
      count: next.length
    };
    const rest = index.filter((item) => item.id !== id);
    if (next.length) rest.unshift(row);
    await chrome.storage.local.set({
      [key]: next,
      [INDEX_KEY]: rest.slice(0, 400)
    });
    return next;
  }

  async function loadIndex() {
    const data = await chrome.storage.local.get(INDEX_KEY);
    return Array.isArray(data[INDEX_KEY]) ? data[INDEX_KEY] : [];
  }

  async function add(bvid, cid, mark, meta) {
    const list = await load(bvid, cid);
    if (list.some((m) => Math.floor(m.time) === Math.floor(mark.time))) {
      const err = new Error("该时间点标记已存在");
      err.duplicate = true;
      throw err;
    }
    list.push({
      id: mark.id || Date.now(),
      time: Number(mark.time) || 0,
      text: String(mark.text || "").trim()
    });
    return save(bvid, cid, list, meta);
  }

  async function update(bvid, cid, id, text, meta) {
    const list = await load(bvid, cid);
    const want = String(id);
    const next = list
      .map((m) => (String(m.id) === want ? { ...m, text: String(text || "").trim() } : m))
      .filter((m) => String(m.id) !== want || m.text);
    return save(bvid, cid, next, meta);
  }

  async function remove(bvid, cid, id, meta) {
    const want = String(id);
    const list = (await load(bvid, cid)).filter((m) => String(m.id) !== want);
    return save(bvid, cid, list, meta);
  }

  async function clearVideo(bvid, cid) {
    return save(bvid, cid, [], {});
  }

  function biliUrl(bvid, time) {
    const t = Math.max(0, Math.floor(Number(time) || 0));
    return `https://www.bilibili.com/video/${bvid}${t ? `?t=${t}` : ""}`;
  }

  function toMarkdown(entry, marks) {
    const lines = [`# ${entry.title || entry.bvid}`, "", `- ${entry.bvid} · ${entry.part || "P1"} · ${entry.dur || ""}`, ""];
    for (const m of marks) {
      lines.push(`- [${fmt(m.time)}](${biliUrl(entry.bvid, m.time)}) ${m.text || ""}`);
    }
    return lines.join("\n") + "\n";
  }

  // 标准引号转义；= + - @ 开头的文本加 ' 前缀，防止在 Excel 里被当公式执行
  function csvCell(value) {
    const raw = String(value ?? "");
    const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return `"${guarded.replace(/"/g, '""')}"`;
  }

  function toCsv(entry, marks) {
    const rows = [["time", "text", "url"]];
    for (const m of marks) {
      rows.push([fmt(m.time), m.text || "", biliUrl(entry.bvid, m.time)]);
    }
    return rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
  }

  function copyText(marks, bvid) {
    return marks.map((m) => `${fmt(m.time)}  ${m.text || ""}  ${biliUrl(bvid, m.time)}`).join("\n");
  }

  global.BiliCaptionMarkers = {
    videoKey,
    load,
    save,
    loadIndex,
    add,
    update,
    remove,
    clearVideo,
    biliUrl,
    toMarkdown,
    toCsv,
    copyText,
    fmt,
    nowLabel
  };
})(globalThis);
