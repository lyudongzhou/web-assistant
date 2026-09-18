<template>
  <!-- @description 用户列表页：展示用户数据，支持按姓名/邮箱搜索、分页、查看详情、删除与新增用户 -->
  <div>
    <PageHeader title="用户管理" description="列表页：agent 从这里拿到可继续导航的用户 id">
      <template #actions>
        <el-input
          v-model="keyword"
          placeholder="搜索姓名 / 邮箱"
          style="width: 220px"
          clearable
          @input="onSearch"
        />
        <el-button size="small" @click="openCreate">新增用户</el-button>
        <el-button size="small" link type="danger" @click="load('500')">模拟接口失败</el-button>
      </template>
    </PageHeader>

    <CapabilityBadge
      :items="['控制面 props', 'call_page_method', 'emit 通知面', '观测面 report', 'dataSources 白名单']"
      hint="原始响应直接上报；字段与行数边界声明在 wc.pages.json 的 dataSources"
    />

    <p v-if="notice" class="notice">{{ notice }}</p>

    <PageState
      :loading="loading"
      :error="error"
      :empty="!rows.length"
      empty-text="没有匹配的用户"
      @retry="load()"
    >
      <el-table :data="pagedRows" border>
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="姓名" width="120" />
        <el-table-column prop="email" label="邮箱" />
        <el-table-column prop="role" label="角色" width="110" />
        <el-table-column label="最近登录" width="170">
          <template #default="{ row }">{{ formatTime(row.lastLoginAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="150">
          <template #default="{ row }">
            <el-button size="small" @click="onView(row)">详情</el-button>
            <el-popconfirm title="确认删除该用户？" @confirm="onDelete(row)">
              <template #reference>
                <el-button size="small" type="danger">删除</el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>

      <div class="pagination">
        <el-pagination
          background
          layout="prev, pager, next"
          :total="rows.length"
          :page-size="pageSize"
          :current-page="page"
          @current-change="onPageChange"
        />
      </div>
    </PageState>

    <el-dialog v-model="createVisible" title="新增用户" width="420px">
      <p v-if="createHint" class="prefill">{{ createHint }}</p>
      <el-form label-width="72px">
        <el-form-item label="姓名">
          <el-input v-model="createForm.name" />
        </el-form-item>
        <el-form-item label="邮箱">
          <el-input v-model="createForm.email" />
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="createForm.role" style="width: 100%">
            <el-option label="管理员" value="管理员" />
            <el-option label="普通用户" value="普通用户" />
            <el-option label="访客" value="访客" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="submitCreate">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
// 用户管理 —— 演示「一个有界上报的列表页」：
//
//   控制面：props.keyword（agent 可直接传，见 manifest 的 props）
//   观测面：listUsers() 内部把**原始响应**连同 url 上报；runtime 按清单里的 dataSources
//           （fields: id/name/role、maxRows: 6）摘要后才出网 —— email 不进 agent 视野
//   执行面：defineExpose 的 refresh / setKeyword / setPage / nextPage / prevPage / openDetail /
//           openCreateDialog（call_page_method）—— 只读 + 视图操作 + 预填；写方法（submitCreate）不 expose
//   通知面：defineEmits 的 search / delete / page-change / create
//
// 注意 host 模式（用法 B）的已知差异：CE 事件**不会自动捕获**，需要页面用 ctx.emit() 才能到 agent；
// 本页两种写法都保留（defineEmits + runtime.emit），对照表见 packages/demo-app/README.md。
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { tryUseRuntimeServices } from '@webassistant/wc-runtime-vue'
import PageHeader from '../components/PageHeader.vue'
import PageState from '../components/PageState.vue'
import CapabilityBadge from '../components/CapabilityBadge.vue'
import { createUser, deleteUser, listUsers } from '../api/users'
import { reportData } from '../utils/httpClient'
import { AGENT_PREFILL_HINT, hasAgentPreset, mergeAgentPreset, prefillReceipt } from '../utils/agentPreset'
import type { AgentPrefillReceipt, PagerSnapshot } from '../utils/agentPreset'
import type { MockFail, User, UserCreateForm } from '../api/types'

const props = defineProps({
  /** 搜索关键词（agent 通过 props 传入过滤条件） */
  keyword: { type: String, default: '' },
})

const emit = defineEmits(['search', 'delete', 'page-change', 'create'])

const router = useRouter()
/** runtime 注入的服务（在「没挂助手」的纯 SPA 里为 null → 用 try 版本） */
const runtime = tryUseRuntimeServices()

const keyword = ref(props.keyword)
const rows = ref<User[]>([])
const loading = ref(false)
const error = ref('')
const notice = ref('')
const page = ref(1)
const pageSize = 5

const pagedRows = computed(() =>
  rows.value.slice((page.value - 1) * pageSize, page.value * pageSize),
)

/** 总页数（空列表也算一页） */
const pageCount = computed(() => Math.max(1, Math.ceil(rows.value.length / pageSize)))

function formatTime(value: string): string {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

async function load(fail?: MockFail): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    rows.value = await listUsers({ keyword: keyword.value.trim() || undefined, fail })
    page.value = 1
  } catch (cause) {
    const message = (cause as Error).message
    rows.value = []
    error.value = message
    // 失败也上报，且**不带 url**（带 url 会被 dataSources 的字段白名单裁空 —— 错误载荷要原样出网）
    reportData('user-list-error', { message, url: '/api/users' })
  } finally {
    loading.value = false
  }
}

function onSearch(): void {
  page.value = 1
  void load()
  emit('search', keyword.value)
  runtime?.emit('search', keyword.value)
}

function onPageChange(next: number): void {
  page.value = next
  emit('page-change', next)
}

function onView(row: User): void {
  void router.push({ name: 'UserDetail', params: { id: row.id } })
}

async function onDelete(row: User): Promise<void> {
  try {
    await deleteUser(row.id)
    notice.value = `已删除：${row.name}`
    await load()
  } catch (cause) {
    error.value = (cause as Error).message
  }
  emit('delete', row)
  runtime?.emit('delete', row)
}

// —— 新增用户 ——
/** 弹窗默认值：本地按钮与 agent 预填共用（agent 只覆盖它显式传入的字段） */
const DEFAULT_CREATE_FORM: UserCreateForm = { name: '', email: '', role: '普通用户' }
const createVisible = ref(false)
const createHint = ref('')
const creating = ref(false)
const createForm = ref<UserCreateForm>({ ...DEFAULT_CREATE_FORM })

/** 本地「新增用户」按钮：清空表单重开并通知（agent 入口是下面的 openCreateDialog，不发通知） */
function openCreate(): void {
  openCreateDialog()
  emit('create')
}

/** agent 可调用（只预填、不提交）：打开「新增用户」弹窗并用 preset 预填，返回表单快照 —— 只打开、不落库，提交仍由用户点「确定」（submitCreate 未 expose） */
function openCreateDialog(preset?: Partial<UserCreateForm>): AgentPrefillReceipt<UserCreateForm> {
  createForm.value = mergeAgentPreset(DEFAULT_CREATE_FORM, preset)
  createVisible.value = true
  createHint.value = hasAgentPreset(preset) ? AGENT_PREFILL_HINT : ''
  return prefillReceipt('新增用户', createForm.value)
}

/** 弹窗「确定」：新建 → 关弹窗 → 刷新列表（只给人点；agent 调不到） */
async function submitCreate(): Promise<void> {
  creating.value = true
  try {
    const created = await createUser(createForm.value)
    notice.value = `已新增：${created.name}（id=${created.id}）`
    createVisible.value = false
    await load()
  } catch (cause) {
    error.value = (cause as Error).message
  } finally {
    creating.value = false
  }
}

// —— agent 可调用（defineExpose → analyzer → manifest.exposes → prompt）——
// 只暴露「只读 / 视图操作 / 预填」三类；删除、提交这类写后端的动作统统不进执行面。
/** agent 可调用（只读）：重新拉取列表（可带关键词覆盖搜索框），返回本次条数 */
async function refresh(keywordText?: string): Promise<number> {
  if (typeof keywordText === 'string') keyword.value = keywordText
  await load()
  return rows.value.length
}

/** agent 可调用（视图操作）：设置筛选关键词并立即查询（等价于在搜索框输入后点搜索） */
async function setKeyword(kw: string): Promise<number> {
  return refresh(kw)
}

/** 分页快照：agent 据此判断「还有没有下一页」 */
function pagerState(): PagerSnapshot {
  return { page: page.value, pageCount: pageCount.value, rowCount: rows.value.length }
}

/** agent 可调用（视图操作）：跳到指定页（等价于点分页器页码；越界会收敛到首/末页），返回分页快照 */
function setPage(next: number): PagerSnapshot {
  const raw = Math.trunc(Number(next))
  const target = Math.min(Math.max(Number.isFinite(raw) ? raw : 1, 1), pageCount.value)
  onPageChange(target)
  return pagerState()
}

/** agent 可调用（视图操作）：下一页（等价于点分页器「下一页」；已在末页时停在原页） */
function nextPage(): PagerSnapshot {
  return setPage(page.value + 1)
}

/** agent 可调用（视图操作）：上一页（等价于点分页器「上一页」；已在首页时停在原页） */
function prevPage(): PagerSnapshot {
  return setPage(page.value - 1)
}

/** agent 可调用（导航）：打开某个用户的详情页（等价于点行内「详情」）；不在列表里就报错，让 agent 自己调整筛选 */
function openDetail(id: string | number): { target: string; id: string } {
  const row = rows.value.find((item) => String(item.id) === String(id))
  if (!row) throw new Error(`当前列表里没有用户 ${id}（可先用 setKeyword / refresh 确认可见范围）`)
  onView(row)
  return { target: 'UserDetail', id: String(row.id) }
}

defineExpose({ refresh, setKeyword, setPage, nextPage, prevPage, openDetail, openCreateDialog })

// agent 传 props.keyword 变化时同步搜索框（控制面入口）
watch(
  () => props.keyword,
  (next) => {
    if (next === undefined || next === keyword.value) return
    keyword.value = next
    page.value = 1
    void load()
  },
)

onMounted(() => void load())
</script>

<style scoped>
.prefill {
  margin: 0 0 var(--app-space-3);
  padding: var(--app-space-2) var(--app-space-3);
  border-radius: var(--app-radius-sm);
  background: var(--app-primary-weak);
  color: #4338ca;
  font-size: 12px;
}
.notice {
  margin: 0 0 var(--app-space-3);
  padding: var(--app-space-2) var(--app-space-3);
  border-radius: var(--app-radius-sm);
  background: #ecfdf5;
  color: #047857;
  font-size: 12px;
}
.pagination {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--app-space-4);
}
</style>
