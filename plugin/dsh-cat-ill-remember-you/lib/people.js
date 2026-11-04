/**
 * 人物卡：按名字查。
 *
 * 人物是「按名字查得到」的那类知识，跟 memories 的语义检索分开——
 * 语义检索会把「嘎啦吗」和「GPT」混在一起（2026-11-04 就混过一次）。
 * 这里只做精确包含匹配：文本里出现了名字或别名，就把那张卡整张给出来。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} text 当前这一句（或它加上最近的上下文）
 * @returns {string} 命中的卡片，多张用换行分隔；没命中返回 ''
 */
export function renderPeople(db, text) {
  const body = String(text ?? '');
  if (!body) return '';
  let rows;
  try {
    rows = db
      .prepare('SELECT name, aliases, who, relation, style, seen FROM people ORDER BY id')
      .all();
  } catch {
    return '';
  }
  const cards = [];
  for (const row of rows) {
    const names = [row.name, ...aliasesOf(row.aliases)];
    if (!names.some((name) => name && body.includes(name))) continue;
    cards.push(formatCard(row));
  }
  return cards.join('\n');
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function aliasesOf(raw) {
  try {
    const list = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(list) ? list.filter((item) => typeof item === 'string' && item) : [];
  } catch {
    return [];
  }
}

/**
 * @param {{name: string, who: string, relation: string, style: string, seen: number}} row
 * @returns {string}
 */
function formatCard(row) {
  const parts = [`【${row.name}】`];
  if (row.who) parts.push(row.who);
  if (row.relation) parts.push(`关系：${row.relation}`);
  if (row.style) parts.push(row.style);
  if (!Number(row.seen)) parts.push('（没直接接触过，别替它编）');
  return parts.join('｜');
}
