import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openStore, insertTurn, pendingTurns, markConsumed, markScanned } from '../lib/db.js';
import { textOf, ingestEvent } from '../lib/ingest.js';

function freshStore() {
  return openStore(':memory:');
}

test('schema creates all thirteen tables', () => {
  const db = freshStore();
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => row.name)
    .sort();
  assert.deepEqual(names, [
    'context_stack',
    'embeddings',
    'entities',
    'forget_log',
    'memories',
    'people',
    'persona',
    'recall_log',
    'recall_trace',
    'runs',
    'shadow_log',
    'shadow_v2',
    'turns',
  ]);
  db.close();
});

test('insertTurn stores text and deduplicates on (sid, seq, role)', () => {
  const db = freshStore();
  const row = { sid: 's1', seq: 1, role: 'user', text: '你好', t: 1000 };
  assert.equal(insertTurn(db, row), 1);
  assert.equal(insertTurn(db, row), 0);

  const rows = db.prepare('SELECT sid, seq, role, text, consumed FROM turns').all();
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0] }, { sid: 's1', seq: 1, role: 'user', text: '你好', consumed: 0 });
  db.close();
});

test('same seq can hold a user and an assistant turn', () => {
  const db = freshStore();
  assert.equal(insertTurn(db, { sid: 's1', seq: 5, role: 'user', text: 'q', t: 1 }), 1);
  assert.equal(insertTurn(db, { sid: 's1', seq: 6, role: 'assistant', text: 'a', t: 2 }), 1);
  assert.equal(pendingTurns(db).length, 2);
  db.close();
});

test('pendingTurns returns oldest first and markConsumed clears them', () => {
  const db = freshStore();
  for (let i = 1; i <= 3; i += 1) {
    insertTurn(db, { sid: 's', seq: i, role: 'user', text: `m${i}`, t: i });
  }
  const pending = pendingTurns(db);
  assert.deepEqual(pending.map((r) => r.text), ['m1', 'm2', 'm3']);

  assert.equal(markConsumed(db, [pending[0].id, pending[1].id]), 2);
  assert.deepEqual(pendingTurns(db).map((r) => r.text), ['m3']);
  db.close();
});

test('a scanned turn stays out of the queue until its rescan window passes', () => {
  const db = freshStore();
  insertTurn(db, { sid: 's', seq: 1, role: 'user', text: '嗯', t: 1 });
  assert.equal(pendingTurns(db).length, 1);

  markScanned(db, [1]);
  assert.equal(pendingTurns(db).length, 0);
  assert.equal(pendingTurns(db, 40, -1).length, 1);
  db.close();
});

test('textOf extracts text blocks only', () => {
  assert.equal(
    textOf({
      role: 'user',
      content: [
        { type: 'text', text: '第一行' },
        { type: 'thinking', text: '内部思考' },
        { type: 'image', data: 'x' },
        { type: 'text', text: '第二行' },
      ],
    }),
    '第一行\n第二行',
  );
  assert.equal(textOf({ role: 'user', content: '纯字符串' }), '纯字符串');
  assert.equal(textOf(null), '');
  assert.equal(textOf({ content: [{ type: 'tool_call' }] }), '');
});

test('ingestEvent stores user and assistant messages, skips notices and turn/end', () => {
  const db = freshStore();
  const session = { id: 'sess-1' };

  const userEvent = {
    type: 'user/message',
    seq: 10,
    time: 5000,
    data: { role: 'user', content: [{ type: 'text', text: '岸姐' }] },
  };
  const assistantEvent = {
    type: 'assistant/message',
    seq: 12,
    time: 5100,
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '在。' }] } },
  };
  const noticeEvent = {
    type: 'user/message',
    seq: 11,
    time: 5050,
    data: { role: 'user', content: [{ type: 'text', text: '[记忆提示] 以前记过的东西' }] },
  };
  const endEvent = { type: 'turn/end', seq: 13, time: 5200, data: { turn: 1, reason: { kind: 'stop' } } };

  assert.equal(ingestEvent(db, session, userEvent), 1);
  assert.equal(ingestEvent(db, session, assistantEvent), 1);
  assert.equal(ingestEvent(db, session, noticeEvent), 0);
  assert.equal(ingestEvent(db, session, endEvent), 0);
  assert.equal(ingestEvent(db, session, userEvent), 0); // replay is a no-op

  const rows = db
    .prepare('SELECT seq, role, text, t FROM turns ORDER BY seq')
    .all()
    .map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { seq: 10, role: 'user', text: '岸姐', t: 5000 },
    { seq: 12, role: 'assistant', text: '在。', t: 5100 },
  ]);
  db.close();
});

test('ingestEvent trusts source.kind: only human input is stored', () => {
  const db = freshStore();
  const session = { id: 's' };

  const human = {
    type: 'user/message',
    seq: 20,
    time: 6000,
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '真的话' }] },
  };
  const runtime = {
    type: 'user/message',
    seq: 21,
    time: 6100,
    data: {
      role: 'user',
      source: { kind: 'runtime-context' },
      content: [{ type: 'text', text: 'MNEMON RUNTIME MEMORY SNAPSHOT ...' }],
    },
  };
  const legacyNotice = {
    type: 'user/message',
    seq: 22,
    time: 6200,
    data: { role: 'user', content: [{ type: 'text', text: '[记忆提示] 旧事件' }] },
  };
  const delegated = {
    type: 'user/message',
    seq: 23,
    time: 6300,
    data: {
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '[dsh-mnemon:delegated review] Bounded completed checkpoint' }],
    },
  };

  assert.equal(ingestEvent(db, session, human), 1);
  assert.equal(ingestEvent(db, session, runtime), 0);
  assert.equal(ingestEvent(db, session, legacyNotice), 0);
  // 前缀黑名单优先于 source.kind：机器串即使标成 user 也不入库
  assert.equal(ingestEvent(db, session, delegated), 0);

  // 旧替换块没有 source 字段，靠前缀黑名单挡住
  const legacyReplacement = {
    type: 'user/message',
    seq: 24,
    time: 6400,
    data: {
      role: 'user',
      content: [{ type: 'text', text: '[上下文替换] 更早的 14 条消息（seq 8-92）原文在本地' }],
    },
  };
  assert.equal(ingestEvent(db, session, legacyReplacement), 0);

  const rows = db.prepare('SELECT seq, text FROM turns').all();
  assert.deepEqual(rows.map((row) => ({ ...row })), [{ seq: 20, text: '真的话' }]);
  db.close();
});

test('ingestEvent tolerates malformed events without throwing', () => {
  const db = freshStore();
  const session = { id: 's' };
  assert.equal(ingestEvent(db, session, null), 0);
  assert.equal(ingestEvent(db, session, { type: 'user/message' }), 0);
  assert.equal(ingestEvent(db, session, { type: 'assistant/message', data: {} }), 0);
  db.close();
});

test('ingestEvent marks the channel as origin', () => {
  const db = freshStore();
  const session = { id: 's' };
  const event = (seq, rpcId, text) => ({
    type: 'user/message',
    seq,
    time: seq * 100,
    data: { role: 'user', source: { kind: 'user', rpcId }, content: [{ type: 'text', text }] },
  });

  // 桌面/GUI 的 rpcId 是 UUID；IM 通道带 bot/通道前缀；无 rpcId 记 unknown。
  ingestEvent(db, session, event(1, 'c587b222-660e-4502-ac18-fbfc8357ce14', '桌面上说的'));
  ingestEvent(db, session, event(2, 'ds-bot-abc', 'QQ 里说的'));
  ingestEvent(db, session, event(3, undefined, '没来源的'));
  ingestEvent(db, session, event(4, 'qq_9ca5b5aec8fc17c3eb34ece2-xyz', 'QQ 带通道前缀'));
  ingestEvent(db, session, event(5, 'weird-bridge-123', '未知桥接'));

  const rows = db.prepare('SELECT seq, origin FROM turns ORDER BY seq').all();
  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { seq: 1, origin: 'chat' },
    { seq: 2, origin: 'im' },
    { seq: 3, origin: 'unknown' },
    { seq: 4, origin: 'im' },
    { seq: 5, origin: 'unknown' },
  ]);
  db.close();
});

test('ingestEvent 把正文里的替换块标记转成全角，防止日后被当成压缩历史', () => {
  const db = freshStore();
  const session = { id: 's' };
  const event = {
    type: 'user/message',
    seq: 30,
    time: 7000,
    data: {
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '看这里 [上下文替换] 是中间出现的' }],
    },
  };
  assert.equal(ingestEvent(db, session, event), 1);
  const row = db.prepare('SELECT text FROM turns WHERE sid = ? AND seq = ?').get('s', 30);
  assert.match(row.text, /［上下文替换］/);
  assert.doesNotMatch(row.text, /\[上下文替换/);
  db.close();
});
