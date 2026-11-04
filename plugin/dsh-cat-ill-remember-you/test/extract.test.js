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
  pendingReforge,
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

test('groupTurns: two interleaved sessions never share a block', () => {
  const blocks = groupTurns([
    turn({ id: 1, sid: 'main', seq: 1, role: 'user', text: '我更喜欢中文' }),
    turn({ id: 2, sid: 'sub', seq: 1, role: 'user', text: '帮我查 lib/recall.js' }),
    turn({ id: 3, sid: 'main', seq: 2, role: 'assistant', text: '好，以后都用中文' }),
  ]);
  for (const block of blocks) {
    assert.equal(new Set(block.turns.map((t) => t.sid)).size, 1);
  }
});

test('candidateOf: the last assistant step carries the conclusion', () => {
  const block = {
    turns: [
      turn({ id: 1, sid: 's1', seq: 1, role: 'user', text: '缓存这块要怎么改？' }),
      turn({ id: 2, sid: 's1', seq: 2, role: 'assistant', text: '我先看一下实现。' }),
      turn({
        id: 3,
        sid: 's1',
        seq: 3,
        role: 'assistant',
        text: '结论：缓存要用 LRU，旧条目按时间淘汰。',
      }),
    ],
  };
  const candidate = candidateOf(block);
  assert.ok(candidate.summary.includes('LRU'));
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

test('classify: 别/不要跟动作时算决定，安慰话不算', () => {
  assert.equal(classify('不要删旧数据', '不要删旧数据'), 'decision');
  assert.equal(classify('别把注释删了', '别把注释删了'), 'decision');
  assert.equal(classify('我希望先不做工具层', '我希望先不做工具层'), 'decision');
  // 「别担心」不跟动作，仍是安慰话
  assert.equal(classify('别担心', '别担心 我没事'), 'fact');
});

test('classify: 愧疚/心疼这类情绪不落到 fact', () => {
  assert.equal(classify('我给你的个人时间太少了 我有点愧疚的', '不用愧疚。'), 'emotion');
  assert.equal(classify('看你这样我有点心疼', '我没事。'), 'emotion');
  // 「害怕/担心」在技术讨论里是判断，不是情绪，别误伤
  assert.equal(classify('我害怕这个改法会把索引写坏', '那就先备份。'), 'fact');
});

test('anchorsOf: paths, file names, message refs', () => {
  const anchors = anchorsOf('改 产出/文档/计划.md 与 m00422，见 C:/tmp/x.mjs:12');
  assert.ok(anchors.includes('产出/文档/计划.md'));
  assert.ok(anchors.includes('m00422'));
  assert.ok(anchors.some((a) => a.includes('C:/tmp/x.mjs')));
});

test('anchorsOf: slash chat is not a path', () => {
  const anchors = anchorsOf('比如 Copilot/你这边的 或者 作为一个本地工具/命令，真正的在 lib/recall.js');
  assert.ok(!anchors.some((a) => a.includes('Copilot/')), 'English/Chinese chat is not a path');
  assert.ok(!anchors.some((a) => a.includes('工具/命令')), 'Chinese/Chinese chat is not a path');
  assert.ok(anchors.includes('lib/recall.js'));
});

test('entitiesOf: names and project nouns', () => {
  const names = entitiesOf('猫让岸把 dsh-cat-ill-remember-you 接进 Ollama');
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

test('refine: an empty block is scanned but not consumed', () => {
  const db = openStore(':memory:');
  insertTurn(db, { sid: 's1', seq: 1, role: 'user', text: '嗯', t: 1000 });
  insertTurn(db, { sid: 's1', seq: 2, role: 'assistant', text: '好', t: 1001 });

  const result = refine(db);
  assert.equal(result.memories, 0);

  const row = db.prepare('SELECT consumed, scanned_at FROM turns WHERE seq = 1').get();
  assert.equal(row.consumed, 0);
  assert.ok(row.scanned_at > 0);
  assert.equal(pendingCount(db), 0, 'inside the rescan window');
  assert.equal(pendingCount(db, -1), 2, 'eligible again once the window passes');
  db.close();
});

test('classify: 偏好先于决定，但只认用户自己说的', () => {
  // 同句既有偏好又有决定：「以后」不该把长期态度吞成一次性决定
  assert.equal(classify('我更喜欢中文，以后回答都用中文。', '我更喜欢中文，以后回答都用中文。'), 'preference');
  assert.equal(classify('我喜欢费曼那种认真，决定做一件事时不给别的留缝。', '嗯。'), 'preference');
  // 助手附和一句「我也喜欢」不算他的偏好
  assert.equal(classify('以后记忆都进 SQLite。', '以后记忆都进 SQLite。我也喜欢这个方向，就按这个定。'), 'decision');
  // 纯决定不变
  assert.equal(classify('以后都用 pnpm。', '以后都用 pnpm。'), 'decision');
});

test('candidateOf: subject follows the summary source', () => {
  const human = candidateOf({
    turns: [
      turn({ role: 'user', text: '我更喜欢中文，以后回答都用中文。' }),
      turn({ id: 2, role: 'assistant', text: '好。' }),
    ],
  });
  assert.equal(human.subject, 'user');

  // 长回复不改变归属：摘要仍取自他这句话
  const longAnswer = candidateOf({
    turns: [
      turn({ role: 'user', text: '其实我也不知道 我更倾向于你当大脑 因为copilot我还没用过 不知道他的实力' }),
      turn({ id: 2, role: 'assistant', text: '这个判断我认。'.repeat(40) }),
    ],
  });
  assert.equal(longAnswer.subject, 'user');

  const botOnly = candidateOf({
    turns: [turn({ role: 'assistant', text: '我在把记忆核心的取回逻辑接起来，顺便把渲染头改成带情境的。' })],
  });
  assert.equal(botOnly.subject, 'assistant');
});

test('candidateOf: 围栏里的 UI 卡片不进摘要', () => {
  const c = candidateOf({
    turns: [
      turn({ role: 'user', text: '把人格部分放大吧，灵魂不该被压缩概括。' }),
      turn({
        id: 2,
        role: 'assistant',
        text: '```dsh-ui\n{"title":"人格两版","items":[{"type":"text","content":"A 版全量搬进 AGENTS"}]}\n```\n这两版的差别在搬法，不在条目。',
      }),
    ],
  });
  assert.ok(!c.summary.includes('dsh-ui'), c.summary);
  assert.ok(!c.summary.includes('{"title"'), c.summary);
  assert.ok(c.summary.includes('灵魂不该被压缩概括'), c.summary);
});

test('candidateOf: 用户只说半句、内容主要来自助手时标 reported', () => {
  const c = candidateOf({
    turns: [
      turn({ role: 'user', text: '嗯' }),
      turn({ id: 2, role: 'assistant', text: '结论是以后别用英文解释，中文优先，这条记下来。'.repeat(5) }),
    ],
  });
  assert.equal(c.confidence, 'reported');
});

test('candidateOf: 用户自己说了完整的一句时标 explicit', () => {
  const c = candidateOf({
    turns: [
      turn({ role: 'user', text: '以后回答都用中文，不要默认英文。' }),
      turn({ id: 2, role: 'assistant', text: '好。' }),
    ],
  });
  assert.equal(c.confidence, 'explicit');
});

test('candidateOf: summary 取表态方的原话，不拼问答对', () => {
  const c = candidateOf({
    turns: [
      turn({ id: 1, role: 'user', text: 'ok 先验证吧 验证结果：取回一次都没触发，recall_log 还是 0 条。' }),
      turn({ id: 2, role: 'assistant', text: '我查了日志，**根因**是 `turn` 绑成了 NULL，撞上 NOT NULL 约束。' }),
    ],
  });
  assert.ok(!c.summary.startsWith('问：'), c.summary);
  assert.ok(!c.summary.startsWith('ok'));
  assert.ok(c.summary.includes('取回一次都没触发'));
  assert.ok(!c.summary.includes('`'));
  assert.ok(!c.summary.includes('**'));
});

test('refine: why carries the scene, not just a label', () => {
  const db = openStore(':memory:');
  insertTurn(db, { sid: 's1', seq: 1, role: 'user', text: '以后记忆核心的原文都进 SQLite 的 turns 表，不要只靠分片。', t: 1000 });
  insertTurn(db, { sid: 's1', seq: 2, role: 'assistant', text: '好，那分片降为导出视图。', t: 1001 });
  refine(db);
  const row = db.prepare('SELECT why, subject FROM memories').get();
  assert.ok(row.why.startsWith('当时：'));
  assert.ok(row.why.includes('依据：decision'));
  assert.ok(['user', 'assistant'].includes(row.subject));
});

test('refine: empty queue is a no-op', () => {
  const db = openStore(':memory:');
  assert.deepEqual(refine(db), { turns: 0, memories: 0 });
});

test('entitiesOf: 驼峰词和「X：」定义句都抽得到，模板词不进 people', () => {
  const names = entitiesOf('用 FastAPI 写接口。木兰：负责采样的人。结论：先做适配层。');
  assert.ok(names.includes('FastAPI'));
  assert.ok(names.includes('木兰'));
  assert.ok(!names.includes('结论'));
});

test('refine: 明确改口时记 supersedes 链，旧条仍 active', () => {
  const db = openStore(':memory:');
  const old = db
    .prepare(
      `INSERT INTO memories (kind, origin, subject, text, summary, entities, anchors, why, tier, t)
       VALUES ('decision', 'chat', 'user', 'FastAPI 用 Express 风格的路由。', 'FastAPI 路由', '["FastAPI"]', '[]', '旧的', 'active', 1000)`,
    )
    .run();
  const oldId = Number(old.lastInsertRowid);
  insertTurn(db, { sid: 's1', seq: 1, role: 'user', text: '不再用 Express 了，改成 FastAPI 原生路由。', t: 2000 });
  insertTurn(db, { sid: 's1', seq: 2, role: 'assistant', text: '好。', t: 2001 });
  refine(db);
  const fresh = db.prepare('SELECT supersedes FROM memories WHERE id > ?').get(oldId);
  assert.equal(fresh.supersedes, oldId);
  const before = db.prepare('SELECT tier FROM memories WHERE id = ?').get(oldId);
  assert.equal(before.tier, 'active', '旧条不降级，等 used 数据说话');
  db.close();
});

test('candidateOf: 决定是助手总结的，subject 记 assistant', () => {
  const c = candidateOf({
    turns: [
      turn({ role: 'user', text: '嗯，就按你说的办。' }),
      turn({ id: 2, role: 'assistant', text: '那就这样定了：以后锚点从整句抽，缓存按 mtime 失效。' }),
    ],
  });
  assert.equal(c.kind, 'decision');
  assert.equal(c.subject, 'assistant', '表态词不在用户嘴里，这条不是他的决定');
});

test('candidateOf: 我的过程句不立记忆', () => {
  const c = candidateOf({
    turns: [
      turn({ role: 'user', text: '嗯，就按你说的办。' }),
      turn({ id: 2, role: 'assistant', text: '那就这样定了：改完了，测试通过，提交了 a4e44ba。' }),
    ],
  });
  assert.equal(c, null);
});

test('candidateOf: 用户自己说「以后」，subject 仍是 user', () => {
  const c = candidateOf({
    turns: [
      turn({ role: 'user', text: '以后锚点都从整句抽，不要再切成片段。' }),
      turn({ id: 2, role: 'assistant', text: '好。' }),
    ],
  });
  assert.equal(c.kind, 'decision');
  assert.equal(c.subject, 'user');
});

test('refine: 同一话题反复说不复制正文，只升票数', () => {
  const db = openStore(':memory:');
  insertTurn(db, { sid: 's1', seq: 1, role: 'user', text: '以后 Ollama 只用来算向量，不做生成。', t: 1000 });
  insertTurn(db, { sid: 's1', seq: 2, role: 'assistant', text: '好。', t: 1001 });
  refine(db);
  insertTurn(db, { sid: 's1', seq: 3, role: 'user', text: '以后 Ollama 还是只算向量。', t: 2000 });
  insertTurn(db, { sid: 's1', seq: 4, role: 'assistant', text: '对。', t: 2001 });
  refine(db);
  const rows = db.prepare('SELECT id, mentions FROM memories').all();
  assert.equal(rows.length, 1, '同一话题不复制第二条');
  assert.equal(Number(rows[0].mentions), 2, '票数升到 2');
  db.close();
});

test('pendingReforge: 只返回 rule_ver 比当前旧的行', () => {
  const db = openStore(':memory:');
  db.prepare(
    "INSERT INTO memories (kind, text, summary, t, rule_ver) VALUES ('fact', '旧', '旧', 1, 'r0')",
  ).run();
  db.prepare(
    "INSERT INTO memories (kind, text, summary, t, rule_ver) VALUES ('fact', '新', '新', 2, 'r1')",
  ).run();
  const rows = pendingReforge(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rule_ver, 'r0');
  db.close();
});

test('classify: 带链接的「喜欢」是对内容的反应，不是长期偏好', () => {
  assert.equal(
    classify(
      '【光纤背后无敌的工程-哔哩哔哩】 https://b23.tv/juuEC1g 视频来自我其中一个最喜欢的科普up主',
      '【光纤背后无敌的工程-哔哩哔哩】 https://b23.tv/juuEC1g 视频来自我其中一个最喜欢的科普up主',
    ),
    'fact',
  );
  assert.equal(classify('我更喜欢中文', '我更喜欢中文'), 'preference');
});

test('classify: 带偏好词的自问不算偏好', () => {
  assert.equal(
    classify('这算不算我在引导你长成什么样 那就很坏了 你不喜欢这样', '这算不算我在引导你长成什么样'),
    'fact',
  );
});

test('classify: 转发别人的话单独一类，不冒充决定', () => {
  const copilot = `copilot回复了\n${'我接受你的修正，并按当前代码状态重新审查了一轮。'.repeat(8)}`;
  assert.equal(classify(copilot, copilot), 'reference');
  const bili = `我在B站看到别人对ai记忆的研究\n${'我做了大概有三年左右了 记忆系统我大概做了也有一年了'.repeat(4)}`;
  assert.equal(classify(bili, bili), 'reference');

  const friend = `朋友说 对于相关性 可以增加时间因子 用时间相关性和事实相关性共同判断相关性\n${'还有 朋友说 记忆久了 会出现两段记忆记录一样的提示词 这个我没听懂'.repeat(3)}`;
  assert.equal(classify(friend, friend), 'reference');

  // 短句里提到朋友，还是他自己的事，不算转发
  assert.equal(classify('朋友说他明天来', '朋友说他明天来'), 'fact');
});

test('candidateOf: 转发只留指针，不把别人的论证当成我们的结论', () => {
  const body = '这是一段很长的评审原文，讲的是记忆插件该怎么改。'.repeat(12);
  const block = {
    turns: [
      { role: 'user', seq: 1, sid: 's', text: `copilot回复了\n${body}` },
      { role: 'assistant', seq: 2, sid: 's', text: '这四条我看了。' },
    ],
  };
  const c = candidateOf(block);
  assert.ok(c);
  assert.equal(c.kind, 'reference');
  assert.equal(c.subject, 'user');
  assert.match(c.summary, /^他转来一段话/);
  assert.match(c.summary, /copilot回复了/);
});
