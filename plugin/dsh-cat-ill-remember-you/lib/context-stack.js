/** 栈容量：跨会话按时间保留最近这么多条指针。 */
export const STACK_LIMIT = 10;

/** 最近的这么多条用原文；更早的用缓存摘要。 */
export const STACK_RAW = 4;

function clip(text, maxChars) {
  const source = String(text ?? '');
  if (source.length <= maxChars) return source;
  return `${source.slice(0, Math.max(1, maxChars - 1))}…`;
}

function clock(t) {
  const date = new Date(Number(t) || 0);
  return Number.isNaN(date.getTime()) ? '--:--' : date.toISOString().slice(11, 16);
}

/**
 * 读栈：跨会话按时间取最近 limit 条指针。栈里只有指针，正文现查。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{limit?:number}} [options]
 */
export function readStack(db, { limit = STACK_LIMIT } = {}) {
  const cap = Math.max(1, Math.floor(Number(limit) || STACK_LIMIT));
  return db
    .prepare(
      `SELECT sid, seq, role, t, text FROM turns
       WHERE origin = 'chat' AND length(text) > 0
       ORDER BY t DESC, seq DESC
       LIMIT ?`,
    )
    .all(cap);
}

/**
 * 找覆盖这条消息的替换块（摘要缓存）。
 * @returns {string|null}
 */
export function cachedSummary(db, sid, seq) {
  const rows = db
    .prepare('SELECT seqs, text FROM shadow_v2 WHERE sid = ? AND applied = 1 ORDER BY id DESC')
    .all(sid);
  for (const row of rows) {
    let seqs;
    try {
      seqs = JSON.parse(row.seqs);
    } catch {
      continue;
    }
    if (Array.isArray(seqs) && seqs.includes(seq)) return String(row.text ?? '');
  }
  return null;
}

/**
 * 把栈渲染成注入块：最近 raw 条原文，更早的用缓存摘要（找不到就截断原文）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{limit?:number, raw?:number, rawChars?:number, oldChars?:number}} [options]
 */
export function renderStack(
  db,
  { limit = STACK_LIMIT, raw = STACK_RAW, rawChars = 220, oldChars = 140, exclude } = {},
) {
  const skip = exclude instanceof Set ? exclude : new Set(Array.isArray(exclude) ? exclude : []);
  // carry 已经渲染过的行不再进栈：两处同时给同一段话，白花字数也重复。
  // 多取一些再过滤，保证过滤后仍能凑满 limit 条。
  const rows = readStack(db, { limit: limit + Math.min(20, skip.size) })
    .filter((row) => !skip.has(`${row.sid}:${row.seq}`))
    .slice(0, limit);
  if (rows.length === 0) return '';
  const lines = rows.map((row, index) => {
    const newest = index < raw;
    const who = row.role === 'user' ? '他说' : '我说';
    let text;
    if (newest) {
      text = clip(row.text, rawChars);
    } else {
      const summary = cachedSummary(db, row.sid, row.seq);
      text = clip(summary ?? row.text, oldChars);
    }
    const tag = newest ? '' : '（旧·摘要）';
    return `- ${clock(row.t)} ${String(row.sid).slice(-6)} ${who}${tag}：${text}`;
  });
  const head = `[全局上下文] 最近 ${rows.length} 条（跨会话，按时间；最近 ${Math.min(raw, rows.length)} 条原文）`;
  return `${head}\n${lines.join('\n')}`;
}
