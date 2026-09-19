<template>
  <!-- @description 查询参数示例页：页面入参全部来自 URL 查询参数（path 里没有 :param），读取 → 筛选/排序/翻页 → 写回 URL -->
  <div>
    <PageHeader
      title="查询参数示例"
      description="本页的入参不在路由路径里（/query-params 没有 :param），全部走 URL 查询参数：读 route.query → 筛选 / 排序 / 翻页 → 写回 URL"
    >
      <template #actions>
        <el-button size="small" @click="reset()">重置查询</el-button>
      </template>
    </PageHeader>

    <CapabilityBadge
      :items="['查询参数 route.query', 'manifest in=query', '写回 URL', '类型推断 number']"
      hint="analyzer 从本页源码探测出这些查询参数（manifest params[].in = 'query'）：agent 只要把 keyword / page 放进 render 的 params，runtime 就会下发成 URL query；path 里没声明的 params 会被 vue-router 丢弃，所以路径外的键值只能走这条通道"
    />

    <!-- 模板里也能直接读（$route.query.tab）—— analyzer 的模板扫描同样会把它记进 manifest -->
    <div class="querybar">
      <span class="chip">tab = {{ $route.query.tab ?? '—' }}</span>
      <span class="chip">from = {{ from || '—' }}</span>
      <span class="raw">route.query = {{ JSON.stringify(route.query) }}</span>
    </div>

    <div class="filters">
      <el-input
        v-model="localKeyword"
        placeholder="按名称搜索（回车写回 ?keyword=）"
        clearable
        class="search"
        @keyup.enter="writeQuery({ keyword: localKeyword, page: '1' })"
        @clear="writeQuery({ keyword: '', page: '1' })"
      />
      <el-select
        :model-value="statusFilter"
        placeholder="状态"
        clearable
        class="status"
        @change="onStatusChange"
      >
        <el-option label="运行中" value="running" />
        <el-option label="已暂停" value="paused" />
        <el-option label="已归档" value="archived" />
      </el-select>
      <el-select :model-value="sortKey" class="sort" @change="onSortChange">
        <el-option label="按 ID 排序" value="id" />
        <el-option label="按名称排序" value="name" />
      </el-select>
      <span class="count">匹配 {{ filtered.length }} 条 · 第 {{ page }} / {{ pageCount }} 页</span>
    </div>

    <PageState
      :loading="false"
      :error="''"
      :empty="!pageRows.length"
      empty-text="没有匹配的作业（换个关键字或状态试试，或点「重置查询」）"
    >
      <el-table :data="pageRows" border>
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="作业名" width="160" />
        <el-table-column prop="cron" label="调度" />
        <el-table-column prop="owner" label="负责人" width="100" />
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="row.status === 'running' ? 'success' : row.status === 'paused' ? 'warning' : 'info'">
              {{ row.status }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        class="pager"
        layout="prev, pager, next"
        :current-page="page"
        :page-size="PAGE_SIZE"
        :total="filtered.length"
        @current-change="onPageChange"
      />
    </PageState>

    <p class="howto">
      页面入参全部来自探测器（analyzer 读源码得到）—— 清单里那段 <code>query</code> 声明是可选的，只用来覆盖参数说明。<br />
      三种驱动方式（效果完全一样）：<br />
      ① 直接改地址栏：<code>#/query-params?keyword=同步&amp;status=archived&amp;sort=name&amp;page=2&amp;tab=巡检</code><br />
      ② 让助手说：「打开查询参数示例，按名称同步筛选」→ agent 用 <code>render</code> 的 params 传 <code>keyword</code><br />
      ③ 控制台：<code>__waRuntime.navigate({ tag: 'query-params-demo', params: { keyword: '同步', page: 2 } })</code>
    </p>
  </div>
</template>

<script setup lang="ts">
// 查询参数示例 —— 把「路径外的入参」整条链路摆在一页里：
//
//   ① 读取：analyzer（packages/analyzer/src/routeScan.ts）从本页源码探测出 6 个查询参数，
//      写进 manifest 的 params（in: 'query'）—— agent 才知道「这页可以传什么」
//   ② 类型推断：keyword / status / from / tab = string，page = number（来自 Number(route.query.page || 1)）
//   ③ 写回：页面自己改筛选条件时写回 URL —— 宿主直连就是真实 URL；容器模式走内存 router → RouterBridge → runtime 再下发回来
//   ④ 可选声明：wc.pages.json 的页面条目里那段 `query` **只用来覆盖/补充参数说明**（本页用它把 sort 的取值域、
//      from 的业务含义写成业务口径）。删掉它这一页照样被探测出全部 6 个参数 —— 只有「动态键 route.query[key]」
//      「整块读 route.query」「读 query 的逻辑封装在别的文件里」这三类才**必须**在清单里声明。
//      参数说明的自动来源是声明处注释的第一行（续行是开发者向说明，不出网进 agent prompt）。
//
// 支持的读法（本页覆盖了其中 5 种，含模板 $route.query 与解构；其余见 analyzer 的 fixture RouteQueryPage.vue）：
//   route.query.x / route.query['x'] / const { query: q } = useRoute() / const q = route.query /
//   const { x } = route.query / useRoute().query.x / 模板里的 $route.query.x
//
// ⚠️ 本页**不读 route.params**：path `/query-params` 里没有 :param，而 vue-router 会丢弃
// path 里没声明的 params（Discarded invalid param）—— 路径外的键值只能走 query。
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PageHeader from '../components/PageHeader.vue'
import PageState from '../components/PageState.vue'
import CapabilityBadge from '../components/CapabilityBadge.vue'

interface JobRow {
  id: number
  name: string
  cron: string
  owner: string
  status: 'running' | 'paused' | 'archived'
}

/** 每页条数（固定值；页码才是入参） */
const PAGE_SIZE = 3
/** 页内数据集：示例只讲「查询参数」，所以不请求接口（要演示 dataSources 看 UserList / DatasourceAdmin） */
const JOBS: JobRow[] = [
  { id: 1, name: '同步用户', cron: '0 */2 * * *', owner: '张三', status: 'running' },
  { id: 2, name: '清理日志', cron: '0 3 * * *', owner: '李四', status: 'running' },
  { id: 3, name: '同步订单', cron: '*/30 * * * *', owner: '王五', status: 'paused' },
  { id: 4, name: '归档报表', cron: '0 1 * * 1', owner: '王五', status: 'archived' },
  { id: 5, name: '同步库存', cron: '*/15 * * * *', owner: '赵六', status: 'running' },
  { id: 6, name: '归档会话', cron: '0 4 * * *', owner: '钱七', status: 'archived' },
  { id: 7, name: '巡检数据源', cron: '0 */6 * * *', owner: '张三', status: 'paused' },
]

const route = useRoute()
const router = useRouter()

/** 按名称搜索（string）：`String(...)` + `|| ''` 兜底 → analyzer 推断为 string */
const keyword = computed(() => String(route.query.keyword || ''))
/** 页码（number）：`Number(...)` + `|| 1` → analyzer 推断为 number（agent 传数字也会被收口成 query 字符串） */
const page = computed(() => Number(route.query.page || 1))
/**
 * 排序字段（取值域：id | name；方括号字面量键 route.query['sort']）
 * 续行是开发者向说明，不会进 manifest —— analyzer 只取注释第一行。
 * 清单里那行显式声明（可选）把它精简成业务口径："排序字段：id | name"。
 */
const sortKey = computed(() => String(route.query['sort'] || 'id'))
/**
 * query 对象别名：`const q = route.query` —— 与 route.query 是同一个响应式对象，不会丢响应式
 * （对比：在 setup 顶层直接解构 `const { status } = route.query` 会丢响应式，所以解构要放进 computed）
 */
const q = route.query
/**
 * 来源标记（string）：外部链接 / agent 标注带进来，走别名读 `q.from`
 * 续行同样不进 manifest（只取第一行）；清单的显式声明（可选）覆盖成业务口径
 */
const from = computed(() => String(q.from || ''))

/**
 * 标签页标识（string）：模板里用 `$route.query.tab` 展示（演示模板扫描），
 * 这里再留一份脚本侧镜像 —— 写回 URL 时需要它（组合出下一份 query）
 */
const tabValue = computed(() => {
  const { tab } = route.query
  return typeof tab === 'string' ? tab : ''
})

/** 状态筛选（解构写法）：放在 computed 里才是响应式的 */
const statusFilter = computed(() => {
  const { status } = route.query
  return typeof status === 'string' ? status : ''
})

/** 输入框的本地值：回车/清空才写回 URL（否则每敲一个字都要改一次地址） */
const localKeyword = ref(keyword.value)

/** 按查询参数筛选 + 排序（纯前端切片，示例重点是入参不是取数） */
const filtered = computed(() => {
  const name = keyword.value.trim()
  const rows = JOBS.filter((job) => (statusFilter.value ? job.status === statusFilter.value : true)).filter((job) =>
    name ? job.name.includes(name) : true,
  )
  return [...rows].sort((a, b) => (sortKey.value === 'name' ? a.name.localeCompare(b.name) : a.id - b.id))
})
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE)))
/** 页码越界时夹回最后一页（agent 传 page=99 也不会白屏） */
const pageRows = computed(() => {
  const current = Math.min(Math.max(page.value, 1), pageCount.value)
  const start = (current - 1) * PAGE_SIZE
  return filtered.value.slice(start, start + PAGE_SIZE)
})

/**
 * 页面自己的查询契约（脚本侧唯一真相源）：写回 URL 时用它 + patch 组合。
 *
 * 为什么不写 `{ ...route.query, ...patch }`：整块展开 route.query 会让 analyzer 无法枚举键
 * （analyze 时出「无法枚举」诊断），也会把不认识的外部参数原样带回地址栏。
 * 默认值（sort=id / page=1）不写进 URL，地址更干净。
 */
function currentQuery(): Record<string, string> {
  return {
    keyword: keyword.value,
    status: statusFilter.value,
    sort: sortKey.value === 'id' ? '' : sortKey.value,
    page: page.value > 1 ? String(page.value) : '',
    tab: tabValue.value,
    from: from.value,
  }
}

/**
 * 把查询参数写回 URL：空字符串 = 删除该键。
 * 宿主直连：真实 URL 变化（`#/query-params?keyword=…`）；容器：内存 router → RouterBridge → runtime 再下发回来。
 */
function writeQuery(patch: Record<string, string>): void {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...currentQuery(), ...patch })) {
    if (value) next[key] = value
  }
  void router.replace({ query: next })
}

/** 状态筛选变化：写回 ?status=（空即删除）并回到第 1 页 */
function onStatusChange(value: string | undefined): void {
  writeQuery({ status: value ?? '', page: '1' })
}

/** 排序字段变化：写回 ?sort=（空即用默认 id 排序） */
function onSortChange(value: string | undefined): void {
  writeQuery({ sort: value ?? '' })
}

/** 翻页：只改 ?page=（其余筛选条件保持不变） */
function onPageChange(value: number): void {
  writeQuery({ page: String(value) })
}

/** 重置：只保留来源标记（from 一般是外部链接带进来的） */
function reset(): void {
  localKeyword.value = ''
  writeQuery({ keyword: '', status: '', sort: '', page: '' })
}
</script>

<style scoped>
.querybar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--app-space-2);
  margin-bottom: var(--app-space-3);
}
.chip {
  padding: 2px 8px;
  border: 1px solid var(--app-border, #e5e7eb);
  border-radius: 999px;
  font-size: 12px;
  background: #f8fafc;
}
.raw {
  font-family: var(--app-mono, ui-monospace, SFMono-Regular, monospace);
  font-size: 12px;
  color: #64748b;
}
.filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--app-space-2);
  margin-bottom: var(--app-space-3);
}
.filters .search {
  width: 240px;
}
.filters .status,
.filters .sort {
  width: 150px;
}
.count {
  font-size: 13px;
  color: #64748b;
}
.pager {
  margin-top: var(--app-space-3);
  justify-content: flex-end;
}
.howto {
  margin-top: var(--app-space-4);
  padding: var(--app-space-3);
  border: 1px dashed var(--app-border, #e5e7eb);
  border-radius: var(--app-radius-sm, 8px);
  font-size: 13px;
  line-height: 1.9;
  color: #475569;
}
.howto code {
  padding: 1px 5px;
  border-radius: 4px;
  background: #f1f5f9;
  font-size: 12px;
}
</style>
