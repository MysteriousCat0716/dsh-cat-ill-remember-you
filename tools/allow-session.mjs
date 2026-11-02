/**
 * 会话白名单工具（只读库、只写一个文本文件）
 *
 * 用法：
 *   node tools/allow-session.mjs            # 列出最近 5 个会话（sid / 最后活动 / 轮数）
 *   node tools/allow-session.mjs <sid>      # 把该会话写进真替换白名单
 *
 * 白名单文件默认 ~/.dsh/cache/replace-sessions.txt，每行一个 sid，`*` 全开。
 * 真替换还要 DSH_MEMORY_CORE_REPLACE=1 才生效；两个条件缺一不换。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DB = process.env.DSH_MEMORY_CORE_DB || path.join(os.homedir(), '.dsh', 'memory', 'core.db');
const LIST =
  process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS ||
  path.join(os.homedir(), '.dsh', 'cache', 'replace-sessions.txt');

const sid = process.argv[2]?.trim();
const db = new DatabaseSync(DB, { readOnly: true });

if (!sid) {
  const rows = db
    .prepare(
      `SELECT sid, COUNT(*) AS turns, MAX(t) AS last
         FROM turns GROUP BY sid ORDER BY last DESC LIMIT 5`,
    )
    .all();
  for (const row of rows) {
    const when = new Date(Number(row.last)).toISOString().replace('T', ' ').slice(0, 19);
    console.log(`${row.sid}  turns=${row.turns}  last=${when}`);
  }
  process.exit(0);
}

fs.mkdirSync(path.dirname(LIST), { recursive: true });
const lines = new Set(
  fs.existsSync(LIST)
    ? fs.readFileSync(LIST, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [],
);
lines.add(sid);
fs.writeFileSync(LIST, `${[...lines].join('\n')}\n`, 'utf8');
console.log(`OK ${LIST} <- ${sid}`);
