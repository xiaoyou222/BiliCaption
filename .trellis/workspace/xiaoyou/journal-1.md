# Journal - xiaoyou (Part 1)

> AI development session journal
> Started: 2026-08-20

---



## Session 1: 多通道优先级链 + ElevenLabs 双通道 + 设计稿对齐

**Date**: 2026-08-20
**Task**: 多通道优先级链 + ElevenLabs 双通道 + 设计稿对齐
**Branch**: `master`

### Summary

转写架构从主+单备用改为多通道优先级链（限流冷却顺延/致命停用/全冷却等待/自动切回）；新增 ElevenLabs 免Key演示+填Key官方双通道；设置页转写区按最新设计稿重做（拖拽排序卡片+虚线新增表单，测试通过才可添加）；清理备用/加速死代码并修复生成闸门只查首通道的 bug。

### Git Commits

| Hash | Message |
|------|---------|
| `2bbba63` | (see git log) |

### Status

[OK] **Completed**


## Session 2: 语义断句后台化，胶囊只显示翻译进度

**Date**: 2026-08-21
**Task**: 语义断句后台化，胶囊只显示翻译进度
**Branch**: `master`

### Summary

翻译按块先断句再立刻翻译该块，用户界面不再暴露断句阶段，胶囊只显示翻译句数。同提交去掉 ElevenLabs 免 Key 演示、通道卡片立刻保存，长拉丁句仍会进入翻译。

### Git Commits

| Hash | Message |
|------|---------|
| `b7668b7` | (see git log) |

### Status

[OK] **Completed**


## Session 3: 选区总结按内容结构选段落或列表

**Date**: 2026-08-27
**Task**: 选区总结按内容结构选段落或列表
**Branch**: `master`

### Summary

划选总结不再强制拆成 3-6 条要点：同一件事写成一段话，只有选区里确有并列要点时才用列表。

### Main Changes

- 改 buildSummaryPrompt：默认一段连贯中文，列表仅用于互不从属的并列要点，禁止拆成假要点。
- 补 测试/选区总结格式.test.js，并写入 outline-and-subtitles 的 selection summary format 约定。

### Git Commits

| Hash | Message |
|------|---------|
| `1d1d1d1` | (see git log) |

### Testing

- [OK] node --test 测试/选区总结格式.test.js 测试/大纲时间轴.test.js 测试/中英字幕切换.test.js（27 passed）

### Status

[OK] **Completed**

### Next Steps

- 在真实视频上划短选区和并列要点选区各总结一次，确认模型格式。
