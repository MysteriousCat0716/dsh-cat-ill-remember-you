import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../lib/db.js';
import { ingestEvent, flushImmediate } from '../lib/ingest.js';
import { classify, wantsImmediate } from '../lib/extract.js';

const RPC = '3f1c2d7e-1a2b-4c3d-8e9f-0123456789ab';

function userEvent({ seq, text }) {
  return {
    type: 'user/message',
    seq,
    time: 1000 + seq,
    data: {
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user', rpcId: RPC },
    },
  };
}

function assistantEvent({ seq, text }) {
  return {
    type: 'assistant/message',
    seq,
    time: 1000 + seq,
    data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
  };
}

test('即时通道：多步回复在静默窗内一条不炼，flush 后只炼一条并标 consumed', () => {
  const db = openStore(':memory:');
  const session = { id: 's1', header: { cwd: '/w' } };

  ingestEvent(db, session, userEvent({ seq: 1, text: '以后都用 pnpm，不要 npm' }));
  // 多步回复：第一条常是「我看看」，结论在最后一条。
  ingestEvent(db, session, assistantEvent({ seq: 2, text: '我先看一下 lock 文件。' }));
  ingestEvent(db, session, assistantEvent({ seq: 3, text: '改成 pnpm 了。' }));
  ingestEvent(
    db,
    session,
    assistantEvent({ seq: 4, text: '好，以后统一用 pnpm，不再用 npm 装这个仓库。' }),
  );

  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM memories').get().n,
    0,
    '静默窗内不该炼',
  );

  flushImmediate(db, 's1');

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 1);
  const row = db.prepare('SELECT rule_ver, supersedes, confidence FROM memories').get();
  assert.equal(row.rule_ver, 'r1');
  assert.equal(row.supersedes, null);
  // 三条 assistant 必须跟着 user 一起 consumed，否则空闲批会把它们组成
  // assistant 开头的孤儿块，同一句话立两条记忆、第二条归属还错。
  const consumed = db.prepare('SELECT seq, consumed FROM turns ORDER BY seq').all();
  assert.deepEqual(
    consumed.map((r) => [r.seq, r.consumed]),
    [
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
    ],
  );
  db.close();
});

test('即时通道：不表态的 user 不触发', () => {
  const db = openStore(':memory:');
  const session = { id: 's2', header: { cwd: '/w' } };
  ingestEvent(db, session, userEvent({ seq: 1, text: '今天天气不错' }));
  ingestEvent(db, session, assistantEvent({ seq: 2, text: '是挺好的。' }));
  flushImmediate(db, 's2');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 0);
  db.close();
});

test('即时通道：回复还没落库时保留待办，下一条 assistant 落库后再炼', () => {
  const db = openStore(':memory:');
  const session = { id: 's3', header: { cwd: '/w' } };

  ingestEvent(db, session, userEvent({ seq: 1, text: '以后都用 pnpm，不要 npm' }));
  flushImmediate(db, 's3');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM memories').get().n,
    0,
    '只有问句，不该炼',
  );

  ingestEvent(
    db,
    session,
    assistantEvent({ seq: 2, text: '好，以后统一用 pnpm，不再用 npm 装这个仓库。' }),
  );
  flushImmediate(db, 's3');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 1);
  db.close();
});

test('即时通道：命中表态词但 classify 判 fact 的块不插、不 consumed，交回空闲批', () => {
  const db = openStore(':memory:');
  const session = { id: 's4', header: { cwd: '/w' } };
  const text = '原则上明天要交，别拖了';
  assert.equal(wantsImmediate(text), true, 'JUDGE 会命中');
  assert.equal(classify(text, text), 'fact', '但 classify 判 fact');

  ingestEvent(db, session, userEvent({ seq: 1, text }));
  ingestEvent(
    db,
    session,
    assistantEvent({ seq: 2, text: '那就今晚先把能交的部分整理出来，明早补完剩下的。' }),
  );
  flushImmediate(db, 's4');

  // 不插、不 consumed：这块还给空闲批，由它按自己的规则决定收不收。
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 0);
  const rows = db.prepare('SELECT seq, consumed FROM turns ORDER BY seq').all();
  assert.deepEqual(
    rows.map((r) => [r.seq, r.consumed]),
    [
      [1, 0],
      [2, 0],
    ],
  );
  // 待办也要清空，否则下一条 assistant 落库会再触发一次无用的即时通道。
  assert.equal(flushImmediate(db, 's4').memories, 0);
  db.close();
});

test('wantsImmediate 只认表态句', () => {
  assert.equal(wantsImmediate('以后别用 npm'), true);
  assert.equal(wantsImmediate('今天天气不错'), false);
});

test('子代理会话的派工单与报告都不入库', () => {
  const db = openStore(':memory:');
  // 子代理会话的 header 带 origin='subagent'；消息本身仍可能挂着
  // source.kind='user' + UUID rpcId（originOf 会判成 chat），所以判据必须看会话。
  const session = {
    id: 'sub-1',
    header: { cwd: '/w', origin: 'subagent', parentSession: 'session-p' },
  };

  const n1 = ingestEvent(db, session, userEvent({ seq: 1, text: '你是只读审计员，审这段代码的缺陷。' }));
  const n2 = ingestEvent(db, session, assistantEvent({ seq: 2, text: '### [major] 这里会漏掉空数组。' }));

  assert.equal(n1, 0);
  assert.equal(n2, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM turns').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 0);
  db.close();
});
