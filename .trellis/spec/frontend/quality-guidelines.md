# Quality Guidelines

Frontend quality is visual tokens + message/state consistency + source-scan tests.

## Required

- Match existing CSS variables; do not introduce a utility framework.
- Keep HTML structure in `*.html`. JS builds lists (cues, chapters, logs), not the chrome of the page.
- New interactive copy stays Chinese.
- If CSS/HTML ids change, update the `assert.match` tests that lock them (`测试/中英字幕切换.test.js`, `测试/大纲时间轴.test.js`).

## Forbidden

- React/Vue/Svelte for this extension.
- Showing both float dock and Chrome side panel.
- `trackSelect` as the language switch.
- Inline styles for colors that already have tokens, except `library.html` which already inlines (keep those values on the token palette).

## Testing

Node cannot click the side panel. UI tests:

1. Source-scan HTML/CSS/JS for ids, class names, and message types.
2. `vm` tests for `lib/` that the UI calls (`outline.js`, `translate.js`, `markers.js`).

Live check when the change is visual: load the unpacked extension, exercise the control, desktop width of the side panel (~360px) and the float dock.

## Review checklist

- [ ] Tokens match `:root` / design draft
- [ ] `.hidden` used for show/hide
- [ ] No new privileged `message.type` from the content script
- [ ] Related views (sidepanel, float, options, library) still agree on the field you changed
