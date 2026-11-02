# I'll Remember You

包名 `dsh-cat-ill-remember-you`。

记忆核心的 DSH 插件：把对话原文落进本地 SQLite，空闲时提炼成信息点，每轮开始前三级取回并注入。

设计原则与整体架构见仓库根 [README](../../README.md)。

## 现在有什么

- **M0 原文入库**：`session/event` 的 `user/message` / `assistant/message` 写进 `turns`；按 `(sid, seq, role)` 幂等；只取 text 块；运行时上下文、记忆提示、子代理委派等机器串挡在门外。
- **M1 规则提炼**：空闲 5 分钟后把未消费的 turns 分成「user + 其后 assistant」的块，按判断/偏好/事实三类提炼成 `memories`，抽锚点与实体。接模型时只换 `refine()` 内部，接口不变。
- **M2 三级取回**：L1 最近 3 条 / L2 memories / L3 turns，闸门要求每条写出 why，注入 1–2 条、≤600 字，落 `recall_log`。另有分区：persona（偏好 + 关系类决定）常驻 ≤8 条/300 字，people 与 tools 各按需取 1 条，都算进 2 条/600 字预算。
- **M3 影子**：每轮算「如果替换会删掉什么、补上什么」，只写 `shadow_log`，不动真实上下文。
- **M4 遗忘**：每日一次，按取回/验证时间降 tier，只标不删，落 `forget_log`。保留期分三档：`permanent` 永不降级（偏好）、`ephemeral` 7 天没碰沉 dormant（情绪）、`auto` 走默认曲线（30/90 天）。
- **M5 跨会话接续**：新会话第一轮，注入同 workspace 上一个会话的最后几条**原文**（`lib/originals.js` 读 `~/.dsh/sessions/<workspace>/<sid>/session.v4.jsonl.zstd`，append-only，被替换掉的原文也在；跳过子代理会话与空会话），标 `[上次会话结尾]`，≤1600 字，每会话一次。原文读不到时才退回 `shadow_v2` 里 `applied=1`、同 `cwd`、非当前会话的缓存摘要——摘要永远是退路。跨 workspace 不串；`cwd` 为空的历史行不参与。「是不是新会话」按**会话历史**判断——`session.surface` 里有没有 assistant 回复。不能用 pre-step 的 `messages`：那是 inbox 里 claim 到的本轮新消息（`dsh-agent-loop/lib/index.js:909-912` `messages: claimed`），拿它判 assistant 永远为假，主会话每轮都会被注入（2026-11-03 01:31 实机踩到）。也不能用 `turn`——那是进程内轮次（`dsh-agent-loop/lib/index.js:943` `const turn = phase.turn + 1`），旧会话恢复后也从 1 开始。

替换的区间按**位置**取（`surface.nodes.indexOf(startSeq)` 到 `indexOf(endSeq)`），不能按 seq 值过滤：早先替换块的 seq 比它所在的位置大，会夹在后续区间中间；值过滤会漏掉它，宿主按位置算 `shadowedSeqs`，直接报 `missing`。同一区间只记一次账，但白名单内上次 `applied=0`（append 失败）时允许下一轮重试；冷却期内不记账也不替换。

替换已改成**滚动**（0.4.0）：不再等窗口满一次换掉 40%，而是每次只动 surface 上最早 `STEP=4` 条，最近 `KEEP_TAIL=6` 条永远是原文；条数 > 10 或原文总字数 > 6000 任一超线就跑，冷却 60 秒。旧的比例逻辑保留为兜底，`DSH_MEMORY_CORE_ROLL=0` 可退回。替换块不进 `surfaceMessages`（`source.kind` 是 `context-replacement`，被跳过），所以不会被二次压缩——下一次替换永远从原文重算。

## 数据

默认 `~/.dsh/memory/core.db`，`DSH_MEMORY_CORE_DB` 可覆盖。

## 装进 profile

依赖与 `dsh.profile.bundles` 里加 `dsh-cat-ill-remember-you`（link 到本目录），`pnpm install`，重启 dsh。

## 跑测试

```bash
node --test test/
```

118 条；单元测试用内存库，pre-step 集成测试用临时文件库（跑完删除），都不碰真实数据。

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `DSH_MEMORY_CORE_DB` | `~/.dsh/memory/core.db` | 数据库路径 |
| `DSH_MEMORY_CORE_IDLE_MS` | `300000` | 空闲多久后开始提炼 |
| `DSH_MEMORY_CORE_TICK_MS` | `60000` | 空闲检查间隔 |
| `DSH_MEMORY_CORE_EMBED_MODEL` | `qwen3-embedding:0.6b` | 向量模型 |
| `DSH_MEMORY_CORE_OLLAMA` | `http://127.0.0.1:11434` | Ollama 地址 |
| `DSH_MEMORY_CORE_EMBED_BATCH` | `16` | 每批补多少条向量 |
| `DSH_MEMORY_CORE_KEEP` | `10` | 旧模式保留多少条原文（滚动模式按 `KEEP_TAIL` 固定 6） |
| `DSH_MEMORY_CORE_SHADOW_WINDOW` | `40` | 旧模式每次被换窗口最多取多少条 |
| `DSH_MEMORY_CORE_ROLL` | `1` | 滚动替换；`0` 退回按比例一次换一段 |

真替换的开关不是环境变量，是白名单文件 `~/.dsh/cache/replace-sessions.txt`：每行一个 session id，`*` 表示全部；文件不存在或名单为空 = 全关。`tools/allow-session.mjs` 可以列最近会话、把某个 sid 写进名单。

## 已知缺口

- 向量已生成（1024 维），但还没接进取回；纯语义指代（「就那个讲压缩的」）仍可能捞不回。
- 真替换只在白名单会话里验证过；主会话还没开，几千字的大窗口路径也还没实跑。
- 白名单外完全不记账（2026-11-03 02:33 起），所以这些会话没有替换账本可查。
- 提炼是规则版，摘要质量一般；接模型只改 `refine()` 内部。
