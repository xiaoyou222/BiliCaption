# Implement

## Checklist

1. `lib/outline.js`
   - 导出 `BRIEF_MAX_SECONDS = 20 * 60`、`outlineLayout(cues)`。
   - `buildOutlinePrompt` / `buildChaptersPrompt` 按 layout 分支：flat 不提 subs；nested 要 `subs` 数组和目标粒度。
   - `normalizeChapter` 保留并规范化 `subs`。
   - `finalizeOutline`：短视频丢掉 subs；长视频夹紧小节时间；tiny 均分时小节跟章走。
   - `parseStreamingChapters` 改 `sliceBalanced` 扫顶层章对象。
   - `formatOutlineCopy` / `formatOutlineMarkdown` 输出小节。
2. `sidepanel.html` / `sidepanel.css`
   - 总结块和列表之间：`outlineMeta`（段数、密度分段）。默认 hidden。
   - 章/小节/徽章/▾/缩进竖线按设计稿，按钮尺度 sm。
3. `sidepanel.js`
   - `outlineDensity`、`chOpen`；换视频/重新生成复位为 brief。
   - `renderOutline` 画树；`renderOutlineActive` 展开时高亮小节。
   - `renderOutline` / `renderOutlineActive` 共用 `activeOutlinePosition`；边界取最后开始项，并容忍播放器落在目标前 50ms。
   - 有 `subs` 才 `show(outlineMeta)`。
   - 生成/缓存路径继续 `finalizeOutline`；缺小节不当失败。
4. 测试 `测试/大纲时间轴.test.js`
   - layout：19:59 flat、20:00 nested。
   - nested 提示词含 `subs`、主题切、禁止固定时钟；flat 提示词不含小节要求。
   - 解析带 nested `subs` 的完整 JSON 与流式半截。
   - 小节行号超出章范围时被夹紧。
   - 相邻字幕 cue 有小数秒重叠时，前后章仍对齐到唯一边界。
   - 播放器落点比 `80:21` 目标早一个媒体帧时，仍高亮后一章的首个小节。
   - 短视频 finalize 丢掉模型多写的 subs。
   - 旧缓存无 subs 仍能 parse。
   - 复制/MD 含缩进小节；无小节格式不变。
   - 现有行号、末章修复、tiny 均分、summary 前缀用例仍过。
5. 回归：`node --test 测试/*.test.js`。

## Validate

```bash
node --test 测试/大纲时间轴.test.js
node --test 测试/*.test.js
```

手工（实现后、有浏览器再验）：

- 短片（&lt; 20 min）：无简略/详情，3–6 章。
- 长片：默认简略；详情展开小节；单章 ▾；点小节会 seek；展开时高亮在小节。
- 旧大纲缓存：能看，无密度条；重新生成后长片出现小节。
- 复制/MD、全片总结折叠、停止生成、清缓存。

## Risky files

- `lib/outline.js` `parseStreamingChapters`：改坏则所有大纲流式预览空或乱。
- `sidepanel.js` `renderOutline`：节点复用和 `.chapter` 选择器被高亮/滚动依赖。
- 不要改 `background.js` 字幕列表、`lib/stt.js`、选区总结提示词。

## Rollback

还原 `lib/outline.js`、`sidepanel.html`、`sidepanel.css`、`sidepanel.js`、大纲测试。已写入的带 `subs` 的缓存，旧版本会忽略多余字段，章和 summary 仍能显示。
