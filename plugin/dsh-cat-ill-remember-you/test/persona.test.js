import assert from 'node:assert/strict';
import test from 'node:test';

import { openStore } from '../lib/db.js';
import { renderPersona, PERSONA_MARK } from '../lib/persona.js';

function seed(db, rows) {
  const insert = db.prepare(
    'INSERT INTO persona (target, content, importance, source, t) VALUES (?, ?, ?, ?, ?)',
  );
  for (const [target, content, importance, t] of rows) {
    insert.run(target, content, importance, 'test', t);
  }
}

test('renderPersona: 按 target 分区，critical 排前面', () => {
  const db = openStore(':memory:');
  seed(db, [
    ['user', '普通偏好', 'normal', 200],
    ['user', '必须遵守的约定', 'critical', 100],
    ['memory', '一条环境事实', 'normal', 300],
  ]);
  const text = renderPersona(db);
  assert.ok(text.startsWith(PERSONA_MARK), text);
  assert.ok(text.includes('【用户】'));
  assert.ok(text.includes('【记忆】'));
  assert.ok(text.indexOf('必须遵守的约定') < text.indexOf('普通偏好'));
  assert.ok(text.includes('一条环境事实'));
  db.close();
});

test('renderPersona: 超出容量只保留排在前面的条目', () => {
  const db = openStore(':memory:');
  seed(db, [
    ['user', '第一条'.padEnd(60, '甲'), 'critical', 200],
    ['user', '第二条'.padEnd(60, '乙'), 'normal', 100],
  ]);
  const text = renderPersona(db, { userMax: 80, memoryMax: 0 });
  assert.ok(text.includes('第一条'));
  assert.ok(!text.includes('第二条'), text);
  db.close();
});

test('renderPersona: 空表返回空串', () => {
  const db = openStore(':memory:');
  assert.equal(renderPersona(db), '');
  db.close();
});
