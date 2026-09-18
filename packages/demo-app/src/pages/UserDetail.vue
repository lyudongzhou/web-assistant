<template>
  <!-- @description 用户详情页：按 id 展示并编辑单个用户的姓名、邮箱、角色，支持保存 -->
  <div class="detail">
    <PageHeader
      :title="heading"
      description="详情页：路由参数 id 决定拉谁；保存结果会回报给 agent"
    >
      <template #actions>
        <el-button size="small" @click="router.back()">返回列表</el-button>
      </template>
    </PageHeader>

    <CapabilityBadge
      :items="['路由参数 props', '直传 props 旁路', 'call_page_method', '观测面 report']"
      hint="host 模式的对象直传走 useRuntimeServices().pageProps（真实 router 承载不了对象）"
    />

    <PageState :loading="loading" :error="error" :empty="false" @retry="reload()">
      <el-card shadow="never">
        <el-form label-width="88px">
          <el-form-item label="ID">
            <el-input :model-value="resolvedId || '—'" disabled />
          </el-form-item>
          <el-form-item label="姓名">
            <el-input v-model="form.name" />
          </el-form-item>
          <el-form-item label="邮箱">
            <el-input v-model="form.email" />
          </el-form-item>
          <el-form-item label="角色">
            <el-select v-model="form.role" style="width: 100%">
              <el-option label="管理员" value="管理员" />
              <el-option label="普通用户" value="普通用户" />
              <el-option label="访客" value="访客" />
            </el-select>
          </el-form-item>
          <el-form-item label="最近登录">
            <span class="muted">{{ form.lastLoginAt || '—' }}</span>
          </el-form-item>
        </el-form>
        <div class="actions">
          <el-button type="primary" :loading="saving" @click="onSave">保存</el-button>
          <span v-if="notice" class="notice">{{ notice }}</span>
          <span v-if="prefillHint" class="prefill">{{ prefillHint }}</span>
        </div>
      </el-card>
    </PageState>
  </div>
</template>

<script setup lang="ts">
// 用户详情 —— 演示三种「入参通道」合一：
//   ① 路由参数：useRoute().params.id（容器模式内部 memory router / host 模式真实 router 都成立）
//   ② 声明 props：agent 可直接传 id
//   ③ 直传 props 旁路：agent 传**对象**时只能走 useRuntimeServices().pageProps
//      （真实 router 承载不了对象，见 PROJECT.md 6.9 的能力对照表）
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { tryUseRuntimeServices } from '@webassistant/wc-runtime-vue'
import PageHeader from '../components/PageHeader.vue'
import PageState from '../components/PageState.vue'
import CapabilityBadge from '../components/CapabilityBadge.vue'
import { getUser, updateUser } from '../api/users'
import { AGENT_PREFILL_HINT, hasAgentPreset, mergeAgentPreset, prefillReceipt } from '../utils/agentPreset'
import type { AgentPrefillReceipt } from '../utils/agentPreset'
import type { User, UserEditForm, UserRole } from '../api/types'

const props = defineProps({
  /** 用户 id（agent 直传；不给则读当前路由参数） */
  id: { type: [String, Number], default: '' },
})

const emit = defineEmits(['save'])

const route = useRoute()
const router = useRouter()
const runtime = tryUseRuntimeServices()

/** 直传 props 旁路（host 模式由 createVueHostSurface 写入；容器模式恒为空对象） */
const pageProps = computed<Record<string, unknown>>(() => runtime?.pageProps ?? {})

/** 直传的完整用户对象：agent 已经有一份数据时可直接给对象，页面就不必再请求 */
const injectedUser = computed<User | undefined>(() => {
  const injected = pageProps.value.user
  return injected && typeof injected === 'object' ? (injected as User) : undefined
})

const loading = ref(false)
const saving = ref(false)
const error = ref('')
const notice = ref('')
const prefillHint = ref('')
/** 预填生效时的用户 id：同一个人身上的预填不会被随后的接口回填覆盖（换个人自动失效） */
const prefilledFor = ref('')

const form = reactive<Partial<User>>({
  name: '',
  email: '',
  role: '普通用户' as UserRole,
  lastLoginAt: '',
})

const resolvedId = computed<string>(() => {
  const raw = props.id ?? route.params.id ?? pageProps.value.id
  if (raw === '' || raw === undefined || raw === null) return ''
  return String(raw)
})

const heading = computed(() => (resolvedId.value ? `用户详情 · #${resolvedId.value}` : '用户详情'))

async function load(id: string): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const user = await getUser(id)
    if (prefilledFor.value !== id) Object.assign(form, user)
  } catch (cause) {
    error.value = (cause as Error).message
  } finally {
    loading.value = false
  }
}

function reload(): void {
  if (resolvedId.value) void load(resolvedId.value)
}

/** 保存并返回保存后的对象 —— 只给人点「保存」走；agent 侧未 expose（助手只填不交） */
async function save(): Promise<Partial<User>> {
  saving.value = true
  notice.value = ''
  try {
    const saved = await updateUser(resolvedId.value, {
      name: form.name,
      email: form.email,
      role: form.role,
    })
    Object.assign(form, saved)
    notice.value = '已保存'
    return saved
  } catch (cause) {
    error.value = (cause as Error).message
    throw cause
  } finally {
    saving.value = false
  }
}

/** 「保存」按钮：保存并按通知面发 save 事件（agent 只能通过观测面看到结果） */
function onSave(): void {
  const snapshot = { ...form }
  void save()
  emit('save', snapshot)
  runtime?.emit('save', snapshot)
}

// —— agent 可调用（只读 / 导航 / 预填）——
/** agent 可调用（只读）：重新拉取当前用户资料，返回 id / name / role（email 不出网，与数据源清单同口径） */
async function refresh(): Promise<{ id: string; name: string; role: string }> {
  prefilledFor.value = ''
  if (resolvedId.value) await load(resolvedId.value)
  return { id: resolvedId.value, name: form.name ?? '', role: form.role ?? '' }
}

/** agent 可调用（导航）：回用户列表（直接 push，比「返回」按钮更确定，不受 history 顺序影响） */
function backToList(): string {
  void router.push({ name: 'UserList' })
  return 'UserList'
}

/** agent 可调用（只预填、不提交）：把 preset 填进资料表单（以当前值为底，只覆盖显式传入的字段），返回表单快照 —— 写入仍由用户点「保存」（save 未 expose） */
function fillEditForm(preset?: Partial<UserEditForm>): AgentPrefillReceipt<UserEditForm> {
  const merged = mergeAgentPreset<UserEditForm>(
    { name: form.name ?? '', email: form.email ?? '', role: form.role ?? '普通用户' },
    preset,
  )
  Object.assign(form, merged)
  prefilledFor.value = resolvedId.value
  prefillHint.value = hasAgentPreset(preset) ? AGENT_PREFILL_HINT : ''
  return prefillReceipt('用户资料', merged)
}

defineExpose({ refresh, backToList, fillEditForm })

watch(
  () => [resolvedId.value, injectedUser.value?.id] as const,
  () => {
    // 直传对象优先：agent 已经给了完整数据就不必再请求
    if (injectedUser.value) {
      Object.assign(form, injectedUser.value)
      error.value = ''
      return
    }
    if (resolvedId.value) void load(resolvedId.value)
    else error.value = '缺少用户 id'
  },
  { immediate: true },
)
</script>

<style scoped>
.prefill {
  padding: var(--app-space-2) var(--app-space-3);
  border-radius: var(--app-radius-sm);
  background: var(--app-primary-weak);
  color: #4338ca;
  font-size: 12px;
}
.detail {
  max-width: 560px;
}
.actions {
  display: flex;
  align-items: center;
  gap: var(--app-space-3);
  padding-left: 88px;
}
.notice {
  font-size: 12px;
  color: var(--app-success);
}
.muted {
  color: var(--app-text-muted);
}
</style>
