<template>
  <!-- @description 工作台：展示用户总数、订单数、成交额等指标卡与近 7 日趋势，支持按关键词高亮指标、刷新数据 -->
  <div>
    <PageHeader title="工作台" description="只读聚合指标：打开页面即上报给 agent（调用点显式 report）">
      <template #actions>
        <el-button size="small" :loading="loading" @click="refresh()">刷新</el-button>
        <el-button size="small" link type="danger" @click="load('500')">模拟接口失败</el-button>
      </template>
    </PageHeader>

    <CapabilityBadge
      :items="['观测面 report', 'call_page_method', 'emit 通知面']"
      hint="指标数据在页面 onMounted 后显式上报；expose 的 refresh() 供 agent 兜底重取"
    />

    <PageState :loading="loading" :error="error" :empty="false" @retry="load()">
      <section class="cards">
        <el-card
          v-for="card in visibleStats"
          :key="card.key"
          shadow="hover"
          :class="{ highlight: matched }"
          @click="onStatClick(card.key)"
        >
          <div class="value">{{ card.value }}</div>
          <div class="label">{{ card.label }}</div>
        </el-card>
      </section>

      <el-card class="trend" shadow="never">
        <template #header>
          <span class="trend-title">近 7 日趋势</span>
          <span class="trend-time">更新于 {{ updatedAtText }}</span>
        </template>
        <el-table :data="trend" size="small">
          <el-table-column prop="date" label="日期" width="120" />
          <el-table-column prop="orders" label="订单数" width="100" />
          <el-table-column prop="gmv" label="成交额" />
        </el-table>
      </el-card>
    </PageState>
  </div>
</template>

<script setup lang="ts">
// 工作台 —— 演示「观测面：调用点显式上报」。
//
// agent 看到什么：本页 pull 完 /api/stats/overview 后，调用点自己挑字段 reportData('dashboard', …)。
// 这一页**没有**声明 dataSources（对比「用户管理」页：原始响应直接上报 + 由清单里的白名单裁剪）。
// 两种方式都合法，取舍是：边界写在代码里 vs 边界写在清单里。
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import PageHeader from '../components/PageHeader.vue'
import PageState from '../components/PageState.vue'
import CapabilityBadge from '../components/CapabilityBadge.vue'
import { getOverview } from '../api/dashboard'
import { reportData } from '../utils/httpClient'
import type { DashboardOverview, MockFail } from '../api/types'

const props = defineProps({
  /** 指标关键词（agent 通过 props 传入：只展示名字里含该词的指标卡） */
  keyword: { type: String, default: '' },
})

const emit = defineEmits(['stat-click'])

const router = useRouter()
const loading = ref(false)
const error = ref('')
const overview = ref<DashboardOverview | null>(null)

const trend = computed(() => overview.value?.trend ?? [])

/** 关键词本地态：props（控制面）与 agent 的 setKeyword() 都落到它上面上 */
const localKeyword = ref(props.keyword)

const matched = computed(() => localKeyword.value.trim().length > 0)

const visibleStats = computed(() => {
  const stats = overview.value?.stats ?? []
  const keyword = localKeyword.value.trim().toLowerCase()
  if (!keyword) return stats
  const filtered = stats.filter((stat) => stat.label.toLowerCase().includes(keyword))
  return filtered.length ? filtered : stats
})

const updatedAtText = computed(() => {
  const at = overview.value?.updatedAt
  if (!at) return '—'
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
})

async function load(fail?: MockFail): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    overview.value = await getOverview({ fail })
  } catch (cause) {
    const message = (cause as Error).message
    error.value = message
    // 失败也上报：否则 agent 会一直「等数据」，不知道接口已经挂了。
    // ⚠️ 故意**不带 url**：带 url 会命中 dataSources 的字段白名单（{message} 会被裁空），
    //    错误载荷要原样出网 —— 这也是「带不带 url」的一个实际取舍点。
    reportData('dashboard-error', { message, url: '/api/stats/overview' })
  } finally {
    loading.value = false
  }
}

/** 指标卡 → 目标页（点卡片与 agent 的 openStat 共用同一张表） */
const STAT_TARGETS: Record<string, string> = { users: 'UserList', orders: 'OrderList' }

/** 点击指标卡：emit 给宿主/agent（通知面），并按业务规则跳到对应列表页（老代码 router.push 原样） */
function onStatClick(key: string): void {
  emit('stat-click', { key })
  const name = STAT_TARGETS[key]
  if (name) void router.push({ name })
}

// —— agent 可调用（只读 / 视图操作 / 导航；本页没有写方法）——
/** agent 可调用（只读）：重新拉取指标并上报，返回指标条数 */
async function refresh(): Promise<number> {
  await load()
  return visibleStats.value.length
}

/** agent 可调用（视图操作）：设置指标关键词（等价于 agent 传 props.keyword），返回当前展示的指标卡 */
function setKeyword(keyword: string): { keyword: string; labels: string[] } {
  localKeyword.value = typeof keyword === 'string' ? keyword : ''
  return { keyword: localKeyword.value, labels: visibleStats.value.map((stat) => stat.label) }
}

/** agent 可调用（导航）：打开某张指标卡对应的列表页（等价于点指标卡），返回目标路由名 */
function openStat(key: string): { key: string; target: string; labels: string[] } {
  const target = STAT_TARGETS[key] ?? ''
  if (!target) throw new Error(`指标卡 ${key} 没有对应页面（可用：users / orders）`)
  onStatClick(key)
  return { key, target, labels: visibleStats.value.map((stat) => stat.label) }
}

defineExpose({ refresh, setKeyword, openStat })

// agent 传 props.keyword 变化时同步本地关键词（控制面入口优先）
watch(
  () => props.keyword,
  (next) => {
    if (next === undefined) return
    localKeyword.value = next
  },
)

onMounted(() => void load())
</script>

<style scoped>
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--app-space-4);
  margin-bottom: var(--app-space-4);
}
.cards :deep(.el-card) {
  cursor: pointer;
  border-radius: var(--app-radius);
}
.cards :deep(.el-card.highlight) {
  border-color: var(--app-primary);
}
.value {
  font-size: 24px;
  font-weight: 700;
  color: var(--app-text);
}
.label {
  margin-top: var(--app-space-2);
  font-size: 13px;
  color: var(--app-text-muted);
}
.trend :deep(.el-card__header) {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.trend-title {
  font-size: 14px;
  font-weight: 600;
}
.trend-time {
  font-size: 12px;
  color: var(--app-text-muted);
}
</style>
