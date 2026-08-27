# State Management

No Redux/Vue. Each page keeps module-level `let` variables. The service worker is the source of jobs and caches.

## Sidepanel

`sidepanel.js`:

- `state` — current video snapshot (`cues`, `tracks`, `bvid`, `cid`, `source`, `currentTime`, …)
- UI-only: `range`, `outline`, `videoSummary`, `outlineDensity`, `captionLang`, `generating`, …
- `ui` — DOM nodes resolved once at load

Render functions read those lets and write the DOM (`renderCues`, `renderOutline`, `renderVideoSummary`). Do not keep a parallel copy of cues in random closures.

`captionLang` is `chrome.storage.sync`. Outline fold/density is session-only.

## Content script

`content.js` holds player hooks, overlay cues, dock geometry. It does not read `chrome.storage.local` secrets. Overlay / `selKey` / `captionLang` come from `sync`.

Player time: ordinary `timeupdate` may throttle (120 ms). `seeked` must `sendTime({ force: true })` so a paused seek still updates the outline. Active outline row uses `activeOutlinePosition` (latest start, 50 ms tolerance) — `outline-and-subtitles.md`.

## Messages as state sync

| Direction | Examples |
|---|---|
| sidepanel → content | `SEEK`, `SET_CAPTION_LANG`, `SYNC_CUES` |
| content → sidepanel | `TIME`, page identity |
| sidepanel → background | `LOAD_SUBTITLES`, `GENERATE_ASR`, `START_TRANSLATE`, `CLEAR_VIDEO_CACHE` |
| background → pages | `ASR_PROGRESS`, `TRANSLATE_PROGRESS`, `APP_LOG`, `DAV_SYNCED` |

Float embed binds `myTabId`; non-embed uses `boundTabId`. Ignore messages for other tabs (`isForThisPanel`).

## Storage listeners

`chrome.storage.onChanged` updates overlay prefs and last-video hints. Job progress is messages, not a storage poll.

## Common mistakes

- Casting raw payload fields in three UIs instead of one `lib/` normalize.
- Writing `state.currentTime` only from throttled `TIME` after a click-to-seek (click must set it immediately).
- `executeScript` on a failed PING inside the float iframe (tears down the embed).
