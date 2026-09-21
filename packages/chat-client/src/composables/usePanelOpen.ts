// 面板折叠 —— **过程区与计划卡共用的同一份收缩逻辑**（`add-interactive-plan-revision`）。
//
// 为什么不各写一份 ref：两处的折叠行为必须一致（点整行切换、换内容时是否重置、默认展开还是收起、
// 状态变化时是否跟随），各写一份就一定会漂移（本项目已经出现过"计划卡折叠态在 turnState、
// 过程区在组件 ref"的分叉）。这里只依赖 vue 的响应式原语（`ref` / `watch`），不碰组件生命周期
// —— 因此可以在 node 里直接单测。
import { ref, watch, type Ref } from 'vue'

export interface PanelOpen {
  /** 是否展开 */
  open: Ref<boolean>
  /** 切换（面板头的整行点击调它） */
  toggle: () => void
}

/**
 * @param defaultOpen 是否展开（缺省收起）。可以传 **getter**：默认值本身就是状态时用它
 *        （计划卡就是「待确认 = 展开 / 执行中 = 收起」）。默认值一变 `open` 就跟随到新默认值 ——
 *        "点了「开始执行」面板自动收成一行"因此不需要调用方自己 watch + 改 `open`。
 *        默认值**没变**时不动 `open`：用户手动折叠过的面板不会被无关的响应式触发弹回去。
 * @param resetKey 可选：内容身份（如计划卡用 `planId`）。**身份变化即回到默认值** ——
 *        比如"换了一份计划"要重新展开，而"同一份计划被修订"要保留用户收起的偏好。
 */
export function usePanelOpen(
  defaultOpen: boolean | (() => boolean) = false,
  resetKey?: () => string | number | undefined | null,
): PanelOpen {
  const resolve = (): boolean => (typeof defaultOpen === 'function' ? defaultOpen() : defaultOpen)
  const open = ref(resolve())
  // 静态默认值 + 无身份 = 纯手动折叠，不需要监听（也不白白多两个 watcher）
  if (typeof defaultOpen === 'function') {
    // watch 一个返回布尔值的 getter：值真的变了才回调（Vue 自己比 Object.is）
    watch(resolve, (value) => {
      open.value = value
    })
  }
  if (resetKey) {
    watch(resetKey, () => {
      open.value = resolve()
    })
  }
  return {
    open,
    toggle: () => {
      open.value = !open.value
    },
  }
}
