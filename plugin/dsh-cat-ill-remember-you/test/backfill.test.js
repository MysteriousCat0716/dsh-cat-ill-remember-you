import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { openStore } from '../lib/db.js';
import { backfillTurnCwd } from '../lib/backfill.js';

function writeSession(root, workspaceDir, sid, cwd) {
  const dir = join(root, workspaceDir, sid);
  mkdirSync(dir, { recursive: true });
  const header = JSON.stringify({ type: 'session', version: 4, id: sid, cwd }) + '\n';
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(header)));
}

test('backfillTurnCwd: 按会话文件头的 cwd 补旧行，认不出的保持空', () => {
  const db = openStore(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'carry-backfill-'));
  try {
    writeSession(root, '--W--', 'session-a', '/w');
    const insert = db.prepare(
      'INSERT OR IGNORE INTO turns (sid, seq, role, origin, cwd, text, t) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    insert.run('session-a', 1, 'user', 'chat', '', '能认领的旧话', 1);
    insert.run('session-gone', 1, 'user', 'chat', '', '文件已经不在的旧话', 2);

    assert.equal(backfillTurnCwd(db, { sessionsRoot: root }), 1);
    const rows = db.prepare('SELECT sid, cwd FROM turns ORDER BY sid').all();
    assert.deepEqual(
      rows.map((row) => [row.sid, row.cwd]),
      [
        ['session-a', '/w'],
        ['session-gone', ''],
      ],
    );
    // 幂等：没有空行可补时不再扫描。
    assert.equal(backfillTurnCwd(db, { sessionsRoot: root }), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    db.close();
  }
});

test('backfillTurnCwd: 损坏的会话文件不写坏值，也不抛', () => {
  const db = openStore(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'carry-backfill-bad-'));
  try {
    const dir = join(root, '--W--', 'session-bad');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), 'not a zstd stream');
    db.prepare(
      'INSERT OR IGNORE INTO turns (sid, seq, role, origin, cwd, text, t) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('session-bad', 1, 'user', 'chat', '', 'x', 1);

    assert.equal(backfillTurnCwd(db, { sessionsRoot: root }), 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM turns WHERE cwd = ''").get().n, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    db.close();
  }
});
