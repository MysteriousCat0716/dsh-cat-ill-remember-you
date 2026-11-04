#!/usr/bin/env node
/**
 * 只读的本地记忆查看器：搜 turns / 看账。
 *
 * 为什么不是 dsh 里的页面：客户端插件要重启 dsh 才生效，而这个工具
 * 是为了「现在就能看」。它只读打开同一个 core.db，不写库、不改配置，
 * 也不提供任何写接口。
 *
 *   node tools/studio.mjs
 *   node tools/studio.mjs --port 3200
 *   DSH_MEMORY_CORE_DB=/path/to/core.db node tools/studio.mjs
 *
 * 界面只有两张页：搜（turns 原文）和账（取回、替换、栈、记忆库四本）。
 */
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_FILE =
  process.env.DSH_MEMORY_CORE_DB || path.join(os.homedir(), '.dsh', 'memory', 'core.db');
const PORT = Number(argValue('--port') ?? process.env.DSH_MEMORY_CORE_STUDIO_PORT ?? 3139);
const HOST = '127.0.0.1';

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function openReadonly() {
  if (!fs.existsSync(DB_FILE)) throw new Error(`找不到记忆库：${DB_FILE}`);
  return new DatabaseSync(DB_FILE, { readOnly: true });
}

function clock(t) {
  const date = new Date(Number(t) || 0);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function json(res, value, status = 200) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function searchTurns(db, q, limit) {
  const needle = `%${String(q ?? '').trim()}%`;
  const rows = db
    .prepare(
      `SELECT sid, seq, role, origin, cwd, text, t
       FROM turns
       WHERE text LIKE ? ESCAPE '\\'
       ORDER BY t DESC, seq DESC
       LIMIT ?`,
    )
    .all(needle, limit);
  return rows.map((row) => ({ ...row, time: clock(row.t) }));
}

function account(db, limit) {
  const recall = db
    .prepare(
      `SELECT l.id, l.sid, l.turn, l.t, l.memory_id, l.why, l.used, m.text, m.kind
       FROM recall_log l
       LEFT JOIN memories m ON m.id = l.memory_id
       WHERE l.section = 'recall'
       ORDER BY l.id DESC
       LIMIT ?`,
    )
    .all(limit)
    .map((row) => ({ ...row, time: clock(row.t) }));

  const shadow = db
    .prepare(
      `SELECT id, sid, range_start, range_end, applied, chars_before, chars_after,
              lost_ratio, token_keep, t
       FROM shadow_v2
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(limit)
    .map((row) => ({ ...row, time: clock(row.t) }));

  const stack = db
    .prepare('SELECT evicted, count(*) AS c FROM context_stack GROUP BY evicted')
    .all();

  const memories = db
    .prepare('SELECT kind, tier, count(*) AS c FROM memories GROUP BY kind, tier ORDER BY c DESC')
    .all();

  const used = db
    .prepare(
      `SELECT
         sum(CASE WHEN used = 1 THEN 1 ELSE 0 END) AS used,
         sum(CASE WHEN used IS NULL AND memory_id IS NOT NULL THEN 1 ELSE 0 END) AS pending,
         count(*) AS total
       FROM recall_log
       WHERE section = 'recall'`,
    )
    .get();

  return {
    recall,
    shadow,
    stack,
    memories,
    usedRate: {
      used: Number(used?.used ?? 0),
      pending: Number(used?.pending ?? 0),
      total: Number(used?.total ?? 0),
    },
  };
}

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>记忆库 · 看</title>
<style>
  :root { color-scheme: dark; --bg:#12141a; --panel:#1a1d26; --line:#2a2f3d; --text:#e8eaf0; --dim:#8b93a7; --accent:#7aa2f7; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.6 "Segoe UI","Microsoft YaHei",sans-serif; }
  header { position:sticky; top:0; background:rgba(18,20,26,.92); backdrop-filter:blur(8px); border-bottom:1px solid var(--line); padding:12px 16px; display:flex; gap:10px; align-items:center; flex-wrap:wrap; z-index:2; }
  h1 { font-size:15px; margin:0 12px 0 0; font-weight:600; }
  button { background:var(--panel); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:6px 12px; cursor:pointer; }
  button.on { border-color:var(--accent); color:var(--accent); }
  input { background:var(--panel); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:7px 10px; min-width:260px; flex:1; max-width:520px; }
  main { padding:16px; max-width:1000px; margin:0 auto; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px 14px; margin-bottom:12px; }
  .meta { color:var(--dim); font-size:12px; margin-bottom:6px; display:flex; gap:10px; flex-wrap:wrap; }
  .text { white-space:pre-wrap; word-break:break-word; }
  .role { padding:0 6px; border-radius:4px; font-size:11px; border:1px solid var(--line); }
  .role.user { color:#9ece6a; } .role.assistant { color:#7aa2f7; }
  .stats { display:flex; gap:16px; flex-wrap:wrap; }
  .stat { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px 14px; min-width:130px; }
  .stat b { display:block; font-size:20px; }
  .stat span { color:var(--dim); font-size:12px; }
  .empty { color:var(--dim); padding:24px; text-align:center; }
  .hidden { display:none; }
</style>
</head>
<body>
<header>
  <h1>记忆库 · 看</h1>
  <button id="tab-search" class="on">搜 turns</button>
  <button id="tab-account">看账</button>
  <input id="q" placeholder="输一句话、一个文件名、一个 seq…" autocomplete="off">
  <span id="hint" style="color:var(--dim);font-size:12px"></span>
</header>
<main>
  <section id="page-search">
    <div class="stats" id="search-stats" style="margin-bottom:12px"></div>
    <div id="search-list"></div>
  </section>
  <section id="page-account" class="hidden">
    <div class="stats" id="acc-stats" style="margin-bottom:12px"></div>
    <div id="acc-recall"></div>
    <div id="acc-shadow"></div>
    <div id="acc-memories"></div>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
let tab = 'search';
let timer = null;

function esc(value) {
  return String(value ?? '').replace(/[&<>"]/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[ch]));
}

function show(name) {
  tab = name;
  $('page-search').classList.toggle('hidden', name !== 'search');
  $('page-account').classList.toggle('hidden', name !== 'account');
  $('tab-search').classList.toggle('on', name === 'search');
  $('tab-account').classList.toggle('on', name === 'account');
  if (name === 'account') loadAccount();
}

async function search() {
  const q = $('q').value.trim();
  if (!q) { $('search-list').innerHTML = '<div class="empty">写点什么再搜。</div>'; $('search-stats').innerHTML = ''; return; }
  const response = await fetch('/api/search?q=' + encodeURIComponent(q) + '&limit=60');
  const rows = await response.json();
  $('search-stats').innerHTML = '<div class="stat"><b>' + rows.length + '</b><span>命中</span></div>';
  $('search-list').innerHTML = rows.length === 0
    ? '<div class="empty">没有命中。</div>'
    : rows.map((row) => \`
      <div class="card">
        <div class="meta">
          <span class="role \${esc(row.role)}">\${esc(row.role)}</span>
          <span>\${esc(row.time)}</span>
          <span>\${esc(row.sid)} · seq \${esc(row.seq)}</span>
          <span>\${esc(row.origin)}</span>
        </div>
        <div class="text">\${esc(row.text)}</div>
      </div>\`).join('');
}

async function loadAccount() {
  const data = await (await fetch('/api/account?limit=60')).json();
  const rate = data.usedRate;
  $('acc-stats').innerHTML = \`
    <div class="stat"><b>\${rate.total}</b><span>取回记录</span></div>
    <div class="stat"><b>\${rate.used}</b><span>被用到</span></div>
    <div class="stat"><b>\${rate.pending}</b><span>还没判</span></div>
    <div class="stat"><b>\${data.shadow.length}</b><span>替换（最近）</span></div>\`;

  $('acc-recall').innerHTML = '<h3 style="font-size:14px;margin:12px 0 8px">取回账</h3>' + (data.recall.length === 0
    ? '<div class="empty">还没有取回记录。</div>'
    : data.recall.map((row) => \`
      <div class="card">
        <div class="meta">
          <span>\${esc(row.time)}</span>
          <span>\${esc(row.sid)} · 第 \${esc(row.turn)} 轮</span>
          <span>memory \${esc(row.memory_id ?? '—')}</span>
          <span>\${row.used === 1 ? '用到了' : '未判'}</span>
        </div>
        <div class="meta">\${esc(row.why)}</div>
        <div class="text">\${esc(row.text ?? '')}</div>
      </div>\`).join(''));

  $('acc-shadow').innerHTML = '<h3 style="font-size:14px;margin:12px 0 8px">替换账</h3>' + (data.shadow.length === 0
    ? '<div class="empty">还没有替换记录。</div>'
    : data.shadow.map((row) => \`
      <div class="card">
        <div class="meta">
          <span>\${esc(row.time)}</span>
          <span>\${esc(row.sid)}</span>
          <span>seq \${esc(row.range_start)}–\${esc(row.range_end)}</span>
          <span>\${row.applied ? '已应用' : '预览'}</span>
          <span>\${esc(row.chars_before)}→\${esc(row.chars_after)} 字</span>
          <span>token 保留 \${(Number(row.token_keep ?? 0) * 100).toFixed(0)}%</span>
        </div>
      </div>\`).join(''));

  const stack = data.stack.map((row) => \`\${row.evicted ? '已出栈' : '在栈'} \${row.c}\`).join(' · ');
  $('acc-memories').innerHTML = '<h3 style="font-size:14px;margin:12px 0 8px">栈与记忆库</h3>'
    + '<div class="card"><div class="meta">' + esc(stack || '栈是空的') + '</div></div>'
    + '<div class="card">' + data.memories.map((row) => \`\${esc(row.kind)}/\${esc(row.tier)} \${row.c}\`).join(' · ') + '</div>';
}

$('tab-search').onclick = () => show('search');
$('tab-account').onclick = () => show('account');
$('q').addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(search, 220);
});
show('search');
search();
</script>
</body>
</html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAGE);
      return;
    }
    if (url.pathname === '/api/search') {
      const db = openReadonly();
      try {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 60) || 60));
        json(res, searchTurns(db, url.searchParams.get('q') ?? '', limit));
      } finally {
        db.close();
      }
      return;
    }
    if (url.pathname === '/api/account') {
      const db = openReadonly();
      try {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 60) || 60));
        json(res, account(db, limit));
      } finally {
        db.close();
      }
      return;
    }
    json(res, { error: 'not found' }, 404);
  } catch (error) {
    json(res, { error: String(error?.message ?? error) }, 500);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`记忆库看板：http://${HOST}:${PORT}`);
  console.log(`库文件：${DB_FILE}（只读）`);
});
