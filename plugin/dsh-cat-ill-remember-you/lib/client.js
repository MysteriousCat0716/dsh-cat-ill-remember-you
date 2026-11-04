/**
 * dsh-cat-ill-remember-you · 浏览器端入口（最小骨架）
 *
 * 只做两件事：在左栏图标区注册一个「记忆」图标，在中栏注册一张占位面板。
 * 目的是先把通路跑通——图标出现、点开能切到我们自己的面板。
 * 数据读写（层开关、替换选项三选一）等这一步验证过了再往里填。
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

    /** 中栏占位面板。真实内容（层开关 + 替换选项）在通路验证之后填。 */
    function Panel() {
      const note = { margin: 0, opacity: 0.6 };
      return h(
        'div',
        {
          style: {
            padding: '24px 28px',
            lineHeight: 1.75,
            fontSize: 13,
            color: 'var(--dsw-alias-text-1, inherit)',
          },
        },
        [
          h(
            'h2',
            { key: 'title', style: { margin: '0 0 6px', fontSize: 16, fontWeight: 600 } },
            '记忆',
          ),
          h(
            'p',
            { key: 'lead', style: { margin: '0 0 14px', opacity: 0.72 } },
            '通路验证页。左栏图标能出现、点开能到这里，就说明 client 入口接上了。',
          ),
          h(
            'div',
            { key: 'layers', style: { margin: '0 0 6px', fontWeight: 600 } },
            '当前层开关（环境变量）',
          ),
          h('ul', { key: 'list', style: { margin: '0 0 14px', paddingLeft: 18, opacity: 0.85 } }, [
            h('li', { key: 'a1' }, 'DSH_MEMORY_CORE_STACK —— 全局接续栈'),
            h('li', { key: 'a2' }, 'DSH_MEMORY_CORE_PERSONA —— 常驻层（默认关）'),
            h('li', { key: 'a3' }, 'DSH_MEMORY_CORE_PEOPLE —— 人物卡'),
            h('li', { key: 'a4' }, 'DSH_MEMORY_CORE_RECALL —— 检索块'),
            h('li', { key: 'c' }, 'DSH_MEMORY_CORE_ENRICH —— 后台整理（refine / embed / forget）'),
            h('li', { key: 'b' }, '替换白名单 —— ~/.dsh/cache/replace-sessions.txt'),
          ]),
          h('p', { key: 'note', style: note }, '下一步：把这张页面换成真开关和「上下文替换选项」三选一。'),
        ],
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel),
        );
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => '记忆' },
            MemoryIcon,
          ),
        );
      },
    };
  },
});
