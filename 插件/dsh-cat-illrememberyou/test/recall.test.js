import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openStore, insertTurn } from '../lib/db.js';
import { queryOf, knownOf, retrieve, renderHint } from '../lib/recall.js';

function makeDb() {
  const db = openStore(':memory:');
  db.prepare(
    `INSERT INTO memories (kind, text, summary, entities, anchors, why, tier, t)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
  ).run(
    'decision',
    '决定把缓存层换掉，因为它太大。',
    '缓存层要换掉',
    JSON.stringify(['缓存']),
    JSON.stringify(['产出/插件/foo.js']),
    '规则提炼：decision',
    1000,
  );
  return db;
}

test('queryOf: picks the anchor out of the sentence', () => {
  const query = queryOf('产出/插件/foo.js 这个文件还要改吗');
  assert.ok(query.anchors.includes('产出/插件/foo.js'));
  assert.equal(query.referral, true);
  assert.equal(queryOf('产出/插件/foo.js 还要改吗').referral, false);
});

test('queryOf: detects a referent', () => {
  assert.equal(queryOf('之前说的那件事结论是什么').referral, true);
});

test('retrieve: anchor match returns one hit with a written why', () => {
  const db = makeDb();
  const hits = retrieve(db, { text: '产出/插件/foo.js 这个文件还要改吗', recent: [] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].source, 'memory');
  assert.ok(hits[0].why.includes('产出/插件/foo.js'));
});

test('retrieve: unrelated sentence gets nothing', () => {
  const db = makeDb();
  assert.deepEqual(retrieve(db, { text: '今天天气不错', recent: [] }), []);
});

test('L2 matches anchors literally, so LIKE wildcards do not leak', () => {
  const db = openStore(':memory:');
  const insert = db.prepare(
    `INSERT INTO memories (kind, text, summary, entities, anchors, why, tier, t)
     VALUES ('fact', '关于这个文件的笔记', ?, '[]', ?, '规则提炼：fact', 'active', 1000)`,
  );
  insert.run('notes_a_b.md', JSON.stringify(['notes_a_b.md']));
  insert.run('notesXaXb.md', JSON.stringify(['notesXaXb.md']));

  const hits = retrieve(db, { text: 'notes_a_b.md 还要改吗', recent: [] });
  assert.equal(hits.length, 1);
  assert.ok(hits[0].summary.includes('notes_a_b.md'));
  db.close();
});

test('retrieve: anchor already in recent context is not fetched again', () => {
  const db = makeDb();
  const hits = retrieve(db, {
    text: '产出/插件/foo.js 这个文件还要改吗',
    recent: ['刚才在说 产出/插件/foo.js'],
  });
  assert.equal(hits.length, 0);
});

test('retrieve: L3 falls back to raw turns only with a referent', () => {
  const db = openStore(':memory:');
  insertTurn(db, {
    sid: 's1',
    seq: 1,
    role: 'user',
    text: '产出/插件/foo.js 的结论是先不换缓存。',
    t: 500,
  });
  const hits = retrieve(db, { text: '之前 产出/插件/foo.js 那件事结论是什么', recent: [], now: 1000 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].source, 'turn');
  assert.ok(hits[0].why.includes('产出/插件/foo.js'));
});

test('retrieve: caps hits at two', () => {
  const db = openStore(':memory:');
  const stmt = db.prepare(
    `INSERT INTO memories (kind, text, summary, entities, anchors, tier, t)
     VALUES ('fact', ?, ?, '[]', ?, 'active', ?)`,
  );
  for (let i = 0; i < 3; i += 1) {
    stmt.run(`缓存第 ${i} 条的结论`, `缓存第 ${i} 条`, JSON.stringify(['产出/插件/foo.js']), 1000 + i);
  }
  const hits = retrieve(db, { text: '产出/插件/foo.js 还要改吗', recent: [] });
  assert.equal(hits.length, 2);
});

test('retrieve: one question with several answers keeps only the newest', () => {
  const db = openStore(':memory:');
  const stmt = db.prepare(
    `INSERT INTO memories (kind, text, summary, entities, anchors, tier, t)
     VALUES ('fact', ?, ?, '[]', ?, 'active', ?)`,
  );
  const q = '问：之前那个 lib/recall.js 的 L2 问题，再用一句话讲一遍';
  stmt.run('旧的根因', `${q}｜答：找到根因了`, JSON.stringify(['产出/插件/foo.js']), 1000);
  stmt.run('新的答案', `${q}｜答：用 json_each 精确等值`, JSON.stringify(['产出/插件/foo.js']), 2000);
  const hits = retrieve(db, { text: '产出/插件/foo.js 还要改吗', recent: [] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].summary, `${q}｜答：用 json_each 精确等值`);
  db.close();
});

test('knownOf: collects anchors and entities', () => {
  const known = knownOf(['刚才在说 产出/插件/foo.js，猫也提过']);
  assert.ok(known.anchors.has('产出/插件/foo.js'));
  assert.ok(known.entities.has('猫'));
});

test('retrieve: memories from an IM channel are not injected', () => {
  const db = makeDb();
  db.prepare(
    `INSERT INTO memories (kind, origin, text, summary, entities, anchors, why, tier, t)
     VALUES ('fact', 'im', '朋友在 QQ 里说的缓存方案', '朋友说的缓存', '[]', ?, '规则提炼：fact', 'active', 2000)`,
  ).run(JSON.stringify(['产出/插件/foo.js']));

  const hits = retrieve(db, { text: '产出/插件/foo.js 还要改吗', recent: [] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].summary, '缓存层要换掉');
  db.close();
});

test('renderHint: renders a gated hint and nothing when empty', () => {
  assert.equal(renderHint([]), '');
  const text = renderHint([{ kind: 'user', summary: '缓存层要换掉', t: Date.UTC(2026, 10, 2) }]);
  assert.ok(text.startsWith('[记忆]'));
  assert.ok(text.includes('原话'));
  assert.ok(text.includes('缓存层要换掉'));
});

test('renderHint: carries the scene when the memory stored one', () => {
  const text = renderHint([
    {
      kind: 'decision',
      summary: '缓存层要换掉',
      t: Date.UTC(2026, 10, 2),
      scene: '当时在聊某段对话太长',
    },
  ]);
  assert.ok(text.includes('当时：当时在聊某段对话太长'));
  assert.ok(text.includes('只有能自然接上'));
  assert.ok(!text.includes('\\n'));
});
