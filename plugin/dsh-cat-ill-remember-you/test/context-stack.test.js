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

test('evictOverflow: assistant 行出栈时问回查前一条 user，不把答当问', () => {
  const db = openStore(':memory:');
  insertTurn(db, { sid: 's-a', seq: 1, role: 'user', text: '这次改哪边？', t: 1000 });
  insertTurn(db, {
    sid: 's-a',
    seq: 2,
    role: 'assistant',
    text: '先改读取那一侧，写入不动。结论在最后这句上。',
    t: 1001,
  });
  insertTurn(db, { sid: 's-b', seq: 1, role: 'user', text: '后来的一句', t: 2000 });
  pushStack(db, { sid: 's-a', seq: 2, t: 1000 });
  pushStack(db, { sid: 's-b', seq: 1, t: 2000 });
  assert.equal(evictOverflow(db, { limit: 1 }), 1);
  const oldest = readStack(db, { limit: 10 }).find((row) => row.sid === 's-a' && row.seq === 2);
  assert.equal(oldest.evicted, 1);
  // 问来自前一条 user，不是 assistant 自己的结论。
  assert.match(oldest.summary, /问：这次改哪边？/);
  assert.doesNotMatch(oldest.summary, /问：先改读取那一侧/);
  // 答留尾巴。
  assert.match(oldest.summary, /结论在最后这句上/);
  db.close();
});

test('renderStack: 全局段按会话取，本会话单独补一段', () => {
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
  assert.match(text, /【本会话】/);
  assert.match(text, /本会话第一句/);
  // 全局段里不该出现本会话那三条。
  const globalPart = text.split('【本会话】')[0];
  assert.doesNotMatch(globalPart, /本会话第一句/);
  db.close();
});

test('renderStack: 按会话新→旧分配 6/5/4/3/2/1 条，长会话不再占满窗口', () => {
  const db = openStore(':memory:');
  // 会话 A 最新但很长（10 条），只该拿 6 条。
  for (let seq = 1; seq <= 10; seq += 1) {
    insertTurn(db, { sid: 's-a', seq, text: `A第${seq}条`, t: 1000 + seq });
    pushStack(db, { sid: 's-a', seq, t: 1000 + seq });
  }
  // 会话 B 与 C 各 8 条，分别该拿 5 条、4 条。
  for (const [sid, base] of [['s-b', 2000], ['s-c', 3000]]) {
    for (let seq = 1; seq <= 8; seq += 1) {
      insertTurn(db, { sid, seq, text: `${sid}第${seq}条`, t: base + seq });
      pushStack(db, { sid, seq, t: base + seq });
    }
  }
  // 会话时间：C 最新（3001+）、B 次新、A 最旧（1001+）。
  const text = renderStack(db, { sid: 's-me', limit: 30, localExtra: 0, raw: 0 });
  const globalPart = text.split('【本会话】')[0];
  const count = (mark) => (globalPart.match(new RegExp(mark, 'g')) || []).length;
  assert.equal(count('s-c第'), 6);
  assert.equal(count('s-b第'), 5);
  assert.equal(count('A第'), 4);
  // 取的是各自的尾部，不是开头。
  assert.match(globalPart, /s-c第8条/);
  assert.doesNotMatch(globalPart, /s-c第1条/);
  db.close();
});

test('renderStack: 注入块按时间正序，最早的在最上面', () => {
  const db = openStore(':memory:');
  insertTurn(db, { sid: 's-a', seq: 1, text: '最早那条', t: 1000 });
  insertTurn(db, { sid: 's-b', seq: 1, text: '中间那条', t: 2000 });
  insertTurn(db, { sid: 's-c', seq: 1, text: '最新那条', t: 3000 });
  pushStack(db, { sid: 's-a', seq: 1, t: 1000 });
  pushStack(db, { sid: 's-b', seq: 1, t: 2000 });
  pushStack(db, { sid: 's-c', seq: 1, t: 3000 });
  const text = renderStack(db, { limit: 10, raw: 0 });
  assert.ok(text.indexOf('最早那条') < text.indexOf('中间那条'));
  assert.ok(text.indexOf('中间那条') < text.indexOf('最新那条'));
  db.close();
});

test('renderStack: 时间戳用本机时区，不是 UTC', () => {
  const db = openStore(':memory:');
  // 本地 2026-11-04 01:21；UTC 会写成前一天的 17:21。
  const t = new Date(2026, 10, 4, 1, 21, 0).getTime();
  insertTurn(db, { sid: 's-a', seq: 1, text: '凌晨说的话', t });
  pushStack(db, { sid: 's-a', seq: 1, t });
  const text = renderStack(db, { limit: 10 });
  assert.match(text, /01:21/);
  assert.doesNotMatch(text, /17:21/);
  db.close();
});

test('renderStack: 原文按轮算，多步回复不会把提问挤成摘要', () => {
  const db = openStore(':memory:');
  const tail = (mark) => `${mark}${'长'.repeat(200)}尾巴${mark}`;
  insertTurn(db, { sid: 's-a', seq: 1, text: '把缓存改一下，改完告诉我结论' });
  insertTurn(db, { sid: 's-a', seq: 2, role: 'assistant', text: tail('A1') });
  insertTurn(db, { sid: 's-a', seq: 3, role: 'assistant', text: tail('A2') });
  insertTurn(db, { sid: 's-a', seq: 4, role: 'assistant', text: tail('A3') });
  for (const seq of [1, 2, 3, 4]) pushStack(db, { sid: 's-a', seq, t: 1000 + seq });
  const text = renderStack(db, { limit: 10, raw: 1 });
  // 这一轮整轮都在原文区间里：提问和三条回复的原文都在。
  assert.match(text, /把缓存改一下/);
  assert.match(text, /尾巴A1/);
  assert.match(text, /尾巴A3/);
  db.close();
});

test('renderStack: dsh-ui 围栏换成卡片标题与正文，不再是一坨 JSON', () => {
  const db = openStore(':memory:');
  const ui = '```dsh-ui\n{"title":"三件都办了","gap":10,"items":[{"type":"text","content":"正文一句话"}]}\n```';
  insertTurn(db, { sid: 's-a', seq: 1, role: 'assistant', text: ui });
  pushStack(db, { sid: 's-a', seq: 1, t: 1000 });
  const text = renderStack(db, { limit: 10, raw: 1 });
  assert.match(text, /\[卡片\] 三件都办了｜正文一句话/);
  assert.doesNotMatch(text, /"gap"/);
  db.close();
});
