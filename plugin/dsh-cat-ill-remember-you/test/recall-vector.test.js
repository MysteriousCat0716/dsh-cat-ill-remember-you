import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { openStore } from '../lib/db.js';
import { retrieve } from '../lib/recall.js';

// 一个只回固定向量的假 Ollama。endpointReady 是 TCP 探测，能连上就算在。
function fakeOllama(vector) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ embeddings: [vector] }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('retrieve: 锚点命中一条后，向量仍能补一条没有共享词的旧事', async () => {
  const db = openStore(':memory:');
  // A：锚点命中，走 L2。
  db.prepare(
    `INSERT INTO memories (kind, text, summary, anchors, why, t)
     VALUES ('decision', 'lib/recall.js 先读再改', '先读再改', '["lib/recall.js"]', 'x', 1000)`,
  ).run();
  // B：没有锚点也没有实体，只有向量能找得到。
  const info = db
    .prepare(
      `INSERT INTO memories (kind, text, summary, why, t)
       VALUES ('decision', '换缓存之前先量一下命中率', '量完再换', 'y', 900)`,
    )
    .run();
  const id = Number(info.lastInsertRowid);

  const { server, port } = await fakeOllama([1, 0, 0]);
  const previous = process.env.DSH_MEMORY_CORE_OLLAMA;
  try {
    process.env.DSH_MEMORY_CORE_OLLAMA = `http://127.0.0.1:${port}`;
    db.prepare(
      `INSERT INTO embeddings (memory_id, model, dim, vec, t)
       VALUES (?, 'qwen3-embedding:0.6b', 3, ?, 900)`,
    ).run(id, Buffer.from(new Float32Array([1, 0, 0]).buffer));

    const hits = await retrieve(db, {
      text: 'lib/recall.js 这个文件现在怎么改',
      recent: [],
      now: 2000,
    });

    assert.ok(
      hits.some((hit) => hit.section === 'vector'),
      `锚点命中后向量层被跳过：${JSON.stringify(hits.map((hit) => hit.section))}`,
    );
    const vectorHit = hits.find((hit) => hit.section === 'vector');
    assert.equal(vectorHit.id, id);
  } finally {
    if (previous === undefined) delete process.env.DSH_MEMORY_CORE_OLLAMA;
    else process.env.DSH_MEMORY_CORE_OLLAMA = previous;
    server.close();
    db.close();
  }
});
