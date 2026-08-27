# Design

## Boundaries

| 层 | 职责 |
|---|---|
| `lib/outline.js` | 提示词、`{ summary, chapters }` 解析/定稿、旧缓存归一化、超长总结分段、复制/MD 文本 |
| `sidepanel.html` / `sidepanel.css` / `sidepanel.js` | 全片总结折叠区、流式绘制、空态、生成/停止/缓存读写 |
| `background.js` | `dm/view` 兜底、字幕轨合并、`loadSubtitles` 失败分类 |
| 测试 | `测试/大纲时间轴.test.js` 扩；新增 `测试/字幕列表获取.test.js`（vm 加载 background，与 `测试/批量翻译与分片逻辑.test.js` 同模式） |

不新增第三个 lib。选区总结、STT、WebDAV 不改契约。

## Data flow

```
字幕 cues
  → buildOutlinePrompt（summary + chapters JSON）
  → runModel 流式
  → parseStreamingOutline → 侧栏
  → chrome.storage.local[outline:v2:bvid:cid] = { summary, chapters }

字幕列表
  → fetchPlayer (wbi v2 → player/v2)
  → tracks 过滤 url 后若空 → fetchDmView(aid, cid)
  → pickDefaultTrack → fetchCues
  → 若仍空：按 login / 网络 / 双空 / 双失败 分类空态
```

## Outline JSON contract

模型必须只输出一个对象，字段顺序固定，便于流式：

```json
{
  "summary": "从空场景搭建 Geometry Nodes……接到属性和材质上。",
  "chapters": [
    { "title": "环境搭建", "synopsis": "……", "from": 1, "to": 12 }
  ]
}
```

- `summary`：一句或两句，约 80–150 个中文字，禁止 Markdown 标题、列表、时间码。
- `chapters`：3–8 项；`from`/`to` 仍是字幕行号（从 1 计）。`finalizeOutline` 对秒，逻辑不变。
- 提示词在 `buildOutlinePrompt` 上扩展，不要另开第二个「只生成总结」的默认路径。

流式解析：先取 `"summary"` 字符串（可半截），再对 `chapters` 数组复用现有 `parseStreamingChapters` 的对象扫描。`parseOutlineJson` 同时接受：

1. 新对象 `{ summary, chapters }`
2. 旧数组（当 `summary=""` 的 chapters）

校验：至少要有非空 `summary` 或一章；最终成功落盘必须两者都有（章节 `finalizeOutline` 后 length>0 且 summary trim 非空）。生成中允许只先画出其中一样。

## Cache

键仍是 `outline:v2:{bvid}:{cid}`。

| 读到的值 | 内存 |
|---|---|
| `{ summary, chapters }` | `videoSummary` + `outline`（chapters） |
| 数组 | `outline` = 该数组，`videoSummary` = `""`，隐藏总结块 |
| 空 | 两者皆空 |

侧栏继续用 `outline` 当章节数组，另加 `videoSummary` 字符串，避免改 `renderOutline` 的数据形状。写入一律新对象。`clearVideoCache` 已删该键，不用改键名。

折叠开合只在本次侧栏会话，不入缓存；每次有总结时默认展开。

## Long subtitle map-reduce

预算：`formatCueLine` 拼出的字幕正文（不含 system/user 外壳）`> 100000` 字符才走两阶段。不用 tiktoken。

1. 按行切块，每块目标约 20000 字符，单行超长才硬切。
2. 每块：三四句概括，不要时间码、不要标题。
3. 把各块要点收成一条 80–150 字 `summary`。
4. 再用**现有章节提示词**对全文 cues 要 chapters（输入与今天大纲相同）。

两阶段不把 summary 和 chapters 混在第二次 JSON 里。列表布局仍等第一章出现（与设计稿 `hasChapters` 一致）；若章节失败，整次失败，summary 不落盘。

常见视频（低于预算）只打一次带 `summary`+`chapters` 的请求。

## UI

插在 `outlineHead` 和 `outlineList` 之间：

- `#videoSummary`：有 `videoSummary` 或流式总结文本时显示（且当前在大纲 Tab、已离开空态球）。
- 第一行「全片总结」+ chevron，点击折叠。
- 正文 11.5px / 1.7 行高 / `#C7CBD1`，流式末尾可加 `▍`。
- 生成中顶栏文案保持「正在生成大纲 · 第 n 段」；不要给总结块加 BorderBeam。

空态分类只改 `#emptyView` 标题和 `#emptyKeyHint` 旁的说明，不改错误页（未登录 / 网络）。

`fetch_failed`：标题「没拿到字幕列表」；说明「可重试，或直接生成字幕」；主按钮仍 `#btnGenerateEmpty`；说明里放与「打开设置」同款 `link-btn` 触发 `refresh(true)`。

## Subtitle fetch

`fetchPlayer` 保持 wbi → 非 wbi。轨映射保持 `lan` / `lanDoc` / `url` / `aiType` / `aiStatus`，`url` 空的丢掉。

仅当过滤后 `tracks.length === 0` 且已有 `aid`、`cid` 时：

```
GET https://api.bilibili.com/x/v2/dm/view?type=1&oid={cid}&pid={aid}
credentials: include
Referer: https://www.bilibili.com/
Accept: application/json
```

解析 `data.subtitle.subtitles`（或同等路径），归一化后若有轨则用之。`dm/view` 抛错或空列表：记下 `dmViewError`，不覆盖 player 已有错误类型。

`loadSubtitles` 在「无 preferred 轨、无 ASR 缓存」时返回：

| 条件 | `error` / 空态 | `subtitleStatus` |
|---|---|---|
| 登录接口网络失败 | 现有「无法确认登录状态」 | `network`（侧栏已有） |
| 未登录 | 现有未登录页 | `login`（侧栏已有） |
| 两接口都拿到空列表 | 不设 `error`，`notice` 可留 | `none` |
| 至少一次请求失败且最终无轨 | 不设登录类 `error` | `fetch_failed` |

`canGenerate` 在视频页仍为 true。不在 Cookie 失败时自动 ASR。

番剧走同一 `aid`/`cid`。优先轨规则不改。

## Compatibility

- 旧大纲缓存数组可读。
- ASR 缓存在 `loadSubtitles` 里仍优先于官方字幕，行为不变。
- 总结服务商、选区总结 prompt、翻译、标记、WebDAV 不同步大纲。

## Risks

- `dm/view` 偶发风控：只在 player 为空时打，失败降为 `fetch_failed` 或 `none`，不让整页 LOAD 抛死。
- 模型不按字段顺序输出：最终 `parseOutlineJson` 用括号匹配，不依赖流式顺序；流式预览可能晚一截。
- 超长两阶段耗时：沿用 `requestPromptModel` 90s 超时；每段 map 也走同一超时。不在本轮加队列。

## Rollback

回滚 `lib/outline.js`、`sidepanel.*`、`background.js` 里 `loadSubtitles`/`fetchPlayer` 附近即可。缓存新对象旧代码会当非数组丢掉大纲，用户点一次生成即可；不写迁移回数组的脚本。
