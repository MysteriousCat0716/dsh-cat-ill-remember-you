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
  try {
    if (!existsSync(file)) return [];
    if (statSync(file).size > MAX_ORIGINAL_FILE_BYTES) return [];
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
  } catch {
    return [];
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
  return messagesFromEvents(readSessionEvents(file));
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
  } catch {
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
    const events = readSessionEvents(item.file);
    if (events.length === 0) continue;
    // 子代理的会话也是文件，但那是任务现场，不是「上一个会话」。
    const origin = events[0]?.origin;
    if (typeof origin === 'string' && origin !== 'session') continue;
    const messages = messagesFromEvents(events);
    if (messages.length === 0) continue;
    return { sid: item.sid, mtime: item.mtime, messages: messages.slice(-Math.max(1, limit)) };
  }
  return null;
}
