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
import { sidOf } from './sid.js';
import { spillPathOf } from './originals.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let log = () => {};
/** 注入日志：index.js 把宿主 log 接进来；没接时静默。 */
export function setShadowLogger(fn) {
  log = typeof fn === 'function' ? fn : () => {};
}

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

// 滚动替换（P1）：不再等窗口满一次换掉 40%，而是每次只动最早 STEP 条。
// 保留区按「轮」算（最后一条 user 起）；ROLL_KEEP_TAIL 只在一条 user 都没有时兜底。
export const ROLL_KEEP_TAIL = 6;
export const ROLL_STEP = 4;
export const ROLL_SOFT_BUDGET = 6000;
// 每次只动 4 条，冷却可以比「一次换一大段」短。
export const ROLL_COOLDOWN_MS = 60 * 1000;

/** full 模式只留最后这几条原文（当前轮）；更早的全部换掉。 */
export const FULL_KEEP_TAIL = 2;
// full 的成本随会话长度线性涨：每轮全量拉该 sid 的 turns 再全量拼接。
// 超过上限退回 roll（每轮只动 ROLL_STEP 条，成本有界），宁可压得慢也不卡事件循环。
export const FULL_MAX_ROWS = envInt('DSH_MEMORY_CORE_FULL_MAX_ROWS', 800);

// 同一个区间只允许一个替换在途：记账那一行要等微任务里的 append 成功才
// 标 applied=1，这期间同区间再评估一次会重复排队。用内存锁挡住。
const pending = new Set();
// 已经报过降级的会话：日志只打一次，别每轮刷。
const degraded = new Set();

/** 读整数环境变量；空值或非法值回落到默认。 */
function envInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
export const REFERRAL = /(那个|这个|它|上面|刚才|之前|前面|上次|这里|那些|这些|这事|那句)/;

/**
 * 保留区按「轮」算：从最后一条 user 起，到末尾全留原文。
 * 多步回复里最后几条常常是 assistant，按条数留会把当前提问换进区间。
 */
export function lastUserIndex(entries) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].role === 'user') return i;
  }
  return -1;
}

// 替换块是模型唯一能看到的旧历史。定长取前 N 字会把结论砍掉（缺陷文档第 1 条
// 有实证：seq 414 / 399 的结论都在后三分之一）。改成保首句 + 保尾句，中段按句
// 从后往前填——结论几乎总在最后一句，所以尾巴是必保的。
const CONDENSE_HEAD = 50;
const CONDENSE_TAIL = 80;
const CONDENSE_USER = 120;
const CONDENSE_ASSISTANT = 200;
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
      if (text.startsWith('[上下文替换')) continue;
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

/**
 * 首句 + 尾句 + 中段按句从后往前填。预算不够时宁可只保首尾，
 * 也不退回「取前 N 字」——那样丢的恰好是结论。
 * @param {string} text
 * @param {number} budget
 */
function condenseBody(text, budget) {
  const s = squash(text);
  if (s.length <= budget) return s;
  // 按比例分：短消息（user）也要给尾巴留够位置。
  const head = Math.max(8, Math.min(CONDENSE_HEAD, Math.floor(budget * 0.35)));
  const tail = Math.max(8, Math.min(CONDENSE_TAIL, Math.floor(budget * 0.4)));
  const middleBudget = budget - head - tail - 2; // 两个省略号
  const headText = s.slice(0, head);
  const tailText = s.slice(s.length - tail);
  if (middleBudget < 8) return `${headText}…${tailText}`;
  const middle = s.slice(head, s.length - tail);
  const sentences = middle
    .split(/(?<=[。；！？!?])/)
    .map(squash)
    .filter(Boolean);
  let picked = '';
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    const piece = sentences[i];
    if (picked.length + piece.length > middleBudget) break;
    picked = piece + picked;
  }
  return picked ? `${headText}…${picked}…${tailText}` : `${headText}…${tailText}`;
}

function condense(entry) {
  if (entry.role === 'user') return condenseBody(entry.text, CONDENSE_USER);
  // 旧实现只留 assistant 的最后一段（按换行切），首句和中间的全丢。
  if (entry.role === 'assistant') return condenseBody(entry.text, CONDENSE_ASSISTANT);
  return condenseBody(entry.text, CONDENSE_TOOL);
}

/**
 * 区间里的工具结果：替换文本只写对话，但工具原文被压掉后模型就完全不知道
 * 这段发生过什么。这里给一行索引——带上 seq，宿主侧还能按 seq 取回原文。
 */
function toolNote(session, seqs) {
  const list = Array.isArray(seqs) ? seqs : [];
  const names = new Map();
  const results = [];
  for (const seq of list) {
    const event = typeof session?.eventAt === 'function' ? session.eventAt(seq) : undefined;
    if (!event) continue;
    if (event.type === 'tool/call') {
      for (const call of event.data?.calls ?? []) {
        if (call?.callId && call?.name) names.set(String(call.callId), String(call.name));
      }
    } else if (event.type === 'tool/result') {
      const message = event.data?.message;
      const callId = message?.source?.callId;
      const text = (Array.isArray(message?.content) ? message.content : [])
        .map((block) => (typeof block?.text === 'string' ? block.text : ''))
        .join('\n');
      results.push({ seq, name: names.get(String(callId)) ?? '', spill: spillPathOf(text) });
    }
  }
  if (results.length === 0) return '';
  const head = results.slice(0, 4).map((item) => `${item.name || '工具'}@${item.seq}`).join('、');
  const more = results.length > 4 ? ` 等 ${results.length} 个` : '';
  // spill 目录比 seq 稳定：seq 重启后指过去是空的，磁盘上的文件还在。
  const dirs = [...new Set(results.map((item) => (item.spill ? path.dirname(item.spill) : '')).filter(Boolean))];
  const where = dirs.length === 0
    ? '；原文按 seq 取回'
    : `；全文在 ${dirs[0]}${dirs.length > 1 ? ` 等 ${dirs.length} 个目录` : ''}`;
  return `［工具结果 ${results.length} 个：${head}${more}${where}］`;
}

/** surface 上 seq 落在区间内的节点（含工具节点）。 */
function nodesBetween(session, from, to) {
  const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : [];
  return nodes.filter((seq) => Number(seq) >= Number(from) && Number(seq) <= Number(to));
}

/**
 * 把被换窗口压成一段替换文本，硬上界 maxChars。
 * @param {Array} replaced
 * @param {{maxChars?:number}} [options]
 */
export function renderReplacement(replaced, { maxChars = MAX_REPLACE_CHARS, note = '' } = {}) {
  const list = Array.isArray(replaced) ? replaced : [];
  if (list.length === 0) return '';
  const first = list[0]?.seq ?? 0;
  const last = list.at(-1)?.seq ?? 0;
  // 实体·锚点清单先写：断链几乎都发生在这些 token 上，把它们钉在文本最前面。
  const keywords = keyTokens(list).slice(0, 24);
  // 约定句原样留：关键词救不了「以后不要怎样」，句子才行。
  const promises = promiseLines(list, { max: 4, chars: 36 });
  const header =
    `[上下文替换｜旧消息压缩，非用户发言] 更早 ${list.length} 条（seq ${first}-${last}），原文事件仍在会话日志里、工具结果见下方索引：\n` +
    (keywords.length > 0 ? `关键词：${keywords.join('、')}\n` : '') +
    (promises.length > 0 ? `约定：${promises.join('；')}\n` : '') +
    (note ? `${note}\n` : '');
  const limit = Math.max(80, maxChars - header.length - 10);
  const picked = [];
  let size = 0;
  // 从最近的老消息往回填：贴着保留区的细节更可能被下一轮接着用。
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const entry = list[index];
    const text = condense(entry);
    if (!text) continue;
    const prefix = entry.role === 'user' ? '用户' : '助手';
    const line = `- ${prefix}: ${text}`;
    if (size + line.length + 1 > limit) continue;
    picked.push(line);
    size += line.length + 1;
  }
  if (picked.length === 0) {
    const entry = [...list].reverse().find((item) => condense(item));
    if (!entry) return header;
    const prefix = entry.role === 'user' ? '用户' : '助手';
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
export function assessReplacement({ replaced, kept, text, charsBefore }) {
  const textOut = String(text ?? '');
  const before = Number(charsBefore) || (Array.isArray(replaced)
    ? replaced.reduce((total, entry) => total + String(entry.text ?? '').length, 0)
    : 0);
  const after = textOut.length;
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
    // 主字段改成字符差：之前存的是「关键 token 缺失比例」，名字叫 lost_ratio
    // 却不是「丢了多少文本」——chars 599→420 丢 30% 而它可以是 0。
    // 允许为负：替换文本比原文长是合法的，它是缓存，不是压缩。
    lostRatio: before === 0 ? 0 : 1 - after / before,
    // 关键 token 保留率单独一列。两个一起看才有意义：
    // 字符砍了 30% 而 token 全在，说明砍掉的是冗余；token 掉了才是断链风险。
    tokenKeep: tokens.length === 0 ? 1 : 1 - missing.length / tokens.length,
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
       (sid, turn, t, range_start, range_end, seqs, text, chars_before, chars_after, kept, lost_ratio, token_keep, dangling, applied, cwd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      row.tokenKeep ?? 0,
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

// 白名单文件很小，但 replaceMode 会被 provider.text() 每次 refresh 调到，
// 也会在每个 assistant 事件里调到。按 mtime+size 缓存内容，只在文件真变了
// 才重读；读失败不写缓存，文件后来出现仍能读到。
const sessionsCache = { file: '', mtimeMs: -1, size: -1, text: null };

function sessionsText() {
  const file = sessionsFile();
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const { mtimeMs, size } = stat;
  if (
    sessionsCache.file === file
    && sessionsCache.mtimeMs === mtimeMs
    && sessionsCache.size === size
  ) {
    return sessionsCache.text;
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  sessionsCache.file = file;
  sessionsCache.mtimeMs = mtimeMs;
  sessionsCache.size = size;
  sessionsCache.text = text;
  return text;
}

export function replaceEnabled(sid) {
  return replaceMode(sid) !== 'off';
}

/**
 * 白名单里每行可以是 `sid`（滚动小步）、`sid:full`（一次换掉全部旧历史）
 * 或 `sid:append`（不动历史，只在上下文末尾追加一块「如果替换会变成什么样」）；
 * `*`/`*:full`/`*:append` 对所有会话生效。返回 'off' | 'roll' | 'full' | 'append'。
 * @param {string|null|undefined} sid
 * @returns {'off'|'roll'|'full'|'append'}
 */
export function replaceMode(sid) {
  const text = sessionsText();
  if (text == null) return 'off';
  const allowed = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (allowed.length === 0) return 'off';
  const id = sid == null ? '' : String(sid);
  if (allowed.includes('*:full') || allowed.includes(`${id}:full`)) return 'full';
  if (allowed.includes('*:append') || allowed.includes(`${id}:append`)) return 'append';
  if (allowed.includes('*') || allowed.includes(id)) return 'roll';
  return 'off';
}

/** 上一次记账是不是同一个区间且已应用——是就不用再算一遍。 */
function sameRangeApplied(db, sid, rangeStart, rangeEnd) {
  const last = db
    .prepare(
      'SELECT range_start, range_end, applied FROM shadow_v2 WHERE sid = ? ORDER BY id DESC LIMIT 1',
    )
    .get(sid);
  return Boolean(
    last
    && last.range_start === rangeStart
    && last.range_end === rangeEnd
    && Number(last.applied) === 1,
  );
}

/**
 * 真替换：把被换窗口压成一条 user/message，用 surfaceOp.replace 盖掉原区间。
 * 宿主校验要求 sourceEventSeqs 覆盖区间内每个 surface node，所以这里取
 * surface.nodes 里落在区间内的全部 seq（含工具结果）。
 * @returns {boolean} 是否真的写入了替换事件
 */
export function applyReplacement(session, replaced, text, sid, { startSeq = null, endSeq = null } = {}) {
  if (!replaceEnabled(sid)) {
    log(`apply skip: 不在白名单 sid=${sid}`);
    return false;
  }
  if (!Array.isArray(replaced) || replaced.length === 0) {
    log(`apply skip: 没有可替换原文 sid=${sid}`);
    return false;
  }
  if (typeof session?.append !== 'function') {
    log(`apply skip: session.append 不是函数 sid=${sid}`);
    return false;
  }
  const fromSeq = startSeq ?? replaced[0].seq;
  const toSeq = endSeq ?? replaced.at(-1).seq;
  const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : [];
  // 按位置取区间，不按 seq 值过滤：早先替换块的 seq 比它所在位置大，会夹在
  // 后续区间中间。值过滤会把它漏掉，而宿主按位置判断 shadowedSeqs，报 missing。
  const startIdx = nodes.indexOf(fromSeq);
  let endIdx = nodes.indexOf(toSeq);
  if (startIdx < 0 || endIdx < startIdx) {
    log(`apply skip: 区间不在表面 start=${fromSeq}(${startIdx}) end=${toSeq}(${endIdx}) nodes=${nodes.length}`);
    return false;
  }
  // 遮蔽区间不能切在 assistant 消息和它的 tool/call 之间：消息被换掉、
  // tool/call 还留在表面上，后端会收到没有对应调用的 tool 结果
  // （DeepSeek: Messages tool result has no matching call）。
  for (;;) {
    const nextSeq = nodes[endIdx + 1];
    const nextEvent = nextSeq == null ? undefined : session.eventAt?.(nextSeq);
    if (!nextEvent || nextEvent.type !== 'tool/call') break;
    endIdx -= 1;
    if (endIdx < startIdx) {
      log(`apply skip: tool/call 回退越过起点 start=${fromSeq} end=${toSeq}`);
      return false;
    }
  }
  const lastSeq = nodes[endIdx];
  const seqs = nodes.slice(startIdx, endIdx + 1);
  if (seqs.length === 0) {
    log(`apply skip: 区间为空 start=${fromSeq} end=${toSeq}`);
    return false;
  }
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
      { surfaceOp: { op: 'replace', startSeq: fromSeq, endSeq: lastSeq }, sourceEventSeqs: seqs },
    );
    return true;
  } catch (error) {
    log(`apply failed: ${error?.message ?? error} sid=${sid} start=${fromSeq} end=${lastSeq}`);
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
    // append 模式用：只算出「如果替换会怎样」，不记账、不写 surface。
    dryRun = false,
  } = {},
) {
  const sid = sidOf(session);
  // 白名单外不记账：这些会话不会真替换，账本只会随宿主压缩反复增行。
  // 「只看会怎么换」的推演也放进白名单会话里做，别让它变成噪音。
  // 先判白名单再遍历：白名单外的会话占绝大多数，之前每次都要把整段
  // surface 走一遍才发现不记账。
  const mode = replaceMode(sid);
  // dryRun 是「如果开了会怎样」的推演：白名单关着也要能算。否则面板上的
  // 预览按钮永远只会回「没有可替换的历史」，那句话的意思是「你这会话没开
  // 替换」而不是「历史太短」。
  if (mode === 'off' && !dryRun) return null;
  // append 只推演：选区按 full 算（要测的就是「全换之后够不够」），
  // 记账与 apply 全部跳过——pre-step 只拿 text 拼到上下文末尾。
  // dryRun 同样按 full 算：预览要看的就是「全换之后是什么样」。
  const selectMode = mode === 'append' || mode === 'off' ? 'full' : mode;
  // full 每轮全量 SELECT 该 sid 的 turns（shadow-v2.js 里最贵的一次查询），
  // 行数越多越慢。超过 FULL_MAX_ROWS 就降级到 roll：成本从 O(n) 回到 O(1)。
  let fullRows = 0;
  if (selectMode === 'full') {
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM turns WHERE sid = ? AND origin = 'chat'")
      .get(sid);
    fullRows = Number(count?.n) || 0;
    if (fullRows > FULL_MAX_ROWS && !degraded.has(sid)) {
      degraded.add(sid);
      log(`full degraded: rows=${fullRows} > ${FULL_MAX_ROWS} sid=${sid}`);
    }
  }
  const entries = surfaceMessages(session);
  let replaced;
  let kept;
  let rangeStart = null;
  let rangeEnd = null;
  let covered = null;
  if (selectMode === 'full' && fullRows <= FULL_MAX_ROWS) {
    // 完全替换：不等条数/字数门槛，当前轮之外全换。
    // 保留区按「轮」算，不按条数：从最后一条 user 起，到末尾全部留原文。
    // 旧的 FULL_KEEP_TAIL=2 在多步回复里会把当前 user 换进区间——最后两条
    // 常常是两条 assistant，模型就看不到你刚说的话了。
    let keepFrom = lastUserIndex(entries);
    // 一条 user 都没有（比如刚加载）：退回按条数保留。
    if (keepFrom < 0) keepFrom = Math.max(0, entries.length - FULL_KEEP_TAIL);
    if (keepFrom <= 0) {
      if (dryRun) log(`preview: full keepFrom=${keepFrom} entries=${entries.length} mode=${mode}`);
      return null;
    }
    const keepSeqs = new Set(entries.slice(keepFrom).map((entry) => entry.seq));
    // 区间必须从 surface 第一个节点算起，而不是第一条「没被换过的消息」。
    // 旧替换块在 surface 上是一条 user/message；区间不包住它，每轮都会在
    // 它后面再插一块，块数随轮数线性涨，窗口永远不收窄。
    // 节点 0 是 system prompt：宿主只允许 system/message 恰好覆写它，
    // 区间从节点 1 起算，不能把它包进来。
    const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes.slice(1) : [];
    const cutIndex = nodes.findIndex((seq) => keepSeqs.has(seq));
    if (cutIndex <= 0) {
      if (dryRun) log(`preview: full cutIndex=${cutIndex} nodes=${nodes.length} keep=${keepSeqs.size} entries=${entries.length}`);
      return null;
    }
    covered = nodes.slice(0, cutIndex);
    rangeStart = covered[0];
    rangeEnd = covered.at(-1);
    // 热路径：每个 assistant 事件都会重新算计划，但窗口多半没动。区间没变
    // 就直接返回，不查 turns 全表（full 分支最贵的一次查询）。
    if (!dryRun && sameRangeApplied(db, sid, rangeStart, rangeEnd)) return null;
    // 替换块盖住的原文已经离开 surface，只有 turns 还留着。区间覆盖的是
    // surface 上除保留区外的全部节点，所以原文 = turns 里除保留区 seq 外的
    // 全部 chat 行——不能按 seq < rangeEnd 取：surface 节点顺序和 seq 并不
    // 单调，用 rangeEnd 会漏掉排在其前面的节点。
    const originalRows = db
      .prepare("SELECT seq, role, text FROM turns WHERE sid = ? AND origin = 'chat' ORDER BY seq")
      .all(sid);
    const originals = originalRows.filter((row) => !keepSeqs.has(row.seq));
    replaced = originals.length > 0 ? originals : entries.slice(0, keepFrom);
    kept = entries.slice(keepFrom);
  } else if (roll) {
    if (entries.length <= MIN_ENTRIES) {
      if (dryRun) log(`preview: roll entries=${entries.length} mode=${mode} fullRows=${fullRows}`);
      return null;
    }
    // 滚动模式：只动最早 STEP 条。保留区按「轮」算而不是按条数——
    // 旧逻辑固定留最近 6 条，7 步以上的超长工具轮会把当前提问换进区间。
    let keepFrom = lastUserIndex(entries);
    if (keepFrom < 0) keepFrom = Math.max(0, entries.length - ROLL_KEEP_TAIL);
    if (keepFrom <= 0) {
      if (dryRun) log(`preview: roll keepFrom=${keepFrom} entries=${entries.length} mode=${mode} fullRows=${fullRows}`);
      return null;
    }
    const totalChars = entries.reduce((total, entry) => total + entry.text.length, 0);
    const early = entries.slice(0, keepFrom);
    const overCount = early.length > ROLL_STEP;
    if (!overCount && totalChars <= ROLL_SOFT_BUDGET) return null;
    replaced = early.slice(0, ROLL_STEP);
    kept = [...early.slice(ROLL_STEP), ...entries.slice(keepFrom)];
  } else {
    // 旧逻辑兜底：按比例保留，一次换掉更早的一段。
    const keepCount = resolveKeep(entries.length, keep);
    const split = splitKeep(entries, keepCount);
    const cap = Math.max(1, Math.floor(Number(window) || DEFAULT_WINDOW));
    replaced = split.replaced.slice(-cap);
    kept = split.kept;
  }
  if (replaced.length === 0) {
    if (dryRun) log(`preview: empty replaced mode=${mode} fullRows=${fullRows} entries=${entries.length}`);
    return null;
  }
  const cwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : '';
  rangeStart = rangeStart ?? replaced[0].seq;
  rangeEnd = rangeEnd ?? replaced.at(-1).seq;
  // 同一区间不重复记账：每轮都会重算，但被换的窗口没动就没新信息。
  // 上一次 apply 失败（applied=0）时允许重试，否则一次微任务失败会让
  // 这段永远停在原文。full 分支在上面已经判过，这里主要挡 roll/兜底。
  if (!dryRun && sameRangeApplied(db, sid, rangeStart, rangeEnd)) return null;
  const text = renderReplacement(replaced, {
    note: toolNote(session, covered ?? nodesBetween(session, rangeStart, rangeEnd)),
  });
  const charsBefore = replaced.reduce((total, entry) => total + entry.text.length, 0);
  const assessment = assessReplacement({ replaced, kept, text, charsBefore });
  // 冷却：刚换过就先不换，也不记账——窗口没动，再记一行没有新信息。
  // 只看不换的会话没有 applied=1 的行，永远不走这条分支。
  const recent = db
    .prepare('SELECT t FROM shadow_v2 WHERE sid = ? AND applied = 1 ORDER BY id DESC LIMIT 1')
    .get(sid);
  // full 模式不设冷却：要的就是每轮都把可换的旧历史换掉。
  const cooldown = selectMode === 'full' ? 0 : roll ? ROLL_COOLDOWN_MS : REPLACE_COOLDOWN_MS;
  if (!dryRun && recent && cooldown > 0 && now - recent.t < cooldown) return null;
  const row = {
    sid,
    turn: 0,
    t: now,
    rangeStart,
    rangeEnd,
    seqs: JSON.stringify(covered ?? replaced.map((entry) => entry.seq)),
    text,
    charsBefore,
    charsAfter: text.length,
    kept: kept.length,
    lostRatio: assessment.lostRatio,
    tokenKeep: assessment.tokenKeep,
    dangling: assessment.dangling.length,
    applied: false,
    cwd,
  };
  // 推演不记账、不写 surface：pre-step 只拿 text 拼到上下文末尾。
  if (dryRun) return { ...row, missing: assessment.missing, danglingList: assessment.dangling };
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
      if (applyReplacement(session, replaced, text, sid, { startSeq: rangeStart, endSeq: rangeEnd })) {
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
