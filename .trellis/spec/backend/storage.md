# Storage

There is no database. Persistence is `chrome.storage.sync` (settings) and `chrome.storage.local` (secrets, video caches, logs, markers).

## Overview

`lib/prefs.js` owns settings load/save. Video caches and jobs are written by `background.js`. Markers use `lib/markers.js`.

`chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })` in `background.js` keeps API keys out of the content script.

## Settings vs secrets

`BiliCaptionPrefs.SECRET_KEYS`:

`groqApiKey`, `sttKey`, `sttCreds`, `sttChannels`, `apiKey`, `backupKey`, `davPass`

| Kind | Area | API |
|---|---|---|
| Secrets | `local` | `loadSettings` / `saveSettings` split them out |
| Non-secret prefs | `sync` | overlay, keys, models, captionLang, dock geom |
| Leftover secrets in `sync` | migrate to `local` then `sync.remove` | `loadSettings` |

Do not put new API keys in `sync`. Add the key name to `SECRET_KEYS` if a setting is a credential.

WebDAV `config.json` includes `sttChannels`. Each channel has a `key`. `configPayload` must strip those keys (and omit `sttCreds` / `apiKey` / `backupKey`) unless `syncKeys` is on. Pull must strip the same way so a previously leaked remote file cannot write keys back.

## Video and job keys (`local`)

Per `bvid` + `cid`:

| Key | Writer | What |
|---|---|---|
| `asr:{bvid}:{cid}` | `saveCachedAsr` | generated / translated cues |
| `asrJob:{bvid}:{cid}` | ASR job | in-progress transcribe |
| `trJob:{bvid}:{cid}` | translate job | in-progress translate |
| `outline:v2:{bvid}:{cid}` | sidepanel generate | `{ summary, chapters }` |
| `outline:{bvid}:{cid}` | legacy | chapter array only |
| `marks:{bvid}:{cid}` | `BiliCaptionMarkers` | timestamps |

`clearVideoCache` removes only the plugin keys above (plus the legacy `outline:` key). It does **not** delete Bilibili official tracks. Contract: `backend/outline-and-subtitles.md`.

## Other `local` keys

| Key | What |
|---|---|
| `appLogs` | last 200 log entries |
| `markerIndex` / `markerTrash` | library + 30-day trash |
| `davSyncMeta` | WebDAV etag / timestamps |
| `lastVideo` | sidepanel empty-state hint |

## Cue records

Cached cues are plain objects: `{ from, to, content, original? }`. `clampCues` in `background.js` caps list length and string size before write.

Outline record shape is `{ summary, chapters }` — do not invent a second key. Details in `outline-and-subtitles.md`.

## Common mistakes

- Treating leftover official captions after 清理缓存 as a failed delete.
- Reading secrets from `sync` in new code.
- Letting the content script `storage.local.get` API keys (blocked by `TRUSTED_CONTEXTS`).
- Persisting 简略/详情 fold state (session-only in sidepanel memory).
