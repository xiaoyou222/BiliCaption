const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { root, read, backgroundImports } = require("./源码加载.js");

function packedFiles() {
  const out = execFileSync("bash", [path.join(root, "scripts/打包.sh"), "--列出"], { cwd: root, encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

/** manifest 与各页面实际引用到的本地文件 */
function referencedFiles(packed) {
  const manifest = JSON.parse(read("manifest.json"));
  const refs = new Set(["manifest.json", manifest.background.service_worker, manifest.side_panel.default_path, manifest.options_ui.page]);
  for (const size of Object.values(manifest.icons || {})) refs.add(size);
  for (const size of Object.values(manifest.action?.default_icon || {})) refs.add(size);
  for (const entry of manifest.content_scripts || []) entry.js.forEach((file) => refs.add(file));
  for (const entry of manifest.web_accessible_resources || []) entry.resources.forEach((file) => refs.add(file));
  for (const file of backgroundImports()) refs.add(file);
  // 标记库由侧栏用 chrome.runtime.getURL("library.html") 打开，不在 manifest 里
  refs.add("library.html");
  for (const html of packed.filter((file) => file.endsWith(".html"))) {
    for (const m of read(html).matchAll(/\b(?:src|href)="([^"#:]+)"/g)) refs.add(m[1]);
  }
  return refs;
}

test("打包清单：manifest、importScripts 和页面引用到的文件一个不漏", () => {
  const packed = packedFiles();
  assert.equal(new Set(packed).size, packed.length, "清单里有重复文件");
  for (const file of packed) assert.ok(fs.existsSync(path.join(root, file)), `${file} 不存在`);
  for (const file of referencedFiles(packed)) {
    assert.ok(packed.includes(file), `运行时要用的 ${file} 没打进包`);
  }
});

test("打包清单：设计稿、测试、脚本和开发文件不打进去；打进去的脚本都有地方加载", () => {
  const packed = packedFiles();
  for (const file of packed) {
    assert.doesNotMatch(file, /^(BiliCaption|测试|scripts|\.git|\.claude|参考)\//, `${file} 不该打进包`);
    assert.doesNotMatch(file, /^(package\.json|README\.md|\.gitignore)$|\.zip$|\.DS_Store$/, `${file} 不该打进包`);
  }
  const refs = referencedFiles(packed);
  const orphans = packed.filter((file) => (file.endsWith(".js") || file.endsWith(".html") || file.endsWith(".css")) && !refs.has(file));
  assert.deepEqual(orphans, [], "打进包却没有任何地方加载的文件");
});
