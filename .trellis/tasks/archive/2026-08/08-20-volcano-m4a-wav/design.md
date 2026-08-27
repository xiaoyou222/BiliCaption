# Design

## Behavior gap

现在：`background.js` 在开工前对火山调用 `sttCompatibilityError(..., "m4a")` 直接抛错；`lib/stt.js` 的 `transcribeVolcano` 也拒绝非 wav/mp3/ogg/opus。设置页 `compatibilityWarning` 还会把火山从备用列表过滤掉。

目标：M4A 分片在 `Stt.transcribe` 之前变成 WAV。火山仍只收 WAV。其它服务商不转码。

## Where it lives

转换点在 `background.js` 的 `transcribeWithCfg`：已经知道本段要交给哪个 `cfg`。在这里判断 `cfg.kind === "volcano"` 且扩展名不是 wav/mp3/ogg/opus，再解码。

不要放进切片器：切片结果要继续给 Groq 备用；指纹也按 M4A 分片算。

不要只放在 `stt.js`：Service Worker 解不了 AAC，`stt.js` 也跑在测试 VM 里，不该依赖 DOM。

## Data flow

```
B 站 M4A
  → mp4-aac 切片（仍是 m4a）
  → 断点匹配（fingerprint 仍用 m4a）
  → transcribeWithCfg(cfg)
       ├─ cfg 不是火山：原样上传
       └─ cfg 是火山：
            SW 把 ArrayBuffer 发给 Offscreen
            Offscreen AudioContext.decodeAudioData
            混成单声道、重采样 16 kHz、写 WAV
            交回 Blob(type=audio/wav)
            requestVolcano(base64 WAV)
```

## Offscreen contract

- `manifest.json` 增加 `offscreen` 权限。
- 文档：`offscreen.html` + `offscreen.js`，理由 `AUDIO_PLAYBACK` + `BLOBS`。
- 全程只建一个 Offscreen，复用到任务结束。
- 消息：`{ type: "DECODE_WAV", id, sampleRate: 16000 }` + transferable `ArrayBuffer`。
- 回包：`{ type: "DECODE_WAV_RESULT", id, ok, wav, error }`，`wav` 为 ArrayBuffer。
- 取消：`AbortSignal` 在 SW 侧忽略过期结果；Offscreen 不保证立刻停解码。

## WAV 编码

纯函数放 `lib/wav-encode.js`（Offscreen 和 Node 测试共用）：

- 输入：Float32 通道、原始 sampleRate
- 输出：16-bit PCM WAV，单声道 16 kHz
- 多声道平均；重采样线性插值即可

## Limits

火山 `sttLimits` 保持 8 分钟 / 20 MB。16 kHz 单声道 8 分钟 WAV ≈ 15.4 MB，base64 后约 20.5 MB，低于官方 100 MB。切片仍按源 M4A 大小切。

## Compatibility flags

- 删除火山 `compatibilityWarning`。备用列表不再因警告排除火山。
- `sttCompatibilityError(volcano, "m4a")` 不再用于开工拦截。
- `transcribeVolcano` 继续拒绝 M4A，作为防漏网。

## Failure

解码失败 → 该分片失败，文案带「音频转码失败」。不要回退传 M4A。Groq 备用若启用，加速/失败切换仍走原 M4A 分片。

## Not doing

- 不在侧栏页解码（折叠会卸页面）
- 不引入 ffmpeg
- 不把 WAV 写入磁盘或 WebDAV
