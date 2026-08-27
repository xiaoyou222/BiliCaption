# Design

## Boundaries

| 层 | 职责 |
|---|---|
| `lib/outline.js` | 时长布局、两套提示词、嵌套解析/定稿、小节行号夹紧、复制/MD |
| `sidepanel.html` / `sidepanel.css` / `sidepanel.js` | 「N 段 · M 小节」、简略/详情、章▾、小节列表、高亮与跳转 |
| 测试 | `测试/大纲时间轴.test.js` 扩；不改字幕列表测试的契约 |

不新增 lib。`background.js`、选区总结、STT、WebDAV 不改契约。

## Layout from duration

`outlineLayout(cues)` 用 `videoSpan(cues).span`（秒）：

| 时长 | mode | 章 | 小节 |
|---|---|---|---|
| &lt; 20 min | `flat` | 3–6 | 无 |
| 20–45 min | `nested` | 3–6，章大约 5–15 min | 每章 2–4 |
| 45 min–2 h | `nested` | 4–8，章大约 15–30 min | 每章 3–5 |
| ≥ 2 h | `nested` | 6–12，章大约 15–30 min | 每章 3–5 |

提示词写「跟着主题切，不要按固定时钟切」，把上表的数字填进去。本地不算 30 分钟网格。

## Data flow

```
cues
  → outlineLayout
  → buildOutlinePrompt 或（超预算）map-reduce summary + buildChaptersPrompt
  → runModel 流式
  → parseStreamingOutline（章可先于小节出现）
  → finalizeOutline（章 + 小节对秒、夹紧）
  → storage.local[outline:v2:bvid:cid] = { summary, chapters }
  → 侧栏：无 subs 则扁平；有 subs 则密度条 + 树
```

## JSON contract

扁平（短视频）：与现在相同。

```json
{
  "summary": "……",
  "chapters": [
    { "title": "环境搭建", "synopsis": "……", "from": 1, "to": 12 }
  ]
}
```

两级（长视频），字段顺序 `summary`、`chapters`；每章在 `to` 之后接 `subs`：

```json
{
  "summary": "……",
  "chapters": [
    {
      "title": "字段与点云分布",
      "synopsis": "字段是逐元素求值……",
      "from": 13,
      "to": 40,
      "subs": [
        { "title": "字段不是单个数值", "from": 13, "to": 20 },
        { "title": "Distribute Points 生成点云", "from": 21, "to": 32 },
        { "title": "Seed 固定随机", "from": 33, "to": 40 }
      ]
    }
  ]
}
```

- 章、小节的 `from`/`to` 都是字幕行号。秒数只在 `finalizeOutline` 写 `start`/`end`。
- 小节只要 `title` + 行号，不要 synopsis。
- 落盘：`summary` 非空且至少一章。`subs` 缺、空、坏都不阻止落盘。
- 读：旧数组、无 `subs` 的章 → 当扁平。

内存中的章：

```
{ start, end, title, synopsis, subs?: [{ start, end, title }] }
```

## Finalize

在现有章修复之后处理 `subs`：

1. 先把相邻章对齐到唯一边界：`current.start = previous.end`。Bilibili 相邻 cue 可能有小数秒重叠，不能让两个章同时命中。
2. 每条 sub 用同一套 `resolveChapterTimes`（行号优先）。
3. `start`/`end` 夹进所属章的 `[start, end]`。
4. 按 `start` 排序；后一条的 start 不得早于前一条 end（必要时对齐）。
5. 丢掉 title 为空且时长 &lt; 1 秒的空壳。
6. `outlineLooksTiny` 均分章时，章内小节按条数在该章 cues 上再均分，避免小节全挤在片头。

## Streaming parse

`parseStreamingChapters` 不能再用 `/\{[^{}]*\}/`。对 `chapters` 数组体用已有 `sliceBalanced` 取出顶层对象：

- 完整对象 `JSON.parse` → `normalizeChapter`（保留已解析的 subs）。
- 末尾半截：有 title/synopsis 就可预览该章；`subs` 用同样的括号配对尽量收已完整的小节。

`parseStreamingOutline` 仍先 `summary` 再 `chapters`。

## UI

在 `videoSummary` 和 `outlineList` 之间加一条 meta 行（仅 `hasSubs`）：

- 左：`4 段 · 12 小节`（无小节时整行不画，包括切换）。
- 右：简略 / 详情，样式跟设计稿分段（未选 `#8A9099` 透明底，选中抬起 `#24272D` + `#E7E9ED`）。

状态：

- `outlineDensity`: `'brief' | 'detail'`，默认 `'brief'`。点分段则把所有有小节的章设成全关或全开。
- `chOpen: { [index]: boolean }` 单章 ▾。手动开合后，分段的选中态按「全关 = 简略、全开 = 详情」，部分开则两键都不是选中。
- 两者都不进 `outline:v2` 缓存。换视频或重新生成回到简略。

章 DOM 从单行 `.chapter` 改成包一层：

- `.chapter` 仍可点 seek 到章 `start`。
- 「N 节」徽章在折叠时显示，展开隐藏。
- ▾ `stopPropagation`，只改 `chOpen`。
- `.chapter-subs` 仅 `chOpen[i]` 时存在；子行 seek 到 sub.start。

高亮：`activeOutlinePosition` 是唯一时间判定入口。它按开始时间选择最后一个已到达的章/小节，并给 `HTMLMediaElement` seek 落点保留 50ms 媒体帧误差；不能用区间 `findIndex`，否则重叠边界会先选中上一章。`renderOutline` 和 `renderOutlineActive` 共用该结果，滚动目标是高亮行。

## Copy / Markdown

有 `subs` 时：

```
00:48–01:37 字段与点云分布
字段是逐元素求值……
  00:48 字段不是单个数值
  01:02 Distribute Points 生成点云
```

Markdown 用章 `##`、小节 `- 00:48 标题`。无 subs 保持现在的两行章格式。

## Compatibility

| 输入 | 行为 |
|---|---|
| 旧数组 / 无 subs 的对象 | 扁平章，无密度条 |
| 新对象带空 `subs` | 同扁平 |
| 新对象带有效 `subs` | 密度条 + 树 |
| 短视频新生成 | 提示词不要求 subs，即使模型多写也显示（有则用，无则藏切换） |

短视频提示词明确「不要小节」。若模型仍返回 `subs`，UI 可以显示（不强制删），但验收以「短视频不出现切换」为准：短视频 finalize 时丢掉 `subs`，避免 12 分钟片子出现无意义的两级。

## Risks

- 嵌套流式解析写错会让长视频大纲空白或章被切碎。用括号配对，并保留扁平对象的旧用例。
- 一次要出很多小节可能顶到模型输出上限。第一版不拆第二趟；若经常截断，章仍在、小节不齐，切换仍可用已有小节。不在本轮做逐章补全。
- `renderOutline` 现在按 `children[i] === outline[i]` 复用节点，改成包装层后要一起改，避免流式时抖。
