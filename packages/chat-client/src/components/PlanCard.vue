<template>
  <!-- 计划卡 = 与过程区（`<PanelSection class="trace">`）**同一层级的 panel**：
         待确认（默认展开）                              执行中（默认收起，与过程区一样只有一行）
         ▾ [计划待确认] 对比三张数据源 · 已完成 1/3       ▸ [计划执行中] 对比三张数据源 · 已完成 1/3
           步骤列表 / 变更摘要 / 说明文案  ← 详情（随折叠收起）      ← 详情与动作条都收起
           [开始执行] [修改计划]           ← 动作条（详情展开时可见，不被详情滚走）
       折叠状态由 `usePanelOpen` 管（和过程区同一份逻辑）；**默认值本身跟随状态**：
       待确认 = 展开（要用户做决定）、执行中 = 收起（已确认的计划只剩"做到哪了"），
       所以点「开始执行」后面板自动收成一行。换一份计划（planId 变）回到默认；
       同一份计划被修订（planId 不变）保留用户的折叠偏好。

       行为要点：
       「开始执行」= 用户确认（chat.send 带 planId），确认前服务端会拒绝页面操作（PLAN_GATE=hard）。
       「修改计划」= 在卡内输入要改什么（chat.send 带 revisePlanId）→ 服务端用 revise_plan
       在本计划上**增量合并**：未改动的步骤保留原 id 与完成状态（进度不丢），planId 不变。
       「重新生成计划」= 推倒重来（走 propose_plan，旧计划按过期处理）—— 与"修改"是两件事。 -->
  <PanelSection
    class="plan-card"
    :class="{ approved }"
    :open="open"
    :toggle-title="open ? '收起计划详情' : '展开计划详情'"
    @toggle="toggle"
  >
    <template #head>
      <span class="badge">{{ approved ? '计划执行中' : '计划待确认' }}</span>
      <span v-if="revision > 1" class="revised-badge">已修订 · 第 {{ revision }} 版</span>
      <span class="title">{{ plan.message.summary }}</span>
      <span class="meta">{{ stepsMeta }}</span>
    </template>

    <!-- 状态行（不随折叠收起）：修订中也要看得见 -->
    <template v-if="revising" #status>
      <span class="dot running">◐</span>
      <span>正在按你的意见更新计划…</span>
    </template>

    <!-- 详情：折叠时收起 -->
    <ol class="steps">
      <li v-for="step in plan.message.steps" :key="step.id" :class="step.status">
        <span class="mark">{{ step.status === 'done' ? '✓' : '○' }}</span>
        <span class="title-text">{{ step.title }}</span>
      </li>
    </ol>
    <p v-if="plan.message.note" class="note">本次变更：{{ plan.message.note }}</p>
    <p class="foot">
      <template v-if="approved">已确认，我按这个计划分步执行；要改哪一步点「修改计划」（改完需重新确认）。</template>
      <template v-else>要改哪一步就点「修改计划」写清楚（未改动的步骤进度会保留）；想推倒重来用「重新生成计划」。</template>
      <button class="link" type="button" :disabled="disabled" @click="emit('replan')">重新生成计划</button>
    </p>

    <!-- footer：修改输入 或 主操作按钮（随详情展开/收起；展开时主操作一定在视野里） -->
    <template #footer>
      <form v-if="editing" class="revise" @submit.prevent="submitRevision">
        <input
          v-model="draft"
          class="revise-input"
          :placeholder="REVISE_PLACEHOLDER"
          :disabled="disabled"
        />
        <div class="actions">
          <button class="primary" type="submit" :disabled="disabled || !draft.trim()">提交修改</button>
          <button type="button" :disabled="disabled" @click="emit('cancel-revision')">取消</button>
        </div>
      </form>
      <div v-else class="actions">
        <button v-if="!approved" class="primary" type="button" :disabled="disabled" @click="emit('approve', plan)">
          开始执行
        </button>
        <button type="button" :disabled="disabled" @click="emit('open-revision')">修改计划</button>
      </div>
    </template>
  </PanelSection>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { PlanCard } from '../lib/turnState.js'
import { usePanelOpen } from '../composables/usePanelOpen.js'
import PanelSection from './PanelSection.vue'

/** 修改意见输入框的占位提示：用例子说清"能改什么"（步骤级改动 / 增删 / 重排都支持） */
const REVISE_PLACEHOLDER = '例如：第 3 步改成导出 CSV；再加一步把结果同步给张三'

const props = withDefaults(
  defineProps<{
    plan: PlanCard
    /** run 进行中：按钮禁用（避免与正在跑的一轮抢同一条会话） */
    disabled?: boolean
  }>(),
  { disabled: false },
)

const emit = defineEmits<{
  (e: 'approve', plan: PlanCard): void
  /** 展开修改输入框 */
  (e: 'open-revision'): void
  /** 修改意见输入变化 */
  (e: 'revision-input', draft: string): void
  /** 取消修改 */
  (e: 'cancel-revision'): void
  /** 提交修改意见（草稿由 `plan.draft` 提供，这里只发事件） */
  (e: 'revise'): void
  /** 重新生成计划（推倒重来） */
  (e: 'replan'): void
}>()

// computed 而不是普通常量：卡片在多轮之间会被复用（同一个组件实例换 props），
// 普通常量只在 setup 时算一次 —— 点了「开始执行」后界面不会切到「计划执行中」。
const approved = computed(() => props.plan.status === 'approved')

/**
 * 折叠：与过程区共用 `usePanelOpen`（同一份收缩逻辑）。
 * **默认值本身就是状态**（`() => !approved.value`）：待确认 = 展开（要用户做决定，步骤与按钮都看得见）、
 * 执行中 = 收起（与过程区一样只剩一行「计划执行中 · 已完成 1/3」）—— 所以点「开始执行」后
 * 面板自动收成一行，要看进度或改计划再展开；修订回来（回到待确认）又自动展开。
 * resetKey 用 `planId`：**同一份计划**（修订）保留用户的折叠偏好，**换一份计划**（重新生成）回到默认 ——
 * 否则用户会看到"新计划一条步骤都没有"（其实是上一份的折叠状态被继承了）。
 */
const { open, toggle } = usePanelOpen(
  () => !approved.value,
  () => props.plan.message.planId,
)
/** 第几版（服务端 `ChatPlanMessage.revision`；首版为 1） */
const revision = computed(() => props.plan.message.revision ?? 1)
/** 是否正在输入修改意见（草稿存在 = 输入框展开） */
const editing = computed(() => props.plan.draft !== undefined)
const revising = computed(() => props.plan.revising === true)
/** 折叠头右侧的步骤计数（折叠后这是"计划里还有几步 / 做到哪了"的唯一线索） */
const stepsMeta = computed(() => {
  const steps = props.plan.message.steps
  const done = steps.filter((step) => step.status === 'done').length
  return done > 0 ? `已完成 ${done}/${steps.length}` : `${steps.length} 步`
})
/** 修改意见双向绑定：读本地草稿、写回上层（状态在 `lib/turnState.ts`，组件只做数据进事件出） */
const draft = computed({
  get: () => props.plan.draft ?? '',
  set: (value: string) => emit('revision-input', value),
})

function submitRevision(): void {
  if (!draft.value.trim()) return
  emit('revise')
}
</script>

<style scoped>
/* 壳（分隔线 / 折叠头 / chevron / 标题与 meta 字号 / 状态行）都在 <PanelSection>：
   计划卡与过程区因此是**同一层级的两个 panel**，样式只有那一份实现。
   这里只管"计划内容"自己的样式（步骤 / 变更摘要 / 说明 / 按钮 / 输入框）。 */
/* 字号在壳里定（`PanelSection` 的 `.panel`），两个 panel 同源；
   这里的行高只作用于**详情内容**（步骤 / 变更摘要 / 说明文案）——
   折叠头与状态行的行高由壳定死，所以两张卡折起来是同一个高度。 */
.plan-card {
  line-height: 1.7;
}
/* `.approved` 现在是留给宿主的样式钩子（面板自身不再整体降透明度：那会让同级的两个 panel
   底纹 / 分隔线深浅不一，"执行中"已经由「计划执行中」徽标表达）。 */
.badge {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--wa-primary-soft, #dbeafe);
  color: var(--wa-primary, #3b82f6);
  font-size: 11px;
  /* 药丸自己定行高：不然它比折叠头里的标题（12px × 1.5 = 18px）还高 0.5px，
     整个折叠头就比过程区高 1px（"同构"要的是同一个高度，不是差不多的高度）。 */
  line-height: 1.4;
}
/* 修订徽标：让"这份计划被改过"一眼可见（planId 不变，靠版本号区分） */
.revised-badge {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--wa-warn-soft, #fef3c7);
  color: #b45309;
  font-size: 11px;
  /* 同上：不撑高折叠头 */
  line-height: 1.4;
}
/* 状态行里的动点（照过程区的「思考中…」）：修订中也要看得见 */
.dot.running {
  color: var(--wa-primary, #3b82f6);
}
/* 内容块：横向内边距与折叠头（12px）对齐，纵向各自控制 */
.steps {
  margin: 0;
  padding: 0 12px;
  list-style: none;
}
.steps li {
  display: flex;
  gap: 6px;
  color: var(--wa-text, #1f2937);
}
.steps li.done .title-text {
  color: var(--wa-text-muted, #9ca3af);
  text-decoration: line-through;
}
.mark {
  flex: 0 0 auto;
  color: var(--wa-text-muted, #9ca3af);
}
.note {
  margin: 6px 0 0;
  padding: 0 12px;
  font-size: 11px;
  color: var(--wa-text-muted, #6b7280);
}
.revise {
  padding: 0 12px;
}
.revise-input {
  display: block;
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  border: 1px solid var(--wa-border-strong, #d1d5db);
  border-radius: var(--wa-radius-sm, 6px);
  background: var(--wa-panel-bg, #fff);
  color: var(--wa-text, #1f2937);
  font: inherit;
  font-size: 12px;
}
.revise-input:focus {
  border-color: var(--wa-primary, #3b82f6);
  outline: none;
}
.actions {
  display: flex;
  gap: 8px;
  padding: 8px 12px 0;
}
.actions button {
  padding: 5px 12px;
  border: 1px solid var(--wa-border-strong, #d1d5db);
  border-radius: var(--wa-radius-sm, 6px);
  background: var(--wa-panel-bg, #fff);
  color: var(--wa-text-strong, #374151);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.actions button.primary {
  border-color: var(--wa-primary, #3b82f6);
  background: var(--wa-primary, #3b82f6);
  color: var(--wa-primary-contrast, #fff);
}
.actions button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.foot {
  margin: 6px 0 0;
  padding: 0 12px;
  font-size: 11px;
  color: var(--wa-text-muted, #9ca3af);
}
/* 「重新生成计划」是次要入口（会丢进度）—— 做成链接，避免与「修改计划」抢注意力 */
.foot .link {
  margin-left: 4px;
  padding: 0;
  border: none;
  background: none;
  color: var(--wa-text-muted, #9ca3af);
  font: inherit;
  font-size: 11px;
  text-decoration: underline;
  cursor: pointer;
}
.foot .link:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
