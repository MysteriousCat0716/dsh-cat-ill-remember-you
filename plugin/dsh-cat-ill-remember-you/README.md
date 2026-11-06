# I'll Remember You

包名 `dsh-cat-ill-remember-you`，当前版本 0.8.43。

记忆核心的 DSH 插件：把对话原文落进本地 SQLite，空闲时提炼成信息点，每轮开始前把「全局栈 + 常驻偏好 + 取回的记忆」拼进动态上下文。

设计原则与整体架构见仓库根 [README](../../README.md)。

## 现在有什么

- **M0 原文入库**：`session/event` 的 `user/message` / `assistant/message` 写进 `turns`；按 `(sid, seq, role)` 幂等；只取 text 块；运行时上下文、记忆提示、子代理委派、替换块等机器串挡在门外。
- **M1 规则提炼**：空闲 5 分钟后把未消费的 turns 分成「user + 其后 assistant」的块，按判断/偏好/事实三类提炼成 `memories`，抽锚点与实体。表态句（`JUDGE` 命中）走即时通道：用户那句话落库后，等这一轮的 assistant 落完、静默 30 秒再炼，多步回复不会在第一步就炼出孤儿块；只收 `decision` / `preference`，其余交回空闲批。接模型时只换 `refine()` 内部，接口不变。
- **M2 三级取回**：L1 最近 3 条 / L2 锚点与实体 / L2.4 向量 / L2.5 弱匹配 / L3 turns 原文（按 cwd 只回看当前 workspace）。每轮注入 1–2 条、≤600 字，落 `recall_log`。
  - 同分区按 `anchors × 2 + entities` 打分，不再按时间取最新；L2 候选池 24 条。
  - 「这一轮已经给过」按 `recall_log.memory_id` 抑制，不按词面重合——否则越在聊越不召回。
  - L3 只要句子带指代就回看最近原文；只有指代、抽不出名词时也翻（「你还记得上次那件事吗」）。
  - 向量：`lib/embed.js` 直接调本机 Ollama `/api/embed`（默认 `qwen3-embedding:0.6b`，1024 维），回填在 `embeddings` 表；锚点/实体没补满两条就跑一次，余弦 ≥0.55 补一条，连不上 60 秒冷却。
  - 注入走宿主 `systemPrompt.context` 动态上下文，不塞 `decision.messages`——后者会被宿主 append 成 `user/message`，显示成用户气泡。
- **M3 影子账本**：黑名单外每轮算「如果替换会删掉什么、补上什么」，落 `shadow_v2`；黑名单里的会话完全不记账（这些会话不会真替换，记账只会随宿主压缩无限涨）。
- **M4 遗忘**：每日一次，按取回/验证时间降 tier，只标不删，落 `forget_log`。保留期分三档：`permanent` 永不降级（偏好）、`ephemeral` 7 天没碰沉 dormant（情绪）、`auto` 走默认曲线（30/90 天）。
- **M5 短期栈**：每说一句，把指针（`sid` / `seq` / `t`）压进 `context_stack`。存储上每个会话留最近 40 条 active、全局 400 条兜底——容量是存储问题，本会话再长也不挤掉别的会话。注入时按会话新→旧分配字数预算（900 / 700 / 550 / 450 / 350 / 250），本会话再切 600 字；从每个会话的尾部往回装**整轮**，一轮要么全进要么全不进；最近 2 轮用原文，更早的用出栈摘要；总硬顶 3000 字。注入按时间正序，时间戳用本机时区。所有会话都注入；黑名单里的会话另有「只预览、不改历史」的标注。
  - 出栈只按**未出栈**的行数计数——表里留着历史指针，用总数算会把 active 全挤掉。
  - 侧栏「记忆」页签里有栈面板：列出每个会话最新入栈的指针（会话名 + 会话号），滑条调「多少条进入全局注入」（30–50），勾选可删行，删掉的行只不进注入，`turns` 里的原文一个字不动。面板只读写 `~/.dsh/cache/stack-limit.txt` 与 `stack-exclude.txt`，改完立刻生效。
- **M6 替换**（黑名单之外）：
  - `sid:full`：从第 3 条消息起，每次把「最近 2 条之外的全部旧历史」压成一条替换块，无冷却。
  - `sid`（roll）：每次只动最早 `STEP=4` 条，最近 `KEEP_TAIL=6` 条永远是原文，冷却 60 秒。
  - 替换块头部标 `[上下文替换｜旧消息压缩，非用户发言]`，每条原消息标「用户/助手」；事件载体只能是 `user/message`（宿主禁 `assistant/message` 带 `sourceEventSeqs`，官方 compaction 也这么做）。替换块不进 `surfaceMessages`，下一次替换永远从原文重算。
  - 预算 3000 字（`DSH_MEMORY_CORE_REPLACE_CHARS`）；按句权重挑选，助手行进块，中段优先理由句，最近 6 条保底。
  - 工具结果只留一行摘要（80 字）；大结果给取回凭据——`refId` 交给 `ops_result`、spill 路径交给 `read`，小结果直接摘录。

替换的区间按**位置**取（`surface.nodes.indexOf(startSeq)` 到 `indexOf(endSeq)`），不能按 seq 值过滤：早先替换块的 seq 比它所在的位置大，会夹在后续区间中间；值过滤会漏掉它，宿主按位置算 `shadowedSeqs`，直接报 `missing`。同一区间只记一次账，但上次 `applied=0`（append 失败）时允许下一轮重试。

## 替换的开关

真替换的开关不是环境变量，是两个文件：

- `~/.dsh/cache/replace-blacklist.txt`，每行一个 session id；命中即 off。
- `~/.dsh/cache/replace-mode.txt`，值为 `on` 时，黑名单之外的会话按 full 替换。

**黑名单之外 = 会替换**（旧称「白名单」；旧文件 `replace-sessions.txt` 已删，备份在 `_backups/replace-sessions-20261105.txt`）。两个文件都按 `mtime + size` 缓存，改完立刻生效，不用重启。`tools/replay-extract.mjs` 是提炼决策的回放（`--rules r0|r1`），只读库、不写库。

## 数据

默认 `~/.dsh/memory/core.db`，`DSH_MEMORY_CORE_DB` 可覆盖。表：`turns` / `memories` / `entities` / `embeddings` / `runs` / `recall_log` / `shadow_log` / `forget_log` / `shadow_v2` / `context_stack` / `persona`。

## 装进 profile

依赖与 `dsh.profile.bundles` 里加 `dsh-cat-ill-remember-you`（link 到本目录），`pnpm install`，重启 dsh。侧栏出现「记忆」页签；面板里的「只推演」按钮会生成一份「若现在开替换，这一轮模型会收到的完整上下文」，不写历史、不记账。

## 跑测试

```bash
for f in test/*.test.js; do node "$f"; done
```

211 条；单元测试用内存库，pre-step 集成测试用临时文件库（跑完删除），都不碰真实数据。`node --test test/` 在部分 Windows 沙箱里会给每个文件起子进程、报 `spawn EPERM`，所以逐文件跑。

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
| `DSH_MEMORY_CORE_STACK` | `on` | 短期栈（A1 接续层）开关 |
| `DSH_MEMORY_CORE_PEOPLE` | `on` | 人物层（A3）开关 |
| `DSH_MEMORY_CORE_ENRICH` | `on` | 后台整理（提炼 / 向量 / 遗忘）开关 |
| `DSH_MEMORY_CORE_PERSONA` | `off` | 设 `on` 才注入常驻层（避免和仍在跑的 mnemon 双份） |
| `DSH_MEMORY_CORE_PERSONA_USER` | `4096` | 常驻层 user 区字数上限 |
| `DSH_MEMORY_CORE_PERSONA_MEMORY` | `8192` | 常驻层 memory 区字数上限 |
| `DSH_MEMORY_CORE_REPLACE_CHARS` | `3000` | 替换块字数上限 |
| `DSH_MEMORY_CORE_KEEP` | `10` | 旧模式保留多少条原文（roll 模式按 `KEEP_TAIL` 固定 6） |
| `DSH_MEMORY_CORE_SHADOW_WINDOW` | `40` | 旧模式每次被换窗口最多取多少条 |
| `DSH_MEMORY_CORE_ROLL` | `1` | roll 模式；`0` 退回按比例一次换一段 |

## 已知缺口

- 替换块在 UI 上仍占「用户消息」的位置——宿主事件类型层只允许 `user/message` 带 `sourceEventSeqs`，改不了；内容层已标「非用户发言」。
- 替换块摘要仍是规则压缩（关键词 + 截断），结论容易被砍；提炼质量一般，接模型只改 `refine()` 内部。
- 真替换只对黑名单之外的会话生效；几千字的大窗口路径还没实跑。
- 工具原文取回：小结果摘录已在 a7d24d 的替换块里验证；大结果的 `refId` 取回路径还没实撞上。
- `persona` 表已导入 mnemon 的常驻条目，但默认不注入；提炼层还没做「从对话里长出偏好/判断」。
