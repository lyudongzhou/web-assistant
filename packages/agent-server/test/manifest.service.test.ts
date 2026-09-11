// ManifestService.buildAgentContext 单测：验证 exposes/emits 进 prompt + 当前页可用方法段。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.MANIFEST_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'wa-manifest-')), 'manifest.json')
writeFileSync(
  process.env.MANIFEST_PATH,
  JSON.stringify({
    version: 2,
    containers: {},
    pages: [
      {
        tag: 'user-list',
        name: 'UserList',
        path: '/users',
        framework: 'vue',
        bundle: 'pages/userList.js',
        exposes: [
          { name: 'refresh', signature: '(args?: { silent?: boolean }) => void', description: '重新拉取列表' },
          { name: 'setKeyword', signature: '(keyword: string) => void', description: '设置筛选关键字' },
        ],
        emits: [{ name: 'selection-change', payloadType: 'unknown[]', description: '选中行变化' }],
      },
      {
        tag: 'user-detail',
        name: 'UserDetail',
        path: '/users/:id',
        framework: 'vue',
        bundle: 'pages/userDetail.js',
      },
    ],
  }),
  'utf8',
)

const { ManifestService } = await import('../src/manifest/manifest.service.js')

async function makeService() {
  const svc = new ManifestService()
  await svc.onModuleInit()
  return svc
}

test('buildAgentContext：每页注入可调用方法与页面事件', async () => {
  const svc = await makeService()
  const prompt = svc.buildAgentContext()
  assert.match(prompt, /可调用方法：refresh\(args\?: \{ silent\?: boolean \}\) => void（重新拉取列表）；setKeyword/)
  assert.match(prompt, /页面会发出的事件（只读观察，agent 不能主动触发）：selection-change<unknown\[\]>（选中行变化）/)
  assert.match(prompt, /call_page_method/)
})

test('buildAgentContext：注入 call_page_method 传参规则 + 示例 + 当前页调用方式提示', async () => {
  const svc = await makeService()
  const prompt = svc.buildAgentContext({
    currentPage: { tag: 'user-list', params: {}, source: 'agent', at: Date.now() },
    pageExposedKeys: { 'user-list': ['refresh', 'setKeyword'] },
    recentObservations: [],
  })
  // 传参规则 + few-shot 示例
  assert.match(prompt, /方法签名里出现的参数必须放进 call_page_method 的 args/)
  assert.match(prompt, /call_page_method\(\{ name: "setKeyword", args: \["钱"\] \}\)/)
  assert.match(prompt, /call_page_method\(\{ name: "save", args: \[\{ name: "新数据源", host: "127\.0\.0\.1" \}\] \}\)/)
  // 当前页可用方法段带调用方式提示
  assert.match(prompt, /\[当前页 <user-list> 可用方法\]/)
  assert.match(prompt, /调用方式：call_page_method\(\{ name: "<方法名>", args: \[按上面签名顺序传实参\] \}\)/)
  // ack 语义（in-band）：render 回 done、call 成功回 success
  assert.match(prompt, /render 的 ack 是 \{ status: "done" \}/)
  assert.match(prompt, /call_page_method 成功时 ack 为 \{ status: "success", value\? \}/)
})

test('buildAgentContext：当前页 + pageExposedKeys 合并出 [当前页可用方法]', async () => {
  const svc = await makeService()
  const prompt = svc.buildAgentContext({
    currentPage: { tag: 'user-list', params: {}, source: 'agent', at: Date.now() },
    pageExposedKeys: { 'user-list': ['refresh', 'runtimeOnly'] },
    recentObservations: [],
  })
  assert.match(prompt, /\[当前页 <user-list> 可用方法\]/)
  assert.match(prompt, /- refresh/)
  assert.match(prompt, /- setKeyword/)
  assert.match(prompt, /- runtimeOnly/, '运行时多出的 key 也列出（无 manifest 描述，只显示名字）')
})

test('buildAgentContext：page.emit 观察渲染为 [页面事件]', async () => {
  const svc = await makeService()
  const prompt = svc.buildAgentContext({
    recentObservations: [
      {
        type: 'page.emit',
        page: 'user-list',
        event: 'selection-change',
        payload: { id: 7 },
        emittedAt: Date.now(),
      },
    ],
  })
  assert.match(prompt, /\[页面事件\] selection-change/)
  assert.match(prompt, /"id":7/)
})
