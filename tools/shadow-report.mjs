#!/usr/bin/env node
/**
 * 影子账本日报：只读 core.db，把 shadow_v2 最近 N 行汇总成 markdown。
 * 用法：node tools/shadow-report.mjs [条数]
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DB = process.env.DSH_MEMORY_CORE_DB || 'C:/Users/Administrator/.dsh/memory/core.db';
const LIMIT = Number(process.argv[2] ?? 40) || 40;
const OUT = path.resolve(
  process.env.DSH_MEMORY_CORE_REPORT ??
    'C:/Users/Administrator/Documents/deepseek-harness/default-workspace/产出/文档/影子日报-2026-11-02.md',
);

const db = new DatabaseSync(DB, { readOnly: true });
const total = db.prepare('SELECT COUNT(*) AS n FROM shadow_v2').get().n;
const rows = db
  .prepare(
    `SELECT id, sid, t, range_start, range_end, chars_before, chars_after, kept,
            lost_ratio, dangling, applied, text
       FROM shadow_v2 ORDER BY id DESC LIMIT ?`,
  )
  .all(LIMIT);

const avg = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const when = (t) => {
  const d = new Date(Number(t));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const before = rows.map((r) => Number(r.chars_before));
const after = rows.map((r) => Number(r.chars_after));
const lost = rows.map((r) => Number(r.lost_ratio));
const danglingRows = rows.filter((r) => Number(r.dangling) > 0);
const appliedRows = rows.filter((r) => Number(r.applied) > 0);
const sids = new Map();
for (const r of rows) sids.set(r.sid, (sids.get(r.sid) ?? 0) + 1);

const lines = [
  `# 影子账本日报 · 最近 ${rows.length} 行`,
  '',
  `- 全库累计：**${total}** 行`,
  `- 时间跨度：${rows.length ? `${when(rows.at(-1).t)} → ${when(rows[0].t)}` : '—'}`,
  `- 被换原文平均：**${Math.round(avg(before)).toLocaleString()}** 字 → 替换文本平均 **${Math.round(avg(after))}** 字`,
  `- 平均保留率：**${pct(avg(lost))}**（被换内容里锚点/实体还剩多少）`,
  `- 断链行：**${danglingRows.length} / ${rows.length}**（${pct(danglingRows.length / Math.max(1, rows.length))}）`,
  `- 真替换写入：**${appliedRows.length}** 行（开关默认关，应为 0）`,
  '',
  '## 会话分布',
  '',
  '| sid | 行数 |',
  '| --- | --- |',
  ...[...sids.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([sid, n]) => `| ${sid} | ${n} |`),
  '',
  '## 最近 10 行',
  '',
  '| id | 时间 | 区间 | 原文 | 替换 | 保留率 | 断链 | 开头 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ...rows.slice(0, 10).map((r) =>
    [
      r.id,
      when(r.t),
      `${r.range_start}–${r.range_end}`,
      Number(r.chars_before).toLocaleString(),
      Number(r.chars_after),
      pct(Number(r.lost_ratio)),
      r.dangling,
      String(r.text ?? '').replace(/\s+/g, ' ').slice(0, 36),
    ]
      .map((cell) => String(cell).replace(/\|/g, '\\|'))
      .join(' | '),
  ).map((row) => `| ${row} |`),
  '',
  '## 看什么',
  '',
  '- 保留率低（<80%）的行：替换文本丢了太多锚点/实体，先看 `dangling` 是不是同时变多。',
  '- 断链行：说明后续指代词接不上；如果集中在某个 sid，先在那条会话上小窗口试。',
  '- 原文/替换比：只对「窗口边缘最近 40 条」有意义，早期整段压缩的比值会夸张。',
  '',
];

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(`OK ${OUT} rows=${rows.length} total=${total}`);
db.close();
