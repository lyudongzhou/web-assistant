<template>
  <!-- @description 商品管理页，展示商品列表，支持按分类筛选、搜索和查看/下架商品 -->
  <div class="product-list">
    <div class="product-header">
      <h2 class="product-title">商品管理</h2>
      <div class="product-actions">
        <el-input
          v-model="keywordInput"
          placeholder="搜索商品名称"
          style="width: 200px;"
          clearable
          @input="onSearch"
        />
        <el-select v-model="category" placeholder="按分类筛选" clearable style="width: 160px;" @change="onFilter">
          <el-option label="电子产品" value="electronics" />
          <el-option label="服饰" value="clothing" />
          <el-option label="食品" value="food" />
        </el-select>
        <el-button type="primary" @click="onCreate">新增商品</el-button>
      </div>
    </div>

    <el-table :data="filteredProducts" border>
      <el-table-column prop="id" label="ID" width="80" />
      <el-table-column prop="name" label="名称" />
      <el-table-column prop="price" label="价格" width="120">
        <template #default="{ row }">￥{{ row.price.toFixed(2) }}</template>
      </el-table-column>
      <el-table-column label="分类" width="120">
        <template #default="{ row }">{{ categoryText(row.category) }}</template>
      </el-table-column>
      <el-table-column label="库存" width="100">
        <template #default="{ row }">
          <el-tag :type="row.stock > 0 ? 'success' : 'danger'">{{ row.stock }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="160">
        <template #default="{ row }">
          <el-button size="small" @click="onView(row)">详情</el-button>
          <el-button size="small" type="danger" :disabled="row.stock === 0" @click="onOffShelf(row)">下架</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, type PropType } from 'vue'

interface Product {
  id: string
  name: string
  price: number
  category: string
  stock: number
}

const props = defineProps({
  // 外部可注入商品数据；不传则用内置 mock（便于独立演示）
  products: { type: Array as PropType<Product[]>, default: () => [] },
  // 搜索关键词（agent 可通过 props 传入过滤条件）
  keyword: { type: String, default: '' },
})

const emit = defineEmits(['search', 'filter', 'view', 'create', 'off-shelf'])

const category = ref('')
const keywordInput = ref('')

const mockProducts: Product[] = [
  { id: 'P-001', name: '无线蓝牙耳机', price: 299.0, category: 'electronics', stock: 42 },
  { id: 'P-002', name: '纯棉T恤', price: 79.9, category: 'clothing', stock: 128 },
  { id: 'P-003', name: '有机燕麦片', price: 39.5, category: 'food', stock: 0 },
  { id: 'P-004', name: '机械键盘', price: 459.0, category: 'electronics', stock: 18 },
]

const allProducts = computed(() => (props.products.length ? props.products : mockProducts))

const keywordQuery = computed(() => keywordInput.value || props.keyword)

const filteredProducts = computed(() =>
  allProducts.value.filter((p) => {
    const matchCategory = category.value ? p.category === category.value : true
    const kw = keywordQuery.value.toLowerCase()
    const matchKeyword = kw ? p.name.toLowerCase().includes(kw) : true
    return matchCategory && matchKeyword
  })
)

const categoryMap: Record<string, string> = {
  electronics: '电子产品',
  clothing: '服饰',
  food: '食品',
}

function categoryText(c: string): string {
  return categoryMap[c] || c
}

function onSearch() {
  emit('search', keywordInput.value)
}
function onFilter() {
  emit('filter', category.value)
}
function onView(p: Product) {
  emit('view', p)
}
function onCreate() {
  emit('create')
}
function onOffShelf(p: Product) {
  emit('off-shelf', p)
}
</script>

<style scoped>
.product-list {
  padding: 16px;
}
.product-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  flex-wrap: wrap;
  gap: 12px;
}
.product-title {
  margin: 0;
  font-size: 18px;
  color: #1f2937;
}
.product-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
