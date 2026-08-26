const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadDav() {
  const context = {
    console,
    chrome: {
      storage: { local: { async get() { return {}; }, async set() {} } },
      permissions: { async request() {} }
    },
    btoa: (s) => Buffer.from(s, "binary").toString("base64")
  };
  context.self = context;
  context.window = context;
  context.global = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "lib/webdav.js"), "utf8"), context);
  return context.BiliCaptionDav;
}

test("集合目录补尾斜杠，避免 MKCOL 被 301 到 http", () => {
  const D = loadDav();
  assert.equal(D.collectionPath(""), "");
  assert.equal(D.collectionPath("marks"), "marks/");
  assert.equal(D.collectionPath("/marks/"), "marks/");
  assert.equal(
    D.joinUrl("https://bili.xiaoyou.love/bilicaption/", D.collectionPath("marks")),
    "https://bili.xiaoyou.love/bilicaption/marks/"
  );
});

test("同步时间按时间戳现算，不会永远停在刚刚", () => {
  const D = loadDav();
  assert.equal(D.formatSyncAgo(0), "");
  assert.equal(D.formatSyncAgo(Date.now() - 20 * 1000), "刚刚");
  assert.equal(D.formatSyncAgo(Date.now() - 5 * 60 * 1000), "5 分钟前");
  assert.equal(D.formatSyncAgo(Date.now() - 3 * 60 * 60 * 1000), "3 小时前");
});

test("本地改过、云端没动则上传", () => {
  const D = loadDav();
  assert.equal(D.decideSync(200, 100, 100), "push");
});

test("云端较新、本地没改则下载", () => {
  const D = loadDav();
  assert.equal(D.decideSync(100, 200, 100), "pull");
});

test("都没超过上次同步则跳过", () => {
  const D = loadDav();
  assert.equal(D.decideSync(100, 100, 100), "skip");
});

test("两边都改过则较新的赢", () => {
  const D = loadDav();
  assert.equal(D.decideSync(300, 250, 100), "conflict-push");
  assert.equal(D.decideSync(250, 300, 100), "conflict-pull");
});

test("回收站两边各删一条时合并保留", () => {
  const D = loadDav();
  const merged = D.mergeTrash(
    [{ id: "a", deletedAt: 180 }],
    [{ id: "b", deletedAt: 190 }],
    200,
    210,
    100
  );
  assert.equal(merged.map((item) => item.id).sort().join(","), "a,b");
});

test("这边恢复后，另一边未改过的回收站条目不再加回来", () => {
  const D = loadDav();
  const merged = D.mergeTrash(
    [],
    [{ id: "old", deletedAt: 80 }],
    200,
    90,
    100
  );
  assert.equal(merged.length, 0);
});
