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
    if (needles.some((needle) => text.includes(needle))) {
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
