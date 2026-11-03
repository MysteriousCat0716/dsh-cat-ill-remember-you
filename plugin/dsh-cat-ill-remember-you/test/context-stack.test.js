import test from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '../lib/db.js';
import { evictOverflow, pushStack, readStack, renderStack } from '../lib/context-stack.js';

function insertTurn(db, { sid, seq, role = 'user', text, t = 1000 }) {
  db.prepare(
    `INSERT OR IGNORE INTO turns (sid, seq, role, origin, cwd, text, t) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(sid, seq, role, 'chat', '', text, t);
}

test('readStack: 跨会话按时间倒序取最近 N 条', () => {
  const db = openStore(':memory:');
  insertTurn(db, { sid: 's-a', seq: 1, text: '会话一的话', t: 1000 });
  insertTurn(db, { sid: 's-b', seq: 1, text: '会话二的话', t: 2000 });
  pushStack(db, { sid: 's-a', seq: 1, t: 1000 });
  pushStack(db, { sid: 's-b', seq: 1, t: 2000 });
  const rows = readStack(db, { limit: 10 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].sid, 's-b');
  assert.equal(rows[1].sid, 's-a');
  db.close();
});

test('evictOverflow: 超过容量时最早的出栈并留下摘要', () => {
  const db = openStore(':memory:');
  insertTurn(db, { sid: 's-a', seq: 1, text: '最早的那句话', t: 1000 });
  insertTurn(db, { sid: 's-b', seq: 1, text: '第二句话', t: 2000 });
  insertTurn(db, { sid: 's-c', seq: 1, text: '第三句话', t: 3000 });
  pushStack(db, { sid: 's-a', seq: 1, t: 1000 });
  pushStack(db, { sid: 's-b', seq: 1, t: 2000 });
  pushStack(db, { sid: 's-c', seq: 1, t: 3000 });
  assert.equal(evictOverflow(db, { limit: 2 }), 1);
  const oldest = readStack(db, { limit: 10 }).find((row) => row.sid === 's-a');
  assert.equal(oldest.evicted, 1);
  assert.match(oldest.summary, /最早的那句话/);
  const text = renderStack(db, { limit: 10, raw: 1 });
  assert.match(text, /旧·摘要/);
  assert.match(text, /最早的那句话/);
  db.close();
});

test('evictOverflow 幂等：容量内重复调用不出栈', () => {
  const db = openStore(':memory:');
  insertTurn(db, { sid: 's-a', seq: 1, text: '一句', t: 1000 });
  pushStack(db, { sid: 's-a', seq: 1, t: 1000 });
  assert.equal(evictOverflow(db, { limit: 10 }), 0);
  assert.equal(evictOverflow(db, { limit: 10 }), 0);
  db.close();
});

test('evictOverflow: 出栈摘要带上同一轮 assistant 的结尾', () => {
  const db = openStore(':memory:');
  insertTurn(db, { sid: 's-a', seq: 1, role: 'user', text: '这句问的是第一件事', t: 1000 });
  insertTurn(db, {
    sid: 's-a',
    seq: 2,
    role: 'assistant',
    text: '先做备份再改。这一轮的结论落在这句话的尾巴上。',
    t: 1001,
  });
  insertTurn(db, { sid: 's-b', seq: 1, text: '后来的一句', t: 2000 });
  pushStack(db, { sid: 's-a', seq: 1, t: 1000 });
  pushStack(db, { sid: 's-b', seq: 1, t: 2000 });
  assert.equal(evictOverflow(db, { limit: 1 }), 1);
  const oldest = readStack(db, { limit: 10 }).find((row) => row.sid === 's-a');
  assert.equal(oldest.evicted, 1);
  assert.match(oldest.summary, /问：/);
  assert.match(oldest.summary, /答：/);
  assert.match(oldest.summary, /结论落在这句话的尾巴上/);
  db.close();
});

test('renderStack: 全局 20 条之外，补本会话更早的几条', () => {
  const db = openStore(':memory:');
  insertTurn(db, { sid: 's-me', seq: 1, text: '本会话第一句', t: 1000 });
  insertTurn(db, { sid: 's-me', seq: 2, text: '本会话第二句', t: 1001 });
  insertTurn(db, { sid: 's-me', seq: 3, text: '本会话第三句', t: 1002 });
  pushStack(db, { sid: 's-me', seq: 1, t: 1000 });
  pushStack(db, { sid: 's-me', seq: 2, t: 1001 });
  pushStack(db, { sid: 's-me', seq: 3, t: 1002 });
  // 别的会话占满最近 25 条，把本会话的三条挤出全局 20 条。
  for (let index = 0; index < 25; index += 1) {
    const sid = `s-other-${index}`;
    insertTurn(db, { sid, seq: 1, text: `别处第${index}句`, t: 2000 + index });
    pushStack(db, { sid, seq: 1, t: 2000 + index });
  }
  const text = renderStack(db, { sid: 's-me', limit: 20, localExtra: 10, raw: 0 });
  assert.match(text, /【本会话更早】/);
  assert.match(text, /本会话第一句/);
  // 全局段里不该出现本会话那三条。
  const globalPart = text.split('【本会话更早】')[0];
  assert.doesNotMatch(globalPart, /本会话第一句/);
  db.close();
});
