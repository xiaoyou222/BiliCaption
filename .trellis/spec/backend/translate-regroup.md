# Translate regroup and summary providers

Executable contracts for summary/translate providers and the MERGE/KEEP regroup step that runs before batch translation.

## Scenario: summary provider list and migration

### 1. Scope / Trigger

`SUM_PROVIDERS` is a named chat list shared by summary, regroup, and translation. Changing the list, default, or Gemini base is a storage + options + `resolveSum` contract change.

### 2. Signatures

- `migrateSum(storage) -> storage'`
- `resolveSum(storage) -> { provider, base, model, key }`

### 3. Contracts

Current named providers: `OpenAI`, `Gemini`, `DeepSeek`, `自定义`. Default provider is `OpenAI`.

| Provider | `base` | User URL | Default model |
|---|---|---|---|
| OpenAI | `https://api.openai.com/v1` | no | `gpt-4o-mini` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | no | `gemini-2.5-flash` |
| DeepSeek | `https://api.deepseek.com/v1` | no | `deepseek-chat` |
| 自定义 | `apiBase` / `sumUrl` | yes | empty / typed |

Gemini uses the official OpenAI-compatible chat path. Callers still POST `{base}/chat/completions` with a Bearer AI Studio key. Do not add a Gemini-native client or Vertex URL.

`migrateSum` (persist on options load):

| Old `sumProvider` | New | URL |
|---|---|---|
| `统一网关` with non-empty URL | `自定义` | keep |
| `统一网关` with empty URL | `OpenAI` | official |
| `智谱 GLM` / `Kimi` / `通义千问` / `OpenRouter` | `自定义` | keep URL or write `LEGACY_SUM_URLS` |
| already in the new list | unchanged | unchanged |
| unknown / empty | `OpenAI` | official |

If `translateModel` or (when leaving the gateway) `apiModel` is `xy-smart` / `xy-fast` / `xy-backup`, clear it so translation follows the summary model. `BiliCaptionModelRoute.fallbackFor()` returns `""`. Translation must not send a second request to `xy-backup`.

### 4. Validation & Error Matrix

- Missing summary Key → existing "请先在设置里配置…" path; regroup does not start.
- Gemini 401/403 → same chat error wrapping as OpenAI.
- Custom empty URL → `resolveSum.base` is empty; chat fetch fails with the existing gateway-address error.

### 5. Good / Base / Bad Cases

- Good: stored `智谱 GLM` + key → UI shows 自定义, `apiBase` is `https://open.bigmodel.cn/api/paas/v4`.
- Base: fresh install → `sumProvider` OpenAI, no URL field.
- Bad: keep `统一网关` in `SUM_PROVIDERS` or default `xy-fast` for non-custom providers.

### 6. Tests Required

- `SUM_PROVIDERS` equals the four names.
- Gemini `SUM_URLS` is the OpenAI-compat host (no trailing path beyond `/openai`).
- `migrateSum` cases: gateway with/without URL; each legacy named vendor.

### 7. Wrong vs Correct

#### Wrong

```js
SUM_PROVIDERS = ["统一网关", "OpenAI", "DeepSeek", "自定义"];
// translateBatchWithFallback then retries model "xy-backup"
```

#### Correct

```js
SUM_PROVIDERS = ["OpenAI", "Gemini", "DeepSeek", "自定义"];
// one chat request per batch; empty translateModel follows resolveSum().model
```

## Scenario: MERGE/KEEP regroup before translate

### 1. Scope / Trigger

Clicking 「翻译成中文」 translates immediately in batches of 24 with configured concurrency. Do **not** call the LLM 断句军师 first — that serial MERGE over ~80-line chunks made 2000-line jobs look like `6/2292`. Local `refineAsrCues` / sentence split is enough. Overlay cues, job progress, and resume flags are a cross-layer contract (`background.js` ↔ `sidepanel.js` ↔ `lib/translate.js`). The MERGE/KEEP parser in `lib/translate.js` stays for tests and optional future use.

### 2. Signatures

- `BiliCaptionTranslate.parseRegroupCommands(raw, count) -> { ok, ranges?, reason? }`
- `BiliCaptionTranslate.applyRegroupText(cues, raw) -> { cues, fallback, reason? }`
- `BiliCaptionTranslate.chunkCues(cues, size=REGROUP_CHUNK_SIZE)`
- `runTranslateJob` broadcasts `stage: "run" | "done" | "canceled" | "error"`
- persisted job field `regrouped: boolean`

`REGROUP_CHUNK_SIZE` is 80. Chunks are serial and non-overlapping.

### 3. Contracts

Model output (only):

```
MERGE 1-5
KEEP 6
```

Worker applies timestamps: MERGE `from` = first cue `from`, `to` = last cue `to`, text via `joinCueText`. Never accept model-written timecodes.

`START_TRANSLATE` / resume opens as `stage: "run"` with `done/total` counted in English cue lines after local sentence split. `total` is frozen at start. Translate in batches of 24 with concurrency. No LLM regroup in the live path.

Before each overlay sync, run `refineAsrCues` on the merged prefix so a long MERGE does not flash as one paragraph. After Chinese is written (each chunk and job end), run `splitTranslatedCues` so translation-inserted `。` splits the line without merging short cues. Official Bilibili cues go through `refineCues` on fetch; translated cache uses `splitTranslatedCues` on load.

If `job.regrouped` is already true, skip regroup.

### 4. Validation & Error Matrix

| Condition | Behavior |
|---|---|
| empty / unparsed output | keep original chunk, continue job |
| `SPLIT` line | whole chunk fallback (`reason: "split"`) |
| overlapping MERGE | whole chunk fallback (`reason: "conflict"`) |
| MERGE range includes Chinese or speaker change | split at that boundary, keep the rest |
| network error on a chunk | keep original chunk, continue |
| abort (extension killed / crash) | keep refined merged prefix + remaining original chunks; `pending` so SW boot / `GET_TRANSLATE_JOB` can resume |
| user cancel | keep already-translated cues in ASR cache; **clear** `trJob:` so reload / opening a video does not auto-resume |

### 5. Good / Base / Bad Cases

- Good: `MERGE 1-2` + `KEEP 3` on three English cues → one joined cue spanning first.from–second.to, then the third cue.
- Base: no English targets → `{ empty: true }` as before, no regroup call.
- Bad: write new SRT timestamps in the model reply, or show `stage: "run"` before the first regroup broadcast.

### 6. Tests Required

- Parse MERGE/KEEP; SPLIT and overlap fallback.
- Local `from`/`to` after MERGE; Chinese-boundary cut.
- Fresh translate job snapshot `stage === "regroup"`.
- Chunk network failure does not abort translation.

### 7. Wrong vs Correct

#### Wrong

```js
const raw = await translateChat("Rewrite this SRT with new timestamps…");
job.cues = parseSrt(raw); // model owns the clock
```

#### Correct

```js
const { cues, fallback } = T.applyRegroupText(chunk, raw);
job.cues = [...refineAsrCues(merged), ...rest];
```

## Scenario: bilingual caption language switch

### 1. Scope / Trigger

Sidepanel 中 / EN control, overlay language, `cue.original` persistence, or replacing the official `trackSelect` dropdown for zh/en tracks.

### 2. Signatures

- `BiliCaptionTranslate.cueDisplayText(cue, lang) -> string`
- `BiliCaptionTranslate.cueHasOriginal(cue) -> boolean`
- `BiliCaptionTranslate.stampCueOriginal(cue, english) -> cue`
- `SET_CAPTION_LANG` tab message `{ lang: "zh" | "en" }`
- storage: `chrome.storage.sync.captionLang`

### 3. Contracts

Translation overwrites `cue.content` with Simplified Chinese and writes `cue.original` once with the English source. Do not swap `content` when the user toggles language — display only.

`loadSubtitles` / ASR cache round-trip must keep `original`. `flattenCueParts` copies `original` onto split pieces. `mergeTranslatedCues` / `preserveCueText` set `original` from the incoming English line when overlaying a previous Chinese translation.

The 中 | EN control is visible **only when both Chinese and English actually exist**. Chinese-only official tracks or Chinese-only plugin ASR must not show the switch. Default `captionLang` is `"zh"`.

- Plugin ASR + translate with `cue.original`: **display-only**. Never `SWITCH_TRACK`.
- Official Bilibili zh **and** en tracks (not plugin): 中 / EN calls `SWITCH_TRACK`. Never show the old `trackSelect` dropdown — 中/EN replaces it.
- Plugin English ASR not yet translated, or Chinese-only ASR: hide the switch.
- `captionListHasLang`: zh = any CJK `content`; en = `cueHasOriginal` or the list is predominantly English (`needsTranslation` and no CJK, count >= Chinese). A few English loanwords in Chinese captions do not count as English.

Copy / SRT / TXT follow the current display language. Outline / summary prompts still use `cue.content` (Chinese after translate).

### 4. Validation & Error Matrix

| condition | result |
|---|---|
| official zh + en tracks, not plugin | show 中/EN; click EN `SWITCH_TRACK` to en |
| official zh only / plugin Chinese-only ASR | hide 中/EN |
| plugin ASR + translate with `original` | show 中/EN; display-only; never `SWITCH_TRACK` |
| plugin English ASR, no Chinese yet | hide 中/EN until translated |
| `captionLang` is `"en"` but a cue has no original | that row falls back to `content` |

### 5. Good/Base/Bad Cases

- Good: translated English ASR → 中 shows 中文, EN shows original, overlay matches
- Base: official `ai-zh` only → no 中/EN
- Bad: showing 中/EN on Chinese-only captions; `SWITCH_TRACK` on groq/translated cues

### 6. Tests Required

- `测试/中英字幕切换.test.js`: display helper; stamp-once; translate job keeps original; flatten keeps original; mergeTranslatedCues keeps original; `trackLangKind` / `pickTrackByLang`; HTML/CSS/message wiring; sidepanel shows switch on captions and hides zh/en-only `trackSelect`
- `测试/批量翻译与分片逻辑.test.js`: 50-line job originals; cross-file `captionLang` / `SET_CAPTION_LANG`

### 7. Wrong vs Correct

#### Wrong

```
cue.content = captionLang === "en" ? cue.original : cue.content;
sendToTab({ type: "SYNC_CUES", cues });
```

`SYNC_CUES` saves cache. English would replace the translation.

#### Correct

```
stampCueOriginal(cue, english);
cue.content = chinese;
// display: cueDisplayText(cue, captionLang)
sendToTab({ type: "SET_CAPTION_LANG", lang });
```

---

## Design Decision: regroup on Translate, not after ASR

ASR stays fast and unchanged. Regroup costs chat tokens only when the user asks for Chinese. The overlay length cap stays `refineAsrCues` / `shouldSplitCue`; MERGE may produce long semantic units, the player must still see short lines.

## Common Mistake: exposing regroup in the pill

Regroup is an implementation detail. The pill and job bar only show 「翻译中」 plus sentence `done/total`. Do not broadcast `stage: "regroup"` or chunk counts to the UI.
