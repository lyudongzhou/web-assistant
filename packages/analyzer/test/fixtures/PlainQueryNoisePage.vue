<script setup lang="ts">
// 同名属性但不是路由：不得被误判成路由入参
const http = { query: { a: 1 }, params: { b: 2 } }
const a = http.query.a
const b = http.params.b
</script>
