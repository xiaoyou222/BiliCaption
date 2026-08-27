# Implement

## Checklist

1. `lib/providers.js`
   - `STT_PROVIDERS = ["Fish Audio", "Groq", "OpenAI"]`
   - 重写 `STT_SCHEMA`：Fish `kind:"fish"`；OpenAI 保留默认 url，另记 `editableUrl: true`
   - `MODEL_HINTS` 只留 Groq / OpenAI 转写模型；Fish 无模型
   - `resolveStt` / `resolveBackup`：OpenAI `base` 用 `box.url || meta.url`；未知服务商回落 Groq / 不启用
   - 删 volcano / dashscope 兼容函数或改成三家都接受 m4a
   - `credentialKey` 不再特殊对待火山 `apiKey`
2. `lib/stt.js`
   - 新增 `transcribeFish`：multipart `audio` + `ignore_timestamps=false`
   - `testConnection`：Fish 用 1 秒 silent wav
   - `listModels`：Fish 返回 `[]`（UI 已隐藏）
   - 删除腾讯 / 讯飞 / 百炼 / 火山整支；去掉硅基流动特例
3. `options.js` / `options.html`
   - OpenAI 渲染可编辑接口地址
   - Fish 隐藏模型行
   - 去掉百炼兼容提示
4. `background.js`
   - 删 Offscreen / `decodeToWav` / `volcanoNeedsWav`
   - 开工不再按旧服务商兼容错误拦截
   - Groq 快路径保持
5. `manifest.json`
   - 加 `https://api.fish.audio/*`
   - 去掉 siliconflow / tencent asr / xunfei / volcano host
   - 去掉 `offscreen` 权限
6. 删除 `offscreen.html`、`offscreen.js`、`lib/wav-encode.js`
7. 测试
   - `测试/转写服务兼容性.test.js`：Fish multipart + 时间轴；OpenAI 改 base 后打到新 host；未知旧服务商回落 Groq
   - 删百炼 / 火山 / 讯飞转写断言
   - `测试/wav编码.test.js` 随编码器删除
   - `测试/批量翻译与分片逻辑.test.js` 去掉火山转码用例；Groq 模型用例保留
   - 跑切片器，确认未改容器格式

## Validate

```bash
node --test 测试/转写服务兼容性.test.js 测试/音频切片器.test.js 测试/批量翻译与分片逻辑.test.js
```

手工：设置 Fish Key → 测通 → 生成字幕；OpenAI 不改 URL 走官方；改成兼容网关后请求新地址；切到总结页确认服务商列表没变。

## Rollback

`providers.js` / `stt.js` / `options.*` / `manifest.json` / `background.js` 是主回滚面。Offscreen 文件若已删，从 git 取回。总结相关文件不应被这次改动碰到。
