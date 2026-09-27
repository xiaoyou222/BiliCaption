const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { backgroundSource, contentSource, panelSource } = require("./源码加载.js");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const manifest = JSON.parse(read("manifest.json"));

function platforms() {
  const context = vm.createContext({ URL });
  vm.runInContext(read("lib/视频平台.js"), context);
  return context.BiliCaptionPlatforms;
}

test("manifest、后台补注入、侧栏补注入用同一份内容脚本清单", () => {
  const files = Array.from(platforms().CONTENT_SCRIPT_FILES);
  assert.deepEqual(files, ["lib/视频平台.js", "lib/字幕工具.js", "内容/样式.js", "content.js"]);
  assert.deepEqual(manifest.content_scripts[0].js, files);
  assert.match(backgroundSource(), /files: \[\.\.\.BiliCaptionPlatforms\.CONTENT_SCRIPT_FILES\]/);
  assert.match(panelSource(), /files: \[\.\.\.BiliCaptionPlatforms\.CONTENT_SCRIPT_FILES\]/);
  assert.doesNotMatch(panelSource(), /files: \["content\.js"\]/);
});

test("浮窗 iframe 依赖的 sidepanel.html 开了 use_dynamic_url，嵌入地址来自 getURL", () => {
  const entry = manifest.web_accessible_resources.find((item) => item.resources.includes("sidepanel.html"));
  assert.equal(entry.use_dynamic_url, true);
  assert.match(contentSource(), /iframe\.src = `\$\{chrome\.runtime\.getURL\("sidepanel\.html"\)\}\?embed=1`/);
});

test("权限：去掉用不到的 pbs.twimg.com；tabs、clipboardWrite 仍在用", () => {
  assert.equal(manifest.host_permissions.includes("https://pbs.twimg.com/*"), false);
  assert.ok(manifest.host_permissions.includes("https://video.twimg.com/*"));
  // tabs：侧栏按 tab.url 判断站点和换视频；clipboardWrite：浮窗 iframe 里 Clipboard API 不可用时退回 execCommand("copy")
  assert.ok(manifest.permissions.includes("tabs"));
  assert.ok(manifest.permissions.includes("clipboardWrite"));
  assert.match(panelSource(), /document\.execCommand\("copy"\)/);
  // unlimitedStorage：转写结果和改过字的字幕不参与自动淘汰，会一直累积，storage.local 默认只有 10MB。
  // 该权限没有安装提示，升级时不会因新增权限被停用。
  assert.ok(manifest.permissions.includes("unlimitedStorage"));
});

test("zh-simp 映射表没有重复键", () => {
  const source = read("lib/zh-simp.js");
  const body = source.slice(source.indexOf("const chars = {"), source.indexOf("};", source.indexOf("const chars = {")));
  const keys = [...body.matchAll(/(\S): "[^"]*"/g)].map((m) => m[1]);
  const dup = keys.filter((key, i) => keys.indexOf(key) !== i);
  assert.deepEqual(dup, []);
  const context = { self: {} };
  vm.createContext(context);
  vm.runInContext(`${source};self.__Z = BiliCaptionZh;`, context);
  assert.equal(context.self.__Z.toSimplified("餘下這幾隻鳥點頭"), "余下这几只鸟点头");
});

test("死代码已删：无发送方的消息处理、未调用函数、未用到的样式和脚本", () => {
  const content = contentSource();
  const background = backgroundSource();
  const panel = panelSource();
  for (const type of ["TOGGLE_DOCK", "RETURN_SIDEBAR", "GENERATE_ASR"]) {
    assert.doesNotMatch(content, new RegExp(`message\\?\\.type === "${type}"`));
  }
  assert.doesNotMatch(background, /function resolvePanelContext/);
  assert.doesNotMatch(background, /Referer: "https:\/\/www\.bilibili\.com\/"\s*\}\s*\}\s*\);\s*if \(json\.code != null/);
  assert.doesNotMatch(panel, /function selectModeOn/);
  assert.doesNotMatch(read("sidepanel.css"), /\.job-seg-orb|\.job-btn\.gold/);
  assert.doesNotMatch(read("options.css"), /\.creds\.two|\.test-slot/);
  assert.doesNotMatch(read("options.html"), /lib\/md5\.js/);
  // API Key 明文上传：勾选前 chip 悬停说明，勾选后显示提醒
  assert.match(read("options.html"), /id="syncKeys"[^>]*title="[^"]*明文/);
  assert.match(read("options.html"), /id="syncKeysWarn"[^>]*>Key 将明文存入网盘，请确认只有你能访问</);
});

test("onInstalled / onStartup 各只注册一次", () => {
  const background = backgroundSource();
  assert.equal((background.match(/runtime\.onInstalled\??\.addListener/g) || []).length, 1);
  assert.equal((background.match(/runtime\.onStartup\??\.addListener/g) || []).length, 1);
});

test("X 只监听 m3u8 清单请求，不再监听整个 video.twimg.com", () => {
  const background = backgroundSource();
  assert.doesNotMatch(background, /\{ urls: \["https:\/\/video\.twimg\.com\/\*"\] \}/);
  assert.match(background, /"https:\/\/video\.twimg\.com\/amplify_video\/\*\.m3u8\*"/);
});
