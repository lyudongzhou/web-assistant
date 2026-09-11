<template>
  <div><button @click="handleDialogSubmit">提交</button></div>
</template>

<script setup lang="ts">
import type { DatasourceRequest, DatasourceVO } from './datasource'

/** 提交数据源表单，返回创建后的数据源 */
async function handleDialogSubmit(data: DatasourceRequest): Promise<DatasourceVO> {
  return Promise.resolve(data as unknown as DatasourceVO)
}

defineExpose({ handleDialogSubmit })
</script>
