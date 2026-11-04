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

/** retention='ephemeral' 的短曲线：7 天没碰就沉，再 7 天进 cold。 */
export const EPHEMERAL_DORMANT_MS = 7 * DAY_MS;
export const EPHEMERAL_COLD_MS = 7 * DAY_MS;

/**
 * 「真的用上了」才算活着。
 *
 * 误沉的代价比看起来小：dormant 仍在取回池里，reviveOnRecall 会把它升回 active，
 * 所以降级是「排序压一段时间」，不是失忆——这个自愈路径就是这条判据的兜底。
 *
 * 旧判据是「被取回过」：取回一次 age 就重置，一条从没被用到的记忆可以靠
 * 反复被取回一直活着。人不是这样——想起来了但没用上，等于没想起来。
 * 现在只用 recall_log 里 used=1 的最近时间；没有就退回写入时间。
 */
function lastEffective(row, usedAt) {
  const used = usedAt.get(Number(row.id)) ?? 0;
  return Math.max(used, Number(row.t ?? 0));
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
      "SELECT id, kind, tier, retention, t, last_used FROM memories WHERE tier IN ('active','dormant')",
    )
    .all();

  // 预算一次：哪些记忆真的被用上了，最近一次是什么时候。
  // 老库没有 recall_log 时退回时间曲线，不让整轮 sweep 抛错。
  const usedAt = new Map();
  try {
    for (const row of db
      .prepare(
        `SELECT memory_id, MAX(t) AS last FROM recall_log
          WHERE used = 1 AND section = 'recall' AND memory_id IS NOT NULL
          GROUP BY memory_id`,
      )
      .all()) {
      usedAt.set(Number(row.memory_id), Number(row.last) || 0);
    }
  } catch {
    // 没有 recall_log：usedAt 空着，下面自动退回写入时间。
  }

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
      // 显式 permanent 永不降级；ephemeral 走短曲线；auto 走默认曲线。
      if (row.retention === 'permanent') continue;
      const ephemeral = row.retention === 'ephemeral';
      if (!ephemeral && STICKY_KINDS.has(row.kind)) continue;
      const age = now - lastEffective(row, usedAt);
      const dormantAt = ephemeral ? EPHEMERAL_DORMANT_MS : dormantAfterMs;
      const coldAt = dormantAt + (ephemeral ? EPHEMERAL_COLD_MS : coldAfterMs);
      if (row.tier === TIER_ACTIVE && age >= dormantAt) {
        markDormant.run(row.id);
        log.run(
          row.id,
          now,
          `${ephemeral ? 'ephemeral ' : ''}active ${Math.floor(age / DAY_MS)}d unused`,
          TIER_ACTIVE,
          TIER_DORMANT,
        );
        dormant += 1;
      } else if (row.tier === TIER_DORMANT && age >= coldAt) {
        markCold.run(row.id);
        log.run(
          row.id,
          now,
          `${ephemeral ? 'ephemeral ' : ''}dormant ${Math.floor(age / DAY_MS)}d unused`,
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

/**
 * 回升：一次真被取回的 dormant 记忆重新记成 active。
 *
 * 遗忘是可回退的降级，不是删除——但旧实现只有降没有升，沉下去的记忆
 * 就再也浮不上来（召回又只查 active，等于单向门）。
 * 只处理 dormant：cold 是「几乎不再想起」，要回来得靠手动。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number[]} ids
 * @returns {number} 回升条数
 */
export function reviveOnRecall(db, ids) {
  const unique = [...new Set((ids ?? []).map(Number).filter((id) => Number.isFinite(id) && id > 0))];
  if (unique.length === 0) return 0;
  const placeholders = unique.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id FROM memories WHERE tier = 'dormant' AND id IN (${placeholders})`)
    .all(...unique);
  if (rows.length === 0) return 0;
  const now = Date.now();
  const revive = db.prepare("UPDATE memories SET tier = 'active', last_used = ? WHERE id = ?");
  const log = db.prepare(
    'INSERT INTO forget_log (memory_id, at, reason, tier_before, tier_after) VALUES (?, ?, ?, ?, ?)',
  );
  // 状态和审计行一起提交：只改 tier 不写 forget_log 的话，事后没法解释
  // 一条记忆为什么又活了。
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      revive.run(now, row.id);
      log.run(row.id, now, 'recalled', 'dormant', 'active');
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
  return rows.length;
}
