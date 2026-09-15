// runtime 门面（装配器）：挑选渲染面（container / host）并把内核装起来。
//
// 本文件保持框架无关，且**不对外承诺**：宿主请用 @webassistant/wc-runtime-vue 的门面
// （createVueRuntime / createVueHostRuntime），它们只是把框架相关的渲染面实现传进来。
//
// 解耦后的职责分布（详见 openspec/changes/add-host-router-surface/design.md）：
//   kernel.ts           内核：导航真相源 + 服务/状态/事件/观测/留痕 + 页面目录 + 视图状态机
//   surfaceContainer.ts 容器渲染面：bundle + 自定义元素 + 容器（用法 A / WC）
//   surfaceHost.ts      宿主渲染面适配：真实 router（用法 B / 宿主直连）
import { createKernel } from './kernel.js'
import { createContainerSurface } from './surfaceContainer.js'
import { createHostPageSurface } from './surfaceHost.js'
import type { CreateRuntimeOptions, Runtime } from './types.js'

export function createRuntime(options: CreateRuntimeOptions): Runtime {
  const host = options.hostSurface
  if (options.surface === 'host' && !host) {
    throw new Error('createRuntime：surface 为 "host" 时必须提供 hostSurface（宿主渲染面实现）')
  }
  return createKernel({
    options,
    createSurface: (handles) =>
      options.surface === 'host' && host
        ? createHostPageSurface(host, handles)
        : createContainerSurface(options, handles),
  })
}
