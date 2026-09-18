<template>
  <!-- @description 站点设置页：编辑站点名称/语言/通知开关，演示宿主 store 镜像与 401 登录守卫链路 -->
  <div class="settings">
    <PageHeader :title="t('settings.title')" :description="t('settings.description')">
      <template #actions>
        <el-button size="small" type="primary" :loading="saving" @click="save()">
          {{ t('settings.save') }}
        </el-button>
      </template>
    </PageHeader>

    <CapabilityBadge
      :items="['宿主 store 镜像', 'services.t / $tt', '登录守卫 + 401', '观测面 report']"
      hint="本页在 manifest 之外要求登录（meta.requiresAuth）——所以 agent 打开它之前会先被守卫拦到登录页"
    />

    <PageState :loading="loading" :error="error" :empty="false" @retry="load()">
      <el-card shadow="never" class="card">
        <el-form label-width="110px">
          <el-form-item :label="t('settings.siteName')">
            <el-input v-model="form.siteName" />
          </el-form-item>
          <el-form-item :label="t('settings.locale')">
            <el-select v-model="form.locale" style="width: 100%" @change="onLocaleChange">
              <el-option label="简体中文" value="zh-CN" />
              <el-option label="English" value="en-US" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('settings.notify')">
            <el-switch v-model="form.notify" />
          </el-form-item>
          <el-form-item :label="t('settings.version')">
            <el-input :model-value="version" disabled />
          </el-form-item>
        </el-form>
        <p v-if="prefillHint" class="prefill">{{ prefillHint }}</p>
        <p class="hint">{{ t('settings.hint') }}</p>
        <p class="echo">
          services.t：<b>{{ t('settings.save') }}</b> / <b>{{ t('settings.saved') }}</b>
        </p>
        <p class="echo">
          宿主 store 镜像：<b>{{ auth.user ? `${auth.user.name}（${auth.user.role}）` : '未登录' }}</b>
          · token {{ auth.token ? `${auth.token.slice(0, 10)}…` : '（空）' }}
        </p>
        <p v-if="notice" class="notice">{{ notice }}</p>
      </el-card>
    </PageState>
  </div>
</template>

<script setup lang="ts">
// 站点设置 —— 四条链路叠在一页：
//   ① 登录守卫：路由 meta.requiresAuth → 未登录跳 /login（**宿主自己的守卫**，agent 也受它约束）
//   ② 401 链路：GET /api/settings 需要 Authorization，token 来自宿主 store（services.getToken）
//   ③ store 镜像：页面直接用 useAuthStore() / useAppStore()，容器模式下由宿主快照桥推值
//   ④ services.t：文案不写死，走宿主注入的翻译函数（切换语言即时生效）
import { onMounted, ref } from 'vue'
import { tryUseRuntimeServices } from '@webassistant/wc-runtime-vue'
import PageHeader from '../components/PageHeader.vue'
import PageState from '../components/PageState.vue'
import CapabilityBadge from '../components/CapabilityBadge.vue'
import { getSettings, updateSettings } from '../api/settings'
import { AGENT_PREFILL_HINT, hasAgentPreset, mergeAgentPreset, prefillReceipt } from '../utils/agentPreset'
import type { AgentPrefillReceipt } from '../utils/agentPreset'
import { useAuthStore } from '../stores/authStore'
import { useAppStore } from '../stores/appStore'
import { translate } from '../utils/i18n'
import type { AppSettings, Locale, SettingsForm } from '../api/types'

const ctx = tryUseRuntimeServices()
const auth = useAuthStore()
const app = useAppStore()

const loading = ref(false)
const saving = ref(false)
const error = ref('')
const notice = ref('')

/** 表单只装可编辑项；version 是服务端只读项，单独放（不进 agent 的预填合同） */
const DEFAULT_SETTINGS_FORM: SettingsForm = { siteName: '', locale: 'zh-CN', notify: true }
const form = ref<SettingsForm>({ ...DEFAULT_SETTINGS_FORM })
const version = ref('—')
const prefillHint = ref('')

/** 宿主注入的翻译函数；没挂助手（纯 SPA）时退回本地字典 */
function t(key: string): string {
  return ctx ? ctx.t(key) : translate(app.locale, key)
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const settings = await getSettings()
    form.value = { siteName: settings.siteName, locale: settings.locale, notify: settings.notify }
    version.value = settings.version
    app.setLocale(settings.locale)
    app.setSiteName(settings.siteName)
  } catch (cause) {
    error.value = (cause as Error).message
  } finally {
    loading.value = false
  }
}

function onLocaleChange(next: Locale): void {
  app.setLocale(next)
}

/** 保存（只给人点「保存」走）—— agent 侧未 expose：助手只预填，提交由用户完成 */
async function save(): Promise<AppSettings> {
  saving.value = true
  notice.value = ''
  try {
    const saved = await updateSettings(form.value)
    form.value = { siteName: saved.siteName, locale: saved.locale, notify: saved.notify }
    version.value = saved.version
    app.setLocale(saved.locale)
    app.setSiteName(saved.siteName)
    notice.value = t('settings.saved')
    return saved
  } catch (cause) {
    error.value = (cause as Error).message
    throw cause
  } finally {
    saving.value = false
  }
}

// —— agent 可调用（只读 / 预填）——
/** agent 可调用（只读）：重新拉取站点设置，返回可编辑项快照 */
async function refresh(): Promise<SettingsForm> {
  await load()
  return { ...form.value }
}

/** agent 可调用（只预填、不提交）：把 preset 填进设置表单（以当前值为底，只覆盖显式传入的字段），返回表单快照 —— 语言即时生效但不写后端，保存仍由用户点「保存」（save 未 expose） */
function fillSettingsForm(preset?: Partial<SettingsForm>): AgentPrefillReceipt<SettingsForm> {
  form.value = mergeAgentPreset(form.value, preset)
  app.setLocale(form.value.locale)
  prefillHint.value = hasAgentPreset(preset) ? AGENT_PREFILL_HINT : ''
  return prefillReceipt('站点设置', form.value)
}

defineExpose({ refresh, fillSettingsForm })

onMounted(() => void load())
</script>

<style scoped>
.settings {
  max-width: 620px;
}
.card :deep(.el-card__body) {
  padding-bottom: var(--app-space-3);
}
.prefill {
  margin: 0 0 var(--app-space-2);
  padding: var(--app-space-2) var(--app-space-3);
  border-radius: var(--app-radius-sm);
  background: var(--app-primary-weak);
  color: #4338ca;
  font-size: 12px;
}
.hint,
.echo {
  margin: 0 0 var(--app-space-2);
  font-size: 12px;
  color: var(--app-text-muted);
}
.notice {
  margin: 0;
  font-size: 12px;
  color: var(--app-success);
}
</style>
