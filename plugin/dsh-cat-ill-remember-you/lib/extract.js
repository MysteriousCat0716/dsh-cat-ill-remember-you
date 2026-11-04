/**
 * M1 · 规则提炼（规则先行，模型后接）
 *
 * 本机 Ollama 只有 embedding 模型，没有生成模型，所以这一版不调模型：
 * 用可解释的规则把原始轮次切成「记忆候选」，写进 memories。
 * 等 M1.5 / M2 再接模型，接口不变（refine() 是唯一入口）。
 */

import { pendingTurns, markConsumed, markScanned } from './db.js';

export const JUDGE =
  /(以后|下次|记住|不要|别|必须|规则|约定|原则上|不再|改成|还是用|决定|定了|就这样|采用|选用|偏好|更喜欢|讨厌|不喜欢)/;

const ANCHOR_FILE =
  /[A-Za-z]:[\\/][^\s"'）)】\]，,；;]+|[^\s"'）)】\]，,；;：:]+\.(?:mjs|js|ts|tsx|md|json|ya?ml|py|sh|ps1|cmd|txt|png|svg|db)/g;
const ANCHOR_MSG = /\bm\d{5}\b/g;
const ENTITY = /猫|岸|DeepSeek|dsh[\w-]*|Ollama|qwen[\w.:-]*|[A-Z][a-z]+[A-Z][A-Za-z0-9]+/g;
// 「X：」式的定义句：行首/句末的「FastAPI：…」「木兰：…」。
// 只认 2 到 15 个字符，并挡掉「结论：」「注意：」这类模板词——
// 它们不是名字，抽进 people 分区只会让那一层变噪音。
const ENTITY_DEF = /(?:^|[\n。；!?！？])\s*([一-龥A-Za-z][一-龥A-Za-z0-9_-]{1,14})\s*[：:]/g;
const ENTITY_DEF_STOP = new Set([
  '结论', '注意', '问题', '下一步', '原因', '理由', '计划', '做法', '判断',
  '背景', '目标', '现状', '决定', '原则', '规则', '建议', '方法', '步骤',
  '结果', '说明', '回答', '答案', '用途', '范围', '前提', '目的', '定义',
]);

const MAX_TURNS = 40;
const MAX_BLOCK_CHARS = 2400;

/** 规则版本：换了提炼规则就升，回放集按版本对比。 */
export const RULE_VER = 'r1';

/** @param {string} text */
function squash(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** @param {string} text */
function head(text, n) {
  const s = squash(text);
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/**
 * Group raw turns into blocks: one block starts at each user message and
 * carries the assistant replies that follow it.
 * @param {Array<{id:number, sid:string, seq:number, role:string, text:string, t:number}>} turns
 */
export function groupTurns(turns) {
  const blocks = [];
  let current = null;
  for (const turn of turns) {
    // Sessions interleave in one append-only table; never merge two sids into
    // one question/answer block.
    if (current && current.turns[0].sid !== turn.sid) {
      blocks.push(current);
      current = null;
    }
    if (turn.role === 'user') {
      if (current) blocks.push(current);
      current = { turns: [turn] };
    } else if (current) {
      current.turns.push(turn);
    } else {
      // assistant 开头（会话中段接入）：单独成块，不丢
      current = { turns: [turn] };
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

/** @param {{turns:Array<{role:string,text:string}>}} block */
function blockText(block) {
  return block.turns
    .map((t) => `${t.role === 'user' ? '用户' : '助手'}：${squash(t.text)}`)
    .join('\n');
}

// 「别 / 不要」只有跟动作时才算决定：「别担心」「不要紧」是安慰，不是决定。
const DECISION_HINT =
  /我希望|我想要|我想让|先不做|暂时不|不要删|不要改|不要动|不要再|不要只|不要用|别删|别改|别动|别再|别用|别加|别把/;

/**
 * Rule-based classification of one block.
 * @param {string} userText
 * @param {string} allText
 */
export function classify(userText, allText) {
  const sample = `${userText} ${allText}`;
  // 决定类强词优先：「以后……不要只靠分片」是决定，不是偏好
  if (
    /决定|定了|就这样|采用|选用|还是用|以后|下次|记住|不再|改成|必须|规则|约定/.test(sample) ||
    DECISION_HINT.test(sample)
  ) {
    return 'decision';
  }
  // 「别撑了」「不用算着」是安慰话，不是偏好；偏好只认明确的态度词
  if (/偏好|更喜欢|讨厌|不喜欢|受不了|烦死|最爱/.test(sample)) return 'preference';
  // 情绪是时间强相关的：单独一类，取回只在情绪/回忆轮次触发，短半衰期
  if (/累了|难受|难过|玉玉|失眠|焦虑|撑不住|想你|低落|情绪|抑郁/.test(sample)) {
    return 'emotion';
  }
  return 'fact';
}

/** @param {string} text */
export function anchorsOf(text) {
  const set = new Set();
  // Linear scan only: a pasted megabyte must not become an O(n²) block.
  const s = String(text ?? '').slice(0, 8000);
  for (const match of s.matchAll(ANCHOR_FILE)) set.add(match[0]);
  for (const match of s.matchAll(ANCHOR_MSG)) set.add(match[0]);
  return [...set].slice(0, 8);
}

/** @param {string} text */
export function entitiesOf(text) {
  const set = new Set();
  const s = String(text ?? '').slice(0, 8000);
  for (const match of s.matchAll(ENTITY)) set.add(match[0]);
  // 名单之外的专名靠「X：」定义句补：人是先给名字再展开说的。
  // 中文引号/书名号里的词先不抽——「那个“缓存”」这种普通名词会被误当实体。
  for (const match of s.matchAll(ENTITY_DEF)) {
    const name = match[1].trim();
    if (name.length >= 2 && !ENTITY_DEF_STOP.has(name)) set.add(name);
  }
  return [...set].slice(0, 8);
}

/**
 * 表态词：决定/偏好这两类，只有用户自己说过才算「用户的决定」。
 * classify() 拿 user + assistant 的合并文本判类，所以一条决定常常
 * 是助手替用户总结出来的；那种条目的 subject 是 assistant，不是 user。
 */
const ATTITUDE =
  /决定|定了|就这样|采用|选用|还是用|以后|下次|记住|不再|改成|必须|规则|约定|偏好|更喜欢|讨厌|不喜欢|受不了|烦死|最爱/;

/**
 * Who a memory is about: the human or the assistant.
 * 普通事实看来源（有 user 就是 user）；决定和偏好要看表态词在谁嘴里。
 * @param {string} userText
 * @param {string} kind
 * @returns {'user'|'assistant'}
 */
function subjectOf(userText, kind) {
  const text = String(userText ?? '');
  if (kind === 'decision' || kind === 'preference') {
    return ATTITUDE.test(text) || DECISION_HINT.test(text) ? 'user' : 'assistant';
  }
  return text ? 'user' : 'assistant';
}

/**
 * Turn one block into a memory candidate. null when the block is too thin
 * (pure acknowledgement / empty / only a tool line).
 * @param {{turns:Array<{role:string,text:string}>}} block
 */
const GREETING = /^(ok|okay|好的?|嗯+|啊+|行|收到|可以|对的?|是的|好滴)[\s，,。.!！~～]*/i;

/** Split on sentence enders, keep the enders. */
function sentencesOf(text) {
  return String(text ?? '')
    .split(/(?<=[。！？!?；;])/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Strip markdown emphasis/code markers so summaries read as plain text. */
function stripMarkup(s) {
  return s.replace(/[*`#>]+/g, '').replace(/\s+/g, ' ').trim();
}

/** The most informative sentence, with acknowledgement softeners removed. */
function coreOf(text, n) {
  const source = squash(text);
  const parts = sentencesOf(source)
    .map((s) =>
      s
        .replace(GREETING, '')
        .replace(/^(顺带|顺便|另外|对了)[，,：: ]*/, '')
        .trim(),
    )
    .filter((s) => s.length >= 6);
  if (parts.length === 0) return head(stripMarkup(source.replace(GREETING, '')), n);
  parts.sort((a, b) => b.length - a.length);
  return head(stripMarkup(parts[0]), n);
}

/**
 * A retrievable one-liner: the human's point + what the assistant settled.
 * Rule-based until a real summarizer replaces it.
 */
/** 围栏块（代码、dsh-ui 卡片）说的是界面，不是对话内容；进摘要只会变成噪音。 */
function withoutFences(text) {
  return String(text ?? '').replace(/```[\s\S]*?(?:```|$)/g, ' ');
}

function digestOf(userText, botText) {
  const ask = coreOf(withoutFences(userText), 60);
  const answer = coreOf(withoutFences(botText), 90);
  if (ask && answer) return `问：${ask}｜答：${answer}`;
  return ask || answer;
}

/** 保留期：preference 是 persona 常驻内容，emotion 是短时效，其余走默认遗忘曲线。 */
export function retentionOf(kind) {
  if (kind === 'preference') return 'permanent';
  if (kind === 'emotion') return 'ephemeral';
  return 'auto';
}

export function candidateOf(block) {
  const user = block.turns.find((t) => t.role === 'user');
  // The conclusion usually sits in the last step of a multi-step reply; the
  // first assistant message is often just "I'll take a look".
  const assistants = block.turns.filter((t) => t.role === 'assistant');
  const assistant = assistants.length > 0 ? assistants[assistants.length - 1] : undefined;
  const allText = blockText(block);
  if (allText.length < 12) return null;

  const userText = user ? squash(user.text) : '';
  const botText = assistant ? squash(assistant.text) : '';
  // 纯回执（「好的」「嗯」）不立记忆
  if (userText.length < 6 && botText.length < 20) return null;

  const kind = classify(userText, allText);
  const summary = digestOf(userText, botText);
  const scene = head(userText || botText, 50);
  return {
    kind,
    origin: user?.origin ?? 'chat',
    subject: subjectOf(userText, kind),
    text: allText.slice(0, 2000),
    summary,
    entities: entitiesOf(allText),
    anchors: anchorsOf(allText),
    why: `当时：${scene}｜依据：${kind}`,
    tier: 'active',
    retention: retentionOf(kind),
    t: Number(block.turns[block.turns.length - 1]?.t ?? Date.now()),
    source_sid: user?.sid ?? null,
    source_seq: user?.seq ?? null,
    // 用户只说了半句、内容主要来自助手回复时，标成转述：下一轮引用它时要留余地。
    confidence: userText.length < 12 && botText.length >= 60 ? 'reported' : 'explicit',
    supersedes: null,
    rule_ver: RULE_VER,
    ids: block.turns.map((t) => t.id).filter((id) => typeof id === 'number'),
  };
}

/** @param {DatabaseSync} db */
function upsertEntities(db, names, t) {
  if (!Array.isArray(names) || names.length === 0) return;
  const stmt = db.prepare(
    'INSERT INTO entities (name, mentions, last_seen) VALUES (?, 1, ?) ' +
      'ON CONFLICT(name) DO UPDATE SET mentions = mentions + 1, last_seen = excluded.last_seen',
  );
  for (const name of names) stmt.run(name, t);
}


/**
 * 改主意的时候记一条链，不改旧条的 tier。
 *
 * 评审建议「反驳词命中就把旧条标 superseded」，但反驳词表太粗——
 * 「不」几乎每句都有，自动降级会把大量还在用的记忆埋掉。这里只做
 * 两件保守的事：词表窄到「改成/不再/反过来/错了」这类明确改口，
 * 且要求实体有交集；命中只写 supersedes 指针，旧条保持 active。
 * 等 used 数据能看出「旧条还在被取回」时，再决定要不要降级。
 */
const SUPERSEDE_CUE = /(改成|不再|反过来|错了|其实不|换一种|不这样)/;

function namesOf(raw) {
  try {
    const list = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(list) ? list.map(String) : [];
  } catch {
    return [];
  }
}

function supersedesFor(db, item) {
  const text = String(item.text ?? '');
  if (!SUPERSEDE_CUE.test(text)) return null;
  const entities = Array.isArray(item.entities) ? item.entities : [];
  if (entities.length === 0) return null;
  // 高频实体（猫、岸、dsh）几乎每条记忆都有，拿它当「同一主题」会把链挂到
  // 无关记忆上。只认低频专名——entities.mentions 已经记着每个词出现几次；
  // 查不到统计的词按低频处理（宁可多记一条链，也别把改口漏掉）。
  const placeholders = entities.map(() => '?').join(',');
  const freq = new Map(
    db
      .prepare(`SELECT name, mentions FROM entities WHERE name IN (${placeholders})`)
      .all(...entities)
      .map((row) => [row.name, Number(row.mentions) || 0]),
  );
  const credible = entities.filter((name) => (freq.get(name) ?? 0) <= 5);
  if (credible.length === 0) return null;
  const rows = db
    .prepare(
      `SELECT id, entities FROM memories
       WHERE kind = ? AND tier = 'active' AND origin = 'chat'
       ORDER BY t DESC LIMIT 30`,
    )
    .all(item.kind);
  const credibleSet = new Set(credible);
  for (const row of rows) {
    const old = namesOf(row.entities);
    if (old.some((name) => credibleSet.has(name))) return row.id;
  }
  return null;
}

/** @param {DatabaseSync} db */
/**
 * 同一话题反复说：不复制正文，只升票数。
 * 判据是「同 kind + 共享一个低频实体」——高频实体（猫、岸、dsh）几乎每条
 * 都有，拿它当主题会把无关记忆并到一起。30 天窗口之外的旧事不合并，
 * 免得半年前的决定被今天一句闲聊盖住。
 */
function sameTopicFor(db, item) {
  const entities = Array.isArray(item.entities) ? item.entities : [];
  if (entities.length === 0) return null;
  const placeholders = entities.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT name, mentions FROM entities WHERE name IN (${placeholders})`)
    .all(...entities);
  const freq = new Map(rows.map((row) => [String(row.name), Number(row.mentions) || 0]));
  const credible = entities.filter((name) => (freq.get(name) ?? 0) <= 5);
  if (credible.length === 0) return null;
  const recent = db
    .prepare(
      "SELECT id, entities FROM memories WHERE kind = ? AND tier = 'active' AND t >= ? ORDER BY t DESC LIMIT 30",
    )
    .all(item.kind, Number(item.t) - 30 * 24 * 3600 * 1000);
  for (const row of recent) {
    const have = namesOf(row.entities);
    if (credible.some((name) => have.includes(name))) return Number(row.id);
  }
  return null;
}

function insertMemory(db, item) {
  // 改口和「同一话题重复」要分开：改口必须插新条并挂链，否则新决定
  // 会被并进旧条里，supersedes 永远用不上。
  const supersedes = item.supersedes ?? supersedesFor(db, item);
  const merged = supersedes ? null : sameTopicFor(db, item);
  if (merged) {
    db.prepare('UPDATE memories SET mentions = mentions + 1, last_used = ? WHERE id = ?').run(
      item.t,
      merged,
    );
    return { id: merged, inserted: false };
  }
  const stmt = db.prepare(
    'INSERT INTO memories (kind, origin, subject, text, summary, entities, anchors, why, tier, retention, t, source_sid, source_seq, confidence, supersedes, rule_ver) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  // 只在明确改口时记链；旧条不降级，等 used 数据说话。
  const result = stmt.run(
    item.kind,
    item.origin ?? 'chat',
    item.subject ?? 'user',
    item.text,
    item.summary,
    JSON.stringify(item.entities),
    JSON.stringify(item.anchors),
    item.why,
    item.tier,
    item.retention ?? 'auto',
    item.t,
    item.source_sid,
    item.source_seq,
    item.confidence ?? 'explicit',
    supersedes,
    item.rule_ver ?? RULE_VER,
  );
  return { id: Number(result.lastInsertRowid ?? 0), inserted: true };
}

/**
 * One distillation pass over the oldest pending turns.
 * @param {DatabaseSync} db
 * @param {{limit?:number}} [opts]
 * @returns {{turns:number, memories:number}}
 */
export function refine(db, opts = {}) {
  const limit = opts.limit ?? MAX_TURNS;
  const all = pendingTurns(db, limit);
  if (all.length === 0) return { turns: 0, memories: 0 };

  // Do not cut a question from its answers at the window edge: a trailing lone
  // user turn is left for the next pass instead of becoming an answerless memory.
  let turns = all;
  if (all.length === limit && all[all.length - 1].role === 'user') {
    turns = all.slice(0, -1);
  }
  if (turns.length === 0) return { turns: 0, memories: 0 };

  const blocks = groupTurns(turns);
  let memories = 0;
  const consumed = [];
  // insertMemory + markConsumed must commit together; otherwise a crash or a
  // SQLITE_BUSY after the INSERTs replays the same turns into duplicate rows.
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const block of blocks) {
      const candidate = candidateOf(block);
      if (!candidate) continue;
      const { inserted } = insertMemory(db, candidate);
      if (inserted) {
        upsertEntities(db, candidate.entities, candidate.t);
        memories += 1;
      }
      consumed.push(...candidate.ids);
    }
    // Consume only the turns that produced a memory. A block that matched no
    // candidate stays in the raw store, merely scanned: a later rule set or model
    // must still be able to read what the current one skipped.
    markConsumed(db, [...new Set(consumed)]);
    const consumedSet = new Set(consumed);
    markScanned(
      db,
      turns.map((t) => t.id).filter((id) => !consumedSet.has(id)),
    );
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* transaction may already be closed */
    }
    throw error;
  }
  return { turns: turns.length, memories };
}

/** 表态句：命中判据的 user 消息，等它的回复落库后再即时提炼。 */
export function wantsImmediate(text) {
  return JUDGE.test(String(text ?? ''));
}

/**
 * 即时通道：一块完整了（user + 它的 assistant 回复都落库）之后炼一条。
 * 只处理它自己那一块，不碰待处理队列；炼完把这一块的 turns 标 consumed，
 * 免得空闲批通道再炼一遍。
 *
 * `reason` 让调用方知道要不要保留这个块：
 * - `incomplete`：只有 user、回复还没落库——留着等静默窗补偿；
 * - `no-candidate` / `skipped-kind`：规则不收，交回空闲批，不再占即时通道。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{sid:string, userSeq:number}} job
 * @returns {{memories:number, consumed:number, reason:'ok'|'incomplete'|'no-candidate'|'skipped-kind'}}
 */
export function refineBlock(db, { sid, userSeq }) {
  const rows = db
    .prepare(
      `SELECT id, sid, seq, role, origin, text, t FROM turns
       WHERE sid = ? AND seq >= ? ORDER BY seq`,
    )
    .all(sid, userSeq);

  const blockTurns = [];
  for (const row of rows) {
    if (blockTurns.length > 0 && row.role === 'user') break;
    blockTurns.push(row);
  }
  if (blockTurns.length < 2) return { memories: 0, consumed: 0, reason: 'incomplete' };

  const candidate = candidateOf({ turns: blockTurns });
  if (!candidate) return { memories: 0, consumed: 0, reason: 'no-candidate' };

  // 即时通道只收「表态」——decision / preference。JUDGE 是宽词面判据，
  // 「别」「原则上」「不要」这类也会命中，classify 却不一定判成表态；
  // 那种块插进去是噪音，还把这轮原文标 consumed，让空闲批再也看不到。
  if (candidate.kind !== 'decision' && candidate.kind !== 'preference') {
    return { memories: 0, consumed: 0, reason: 'skipped-kind' };
  }

  // insertMemory + markConsumed 必须一起提交，理由同 refine()。
  db.exec('BEGIN IMMEDIATE');
  try {
    const { inserted } = insertMemory(db, candidate);
    if (inserted) upsertEntities(db, candidate.entities, candidate.t);
    markConsumed(db, candidate.ids);
    db.exec('COMMIT');
    return { memories: inserted ? 1 : 0, consumed: candidate.ids.length, reason: 'ok' };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* transaction may already be closed */
    }
    throw error;
  }
}

/**
 * 回炉的键：规则升级后只扫 `rule_ver` 比当前旧的行，不重炼全库。
 * 现在只暴露查询——要不要改写这些行，等 used 数据和回放集一起看。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} [ver]
 */
export function pendingReforge(db, ver = RULE_VER) {
  return db
    .prepare(
      'SELECT id, kind, subject, summary, rule_ver FROM memories WHERE rule_ver < ? ORDER BY id',
    )
    .all(ver);
}
