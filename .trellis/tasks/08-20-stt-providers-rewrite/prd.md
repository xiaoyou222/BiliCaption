# 转写服务商只留 Fish / Groq / OpenAI

## Goal

设置页「转写服务」只保留三家：Fish Audio、Groq、OpenAI。OpenAI 默认官方地址，但用户可以改 URL，模型仍是 OpenAI 转写那一套。不再提供单独的「自定义」转写服务商。总结 / 翻译一行不动。

## Background

当前转写列表是 Groq、OpenAI、硅基流动、阿里云百炼、腾讯云、讯飞、火山引擎。用户只要 Fish / Groq / OpenAI。Fish Audio 官方转写是 `POST https://api.fish.audio/v1/asr`，Bearer API Key，multipart 字段 `audio`，不是 OpenAI 兼容接口。火山 M4A→WAV（`08-20-volcano-m4a-wav`）随火山一起卸掉。

## Requirements

- 转写服务商只显示：`Fish Audio`、`Groq`、`OpenAI`。默认仍是 Groq。
- Fish Audio：只填 API Key。请求 `POST https://api.fish.audio/v1/asr`，头 `Authorization: Bearer <key>`，`multipart/form-data` 字段 `audio`。字幕必须带时间轴，因此固定传 `ignore_timestamps=false`。语言沿用现有 `asrLanguage`。不展示模型框（官方 ASR 无 model 字段）。
- Groq：保持现在的官方 URL 与 Whisper 模型列表，URL 不可改。
- OpenAI：默认 URL `https://api.openai.com/v1`，设置页提供可编辑的「接口地址」；空值回落到官方地址。模型仍是 `whisper-1` / `gpt-4o-transcribe` / `gpt-4o-mini-transcribe`，不因为改 URL 换成别的默认模型。
- 没有单独的转写「自定义」服务商。改地址只发生在 OpenAI 这一家。
- 备用服务商只能从剩下两家里选（不含当前主服务商）。
- 已保存的主服务商若不在新名单里，回落到 Groq。备用若不在新名单里，回落到「不启用」。Groq / OpenAI 已有 Key 保留。
- 硅基流动、阿里云百炼、腾讯云、讯飞、火山引擎的转写实现、设置项、host 权限一并删除。只给转写用的 Offscreen / WAV 转码一并删除。
- 总结服务、翻译、统一网关、总结页的「自定义」保持原样。`dashscope.aliyuncs.com` 等总结用 host 不要误删。
- 切片、断点、侧栏折叠不中断，行为与现在 Groq/OpenAI 路径一致。Fish 官方上限 20 MB / 60 分钟；本轮仍用现有约 8 分钟 / 20 MB 切片，不单独放宽。

## Acceptance Criteria

- [ ] 转写服务商分段只剩 Fish Audio、Groq、OpenAI；设置页看不到硅基 / 百炼 / 腾讯 / 讯飞 / 火山 / 转写自定义。
- [ ] Fish Audio 填 Key 后可测通，生成字幕时请求 `api.fish.audio/v1/asr`，body 是 multipart `audio`，且带时间轴分段。
- [ ] Groq 生成字幕路径与现在一致，不出现 URL 输入框。
- [ ] OpenAI 不改 URL 时走 `api.openai.com`；改成兼容地址后走新地址，模型列表仍是 OpenAI 转写模型。
- [ ] 总结页服务商、统一网关、自定义地址、翻译模型逻辑与现在一致。
- [ ] 旧设置里主服务商是火山等已删项时，打开设置或开工回落到 Groq，不报未知服务商。
- [ ] 现有兼容性测试按新三家改写；火山 / 百炼 / 讯飞转写用例删除或替换。

## Out of Scope

- 不改总结 / 翻译服务商列表。
- 不接 Fish TTS、Voice Clone、WebSocket。
- 不把 Fish 做成 OpenAI 兼容代理。
- 不放宽切片时长，不为 Fish 单独做 60 分钟整段上传。
- 不完成或继续 `08-20-volcano-m4a-wav`（已被本需求替代）。
- 不接 ElevenLabs 网页演示免登录（`allow_unauthenticated`）。空 Key 不回落免登录，Key 框也不用密码切换。要接 ElevenLabs 只能走官方 `xi-api-key`。

## Open Questions

- 要不要把 ElevenLabs 加成第四家转写服务商（只走官方 `xi-api-key`）？当前目标仍是 Fish / Groq / OpenAI 三家。
