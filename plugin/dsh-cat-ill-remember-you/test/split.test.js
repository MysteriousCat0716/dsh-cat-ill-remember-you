import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splitMessage, isStandalone, mergeFragments, matchableSegments } from '../lib/split.js';

test('splitMessage: empty input yields no segments', () => {
  assert.deepEqual(splitMessage(''), []);
  assert.deepEqual(splitMessage('   '), []);
});

test('splitMessage: blank lines split paragraphs', () => {
  const segments = splitMessage('这个问题的原因是缓存太大。\n\n处理办法是换掉缓存层。');
  assert.equal(segments.length, 2);
  assert.equal(segments[0], '这个问题的原因是缓存太大。');
  assert.equal(segments[1], '处理办法是换掉缓存层。');
});

test('splitMessage: sentence ends split inside a paragraph', () => {
  const segments = splitMessage('我决定把缓存层换掉，因为它太大。然后重新跑一遍测试。');
  assert.equal(segments.length, 2);
  assert.equal(segments[0], '我决定把缓存层换掉，因为它太大。');
  assert.equal(segments[1], '然后重新跑一遍测试。');
});

test('splitMessage: leading fragment joins the next segment', () => {
  const segments = splitMessage('嗯。这个锚点是 产出/插件/foo.js');
  assert.equal(segments.length, 1);
  assert.equal(segments[0], '嗯。 这个锚点是 产出/插件/foo.js');
});

test('isStandalone: short plain text does not stand alone', () => {
  assert.equal(isStandalone('嗯'), false);
  assert.equal(isStandalone('就按那个'), false);
});

test('isStandalone: path or known entity stands alone', () => {
  assert.equal(isStandalone('产出/插件/foo.js'), true);
  assert.equal(isStandalone('猫'), true);
});

test('mergeFragments: middle fragment joins the previous segment', () => {
  const merged = mergeFragments(['这个锚点是 产出/插件/foo.js', '嗯', '然后就好了']);
  assert.deepEqual(merged, ['这个锚点是 产出/插件/foo.js 嗯 然后就好了']);
});

test('matchableSegments: carries anchors per segment', () => {
  const segments = matchableSegments('先看 产出/插件/foo.js。再看 记忆核心/插件/dsh-cat-ill-remember-you/README.md。');
  assert.equal(segments.length, 2);
  assert.ok(segments[0].anchors.includes('产出/插件/foo.js'));
  assert.ok(segments[1].anchors.includes('记忆核心/插件/dsh-cat-ill-remember-you/README.md'));
});
