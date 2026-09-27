// 测试共用：按扩展真实的加载顺序读取、执行源码。
// 后台：background.js 第 1 行 importScripts 的清单；侧栏：sidepanel.html 的 script 标签；
// 内容脚本：manifest 的 content_scripts。拆出来的文件都从这三处取，测试测的仍是真实代码。
// 文件名不带 .test，不会被 node --test 当成测试文件。
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

/** background.js 第 1 行 importScripts 里的文件，依次加载（含 lib/） */
function backgroundImports() {
  const first = read("background.js").split("\n", 1)[0];
  const call = first.match(/^importScripts\(([\s\S]*)\);$/);
  if (!call) throw new Error("background.js 第 1 行不是 importScripts(...)");
  return [...call[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** 某个扩展页按 script 标签顺序加载的文件（含 lib/） */
function pageScripts(html) {
  return [...read(html).matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
}

/** manifest content_scripts 注入的文件（含 lib/） */
function contentScripts() {
  return JSON.parse(read("manifest.json")).content_scripts[0].js.slice();
}

const own = (files) => files.filter((file) => !file.startsWith("lib/"));

/** 后台自己的脚本（不含 lib/），按执行顺序：importScripts 引入的在前，background.js 最后 */
function backgroundFiles() {
  return [...own(backgroundImports()), "background.js"];
}

function panelFiles() {
  return own(pageScripts("sidepanel.html"));
}

function contentFiles() {
  return own(contentScripts());
}

/** 多个文件的源码按加载顺序拼成一段，供正则断言和按标记截取 */
function joinSource(files) {
  return files.map(read).join("\n");
}

const backgroundSource = () => joinSource(backgroundFiles());
const panelSource = () => joinSource(panelFiles());
const contentSource = () => joinSource(contentFiles());

function runFile(context, file) {
  return vm.runInContext(read(file), context, { filename: file });
}

/**
 * 在 vm 上下文里按真实顺序加载后台：执行 background.js，由它的 importScripts 依次加载拆分出的脚本。
 * libs 是要真实加载的 lib 文件；没列出的 lib 视为测试已用桩对象代替，跳过。
 */
function loadBackgroundScripts(context, libs = []) {
  const wanted = new Set(libs);
  const imports = backgroundImports();
  for (const lib of wanted) {
    if (!imports.includes(lib)) throw new Error(`${lib} 不在 background.js 的 importScripts 里`);
  }
  context.importScripts = (...files) => {
    for (const file of files) {
      if (!file.startsWith("lib/") || wanted.has(file)) runFile(context, file);
    }
  };
  runFile(context, "background.js");
  return context;
}

/** 按 manifest 顺序加载全部内容脚本（平台模块、共用工具、content.js） */
function loadContentScripts(context) {
  for (const file of contentScripts()) runFile(context, file);
  return context;
}

module.exports = {
  root,
  read,
  backgroundImports,
  pageScripts,
  contentScripts,
  backgroundFiles,
  panelFiles,
  contentFiles,
  backgroundSource,
  panelSource,
  contentSource,
  runFile,
  loadBackgroundScripts,
  loadContentScripts
};
