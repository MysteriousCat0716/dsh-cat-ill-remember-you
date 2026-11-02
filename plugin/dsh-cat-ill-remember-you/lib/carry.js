/**
 * M5 · 跨会话接续
 *
 * 新会话第一轮，把「同 workspace 的上一个会话最后那条缓存」接进来。
 * 数据源只有 shadow_v2 里真替换过（applied=1）的行：那是模型实际读过的
 * 接续缓存，不是我事后猜的压缩文本。
 *
 * 三条边界：
 *   1. 只认同 cwd；cwd 为空的历史行不参与，宁可接不上也不串项目。
 *   2. 不取当前会话自己的缓存。
 *   3. 一个会话只注入一次：messages 里已经有标记就跳过（跨重启也成立，
 *      因为标记就在会话历史里）。
 */

export const LAST_SESSION_MARK = '[上次会话结尾]';
export const LAST_SESSION_MAX_CHARS = 800;

/** @param {string} text @param {number} maxChars */
export function clipText(text, maxChars = LAST_SESSION_MAX_CHARS) {
  const s = String(text ?? '').trim();
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(1, maxChars - 1))}…`;
}

function stamp(t) {
  const d = new Date(Number(t));
  if (!Number.isFinite(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 同一个 workspace 里，除当前会话外最近一条真替换缓存。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{cwd?:string, sid?:string, maxChars?:number}} options
 * @returns {{sid:string, t:number, text:string}|null}
 */
export function lastSessionCache(db, { cwd, sid, maxChars = LAST_SESSION_MAX_CHARS } = {}) {
  if (!db || typeof cwd !== 'string' || cwd.trim() === '') return null;
  let row;
  try {
    row = db
      .prepare(
        `SELECT sid, t, text FROM shadow_v2
         WHERE applied = 1 AND cwd = ? AND sid != ? AND length(text) > 0
         ORDER BY t DESC, id DESC LIMIT 1`,
      )
      .get(cwd, String(sid ?? ''));
  } catch {
    // 老库还没有 cwd 列时不要打断会话；升级失败就当接不上。
    return null;
  }
  if (!row || typeof row.text !== 'string' || row.text.trim() === '') return null;
  return { sid: String(row.sid), t: Number(row.t) || 0, text: clipText(row.text, maxChars) };
}

/**
 * 渲染注入文本。写明「不是这个会话」，否则读到时会把两段对话当成同一段。
 * @param {{sid:string, t:number, text:string}} row
 */
export function renderCarry(row) {
  const when = stamp(row?.t);
  const head =
    `${LAST_SESSION_MARK} 另一个会话的最后缓存` +
    (when ? `（${when}）` : '') +
    '，不是当前这段对话。细节在本地文件里，要查用 read / 取回。';
  return `${head}\n${row?.text ?? ''}`;
}

/** 这条会话历史里是否已经注入过接续缓存。 */
export function hasCarry(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => {
    const content = message?.content;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((block) => block?.text ?? '').join('\n')
          : '';
    return text.trimStart().startsWith(LAST_SESSION_MARK);
  });
}

/**
 * 会话里是否已经有过 assistant 回复。
 *
 * 这是「是不是新会话」的判据，不用 pre-step 的 turn：turn 是**进程内**轮次
 * （dsh-agent-loop/lib/index.js:943 `const turn = phase.turn + 1`），旧会话
 * 恢复后第一轮也是 1，拿它当判据会把「上个会话结尾」塞进一个聊了很久的会话。
 * 新会话第一轮不可能有 assistant 历史，这个判据跨重启也成立。
 */
export function hasAssistantTurn(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => message?.role === 'assistant');
}

/**
 * 接线用的纯函数：该不该注入、注入什么。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{cwd?:string, sid?:string, messages?:Array, maxChars?:number}} options
 * @returns {string|null}
 */
export function planCarry(db, { cwd, sid, messages, maxChars = LAST_SESSION_MAX_CHARS } = {}) {
  if (hasCarry(messages)) return null;
  if (hasAssistantTurn(messages)) return null;
  const row = lastSessionCache(db, { cwd, sid, maxChars });
  return row ? renderCarry(row) : null;
}
