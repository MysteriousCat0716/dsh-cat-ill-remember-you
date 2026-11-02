import test from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '../lib/db.js';
import { shadowPlan, recordShadow } from '../lib/shadow.js';

function msg(role, text, kind) {
  const message = { role, content: [{ type: 'text', text }] };
  if (kind) message.source = { kind };
  return message;
}

test('shadowPlan counts old messages that overlap a hit anchor', () => {
  const plan = shadowPlan({
    messages: [
      msg('user', '之前那个 lib/recall.js 的 L2 问题，再用一句话讲一遍'),
      msg('assistant', 'lib/recall.js 的 L2 用 json_each 而不是 LIKE，因为 anchors 是 JSON 数组。'),
      msg('user', '好的谢谢'),
    ],
    hits: [{ anchors: ['lib/recall.js'], entities: [] }],
    query: '好的谢谢',
  });
  assert.equal(plan.replaced, 2);
  assert.ok(plan.replacedChars > 0);
  assert.equal(plan.added, 1);
});

test('shadowPlan ignores the current message itself', () => {
  const plan = shadowPlan({
    messages: [msg('user', '之前那个 lib/recall.js 的 L2 问题')],
    hits: [{ anchors: ['lib/recall.js'] }],
    query: '之前那个 lib/recall.js 的 L2 问题',
  });
  assert.equal(plan.replaced, 0);
});

test('shadowPlan ignores injected hints and runtime context', () => {
  const plan = shadowPlan({
    messages: [
      msg('user', '[记忆] 以下是以前记过的：lib/recall.js 的 L2 问题…', 'memory-core'),
      msg('user', 'runtime says lib/recall.js', 'runtime-context'),
      msg('assistant', '真正提到 lib/recall.js 的回答'),
    ],
    hits: [{ anchors: ['lib/recall.js'] }],
    query: '还有别的吗',
  });
  assert.equal(plan.replaced, 1);
});

test('shadowPlan with no hits replaces nothing', () => {
  const plan = shadowPlan({
    messages: [msg('user', 'lib/recall.js 是什么')],
    hits: [],
    query: 'lib/recall.js 是什么',
  });
  assert.equal(plan.replaced, 0);
  assert.equal(plan.added, 0);
});

test('recordShadow writes one row', () => {
  const db = openStore(':memory:');
  recordShadow(db, { sid: 's1', turn: 3, replaced: 2, replacedChars: 120, added: 1, hintChars: 80 });
  const row = db.prepare('SELECT * FROM shadow_log').get();
  assert.equal(row.sid, 's1');
  assert.equal(row.replaced, 2);
  assert.equal(row.replaced_chars, 120);
  db.close();
});
