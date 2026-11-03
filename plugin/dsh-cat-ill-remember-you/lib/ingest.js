import { insertTurn } from './db.js';
import { evictOverflow, pushStack } from './context-stack.js';
import { refineBlock, wantsImmediate } from './extract.js';

/**
 * 即时通道的待办：sid -> 该块 user 行的 seq。
 * 进程重启会丢，漏掉的块留在待处理队列里，由空闲批兜底。
 */
const pendingImmediate = new Map();

/** Fallback filter for old events that carry no `source` field. */
export const INJECT_RE =
  /^\s*(\[记忆\]|\[上下文替换(?:｜|\])|\[记忆提示\]|\[MEMORY HINT\]|\[inject-guard\]|\[记忆注入\]|\[记忆召回\]|MNEMON RUNTIME MEMORY SNAPSHOT|Current runtime context|\[Compressed conversation section\]|\[dsh-mnemon|<system-reminder>|<runtime-memory-file)/;

/** A single turn is capped so one pasted log cannot bloat the store. */
const MAX_TURN_CHARS = 200_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Recognised bridge prefixes. Anything else non-UUID stays 'unknown'. */
const IM_PREFIX = /^(?:ds-bot-|qq_|feishu_|telegram_|discord_|wechat_)/i;

/** node:sqlite binds NaN as NULL; fall back instead of poisoning NOT NULL columns. */
function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Which channel a user message came from.
 * Desktop/web chat uses a UUID as `source.rpcId`; IM bridges (QQ/Feishu/...)
 * prefix theirs with a channel or bot id (e.g. `ds-bot-<id>`). Anything
 * without an rpcId stays 'unknown' — it neither pollutes the owner's memories
 * nor pretends to be him.
 * @param {unknown} message
 * @returns {'chat'|'im'|'unknown'}
 */
export function originOf(message) {
  const rpcId = message?.source?.rpcId;
  if (typeof rpcId !== 'string') return 'unknown';
  const id = rpcId.trim();
  if (id === '') return 'unknown';
  if (UUID_RE.test(id)) return 'chat';
  // Only known bridge prefixes count as IM; an unrecognised non-UUID id
  // stays 'unknown', so a bridge that reuses a UUID cannot be mistaken for
  // the owner typing in the desktop chat.
  if (IM_PREFIX.test(id)) return 'im';
  return 'unknown';
}

/**
 * Extract the human-readable text of one session message.
 * Only `text` blocks count: thinking, tool calls, images are not dialogue.
 * @param {unknown} message
 * @returns {string}
 */
export function textOf(message) {
  if (typeof message === 'string') return message;
  if (!message || typeof message !== 'object') return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * Ingest one `session/event` record into the raw turns table.
 * `turn/end` carries no message body, so the body is read from the
 * `user/message` / `assistant/message` records that precede it.
 *
 * Real human input carries `message.source.kind === 'user'`. Runtime context,
 * memory notices, reminders and other machinery have their own `kind`, so they
 * are rejected before their text is ever parsed. Old events without a `source`
 * field fall back to the notice-prefix filter.
 *
 * @returns {number} rows inserted
 */
export function ingestEvent(db, session, event) {
  if (!event || typeof event !== 'object') return 0;
  let role;
  let message;
  if (event.type === 'user/message') {
    role = 'user';
    message = event.data;
  } else if (event.type === 'assistant/message') {
    role = 'assistant';
    message = event.data?.message;
  } else {
    return 0;
  }

  const text = textOf(message).trim().slice(0, MAX_TURN_CHARS);
  if (!text) return 0;
  // 过了上面的黑名单还留着这个标记的，才是真人自己打的：转成全角再入库，
  // 免得日后被当成压缩块（重放/回填时冒充历史）。
  const storedText = text
    .replace(/\[上下文替换\]/g, '［上下文替换］')
    .replace(/\[上下文替换/g, '［上下文替换');

  if (role === 'user') {
    // 先过前缀黑名单：即使 source.kind 是 'user'，子代理委派、
    // 运行时快照这类机器串也不该当成人话入库。
    if (INJECT_RE.test(text)) return 0;
    const kind = message?.source?.kind;
    if (typeof kind === 'string' && kind !== 'user') return 0;
  }

  const headerCwd = session?.header?.cwd;
  const sessionCwd = session?.cwd;
  const sid = String(session?.id ?? 'unknown');
  const seq = finiteNumber(event.seq, 0);
  const t = finiteNumber(event.time, Date.now());
  const origin = role === 'user' ? originOf(message) : 'chat';
  const inserted = insertTurn(db, {
    sid,
    seq,
    role,
    origin,
    // 只认可信的工作区字段；两个来源都没有就留空——空 cwd 表示「归属未知」，
    // 不靠目录名或 sid 反推（反推出来的是错误归属，比接不上更糟）。
    cwd:
      typeof headerCwd === 'string' && headerCwd
        ? headerCwd
        : typeof sessionCwd === 'string'
          ? sessionCwd
          : '',
    text: storedText,
    t,
  });
  // 只有对话行才进栈：im/unknown 来源的行在 readStack 里 JOIN 不到角色和
  // 正文，会渲染成空行，还占「最近几条原文」的名额。
  if (inserted > 0 && origin === 'chat') {
    // 每一句人话入栈；超过容量时最早的一条出栈、留一份本地摘要。
    pushStack(db, { sid, seq, t });
    evictOverflow(db);
  }
  if (inserted > 0) {
    // 即时通道：user 表态只做标记，等这一块的 assistant 落库再炼——那时结论
    // 才在。炼完这一块的 turns 直接标 consumed，空闲批不会重复炼。
    if (role === 'user' && origin === 'chat' && wantsImmediate(storedText)) {
      pendingImmediate.set(sid, seq);
    } else if (role === 'assistant') {
      const userSeq = pendingImmediate.get(sid);
      if (userSeq !== undefined) {
        pendingImmediate.delete(sid);
        try {
          refineBlock(db, { sid, userSeq });
        } catch {
          /* 即时提炼失败不能连累 ingest；漏掉的块由空闲批兜底 */
        }
      }
    }
  }
  return inserted;
}
