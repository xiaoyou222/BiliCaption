(function (global) {
  const INDEX_KEY = "markerIndex";
  const TRASH_KEY = "markerTrash";
  const TRASH_MS = 30 * 24 * 60 * 60 * 1000;

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

  function coverUrl(raw) {
    const s = String(raw || "").trim();
    if (!s) return "";
    if (s.startsWith("//")) return `https:${s}`;
    if (/^http:\/\//i.test(s)) return `https://${s.slice(7)}`;
    return s;
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
    const prev = index.find((item) => item.id === id) || {};
    const row = {
      id,
      bvid: bvid || "",
      cid: Number(cid) || 0,
      title: meta.title || prev.title || "",
      up: String(meta.up || "").trim() || prev.up || "",
      part: meta.part || prev.part || "",
      dur: meta.dur || prev.dur || "",
      pic: coverUrl(meta.pic) || prev.pic || "",
      when: nowLabel(meta.updatedAt || Date.now()),
      updatedAt: Number(meta.updatedAt) || Date.now(),
      count: next.length
    };
    const rest = index.filter((item) => item.id !== id);
    rest.unshift(row);
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

  async function patchIndex(bvid, cid, patch) {
    const index = await loadIndex();
    const id = `${bvid || ""}:${Number(cid) || 0}`;
    const i = index.findIndex((item) => item.id === id);
    if (i < 0) return null;
    const next = { ...index[i] };
    if (patch.title != null) next.title = String(patch.title || "");
    if (patch.up != null) next.up = String(patch.up || "").trim();
    if (patch.part != null) next.part = String(patch.part || "");
    if (patch.dur != null) next.dur = String(patch.dur || "");
    if (patch.pic != null) next.pic = coverUrl(patch.pic);
    index[i] = next;
    await chrome.storage.local.set({ [INDEX_KEY]: index });
    return next;
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

  function daysLeft(deletedAt) {
    const age = Math.floor((Date.now() - (Number(deletedAt) || 0)) / 86400000);
    return Math.max(0, 30 - age);
  }

  function normalizeTrash(raw) {
    if (Array.isArray(raw)) return { updatedAt: 0, items: raw };
    if (raw && typeof raw === "object" && Array.isArray(raw.items)) {
      return { updatedAt: Number(raw.updatedAt) || 0, items: raw.items };
    }
    return { updatedAt: 0, items: [] };
  }

  function freshTrashItems(items) {
    return (items || []).filter((item) => Date.now() - (Number(item.deletedAt) || 0) < TRASH_MS);
  }

  async function loadTrashDoc() {
    const data = await chrome.storage.local.get(TRASH_KEY);
    const raw = data[TRASH_KEY];
    if (Array.isArray(raw)) return saveTrashDoc({ updatedAt: Date.now(), items: raw });
    return normalizeTrash(raw);
  }

  async function saveTrashDoc(doc) {
    const items = freshTrashItems(doc?.items);
    const next = { updatedAt: Number(doc?.updatedAt) || Date.now(), items };
    await chrome.storage.local.set({ [TRASH_KEY]: next });
    return next;
  }

  async function loadTrash() {
    const doc = await loadTrashDoc();
    const keep = freshTrashItems(doc.items);
    if (keep.length !== doc.items.length) await saveTrashDoc({ updatedAt: Date.now(), items: keep });
    return keep;
  }

  async function saveTrash(list) {
    const doc = await saveTrashDoc({ updatedAt: Date.now(), items: list });
    return doc.items;
  }

  function indexRow(bvid, cid, extra = {}) {
    return {
      id: `${bvid || ""}:${Number(cid) || 0}`,
      bvid: bvid || "",
      cid: Number(cid) || 0,
      title: extra.title || "",
      up: extra.up || "",
      part: extra.part || "",
      dur: extra.dur || "",
      when: extra.when || "",
      updatedAt: extra.updatedAt || Date.now(),
      count: extra.count || 0
    };
  }

  async function findEntry(bvid, cid) {
    const index = await loadIndex();
    return index.find((row) => row.bvid === bvid && Number(row.cid) === Number(cid))
      || indexRow(bvid, cid);
  }

  async function trashVideo(bvid, cid) {
    const marks = await load(bvid, cid);
    const entry = await findEntry(bvid, cid);
    const item = {
      id: `v:${entry.id}:${Date.now()}`,
      kind: "video",
      deletedAt: Date.now(),
      entry,
      marks
    };
    const trash = await loadTrash();
    trash.unshift(item);
    await saveTrash(trash);
    await save(bvid, cid, [], entry);
    return item;
  }

  async function trashMark(bvid, cid, id) {
    const list = await load(bvid, cid);
    const mark = list.find((m) => String(m.id) === String(id));
    if (!mark) return null;
    const entry = await findEntry(bvid, cid);
    const item = {
      id: `m:${entry.id}:${mark.id}:${Date.now()}`,
      kind: "mark",
      deletedAt: Date.now(),
      entry,
      mark
    };
    const trash = await loadTrash();
    trash.unshift(item);
    await saveTrash(trash);
    await remove(bvid, cid, id, entry);
    return item;
  }

  async function restoreTrashItem(id) {
    const trash = await loadTrash();
    const item = trash.find((row) => row.id === id);
    if (!item) return null;
    if (item.kind === "video") {
      const current = await load(item.entry.bvid, item.entry.cid);
      const seen = new Set(current.map((m) => String(m.id)));
      const merged = current.concat((item.marks || []).filter((m) => !seen.has(String(m.id))));
      await save(item.entry.bvid, item.entry.cid, merged, { ...item.entry, updatedAt: Date.now() });
    } else if (item.mark) {
      const current = await load(item.entry.bvid, item.entry.cid);
      if (!current.some((m) => String(m.id) === String(item.mark.id))) {
        current.push(item.mark);
      }
      await save(item.entry.bvid, item.entry.cid, current, { ...item.entry, updatedAt: Date.now() });
    }
    await saveTrash(trash.filter((row) => row.id !== id));
    return item;
  }

  async function restoreTrashMark(id, markId) {
    const trash = await loadTrash();
    const item = trash.find((row) => row.id === id);
    if (!item) return null;
    if (item.kind === "mark") return restoreTrashItem(id);
    const mark = (item.marks || []).find((m) => String(m.id) === String(markId));
    if (!mark) return null;
    const current = await load(item.entry.bvid, item.entry.cid);
    if (!current.some((m) => String(m.id) === String(mark.id))) current.push(mark);
    await save(item.entry.bvid, item.entry.cid, current, { ...item.entry, updatedAt: Date.now() });
    const left = (item.marks || []).filter((m) => String(m.id) !== String(markId));
    if (!left.length) await saveTrash(trash.filter((row) => row.id !== id));
    else {
      item.marks = left;
      await saveTrash(trash);
    }
    return item;
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
    coverUrl,
    load,
    save,
    loadIndex,
    patchIndex,
    add,
    update,
    remove,
    clearVideo,
    loadTrash,
    loadTrashDoc,
    saveTrashDoc,
    trashVideo,
    trashMark,
    restoreTrashItem,
    restoreTrashMark,
    daysLeft,
    biliUrl,
    toMarkdown,
    toCsv,
    copyText,
    fmt,
    nowLabel
  };
})(globalThis);
