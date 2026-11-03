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
import {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  embedText,
  endpointReady,
  nearestByVector,
} from './embed.js';
import { reviveOnRecall } from './forget.js';

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
  // 整句都参与抽锚点。旧实现只留含指代的片段，本意是让长消息别拖进一堆
  // 名词，代价却是长句的主题词被切掉：「上次说的那个，lib/recall.js 的缓存
  // 问题」里的路径恰好不在指代片段里，锚点就丢了。anchorsOf/entitiesOf
  // 自己会筛（路径、专名），不用先切段。
  return {
    text: value,
    anchors: anchorsOf(value),
    entities: entitiesOf(value),
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
// 3 字窗口几乎必含疑问词/虚词；WEAK_STOP 里是整词，对窗口永远不命中，
// 所以这里按「夹带」判断——「怎么做」「是什么」这类窗口整条丢掉。
const WEAK_NOISE = /[什么怎么哪吗呢吧啊呀了的么这那个]/;
const SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' });

export function weakTerms(text) {
  const s = String(text ?? '');
  if (!s) return [];
  const out = new Set();
  for (const match of s.matchAll(/[A-Za-z][A-Za-z0-9_.-]{3,}/g)) out.add(match[0]);

  // 先按 ICU 里的中文词表切——「车站」不会再拆成「车」和「站」两个单字。
  // 词典里的技术词（缓存、破甲）会被切成单字，所以连续单字再两两拼回来。
  const words = [];
  let singles = '';
  const flush = () => {
    for (let i = 0; i + 2 <= singles.length; i += 1) words.push(singles.slice(i, i + 2));
    singles = '';
  };
  try {
    for (const part of SEGMENTER.segment(s)) {
      if (!part.isWordLike) {
        flush();
        continue;
      }
      const term = part.segment;
      if (term.length === 1 && /^[\u4e00-\u9fa5]$/.test(term)) {
        singles += term;
        continue;
      }
      flush();
      if (term.length >= 2 && (/^[\u4e00-\u9fa5]+$/.test(term) || /[A-Za-z]/.test(term))) {
        words.push(term);
      }
    }
  } catch {
    // 老 Node 没有 Intl.Segmenter：这一层就不出词，宁缺毋滥。
  }
  flush();

  for (const term of words) {
    if (WEAK_STOP.has(term) || WEAK_NOISE.test(term)) continue;
    out.add(term);
  }
  return [...out].slice(0, 8);
}

/** Count non-overlapping occurrences of a literal term. */
function countOccurrences(text, term) {
  if (!term) return 0;
  let count = 0;
  let at = text.indexOf(term);
  while (at !== -1) {
    count += 1;
    at = text.indexOf(term, at + term.length);
  }
  return count;
}

/**
 * 弱匹配打分：稀有度 + 条内重复次数。
 *
 * 旧实现 8 个词等权、OR 命中、只取最新一条，权重根本不参与排序——
 * 「这次」「那个」这类词和真正的主题词同权，回来的是最新而不是最相关。
 * 这里按评审的三条判据里能落地的两条做：
 *  - 稀有度：词在全库出现得越少，权重越高（1 / log(2 + df)）；
 *  - 分布：同一条记忆里出现多次算主题词，封顶 3 次，避免长文霸榜。
 * 第三条「命中在 user 问句里 > assistant 长解释里」需要 role，memories
 * 没有这个列，先不做；summary 里已经带着「问：/答：」的形态，后面再说。
 */
function weakScoreOf(db, terms, text, weightOf, countStmt) {
  const body = String(text ?? '');
  let score = 0;
  let hits = 0;
  for (const term of terms) {
    const tf = countOccurrences(body, term);
    if (tf === 0) continue;
    hits += 1;
    let weight = weightOf.get(term);
    if (weight === undefined) {
      const df = Number(countStmt.get(`%${escapeLike(term)}%`)?.c) || 0;
      weight = 1 / Math.log(2 + df);
      weightOf.set(term, weight);
    }
    score += Math.min(tf, 3) * weight;
  }
  // hits 也交回去：单个 3 字窗口的重合大多是巧合（「压缩要」也能对上
  // 一篇讲 VS Code 的正文），要求至少两个不同窗口同时命中才认。
  return { score, hits };
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
    retention: row.retention ?? 'auto',
  };
}

/**
 * 常驻分区：preference 全部 + 带关系词的 decision，active 且来自对话。
 * 预算独立（MAX_PERSONA 条 / MAX_PERSONA_CHARS 字），不参与下面的 2 条挑选。
 */
function personaOf(db) {
  const rows = db
    .prepare(
      `SELECT id, kind, summary, text, entities, anchors, t, confidence, retention FROM memories
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

// 相关度粗分：命中的锚点/实体按稀有度加权。
//
// 为什么不再用「个数」：长文本、锚点多的条目和任何 query 都有重合，
// 个数计分会让它处处占优——「github 真好用」赢在 dsh/记忆/猫 这类高频词上，
// 而不是赢在 query 真正问的东西上。
// 稀有度沿用弱匹配层已经采纳的同一条判据：1 / log(2 + df)，
// df 优先取 entities.mentions（现成的全库词频），锚点没有登记时退回 LIKE 计数。
const dfCaches = new WeakMap();
function dfCacheOf(db) {
  let cache = dfCaches.get(db);
  if (!cache) {
    const freq = new Map();
    try {
      for (const row of db.prepare('SELECT name, mentions FROM entities').all()) {
        freq.set(String(row.name), Number(row.mentions) || 0);
      }
    } catch {
      // 老库没有 entities 表：全部走 LIKE 计数，不影响正确性，只是慢一点。
    }
    cache = { freq, weights: new Map() };
    dfCaches.set(db, cache);
  }
  return cache;
}
function weightOf(db, term) {
  const { freq, weights } = dfCacheOf(db);
  const key = String(term);
  const hit = weights.get(key);
  if (hit !== undefined) return hit;
  let df = freq.get(key);
  if (df === undefined) {
    try {
      df = Number(db.prepare("SELECT count(*) AS c FROM memories WHERE summary LIKE ? ESCAPE '\\'").get(`%${key}%`)?.c) || 0;
    } catch {
      df = 0;
    }
  }
  const weight = 1 / Math.log(2 + df);
  weights.set(key, weight);
  return weight;
}
function scoreOf(item, query, db) {
  let score = 0;
  for (const value of item.anchors) if (query.anchors.includes(value)) score += 2 * weightOf(db, value);
  for (const value of item.entities) if (query.entities.includes(value)) score += weightOf(db, value);
  // 「钉子」：显式 permanent 的记忆不靠时间赢，也不该被更近的条目挤掉。
  if (item.retention === 'permanent') score += 2;
  return score;
}

// turn 不参与过滤：它是进程内轮次，旧会话恢复后从 1 重新数，
// `turn < ?` 会让重启前的 recall_log 行查不到、抑制静默失效。
// id 单调且跨重启成立，「最近 40 次注入」才是这里要的语义。
function recentlyGiven(db, sid, turn, limit = 40) {
  if (!sid) return new Set();
  try {
    const rows = db
      .prepare(
        `SELECT memory_id FROM recall_log
         WHERE sid = ? AND memory_id IS NOT NULL
         ORDER BY id DESC LIMIT ?`,
      )
      .all(sid, limit);
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
  // 落选账：候选里哪几条没进最终的 2 条、为什么。账挂在返回数组上
  // （数组也是对象），不改变 retrieve 的返回形状，调用方按需读 hits.trace。
  // 上限 12 条：够看出「这轮为什么空」，又不至于把账本撑大。
  const trace = [];
  const note = (item, reason) => {
    if (!item || trace.length >= 12) return;
    trace.push({
      id: item.id,
      source: item.source ?? 'memory',
      section: item.section ?? '',
      score: Math.round((item.score ?? 0) * 1000) / 1000,
      reason,
    });
  };

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
        `SELECT id, kind, summary, text, entities, anchors, t, confidence, retention FROM memories
         WHERE tier = 'active' AND origin = 'chat'
           AND EXISTS (SELECT 1 FROM json_each(memories.entities) WHERE json_each.value IN (${marks}))
         ORDER BY t DESC LIMIT 6`,
      )
      .all(...query.entities);
    // 候选按 t 取 6 条，选重合最多的那条，不是最新的那条。
    let best = null;
    for (const row of rows) {
      const item = rowToItem(row, 'memory');
      if (seen.has(`memory:${item.id}`) || given.has(`memory:${item.id}`)) {
        note(item, given.has(`memory:${item.id}`) ? 'given' : 'already-seen');
        continue;
      }
      item.score = scoreOf(item, query, db);
      if (!best || item.score > best.score) best = item;
    }
    if (best) {
      const entity = best.entities.find((value) => query.entities.includes(value));
      best.section = 'people';
      best.why = `这一轮提到 ${entity}；这条记的是与它有关的旧事。`;
      push(best);
    }
  }

  // 工具分区：这轮提到文件/命令，取记着它用法或坑的那条，最多一条。
  const toolAnchors = query.anchors.filter(isPathLike);
  if (toolAnchors.length) {
    const marks = toolAnchors.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT id, kind, summary, text, entities, anchors, t, confidence, retention FROM memories
         WHERE tier = 'active' AND origin = 'chat'
           AND EXISTS (SELECT 1 FROM json_each(memories.anchors) WHERE json_each.value IN (${marks}))
         ORDER BY t DESC LIMIT 6`,
      )
      .all(...toolAnchors);
    // 同上：在候选里选重合最多的那条，不赌时间。
    let best = null;
    for (const row of rows) {
      const item = rowToItem(row, 'memory');
      if (seen.has(`memory:${item.id}`) || given.has(`memory:${item.id}`)) {
        note(item, given.has(`memory:${item.id}`) ? 'given' : 'already-seen');
        continue;
      }
      item.score = scoreOf(item, query, db);
      if (!best || item.score > best.score) best = item;
    }
    if (best) {
      const anchor = best.anchors.find((value) => toolAnchors.includes(value));
      best.section = 'tools';
      best.why = `这一轮提到 ${anchor}；这条记着它的用法或坑。`;
      push(best);
    }
  }

  // L1: the newest three distilled memories double as the sliding cache.
  const cacheRows = db
    .prepare(
      `SELECT id, kind, summary, text, entities, anchors, t, confidence, retention FROM memories
       WHERE tier = 'active' AND origin = 'chat' ORDER BY t DESC LIMIT ?`,
    )
    .all(CACHE_SIZE);
  for (const row of cacheRows) {
    const item = rowToItem(row, 'memory');
    if (!sharedWith(item, query) || given.has(`memory:${item.id}`)) {
      note(item, given.has(`memory:${item.id}`) ? 'given' : 'no-share');
      continue;
    }
    item.score = scoreOf(item, query, db) || 1;
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
        `SELECT id, kind, summary, text, entities, anchors, t, confidence, retention FROM memories
         WHERE tier IN ('active','dormant') AND origin = 'chat' AND (${clauses.join(' OR ')})
         ORDER BY t DESC LIMIT 24`,
      )
      .all(...params);
    for (const row of rows) {
      const item = rowToItem(row, 'memory');
      if (given.has(`memory:${item.id}`)) {
        note(item, 'given');
        continue;
      }
      item.score = scoreOf(item, query, db);
      item.why = whyOf(item, query);
      push(item);
    }
  }

  // L2.4: 向量候选。锚点/实体没补满两条就试一次；只在「全空」时才跑的话，
  // 话里一带文件名这条通路就永远轮不到——而语义相近的旧事往往恰恰不共享词。
  // Ollama 不在就跳过，不解释、不报错——降级回下面的词面弱匹配。
  // why 写明是向量，别让它冒充锚点。
  if (hits.length < MAX_HITS && vector && Date.now() > vectorCooldownUntil) {
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
          if (candidate.score < 0.55) {
            note(
              { id: candidate.memory_id, source: 'memory', section: 'vector', score: candidate.score },
              'low-vector',
            );
            continue;
          }
          const row = db
            .prepare(
              `SELECT id, kind, summary, text, entities, anchors, t, confidence, retention FROM memories
               WHERE id = ? AND tier IN ('active','dormant') AND origin = 'chat'`,
            )
            .get(candidate.memory_id);
          if (!row) continue;
          const item = rowToItem(row, 'memory');
          if (seen.has(`memory:${item.id}`) || given.has(`memory:${item.id}`)) continue;
          item.section = 'vector';
          item.score = candidate.score;
          item.why = `这一轮锚点/实体没补满两条；这条语义相近（${candidate.score.toFixed(3)}）。`;
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

  // L2.5: 弱匹配。锚点、实体抽不出东西（或抽出了、前面的层没对上）时，
  // 用句子里的实词在记忆正文里找。旧实现要求「前面全空」才跑，而向量层
  // 已经先占了一个槽位，这一层几乎永远轮不到——变成只有向量失败时才兜底。
  // 现在只要还差一条就试，让词面重合和语义相近各拿一次机会。
  if (hits.length < MAX_HITS) {
    const terms = weakTerms(query.text);
    if (terms.length) {
      const like = terms.map(() => `(text LIKE ? ESCAPE '\\')`).join(' OR ');
      const values = terms.map((term) => `%${escapeLike(term)}%`);
      const rows = db
        .prepare(
          `SELECT id, kind, summary, text, entities, anchors, t, confidence, retention FROM memories
           WHERE tier = 'active' AND origin = 'chat' AND (${like})
           ORDER BY t DESC LIMIT 200`,
        )
        .all(...values);
      const countStmt = db.prepare(
        "SELECT count(*) AS c FROM memories WHERE text LIKE ? ESCAPE '\\'",
      );
      const weightOf = new Map();
      const candidates = [];
      for (const row of rows) {
        const item = rowToItem(row, 'memory');
        if (seen.has(`memory:${item.id}`) || given.has(`memory:${item.id}`)) continue;
        const { score } = weakScoreOf(db, terms, row.text, weightOf, countStmt);
        if (score <= 0) {
          note(item, 'low-weak');
          continue;
        }
        item.section = 'weak';
        item.score = score;
        item.why = `这一轮锚点/实体没对上；这条和当前句子有词面重合（${terms.slice(0, 3).join('、')}…），属弱匹配。`;
        candidates.push(item);
      }
      // 弱匹配的分数是「稀有度 × 条内重复」的累加，量纲和向量的 0–1 不一样；
      // 不归一化的话，一条长文靠重复次数就能压过语义命中。
      // 再乘 0.5 上限：按词切了，但词面重合仍是弱证据，这层只该补空位。
      const top = candidates.reduce((max, item) => Math.max(max, item.score), 0);
      for (const item of candidates) item.score = top > 0 ? (item.score / top) * 0.5 : 0;
      // 候选池不再按时间截断：时间新不等于相关，长文档在过去能靠词多赢。
      // 按分数取前几条交给 push，剩下的会被记成 budget。
      candidates.sort((a, b) => b.score - a.score);
      for (const item of candidates.slice(0, MAX_HITS + 2)) push(item);
    }
  }

  // L3: only with a referent and only when the upper layers left room.
  if (query.referral && hits.length < MAX_HITS) {
    const terms = [
      ...query.anchors.slice(0, 3),
      ...query.entities.filter((value) => value.length >= 2).slice(0, 3),
    ];
    // 没抽出名词不等于没有「上次那件事」：「你还记得上次那件事吗」整句没有锚点，
    // 旧实现直接跳过，最该翻原文的时候反而查不到。这时退回最近几条原文——
    // referral 本身已经把范围压到「最近聊过的东西」。
    const clauses3 = terms.length
      ? terms.map(() => "text LIKE ? ESCAPE '\\'").join(' OR ')
      : '1 = 1';
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
      // 没有名词时 whyOf 交回空串，push 会把整条丢掉；这里补一句来源说明，
      // 否则「只有指代」这条通路等于白改。
      item.score = terms.length ? scoreOf(item, query, db) : 0.05;
      item.why = terms.length
        ? whyOf(item, query)
        : '这一轮只有指代、抽不出名词；按「上次那件事」回看最近的原文。';
      push(item);
    }
  }

  // 分区优先级：人物 → 工具 → 按需。前两个各最多一条，都算进 2 条总预算。
  // 同一分区里先看相关度，再看时间。旧的排序只看 t：同一个锚点命中十几条时，
  // 回来的是最新的几条，真正对得上的那条可能排不进来。
  const rank = (hit) => (hit.section === 'people' ? 0 : hit.section === 'tools' ? 1 : 2);
  const ordered = hits
    .slice()
    .sort((a, b) => rank(a) - rank(b) || (b.score ?? 0) - (a.score ?? 0) || b.t - a.t);
  const picked = [];
  const seenAsks = new Set();
  const sectionCount = { people: 0, tools: 0 };
  let chars = 0;
  for (const hit of ordered) {
    if (picked.length >= MAX_HITS) {
      note(hit, 'budget');
      continue;
    }
    if (hit.section === 'people' && sectionCount.people >= 1) {
      note(hit, 'section-cap');
      continue;
    }
    if (hit.section === 'tools' && sectionCount.tools >= 1) {
      note(hit, 'section-cap');
      continue;
    }
    // 同一句提问引出的多条记忆只留最新一条，否则注入的是同一个问题的几个不同答案。
    const summary = String(hit.summary ?? '');
    const key = summary.startsWith('问：') ? summary.split('｜答：')[0] : summary.slice(0, 40);
    if (seenAsks.has(key)) {
      note(hit, 'duplicate');
      continue;
    }
    if (chars + summary.length > MAX_CHARS) {
      note(hit, 'chars');
      continue;
    }
    if (hit.section === 'people' || hit.section === 'tools') sectionCount[hit.section] += 1;
    seenAsks.add(key);
    picked.push(hit);
    chars += summary.length;
  }
  // 回升：这次真被取回的 dormant 记忆重新记成 active（遗忘是可回退的降级）。
  // 只在选中的 2 条上做，候选遍历不算「被想起」。
  try {
    const ids = picked.filter((hit) => hit.source === 'memory').map((hit) => Number(hit.id));
    if (ids.length) reviveOnRecall(db, ids);
  } catch {
    // 回升失败不影响这一轮取回：先让记忆拿回去用，账本下次再补。
  }
  const result = [...persona, ...picked];
  result.trace = trace;
  result.personaCount = persona.length;
  return result;
}

/**
 * Render the hint appended before the model turn.
 * @param {Array<{kind:string, summary:string, t:number}>} hits
 */
/**
 * 回复落库后回填 recall_log.used：模型有没有把取回的东西真的说出来。
 *
 * 判据故意从宽（回复里出现这条记忆的任一锚点/实体就算），先让 used 有数据。
 * 跑一周看 used=1 占总注入的比例：低于 30% 说明取回策略有问题，高于 80%
 * 说明判据太松——`dsh`、`记忆` 这类词太容易复现。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{sid:string, text:string}} input
 * @returns {number} 被标记的行数
 */
export function markRecallUsed(db, { sid, text }) {
  if (!sid || !text) return 0;
  const terms = new Set([...anchorsOf(text), ...entitiesOf(text)]);
  if (terms.size === 0) return 0;
  const rows = db
    .prepare(
      `SELECT l.id, m.anchors, m.entities
       FROM recall_log l
       JOIN memories m ON m.id = l.memory_id
       WHERE l.sid = ? AND l.used IS NULL AND l.memory_id IS NOT NULL
       ORDER BY l.id DESC
       LIMIT 40`,
    )
    .all(String(sid));
  if (rows.length === 0) return 0;
  const update = db.prepare('UPDATE recall_log SET used = 1 WHERE id = ?');
  let marked = 0;
  for (const row of rows) {
    const owned = [...parseList(row.anchors), ...parseList(row.entities)];
    if (owned.some((token) => terms.has(token))) {
      update.run(row.id);
      marked += 1;
    }
  }
  return marked;
}

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
