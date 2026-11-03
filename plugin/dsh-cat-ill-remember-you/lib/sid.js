/**
 * 会话 id 只从一处取。
 *
 * provider 拿到的是 agent，事件拿到的是 session；宿主的 agent 可能只有 `id`，
 * 真正的会话 id 在 `agent.session.id` 上。三处各写各的（`agent.id`、
 * `session.id ?? session.sessionId`、`agent.session?.id ?? agent.id`）时，
 * hint 的键、白名单判断、账本的 sid 会对不上——测试里的 fake agent 恰好
 * 两者相等，所以测不出来。
 *
 * 顺序固定为 session 内层优先，再退到对象自身的 id。
 * @param {unknown} value agent 或 session
 * @returns {string}
 */
export function sidOf(value) {
  if (!value || typeof value !== 'object') return '';
  return String(value.session?.id ?? value.id ?? value.sessionId ?? '');
}
