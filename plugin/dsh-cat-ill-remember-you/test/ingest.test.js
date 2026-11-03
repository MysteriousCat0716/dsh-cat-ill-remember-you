import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../lib/db.js';
import { ingestEvent } from '../lib/ingest.js';
import { wantsImmediate } from '../lib/extract.js';

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

test('即时通道：user 表态 + assistant 落库后立刻炼一条，并标 consumed', () => {
  const db = openStore(':memory:');
  const session = { id: 's1', header: { cwd: '/w' } };

  ingestEvent(db, session, userEvent({ seq: 1, text: '以后都用 pnpm，不要 npm' }));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 0);

  ingestEvent(
    db,
    session,
    assistantEvent({ seq: 2, text: '好，以后统一用 pnpm，不再用 npm 装这个仓库。' }),
  );

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 1);
  const row = db.prepare('SELECT rule_ver, supersedes, confidence FROM memories').get();
  assert.equal(row.rule_ver, 'r1');
  assert.equal(row.supersedes, null);
  assert.equal(db.prepare('SELECT consumed FROM turns WHERE seq = 1').get().consumed, 1);
  db.close();
});

test('即时通道：不表态的 user 不触发', () => {
  const db = openStore(':memory:');
  const session = { id: 's2', header: { cwd: '/w' } };
  ingestEvent(db, session, userEvent({ seq: 1, text: '今天天气不错' }));
  ingestEvent(db, session, assistantEvent({ seq: 2, text: '是挺好的。' }));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 0);
  db.close();
});

test('wantsImmediate 只认表态句', () => {
  assert.equal(wantsImmediate('以后别用 npm'), true);
  assert.equal(wantsImmediate('今天天气不错'), false);
});
