# dsh-whale-coach

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的**旁听小助手**：它不替角色说话，只在旁边看着你们聊，时机合适时递一句话进去——「要不要开口？要不要配个表情？」——台词由角色自己写。

顺带把每轮聊天滚动记下来，上下文攒到阈值时提醒角色「该转生了」，避免新会话失忆。

> 只支持装了 DSH 的机器；代码改动需要重启 DSH 才生效（DSH 的插件模块会缓存）。

## 它做什么

```
每 5 轮（≥45 秒间隔）看一眼最近 12 条消息
        │
        ├─ 用最便宜的模型判断：现在适合提醒她做点什么吗？
        │     输出 {"提醒": true, "类型": "语音" | "表情" | "都", "理由": "…"}
        │
        ├─ 放行 → 往角色会话里塞一条【旁听】提示
        │     语音：让她发一条【语音】（走 dsh-qq-bridge 的语音条通道）
        │     表情：让她在回复末尾补一行 ![]( _stickers/xxx.png )
        │     台词她自己写，插件不代笔
        │
        ├─ 每轮把「主人说了什么 / 她回了什么」写进 whale-context-digest.md
        │     每 10 轮压成要点 → whale-context-brief.md
        │
        └─ 本会话累计字数到阈值 → 递一条【转生提示】
              让她自己跟主人说「老大，我好困」之类；不自动换会话
```

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
    rebirthChars: 280000   # 本会话累计多少字算「快满了」
    provider: ''           # 留空 = 自动挑最便宜的 flash
    model: ''
```

## 数据文件

| 文件 | 内容 |
| --- | --- |
| `~/.dsh/storages/whale-coach/state.json` | 轮次、字数、闸的时间戳 |
| `~/.dsh/storages/whale-coach/coach.log` | 每次判断/递话/被闸拦住的记录 |
| `~/.dsh/whale-context-digest.md` | 逐轮流水（每轮一行） |
| `~/.dsh/whale-context-brief.md` | 每 10 轮压缩出的阶段要点 |

调试接口：`GET /whale-coach/state`（返回配置、轮次、字数、最近闸状态）。

## 兼容性与踩过的坑

- 本插件监听的是 `ctx.on('session/event', ...)`。**不要**换成 `agent/turn-stopping`——在某些 DSH 版本里这个事件不触发，插件会静默空转（`rounds` 一直是 0）。
- 改完插件代码必须**重启 DSH** 才生效（插件模块在进程内缓存，热重载只认配置）。
- 判断时机依赖 `ctx.llm.listProviders()` 能列出可用 provider；拿不到时会退到会话自己的模型。

## 已知限制

- **拿不到精确的上下文占用**：DSH 没把 token 用量暴露给插件，所以「快满了」是按本会话累计字数估算的（约 1 字 ≈ 0.6 token）。想手动「转生」的话，直接跟角色说一声更准。
- 判断会消耗一次模型调用；默认每 5 轮 + 45 秒间隔已经压得比较低，嫌烦可以调大 `roundsPerJudge`。
- 只在有 agent 活动（`agent/turn-stopping`）时工作；会话没加载时它什么都不做。

## 隐私

所有数据都在本机 `~/.dsh` 下，不上传任何地方。插件读的是本机会话事件流，写的是本地 markdown。

## 许可

MIT
