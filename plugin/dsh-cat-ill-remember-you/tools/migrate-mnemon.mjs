#!/usr/bin/env node
/**
 * 一次性迁移：mnemon 的 an / default 两个空间 → 插件 core.db。
 *
 * 只做「搬运 + 去重」：insertMemory 里已有的 sameTopic 合并与改口链照常生效，
 * 所以重复条目不会被插第二遍。默认 dry-run（事务里跑完回滚），确认条数后再落库。
 *
 * 用法：
 *   node tools/migrate-mnemon.mjs --dry     # 预览：inserted / merged 统计，不改库
 *   node tools/migrate-mnemon.mjs           # 真写
 */
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/db.js';
import { insertMemory, anchorsOf, entitiesOf, retentionOf } from '../lib/extract.js';

const DRY = process.argv.includes('--dry');
const MNEMON_ROOT = join(homedir(), '.mnemon', 'data');

function summaryOf(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  const cut = s.search(/[。！？!?]/);
  const first = cut >= 0 ? s.slice(0, cut + 1) : s;
  return first.length > 80 ? `${first.slice(0, 80)}…` : first;
}

function timeOf(value) {
  if (Number.isFinite(value)) return Number(value);
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

const rows = [];
for (const space of ['an', 'default']) {
  const src = new DatabaseSync(join(MNEMON_ROOT, space, 'mnemon.db'), { readOnly: true });
  const list = src
    .prepare('SELECT id, content, category, importance, entities, stored_at FROM insights WHERE deleted_at IS NULL')
    .all();
  for (const row of list) rows.push({ space, ...row });
  src.close();
}

const db = openStore();
if (DRY) db.exec('BEGIN');
const stats = { total: rows.length, inserted: 0, merged: 0, skipped: 0, chars: 0 };
try {
  for (const row of rows) {
    const text = String(row.content ?? '').trim();
    if (!text) {
      stats.skipped += 1;
      continue;
    }
    const kind = row.category === 'context' ? 'fact' : (row.category ?? 'general');
    let entities;
    try {
      entities = JSON.parse(row.entities ?? '[]');
    } catch {
      entities = entitiesOf(text);
    }
    const item = {
      kind,
      text,
      summary: summaryOf(text),
      entities: Array.isArray(entities) ? entities : entitiesOf(text),
      anchors: anchorsOf(text),
      why: '',
      tier: 'active',
      retention: retentionOf(kind),
      t: timeOf(row.stored_at),
      source_sid: `mnemon:${row.space}:${String(row.id).slice(0, 8)}`,
      source_seq: 0,
      confidence: 'explicit',
      origin: 'mnemon',
    };
    const result = insertMemory(db, item);
    if (result.inserted) {
      stats.inserted += 1;
      stats.chars += text.length;
    } else {
      stats.merged += 1;
    }
  }
  if (DRY) db.exec('ROLLBACK');
} catch (error) {
  if (DRY) db.exec('ROLLBACK');
  throw error;
}
db.close();
console.log(JSON.stringify({ ...stats, dry: DRY }, null, 2));
