# I'll Remember You

包名 `dsh-cat-ill-remember-you`。

记忆核心的 DSH 插件：把对话原文落进本地 SQLite，空闲时提炼成信息点，每轮开始前把「全局栈 + 常驻偏好 + 取回的记忆」拼进动态上下文。

设计原则与整体架构见仓库根 [README](../../README.md)。

## 现在有什么

- **M0 原文入库**：`session/event` 的 `user/message` / `assistant/message` 写进 `turns`；按 `(sid, seq, role)` 幂等；只取 text 块；运行时上下文、记忆提示、子代理委派、替换块等机器串挡在门外。
- **M1 规则提炼**：空闲 5 分钟后把未消费的 turns 分成「user + 其后 assistant」的块，按判断/偏好/事实三类提炼成 `memories`，抽锚点与实体。接模型时只换 `refine()` 内部，接口不变。
- **M2 三级取回**：L1 最近 3 条 / L2 锚点与实体 / L2.4 向量 / L2.5 弱匹配 / L3 turns 原文（按 cwd 只回看当前 workspace）。每轮注入 1–2 条、≤600 字，落 `recall_log`。
  - 向量：`lib/embed.js` 直接调本机 Ollama `/api/embed`（默认 `qwen3-embedding:0.6b`，1024 维），回填在 `embeddings` 表；检索只在锚点和实体都空时用，余弦 ≥0.55 取一条，连不上 60 秒冷却后退回词面。
  - 注入走宿主 `systemPrompt.context` 动态上下文，不塞 `decision.messages`——后者会被宿主 append 成 `user/message`，显示成用户气泡。
- **M3 影子账本**：白名单内每轮算「如果替换会删掉什么、补上什么」，落 `shadow_v2`；白名单外完全不记账（这些会话不会真替换，记账只会随宿主压缩无限涨）。
- **M4 遗忘**：每日一次，按取回/验证时间降 tier，只标不删，落 `forget_log`。保留期分三档：`permanent` 永不降级（偏好）、`ephemeral` 7 天没碰沉 dormant（情绪）、`auto` 走默认曲线（30/90 天）。
- **M5 全局上下文栈**：每说一句，把指针（`sid` / `seq` / `t`）压进 `context_stack`；容量 50 条。注入时取最近 20 条（最近 4 条原文，其余用出栈时写的本地摘要），再从剩下的条目里补最多 10 条本会话更早的，单列 `【本会话更早】`。字数硬顶 3000。所有会话都注入；白名单外的会话另有「只预览、不改历史」的标注。
  - 出栈只按**未出栈**的行数计数——表里留着历史指针，用总数算会把 active 全挤掉。
- **M6 替换**（白名单会话）：
  - `sid:full`：从第 3 条消息起，每次把「最近 2 条之外的全部旧历史」压成一条替换块，无冷却。
  - `sid`（roll）：每次只动最早 `STEP=4` 条，最近 `KEEP_TAIL=6` 条永远是原文，冷却 60 秒。
  - 替换块头部标 `[上下文替换｜旧消息压缩，非用户发言]`，每条原消息标「用户/助手」；事件载体只能是 `user/message`（宿主禁 `assistant/message` 带 `sourceEventSeqs`，官方 compaction 也这么做）。替换块不进 `surfaceMessages`，下一次替换永远从原文重算。

替换的区间按**位置**取（`surface.nodes.indexOf(startSeq)` 到 `indexOf(endSeq)`），不能按 seq 值过滤：早先替换块的 seq 比它所在的位置大，会夹在后续区间中间；值过滤会漏掉它，宿主按位置算 `shadowedSeqs`，直接报 `missing`。同一区间只记一次账，但上次 `applied=0`（append 失败）时允许下一轮重试。

## 数据

默认 `~/.dsh/memory/core.db`，`DSH_MEMORY_CORE_DB` 可覆盖。表：`turns` / `memories` / `entities` / `embeddings` / `runs` / `recall_log` / `shadow_log` / `forget_log` / `shadow_v2` / `context_stack` / `persona`。

## 装进 profile

依赖与 `dsh.profile.bundles` 里加 `dsh-cat-ill-remember-you`（link 到本目录），`pnpm install`，重启 dsh。

## 跑测试

```bash
node --test test/
```

124 条；单元测试用内存库，pre-step 集成测试用临时文件库（跑完删除），都不碰真实数据。

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `DSH_MEMORY_CORE_DB` | `~/.dsh/memory/core.db` | 数据库路径 |
| `DSH_MEMORY_CORE_IDLE_MS` | `300000` | 空闲多久后开始提炼 |
| `DSH_MEMORY_CORE_TICK_MS` | `60000` | 空闲检查间隔 |
| `DSH_MEMORY_CORE_EMBED_MODEL` | `qwen3-embedding:0.6b` | 向量模型 |
| `DSH_MEMORY_CORE_OLLAMA` | `http://127.0.0.1:11434` | Ollama 地址 |
| `DSH_MEMORY_CORE_EMBED_BATCH` | `16` | 每批补多少条向量 |
| `DSH_MEMORY_CORE_VECTOR` | `on` | 设 `off` 关掉向量召回（测试用） |
| `DSH_MEMORY_CORE_PERSONA` | `off` | 设 `on` 才注入常驻层（避免和仍在跑的 mnemon 双份） |
| `DSH_MEMORY_CORE_PERSONA_USER` | `4096` | 常驻层 user 区字数上限 |
| `DSH_MEMORY_CORE_PERSONA_MEMORY` | `8192` | 常驻层 memory 区字数上限 |
| `DSH_MEMORY_CORE_KEEP` | `10` | 旧模式保留多少条原文（roll 模式按 `KEEP_TAIL` 固定 6） |
| `DSH_MEMORY_CORE_SHADOW_WINDOW` | `40` | 旧模式每次被换窗口最多取多少条 |
| `DSH_MEMORY_CORE_ROLL` | `1` | roll 模式；`0` 退回按比例一次换一段 |

真替换的开关不是环境变量，是白名单文件 `~/.dsh/cache/replace-sessions.txt`：每行一个 session id，`sid:full` 表示完全替换，`*` 表示全部；文件不存在或名单为空 = 全关。`tools/allow-session.mjs` 可以列最近会话、把某个 sid 写进名单。

## 已知缺口

- 替换块在 UI 上仍占「用户消息」的位置——宿主事件类型层只允许 `user/message` 带 `sourceEventSeqs`，改不了；内容层已标「非用户发言」。
- 替换文本仍是规则压缩（关键词 + 截断），结论容易被砍；提炼质量一般，接模型只改 `refine()` 内部。
- 主会话还没开真替换；几千字的大窗口路径也还没实跑。
- `persona` 已导入 mnemon 的 39 条常驻，但默认不注入；提炼层还没做「从对话里长出偏好/判断」。
