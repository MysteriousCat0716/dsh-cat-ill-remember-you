import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openStore } from '../lib/db.js';
import { recordShadowV2 } from '../lib/shadow-v2.js';
import { apply } from '../lib/index.js';
import { LAST_SESSION_MARK } from '../lib/carry.js';

/** 假会话：surface.nodes 是 seq 数组，eventAt/deriveEventMessage 按 seq 取回。 */
function fakeSession(entries, cwd) {
  const events = new Map(
    entries.map(([seq, role, text, source]) => [seq, { seq, role, text, source }]),
  );
  return {
    header: { cwd },
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

function fakeCtx(cwd, history = []) {
  const handlers = new Map();
  const disposers = [];
  const contexts = new Map();
  return {
    contexts,
    ctx: {
      systemPrompt: {
        context: (entry) => {
          contexts.set(entry.name, entry);
          return () => {};
        },
      },
      on: (event, fn) => {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event).push(fn);
      },
      effect: (execute) => {
        const dispose = execute();
        if (typeof dispose === 'function') disposers.push(dispose);
        return { dispose() {} };
      },
      sessions: { get: () => fakeSession(history, cwd) },
    },
    fire: (event, payload, next) => handlers.get(event)[0](payload, next),
    dispose: () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* 测试里只关心注入 */
        }
      }
    },
  };
}

/** 准备一个带旧会话缓存的临时库，然后按真实接线跑一次 pre-step。 */
async function runPreStep({ turn, messages, cwd = '/proj', memory = null, history = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-pre-step-'));
  const file = path.join(dir, 'memory.db');
  const seed = openStore(file);
  recordShadowV2(seed, {
    sid: 'old-session',
    turn: 0,
    t: Date.now() - 60_000,
    rangeStart: 1,
    rangeEnd: 4,
    seqs: '[1,2,3,4]',
    text: '上次停在：把 carry.js 接进 pre-step',
    charsBefore: 300,
    charsAfter: 40,
    kept: 4,
    lostRatio: 0.1,
    dangling: 0,
    applied: true,
    cwd,
  });
  if (memory) {
    seed
      .prepare(
        `INSERT INTO memories (kind, origin, subject, text, summary, entities, anchors, tier, t)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      )
      .run(
        memory.kind ?? 'fact',
        'chat',
        'user',
        memory.text,
        memory.summary ?? memory.text.slice(0, 40),
        JSON.stringify(memory.entities ?? []),
        JSON.stringify(memory.anchors ?? []),
        Date.now() - 120_000,
      );
  }
  seed.close();

  const previous = process.env.DSH_MEMORY_CORE_DB;
  process.env.DSH_MEMORY_CORE_DB = file;
  const harness = fakeCtx(cwd, history);
  try {
    apply(harness.ctx);
    const decision = {
      messages: [...messages],
      assembly: { sections: [], contexts: [], tools: [], variables: {} },
    };
    const result = await harness.fire(
      'agent/pre-step',
      { agent: { id: 'new-session' }, messages: decision.messages, step: 1, turn },
      async () => decision,
    );
    const provider = harness.contexts.get('memory-core');
    const hintText = provider
      ? provider.text({ agent: { id: 'new-session', session: { id: 'new-session' } } })
      : '';
    const check = openStore(file);
    const recallCount = check.prepare('SELECT count(*) AS c FROM recall_log').get().c;
    check.close();
    return { decision: result, recallCount, hintText };
  } finally {
    harness.dispose();
    if (previous === undefined) delete process.env.DSH_MEMORY_CORE_DB;
    else process.env.DSH_MEMORY_CORE_DB = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const userMessage = (text) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });

test('pre-step: 第一轮注入上一个会话的最后缓存', async () => {
  const { decision: result, hintText } = await runPreStep({
    turn: 1,
    messages: [userMessage('我回来了')],
  });
  assert.ok(hintText.startsWith(LAST_SESSION_MARK));
  assert.ok(hintText.includes('把 carry.js 接进 pre-step'));
  // 记忆块走 runtime context provider，不再混进 decision.messages——那是用户消息。
  assert.equal(result.messages.filter((message) => message.source?.kind === 'user').length, 1);
  assert.equal(result.messages.filter((message) => message.source?.kind === 'memory-core').length, 0);
});

test('pre-step: 聊过的会话也会接上（每轮接续，不再只看第一轮）', async () => {
  const { hintText } = await runPreStep({
    turn: 1,
    messages: [userMessage('继续')],
    history: [
      [1, 'user', '早'],
      [2, 'assistant', '在'],
      [3, 'user', '继续'],
    ],
  });
  assert.ok(hintText.startsWith(LAST_SESSION_MARK));
});

test('pre-step: 历史里有旧标记时，新的接续仍然注入（去重靠 carry_log）', async () => {
  const { hintText } = await runPreStep({
    turn: 1,
    messages: [userMessage('我回来了')],
    history: [[1, 'user', `${LAST_SESSION_MARK} 上一轮已注入`, { kind: 'memory-core' }]],
  });
  assert.ok(hintText.startsWith(LAST_SESSION_MARK));
});

test('pre-step: 有取回命中时 recall_log 落账（不因 turnNo 漏定义而静默失败）', async () => {
  const { hintText, recallCount } = await runPreStep({
    turn: 1,
    messages: [userMessage('继续改 lib/carry.js 的判据')],
    memory: {
      text: 'carry.js 的新会话判据是会话历史里有没有 assistant 回复',
      summary: 'carry.js 判据：看会话历史',
      anchors: ['lib/carry.js'],
    },
  });
  assert.ok(recallCount > 0, 'recall_log 应写入命中记录');
  assert.ok(hintText.startsWith(LAST_SESSION_MARK), '接续与取回合并成一条 runtime context');
  assert.ok(hintText.includes('carry.js 判据：看会话历史'));
});
