/**
 * 一次性把 mnemon 的常驻条目导入我们自己的 persona 表。
 *
 * 只读 ~/.mnemon/runtime/memories.json，写到 core.db 的 persona 表；
 * 重复执行不会重复插入（UNIQUE(target, content) + INSERT OR IGNORE）。
 *
 * 用法：
 *   node 记忆核心/tools/import-mnemon-persona.mjs [--dry]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../plugin/dsh-cat-ill-remember-you/lib/db.js';

const SOURCE = path.join(os.homedir(), '.mnemon', 'runtime', 'memories.json');
const DRY = process.argv.includes('--dry');

if (!fs.existsSync(SOURCE)) {
  console.error(`找不到 ${SOURCE}`);
  process.exit(1);
}

const parsed = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
if (entries.length === 0) {
  console.error('memories.json 里没有 entries');
  process.exit(1);
}

const db = openStore();
const insert = db.prepare(
  `INSERT OR IGNORE INTO persona (target, content, importance, source, t)
   VALUES (?, ?, ?, 'mnemon', ?)`,
);

let inserted = 0;
let skipped = 0;
for (const entry of entries) {
  const content = String(entry?.content ?? '').trim();
  if (!content) continue;
  const target = entry?.target === 'memory' ? 'memory' : 'user';
  const importance = ['critical', 'normal', 'low'].includes(entry?.importance)
    ? entry.importance
    : 'normal';
  const when = Date.parse(entry?.updated_at || entry?.created_at || '');
  const t = Number.isFinite(when) ? when : Date.now();
  if (DRY) {
    inserted += 1;
    continue;
  }
  const result = insert.run(target, content, importance, t);
  if (result.changes > 0) inserted += 1;
  else skipped += 1;
}

const counts = db
  .prepare(`SELECT target, COUNT(*) AS n FROM persona GROUP BY target ORDER BY target`)
  .all();

console.log(`${DRY ? '[dry] ' : ''}导入 ${inserted} 条，跳过重复 ${skipped} 条`);
for (const row of counts) console.log(`  ${row.target}: ${row.n} 条`);
