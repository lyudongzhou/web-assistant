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
| `params[]` | 路由 path 里的 `:param`（纯正则） |
| `description/keywords/exampleQueries` | AI（`--no-ai` 时回退源码里的 `@description`） |

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