// usePanelOpen 单测：**过程区与计划卡共用的那一份收缩逻辑**。
// 锁三件事：默认值、整行点击的切换、内容身份（resetKey）变化时的重置。
// 纯响应式（ref / watch），不需要 DOM —— 因此可以用 node:test 直接测。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextTick, ref } from 'vue'
import { usePanelOpen } from '../src/composables/usePanelOpen.ts'

test('默认收起（过程区的语义）：不传 defaultOpen 时 open 为 false', () => {
  const { open } = usePanelOpen()
  assert.equal(open.value, false)
})

test('默认展开（计划卡的语义）：传 true 时 open 为 true', () => {
  const { open } = usePanelOpen(true)
  assert.equal(open.value, true)
})

test('toggle：点一次收起、再点一次展开', () => {
  const { open, toggle } = usePanelOpen(true)
  toggle()
  assert.equal(open.value, false)
  toggle()
  assert.equal(open.value, true)
})

test('resetKey：同一身份不重置（修订保留折叠偏好），身份变化回到默认展开', async () => {
  const planId = ref('plan-1')
  const { open, toggle } = usePanelOpen(true, () => planId.value)

  toggle()
  assert.equal(open.value, false, '用户手动收起')

  // 同一份计划被修订（planId 不变）→ 保留用户的折叠偏好
  planId.value = 'plan-1'
  await nextTick()
  assert.equal(open.value, false)

  // 换一份计划（planId 变化）→ 回到默认展开，否则"新计划一条步骤都没有"会被当成 bug
  planId.value = 'plan-2'
  await nextTick()
  assert.equal(open.value, true)
})

test('resetKey：默认收起的面板换身份后仍然是收起（重置到 defaultOpen 而不是"展开"）', async () => {
  const key = ref('a')
  const { open, toggle } = usePanelOpen(false, () => key.value)
  toggle()
  assert.equal(open.value, true)
  key.value = 'b'
  await nextTick()
  assert.equal(open.value, false)
})

// 默认值本身是状态（计划卡就是「待确认 = 展开 / 执行中 = 收起」）——
// 用 getter 传默认值，值一变 open 就跟上，"点了「开始执行」自动收成一行"因此不需要调用方自己 watch。
test('default 传 getter：初始取 getter 的值，值变则跟随（执行中收起 / 回到待确认又展开）', async () => {
  const approved = ref(false)
  const { open } = usePanelOpen(() => !approved.value)
  assert.equal(open.value, true, '待确认 = 默认展开')

  approved.value = true
  await nextTick()
  assert.equal(open.value, false, '点「开始执行」→ 面板自动收成一行（与过程区一致）')

  approved.value = false
  await nextTick()
  assert.equal(open.value, true, '改回待确认（如修订）→ 又展开')
})

test('default getter 的值没变时不动 open：无关的响应式触发不会弹回用户的手动折叠', async () => {
  const approved = ref(false)
  const unrelated = ref(0)
  const { open, toggle } = usePanelOpen(() => {
    unrelated.value
    return !approved.value
  })

  toggle()
  assert.equal(open.value, false, '用户手动收起')

  unrelated.value = 1
  await nextTick()
  assert.equal(open.value, false, '默认值没变 → 保留用户的选择')

  approved.value = false // 值仍是 false（默认 true），没变
  await nextTick()
  assert.equal(open.value, false, '默认值没变 → 仍保留用户的选择')

  approved.value = true // 默认值 true → false，真的变了
  await nextTick()
  assert.equal(open.value, false, '默认值变成 false → 跟随（本来已是收起）')

  approved.value = false
  await nextTick()
  assert.equal(open.value, true, '默认值变回 true → 跟随展开（手动折叠过也照样跟随状态）')
})
