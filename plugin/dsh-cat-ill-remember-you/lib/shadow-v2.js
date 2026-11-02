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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_KEEP = 10;
export const DEFAULT_WINDOW = 40;
export const MAX_REPLACE_CHARS = 600;
// 收益门槛：替换文本要比被换原文明显短才值得真换。
export const REPLACE_GAIN = 0.7;

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
      // 我们自己写进历史的替换文本不能再被当成「他说」。
      if (text.startsWith('[上下文替换]')) continue;
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
  // 实体·锚点清单先写：断链几乎都发生在这些 token 上，把它们钉在文本最前面。
  const keywords = keyTokens(list).slice(0, 24);
  // 约定句原样留：关键词救不了「以后不要怎样」，句子才行。
  const promises = promiseLines(list, { max: 4, chars: 36 });
  const header =
    `[上下文替换] 更早的 ${list.length} 条消息（seq ${first}-${last}）原文在本地，` +
    `这里只留接得上的摘要：\n` +
    (keywords.length > 0 ? `关键词：${keywords.join('、')}\n` : '') +
    (promises.length > 0 ? `约定：${promises.join('；')}\n` : '');
  const limit = Math.max(80, maxChars - header.length - 10);
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
    if (!entry) return header;
    const prefix = entry.role === 'user' ? '他说' : '我说';
    picked.push(`- ${prefix}: ${condense(entry).slice(0, Math.max(20, limit - 10))}`);
  }
  picked.reverse();
  const out = header + picked.join('\n');
  return out.length <= maxChars ? out : `${out.slice(0, maxChars - 1)}…`;
}

/** 被换窗口里的锚点/实体，去重。实体在前：回放显示 entities key 的断链率是 anchors 的十分之一。 */
export function keyTokens(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const source = list.map((entry) => entry.text).join('\n');
  const tokens = new Set();
  for (const entity of entitiesOf(source)) tokens.add(entity);
  for (const anchor of anchorsOf(source)) tokens.add(anchor);
  return [...tokens];
}

const PROMISE_RE = /(不要|别再|别忘|记住|以后|约定|答应|下次|永远|说好)/;

/**
 * 从被换窗口里挑出带约定词的句子。约定句必须原样留，不能只剩关键词。
 * @param {Array} entries
 * @param {{max?:number, chars?:number}} [options]
 */
export function promiseLines(entries, { max = 4, chars = 36 } = {}) {
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    for (const part of String(entry?.text ?? '').split(/[。；\n]+/)) {
      const s = squash(part);
      if (s.length < 4 || !PROMISE_RE.test(s)) continue;
      const key = s.slice(0, 16);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(clip(s, chars));
      if (out.length >= max) return out;
    }
  }
  return out;
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
  return db
    .prepare(
      `INSERT INTO shadow_v2
       (sid, turn, t, range_start, range_end, seqs, text, chars_before, chars_after, kept, lost_ratio, dangling, applied)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
      row.applied ? 1 : 0,
    );
}

/** 旧的全局开关，保留导出只为兼容；现在开关就是白名单文件本身。 */
export const REPLACE_FLAG = 'DSH_MEMORY_CORE_REPLACE';

/** 白名单文件：每行一个 session id，`*` 表示全部。只有列在里面的会话才真替换。 */
export const REPLACE_SESSIONS_FLAG = 'DSH_MEMORY_CORE_REPLACE_SESSIONS';
export const REPLACE_SESSIONS_FILE = path.join(os.homedir(), '.dsh', 'cache', 'replace-sessions.txt');

function sessionsFile() {
  return process.env[REPLACE_SESSIONS_FLAG] || REPLACE_SESSIONS_FILE;
}

export function replaceEnabled(sid) {
  // 白名单文件就是开关：不存在 = 全关；存在 = 只认名单里的会话（`*` 全开）。
  // 不用改启动命令、不用带环境变量，写一行文本就开，删掉就关。
  let lines;
  try {
    lines = fs.readFileSync(sessionsFile(), 'utf8').split(/\r?\n/);
  } catch {
    return false;
  }
  const allowed = lines.map((line) => line.trim()).filter(Boolean);
  if (allowed.length === 0) return false;
  if (allowed.includes('*')) return true;
  return sid != null && allowed.includes(String(sid));
}

/**
 * 真替换：把被换窗口压成一条 user/message，用 surfaceOp.replace 盖掉原区间。
 * 宿主校验要求 sourceEventSeqs 覆盖区间内每个 surface node，所以这里取
 * surface.nodes 里落在区间内的全部 seq（含工具结果）。
 * @returns {boolean} 是否真的写入了替换事件
 */
export function applyReplacement(session, replaced, text, sid) {
  if (!replaceEnabled(sid)) return false;
  if (!Array.isArray(replaced) || replaced.length === 0) return false;
  if (typeof session?.append !== 'function') return false;
  const startSeq = replaced[0].seq;
  const endSeq = replaced.at(-1).seq;
  const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : [];
  const seqs = nodes.filter((seq) => seq >= startSeq && seq <= endSeq);
  if (seqs.length === 0) return false;
  try {
    session.append(
      'user/message',
      {
        role: 'user',
        content: [{ type: 'text', text }],
        // 宿主投影会对每条 surface 消息读 source.kind（runtime-context 判断归属），
        // 缺 source 会让整个会话加载时报 `Cannot read properties of undefined`。
        source: { kind: 'context-replacement' },
      },
      { surfaceOp: { op: 'replace', startSeq, endSeq }, sourceEventSeqs: seqs },
    );
    return true;
  } catch {
    return false;
  }
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
  const sid = String(session?.id ?? session?.sessionId ?? 'unknown');
  const rangeStart = replaced[0].seq;
  const rangeEnd = replaced.at(-1).seq;
  // 同一区间不重复记账：每轮都会重算，但被换的窗口没动就没新信息。
  const last = db
    .prepare('SELECT range_start, range_end FROM shadow_v2 WHERE sid = ? ORDER BY id DESC LIMIT 1')
    .get(sid);
  if (last && last.range_start === rangeStart && last.range_end === rangeEnd) return null;
  const text = renderReplacement(replaced);
  const assessment = assessReplacement({ replaced, kept, text });
  const charsBefore = replaced.reduce((total, entry) => total + entry.text.length, 0);
  const row = {
    sid,
    turn: 0,
    t: now,
    rangeStart,
    rangeEnd,
    seqs: JSON.stringify(replaced.map((entry) => entry.seq)),
    text,
    charsBefore,
    charsAfter: text.length,
    kept: kept.length,
    lostRatio: assessment.lostRatio,
    dangling: assessment.dangling.length,
    applied: false,
  };
  const info = recordShadowV2(db, row);
  // 真替换不能在 session/event 回调里同步 append：此刻宿主还在发布边界内，
  // 重入 append 会被拒绝。推到微任务，等 appending 标志落下再写。
  queueMicrotask(() => {
    try {
      // 收益门槛：替换文本要比原文明显短才动手。固定头（关键词/约定）在短对话
      // 上会把 88 字撑成 149 字，换完反而更长，这种只记账不真换。
      const worthIt = text.length < charsBefore * REPLACE_GAIN;
      if (worthIt && applyReplacement(session, replaced, text, sid)) {
        db.prepare('UPDATE shadow_v2 SET applied = 1 WHERE id = ?').run(Number(info.lastInsertRowid));
      }
    } catch {
      /* 记账失败不影响会话 */
    }
  });
  return {
    ...row,
    missing: assessment.missing,
    danglingList: assessment.dangling,
  };
}
