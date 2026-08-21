# Design

## Behavior gap

翻译现在直接按 Whisper cue 编号英译中。本轮在 `runTranslateJob` 里加一段「断句」：同一套聊天接口先出 `MERGE`/`KEEP`，本地改轴，再翻译。总结服务商从 8 家收到 4 家，默认改为 OpenAI，去掉统一网关和 `xy-*` 别名。

转写路径（`refineAsrCues`、STT 服务商）不改。

## Sum providers

| 服务商 | 默认 base | 用户可改 URL | 默认模型 |
|---|---|---|---|
| OpenAI | `https://api.openai.com/v1` | 否 | `gpt-4o-mini` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | 否 | `gemini-2.5-flash` |
| DeepSeek | `https://api.deepseek.com/v1` | 否 | `deepseek-chat` |
| 自定义 | 用户填写 | 是 | 空，跟手输 |

Gemini 走官方 OpenAI 兼容聊天口，Bearer 仍是 AI Studio Key。`translateChat` 已打 `{base}/chat/completions`，不用另写 Gemini 客户端。默认用 Flash：断句指令不需要 Pro，免费档也更稳。提示列表可含 `gemini-2.5-flash`、`gemini-3-flash-preview`。

`SUM_PROVIDERS` 新名单：`["OpenAI", "Gemini", "DeepSeek", "自定义"]`。`resolveSum` 默认 `OpenAI`。翻译模型留空则跟随总结模型（现有非网关行为）。

## Migration

在 `lib/providers.js` 提供 `migrateSum(storage)`，`resolveSum` 和设置页加载都走它，加载后写回 storage。

| 旧 `sumProvider` | 新值 | 地址 |
|---|---|---|
| `统一网关` 且 `apiBase`/`sumUrl` 非空 | `自定义` | 保留 |
| `统一网关` 且地址为空 | `OpenAI` | 官方 |
| `智谱 GLM` / `Kimi` / `通义千问` / `OpenRouter` | `自定义` | 写入原 `SUM_URLS` |
| 已在新名单 | 不动 | 不动 |
| 其他未知 | `OpenAI` | 官方 |

Key、`apiModel`、`translateModel` 都保留。若翻译模型是 `xy-fast` / `xy-smart` / `xy-backup` 且已迁走统一网关，清空翻译模型让它跟随总结模型。

## 去掉 xy-*

`lib/模型路由.js` 的 `xy-fast` / `xy-smart` / `xy-backup`、`fallbackFor`、`isBusinessAlias` 校验不再用于翻译。`translateBatchWithFallback` 变成对当前翻译模型请求一次；结构校验失败就当这批失败（现有「跳过不像中文的行」仍在）。不要再打第二发 `xy-backup`。

设置页文案去掉「xy-smart / xy-fast / xy-backup」。`#sumCustom` 只在「自定义」时显示。

## 断句流水线

入口仍是侧栏「翻译成中文」→ `START_TRANSLATE`。`runTranslateJob` 顺序：

1. `prepareCues`（现有：简体、筛出要译的行）。若没有英文目标，行为与现在相同。
2. 若 `job.regrouped` 已是 true（续跑），跳过断句。
3. 否则对 cue 列表按约 80 条一块处理。**每一块：断句 → `refineAsrCues` → 立刻翻译该块**，再进入下一块。不要等全部断完再译。块与块不重叠，不做跨块 MERGE。
4. 解析指令 → 本地应用 → `refineAsrCues` → 写回当前已完成前缀 + 未处理后缀，广播 `stage: "run"` 和已译句数，经现有 `syncTranslatedCues` 同步。
5. 该块内翻译仍是 24 条一批、按设置并发。下一块未断句的英文先保持原文。用户界面不展示断句。

工人逻辑放 `lib/translate.js`（或同级小模块，由 `BiliCaptionTranslate` 导出），service worker 只编排。复用 `joinCueText` 的规则：英文之间补空格。时间轴：MERGE 的 `from` = 第一条，`to` = 最后一条，中间条目丢掉。不要按字数重切时间，显示长度交给随后的 `refineAsrCues`。

### 指令协议

模型只能输出：

```
MERGE 1-5
KEEP 6
```

解析规则：

- 忽略空行、解释、markdown。
- `SPLIT` 或无法识别的行：该序号当 `KEEP`。
- 缺序号当 `KEEP`。
- `MERGE X-Y` 要求 X < Y、范围内都在本块；越界整条丢弃。
- MERGE 区间若含已是中文的 cue（`looksTranslated` / 现有 CJK 判断），在中文边界切开，只合并连续英文。
- 覆盖冲突（同一行出现在两个 MERGE）时整块回落原 cue。

断句失败（网络、空响应、整块无法解析）不 abort 翻译：该块保持原 cue，记一条 log，继续下一块。

### 提示词要点

军师角色：只出指令。优先把同一说话人、同一句子/意群的相邻行 MERGE；换说话人必须断开；不要因为「有点长」就不合并；显示长度由程序处理。已是中文的行必须 KEEP。禁止输出时间码或译文。

断句和翻译都用 `translateModel || sumModel`，不另开模型框。

## 进度 / 取消

`trBroadcast` 对外只报 `stage: "run"` 和已译句数。断句在后台按块进行，侧栏胶囊只显示「翻译中」和 `done/total` 句数，用户不感知断句。取消仍 abort 同一 `AbortController`，已合并的 cue 和已译中文都保留。

续跑：storage 里的 translate job 带上 `regrouped` 和最新 cues。已断句则直接译剩下的英文。

## Hosts

`manifest.json` 加上 `https://generativelanguage.googleapis.com/*`。智谱 / Kimi / 通义 / OpenRouter 的 host 先留着，迁到自定义的旧用户不必再点一次权限。自定义新地址继续走 `optional_host_permissions` + `ensureOrigin`。

## Not doing

不改 STT。不接 Vertex。不在转写结束时断句。不做 SPLIT。不输出双语两行。
