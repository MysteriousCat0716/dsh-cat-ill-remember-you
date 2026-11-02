/**
 * M2 · 三级取回
 *
 * L1 滑动窗口缓存：最近 3 条提炼，锚点/实体对得上就地解；
 * L2 memories：实体 + 锚点匹配，摘要能判断是否同一件事；
 * L3 turns 原文：前两层都说不清、且句子带指代词时才翻，只取最近一小批。
 *
 * 闸门：每条被取回的都必须写出「这一轮缺什么、它补什么」，
 * 写不出 why 的一律丢弃——那是相似度在替我做决定。
 */

import { anchorsOf, entitiesOf } from './extract.js';
import { splitMessage } from './split.js';

const REFERRAL = /(之前|上次|上回|那个|这个|这句|这份|这条|这段|那件|那事|还说过|刚才|前面|说过|提过|记得|上一条|刚刚)/;
const MAX_HITS = 2;
const MAX_CHARS = 600;
const TURN_WINDOW_MS = 30 * 24 * 3600 * 1000;
const CACHE_SIZE = 3;

/**
 * Anchors/entities of the current turn. Only segments that mention a
 * referent are used, so a long message does not drag in every noun.
 * @param {string} text
 */
export function queryOf(text) {
  const value = String(text ?? '').trim();
  const referring = splitMessage(value).filter((segment) => REFERRAL.test(segment));
  const pool = referring.length ? referring.join(' ') : value;
  return {
    text: value,
    anchors: anchorsOf(pool),
    entities: entitiesOf(pool),
    referral: REFERRAL.test(value),
  };
}

function parseList(raw) {
  try {
    const value = JSON.parse(raw ?? '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/** Escape LIKE wildcards so a path or filename is matched literally. */
export function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, '\\$&');
}

/** Pull the scene out of a stored `当时：…｜依据：…` why. */
function sceneOf(why) {
  const text = String(why ?? '');
  if (!text.startsWith('当时：')) return '';
  return text.slice(3).split('｜依据：')[0].trim();
}

function rowToItem(row, source) {
  return {
    source,
    id: row.id,
    kind: row.kind ?? 'fact',
    summary: String(row.summary ?? '').trim() || String(row.text ?? '').slice(0, 80),
    text: row.text,
    t: Number(row.t ?? 0),
    anchors: parseList(row.anchors),
    entities: parseList(row.entities),
    why: '',
    scene: sceneOf(row.why),
  };
}

/** Anchors/entities already present in the recent context. */
export function knownOf(texts) {
  const anchors = new Set();
  const entities = new Set();
  for (const text of texts) {
    for (const anchor of anchorsOf(text)) anchors.add(anchor);
    for (const entity of entitiesOf(text)) entities.add(entity);
  }
  return { anchors, entities };
}

function sharedWith(item, query) {
  const anchor = item.anchors.find((value) => query.anchors.includes(value));
  if (anchor) return { kind: 'anchor', value: anchor };
  const entity = item.entities.find((value) => query.entities.includes(value));
  if (entity) return { kind: 'entity', value: entity };
  return null;
}

function whyOf(item, query) {
  const hit = sharedWith(item, query);
  if (!hit) return '';
  if (hit.kind === 'anchor') {
    return `这一轮提到 ${hit.value}，但没给它的来历/结论；这条补的是 ${hit.value} 的旧记录。`;
  }
  return `这一轮提到 ${hit.value}，当前上下文里还没有它之前的结论；这条补上。`;
}

function inKnown(item, known) {
  return (
    item.anchors.some((value) => known.anchors.has(value)) ||
    item.entities.some((value) => known.entities.has(value))
  );
}

/**
 * Three-level recall. Returns at most two gated hits.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{text:string, recent?:string[], now?:number}} input
 */
export function retrieve(db, { text, recent = [], now = Date.now() } = {}) {
  const query = queryOf(text);
  const known = knownOf(recent);
  const seen = new Set();
  const hits = [];

  const push = (item) => {
    if (!item || !item.why || seen.has(`${item.source}:${item.id}`)) return;
    seen.add(`${item.source}:${item.id}`);
    hits.push(item);
  };

  // L1: the newest three distilled memories double as the sliding cache.
  const cacheRows = db
    .prepare(
      `SELECT id, kind, summary, text, entities, anchors, t FROM memories
       WHERE tier = 'active' AND origin = 'chat' ORDER BY t DESC LIMIT ?`,
    )
    .all(CACHE_SIZE);
  for (const row of cacheRows) {
    const item = rowToItem(row, 'memory');
    if (!sharedWith(item, query) || inKnown(item, known)) continue;
    item.why = whyOf(item, query) || '刚才还在说它，缓存里直接取。';
    push(item);
  }

  // L2: distilled memories matched by anchor or entity. Match inside the JSON
  // array element-wise: a LIKE over the serialized array would treat `%`/`_`
  // in paths and entity names as wildcards.
  const clauses = [];
  const params = [];
  for (const anchor of query.anchors) {
    clauses.push('EXISTS (SELECT 1 FROM json_each(memories.anchors) WHERE json_each.value = ?)');
    params.push(anchor);
  }
  for (const entity of query.entities) {
    clauses.push('EXISTS (SELECT 1 FROM json_each(memories.entities) WHERE json_each.value = ?)');
    params.push(entity);
  }
  if (clauses.length) {
    const rows = db
      .prepare(
        `SELECT id, kind, summary, text, entities, anchors, t FROM memories
         WHERE tier = 'active' AND origin = 'chat' AND (${clauses.join(' OR ')})
         ORDER BY t DESC LIMIT 8`,
      )
      .all(...params);
    for (const row of rows) {
      const item = rowToItem(row, 'memory');
      if (inKnown(item, known)) continue;
      item.why = whyOf(item, query);
      push(item);
    }
  }

  // L3: only with a referent and only when the upper layers left room.
  if (query.referral && hits.length < MAX_HITS) {
    const terms = [
      ...query.anchors.slice(0, 3),
      ...query.entities.filter((value) => value.length >= 2).slice(0, 3),
    ];
    if (terms.length) {
      const clauses3 = terms.map(() => "text LIKE ? ESCAPE '\\'").join(' OR ');
      const values = terms.map((term) => `%${escapeLike(term)}%`);
      const rows = db
        .prepare(
          `SELECT id, sid, seq, role, text, t FROM turns
           WHERE origin = 'chat' AND (${clauses3}) AND t >= ? ORDER BY t DESC LIMIT 6`,
        )
        .all(...values, now - TURN_WINDOW_MS);
      for (const row of rows) {
        const item = {
          source: 'turn',
          id: row.id,
          kind: row.role,
          summary: String(row.text ?? '').slice(0, 120),
          text: row.text,
          t: Number(row.t ?? 0),
          anchors: anchorsOf(row.text),
          entities: entitiesOf(row.text),
          why: '',
        };
        item.why = whyOf(item, query);
        push(item);
      }
    }
  }

  hits.sort((a, b) => b.t - a.t);
  const picked = [];
  const seenAsks = new Set();
  let chars = 0;
  for (const hit of hits) {
    if (picked.length >= MAX_HITS) break;
    // 同一句提问引出的多条记忆只留最新一条，否则注入的是同一个问题的几个不同答案。
    const summary = String(hit.summary ?? '');
    const key = summary.startsWith('问：') ? summary.split('｜答：')[0] : summary.slice(0, 40);
    if (seenAsks.has(key)) continue;
    if (chars + summary.length > MAX_CHARS) continue;
    seenAsks.add(key);
    picked.push(hit);
    chars += summary.length;
  }
  return picked;
}

/**
 * Render the hint appended before the model turn.
 * @param {Array<{kind:string, summary:string, t:number}>} hits
 */
export function renderHint(hits) {
  if (!hits || hits.length === 0) return '';
  const lines = [
    '[记忆] 以下是以前记过的，只有能自然接上这一轮时才用；接不上就不提，别硬塞。',
  ];
  hits.forEach((hit, index) => {
    const when = hit.t ? new Date(hit.t).toISOString().slice(0, 10) : '';
    const kind = hit.kind === 'user' ? '原话' : hit.kind === 'assistant' ? '旧回复' : hit.kind;
    lines.push(`${index + 1}. （${kind}${when ? ` · ${when}` : ''}）${hit.summary}`);
    if (hit.scene) lines.push(`   当时：${hit.scene}`);
  });
  return lines.join('\n');
}
