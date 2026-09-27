const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { panelSource } = require("./源码加载.js");

const root = path.resolve(__dirname, "..");
const panel = panelSource();
const css = fs.readFileSync(path.join(root, "sidepanel.css"), "utf8");

function slice(from, to) {
  const start = panel.indexOf(from);
  const end = panel.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `找不到 ${from}`);
  return panel.slice(start, end);
}

function row() {
  const classes = new Set();
  const el = {
    touched: 0,
    classList: {
      toggle(name, on) {
        el.touched += 1;
        if (on) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name)
    },
    has: (name) => classes.has(name)
  };
  return el;
}

function painter(n) {
  const context = {
    cueRowEls: Array.from({ length: n }, row),
    lastActiveIndex: -1,
    range: { start: -1, end: -1 },
    cueEdit: null
  };
  vm.createContext(context);
  vm.runInContext(slice("let paintedRows = null;", "function stopCueEditBubble"), context);
  return context;
}

// 与旧实现（整表重算）对照：每一行的 active / picked 必须一致
function expected(ctx, index) {
  const { start } = ctx.range;
  const end = ctx.range.end >= 0 ? ctx.range.end : start;
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  const picked = start >= 0 && index >= from && index <= to && !(ctx.cueEdit && index === ctx.cueEdit.index);
  return { active: index === ctx.lastActiveIndex, picked };
}

function assertMatchesFullRepaint(ctx) {
  ctx.cueRowEls.forEach((el, index) => {
    const want = expected(ctx, index);
    assert.equal(el.has("active"), want.active, `第 ${index} 行 active`);
    assert.equal(el.has("picked"), want.picked, `第 ${index} 行 picked`);
  });
}

const touches = (ctx) => ctx.cueRowEls.reduce((sum, el) => sum + el.touched, 0);
const resetTouches = (ctx) => ctx.cueRowEls.forEach((el) => { el.touched = 0; });

test("换高亮行只动前一行和新行，不遍历整张表", () => {
  const ctx = painter(8000);
  ctx.lastActiveIndex = 10;
  ctx.paintVisibleCues();
  assertMatchesFullRepaint(ctx);
  resetTouches(ctx);
  ctx.lastActiveIndex = 11;
  ctx.paintVisibleCues();
  assert.equal(touches(ctx), 2);
  assertMatchesFullRepaint(ctx);
  resetTouches(ctx);
  ctx.paintVisibleCues();
  assert.equal(touches(ctx), 0);
});

test("拖动划选只重画伸缩出来的行，结果与整表重算一致", () => {
  const ctx = painter(8000);
  ctx.range = { start: 100, end: 100 };
  ctx.paintVisibleCues();
  assertMatchesFullRepaint(ctx);
  for (const end of [101, 105, 400, 390, 100, 90, 50, 3000, 2999]) {
    resetTouches(ctx);
    const before = ctx.range.end;
    ctx.range.end = end;
    ctx.paintVisibleCues();
    assertMatchesFullRepaint(ctx);
    assert.ok(touches(ctx) <= Math.abs(end - before) + 2, `end ${before}→${end} 动了 ${touches(ctx)} 行`);
  }
  // 换起点、跳到不相交的另一段、清空选区
  ctx.range = { start: 7000, end: 7005 };
  ctx.paintVisibleCues();
  assertMatchesFullRepaint(ctx);
  ctx.cueEdit = { index: 7003 };
  ctx.paintVisibleCues();
  assertMatchesFullRepaint(ctx);
  ctx.cueEdit = null;
  ctx.range = { start: -1, end: -1 };
  ctx.paintVisibleCues();
  assertMatchesFullRepaint(ctx);
});

test("行节点重建后按新行重新画，不沿用旧状态", () => {
  const ctx = painter(50);
  ctx.lastActiveIndex = 5;
  ctx.range = { start: 10, end: 20 };
  ctx.paintVisibleCues();
  ctx.cueRowEls = Array.from({ length: 50 }, row);
  ctx.paintVisibleCues();
  assertMatchesFullRepaint(ctx);
});

test("字幕行保留 content-visibility 与占位高度", () => {
  assert.match(css, /\.cue \{[\s\S]*?content-visibility: auto;[\s\S]*?contain-intrinsic-size: auto 36px;/);
});

function sender(behavior) {
  const calls = [];
  const context = {
    calls,
    myTabId: 0,
    boundTabId: 7,
    inFloatEmbed: () => false,
    getActiveTab: async () => ({ id: 7 }),
    ensureContentScript: async (id) => {
      calls.push(["inject", id]);
      return behavior.injectOk !== false;
    },
    chrome: {
      tabs: {
        async sendMessage(id, message) {
          calls.push(["send", id, message.type]);
          return behavior.send(calls.filter((c) => c[0] === "send").length, message);
        }
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(slice("function isNoReceiverError", "// 播放进度：TIME 来自"), context);
  return context;
}

test("sendToTab 直接发，不先 PING；没有接收方时才补注入再发一次", async () => {
  const ok = sender({ send: () => ({ ok: true }) });
  assert.deepEqual({ ...(await ok.sendToTab({ type: "SEEK" })) }, { ok: true });
  assert.deepEqual(ok.calls.map((c) => c.join(":")), ["send:7:SEEK"]);

  const missing = sender({
    send: (n) => {
      if (n === 1) throw new Error("Could not establish connection. Receiving end does not exist.");
      return { ok: 2 };
    }
  });
  assert.equal((await missing.sendToTab({ type: "SEEK" })).ok, 2);
  assert.deepEqual(missing.calls.map((c) => c.join(":")), ["send:7:SEEK", "inject:7", "send:7:SEEK"]);

  const other = sender({ send: () => { throw new Error("boom"); } });
  await assert.rejects(other.sendToTab({ type: "SEEK" }), /boom/);
  assert.equal(other.calls.some((c) => c[0] === "inject"), false);

  const cannot = sender({ injectOk: false, send: () => { throw new Error("Receiving end does not exist."); } });
  await assert.rejects(cannot.sendToTab({ type: "SEEK" }), /Receiving end/);
  assert.equal(cannot.calls.filter((c) => c[0] === "send").length, 1);
});
