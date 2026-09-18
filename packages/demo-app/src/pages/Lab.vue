<template>
  <!-- @description 能力验收室：集中演示容器隔离下才会暴露的问题（浮层样式、CSS-in-JS 注入、3D 图谱） -->
  <div>
    <PageHeader
      title="能力验收室"
      description="原先散在业务页里的探针都集中在这里 —— 业务页保持干净，验收能力一条不丢"
    >
      <template #actions>
        <el-button size="small" @click="reloadGraph()">重建 3D 图</el-button>
      </template>
    </PageHeader>

    <CapabilityBadge
      :items="['容器 shadow 隔离', 'styleShim 样式落点桥', 'element-plus 浮层', 'runtime 状态']"
      hint="这些探针只有在「容器 / WC 模式」（/assistant）里才有说服力；宿主直连模式下照旧只进 document.head"
    />

    <el-card shadow="never" class="card">
      <template #header><span class="card-title">runtime 状态（只读）</span></template>
      <ul class="facts">
        <li>
          apiBus：<b>{{ apiState.attached ? '已挂载 sink（上报会被转发）' : '没有 sink（上报会被丢弃）' }}</b>
        </li>
        <li>当前页 tag：<b>{{ apiState.tag ?? '（空态）' }}</b></li>
        <li>当前页 expose：<b>{{ apiState.exposed.join('、') || '（无）' }}</b></li>
        <li>最近上报（来自执行监视）：<b>{{ apiState.lastReport || '（暂无）' }}</b></li>
      </ul>
      <p class="hint">
        数据来源：<code>globalThis['webassistant.apiBus']</code>（全局单例）+ 面板的
        <code>__waRuntime</code> / <code>__waActivities</code> 调试句柄（仅在 debug 模式挂载）。
      </p>
    </el-card>

    <el-card shadow="never" class="card">
      <template #header>
        <span class="card-title">element-plus 浮层样式（teleport 到 body 的泄漏点）</span>
      </template>
      <div class="row">
        <span class="label">非 scoped 样式（容器里靠 lightDomStyles 补一份才生效）：</span>
        <el-dropdown popper-class="popper-ok">
          <el-button type="primary">打开菜单</el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item>选项一</el-dropdown-item>
              <el-dropdown-item>选项二</el-dropdown-item>
              <el-dropdown-item disabled>选项三</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
      <div class="row">
        <span class="label">scoped :deep()（编译成 [data-v-x] 前缀 → 浮层命中不了，SPA / WC 都一样）：</span>
        <el-dropdown popper-class="popper-bad">
          <el-button>打开菜单</el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item>选项一</el-dropdown-item>
              <el-dropdown-item>选项二</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </el-card>

    <el-card shadow="never" class="card">
      <template #header>
        <span class="card-title">CSS-in-JS 注入（styleShim 的两条路径）</span>
      </template>
      <div id="cssinjs-probe" class="cssinjs-probe-direct probe">
        这一块的边框 / 背景由「裸 document 注入」的样式决定：
        <b>P1</b> appendChild、<b>P2</b> insertRule 走 styleShim 镜像进 shadow root（虚线绿框 + 浅绿底）；
        而**页面自己**直写的 document（红框）不在 styleShim 名单里，容器模式下不会进 shadow。
      </div>
    </el-card>

    <el-card shadow="never" class="card">
      <template #header>
        <span class="card-title">3D 力导向图（真实第三方依赖的运行时样式注入）</span>
      </template>
      <div ref="graphHost" class="graph"></div>
      <p class="hint">
        <code>3d-force-graph</code> / <code>three-render-objects</code> 在**模块求值期**往 document.head
        注入样式；容器模式下必须靠 styleShim 映射进 shadow root，否则 canvas 上的交互提示与结构样式丢失。
      </p>
    </el-card>
  </div>
</template>

<script setup lang="ts">
// 能力验收室 —— 这里放的是「换个用法就会坏掉」的东西，业务页不该出现它们：
//   ① runtime / apiBus 只读状态：一眼看出上报有没有被监听（这是排查「数据没到 agent」的第一现场）
//   ② element-plus 浮层样式：UI 库 teleport 到 body 的已知泄漏点，容器模式靠 lightDomStyles 补
//   ③ CSS-in-JS 注入：styleShim 的两条注入路径 + 页面直写 document 的对照项
//   ④ 3D 力导向图：真实依赖在模块求值期注入样式，容器模式下必须映射进 shadow root
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import ForceGraph3D from '3d-force-graph'
import PageHeader from '../components/PageHeader.vue'
import CapabilityBadge from '../components/CapabilityBadge.vue'
import { injectByAppendChild, injectByInsertRule } from '../vendor/fakeCssInJs'

/** runtime 调试句柄的形状（只在 debug 模式下由面板挂上，取不到就显示空态） */
interface RuntimeHandle {
  view?: { tag?: string | null }
  getPageExposed?: () => Record<string, unknown> | null | undefined
}
interface ActivityRecord {
  kind: string
  name?: string
  tag?: string
  args?: unknown
}

const apiState = reactive({
  attached: false,
  tag: null as string | null,
  exposed: [] as string[],
  lastReport: '',
})

let graph: { _destructor: () => void } | null = null
const graphHost = ref<HTMLElement | null>(null)

const globalScope = globalThis as Record<string, unknown>

/** 读取 runtime / apiBus 的只读状态（每次调用现取，句柄可能是后来才挂上的） */
function readRuntimeState(): void {
  const bus = globalScope['webassistant.apiBus'] as { listener?: unknown } | undefined
  apiState.attached = Boolean(bus?.listener)

  const runtime = globalScope['__waRuntime'] as RuntimeHandle | null | undefined
  apiState.tag = runtime?.view?.tag ?? null
  const exposed = runtime?.getPageExposed?.()
  apiState.exposed = exposed ? Object.keys(exposed) : []

  const activities = (globalScope['__waActivities'] as ActivityRecord[] | undefined) ?? []
  const lastData = activities.find((item) => item.kind === 'data')
  apiState.lastReport = lastData
    ? `${lastData.tag ?? '—'} · ${lastData.name ?? '—'}`
    : ''
}

function buildGraph(): void {
  if (!graphHost.value) return
  graph?._destructor()
  graph = new ForceGraph3D(graphHost.value)
    .backgroundColor('#0b1020')
    .graphData({
      nodes: [{ id: 'runtime' }, { id: 'apiBus' }, { id: 'manifest' }, { id: 'agent' }],
      links: [
        { source: 'agent', target: 'manifest' },
        { source: 'manifest', target: 'runtime' },
        { source: 'runtime', target: 'apiBus' },
        { source: 'apiBus', target: 'agent' },
      ],
    })
}

function reloadGraph(): void {
  buildGraph()
}

/** 状态卡每 2 秒自刷新（上报是异步发生的，静态快照看不出「刚刚有没有到」） */
let pollTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  // 两条 CSS-in-JS 注入路径（容器模式下会被 styleShim 镜像进 shadow root）
  injectByAppendChild('.cssinjs-probe-p1{outline:3px dashed rgb(22,163,74)}')
  injectByInsertRule('#cssinjs-probe{background:rgb(240,253,244)}')

  // 对照项：页面自身直写 document —— 不在 styleShim.packages 名单里，容器模式下**不会**进 shadow root
  const direct = document.createElement('style')
  direct.textContent = '.cssinjs-probe-direct{outline:3px solid rgb(220,38,38)}'
  document.head.appendChild(direct)

  buildGraph()
  readRuntimeState()
  pollTimer = setInterval(readRuntimeState, 2_000)
})

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  graph?._destructor()
  graph = null
})
</script>

<style scoped>
.card {
  margin-bottom: var(--app-space-4);
  border-radius: var(--app-radius);
}
.card-title {
  font-size: 14px;
  font-weight: 600;
}
.facts {
  margin: 0 0 var(--app-space-2);
  padding-left: 18px;
  font-size: 13px;
  color: var(--app-text-secondary);
}
.row {
  display: flex;
  align-items: center;
  gap: var(--app-space-3);
  flex-wrap: wrap;
  margin-bottom: var(--app-space-3);
}
.label {
  font-size: 12px;
  color: var(--app-text-muted);
}
.probe {
  padding: var(--app-space-3);
  border-radius: var(--app-radius-sm);
  background: var(--app-surface);
  font-size: 13px;
  line-height: 1.8;
}
.graph {
  width: 100%;
  height: 360px;
  border-radius: var(--app-radius-sm);
  overflow: hidden;
}
.hint {
  margin: var(--app-space-3) 0 0;
  font-size: 12px;
  color: var(--app-text-muted);
  line-height: 1.7;
}
code {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--app-bg);
}
</style>

<!-- 非 scoped：容器模式下 lightDomStyles 会补一份到光 DOM，teleport 到 body 的浮层才命中 -->
<style>
.popper-ok {
  background: #312e81 !important;
  border: 2px solid #7c3aed !important;
}
.popper-ok .el-dropdown-menu__item {
  color: #fbbf24;
  font-size: 18px;
}
.popper-ok .el-dropdown-menu__item:hover {
  background: #7c3aed;
  color: #fff;
}
</style>

<!-- scoped :deep()：编译成 [data-v-xxx] .popper-bad …，浮层节点不带 data-v-xxx 祖先 → 命中不了 -->
<style scoped>
:deep(.popper-bad) {
  background: #312e81 !important;
}
:deep(.popper-bad .el-dropdown-menu__item) {
  color: #fbbf24 !important;
  font-size: 18px !important;
}
</style>
