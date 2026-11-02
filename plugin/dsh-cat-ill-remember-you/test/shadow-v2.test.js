import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  const appended = [];
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
    append: (type, data, options) => {
      appended.push({ type, data, options });
      return { seq: 900 + appended.length };
    },
    appended,
  };
}

function textEntries(prefix, count) {
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    entries.push([i + 1, i % 2 === 0 ? 'user' : 'assistant', `${prefix} 第 ${i + 1} 条`]);
  }
  return entries;
}

/** 临时白名单文件：只有列出的会话才允许真替换。 */
function tempSessionList(sids) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replace-sessions-'));
  const file = path.join(dir, 'list.txt');
  fs.writeFileSync(file, `${sids.join('\n')}\n`, 'utf8');
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** 真替换推在微任务里做，断言前等它落地。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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

test('planShadowV2: keep 可由 DSH_MEMORY_CORE_KEEP 覆盖', () => {
  const db = openStore(':memory:');
  const session = fakeSession(textEntries('消息', 20), 'sid-env');
  const previous = process.env.DSH_MEMORY_CORE_KEEP;
  process.env.DSH_MEMORY_CORE_KEEP = '5';
  try {
    const plan = planShadowV2(session, db, { now: 1 });
    assert.ok(plan);
    assert.equal(plan.kept, 5);
  } finally {
    if (previous === undefined) delete process.env.DSH_MEMORY_CORE_KEEP;
    else process.env.DSH_MEMORY_CORE_KEEP = previous;
    db.close();
  }
});

test('planShadowV2: 环境变量非法时回落到默认 keep', () => {
  const db = openStore(':memory:');
  const session = fakeSession(textEntries('消息', 20), 'sid-env-bad');
  const previous = process.env.DSH_MEMORY_CORE_KEEP;
  process.env.DSH_MEMORY_CORE_KEEP = 'nope';
  try {
    const plan = planShadowV2(session, db, { now: 1 });
    assert.ok(plan);
    assert.equal(plan.kept, 10);
  } finally {
    if (previous === undefined) delete process.env.DSH_MEMORY_CORE_KEEP;
    else process.env.DSH_MEMORY_CORE_KEEP = previous;
    db.close();
  }
});

test('planShadowV2: 默认不真替换（REPLACE 关）', async () => {
  const db = openStore(':memory:');
  const session = fakeSession(textEntries('消息', 14), 'sid-no-replace');
  const previous = process.env.DSH_MEMORY_CORE_REPLACE;
  delete process.env.DSH_MEMORY_CORE_REPLACE;
  try {
    const plan = planShadowV2(session, db, { keep: 10, now: 1 });
    assert.ok(plan);
    assert.equal(plan.applied, false);
    await tick();
    assert.equal(session.appended.length, 0);
    const row = db.prepare('SELECT applied FROM shadow_v2 ORDER BY id DESC LIMIT 1').get();
    assert.equal(Number(row.applied), 0);
  } finally {
    if (previous === undefined) delete process.env.DSH_MEMORY_CORE_REPLACE;
    else process.env.DSH_MEMORY_CORE_REPLACE = previous;
    db.close();
  }
});

test('planShadowV2: REPLACE=1 且会话在白名单时写 surfaceOp.replace', async () => {
  const db = openStore(':memory:');
  const session = fakeSession(textEntries('消息', 14), 'sid-replace');
  const previous = process.env.DSH_MEMORY_CORE_REPLACE;
  const previousList = process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS;
  const list = tempSessionList(['sid-replace']);
  process.env.DSH_MEMORY_CORE_REPLACE = '1';
  process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS = list.file;
  try {
    const plan = planShadowV2(session, db, { keep: 10, now: 1 });
    assert.ok(plan);
    assert.equal(plan.applied, false);
    await tick();
    assert.equal(session.appended.length, 1);
    const row = db.prepare('SELECT applied FROM shadow_v2 ORDER BY id DESC LIMIT 1').get();
    assert.equal(Number(row.applied), 1);
    const call = session.appended[0];
    assert.equal(call.type, 'user/message');
    assert.equal(call.options.surfaceOp.op, 'replace');
    assert.equal(call.options.surfaceOp.startSeq, plan.rangeStart);
    assert.equal(call.options.surfaceOp.endSeq, plan.rangeEnd);
    const nodes = session.surface.nodes.filter(
      (seq) => seq >= plan.rangeStart && seq <= plan.rangeEnd,
    );
    assert.deepEqual(call.options.sourceEventSeqs, nodes);
    assert.equal(call.data.source.kind, 'context-replacement');
    assert.ok(call.data.content[0].text.length <= MAX_REPLACE_CHARS);
  } finally {
    if (previous === undefined) delete process.env.DSH_MEMORY_CORE_REPLACE;
    else process.env.DSH_MEMORY_CORE_REPLACE = previous;
    if (previousList === undefined) delete process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS;
    else process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS = previousList;
    list.cleanup();
    db.close();
  }
});

test('planShadowV2: REPLACE=1 但会话不在白名单时不替换', async () => {
  const db = openStore(':memory:');
  const session = fakeSession(textEntries('消息', 14), 'sid-other');
  const previous = process.env.DSH_MEMORY_CORE_REPLACE;
  const previousList = process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS;
  const list = tempSessionList(['sid-replace']);
  process.env.DSH_MEMORY_CORE_REPLACE = '1';
  process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS = list.file;
  try {
    const plan = planShadowV2(session, db, { keep: 10, now: 1 });
    assert.ok(plan);
    assert.equal(plan.applied, false);
    await tick();
    assert.equal(session.appended.length, 0);
  } finally {
    if (previous === undefined) delete process.env.DSH_MEMORY_CORE_REPLACE;
    else process.env.DSH_MEMORY_CORE_REPLACE = previous;
    if (previousList === undefined) delete process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS;
    else process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS = previousList;
    list.cleanup();
    db.close();
  }
});

test('renderReplacement: 约定句原样留在「约定：」段', () => {
  const entries = [
    { seq: 1, role: 'user', text: '以后不要主动压记忆，压缩要单独一轮。' },
    { seq: 2, role: 'assistant', text: '记住了，压缩独自一轮。' },
    { seq: 3, role: 'user', text: '今天天气不错。' },
  ];
  const text = renderReplacement(entries);
  assert.match(text, /约定：/);
  assert.match(text, /不要主动压记忆/);
  assert.ok(text.length <= MAX_REPLACE_CHARS);
});

test('planShadowV2: 同一区间不重复记账', () => {
  const db = openStore(':memory:');
  const session = fakeSession(textEntries('消息', 14), 'sid-dedupe');
  const first = planShadowV2(session, db, { keep: 10, now: 1 });
  const second = planShadowV2(session, db, { keep: 10, now: 2 });
  assert.ok(first);
  assert.equal(second, null);
  const count = db.prepare('SELECT COUNT(*) AS n FROM shadow_v2').get().n;
  assert.equal(Number(count), 1);
  db.close();
});
