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

## 数据

默认 `~/.dsh/memory/core.db`，`DSH_MEMORY_CORE_DB` 可覆盖。

## 装进 profile

依赖与 `dsh.profile.bundles` 里加 `dsh-cat-ill-remember-you`（link 到本目录），`pnpm install`，重启 dsh。

## 跑测试

```bash
node --test test/
```

72 条，全部用内存库（`':memory:'`），不碰真实数据。

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `DSH_MEMORY_CORE_DB` | `~/.dsh/memory/core.db` | 数据库路径 |
| `DSH_MEMORY_CORE_IDLE_MS` | `300000` | 空闲多久后开始提炼 |
| `DSH_MEMORY_CORE_TICK_MS` | `60000` | 空闲检查间隔 |
| `DSH_MEMORY_CORE_EMBED_MODEL` | `qwen3-embedding:0.6b` | 向量模型 |
| `DSH_MEMORY_CORE_OLLAMA` | `http://127.0.0.1:11434` | Ollama 地址 |
| `DSH_MEMORY_CORE_EMBED_BATCH` | `16` | 每批补多少条向量 |
| `DSH_MEMORY_CORE_KEEP` | `10` | 影子/替换时保留多少条原文 |
| `DSH_MEMORY_CORE_SHADOW_WINDOW` | `40` | 每次被换窗口最多取多少条 |
| `DSH_MEMORY_CORE_REPLACE` | `0` | 真替换开关；`1` 才写 `surfaceOp.replace` |

## 已知缺口

- 向量已生成（1024 维），但还没接进取回；纯语义指代（「就那个讲压缩的」）仍可能捞不回。
- 影子样本不足 50 轮，替换没开。
- 提炼是规则版，摘要质量一般；接模型只改 `refine()` 内部。
