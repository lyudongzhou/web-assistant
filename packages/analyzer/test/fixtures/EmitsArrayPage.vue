<script setup lang="ts">
const emit = defineEmits(['search', 'page-change'])
defineExpose({ search: () => emit('search') })
</script>
