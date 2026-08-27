# UI Guidelines

There are no React components. UI is static HTML plus class toggles.

## Tokens

From `sidepanel.css` `:root` and `BiliCaption/BiliCaption Sidebar.dc.html`:

| Role | Value |
|---|---|
| Page / panel | `#121417` (`--bg`) |
| Card | `#1A1D22` (`--surface`) |
| Lift | `#24272D` (`--lift`) |
| Text | `#E7E9ED` / `#C7CBD1` / `#8A9099` / `#767C86` |
| Primary | `#4D8EF0` hover `#5D9AF2` |
| Ok / danger / warn | `#3ECF8E` / `#E2637E` / `#F0B84D` |

Do not reintroduce old greys (`#565C66`, `#9BA0AA`, `#15171A` nav). Options and library should follow the same tokens (`options.css` `:root`, `library.html` inline colors).

## Buttons

Design sizes:

- sm: 11px, padding `5px 10px`, radius 6
- md: 12px, padding `8px 16px`, radius 7

Kinds already in CSS: `.btn-primary`, `.btn-outline`, `.btn-text`, `.btn-ghost`, `.btn-sm`, selected/on. Prefer an existing class over a one-off.

Primary actions on dark use `--blue` fill and dark ink, not white fill.

## Copy and empty states

User-facing strings are Chinese. Empty / error views already exist (`emptyView`, `errorView`, `outlineEmpty`). Add a sentence there instead of `alert()`.

Toasts: `flash(msg)` (~1600 ms) on `#toast`.

Thinking: `lib/thinking-orb.js` hosts, not a CSS spinner of a different size.

## Markdown in the selection card

`#summaryText` is a `<p>` with `white-space: pre-wrap`. `renderMarkdownLite` maps `- ` to `• `. Selection summaries are a paragraph by default; lists only when the model returns real parallel points (`outline-and-subtitles.md`).

## Accessibility already used

Icon-only buttons have `aria-label`. Menus use `aria-expanded` / `listbox` where the speed menu does. Keep that when adding similar controls. Do not require a full a11y framework.

## Common mistakes

- Showing `#trackSelect` again; 中/EN replaced it (`translate-regroup.md`).
- Mixing float and side panel (non-embed sidepanel sends `CLOSE_FLOAT`).
- Styling float-embed with opaque panel backgrounds; `html.float-embed` already forces transparent chrome.
