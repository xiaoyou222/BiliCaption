# 火山引擎 M4A 转 WAV 后转写

## Goal

选火山引擎生成字幕时，B 站 M4A 音轨自动转成 WAV 再上传。设置页能配、能测通，也能真正转写出字幕。侧栏折叠或关掉不中断。

## Background

火山录音文件极速版只收 WAV / MP3 / OGG OPUS。扩展现在从 B 站拿到的是 M4A，启动生成前就会被 `sttCompatibilityError` 拦住。Key 测通了也用不了。

转写跑在 Service Worker。Chrome 后台脚本没有 Web Audio，解 AAC 必须放到 Offscreen 文档。Offscreen 不跟侧栏绑定，折叠侧栏不会拆掉转码。

## Requirements

- 主服务商或备用是火山时，每一段 M4A 在上传前转成 16 kHz、16-bit、单声道 WAV，再走现有极速版接口（`model_name=bigmodel`）。
- 转码在 Offscreen 完成；Service Worker 继续负责下载、切片、调用接口、断点续跑。
- 侧栏折叠、关闭、或切到浮窗，不取消转写、不取消转码。
- Groq / 硅基流动 / 腾讯云 / 讯飞 / 百炼仍直接传 M4A，不绕 Offscreen。
- 火山不再显示「M4A 无法转写」警告，也不再因此从备用列表里被踢掉。
- `model` 仍固定 `bigmodel`，用户不用改。
- 转码失败时该段失败，错误说清是转码失败，不要用原始 M4A 去撞火山接口。

## Constraints

- 不引入 ffmpeg.wasm 或其他解码库；只用 Chrome Web Audio。
- 不改切片器容器格式；切片仍是 M4A，只在送给火山前转码。
- 不断点指纹仍按原始分片算，避免已有进度失效。
- 火山上传仍走 base64 JSON。WAV 按时长膨胀，分片时长保持现有约 8 分钟上限（16 kHz 单声道约 15 MB）。

## Acceptance Criteria

- [ ] 火山为主服务商时，生成字幕不再被「M4A 无法直接转写」拦住。
- [ ] 发给火山的请求体是 WAV（或至少 `audio/wav`），不再是 M4A。
- [ ] 折叠或关闭侧栏后，后台任务继续；再打开能看到进度。
- [ ] 主服务商不是火山时，行为与现在一致，不创建 Offscreen、不转码。
- [ ] 设置页火山不再显示黄色 M4A 警告；备用列表可以选火山（当前主服务商除外）。
- [ ] 现有兼容性测试按新行为更新，并覆盖：火山拒绝直接 M4A；WAV 编码器产出合法头；非火山路径不转码。

## Out of scope

- 不接火山标准版 / 闲时版轮询接口。
- 不给百炼 `qwen3-asr-flash` 做同样转码。
- 不改火山鉴权（继续新版控制台 `X-Api-Key`）。
- 不做 MP3 编码。
