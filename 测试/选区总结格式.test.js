const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

test("选区总结按内容结构选段落或列表，不强制要点条数", () => {
  const panel = fs.readFileSync(path.join(root, "sidepanel.js"), "utf8");
  const promptFn = panel.match(/function buildSummaryPrompt[\s\S]*?\n}\n/);
  assert.ok(promptFn, "找不到 buildSummaryPrompt");
  const body = promptFn[0];
  assert.match(body, /默认写成一段连贯的话/);
  assert.match(body, /互不从属的并列要点/);
  assert.match(body, /不要写进总结/);
  assert.doesNotMatch(body, /分 3-6 条要点/);
  assert.doesNotMatch(body, /不要写进要点/);
});
