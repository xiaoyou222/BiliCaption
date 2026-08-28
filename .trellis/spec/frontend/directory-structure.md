# Directory Structure

How UI surfaces are split. There is no `components/` folder.

## Overview

Each Chrome page is a triad: `name.html` + `name.css` + `name.js`. Shared look is copied tokens, not a CSS framework.

## Directory Layout

```
sidepanel.html / .css / .js    Chrome side_panel + float iframe (?embed=1)
options.html / .css / .js      options_ui open_in_tab
library.html / .js             marker library (styles inlined in html)
content.js                     overlay, dock, progress-bar marker dots, player events (injects its own CSS)
icons/                         action icons
BiliCaption/BiliCaption Sidebar.dc.html   design draft (tokens already in sidepanel.css)
```

`manifest.json` `side_panel.default_path` is `sidepanel.html`. Float loads the same file as `sidepanel.html?embed=1` inside `#bilicaption-dock`.

## Script order

Pages load `lib/*` then the page script. Sidepanel needs thinking-orb, zh-simp, translate, outline, 模型路由, markers, providers, prefs, then `sidepanel.js`. Do not reorder unless you also fix the globals those files expect.

Content script is listed in `manifest.json` `content_scripts` and re-injected by `background.js` `onInstalled` / `executeScript`. Isolated worlds do not share `window`.

## Naming

- DOM ids: camelCase matching `sidepanel.js` `ui` keys (`btnSettings`, `cueList`).
- CSS: kebab-case layout classes (`.summary`, `.view-tabs`), state `.hidden`, `.on`, `.active`.
- Show/hide with `el.classList.toggle("hidden", !on)` (`show()` in `sidepanel.js`). Do not `display` inline except where the design already does.

## Ownership of the Bilibili page

`content.js` writes `data-bilicaption-owner` on `<html>`. Only the current generation may remove `#bilicaption-dock`. PING must be answered even by a stale script. Float embed must not `executeScript` on a failed PING. Details: thinking trigger in `guides/index.md`.

## Examples

- Sidepanel tabs 字幕 / 大纲: `sidepanel.html` `data-view`
- Settings nav: `options.html` `data-tab`
- Library: `library.js` + `lib/markers.js`
