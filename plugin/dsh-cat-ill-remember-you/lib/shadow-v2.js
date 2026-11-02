/**
 * M3.5 · 替换模板影子（只记账，不改历史）
 *
 * 每轮 assistant/message 之后，从 session.surface 取模型可见消息：最近 KEEP
 * 条保留原文，更早的窗口压成一段替换文本，写进 shadow_v2。只评估这段文本够
 * 不够用，不 append surfaceOp.replace —— 真替换等账本稳了再开。
 *
 * 两层判据：
 *   1. 守恒：被换内容里的锚点/实体，替换文本里还剩多少（lostRatio）。
 *   2. 断链：保留区里含指代词的 user 消息，若它指代的对象只在被换区出现过、
 *      替换文本又没接住，记一条 dangling。
 */

import { anchorsOf, entitiesOf } from './extract.js';
import { INJECT_RE } from './ingest.js';

export const DEFAULT_KEEP = 10;
export const DEFAULT_WINDOW = 40;
export const MAX_REPLACE_CHARS = 600;

/** 读整数环境变量；空值或非法值回落到默认。 */
function envInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
export const REFERRAL = /(那个|这个|它|上面|刚才|之前|前面|上次|这里|那些|这些|这事|那句)/;

const CONDENSE_USER = 100;
const CONDENSE_ASSISTANT = 140;
const CONDENSE_TOOL = 100;

/** @param {string} text */
function squash(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** @param {string} text @param {number} n */
function clip(text, n) {
  const s = squash(text);
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function blocksOf(message) {
  return Array.isArray(message?.content) ? message.content : [];
}

function toolText(block) {
  const content = block?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join(' ');
}

/** @param {unknown} message */
export function messageText(message) {
  if (typeof message?.content === 'string') return squash(message.content);
  const parts = [];
  for (const block of blocksOf(message)) {
    if (!block) continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'tool_result') parts.push(toolText(block));
  }
  return squash(parts.join('\n'));
}

/**
 * 模型可见消息序列（seq 递增）。跳过 seq 0 的 system head。
 * @returns {{seq:number, role:string, message:unknown, text:string}[]}
 */
export function surfaceMessages(session) {
  const nodes = session?.surface?.nodes;
  if (!Array.isArray(nodes)) return [];
  const out = [];
  for (const seq of nodes) {
    if (seq === 0) continue;
    const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined;
    if (!event) continue;
    const message =
      typeof session.deriveEventMessage === 'function' ? session.deriveEventMessage(event) : undefined;
    const role = message?.role;
    // 替换文本只面向对话；工具结果原文由工具层自己管。
    if (role !== 'user' && role !== 'assistant') continue;
    const text = messageText(message);
    if (!text) continue;
    if (role === 'user') {
      const kind = message?.source?.kind;
      if (typeof kind === 'string' && kind !== 'user') continue;
      if (!message?.source && INJECT_RE.test(text)) continue;
    }
    out.push({ seq, role, message, text });
  }
  return out;
}

/**
 * 保留最近 keep 条原文，更早的进 replaced。
 * @param {Array} entries
 * @param {number} keep
 */
export function splitKeep(entries, keep = DEFAULT_KEEP) {
  const list = Array.isArray(entries) ? entries : [];
  const k = Math.max(0, Math.floor(Number(keep) || 0));
  if (list.length <= k) return { replaced: [], kept: list };
  return {
    replaced: list.slice(0, list.length - k),
    kept: list.slice(list.length - k),
  };
}

function condense(entry) {
  if (entry.role === 'user') return clip(entry.text, CONDENSE_USER);
  if (entry.role === 'assistant') {
    const parts = String(entry.text ?? '')
      .split(/\n+/)
      .map(squash)
      .filter(Boolean);
    return clip(parts.at(-1) ?? entry.text ?? '', CONDENSE_ASSISTANT);
  }
  return clip(entry.text, CONDENSE_TOOL);
}

/**
 * 把被换窗口压成一段替换文本，硬上界 maxChars。
 * @param {Array} replaced
 * @param {{maxChars?:number}} [options]
 */
export function renderReplacement(replaced, { maxChars = MAX_REPLACE_CHARS } = {}) {
  const list = Array.isArray(replaced) ? replaced : [];
  if (list.length === 0) return '';
  const first = list[0]?.seq ?? 0;
  const last = list.at(-1)?.seq ?? 0;
  const limit = Math.max(80, maxChars - 90);
  const picked = [];
  let size = 0;
  // 从最近的老消息往回填：贴着保留区的细节更可能被下一轮接着用。
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const entry = list[index];
    const text = condense(entry);
    if (!text) continue;
    const prefix = entry.role === 'user' ? '他说' : '我说';
    const line = `- ${prefix}: ${text}`;
    if (size + line.length + 1 > limit) continue;
    picked.push(line);
    size += line.length + 1;
  }
  if (picked.length === 0) {
    const entry = [...list].reverse().find((item) => condense(item));
    if (!entry) return '';
    const prefix = entry.role === 'user' ? '他说' : '我说';
    picked.push(`- ${prefix}: ${condense(entry).slice(0, Math.max(20, limit - 10))}`);
  }
  picked.reverse();
  const header =
    `[上下文替换] 更早的 ${list.length} 条消息（seq ${first}-${last}）原文在本地，` +
    `这里只留接得上的摘要：\n`;
  const out = header + picked.join('\n');
  return out.length <= maxChars ? out : `${out.slice(0, maxChars - 1)}…`;
}

/** 被换窗口里的锚点/实体，去重。 */
export function keyTokens(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const source = list.map((entry) => entry.text).join('\n');
  const tokens = new Set();
  for (const anchor of anchorsOf(source)) tokens.add(anchor);
  for (const entity of entitiesOf(source)) tokens.add(entity);
  return [...tokens];
}

/**
 * 评估替换文本：守恒 + 断链。
 * @param {{replaced:Array, kept:Array, text:string}} input
 */
export function assessReplacement({ replaced, kept, text }) {
  const textOut = String(text ?? '');
  const tokens = keyTokens(replaced);
  const missing = tokens.filter((token) => !textOut.includes(token));
  const inReplaced = new Set(tokens);
  const dangling = [];
  for (const entry of Array.isArray(kept) ? kept : []) {
    if (entry.role !== 'user' || !REFERRAL.test(entry.text)) continue;
    const referents = [...anchorsOf(entry.text), ...entitiesOf(entry.text)];
    const outside = referents.filter((token) => inReplaced.has(token) && !textOut.includes(token));
    if (outside.length > 0) dangling.push({ seq: entry.seq, referents: outside });
  }
  return {
    tokens,
    missing,
    lostRatio: tokens.length === 0 ? 0 : missing.length / tokens.length,
    dangling,
  };
}

/**
 * 写一行 shadow_v2。字段顺序与 db.js 的 SCHEMA 一致。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{sid:string,turn:number,t:number,rangeStart:number,rangeEnd:number,seqs:string,text:string,charsBefore:number,charsAfter:number,kept:number,lostRatio:number,dangling:number}} row
 */
export function recordShadowV2(db, row) {
  db.prepare(
    `INSERT INTO shadow_v2
       (sid, turn, t, range_start, range_end, seqs, text, chars_before, chars_after, kept, lost_ratio, dangling)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.sid,
    row.turn,
    row.t,
    row.rangeStart,
    row.rangeEnd,
    row.seqs,
    row.text,
    row.charsBefore,
    row.charsAfter,
    row.kept,
    row.lostRatio,
    row.dangling,
  );
}

/**
 * 一轮结束时调用：算替换文本 + 评估 + 落库。只记账。
 * @returns {object|null}
 */
export function planShadowV2(
  session,
  db,
  {
    keep = envInt('DSH_MEMORY_CORE_KEEP', DEFAULT_KEEP),
    window = envInt('DSH_MEMORY_CORE_SHADOW_WINDOW', DEFAULT_WINDOW),
    now = Date.now(),
  } = {},
) {
  const entries = surfaceMessages(session);
  if (entries.length <= keep) return null;
  const { replaced: older, kept } = splitKeep(entries, keep);
  const cap = Math.max(1, Math.floor(Number(window) || DEFAULT_WINDOW));
  const replaced = older.slice(-cap);
  if (replaced.length === 0) return null;
  const text = renderReplacement(replaced);
  const assessment = assessReplacement({ replaced, kept, text });
  const charsBefore = replaced.reduce((total, entry) => total + entry.text.length, 0);
  const row = {
    sid: String(session?.id ?? session?.sessionId ?? 'unknown'),
    turn: 0,
    t: now,
    rangeStart: replaced[0].seq,
    rangeEnd: replaced.at(-1).seq,
    seqs: JSON.stringify(replaced.map((entry) => entry.seq)),
    text,
    charsBefore,
    charsAfter: text.length,
    kept: kept.length,
    lostRatio: assessment.lostRatio,
    dangling: assessment.dangling.length,
  };
  recordShadowV2(db, row);
  return {
    ...row,
    missing: assessment.missing,
    danglingList: assessment.dangling,
  };
}
