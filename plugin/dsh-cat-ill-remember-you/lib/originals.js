import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

/**
 * 原文的家：dsh 自己把每条会话事件按 append-only 写在
 * `~/.dsh/sessions/<workspace 目录>/<sid>/session.v4.jsonl.zstd`。
 * 替换（surfaceOp.replace）只是运行时的表面操作，被盖掉的原文仍然在这个
 * 文件里，所以「浓缩只读原文」不需要另存一份。
 */

export const DEFAULT_SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions');

/** 单个文件超过这个大小就不解压了：同步解压会卡住 dsh 的事件循环。 */
export const MAX_ORIGINAL_FILE_BYTES = 30 * 1024 * 1024;

/**
 * 读不到原文时不再静默：carry.js 会把插件日志函数转进来。
 * 不存在的文件属于正常情况（没有别的会话），只有解压/读取失败才记。
 */
let warn = () => {};
export function setOriginalsLogger(fn) {
  warn = typeof fn === 'function' ? fn : () => {};
}

/**
 * 工作区目录名：cwd 里所有非字母数字压成一个 `-`，首尾各补 `--`。
 * 例：`C:\Users\...\default-workspace` → `--C-Users-...-default-workspace--`。
 */
export function workspaceDirName(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return '';
  return `--${cwd.replace(/[^A-Za-z0-9]+/g, '-')}--`;
}

export function sessionLogFile({ sid, cwd, sessionsRoot = DEFAULT_SESSIONS_ROOT }) {
  if (typeof sid !== 'string' || sid.length === 0) return '';
  const dir = workspaceDirName(cwd);
  if (dir === '') return '';
  return join(sessionsRoot, dir, sid, 'session.v4.jsonl.zstd');
}

/**
 * 读会话文件里的全部事件。文件不存在、解压失败、超过大小上限都返回 []，
 * 调用方按「读不到原文」处理，不要因此中断替换流程。
 */
export function readSessionEvents(file) {
  if (typeof file !== 'string' || file.length === 0) return [];
  // 「没有这个文件」和「文件在但读不动」是两回事：前者正常跳过，
  // 后者要抛出去让调用方显式降级，而不是当成空会话。
  if (!existsSync(file)) return [];
  const size = statSync(file).size;
  if (size > MAX_ORIGINAL_FILE_BYTES) {
    warn(`originals: skip ${file} (${size} bytes > ${MAX_ORIGINAL_FILE_BYTES})`);
    return [];
  }
  try {
    const text = zstdDecompressSync(readFileSync(file)).toString('utf8');
    const events = [];
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // 一行坏了不影响其余事件
      }
    }
    return events;
  } catch (error) {
    warn(`originals: read ${file} failed: ${error?.message ?? error}`);
    throw error;
  }
}

/** 从 user/message / assistant/message 事件里取纯文本；取不到返回 ''。 */
export function textOfEvent(event) {
  if (!event || typeof event !== 'object') return '';
  const data = event.data;
  const message = data && typeof data === 'object' && data.message ? data.message : data;
  const content = message && Array.isArray(message.content) ? message.content : [];
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

const REF_ID = /refId=(ref:\/\/[^;\s\]]+)/;
const REF_TOOL = /producerTool=([^;\s\]]+)/;

/**
 * 大结果在会话日志里只是一行指针，不是原文。指针本身有用：
 * refId 交给宿主的 ops_result 就能解引用，producerTool 说明是谁产生的。
 * 插件自己读不到宿主的引用存储，所以这里只负责把 refId 捞出来。
 */
export function refPointerOf(text) {
  const value = String(text ?? '');
  const id = value.match(REF_ID);
  if (id === null) return null;
  const tool = value.match(REF_TOOL);
  return { refId: id[1], producerTool: tool ? tool[1] : null };
}

/**
 * spill 路径：工具结果超过 token 阈值时，DSH 把全文写到
 * `%TEMP%/dsh-spill-XXXXXX/session-<hash>/<rand>-<tool>`，正文只留预览和一行
 * `Full formatted result stored at: <path>. Use read with offset/limit, ...`。
 * 这是插件侧唯一能拿到的「全文」，比 refId 有用——refId 指向进程内存，重启就空。
 */
const SPILL_PATH = /Full formatted result stored at: (.+?)\. (?:Use read|$)/;

export function spillPathOf(text) {
  const value = String(text ?? '');
  const match = value.match(SPILL_PATH);
  return match ? match[1].trim() : '';
}

/** 读 spill 文件；不存在、超上限、读失败都返回空串，让调用方退回正文预览。 */
function readSpillText(path) {
  if (typeof path !== 'string' || path.length === 0) return '';
  try {
    if (!existsSync(path)) return '';
    const size = statSync(path).size;
    if (size > MAX_ORIGINAL_FILE_BYTES) return '';
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** tool/call 里 callId → 工具名，用来给 tool/result 补上名字。 */
function toolNames(events) {
  const names = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'tool/call') continue;
    const calls = event.data?.calls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (call && call.callId && call.name) names.set(String(call.callId), String(call.name));
    }
  }
  return names;
}

/**
 * 工具结果原文，按 seq 升序。小结果 text 就是原文；大结果 text 是指针，
 * `ref` 非空表示原文不在日志里，要拿 refId 去宿主侧解引用。
 * 名字从 tool/call 按 callId 配对——tool/result 自己不带工具名。
 */
export function toolResultsFromEvents(events) {
  const names = toolNames(events);
  const out = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'tool/result') continue;
    const message = event.data?.message;
    const content = Array.isArray(message?.content) ? message.content : [];
    const preview = content
      .map((block) => (block && typeof block.text === 'string' ? block.text : ''))
      .join('\n');
    if (preview.length === 0) continue;
    // spill 的全文在磁盘上；读得到就用全文，读不到保留正文预览。
    const spill = spillPathOf(preview);
    const text = readSpillText(spill) || preview;
    const callId = message?.source?.callId ?? event.data?.callId ?? '';
    out.push({
      seq: event.seq,
      name: names.get(String(callId)) ?? String(event.data?.name ?? ''),
      text,
      ref: refPointerOf(preview),
      spill,
    });
  }
  return out;
}

/** 当前会话的工具结果；读不到按空数组处理，不影响替换流程。 */
export function toolOriginals(session, sessionsRoot = DEFAULT_SESSIONS_ROOT) {
  const file = sessionLogFile({
    sid: typeof session?.id === 'string' ? session.id : '',
    cwd: typeof session?.header?.cwd === 'string' ? session.header.cwd : '',
    sessionsRoot,
  });
  try {
    return toolResultsFromEvents(readSessionEvents(file));
  } catch (error) {
    warn(`originals: toolOriginals ${file} failed: ${error?.message ?? error}`);
    return [];
  }
}

/**
 * 会话里的「人说的话」原文，按 seq 升序。
 * 只收 source.kind === 'user' 的 user 消息（把 runtime-context、memory-core、
 * agent-instructions 这些注入挡在外面）和 assistant 消息；tool 结果不算对话。
 */
export function messagesFromEvents(events) {
  const out = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'user/message' && event?.type !== 'assistant/message') continue;
    const message = event.data && event.data.message ? event.data.message : event.data;
    if (!message || typeof message !== 'object') continue;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    if (message.role === 'user' && message.source?.kind !== 'user') continue;
    const text = textOfEvent(event);
    if (text.length === 0) continue;
    out.push({ seq: event.seq, role: message.role, text });
  }
  return out;
}

export function originalMessages(session, sessionsRoot = DEFAULT_SESSIONS_ROOT) {
  const file = sessionLogFile({
    sid: typeof session?.id === 'string' ? session.id : '',
    cwd: typeof session?.header?.cwd === 'string' ? session.header.cwd : '',
    sessionsRoot,
  });
  try {
    return messagesFromEvents(readSessionEvents(file));
  } catch (error) {
    // 当前会话自己的原文读不动时按「没有」处理，不影响替换流程；
    // 但要留日志，否则「读不到」和「没有对话」在流水里分不开。
    warn(`originals: originalMessages ${file} failed: ${error?.message ?? error}`);
    return [];
  }
}

/**
 * 同一 workspace 里最近活跃的另一个会话的最后几条原文。
 * 用文件 mtime 找最近的几个，再按「有原文」过滤——刚开就关的空会话会被跳过。
 * 找不到返回 null；调用方退回 shadow_v2 里的摘要缓存。
 *
 * @param {{cwd?:string, excludeSid?:string, sessionsRoot?:string, limit?:number, maxFiles?:number}} [options]
 * @returns {{sid:string, mtime:number, messages:Array<{seq:number,role:string,text:string}>}|null}
 */
export function recentSessionOriginals({
  cwd,
  excludeSid,
  sessionsRoot = DEFAULT_SESSIONS_ROOT,
  limit = 6,
  maxFiles = 3,
} = {}) {
  const dir = workspaceDirName(cwd);
  if (dir === '') return null;
  const root = join(sessionsRoot, dir);
  let dirents;
  try {
    dirents = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    warn(`originals: list ${root} failed: ${error?.message ?? error}`);
    return null;
  }
  const files = [];
  for (const entry of dirents) {
    if (!entry.isDirectory()) continue;
    if (typeof excludeSid === 'string' && entry.name === excludeSid) continue;
    const file = join(root, entry.name, 'session.v4.jsonl.zstd');
    try {
      files.push({ sid: entry.name, file, mtime: statSync(file).mtimeMs });
    } catch {
      // 没有会话文件的目录跳过
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  for (const item of files.slice(0, Math.max(1, maxFiles))) {
    let events;
    try {
      events = readSessionEvents(item.file);
    } catch (error) {
      // 这个文件读不动，换下一个；全都不行时返回 null，由调用方决定退路。
      warn(`originals: skip ${item.file}: ${error?.message ?? error}`);
      continue;
    }
    if (events.length === 0) continue;
    // 子代理的会话也是文件，但那是任务现场，不是「上一个会话」。
    // 判据只用 origin === 'subagent'：宿主源码里这才是「作为子代理创建」
    // （dsh-session/lib/types/index.js:950-959）。`session-` 前缀不是判据——
    // store mint session-<counter>、Web/fork 用 session-<uuid>、子代理可用裸
    // uuid；fork 只设 parentSession、不设 origin，它是用户自己的分支，应该能接。
    const header = events[0] ?? {};
    if (header.origin === 'subagent') continue;
    const messages = messagesFromEvents(events);
    if (messages.length === 0) continue;
    return { sid: item.sid, mtime: item.mtime, messages: messages.slice(-Math.max(1, limit)) };
  }
  return null;
}
