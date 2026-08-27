# Implement

## Checklist

1. `lib/outline.js`
   - 扩展 `buildOutlinePrompt`：要求单个 JSON 对象，字段顺序 `summary` 然后 `chapters`；summary 80–150 字一段话；chapters 行号规则保持。
   - `normalizeOutlineRecord` / `parseOutlinePayload`：对象或旧数组 → `{ summary, chapters }`。
   - `finalizeOutline` 仍只处理 chapters。
   - 导出 `SUMMARY_CUE_CHAR_BUDGET = 100000`、`chunkCueLines`、`buildSummaryMapPrompt` / `buildSummaryReducePrompt`（测试用；sidepanel 调用）。
   - 导出 `formatOutlineCopy` / `formatOutlineMarkdown(title, summary, chapters)`，有总结时放最前。
2. `sidepanel.html` / `sidepanel.css`
   - 在 `outlineHead` 与 `outlineList` 之间插入全片总结折叠区。
   - 样式对齐设计稿：11.5px / 1.7 / `#C7CBD1`，chevron 旋转，底部分隔线。
   - 空态预留失败说明节点（或复用 `emptyKeyHint` 旁的 note），`fetch_failed` 用 link-btn 重试。
3. `sidepanel.js`
   - `videoSummary` 状态；`loadOutlineCache` 读新对象和旧数组。
   - `generateOutline`：低于预算一次 `runModel`；超过则 map-reduce 总结再章节。流式解析 summary + chapters。成功才 `storage.set` 新对象。
   - 停止同时 abort。复制 / MD 走新 format 函数。
   - 按 `subtitleStatus` 切换空态文案（`none` / `fetch_failed`）；登录和网络页不改。
4. `background.js`
   - `fetchDmView(aid, cid)`；`loadSubtitles` 在 player 轨为空时调用。
   - 最终无轨时写入 `subtitleStatus`：`none` | `fetch_failed`（登录/网络仍走现有 `error`）。
   - player 或 dm/view 抛错不要让整个 `LOAD_SUBTITLES` 在「已登录、可生成」场景未分类地炸掉。
5. 测试
   - `测试/大纲时间轴.test.js`：行号对时、过短均分、提示词含 summary 且仍要求行号；解析对象/旧数组；分段函数；复制/MD 前缀。
   - 新增 `测试/字幕列表获取.test.js`：player 空 + dm/view 有 `ai-zh` → 用 dm 轨；两处空 → `none`；两处失败且已登录 → `fetch_failed`；未登录不打成 `none`。
6. 回归
   - `测试/批量翻译与分片逻辑.test.js`、`测试/转写服务兼容性.test.js` 不改逻辑，跑一遍确认没误伤。

## Validate

```bash
node --test 测试/大纲时间轴.test.js 测试/字幕列表获取.test.js
node --test 测试/批量翻译与分片逻辑.test.js 测试/转写服务兼容性.test.js 测试/音频切片器.test.js
```

手工（有浏览器再验，本轮规划不替代）：

- 有 AI 字幕的视频：侧栏直接出官方字幕；大纲生成出现总结 + 章节；折叠；复制/MD；清缓存后需重生成。
- player 列表为空但 dm/view 有轨的片（若能复现）：不再显示「没有字幕」。
- 未登录 / 断网：错误页与现在一致。
- 选区总结、转写、标记、设置页总结服务商：无回归。

## Risky files

- `background.js` `loadSubtitles` / `fetchPlayer`：改坏会导致所有视频无字幕。
- `sidepanel.js` 大纲缓存形状：旧数组必须仍能显示章节。
- 不要改 `lib/stt.js`、`lib/providers.js` 转写名单。

## Rollback

还原上述文件。用户侧最坏情况：新缓存对象被旧版本忽略，点一次「生成大纲」即可。
