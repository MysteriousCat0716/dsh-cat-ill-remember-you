import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_SESSIONS_ROOT, readSessionEvents } from './originals.js';

/**
 * Read the workspace a session directory belongs to.
 *
 * 目录名把 cwd 里的分隔符压成 `-`，反解不回去（`C-Users` 还是 `C:\Users` 靠猜），
 * 所以以会话文件首行（`{"type":"session",...,"cwd":...}`）为准。走 readSessionEvents
 * 是为了复用它的 30MB 上限与损坏文件日志——回填虽然只跑一次，解压同样是同步的，
 * 一个坏掉的大文件会把启动卡住。
 *
 * @param {string} dir session 目录，里面是 `session.v4.jsonl.zstd`
 * @returns {string} cwd，读不到时返回空串
 */
function cwdOfSessionDir(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return '';
  }
  for (const name of names) {
    if (!name.endsWith('.zstd')) continue;
    try {
      const header = readSessionEvents(path.join(dir, name))[0];
      if (typeof header?.cwd === 'string' && header.cwd) return header.cwd;
    } catch {
      /* 损坏的会话文件：这个 sid 留空，下次还能再试 */
    }
  }
  return '';
}

/**
 * 给旧 turns 补 workspace 归属。
 *
 * 2026-11-03 之前 turns 没有 cwd 列，`recentTurnsBySession` 只能按 sid 去重，
 * 不同 workspace 的会话会互相看见尾巴。加列之后旧行 cwd='' 不参与接续，
 * 这里按会话文件头把能认领的行补上；认不出的保持空，宁可接不上也不串项目。
 *
 * 幂等：没有空行时只做一次 `SELECT DISTINCT` 就返回。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{sessionsRoot?:string}} [options]
 * @returns {number} 回填的行数
 */
export function backfillTurnCwd(db, { sessionsRoot = DEFAULT_SESSIONS_ROOT } = {}) {
  if (!db) return 0;
  let pending;
  try {
    pending = db.prepare("SELECT DISTINCT sid FROM turns WHERE cwd = ''").all().map((row) => String(row.sid));
  } catch {
    return 0;
  }
  if (pending.length === 0) return 0;

  const wanted = new Set(pending);
  /** @type {Map<string,string>} */
  const cwdBySid = new Map();
  let workspaces;
  try {
    workspaces = fs.readdirSync(sessionsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return 0;
  }
  for (const workspace of workspaces) {
    let entries;
    try {
      entries = fs.readdirSync(path.join(sessionsRoot, workspace.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !wanted.has(entry.name) || cwdBySid.has(entry.name)) continue;
      const cwd = cwdOfSessionDir(path.join(sessionsRoot, workspace.name, entry.name));
      if (cwd) cwdBySid.set(entry.name, cwd);
    }
  }
  if (cwdBySid.size === 0) return 0;

  const update = db.prepare("UPDATE turns SET cwd = ? WHERE sid = ? AND cwd = ''");
  let changed = 0;
  for (const [sid, cwd] of cwdBySid) {
    changed += Number(update.run(cwd, sid).changes ?? 0);
  }
  return changed;
}
