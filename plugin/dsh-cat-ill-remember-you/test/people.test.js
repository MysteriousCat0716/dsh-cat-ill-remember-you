import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '../lib/db.js';
import { renderPeople } from '../lib/people.js';

function seed(db) {
  const insert = db.prepare(
    'INSERT INTO people (name, aliases, who, relation, style, seen, source, t) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const t = Date.now();
  insert.run('嘎啦吗', '["GLM"]', '智谱的 GLM 模型', '外部助手', '猫说它拟人化', 0, 'm01281', t);
  insert.run('猫', '[]', '广西民族大学学生', '造我的人', '要直接输出', 1, '多轮', t);
  return db;
}

test('renderPeople: 提到名字就把整张卡给出来', () => {
  const db = seed(openStore(':memory:'));
  const text = renderPeople(db, '嘎啦吗帮我审一下这个改动');
  assert.match(text, /【嘎啦吗】/);
  assert.match(text, /智谱的 GLM 模型/);
  assert.match(text, /外部助手/);
  assert.match(text, /没直接接触过/);
  db.close();
});

test('renderPeople: 别名也能命中', () => {
  const db = seed(openStore(':memory:'));
  const text = renderPeople(db, 'GLM 说这样不行');
  assert.match(text, /【嘎啦吗】/);
  db.close();
});

test('renderPeople: 见过的人不加「没直接接触过」', () => {
  const db = seed(openStore(':memory:'));
  const text = renderPeople(db, '猫 今天累不累');
  assert.match(text, /【猫】/);
  assert.ok(!text.includes('没直接接触过'));
  db.close();
});

test('renderPeople: 没提到人就不给卡', () => {
  const db = seed(openStore(':memory:'));
  assert.equal(renderPeople(db, '把测试跑一遍'), '');
  assert.equal(renderPeople(db, ''), '');
  db.close();
});
