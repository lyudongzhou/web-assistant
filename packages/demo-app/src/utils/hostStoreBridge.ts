// 宿主 store → 容器批次（CE）的**快照桥**推手。
//
// 只在「容器 / WC 模式」下有意义（页面跑在另一份 vue/pinia 副本里，靠快照镜像拿值）；
// 宿主直连模式（用法 B）下页面用的就是宿主自己的 store 实例，这里的推送是空转，无副作用。
//
// ★ 为什么 pusher 在 main.ts 里就要装到 pinia 上：
//   pinia 插件只对**装插件之后创建**的 store 生效；而 AppShell / 路由守卫在首屏就会创建 store，
//   若等到 dock 的 onMounted 再 `pinia.use(...)`，这些 store 就永远挂不上订阅（镜像不动）。
//   所以：插件在 main.ts 装，runtime 句柄这里懒取（首屏还没 init 完也没关系）。
import { createHostStorePusher, type HostRuntimeLike, type HostStoreLike } from '@webassistant/wc-runtime-vue/host'

let runtime: HostRuntimeLike | null = null

export const hostStorePusher = createHostStorePusher({
  getRuntime: () => runtime,
})

/** runtime 就绪时调用：记下句柄，并把已经存在的 store 立刻补推一次 */
export function attachRuntimeToStoreBridge(next: HostRuntimeLike | null, stores: HostStoreLike[] = []): void {
  runtime = next
  for (const store of stores) hostStorePusher.push(store)
}
