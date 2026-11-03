import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '../lib/db.js';
import { retrieve } from '../lib/recall.js';

// 单元测试不依赖本机 Ollama。
process.env.DSH_MEMORY_CORE_VECTOR = 'off';

function insertMemory(db, { summary, text, anchors, t }) {
  db.prepare(
    `INSERT INTO memories (kind, text, summary, entities, anchors, why, tier, t)
     VALUES ('decision', ?, ?, '[]', ?, '规则提炼：decision', 'active', ?)`,
  ).run(text, summary, JSON.stringify(anchors), t);
}

test('recall trace: 名额满了以后，后面的候选记 budget', async () => {
  const db = openStore(':memory:');
  for (let i = 1; i <= 4; i += 1) {
    insertMemory(db, {
      summary: `lib/recall.js 的第 ${i} 条笔记`,
      text: `lib/recall.js 的第 ${i} 条笔记，内容不同。`,
      anchors: ['lib/recall.js'],
      t: 1000 + i,
    });
  }
  const hits = await retrieve(db, { text: 'lib/recall.js 现在怎么改', recent: [], now: 9000 });
  assert.equal(hits.length, 2);
  assert.ok(Array.isArray(hits.trace));
  assert.ok(
    hits.trace.some((item) => item.reason === 'budget'),
    `trace 里应有 budget：${JSON.stringify(hits.trace)}`,
  );
  db.close();
});

test('recall trace: 上一轮给过的候选记 given', async () => {
  const db = openStore(':memory:');
  insertMemory(db, {
    summary: 'lib/recall.js 的旧笔记',
    text: 'lib/recall.js 的旧笔记，别再重复注入。',
    anchors: ['lib/recall.js'],
    t: 1000,
  });
  // 伪造上一轮已给过：recall_log 里有一行，memory_id 是第一条的 id（自增 1）。
  db.prepare('INSERT INTO recall_log (sid, turn, t, memory_id, why) VALUES (?, ?, ?, ?, ?)').run(
    's1',
    1,
    1500,
    1,
    '上一轮给过',
  );
  const hits = await retrieve(db, {
    text: 'lib/recall.js 现在怎么改',
    recent: [],
    now: 9000,
    sid: 's1',
    turn: 2,
  });
  assert.ok(
    hits.trace.some((item) => item.reason === 'given'),
    `trace 里应有 given：${JSON.stringify(hits.trace)}`,
  );
  db.close();
});

test('recall trace: 空结果也带 trace，且不把属性算进长度', async () => {
  const db = openStore(':memory:');
  const hits = await retrieve(db, { text: '今天天气不错', recent: [] });
  assert.equal(hits.length, 0);
  assert.deepEqual(hits.trace, []);
  db.close();
});
