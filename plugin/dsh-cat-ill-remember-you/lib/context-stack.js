/** 注入块头部标记；测试和日志靠它认「这一段是全局栈」。 */
export const STACK_MARK = '[全局上下文]';

/**
 * 每个会话各留多少条 active 指针。
 * 容量是存储问题、预算是渲染问题，两者不该共用一个数：本会话几乎每句占一条，
 * 用全局小容量会把别的会话整段挤掉，「按会话分配」就成了空话。
 */
export const STACK_PER_SESSION = 40;

/** 全局安全网：会话数太多时，超出这个总数的最早指针出栈。 */
export const STACK_LIMIT = 400;

/** 每轮注入的条数安全上限：只做汇报与兜底，主约束是字数。 */
export const INJECT_LIMIT = 30;

/**
 * 每个会话的字数预算，按「新→旧」递减。
 * 成本跟字数走，条数是它的不稳定估计；比例承接原来的 6/5/4/3/2/1。
 */
export const SESSION_BUDGETS = [900, 700, 550, 450, 350, 250];

/** 本会话段（更早的行）从总预算里切走的一块。 */
export const LOCAL_BUDGET = 600;

/** readLocalStack 的默认条数（旧调用方还在用）。 */
export const LOCAL_EXTRA = 9;

/** 注入时的总字数硬顶——安全网，不是分配依据。 */
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
 * 出栈：每个会话只留最近 perSession 条 active，全局再有上限兜底。
 * 不删行、不删 turns——出栈只是「不再当原文进注入」。
 *
 * 两级是故意的：一级按会话，保证本会话再长也挤不掉别的会话的尾巴；
 * 二级按全局，防止会话越开越多把指针表撑大。limit 仍是总容量，测试与旧调用方靠它。
 * @returns {number} 本次出栈条数
 */
export function evictOverflow(db, { limit = STACK_LIMIT, perSession = STACK_PER_SESSION } = {}) {
  const cap = Math.max(1, Math.floor(Number(limit) || STACK_LIMIT));
  const per = Math.max(1, Math.floor(Number(perSession) || STACK_PER_SESSION));
  const update = db.prepare('UPDATE context_stack SET evicted = 1, summary = ? WHERE id = ?');
  let evicted = 0;
  const drain = (rows) => {
    for (const row of rows) {
      update.run(summarizeBlock(db, row), row.id);
      evicted += 1;
    }
  };
  const oldest = db.prepare(
    `SELECT s.id, s.sid, s.seq, t.role, t.text
     FROM context_stack s
     LEFT JOIN turns t ON t.sid = s.sid AND t.seq = s.seq AND t.origin = 'chat'
     WHERE s.evicted = 0 AND s.sid = ?
     ORDER BY s.t ASC, s.id ASC
     LIMIT ?`,
  );

  // 一级：按会话。只数还没出栈的行，用总数算会把 active 全挤掉。
  const sessions = db
    .prepare('SELECT sid, count(*) AS c FROM context_stack WHERE evicted = 0 GROUP BY sid HAVING c > ?')
    .all(per);
  for (const session of sessions) {
    const extra = Number(session.c) - per;
    if (extra <= 0) continue;
    drain(oldest.all(String(session.sid), extra));
  }

  // 二级：全局安全网。
  const active = Number(db.prepare('SELECT count(*) AS c FROM context_stack WHERE evicted = 0').get()?.c) || 0;
  const overflow = active - cap;
  if (overflow <= 0) return evicted;
  drain(
    db
      .prepare(
        `SELECT s.id, s.sid, s.seq, t.role, t.text
         FROM context_stack s
         LEFT JOIN turns t ON t.sid = s.sid AND t.seq = s.seq AND t.origin = 'chat'
         WHERE s.evicted = 0
         ORDER BY s.t ASC, s.id ASC
         LIMIT ?`,
      )
      .all(overflow),
  );
  return evicted;
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
 * 读本会话在栈里的几行（全局段按会话取，本会话不占名额，单独补）。
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

/** 按轮切分：一条 user 开启新轮，其余行跟上一条 user。 */
function splitRounds(rows) {
  const rounds = [];
  for (const row of rows) {
    if (rounds.length === 0 || row.role === 'user') rounds.push([row]);
    else rounds[rounds.length - 1].push(row);
  }
  return rounds;
}

/** 渲染一行。isRaw 为真用原文，否则用出栈摘要或节选。 */
function renderRow(row, { isRaw, rawChars, oldChars, sid }) {
  const source = plainText(row.text);
  const text = isRaw ? clip(source, rawChars) : clip(row.summary ? plainText(row.summary) : source, oldChars);
  // 有真摘要才叫「旧·摘要」；只是原文截断的标「节选」，不撒谎。
  const tag = isRaw ? '' : row.summary ? '（旧·摘要）' : '（节选）';
  const who = row.role === 'user' ? '用户' : '助手';
  // 会话码要显眼：裸的 6 位码会被当成消息 id 或时间的一部分——2026-11-04 就把
  // 上个会话的收尾话当成了本会话的状态。本会话写「本会话」，别的会话一律带码。
  const code = String(row.sid ?? '').slice(-6) || '??????';
  const mark = sid && String(row.sid) === String(sid) ? '[本会话]' : `[会话 ${code}]`;
  return `- ${mark} ${clock(row.t)} ${who}${tag}：${text}`;
}

/**
 * 从尾部往回按「整轮」装：一轮的行要么全进要么全不进。
 * 最新一轮无论如何都留（哪怕单轮就超预算），再往回超了就停。
 * 必须从新往旧装——旧实现从最旧那头装、超了 break，丢掉的正好是最新的行。
 */
function pickRounds(rows, { budget, rawRounds = 0, rawChars = 220, oldChars = 140, sid = '' }) {
  const rounds = splitRounds(rows);
  const rawFrom = Math.max(0, rounds.length - rawRounds);
  const picked = [];
  let used = 0;
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const block = rounds[index].map((row) => {
      const isRaw = index >= rawFrom && !row.evicted;
      return {
        t: row.t,
        key: `${row.sid}:${row.seq}`,
        raw: isRaw,
        line: renderRow(row, { isRaw, rawChars, oldChars, sid }),
      };
    });
    const size = block.reduce((sum, item) => sum + item.line.length + 1, 0);
    if (picked.length > 0 && used + size > budget) break;
    picked.push(...block);
    used += size;
  }
  return picked;
}

/** 某个会话在栈里的最近若干行，按时间正序。 */
// 出栈行不会删、只会累积；长会话几千行时每轮全量走一遍太浪费。
// pickRounds 本来就是从尾部装，所以查询也只取尾部 SESSION_ROWS_LIMIT 条。
const SESSION_ROWS_LIMIT = 200;

function readSessionRows(db, sid, limit = SESSION_ROWS_LIMIT) {
  const rows = db
    .prepare(
      `SELECT s.sid, s.seq, s.t, s.evicted, s.summary, t.role, t.text
       FROM context_stack s
       LEFT JOIN turns t ON t.sid = s.sid AND t.seq = s.seq AND t.origin = 'chat'
       WHERE s.sid = ?
       ORDER BY s.t DESC, s.id DESC
       LIMIT ?`,
    )
    .all(String(sid), Math.max(1, Math.floor(Number(limit) || SESSION_ROWS_LIMIT)));
  return rows.reverse();
}

/** 栈里出现过的会话，按最近时间新→旧。 */
function listSessions(db) {
  return db
    .prepare('SELECT sid, MAX(t) AS mt FROM context_stack GROUP BY sid ORDER BY mt DESC')
    .all();
}

/** 超了就从最旧的开始丢——丢的必须是旧的那头。 */
function trimOldest(items, { maxChars, maxItems }) {
  let total = items.reduce((sum, item) => sum + item.line.length + 1, 0);
  let start = 0;
  while (start < items.length - 1 && (total > maxChars || items.length - start > maxItems)) {
    total -= items[start].line.length + 1;
    start += 1;
  }
  return items.slice(start);
}

/**
 * 把栈渲染成注入块。
 * 主约束是字数：每个会话有自己的预算，从尾部按整轮往回装；条数只做汇报。
 * 本会话不占全局名额，从总预算里另切一块。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{sid?:string, limit?:number, raw?:number, rawChars?:number, oldChars?:number, maxChars?:number, budgets?:number[], localBudget?:number, excludeSeqs?:number[]}} [options]
 */
export function renderStack(
  db,
  {
    sid = '',
    limit = INJECT_LIMIT,
    raw = STACK_RAW,
    rawChars = 220,
    oldChars = 140,
    maxChars = STACK_MAX_CHARS,
    budgets = SESSION_BUDGETS,
    localBudget = LOCAL_BUDGET,
    excludeSeqs = [],
  } = {},
) {
  const globalItems = [];
  let slot = 0;
  for (const session of listSessions(db)) {
    if (slot >= budgets.length) break;
    // 本会话由下面的【本会话】段单独补，不占全局名额。
    if (sid && String(session.sid) === String(sid)) continue;
    const rows = readSessionRows(db, session.sid);
    if (rows.length === 0) continue;
    globalItems.push(
      ...pickRounds(rows, {
        budget: budgets[slot],
        // 只有最新会话的结尾用原文——那是「接上」最需要的。
        rawRounds: slot === 0 ? raw : 0,
        rawChars,
        oldChars,
        sid,
      }),
    );
    slot += 1;
  }

  // 库里只有本会话时全局段会空（新会话第一轮就是这样）；退回按时间取，别空着。
  if (globalItems.length === 0) {
    const skipSeqs = new Set((Array.isArray(excludeSeqs) ? excludeSeqs : []).map((seq) => Number(seq)));
    const rows = readStack(db, { limit: STACK_LIMIT })
      .slice()
      .reverse()
      .filter((row) => !skipSeqs.has(Number(row.seq)));
    globalItems.push(...pickRounds(rows, { budget: maxChars, rawRounds: raw, rawChars, oldChars, sid }));
  }

  globalItems.sort((a, b) => a.t - b.t);
  const globals = trimOldest(globalItems, { maxChars, maxItems: limit });
  const usedGlobal = globals.reduce((sum, item) => sum + item.line.length + 1, 0);

  let locals = [];
  if (sid && localBudget > 0) {
    const keys = new Set(globals.map((item) => item.key));
    // 当前窗口里已有的行不再重复注入：seq 是宿主真相，turn 号是进程内的，
    // 旧会话恢复后不可比。调用方从 session.surface 尾部取 seq 传进来。
    const skipSeqs = new Set((Array.isArray(excludeSeqs) ? excludeSeqs : []).map((seq) => Number(seq)));
    const rows = readSessionRows(db, sid).filter(
      (row) => !keys.has(`${row.sid}:${row.seq}`) && !skipSeqs.has(Number(row.seq)),
    );
    // 全局段没装满的额度不浪费，交给本会话——接上最需要的本来就是最近这几轮。
    const localBudgetNow = Math.max(localBudget, Math.max(0, maxChars - usedGlobal));
    const localItems = pickRounds(rows, { budget: localBudgetNow, rawRounds: 0, rawChars, oldChars, sid });
    localItems.sort((a, b) => a.t - b.t);
    locals = trimOldest(localItems, {
      maxChars: Math.max(0, maxChars - usedGlobal),
      maxItems: Math.max(0, limit - globals.length),
    });
  }

  const rawCount = [...globals, ...locals].filter((item) => item.raw).length;
  const head = `${STACK_MARK} 最近 ${globals.length + locals.length} 条（每会话按字数预算取整轮；最近 ${rawCount} 条原文）\n行首 [会话 xxxxxx] 是会话代码，不同代码不是同一个会话；[本会话] 指当前这句所在的会话。`;
  const parts = [head];
  if (globals.length > 0) parts.push(globals.map((item) => item.line).join('\n'));
  if (locals.length > 0) parts.push('【本会话】', ...locals.map((item) => item.line));
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
export function backfillStack(db, { limit = STACK_PER_SESSION * 4 } = {}) {
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
