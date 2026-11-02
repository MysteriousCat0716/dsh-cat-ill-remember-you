import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openStore } from '../lib/db.js';
import { recordShadowV2 } from '../lib/shadow-v2.js';
import { apply } from '../lib/index.js';
import { LAST_SESSION_MARK } from '../lib/carry.js';

function fakeCtx(cwd) {
  const handlers = new Map();
  const disposers = [];
  return {
    ctx: {
      on: (event, fn) => {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event).push(fn);
      },
      effect: (execute) => {
        const dispose = execute();
        if (typeof dispose === 'function') disposers.push(dispose);
        return { dispose() {} };
      },
      sessions: { get: () => ({ header: { cwd } }) },
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
async function runPreStep({ turn, messages, cwd = '/proj' }) {
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
  seed.close();

  const previous = process.env.DSH_MEMORY_CORE_DB;
  process.env.DSH_MEMORY_CORE_DB = file;
  const harness = fakeCtx(cwd);
  try {
    apply(harness.ctx);
    const decision = { messages: [...messages] };
    const result = await harness.fire(
      'agent/pre-step',
      { agent: { id: 'new-session' }, messages: decision.messages, step: 1, turn },
      async () => decision,
    );
    return result;
  } finally {
    harness.dispose();
    if (previous === undefined) delete process.env.DSH_MEMORY_CORE_DB;
    else process.env.DSH_MEMORY_CORE_DB = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const userMessage = (text) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });

test('pre-step: 第一轮注入上一个会话的最后缓存', async () => {
  const result = await runPreStep({ turn: 1, messages: [userMessage('我回来了')] });
  const injected = result.messages.filter((message) => message.source?.kind === 'memory-core');
  assert.equal(injected.length, 1);
  assert.ok(injected[0].content[0].text.startsWith(LAST_SESSION_MARK));
  assert.ok(injected[0].content[0].text.includes('把 carry.js 接进 pre-step'));
  // 原消息还在，注入是追加。
  assert.equal(result.messages.filter((message) => message.source?.kind === 'user').length, 1);
});

test('pre-step: 第二轮不再注入', async () => {
  const result = await runPreStep({ turn: 2, messages: [userMessage('第二句')] });
  assert.equal(result.messages.filter((message) => message.source?.kind === 'memory-core').length, 0);
});

test('pre-step: 历史里已有标记时不重复注入', async () => {
  const result = await runPreStep({
    turn: 1,
    messages: [userMessage('我回来了'), userMessage(`${LAST_SESSION_MARK} 上一轮已注入`)],
  });
  assert.equal(result.messages.filter((message) => message.source?.kind === 'memory-core').length, 0);
});
