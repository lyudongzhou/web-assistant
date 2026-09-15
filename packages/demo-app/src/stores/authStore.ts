// 宿主业务 store 示例（token / 用户）—— 演示「宿主 pinia 的数据怎么进 CE 页面」。
//
// 关键点：宿主与 CE 是**两份 vue/pinia 副本**，不共享实例（共享了也不会响应式更新，
// 依赖收集跨副本不互通）。数据走**快照桥**单向镜像：
//   宿主侧：createHostStorePusher(...).plugin 挂在宿主 pinia 上 → 每个 store 变更即 runtime.setState
//   CE 侧：容器 plugins 里的 createStoreMirror() → 把 `store:auth` 快照 hydrate 进本批 pinia 的同名 store
// 于是页面里 `useAuthStore().token` 一行不改就有值（拿到的是镜像值）。
//
// 详见 docs/INTEGRATION_GUIDE.md「宿主 store 里的数据怎么进 CE」。
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

export interface AuthUser {
  name: string
  role: string
}

export const useAuthStore = defineStore('auth', () => {
  const token = ref('')
  const user = ref<AuthUser | null>(null)

  /**
   * ⚠️ 派生值（computed）**不在 `$state` 里**，所以不会被镜像到 CE。
   * 页面要用「是否登录」，请用 `token !== ''` 自己算，或让宿主把派生值也放进 state。
   */
  const loggedIn = computed(() => token.value !== '')

  function login(payload: { token: string; user: AuthUser }): void {
    token.value = payload.token
    user.value = payload.user
  }

  function logout(): void {
    token.value = ''
    user.value = null
  }

  return { token, user, loggedIn, login, logout }
})
