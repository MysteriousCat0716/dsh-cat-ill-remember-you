#!/usr/bin/env node
// 离线回放 v3：候选老消息只计一次（每条消息只被替换一次），扫更大的保留窗口矩阵。
// 断链 = 被换消息的 token 在之后 5 条 user 的指代句里再次出现。
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

const DB = process.env.DSH_MEMORY_CORE_DB || path.join(os.homedir(), '.dsh/memory/core.db');
const db = new DatabaseSync(DB, { readOnly: true });
const rows = db.prepare("select id,sid,role,text,t from turns where origin='chat' order by sid, t, id").all();
const bySid = new Map();
for (const r of rows) {
  if (!bySid.has(r.sid)) bySid.set(r.sid, []);
  bySid.get(r.sid).push(r);
}
const mems = db.prepare("select id,anchors,entities from memories where tier='active'").all().map((m) => ({
  id: m.id, anchors: JSON.parse(m.anchors || '[]'), entities: JSON.parse(m.entities || '[]'),
}));
const REFERRAL = /(那个|这个|它|上面|刚才|之前|那条|那件|那次|说的|提到的|刚说|上一)/;
const K = 5;
const KEEPS = [4, 6, 8, 10, 12, 15, 20];
const KEYS = ['anchors', 'entities', 'both'];
const tokensOf = (m, key) => key === 'anchors' ? m.anchors : key === 'entities' ? m.entities : [...m.anchors, ...m.entities];

console.log(`回放库: ${DB}  会话 ${bySid.size}, turns ${rows.length}, memories ${mems.length}\n`);
for (const key of KEYS) {
  for (const KEEP of KEEPS) {
    let replaced = 0, savedChars = 0, dangling = 0;
    for (const msgs of bySid.values()) {
      const done = new Set(); // 已替换的消息 id，只计一次
      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i].role !== 'user') continue;
        const query = msgs[i].text || '';
        if (!query) continue;
        const hits = mems.filter((m) => tokensOf(m, key).some((t) => t && query.includes(t)));
        if (!hits.length) continue;
        const pool = msgs.slice(0, Math.max(0, i - KEEP)).filter((m) => !done.has(m.id));
        const futureUser = msgs.slice(i + 1, i + 1 + K).filter((m) => m.role === 'user').map((m) => m.text || '');
        const all = new Set(hits.flatMap((m) => tokensOf(m, key)));
        for (const m of pool) {
          const text = m.text || '';
          const matched = [...all].filter((t) => t && text.includes(t));
          if (!matched.length) continue;
          done.add(m.id);
          replaced++;
          savedChars += text.length;
          if (futureUser.some((u) => REFERRAL.test(u) && matched.some((t) => u.includes(t)))) dangling++;
        }
      }
    }
    const rate = replaced ? ((dangling / replaced) * 100).toFixed(1) : '0.0';
    console.log(`${key.padEnd(8)} 保留${String(KEEP).padStart(2)} 条  可换 ${String(replaced).padStart(4)} 条  省 ${String(savedChars).padStart(7)} 字  断链 ${String(dangling).padStart(3)} (${rate.padStart(5)}%)`);
  }
}
db.close();
