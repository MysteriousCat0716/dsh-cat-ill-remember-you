import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { openStore } from '../lib/db.js';
import { cosine, embedPending, endpointReady, nearestByVector, pendingEmbeddings } from '../lib/embed.js';

function fakeOllama(vectors) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        const embeddings = parsed.input.map((_, index) => vectors[index % vectors.length]);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ embeddings }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('embed: writes one float32 vector per memory and skips embedded rows', async () => {
  const db = openStore(':memory:');
  db.prepare(`INSERT INTO memories (kind, text, summary, t) VALUES ('fact', 'a', '甲', 1000)`).run();
  db.prepare(`INSERT INTO memories (kind, text, summary, t) VALUES ('fact', 'b', '乙', 2000)`).run();
  const { server, port } = await fakeOllama([[1, 2, 3]]);
  try {
    const first = await embedPending(db, { endpoint: `http://127.0.0.1:${port}`, limit: 10 });
    assert.equal(first.embedded, 2);
    assert.equal(first.dim, 3);
    const rows = db
      .prepare('SELECT memory_id, model, dim, vec FROM embeddings ORDER BY memory_id')
      .all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].dim, 3);
    const buf = Buffer.from(rows[0].vec);
    const vec = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    assert.deepEqual(Array.from(vec), [1, 2, 3]);
    assert.equal(pendingEmbeddings(db), 0);
    const second = await embedPending(db, { endpoint: `http://127.0.0.1:${port}`, limit: 10 });
    assert.equal(second.embedded, 0);
  } finally {
    server.close();
    db.close();
  }
});

test('embed: an unreachable endpoint throws instead of writing', async () => {
  const db = openStore(':memory:');
  db.prepare(`INSERT INTO memories (kind, text, summary, t) VALUES ('fact', 'a', '甲', 1000)`).run();
  await assert.rejects(() => embedPending(db, { endpoint: 'http://127.0.0.1:1', limit: 5 }));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM embeddings').get().n, 0);
  db.close();
});

test('embed: a response with the wrong number of vectors writes nothing', async () => {
  const db = openStore(':memory:');
  db.prepare(`INSERT INTO memories (kind, text, summary, t) VALUES ('fact', 'a', '甲', 1000)`).run();
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ embeddings: [] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await assert.rejects(() => embedPending(db, { endpoint: `http://127.0.0.1:${port}`, limit: 5 }));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM embeddings').get().n, 0);
  } finally {
    server.close();
    db.close();
  }
});

test('cosine: 同向为 1，正交为 0', () => {
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9);
  assert.equal(cosine([1, 0], [0, 1]), 0);
});

test('nearestByVector: 按余弦排序，取最相近的', () => {
  const db = openStore(':memory:');
  const memory = db.prepare(
    `INSERT INTO memories (id, kind, text, summary, entities, anchors, why, tier, t)
     VALUES (?, 'fact', ?, ?, '[]', '[]', '规则提炼：fact', 'active', 1000)`,
  );
  memory.run(1, '部署脚本在哪', '部署脚本位置');
  memory.run(2, '火锅底料', '火锅底料');
  const insert = db.prepare(
    'INSERT INTO embeddings (memory_id, model, dim, vec, t) VALUES (?, ?, ?, ?, ?)',
  );
  const toBlob = (values) => new Uint8Array(new Float32Array(values).buffer);
  insert.run(1, 'qwen3-embedding:0.6b', 3, toBlob([1, 0, 0]), 1000);
  insert.run(2, 'qwen3-embedding:0.6b', 3, toBlob([0, 1, 0]), 1000);

  const nearest = nearestByVector(db, [0.9, 0.1, 0], { limit: 1 });
  assert.equal(nearest.length, 1);
  assert.equal(nearest[0].memory_id, 1);
  assert.ok(nearest[0].score > 0.9);
  db.close();
});

test('endpointReady: 没开的端口很快返回 false', async () => {
  assert.equal(await endpointReady('http://127.0.0.1:1', 200), false);
});
