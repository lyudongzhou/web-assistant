<template>
  <div>{{ props.source.name }}</div>
</template>

<script setup lang="ts">
import type {
  DatasourceFilter,
  DatasourceRequest,
  DatasourceVO,
} from './datasource'

const props = defineProps<{
  /** 当前数据源 */
  source: DatasourceVO
  retry?: number
  /** 过滤条件（增量） */
  filter?: Partial<DatasourceFilter>
  /** 关联数据源 */
  related?: DatasourceVO[]
}>()

const emit = defineEmits<{
  /** 提交表单 */
  submit: [data: DatasourceRequest]
  (e: 'close', v: DatasourceVO): void
  (e: 'filter', v: Partial<DatasourceFilter>): void
}>()

/** 保存数据源 */
function save(data: DatasourceRequest, dryRun?: boolean): Promise<DatasourceVO> {
  return Promise.resolve(data as unknown as DatasourceVO)
}

/** 设置过滤条件（增量合并），返回生效后的条件 */
async function setFilter(patch: Partial<DatasourceFilter>): Promise<DatasourceFilter> {
  return { keyword: '', datasourceType: '', status: '', testStatus: '', ...patch }
}

defineExpose({ save, setFilter, count: (id: number): number => id })
</script>
