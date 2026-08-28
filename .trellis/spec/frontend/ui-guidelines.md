# UI Guidelines

There are no React components. UI is static HTML plus class toggles.

## Tokens

From `sidepanel.css` `:root` (design draft: `BiliCaption/BiliCaption Sidebar.dc.html`):

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

Marker polish uses `lib/border-beam.js`, a vanilla port of `border-beam@1.3.0` `pulse-inner` + `ocean` + `strength={0.7}`. Do not copy the design-draft CSS ring. Do not put the beam on the selection-summary card: summarizing keeps the thinking orb + title shimmer only. Polish overlay is a light translucent wash (no `backdrop-filter` blur). Double-click edits a marker; the row button is **AI**, not 改. Marker polish rewrites casual/oral notes into standard professional Chinese: drop filler and vague talk, keep every information point. It is not the design-draft `condense()` mock (two sentences / 52 characters) and not a summary. Polish calls must pass `POLISH_SYSTEM`; do not reuse the default「简洁的中文助手」system prompt.

## Markdown in the selection card

`#summaryText` is a `<p>` with `white-space: pre-wrap`. `renderMarkdownLite` maps `- ` to `• `. Selection summaries are a paragraph by default; lists only when the model returns real parallel points (`outline-and-subtitles.md`).

## Accessibility already used

Icon-only buttons have `aria-label`. Menus use `aria-expanded` / `listbox` where the speed menu does. Keep that when adding similar controls. Do not require a full a11y framework.

## Common mistakes

- Showing `#trackSelect` again; 中/EN replaced it (`translate-regroup.md`).
- Putting `#captionLang` before `.job-pill-slot`. The slot is `flex: 1` and pins the pill to its right; 中/EN must come after the slot so it stays at the bar’s right edge and only yields the pill’s width.
- Mixing float and side panel (non-embed sidepanel sends `CLOSE_FLOAT`).
- Styling float-embed with opaque panel backgrounds; `html.float-embed` already forces transparent chrome.
- Clamping float dock alpha with `value || 0.82`: `0` is a valid opacity. Slider is 0–100; `clampDockAlpha` uses `Number.isFinite`.
- Forgetting the sel-key armed hint: holding `selKey` on the captions list must add `.key-armed` (inset 1px `rgba(77,142,240,.42)`, wash `.045`) and `#selKeyHint` 「划动选择字幕」 immediately. Hide the pill once drag starts. Do not wait for `pointermove`. Click-mode 划选 (`selecting`) does not use this.
- Selection-bar **循环** (`#btnLoopSel`): off is ghost outline, on is 「循环中」 with blue wash (`#79ACF5`). Turning on seeks to the first selected cue and plays; wrap lives in the content script (`LOOP_SEL`), end is the next cue’s `from` (last cue uses its `to`). Clicking another cue or clearing the selection turns it off. Do not pause the player while looping.
