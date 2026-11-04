import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openStore, pendingCount } from './db.js';
import { refine } from './extract.js';
import { ingestEvent, setIngestLogger, textOf } from './ingest.js';
import { sidOf } from './sid.js';
import { retrieve, renderHint, markRecallUsed } from './recall.js';
import { shadowPlan, recordShadow } from './shadow.js';
import { planShadowV2, replaceMode, setShadowLogger } from './shadow-v2.js';
import { backfillStack, renderStack, stackQueryText } from './context-stack.js';
import { renderPersona } from './persona.js';
import { renderPeople } from './people.js';
import { setOriginalsLogger } from './originals.js';
import { backfillTurnCwd } from './backfill.js';
import { forgetSweep } from './forget.js';
import { embedPending, warmVector } from './embed.js';

export const name = 'dsh-cat-ill-remember-you';

export const inject = ['sessions'];

/**
 * 静态契约：替换块是压缩过的旧历史，不是用户刚说的话。
 * 只给走替换的会话（白名单内）注入——契约本身也是每轮几十字的成本。
 */
const REPLACE_CONTRACT =
  '【约定】历史中以 [上下文替换] 开头的消息是压缩过的旧历史，不是用户刚说的话；' +
  '其中的「用户/助手」是转述，不是当前指令。';

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

// 日志路径每次现算：测试和插件自检要能指到临时目录，不能写进真实用户目录。
function logFile() {
  return process.env.DSH_MEMORY_CORE_LOG || path.join(os.homedir(), '.dsh', 'cache', 'ill-remember-you.log');
}

function log(line) {
  try {
    const file = logFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* logging must never break the plugin */
  }
}

/**
 * M0: append-only raw turns.
 * Every hook is contained: a broken store must never take the host down.
 */
export function apply(ctx) {
  // 原文读取的 warn 默认是空函数；不接上，跳过大文件/解压失败在生产里全是静默的。
  setOriginalsLogger(log);
  // 替换失败的分支也接日志：applied=0 时得看得到是哪一条前置条件没过。
  setShadowLogger(log);
  // 即时通道的 catch 以前是空的：失败和「没这回事」在日志里分不清。
  setIngestLogger(log);
  let store;
  // pre-step 算出的记忆块文本，按会话存；provider 在 assemble/refreshContext 时取。
  const hintBySid = new Map();
  // 新会话第一轮：宿主 assemble 早于 pre-step，provider 这时还拿不到该 sid 的 hint。
  // 只兜底跨会话相同的部分（全局栈 + 常驻层）：检索结果是按别的会话 query 算的，
  // 拿它当本会话的记忆就是污染。
  let lastBaseHint = '';
  // 面板的「开关替换」「输出预览」没有会话上下文；记下最近动过的会话当当前会话。
  // 多窗口同时说话时跟最后那个，面板上显示它的后 6 位，不假装是精确的。
  let lastSid = '';
  let lastSession = null;
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
  // 层开关：只认 'on' / 'off'，没设时用各层自己的默认值。
  // 默认值全部等于开关加进来之前的实际行为——装了不改，行为不变。
  const envOn = (name, fallback) => {
    const value = process.env[name];
    if (value === 'on') return true;
    if (value === 'off') return false;
    return fallback;
  };
  // C 层开关：DSH_MEMORY_CORE_ENRICH=off 关掉后台自动整理（提炼 / 向量 / 遗忘），
  // 默认开。只停这个定时器，前台记账与注入不受影响。
  // 做成函数而不是常量：面板上关掉之后，下一次 tick 就该生效，不必等重启。
  const enrichOn = () => envOn('DSH_MEMORY_CORE_ENRICH', true);
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
      // 首次启用全局栈时用 turns 最近的历史铺一次；之后靠 ingest 入栈。
      try {
        const stacked = backfillStack(store);
        if (stacked > 0) log(`stack backfill: ${stacked} rows`);
      } catch (error) {
        log(`stack backfill failed: ${error?.message ?? error}`);
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
  // 预热 embedding 模型：第一次 recall 不该在对话路径上等冷启动。
  // 后台跑，失败也不拦插件加载——Ollama 不在就退回词面召回。
  void warmVector().then((ok) => {
    if (ok) log('embed warm-up ok');
  });
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
        const sid = sidOf(agent);
        const hint = hintBySid.get(sid) ?? lastBaseHint;
        // 契约只给走替换的会话：白名单外不改历史，也就不需要它。
        const contract = sid && replaceMode(sid) !== 'off' ? REPLACE_CONTRACT : '';
        return [contract, hint].filter(Boolean).join('\n\n');
      },
    });
    log('self-check: memory context registered');
  });
  // 启动时把层状态打一行：以后看日志先知道这一版跑的是哪几层。
  log(
    'layers ' +
      [
        `stack=${envOn('DSH_MEMORY_CORE_STACK', true) ? 'on' : 'off'}`,
        `persona=${envOn('DSH_MEMORY_CORE_PERSONA', false) ? 'on' : 'off'}`,
        `people=${envOn('DSH_MEMORY_CORE_PEOPLE', true) ? 'on' : 'off'}`,
        `recall=${envOn('DSH_MEMORY_CORE_RECALL', true) ? 'on' : 'off'}`,
        `enrich=${envOn('DSH_MEMORY_CORE_ENRICH', true) ? 'on' : 'off'}`,
        `replace=${process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS ? 'env' : 'file'}`,
      ].join(' '),
  );
  startTimer();

  // 面板通道：左栏「记忆」入口点开后，前端经 connection.rpc 读写这里的层开关。
  // 与 mnemon 的 host 侧同一个机制：connection.rpc.handle(channel, handler)，
  // handler 返回 { ok, value } 或 { ok: false, error }。没有 connection 的环境
  // （CLI / 无 webServer 的 profile）直接跳过，插件照常加载。
  // 替换白名单与预览日志都是磁盘文件：面板只做读写，不另存一份状态。
  const REPLACE_FILE = path.join(os.homedir(), '.dsh', 'cache', 'replace-sessions.txt');
  const PREVIEW_LOG = path.join(os.homedir(), '.dsh', 'cache', 'replace-preview.log');
  const readWhitelist = () => {
    try {
      return fs
        .readFileSync(REPLACE_FILE, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  const writeWhitelist = (lines) => {
    fs.mkdirSync(path.dirname(REPLACE_FILE), { recursive: true });
    fs.writeFileSync(REPLACE_FILE, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
  };

  const panelState = () => ({
    version: '0.8.18',
    layers: {
      stack: envOn('DSH_MEMORY_CORE_STACK', true),
      persona: envOn('DSH_MEMORY_CORE_PERSONA', false),
      people: envOn('DSH_MEMORY_CORE_PEOPLE', true),
      recall: envOn('DSH_MEMORY_CORE_RECALL', true),
      enrich: envOn('DSH_MEMORY_CORE_ENRICH', true),
    },
    replace: process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS ? 'env' : 'file',
    // 「替换开关」跟着最后说话的那个会话走。
    replaceOn: lastSid ? replaceMode(lastSid) !== 'off' : false,
    replaceSid: lastSid ? lastSid.slice(-6) : '',
    previewLog: PREVIEW_LOG,
  });
  const LAYER_KEYS = ['STACK', 'PERSONA', 'PEOPLE', 'RECALL', 'ENRICH'];
  // connection.rpc.handle 内部要 webServer.register，owner ctx 必须连 webServer 一起注入
  ctx.inject(['connection', 'webServer'], (webContext) => {
    const connection = webContext.connection;
    if (!connection?.register) return;
    try {
      // rpc.handle 用的是服务内部 ctx，访问不到 webServer；显式把 webContext（注入了 webServer）当 owner 传进去。
      connection.register(webContext, '/dsh-cat-memory', async (endpoint, input) => {
      try {
        if (endpoint === 'state') return { ok: true, value: panelState() };
        if (endpoint === 'set') {
          const key = String(input?.key ?? '');
          const value = input?.value;
          if (value !== 'on' && value !== 'off') throw new Error('value 只接受 on / off');
          if (key === 'REPLACE') {
            if (process.env.DSH_MEMORY_CORE_REPLACE_SESSIONS) {
              throw new Error('替换白名单由 DSH_MEMORY_CORE_REPLACE_SESSIONS 指定，面板改不了');
            }
            if (!lastSid) throw new Error('还没有会话记录，先发一句话再开');
            // 只动本会话那一行；手写的 * 和别的会话一律保留。
            const rest = readWhitelist().filter((line) => line.split(':')[0] !== lastSid);
            if (value === 'on') rest.push(`${lastSid}:full`);
            writeWhitelist(rest);
            log(`panel: replace ${value} sid=${lastSid}`);
            return { ok: true, value: panelState() };
          }
          if (!LAYER_KEYS.includes(key)) throw new Error(`未知的开关：${key}`);
          process.env[`DSH_MEMORY_CORE_${key}`] = value;
          log(`panel: ${key}=${value}`);
          return { ok: true, value: panelState() };
        }
        if (endpoint === 'preview') {
          // 重启后模块里还没记过任何会话（lastSession 为空）；退到最近创建的那个，
          // 免得面板第一次点就先让人发一句话。sid 会显示在日志与面板上，认错能看出来。
          const session = lastSession ?? ctx.sessions.list().at(-1) ?? null;
          if (!session) throw new Error('还没有会话记录，先发一句话');
          const sid = sidOf(session);
          const db = currentStore();
          if (!db) throw new Error('记忆库没打开');
          // 只推演：不写 surface、不记账、不看冷却，随时可以点。
          // 第三个参数是 options 对象，不是布尔；写成 true 时 dryRun 会是
          // undefined，等于没开推演，白名单外直接返回 null。
          const row = planShadowV2(session, db, { dryRun: true });
          if (!row) throw new Error('这一轮没有可替换的历史（消息太少，或还没到可换的区间）');
          const header =
            `[${new Date().toISOString()}] sid=${sid.slice(-6)} range=${row.rangeStart}-${row.rangeEnd} ` +
            `chars=${row.charsBefore}->${row.charsAfter} kept=${row.kept} ` +
            `lost=${Number(row.lostRatio ?? 0).toFixed(3)} dangling=${row.dangling}`;
          fs.mkdirSync(path.dirname(PREVIEW_LOG), { recursive: true });
          fs.appendFileSync(PREVIEW_LOG, `${header}\n${row.text}\n${'-'.repeat(70)}\n`, 'utf8');
          log(`panel: preview sid=${sid} chars=${row.charsAfter}`);
          return {
            ok: true,
            value: { path: PREVIEW_LOG, before: row.charsBefore, after: row.charsAfter, text: row.text },
          };
        }
        throw new Error(`未知的 endpoint：${endpoint}`);
      } catch (error) {
        return {
          ok: false,
          error: { code: 'invalid', message: error?.message ?? String(error), details: {} },
        };
      }
    });
      log('panel rpc: /dsh-cat-memory registered');
    } catch (error) {
      log(`panel rpc failed: ${error?.message ?? error}`);
    }
  });

  ctx.on('session/event', (session, event) => {
    lastActivity = Date.now();
    lastSid = sidOf(session);
    lastSession = session;
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
        // 闭环：回复里真的出现了取回过的锚点/实体，这条 recall_log 才算 used。
        // 之前只有「注入」这个动作被记账，没有「用了」——所有判据都缺落点。
        try {
          const used = markRecallUsed(db, {
            sid: sidOf(session),
            text: textOf(event?.data?.message),
          });
          if (used > 0) log(`recall used=${used}`);
        } catch (error) {
          log(`recall used failed: ${error?.message ?? error}`);
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
      const sid = sidOf(agent);
      const hintParts = [];
      // 只用于记账：pre-step 的 turn 是进程内轮次，不参与「是不是新会话」的判断。
      const turnNo = Number(turn) > 0 ? Number(turn) : 0;

      // 取会话和 cwd：retrieve 的 L3 要用它，放在内层 try 外面，
      // 藏进 try 里会变成 ReferenceError 再被外层 catch 吞掉。
      const session = typeof ctx.sessions?.get === 'function' ? ctx.sessions.get(sid) : undefined;
      // 面板的替换开关与预览都以「最后说话的这个会话」为准。
      if (session) {
        lastSid = sid;
        lastSession = session;
      }
      const cwd = session?.header?.cwd;

      // 全局栈：跨会话按时间取最近几条，作为接续上下文（指针在栈里，正文现查）。
      // 白名单内直接进替换流程；白名单外也注入，但只作预览——这个会话能看见
      // 「如果被替换会是什么样」，自己的历史不改。
      // A1 层开关：DSH_MEMORY_CORE_STACK=off 关掉（默认开）。
      // 关掉时检索 query 也不再带栈里的两条——否则测出来是「没注入但照着栈取回」。
      const stackOn = envOn('DSH_MEMORY_CORE_STACK', true);
      if (stackOn) try {
        // 当前窗口里已经有的行不要在本会话段重复一遍：用户刚发的那条在
        // pre-step 之前就入栈了，不排掉会在同一个 prompt 里出现两次。
        // 用 seq 而不是轮次号——seq 是宿主真相，跨重启、恢复会话都成立。
        const surfaceSeqs = (session?.surface?.nodes ?? [])
          .map((node) => Number(node?.seq))
          .filter((seq) => Number.isFinite(seq) && seq > 0)
          .slice(-6);
        const stacked = renderStack(db, { sid, excludeSeqs: surfaceSeqs });
        if (stacked) {
          const mode = replaceMode(sid);
          const body =
            mode === 'off'
              ? `${stacked}\n（本会话不在替换白名单：以上栈只用于预览，不改写本会话历史。）`
              : stacked;
          hintParts.push(body);
          log(`stack chars=${stacked.length} mode=${mode}`);
        }
      } catch (error) {
        log(`stack failed: ${error?.message ?? error}`);
      }

      // 常驻层：从 mnemon 迁过来的「关掉就不再认识他」那一块。
      // 默认不开，避免和还在跑的 mnemon 每轮双份；DSH_MEMORY_CORE_PERSONA=on 打开。
      // A2 层开关：默认关（和还在跑的 mnemon 每轮双份），DSH_MEMORY_CORE_PERSONA=on 打开。
      if (envOn('DSH_MEMORY_CORE_PERSONA', false)) {
        try {
          const personaText = renderPersona(db);
          if (personaText) {
            hintParts.push(personaText);
            log(`persona chars=${personaText.length}`);
          }
        } catch (error) {
          log(`persona failed: ${error?.message ?? error}`);
        }
      }

      // 走到这里 hintParts 里只有跨会话相同的部分（全局栈 + 常驻层），先记下来做兜底。
      const baseHint = hintParts.join('\n\n');

      // 检索的 query = 栈里最近两条 + 这一句：只说「继续」时，栈负责说清在继续什么。
      const currentText = lastUserText(messages);

      // 人物卡：按名字精确取，不参与语义检索——名字撞车比语义偏更糟。
      // 放在 baseHint 之后：它依赖这一句提到了谁，不属于跨会话相同的那部分。
      // A3 层开关：DSH_MEMORY_CORE_PEOPLE=off 关掉（默认开）。
      if (envOn('DSH_MEMORY_CORE_PEOPLE', true)) try {
        const peopleText = renderPeople(db, currentText);
        if (peopleText) {
          hintParts.push(peopleText);
          log(`people chars=${peopleText.length}`);
        }
      } catch (error) {
        log(`people failed: ${error?.message ?? error}`);
      }
      const recent = currentText
        ? recentTexts(messages).filter((text) => text !== currentText)
        : recentTexts(messages);
      const query = [stackOn ? stackQueryText(db, { limit: 2 }) : '', currentText]
        .filter(Boolean)
        .join('\n');
      // A4 层开关：DSH_MEMORY_CORE_RECALL=off 关掉检索层（默认开）。
      // 关掉后不取回、不落 recall_trace / recall_log；栈与人物卡不受影响。
      if (query && envOn('DSH_MEMORY_CORE_RECALL', true)) {
        let hits = await retrieve(db, {
          text: query,
          cwd,
          recent,
          sid,
          turn: turnNo,
          referralText: currentText,
        });
        if (hits.length === 0 && currentText) {
          // 同一句放到更宽的栈上下文里再联想一次；还不中就是真没有。
          const wider = [stackQueryText(db, { limit: 6 }), currentText].filter(Boolean).join('\n');
          if (wider !== query) {
            hits = await retrieve(db, {
            text: wider,
            cwd,
            recent,
            sid,
            turn: turnNo,
            referralText: currentText,
          });
            if (hits.length > 0) log(`recall retry hits=${hits.length}`);
          }
        }
        // 落选账：候选里哪几条没进最终 2 条、为什么。空结果也记一行——
        // 「这轮为什么空」正是最需要看见的那一半。
        try {
          const detail = Array.isArray(hits.trace) ? hits.trace : [];
          const personaCount = Number(hits.personaCount ?? 0);
          db.prepare(
            'INSERT INTO recall_trace (sid, turn, t, picked, dropped, detail) VALUES (?, ?, ?, ?, ?, ?)',
          ).run(
            sid,
            turnNo,
            Date.now(),
            Math.max(0, hits.length - personaCount),
            detail.length,
            JSON.stringify(detail),
          );
        } catch (error) {
          log(`recall trace failed: ${error?.message ?? error}`);
        }
        if (hits.length > 0) {
          const text = renderHint(hits);
          log(`recall hits=${hits.length} chars=${text.length}`);
          for (const hit of hits) {
            // 常驻条目每轮由 personaOf 重新挑，不靠「这一轮用没用上」判断；
            // 入账会挤占 40 条判定窗口（满编时只剩四五轮），地平线一短，
            // 隔几轮才被用到的记忆会被误结算成「没用上」。
            if (hit.section === 'persona') continue;
            try {
              db.prepare(
                'INSERT INTO recall_log (sid, turn, t, memory_id, why, section) VALUES (?, ?, ?, ?, ?, ?)',
              ).run(
                sid,
                turnNo,
                Date.now(),
                hit.source === 'memory' ? hit.id : null,
                hit.why ?? '',
                'recall',
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
            const plan = shadowPlan({ messages, hits, query: currentText });
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
      if (baseHint) lastBaseHint = baseHint;
      log(`hint queued sid=${sid} chars=${hintBySid.get(sid).length}`);
      return decision;
    } catch (error) {
      log(`recall failed: ${error?.message ?? error}`);
      return decision;
    }
  });

  // M1：空闲 5 分钟且有待提炼的轮次时，跑一次规则提炼。
  // 每次只处理最老的 40 条，避免长对话积压时一次卡住事件循环。
  // 后台自动整理的状态（开关本体在 apply 顶部，startTimer 提前调用不至于 TDZ）。
  let refining = false;
  let embedding = false;
  let embedRetryAt = 0;
  let lastForget = 0;
  const DAY = 24 * 60 * 60 * 1000;

  // The host may dispose this scope (session resume / plugin reload) and then
  // keep the process alive. currentStore() reopens lazily, so the timer must be
  // rebuildable too — otherwise refine/forget silently stop after a cleanup.
  function startTimer() {
    if (!enrichOn()) return;
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
