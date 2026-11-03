import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sidOf } from '../lib/sid.js';

test('sidOf: 会话内层 id 优先，agent.id 次之，sessionId 最后', async () => {
  // provider 拿到的 agent 是 { id, session: { id } }：真正会话 id 在内层。
  assert.equal(sidOf({ id: 'agent-id', session: { id: 'session-id' } }), 'session-id');
  // 事件里拿到的 session 自带 id。
  assert.equal(sidOf({ id: 'session-id' }), 'session-id');
  // 只有 sessionId 的老形状。
  assert.equal(sidOf({ sessionId: 'legacy-id' }), 'legacy-id');
  // 空值一律空串，不写 'unknown' 进账本。
  assert.equal(sidOf(null), '');
  assert.equal(sidOf({}), '');
  assert.equal(sidOf('not-an-object'), '');
});
