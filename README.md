# dsh-whale-coach

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的**旁听小助手**：它不替角色说话，只在旁边看着你们聊，时机合适时递一句话进去——「要不要开口？要不要配个表情？」——台词由角色自己写。

它还有两个别的活儿：

- **滚动记 + 压摘要**：每轮聊天写进 `whale-context-digest.md`，每 10 轮压成要点，供新会话「记忆恢复」用
- **影子独白**：每 10 分钟让她自己冒一句"内心独白"（只记录、不进会话）；攒成想法时，判断层会递一条 `[自发]` 提示给她选修辞
- **无聊值 + 主动行动**（v0.9）：从独白里数「无聊/烦」的密度，满点就往 QQ 会话递一条 `[行动]` 提示，让她自己找点事做；另给角色挂了一个只读工具 `whale_look`，她自己随时能翻小本本/独白/无聊值

上下文用到阈值时，也会提醒角色「快满了，可以跟主人说一声」，避免新会话失忆。

> 只支持装了 DSH 的机器；代码改动需要重启 DSH 才生效（DSH 的插件模块会缓存）。

## 它做什么

```
【每轮】把「主人说了什么 / 她回了什么」写进 digest；把另一边的近况塞进系统提示
        │
【每 5 轮，≥45 秒】判断一次：现在适合提醒她做点什么吗？
        │   输出 {"提醒": …, "类型": "语音"|"表情"|"都", "理由": …,
        │         "有想法": true/false, "种子": "…"}
        │
        ├─ 放行 → 塞一条【旁听】提示（语音 / 表情，带独立冷却与小时上限）
        │     台词她自己写，插件不代笔
        │
        ├─ 有想法 → 塞一条 [自发] 提示：「你刚才自己在想：<种子>」（1 小时一次）
        │
        └─ 顺手记忆体检：小本本 <5 条就塞一份补课包

【每 10 分钟】影子独白：写一条 20~60 字的情绪碎片 → whale-thoughts.md（不进会话）
        │
【每 10 轮】把 digest 压成要点 → whale-context-brief.md

【上下文到阈值】递一条「满上下文」提醒（让她自己说，不自动换会话）
```

新会话（或重启）后第一轮，会把 `whale-context-brief.md` 的阶段摘要作为 `[记忆恢复]` 读回给她。

## 跨会话同步（私聊 ↔ 群）

如果两间会话绑的是同一条鲸（比如私聊 `bili-whale` + 群），插件会：

- 每轮在系统提示里追加「另一边刚才说的话」+「那边小本本最近 5 条」
- 检测到某间会话"记忆偏薄"（小本本 < 5 条），在判断窗口同步补一段"补课包"（小本本 + 日记 + 阶段摘要）
- 新会话首轮注入一次「记忆恢复」（摘要 + 日记，走 prompt 段落，不额外造轮次）

判定"薄"只看数量，不猜语义；真想让鲸记得牢，得靠她自己用 `remember` 记。

## 影子独白（v0.8）

每 10 分钟自己冒一条"内心独白"，写进 `~/.dsh/whale-thoughts.md`，**只记录，不注入会话**。

- 素材：当前时间 / 上下文占用 / 今天聊过的流水 / 小本本 / 当天的 B 站日报节选
- 形态由 `~/.dsh/whale-thinking.md`（思考卡）规定，仓库里的 `whale-thinking.sample.md` 是默认版
- 温度 0.95（判断那边仍是 0.2），生成失败 60 秒后重试
- 判断时会顺带看最近 3 条独白，攒成想法就递一条 `[自发]` 提示（1 小时最多一次）

⚠️ **这是"情绪碎片"，不是"思考记录"**。思考卡明确要求：越没逻辑越好，可以半句、可以自相矛盾、可以说一半就烦了；
不要总结、不要分析、不要给结论、不要列计划。它的用途是让角色有"自己的内在节奏"，而不是生成一份待办清单。

另一个前提写进了卡里：**她知道自己只是跑在电脑里的一段程序**，没有身体——钢盆、饭粒、走路、天气这些写出来就是硬套人设。

配置：`thoughtEnabled` / `thoughtEveryMin` / `thoughtMaxChars` / `ideaMinGapSec`。

## 无聊值 + 主动行动（v0.9）

独白是"情绪碎片"，所以可以从里面数无聊：

- 每条独白命中关键词（`无聊/烦/没劲/没意思/空/腻/闷`）→ 无聊值 +1（日志记 `无聊值 +1（N/10）`）
- 每小时自然衰减 `boredomDecayPerHour` 点
- 满 `boredomThreshold` 点且距上次行动超过 `boredomActionMinGapSec` → 从行动清单里挑一条，`followup` 进 QQ 会话
  （MVP 只上：找主人私聊 / 去群里冒泡 / 喊主人升级；每条都以 `[行动] 这不是主人说的。` 开头）
- 触发后无聊值**减半**（不清零）；每次行动写一行 `storages/whale-coach/boredom.jsonl`
  （`at` 本地 ISO / `boredom` 触发点数 / `action` 中文名 / `session` / `text` 她实际说的 / `result` ok|silent|fail:原因）
- 她回话后自动把 `text` 补进 jsonl；10 分钟没回结为 `silent`

测试开关（不用改代码、不用重启）：往 `storages/whale-coach/` 放
`boredom-threshold.txt`（写 `1` 就是阈值 1）或 `boredom-cooldown-sec.txt`（写 `60` 就是冷却 60 秒），删掉即恢复配置值。

## whale_look（v0.9）

给盯着的每间会话挂一个只读工具，角色想查就自己调：

- `what: notes` 小本本 / `thoughts` 最近独白 / `boredom` 无聊值 / `digest` 最近流水，`n` 条数（默认 10）
- 内容硬截断 800 字；只读，不提供写操作

## 跨频道互看

每轮组装 prompt 时（`system-prompt/assemble`），把"另一边最近 4 句 + 那边小本本最近 5 条"塞进系统提示（≤600 字），
并明确写"这不是同一个人说的，但你们是同一条鲸；别把它当成主人刚说的事"。

## 记忆体检

判断触发时顺手检查这间会话的小本本条数，<5 条就塞一份补课包（小本本 + 摘要 + 日记，≤1600 字），
跟判断同频——不是另设一套冷却。

## 两个闸（防刷屏）

| 类型 | 最小间隔 | 每小时上限 |
| --- | --- | --- |
| 语音 | 600 秒 | 3 次 |
| 表情 | 240 秒 | 6 次 |

外加：角色上一条已经是语音/表情就跳过；模型调用失败一律静默。

## 安装

```sh
dsh plugin --profile <你的 profile> add github:<你的账号>/dsh-whale-coach
```

或者手动：把本仓库放进插件目录，profile 的 `dependencies` 加 `"dsh-whale-coach": "link:<路径>"`，`bundles` 加 `"dsh-whale-coach"`，重启 DSH。

## 配置

写进 profile 的 `cordis.patch.yml`：

```yaml
- id: whale-coach
  name: 'dsh-whale-coach'
  config:
    enabled: true
    roundsPerJudge: 5      # 至少攒够几轮才判断一次
    minGapSec: 45          # 两次判断的最小间隔
    windowMessages: 12     # 判断时带多少条最近消息
    voiceMinGapSec: 600    # 两条语音提醒之间至少隔多久
    voiceMaxPerHour: 3
    stickerMinGapSec: 240
    stickerMaxPerHour: 6
    contextFullTokens: 800000  # 上下文 token 到多少算「快满了」（1M 窗口的 80%）
    boredomEnabled: true       # 无聊值计数器开关
    boredomThreshold: 10       # 满多少点触发一次行动
    boredomDecayPerHour: 1     # 每小时自然衰减几点
    boredomActionMinGapSec: 10800  # 两次行动最小间隔（秒）
    boredomKeywords: [无聊, 烦, 没劲, 没意思, 空, 腻, 闷]  # 独白命中就 +1
    sessionId: ''          # 只盯这间会话；留空 = 自动读 qq-bridge 绑定的会话
    provider: ''           # 留空 = 自动挑最便宜的 flash
    model: ''
```

## 数据文件

| 文件 | 内容 |
| --- | --- |
| `~/.dsh/storages/whale-coach/state.json` | 轮次、字数、token、闸的时间戳 |
| `~/.dsh/storages/whale-coach/coach.log` | 每次判断/递话/被闸拦住的记录 |
| `~/.dsh/storages/whale-coach/boredom.jsonl` | 每次无聊行动的记录（一行一次） |
| `~/.dsh/whale-context-digest.md` | 逐轮流水（每轮一行） |
| `~/.dsh/whale-context-brief.md` | 每 10 轮压缩出的阶段要点 |

调试接口：`GET /whale-coach/state`（配置、轮次、字数、token、正在盯哪些会话）；`GET /whale-coach/probe`（运行时服务自检）。

## 兼容性与踩过的坑

- 本插件用 **事件 + 12 秒轮询**双保险读消息。`agent/turn-stopping` 在某些 DSH 版本里不触发，不要依赖它。
- 改完插件代码必须**重启 DSH** 才生效（插件模块在进程内缓存，热重载只认配置）。
- 判断时机依赖 `ctx.llm.listProviders()` 能列出可用 provider；拿不到时会退到会话自己的模型。
- 上下文占用读的是 assistant 消息的 `usage.inputTokens + cacheReadTokens + cacheWriteTokens`（`inputTokens` 只是未命中缓存那部分）。

## 已知限制

- 上下文占用量是「最后一条回复当时的 prompt 大小」，是采样值、不是实时精确值；想手动「换会话」，直接跟角色说一声更准。
- 判断会消耗一次模型调用；默认每 5 轮 + 45 秒间隔已经压得比较低，嫌烦可以调大 `roundsPerJudge`。
- 只在会话加载时有活动；没绑 QQ 会话且没填 `sessionId` 时，它什么都不盯。

## 隐私

所有数据都在本机 `~/.dsh` 下，不上传任何地方。插件读的是本机会话事件流，写的是本地 markdown。

## 许可

MIT
