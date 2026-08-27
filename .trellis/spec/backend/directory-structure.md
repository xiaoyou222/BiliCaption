# Directory Structure

How backend (service worker + shared `lib/`) code is laid out.

## Overview

Single-repo Chrome MV3 extension. Business logic lives in root scripts and `lib/*.js`. There is no `src/`, no packages, no bundler.

## Directory Layout

```
.
├── manifest.json          MV3: service_worker, side_panel, content_scripts
├── background.js          service worker (jobs, Bilibili fetch, storage, logs)
├── content.js             Bilibili page: player hook, overlay, float dock
├── sidepanel.js           Chrome side panel + `?embed=1` float
├── options.js             settings
├── library.js             marker library page
├── lib/                   IIFE modules on `globalThis`
│   ├── prefs.js           BiliCaptionPrefs
│   ├── providers.js       BiliCaptionProviders
│   ├── stt.js             BiliCaptionStt
│   ├── outline.js         BiliCaptionOutline
│   ├── translate.js       BiliCaptionTranslate
│   ├── markers.js         BiliCaptionMarkers
│   ├── webdav.js
│   ├── 模型路由.js         BiliCaptionModelRoute
│   ├── wbi.js / md5.js    Bilibili WBI
│   └── mp4-aac.js         audio slice
└── 测试/                   node:test files (Chinese names)
```

`BiliCaption/` is the design prototype (`BiliCaption Sidebar.dc.html`). `参考/` is third-party reference, not product code.

## Module Organization

New shared logic goes in `lib/<topic>.js` as an IIFE that assigns one `globalThis.BiliCaption*` object. Callers never `import` / `export`.

Load the same file in every context that needs it:

| Context | How |
|---|---|
| Service worker | `importScripts("lib/…")` at the top of `background.js` |
| Side panel | ordered `<script src>` before `sidepanel.js` |
| Options | ordered `<script src>` before `options.js` |
| Tests | `vm.runInContext(fs.readFileSync("lib/….js"), context)` |

Do not add a build step, ES modules, or a second copy of a helper in the page script.

## Message Types

`background.js` `chrome.runtime.onMessage` is the RPC bus.

- Extension pages (sidepanel / options / library) may send any handled type.
- Content script may send only `CONTENT_MESSAGE_TYPES` (`WHOAMI`, `LOAD_SUBTITLES`, `GENERATE_ASR`, …). Other types reply `{ error: "无权调用" }`.
- Async handlers use `reply(promise)` so `sendResponse` always runs; the listener **must return `true`**.
- Tab-directed UI uses `chrome.tabs.sendMessage` via sidepanel `sendToTab` after `ensureContentScript`.

Adding a `type` string is a cross-layer change: handler in `background.js`, sender in `sidepanel.js` / `content.js` / `options.js`, and usually a test assertion in `测试/`.

## Naming Conventions

- Storage / message keys: `SCREAMING` `type` strings, `prefix:id` storage keys.
- Lib globals: `BiliCaption` + Pascal topic (`BiliCaptionOutline`).
- Tests: `测试/<中文能力>.test.js`.
- Chinese filenames exist on purpose (`lib/模型路由.js`, `测试/大纲时间轴.test.js`). Do not rename them for ASCII.

## Examples

- Shared STT/sum config: `lib/providers.js` + `lib/stt.js`
- Outline prompt + parse: `lib/outline.js`, not a copy in `sidepanel.js`
- Marker index: `lib/markers.js` used by `sidepanel.js` and `library.js`

## Wrong vs Correct

#### Wrong

```js
import { resolveStt } from "./lib/providers.js";
```

#### Correct

```js
importScripts("lib/providers.js", "lib/stt.js");
const cfg = BiliCaptionProviders.resolveStt(settings);
```
