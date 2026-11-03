/**
 * Embedding index layer.
 *
 * Stores one float32 vector per memory in the `embeddings` table so a later
 * version can add similarity as a *candidate* signal. Retrieval still goes
 * through the anchor/entity gate: a vector never becomes the only reason to
 * recall a memory.
 *
 * The layer is optional by design — Ollama may be closed, the model may be
 * missing, or the machine may be offline. Every failure is thrown to the
 * caller, which logs and moves on; nothing here may block the pre-step path.
 */

import net from 'node:net';

export const DEFAULT_MODEL = 'qwen3-embedding:0.6b';
export const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';
export const DEFAULT_BATCH = 16;
export const DEFAULT_TIMEOUT_MS = 30_000;

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function toBlob(vector) {
  const floats = new Float32Array(vector);
  return new Uint8Array(floats.buffer);
}

/**
 * Embed up to `limit` memories that have no vector for `model` yet.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{model?:string, endpoint?:string, limit?:number, timeoutMs?:number, now?:number}} [options]
 * @returns {Promise<{embedded:number, model:string, dim?:number}>}
 */
export async function embedPending(db, options = {}) {
  const model =
    options.model || process.env.DSH_MEMORY_CORE_EMBED_MODEL || DEFAULT_MODEL;
  const endpoint = (
    options.endpoint ||
    process.env.DSH_MEMORY_CORE_OLLAMA ||
    DEFAULT_ENDPOINT
  ).replace(/\/+$/, '');
  const limit = positive(options.limit ?? process.env.DSH_MEMORY_CORE_EMBED_BATCH, DEFAULT_BATCH);
  const timeoutMs = positive(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const now = Number.isFinite(options.now) ? options.now : Date.now();

  const rows = db
    .prepare(
      `SELECT m.id, m.summary, m.text FROM memories m
       LEFT JOIN embeddings e ON e.memory_id = m.id AND e.model = ?
       WHERE e.id IS NULL AND m.tier = 'active'
       ORDER BY m.t DESC LIMIT ?`,
    )
    .all(model, limit);
  if (rows.length === 0) return { embedded: 0, model };

  const response = await fetch(`${endpoint}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      input: rows.map((row) => row.summary || row.text),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`ollama /api/embed ${response.status} ${response.statusText}`);
  }
  const payload = await response.json();
  const vectors = Array.isArray(payload?.embeddings) ? payload.embeddings : null;
  if (!vectors || vectors.length !== rows.length) {
    throw new Error(
      `ollama /api/embed returned ${vectors ? vectors.length : 'no'} vectors for ${rows.length} inputs`,
    );
  }

  // Validate every vector before opening the transaction: a half-written batch
  // would need a manual cleanup, and the next sweep would skip those rows.
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error('ollama /api/embed returned an empty vector');
    }
  }
  const dim = vectors[0].length;
  if (vectors.some((vector) => vector.length !== dim)) {
    throw new Error('ollama /api/embed returned vectors of different dimensions');
  }

  const insert = db.prepare(
    `INSERT OR REPLACE INTO embeddings (memory_id, model, dim, vec, t)
     VALUES (?, ?, ?, ?, ?)`,
  );
  db.exec('BEGIN');
  try {
    for (let i = 0; i < rows.length; i += 1) {
      insert.run(rows[i].id, model, dim, toBlob(vectors[i]), now);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { embedded: rows.length, model, dim };
}

/** How many active memories still have no vector for `model`. */
export function pendingEmbeddings(db, model = DEFAULT_MODEL) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM memories m
       LEFT JOIN embeddings e ON e.memory_id = m.id AND e.model = ?
       WHERE e.id IS NULL AND m.tier = 'active'`,
    )
    .get(model);
  return Number(row?.n ?? 0);
}

/**
 * One vector for a free-text query. Throws on any failure — the caller is
 * expected to catch and fall back to lexical recall; an embedding outage may
 * never break the pre-step path.
 * @param {string} text
 * @param {{model?:string, endpoint?:string, timeoutMs?:number}} [options]
 * @returns {Promise<number[]>}
 */
export async function embedText(text, options = {}) {
  const model =
    options.model || process.env.DSH_MEMORY_CORE_EMBED_MODEL || DEFAULT_MODEL;
  const endpoint = (
    options.endpoint ||
    process.env.DSH_MEMORY_CORE_OLLAMA ||
    DEFAULT_ENDPOINT
  ).replace(/\/+$/, '');
  // A cold Ollama has to load the model before the first vector; 4s covers
  // that once, and keep_alive below keeps it from happening every turn.
  const timeoutMs = positive(options.timeoutMs, 4000);
  const response = await fetch(`${endpoint}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      input: [String(text ?? '')],
      keep_alive: options.keepAlive || '30m',
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`ollama /api/embed ${response.status} ${response.statusText}`);
  }
  const payload = await response.json();
  const vector = Array.isArray(payload?.embeddings) ? payload.embeddings[0] : null;
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('ollama /api/embed returned no vector');
  }
  return vector;
}

/**
 * Fast TCP probe. A closed Ollama must cost the turn ~300ms at most, not a
 * full HTTP timeout on every single message.
 * @param {string} [endpoint]
 * @param {number} [timeoutMs]
 */
export function endpointReady(endpoint = DEFAULT_ENDPOINT, timeoutMs = 300) {
  const url = new URL(endpoint.replace(/\/+$/, '') || DEFAULT_ENDPOINT);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  return new Promise((resolve) => {
    const socket = net.connect({ host: url.hostname, port });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** Cosine similarity; both vectors must have the same dimension. */
export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function readVector(blob) {
  const bytes = new Uint8Array(blob);
  const aligned = bytes.slice().buffer;
  return new Float32Array(aligned);
}

/**
 * Nearest stored memories to one query vector, best first.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number[]} vector
 * @param {{model?:string, limit?:number}} [options]
 */
export function nearestByVector(db, vector, options = {}) {
  const model = options.model || DEFAULT_MODEL;
  const limit = positive(options.limit, 3);
  const rows = db
    .prepare('SELECT memory_id, vec FROM embeddings WHERE model = ?')
    .all(model);
  const scored = [];
  for (const row of rows) {
    const other = readVector(row.vec);
    if (other.length !== vector.length) continue;
    scored.push({ memory_id: row.memory_id, score: cosine(vector, other) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Fire-and-forget: load the embedding model now, so the first recall of the
 * session does not pay the cold-start cost on the turn path.
 * @param {{model?:string, endpoint?:string, timeoutMs?:number}} [options]
 */
export async function warmVector(options = {}) {
  try {
    await embedText('预热', { ...options, timeoutMs: options.timeoutMs ?? 8000 });
    return true;
  } catch {
    return false;
  }
}
