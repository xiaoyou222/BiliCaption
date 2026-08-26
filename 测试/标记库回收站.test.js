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
