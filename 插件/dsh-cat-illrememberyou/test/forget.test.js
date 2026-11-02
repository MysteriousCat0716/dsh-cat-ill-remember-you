import test from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '../lib/db.js';
import { forgetSweep, DAY_MS } from '../lib/forget.js';

function seed(db, { kind = 'fact', tier = 'active', t = 0, lastUsed = 0, text = 'x' }) {
  const info = db
    .prepare(
      'INSERT INTO memories (kind, text, summary, t, tier, last_used) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(kind, text, text, t, tier, lastUsed || null);
  return Number(info.lastInsertRowid);
}

function tierOf(db, id) {
  return db.prepare('SELECT tier FROM memories WHERE id = ?').get(id).tier;
}

test('old unused fact goes active -> dormant and logs it', () => {
  const db = openStore(':memory:');
  const now = 100 * DAY_MS;
  const id = seed(db, { t: now - 40 * DAY_MS, lastUsed: now - 40 * DAY_MS });
  const result = forgetSweep(db, { now });
  assert.equal(result.dormant, 1);
  assert.equal(tierOf(db, id), 'dormant');
  const log = db.prepare('SELECT * FROM forget_log WHERE memory_id = ?').get(id);
  assert.equal(log.tier_before, 'active');
  assert.equal(log.tier_after, 'dormant');
  db.close();
});

test('dormant memory older than 90 days goes cold', () => {
  const db = openStore(':memory:');
  const now = 200 * DAY_MS;
  const id = seed(db, { tier: 'dormant', t: now - 95 * DAY_MS, lastUsed: now - 95 * DAY_MS });
  const result = forgetSweep(db, { now });
  assert.equal(result.cold, 1);
  assert.equal(tierOf(db, id), 'cold');
  db.close();
});

test('decision and preference never demote', () => {
  const db = openStore(':memory:');
  const now = 200 * DAY_MS;
  const a = seed(db, { kind: 'decision', t: now - 100 * DAY_MS });
  const b = seed(db, { kind: 'preference', t: now - 100 * DAY_MS });
  forgetSweep(db, { now });
  assert.equal(tierOf(db, a), 'active');
  assert.equal(tierOf(db, b), 'active');
  db.close();
});

test('fresh memory stays active', () => {
  const db = openStore(':memory:');
  const now = 200 * DAY_MS;
  const id = seed(db, { t: now - 2 * DAY_MS, lastUsed: now - 2 * DAY_MS });
  const result = forgetSweep(db, { now });
  assert.equal(result.demoted, 0);
  assert.equal(tierOf(db, id), 'active');
  db.close();
});

test('recently used memory is not demoted even if written long ago', () => {
  const db = openStore(':memory:');
  const now = 200 * DAY_MS;
  const id = seed(db, { t: now - 100 * DAY_MS, lastUsed: now - DAY_MS });
  forgetSweep(db, { now });
  assert.equal(tierOf(db, id), 'active');
  db.close();
});
