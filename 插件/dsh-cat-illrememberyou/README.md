# dsh-cat-illrememberyou

记忆核心插件。M0 把对话原文按 turn 落进本地 SQLite；M1 在空闲时用规则把原始轮次提炼成 `memories` 候选。

## 现在有什么

- `lib/db.js` — `node:sqlite` 打开/建库（默认 `~/.dsh/memory/core.db`），七张表的 schema：
  `turns`（原文，唯一键 `sid+seq+role`）、`memories`（提炼后的记忆）、`entities`、`embeddings`、
  `runs`（提炼/建向量的执行记录）、`recall_log`（每次取回与理由）、`forget_log`（只降级不删行）。
- `lib/ingest.js` — 从 `session/event` 的 `user/message` / `assistant/message` 提取 `text` 块写进 `turns`；
  真人输入按 `message.source.kind === 'user'` 判断，运行时上下文（kind=`runtime-context` 等）直接丢弃；
  无 `source` 的旧事件回落到 `[记忆提示]` 前缀黑名单；跳过 thinking / tool_call / 图片块；按 `sid+seq+role` 幂等。
- `lib/extract.js` — M1 规则提炼（本机没有生成模型，先规则先行）：
  `groupTurns` 按「每个 user 一条 + 其后的 assistant」分块；`classify` 分 decision / preference / fact；
  `anchorsOf` 抓路径/文件名/`mNNNNN`；`entitiesOf` 抓专名；`refine` 写 `memories` 并标记 turns 已消费。
  之后接模型时只换 `refine` 内部，接口不变。
- `lib/index.js` — 挂 `session/event` 入库；空闲 5 分钟（`DSH_MEMORY_CORE_IDLE_MS`）且有待消费 turns 时跑一次提炼（每次最多 40 条）；
  每次事件前探测 store，发现被关闭就重开（自愈）；异常写 `~/.dsh/cache/illrememberyou.log`，插件坏掉不连累宿主。

## 还没做（M2–M3）

- M2 取回：结构过滤 → 向量补充 → 去重 → 闸门写 `why` → 注入；对应 `recall_log`。
- M3 迁移：把现有分片条目和旧会话文件导进 `turns` / `memories`。

## 跑测试

```bash
node --test test/
```

## 装进 profile

依赖与 `dsh.profile.bundles` 里加 `dsh-cat-illrememberyou`（link 到本目录），`pnpm install`，重启 dsh。
数据库路径可用 `DSH_MEMORY_CORE_DB` 覆盖（测试用）。
