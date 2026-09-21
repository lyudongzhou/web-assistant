// traceText 单测（node:test + tsx 直跑 src）。
// 覆盖：三个工具的步骤文案（必须带动作目标 —— 否则多跳流程在 UI 上分不出哪步是哪步）、
// 未知工具兜底、脏实参不抛、tool-finished 的成败判定。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeToolStep, toolResultError } from '../src/agent/traceText.js'

test('describeToolStep：render 的文案带上页面 tag，target 同时给出', () => {
  assert.deepEqual(describeToolStep('render', { tag: 'user-list' }), {
    text: '正在打开页面 <user-list>',
    target: 'user-list',
  })
})

test('describeToolStep：call_page_method 按「目标页 / 当前页」两种形态', () => {
  assert.deepEqual(describeToolStep('call_page_method', { name: 'setKeyword', args: ['钱'] }), {
    text: '正在调用 当前页.setKeyword()',
    target: 'setKeyword',
  })
  assert.deepEqual(describeToolStep('call_page_method', { page: 'user-list', name: 'nextPage' }), {
    text: '正在调用 <user-list>.nextPage()',
    target: 'nextPage',
  })
})

test('describeToolStep：wait_for_observation 带页面时标注页面', () => {
  assert.deepEqual(describeToolStep('wait_for_observation', { page: 'user-list' }), {
    text: '正在等待页面数据 <user-list>',
    target: 'user-list',
  })
  assert.deepEqual(describeToolStep('wait_for_observation', {}), { text: '正在等待页面数据' })
})

test('describeToolStep：缺目标时退回通用文案（不出现 undefined）', () => {
  assert.deepEqual(describeToolStep('render', {}), { text: '正在打开页面' })
  assert.deepEqual(describeToolStep('call_page_method', {}), { text: '正在调用 当前页的方法' })
})

test('describeToolStep：未知工具 / 脏实参都不抛（观测路径不能影响主流程）', () => {
  assert.deepEqual(describeToolStep('some_new_tool', { anything: 1 }), { text: '正在执行 some_new_tool' })
  assert.deepEqual(describeToolStep('render', null), { text: '正在打开页面' })
  assert.deepEqual(describeToolStep('render', 'not-an-object'), { text: '正在打开页面' })
  assert.deepEqual(describeToolStep('render', { tag: 123 }), { text: '正在打开页面' })
})

test('toolResultError：isError 的 tool-result → 取 output 作为原因', () => {
  const message = {
    parts: [
      { type: 'text' },
      { type: 'tool-result', toolCallId: 'c1', isError: true, output: '方法未暴露' },
    ],
  }
  assert.equal(toolResultError(message), '方法未暴露')
})

test('toolResultError：成功（无 isError）→ undefined', () => {
  assert.equal(
    toolResultError({ parts: [{ type: 'tool-result', toolCallId: 'c1', output: { status: 'done' } }] }),
    undefined,
  )
})

test('toolResultError：isError 但 output 不是字符串 → 用兜底文案，不吐 undefined', () => {
  assert.equal(
    toolResultError({ parts: [{ type: 'tool-result', isError: true, output: { code: 500 } }] }),
    '工具执行失败',
  )
})

test('toolResultError：形状不对（无 parts / 不是对象）→ undefined 而不是抛', () => {
  assert.equal(toolResultError(undefined), undefined)
  assert.equal(toolResultError({}), undefined)
  assert.equal(toolResultError({ parts: 'nope' }), undefined)
})
