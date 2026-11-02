import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { openStore } from '../lib/db.js';
import { recordShadowV2 } from '../lib/shadow-v2.js';
import { LAST_SESSION_MARK, planCarry, renderTailCarry } from '../lib/carry.js';
import {
  originalMessages,
  recentSessionOriginals,
  sessionLogFile,
  textOfEvent,
  workspaceDirName,
} from '../lib/originals.js';

function userEvent(seq, text, kind = 'user') {
  return {
    type: 'user/message',
    seq,
    time: seq,
    data: { id: `u${seq}`, role: 'user', source: { kind }, content: [{ type: 'text', text }] },
  };
}

function assistantEvent(seq, text) {
  return {
    type: 'assistant/message',
    seq,
    time: seq,
    data: {
      turn: 1,
      step: 1,
      message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text }] },
    },
  };
}

function writeSession(root, sid, cwd, events) {
  const dir = join(root, workspaceDirName(cwd), sid);
  mkdirSync(dir, { recursive: true });
  const body = events.map((event) => JSON.stringify(event)).join('\n');
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(body, 'utf8')));
}

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-originals-'));
}

test('workspaceDirName 把非字母数字压成一个 -', () => {
  assert.equal(workspaceDirName('C:\\Users\\a b\\c'), '--C-Users-a-b-c--');
  assert.equal(workspaceDirName(''), '');
  assert.equal(workspaceDirName(undefined), '');
});

test('sessionLogFile 指向 <root>/<workspace>/<sid>/session.v4.jsonl.zstd', () => {
  const file = sessionLogFile({ sid: 's1', cwd: 'C:\\w', sessionsRoot: 'R' });
  assert.equal(file, join('R', '--C-w--', 's1', 'session.v4.jsonl.zstd'));
});

test('originalMessages 只留真人和 assistant，过滤注入与工具', () => {
  const root = tempRoot();
  try {
    writeSession(root, 's1', 'C:\\w', [
      { type: 'session', seq: 0, data: { id: 's1', cwd: 'C:\\w' } },
      userEvent(1, '你好'),
      userEvent(2, '系统提示', 'runtime-context'),
      assistantEvent(3, '在。'),
      userEvent(4, '自定义注入', 'memory-core'),
      { type: 'tool/result', seq: 5, data: { message: { role: 'tool', content: [] } } },
    ]);
    const messages = originalMessages({ id: 's1', header: { cwd: 'C:\\w' } }, root);
    assert.deepEqual(messages, [
      { seq: 1, role: 'user', text: '你好' },
      { seq: 3, role: 'assistant', text: '在。' },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('originalMessages 读不到文件时返回空数组', () => {
  assert.deepEqual(originalMessages({ id: 'nope', header: { cwd: 'C:\\w' } }, tempRoot()), []);
});

test('recentSessionOriginals 取最近、排除自己、跳过没有原文的会话', () => {
  const root = tempRoot();
  try {
    const cwd = 'C:\\w';
    writeSession(root, 'older', cwd, [userEvent(1, '老会话')]);
    writeSession(root, 'newest', cwd, [userEvent(1, '新会话')]);
    // 空会话：只有 header，没有可接的内容
    writeSession(root, 'empty', cwd, [{ type: 'session', seq: 0, data: { id: 'empty' } }]);
    const found = recentSessionOriginals({ cwd, excludeSid: 'newest', sessionsRoot: root });
    assert.ok(found);
    assert.equal(found.sid, 'older');
    assert.deepEqual(found.messages.map((m) => m.text), ['老会话']);
    const other = recentSessionOriginals({ cwd, excludeSid: 'older', sessionsRoot: root });
    assert.ok(other);
    assert.notEqual(other.sid, 'older');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('renderTailCarry 保留最近的条目并带标记', () => {
  const text = renderTailCarry(
    {
      sid: 's1',
      mtime: 1000,
      messages: [
        { role: 'user', text: '第一句' },
        { role: 'assistant', text: '第二句' },
        { role: 'user', text: '第三句' },
      ],
    },
    400,
  );
  assert.ok(text.startsWith(LAST_SESSION_MARK));
  assert.ok(text.includes('第三句'));
  assert.ok(text.indexOf('第二句') < text.indexOf('第三句'));
});

test('planCarry 优先用上一个会话的原文，原文读不到才退回摘要', () => {
  const root = tempRoot();
  const db = openStore(':memory:');
  try {
    const cwd = 'C:\\w';
    writeSession(root, 'prev', cwd, [userEvent(1, '上一句原文'), assistantEvent(2, '上一句回复')]);
    recordShadowV2(db, {
      sid: 'prev',
      turn: 0,
      t: 1000,
      rangeStart: 1,
      rangeEnd: 2,
      seqs: '[1,2]',
      text: '缓存摘要正文',
      charsBefore: 100,
      charsAfter: 10,
      kept: 4,
      lostRatio: 0.1,
      dangling: 0,
      applied: true,
      cwd,
    });
    const session = { header: { cwd }, surface: { nodes: [0] }, eventAt: () => undefined, deriveEventMessage: () => undefined };
    const withOriginals = planCarry(db, { cwd, sid: 'new', session, sessionsRoot: root });
    assert.ok(withOriginals.includes('上一句原文'));
    assert.ok(!withOriginals.includes('缓存摘要正文'));
    // 换一个读不到原文的 workspace：退回摘要（摘要的 cwd 要同 workspace 才有）
    const fallback = planCarry(db, { cwd: 'C:\\w2', sid: 'new', session: { ...session, header: { cwd: 'C:\\w2' } } });
    assert.equal(fallback, null);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
