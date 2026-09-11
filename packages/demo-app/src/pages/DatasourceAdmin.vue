<template>
  <!-- @description 数据源管理页，用类型写法声明 props/emits，支持保存、刷新与提交新建数据源 -->
  <div style="padding: 16px;">
    <h2 style="margin: 0 0 16px; font-size: 18px;">数据源管理</h2>
    <el-table :data="rows" border>
      <el-table-column prop="id" label="ID" width="80" />
      <el-table-column prop="name" label="名称" />
      <el-table-column prop="host" label="主机" />
      <el-table-column prop="port" label="端口" width="100" />
      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <el-tag :type="row.status === 'active' ? 'success' : 'info'">{{ row.status }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="负责人" width="140">
        <template #default="{ row }">{{ row.owner?.displayName ?? '—' }}</template>
      </el-table-column>
    </el-table>
    <div style="margin-top: 16px; display: flex; gap: 8px;">
      <el-button type="primary" @click="onSubmit">提交</el-button>
      <el-button @click="refresh(true)">刷新</el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
// 本页刻意使用「类型写法」声明 props / emits，并且类型都来自跨文件 import ——
// 用来验收 analyzer 的 vue-tsc 内核是否把自定义类型展开成真实字段结构。
import { computed } from 'vue'
import { DatasourceKind } from '../types/datasource'
import type { DatasourceOwner, DatasourceRequest, DatasourceVO } from '../types/datasource'

const props = defineProps<{
  // 外部可注入数据源列表；不传则用内置 mock
  sources?: DatasourceVO[]
  // 负责人信息（演示嵌套自定义类型展开）
  owner?: DatasourceOwner
  // 只展示启用中的数据源
  onlyEnabled?: boolean
}>()

const emit = defineEmits<{
  // 提交新建数据源
  submit: [payload: DatasourceRequest]
  // 选中某条数据源
  select: [source: DatasourceVO]
  // 关闭（可选原因）
  close: [reason?: string]
}>()

const mockSources: DatasourceVO[] = [
  {
    id: 1,
    name: '主库',
    host: '10.0.0.1',
    port: 3306,
    tags: ['prod'],
    enabled: true,
    status: 'active',
    kind: DatasourceKind.MySQL,
    owner: { id: 1, displayName: '张三' },
  },
]

const rows = computed(() => {
  const list = props.sources?.length ? props.sources : mockSources
  return props.onlyEnabled ? list.filter((item) => item.enabled) : list
})

/** 保存数据源，返回保存后的完整对象（agent 可据返回值继续规划） */
async function save(data: DatasourceRequest): Promise<DatasourceVO> {
  // emit('submit', data)
  return {
    id: 0,
    name: data.name,
    host: data.host,
    port: data.port ?? 0,
    tags: [],
    enabled: true,
    status: 'active',
    kind: DatasourceKind.MySQL,
    owner: data.owner ?? null,
  }
}

/** 重新拉取数据源列表，返回条数 */
async function refresh(force?: boolean): Promise<number> {
  if (force) emit('close', 'refresh')
  return rows.value.length
}

function onSubmit(): void {
  void save({ name: '新数据源', host: '127.0.0.1', owner: props.owner })
}

defineExpose({ save, refresh, onSubmit })
</script>
