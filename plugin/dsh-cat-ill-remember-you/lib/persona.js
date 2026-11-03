/**
 * 常驻层：每轮都要在场的一小块。
 *
 * 与栈、召回不同，这里的条目不是「这一轮碰巧相关」，而是「关掉之后我
 * 就不再认识他」的那部分：他是谁、说好过什么、哪些判断已经定下。
 *
 * 容量按 target 分开，默认 user 4096 / memory 8192 字，可用环境变量覆盖。
 * 排序：importance（critical 优先）→ 最近更新优先；超出容量就截断。
 */
export const PERSONA_MARK = '[常驻｜插件]';

const DEFAULT_USER_MAX = 4096;
const DEFAULT_MEMORY_MAX = 8192;

const IMPORTANCE_RANK = { critical: 0, normal: 1, low: 2 };

/** 截断到 maxChars，尽量落在句号/逗号边界。 */
function clip(text, maxChars) {
  const value = String(text ?? '').trim();
  if (value.length <= maxChars) return value;
  const cut = value.slice(0, maxChars);
  const boundary = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('，'));
  return `${boundary > maxChars * 0.6 ? cut.slice(0, boundary + 1) : cut}…`;
}

function maxFor(target) {
  const env =
    target === 'user'
      ? process.env.DSH_MEMORY_CORE_PERSONA_USER
      : process.env.DSH_MEMORY_CORE_PERSONA_MEMORY;
  const fallback = target === 'user' ? DEFAULT_USER_MAX : DEFAULT_MEMORY_MAX;
  const value = Number(env);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ userMax?: number, memoryMax?: number }} [options]
 * @returns {string} 空字符串表示没有可注入的常驻内容
 */
export function renderPersona(db, { userMax, memoryMax } = {}) {
  const rows = db
    .prepare(
      `SELECT target, content, importance, t
         FROM persona
        ORDER BY target, t DESC`,
    )
    .all();
  if (rows.length === 0) return '';

  const grouped = { user: [], memory: [] };
  for (const row of rows) {
    const target = row.target === 'memory' ? 'memory' : 'user';
    grouped[target].push(row);
  }
  for (const list of Object.values(grouped)) {
    list.sort(
      (a, b) =>
        (IMPORTANCE_RANK[a.importance] ?? 1) - (IMPORTANCE_RANK[b.importance] ?? 1) ||
        (b.t ?? 0) - (a.t ?? 0),
    );
  }

  const limits = {
    user: Number.isFinite(userMax) ? userMax : maxFor('user'),
    memory: Number.isFinite(memoryMax) ? memoryMax : maxFor('memory'),
  };

  const parts = [];
  for (const target of ['user', 'memory']) {
    const list = grouped[target];
    if (list.length === 0) continue;
    const title = target === 'user' ? '【用户】' : '【记忆】';
    let block = title;
    let used = 0;
    for (const row of list) {
      const line = `\n- ${clip(row.content, 400)}`;
      if (used + line.length > limits[target]) break;
      block += line;
      used += line.length;
    }
    if (used > 0) parts.push(block);
  }
  if (parts.length === 0) return '';
  return `${PERSONA_MARK} 长期有效，不必每轮重问\n${parts.join('\n')}`;
}
