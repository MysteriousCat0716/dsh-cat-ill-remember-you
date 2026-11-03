import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { openStore } from '../lib/db.js';
import { recordShadowV2 } from '../lib/shadow-v2.js';
import {
  originalMessages,
  recentSessionOriginals,
  sessionLogFile,
  refPointerOf,
  textOfEvent,
  toolResultsFromEvents,
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

test('recentSessionOriginals 只跳过 origin=subagent，fork 会话照接', () => {
  const root = tempRoot();
  try {
    const cwd = 'C:\\\\w';
    // 子代理：无前缀 uuid + origin=subagent，即使有对话也不该被当成上一个会话
    writeSession(root, 'aaaaaaaa-0000-0000-0000-000000000001', cwd, [
      { type: 'session', seq: 0, origin: 'subagent', data: { id: 'aaaaaaaa' } },
      userEvent(1, '子代理现场'),
    ]);
    // fork：只带 parentSession、不带 origin，是用户自己的分支，应该能接
    writeSession(root, 'session-cccc', cwd, [
      { type: 'session', seq: 0, data: { id: 'session-cccc', parentSession: 'session-parent' } },
      userEvent(1, 'fork 出来的分支'),
    ]);
    const found = recentSessionOriginals({
      cwd,
      excludeSid: 'session-current',
      sessionsRoot: root,
    });
    assert.ok(found);
    assert.equal(found.sid, 'session-cccc');
    assert.deepEqual(found.messages.map((m) => m.text), ['fork 出来的分支']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('refPointerOf: 认出 ref 指针，普通文本返回 null', () => {
  const pointer = refPointerOf(
    '[Stored reference: refId=ref://session-x/read_files/abc; producerTool=read_files; totalBytes=195121]',
  );
  assert.equal(pointer.refId, 'ref://session-x/read_files/abc');
  assert.equal(pointer.producerTool, 'read_files');
  assert.equal(refPointerOf('普通的工具输出'), null);
});

test('toolResultsFromEvents: 按 callId 配工具名，大结果标出 ref', () => {
  const events = [
    {
      type: 'tool/call',
      seq: 1,
      data: { calls: [{ callId: 'c1', name: 'read' }, { callId: 'c2', name: 'bash' }] },
    },
    {
      type: 'tool/result',
      seq: 2,
      data: { message: { source: { callId: 'c1' }, content: [{ type: 'text', text: '小结果原文' }] } },
    },
    {
      type: 'tool/result',
      seq: 3,
      data: {
        message: {
          source: { callId: 'c2' },
          content: [{ type: 'text', text: '[Stored reference: refId=ref://s/bash/xyz; producerTool=bash]' }],
        },
      },
    },
  ];
  const results = toolResultsFromEvents(events);
  assert.equal(results.length, 2);
  assert.equal(results[0].name, 'read');
  assert.equal(results[0].text, '小结果原文');
  assert.equal(results[0].ref, null);
  assert.equal(results[1].name, 'bash');
  assert.equal(results[1].ref.refId, 'ref://s/bash/xyz');
});
