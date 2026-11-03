import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_DB_FILE = path.join(os.homedir(), '.dsh', 'memory', 'core.db');

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS turns (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  sid       TEXT    NOT NULL,
  seq       INTEGER NOT NULL,
  role      TEXT    NOT NULL,
  origin    TEXT    NOT NULL DEFAULT 'chat',
  cwd       TEXT    NOT NULL DEFAULT '',
  text      TEXT    NOT NULL,
  t         INTEGER NOT NULL,
  consumed  INTEGER NOT NULL DEFAULT 0,
  scanned_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE (sid, seq, role)
);
CREATE INDEX IF NOT EXISTS idx_turns_pending ON turns (consumed, id);
CREATE INDEX IF NOT EXISTS idx_turns_sid     ON turns (sid, seq);

CREATE TABLE IF NOT EXISTS memories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT    NOT NULL DEFAULT 'fact',
  origin     TEXT    NOT NULL DEFAULT 'chat',
  subject    TEXT    NOT NULL DEFAULT 'user',
  text       TEXT    NOT NULL,
  summary    TEXT    NOT NULL DEFAULT '',
  entities   TEXT    NOT NULL DEFAULT '[]',
  anchors    TEXT    NOT NULL DEFAULT '[]',
  why        TEXT    NOT NULL DEFAULT '',
  tier       TEXT    NOT NULL DEFAULT 'active',
  retention  TEXT    NOT NULL DEFAULT 'auto',
  t          INTEGER NOT NULL,
  last_used  INTEGER,
  verified   INTEGER,
  source_sid TEXT,
  source_seq INTEGER,
  confidence TEXT NOT NULL DEFAULT 'explicit'
);
CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories (tier, last_used);

CREATE TABLE IF NOT EXISTS entities (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  kind       TEXT    NOT NULL DEFAULT '',
  mentions   INTEGER NOT NULL DEFAULT 0,
  last_seen  INTEGER
);

CREATE TABLE IF NOT EXISTS embeddings (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
  model     TEXT    NOT NULL,
  dim       INTEGER NOT NULL,
  vec       BLOB    NOT NULL,
  t         INTEGER NOT NULL,
  UNIQUE (memory_id, model)
);

CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT    NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  status      TEXT    NOT NULL DEFAULT 'running',
  note        TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS recall_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  sid       TEXT    NOT NULL,
  turn      INTEGER NOT NULL,
  t         INTEGER NOT NULL,
  memory_id INTEGER,
  why       TEXT    NOT NULL DEFAULT '',
  score     REAL,
  used      INTEGER
);

CREATE TABLE IF NOT EXISTS shadow_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  sid            TEXT    NOT NULL,
  turn           INTEGER NOT NULL,
  t              INTEGER NOT NULL,
  replaced       INTEGER NOT NULL DEFAULT 0,
  replaced_chars INTEGER NOT NULL DEFAULT 0,
  added          INTEGER NOT NULL DEFAULT 0,
  hint_chars     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS forget_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id   INTEGER NOT NULL,
  at          INTEGER NOT NULL,
  reason      TEXT    NOT NULL,
  tier_before TEXT    NOT NULL,
  tier_after  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS shadow_v2 (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  sid          TEXT    NOT NULL,
  turn         INTEGER NOT NULL DEFAULT 0,
  t            INTEGER NOT NULL,
  range_start  INTEGER NOT NULL,
  range_end    INTEGER NOT NULL,
  seqs         TEXT    NOT NULL,
  text         TEXT    NOT NULL,
  chars_before INTEGER NOT NULL,
  chars_after  INTEGER NOT NULL,
  kept         INTEGER NOT NULL DEFAULT 0,
  lost_ratio   REAL    NOT NULL DEFAULT 0,
  dangling     INTEGER NOT NULL DEFAULT 0,
  applied      INTEGER NOT NULL DEFAULT 0,
  cwd          TEXT    NOT NULL DEFAULT ''
);

-- 全局上下文栈：只存指针（哪条会话的哪一句），正文仍在 turns。
-- 入栈发生在 ingest；栈超过上限时最早的一条被标记 evicted 并留下一份
-- 本地摘要，注入时用它代替原文。出栈不删任何东西。
CREATE TABLE IF NOT EXISTS context_stack (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  sid     TEXT    NOT NULL,
  seq     INTEGER NOT NULL,
  t       INTEGER NOT NULL,
  evicted INTEGER NOT NULL DEFAULT 0,
  summary TEXT    NOT NULL DEFAULT '',
  UNIQUE (sid, seq)
);
CREATE INDEX IF NOT EXISTS idx_stack_t ON context_stack (t, id);

-- 常驻层：每轮都要在场的那一小块。来源可以是人工写入（从别的记忆系统迁来），
-- 也可以由提炼器从对话里抽出来。target 决定进哪一区：user / memory。
CREATE TABLE IF NOT EXISTS persona (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  target     TEXT    NOT NULL DEFAULT 'user',
  content    TEXT    NOT NULL,
  importance TEXT    NOT NULL DEFAULT 'normal',
  source     TEXT    NOT NULL DEFAULT '',
  t          INTEGER NOT NULL,
  last_used  INTEGER,
  UNIQUE (target, content)
);
CREATE INDEX IF NOT EXISTS idx_persona_target ON persona (target, importance, t);

-- full 模式每轮都会写一行 shadow_v2，按 sid 查旧块时没有索引会全表扫。
CREATE INDEX IF NOT EXISTS idx_shadow_v2_sid ON shadow_v2 (sid, applied);
`;

/**
 * Add a column that older stores lack. `CREATE TABLE IF NOT EXISTS` never
 * rewrites an existing table, so upgrades need an explicit ALTER.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} table
 * @param {string} column
 * @param {string} ddl
 */
function ensureColumn(db, table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

/**
 * Open (or create) the memory core database.
 * @param {string} [file] database path; ':memory:' for tests.
 * @returns {import('node:sqlite').DatabaseSync}
 */
export function openStore(file = DEFAULT_DB_FILE) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  // Refuse to silently turn an empty or foreign file into a fresh store: that is
  // exactly how a wiped database looks, and quietly re-initializing it would
  // hide the loss. First run creates the file, so `exists === false` is fine.
  if (file !== ':memory:' && fs.existsSync(file)) {
    const size = fs.statSync(file).size;
    if (size === 0) {
      throw new Error(`refusing to initialize empty store file: ${file}`);
    }
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const row = db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('turns', 'memories')",
        )
        .get();
      if (Number(row?.n ?? 0) < 2) throw new Error(`not an ill-remember-you store: ${file}`);
    } finally {
      db.close();
    }
  }
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    // web and headless can point at the same file; wait briefly instead of
    // failing with SQLITE_BUSY on a refine/forget transaction.
    db.exec('PRAGMA busy_timeout = 3000');
    if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA);
    ensureColumn(db, 'turns', 'origin', "TEXT NOT NULL DEFAULT 'chat'");
    ensureColumn(db, 'memories', 'origin', "TEXT NOT NULL DEFAULT 'chat'");
    ensureColumn(db, 'memories', 'subject', "TEXT NOT NULL DEFAULT 'user'");
    ensureColumn(db, 'memories', 'retention', "TEXT NOT NULL DEFAULT 'auto'");
    ensureColumn(db, 'memories', 'confidence', "TEXT NOT NULL DEFAULT 'explicit'");
    ensureColumn(db, 'turns', 'scanned_at', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(db, 'turns', 'cwd', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, 'shadow_v2', 'applied', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(db, 'shadow_v2', 'cwd', "TEXT NOT NULL DEFAULT ''");
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    throw error;
  }
}

/**
 * Append one raw dialogue turn. Duplicate (sid, seq, role) is ignored.
 * `origin`: 'chat' for the owner typing in the desktop/web chat, 'im' for a
 * connected IM channel (QQ/Feishu/...), 'unknown' when the source carries no
 * channel hint.
 * `cwd`: the workspace the session belongs to. 空值表示「归属未知」，
 * 不参与按 workspace 的原文回看（宁可接不上也不串项目）。
 * @returns {number} rows inserted (0 or 1)
 */
export function insertTurn(db, { sid, seq, role, text, origin = 'chat', cwd = '', t = Date.now() }) {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO turns (sid, seq, role, origin, cwd, text, t) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const result = stmt.run(sid, seq, role, origin, cwd, text, t);
  return Number(result.changes ?? 0);
}

/** How long a scanned-but-empty turn waits before a rule/model upgrade may re-read it. */
export const DEFAULT_RESCAN_MS = 24 * 60 * 60 * 1000;

/** Raw turns not yet distilled, oldest first. A turn scanned without producing a
 * memory is retried after `rescanMs` instead of being consumed for good: a better
 * rule set or model must be able to read the turns the previous one skipped. */
export function pendingTurns(db, limit = 40, rescanMs = DEFAULT_RESCAN_MS) {
  return db
    .prepare(
      'SELECT id, sid, seq, role, origin, text, t FROM turns ' +
        'WHERE consumed = 0 AND (scanned_at = 0 OR scanned_at < ?) ORDER BY id LIMIT ?',
    )
    .all(Date.now() - rescanMs, limit);
}

/** How many raw turns are waiting for a distillation pass. */
export function pendingCount(db, rescanMs = DEFAULT_RESCAN_MS) {
  const row = db
    .prepare(
      'SELECT COUNT(*) AS n FROM turns WHERE consumed = 0 AND (scanned_at = 0 OR scanned_at < ?)',
    )
    .get(Date.now() - rescanMs);
  return Number(row?.n ?? 0);
}

/** Mark turns consumed by a successful distillation run. */
export function markConsumed(db, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const stmt = db.prepare('UPDATE turns SET consumed = 1 WHERE id = ?');
  let changed = 0;
  for (const id of ids) changed += Number(stmt.run(id).changes ?? 0);
  return changed;
}

/** Mark turns scanned by a run that produced no memory; they stay retryable. */
export function markScanned(db, ids, t = Date.now()) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const stmt = db.prepare('UPDATE turns SET scanned_at = ? WHERE id = ?');
  let changed = 0;
  for (const id of ids) changed += Number(stmt.run(t, id).changes ?? 0);
  return changed;
}
