import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../lib/db.js';

test('openStore refuses an empty or foreign file instead of re-initializing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ill-remember-you-'));
  try {
    const empty = path.join(dir, 'empty.db');
    fs.writeFileSync(empty, '');
    assert.throws(() => openStore(empty), /refusing to initialize empty store/);

    const foreign = path.join(dir, 'foreign.db');
    fs.writeFileSync(foreign, 'not a database');
    assert.throws(() => openStore(foreign));

    // A file with only one of our tables is someone else's store, not ours.
    const half = path.join(dir, 'half.db');
    const halfDb = new DatabaseSync(half);
    halfDb.exec('CREATE TABLE turns (id INTEGER PRIMARY KEY)');
    halfDb.close();
    assert.throws(() => openStore(half), /not an ill-remember-you store/);

    const fresh = path.join(dir, 'fresh.db');
    const db = openStore(fresh);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'turns'").get());
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
