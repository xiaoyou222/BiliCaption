# Logging

Runtime logs are a 200-entry ring buffer in `chrome.storage.local.appLogs`, shown on the options 运行日志 tab.

## Overview

`background.js` `appLog(level, scope, message, extra)` is the writer. Options `noteLog` forwards through `{ type: "APPEND_LOG" }`. Entries also broadcast `{ type: "APP_LOG", entry }` for a live list.

## Levels and scopes

`level` is `info` | `warn` | `error` (anything else becomes `info`).

Options UI labels (`options.js` `SCOPE`):

| scope | label |
|---|---|
| `groq` / `asr` | 转写 |
| `bili` | B站 |
| `net` | 网络 |
| `set` | 设置 |
| `app` | 应用 |
| `sum` | 总结 |
| `dav` | 同步 |

Keep new scopes short (`slice(0, 16)`). Prefer an existing one.

## Message shape

```js
{
  t: Date.now(),
  level: "info" | "warn" | "error",
  scope: string,
  message: string,   // max 400
  detail: string     // JSON of a small extra allowlist, max 400
}
```

`logDetail` only copies `status`, `ms`, `mb`, `done`, `total`, `current`, `bvid`, `cid`, `host`, `waitMs`, `chunks`, `cues`, `try`. Do not dump API keys, raw audio, or full cue lists.

Error-level entries flush immediately; others debounce 400 ms.

## Console

Service worker may `console.warn("[BiliCaption]", error)` for install-time Chrome API failures. Feature logs that the user should inspect belong in `appLog`, not only `console.log`.

## Common mistakes

- Logging secret keys or full request bodies.
- Growing `appLogs` without the 200 cap (`LOG_MAX`).
- Introducing a second log store instead of `appLogs`.
