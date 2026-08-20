# 语义断句后再翻译

## Goal

点「翻译成中文」时，先用现有聊天模型把 Whisper 切碎的字幕收成语义完整句，再翻译。模型只输出 `MERGE` / `KEEP`，时间轴由本地代码改。总结/翻译服务商收成 OpenAI、Gemini、DeepSeek、自定义；统一网关删除。

## Background

当前转写（`background.js` `refineAsrCues`）只按标点、时长、字数切分/合并。翻译（`lib/translate.js` + `runTranslateJob`）按现有 cue 每 24 条编号英译中，批次之间没有上下文。半句话会被单独翻译，质量上限卡在断句，不卡在模型。

参考方案（linux.do/t/topic/636844）把「AI 军师 / 脚本工人」拆开：模型输出 `MERGE X-Y` / `KEEP X`，程序改 `from`/`to`。本任务借这个结构，不借 Vertex、GCP 或桌面 Python 流水线。

总结页现在是 `统一网关 / OpenAI / DeepSeek / 智谱 GLM / Kimi / 通义千问 / OpenRouter / 自定义`。统一网关只是用户自填的 OpenAI 兼容中转，外加 `xy-smart` / `xy-fast` / `xy-backup` 别名；产品主人不用这套，因此删掉。智谱、Kimi、通义、OpenRouter 并进自定义。Gemini 新加为具名项，走官方 OpenAI 兼容聊天地址。

## Confirmed facts

- 产品是 B 站播放器叠字幕，不是离线双语 SRT。合并后仍须按现有显示上限切开（约 56 字 / 12 秒，`shouldSplitCue`）。
- 总结和翻译共用 `resolveSum` 的服务商与 Key；翻译另有 `translateModel`。断句走同一条聊天接口。
- 翻译目前替换 cue 文本为中文，不是双语两行。本轮保持这个形态。
- 模型不得生成带时间码的新 SRT。只允许 `MERGE X-Y` 和 `KEEP X`。MVP 不做 `SPLIT`。
- 说话人切换是硬切点：禁止跨说话人 `MERGE`。
- 与 `08-20-stt-providers-rewrite` 独立。本轮不改转写服务商。
- 统一网关删除。新默认服务商是 OpenAI。`xy-smart` / `xy-fast` / `xy-backup` 及自动备用只服务于统一网关，一并去掉。
- 断句发生在点「翻译成中文」时，不新增按钮，转写完成后不提前断句。

## Requirements

- 点「翻译成中文」后，翻译任务先跑「断句」再跑「翻译」。不新增按钮或设置开关。
- 断句：对当前 cue 列表分块调用现有聊天接口，解析 `MERGE`/`KEEP`，本地合并相邻条目（`from` 取第一条、`to` 取最后一条、文本用现有 `joinCueText`）。
- 指令覆盖全部输入序号；解析失败、覆盖不全、或模型输出 `SPLIT` 时，该块保持原 cue，不中断整次翻译。
- 已是中文的行不得被 MERGE 进英文。说话人切换禁止 MERGE。
- 合并后立刻跑现有 `refineAsrCues` / `splitLongCue`，屏幕上的行仍然短。
- 翻译按合并后的语义单元来做；现有 24 条一批、并发、编号解析保持。不再调用 `xy-backup`。
- 进度可区分断句 / 翻译；取消翻译时已合并或已译的句子保留。
- 总结/翻译服务商只显示：OpenAI、Gemini、DeepSeek、自定义。默认 OpenAI。
- Gemini：固定官方 OpenAI 兼容地址 `https://generativelanguage.googleapis.com/v1beta/openai`，用户只填 API Key 和模型。
- 自定义：用户填接口地址和 Key，可接原先的智谱 / Kimi / 通义 / OpenRouter / 任何 CPA 网关。
- 旧设置迁移：`统一网关` 若已填地址 → 自定义（保留 URL、Key、模型）；未填地址 → OpenAI。智谱 / Kimi / 通义 / OpenRouter → 自定义，并把原官方 URL 写入地址栏，Key 保留。加载设置时写回，避免 UI 仍显示已删服务商。

## Acceptance Criteria

- [ ] 点「翻译成中文」后，先出现断句阶段，再出现按句翻译进度。转写完成不会自动断句。
- [ ] 模型只被要求输出 `MERGE`/`KEEP`；最终 cue 的时间轴由本地代码计算，不采用模型写的时间码。
- [ ] 语义上应连在一起的相邻英文行会被合并后再译；明显换说话人的相邻行不会被合并。
- [ ] 合并后的长句仍会被切成适合叠字幕的短行；播放器上不会出现整段段落挡画面。
- [ ] 总结页服务商只剩 OpenAI、Gemini、DeepSeek、自定义；看不到统一网关 / 智谱 / Kimi / 通义 / OpenRouter。
- [ ] 选 Gemini 时走官方兼容地址，填 AI Studio / Gemini API Key 即可。
- [ ] 旧「统一网关」且已填 URL 时打开设置落到自定义且地址仍在；未填 URL 时落到 OpenAI。
- [ ] 旧智谱等具名项打开设置落到自定义，官方地址和 Key 仍在，总结/翻译仍能打到原服务。
- [ ] 翻译失败不再自动改打 `xy-backup`。
- [ ] 断句解析失败时，该块按原 cue 继续翻译，整次任务不因此失败。
- [ ] 取消翻译后，已写出的中文和已改过的时间轴保留；可再点一次续翻。
- [ ] 现有批量翻译测试按新服务商改写；新增断句指令解析 / 本地合并 / 失败回落 / 旧服务商迁移的测试。

## Out of Scope

- 不接 Vertex、Hugging Face 中转，不把 Gemini 做成转写服务商。
- 不改转写服务商列表。
- 不把 Claude、Groq、智谱、Kimi、通义、OpenRouter、统一网关加成具名总结服务商。
- 不保留 `xy-smart` / `xy-fast` / `xy-backup` 专用逻辑。
- 不做 `SPLIT` 指令，不让模型重写 SRT 格式。
- 不改成双语两行字幕，不导出离线 SRT 流水线。
- 不把「尽量合成很长完整句、忽略显示长度」当成产品目标。
- 不在设置页增加断句开关或独立模型框。
- 不在转写结束后自动断句。
