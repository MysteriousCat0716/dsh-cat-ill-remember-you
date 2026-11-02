import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../lib/db.js';

test('openStore refuses an empty or foreign file instead of re-initializing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'illrememberyou-'));
  try {
    const empty = path.join(dir, 'empty.db');
    fs.writeFileSync(empty, '');
    assert.throws(() => openStore(empty), /refusing to initialize empty store/);

    const foreign = path.join(dir, 'foreign.db');
    fs.writeFileSync(foreign, 'not a database');
    assert.throws(() => openStore(foreign));

    const fresh = path.join(dir, 'fresh.db');
    const db = openStore(fresh);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'turns'").get());
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
