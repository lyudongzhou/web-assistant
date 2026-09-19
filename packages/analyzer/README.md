# @webassistant/analyzer

读 `wc.pages.json` + 页面源码 → 产出 `manifest.json`（v2，analyzer 写 / runtime 读 / agent 读）。

- [`@webassistant/vite-plugin-wc`](../vite-plugin-wc) 用同一份 `wc.pages.json` 产出 `dist-ce/` 的 WC bundle；两边共用
  [`@webassistant/protocol`](../protocol) 的 tag / 产物路径命名规则，不会漂移
- 静态解析（`@vue/compiler-sfc` 切块 + `@babel/parser`）+ vue-tsc 内核的类型解析 + AI 语义分析（DeepSeek）三层

---

## 1. CLI

```bash
wc-analyze --config wc.pages.json [--out manifest.json] [--tsconfig tsconfig.json] \
           [--env-file .env.local] [--ai-cache .analyze-cache.json] [--no-ai]
```

| 参数 | 说明 |
|---|---|
| `--config` / `-c` | `wc.pages.json` 路径（也可用环境变量 `WC_PAGES`），必填 |
| `--out` / `-o` | manifest 输出路径，缺省为 `wc.pages.json` 同目录 `manifest.json` |
| `--tsconfig` | tsconfig 路径，缺省取「`wc.pages.json` 同目录 `tsconfig.json`」 |
| `--env-file` | AI 环境变量文件，缺省依次读项目根 `.env.local` → `.env` |
| `--ai-cache` | AI 结果缓存，缺省 `.analyze-cache.json` |
| `--no-ai` | 只做静态 + 类型解析，跳过 AI 语义分析 |

> `bin` 指向 `dist/`，改了源码要先 build：用根脚本 `pnpm analyze`（先 build 再跑），别直接调 bin。

## 2. Library API

```ts
import { analyze, resolveComponentTypes } from '@webassistant/analyzer'

const manifest = await analyze({ configPath: 'wc.pages.json', outPath: 'manifest.json', noAi: true })
```

`analyze` 内部对整批页面**只建一次** vue-tsc program（跨文件类型解析），失败时自动降级为纯语法解析。

## 3. 解析出的字段

| manifest 字段 | 来源 |
|---|---|
| `props[]` | `defineProps` 运行时写法（行注释作 description）或类型写法 `defineProps<{}>`（展开字段） |
| `events[]` / `emits[]` | `defineEmits` 数组 / 对象 / 类型写法（元组载荷 → `payloadType`） |
| `exposes[]` | `defineExpose({...})` 的 key + 顶层函数声明处的 JSDoc + 函数签名 |
| `params[]` | 路由 path 里的 `:param`（通道缺省 `path`）+ 页面源码里 `route.query.x` 的读取（`in: 'query'`）+ `wc.pages.json` 页面条目的显式 `query` 声明 |
| `description/keywords/exampleQueries` | AI（`--no-ai` 时回退源码里的 `@description`） |

### 3.1 路由入参通道：path 与 query

agent 的 `render` 只有一个 `params` 对象；「这个参数走 path 还是走 query」由 manifest 的 `ManifestParam.in` 表达：

| 通道 | 来源 | 下发方式 |
|---|---|---|
| `path`（缺省，**不写该字段**） | `wc.pages.json` 的 `path` 里的 `:param` | 路由段 → `route.params`，并按旧契约归一为 WC props |
| `query` | 页面源码里 `route.query.x` 的读取（`src/routeScan.ts` 探测）+ 页面条目的显式 `query` 声明 | URL `?x=` → `route.query`（**path 里没声明的 params 会被 vue-router 丢弃**，所以路径外的键值只能走这条通道） |

探测覆盖：`useRoute()` 绑定名 / `const { query: q } = useRoute()` 别名 / `route.query.x` 与 `route.query['x']` /
`const { x: alias } = route.query` / 内联 `useRoute().query.x` / 模板里的 `$route.query.x`。
类型推断优先级：同名 `defineProps` 类型 > `String`/`Number`/`parseInt`/`Boolean` 包装 > 兜底字面量（`|| 1`）> `=== 'true'` > 缺省 `string`。

**读不出来的情形不猜，只出诊断**（analyze 时打印 `⚠️`）：

| 诊断 | 怎么解 |
|---|---|
| 动态键 `route.query[key]` / 整块读 `{ ...route.query }` / 读 query 的逻辑封装在别的文件（组合式函数里 `useRoute()`） | 用页面条目的 `query` 显式声明这些键 —— **只有这一类必须写** |
| `route.params.x` 与 path 不一致（vue-router 会丢弃 `Discarded invalid param`） | 在清单的 `path` 里补 `:x`；或让页面改读 `route.query.x`（再按上一行声明） |
| 显式声明与 path 段同名 | 会形成 path + query 双通道两条同名入参（合法但通常非本意）；只想留一条就去掉其中一处 |

**页面条目的 `query` 是可选的**（逃生口）：探测能拿到的键不必写。它的两个用途是**补探测盲区**（上表第一行）
和**覆盖说明 / 类型**（显式优先于探测结果）。参数说明的自动来源是声明处注释的**第一行**
（续行常是开发者向说明，不出网进 prompt）；要写完整业务口径就在 `query` 里给 `description`：

```jsonc
{ "name": "DatasourceAdmin", "path": "/datasources", "component": "src/pages/DatasourceAdmin.vue",
  "query": [{ "name": "keyword", "type": "string", "description": "按名称过滤" }] }
```

## 4. 跨文件类型解析（typeResolver）

用 vue-tsc 内核（`@vue/language-core` + `@volar/typescript`）把签名里的自定义类型展开成字段结构，agent 才知道该传什么：

```
setFilter(patch: Partial<DatasourceFilter>): Promise<DatasourceFilter>
  → (patch: { keyword?: string; datasourceType?: string; status?: string; testStatus?: string })
    => Promise<{ keyword: string; datasourceType: string; status: string; testStatus: string }>
```

展开规则（depth 上限 4 + 环检测）：

| 类型 | 行为 |
|---|---|
| 项目内类型（含 `node_modules` 里**软链**进来的 workspace 包，realpath 不在 `node_modules`） | 递归展开 `{ field: type }` |
| 外部**非泛型**（`AxiosResponse`、`Record<string, string>`） | 只打印名字，不递归 |
| 外部**泛型实例化**（`Promise<T>` / `Set<T>`） | 保留名字，类型参数继续展开 → `Promise<{ ... }>` |
| 外部 **mapped 类型**（`Partial<T>` / `Readonly<T>` / `Pick<T, K>` / `Omit<T, K>`），且类型参数含项目内类型 | 按对象展开（`?` 表达可选） |
| `T[]` / `[a: T, b: U]` | 展开元素类型，保留 `[]` / 元组结构 |

类型注解偏移会向上收敛到「起点相同的最外层类型节点」，避免 `Partial<X>` 退化成泛型声明形态 `Partial<T>`、`Foo[]` 丢掉 `[]`。

## 5. 降级路径（不破坏不用 vue-tsc 的宿主）

1. 找不到 `tsconfig.json`（或 vue 语言插件初始化失败）→ 打印 warning，退回**纯语法级**解析：
   自定义类型退化成 `Object` / `Array`，exposes 签名保留源码里的类型名字串。
2. 某个偏移映射不到虚拟 TS（模板区）、类型解析不出 → 该字段单独回退，不影响其它字段。
3. AI 无 key / 请求失败 → 回退静态 `@description`；只有**成功**的 AI 结果才写进缓存。

## 6. 已知限制

- 不解析 `defineExpose` 函数体，只取签名 + 类型 + JSDoc；`defineExpose<T>()` 泛型写法暂不支持。
- 外部泛型会展开一层类型参数，manifest 会比「只印名字」更长（例如 `Promise<DatasourceVO>` → `Promise<{ ... }>`）。
- `emits[]` 只表达「声明面」，运行时不保证与 `defineEmits` 100% 对齐（agent 参考用）。
- 优先解析 `<script setup>`（无则退回普通 `<script>`），且只扫**顶层** `defineProps` / `defineEmits` / `defineExpose` 调用；
  选项式 `setup()` / 非顶层 `defineXxx` 不解析。
- 路由 query 探测**要求绑定先于使用**（`const route = useRoute()` 出现在读取之前）—— 跨文件封装了 `useRoute()`
  （组合式函数里读 query 后 return）探测不到，用页面条目的 `query` 显式声明补。
- 模板里只认 `$route.query.x` 与脚本已绑定的路由变量名（不做完整模板表达式解析），且方括号键只支持引号字面量。