# Error Handling

Plain `Error` objects with Chinese messages. No custom error classes.

## Overview

Failures travel as `error.message`. RPC replies use `{ error: string }`. The sidepanel maps that to `flash()`, an empty-state, or an error view — not a stack overlay.

## Patterns

### Throw at the source

```js
if (!res.ok) throw new Error(`请求失败 ${res.status}: ${url}`);
```

`fetchJson` in `background.js` is the Bilibili HTTP helper. Merge extra headers into the default `Accept` object; do not spread `options` after `headers`.

### RPC reply

`background.js` wraps async work:

```js
const reply = (promise) => {
  Promise.resolve(promise)
    .then(sendResponse)
    .catch((error) => sendResponse({ error: error.message || String(error) }));
  return true;
};
```

Callers check `result.error`. Do not throw out of the `onMessage` listener.

### Chat / STT errors

`BiliCaptionModelRoute.markError` stamps `status` and `invalidResponse` on a normal `Error`. `shouldFallback` decides retry; `fallbackFor()` is always `""` (no `xy-backup`). Abort / user cancel must not fallback.

STT: config/auth errors abort the whole job; ordinary per-chunk audio errors retry. Tests in `测试/批量翻译与分片逻辑.test.js`.

### User-visible

| Situation | UI |
|---|---|
| Short action failed | `flash(error.message)` in `sidepanel.js` |
| No video / not logged in / network | dedicated state view, existing copy |
| Subtitle list empty vs fetch failed | `subtitleStatus` `none` / `fetch_failed` — not `error: notice` |
| Missing summary key | flash + open settings |

## Silent catch

`.catch(() => {})` is allowed only on fire-and-forget Chrome APIs (`sendMessage`, `storage.set` after a successful action, `sidePanel.setPanelBehavior`). Do not swallow job failures that way.

## Common mistakes

- Copying `error: data.error || data.notice` and sending 「没拿到字幕列表」 into the generic error page. Use `subtitleStatus`.
- Trusting model clocks after an outline parse throw; `validate()` parse throws must become `false`, not kill the stream reader.
- Using English exception text for user-facing toasts.
