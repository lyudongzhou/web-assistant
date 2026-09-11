// pinia store 示例：页面通过 `import { useUserStore } from '../stores/userStore'` 使用。
// 容器在 plugins 里注入了 createPinia()，所以这个 store 在所有页面间共享同一实例。
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useUserStore = defineStore('user', () => {
  const name = ref('张三')
  const email = ref('zhangsan@example.com')
  const role = ref('管理员')

  const displayName = computed(() => `${name.value}（${role.value}）`)

  function setUser(next: { name: string; email: string; role: string }): void {
    name.value = next.name
    email.value = next.email
    role.value = next.role
  }

  return { name, email, role, displayName, setUser }
})
