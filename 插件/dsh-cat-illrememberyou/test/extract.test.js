import test from 'node:test';
import assert from 'node:assert/strict';

import { openStore, insertTurn, pendingCount } from '../lib/db.js';
import {
  groupTurns,
  classify,
  anchorsOf,
  entitiesOf,
  candidateOf,
  refine,
} from '../lib/extract.js';

function turn(over = {}) {
  return { id: 1, sid: 's1', seq: 1, role: 'user', text: '你好', t: 1000, ...over };
}

test('groupTurns: one block per user message, assistant rides along', () => {
  const blocks = groupTurns([
    turn({ id: 1, seq: 1, role: 'user', text: 'A' }),
    turn({ id: 2, seq: 2, role: 'assistant', text: 'a1' }),
    turn({ id: 3, seq: 3, role: 'assistant', text: 'a2' }),
    turn({ id: 4, seq: 4, role: 'user', text: 'B' }),
  ]);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0].turns.map((t) => t.id), [1, 2, 3]);
  assert.deepEqual(blocks[1].turns.map((t) => t.id), [4]);
});

test('groupTurns: leading assistant does not get dropped', () => {
  const blocks = groupTurns([
    turn({ id: 7, seq: 7, role: 'assistant', text: '中段接入' }),
    turn({ id: 8, seq: 8, role: 'user', text: '在吗' }),
  ]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].turns[0].id, 7);
});

test('classify: preference / decision / emotion / fact', () => {
  assert.equal(classify('我更喜欢中文', '我更喜欢中文'), 'preference');
  assert.equal(classify('以后都走这个入口', '以后都走这个入口'), 'decision');
  assert.equal(classify('今天下午开会', '今天下午开会'), 'fact');
  // 安慰话里的「别」「不用」不是偏好；但情绪本身单独一类
  assert.equal(classify('就是累了', '就是累了 那就别撑了，也不用解释什么'), 'emotion');
  assert.equal(classify('现在做 M2', '现在做 M2 取回'), 'fact');
});

test('anchorsOf: paths, file names, message refs', () => {
  const anchors = anchorsOf('改 产出/文档/计划.md 与 m00422，见 C:/tmp/x.mjs:12');
  assert.ok(anchors.includes('产出/文档/计划.md'));
  assert.ok(anchors.includes('m00422'));
  assert.ok(anchors.some((a) => a.includes('C:/tmp/x.mjs')));
});

test('entitiesOf: names and project nouns', () => {
  const names = entitiesOf('猫让岸把 dsh-cat-illrememberyou 接进 Ollama');
  assert.ok(names.includes('猫'));
  assert.ok(names.includes('岸'));
  assert.ok(names.some((n) => n.startsWith('dsh-')));
  assert.ok(names.includes('Ollama'));
});

test('candidateOf: thin acknowledgement yields nothing', () => {
  assert.equal(candidateOf({ turns: [turn({ text: '好' })] }), null);
});

test('refine: inserts memories and consumes the turns', () => {
  const db = openStore(':memory:');
  insertTurn(db, { sid: 's1', seq: 1, role: 'user', text: '以后记忆核心的原文都进 SQLite 的 turns 表，不要只靠分片。', t: 1000 });
  insertTurn(db, { sid: 's1', seq: 2, role: 'assistant', text: '好，那分片降为导出视图。', t: 1001 });
  assert.equal(pendingCount(db), 2);

  const result = refine(db);
  assert.equal(result.turns, 2);
  assert.ok(result.memories >= 1);
  assert.equal(pendingCount(db), 0);

  const rows = db.prepare('SELECT kind, summary, anchors FROM memories').all();
  assert.equal(rows.length, result.memories);
  assert.equal(rows[0].kind, 'decision');
  assert.ok(rows[0].summary.length > 0);
});

test('candidateOf: subject follows who wrote the block', () => {
  const human = candidateOf({
    turns: [
      turn({ role: 'user', text: '我更喜欢中文，以后回答都用中文。' }),
      turn({ id: 2, role: 'assistant', text: '好。' }),
    ],
  });
  assert.equal(human.subject, 'user');

  const bot = candidateOf({
    turns: [
      turn({ role: 'user', text: '你在干嘛' }),
      turn({ id: 2, role: 'assistant', text: '我在把记忆核心的取回逻辑接起来，顺便让渲染头不再写成裸事实，还要补情境进去。' }),
    ],
  });
  assert.equal(bot.subject, 'assistant');

  const both = candidateOf({
    turns: [
      turn({ role: 'user', text: '以后都走这个入口，别只靠分片，原文进库。' }),
      turn({ id: 2, role: 'assistant', text: '好，分片降为导出视图，这周先把取回接起来再说。' }),
    ],
  });
  assert.equal(both.subject, 'both');
});

test('refine: why carries the scene, not just a label', () => {
  const db = openStore(':memory:');
  insertTurn(db, { sid: 's1', seq: 1, role: 'user', text: '以后记忆核心的原文都进 SQLite 的 turns 表，不要只靠分片。', t: 1000 });
  insertTurn(db, { sid: 's1', seq: 2, role: 'assistant', text: '好，那分片降为导出视图。', t: 1001 });
  refine(db);
  const row = db.prepare('SELECT why, subject FROM memories').get();
  assert.ok(row.why.startsWith('当时：'));
  assert.ok(row.why.includes('依据：decision'));
  assert.ok(['user', 'assistant', 'both'].includes(row.subject));
});

test('refine: empty queue is a no-op', () => {
  const db = openStore(':memory:');
  assert.deepEqual(refine(db), { turns: 0, memories: 0 });
});
