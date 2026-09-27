const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { contentSource, panelSource } = require("./源码加载.js");

const root = path.resolve(__dirname, "..");
const content = contentSource();
const panel = panelSource();
const css = fs.readFileSync(path.join(root, "sidepanel.css"), "utf8");

function loadPrefs() {
  const context = { chrome: { storage: { sync: {}, local: {} } } };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "lib/prefs.js"), "utf8"), context);
  return context.BiliCaptionPrefs;
}

const plain = (v) => JSON.parse(JSON.stringify(v));

const UI_FONT = '"Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

test("浮窗偏好按全局读写，不跟 tabId 绑死", () => {
  const P = loadPrefs();
  assert.deepEqual(plain(P.DOCK_UI_DEFAULTS), { dockOpen: false, preferSidebar: true });
  assert.deepEqual(plain(P.readDockUiPrefs({})), { preferSidebar: true, dockOpen: false });
  assert.deepEqual(plain(P.readDockUiPrefs({ preferSidebar: false, dockOpen: true })), {
    preferSidebar: false,
    dockOpen: true
  });
  assert.deepEqual(plain(P.readDockUiPrefs({ preferSidebar: false, dockOpen: false })), {
    preferSidebar: false,
    dockOpen: false
  });
  assert.deepEqual(plain(P.readDockUiPrefs({ preferSidebar: true, dockOpen: true })), {
    preferSidebar: true,
    dockOpen: false
  });
  assert.deepEqual(
    plain(P.readDockUiPrefs({ "dockOpen:12": true, "preferSidebar:12": false })),
    { preferSidebar: true, dockOpen: false }
  );

  assert.match(content, /chrome\.storage\.sync\.set\(\{ dockOpen, preferSidebar \}\)/);
  assert.match(content, /function applyDockUiPrefs/);
  assert.match(content, /dockOpen: false,\s*preferSidebar: true/);
  assert.match(content, /changes\.dockOpen \|\| changes\.preferSidebar/);
  assert.doesNotMatch(content, /dockOpen:\$\{/);
  assert.doesNotMatch(content, /preferSidebar:\$\{/);
  assert.doesNotMatch(content, /`dockOpen:\$\{myTabId\}`/);
  assert.doesNotMatch(content, /`preferSidebar:\$\{myTabId\}`/);
});

test("选了浮窗后，切标签不会把 Chrome 侧栏当主界面", () => {
  assert.match(panel, /async function hideChromePanelIfFloating/);
  assert.match(panel, /async function loadDockUiPrefs/);
  assert.match(panel, /prefs\.preferSidebar/);
  assert.match(panel, /hideChromePanelIfFloating\(\)/);
  assert.match(panel, /changes\.preferSidebar && changes\.preferSidebar\.newValue === false/);
  assert.match(panel, /if \(info\.url\) hideChromePanelIfFloating\(\)/);
  assert.doesNotMatch(panel, /RESTORE_SIDE_PANEL/);
  assert.match(panel, /if \(prefs\.preferSidebar\) \{\s*await sendToTab\(\{ type: "CLOSE_FLOAT" \}\)/);
  assert.match(panel, /else \{\s*await hideChromePanelIfFloating\(\);\s*return;/);
  assert.doesNotMatch(
    panel,
    /bindFloatTab\(\)\.then\(async \(\) => \{\s*if \(!inFloatEmbed\(\)\) \{\s*await sendToTab\(\{ type: "CLOSE_FLOAT" \}\)/
  );
});

test("浮窗外壳、内嵌侧栏、overlay 用同一套字体，不继承宿主页", () => {
  const P = loadPrefs();
  assert.equal(P.UI_FONT, UI_FONT);
  assert.match(content, /--bc-ui-font: "Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;/);
  assert.match(content, /#bilicaption-dock,\s*#bilicaption-overlay/);
  assert.match(content, /#bilicaption-dock \.bc-dock-title/);
  assert.match(content, /#bilicaption-overlay \.bc-overlay-text/);
  assert.match(content, /font-family: var\(--bc-ui-font\) !important;/);
  assert.match(content, /#bilicaption-dock iframe/);
  assert.doesNotMatch(content, /font: 13px\/1 inherit/);
  assert.doesNotMatch(content, /font: 600 11\.5px\/1 inherit/);
  assert.doesNotMatch(content, /YouTube Sans|Roboto/);
  assert.match(css, /--bc-ui-font: "Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;/);
  assert.match(css, /html\.float-embed,\s*html\.float-embed body \{[\s\S]*?font-family: var\(--bc-ui-font\) !important;/);
});
