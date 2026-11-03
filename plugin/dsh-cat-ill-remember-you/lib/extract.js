/**
 * M1 · 规则提炼（规则先行，模型后接）
 *
 * 本机 Ollama 只有 embedding 模型，没有生成模型，所以这一版不调模型：
 * 用可解释的规则把原始轮次切成「记忆候选」，写进 memories。
 * 等 M1.5 / M2 再接模型，接口不变（refine() 是唯一入口）。
 */

import { pendingTurns, markConsumed, markScanned } from './db.js';

const JUDGE =
  /(以后|下次|记住|不要|别|必须|规则|约定|原则上|不再|改成|还是用|决定|定了|就这样|采用|选用|偏好|更喜欢|讨厌|不喜欢)/;

const ANCHOR_FILE =
  /[A-Za-z]:[\\/][^\s"'）)】\]，,；;]+|[^\s"'）)】\]，,；;：:]+\.(?:mjs|js|ts|tsx|md|json|ya?ml|py|sh|ps1|cmd|txt|png|svg|db)/g;
const ANCHOR_MSG = /\bm\d{5}\b/g;
const ENTITY = /猫|岸|DeepSeek|dsh[\w-]*|Ollama|qwen[\w.:-]*/g;

const MAX_TURNS = 40;
const MAX_BLOCK_CHARS = 2400;

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

/**
 * Rule-based classification of one block.
 * @param {string} userText
 * @param {string} allText
 */
export function classify(userText, allText) {
  const sample = `${userText} ${allText}`;
  // 决定类强词优先：「以后……不要只靠分片」是决定，不是偏好
  if (/决定|定了|就这样|采用|选用|还是用|以后|下次|记住|不再|改成|必须|规则|约定/.test(sample)) {
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
  return [...set].slice(0, 8);
}

/**
 * Who a memory is about: the human or the assistant.
 * The summary/body of a candidate comes from the human turn whenever there is
 * one, so the subject follows the summary's source instead of comparing lengths.
 * A block with only an assistant turn is about the assistant.
 * @param {string} userText
 * @returns {'user'|'assistant'}
 */
function subjectOf(userText) {
  return userText ? 'user' : 'assistant';
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
function digestOf(userText, botText) {
  const ask = coreOf(userText, 60);
  const answer = coreOf(botText, 90);
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
    subject: subjectOf(userText),
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

/** @param {DatabaseSync} db */
function insertMemory(db, item) {
  const stmt = db.prepare(
    'INSERT INTO memories (kind, origin, subject, text, summary, entities, anchors, why, tier, retention, t, source_sid, source_seq, confidence) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
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
  );
  return Number(result.lastInsertRowid ?? 0);
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
      const id = insertMemory(db, candidate);
      if (id) {
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
