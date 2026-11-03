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
import {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  embedText,
  endpointReady,
  nearestByVector,
} from './embed.js';

const REFERRAL = /(之前|上次|上回|那个|这个|这句|这份|这条|这段|那件|那事|还说过|刚才|前面|说过|提过|记得|上一条|刚刚)/;
const MAX_HITS = 2;
const MAX_CHARS = 600;
const TURN_WINDOW_MS = 30 * 24 * 3600 * 1000;
const CACHE_SIZE = 3;
// 向量请求失败后冷却一分钟：Ollama 冷启动/掉线时，别让每一轮都赔进去
// 两三秒的等待，等它自己热起来再试。
let vectorCooldownUntil = 0;

// 常驻分区：长期有效的偏好与约定，每轮都在场，不靠抽查到才出现。
// 上限单独算——它不是「这一轮缺什么」，占的是固定预算。
const MAX_PERSONA = 8;
const MAX_PERSONA_CHARS = 300;
// 哪些 decision 算「约定」：有它才进常驻，普通决定按需取。
const RELATION = /(以后|不要|别再|记住|规则|约定|答应|下次|永远|边界|原则|偏好|说好)/;

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

/** Words too common to say anything about what a sentence is about. */
const WEAK_STOP = new Set([
  '这个', '那个', '什么', '怎么', '继续', '现在', '还是', '可以', '不是', '没有',
  '我们', '你们', '他们', '一个', '一下', '已经', '因为', '所以', '但是', '如果',
  '这样', '那样', '时候', '自己', '知道', '觉得', '就是', '要的', '了的', '一下',
]);

/**
 * Weak terms: 3-char Chinese windows and 4+ char Latin words. Used only when
 * the query has neither an anchor nor an entity — the sentence is chat, not
 * a pointer at a file, so nothing in L1/L2/L3 can match it. These terms are
 * deliberately crude: a miss costs one query, a false hit is marked as weak.
 * @param {string} text
 */
function weakTerms(text) {
  const s = String(text ?? '');
  const out = new Set();
  for (const match of s.matchAll(/[A-Za-z][A-Za-z0-9_.-]{3,}/g)) out.add(match[0]);
  for (const run of s.match(/[\u4e00-\u9fa5]{3,}/g) ?? []) {
    for (let i = 0; i + 3 <= run.length; i += 1) {
      const term = run.slice(i, i + 3);
      if (!WEAK_STOP.has(term)) out.add(term);
    }
  }
  return [...out].slice(0, 8);
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
    confidence: row.confidence ?? 'explicit',
  };
}

/**
 * 常驻分区：preference 全部 + 带关系词的 decision，active 且来自对话。
 * 预算独立（MAX_PERSONA 条 / MAX_PERSONA_CHARS 字），不参与下面的 2 条挑选。
 */
function personaOf(db) {
  const rows = db
    .prepare(
      `SELECT id, kind, summary, text, entities, anchors, t, confidence FROM memories
       WHERE tier = 'active' AND origin = 'chat' AND kind IN ('preference', 'decision')
       ORDER BY t DESC LIMIT 100`,
    )
    .all();
  const out = [];
  let chars = 0;
  for (const row of rows) {
    if (out.length >= MAX_PERSONA) break;
    const text = `${row.summary ?? ''} ${row.text ?? ''}`;
    if (row.kind !== 'preference' && !RELATION.test(text)) continue;
    const summary = String(row.summary ?? '').trim() || String(row.text ?? '').slice(0, 80);
    if (chars + summary.length > MAX_PERSONA_CHARS) continue;
    const item = rowToItem(row, 'memory');
    item.section = 'persona';
    item.summary = summary;
    item.why = '长期偏好/约定，每轮都在场。';
    out.push(item);
    chars += summary.length;
  }
  return out;
}

/** Anchors that point at a file, command or skill rather than a topic. */
function isPathLike(anchor) {
  return (
    /[\\/]/.test(anchor) ||
    /\.(mjs|js|cjs|ts|json|md|yml|yaml|txt|zip|png|jpg)$/i.test(anchor) ||
    /^(git|node|pnpm|npm|npx|dsh|bash|python)\b/i.test(anchor)
  );
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

// 「这一轮已经给过哪条」按记忆 id 记，不按词面。
// 旧实现只要 item 的任一锚点在本轮上下文出现过就丢整条——越在聊越不召回：
// 正在讨论 `recall.js` 时，讲它历史决策的那条反而被「这个词出现过」挡掉。
// 记忆 id 才有「给过/没给过」的含义；词面重合只说明在聊同一个东西，不说明已经知道结论。
function recentlyGiven(db, sid, turn, limit = 40) {
  if (!sid) return new Set();
  try {
    const rows = db
      .prepare(
        `SELECT memory_id FROM recall_log
         WHERE sid = ? AND memory_id IS NOT NULL AND turn < ?
         ORDER BY id DESC LIMIT ?`,
      )
      .all(sid, turn, limit);
    return new Set(rows.map((row) => `memory:${row.memory_id}`));
  } catch {
    // 老库没有 recall_log 或表结构不同：退回「不抑制」，宁可重复也别哑掉。
    return new Set();
  }
}

/**
 * Three-level recall. Returns at most two gated hits.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{text:string, recent?:string[], now?:number, cwd?:string, sid?:string, turn?:number}} input
 */
export async function retrieve(
  db,
  {
    text,
    recent = [],
    now = Date.now(),
    cwd = '',
    sid = '',
    turn = 0,
    referralText = null,
    vector = process.env.DSH_MEMORY_CORE_VECTOR !== 'off',
  } = {},
) {
  const query = queryOf(text);
  // 栈文本也拼进了检索句，但「这一句里有没有指代」要按用户原话判断：
  // 混着栈看，referral 几乎每轮都真，L3 的原文扫描就会每轮都跑。
  if (referralText != null) query.referral = REFERRAL.test(referralText);
  const given = recentlyGiven(db, sid, turn);
  const seen = new Set();
  const hits = [];

  const push = (item) => {
    if (!item || !item.why || seen.has(`${item.source}:${item.id}`)) return;
    seen.add(`${item.source}:${item.id}`);
    hits.push(item);
  };

  // 常驻段：先占好位置，再让下面按需取回跳过它们。
  const persona = personaOf(db);
  for (const item of persona) seen.add(`memory:${item.id}`);

  // 人物分区：这轮提到的实体，查与它有关的旧事，最多一条。
  if (query.entities.length) {
    const marks = query.entities.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT id, kind, summary, text, entities, anchors, t, confidence FROM memories
         WHERE tier = 'active' AND origin = 'chat'
           AND EXISTS (SELECT 1 FROM json_each(memories.entities) WHERE json_each.value IN (${marks}))
         ORDER BY t DESC LIMIT 6`,
      )
      .all(...query.entities);
    for (const row of rows) {
      const item = rowToItem(row, 'memory');
      if (seen.has(`memory:${item.id}`) || given.has(`memory:${item.id}`)) continue;
      const entity = item.entities.find((value) => query.entities.includes(value));
      if (!entity) continue;
      item.section = 'people';
      item.why = `这一轮提到 ${entity}；这条记的是与它有关的旧事。`;
      push(item);
      break;
    }
  }

  // 工具分区：这轮提到文件/命令，取记着它用法或坑的那条，最多一条。
  const toolAnchors = query.anchors.filter(isPathLike);
  if (toolAnchors.length) {
    const marks = toolAnchors.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT id, kind, summary, text, entities, anchors, t, confidence FROM memories
         WHERE tier = 'active' AND origin = 'chat'
           AND EXISTS (SELECT 1 FROM json_each(memories.anchors) WHERE json_each.value IN (${marks}))
         ORDER BY t DESC LIMIT 6`,
      )
      .all(...toolAnchors);
    for (const row of rows) {
      const item = rowToItem(row, 'memory');
      if (seen.has(`memory:${item.id}`) || given.has(`memory:${item.id}`)) continue;
      const anchor = item.anchors.find((value) => toolAnchors.includes(value));
      if (!anchor) continue;
      item.section = 'tools';
      item.why = `这一轮提到 ${anchor}；这条记着它的用法或坑。`;
      push(item);
      break;
    }
  }

  // L1: the newest three distilled memories double as the sliding cache.
  const cacheRows = db
    .prepare(
      `SELECT id, kind, summary, text, entities, anchors, t, confidence FROM memories
       WHERE tier = 'active' AND origin = 'chat' ORDER BY t DESC LIMIT ?`,
    )
    .all(CACHE_SIZE);
  for (const row of cacheRows) {
    const item = rowToItem(row, 'memory');
    if (!sharedWith(item, query) || given.has(`memory:${item.id}`)) continue;
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
        `SELECT id, kind, summary, text, entities, anchors, t, confidence FROM memories
         WHERE tier = 'active' AND origin = 'chat' AND (${clauses.join(' OR ')})
         ORDER BY t DESC LIMIT 8`,
      )
      .all(...params);
    for (const row of rows) {
      const item = rowToItem(row, 'memory');
      if (given.has(`memory:${item.id}`)) continue;
      item.why = whyOf(item, query);
      push(item);
    }
  }

  // L2.4: 向量候选。锚点、实体都没有时，用语义找一条；Ollama 不在就跳过，
  // 不解释、不报错——降级回下面的词面弱匹配。why 写明是向量，别让它冒充锚点。
  if (
    hits.length === 0 &&
    query.anchors.length === 0 &&
    query.entities.length === 0 &&
    vector &&
    Date.now() > vectorCooldownUntil
  ) {
    try {
      const endpoint = (
        process.env.DSH_MEMORY_CORE_OLLAMA || DEFAULT_ENDPOINT
      ).replace(/\/+$/, '');
      if (await endpointReady(endpoint)) {
        const model = process.env.DSH_MEMORY_CORE_EMBED_MODEL || DEFAULT_MODEL;
        const probe = await embedText(query.text, { model, endpoint, timeoutMs: 2500 });
        for (const candidate of nearestByVector(db, probe, { model, limit: 3 })) {
          // 0.55 不是拍的：真实库里「考研还剩多久」对毕设那条是 0.568，
          // 卡 0.6 会把它挡掉；再低就只剩「都像」的噪音。最多取一条，
          // 所以宁可偏宽一点，让它在门内有一次机会。
          if (candidate.score < 0.55) continue;
          const row = db
            .prepare(
              `SELECT id, kind, summary, text, entities, anchors, t, confidence FROM memories
               WHERE id = ? AND tier = 'active' AND origin = 'chat'`,
            )
            .get(candidate.memory_id);
          if (!row) continue;
          const item = rowToItem(row, 'memory');
          if (seen.has(`memory:${item.id}`) || given.has(`memory:${item.id}`)) continue;
          item.section = 'vector';
          item.why = `这一轮没给锚点也没给实体；这条语义相近（${candidate.score.toFixed(3)}）。`;
          push(item);
          break;
        }
      }
    } catch {
      // Ollama 掉了、模型没拉、超时——都退回词面匹配，别让检索拖垮这一轮。
      // 冷却一分钟，别让每轮都再等一次。
      vectorCooldownUntil = Date.now() + 60_000;
    }
  }

  // L2.5: 弱匹配。锚点、实体都没有——这句话是聊天，不是指针，前面的层
  // 没有东西可对。用句子里的实词在记忆正文里找最近一条，最多一条，
  // why 写明「弱匹配」：放宽的代价要留在账上，不能假装它和锚点命中同权。
  if (hits.length === 0 && query.anchors.length === 0 && query.entities.length === 0) {
    const terms = weakTerms(query.text);
    if (terms.length) {
      const like = terms.map(() => `(text LIKE ? ESCAPE '\\')`).join(' OR ');
      const values = terms.map((term) => `%${escapeLike(term)}%`);
      const rows = db
        .prepare(
          `SELECT id, kind, summary, text, entities, anchors, t, confidence FROM memories
           WHERE tier = 'active' AND origin = 'chat' AND (${like})
           ORDER BY t DESC LIMIT 1`,
        )
        .all(...values);
      for (const row of rows) {
        const item = rowToItem(row, 'memory');
        if (seen.has(`memory:${item.id}`) || given.has(`memory:${item.id}`)) continue;
        item.section = 'weak';
        item.why = `这一轮没给锚点也没给实体；这条和当前句子有词面重合（${terms.slice(0, 3).join('、')}…），属弱匹配。`;
        push(item);
        break;
      }
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
      // 原文层只回看同一个 workspace：别的项目的会话尾巴不是「我们说过」。
      // cwd 缺失（老会话、拿不到 header）时退回旧行为，宁可少过滤也不把这层变哑。
      const cwdClause = cwd ? ' AND cwd = ?' : '';
      const cwdParams = cwd ? [cwd] : [];
      const rows = db
        .prepare(
          `SELECT id, sid, seq, role, text, t FROM turns
           WHERE origin = 'chat'${cwdClause} AND (${clauses3}) AND t >= ? ORDER BY t DESC LIMIT 6`,
        )
        .all(...cwdParams, ...values, now - TURN_WINDOW_MS);
      for (const row of rows) {
        const text = String(row.text ?? '');
        // The current message is already in `turns`; pasting it back as "what
        // we said before" is not a memory. Skip it and anything this round
        // already has in context.
        if (text === query.text) continue;
        const item = {
          source: 'turn',
          id: row.id,
          kind: row.role,
          summary: text.slice(0, 120),
          text,
          t: Number(row.t ?? 0),
          anchors: anchorsOf(text),
          entities: entitiesOf(text),
          why: '',
        };
        // 原文层按 turn id 记，和记忆 id 不同源，不能拿 given 抑制；
        // 同一句已经在上下文里的情况由上一行的 text 比较挡掉。
        item.why = whyOf(item, query);
        push(item);
      }
    }
  }

  // 分区优先级：人物 → 工具 → 按需。前两个各最多一条，都算进 2 条总预算。
  const rank = (hit) => (hit.section === 'people' ? 0 : hit.section === 'tools' ? 1 : 2);
  const ordered = hits.slice().sort((a, b) => rank(a) - rank(b) || b.t - a.t);
  const picked = [];
  const seenAsks = new Set();
  const sectionCount = { people: 0, tools: 0 };
  let chars = 0;
  for (const hit of ordered) {
    if (picked.length >= MAX_HITS) break;
    if (hit.section === 'people' && sectionCount.people >= 1) continue;
    if (hit.section === 'tools' && sectionCount.tools >= 1) continue;
    // 同一句提问引出的多条记忆只留最新一条，否则注入的是同一个问题的几个不同答案。
    const summary = String(hit.summary ?? '');
    const key = summary.startsWith('问：') ? summary.split('｜答：')[0] : summary.slice(0, 40);
    if (seenAsks.has(key)) continue;
    if (chars + summary.length > MAX_CHARS) continue;
    if (hit.section === 'people' || hit.section === 'tools') sectionCount[hit.section] += 1;
    seenAsks.add(key);
    picked.push(hit);
    chars += summary.length;
  }
  return [...persona, ...picked];
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
  const section = (title, list) => {
    if (list.length === 0) return;
    lines.push('');
    lines.push(title);
    list.forEach((hit, index) => {
      const when = hit.t ? new Date(hit.t).toISOString().slice(0, 10) : '';
      const kind = hit.kind === 'user' ? '原话' : hit.kind === 'assistant' ? '旧回复' : hit.kind;
      // 转述/未核实不装成原话：引用它时先留余地。
      const conf =
        hit.confidence === 'reported' ? ' · 转述' : hit.confidence === 'uncertain' ? ' · 未核实' : '';
      lines.push(`${index + 1}. （${kind}${when ? ` · ${when}` : ''}${conf}）${hit.summary}`);
      if (hit.scene) lines.push(`   当时：${hit.scene}`);
    });
  };
  section(
    '[常驻] 你在意的事和说好的约定（长期有效，不必每轮重问）：',
    hits.filter((hit) => hit.section === 'persona'),
  );
  section(
    '[这轮] 与当前这句有关的旧记录：',
    hits.filter((hit) => hit.section !== 'persona'),
  );
  return lines.join('\n');
}
