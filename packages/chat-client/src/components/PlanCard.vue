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
      <!-- 等待中的步骤：折叠起来也要一眼看见"轮到我了"（所以它进折叠头，而不只在详情里） -->
      <span v-if="handoff" class="handoff-badge">{{ handoff.issue ? '需你重做' : '等你操作' }}</span>
      <span v-if="revision > 1" class="revised-badge">已修订 · 第 {{ revision }} 版</span>
      <span class="title">{{ plan.message.summary }}</span>
      <span class="meta">{{ stepsMeta }}</span>
    </template>

    <!-- 状态行（不随折叠收起）：修订中 / 正在校验 / 等你操作 —— 折起来也必须看得见 -->
    <template v-if="revising || completing || handoff" #status>
      <template v-if="revising">
        <span class="dot running">◐</span>
        <span>正在按你的意见更新计划…</span>
      </template>
      <template v-else-if="completing">
        <span class="dot running">◐</span>
        <span>已收到，正在校验{{ completingLabel }}…</span>
      </template>
      <template v-else-if="handoff">
        <span class="dot" :class="{ warn: !!handoff.issue }">{{ handoff.issue ? '!' : '⏳' }}</span>
        <span>{{ handoffStatusText }}</span>
      </template>
    </template>

    <!-- 详情：折叠时收起。步骤行三态：完成 / 轮到你（带指引与失败原因） / 待做 -->
    <ol class="steps">
      <li v-for="step in plan.message.steps" :key="step.id" :class="statusOf(step).tone">
        <span class="mark">{{ statusOf(step).mark }}</span>
        <div class="step-body">
          <span class="title-text">{{ step.title }}</span>
          <span v-if="statusOf(step).label" class="step-badge">{{ statusOf(step).label }}</span>
          <p v-if="step.status === 'waiting-user' && step.instructions" class="step-instructions">
            {{ step.instructions }}
          </p>
          <p v-if="step.issue" class="step-issue">
            没做成：{{ step.issue.reason }}<template v-if="step.issue.expected">；应该做成：{{ step.issue.expected }}</template>
          </p>
        </div>
      </li>
    </ol>
    <p v-if="plan.message.note" class="note">本次变更：{{ plan.message.note }}</p>
    <p class="foot">
      <template v-if="handoff">
        在页面上完成后点上面的「{{ handoff.issue ? '我已重做，下一步' : '我已完成，下一步' }}」，我会先校验再继续。
      </template>
      <template v-else-if="approved">已确认，我按这个计划分步执行；要改哪一步点「修改计划」（改完需重新确认）。</template>
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
        <!-- 轮到你操作时，卡片的主操作就是"我已完成"（而不是「开始执行」——计划早已确认） -->
        <button
          v-if="handoff"
          class="primary"
          type="button"
          :disabled="disabled || completing"
          @click="emit('step-done', handoff.id)"
        >
          {{ handoff.issue ? '我已重做，下一步' : '我已完成，下一步' }}
        </button>
        <button v-else-if="!approved" class="primary" type="button" :disabled="disabled" @click="emit('approve', plan)">
          开始执行
        </button>
        <button type="button" :disabled="disabled" @click="emit('open-revision')">修改计划</button>
      </div>
    </template>
  </PanelSection>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { PlanStep } from '@webassistant/protocol'
import type { PlanCard } from '../lib/turnState.js'
import { describeStepStatus } from '../lib/turnState.js'
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
  /**
   * 人工步骤完成回执（「我已完成 / 我已重做，下一步」）：值为被推进的步骤 id。
   * 宿主转成 `completeStep(plan, stepId)`（`chat.send` 带 `planId` + `stepDoneId`）。
   */
  (e: 'step-done', stepId: string): void
}>()

// computed 而不是普通常量：卡片在多轮之间会被复用（同一个组件实例换 props），
// 普通常量只在 setup 时算一次 —— 点了「开始执行」后界面不会切到「计划执行中」。
const approved = computed(() => props.plan.status === 'approved')
/** 已点「我已完成，下一步」、等本轮校验（本地反馈态） */
const completing = computed(() => props.plan.completingStepId !== undefined)
/**
 * "正在校验哪一步"的文案。
 * 必须用 `completingStepId` 自己算（不能用当前的等待步骤）：服务端把该步标 `done` 后就会推新卡片，
 * 那一瞬间"等待中的步骤"已经不存在了，用它会显示成「第 0 步」。
 */
const completingLabel = computed(() => {
  const index = props.plan.message.steps.findIndex((step) => step.id === props.plan.completingStepId)
  return index >= 0 ? `第 ${index + 1} 步` : '这一步'
})
/**
 * 当前"轮到你操作"的那一步（服务端 `waiting-user`；本地不推断）。
 * 有它才有「我已完成，下一步」按钮与那条操作指引 —— 计划卡上"需要给出提示"的全部依据。
 *
 * ⚠️ 必须在 `usePanelOpen` **之前**定义：折叠的默认值依赖它，而 `usePanelOpen` 会立刻求值一次
 * （放在后面会踩 TDZ —— `Cannot access 'handoff' before initialization`）。
 */
const handoff = computed(() => props.plan.message.steps.find((step) => step.status === 'waiting-user'))
/** 等待中的步骤序号（-1 = 没有），折叠头与状态行文案共用 */
const handoffIndex = computed(() => props.plan.message.steps.findIndex((step) => step.status === 'waiting-user'))
/** 折叠/状态行的"等你"线索：折起来也要知道该自己动手了 */
const handoffStatusText = computed(() => {
  const index = handoffIndex.value
  const label = index >= 0 ? `第 ${index + 1} 步` : '这一步'
  return handoff.value?.issue
    ? `${label}需要你重做（在页面上改好后点按钮）`
    : `等待你在页面上操作${index >= 0 ? ` · ${label}` : ''}`
})

/**
 * 折叠：与过程区共用 `usePanelOpen`（同一份收缩逻辑）。
 * **默认值本身就是状态**（`() => !approved.value || !!handoff.value`）：
 * 待确认 = 展开（要用户做决定，步骤与按钮都看得见）、**有步骤在等你 = 展开**
 * （这是"需要给出提示"的那一步，不能藏在折叠里）、执行中且没有待办 = 收起
 * （与过程区一样只剩一行「计划执行中 · 已完成 1/3」）。
 * resetKey 用 `planId`：**同一份计划**（修订）保留用户的折叠偏好，**换一份计划**（重新生成）回到默认 ——
 * 否则用户会看到"新计划一条步骤都没有"（其实是上一份的折叠状态被继承了）。
 */
const { open, toggle } = usePanelOpen(
  () => !approved.value || !!handoff.value,
  () => props.plan.message.planId,
)
/** 第几版（服务端 `ChatPlanMessage.revision`；首版为 1） */
const revision = computed(() => props.plan.message.revision ?? 1)
/** 是否正在输入修改意见（草稿存在 = 输入框展开） */
const editing = computed(() => props.plan.draft !== undefined)
const revising = computed(() => props.plan.revising === true)
/** 步骤行的展示口径（三态 + 徽标）：纯函数在 `lib/turnState.ts`，两条渲染面共用 */
function statusOf(step: PlanStep): ReturnType<typeof describeStepStatus> {
  return describeStepStatus(step)
}
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
/* 人工步骤徽标：「轮到你了」要进折叠头（折起来也看得见）—— 与"已修订"同为药丸，但用警示色 */
.handoff-badge {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--wa-warn-soft, #fef3c7);
  color: #b45309;
  font-size: 11px;
  /* 同「已修订」：自己定行高，不撑高折叠头 */
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
/* 状态行里的动点（照过程区的「思考中…」）：修订中 / 正在校验也要看得见 */
.dot.running {
  color: var(--wa-primary, #3b82f6);
}
/* 「需你重做」的感叹号用警示色（与等待中的 ⏳ 区分） */
.dot.warn {
  color: #b91c1c;
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
/* 「轮到你了」的那一步：整行给底色，扫一眼就知道停在哪（计划可以有 8 步） */
.steps li.waiting,
.steps li.rework {
  align-items: flex-start;
  margin: 4px 0;
  padding: 6px 8px;
  border-radius: var(--wa-radius-sm, 6px);
  background: var(--wa-warn-soft, #fef3c7);
}
/* 校验失败（`issue` 非空）= 上一次没做成，请重做 —— 语气必须比"等你操作"更紧 */
.steps li.rework {
  background: #fee2e2;
}
.step-body {
  flex: 1;
  min-width: 0;
}
.steps li.waiting .step-badge,
.steps li.rework .step-badge {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 999px;
  background: #b45309;
  color: #fff;
  font-size: 10px;
  line-height: 1.6;
  white-space: nowrap;
}
.steps li.rework .step-badge {
  background: #b91c1c;
}
/* 操作指引：用户要照着做的那句话，必须比"计划正文"更显眼 */
.step-instructions {
  margin: 2px 0 0;
  font-size: 11px;
  color: var(--wa-text-strong, #374151);
}
.step-issue {
  margin: 2px 0 0;
  font-size: 11px;
  color: #b91c1c;
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
