# Agent Session 与页面数据回传设计

> 状态：**已实施**（D1 已定案为方案 B；`expose` 执行面与 `emit` 通知面已落地并通过端到端验收，见 openspec `agent-wc-expose-and-emit`）
> 影响包：`protocol` / `wc-runtime-core` / `wc-runtime-vue` / `chat-client` / `agent-server` / `demo-app`

## 1. 背景与目标

当前 agent 只能单向推送 `render`：它知道“有哪些页面”（manifest），但**看不到页面里的数据**，
也无法“先做一步、看到结果再做下一步”。

目标场景（验收用例）：

```
用户：“看名字为张三的用户详情”
  → agent 从 manifest 得知：user-detail 需 id；user-list 有 keyword prop 且其 /api/users 数据源含 id
  → 先渲染 user-list（keyword=张三）→ 等页面接口数据回传 → 解析出 id=1
  → 再渲染 user-detail（id=1）
```

为此需要三个新能力：**会话状态**、**双向通信**、**页面数据采集**。

## 2. 已定的四条前提

| # | 决策 | 含义 |
|---|---|---|
| P1 | **agent 有 session** | 对话历史 + 当前页面 + 页面数据快照持续保存，与连接解耦 |
| P2 | **通信用 WebSocket** | 不做“SSE + POST 回执”中间形态；HTTP 仅保留降级/健康检查 |
| P3 | **接受侵入式改老项目** | 在接口层（axios 拦截器 / 自研 http 封装）接一个 EventBus 上报响应数据 |
| P4 | **不做静默页面** | agent 的每一步操作就在渲染区可见地执行，用户能看到全过程 |

## 3. Session 模型

```ts
interface AgentSession {
  id: string                        // 前端 sessionStorage 保存（每 tab 一个），断线重连用它恢复
  createdAt: number
  lastSeenAt: number                // TTL 清理依据（默认 30min）
  history: ChatTurn[]               // 对话历史；超过 N 轮做摘要压缩
  currentPage?: {                   // 当前页面（agent 与用户都会改变它）
    tag: string
    params: Record<string, unknown>
    title?: string
  }
  pageContext: Record<string, PageDataSnapshot[]>  // tag → 该页采集到的数据（按 source 去重覆盖）
  /**
   * 页面 `defineExpose` 能力清单缓存（tag → key 列表，最近一次覆盖）。
   * chat-client 接到 runtime 的 'page-exposed-changed' 后经 ws `page.exposed` 写入；
   * prompt 构建时取 `pageExposedKeys[currentPage.tag]` 拼「当前页可用方法」。
   */
  pageExposedKeys?: Record<string, string[]>
  pendingCalls: Map<string, PendingCall>           // 进行中的 RPC（不持久化，重连即失效）
  socketId?: string                 // 当前绑定的连接；断线置空，session 仍存活
}

interface PageDataSnapshot {
  source: string                    // 命中的 dataSources.match
  rows?: unknown[]                  // 已按 fields / maxRows / mask 摘要
  data?: unknown                    // 非列表型响应
  truncated: boolean
  at: number
}

interface PendingCall {
  id: string
  name: ToolName
  args: unknown
  createdAt: number
  timeoutMs: number
  resolve: (result: ToolResult) => void
}
```

要点：

- **session 与连接解耦**：断线不丢上下文；重连发 `session.hello { sessionId }` 恢复，`pendingCalls` 直接判超时失败
- **存储抽象**：`SessionStore` 接口，先内存 `Map`，将来换 Redis 不动上层
- **多标签页隔离**：sessionId 存 `sessionStorage`（不是 localStorage），天然一 tab 一会话
- **pageContext 是“免费上下文”**：用户自己操作页面产生的数据也会进来，agent 下一轮直接可用，无需往返

## 4. WebSocket 协议

统一成 **RPC over WS**：agent 的每个“操作页面”动作 = 一次 `tool.call`，前端执行后回 `tool.result`。
这样 render / 读数据 / 未来的 page action 全走同一个模型。

```ts
// ───────── 客户端 → 服务端 ─────────
type ClientMessage =
  | { t: 'session.hello'; sessionId?: string; wcBase: string; manifestVersion: number }
  | { t: 'chat.send'; text: string }
  | { t: 'chat.cancel' }                                          // 用户打断 agent
  | { t: 'tool.result'; id: string; ok: true; data: unknown }
  | { t: 'tool.result'; id: string; ok: false; error: string; timedOut?: boolean }
  | { t: 'page.data'; tag: string; snapshot: PageDataSnapshot }    // 被动观察（用户自己操作产生）
  | { t: 'page.network.request' | 'page.network.response' | 'page.network.error' | 'page.network.timeout' }
  | { t: 'page.emit'; tag: string; event: string; payload?: unknown; at?: number }  // 页面 defineEmits（通知面）
  | { t: 'page.exposed'; tag: string; keys: string[] }             // 页面 defineExpose 的方法名（执行面）
  | { t: 'page.navigated'; tag: string; params: Record<string, unknown>; source: 'page' | 'host' | 'agent' }
  | { t: 'ping' }

// ───────── 服务端 → 客户端 ─────────
type ServerMessage =
  | { t: 'session.ready'; sessionId: string; resumed: boolean }
  | { t: 'chat.text'; delta: string }                             // 流式文本
  | { t: 'agent.step'; index: number; text: string }              // 可见执行的轨迹
  | { t: 'tool.call'; id: string; name: ToolName; args: unknown; timeoutMs: number }
  | { t: 'chat.done'; steps: number }
  | { t: 'chat.error'; message: string }
  | { t: 'pong' }

type ToolName = 'render' | 'wait_for_observation' | 'call_page_method'

/**
 * call_page_method 的 args（执行面：agent 调页面 `defineExpose` 暴露的方法）。
 * 见 §4.4 —— 它是 props 控制面之外的第二条「agent → 页面」通道。
 */
interface CallPageMethodToolArgs {
  page?: string      // 不传 = 当前页；传了 = 该容器已渲染的指定 tag
  name: string       // 必须命中 manifest.pages[].exposes[].name，否则 chat-client 拒绝执行
  args?: unknown[]   // 方法实参数组（JSON 可序列化优先）
  timeoutMs?: number
}
```

### 4.1 心跳与重连

- 客户端每 20s 发 `ping`，服务端回 `pong`；服务端 60s 无消息则关连接（session 仍保留）
- 重连后客户端必须先发 `session.hello { sessionId }`；服务端回 `session.ready { resumed: true }`
- 重连前未完成的 `tool.call` 一律当超时失败（不补发）

### 4.2 验收用例的完整时序

```
用户 ──chat.send──▶ agent
                    │ LLM 读 manifest：user-detail 需 id；user-list 有 keyword prop + /api/users 数据源
       ◀─agent.step─┤ "正在用户列表里按『张三』查找…"
       ◀─tool.call──┤ { id:'c1', name:'render',
                    │   args:{ tag:'user-list', props:{ keyword:'张三' }, waitFor:['/api/users'] },
                    │   timeoutMs: 8000 }
runtime.navigate ───┤ 渲染区可见地切到用户列表（keyword 已填入搜索框）
页面 axios 请求 ────┤
拦截器 → apiBus ────┤ core 按 dataSources 摘要（fields / maxRows / mask）
       ──tool.result▶ { id:'c1', ok:true,
                        data:{ tag:'user-list', rows:[{id:1,name:'张三',role:'管理员'}], truncated:false } }
                    │ LLM 观察到 id=1
       ◀─agent.step─┤ "找到张三（id=1），打开详情…"
       ◀─tool.call──┤ { id:'c2', name:'render', args:{ tag:'user-detail', params:{ id:1 } } }
       ──tool.result▶ { id:'c2', ok:true, data:{ tag:'user-detail' } }
       ◀─chat.text──┤ "已打开张三的用户详情，可以修改姓名/邮箱/角色。"
       ◀─chat.done──┤
```

### 4.3 失败与兼容语义

| 情况 | 处理 |
|---|---|
| `waitFor` 超时 | **不** reject，而是回 `{ ok:true, data:{ timedOut:true, rows:[] } }` —— 让 LLM 知道“没拿到数据”并自行决定下一步（追问用户 / 换策略），而不是让 ReAct 崩掉 |
| 导航失败（tag 不存在 / bundle 404） | `{ ok:false, error }`，LLM 改口径或报告用户 |
| 未知 `tool.name` | 客户端回 `{ ok:false, error:'unsupported tool' }`（向前兼容：老客户端遇新工具不致崩） |
| `call_page_method` 的 `name` 未命中 expose | 客户端回 `{ ok:false, error:'页面未暴露方法 xxx' }`，LLM 改走 render 或追问 |
| `call_page_method` 执行中抛错 / 超时 | 异常 message 原样回 `ok:false`；超时由 server 侧 `TOOL_CALL_TIMEOUT_MS` 兜底，ReAct 不挂死 |
| 页面尚无 expose（`getPageExposed` 返回 `null`） | prompt 里「当前页可用方法」段缺省，agent 退化为只用 props/dataSources |
| 未知消息 `t` | 两端均忽略并记日志（协议可演进） |
| 总步数超限 | 服务端中止并 `chat.error`，已渲染页面不回滚 |

### 4.4 执行面（`call_page_method`）与通知面（`page.emit`）

控制面（`props`）只能靠「重新 render 一个页面」间接改页面状态；`call_page_method` 补上第二条
**agent → 页面**通道：直接调页面 `defineExpose` 暴露的方法（筛选 / 刷新 / 提交），返回值经
`tool.result` 回流成 agent 后续推理的事实依据。

**能力清单的两条来源（缺一不可）**：

```
① 构建期（静态）：UserList.vue `defineExpose({ refresh, setKeyword })`
     → analyzer 静态解析 → manifest.pages[].exposes[]（name / signature / description）
     → agent-server 注入 system prompt「可调用方法」段
② 运行期（真实暴露面）：applyNavigation 视图就绪 → core broadcastPageExposed
     → bus 'page-exposed-changed' { tag, keys }（只带方法名，函数不可序列化）
     → chat-client useRuntimeHost → ws `page.exposed` → session.pageExposedKeys[tag]
     → prompt「[当前页 <tag> 可用方法]」段 = 运行时 keys ∪ manifest exposes（keys 优先，
       manifest 提供 signature/description）
```

**一次调用（实测：真实 DeepSeek，demo-app + chat-client）**：

```
用户："不要重新打开页面，直接调用当前页面暴露出来的方法，把用户列表筛选成姓钱的"
                    │ LLM 从 prompt 的「可用方法」里选中 setKeyword
       ◀─agent.step─┤ "调用当前页面的 setKeyword 方法"
       ◀─tool.call──┤ { id:'c7', name:'call_page_method', args:{ name:'setKeyword', args:['钱'] } }
chat-client ────────┤ runtime.getPageExposed(tag) → exposed.setKeyword('钱')
页面 fetch ─────────┤ 表格只剩「钱七」，搜索框同步为「钱」
       ──tool.result▶ { id:'c7', ok:true, data:1 }   // data = 返回值（过滤后条数）
       ◀─chat.text──┤ "已筛选，返回 1 条（钱七）"      // 下一轮直接引用该返回值
```

**通知面（`emit`）**：

```
页面 emit('search', '赵') → Vue CE 派发 CustomEvent（composed:false，停在容器 shadow root 内）
  → 容器按 manifest pages[].events 白名单挂的监听 → runtime 'page-event'
  → WebAssistant emit + ws `page.emit` { tag, event, payload, at }
  → session.recordPageEmit → PageObservation{ type:'page.emit', page, event, payload, emittedAt }
  → prompt 观测段：`[页面事件] search 载荷："赵"（页面：user-list）`
```

要点：

- **函数不跨边界**：expose 的函数引用始终留在浏览器，只上报 key 列表；`args` 走 JSON 序列化。
- **同一入口**：`chat-client` 执行器与验收台 `window.__waRuntime.getPageExposed()` 走的是同一个 runtime API，验收台可不起 agent 直接验证。
- **白名单优先**：容器只挂 `manifest.pages[].events` 声明的事件，避免 `*` 全量监听放大事件量。
- **MVP 边界**：只能调**已渲染**的 tag；跨页调用需页面实例注册表（未做，见附录 C）。

### 4.5 agent 动作的 ack（in-band，与调用一一对应）

每个 agent 主动动作（activity）的 ack 都以 **in-band** 方式回在 `tool.result` 里 —— 靠 function-calling 的
tool-result 通道与**那次** tool 调用一一对应，模型无需识别 id（带外通知如 `page.emit` 才对不上）。

| 动作 | ack 时机 | `tool.result` |
|---|---|---|
| `render` | 收到即 ack（不等页面/数据就绪） | `{ ok:true, data:{ status:'done', target } }` |
| `call_page_method` · Promise resolve | 等其 resolve | `{ ok:true, data:{ status:'success', target, async:true, value } }` |
| `call_page_method` · 非 Promise | 立即 | `{ ok:true, data:{ status:'success', target, async:false, value? } }` |
| `call_page_method` · reject / 超时 | 等结算 | `{ ok:false, error }` |

- `ActivityStatus = 'done' | 'success' | 'failure'` 与 `ActivityAckData` 定义在 `protocol/websocket.ts`；
  `failure` 由 `tool.result.ok = false` 表达（失败分支无 `data`）。
- **非 Promise 也判成功**：有同步返回值就带在 `value`，无则省略，由 agent 自行判断。
- wc 页面自己 `emit` 的事件**不做归因**（非 agent 发起，只作为决策辅助）。

## 5. 【待拍板 D1】render 与“等数据”是一个 RPC 还是两个

三种方案均可跑通验收用例，区别在协议形状、LLM 需要的步数、实现复杂度。

### 方案 A：render 自己等（一个 RPC 包完“渲染 + 取数据”）

```ts
// s2c
{ t:'tool.call', id:'c1', name:'render', timeoutMs:8000,
  args:{ tag:'user-list', props:{ keyword:'张三' }, waitFor:['/api/users'] } }
// c2s（等到命中 waitFor 的响应才发）
{ t:'tool.result', id:'c1', ok:true,
  data:{ tag:'user-list', rows:[{id:1,name:'张三'}], truncated:false } }
```

- LLM 工具签名：`go_to_page({ tag, props?, params?, waitFor?: string[] })` → 返回值里就带数据
- **优**：LLM 一步到位（验收用例只需 2 步 ReAct）；token 最省；往返次数最少
- **劣**：`render` 职责不单一（导航 + 等待）；前端要在一个 RPC 内管“导航完成”与“数据到齐”两个异步条件
- **实现**：core 新增 `navigateAndCollect(target, waitFor, timeout)`；内部一个 Promise.race([数据齐, 超时])

### 方案 B：render 立即返回，另一个工具等数据

```ts
{ t:'tool.call', id:'c1', name:'render', args:{ tag:'user-list', props:{ keyword:'张三' } } }
{ t:'tool.result', id:'c1', ok:true, data:{ tag:'user-list' } }          // 立即回
{ t:'tool.call', id:'c2', name:'read_page_data', timeoutMs:8000,
  args:{ tag:'user-list', source:'/api/users', wait:true } }
{ t:'tool.result', id:'c2', ok:true, data:{ rows:[{id:1,name:'张三'}] } }
```

- LLM 工具：`go_to_page({...})` + `read_page_data({ tag, source, wait })`
- **优**：职责单一；`read_page_data` 可单独用于“读已有快照”（`wait:false` 时零往返）；前端实现最直白
- **劣**：验收用例变成 3~4 步 ReAct（每步一次 LLM 调用）→ 延迟与 token 变高；LLM 可能忘了调 `read_page_data`（靠 prompt 约束）
- **实现**：core 新增 `waitForPageData(tag, source, timeout)`；与 navigate 互不耦合

### 方案 C：两种都支持（render 带 waitFor 时等，不带时立即返）

- LLM 工具：同时提供 `waitFor` 参数与独立的 `read_page_data`
- **优**：既能一步到位，也能事后补拉；对 LLM 宽容（忘了带 waitFor 也能补救）
- **劣**：两条路径都要实现与测试；prompt 要说清何时用哪种，否则 LLM 会乱选
- **实现**：= A + B（core 两个方法共用底层的 dataWaiter）

### 对比表

| 维度 | A（合一） | B（分离） | C（都支持） |
|---|---|---|---|
| 验收用例的 LLM 步数 | 2 | 3~4 | 2（带 waitFor） |
| 单轮延迟 | 最低 | 高（多一次 LLM 往返） | 最低 |
| token 消耗 | 最低 | 较高 | 最低 |
| 协议复杂度 | 低 | 低 | 中 |
| core 实现复杂度 | 中（一个方法两个异步条件） | 低 | 高 |
| 职责单一性 | 差 | 好 | 中 |
| “读已有快照”能力 | 靠 pageContext 进 prompt | 工具显式提供 | 两者都有 |
| 失败定位（谁超时） | 略模糊（导航还是数据？需在 result 里区分） | 清晰 | 清晰 |

### 建议（供 review 参考，未定）

从“用户体验与成本”看 **A** 最优；从“工程洁癖”看 **B** 最优。
若选 A，建议在 `tool.result.data` 里区分失败阶段（`{ navigated:true, timedOut:true }`）以弥补它唯一的短板。
若选 C，必须在 system prompt 里给出硬规则（如“需要数据就一定带 waitFor，read_page_data 仅用于读旧快照”）。

## 6. 老项目的侵入点：`apiBus`（共 2 行）

不用 `window` 全局，也不需要老项目的 http 封装能拿到 Vue context。
利用已有的硬约束「**一个 framework 批次 = 一次构建**」：批次内 `@webassistant/wc-runtime-vue`
是单模块实例，所以它导出的模块级 bus 在容器与所有页面/工具模块之间是同一个。

```ts
// ① 老项目的 http 封装（唯一侵入点）
import { apiBus } from '@webassistant/wc-runtime-vue'

http.interceptors.response.use((res) => {
  apiBus.report({ url: res.config.url, method: res.config.method, data: res.data })  // ← 加这一行
  return res
})

// ② 批次容器入口（container.ts）
export default defineVueContainer({
  setup(context) {
    apiBus.attach(context.reportApiData)   // ← 加这一行
  },
})
```

之后的脏活全由 **core** 干（老项目不关心）：

1. 补上当前 `tag`（core 知道 `nav.current()`）
2. 按 `manifest.dataSources[].match` 匹配 url，**未命中直接丢弃**
3. 按 `fields` / `maxRows` / `mask` 摘要 —— **敏感字段不出浏览器**
4. 命中某个 `waitFor` 的 → resolve 对应 `tool.call`；否则 → 以 `page.data` 推送进 session

```ts
// apiBus 的形状（框架无关，非 axios 的封装也能调）
interface ApiReport { url?: string; method?: string; data: unknown; status?: number }
interface ApiBus {
  report(payload: ApiReport): void
  attach(sink: (payload: ApiReport) => void): () => void   // 容器接入；未 attach 时 report 静默丢弃
}
```

> 未 attach 就静默丢弃，意味着老项目在**自己的 SPA 里跑**时这行代码无副作用。

## 7. manifest 扩展：`dataSources`

```jsonc
{
  "tag": "user-list",
  "props": [
    { "name": "keyword", "type": "String",
      "description": "按姓名或邮箱过滤；agent 可用它定位某个用户以取得其 id" }
  ],
  "dataSources": [
    { "match": "/api/users",
      "fields": ["id", "name", "email", "role"],
      "mask": ["phone"],
      "maxRows": 20,
      "primaryKey": "id",
      "description": "用户列表数据，含 id —— 需要 userId 时可来这里取" }
  ]
}
```

`dataSources` 是 agent **规划的依据**：它让 LLM 事先知道“进 user-list 能拿到带 id 的用户数据”，
才敢做两步计划。没有它，LLM 只能瞎猜。

## 8. props 是 agent 的“控制面”（老项目必须让步的一处）

当前 demo 的 `UserList.vue` **没有** keyword prop，搜索词是内部 state，agent 摸不到：

```ts
// 现状（agent 无法驱动）
const keyword = ref('')

// 改成（agent 可驱动，且本身也是更好的组件设计）
const props = defineProps({
  users: { type: Array as PropType<User[]>, default: () => [] },
  // agent 可用它按姓名/邮箱定位用户（会同步到搜索框）
  keyword: { type: String, default: '' },
})
const keyword = ref(props.keyword)
watch(() => props.keyword, (v) => (keyword.value = v))
```

**结论**：`props` = agent 的控制面，`dataSources` = agent 的观测面，`events` = agent 的通知面，
`defineExpose` = agent 的**执行面**。页面要接受 agent 驱动，必须把“可被外部决定的输入”显式声明成
props；把“可被外部直接调用的动作”显式 `defineExpose`（其余三面由 runtime 透明采集，页面零感知）。

## 9. system prompt 的关键规则

```
可用页面（含 props / params / events / dataSources 描述）：……
当前页面：{currentPage}
已知页面数据（摘要）：{pageContext}

规则：
1. 若目标页面所需参数（如 id）用户没直接给出，但另一个页面的 dataSources 声明能提供它：
   先 render 那个页面（用它的 props 过滤缩小范围）并声明 waitFor，
   拿到数据后从中解析出参数，再 render 目标页面。
2. 每一步先用 agent.step 用一句人话说明你在做什么。
3. 若数据超时或未命中，不要猜测 id，改为追问用户或展示列表让用户选。
4. 已在 pageContext 里的数据不要重复拉取。
```

## 10. 可见执行的 UX（P4：不做静默页面）

| 元素 | 设计 |
|---|---|
| 渲染区顶部 | 操作条：`● agent 正在操作 · 步骤 1/2 · 用户列表（keyword=张三）` + 「打断」按钮（发 `chat.cancel`） |
| 对话区 | 每个 `agent.step` 插一条浅色系统气泡，用户能看懂 agent 的推理路径 |
| 页面切换 | 不加人为延时 —— 等接口本身就有几百 ms 的自然停留，足够看清 |
| 冲突处理 | agent 操作期间渲染区加半透明遮罩（防误点导致导航冲突），打断后立即解除 |
| 失败 | `timedOut` 时步骤条标红：`未取到用户列表数据，已改为直接询问` |
| 用户中途导航 | 页面自己的 `router.push` 会发 `page.navigated{source:'page'}`，agent 下一轮知道页面变了 |

## 11. agent-server 结构（Nest + Fastify）

```
agent-server/src/
├── main.ts                        # NestFactory(FastifyAdapter) + ws
├── app.module.ts
├── gateway/
│   ├── agent.gateway.ts           # @WebSocketGateway：socket↔session 绑定、消息路由、心跳
│   └── rpc.service.ts             # ★ pendingCalls：call(name,args,timeout) → Promise<ToolResult>
├── session/
│   ├── session.service.ts         # 取/建/恢复/TTL 清理、history 压缩、pageContext 写入
│   └── session.store.ts           # 接口 + 内存实现（可换 Redis）
├── agent/
│   ├── agent.service.ts           # Cline SDK ReAct 编排、步数上限、cancel
│   └── prompt.service.ts          # manifest + dataSources + currentPage + pageContext → system prompt
├── tools/
│   ├── render.tool.ts             # 走 rpc.call('render', …)（是否带 waitFor 取决于 D1）
│   ├── read-page-data.tool.ts     # 读 session.pageContext（零往返）/ 或等数据（D1=B、C）
│   └── tools.module.ts            # 注册表（zod 校验入参）
├── manifest/manifest.service.ts   # 加载 + 监听变更
└── health.controller.ts           # GET /health
```

工程注意：

- 用 `@nestjs/platform-fastify`；SSE 降级通道若保留，建议裸写 `reply.raw`（避开 `@Sse()` 的 Observable 桥接）
- **agent-server 的 tsconfig 单独放宽**：开 `experimentalDecorators` / `emitDecoratorMetadata`，
  关掉 `verbatimModuleSyntax`（与装饰器元数据冲突）—— 其余包仍用仓库基线
- Cline SDK 是回调式事件流，在 `agent.service` 里直接转成 `gateway.send()`，不引入 RxJS

## 12. 待拍板清单

| # | 决策点 | 选项 | 建议 |
|---|---|---|---|
| **D1** | render 与等数据是一个还是两个 RPC | A 合一 / B 分离 / C 都支持（第 5 节） | 待定 |
| D2 | sessionId 存储 | `sessionStorage`（一 tab 一会话）/ `localStorage`（跨 tab 共享） | sessionStorage |
| D3 | history 压缩 | 直接截断最近 N 轮 / LLM 摘要 | 先截断（N=10） |
| D4 | 是否保留 HTTP `POST /chat` | 保留（单步降级）/ 删除 | 保留 |
| D5 | `dataSources` 声明方式 | `wc.pages.json` 手写 / analyzer 从代码推断 | 先手写（推断不可靠） |
| D6 | `chat.cancel` 语义 | 仅停推理 / 并回滚到操作前页面 | 仅停推理（回滚会让用户困惑） |
| D7 | 上报粒度 | 每个响应都上报 / 页面就绪后批量 | 每个响应（简单，已有白名单限流） |
| D8 | 超时/上限数值 | `timeoutMs` 默认 8s、总步数 6、单轮 60s | 先用这组，可配 |
| D9 | mask 在哪侧 | 前端（不出浏览器）/ 服务端 | 前端 |
| D10 | ws 鉴权 | 无（研究阶段）/ 握手带 token | 研究阶段无，接入 ontology 前补 |
| D11 | expose 执行面 / emit 通知面 | 是否纳入本轮 | **已纳入并落地**（`agent-wc-expose-and-emit`） |

## 13. 实施步骤

| 步 | 内容 | 验收 |
|---|---|---|
| 0 | **本文档**（待 review） | 协议表 / session 模型 / 侵入点 / 风险 / 待拍板清单 均成文 |
| 1 | `protocol`：ws 消息联合类型、`dataSources`、`PageDataSnapshot`、`AgentSession` | `pnpm typecheck` 通过；类型即契约 |
| 2 | `agent-server`：Nest + TS 重写（session + gateway + rpc + tools + prompt） | ws 连上、`session.ready`、单步 render 可用；断线重连保上下文 |
| 3 | `wc-runtime-core` / `-vue`：`apiBus`、`reportApiData`、dataSources 摘要、tool.call 执行器 | core 单测覆盖摘要/白名单/mask/超时；vue 侧冒烟 |
| 4 | `chat-client`：SSE → ws、步骤条 + 遮罩 + 打断 | 浏览器实测可见执行轨迹 |
| 5 | `demo-app`：`serve.mjs` 加 `/api/users?name=` mock、拦截器、`keyword` prop、`dataSources` | 「看名字为张三的用户详情」一轮内自动两跳，渲染区可见全过程 |

## 14. 风险与对策

| 风险 | 对策 |
|---|---|
| ReAct 挂死 | 每个 `tool.call` 有 `timeoutMs` + 总步数上限 + 单轮总时长上限（D8） |
| token 爆炸 | `dataSources.fields/maxRows` 前端截断 + session 只留最近 3 个页面快照 + history 压缩 |
| 隐私 | `mask` 字段在浏览器侧就抹掉；`fields` 白名单（未声明字段一律不上报） |
| 用户中途干预 | 遮罩 + `chat.cancel`；`page.navigated` 让 agent 知道页面被人改了 |
| 断线 | session 存活、`pendingCalls` 判超时；重连 `session.hello` 恢复 |
| manifest 版本漂移 | `session.hello` 带 `manifestVersion`，不一致时提示重建 |
| 老项目不用 axios | `apiBus.report()` 与库无关，任何 http 封装都能调 |
| 页面未声明 keyword prop | agent 无法缩小范围 → 退化为“展示列表让用户选”（prompt 规则 3） |

---

## 附录 A：D1 三种方案的代码级差异

### core 对外 API

```ts
// 方案 A（合一）
interface Runtime {
  navigate(target: NavigationTarget): Promise<NavigationResult>
  /** 新增：导航并等待指定数据源到齐；超时不报错，回 timedOut */
  navigateAndCollect(
    target: NavigationTarget,
    waitFor: string[],
    timeoutMs: number,
  ): Promise<{ navigated: boolean; snapshots: PageDataSnapshot[]; timedOut: boolean }>
}

// 方案 B（分离）
interface Runtime {
  navigate(target: NavigationTarget): Promise<NavigationResult>
  /** 新增：等（或直接读）指定页面的数据 */
  readPageData(options: {
    tag?: string
    source?: string
    wait?: boolean
    timeoutMs?: number
  }): Promise<{ snapshots: PageDataSnapshot[]; timedOut: boolean }>
}

// 方案 C = A + B（共用底层 dataWaiter）
```

### agent 侧工具声明

```ts
// A
go_to_page({ tag, params?, props?, waitFor?: string[] })
//   → { opened, rows?, truncated?, timedOut? }

// B
go_to_page({ tag, params?, props? })            // → { opened }
read_page_data({ tag?, source?, wait?: boolean })// → { rows, truncated, timedOut }

// C
go_to_page({ tag, params?, props?, waitFor? })   // 带 waitFor 就等
read_page_data({ tag?, source?, wait? })         // 仅用于读旧快照
```

### 验收用例的 ReAct 轨迹

```
A（2 步）
  1. go_to_page({ tag:'user-list', props:{keyword:'张三'}, waitFor:['/api/users'] })
     → { opened:'user-list', rows:[{id:1,name:'张三'}] }
  2. go_to_page({ tag:'user-detail', params:{ id:1 } })

B（3 步）
  1. go_to_page({ tag:'user-list', props:{keyword:'张三'} })  → { opened:'user-list' }
  2. read_page_data({ tag:'user-list', source:'/api/users', wait:true })
     → { rows:[{id:1,name:'张三'}] }
  3. go_to_page({ tag:'user-detail', params:{ id:1 } })

C（2 步，与 A 同；但 LLM 忘带 waitFor 时可用第 2 步补救）
```

## 附录 B：与现有实现的衔接点

| 现有能力 | 本设计如何复用 |
|---|---|
| `defineVueContainer({ setup(context) })` 一次性钩子 | `apiBus.attach(context.reportApiData)` 就接在这里 |
| `RuntimeServices`（框架无关约束） | 新增 `reportApiData`；仍然只传纯函数/纯数据 |
| runtime `page-event` 事件 | 直接映射成 ws 的 `page.event` |
| runtime `navigate` 事件（带 `source`） | 直接映射成 ws 的 `page.navigated` |
| core 的 `props.ts` 归一（按 manifest type coerce） | `render` 的 `props`/`params` 照旧走这套 |
| `chat-client` 的 `useAgentChat` | 拆成 `useAgentSocket`（ws）+ 保留消息流式拼接逻辑 |
| 验收台 `wc-demo.html` | 可加一个“模拟 tool.call”按钮，不起 agent 就能测 core 的执行器 |

## 附录 C：不在本轮范围

- ~~`call_page_action`（调页面 `defineExpose` 方法）~~ —— **已实现为 `call_page_method`**（见 §4.4）；遗留边界是「只能调已渲染 tag」，跨页调用需引入页面实例注册表
- agent 直连业务 API（绕过页面取数）—— 与本设计不冲突，可作为另一类工具并存
- 多批次（vue + react）同时在线时的 `dataSources` 命名冲突 —— 待遇到再议；react 批次的 `getPageExposed` adapter 亦未实现
- 持久化（Redis）与多实例部署 —— `SessionStore` 接口已预留
