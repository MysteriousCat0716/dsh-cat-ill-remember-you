/** 注入块头部标记；测试和日志靠它认「这一段是全局栈」。 */
export const STACK_MARK = '[全局上下文]';

/** 栈容量：跨会话按时间保留最近这么多条指针。 */
export const STACK_LIMIT = 10;

/** 最近的这么多条用原文；更早的用出栈时留下的摘要。 */
export const STACK_RAW = 4;

/** 出栈摘要的长度上限。 */
const SUMMARY_CHARS = 140;

function clip(text, maxChars) {
  const source = String(text ?? '');
  if (source.length <= maxChars) return source;
  return `${source.slice(0, Math.max(1, maxChars - 1))}…`;
}

function clock(t) {
  const date = new Date(Number(t) || 0);
  return Number.isNaN(date.getTime()) ? '--:--' : date.toISOString().slice(11, 16);
}

/** 本地摘要：不调模型，只做首尾保留。够让「有过这件事」活下来。 */
function summarize(text) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= SUMMARY_CHARS) return clean;
  return `${clean.slice(0, 80)}…${clean.slice(-40)}`;
}

/**
 * 入栈：只记指针。同一 (sid, seq) 重复入栈是幂等的。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{sid:string, seq:number, t?:number}} item
 */
export function pushStack(db, { sid, seq, t = Date.now() }) {
  db.prepare(`INSERT OR IGNORE INTO context_stack (sid, seq, t) VALUES (?, ?, ?)`).run(
    String(sid),
    Number(seq),
    Number(t),
  );
}

/** 当前栈里还没出栈的条数。 */
export function stackSize(db) {
  return Number(db.prepare('SELECT count(*) AS c FROM context_stack').get()?.c) || 0;
}

/**
 * 出栈：超过 limit 的最早几条标记 evicted，并写一份本地摘要。
 * 不删行、不删 turns——出栈只是「不再当原文进注入」。
 * @returns {number} 本次出栈条数
 */
export function evictOverflow(db, { limit = STACK_LIMIT } = {}) {
  const cap = Math.max(1, Math.floor(Number(limit) || STACK_LIMIT));
  const overflow = stackSize(db) - cap;
  if (overflow <= 0) return 0;
  const rows = db
    .prepare(
      `SELECT s.id, s.sid, s.seq, t.text
       FROM context_stack s
       LEFT JOIN turns t ON t.sid = s.sid AND t.seq = s.seq AND t.origin = 'chat'
       WHERE s.evicted = 0
       ORDER BY s.t ASC, s.id ASC
       LIMIT ?`,
    )
    .all(overflow);
  const update = db.prepare('UPDATE context_stack SET evicted = 1, summary = ? WHERE id = ?');
  for (const row of rows) update.run(summarize(row.text), row.id);
  return rows.length;
}

/**
 * 读栈：跨会话按时间取最近 limit 条指针。正文现查，查不到就用摘要。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{limit?:number}} [options]
 */
export function readStack(db, { limit = STACK_LIMIT } = {}) {
  const cap = Math.max(1, Math.floor(Number(limit) || STACK_LIMIT));
  return db
    .prepare(
      `SELECT s.sid, s.seq, s.t, s.evicted, s.summary, t.role, t.text
       FROM context_stack s
       LEFT JOIN turns t ON t.sid = s.sid AND t.seq = s.seq AND t.origin = 'chat'
       ORDER BY s.t DESC, s.id DESC
       LIMIT ?`,
    )
    .all(cap);
}

/**
 * 把栈渲染成注入块：最近 raw 条用原文，出了栈的用摘要。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{limit?:number, raw?:number, rawChars?:number, oldChars?:number}} [options]
 */
export function renderStack(
  db,
  { limit = STACK_LIMIT, raw = STACK_RAW, rawChars = 220, oldChars = 140 } = {},
) {
  const rows = readStack(db, { limit });
  if (rows.length === 0) return '';
  const lines = rows.map((row, index) => {
    const newest = index < raw && !row.evicted;
    const who = row.role === 'user' ? '用户' : '助手';
    const text = newest ? clip(row.text, rawChars) : clip(row.summary || row.text, oldChars);
    const tag = newest ? '' : '（旧·摘要）';
    return `- ${clock(row.t)} ${String(row.sid).slice(-6)} ${who}${tag}：${text}`;
  });
  const head = `${STACK_MARK} 最近 ${rows.length} 条（跨会话，按时间；最近 ${Math.min(raw, rows.length)} 条原文）`;
  return `${head}\n${lines.join('\n')}`;
}

/**
 * 首次启用时用 turns 里最近的历史把栈铺满（只做一次）。
 * 没有这一步，升级后的栈是空的，要等新消息才慢慢有内容。
 * @returns {number} 本次入栈条数
 */
export function backfillStack(db, { limit = STACK_LIMIT * 4 } = {}) {
  if (stackSize(db) > 0) return 0;
  const rows = db
    .prepare(
      `SELECT sid, seq, t FROM turns
       WHERE origin = 'chat' AND length(text) > 0
       ORDER BY t DESC, seq DESC
       LIMIT ?`,
    )
    .all(limit);
  for (const row of rows) pushStack(db, { sid: row.sid, seq: row.seq, t: row.t });
  // 铺多取一些再按正常容量出栈，让更早的提前拿到摘要，不留一个超容量的表。
  evictOverflow(db);
  return rows.length;
}
