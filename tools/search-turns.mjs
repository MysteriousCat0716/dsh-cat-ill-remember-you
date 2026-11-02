#!/usr/bin/env node
/**
 * 原文检索：按关键词翻 turns 表，跨会话找旧话。
 *
 *   node tools/search-turns.mjs 关键词 [关键词2 ...] [--sid=<session>] [--limit=20]
 *
 * 多个关键词是 AND。只读，不写库。
 * 输出：会话后 6 位 / seq / 角色 / 时间 + 命中处前后一段原文。
 */
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dbPath = process.env.DSH_MEMORY_CORE_DB || join(homedir(), '.dsh/memory/core.db');

const argv = process.argv.slice(2);
const words = [];
let sidArg = '';
let limit = 20;
for (const a of argv) {
  if (a.startsWith('--sid=')) sidArg = a.slice(6);
  else if (a.startsWith('--limit=')) limit = Number(a.slice(8)) || 20;
  else if (!a.startsWith('--')) words.push(a);
}

if (words.length === 0) {
  console.error('用法: node tools/search-turns.mjs 关键词 [关键词2 ...] [--sid=<session>] [--limit=20]');
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const where = words.map(() => 'text LIKE ?').join(' AND ');
const params = words.map((w) => `%${w}%`);
let sql = `SELECT sid, seq, role, t, text FROM turns WHERE ${where}`;
if (sidArg) sql += ` AND sid = ?`;
sql += ` ORDER BY t DESC LIMIT ?`;
const rows = db.prepare(sql).all(...params, ...(sidArg ? [sidArg] : []), limit);

for (const r of rows) {
  const time = new Date(r.t).toLocaleString('zh-CN', { hour12: false });
  const text = String(r.text ?? '');
  const idx = words.map((w) => text.indexOf(w)).find((i) => i >= 0) ?? 0;
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + 140);
  const snippet =
    (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '');
  const short = String(r.sid).replace(/^session-/, '').slice(0, 8);
  console.log(`\n[${short}] seq=${r.seq} ${r.role} ${time}\n  ${snippet}`);
}
console.log(`\n共 ${rows.length} 条`);
