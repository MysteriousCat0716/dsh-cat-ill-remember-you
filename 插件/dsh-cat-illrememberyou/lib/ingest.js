import { insertTurn } from './db.js';

/** Fallback filter for old events that carry no `source` field. */
const INJECT_RE = /^\s*(\[记忆提示\]|\[MEMORY HINT\]|\[inject-guard\]|\[记忆注入\]|\[记忆召回\]|MNEMON RUNTIME MEMORY SNAPSHOT|\[Compressed conversation section\]|\[dsh-mnemon|<system-reminder>|<runtime-memory-file)/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (typeof rpcId !== 'string' || rpcId.trim() === '') return 'unknown';
  return UUID_RE.test(rpcId.trim()) ? 'chat' : 'im';
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

  const text = textOf(message).trim();
  if (!text) return 0;

  if (role === 'user') {
    // 先过前缀黑名单：即使 source.kind 是 'user'，子代理委派、
    // 运行时快照这类机器串也不该当成人话入库。
    if (INJECT_RE.test(text)) return 0;
    const kind = message?.source?.kind;
    if (typeof kind === 'string' && kind !== 'user') return 0;
  }

  return insertTurn(db, {
    sid: String(session?.id ?? 'unknown'),
    seq: Number(event.seq ?? 0),
    role,
    origin: role === 'user' ? originOf(message) : 'chat',
    text,
    t: Number(event.time ?? Date.now()),
  });
}
