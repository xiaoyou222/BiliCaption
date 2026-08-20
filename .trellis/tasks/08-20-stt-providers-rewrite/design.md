# Design

## Behavior gap

现在 `lib/providers.js` 的 `STT_PROVIDERS` 有 7 家，`lib/stt.js` 按 `kind` 分发 openai / tencent / xunfei / volcano / dashscope。目标只留 3 家：Fish（新 kind）、Groq、OpenAI（openai kind，OpenAI 允许改 base）。

总结侧 `SUM_PROVIDERS`、`resolveSum`、统一网关兜底一律不动。

## Provider contract

| 服务商 | kind | 默认 base | 用户可改 URL | 模型 UI | 凭证 |
|---|---|---|---|---|---|
| Fish Audio | `fish` | `https://api.fish.audio` | 否 | 隐藏 | `key` |
| Groq | `openai` | `https://api.groq.com/openai/v1` | 否 | 现有下拉 | `key` |
| OpenAI | `openai` | `https://api.openai.com/v1` | 是 | 现有 OpenAI 转写列表 | `key` + 可选 `url` |

`resolveStt` / `resolveBackup`：`OpenAI` 的 `base = normalizeBase(box.url || meta.url)`。空字符串当没填。Groq / Fish 忽略用户 URL。

已删服务商：`硅基流动`、`阿里云百炼`、`腾讯云`、`讯飞`、`火山引擎`。加载设置时若 `sttProvider` 不在新名单，写成 Groq；`backupProvider` 无效则「不启用」。

## Fish Audio

官方：https://docs.fish.audio/api-reference/endpoint/openapi-v1/speech-to-text.md

```
POST https://api.fish.audio/v1/asr
Authorization: Bearer <API Key>
Content-Type: multipart/form-data
audio: <file>
language: zh|en|…   # 有 asrLanguage 才带
ignore_timestamps: false
```

成功 JSON：`{ text, duration, segments: [{ text, start, end }], language_code }`。`start`/`end` 已是秒，直接映射现有 cue。

测连通：对 1 秒 `silentWav()` 发同样的 ASR（Fish 最短 1 秒）。不要打 `/models`。402/401 按现有错误包装。

不走 Offscreen。B 站 M4A 原样上传。官方写 wav/mp3/opus and more，20 MB / 60 分钟；切片仍用现有 8 分钟 / 20 MB。

## OpenAI 可改 URL

设置页在选中 OpenAI 时多一个文本框「接口地址」，placeholder 官方 URL，不是 password。值存在 `sttCreds.OpenAI.url`。`transcribeOpenAI` 已用 `cfg.base`，不用另写一套。

改 URL 后 `ensureOrigin` 继续走 `optional_host_permissions` 的 `https://*/*`。

Groq 继续走 `background.js` 的 `transcribeWithGroq` 快路径，不出现 URL 框。从 `transcribeOpenAI` 里删掉 `硅基流动` 特例。

## 删除面

- `lib/stt.js`：`transcribeTencent` / `transcribeXunfei` / `transcribeDashScope` / `transcribeVolcano` / `requestVolcano` / hmac 仅腾讯用的可删。
- `background.js`：火山 Offscreen、`decodeToWav`、`volcanoNeedsWav`、`jobCompatibilityError` 对 volcano 的特殊分支。
- `offscreen.html` / `offscreen.js` / `lib/wav-encode.js`；`manifest.json` 的 `offscreen` 权限。
- host：加上 `https://api.fish.audio/*`；去掉只给转写用的 `api.siliconflow.cn`、`asr.cloud.tencent.com`、`raasr.xfyun.cn`、`openspeech.bytedance.com`。保留 `dashscope.aliyuncs.com`（总结通义）。
- `acceptsSttExtension` / `sttCompatibilityError` 的 volcano、qwen3 分支可删；三家都收 M4A。
- 测试：百炼 / 火山 / 讯飞转写用例换成 Fish multipart + OpenAI 改 URL + 旧服务商回落。

## 设置页

`options.js` `renderSttFields`：OpenAI 在 Key 上方或下方加 URL 文本框。Fish 时隐藏 `#sttModel` 所在 field。`compatibility` 提示不再出现百炼 5 分钟文案。

备用列表：`Fish Audio` / `Groq` / `OpenAI` 互斥。

## 失败

Fish 4xx/5xx 用 `message`。401/403 仍算 `isFatalSttError`。转码相关文案不再出现。

## Not doing

不改 `resolveSum`、翻译并发、统一网关 `xy-smart` / `xy-fast`。
