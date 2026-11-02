import test from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '../lib/db.js';
import {
  MAX_REPLACE_CHARS,
  surfaceMessages,
  splitKeep,
  renderReplacement,
  assessReplacement,
  planShadowV2,
} from '../lib/shadow-v2.js';

/** 假 session：nodes 是 seq 数组，eventAt/deriveEventMessage 按 seq 取回。 */
function fakeSession(entries, id = 'sid-test') {
  const events = new Map(
    entries.map(([seq, role, text, source]) => [seq, { seq, role, text, source }]),
  );
  return {
    id,
    surface: { nodes: [0, ...entries.map(([seq]) => seq)] },
    eventAt: (seq) => events.get(seq),
    deriveEventMessage: (event) =>
      event
        ? {
            role: event.role,
            content: [{ type: 'text', text: event.text }],
            ...(event.source ? { source: event.source } : {}),
          }
        : undefined,
  };
}

function textEntries(prefix, count) {
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    entries.push([i + 1, i % 2 === 0 ? 'user' : 'assistant', `${prefix} 第 ${i + 1} 条`]);
  }
  return entries;
}

test('surfaceMessages: 跳过 system head，只收 user/assistant', () => {
  const session = fakeSession([
    [1, 'user', '你好'],
    [2, 'assistant', '在'],
  ]);
  const entries = surfaceMessages(session);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].seq, 1);
  assert.equal(entries[1].role, 'assistant');
  assert.equal(surfaceMessages({ surface: { nodes: [0] } }).length, 0);
  assert.deepEqual(surfaceMessages(undefined), []);
});

test('splitKeep: 保留最近 keep 条，其余进 replaced', () => {
  const entries = textEntries('m', 12).map(([seq, role, text]) => ({ seq, role, text }));
  const { replaced, kept } = splitKeep(entries, 10);
  assert.equal(replaced.length, 2);
  assert.equal(kept.length, 10);
  assert.equal(kept.at(-1).seq, 12);
  assert.equal(splitKeep(entries, 20).replaced.length, 0);
});

test('renderReplacement: 有头、有正文、不超过 600 字', () => {
  const entries = textEntries('长文本'.repeat(40), 30).map(([seq, role, text]) => ({
    seq,
    role,
    text,
  }));
  const text = renderReplacement(entries);
  assert.ok(text.length <= MAX_REPLACE_CHARS);
  assert.ok(text.startsWith('[上下文替换]'));
  assert.ok(text.includes('他说'));
});

test('assessReplacement: 锚点没进替换文本 → lostRatio 高、dangling 记一条', () => {
  const replaced = [
    { seq: 1, role: 'user', text: '改 产出/插件/foo.mjs 这个文件' },
    { seq: 2, role: 'assistant', text: '好' },
  ];
  const kept = [
    { seq: 3, role: 'user', text: '那个 产出/插件/foo.mjs 再改一下' },
    { seq: 4, role: 'assistant', text: '行' },
  ];
  const assessment = assessReplacement({ replaced, kept, text: '' });
  assert.ok(assessment.missing.includes('产出/插件/foo.mjs'));
  assert.ok(assessment.lostRatio > 0);
  assert.equal(assessment.dangling.length, 1);
  assert.equal(assessment.dangling[0].seq, 3);
});

test('planShadowV2: 消息不够 keep 条时不记账', () => {
  const db = openStore(':memory:');
  const session = fakeSession(textEntries('短', 5));
  assert.equal(planShadowV2(session, db), null);
  db.close();
});

test('planShadowV2: 写一行 shadow_v2，字段对得上', () => {
  const db = openStore(':memory:');
  const session = fakeSession(textEntries('消息', 14), 'sid-abc');
  const plan = planShadowV2(session, db, { keep: 10, now: 1234 });
  assert.ok(plan);
  assert.equal(plan.rangeStart, 1);
  assert.equal(plan.rangeEnd, 4);
  assert.equal(plan.kept, 10);
  assert.equal(plan.charsAfter, plan.text.length);
  const row = db.prepare('SELECT * FROM shadow_v2').get();
  assert.equal(row.sid, 'sid-abc');
  assert.equal(row.t, 1234);
  assert.equal(row.chars_before, plan.charsBefore);
  assert.equal(row.chars_after, plan.charsAfter);
  assert.equal(row.dangling, plan.danglingList.length);
  db.close();
});

test('surfaceMessages: 跳过运行时注入与工具消息', () => {
  const session = fakeSession([
    [1, 'user', '岸姐', { kind: 'user' }],
    [2, 'user', 'Current runtime context. This snapshot', { kind: 'runtime-context' }],
    [3, 'assistant', '在'],
    [4, 'tool', '工具输出'],
    [5, 'user', '<system-reminder>workspace instructions</system-reminder>'],
  ]);
  const entries = surfaceMessages(session);
  assert.deepEqual(
    entries.map((entry) => entry.seq),
    [1, 3],
  );
});

test('planShadowV2: 只取最近 window 条老消息', () => {
  const db = openStore(':memory:');
  const session = fakeSession(textEntries('消息', 80), 'sid-w');
  const plan = planShadowV2(session, db, { keep: 10, window: 20, now: 1 });
  assert.ok(plan);
  assert.equal(plan.rangeStart, 51);
  assert.equal(plan.rangeEnd, 70);
  assert.equal(plan.kept, 10);
  db.close();
});
