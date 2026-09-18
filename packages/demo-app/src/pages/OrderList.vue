<template>
  <!-- @description 订单管理页：展示订单列表，支持按状态筛选、按用户过滤、查看订单详情 -->
  <div>
    <PageHeader title="订单管理" description="agent 可从用户详情带 userId 过来，或按状态筛选">
      <template #actions>
        <el-select
          v-model="status"
          placeholder="按状态筛选"
          clearable
          style="width: 160px"
          @change="onFilter"
        >
          <el-option label="待支付" value="pending" />
          <el-option label="已支付" value="paid" />
          <el-option label="已发货" value="shipped" />
          <el-option label="已完成" value="done" />
          <el-option label="已取消" value="canceled" />
        </el-select>
        <el-button size="small" link type="danger" @click="load('500')">模拟接口失败</el-button>
      </template>
    </PageHeader>

    <CapabilityBadge
      :items="['控制面 props', '直传 props 旁路', 'call_page_method', '观测面 report', 'emit 通知面']"
      hint="userId 可由 agent 直传（对象/标量走 pageProps 旁路），据此把「用户 → 订单」串起来"
    />

    <p v-if="filterHint" class="hint">{{ filterHint }}</p>

    <PageState
      :loading="loading"
      :error="error"
      :empty="!rows.length"
      empty-text="没有匹配的订单"
      @retry="load()"
    >
      <el-table :data="rows" border @row-click="onView">
        <el-table-column prop="id" label="订单号" width="130" />
        <el-table-column prop="customer" label="客户" width="120" />
        <el-table-column label="金额" width="120">
          <template #default="{ row }">￥{{ row.amount.toFixed(2) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)">{{ statusText(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="下单时间" width="170">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="100">
          <template #default="{ row }">
            <el-button size="small" @click.stop="onView(row)">详情</el-button>
          </template>
        </el-table-column>
      </el-table>
    </PageState>

    <el-drawer v-model="detailVisible" title="订单详情" size="360px">
      <el-descriptions v-if="detail" :column="1" border>
        <el-descriptions-item label="订单号">{{ detail.id }}</el-descriptions-item>
        <el-descriptions-item label="客户">{{ detail.customer }}</el-descriptions-item>
        <el-descriptions-item label="用户 id">{{ detail.userId }}</el-descriptions-item>
        <el-descriptions-item label="金额">￥{{ detail.amount.toFixed(2) }}</el-descriptions-item>
        <el-descriptions-item label="状态">
          <el-tag :type="statusTagType(detail.status)">{{ statusText(detail.status) }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="下单时间">{{ formatTime(detail.createdAt) }}</el-descriptions-item>
      </el-descriptions>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
// 订单管理 —— 演示「跨页链路」：agent 在用户列表拿到 id → 打开用户详情 → 带 userId 打开本页。
//
// 入参两种通道都用上了：
//   ① 声明 props 的标量：status（agent 可通过 props 传）
//   ② 直传 props 旁路：host 模式下 agent 传的任意字段会落在 useRuntimeServices().pageProps
//      （真实 router 承载不了对象，所以对象/额外标量走这里 —— 页面自己决定读不读）
import { computed, onMounted, ref, watch } from 'vue'
import { tryUseRuntimeServices } from '@webassistant/wc-runtime-vue'
import PageHeader from '../components/PageHeader.vue'
import PageState from '../components/PageState.vue'
import CapabilityBadge from '../components/CapabilityBadge.vue'
import { getOrder, listOrders } from '../api/orders'
import { reportData } from '../utils/httpClient'
import type { MockFail, Order, OrderStatus } from '../api/types'

const props = defineProps({
  /** 订单状态筛选（agent 可通过 props 传） */
  status: { type: String, default: '' },
  /** 只看某个用户的订单（agent 从用户页带过来） */
  userId: { type: [String, Number], default: '' },
})

const emit = defineEmits(['filter', 'view'])

const runtime = tryUseRuntimeServices()
/** 直传 props 旁路：agent 传的字段（host 模式有效；容器模式为空对象） */
const direct = computed<Record<string, unknown>>(() => runtime?.pageProps ?? {})

const status = ref<string>(props.status || String(direct.value.status ?? ''))
const rows = ref<Order[]>([])
const loading = ref(false)
const error = ref('')
const detail = ref<Order | null>(null)
const detailVisible = ref(false)

const userIdFilter = computed<string>(() => {
  const raw = props.userId || direct.value.userId
  return raw === '' || raw === undefined || raw === null ? '' : String(raw)
})

const filterHint = computed(() =>
  userIdFilter.value ? `已按用户过滤：userId=${userIdFilter.value}` : '',
)

const statusMap: Record<OrderStatus, { text: string; tag: 'warning' | 'primary' | 'success' | 'info' | 'danger' }> = {
  pending: { text: '待支付', tag: 'warning' },
  paid: { text: '已支付', tag: 'primary' },
  shipped: { text: '已发货', tag: 'success' },
  done: { text: '已完成', tag: 'success' },
  canceled: { text: '已取消', tag: 'info' },
}

const statusText = (value: OrderStatus): string => statusMap[value]?.text ?? value
const statusTagType = (value: OrderStatus) => statusMap[value]?.tag ?? 'info'

function formatTime(value: string): string {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
}

async function load(fail?: MockFail): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const list = await listOrders({ status: (status.value || undefined) as OrderStatus | undefined, fail })
    // userId 过滤放在前端（mock 只提供 status 过滤）——演示「props 影响展示」而不改接口契约
    rows.value = userIdFilter.value
      ? list.filter((order) => String(order.userId) === userIdFilter.value)
      : list
  } catch (cause) {
    const message = (cause as Error).message
    rows.value = []
    error.value = message
    // 不带 url：错误载荷要原样出网，不能走 dataSources 的字段白名单
    reportData('order-list-error', { message, url: '/api/orders' })
  } finally {
    loading.value = false
  }
}

function onFilter(): void {
  void load()
  emit('filter', status.value)
  runtime?.emit('filter', status.value)
}

/** 打开订单详情：再拉一次单条接口（演示「列表 → 详情」的两跳上报） */
async function onView(row: Order): Promise<void> {
  emit('view', row)
  try {
    detail.value = await getOrder(row.id)
    detailVisible.value = true
  } catch (cause) {
    error.value = (cause as Error).message
  }
}

// —— agent 可调用（只读 / 视图操作）——
// 只暴露「只读 / 视图操作」：筛选与打开详情都不写后端（本页没有写方法）。
/** agent 可调用（视图操作）：设置状态筛选并重新查询，返回条数 */
async function setStatus(next: string): Promise<number> {
  status.value = next ?? ''
  await load()
  return rows.value.length
}

/** agent 可调用（只读）：重新拉取列表，返回条数 */
async function refresh(): Promise<number> {
  await load()
  return rows.value.length
}

/** agent 可调用（只读）：打开某张订单的详情抽屉（等价于点行内「详情」；会再读一次单条接口），返回抽屉状态 */
async function openDetail(orderId: string): Promise<{ opened: boolean; id: string; status: string }> {
  const row = rows.value.find((item) => item.id === String(orderId))
  if (!row) throw new Error(`当前列表里没有订单 ${orderId}（可先用 setStatus / refresh 确认可见范围）`)
  await onView(row)
  return { opened: detailVisible.value, id: row.id, status: row.status }
}

defineExpose({ setStatus, refresh, openDetail })

watch(
  () => props.status,
  (next) => {
    if (next === undefined || next === status.value) return
    status.value = next
    void load()
  },
)

onMounted(() => void load())
</script>

<style scoped>
.hint {
  margin: 0 0 var(--app-space-3);
  padding: var(--app-space-2) var(--app-space-3);
  border-radius: var(--app-radius-sm);
  background: var(--app-primary-weak);
  color: #4338ca;
  font-size: 12px;
}
:deep(.el-table__row) {
  cursor: pointer;
}
</style>
