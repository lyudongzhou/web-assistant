<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const id = computed(() => route.params.id)
const byQuery = computed(() => route.query.id)
const legacy = computed(() => route.params.legacyId)
</script>
