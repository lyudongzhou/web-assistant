<template>
  <!-- 用法 B 的面板 = 库里的 <HostAssistantDock>（chat-client 导出）+ 本 demo 的三样私货。
       库组件负责其余全部：socket / 对话 / 状态行 / 「本轮动作」时间线 / 收起展开。
       ⚠️ 挂在 App.vue 的 <router-view> **之外**：挂路由组件里的话 agent 一导航面板自己就被卸载。 -->
  <HostAssistantDock
    :create-runtime="createRuntime"
    :services="services"
    title="WebAssistant"
    badge="用法 B · 宿主直连"
    placeholder="试试：打开用户列表，找一下李四"
    :suggestions="SUGGESTIONS"
    hello-title="让助手替你操作这个后台"
    hello-hint="页面在宿主自己的位置打开；助手只做「打开 / 预填 / 翻页 / 筛选」，提交永远由你点。"
    debug
    :on-runtime-ready="onRuntimeReady"
  />
</template>

<script setup lang="ts">
// 本文件只做三件 demo 私事（其余都在库的 <HostAssistantDock> 里）：
//   ① 用 createVueHostRuntimeBinding 造 runtime（agent 导航 = 改宿主真实 router）
//   ② 把 runtime 就绪告诉 store 快照桥（容器模式的页面靠它拿到宿主 pinia 的值）
//   ③ 挂控制台句柄 __waHostRuntime（/lab 验收室与手动排查用）
//
// 第三方接入**不需要**这一层：直接把 `<HostAssistantDock :create-runtime>` 挂到布局外壳即可
// （见 docs/INTEGRATION_GUIDE.md §9）。这里保留是因为 demo 要演示「宿主自己的扩展点」——
// 也就是 `onRuntimeReady` 这个口子。
import { getCurrentInstance, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { createVueHostRuntimeBinding } from '@webassistant/wc-runtime-vue/host-router'
import { HostAssistantDock } from '@webassistant/chat-client'
import type { Runtime } from '@webassistant/wc-runtime-vue/host'
import { useAuthStore } from '../stores/authStore'
import { useAppStore } from '../stores/appStore'
import { hostServices } from '../utils/hostServices'
import { attachRuntimeToStoreBridge } from '../utils/hostStoreBridge'

const router = useRouter()
// binding 要把 runtime context provide 进**宿主 app**，页面才能用 useRuntimeServices()
const app = getCurrentInstance()?.appContext.app
/** 宿主能力（纯函数，按需现读）—— runtime 与面板共用同一份 */
const services = hostServices()

/** 空态建议：都对应本 demo 已有能力（翻页 / 预填 / 跨页导航），点一下就能看到效果 */
const SUGGESTIONS = [
  '打开用户列表，找一下李四',
  '帮我新增一个 MySQL 数据源',
  '看看用户列表下一页',
]

/** 当前挂着的 host runtime（控制台句柄 __waHostRuntime 读它） */
let liveRuntime: Runtime | null = null

// 只给 createRuntime（不给 surface）⇒ 渲染面缺省推导为 'host'（chat-client 的 lib/surface.ts）
const { createRuntime } = createVueHostRuntimeBinding({ router, app, services })

function onRuntimeReady(runtime: Runtime): void {
  liveRuntime = runtime
  // 控制台句柄用宿主自己的名字（避开 chat-client 的 __waRuntime —— 那个是「最后挂的赢」，
  // 同页可能有第二个 runtime，来回切模式时容易点到已 dispose 的实例）
  Object.defineProperty(globalThis, '__waHostRuntime', { configurable: true, get: () => liveRuntime })
  // store 快照桥：记下 runtime 并把已存在的 store（首屏就创建了）立刻补推一次
  attachRuntimeToStoreBridge(runtime, [useAuthStore(), useAppStore()])
}

onUnmounted(() => {
  // 只摘掉**本实例**挂的句柄（同页可能有第二个 runtime，见上）
  if (Reflect.get(globalThis, '__waHostRuntime') === liveRuntime) {
    Reflect.deleteProperty(globalThis, '__waHostRuntime')
  }
  attachRuntimeToStoreBridge(null)
  liveRuntime = null
})
</script>
