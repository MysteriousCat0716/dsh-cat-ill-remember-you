/**
 * dsh-cat-ill-remember-you · 浏览器端入口
 *
 * 左栏图标 + 中栏面板。两页：
 * - 通常设置：全局替换开关、新会话自动拉黑、黑名单双栏、生成替换上下文。
 *   动这些不会改变「同一轮对话算出来的替换块」——只决定用不用、对谁用。
 * - 调试设置：五个层开关。动它们会改变替换块的内容，属于测试用。
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
    const bg2 = 'var(--dsw-alias-bg-2, rgba(255,255,255,0.04))';

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

    /** 一行「标题 + 说明 + 开关」。 */
    function Row(props) {
      return h(
        'div',
        {
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
              h('div', { key: 'name', style: { fontSize: 13, color: text1 } }, props.name),
              h('div', { key: 'desc', style: { fontSize: 12, color: text2, marginTop: 2 } }, props.desc),
            ],
          ),
          h(Switch, { key: 'switch', on: props.on, disabled: props.disabled, onClick: props.onClick }),
        ],
      );
    }

    function SmallButton(props) {
      const disabled = props.disabled === true;
      return h(
        'button',
        {
          type: 'button',
          disabled,
          onClick: props.onClick,
          style: {
            padding: '4px 10px',
            borderRadius: 6,
            border: `1px solid ${disabled ? line : accent}`,
            background: 'transparent',
            color: disabled ? text2 : accent,
            fontSize: 12,
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.5 : 1,
          },
        },
        props.children,
      );
    }

    /** 一栏会话列表：点一条选中，选中才亮下面那个按钮。 */
    function SessionList(props) {
      const { items, selected, onSelect, empty, height } = props;
      return h(
        'div',
        {
          style: {
            flex: '1 1 0',
            minWidth: 0,
            height: height || 220,
            overflowY: 'auto',
            border: `1px solid ${line}`,
            borderRadius: 8,
            background: bg2,
            padding: 4,
          },
        },
        items.length === 0
          ? h('div', { style: { padding: '10px 8px', fontSize: 12, color: text2 } }, empty)
          : items.map((item) =>
              h(
                'div',
                {
                  key: item.sid,
                  onClick: () => onSelect(item.sid),
                  title: item.sid,
                  style: {
                    padding: '7px 8px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    background: selected === item.sid ? 'rgba(79,140,255,0.16)' : 'transparent',
                    border: `1px solid ${selected === item.sid ? accent : 'transparent'}`,
                    marginBottom: 2,
                  },
                },
                [
                  h(
                    'div',
                    {
                      key: 'title',
                      style: {
                        fontSize: 12,
                        color: text1,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      },
                    },
                    item.title || '(无用户发言)',
                  ),
                  h(
                    'div',
                    { key: 'meta', style: { fontSize: 11, color: text2, marginTop: 2 } },
                    `${item.code} · ${item.count} 条`,
                  ),
                ],
              ),
            ),
      );
    }

    function Panel(props) {
      const call = props.call;
      const [state, setState] = React.useState(null);
      const [tab, setTab] = React.useState('normal');
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState('');
      const [info, setInfo] = React.useState('');
      const [leftPick, setLeftPick] = React.useState('');
      const [rightPick, setRightPick] = React.useState('');

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
        const current =
          key === 'REPLACE'
            ? state.replaceGlobal === true
            : key === 'AUTO_BLACKLIST'
              ? state.autoBlacklist === true
              : state.layers[lower] === true;
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

      const move = async (sid, action) => {
        if (!state || !sid || busy) return;
        setBusy(action);
        setError('');
        try {
          await call('blacklist', { sid, action });
          await load();
          if (action === 'add') setRightPick('');
          else setLeftPick('');
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
          setInfo(`已写入并用记事本打开 ${res.path}（${res.chars} 字）`);
        } catch (e) {
          setError(String(e && e.message ? e.message : e));
        } finally {
          setBusy('');
        }
      };

      const sessions = state && Array.isArray(state.sessions) ? state.sessions : [];
      const blacklist = state && Array.isArray(state.blacklist) ? state.blacklist : [];
      const blackSet = new Set(blacklist);
      const bySid = new Map(sessions.map((item) => [item.sid, item]));
      // 左栏：黑名单里的会话。库里查不到的（很久没说话）也列出来，至少能移出。
      const leftItems = blacklist.map(
        (sid) => bySid.get(sid) || { sid, code: sid.slice(-6), count: 0, title: '(库里没有记录)' },
      );
      const rightItems = sessions.filter((item) => !blackSet.has(item.sid));

      const tabButton = (id, label) =>
        h(
          'button',
          {
            key: id,
            type: 'button',
            onClick: () => setTab(id),
            style: {
              padding: '5px 12px',
              borderRadius: 6,
              border: `1px solid ${tab === id ? accent : line}`,
              background: tab === id ? 'rgba(79,140,255,0.14)' : 'transparent',
              color: tab === id ? accent : text2,
              fontSize: 12,
              cursor: 'pointer',
            },
          },
          label,
        );

      const normalPage = [
        h(Row, {
          key: 'replace',
          name: '上下文替换',
          desc: state && state.replaceGlobal
            ? '开着：历史里较早的部分会被替换成压缩块（黑名单里的会话除外）。'
            : '关着：历史原样保留，只注入记忆块。',
          on: state ? state.replaceGlobal === true : false,
          disabled: state === null || busy === 'REPLACE',
          onClick: () => toggle('REPLACE'),
        }),
        h(Row, {
          key: 'auto',
          name: '新会话自动加入替换黑名单',
          desc: '开着时，第一次见到、库里还没有记录的新会话会自动进黑名单，不会被替换。',
          on: state ? state.autoBlacklist === true : false,
          disabled: state === null || busy === 'AUTO_BLACKLIST',
          onClick: () => toggle('AUTO_BLACKLIST'),
        }),
        h(
          'div',
          { key: 'blacklist', style: { marginTop: 18 } },
          [
            h(
              'div',
              { key: 'head', style: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 } },
              [
                h('div', { key: 't', style: { fontSize: 13, fontWeight: 600 } }, '上下文替换黑名单'),
                h(
                  'div',
                  { key: 'd', style: { fontSize: 11, color: text2 } },
                  '名单里的会话保留历史原文，不被替换。',
                ),
              ],
            ),
            h(
              'div',
              { key: 'cols', style: { display: 'flex', gap: 12, alignItems: 'stretch' } },
              [
                h(
                  'div',
                  { key: 'l', style: { flex: '1 1 0', minWidth: 0 } },
                  [
                    h(
                      'div',
                      { key: 'lt', style: { fontSize: 11, color: text2, marginBottom: 4 } },
                      `已在黑名单（${leftItems.length}）`,
                    ),
                    h(SessionList, {
                      key: 'list',
                      items: leftItems,
                      selected: leftPick,
                      onSelect: setLeftPick,
                      empty: '还没有会话在名单里',
                      height: 220,
                    }),
                    h(
                      'div',
                      { key: 'lbtn', style: { marginTop: 6 } },
                      h(
                        SmallButton,
                        { disabled: !leftPick || busy !== '', onClick: () => move(leftPick, 'remove') },
                        '移出黑名单',
                      ),
                    ),
                  ],
                ),
                h(
                  'div',
                  { key: 'r', style: { flex: '1 1 0', minWidth: 0 } },
                  [
                    h(
                      'div',
                      { key: 'rt', style: { fontSize: 11, color: text2, marginBottom: 4 } },
                      `全部会话（${rightItems.length}）`,
                    ),
                    h(SessionList, {
                      key: 'list',
                      items: rightItems,
                      selected: rightPick,
                      onSelect: setRightPick,
                      empty: '库里还没有会话记录',
                      height: 220,
                    }),
                    h(
                      'div',
                      { key: 'rbtn', style: { marginTop: 6 } },
                      h(
                        SmallButton,
                        { disabled: !rightPick || busy !== '', onClick: () => move(rightPick, 'add') },
                        '加入黑名单',
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ],
        ),
        h(
          'div',
          { key: 'preview', style: { marginTop: 20, paddingTop: 14, borderTop: `1px solid ${line}` } },
          [
            h(
              'div',
              {
                key: 'row',
                style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
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
                  info || (state && state.contextLog ? state.contextLog : ''),
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
      ];

      const debugPage = [
        h(
          'p',
          { key: 'lead', style: { margin: '0 0 8px', color: text2, fontSize: 12 } },
          '这些只改内存里的环境变量，重启回默认。动任何一个，「同一轮对话」算出来的替换块都会不同——是拿来测的，不是日常用的。',
        ),
        ...LAYERS.map((layer) =>
          h(Row, {
            key: layer.key,
            name: layer.name,
            desc: layer.desc,
            on: state ? state.layers[layer.key.toLowerCase()] === true : false,
            disabled: state === null || busy === layer.key,
            onClick: () => toggle(layer.key),
          }),
        ),
      ];

      return h(
        'div',
        {
          style: {
            padding: '24px 28px',
            lineHeight: 1.7,
            fontSize: 13,
            color: text1,
            maxWidth: 760,
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
          h('div', { key: 'tabs', style: { display: 'flex', gap: 8, margin: '12px 0 16px' } }, [
            tabButton('normal', '通常设置'),
            tabButton('debug', '调试设置'),
          ]),
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
          h('div', { key: 'body' }, tab === 'normal' ? normalPage : debugPage),
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
