import { defineConfig } from 'vitepress'

// GitHub Pages project site: https://tbk0ng.github.io/myflow/
// `base` is the only site-specific setting; every link in the book is relative
// so the builder applies it.
export default defineConfig({
  lang: 'zh-CN',
  title: 'myflow',
  description: '一个只跑在 Pi 上的编码代理工作流外壳：它为什么长这样，以及它哪里还不够好。',
  base: '/myflow/',
  cleanUrls: true,
  lastUpdated: false,
  themeConfig: {
    outline: { level: [2, 3], label: '本页目录' },
    nav: [
      { text: '序', link: '/intro/what-is-myflow', activeMatch: '/intro/' },
      { text: '系统篇', link: '/system/overview', activeMatch: '/system/' },
      { text: '论证篇', link: '/design/windows-only', activeMatch: '/design/' },
      { text: '上线篇', link: '/launch/positioning', activeMatch: '/launch/' },
      { text: '诚实篇', link: '/honest/defects', activeMatch: '/honest/' },
      { text: '附录', link: '/appendix/glossary', activeMatch: '/appendix/' },
    ],
    sidebar: [
      {
        text: '序',
        items: [
          { text: '这是什么', link: '/intro/what-is-myflow' },
          { text: '为什么造它', link: '/intro/why-built' },
          { text: '怎么读这本书', link: '/intro/how-to-read' },
        ],
      },
      {
        text: '系统篇 — 实际跑起来的是什么',
        items: [
          { text: '一次会话的全景', link: '/system/overview' },
          { text: '三个身份：项目根、会话、任务', link: '/system/identity' },
          { text: '任务生命周期与 task.py', link: '/system/task-lifecycle' },
          { text: '上下文注入', link: '/system/context-injection' },
          { text: '子代理调度', link: '/system/dispatch' },
          { text: '运行注册表与转向', link: '/system/runs-and-steering' },
          { text: '计划批准门', link: '/system/approval-gate' },
          { text: '后台任务', link: '/system/background-tasks' },
          { text: '/mysubagents 面板', link: '/system/board' },
          { text: '发布载荷与安装', link: '/system/release' },
        ],
      },
      {
        text: '论证篇 — 别人怎么做，我为什么不一样',
        items: [
          { text: '只支持 Windows + Git Bash', link: '/design/windows-only' },
          { text: '长驻 rpc 子进程', link: '/design/rpc-child' },
          { text: '文件即状态：没有守护进程', link: '/design/state-on-disk' },
          { text: 'append-only 的转向通道', link: '/design/ctl-jsonl' },
          { text: 'writesUnder 是边界，不是锁', link: '/design/write-scope' },
          { text: '字节预算，而不是塞满 prompt', link: '/design/context-budgets' },
          { text: '用哈希锁住计划', link: '/design/plan-hash' },
          { text: '拒绝优于降级', link: '/design/refuse-not-degrade' },
        ],
      },
      {
        text: '上线篇 — 交付、运行和出事以后',
        items: [
          { text: '这个项目是哪一类', link: '/launch/positioning' },
          { text: '构建、发布、更新、版本', link: '/launch/delivery' },
          { text: '灰度与回滚：可重建，不可回滚', link: '/launch/rollback' },
          { text: '埋点就是运行留痕', link: '/launch/observability' },
          { text: '三条真实事故的排障走查', link: '/launch/operating-the-tree' },
          { text: '如果它是一个产品', link: '/launch/if-it-were-a-product' },
        ],
      },
      {
        text: '诚实篇 — 它哪里还不够好',
        items: [
          { text: '已知缺陷登记表', link: '/honest/defects' },
          { text: '最锋利的三处', link: '/honest/sharpest' },
          { text: '如果要重写', link: '/honest/what-i-would-redo' },
        ],
      },
      {
        text: '附录',
        items: [
          { text: '术语表', link: '/appendix/glossary' },
          { text: '文件地图', link: '/appendix/file-map' },
          { text: '命令速查', link: '/appendix/commands' },
        ],
      },
    ],
    search: { provider: 'local' },
    docFooter: { prev: '上一页', next: '下一页' },
    darkModeSwitchLabel: '外观',
    sidebarMenuLabel: '目录',
    returnToTopLabel: '回到顶部',
    outlineLabel: '本页目录',
    footer: {
      message: 'myflow 0.3.0 · 一个只跑在 Pi 上的个人工作流外壳',
      copyright: '文档以 MIT 发布；文中所有缺陷都是真的。',
    },
  },
})
