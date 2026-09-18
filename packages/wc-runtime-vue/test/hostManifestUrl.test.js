// 宿主直连（用法 B）manifest 地址归一 —— 纯函数，单测对齐 chat-client 的 wcBase 缺省值。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveHostManifestUrl, DEFAULT_MANIFEST_BASE } from '../dist/hostManifestUrl.js'

test('缺省基址与 chat-client 的 wcBase 一致（/wc）', () => {
  assert.equal(DEFAULT_MANIFEST_BASE, '/wc')
  assert.equal(resolveHostManifestUrl(undefined), '/wc/manifest.json')
  assert.equal(resolveHostManifestUrl(undefined, {}), '/wc/manifest.json')
})

test('上下文 base → {base}/manifest.json', () => {
  assert.equal(resolveHostManifestUrl(undefined, { base: '/wc' }), '/wc/manifest.json')
  assert.equal(resolveHostManifestUrl(undefined, { base: '/assets/wc' }), '/assets/wc/manifest.json')
})

test('base 末尾斜杠不会拼出双斜杠', () => {
  assert.equal(resolveHostManifestUrl(undefined, { base: '/wc/' }), '/wc/manifest.json')
})

test('显式 manifestUrl 优先（允许宿主自己指定完整地址）', () => {
  assert.equal(
    resolveHostManifestUrl('https://cdn.example.com/wc/manifest.json', { base: '/other' }),
    'https://cdn.example.com/wc/manifest.json',
  )
})
