<template>
  <!-- @description 订单管理页，展示所有订单，支持按状态筛选和查看订单详情 -->
  <div class="order-list">
    <div class="order-header">
      <h2 class="order-title">订单管理</h2>
      <el-select v-model="status" placeholder="按状态筛选" clearable style="width: 180px;" @change="onFilter">
        <el-option label="待支付" value="pending" />
        <el-option label="已支付" value="paid" />
        <el-option label="已完成" value="done" />
        <el-option label="已取消" value="canceled" />
      </el-select>
    </div>

    <el-table :data="filteredOrders" border>
      <el-table-column prop="id" label="订单号" width="140" />
      <el-table-column prop="customer" label="客户" />
      <el-table-column prop="amount" label="金额" width="120" />
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="statusTagType(row.status)">{{ statusText(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="120">
        <template #default="{ row }">
          <el-button size="small" @click="onView(row)">详情</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, type PropType } from 'vue'

interface Order {
  id: string
  customer: string
  amount: number
  status: string
}

const props = defineProps({
  // 外部可注入订单数据；不传则用内置 mock（便于独立演示）
  orders: { type: Array as PropType<Order[]>, default: () => [] },
})

const emit = defineEmits(['filter', 'view'])

const status = ref('')

const mockOrders: Order[] = [
  { id: 'ORD-1001', customer: '张三', amount: 128.5, status: 'paid' },
  { id: 'ORD-1002', customer: '李四', amount: 356.0, status: 'pending' },
  { id: 'ORD-1003', customer: '王五', amount: 89.9, status: 'done' },
  { id: 'ORD-1004', customer: '赵六', amount: 210.0, status: 'canceled' },
]

const allOrders = computed(() => (props.orders.length ? props.orders : mockOrders))

const filteredOrders = computed(() =>
  status.value ? allOrders.value.filter((o) => o.status === status.value) : allOrders.value
)

const statusMap: Record<string, [string, 'warning' | 'primary' | 'success' | 'info']> = {
  pending: ['待支付', 'warning'],
  paid: ['已支付', 'primary'],
  done: ['已完成', 'success'],
  canceled: ['已取消', 'info'],
}

function statusText(s: string): string {
  return statusMap[s]?.[0] || s
}
function statusTagType(s: string) {
  return statusMap[s]?.[1] || 'info'
}
function onFilter() {
  emit('filter', status.value)
}
function onView(o: Order) {
  emit('view', o)
}
</script>

<style scoped>
.order-list {
  padding: 16px;
}
.order-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}
.order-title {
  margin: 0;
  font-size: 18px;
  color: #1f2937;
}
</style>
