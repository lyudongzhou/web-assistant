// host 批次 manifest（宿主直连 / 用法 B）单测：页面**没有 bundle** 也必须能加载。
//
// 背景（历史坑）：protocol 的 `pages[].bundle` 是可选 —— host 模式的页面是宿主自己的路由组件，
// 不经产物编译。但 agent-server 的 validateManifest 曾把它当必填，后果分两种：
//   - 本地文件模式（--manifest / 缺省路径）：onModuleInit 抛错 → 进程启动失败
//   - 远程模式（--manifest-url）：loadRemote 抛错被 tryLoadRemote 吞掉 → 只 warn，
//     agent 以空 manifest 运行（静态降级：欢迎语无能力、prompt 无页面）
// 本文件锁住三件事：host 批次能加载、能力清单/prompt 不退化、bundle 给了就必须是字符串。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const manifestPath = path.join(mkdtempSync(path.join(tmpdir(), 'wa-manifest-host-')), 'manifest.json')
process.env.MANIFEST_PATH = manifestPath
// 隔离：跑测试的机器 shell 里若导出了 MANIFEST_URL，远程来源会优先于本地文件（测试必须确定性）
delete process.env.MANIFEST_URL

/** 与 demo-app/public/wc/manifest.json 同形：无 containers、页面无 bundle、tag 允许不含 '-' */
const hostManifest = {
  version: 2,
  containers: {},
  pages: [
    { tag: 'user-list', name: 'UserList', path: '/users', title: '用户列表', framework: 'vue' },
    { tag: 'user-detail', name: 'UserDetail', path: '/users/:id', title: '用户详情', framework: 'vue' },
    { tag: 'app-dashboard', name: 'Dashboard', path: '/dashboard', title: '数据看板', framework: 'vue' },
  ],
}
writeFileSync(manifestPath, JSON.stringify(hostManifest), 'utf8')

const { ManifestService } = await import('../src/manifest/manifest.service.js')

async function makeService() {
  const svc = new ManifestService()
  await svc.onModuleInit()
  return svc
}

test('host 批次（无 bundle / 空 containers）能加载，不再启动即崩', async () => {
  const svc = await makeService()
  assert.equal(svc.getManifestVersion(), 2)
  assert.deepEqual(
    svc.getPages().map((page) => page.tag),
    ['user-list', 'user-detail', 'app-dashboard'],
  )
})

test('host 批次不因缺 bundle 退化：欢迎载荷能力清单与 prompt 里都有页面', async () => {
  const svc = await makeService()
  const welcome = svc.buildWelcome()
  assert.equal(welcome?.capabilities.length, 3, '能力清单来自 manifest 页面（缺 bundle 不影响）')
  assert.deepEqual(
    welcome?.capabilities.map((cap) => cap.tag),
    ['user-list', 'user-detail', 'app-dashboard'],
  )
  assert.match(svc.buildAgentContext(), /user-list/, 'prompt 里能列出 host 批次页面')
})

test('bundle 存在时必须是字符串（手写 manifest 打错类型要报出来）', async () => {
  writeFileSync(
    manifestPath,
    JSON.stringify({ version: 2, containers: {}, pages: [{ tag: 'x', name: 'X', bundle: 123 }] }),
    'utf8',
  )
  const svc = new ManifestService()
  await assert.rejects(() => svc.onModuleInit(), /bundle must be a string/)
})
