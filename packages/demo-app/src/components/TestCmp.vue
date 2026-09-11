<template>
  <div class="dropdown-demo">
    <div class="row">
      <span class="label">非 scoped（SPA 正常 / WC 靠方向 B）：</span>
      <el-dropdown popper-class="popper-ok">
        <el-button type="primary">打开菜单</el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item>选项一</el-dropdown-item>
            <el-dropdown-item>选项二</el-dropdown-item>
            <el-dropdown-item disabled>选项三</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>

    <div class="row">
      <span class="label">scoped :deep()（SPA 也失效）：</span>
      <el-dropdown popper-class="popper-bad">
        <el-button>打开菜单</el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item>选项一</el-dropdown-item>
            <el-dropdown-item>选项二</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
  </div>
</template>

<!-- 非 scoped：SPA 里 Vite 会抽成全局 CSS 进 <head>，命中 teleport 到 body 的浮层；
     WC 里方向 B 也把它注入光 DOM，所以同样生效。 -->
<style>
.popper-ok {
  background: #312e81 !important;
  border: 2px solid #7c3aed !important;
}
.popper-ok .el-dropdown-menu__item {
  color: #fbbf24;
  font-size: 18px;
}
.popper-ok .el-dropdown-menu__item:hover {
  background: #7c3aed;
  color: #fff;
}
</style>

<!-- scoped :deep()：编译成 [data-v-xxx] .popper-bad ...，
     浮层节点不带 data-v-xxx 祖先，SPA / WC 都命中不了（Vue 通用限制）。 -->
<style scoped>
.dropdown-demo {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.label {
  color: #7c3aed;
  font-weight: 600;
}
:deep(.popper-bad) {
  background: #312e81 !important;
}
:deep(.popper-bad .el-dropdown-menu__item) {
  color: #fbbf24 !important;
  font-size: 18px !important;
}
</style>
