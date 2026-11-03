import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openStore, pendingCount } from './db.js';
import { refine } from './extract.js';
import { ingestEvent, textOf } from './ingest.js';
import { retrieve, renderHint } from './recall.js';
import { shadowPlan, recordShadow } from './shadow.js';
import { planShadowV2 } from './shadow-v2.js';
import { planCarry, setCarryLogger } from './carry.js';
import { renderStack } from './context-stack.js';
import { setOriginalsLogger } from './originals.js';
import { backfillTurnCwd } from './backfill.js';
import { forgetSweep } from './forget.js';
import { embedPending } from './embed.js';

export const name = 'dsh-cat-ill-remember-you';

export const inject = ['sessions'];

/** Last human input of the turn; skips runtime-context and plugin notices. */
function lastUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'user') continue;
    const kind = message.source?.kind;
    if (typeof kind === 'string' && kind !== 'user') continue;
    const text = textOf(message);
    if (text) return text;
  }
  return '';
}

/** Recent turns already in context, used to avoid fetching what is covered. */
function recentTexts(messages, limit = 6) {
  const out = [];
  if (!Array.isArray(messages)) return out;
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const message = messages[i];
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    const kind = message.source?.kind;
    if (typeof kind === 'string' && kind !== 'user') continue;
    const text = textOf(message);
    if (text) out.push(text);
  }
  return out;
}

const LOG_FILE = path.join(os.homedir(), '.dsh', 'cache', 'ill-remember-you.log');

function log(line) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* logging must never break the plugin */
  }
}

/**
 * M0: append-only raw turns.
 * Every hook is contained: a broken store must never take the host down.
 */
export function apply(ctx) {
  // 接续模块自己吞错误，但失败原因要能进日志——不然「没有别的会话」
  // 和「库读不出来」在日志里长得一样。
  setCarryLogger(log);
  // 原文读取的 warn 默认是空函数；不接上，跳过大文件/解压失败在生产里全是静默的。
  setOriginalsLogger(log);
  let store;
  // pre-step 算出的记忆块文本，按会话存；provider 在 assemble/refreshContext 时取。
  const hintBySid = new Map();
  // Set by the effect cleanup. An in-flight pre-step may still be awaiting
  // next() when the host disposes this scope; without this flag currentStore()
  // would happily reopen the db and write after unload.
  let disposed = false;
  let timer = null;
  let lastActivity = Date.now();
  // Number('abc') / Number('') would silently become NaN / 0 and turn the
  // interval into a 1ms spin; keep a finite, positive floor.
  const envMs = (name, fallback) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const idleMs = envMs('DSH_MEMORY_CORE_IDLE_MS', 5 * 60 * 1000);
  const tickMs = envMs('DSH_MEMORY_CORE_TICK_MS', 60 * 1000);
  const file = process.env.DSH_MEMORY_CORE_DB || undefined;

  /** Reopen if the host disposed the store under us; null when the db is unusable. */
  function currentStore() {
    if (disposed) return null;
    if (store) {
      try {
        store.prepare('SELECT 1').get();
        return store;
      } catch {
        try {
          store.close();
        } catch {
          /* already closed */
        }
        store = undefined;
      }
    }
    try {
      store = openStore(file);
      log(`store open: ${store.file ?? file ?? 'default'}`);
      // 旧库的 turns 没有 cwd：按会话文件头补一次，补不上的保持空、不参与接续。
      try {
        const filled = backfillTurnCwd(store);
        if (filled > 0) log(`turn cwd backfill: ${filled} rows`);
      } catch (error) {
        log(`turn cwd backfill failed: ${error?.message ?? error}`);
      }
      return store;
    } catch (error) {
      log(`store unavailable: ${error?.message ?? error}`);
      store = undefined;
      return null;
    }
  }

  // Do not bail out when the store is unavailable at load time: a transient
  // failure (lock, half-written file) would otherwise silence the plugin for
  // the rest of the process. Listeners stay registered and reopen lazily.
  if (!currentStore()) log('store unavailable at load; will retry lazily');
  // 记忆块走宿主的动态上下文通道：pre-step 只把文本放进 hintBySid，
  // provider 在 assemble 和 step() 的 refreshContext 时被求值。
  // 不能塞 decision.messages——宿主会把每条非 runtime-context 的消息 append
  // 成 user/message，记忆块就变成猫自己说的话。
  // 可选注入：systemPrompt 服务出现时才注册——服务缺席时插件仍要能加载。
  // 注意 text 的 context 运行时带 agent（与内置 working-directory 同款），
  // 类型声明 AssembleContext 只列了 scope/signal，agent 是宿主合并进去的。
  // 启动自检：inject 名单进了日志；systemPrompt 缺席时下面回调不会执行，
  // 日志里就不会出现「context registered」——两种状态一眼可分。
  log(`self-check: inject=[${inject.join(',')}]`);
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.context({
      name: 'memory-core',
      order: 1000,
      interpolate: false,
      text: (context) => {
        const agent = context?.agent;
        if (!agent) return '';
        return hintBySid.get(agent.id) ?? hintBySid.get(agent.session?.id) ?? '';
      },
    });
    log('self-check: memory context registered');
  });
  startTimer();

  ctx.on('session/event', (session, event) => {
    lastActivity = Date.now();
    try {
      const db = currentStore();
      if (!db) return;
      startTimer();
      const inserted = ingestEvent(db, session, event);
      if (event?.type === 'user/message' || event?.type === 'assistant/message') {
        log(`${event.type} seq=${event.seq} inserted=${inserted}`);
      }
      if (event?.type === 'assistant/message') {
        try {
          planShadowV2(session, db);
        } catch (error) {
          log(`shadow-v2 failed: ${error?.message ?? error}`);
        }
      }
    } catch (error) {
      log(`ingest failed ${event?.type ?? '?'}#${event?.seq ?? '?'}: ${error?.message ?? error}`);
    }
  });

  // M2：每轮第一个 step 之前取回。不能塞 decision.messages：宿主 step() 会把
  // 每条非 runtime-context 的 decision.messages append 成 user/message
  // （dsh-agent-loop step() 的 firstAttempt 循环）——记忆块会变成猫自己说的话。
  // 文本存进 hintBySid，由注册的 systemPrompt.context provider 在
  // assemble/refreshContext 时取走，合进 runtime-context 快照。
  ctx.on('agent/pre-step', async ({ agent, messages, signal, step, turn }, next) => {
    const decision = await next();
    if (!decision || typeof decision !== 'object') {
      log('pre-step: next() returned no decision, skip injection');
      return decision;
    }
    if (decision?.kind === 'reject' || signal?.aborted) return decision;
    if (step !== 1) return decision;
    if (!Array.isArray(decision.messages)) {
      log(`pre-step: decision.messages is ${typeof decision.messages}, skip injection`);
      return decision;
    }
    try {
      const db = currentStore();
      if (!db) return decision;
      const sid = String(agent?.id ?? '');
      const hintParts = [];
      // 只用于记账：pre-step 的 turn 是进程内轮次，不参与「是不是新会话」的判断。
      const turnNo = Number(turn) > 0 ? Number(turn) : 0;

      // M5：会话第一轮接上同一个 workspace 里上一个会话的最后缓存。
      // 只认真替换过的行（applied=1），那是模型实际读过的接续文本；
      // cwd 为空的历史行不参与——宁可接不上也不串项目。
      // 是不是「第一轮」由 carry.js 看会话历史（surface 里有没有 assistant），
      // 不看 pre-step 的 messages——那只是本轮 claim 到的消息，也不看 turn，
      // 那是进程内轮次（旧会话恢复后也从 1 开始）。
      // 取会话和 cwd 放在内层 try 外面：retrieve 的 L3 也要用它，
      // 藏进 carry 的 try 里会变成 ReferenceError 再被外层 catch 吞掉。
      const session = typeof ctx.sessions?.get === 'function' ? ctx.sessions.get(sid) : undefined;
      const cwd = session?.header?.cwd;
      try {
        const carry = planCarry(db, { cwd, sid, session, messages: decision.messages });
        if (carry) {
          hintParts.push(carry);
          log(`carry chars=${carry.length} cwd=${cwd}`);
        }
      } catch (error) {
        log(`carry failed: ${error?.message ?? error}`);
      }

      // 全局栈：跨会话按时间取最近几条，作为替换上下文（指针在栈里，正文现查）。
      try {
        const stacked = renderStack(db);
        if (stacked) {
          hintParts.push(stacked);
          log(`stack chars=${stacked.length}`);
        }
      } catch (error) {
        log(`stack failed: ${error?.message ?? error}`);
      }

      const query = lastUserText(messages);
      if (query) {
        const hits = retrieve(db, {
          text: query,
          cwd,
          // 当前这句本身不算「已经有什么」，否则 dsh 这类高频实体会把自己挡掉。
          recent: recentTexts(messages).filter((text) => text !== query),
        });
        if (hits.length > 0) {
          const text = renderHint(hits);
          log(`recall hits=${hits.length} chars=${text.length}`);
          for (const hit of hits) {
            try {
              db.prepare(
                'INSERT INTO recall_log (sid, turn, t, memory_id, why) VALUES (?, ?, ?, ?, ?)',
              ).run(
                sid,
                turnNo,
                Date.now(),
                hit.source === 'memory' ? hit.id : null,
                hit.why ?? '',
              );
            } catch (error) {
              log(`recall log failed: ${error?.message ?? error}`);
            }
          }
          // A hit that was actually injected counts as "used": without this,
          // forgetSweep would demote a memory that is read every day after 30 days.
          try {
            const ids = hits.filter((hit) => hit.source === 'memory').map((hit) => hit.id);
            if (ids.length > 0) {
              db.prepare(
                `UPDATE memories SET last_used = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
              ).run(Date.now(), ...ids);
            }
          } catch (error) {
            log(`last_used failed: ${error?.message ?? error}`);
          }
          // M3 影子：算「如果替换会少给多少、补多少」，只记账，不改 messages。
          try {
            const plan = shadowPlan({ messages, hits, query });
            plan.hintChars = text.length;
            recordShadow(db, { sid, turn: turnNo, ...plan });
            if (plan.replaced > 0) log(`shadow replaced=${plan.replaced} saved=${plan.replacedChars} added=${plan.added}`);
          } catch (error) {
            log(`shadow failed: ${error?.message ?? error}`);
          }
          hintParts.push(text);
        }
      }
      if (hintParts.length === 0) {
        hintBySid.delete(sid);
        return decision;
      }
      // 只存文本，不改 decision：provider 会在本步 refreshContext 时取走。
      hintBySid.set(sid, hintParts.join('\n\n'));
      log(`hint queued sid=${sid} chars=${hintBySid.get(sid).length}`);
      return decision;
    } catch (error) {
      log(`recall failed: ${error?.message ?? error}`);
      return decision;
    }
  });

  // M1：空闲 5 分钟且有待提炼的轮次时，跑一次规则提炼。
  // 每次只处理最老的 40 条，避免长对话积压时一次卡住事件循环。
  let refining = false;
  let embedding = false;
  let embedRetryAt = 0;
  let lastForget = 0;
  const DAY = 24 * 60 * 60 * 1000;

  // The host may dispose this scope (session resume / plugin reload) and then
  // keep the process alive. currentStore() reopens lazily, so the timer must be
  // rebuildable too — otherwise refine/forget silently stop after a cleanup.
  function startTimer() {
    if (timer) return;
    timer = setInterval(() => {
    if (refining) return;
    if (Date.now() - lastActivity < idleMs) return;
    const db = currentStore();
    if (!db) return;
    // M4：每日一次遗忘扫描，只降 tier，不删行；重启后第一次空闲会补跑。
    if (Date.now() - lastForget >= DAY) {
      lastForget = Date.now();
      try {
        const sweep = forgetSweep(db);
        if (sweep.demoted) log(`forget dormant=${sweep.dormant} cold=${sweep.cold}`);
      } catch (error) {
        log(`forget failed: ${error?.message ?? error}`);
      }
    }
    try {
      if (pendingCount(db) > 0) {
        refining = true;
        const result = refine(db);
        log(`refine turns=${result.turns} memories=${result.memories}`);
      }
    } catch (error) {
      log(`refine failed: ${error?.message ?? error}`);
    } finally {
      refining = false;
    }
    // 向量索引：只补缺的几条；Ollama 不可用时退避 10 分钟再试，不阻塞下一轮。
    if (!embedding && Date.now() >= embedRetryAt) {
      embedding = true;
      embedPending(db)
        .then((result) => {
          if (result.embedded > 0) {
            log(`embed +${result.embedded} model=${result.model} dim=${result.dim}`);
          }
        })
        .catch((error) => {
          embedRetryAt = Date.now() + 10 * 60 * 1000;
          log(`embed failed: ${error?.message ?? error}`);
        })
        .finally(() => {
          embedding = false;
        });
    }
    }, tickMs);
    timer.unref?.();
  }

  ctx.effect(() => () => {
    disposed = true;
    if (timer) clearInterval(timer);
    timer = null;
    try {
      store?.close();
    } catch {
      /* already closed */
    }
    store = undefined;
  }, 'dsh-cat-ill-remember-you: idle refine + sqlite store');
}
