/**
 * M3 · 影子模式
 *
 * 每轮在「正常注入」之外，再算一次「如果改用替换上下文会怎样」：
 * 找出 messages 里与命中记忆的锚点/实体重叠的旧消息，记录数量与字符数。
 *
 * 只写 shadow_log，不碰 messages，不改变任何回复。跑满 50 轮后，
 * 用这些账决定替换值不值得开。
 */

import { textOf } from './ingest.js';

/** 注入过的提示不算可替换的原文。 */
function isInjected(text) {
  return /^\s*(\[记忆\]|\[记忆提示\]|\[MEMORY HINT\])/.test(text);
}

/** 弱 token（普通词）需要同一条消息命中两个，才认为它可能被覆盖。 */
const WEAK_HITS = 2;

/** 路径/文件名/长专名：单独命中就有说服力。 */
function isStrongAnchor(token) {
  return /[\\/._-]/.test(token) || token.length >= 6;
}

/** 纯 ASCII 用词边界，避免 cat 命中 category；中文没有词边界，退回 includes。 */
export function tokenInText(text, token) {
  if (/^[\x20-\x7e]+$/.test(token) && /[A-Za-z0-9]/.test(token)) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`).test(text);
  }
  return text.includes(token);
}

/**
 * @param {{
 *   messages: Array<{role?: string, content?: unknown, source?: {kind?: string}}>,
 *   hits: Array<{anchors?: string[], entities?: string[]}>,
 *   query?: string,
 * }} input
 * @returns {{replaced: number, replacedChars: number, added: number, hintChars: number}}
 */
export function shadowPlan({ messages, hits, query = '' }) {
  const list = Array.isArray(messages) ? messages : [];
  const tokens = new Set();
  for (const hit of Array.isArray(hits) ? hits : []) {
    for (const anchor of hit.anchors ?? []) if (typeof anchor === 'string') tokens.add(anchor);
    for (const entity of hit.entities ?? []) if (typeof entity === 'string') tokens.add(entity);
  }
  const needles = [...tokens].filter((token) => token.length >= 2);

  let replaced = 0;
  let replacedChars = 0;
  for (const message of list) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    const kind = message.source?.kind;
    if (typeof kind === 'string' && kind !== 'user') continue;
    const text = textOf(message);
    if (!text || text === query || isInjected(text)) continue;
    // 当前这句本身不参与替换：它正是要回答的那一轮。
    // 只命中一个通用词不算：`dsh` / `记忆` 这类短词几乎每条消息都有，
    // 拿它当「这条消息被记忆覆盖」会把节省量算高，而替换不可逆。
    const matched = needles.filter((needle) => tokenInText(text, needle));
    if (matched.some(isStrongAnchor) || matched.length >= WEAK_HITS) {
      replaced += 1;
      replacedChars += text.length;
    }
  }

  return {
    replaced,
    replacedChars,
    added: Array.isArray(hits) ? hits.length : 0,
    hintChars: 0,
  };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{sid: string, turn: number, replaced: number, replacedChars: number, added: number, hintChars: number, t?: number}} row
 */
export function recordShadow(db, row) {
  db.prepare(
    'INSERT INTO shadow_log (sid, turn, t, replaced, replaced_chars, added, hint_chars) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    String(row.sid ?? ''),
    Number.isFinite(Number(row.turn)) ? Number(row.turn) : 0,
    Number(row.t ?? Date.now()),
    Number(row.replaced ?? 0),
    Number(row.replacedChars ?? 0),
    Number(row.added ?? 0),
    Number(row.hintChars ?? 0),
  );
}
