// 渲染面（用法）的归一化：`surface`（宿主 API）→ runtime 的渲染面。
// 拆成独立无依赖模块，便于单测（不拉起 vue / runtime）；与 lib/initialPage.ts 同款。
//
// 背景（为什么要这一层）：`surface` 与 `createRuntime` 是**同一件事的两种表达** ——
// 宿主给了 `createRuntime`（自己造 runtime）就必然是「宿主直连 / host」，不给则必然是「容器 / WC」。
// 归一化前有**两处**各自判断：
//   - `WebAssistant.vue` 判渲染区（`props.surface !== 'host'`）
//   - `useRuntimeHost` 判 init 挂载点（`options.createRuntime ? null : mountEl`）
// 两处口径不一致会漂移出**静默错配**：只给 `createRuntime`、忘给 `surface:'host'` 时，
// runtime 实际是 host 面（页面在宿主 <router-view> 渲染），面板却仍渲染一整列空的「渲染区域」，
// 且不报任何错。这里只推导一次，两处消费同一个结果。
//
// `surface` 显式传入时仍然优先：保留「自定义 createRuntime + 容器面」这个扩展位。
import type { RuntimeSurfaceKind } from '@webassistant/wc-runtime-vue/host'

/**
 * 推导渲染面：
 * - 显式 `surface` 优先
 * - 否则 `createRuntime` 存在 ⇒ `host`（宿主直连：runtime 由宿主注入）
 * - 否则 `container`（容器 / WC：chat-client 自己按 wcBase 拉 manifest + dist-ce）
 */
export function resolveSurfaceKind(
  surface: RuntimeSurfaceKind | undefined,
  createRuntime: unknown,
): RuntimeSurfaceKind {
  if (surface) return surface
  return createRuntime ? 'host' : 'container'
}
