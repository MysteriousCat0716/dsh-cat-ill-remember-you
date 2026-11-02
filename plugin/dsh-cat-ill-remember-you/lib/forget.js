/**
 * M4 · 遗忘
 *
 * 只降 tier，不删行。判据是可数的时间，不是模型判断：
 *   active  --30 天没被用过-->  dormant  --再过 60 天-->  cold
 *
 * decision / preference 不参与自动降级：这两类变化慢，误降一次就要重新学。
 * 每次降级写 forget_log，tier 可以手动改回去——遗忘是可回退的降级，不是删除。
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

export const TIER_ACTIVE = 'active';
export const TIER_DORMANT = 'dormant';
export const TIER_COLD = 'cold';

/** Kinds that stay active until verified obsolete by hand. */
const STICKY_KINDS = new Set(['decision', 'preference']);

/** Used time: last_used if it was ever fetched, else the moment it was written. */
function lastTouched(row) {
  const used = row.last_used ?? 0;
  return Math.max(Number(used), Number(row.t ?? 0));
}

/**
 * Sweep one store: demote old, unused memories.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{now?: number, dormantAfterMs?: number, coldAfterMs?: number}} [opts]
 * @returns {{demoted: number, dormant: number, cold: number}}
 */
export function forgetSweep(db, opts = {}) {
  const now = Number(opts.now ?? Date.now());
  const dormantAfterMs = Number(opts.dormantAfterMs ?? 30 * DAY_MS);
  const coldAfterMs = Number(opts.coldAfterMs ?? 60 * DAY_MS);

  const rows = db
    .prepare(
      "SELECT id, kind, tier, t, last_used FROM memories WHERE tier IN ('active','dormant')",
    )
    .all();

  const markDormant = db.prepare("UPDATE memories SET tier = 'dormant' WHERE id = ?");
  const markCold = db.prepare("UPDATE memories SET tier = 'cold' WHERE id = ?");
  const log = db.prepare(
    'INSERT INTO forget_log (memory_id, at, reason, tier_before, tier_after) VALUES (?, ?, ?, ?, ?)',
  );

  let dormant = 0;
  let cold = 0;
  // The tier change and its forget_log line must commit together: a failure
  // halfway would leave a row demoted with no audit trail.
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      if (STICKY_KINDS.has(row.kind)) continue;
      const age = now - lastTouched(row);
      if (row.tier === TIER_ACTIVE && age >= dormantAfterMs) {
        markDormant.run(row.id);
        log.run(row.id, now, `active ${Math.floor(age / DAY_MS)}d unused`, TIER_ACTIVE, TIER_DORMANT);
        dormant += 1;
      } else if (row.tier === TIER_DORMANT && age >= dormantAfterMs + coldAfterMs) {
        markCold.run(row.id);
        log.run(
          row.id,
          now,
          `dormant ${Math.floor(age / DAY_MS)}d unused`,
          TIER_DORMANT,
          TIER_COLD,
        );
        cold += 1;
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* transaction may already be closed */
    }
    throw error;
  }

  return { demoted: dormant + cold, dormant, cold };
}
