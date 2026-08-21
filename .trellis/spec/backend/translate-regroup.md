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

Clicking 「翻译成中文」 must regroup then translate. ASR completion must not regroup. Overlay cues, job progress, and resume flags are a cross-layer contract (`background.js` ↔ `sidepanel.js` ↔ `lib/translate.js`).

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

`START_TRANSLATE` / resume opens as `stage: "run"` with sentence `done/total`. Regroup runs in the background per chunk and is not shown in the pill. After each chunk regroups, translate that chunk in batches of 24.

Before each overlay sync, run `refineAsrCues` on the merged prefix so a long MERGE does not flash as one paragraph.

If `job.regrouped` is already true, skip regroup.

### 4. Validation & Error Matrix

| Condition | Behavior |
|---|---|
| empty / unparsed output | keep original chunk, continue job |
| `SPLIT` line | whole chunk fallback (`reason: "split"`) |
| overlapping MERGE | whole chunk fallback (`reason: "conflict"`) |
| MERGE range includes Chinese or speaker change | split at that boundary, keep the rest |
| network error on a chunk | keep original chunk, continue |
| abort | keep refined merged prefix + remaining original chunks |

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

## Design Decision: regroup on Translate, not after ASR

ASR stays fast and unchanged. Regroup costs chat tokens only when the user asks for Chinese. The overlay length cap stays `refineAsrCues` / `shouldSplitCue`; MERGE may produce long semantic units, the player must still see short lines.

## Common Mistake: exposing regroup in the pill

Regroup is an implementation detail. The pill and job bar only show 「翻译中」 plus sentence `done/total`. Do not broadcast `stage: "regroup"` or chunk counts to the UI.
