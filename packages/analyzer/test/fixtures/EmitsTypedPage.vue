<script setup lang="ts">
interface Payload {
  id: string
}

const emit = defineEmits<{
  /** 筛选状态变化 */
  filter: [status: 'paid' | 'all', keepPage?: boolean]
  (e: 'view', v: Payload): void
}>()

defineExpose({ noop: () => undefined })
</script>
