// resolveSurfaceKind 单测：`surface` 与 `createRuntime` 不再各自判断（消除静默错配）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSurfaceKind } from '../src/lib/surface.ts'

const createRuntimeStub = () => ({ init: async () => {} })

test('缺省且没有 createRuntime → container（容器 / WC 用法）', () => {
  assert.equal(resolveSurfaceKind(undefined, undefined), 'container')
})

test('给了 createRuntime → host（宿主直连：runtime 由宿主注入）', () => {
  assert.equal(resolveSurfaceKind(undefined, createRuntimeStub), 'host')
})

test('显式 surface 优先（保留「自定义 runtime + 容器面」扩展位）', () => {
  assert.equal(resolveSurfaceKind('container', createRuntimeStub), 'container')
  assert.equal(resolveSurfaceKind('host', undefined), 'host')
})

test('两者同时给且一致 → 结果一致', () => {
  assert.equal(resolveSurfaceKind('host', createRuntimeStub), 'host')
})
