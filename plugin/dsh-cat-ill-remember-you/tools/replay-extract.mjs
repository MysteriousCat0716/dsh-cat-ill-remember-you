#!/usr/bin/env node
/**
 * 回放集：从 turns 里挑「表态句」，按指定规则版本跑一遍「插不插」的决策，输出 JSON。
 * 用途：改提炼规则前后各跑一次，比「会插多少条 / 拦下多少条」。
 *
 * 两个版本模拟的是 refineBlock 的两个决策层：
 *   r0 —— 旧行为：块里只要有第一条 assistant 就炼，不看 kind（JUDGE 命中即插）。
 *         所以 block 只含 user + 块内第一条 assistant。
 *   r1 —— 现行为：等这一轮全部落库，块含 user + 块内所有行；candidate 的 kind
 *         不是 decision/preference 的一律不插（skipped-kind）。
 *         静默窗本身不影响离线回放——它只决定「什么时候炼」，不决定「炼出来的块多大」。
 *
 * 用法：
 *   node tools/replay-extract.mjs --rules r0 --limit 30 --out ~/.dsh/replay-r0.json
 *   node tools/replay-extract.mjs --rules r1 --limit 30 --out ~/.dsh/replay-r1.json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { candidateOf, JUDGE } from '../lib/extract.js';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const RULES = argOf('--rules', 'r1');
if (RULES !== 'r0' && RULES !== 'r1') {
  console.error('--rules 只认 r0 / r1');
  process.exit(2);
}
const DB = argOf('--db', path.join(os.homedir(), '.dsh', 'memory', 'core.db'));
const LIMIT = Number(argOf('--limit', '30'));
const OUT = path.resolve(
  argOf('--out', path.join(os.homedir(), '.dsh', `replay-${RULES}-${Date.now()}.json`)),
);

const db = new DatabaseSync(DB, { readOnly: true });
const users = db
  .prepare(
    `SELECT id, sid, seq, role, text, t FROM turns
     WHERE role = 'user' AND origin = 'chat' AND length(text) >= 6
     ORDER BY id DESC LIMIT ?`,
  )
  .all(LIMIT * 6);

const picked = [];
for (const user of users) {
  if (picked.length >= LIMIT) break;
  if (!JUDGE.test(user.text)) continue;

  // 块边界照 refineBlock 来：从这条 user 起，到下一条 user 之前。
  const next = db
    .prepare(`SELECT seq FROM turns WHERE sid = ? AND seq > ? AND role = 'user' ORDER BY seq LIMIT 1`)
    .get(user.sid, user.seq);
  const rest = db
    .prepare(
      `SELECT id, sid, seq, role, text, t FROM turns
       WHERE sid = ? AND seq > ? ${next ? 'AND seq < ?' : ''} ORDER BY seq`,
    )
    .all(...(next ? [user.sid, user.seq, next.seq] : [user.sid, user.seq]));

  // r0 在块内第一条 assistant 落库时就炼；r1 等整轮落库。
  const blockTurns = RULES === 'r0'
    ? [user, ...rest.slice(0, 1)]
    : [user, ...rest];
  const candidate = blockTurns.length >= 2 ? candidateOf({ turns: blockTurns }) : null;

  let decision;
  if (!candidate) decision = blockTurns.length < 2 ? 'incomplete' : 'no-candidate';
  else if (RULES === 'r1' && candidate.kind !== 'decision' && candidate.kind !== 'preference') decision = 'skipped-kind';
  else decision = 'insert';

  picked.push({
    sid: user.sid,
    userSeq: user.seq,
    userText: user.text,
    blockAssistants: rest.filter((r) => r.role === 'assistant').length,
    decision,
    candidate: candidate
      ? {
          kind: candidate.kind,
          summary: candidate.summary,
          confidence: candidate.confidence,
          anchors: candidate.anchors,
          entities: candidate.entities,
        }
      : null,
  });
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ at: Date.now(), db: DB, rules: RULES, picked }, null, 2));
const tally = picked.reduce((m, p) => ({ ...m, [p.decision]: (m[p.decision] || 0) + 1 }), {});
console.log(`rules=${RULES}  samples=${picked.length}  ${JSON.stringify(tally)}`);
console.log(`wrote -> ${OUT}`);
