import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openStore } from '../lib/db.js';
import { apply } from '../lib/index.js';
import { STACK_MARK } from '../lib/context-stack.js';

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
      inject(_deps, callback) {
        callback(this);
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

/** 准备一个带别的会话原文的临时库，然后按真实接线跑一次 pre-step。 */
async function runPreStep({ turn, messages, cwd = '/proj', memory = null, history = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-pre-step-'));
  const file = path.join(dir, 'memory.db');
  const seed = openStore(file);
  // 全局栈读的是 turns 表，种一条别的会话的原文，验证它会进注入块。
  seed
    .prepare(
      `INSERT INTO turns (sid, seq, role, origin, cwd, text, t) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('old-session', 1, 'user', 'chat', cwd, '上次停在：把 stack 接进 pre-step', Date.now() - 60_000);
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

test('pre-step: 注入全局栈（别的会话最近几句话）', async () => {
  const { decision: result, hintText } = await runPreStep({
    turn: 1,
    messages: [userMessage('我回来了')],
  });
  assert.ok(hintText.includes(STACK_MARK));
  assert.ok(hintText.includes('把 stack 接进 pre-step'));
  // 记忆块走 runtime context provider，不再混进 decision.messages——那是用户消息。
  assert.equal(result.messages.filter((message) => message.source?.kind === 'user').length, 1);
  assert.equal(result.messages.filter((message) => message.source?.kind === 'memory-core').length, 0);
});

test('pre-step: 普通会话也接栈（不再只是白名单）', async () => {
  const { hintText } = await runPreStep({
    turn: 1,
    messages: [userMessage('继续')],
    history: [
      [1, 'user', '早'],
      [2, 'assistant', '在'],
      [3, 'user', '继续'],
    ],
  });
  assert.ok(hintText.includes(STACK_MARK));
});

test('pre-step: 有取回命中时 recall_log 落账（不因 turnNo 漏定义而静默失败）', async () => {
  const { hintText, recallCount } = await runPreStep({
    turn: 1,
    messages: [userMessage('继续改 lib/context-stack.js 的判据')],
    memory: {
      text: 'context-stack.js 的栈只放指针，正文现查',
      summary: 'stack 判据：栈存指针、正文现查',
      anchors: ['lib/context-stack.js'],
    },
  });
  assert.ok(recallCount > 0, 'recall_log 应写入命中记录');
  assert.ok(hintText.includes(STACK_MARK), '栈与取回合并成一条 runtime context');
  assert.ok(hintText.includes('stack 判据：栈存指针、正文现查'));
});
