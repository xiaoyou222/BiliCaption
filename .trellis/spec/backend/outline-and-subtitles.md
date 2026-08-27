# Outline payload and Bilibili subtitle list

Executable contracts for full-video outline+summary storage and for loading official captions.

## Scenario: outline record and cache

### 1. Scope / Trigger

Changing outline JSON, chrome.storage shape, copy/Markdown, or the generate prompt. Sidepanel reads the same `outline:v2:` key that `clearVideoCache` deletes.

### 2. Signatures

- `normalizeOutlineRecord(value) -> { summary: string, chapters: array }`
- `parseOutlinePayload(text) -> { summary, chapters }`
- `finalizeOutline(chapters, cues) -> chapters with start/end seconds`
- `buildOutlinePrompt(cues) -> string` (single JSON object, `summary` then `chapters`)
- `buildChaptersPrompt(cues) -> string` (array only; long-video second pass)
- storage key: `outline:v2:{bvid}:{cid}`

### 3. Contracts

Written value is always:

```
{ summary: string, chapters: [{ start, end, title, synopsis }] }
```

`summary` is one Chinese paragraph (~80–150 characters), no headings, lists, or timestamps.

`chapters` `from`/`to` from the model are **cue indices** (1-based). Seconds are assigned locally by `finalizeOutline`. Do not trust model clocks.

`finalizeOutline` must repair invalid clocks: missing/`0`/`00:00`, out-of-range indices, or a chapter that jumps back before the previous one. Fill from the previous chapter’s end to the next valid start (last chapter → last cue end). Empty `parseClock` input is `NaN`, not `0`.

Read path:

| stored | memory |
|---|---|
| `{ summary, chapters }` | `videoSummary` + `outline` |
| array (legacy) | `outline` = array, `videoSummary` = `""`, hide the 全片总结 fold |
| missing | both empty |

Persist only when **both** summary and chapters are non-empty. Do not persist summary alone if chapters fail.

Cue corpus over `SUMMARY_CUE_CHAR_BUDGET` (100000): map-reduce summary, then `buildChaptersPrompt`. Same AbortController for both.

Copy / Markdown: if summary is non-empty, put it above chapter lines; if empty, match the old chapter-only format.

### 4. Validation & Error Matrix

| condition | result |
|---|---|
| object missing both summary and chapters | throw 大纲为空 |
| final success missing either field | throw 大纲结果结构校验失败; do not write storage |
| generate aborted or video key changed | do not write storage; do not clobber the new video's cache |
| `validate()` parse throws | treat as `false`, do not throw out of the stream reader |
| last chapter `from`/`to` missing, `0`, or out of range | repair to previous end → last cue; never keep `00:00–00:00` |

### 5. Good/Base/Bad Cases

- Good: `{ "summary": "…", "chapters": [{ "title","synopsis","from":1,"to":8 }] }`
- Base: stored legacy `[{ title, synopsis, start, end }]` still shows chapters
- Bad: trusting `start`/`end` seconds from the model when cue indices exist

### 6. Tests Required

- `测试/大纲时间轴.test.js`: cue-index mapping; even-split when span is tiny; last-chapter `0`/overflow repair; prompt requires indices and `summary, chapters` order; parse object vs array; copy/MD prefix; chunking

### 7. Wrong vs Correct

#### Wrong

One Markdown document with “关键观点 + 时间线” that duplicates chapters. Auto-ASR when the subtitle list is empty.

#### Correct

Short paragraph + chapter list. Official tracks first; user clicks 生成字幕.

---

## Scenario: subtitle list fetch and empty states

### 1. Scope / Trigger

Changing `loadSubtitles`, player/dm APIs, or empty-state copy in the sidepanel.

### 2. Signatures

- `fetchPlayer(aid, cid)` — `x/player/wbi/v2`, then `x/player/v2`
- `fetchDmView(aid, cid)` — `GET https://api.bilibili.com/x/v2/dm/view?type=1&oid={cid}&pid={aid}` with `credentials: include` and `Referer: https://www.bilibili.com/`
- `mapSubtitleTracks(source)` — drop tracks with empty `subtitle_url`
- `pickDefaultTrack(tracks)` — `ai-zh` / 中文自动, then zh, then first
- `loadSubtitles(page) -> { tracks, cues, subtitleStatus, error, notice, canGenerate, ... }`

### 3. Contracts

Call `fetchDmView` **only when** `mapSubtitleTracks(player)` is empty.

`fetchJson` must merge extra headers into the default `Accept` object. Do not `...options` after `headers` (that replaced the merged headers).

`content.js` must forward `subtitleStatus`. If `subtitleStatus` is set, do not copy `notice` into `error`.

### 4. Validation & Error Matrix

Logged in, no ASR cache, no preferred track:

| player | dm/view | `subtitleStatus` | UI |
|---|---|---|---|
| empty list | empty list | `none` | 「这个视频没有字幕」+ 生成字幕 |
| throw or empty | throw | `fetch_failed` | 「没拿到字幕列表」+ 重试 + 生成字幕 |
| tracks with url | not called | `""` | show cues |
| — | — | `login` / `network` | existing error pages |

`canGenerate` stays true on a video page. Do not start ASR from these statuses.

### 5. Good/Base/Bad Cases

- Good: player urls empty, dm/view has `ai-zh` → official cues, no empty view
- Base: player already has `ai-zh` → no dm/view request
- Bad: treating cookie/player failure as “no subtitles”

### 6. Tests Required

- `测试/字幕列表获取.test.js`: dm/view used when player urls empty; skipped when player has tracks; `none` vs `fetch_failed` vs `login`; `fetchJson` keeps default Accept when Referer is passed; `clearVideoCache` drops `asr:` / jobs / outline then `loadSubtitles` reloads official `bilibili` cues

### 7. Wrong vs Correct

#### Wrong

```
error: data.error || data.notice
```

That puts 「没拿到字幕列表」 into `error` and can trip the generic error page.

#### Correct

```
subtitleStatus: data.subtitleStatus || ""
error: data.error || (data.partial || data.subtitleStatus ? "" : data.notice) || ""
```

---

## Scenario: clear generated cache vs official tracks

### 1. Scope / Trigger

Changing `clearVideoCache`, the sidepanel 清理缓存 button, or `loadSubtitles` cache-vs-official order. Users may think leftover captions mean the button failed.

### 2. Signatures

- `clearVideoCache(bvid, cid) -> { ok: true }`
- message: `{ type: "CLEAR_VIDEO_CACHE", bvid, cid }`
- `loadSubtitles(page)` prefers `asr:{bvid}:{cid}` then official `pickDefaultTrack`

### 3. Contracts

`clearVideoCache` removes only plugin-written keys:

| key | what |
|---|---|
| `asr:{bvid}:{cid}` | generated ASR / saved translation cues |
| `asrJob:{bvid}:{cid}` | in-progress ASR job |
| `trJob:{bvid}:{cid}` | in-progress translate job |
| `outline:{bvid}:{cid}` | legacy outline |
| `outline:v2:{bvid}:{cid}` | outline + full summary |

It aborts running ASR/translate jobs first, waits up to 5s, then deletes after the ASR write queue for that video.

It does **not** delete Bilibili player/dm tracks. Those are live API data, not cache.

After clear, sidepanel `refresh(true)` → `loadSubtitles`. If `asr:` is gone and a preferred official track exists, `source` is `"bilibili"` and cues come from `fetchCues`. Toast: 「已清理转写、翻译和大纲缓存，已重新加载官方字幕」. If there is no official track: 「已清理本视频的转写、翻译和大纲缓存」.

### 4. Validation & Error Matrix

| condition | result |
|---|---|
| no bvid and no cid | toast 「当前没有视频」; do not call background |
| `CLEAR_VIDEO_CACHE` not `ok` | toast error; keep current cues |
| ASR cache existed, official `ai-zh` exists | cues stay visible; `source === "bilibili"` |
| ASR cache existed, no official track | empty captions + 生成字幕 |
| official-only video, never generated | delete is a no-op on storage; official cues reload |

### 5. Good/Base/Bad Cases

- Good: generated ASR + official track → clear → official cues, toast mentions 官方字幕
- Base: no generated cache, official only → still official after clear
- Bad: treating leftover official cues as “clear failed”; hiding official tracks to make the list empty

### 6. Tests Required

- `测试/字幕列表获取.test.js`: after `clearVideoCache`, `asr:` / job / outline keys are gone and `loadSubtitles` returns `source: "bilibili"`
- `测试/批量翻译与分片逻辑.test.js`: sidepanel toast distinguishes 转写缓存 vs 官方字幕; button title says 不影响视频自带字幕

### 7. Wrong vs Correct

#### Wrong

```
flash("已清理本视频的字幕和翻译缓存");
```

Sounds like every caption should vanish. Official Bilibili tracks then look like a failed clear.

#### Correct

```
if (state?.cues?.length && state.source === "bilibili") {
  flash("已清理转写、翻译和大纲缓存，已重新加载官方字幕");
} else {
  flash("已清理本视频的转写、翻译和大纲缓存");
}
```

---

## Scenario: selection summary format

### 1. Scope / Trigger

Changing `buildSummaryPrompt` in `sidepanel.js` (划选 → 总结). This is not the full-video `summary` field.

### 2. Signatures

- `buildSummaryPrompt(from, to) -> string`

### 3. Contracts

Format follows **content structure**, not how many cues were selected.

- Default: one Chinese paragraph when the selection is one idea, one stretch of explanation, or one conclusion.
- List only when the selection contains multiple independent, parallel points. Each item is one line starting with `- `. Write as many items as there are points; do not pad to a count.
- Do not split a coherent passage into fake 背景 / 过程 / 结论 bullets.
- Keep: Chinese, preserve key terms, no bold, no titles. 【上文】 and 【下文】 are context only — never summarize them.

`renderMarkdownLite` already maps `- ` to `• `; `.summary p` uses `white-space: pre-wrap`. Do not special-case paragraph vs list in the UI.

### 4. Validation & Error Matrix

| condition | result |
|---|---|
| short or long selection, one idea | one paragraph |
| selection enumerates independent points | `- ` list, one line per point |
| model returns a paragraph | render as wrapped text |
| model returns `- ` lines | render as bullets in the same `<p>` |

### 5. Good/Base/Bad Cases

- Good: a 40-second explanation of one technique → one paragraph
- Base: speaker lists three independent conditions → three `- ` lines
- Bad: forcing `分 3-6 条要点` so every selection becomes a bullet list

### 6. Tests Required

- `测试/选区总结格式.test.js`: `buildSummaryPrompt` must not say `分 3-6 条要点`; must default to a paragraph and allow a list only for parallel points

### 7. Wrong vs Correct

#### Wrong

```
请用中文总结【选区】这段视频字幕，分 3-6 条要点……每条一行，以 "- " 开头。
```

#### Correct

```
默认写成一段连贯的话。只有选区里确实有多个互不从属的并列要点时，才用列表。
```
