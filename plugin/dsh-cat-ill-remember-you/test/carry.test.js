import test from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '../lib/db.js';
import { recordShadowV2 } from '../lib/shadow-v2.js';
import {
  LAST_SESSION_MARK,
  LAST_SESSION_MAX_CHARS,
  clipText,
  lastSessionCache,
  renderCarry,
  hasCarry,
  planCarry,
} from '../lib/carry.js';

function shadowRow(over = {}) {
  return {
    sid: 'old-session',
    turn: 0,
    t: 1000,
    rangeStart: 1,
    rangeEnd: 4,
    seqs: '[1,2,3,4]',
    text: '缓存正文',
    charsBefore: 100,
    charsAfter: 10,
    kept: 6,
    lostRatio: 0.1,
    dangling: 0,
    applied: true,
    cwd: '/w',
    ...over,
  };
}

function withStore(fn) {
  const db = openStore(':memory:');
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** 假会话：surface.nodes 是 seq 数组，eventAt/deriveEventMessage 按 seq 取回。 */
function fakeSession(entries = [], cwd = '/w') {
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

test('clipText: 超长保留开头并加省略号', () => {
  assert.equal(clipText('abc', 10), 'abc');
  const clipped = clipText('abcdefghij', 4);
  assert.equal(clipped.length, 4);
  assert.ok(clipped.startsWith('abc'));
  assert.ok(clipped.endsWith('…'));
  assert.equal(clipText('  空白  ', 100), '空白');
});

test('lastSessionCache: 只认 applied=1、同 cwd、非当前会话', () =>
  withStore((db) => {
    recordShadowV2(db, shadowRow({ sid: 'old-session', t: 2000, text: '旧会话结尾' }));
    // 更新但没真替换：不能带来「读过」的证据。
    recordShadowV2(db, shadowRow({ sid: 'dry-session', t: 3000, applied: false }));
    // 别的目录：不许串。
    recordShadowV2(db, shadowRow({ sid: 'other-ws', t: 4000, cwd: '/other' }));

    const hit = lastSessionCache(db, { cwd: '/w', sid: 'me' });
    assert.equal(hit.sid, 'old-session');
    assert.equal(hit.text, '旧会话结尾');
    assert.equal(hit.t, 2000);
  }));

test('lastSessionCache: 排除当前会话自己，cwd 空则不取', () =>
  withStore((db) => {
    recordShadowV2(db, shadowRow({ sid: 'old-session', t: 2000 }));
    recordShadowV2(db, shadowRow({ sid: 'me', t: 5000, text: '我自己的' }));
    assert.equal(lastSessionCache(db, { cwd: '/w', sid: 'me' }).sid, 'old-session');
    assert.equal(lastSessionCache(db, { cwd: '', sid: 'me' }), null);
    assert.equal(lastSessionCache(db, { cwd: '/nowhere', sid: 'me' }), null);
  }));

test('lastSessionCache: 取最近一条', () =>
  withStore((db) => {
    recordShadowV2(db, shadowRow({ sid: 'a', t: 1000, text: '更早' }));
    recordShadowV2(db, shadowRow({ sid: 'b', t: 9000, text: '更近' }));
    assert.equal(lastSessionCache(db, { cwd: '/w', sid: 'me' }).text, '更近');
  }));

test('lastSessionCache: 超长截断到上限', () =>
  withStore((db) => {
    recordShadowV2(db, shadowRow({ text: '长'.repeat(LAST_SESSION_MAX_CHARS + 200) }));
    const hit = lastSessionCache(db, { cwd: '/w', sid: 'me' });
    assert.ok(hit.text.length <= LAST_SESSION_MAX_CHARS);
  }));

test('renderCarry: 带标记并写明不是当前会话', () => {
  const text = renderCarry({ sid: 'a', t: Date.UTC(2026, 10, 2, 15, 40), text: '正文' });
  assert.ok(text.startsWith(LAST_SESSION_MARK));
  assert.ok(text.includes('不是当前这段对话'));
  assert.ok(text.endsWith('正文'));
});

test('hasCarry: 认标记，不误伤普通消息', () => {
  assert.equal(hasCarry([{ role: 'user', content: [{ type: 'text', text: `${LAST_SESSION_MARK} x` }] }]), true);
  assert.equal(hasCarry([{ role: 'user', content: '普通一句' }]), false);
  assert.equal(hasCarry(undefined), false);
});

test('planCarry: 新会话注入，已有 assistant 历史的会话不注入', () =>
  withStore((db) => {
    recordShadowV2(db, shadowRow());
    // 新会话第一轮：surface 里只有本轮用户消息，没有 assistant。
    assert.ok(
      planCarry(db, {
        cwd: '/w',
        sid: 'me',
        session: fakeSession([]),
        messages: [{ role: 'user', content: '在吗' }],
      }),
    );
    // 聊过的会话（含重启后恢复的旧会话）：pre-step 的 messages 只有本轮那条，
    // 但 surface 里已经有 assistant——这是真实判据。
    assert.equal(
      planCarry(db, {
        cwd: '/w',
        sid: 'me',
        session: fakeSession([
          [1, 'user', '早'],
          [2, 'assistant', '在'],
          [3, 'user', '继续'],
        ]),
        messages: [{ role: 'user', content: '继续' }],
      }),
      null,
    );
  }));

test('planCarry: 已经注入过就不再注入（标记可能不在本轮 messages 里）', () =>
  withStore((db) => {
    recordShadowV2(db, shadowRow());
    assert.equal(
      planCarry(db, {
        cwd: '/w',
        sid: 'me',
        session: fakeSession([[1, 'user', `${LAST_SESSION_MARK} 已注入`, { kind: 'memory-core' }]]),
        messages: [{ role: 'user', content: '我回来了' }],
      }),
      null,
    );
    // 本轮 messages 自带标记（同一轮重放）也挡住。
    assert.equal(
      planCarry(db, {
        cwd: '/w',
        sid: 'me',
        session: fakeSession([]),
        messages: [{ role: 'user', content: `${LAST_SESSION_MARK} 已注入` }],
      }),
      null,
    );
  }));

test('planCarry: 拿不到会话就不猜', () =>
  withStore((db) => {
    recordShadowV2(db, shadowRow());
    assert.equal(planCarry(db, { cwd: '/w', sid: 'me', messages: [] }), null);
  }));

test('planCarry: 没有可接的缓存就安静返回 null', () =>
  withStore((db) => {
    assert.equal(planCarry(db, { cwd: '/w', sid: 'me', session: fakeSession([]), messages: [] }), null);
  }));
