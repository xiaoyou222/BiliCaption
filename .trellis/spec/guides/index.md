# Thinking Guides

> **Purpose**: Expand your thinking to catch things you might not have considered.

---

## Why Thinking Guides?

**Most bugs and tech debt come from "didn't think of that"**, not from lack of skill:

- Didn't think about what happens at layer boundaries → cross-layer bugs
- Didn't think about code patterns repeating → duplicated code everywhere
- Didn't think about edge cases → runtime errors
- Didn't think about future maintainers → unreadable code

These guides help you **ask the right questions before coding**.

---

## Available Guides

| Guide | Purpose | When to Use |
|-------|---------|-------------|
| [Code Reuse Thinking Guide](./code-reuse-thinking-guide.md) | Identify patterns and reduce duplication | When you notice repeated patterns |
| [Cross-Layer Thinking Guide](./cross-layer-thinking-guide.md) | Think through data flow across layers | Features spanning multiple layers |

---

## Quick Reference: Thinking Triggers

### When to Think About Cross-Layer Issues

- [ ] Feature touches 3+ layers (sidepanel, content script, service worker, `chrome.storage`)
- [ ] Data format changes between layers
- [ ] WebDAV `config.json` vs `syncKeys`: `sttChannels[].key` is a secret; strip unless the user opted in — `storage.md`
- [ ] `startAsr` occupies `asrJobLocks` before `generateAsr` runs; if channels are empty the outer `finally` must still delete the lock (`!cur.work`)
- [ ] Switching `bvid`/`cid` must reset `range` / `selecting` / `dragSelect` / loop, not only summary
- [ ] Custom API base Bearer fetch: `assertSafeApiUrl` (https, or http localhost) before `fetch`
- [ ] Multiple consumers need the same data
- [ ] You're not sure where to put some logic
- [ ] You are adding an event kind, JSONL record, RPC payload, or config field
- [ ] UI / command code starts casting raw payload fields directly
- [ ] Outline cache or Bilibili subtitle-list fields (`summary`, `subtitleStatus`, `notice`, optional `chapters[].subs`) move between service worker, content script, and sidepanel — read `backend/outline-and-subtitles.md`
- [ ] 选区总结 format: paragraph by default; `- ` list only when the selection has multiple independent points; never force 3–6 bullets — read `backend/outline-and-subtitles.md`
- [ ] Button 划选 is two clicks (start then end) via `onCueClick`. Ordinary cue click seeks. Do not start `dragSelect` on pointerdown in normal mode. Shift-hold drag is `selectHeld` — design in `BiliCaption/BiliCaption Sidebar.dc.html`
- [ ] Holding the 划选 shortcut (`selKey`, default Shift) must show list `.key-armed` + 「划动选择字幕」 as soon as the key is detected (`SEL_KEY_STATE` or sidepanel keydown), not only after the pointer starts moving — design in `BiliCaption/BiliCaption Sidebar.dc.html`
- [ ] Long-video outline density: 20 min cutoff, nested `subs` titles, 简略/详情 is expand/collapse not a second generate; adjacent Bilibili cues may overlap and media seek can settle a frame before the target, so active lookup must use the shared latest-start + 50 ms rule — read `backend/outline-and-subtitles.md`
- [ ] 清理缓存 vs leftover captions: official player/dm tracks are not cache; `clearVideoCache` only drops `asr:` / jobs / outline — read `backend/outline-and-subtitles.md`
- [ ] 中/EN caption switch: show only when both zh and en exist; do not bring back `trackSelect`; Chinese-only official/ASR hides 中/EN; plugin bilingual is display-only (`cue.original`); never `SWITCH_TRACK` over groq/translated cues; plugin translate auto-switches to 中 on the first Chinese line unless the user pinned EN — read `backend/translate-regroup.md`
- [ ] Extension reload vs float: ownership is `data-bilicaption-owner` on `<html>` (isolated worlds do not share `window`); a dead script drops `#bilicaption-dock` only while it still owns that token; `onInstalled` re-injects `content.js`; PING must be answered even by a stale generation; float embed (`?embed=1`) must not `executeScript` on a failed PING (that tears down its own iframe); non-embed sidepanel sends `CLOSE_FLOAT` so float and side panel do not stack; float background alpha slider is 0–100 (`0` is valid, do not `value || 0.82`)
- [ ] Sidepanel/options/library colors: 面板 `#121417` 卡片 `#1A1D22` 抬起 `#24272D` 文字 `E7E9ED/C7CBD1/8A9099/767C86` 主色 `#4D8EF0`; buttons Primary/Secondary/Ghost/Selected, sm `11/5·10/r6` md `12/8·16/r7` — design in `BiliCaption/BiliCaption Sidebar.dc.html`
- [ ] Marker dots on Bilibili's progress bar: overlay `#bilicaption-progress-marks` inside `.bpx-player-progress` (hides with player chrome); `left% = time/duration`; click `SEEK`; content loads via `GET_MARKERS`, sidepanel pushes `SYNC_MARKERS`. Do not read `storage.local` from the content script.
- [ ] 选区循环: wrap only on a small overshoot past the end while playing. A user scrub/click outside the range must `clearCueLoop(true)` (`LOOP_ENDED`) so the progress bar can be dragged. Do not pull currentTime backward to the loop start on every seek.
- [ ] Speed menu: `.header` z-index above `.view-tabs` / job pill so the dropdown is not clipped; `formatRate` must keep 0.75 / 1.25 (do not round to 0.8 / 1.3). Marker ticks on the player bar: `pointer-events` only on the ticks, cache-render, `pointerdown` capture to SEEK.

→ Read [Cross-Layer Thinking Guide](./cross-layer-thinking-guide.md)

### When to Think About Code Reuse

- [ ] You're writing similar code to something that exists
- [ ] You see the same pattern repeated 3+ times
- [ ] You're adding a new field to multiple places
- [ ] **You're modifying any constant or config**
- [ ] **You're creating a new utility/helper function** ← Search first!
- [ ] Two files read the same untyped payload field with local casts
- [ ] Multiple branches update the same derived state from `kind` / `action`

→ Read [Code Reuse Thinking Guide](./code-reuse-thinking-guide.md)

### When Verifying AI Cross-Review Results

- [ ] Reviewer claims "user input can be malicious" → Check the actual data source (internal manifest? user config? external API?)
- [ ] Reviewer flags "missing validation" → Is the data from a trusted internal source?
- [ ] Reviewer says "behavior change" → Read the code comments — is it intentional design?
- [ ] Reviewer identifies a "bug" in test → Mentally delete the feature being tested — does the test still pass? If yes → tautological test

**Common AI reviewer false-positive patterns**:
1. **Trust boundary confusion**: Treating internal data (bundled JSON manifests) as untrusted external input
2. **Ignoring design comments**: Flagging intentional behavior documented in code comments as bugs
3. **Variable misreading**: Not tracing a variable to its actual definition (e.g., Map keyed by path vs name)

**Verification rule**: Every CRITICAL/WARNING finding must be verified against the actual code before prioritizing. Budget ~35% false-positive rate for AI reviews.

---

## Pre-Modification Rule (CRITICAL)

> **Before changing ANY value, ALWAYS search first!**

```bash
# Search for the value you're about to change
grep -r "value_to_change" .
```

This single habit prevents most "forgot to update X" bugs.

---

## How to Use This Directory

1. **Before coding**: Skim the relevant thinking guide
2. **During coding**: If something feels repetitive or complex, check the guides
3. **After bugs**: Add new insights to the relevant guide (learn from mistakes)

---

## Contributing

Found a new "didn't think of that" moment? Add it to the relevant guide.

---

**Core Principle**: 30 minutes of thinking saves 3 hours of debugging.
