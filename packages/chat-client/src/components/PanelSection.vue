<template>
  <!-- 可折叠面板：**过程区与计划卡共用的壳**。
       为什么要有它：两个面板各写一套“折叠头 + 收起内容”就会出现"一个整行可点、一个角落小按钮"
       "一个 chev 在左、一个在右""一处有悬停、一处没有"这类漂移 —— 样式与交互只应有这一份实现。

       结构：head（chevron + 标题类内容 + 右侧动作）/ status（不随折叠收起的状态行）/
             body（详情：随折叠收起 + 限高滚动）/ footer（动作条：随详情收起，但不被详情滚走）。
       折叠状态不在这里：由 `usePanelOpen` 提供（同一个 composable，两处逻辑一致）。 -->
  <section class="panel">
    <div class="panel-head">
      <button
        class="panel-toggle"
        type="button"
        :aria-expanded="open"
        :title="toggleTitle"
        @click="emit('toggle')"
      >
        <span class="chev">{{ open ? '▾' : '▸' }}</span>
        <slot name="head" />
      </button>
      <span class="spacer"></span>
      <slot name="head-actions" />
    </div>

    <!-- 状态行：**不随折叠收起** ——"正在思考 / 正在更新计划"这类瞬时状态折起来也必须看得见 -->
    <div v-if="$slots.status" class="panel-status">
      <slot name="status" />
    </div>

    <!-- 详情与动作条**都随折叠收起**：折叠后 = 只有折叠头一行（与过程区一模一样）。
         动作条放在详情之外：详情限高滚动，主操作不能被滚走。 -->
    <template v-if="open">
      <div class="panel-body">
        <slot />
      </div>
      <div v-if="$slots.footer" class="panel-footer">
        <slot name="footer" />
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    /** 是否展开（状态由 `usePanelOpen` 提供，本组件只渲染 + 发 toggle） */
    open: boolean
    /** 折叠开关的 title（默认按当前状态给一句） */
    toggleTitle?: string
  }>(),
  { toggleTitle: undefined },
)

const emit = defineEmits<{ (e: 'toggle'): void }>()
</script>

<style scoped>
/* 壳：与过程区原本的 `.trace` 一致（分隔线 + 底纹），计划卡因此与它成为同一层级的兄弟面板 */
.panel {
  /* 与消息区（`flex: 1`）分开：面板不参与"被压扁"，两个 panel 在同一个 flex 列里行为一致。
     这条以前只写在过程区那侧（两个渲染面各一份 `.trace-panel`），计划卡因此是可被压缩的
     （flex-shrink 默认 1）—— 计划一长就被压扁、内容溢出盖住消息区。 */
  flex: 0 0 auto;
  border-top: 1px solid var(--wa-border, #e5e7eb);
  background: var(--wa-trace-bg, var(--wa-bg, #f9fafb));
  color: var(--wa-trace-text, var(--wa-text-secondary, #6b7280));
  /* 基准字号由壳给：不再"一个 panel 靠宿主继承、另一个自己设 12px" */
  font-size: 12px;
}
.panel-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  /* 折叠头自己定行高：调用方给详情设的 line-height 不该抬高折叠头 ——
     否则两个"同构"的 panel 折起来不是同一个高度（计划卡曾因根上 1.7 比过程区高 4px）。 */
  line-height: 1.5;
}
.panel-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  cursor: pointer;
  text-align: left;
}
.panel-toggle:hover .chev {
  color: var(--wa-primary, #3b82f6);
}
/* 标题是 **slot 内容**（在调用方的 scope 里编译，只带 `-s` 后缀的 scoped 属性）——
   必须走 `:slotted()` 才命中；写成 `.panel-toggle:hover .title` 会被编译成
   `.title[data-v-壳]`，那个属性在 slot 内容上根本不存在（= 悬停标题不变色）。 */
.panel-toggle:hover :slotted(.title) {
  color: var(--wa-primary, #3b82f6);
}
.chev {
  flex: 0 0 auto;
  font-size: 10px;
  color: var(--wa-text-muted, #9ca3af);
}
.spacer {
  flex: 1;
}
/* 状态行：字号/内边距与过程区原本的「思考中…」一致 */
.panel-status {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 12px 6px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--wa-text-muted, #9ca3af);
}
/*
 * 详情区：**限高 + 内部滚动**。
 * 为什么放在壳里：面板不参与被压扁（见 `.panel` 的 `flex: 0 0 auto`），代价是内容一长就会
 * 把消息区挤没 / 把输入栏顶出视野 —— 过程区原本靠自己的 `.list { max-height: 200px }` 兜住，
 * 计划卡没有（8 步计划直接把面板压扁、内容溢出盖住消息区，见 add-interactive-plan-revision §11）。
 * 宿主可用 `--wa-panel-body-max` 调。
 */
.panel-body {
  max-height: var(--wa-panel-body-max, 200px);
  overflow-y: auto;
}
/* 动作条：随详情一起收起（折叠后只剩折叠头一行），但不受详情滚动影响（主操作不能被滚走）。
   这里不加样式：间距由内容自己给（如计划卡的 `.actions`）。 */
/*
 * 标题与 meta 的排版放在这里（`:slotted`）：slot 内容属于调用方，只有共用的壳能保证
 * 两个面板的字号层级一致 —— 这正是"统一样式"的关键那几行。
 */
:slotted(.title) {
  flex: 0 0 auto;
  font-size: 12px;
  font-weight: 600;
}
:slotted(.meta) {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--wa-text-muted, #9ca3af);
}
/* meta 前的「·」分隔（`.title + .meta` 的兄弟选择器在 :slotted 里不支持，两个面板的 meta 都不在首位） */
:slotted(.meta)::before {
  content: '·';
  margin-right: 6px;
}
</style>
