/** 注入块头部标记；测试和日志靠它认「这一段是全局栈」。 */
export const STACK_MARK = '[全局上下文]';

/** 栈容量：跨会话按时间保留最近这么多条指针。 */
export const STACK_LIMIT = 50;

/** 每次注入取多少条全局指针。 */
export const INJECT_LIMIT = 20;

/** 全局之外，最多再补多少条本会话更早的指针。 */
export const LOCAL_EXTRA = 10;

/** 注入时的总字数硬顶；条数够了但太长就只取最近几条。 */
export const STACK_MAX_CHARS = 3000;

/**
 * 最近的这么多「轮」用原文；更早的用出栈时留下的摘要。
 * 一轮 = 一条 user 到下一条 user 之前；按条算会让多步回复把自己的提问挤成摘要。
 */
export const STACK_RAW = 2;

/** 出栈摘要的长度上限。 */
const SUMMARY_CHARS = 140;

function clip(text, maxChars) {
  const source = String(text ?? '');
  if (source.length <= maxChars) return source;
  return `${source.slice(0, Math.max(1, maxChars - 1))}…`;
}

function clock(t) {
  const date = new Date(Number(t) || 0);
  if (Number.isNaN(date.getTime())) return '--:--';
  // 栈是给人读「刚才 / 昨晚」的，必须用本机时区。toISOString 是 UTC，
  // 在 +08:00 会差 8 小时，跨天时还会把凌晨写成前一天下午。
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 从 dsh-ui 树里收集所有可读文本（content / text 字段）。 */
function collectUiText(items, out = []) {
  if (!Array.isArray(items)) return out;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    for (const key of ['content', 'text']) {
      if (typeof item[key] === 'string' && item[key].trim()) out.push(item[key].trim());
    }
    if (item.type === 'table' && Array.isArray(item.rows)) {
      for (const row of item.rows) {
        if (Array.isArray(row)) out.push(row.filter((cell) => typeof cell === 'string').join('｜'));
      }
    }
    if (item.items) collectUiText(item.items, out);
  }
  return out;
}

/**
 * dsh-ui 围栏对栈没有信息量——它渲染完就只剩一坨 JSON。
 * 截断前先把那块换成「[卡片] 标题｜正文」，其余原文保留。
 * 解析失败就原样返回，栈宁可难看也不能因为一块 UI 整条丢掉。
 */
function plainText(text) {
  const source = String(text ?? '');
  const fence = /```dsh-ui\s*\n([\s\S]*?)```/.exec(source);
  if (!fence) return source;
  try {
    const spec = JSON.parse(fence[1]);
    const pieces = [spec.title, ...collectUiText(spec.items)].filter(Boolean);
    const body = pieces.join('｜').replace(/\s+/g, ' ').trim();
    return source.replace(fence[0], body ? `[卡片] ${body}` : '[卡片]');
  } catch {
    return source;
  }
}

/** 本地摘要：不调模型，只做首尾保留。够让「有过这件事」活下来。 */
function summarize(text) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= SUMMARY_CHARS) return clean;
  return `${clean.slice(0, 80)}…${clean.slice(-40)}`;
}

/**
 * 出栈摘要：同一轮的问答一起留——问留开头，答留尾巴。
 * 结论通常在 assistant 回复的末尾，只截 user 那一句会把结论丢掉。
 * 不调模型，回 turns 表按 (sid, seq) 取同一轮的问答。
 * role 来自 turns：user 行问就是它自己；assistant 行要回查前面的 user——
 * 否则会把答写成「问：<结论>」，摘要读起来像用户在问自己的结论。
 */
function summarizeBlock(db, { sid, seq, text, role }) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (role === 'assistant') {
    const question = String(
      db
        .prepare(
          `SELECT text FROM turns
           WHERE sid = ? AND seq < ? AND origin = 'chat' AND role = 'user'
           ORDER BY seq DESC LIMIT 1`,
        )
        .get(sid, seq)?.text ?? '',
    )
      .replace(/\s+/g, ' ')
      .trim();
    const tail = clean.length > 100 ? clean.slice(-100) : clean;
    if (!question) return `我说：${tail}`;
    return `问：${clip(question, 60)}｜答：${tail}`;
  }
  const question = clean;
  const answer = String(
    db
      .prepare(
        `SELECT text FROM turns
         WHERE sid = ? AND seq > ? AND origin = 'chat' AND role = 'assistant'
         ORDER BY seq ASC LIMIT 1`,
      )
      .get(sid, seq)?.text ?? '',
  )
    .replace(/\s+/g, ' ')
    .trim();
  if (!answer) return summarize(question);
  const tail = answer.length > 100 ? answer.slice(-100) : answer;
  return `问：${clip(question, 60)}｜答：${tail}`;
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
  // 只数还没出栈的行：表里留着历史指针，用总数算会把 active 全挤掉。
  const active = Number(db.prepare('SELECT count(*) AS c FROM context_stack WHERE evicted = 0').get()?.c) || 0;
  const overflow = active - cap;
  if (overflow <= 0) return 0;
  const rows = db
    .prepare(
      `SELECT s.id, s.sid, s.seq, t.role, t.text
       FROM context_stack s
       LEFT JOIN turns t ON t.sid = s.sid AND t.seq = s.seq AND t.origin = 'chat'
       WHERE s.evicted = 0
       ORDER BY s.t ASC, s.id ASC
       LIMIT ?`,
    )
    .all(overflow);
  const update = db.prepare('UPDATE context_stack SET evicted = 1, summary = ? WHERE id = ?');
  for (const row of rows) update.run(summarizeBlock(db, row), row.id);
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
 * 读本会话在栈里更早的几行（已被全局 20 条漏掉的）。
 * 按时间取，不做语义匹配——语义要多一次 embedding，且结果不稳定。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{sid?:string, limit?:number, exclude?:Set<string>}} [options]
 */
export function readLocalStack(db, { sid = '', limit = LOCAL_EXTRA, exclude = new Set() } = {}) {
  if (!sid) return [];
  const cap = Math.max(1, Math.floor(Number(limit) || LOCAL_EXTRA));
  const rows = db
    .prepare(
      `SELECT s.sid, s.seq, s.t, s.evicted, s.summary, t.role, t.text
       FROM context_stack s
       LEFT JOIN turns t ON t.sid = s.sid AND t.seq = s.seq AND t.origin = 'chat'
       WHERE s.sid = ?
       ORDER BY s.t DESC, s.id DESC
       LIMIT ?`,
    )
    .all(String(sid), cap + exclude.size);
  return rows.filter((row) => !exclude.has(`${row.sid}:${row.seq}`)).slice(0, cap);
}

/**
 * 把栈渲染成注入块：最近 raw 条用原文，出了栈的用摘要。
 * 全局取 limit 条；再从栈里补最多 localExtra 条本会话更早的，单列一段。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{sid?:string, limit?:number, localExtra?:number, raw?:number, rawChars?:number, oldChars?:number, maxChars?:number}} [options]
 */
export function renderStack(
  db,
  {
    sid = '',
    limit = INJECT_LIMIT,
    localExtra = LOCAL_EXTRA,
    raw = STACK_RAW,
    rawChars = 220,
    oldChars = 140,
    maxChars = STACK_MAX_CHARS,
  } = {},
) {
  // readStack 是「新→旧」，注入块要「旧→新」：从下往上读才是时间顺序。
  const rows = readStack(db, { limit }).slice().reverse();
  if (rows.length === 0) return '';
  // raw 的语义是「轮」不是「条」：从最后一条 user 往前数 raw 个 user，
  // 这个区间内的行全用原文。一轮多步回复不会再把自己的提问挤成摘要。
  let rawFrom = rows.length;
  if (raw > 0) {
    let seen = 0;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (rows[index].role === 'user') {
        seen += 1;
        if (seen === raw) {
          rawFrom = index;
          break;
        }
      }
    }
    if (seen < raw) rawFrom = 0;
  }
  const out = [];
  let used = 0;
  const push = (line) => {
    // 最近的一条无论如何都留着；之后超字数就停，宁可少几条也不撑爆。
    if (out.length > 0 && used + line.length > maxChars) return false;
    out.push(line);
    used += line.length;
    return true;
  };
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const newest = index >= rawFrom && !row.evicted;
    const who = row.role === 'user' ? '用户' : '助手';
    const source = plainText(row.text);
    const text = newest ? clip(source, rawChars) : clip(row.summary ? plainText(row.summary) : source, oldChars);
    // 有真摘要才叫「旧·摘要」；只是原文截断的标「节选」，不撒谎。
    const tag = newest ? '' : row.summary ? '（旧·摘要）' : '（节选）';
    if (!push(`- ${clock(row.t)} ${String(row.sid).slice(-6)} ${who}${tag}：${text}`)) break;
  }
  const head = `${STACK_MARK} 最近 ${out.length} 条（跨会话，按时间正序；最近 ${Math.min(rows.length - rawFrom, out.length)} 条原文）`;
  const parts = [head];
  if (out.length > 0) parts.push(out.join('\n'));
  const local =
    sid && localExtra > 0
      ? readLocalStack(db, {
          sid,
          limit: localExtra,
          exclude: new Set(rows.map((row) => `${row.sid}:${row.seq}`)),
        })
      : [];
  if (local.length > 0) {
    const localLines = [];
    for (const row of local.slice().reverse()) {
      const text = clip(row.summary ? plainText(row.summary) : plainText(row.text), oldChars);
      const tag = row.summary ? '（旧·摘要）' : '（节选）';
      const line = `- ${clock(row.t)} ${row.role === 'user' ? '用户' : '助手'}${tag}：${text}`;
      if (used + line.length > maxChars) break;
      localLines.push(line);
      used += line.length;
    }
    if (localLines.length > 0) parts.push('【本会话更早】', ...localLines);
  }
  return parts.join('\n');
}

/**
 * 栈里的最近几条纯文本，拼成检索 query 的前半段。
 * 不带头部、不做展示格式——检索要的是「在说什么」，不是「长什么样」。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{limit?:number, chars?:number}} [options]
 */
export function stackQueryText(db, { limit = 2, chars = 80 } = {}) {
  return readStack(db, { limit })
    .map((row) => clip(row.summary || row.text, chars))
    .filter(Boolean)
    .join('\n');
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
