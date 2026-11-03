/**
 * M3.5 · 替换模板影子（只记账，不改历史）
 *
 * 每轮 assistant/message 之后，从 session.surface 取模型可见消息：最近若干条
 * 保留原文，更早的窗口压成一段替换文本，写进 shadow_v2。
 * 真替换由白名单文件控制；替换文本是接续用的缓存，变长变短都换。
 *
 * 两层判据：
 *   1. 守恒：被换内容里的锚点/实体，替换文本里还剩多少（lostRatio）。
 *   2. 断链：保留区里含指代词的 user 消息，若它指代的对象只在被换区出现过、
 *      替换文本又没接住，记一条 dangling。
 */

import { anchorsOf, entitiesOf } from './extract.js';
import { INJECT_RE } from './ingest.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_KEEP = 10;
export const DEFAULT_WINDOW = 40;
// 保留区不再是固定 10 条：短会话也换，长会话多留。至少留 4 条原文，最多 10 条。
export const MIN_KEEP = 4;
export const KEEP_RATIO = 0.4;
// 少于这个条数不跑：没有可换的内容。
export const MIN_ENTRIES = 4;
// 替换文本是缓存不是压缩：600 字上限放开到 1500，变大可以理解。
export const MAX_REPLACE_CHARS = 1500;
// 同一会话两次真替换之间的冷却。每轮都改前缀会让缓存每轮失效。
export const REPLACE_COOLDOWN_MS = 3 * 60 * 1000;

// 滚动替换（P1）：不再等窗口满一次换掉 40%，而是每次只动最早 STEP 条，
// 最近 KEEP_TAIL 条永远是原文。条数或字数任一超线就跑。
export const ROLL_KEEP_TAIL = 6;
export const ROLL_STEP = 4;
export const ROLL_SOFT_BUDGET = 6000;
// 每次只动 4 条，冷却可以比「一次换一大段」短。
export const ROLL_COOLDOWN_MS = 60 * 1000;

// 同一个区间只允许一个替换在途：记账那一行要等微任务里的 append 成功才
// 标 applied=1，这期间同区间再评估一次会重复排队。用内存锁挡住。
const pending = new Set();

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
    `[上下文替换] 更早 ${list.length} 条（seq ${first}-${last}），原文在本地：\n` +
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
 * @param {{sid:string,turn:number,t:number,rangeStart:number,rangeEnd:number,seqs:string,text:string,charsBefore:number,charsAfter:number,kept:number,lostRatio:number,dangling:number,cwd?:string}} row
 */
export function recordShadowV2(db, row) {
  return db
    .prepare(
      `INSERT INTO shadow_v2
       (sid, turn, t, range_start, range_end, seqs, text, chars_before, chars_after, kept, lost_ratio, dangling, applied, cwd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      row.cwd ?? '',
    );
}

/** 旧的全局开关，保留导出只为兼容；现在开关就是白名单文件本身。 */
/** @deprecated 已不读这个环境变量；开关只看下面的白名单文件。保留导出仅为兼容旧脚本。 */
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
  const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : [];
  // 按位置取区间，不按 seq 值过滤：早先替换块的 seq 比它所在位置大，会夹在
  // 后续区间中间。值过滤会把它漏掉，而宿主按位置判断 shadowedSeqs，报 missing。
  const startIdx = nodes.indexOf(startSeq);
  let endIdx = nodes.indexOf(replaced.at(-1).seq);
  if (startIdx < 0 || endIdx < startIdx) return false;
  // 遮蔽区间不能切在 assistant 消息和它的 tool/call 之间：消息被换掉、
  // tool/call 还留在表面上，后端会收到没有对应调用的 tool 结果
  // （DeepSeek: Messages tool result has no matching call）。
  for (;;) {
    const nextSeq = nodes[endIdx + 1];
    const nextEvent = nextSeq == null ? undefined : session.eventAt?.(nextSeq);
    if (!nextEvent || nextEvent.type !== 'tool/call') break;
    endIdx -= 1;
    if (endIdx < startIdx) return false;
  }
  const endSeq = nodes[endIdx];
  const seqs = nodes.slice(startIdx, endIdx + 1);
  if (seqs.length === 0) return false;
  try {
    session.append(
      'user/message',
      {
        // 宿主 assertMessageEventShape 要求 user/message 的 data 本身是一条带
        // id/role/source/content 的消息，缺 id 会让整个会话判 corrupt。
        id: randomUUID(),
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
/** 保留区条数：显式传 > 环境变量 > 按总量 40% 动态（至少 4、至多 10 条）。 */
function resolveKeep(total, explicit) {
  if (explicit != null) return Math.max(1, Math.floor(Number(explicit) || 0));
  const env = envInt('DSH_MEMORY_CORE_KEEP', 0);
  if (env > 0) return env;
  return Math.max(MIN_KEEP, Math.min(DEFAULT_KEEP, Math.round(total * KEEP_RATIO)));
}

export function planShadowV2(
  session,
  db,
  {
    keep = null,
    window = envInt('DSH_MEMORY_CORE_SHADOW_WINDOW', DEFAULT_WINDOW),
    now = Date.now(),
    roll = process.env.DSH_MEMORY_CORE_ROLL !== '0',
  } = {},
) {
  const entries = surfaceMessages(session);
  if (entries.length <= MIN_ENTRIES) return null;
  let replaced;
  let kept;
  if (roll) {
    // 滚动模式：只动最早 STEP 条，最近 KEEP_TAIL 条永远是原文。
    if (entries.length <= ROLL_KEEP_TAIL) return null;
    const totalChars = entries.reduce((total, entry) => total + entry.text.length, 0);
    const overCount = entries.length > ROLL_KEEP_TAIL + ROLL_STEP;
    if (!overCount && totalChars <= ROLL_SOFT_BUDGET) return null;
    const early = entries.slice(0, entries.length - ROLL_KEEP_TAIL);
    replaced = early.slice(0, ROLL_STEP);
    kept = [...early.slice(ROLL_STEP), ...entries.slice(entries.length - ROLL_KEEP_TAIL)];
  } else {
    // 旧逻辑兜底：按比例保留，一次换掉更早的一段。
    const keepCount = resolveKeep(entries.length, keep);
    const split = splitKeep(entries, keepCount);
    const cap = Math.max(1, Math.floor(Number(window) || DEFAULT_WINDOW));
    replaced = split.replaced.slice(-cap);
    kept = split.kept;
  }
  if (replaced.length === 0) return null;
  const sid = String(session?.id ?? session?.sessionId ?? 'unknown');
  // 白名单外不记账：这些会话不会真替换，账本只会随宿主压缩反复增行。
  // 「只看会怎么换」的推演也放进白名单会话里做，别让它变成噪音。
  if (!replaceEnabled(sid)) return null;
  const cwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : '';
  const rangeStart = replaced[0].seq;
  const rangeEnd = replaced.at(-1).seq;
  // 同一区间不重复记账：每轮都会重算，但被换的窗口没动就没新信息。
  // 上一次 apply 失败（applied=0）时允许重试，否则一次微任务失败会让
  // 这段永远停在原文。
  const last = db
    .prepare('SELECT range_start, range_end, applied FROM shadow_v2 WHERE sid = ? ORDER BY id DESC LIMIT 1')
    .get(sid);
  if (
    last
    && last.range_start === rangeStart
    && last.range_end === rangeEnd
    && Number(last.applied) === 1
  ) {
    return null;
  }
  const text = renderReplacement(replaced);
  const assessment = assessReplacement({ replaced, kept, text });
  const charsBefore = replaced.reduce((total, entry) => total + entry.text.length, 0);
  // 冷却：刚换过就先不换，也不记账——窗口没动，再记一行没有新信息。
  // 只看不换的会话没有 applied=1 的行，永远不走这条分支。
  const recent = db
    .prepare('SELECT t FROM shadow_v2 WHERE sid = ? AND applied = 1 ORDER BY id DESC LIMIT 1')
    .get(sid);
  const cooldown = roll ? ROLL_COOLDOWN_MS : REPLACE_COOLDOWN_MS;
  if (recent && now - recent.t < cooldown) return null;
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
    cwd,
  };
  const pendingKey = `${sid}:${rangeStart}:${rangeEnd}`;
  if (pending.has(pendingKey)) return null;
  pending.add(pendingKey);
  const info = recordShadowV2(db, row);
  // 真替换不能在 session/event 回调里同步 append：此刻宿主还在发布边界内，
  // 重入 append 会被拒绝。推到微任务，等 appending 标志落下再写。
  queueMicrotask(() => {
    try {
      // 判据：换完变长变短都换——替换文本是接续用的缓存，不是压缩。
      // 冷却已在记账前挡掉，这里只试一次；失败留 applied=0，下一轮重试。
      if (applyReplacement(session, replaced, text, sid)) {
        db.prepare('UPDATE shadow_v2 SET applied = 1 WHERE id = ?').run(Number(info.lastInsertRowid));
      }
    } catch {
      /* 记账失败不影响会话 */
    } finally {
      pending.delete(pendingKey);
    }
  });
  return {
    ...row,
    missing: assessment.missing,
    danglingList: assessment.dangling,
  };
}
