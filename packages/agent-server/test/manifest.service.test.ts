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
    rules: [
      { name: 'domain-conventions', instructions: '演示数据不得说成生产数据。' },
      { name: 'legacy', instructions: '已停用规则。', disabled: true },
    ],
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
        params: [
          { name: 'id', type: 'string' },
          { name: 'keyword', type: 'string', in: 'query', description: '按名称过滤' },
          { name: 'page', type: 'number', in: 'query' },
        ],
        rules: [
          { name: 'page-rule', instructions: '本页只读，不要调用删除。' },
          { name: 'page-legacy', instructions: '已停用页面规则。', disabled: true },
        ],
        exampleQueries: ['我想看用户列表'],
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
  assert.match(prompt, /call_page_method\(\{ name: "nextPage" \}\)/)
  assert.match(prompt, /call_page_method\(\{ name: "openCreateDialog", args: \[\{ name: "订单库", host: "10\.0\.0\.9", port: 3306 \}\] \}\)/)
  // 写入不进执行面：prompt 必须明确「agent 不代用户提交」
  assert.match(prompt, /保存、新增、删除等写后端的动作不在可调用方法里/)
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

test('buildAgentContext：入参按通道分段（路径参数 / 查询参数）', async () => {
  const svc = await makeService()
  const prompt = svc.buildAgentContext()
  // path 通道（无 in 字段）只出现在「路径参数」行
  assert.match(prompt, /路径参数：id\(string\)/)
  assert.doesNotMatch(prompt, /路径参数：[^\n]*keyword/)
  // query 通道单独一行，带 description 与下发方式说明
  assert.match(prompt, /查询参数：keyword\(string\)：按名称过滤、page\(number\)/)
  assert.match(prompt, /会作为 URL query 下发，页面通过 route\.query 读取/)
  // 传参规则（避免 agent 用 props / 自己拼 path 承载参数）
  assert.match(prompt, /render 的 params 同时承载两种入参通道/)
})

test('buildAgentContext：注入 manifest.rules（跳过 disabled）', async () => {
  const svc = await makeService()
  assert.equal(svc.getRules().length, 2)
  const prompt = svc.buildAgentContext()
  assert.match(prompt, /项目规则（来自本项目 manifest，优先于上面的通用规则；冲突时以项目规则为准）：/)
  assert.match(prompt, /- \[domain-conventions\] 演示数据不得说成生产数据。/)
  assert.doesNotMatch(prompt, /已停用规则/, 'disabled 的规则不注入 prompt')
})

test('buildAgentContext：注入页面级 rules（跳过 disabled）', async () => {
  const svc = await makeService()
  const prompt = svc.buildAgentContext()
  assert.match(prompt, /页面规则（只在该页面生效）：/)
  assert.match(prompt, /- \[page-rule\] 本页只读，不要调用删除。/)
  assert.doesNotMatch(prompt, /已停用页面规则/, 'disabled 的页面规则不注入 prompt')
  const headingCount = (prompt.match(/页面规则（只在该页面生效）：/g) ?? []).length
  assert.equal(headingCount, 1, '只有声明了规则的页面才有该段')
})

test('buildWelcome：返回结构化载荷（欢迎语文本 + 能力清单）', async () => {
  const svc = await makeService()
  const welcome = svc.buildWelcome()
  assert.ok(welcome, '默认开启欢迎语')
  assert.match(welcome.text, /智能助手/)
  assert.match(welcome.text, /UserList/)
  // 能力清单来自 manifest 页面（tag / name / 示例说法）
  assert.deepEqual(welcome.capabilities.map((cap) => cap.tag), ['user-list', 'user-detail'])
  assert.equal(welcome.capabilities[0].name, 'UserList')
  assert.deepEqual(welcome.capabilities[0].examples, ['我想看用户列表'])
  assert.equal(welcome.capabilities[1].examples, undefined, '无 exampleQueries/keywords 时省略 examples')
})

test('buildWelcome：WELCOME_MESSAGE 覆盖 text（能力清单不变）/ WELCOME_ENABLED=0 关闭', async () => {
  const svc = await makeService()
  try {
    process.env.WELCOME_MESSAGE = '自定义欢迎语'
    const welcome = svc.buildWelcome()
    assert.equal(welcome?.text, '自定义欢迎语')
    assert.equal(welcome?.capabilities.length, 2, '覆盖文案不影响能力清单')
  } finally {
    delete process.env.WELCOME_MESSAGE
  }
  try {
    process.env.WELCOME_ENABLED = '0'
    assert.equal(svc.buildWelcome(), null)
  } finally {
    delete process.env.WELCOME_ENABLED
  }
})
