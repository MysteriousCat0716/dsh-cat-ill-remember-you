import test, { afterEach, beforeEach } from 'node:test';
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
  applyReplacement,
  planShadowV2,
  replaceMode,
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

/** 临时打开白名单；返回清理函数。 */
function useWhitelist(sids) {
  const previous = process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS;
  const list = tempSessionList(sids);
  process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS = list.file;
  return () => {
    if (previous === undefined) delete process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS;
    else process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS = previous;
    list.cleanup();
  };
}

// 缓存按 mtime+size 失效：文件改写后必须立刻读到新内容。
test('replaceMode: 白名单文件改写后立即生效（缓存按 mtime+size 失效）', () => {
  const list = tempSessionList(['sid-a']);
  const previous = process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS;
  process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS = list.file;
  try {
    assert.equal(replaceMode('sid-a'), 'roll');
    assert.equal(replaceMode('sid-b'), 'off');
    // 同一路径重写：内容变长，size 和 mtime 都会变，缓存必须跟着失效。
    fs.writeFileSync(list.file, 'sid-a\nsid-b:full\n', 'utf8');
    assert.equal(replaceMode('sid-b'), 'full');
    assert.equal(replaceMode('sid-c'), 'off');
  } finally {
    if (previous === undefined) delete process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS;
    else process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS = previous;
    list.cleanup();
  }
});

/**
 * 记账与替换都只发生在白名单内的会话；测试默认把所有用到的 sid 放进白名单。
 * 需要验证「白名单外」的测试自己再调 useWhitelist 覆盖。
 */
let restoreDefaultWhitelist = null;
beforeEach(() => {
  restoreDefaultWhitelist = useWhitelist([
    'sid-test',
    'sid-abc',
    'sid-w',
    'sid-roll',
    'sid-roll-long',
    'sid-chars',
    'sid-env',
    'sid-env-bad',
    'sid-no-replace',
    'sid-dedupe',
    'sid-retry',
    'sid-apply',
    'sid-gap',
  ]);
});
afterEach(() => {
  restoreDefaultWhitelist?.();
  restoreDefaultWhitelist = null;
});

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
  assert.ok(text.startsWith('[上下文替换｜'));
  assert.ok(text.includes('用户:'));
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

test('planShadowV2: 消息少于 4 条时不记账', () => {
  const db = openStore(':memory:');
  const session = fakeSession(textEntries('短', 3));
  assert.equal(planShadowV2(session, db), null);
  db.close();
});

test('planShadowV2: 6 条短会话不换（最近 6 条是保护线）', () => {
  const db = openStore(':memory:');
  const session = fakeSession(textEntries('短句', 6));
  assert.equal(planShadowV2(session, db, { now: 1 }), null);
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

test('planShadowV2: 只取最近 window 条老消息（旧模式兜底）', () => {
  const db = openStore(':memory:');
  const session = fakeSession(textEntries('消息', 80), 'sid-w');
  const plan = planShadowV2(session, db, { keep: 10, window: 20, now: 1, roll: false });
  assert.ok(plan);
  assert.equal(plan.rangeStart, 51);
  assert.equal(plan.rangeEnd, 70);
  assert.equal(plan.kept, 10);
  db.close();
});

test('planShadowV2: 滚动模式只换最早 4 条，最近 6 条原文不动', () => {
  const db = openStore(':memory:');
  const session = fakeSession(textEntries('消息', 12), 'sid-roll');
  const plan = planShadowV2(session, db, { now: 1 });
  assert.ok(plan);
  assert.equal(plan.rangeStart, 1);
  assert.equal(plan.rangeEnd, 4);
  // 未换的早段 6 条 + 最后一轮 2 条（保留区按轮算）
  assert.equal(plan.kept, 8);
  db.close();
});

test('planShadowV2: 滚动模式按轮保留，超长工具轮不改当前提问', () => {
  const db = openStore(':memory:');
  // 最后一条 user 在 index 3，后面 12 条全是 assistant（超长工具轮）。
  // 旧的「留最近 6 条」会把这条 user 换进区间，模型就看不到当前提问了。
  const entries = Array.from({ length: 16 }, (_, i) => [
    i + 1,
    i === 3 ? 'user' : 'assistant',
    'x'.repeat(400),
  ]);
  const session = fakeSession(entries, 'sid-roll-long');
  const plan = planShadowV2(session, db, { now: 1 });
  assert.ok(plan);
  // 区间只到 index 2（seq 3），当前提问 seq 4 不进区间。
  assert.equal(plan.rangeEnd, 3);
  assert.equal(plan.kept, 13);
  db.close();
});

test('planShadowV2: 白名单 sid:full 不等门槛，除最近 2 条外全部进替换', () => {
  const db = openStore(':memory:');
  const session = fakeSession(textEntries('消息', 12), 'sid-full');
  const restore = useWhitelist(['sid-full:full']);
  try {
    const plan = planShadowV2(session, db, { now: 1 });
    assert.ok(plan);
    assert.equal(plan.rangeStart, 1);
    assert.equal(plan.rangeEnd, 10); // 12 条 - 当前轮 2 条 = 10 条全部进替换
    assert.equal(plan.kept, 2);
  } finally {
    restore();
    db.close();
  }
});

test('planShadowV2: sid:full 会话只有 3 条时也换（不等 11 条门槛）', () => {
  const db = openStore(':memory:');
  const session = fakeSession(textEntries('消息', 3), 'sid-full-small');
  const restore = useWhitelist(['sid-full-small:full']);
  try {
    const plan = planShadowV2(session, db, { now: 1 });
    assert.ok(plan);
    assert.equal(plan.rangeStart, 1);
    // 保留区按轮：最后一条是 user（seq 3），前面的 user+assistant 都进区间。
    assert.equal(plan.rangeEnd, 2);
    assert.equal(plan.kept, 1);
  } finally {
    restore();
    db.close();
  }
});

test('planShadowV2: full 第二轮把旧替换块包进区间，原文从 turns 取', () => {
  const db = openStore(':memory:');
  // 第一轮之后的表面：旧替换块（seq 13）排在位置 1，后面 5..12 是从没被换过的原文。
  const entries = [
    [13, 'user', '[上下文替换｜旧消息压缩，非用户发言] 更早 4 条（seq 1-4），原文在本地：…'],
    ...textEntries('消息', 12).filter(([seq]) => seq >= 5),
  ];
  const session = fakeSession(entries, 'sid-full-2');
  // turns 里留着 1..12 的原文：旧块盖住的 1..4 已经离开 surface，只有这里能找回来。
  const insert = db.prepare(
    'INSERT INTO turns (sid, seq, role, origin, cwd, text, t) VALUES (?,?,?,?,?,?,?)',
  );
  for (let seq = 1; seq <= 12; seq += 1) {
    insert.run(
      'sid-full-2',
      seq,
      seq % 2 === 0 ? 'assistant' : 'user',
      'chat',
      '/w',
      `消息 第 ${seq} 条`,
      seq,
    );
  }
  const restore = useWhitelist(['sid-full-2:full']);
  try {
    const plan = planShadowV2(session, db, { now: 1 });
    assert.ok(plan);
    // 区间从第一个 surface 节点起（含旧块），否则每轮都会在旧块后面再插一块。
    assert.equal(plan.rangeStart, 13);
    assert.equal(plan.rangeEnd, 10);
    assert.equal(plan.kept, 2);
    // 旧块盖住的第 1 条只能从 turns 重算进来。
    assert.match(plan.text, /第 1 条/);
  } finally {
    restore();
    db.close();
  }
});

test('planShadowV2: full 模式不把节点 0 的 system prompt 包进区间', () => {
  const db = openStore(':memory:');
  const entries = textEntries('消息', 9).filter(([seq]) => seq >= 2);
  const session = fakeSession(entries, 'sid-sys-0');
  // 真实宿主里节点 0 是 system prompt，有自己的 seq，不是占位 0。
  session.surface.nodes = [1, ...entries.map(([seq]) => seq)];
  const restore = useWhitelist(['sid-sys-0:full']);
  try {
    const plan = planShadowV2(session, db, { now: 1 });
    assert.ok(plan);
    assert.equal(plan.rangeStart, 2);
    assert.equal(plan.rangeEnd, 8);
    assert.match(plan.text, /第 2 条/);
  } finally {
    restore();
    db.close();
  }
});

test('planShadowV2: full 模式按保留区过滤原文，不依赖 seq 单调', () => {
  const db = openStore(':memory:');
  const entries = [
    [587, 'user', '[上下文替换｜旧消息压缩，非用户发言] 更早 5 条（seq 1-5），原文在本地：…'],
    [571, 'assistant', '助手在 571 说的话'],
    [579, 'user', '用户在 579 说的话'],
    [605, 'assistant', '助手在 605 说的话'],
  ];
  const session = fakeSession(entries, 'sid-nonmono');
  const insert = db.prepare(
    'INSERT INTO turns (sid, seq, role, origin, cwd, text, t) VALUES (?,?,?,?,?,?,?)',
  );
  insert.run('sid-nonmono', 571, 'assistant', 'chat', '/w', '助手在 571 说的话', 571);
  insert.run('sid-nonmono', 579, 'user', 'chat', '/w', '用户在 579 说的话', 579);
  insert.run('sid-nonmono', 605, 'assistant', 'chat', '/w', '助手在 605 说的话', 605);
  const restore = useWhitelist(['sid-nonmono:full']);
  try {
    const plan = planShadowV2(session, db, { now: 1 });
    assert.ok(plan);
    assert.equal(plan.rangeStart, 587);
    assert.equal(plan.rangeEnd, 571);
    // 保留区是 579、605；571 虽然在 rangeEnd 上，也必须进原文。
    assert.match(plan.text, /助手在 571 说的话/);
  } finally {
    restore();
    db.close();
  }
});

test('planShadowV2: 字数超预算时条数不够也换（只换得动最早那段）', () => {
  const db = openStore(':memory:');
  const long = Array.from({ length: 8 }, (_, i) => [
    i + 1,
    i % 2 === 0 ? 'user' : 'assistant',
    `${'长'.repeat(900)} 第 ${i + 1} 条`,
  ]);
  const session = fakeSession(long, 'sid-chars');
  const plan = planShadowV2(session, db, { now: 1 });
  assert.ok(plan);
  assert.equal(plan.rangeStart, 1);
  // 保留区按轮算（最后一轮 2 条 + STEP 之后未换的 2 条），仍只动最早 4 条。
  assert.equal(plan.rangeEnd, 4);
  assert.equal(plan.kept, 4);
  db.close();
});

test('planShadowV2: keep 可由 DSH_MEMORY_CORE_KEEP 覆盖（旧模式兜底）', () => {
  const db = openStore(':memory:');
  const session = fakeSession(textEntries('消息', 20), 'sid-env');
  const previous = process.env.DSH_MEMORY_CORE_KEEP;
  process.env.DSH_MEMORY_CORE_KEEP = '5';
  try {
    const plan = planShadowV2(session, db, { now: 1, roll: false });
    assert.ok(plan);
    assert.equal(plan.kept, 5);
  } finally {
    if (previous === undefined) delete process.env.DSH_MEMORY_CORE_KEEP;
    else process.env.DSH_MEMORY_CORE_KEEP = previous;
    db.close();
  }
});

test('planShadowV2: 环境变量非法时回落到动态 keep（旧模式兜底）', () => {
  const db = openStore(':memory:');
  const session = fakeSession(textEntries('消息', 20), 'sid-env-bad');
  const previous = process.env.DSH_MEMORY_CORE_KEEP;
  process.env.DSH_MEMORY_CORE_KEEP = 'nope';
  try {
    const plan = planShadowV2(session, db, { now: 1, roll: false });
    assert.ok(plan);
    // 20 条 × 0.4 = 8，落在 [MIN_KEEP, DEFAULT_KEEP] 之间
    assert.equal(plan.kept, 8);
  } finally {
    if (previous === undefined) delete process.env.DSH_MEMORY_CORE_KEEP;
    else process.env.DSH_MEMORY_CORE_KEEP = previous;
    db.close();
  }
});

test('planShadowV2: 白名单外默认什么都不做', async () => {
  const db = openStore(':memory:');
  const cleanup = useWhitelist([]); // 空名单 = 全关
  const session = fakeSession(textEntries('消息', 14), 'sid-no-replace');
  try {
    const plan = planShadowV2(session, db, { keep: 10, now: 1 });
    assert.equal(plan, null);
    await tick();
    assert.equal(session.appended.length, 0);
    const count = db.prepare('SELECT COUNT(*) AS n FROM shadow_v2').get().n;
    assert.equal(Number(count), 0);
  } finally {
    cleanup();
    db.close();
  }
});

test('planShadowV2: REPLACE=1 且会话在白名单时写 surfaceOp.replace', async () => {
  const db = openStore(':memory:');
  // 原文要够长，替换文本才短于窗口（收益判据：净变短才换）。
  const longEntries = Array.from({ length: 14 }, (_, i) => [
    i + 1,
    i % 2 === 0 ? 'user' : 'assistant',
    `消息 第 ${i + 1} 条 ` + '这是一段比较长的原文，用来让替换文本明显短于被换窗口。'.repeat(10),
  ]);
  const session = fakeSession(longEntries, 'sid-replace');
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
    // 宿主要的是按位置的区间：startSeq 到 endSeq 之间（含端点）的 surface 节点。
    const nodes = session.surface.nodes;
    const startIdx = nodes.indexOf(plan.rangeStart);
    const endIdx = nodes.indexOf(plan.rangeEnd);
    assert.deepEqual(call.options.sourceEventSeqs, nodes.slice(startIdx, endIdx + 1));
    assert.equal(call.data.source.kind, 'context-replacement');
    // 宿主 assertMessageEventShape 要求带非空字符串 id，缺了会话会被判 corrupt。
    assert.ok(typeof call.data.id === 'string' && call.data.id.length > 0);
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

test('planShadowV2: 替换文本变大也真换（它是缓存不是压缩）', async () => {
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
    await tick();
    assert.equal(session.appended.length, 1);
    const row = db.prepare('SELECT applied FROM shadow_v2 ORDER BY id DESC LIMIT 1').get();
    assert.equal(Number(row.applied), 1);
  } finally {
    if (previous === undefined) delete process.env.DSH_MEMORY_CORE_REPLACE;
    else process.env.DSH_MEMORY_CORE_REPLACE = previous;
    if (previousList === undefined) delete process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS;
    else process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS = previousList;
    list.cleanup();
    db.close();
  }
});

test('planShadowV2: 会话不在白名单时什么都不做', async () => {
  const db = openStore(':memory:');
  const session = fakeSession(textEntries('消息', 14), 'sid-other');
  const previousList = process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS;
  const list = tempSessionList(['sid-replace']);
  process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS = list.file;
  try {
    const plan = planShadowV2(session, db, { keep: 10, now: 1 });
    assert.equal(plan, null);
    await tick();
    assert.equal(session.appended.length, 0);
    const count = db.prepare('SELECT COUNT(*) AS n FROM shadow_v2').get().n;
    assert.equal(Number(count), 0);
  } finally {
    if (previousList === undefined) delete process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS;
    else process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS = previousList;
    list.cleanup();
    db.close();
  }
});

test('renderReplacement: 长回复保首句和尾句，结论不再被截掉', () => {
  const head = '我先看了 lib 下的实现，';
  const middle = '这一段是中间过程。'.repeat(20);
  const tail = '结论是缓存按 mtime 失效就够了。';
  const entries = [
    { seq: 1, role: 'user', text: '缓存这块怎么改' },
    { seq: 2, role: 'assistant', text: `${head}${middle}${tail}` },
  ];
  const text = renderReplacement(entries);
  assert.match(text, /我先看了 lib 下的实现/);
  assert.match(text, /结论是缓存按 mtime 失效就够了/);
  assert.ok(text.length <= MAX_REPLACE_CHARS);
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

test('planShadowV2: 同一区间换成功后不再重复记账', async () => {
  const db = openStore(':memory:');
  const session = fakeSession(textEntries('消息', 14), 'sid-dedupe');
  const first = planShadowV2(session, db, { keep: 10, now: 1 });
  assert.ok(first);
  await tick();
  const second = planShadowV2(session, db, { keep: 10, now: 2 });
  assert.equal(second, null);
  const count = db.prepare('SELECT COUNT(*) AS n FROM shadow_v2').get().n;
  assert.equal(Number(count), 1);
  db.close();
});

test('applyReplacement: 位置区间里夹着早先替换块时，按位置取 seqs 而不是按值', () => {
  const list = tempSessionList(['sid-gap']);
  const previousList = process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS;
  process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS = list.file;
  const appended = [];
  // 真实形状：旧的替换块 seq=313 位置在 100 和 101 之间，值却比当前区间尾部大。
  const session = {
    id: 'sid-gap',
    surface: { nodes: [0, 100, 313, 101, 102] },
    append: (type, data, options) => appended.push({ type, data, options }),
  };
  try {
    const ok = applyReplacement(session, [{ seq: 100 }, { seq: 102 }], '替换文本', 'sid-gap');
    assert.equal(ok, true);
    assert.equal(appended.length, 1);
    assert.deepEqual(appended[0].options.sourceEventSeqs, [100, 313, 101, 102]);
    assert.deepEqual(appended[0].options.surfaceOp, { op: 'replace', startSeq: 100, endSeq: 102 });
  } finally {
    if (previousList === undefined) delete process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS;
    else process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS = previousList;
    list.cleanup();
  }
});

test('planShadowV2: 白名单内 apply 失败后同区间下一轮会重试，成功后不再重复', async () => {
  const db = openStore(':memory:');
  const longEntries = Array.from({ length: 14 }, (_, i) => [
    i + 1,
    i % 2 === 0 ? 'user' : 'assistant',
    `消息 第 ${i + 1} 条 ` + '这是一段比较长的原文，用来让替换文本明显短于被换窗口。'.repeat(10),
  ]);
  const session = fakeSession(longEntries, 'sid-retry');
  const realAppend = session.append;
  let calls = 0;
  session.append = (...args) => {
    calls += 1;
    if (calls === 1) throw new Error('boom');
    return realAppend(...args);
  };
  const list = tempSessionList(['sid-retry']);
  const previousList = process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS;
  process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS = list.file;
  try {
    const first = planShadowV2(session, db, { keep: 10, now: 1 });
    assert.ok(first);
    await tick();
    const afterFirst = db.prepare('SELECT applied FROM shadow_v2 ORDER BY id DESC LIMIT 1').get();
    assert.equal(Number(afterFirst.applied), 0);

    const second = planShadowV2(session, db, { keep: 10, now: 2 });
    assert.ok(second, '上次没换成，同区间应该允许重试');
    await tick();
    assert.equal(calls, 2);
    const afterSecond = db.prepare('SELECT applied FROM shadow_v2 ORDER BY id DESC LIMIT 1').get();
    assert.equal(Number(afterSecond.applied), 1);

    const third = planShadowV2(session, db, { keep: 10, now: 3 });
    assert.equal(third, null, '换成功之后同区间不再重复记账');
  } finally {
    if (previousList === undefined) delete process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS;
    else process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS = previousList;
    list.cleanup();
    db.close();
  }
});

test('applyReplacement: 区间终点不切在 assistant 与它的 tool/call 之间', () => {
  const events = new Map([
    [1, { seq: 1, type: 'user/message', role: 'user', content: [{ type: 'text', text: 'a' }] }],
    [2, { seq: 2, type: 'assistant/message', role: 'assistant', content: [{ type: 'text', text: 'b' }] }],
    [3, { seq: 3, type: 'tool/call' }],
  ]);
  const appended = [];
  const session = {
    id: 'sid-tool-cut',
    surface: { nodes: [1, 2, 3] },
    eventAt: (seq) => events.get(seq),
    deriveEventMessage: (event) => (event?.content ? { role: event.role, content: event.content } : undefined),
    append: (type, data, options) => {
      appended.push({ type, data, options });
    },
  };
  const list = tempSessionList(['sid-tool-cut']);
  const previousList = process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS;
  process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS = list.file;
  try {
    const ok = applyReplacement(
      session,
      [
        { seq: 1, role: 'user', text: 'a' },
        { seq: 2, role: 'assistant', text: 'b' },
      ],
      '摘要',
      'sid-tool-cut',
    );
    assert.equal(ok, true);
    assert.equal(appended.length, 1);
    assert.equal(appended[0].options.surfaceOp.endSeq, 1);
  } finally {
    if (previousList === undefined) delete process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS;
    else process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS = previousList;
    list.cleanup();
  }
});

test('assessReplacement: 字符砍了但关键 token 全在，lost_ratio 与 token_keep 分得开', () => {
  const replaced = [
    {
      seq: 1,
      role: 'user',
      text: '改 产出/插件/foo.mjs 这个文件，先看 lib 下的实现，再看测试，再看文档，最后动手改。',
    },
  ];
  const text = '改 产出/插件/foo.mjs（中间过程省略）';
  const a = assessReplacement({ replaced, kept: [], text });
  // 字符确实砍掉三成以上，但路径还在——砍掉的是冗余，不是断链。
  assert.ok(a.lostRatio > 0.3);
  assert.equal(a.tokenKeep, 1);
});

test('assessReplacement: 替换文本比原文长时 lost_ratio 为负，不算错', () => {
  const replaced = [{ seq: 1, role: 'user', text: '短' }];
  const a = assessReplacement({ replaced, kept: [], text: '很长很长的替换文本' });
  assert.ok(a.lostRatio < 0);
});

test('planShadowV2: full 模式压掉工具结果时，替换文本留一行索引', () => {
  const entries = [
    [1, 'user', '先看这个文件'],
    [2, 'assistant', '我去读'],
    [5, 'user', '继续'],
    [6, 'assistant', '好'],
  ];
  const tools = [
    { type: 'tool/call', seq: 3, data: { calls: [{ callId: 'c1', name: 'read' }] } },
    {
      type: 'tool/result',
      seq: 4,
      data: {
        message: { source: { callId: 'c1' }, content: [{ type: 'text', text: '很长的工具输出'.repeat(50) }] },
      },
    },
  ];
  const events = new Map();
  for (const [seq, role, text] of entries) events.set(seq, { seq, role, text });
  for (const tool of tools) events.set(tool.seq, tool);
  const session = {
    id: 'sid-tool',
    surface: { nodes: [0, 1, 2, 3, 4, 5, 6] },
    eventAt: (seq) => events.get(seq),
    deriveEventMessage: (event) =>
      event && (event.role === 'user' || event.role === 'assistant')
        ? { role: event.role, content: [{ type: 'text', text: event.text }] }
        : undefined,
    append: () => ({ seq: 999 }),
  };
  const cleanup = useWhitelist(['sid-tool:full']);
  const db = openStore(':memory:');
  try {
    const plan = planShadowV2(session, db, { now: 1 });
    assert.ok(plan, 'full 模式应产出替换计划');
    assert.match(plan.text, /工具结果 1 个：read@4/);
  } finally {
    cleanup();
    db.close();
  }
});

test('planShadowV2: 工具结果在 spill 上时，索引写目录而不是 seq', () => {
  const spill = 'C:/tmp/spill/session-abc/1234-ops_bash.txt';
  const entries = [
    [1, 'user', '先看这个文件'],
    [2, 'assistant', '我去读'],
    [5, 'user', '继续'],
    [6, 'assistant', '好'],
  ];
  const tools = [
    { type: 'tool/call', seq: 3, data: { calls: [{ callId: 'c1', name: 'ops_bash' }] } },
    {
      type: 'tool/result',
      seq: 4,
      data: {
        message: {
          source: { callId: 'c1' },
          content: [{
            type: 'text',
            text: `[Notice: 12000 bytes omitted. Full formatted result stored at: ${spill}. Use read with offset/limit, or grep this path to search within it.]`,
          }],
        },
      },
    },
  ];
  const events = new Map();
  for (const [seq, role, text] of entries) events.set(seq, { seq, role, text });
  for (const tool of tools) events.set(tool.seq, tool);
  const session = {
    id: 'sid-tool-spill',
    surface: { nodes: [0, 1, 2, 3, 4, 5, 6] },
    eventAt: (seq) => events.get(seq),
    deriveEventMessage: (event) =>
      event && (event.role === 'user' || event.role === 'assistant')
        ? { role: event.role, content: [{ type: 'text', text: event.text }] }
        : undefined,
    append: () => ({ seq: 999 }),
  };
  const cleanup = useWhitelist(['sid-tool-spill:full']);
  const db = openStore(':memory:');
  try {
    const plan = planShadowV2(session, db, { now: 1 });
    assert.ok(plan, 'full 模式应产出替换计划');
    assert.ok(plan.text.includes('ops_bash@4'));
    assert.ok(plan.text.includes('C:/tmp/spill/session-abc'));
    assert.ok(!plan.text.includes('按 seq 取回'));
  } finally {
    cleanup();
    db.close();
  }
});
