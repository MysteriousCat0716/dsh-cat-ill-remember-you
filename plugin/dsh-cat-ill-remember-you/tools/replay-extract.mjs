#!/usr/bin/env node
/**
 * 回放集：从 turns 里挑「表态句」，按当前规则跑一遍 candidateOf，输出 JSON。
 * 用途：改提炼规则前后各跑一次，比「留对率 / 污染率」。
 *
 * 用法：
 *   node tools/replay-extract.mjs --limit 20 --out ~/.dsh/replay-YYYYMMDD.json
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

const DB = argOf('--db', path.join(os.homedir(), '.dsh', 'memory', 'core.db'));
const LIMIT = Number(argOf('--limit', '20'));
const OUT = path.resolve(
  argOf('--out', path.join(os.homedir(), '.dsh', `replay-${Date.now()}.json`)),
);

const db = new DatabaseSync(DB, { readOnly: true });
const users = db
  .prepare(
    `SELECT id, sid, seq, role, text, t FROM turns
     WHERE role = 'user' AND origin = 'chat' AND length(text) >= 6
     ORDER BY id DESC LIMIT ?`,
  )
  .all(LIMIT * 4);

const picked = [];
for (const user of users) {
  if (picked.length >= LIMIT) break;
  if (!JUDGE.test(user.text)) continue;
  const assistants = db
    .prepare(
      `SELECT id, sid, seq, role, text, t FROM turns
       WHERE sid = ? AND seq > ? AND role = 'assistant'
       ORDER BY seq LIMIT 2`,
    )
    .all(user.sid, user.seq);
  const block = { turns: [user, ...assistants] };
  const candidate = candidateOf(block);
  picked.push({
    sid: user.sid,
    userSeq: user.seq,
    userText: user.text,
    assistantCount: assistants.length,
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
fs.writeFileSync(OUT, JSON.stringify({ at: Date.now(), db: DB, picked }, null, 2));
console.log(`wrote ${picked.length} samples -> ${OUT}`);
