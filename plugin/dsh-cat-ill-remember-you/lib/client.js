/**
 * dsh-cat-ill-remember-you · 浏览器端入口
 *
 * 左栏图标 + 中栏面板。面板读后端的层开关状态，点一下就能改（host 侧
 * /dsh-cat-memory 通道，见 lib/index.js），不用重启。
 *
 * 依据宿主自带的 cordis-plugin-development 技能：
 * - factory 的 id 必须等于包名；
 * - React 由浏览器模块表提供，不要 require primitives 等宿主 UI 包；
 * - 通过 ctx.slots.inject(ownerKey, () => ctx.slots.register(...)) 注册；
 * - 不写 DOM、不挂 document.body，样式用 --dsw-alias-* 主题变量。
 */
window.__ModuleLoader__.load({
  id: 'dsh-cat-ill-remember-you',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const PANEL_ID = 'dsh-cat-ill-remember-you';
    const CHANNEL = '/dsh-cat-memory';

    /** 左栏图标：门 + 门框。尺寸跟宿主图标一致，颜色跟随主题。 */
    function MemoryIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 18;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        [
          h('path', { key: 'frame', d: 'M4 20V8.5L12 4l8 4.5V20' }),
          h('path', { key: 'door', d: 'M9.5 20v-6.5h5V20' }),
        ],
      );
    }

    // 面板上列哪几层。key 对应 host 侧 LAYER_KEYS，小写键对应 state.layers。
    const LAYERS = [
      { key: 'STACK', name: 'A1 接续层', desc: '全局栈：别的会话说过的话' },
      { key: 'PERSONA', name: 'A2 常驻层', desc: '你在意的事与约定（默认关）' },
      { key: 'PEOPLE', name: 'A3 人物层', desc: '人物卡，本句提到谁才进' },
      { key: 'RECALL', name: 'A4 检索层', desc: '按当前这句取回的旧记录' },
      { key: 'ENRICH', name: 'C 后台整理', desc: '提炼 / 向量 / 遗忘，只影响装库' },
    ];

    const text1 = 'var(--dsw-alias-text-1, inherit)';
    const text2 = 'var(--dsw-alias-text-2, rgba(255,255,255,0.62))';
    const line = 'var(--dsw-alias-border-1, rgba(255,255,255,0.12))';
    const accent = 'var(--dsw-alias-accent-1, #4f8cff)';

    function Switch(props) {
      const on = props.on === true;
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': on,
          disabled: props.disabled,
          onClick: props.onClick,
          style: {
            width: 40,
            height: 22,
            borderRadius: 11,
            border: `1px solid ${on ? accent : line}`,
            background: on ? accent : 'transparent',
            opacity: props.disabled ? 0.45 : 1,
            cursor: props.disabled ? 'default' : 'pointer',
            position: 'relative',
            padding: 0,
            flex: '0 0 auto',
          },
        },
        h('span', {
          style: {
            position: 'absolute',
            top: 2,
            left: on ? 20 : 2,
            width: 16,
            height: 16,
            borderRadius: 8,
            background: on ? '#fff' : text2,
            transition: 'left 120ms ease',
          },
        }),
      );
    }

    function Panel(props) {
      const call = props.call;
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState('');
      const [contextInfo, setContextInfo] = React.useState('');

      const load = React.useCallback(() => {
        call('state')
          .then((value) => {
            setState(value);
            setError('');
          })
          .catch((e) => setError(String(e && e.message ? e.message : e)));
      }, [call]);

      React.useEffect(() => {
        load();
      }, [load]);

      const toggle = async (key) => {
        if (!state || busy) return;
        const lower = key.toLowerCase();
        // REPLACE 不是 layers 里的一层：它对应白名单文件里本会话那一行。
        const current = key === 'REPLACE' ? state.replaceOn === true : state.layers[lower] === true;
        setBusy(key);
        setError('');
        try {
          const next = await call('set', { key, value: current ? 'off' : 'on' });
          setState(next);
        } catch (e) {
          setError(String(e && e.message ? e.message : e));
        } finally {
          setBusy('');
        }
      };

      const contextPreview = async () => {
        if (busy) return;
        setBusy('CONTEXT');
        setError('');
        try {
          const res = await call('context');
          setContextInfo(`已写入并用记事本打开 ${res.path}（${res.chars} 字）`);
        } catch (e) {
          setError(String(e && e.message ? e.message : e));
        } finally {
          setBusy('');
        }
      };

      const rows = LAYERS.map((layer) => {
        const lower = layer.key.toLowerCase();
        const on = state ? state.layers[lower] === true : false;
        return h(
          'div',
          {
            key: layer.key,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              padding: '12px 0',
              borderBottom: `1px solid ${line}`,
            },
          },
          [
            h(
              'div',
              { key: 'text', style: { flex: '1 1 auto', minWidth: 0 } },
              [
                h('div', { key: 'name', style: { fontSize: 13, color: text1 } }, layer.name),
                h('div', { key: 'desc', style: { fontSize: 12, color: text2, marginTop: 2 } }, layer.desc),
              ],
            ),
            h(Switch, {
              key: 'switch',
              on,
              disabled: state === null || busy === layer.key,
              onClick: () => toggle(layer.key),
            }),
          ],
        );
      });

      return h(
        'div',
        {
          style: {
            padding: '24px 28px',
            lineHeight: 1.7,
            fontSize: 13,
            color: text1,
            maxWidth: 720,
          },
        },
        [
          h(
            'div',
            { key: 'head', style: { display: 'flex', alignItems: 'baseline', gap: 10 } },
            [
              h('h2', { key: 'title', style: { margin: 0, fontSize: 16, fontWeight: 600 } }, '记忆'),
              h(
                'span',
                { key: 'ver', style: { fontSize: 12, color: text2 } },
                state ? `v${state.version}` : '',
              ),
            ],
          ),
          h(
            'p',
            { key: 'lead', style: { margin: '6px 0 16px', color: text2 } },
            '每层一个开关，关掉就少注入一块。默认值等于装插件之前的行为。',
          ),
          error
            ? h(
                'div',
                {
                  key: 'err',
                  style: {
                    margin: '0 0 12px',
                    padding: '8px 10px',
                    borderRadius: 6,
                    border: '1px solid #a2403a',
                    color: '#f0a6a0',
                    fontSize: 12,
                  },
                },
                error,
              )
            : null,
          h('div', { key: 'rows' }, rows),
          h(
            'div',
            {
              key: 'replace',
              style: { marginTop: 18, paddingTop: 14, borderTop: `1px solid ${line}` },
            },
            [
              h(
                'div',
                { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 14 } },
                [
                  h(
                    'div',
                    { key: 'text', style: { flex: '1 1 auto', minWidth: 0 } },
                    [
                      h(
                        'div',
                        { key: 't', style: { fontSize: 13 } },
                        state && state.replaceSid
                          ? `上下文替换（本会话 ${state.replaceSid}）`
                          : '上下文替换',
                      ),
                      h(
                        'div',
                        { key: 'd', style: { fontSize: 12, color: text2, marginTop: 2 } },
                        state && state.replace === 'env'
                          ? '白名单由环境变量 DSH_MEMORY_CORE_REPLACE_SESSIONS 指定，面板改不了。'
                          : state && state.replaceOn
                            ? '开着：这一轮之后，旧历史会被替换成压缩块。'
                            : '关着：历史原样保留，只注入记忆块。',
                      ),
                    ],
                  ),
                  h(Switch, {
                    key: 'switch',
                    on: state ? state.replaceOn === true : false,
                    disabled:
                      state === null ||
                      busy === 'REPLACE' ||
                      (state !== null && state.replace === 'env'),
                    onClick: () => toggle('REPLACE'),
                  }),
                ],
              ),
              h(
                'div',
                {
                  key: 'preview',
                  style: { marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
                },
                [
                  h(
                    'button',
                    {
                      key: 'ctxbtn',
                      type: 'button',
                      disabled: state === null || busy === 'CONTEXT',
                      onClick: contextPreview,
                      style: {
                        padding: '5px 12px',
                        borderRadius: 6,
                        border: `1px solid ${line}`,
                        background: 'transparent',
                        color: text1,
                        fontSize: 12,
                        cursor: state === null || busy === 'CONTEXT' ? 'default' : 'pointer',
                        opacity: state === null || busy === 'CONTEXT' ? 0.5 : 1,
                      },
                    },
                    busy === 'CONTEXT' ? '计算中…' : '生成替换上下文',
                  ),
                  h(
                    'span',
                    { key: 'path', style: { fontSize: 11, color: text2, wordBreak: 'break-all' } },
                    contextInfo || (state && state.contextLog ? state.contextLog : ''),
                  ),
                ],
              ),
              h(
                'div',
                { key: 'note', style: { fontSize: 11, color: text2, marginTop: 8 } },
                '只推演：不改历史、不记账、不看冷却。生成的是一份「若现在开替换，这一轮模型会收到的完整上下文」——全局栈、记忆块、替换块、保留区都在同一个文件里。',
              ),
            ],
          ),
        ],
      );
    }

    return {
      // connection 要在这里声明：package.json 的 dsh.client.inject 只管模块激活顺序，
      // 不声明就拿不到 ctx.connection（报 cannot get property "connection" without inject）。
      inject: ['slots', 'connection'],
      apply(ctx) {
        const call = async (endpoint, input) => {
          const rpc = ctx.connection && ctx.connection.rpc;
          if (!rpc || typeof rpc.call !== 'function') {
            throw new Error('connection 不可用，面板拿不到后端状态');
          }
          const response = await rpc.call(CHANNEL, endpoint, input || {});
          if (!response || response.ok !== true) {
            const message = response && response.error && response.error.message;
            throw new Error(message || '调用失败');
          }
          return response.value;
        };

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, () => h(Panel, { call })),
        );
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => '记忆' },
            MemoryIcon,
          ),
        );
        ctx.effect(() => () => {}, 'dsh-cat-ill-remember-you: panel');
      },
    };
  },
});
