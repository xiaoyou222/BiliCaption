# Quality Guidelines

Vanilla JS, Node's built-in test runner, no lint/type pipeline.

## Overview

There is no `package.json` ESLint/tsc script. Quality is: existing patterns, `node --test 测试/*.test.js`, and the domain specs.

## Required

- Load `lib/` via IIFE + `globalThis`, same as production.
- Tests live in `测试/<中文>.test.js` using `node:test` and `node:assert/strict`.
- Service-worker tests sandbox `background.js` with `vm` and a fake `chrome.storage` (`测试/字幕列表获取.test.js`).
- UI contracts that cannot run in Node are source-scan assertions (`assert.match(fs.readFileSync("sidepanel.js"), /…/)`).
- When behavior changes, update the matching test in the same change.

Run:

```bash
node --test 测试/*.test.js
```

Targeted:

```bash
node --test 测试/大纲时间轴.test.js 测试/字幕列表获取.test.js
```

## Forbidden

- Adding Webpack/Vite/TypeScript just to ship this extension.
- `import` / `export` in `lib/` or root scripts (MV3 classic scripts + `importScripts`).
- Duplicate outline/translate/STT helpers in `sidepanel.js` when `lib/` already exports them.
- Tautological tests that only echo the implementation.
- Checking in `参考/` or generated design dumps as product code.

## Review checklist

- [ ] Storage key / `message.type` / cue field has one writer and every reader updated
- [ ] Secrets stayed on `local`
- [ ] Content script was not given a new privileged RPC
- [ ] Tests cover the contract, not only the happy path
- [ ] Domain spec updated when the rule is non-obvious (`outline-and-subtitles.md`, `translate-regroup.md`)
