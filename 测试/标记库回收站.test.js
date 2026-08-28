const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadMarkers() {
  const store = {};
  const context = {
    chrome: {
      storage: {
        local: {
          async get(key) {
            if (typeof key === "string") return { [key]: store[key] };
            return {};
          },
          async set(values) {
            Object.assign(store, values);
          }
        }
      }
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "lib/markers.js"), "utf8"), context);
  return { M: context.BiliCaptionMarkers, store };
}

test("删除整段视频会进回收站，恢复后标记回来", async () => {
  const { M } = loadMarkers();
  await M.save("BV1xx", 1, [
    { id: 1, time: 12, text: "开场" },
    { id: 2, time: 40, text: "正片" }
  ], { title: "测试视频", up: "小由", part: "P1" });
  const item = await M.trashVideo("BV1xx", 1);
  assert.equal(item.kind, "video");
  assert.equal((await M.load("BV1xx", 1)).length, 0);
  assert.equal((await M.loadIndex())[0].count, 0);
  assert.equal((await M.loadTrash()).length, 1);
  await M.restoreTrashItem(item.id);
  const marks = await M.load("BV1xx", 1);
  assert.equal(marks.length, 2);
  assert.equal((await M.loadTrash()).length, 0);
});

test("删除单条标记可单独恢复，其余仍在回收站", async () => {
  const { M } = loadMarkers();
  await M.save("BV1yy", 2, [
    { id: 11, time: 5, text: "第一句" },
    { id: 12, time: 9, text: "第二句" }
  ], { title: "另一支" });
  const item = await M.trashMark("BV1yy", 2, 11);
  assert.equal((await M.load("BV1yy", 2)).map((m) => m.id).join(","), "12");
  await M.restoreTrashItem(item.id);
  const marks = await M.load("BV1yy", 2);
  assert.equal(marks.length, 2);
  assert.ok(marks.some((m) => String(m.id) === "11"));
});

test("从整段删除里恢复一条后，剩下的仍可全部恢复", async () => {
  const { M } = loadMarkers();
  await M.save("BV1zz", 3, [
    { id: 21, time: 1, text: "A" },
    { id: 22, time: 2, text: "B" },
    { id: 23, time: 3, text: "C" }
  ], { title: "三段" });
  const item = await M.trashVideo("BV1zz", 3);
  await M.restoreTrashMark(item.id, 22);
  assert.equal((await M.load("BV1zz", 3)).map((m) => m.id).join(","), "22");
  const left = await M.loadTrash();
  assert.equal(left[0].marks.length, 2);
  await M.restoreTrashItem(item.id);
  assert.equal((await M.load("BV1zz", 3)).length, 3);
  assert.equal((await M.loadTrash()).length, 0);
});

test("封面转 https，保存后不丢，空 meta 不覆盖已有封面", async () => {
  const { M } = loadMarkers();
  assert.equal(M.coverUrl("//i0.hdslb.com/bfs/x.jpg"), "https://i0.hdslb.com/bfs/x.jpg");
  assert.equal(M.coverUrl("http://i1.hdslb.com/bfs/x.jpg"), "https://i1.hdslb.com/bfs/x.jpg");
  await M.save("BV1pic", 9, [{ id: 1, time: 1, text: "a" }], {
    title: "有封面",
    pic: "http://i0.hdslb.com/bfs/x.jpg",
    up: "UP主"
  });
  let row = (await M.loadIndex())[0];
  assert.equal(row.pic, "https://i0.hdslb.com/bfs/x.jpg");
  assert.equal(row.up, "UP主");
  await M.save("BV1pic", 9, [
    { id: 1, time: 1, text: "a" },
    { id: 2, time: 2, text: "b" }
  ], { title: "有封面" });
  row = (await M.loadIndex())[0];
  assert.equal(row.pic, "https://i0.hdslb.com/bfs/x.jpg");
  assert.equal(row.up, "UP主");
  const patched = await M.patchIndex("BV1pic", 9, { pic: "//i2.hdslb.com/bfs/y.jpg" });
  assert.equal(patched.pic, "https://i2.hdslb.com/bfs/y.jpg");
});

test("超过 30 天的回收站条目会在读取时清掉", async () => {
  const { M, store } = loadMarkers();
  store.markerTrash = [{
    id: "old",
    kind: "video",
    deletedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
    entry: { id: "BV1old:0", bvid: "BV1old", cid: 0 },
    marks: [{ id: 1, time: 0, text: "过期" }]
  }];
  const trash = await M.loadTrash();
  assert.equal(trash.length, 0);
});

test("播放器进度条会打标记点，点击跳转", () => {
  const root = path.join(__dirname, "..");
  const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
  const panel = fs.readFileSync(path.join(root, "sidepanel.js"), "utf8");
  const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
  assert.match(content, /id = "bilicaption-progress-marks"/);
  assert.match(content, /bc-progress-mark::after[\s\S]{0,220}background: #F0B84D/);
  assert.match(content, /bc-progress-mark::after[\s\S]{0,180}width: 2px/);
  assert.match(content, /bpx-player-progress/);
  assert.match(content, /\(time \/ duration\) \* 100/);
  assert.match(content, /type === "SYNC_MARKERS"/);
  assert.match(content, /GET_MARKERS/);
  assert.match(content, /seekTo\(time\)/);
  assert.match(content, /pointerdown/);
  assert.match(content, /progressMarksSig/);
  assert.match(content, /LOOP_ENDED/);
  assert.match(content, /video\.seeking/);
  assert.match(panel, /type: "SYNC_MARKERS"/);
  assert.match(panel, /function syncProgressMarks/);
  assert.match(background, /"GET_MARKERS"/);
  assert.doesNotMatch(content, /chrome\.storage\.local\.get/);
});

test("标记行用 AI 润色，双击编辑；边缘光只给润色，不给选区总结", () => {
  const root = path.join(__dirname, "..");
  const panel = fs.readFileSync(path.join(root, "sidepanel.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "sidepanel.css"), "utf8");
  const html = fs.readFileSync(path.join(root, "sidepanel.html"), "utf8");
  assert.match(panel, /function polishMarker/);
  assert.match(panel, /function buildPolishPrompt/);
  assert.match(panel, /system: POLISH_SYSTEM/);
  assert.match(panel, /你是中文文字编辑/);
  assert.match(panel, /润色成标准、专业的书面描述/);
  assert.match(panel, /去掉口语风格/);
  assert.match(panel, /不要收成摘要/);
  assert.doesNotMatch(panel, /压得更短更准/);
  const polishPrompt = panel.match(/function buildPolishPrompt\([\s\S]*?\n\}\n/)?.[0] || "";
  assert.doesNotMatch(polishPrompt, /一两句话|更短、更准|压得更短|句子不要动/);
  assert.match(panel, /textContent = "AI"/);
  assert.doesNotMatch(panel, /润色中…/);
  assert.match(panel, /onDelta\(full\) \{ paint\(full\); \}/);
  assert.doesNotMatch(panel, /edit\.textContent = "改"/);
  assert.match(panel, /BiliCaptionBorderBeam/);
  assert.match(panel, /setBeam\(cover, true\)/);
  assert.doesNotMatch(panel, /setBeam\(ui\.summaryBox/);
  assert.match(html, /lib\/border-beam\.js/);
  assert.doesNotMatch(css, /backdrop-filter/);
  assert.doesNotMatch(css, /\.marker-polish\s*\{[^}]*background:\s*#14171B/);
  const beam = fs.readFileSync(path.join(root, "lib/border-beam.js"), "utf8");
  assert.match(beam, /pulse-inner/);
  assert.match(beam, /strength = 0\.7/);
  assert.match(beam, /100, 80, 220/);
  assert.doesNotMatch(beam, /255, 50, 100/);
  assert.match(beam, /--beam-inset/);
  assert.doesNotMatch(beam, /180, 180, 180/);
  assert.match(beam, /HUE_PERIOD = 16/);
});

test("选区总结的已标记跟这条总结的起点走，不沿用上一条", () => {
  const panel = fs.readFileSync(path.join(__dirname, "..", "sidepanel.js"), "utf8");
  const summarize = panel.match(/async function summarizeSelection\([\s\S]*?\n\}\n/);
  assert.ok(summarize, "找不到 summarizeSelection");
  assert.match(summarize[0], /summaryMarkTime = Number\(state\.cues\[from\]\.from\)/);
  assert.match(summarize[0], /updateSummaryMarkerBtn\(\)/);
  assert.match(panel, /if \(Number\.isFinite\(summaryMarkTime\)\) return summaryMarkTime/);
  assert.doesNotMatch(
    panel.match(/function updateSummaryMarkerBtn\([\s\S]*?\n\}\n/)?.[0] || "",
    /currentTime/
  );
});
