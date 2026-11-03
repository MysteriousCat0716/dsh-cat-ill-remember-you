import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openStore, insertTurn } from '../lib/db.js';
import { queryOf, knownOf, retrieve, renderHint, markRecallUsed } from '../lib/recall.js';

// 单元测试不依赖本机 Ollama：向量路径关闭，纯函数在 embed.test.js 里测。
process.env.DSH_MEMORY_CORE_VECTOR = 'off';

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

test('queryOf: picks the anchor out of the sentence', async () => {
  const query = queryOf('产出/插件/foo.js 这个文件还要改吗');
  assert.ok(query.anchors.includes('产出/插件/foo.js'));
  assert.equal(query.referral, true);
  assert.equal(queryOf('产出/插件/foo.js 还要改吗').referral, false);
});

test('queryOf: detects a referent', async () => {
  assert.equal(queryOf('之前说的那件事结论是什么').referral, true);
});

test('queryOf: 长句里的锚点不在指代片段里也要抽到', async () => {
  const query = queryOf('上次说的那个，lib/recall.js 的缓存问题现在怎么样');
  assert.equal(query.referral, true);
  assert.ok(query.anchors.includes('lib/recall.js'));
});

test('retrieve: 同一锚点命中多条时，按相关度取而不是按时间取', async () => {
  const db = openStore(':memory:');
  const insert = db.prepare(
    `INSERT INTO memories (kind, text, summary, entities, anchors, why, tier, t)
     VALUES ('decision', ?, ?, '[]', ?, '规则提炼：decision', 'active', ?)`,
  );
  // 旧的这条同时提到两个路径，和这轮的话重合更多。
  insert.run(
    'lib/recall.js 和 lib/ingest.js 都要先读再改。',
    '两个文件都要先读再改（旧）',
    JSON.stringify(['lib/recall.js', 'lib/ingest.js']),
    1000,
  );
  // 新的这条只提到一个，但因为更新，旧排序会先选它。
  insert.run(
    'lib/recall.js 的缓存按 mtime 失效。',
    'recall.js 缓存按 mtime 失效（新）',
    JSON.stringify(['lib/recall.js']),
    2000,
  );
  const hits = await retrieve(db, {
    text: 'lib/recall.js 和 lib/ingest.js 这两个文件现在怎么改',
    recent: [],
    now: 3000,
  });
  assert.equal(hits[0].summary.includes('两个文件都要先读再改'), true);
  db.close();
});

test('retrieve: anchor match returns one hit with a written why', async () => {
  const db = makeDb();
  const hits = await retrieve(db, { text: '产出/插件/foo.js 这个文件还要改吗', recent: [] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].source, 'memory');
  assert.ok(hits[0].why.includes('产出/插件/foo.js'));
});

test('retrieve: unrelated sentence gets nothing', async () => {
  const db = makeDb();
  assert.deepEqual(await retrieve(db, { text: '今天天气不错', recent: [] }), []);
});

test('L2 matches anchors literally, so LIKE wildcards do not leak', async () => {
  const db = openStore(':memory:');
  const insert = db.prepare(
    `INSERT INTO memories (kind, text, summary, entities, anchors, why, tier, t)
     VALUES ('fact', '关于这个文件的笔记', ?, '[]', ?, '规则提炼：fact', 'active', 1000)`,
  );
  insert.run('notes_a_b.md', JSON.stringify(['notes_a_b.md']));
  insert.run('notesXaXb.md', JSON.stringify(['notesXaXb.md']));

  const hits = await retrieve(db, { text: 'notes_a_b.md 还要改吗', recent: [] });
  assert.equal(hits.length, 1);
  assert.ok(hits[0].summary.includes('notes_a_b.md'));
  db.close();
});

test('retrieve: 最近上下文里出现过锚点，不代表这条已经给过', async () => {
  const db = makeDb();
  const hits = await retrieve(db, {
    text: '产出/插件/foo.js 这个文件还要改吗',
    recent: ['刚才在说 产出/插件/foo.js'],
  });
  // 旧实现按词面抑制：讨论这个文件时，讲它过去结论的那条反而取不出来。
  assert.equal(hits.length, 1);
});

test('retrieve: 同一会话更早轮次给过的记忆不再给，别的会话不交叉抑制', async () => {
  const db = makeDb();
  const id = Number(db.prepare('SELECT id FROM memories LIMIT 1').get().id);
  db.prepare(
    "INSERT INTO recall_log (sid, turn, t, memory_id, why) VALUES ('s1', 3, ?, ?, 'test')",
  ).run(Date.now(), id);
  const asked = '产出/插件/foo.js 这个文件还要改吗';

  assert.equal((await retrieve(db, { text: asked, sid: 's1', turn: 5 })).length, 0);
  // 同一轮（turn 相等）还没算「给过」，重试要能再拿到。
  assert.equal((await retrieve(db, { text: asked, sid: 's1', turn: 3 })).length, 1);
  // 另一个会话的账不该影响这一轮。
  assert.equal((await retrieve(db, { text: asked, sid: 's2', turn: 5 })).length, 1);
  db.close();
});

test('retrieve: L3 falls back to raw turns only with a referent', async () => {
  const db = openStore(':memory:');
  insertTurn(db, {
    sid: 's1',
    seq: 1,
    role: 'user',
    text: '产出/插件/foo.js 的结论是先不换缓存。',
    t: 500,
  });
  const hits = await retrieve(db, { text: '之前 产出/插件/foo.js 那件事结论是什么', recent: [], now: 1000 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].source, 'turn');
  assert.ok(hits[0].why.includes('产出/插件/foo.js'));
});

test('retrieve: 只有指代、抽不出名词时也要翻原文', async () => {
  const db = openStore(':memory:');
  insertTurn(db, {
    sid: 's1',
    seq: 1,
    role: 'user',
    text: '那件事的结论是先不换缓存，等两天再说。',
    t: 500,
  });
  const hits = await retrieve(db, { text: '你还记得上次那件事吗', recent: [], now: 1000 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].source, 'turn');
  db.close();
});

test('retrieve: L3 只回看同一个 workspace 的原文', async () => {
  const db = openStore(':memory:');
  insertTurn(db, {
    sid: 'a',
    seq: 1,
    role: 'user',
    cwd: 'C:\\work\\a',
    text: '产出/插件/foo.js 的结论是先不换缓存。',
    t: 500,
  });
  insertTurn(db, {
    sid: 'b',
    seq: 1,
    role: 'user',
    cwd: 'D:\\work\\b',
    text: '产出/插件/foo.js 的结论是换掉缓存。',
    t: 600,
  });
  const hits = await retrieve(db, {
    text: '之前 产出/插件/foo.js 那件事结论是什么',
    recent: [],
    now: 1000,
    cwd: 'C:\\work\\a',
  });
  const turns = hits.filter((hit) => hit.source === 'turn');
  assert.equal(turns.length, 1);
  assert.ok(turns[0].text.includes('先不换缓存'));
  db.close();
});

test('retrieve: L3 does not inject the current message as a past turn', async () => {
  const db = openStore(':memory:');
  const text = '刚才那个 lib/recall.js 的缓存问题，现在怎么办？';
  insertTurn(db, { sid: 's1', seq: 1, role: 'user', text, t: 500 });
  const hits = await retrieve(db, { text, recent: [], now: 1000 });
  assert.equal(hits.filter((hit) => hit.source === 'turn').length, 0);
});

test('retrieve: caps hits at two', async () => {
  const db = openStore(':memory:');
  const stmt = db.prepare(
    `INSERT INTO memories (kind, text, summary, entities, anchors, tier, t)
     VALUES ('fact', ?, ?, '[]', ?, 'active', ?)`,
  );
  for (let i = 0; i < 3; i += 1) {
    stmt.run(`缓存第 ${i} 条的结论`, `缓存第 ${i} 条`, JSON.stringify(['产出/插件/foo.js']), 1000 + i);
  }
  const hits = await retrieve(db, { text: '产出/插件/foo.js 还要改吗', recent: [] });
  assert.equal(hits.length, 2);
});

test('retrieve: one question with several answers keeps only the newest', async () => {
  const db = openStore(':memory:');
  const stmt = db.prepare(
    `INSERT INTO memories (kind, text, summary, entities, anchors, tier, t)
     VALUES ('fact', ?, ?, '[]', ?, 'active', ?)`,
  );
  const q = '问：之前那个 lib/recall.js 的 L2 问题，再用一句话讲一遍';
  stmt.run('旧的根因', `${q}｜答：找到根因了`, JSON.stringify(['产出/插件/foo.js']), 1000);
  stmt.run('新的答案', `${q}｜答：用 json_each 精确等值`, JSON.stringify(['产出/插件/foo.js']), 2000);
  const hits = await retrieve(db, { text: '产出/插件/foo.js 还要改吗', recent: [] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].summary, `${q}｜答：用 json_each 精确等值`);
  db.close();
});

test('knownOf: collects anchors and entities', async () => {
  const known = knownOf(['刚才在说 产出/插件/foo.js，猫也提过']);
  assert.ok(known.anchors.has('产出/插件/foo.js'));
  assert.ok(known.entities.has('猫'));
});

test('retrieve: memories from an IM channel are not injected', async () => {
  const db = makeDb();
  db.prepare(
    `INSERT INTO memories (kind, origin, text, summary, entities, anchors, why, tier, t)
     VALUES ('fact', 'im', '朋友在 QQ 里说的缓存方案', '朋友说的缓存', '[]', ?, '规则提炼：fact', 'active', 2000)`,
  ).run(JSON.stringify(['产出/插件/foo.js']));

  const hits = await retrieve(db, { text: '产出/插件/foo.js 还要改吗', recent: [] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].summary, '缓存层要换掉');
  db.close();
});

// —— v0.2.0 分区取回：persona / people / tools ——

test('persona: preferences are injected even when the turn is unrelated', async () => {
  const db = openStore(':memory:');
  db.prepare(
    `INSERT INTO memories (kind, text, summary, entities, anchors, why, tier, t)
     VALUES ('preference', '猫不喜欢豆包味的通用句', '不要豆包味的通用句', '[]', '[]', '规则提炼：preference', 'active', 1000)`,
  ).run();
  const hits = await retrieve(db, { text: '今天天气不错', recent: [] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].section, 'persona');
  assert.ok(hits[0].summary.includes('豆包'));
  db.close();
});

test('persona: total stays within 300 characters', async () => {
  const db = openStore(':memory:');
  const stmt = db.prepare(
    `INSERT INTO memories (kind, text, summary, entities, anchors, why, tier, t)
     VALUES ('preference', ?, ?, '[]', '[]', '规则提炼：preference', 'active', ?)`,
  );
  for (let i = 0; i < 10; i += 1) stmt.run(`第 ${i} 条偏好`, '偏'.repeat(50), 1000 + i);
  const hits = await retrieve(db, { text: '无关', recent: [] });
  const persona = hits.filter((hit) => hit.section === 'persona');
  assert.ok(persona.length <= 8);
  assert.ok(persona.reduce((sum, hit) => sum + hit.summary.length, 0) <= 300);
  db.close();
});

test('persona: a plain decision without a relation cue stays out', async () => {
  const db = makeDb();
  const hits = await retrieve(db, { text: '今天天气不错', recent: [] });
  assert.equal(hits.filter((hit) => hit.section === 'persona').length, 0);
  db.close();
});

test('people: an entity mentioned this turn pulls at most one related memory', async () => {
  const db = openStore(':memory:');
  const stmt = db.prepare(
    `INSERT INTO memories (kind, text, summary, entities, anchors, why, tier, t)
     VALUES ('fact', ?, ?, ?, '[]', '规则提炼：fact', 'active', ?)`,
  );
  stmt.run('猫说缓存方案要换', '猫的缓存方案', JSON.stringify(['猫']), 1000);
  stmt.run('另一件关于猫的事', '另一件关于猫的事', JSON.stringify(['猫']), 2000);
  const hits = await retrieve(db, { text: '猫之前说过的那个方案还要改吗', recent: [] });
  const people = hits.filter((hit) => hit.section === 'people');
  assert.equal(people.length, 1);
  assert.ok(people[0].why.includes('猫'));
  db.close();
});

test('tools: a path anchor pulls the memory that records its usage', async () => {
  const db = openStore(':memory:');
  db.prepare(
    `INSERT INTO memories (kind, text, summary, entities, anchors, why, tier, t)
     VALUES ('fact', '跑测试要串 --experimental-test-isolation=none', '测试要串 isolation 参数', '[]', ?, '规则提炼：fact', 'active', 1000)`,
  ).run(JSON.stringify(['产出/插件/foo.js']));
  const hits = await retrieve(db, { text: '产出/插件/foo.js 这个文件还要改吗', recent: [] });
  const tools = hits.filter((hit) => hit.section === 'tools');
  assert.equal(tools.length, 1);
  assert.ok(tools[0].why.includes('产出/插件/foo.js'));
  db.close();
});

test('sections: people and tools each take at most one of the two slots', async () => {
  const db = openStore(':memory:');
  const mem = db.prepare(
    `INSERT INTO memories (kind, text, summary, entities, anchors, why, tier, t)
     VALUES ('fact', ?, ?, ?, ?, '规则提炼：fact', 'active', ?)`,
  );
  mem.run('猫说 foo.js 上次的坑', '猫说 foo.js 的坑', JSON.stringify(['猫']), JSON.stringify(['产出/插件/foo.js']), 1000);
  mem.run('另一件猫的事', '另一件猫的事', JSON.stringify(['猫']), JSON.stringify([]), 2000);
  mem.run('另一件 foo.js 的事', '另一件 foo.js 的事', JSON.stringify([]), JSON.stringify(['产出/插件/foo.js']), 3000);
  const hits = await retrieve(db, { text: '产出/插件/foo.js 猫之前说的那个坑还记得吗', recent: [] });
  assert.ok(hits.filter((hit) => hit.section === 'people').length <= 1);
  assert.ok(hits.filter((hit) => hit.section === 'tools').length <= 1);
  assert.ok(hits.length <= 2);
  db.close();
});

test('persona: a preference is not fetched twice by the on-demand layers', async () => {
  const db = openStore(':memory:');
  db.prepare(
    `INSERT INTO memories (kind, text, summary, entities, anchors, why, tier, t)
     VALUES ('preference', '关于 产出/插件/foo.js 的偏好', '关于 foo.js 的偏好', '[]', ?, '规则提炼：preference', 'active', 1000)`,
  ).run(JSON.stringify(['产出/插件/foo.js']));
  const hits = await retrieve(db, { text: '产出/插件/foo.js 还要改吗', recent: [] });
  const persona = hits.filter((hit) => hit.section === 'persona');
  assert.equal(persona.length, 1);
  assert.equal(hits.filter((hit) => hit.section !== 'persona' && hit.id === persona[0].id).length, 0);
  db.close();
});

test('renderHint: persona and on-demand hits get separate sections', async () => {
  const text = renderHint([
    { kind: 'preference', summary: '不要豆包味', t: Date.UTC(2026, 10, 2), section: 'persona' },
    { kind: 'fact', summary: '缓存层要换掉', t: Date.UTC(2026, 10, 2) },
  ]);
  assert.ok(text.includes('[常驻]'));
  assert.ok(text.includes('[这轮]'));
  assert.ok(text.indexOf('[常驻]') < text.indexOf('[这轮]'));
});

test('renderHint: renders a gated hint and nothing when empty', async () => {
  assert.equal(renderHint([]), '');
  const text = renderHint([{ kind: 'user', summary: '缓存层要换掉', t: Date.UTC(2026, 10, 2) }]);
  assert.ok(text.startsWith('[记忆]'));
  assert.ok(text.includes('原话'));
  assert.ok(text.includes('缓存层要换掉'));
});

test('renderHint: reported memories are marked as retold, explicit ones are not', async () => {
  const text = renderHint([
    { kind: 'fact', summary: '缓存层要换掉', t: Date.UTC(2026, 10, 2), confidence: 'reported' },
    { kind: 'fact', summary: '这个是原话', t: Date.UTC(2026, 10, 2), confidence: 'explicit' },
  ]);
  assert.ok(text.includes('转述'));
  assert.equal(text.split('转述').length - 1, 1);
});

test('renderHint: carries the scene when the memory stored one', async () => {
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

test('retrieve: 零锚点时用句中的实词做一次弱匹配', async () => {
  const db = openStore(':memory:');
  db.prepare(
    `INSERT INTO memories (kind, text, summary, entities, anchors, why, tier, t)
     VALUES ('fact', '缓存层太重，决定先不换。', '缓存层先不换', '[]', '[]', '规则提炼：fact', 'active', 1000)`,
  ).run();
  const hits = await retrieve(db, { text: '继续改缓存层' });
  assert.equal(hits.length, 1);
  assert.ok(hits[0].why.includes('弱匹配'));
  assert.ok(hits[0].summary.includes('缓存层'));
  db.close();
});

test('retrieve: 有锚点时走正常匹配，不标弱匹配', async () => {
  const db = makeDb();
  const hits = await retrieve(db, { text: '产出/插件/foo.js 还要改吗' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].why.includes('弱匹配'), false);
  db.close();
});

test('markRecallUsed: 回复里出现取回过的锚点才算用了，没出现的不动', () => {
  const db = openStore(':memory:');
  const memory = db
    .prepare(
      `INSERT INTO memories (kind, text, summary, entities, anchors, why, tier, t)
       VALUES ('decision', '缓存按 mtime 失效。', '缓存按 mtime 失效', '[]', ?, '规则提炼：decision', 'active', 1000)`,
    )
    .run(JSON.stringify(['lib/recall.js']));
  const memoryId = Number(memory.lastInsertRowid);
  const log = db
    .prepare('INSERT INTO recall_log (sid, turn, t, memory_id, why) VALUES (?, ?, ?, ?, ?)')
    .run('s1', 3, 1100, memoryId, '本周提到过这个文件');
  const logId = Number(log.lastInsertRowid);

  // 回复没提这个文件：不算用上。
  assert.equal(markRecallUsed(db, { sid: 's1', text: '好，那就先不动。' }), 0);
  assert.equal(db.prepare('SELECT used FROM recall_log WHERE id = ?').get(logId).used, null);

  // 别的会话提到也不算：抑制和回填都按 sid 隔离。
  assert.equal(markRecallUsed(db, { sid: 's2', text: 'lib/recall.js 改了没' }), 0);

  // 同会话回复里真的说了这个文件：回填 used=1。
  assert.equal(markRecallUsed(db, { sid: 's1', text: 'lib/recall.js 的缓存已经按 mtime 失效。' }), 1);
  assert.equal(db.prepare('SELECT used FROM recall_log WHERE id = ?').get(logId).used, 1);
  // 已标记的不重复计数。
  assert.equal(markRecallUsed(db, { sid: 's1', text: 'lib/recall.js 再确认一次。' }), 0);
  db.close();
});

test('retrieve: 沉睡（dormant）的记忆带锚点也能取回，取回后回升 active', async () => {
  const db = openStore(':memory:');
  const info = db
    .prepare(
      `INSERT INTO memories (kind, text, summary, entities, anchors, why, tier, t)
       VALUES ('fact', 'lib/recall.js 的缓存按 mtime 失效。', 'recall.js 缓存按 mtime 失效',
               '[]', ?, '规则提炼：fact', 'dormant', 1000)`,
    )
    .run(JSON.stringify(['lib/recall.js']));
  const id = Number(info.lastInsertRowid);
  const hits = await retrieve(db, {
    text: 'lib/recall.js 的缓存现在怎么取值',
    recent: [],
    now: 2000,
  });
  assert.ok(hits.some((hit) => hit.id === id), '沉睡的相关记忆应该能被召回');
  assert.equal(db.prepare('SELECT tier FROM memories WHERE id = ?').get(id).tier, 'active');
  db.close();
});

test('retrieve: 弱匹配按稀有词选，不按新旧选', async () => {
  const db = openStore(':memory:');
  const insert = db.prepare(
    `INSERT INTO memories (kind, text, summary, entities, anchors, why, tier, t)
     VALUES ('fact', ?, ?, '[]', '[]', '规则提炼：fact', 'active', ?)`,
  );
  // 常见词 cache：6 条都有，最新的一条 t 最大。
  for (let i = 0; i < 6; i += 1) {
    insert.run(`cache 的第 ${i} 个说明。`, `cache 说明 ${i}`, 1000 + i);
  }
  // 稀有词 idempotent：只有这一条，而且最旧。
  insert.run('idempotent 的操作重复跑也不会变。', '幂等操作', 900);
  const hits = await retrieve(db, {
    text: 'cache idempotent 现在哪个更要紧',
    recent: [],
    now: 5000,
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].summary, '幂等操作');
  db.close();
});
