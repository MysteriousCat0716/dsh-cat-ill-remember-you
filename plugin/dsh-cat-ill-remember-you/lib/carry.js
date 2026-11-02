/**
 * M5 · 跨会话接续
 *
 * 新会话第一轮，把「同 workspace 的上一个会话结尾」接进来。
 * 优先取上一个会话的**最后几条原文**（dsh 自己落盘的 session.v4.jsonl.zstd，
 * append-only，被替换掉的原文也在），原文读不到时才退回 shadow_v2 里
 * 真替换过（applied=1）的缓存摘要——摘要永远是退路，不是正路。
 *
 * 三条边界：
 *   1. 只认同 cwd；cwd 为空的历史行不参与，宁可接不上也不串项目。
 *   2. 不取当前会话自己（文件 mtime 可能最新）。
 *   3. 一个会话只注入一次：判据是**会话历史**里有没有 assistant 回复，
 *      不是 pre-step 的 messages——那个只是本轮 claim 到的新消息。
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
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    const text = String(entry?.text ?? '').replace(/\s+/g, ' ').trim();
    if (text === '') continue;
    const line = `- ${entry.role === 'user' ? '他说' : '我说'}: ${text}`;
    if (picked.length > 0 && size + line.length + 1 > limit) break;
    picked.push(clipText(line, limit));
    size += line.length + 1;
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
 * 接线用的纯函数：该不该注入、注入什么。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{cwd?:string, sid?:string, session?:object, messages?:Array, maxChars?:number}} options
 * @returns {string|null}
 */
export function planCarry(
  db,
  { cwd, sid, session, messages = [], maxChars = LAST_SESSION_MAX_CHARS, sessionsRoot } = {},
) {
  // 同一轮重放时兜底：本轮消息里已经有标记。
  if (hasCarry(messages)) return null;
  // 拿不到会话就不猜——宁可接不上，也不要往一个可能聊了很久的会话里塞。
  if (!session) return null;
  if (hasCarryInSurface(session)) return null;
  if (hasAssistantTurn(session)) return null;
  if (typeof cwd !== 'string' || cwd.trim() === '') return null;
  // 正路：上一个会话的最后几条原文。
  let tail = null;
  try {
    tail = recentSessionOriginals({ cwd, excludeSid: sid, limit: 6, sessionsRoot });
  } catch {
    tail = null;
  }
  if (tail && tail.messages.length > 0) return renderTailCarry(tail, maxChars);
  // 退路：原文文件读不到（旧会话已清理、盘上换过位置）时才用摘要缓存。
  const row = lastSessionCache(db, { cwd, sid, maxChars });
  return row ? renderCarry(row) : null;
}
