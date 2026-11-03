import test from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '../lib/db.js';
import { readStack, renderStack } from '../lib/context-stack.js';

function insertTurn(db, { sid, seq, role, text, t }) {
  db.prepare(
    `INSERT OR IGNORE INTO turns (sid, seq, role, origin, cwd, text, t) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(sid, seq, role, 'chat', '', text, t);
}

test('readStack: 跨会话按时间倒序取最近 N 条', () => {
  const db = openStore(':memory:');
  insertTurn(db, { sid: 's-a', seq: 1, role: 'user', text: '会话一的话', t: 1000 });
  insertTurn(db, { sid: 's-b', seq: 1, role: 'user', text: '会话二的话', t: 2000 });
  const rows = readStack(db, { limit: 10 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].sid, 's-b');
  assert.equal(rows[1].sid, 's-a');
  db.close();
});

test('renderStack: 最近几条用原文，更早的用缓存摘要', () => {
  const db = openStore(':memory:');
  insertTurn(db, { sid: 's-old', seq: 1, role: 'user', text: '很久以前那句原文', t: 1000 });
  insertTurn(db, { sid: 's-new', seq: 1, role: 'user', text: '刚刚那句原文', t: 2000 });
  db.prepare(
    `INSERT INTO shadow_v2
       (sid, turn, t, range_start, range_end, seqs, text, chars_before, chars_after, kept, lost_ratio, dangling, applied, cwd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('s-old', 0, 1, 1, 1, '[1]', '[上下文替换] 旧话的摘要缓存', 10, 12, 1, 0, 0, 1, '');
  const text = renderStack(db, { limit: 10, raw: 1 });
  assert.match(text, /最近 2 条/);
  assert.match(text, /刚刚那句原文/);
  assert.match(text, /旧话的摘要缓存/);
  assert.doesNotMatch(text, /很久以前那句原文/);
  db.close();
});
