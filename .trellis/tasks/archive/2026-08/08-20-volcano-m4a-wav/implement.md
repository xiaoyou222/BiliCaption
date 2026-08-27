# Implement

## Checklist

1. 抽出 `lib/wav-encode.js`：`mixMono`、`resampleLinear`、`encodeWavPcm16`。Node 测试：RIFF/WAVE 头、采样率 16000、单声道、16-bit。
2. 新增 `offscreen.html` / `offscreen.js`：收 ArrayBuffer，`decodeAudioData`，调 wav-encode，回传 WAV。
3. `manifest.json`：加 `offscreen` 权限；无需 web_accessible。
4. `background.js`：
   - `ensureOffscreen()` 单例
   - `decodeToWav(blob, signal)` 走 Offscreen
   - `transcribeWithCfg` 在火山且非 wav/mp3/ogg/opus 时先转码
   - 去掉开工时对火山 `sttCompatibilityError(..., "m4a")` 的硬拦截
5. `lib/providers.js`：删火山 `compatibilityWarning`。`sttCompatibilityError` 火山+m4a 可保留给误用，但 background 不再用它拦生成。
6. `lib/stt.js`：继续拒绝直接 M4A（测试保持「不会拿 M4A 整批请求」）。
7. 测试：
   - 更新「设置页提示 M4A」：警告应消失，火山可进备用列表
   - 新增 wav-encode 单测
   - 火山 `transcribe` 仍拒绝 `audio/mp4`
   - 可选：mock Offscreen 消息，断言 `transcribeWithCfg` 火山路径带 wav（若现有 background 测试不好挂，就测抽出来的 helper）

## Validate

```bash
node --test 测试/转写服务兼容性.test.js 测试/音频切片器.test.js 测试/批量翻译与分片逻辑.test.js 测试/wav编码.test.js
```

手工：设置火山 → 生成字幕 → 折叠侧栏 → 再打开，进度还在；开发者工具看请求 body 不是 m4a。

## Rollback

删 Offscreen 文件、还原 manifest 权限、还原 compatibility 拦截。切片器和其它服务商路径不应被这次改动绑死。
