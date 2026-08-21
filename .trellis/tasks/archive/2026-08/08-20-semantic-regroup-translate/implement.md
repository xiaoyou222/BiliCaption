# Implement

## Checklist

1. `lib/providers.js`
   - `SUM_PROVIDERS = ["OpenAI", "Gemini", "DeepSeek", "自定义"]`
   - 加 Gemini URL / 默认模型 / Key 提示 / MODEL_HINTS
   - 删统一网关、智谱、Kimi、通义、OpenRouter 的具名项（旧 URL 表留给迁移）
   - `migrateSum` + `resolveSum` 默认 OpenAI；加载后可写回
   - `xy-backup` 不再改写成 xy-smart
2. `lib/模型路由.js` / `background.js` 翻译
   - 去掉 `xy-*` 主备切换；翻译只打当前模型
   - `runTranslateJob`：按块断句后立刻翻译该块
   - 对外只广播 `run` 和已译句数；job 持久化 `regrouped`
3. `lib/translate.js`
   - 解析 `MERGE`/`KEEP`
   - 本地应用合并（含中文边界、越界、冲突回落）
   - 导出给测试和 background
4. `options.html` / `options.js`
   - 默认 OpenAI；接口地址只在自定义时出现
   - 去掉 xy-smart/xy-fast/xy-backup 文案
   - 加载时跑迁移并保存
5. `sidepanel.js` / `sidepanel.html`
   - 胶囊只显示「翻译中」和句数，不展示断句
   - 默认 loadSettings 从统一网关改为 OpenAI
6. `manifest.json`
   - 加 `https://generativelanguage.googleapis.com/*`
7. 测试
   - `测试/转写服务兼容性.test.js`：新 SUM 名单、Gemini base、旧服务商迁移
   - `测试/批量翻译与分片逻辑.test.js`：去掉 xy-backup 用例；加断句解析/合并/失败回落；默认不再是统一网关

## Validate

```bash
node --test 测试/转写服务兼容性.test.js 测试/批量翻译与分片逻辑.test.js
```

手工：设置页只见四家；选 Gemini 测通聊天；旧统一网关有 URL 的落到自定义；点「翻译成中文」先断句再翻译；取消后已合并行还在；屏幕上没有超长一段字幕。

## Rollback

`providers.js`、`translate.js`、`模型路由.js`、`background.js` 翻译段、`options.*`、`sidepanel.js`、`manifest.json`。不要回滚 STT 相关改动。
