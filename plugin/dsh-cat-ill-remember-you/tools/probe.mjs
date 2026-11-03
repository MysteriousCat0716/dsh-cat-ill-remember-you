#!/usr/bin/env node
/**
 * 召回探针：10 个固定问题，看 retrieve 前几条给的是不是该给的那条。
 *
 * 这是给人看的回归集，不是单元测试——答案会随库里内容变，判定也没法自动。
 * 用法：
 *   node tools/probe.mjs                 # 默认库
 *   DSH_MEMORY_CORE_DB=/path node tools/probe.mjs
 *   node tools/probe.mjs "破甲是什么"     # 只问一句
 */
import { openStore } from '../lib/db.js';
import { retrieve } from '../lib/recall.js';

const dbPath = process.env.DSH_MEMORY_CORE_DB || 'C:/Users/Administrator/.dsh/memory/core.db';
const cwd = process.env.DSH_MEMORY_CORE_CWD
  || 'C:/Users/Administrator/Documents/deepseek-harness/default-workspace';

const QUESTIONS = [
  '费曼这人哪里好',
  '岸的生日是哪天',
  '写代码之前先干什么',
  '压缩要怎么做',
  '工具原文怎么取回',
  '栈的窗口怎么分',
  '破甲是什么',
  '在外面要注意什么',
  '你之前说过不要主动压缩，是哪条',
  '学物理是为了什么',
];

const questions = process.argv.slice(2).filter((v) => !v.startsWith('--'));
const db = openStore(dbPath);

for (const q of questions.length > 0 ? questions : QUESTIONS) {
  const hits = await retrieve(db, { text: q, cwd, referralText: q, now: Date.now() });
  console.log('\nQ:', q);
  for (const h of hits) {
    const sec = h.section ?? 'persona';
    const score = (Number(h.score) || 0).toFixed(2);
    const body = String(h.summary ?? '').replace(/\s+/g, ' ').slice(0, 46);
    console.log('  ', sec.padEnd(8), String(h.id).padStart(4), score, '|', body);
  }
}
db.close();
