/**
 * M2 · 消息拆分
 *
 * 一条消息按空行、换行、句末标点切成段，每段尽量能独立说清一个信息点。
 * 太短、依赖上文的段（「嗯」「就按那个」「爱你」）并回相邻段，
 * 不单独参与匹配——这是「拆到哪」的判据：拆出来自己说不清补了什么的，
 * 就不该单独成段。
 */

import { anchorsOf, entitiesOf } from './extract.js';

const SOFT_BREAK = /\n{2,}/;
const SENTENCE = /(?<=[。！？!?；;])\s*/;
const MIN_STANDALONE = 10;

/**
 * Split one message into segments.
 * @param {string} text
 * @returns {string[]}
 */
export function splitMessage(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];

  const segments = [];
  for (const block of raw.split(SOFT_BREAK)) {
    for (const part of block.split(SENTENCE)) {
      const piece = part.replace(/\s+/g, ' ').trim();
      if (piece) segments.push(piece);
    }
  }
  return mergeFragments(segments);
}

/** A segment can stand alone when it is long enough or carries a name/path. */
export function isStandalone(segment) {
  const text = String(segment ?? '').trim();
  if (text.length >= MIN_STANDALONE) return true;
  return anchorsOf(text).length > 0 || entitiesOf(text).length > 0;
}

/**
 * Merge fragments into their neighbour: a leading fragament joins the next
 * segment; a middle or trailing fragment joins the previous one.
 * Nothing is dropped.
 * @param {string[]} segments
 */
export function mergeFragments(segments) {
  const out = [];
  let pending = '';
  for (const segment of segments) {
    if (!isStandalone(segment)) {
      if (out.length === 0) pending += (pending ? ' ' : '') + segment;
      else out[out.length - 1] += ` ${segment}`;
      continue;
    }
    out.push(pending ? `${pending} ${segment}` : segment);
    pending = '';
  }
  if (pending) {
    if (out.length === 0) out.push(pending);
    else out[out.length - 1] += ` ${pending}`;
  }
  return out;
}

/**
 * Segments of one message that carry their own anchors/entities.
 * @param {string} text
 */
export function matchableSegments(text) {
  return splitMessage(text).map((segment) => ({
    text: segment,
    anchors: anchorsOf(segment),
    entities: entitiesOf(segment),
  }));
}
