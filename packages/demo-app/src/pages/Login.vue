<script setup lang="ts">
// 登录页 —— 这是**宿主自己的路由，刻意不进 manifest**：
//   ① agent 看不到它、也不会被导航到它（页面目录之外的宿主路由由桥 passThrough 放行）
//   ② 守卫演示：站点设置（/settings）要求登录，未登录会被重定向到这里并带 redirect
//   ③ token 链路演示：登录写入宿主 pinia → services.getToken 现读 → 请求头带 Authorization
//
// ★ 本页不做任何 apiBus 上报（见 src/api/session.ts 的说明）：token 这类数据永远不出浏览器。
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { login } from '../api/session'
import { useAuthStore } from '../stores/authStore'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const name = ref('张三')
const pending = ref(false)
const error = ref('')

async function submit(): Promise<void> {
  pending.value = true
  error.value = ''
  try {
    const result = await login(name.value)
    auth.login(result)
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : ''
    await router.replace(redirect || { name: 'Dashboard' })
  } catch (cause) {
    error.value = (cause as Error).message
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <div class="login">
    <div class="card">
      <h1>登录演示后台</h1>
      <p class="hint">
        demo 后端不校验密码。登录后 token 写进宿主 store，页面请求会带上
        <code>Authorization: Bearer …</code>。
      </p>
      <el-form label-width="72px" @submit.prevent>
        <el-form-item label="账号">
          <el-input v-model="name" placeholder="准备用哪个身份登录" @keyup.enter="submit" />
        </el-form-item>
      </el-form>
      <p v-if="error" class="error">{{ error }}</p>
      <el-button type="primary" :loading="pending" @click="submit">登录</el-button>
    </div>
  </div>
</template>

<style scoped>
.login {
  display: flex;
  justify-content: center;
  padding-top: var(--app-space-6);
}
.card {
  width: min(420px, 100%);
  padding: var(--app-space-5);
  background: var(--app-surface);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius);
  box-shadow: var(--app-shadow);
}
.card h1 {
  margin: 0 0 var(--app-space-2);
  font-size: 18px;
}
.hint {
  margin: 0 0 var(--app-space-4);
  font-size: 12px;
  color: var(--app-text-muted);
  line-height: 1.7;
}
code {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--app-bg);
}
.error {
  margin: 0 0 var(--app-space-3);
  font-size: 12px;
  color: var(--app-danger);
}
</style>
