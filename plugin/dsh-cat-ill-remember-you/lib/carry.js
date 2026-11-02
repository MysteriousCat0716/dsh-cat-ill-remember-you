/**
 * M5 · 跨会话接续
 *
 * 每轮把「同 workspace 里其他活跃会话的结尾」接进来，不再只接新会话第一轮、
 * 也不只接最近那一个——快速在几个会话间切换时，每个来源各自更新、各自去重。
 * 优先读 turns 表（已过滤注入与工具），读不到再退回会话文件原文，
 * 最后才用 shadow_v2 里真替换过的摘要缓存。
 *
 * 三条边界：
 *   1. 只认同 cwd；cwd 为空的历史行不参与，宁可接不上也不串项目。
 *   2. 不取当前会话自己（文件 mtime 可能最新）。
 *   3. 同一来源没更新就不重复注：判据是来源会话最新一条的 seq，记在
 *      `carry_log` 里，跨重启成立。
 */

import { recentSessionOriginals } from './originals.js';
import { surfaceMessages } from './shadow-v2.js';

export const LAST_SESSION_MARK = '[上次会话结尾]';
export const LAST_SESSION_MAX_CHARS = 1600;

/** @param {string} text @param {number} maxChars */
export function clipText(text, maxChars = LAST_SESSION_MAX_CHARS) {
  const s = String(text ?? '').trim();
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(1, maxChars - 1))}…`;
}

function stamp(t) {
  const d = new Date(Number(t));
  if (!Number.isFinite(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 同一个 workspace 里，除当前会话外最近一条真替换缓存。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{cwd?:string, sid?:string, maxChars?:number}} options
 * @returns {{sid:string, t:number, text:string}|null}
 */
export function lastSessionCache(db, { cwd, sid, maxChars = LAST_SESSION_MAX_CHARS } = {}) {
  if (!db || typeof cwd !== 'string' || cwd.trim() === '') return null;
  let row;
  try {
    row = db
      .prepare(
        `SELECT sid, t, text FROM shadow_v2
         WHERE applied = 1 AND cwd = ? AND sid != ? AND length(text) > 0
         ORDER BY t DESC, id DESC LIMIT 1`,
      )
      .get(cwd, String(sid ?? ''));
  } catch {
    // 老库还没有 cwd 列时不要打断会话；升级失败就当接不上。
    return null;
  }
  if (!row || typeof row.text !== 'string' || row.text.trim() === '') return null;
  return { sid: String(row.sid), t: Number(row.t) || 0, text: clipText(row.text, maxChars) };
}

/**
 * 渲染注入文本。写明「不是这个会话」，否则读到时会把两段对话当成同一段。
 * @param {{sid:string, t:number, text:string}} row
 */
export function renderCarry(row) {
  const when = stamp(row?.t);
  const head =
    `${LAST_SESSION_MARK} 另一个会话的最后缓存` +
    (when ? `（${when}）` : '') +
    '，不是当前这段对话。细节在本地文件里，要查用 read / 取回。';
  return `${head}\n${row?.text ?? ''}`;
}

/**
 * 渲染「上一个会话的最后几条原文」。从最近一条往回填，放不下的整条丢掉，
 * 所以留下的总是贴着结尾的那几轮。
 * @param {{sid:string, mtime:number, messages:Array<{role:string,text:string}>}} tail
 */
export function renderTailCarry(tail, maxChars = LAST_SESSION_MAX_CHARS) {
  const messages = Array.isArray(tail?.messages) ? tail.messages : [];
  if (messages.length === 0) return '';
  const when = stamp(tail?.mtime);
  const headFor = (count) =>
    `${LAST_SESSION_MARK} 上一个会话的最后 ${count} 条原文` +
    (when ? `（${when}）` : '') +
    '，不是当前这段对话。原文在本地文件里，要查用 read / 取回。';
  const head = headFor(messages.length);
  const limit = Math.max(120, maxChars - head.length - 1);
  const picked = [];
  let size = 0;
  const perLine = Math.max(160, Math.min(400, Math.floor(limit / 4)));
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    const text = String(entry?.text ?? '').replace(/\s+/g, ' ').trim();
    if (text === '') continue;
    const line = `- ${entry.role === 'user' ? '他说' : '我说'}: ${text}`;
    const clipped = clipText(line, perLine);
    if (picked.length > 0 && size + clipped.length + 1 > limit) break;
    picked.push(clipped);
    size += clipped.length + 1;
  }
  picked.reverse();
  const finalHead = picked.length === messages.length ? head : headFor(picked.length);
  return clipText(`${finalHead}\n${picked.join('\n')}`, maxChars);
}

/** 这条会话历史里是否已经注入过接续缓存。 */export function hasCarry(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => hasCarryText(message));
}

/** 单条消息是否带接续标记。 */
export function hasCarryText(message) {
  const content = message?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((block) => block?.text ?? '').join('\n')
        : '';
  return text.trimStart().startsWith(LAST_SESSION_MARK);
}

/**
 * 会话历史里是否已经出现过接续标记。
 *
 * surfaceMessages 会跳过 source.kind !== 'user' 的消息，而我们自己注入的
 * 那条是 memory-core——所以要直接扫 surface.nodes。覆盖「注入后、还没回复
 * 就重启」这种情况，否则会再注入一次。
 */
export function hasCarryInSurface(session) {
  const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : [];
  for (const seq of nodes) {
    if (!seq) continue;
    try {
      const message = session.deriveEventMessage?.(session.eventAt?.(seq));
      if (hasCarryText(message)) return true;
    } catch {
      // 单个节点坏了不影响判断别的
    }
  }
  return false;
}

/**
 * 会话里是否已经有过 assistant 回复。
 *
 * 这是「是不是新会话」的判据。不能用 pre-step payload 里的 `messages`：
 * 那是 inbox 里 claim 到的**本轮新消息**（`dsh-agent-loop/lib/index.js:909-912`
 * `messages: claimed`），不是会话历史——拿它判 assistant 永远为假，主会话
 * 每轮都会把「上个会话结尾」塞进去（2026-11-03 01:31 实机踩到）。
 * 也不能用 turn：那是进程内轮次（`dsh-agent-loop/lib/index.js:943`），
 * 旧会话恢复后第一轮也是 1。
 *
 * 用 surface 才看到真实历史，而且跨重启成立。
 * @param {object} session
 */
export function hasAssistantTurn(session) {
  return surfaceMessages(session).some((entry) => entry.role === 'assistant');
}

/**
 * 这个会话上次从 fromSid 接到哪个位置（seq / t）。0 表示没接过。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sid
 * @param {string} fromSid
 */
export function lastCarry(db, sid, fromSid) {
  try {
    const row = db
      .prepare('SELECT from_seq FROM carry_log WHERE sid = ? AND from_sid = ?')
      .get(String(sid ?? ''), String(fromSid ?? ''));
    return row ? Number(row.from_seq) || 0 : 0;
  } catch {
    return 0;
  }
}

/**
 * 记下「接过谁、接到哪」。写失败不影响注入，下次多注一次而已。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sid
 * @param {string} fromSid
 * @param {number} fromSeq
 */
export function rememberCarry(db, sid, fromSid, fromSeq) {
  try {
    db.prepare(
      `INSERT INTO carry_log (sid, from_sid, from_seq, t) VALUES (?, ?, ?, ?)
       ON CONFLICT (sid, from_sid) DO UPDATE SET from_seq = excluded.from_seq, t = excluded.t`,
    ).run(String(sid ?? ''), String(fromSid ?? ''), Number(fromSeq) || 0, Date.now());
  } catch {
    // 记账失败不影响本轮注入
  }
}

export const MAX_CARRY_SESSIONS = 4;

/**
 * 其他会话各自最近几条「真对话」。走 turns 表（SQLite，已经过滤注入与工具），
 * 不再每轮解压几个会话文件——快速在多个会话间切换时，只接一个会被别的会话顶掉。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{sid?:string, limit?:number, maxSessions?:number}} options
 * @returns {Array<{sid:string, mtime:number, messages:Array<{seq:number,role:string,text:string}>}>}
 */
export function recentTurnsBySession(db, { sid, limit = 6, maxSessions = MAX_CARRY_SESSIONS } = {}) {
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        `SELECT sid, seq, role, text, t FROM (
           SELECT sid, seq, role, text, t,
                  ROW_NUMBER() OVER (PARTITION BY sid ORDER BY seq DESC) AS rn
           FROM turns WHERE sid != ? AND length(text) > 0
         ) WHERE rn <= ? ORDER BY sid, seq`,
      )
      .all(String(sid ?? ''), Math.max(1, limit));
    const out = [];
    let current = null;
    for (const row of rows) {
      if (!current || current.sid !== row.sid) {
        current = { sid: row.sid, mtime: 0, messages: [] };
        out.push(current);
      }
      current.messages.push({ seq: Number(row.seq), role: row.role, text: String(row.text) });
      current.mtime = Math.max(current.mtime, Number(row.t) || 0);
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out.slice(0, Math.max(1, maxSessions));
  } catch {
    return [];
  }
}

/**
 * 把多个会话的结尾拼成一块。每个会话一个小标题，只带最后几条。
 * @param {Array<{sid:string, mtime:number, messages:Array<{role:string,text:string}>}>} tails
 * @param {number} maxChars
 */
export function renderMultiCarry(tails, maxChars = LAST_SESSION_MAX_CHARS) {
  const list = Array.isArray(tails)
    ? tails.filter((tail) => Array.isArray(tail?.messages) && tail.messages.length > 0)
    : [];
  if (list.length === 0) return '';
  const head =
    `${LAST_SESSION_MARK} 其他会话的最后几条原文（共 ${list.length} 个会话，不是当前这段对话）。` +
    '原文在本地文件里，要查用 read / 取回。';
  const budget = Math.max(300, maxChars - head.length - 1);
  const perSession = Math.max(160, Math.floor(budget / list.length) - 40);
  const parts = [head];
  for (const tail of list) {
    const when = stamp(tail.mtime);
    const messages = tail.messages.slice(-6);
    const perLine = Math.max(80, Math.min(300, Math.floor(perSession / Math.max(1, messages.length))));
    const lines = [];
    for (const entry of messages) {
      const text = String(entry?.text ?? '').replace(/\s+/g, ' ').trim();
      if (text === '') continue;
      lines.push(`- ${entry.role === 'user' ? '他说' : '我说'}: ${clipText(text, perLine)}`);
    }
    if (lines.length === 0) continue;
    const title = `### 会话 ${String(tail.sid ?? '').slice(-6)}${when ? `（${when}）` : ''}`;
    parts.push(`${title}\n${lines.join('\n')}`);
  }
  return clipText(parts.join('\n'), maxChars);
}

/**
 * 接线用的纯函数：该不该注入、注入什么。
 *
 * 2026-11-03 起是「每轮都看、所有会话都看」：不再限新会话第一轮，
 * 也不只接最近那一个会话——快速在几个会话间切换时，每个会话各自更新。
 * 判据是来源会话有没有比自己上次接过的更新，有就带上那一轮。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{cwd?:string, sid?:string, session?:object, messages?:Array, maxChars?:number, sessionsRoot?:string}} options
 * @returns {string|null}
 */
export function planCarry(
  db,
  { cwd, sid, session, messages = [], maxChars = LAST_SESSION_MAX_CHARS, sessionsRoot } = {},
) {
  // 同一轮重放时兜底：本轮消息里已经有标记。
  if (hasCarry(messages)) return null;
  if (typeof cwd !== 'string' || cwd.trim() === '') return null;

  // 正路：turns 表里所有其他会话的最近几条，各会话独立去重。
  const tails = [];
  for (const tail of recentTurnsBySession(db, { sid })) {
    const lastSeq = Number(tail.messages[tail.messages.length - 1]?.seq) || 0;
    if (lastSeq <= lastCarry(db, sid, tail.sid)) continue;
    tails.push(tail);
  }
  if (tails.length > 0) {
    for (const tail of tails) {
      const lastSeq = Number(tail.messages[tail.messages.length - 1]?.seq) || 0;
      rememberCarry(db, sid, tail.sid, lastSeq);
    }
    return renderMultiCarry(tails, maxChars);
  }

  // 退路一：原文文件（turns 还没写入、或换了机器）。
  let tail = null;
  try {
    tail = recentSessionOriginals({ cwd, excludeSid: sid, limit: 6, sessionsRoot });
  } catch {
    tail = null;
  }
  if (tail && tail.messages.length > 0) {
    const lastSeq = tail.messages[tail.messages.length - 1].seq;
    if (lastCarry(db, sid, tail.sid) >= lastSeq) return null;
    rememberCarry(db, sid, tail.sid, lastSeq);
    return renderTailCarry(tail, maxChars);
  }
  // 退路二：真替换缓存摘要。
  const row = lastSessionCache(db, { cwd, sid, maxChars });
  if (!row) return null;
  if (lastCarry(db, sid, row.sid) >= row.t) return null;
  rememberCarry(db, sid, row.sid, row.t);
  return renderCarry(row);
}
