<template>
  <!-- @description 数据源管理页：展示数据源列表，支持带 token 的自检请求与新增数据源 -->
  <div>
    <PageHeader title="数据源管理" description="演示宿主 store 镜像、token 注入与「只读 + 新增」的页面级规则">
      <template #actions>
        <el-button size="small" :loading="loading" @click="refresh()">刷新</el-button>
        <el-button size="small" type="primary" @click="openCreate">新增数据源</el-button>
      </template>
    </PageHeader>

    <CapabilityBadge
      :items="['页面级 rules', '类型化 props/emits', '查询参数 route.query', 'call_page_method', '宿主 store 镜像', '观测面 report']"
      hint="本页的类型写在 src/types/datasource.ts（跨文件自定义类型 → analyzer 展开进 manifest）；页面级规则见 rules/datasource-page.md"
    />

    <!-- 宿主 store 镜像：页面代码零改动读 pinia。
         容器模式：值由宿主推来（容器 createStoreMirror + 宿主 createHostStorePusher）
         宿主直连模式：就是宿主自己的 store 实例 -->
    <div class="mirror">
      <span>
        当前身份：{{ auth.user ? `${auth.user.name}（${auth.user.role}）` : '未登录' }} · token
        {{ auth.token ? `${auth.token.slice(0, 10)}…` : '（空）' }}
      </span>
      <el-button size="small" link type="primary" @click="whoami()">
        带 token 请求一次 /api/whoami
      </el-button>
      <span class="echo">{{ authEcho }}</span>
    </div>

    <p v-if="notice" class="notice">{{ notice }}</p>

    <!-- 查询参数通道：?keyword=xxx 由 analyzer 探测进 manifest（params[].in='query'），
         agent 只要把 keyword 放进 render 的 params，runtime 就会下发成 URL query -->
    <p v-if="keyword" class="notice">当前按名称过滤：{{ keyword }}（URL 查询参数 keyword）</p>

    <PageState
      :loading="loading"
      :error="error"
      :empty="!rows.length"
      empty-text="暂无数据源"
      @retry="refresh()"
    >
      <el-table :data="rows" border @row-click="onSelect">
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="名称" width="150" />
        <el-table-column prop="host" label="主机" />
        <el-table-column prop="port" label="端口" width="90" />
        <el-table-column label="类型" width="100">
          <template #default="{ row }">{{ row.kind }}</template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="row.status === 'active' ? 'success' : 'info'">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="负责人" width="120">
          <template #default="{ row }">{{ row.owner?.displayName ?? '—' }}</template>
        </el-table-column>
      </el-table>
    </PageState>

    <el-dialog v-model="createVisible" title="新增数据源" width="420px">
      <p v-if="prefillHint" class="prefill">{{ prefillHint }}</p>
      <el-form label-width="72px">
        <el-form-item label="名称">
          <el-input v-model="form.name" />
        </el-form-item>
        <el-form-item label="主机">
          <el-input v-model="form.host" />
        </el-form-item>
        <el-form-item label="端口">
          <el-input v-model.number="form.port" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="onSubmit">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
// 数据源管理 —— 三件事集中在这页：
//   ① 类型验收：props/emits **刻意用类型写法**且类型来自跨文件 import（src/types/datasource.ts），
//      analyzer 的 vue-tsc 内核要把自定义类型展开成真实字段结构写进 manifest
//      （见 docs/analyzer-type-resolution.md）
//   ② 页面级规则：rules/datasource-page.md 只在本页生效，agent 的 system prompt 里会出现在本页条目下
//   ③ 宿主 store 镜像：页面直接 `useAuthStore()`，容器模式下的值由宿主快照桥推来，代码零改动
//   ④ agent 只填不交：只 expose「只读 + 预填」（refresh / openCreateDialog），写后端的 save / onSubmit
//      刻意不进 defineExpose —— agent 想直接落库也调不到（统一约定见 src/utils/agentPreset.ts）
//   ⑤ 查询参数通道：path（/datasources）里没有 :param，页面用 route.query.keyword 读筛选条件 ——
//      analyzer 会把它探测成 manifest 的查询参数（in: 'query'），agent 放进 render 的 params 即可
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import PageHeader from '../components/PageHeader.vue'
import PageState from '../components/PageState.vue'
import CapabilityBadge from '../components/CapabilityBadge.vue'
import { listDatasources, saveDatasource } from '../api/datasources'
import { whoami as whoamiApi } from '../api/session'
import { reportData } from '../utils/httpClient'
import { AGENT_PREFILL_HINT, hasAgentPreset, mergeAgentPreset, prefillReceipt } from '../utils/agentPreset'
import { useAuthStore } from '../stores/authStore'
import type { AgentPrefillReceipt } from '../utils/agentPreset'
import type {
  DatasourceCreateForm,
  DatasourceOwner,
  DatasourceRequest,
  DatasourceVO,
} from '../types/datasource'

const props = defineProps<{
  /** 外部可注入数据源列表；不传则从接口拉取 */
  sources?: DatasourceVO[]
  /** 负责人信息（演示嵌套自定义类型展开） */
  owner?: DatasourceOwner
  /** 只展示启用中的数据源 */
  onlyEnabled?: boolean
}>()

const emit = defineEmits<{
  /** 提交新建数据源（成功落库后触发） */
  submit: [payload: DatasourceRequest]
  /** 选中某条数据源 */
  select: [source: DatasourceVO]
}>()

const auth = useAuthStore()
const route = useRoute()
/** 按名称过滤（URL 查询参数 keyword；agent 传 params.keyword → runtime 下发成 ?keyword=…） */
const keyword = computed(() => String(route.query.keyword || ''))
const fetched = ref<DatasourceVO[]>([])
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const notice = ref('')
const authEcho = ref('（未请求）')

const rows = computed(() => {
  const list = props.sources?.length ? props.sources : fetched.value
  const named = keyword.value ? list.filter((item) => item.name.includes(keyword.value)) : list
  return props.onlyEnabled ? named.filter((item) => item.enabled) : named
})

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    fetched.value = await listDatasources()
  } catch (cause) {
    const message = (cause as Error).message
    fetched.value = []
    error.value = message
    // 不带 url：错误载荷要原样出网，不能走 dataSources 的字段白名单
    reportData('datasource-list-error', { message, url: '/api/datasources' })
  } finally {
    loading.value = false
  }
}

/** 带 token 请求一次：验证「宿主 store 的 token → 请求头」链路（容器 setup 的 axios 拦截器现读 getToken） */
async function whoami(): Promise<void> {
  try {
    const data = await whoamiApi()
    authEcho.value = data.authorization ?? '（服务端没收到 Authorization）'
  } catch (cause) {
    authEcho.value = `请求失败：${(cause as Error).message}`
  }
}

// —— 新增数据源 ——
/** 弹窗默认值：本地按钮与 agent 预填共用（agent 只覆盖它显式传入的字段） */
const DEFAULT_CREATE_FORM: DatasourceCreateForm = { name: '', host: '127.0.0.1', port: 3306 }
const createVisible = ref(false)
const prefillHint = ref('')
const form = ref<DatasourceCreateForm>({ ...DEFAULT_CREATE_FORM })

/** 本地「新增数据源」按钮：清空表单重开（与 agent 入口同一条路径） */
function openCreate(): void {
  openCreateDialog()
}

/** agent 可调用（只预填、不提交）：打开「新增数据源」弹窗并用 preset 预填，返回表单快照 —— 只打开、不落库，提交仍由用户点「确定」（save / onSubmit 未 expose） */
function openCreateDialog(
  preset?: Partial<DatasourceCreateForm>,
): AgentPrefillReceipt<DatasourceCreateForm> {
  form.value = mergeAgentPreset(DEFAULT_CREATE_FORM, preset)
  createVisible.value = true
  prefillHint.value = hasAgentPreset(preset) ? AGENT_PREFILL_HINT : ''
  return prefillReceipt('新增数据源', form.value)
}

function onSelect(row: DatasourceVO): void {
  emit('select', row)
}

/** 保存数据源并返回落库后的完整对象（含 id）—— 只给人点的「确定」走；agent 侧未 expose */
async function save(payload: DatasourceRequest): Promise<DatasourceVO> {
  saving.value = true
  notice.value = ''
  try {
    const created = await saveDatasource({
      ...payload,
      owner: payload.owner ?? props.owner,
      status: payload.status ?? 'active',
    })
    notice.value = `已保存：${created.name}（id=${created.id}）`
    return created
  } catch (cause) {
    error.value = (cause as Error).message
    throw cause
  } finally {
    saving.value = false
  }
}

/** 弹窗「确定」：保存 → 关弹窗 → 刷新列表（只给人点；agent 调不到） */
function onSubmit(): void {
  const payload: DatasourceRequest = {
    name: form.value.name || '未命名数据源',
    host: form.value.host,
    port: form.value.port,
    owner: props.owner,
  }
  void save(payload)
    .then((created) => {
      createVisible.value = false
      emit('submit', payload)
      void load()
      void created
    })
    .catch(() => undefined)
}

/** agent 可调用（只读）：重新拉取列表，返回条数 */
async function refresh(): Promise<number> {
  await load()
  return rows.value.length
}

// 执行面只留「只读 + 预填」：写入方法（save / onSubmit）刻意不 expose，agent 无法直接下发数据
defineExpose({ refresh, openCreateDialog })

onMounted(() => void load())
</script>

<style scoped>
.mirror {
  display: flex;
  align-items: center;
  gap: var(--app-space-3);
  flex-wrap: wrap;
  margin-bottom: var(--app-space-3);
  padding: var(--app-space-2) var(--app-space-3);
  border-radius: var(--app-radius-sm);
  background: var(--app-surface);
  border: 1px solid var(--app-border);
  font-size: 12px;
  color: var(--app-text-secondary);
}
.echo {
  color: var(--app-text-muted);
}
.notice {
  margin: 0 0 var(--app-space-3);
  font-size: 12px;
  color: var(--app-success);
}
.prefill {
  margin: 0 0 var(--app-space-3);
  padding: var(--app-space-2) var(--app-space-3);
  border-radius: var(--app-radius-sm);
  background: var(--app-primary-weak);
  color: #4338ca;
  font-size: 12px;
}
:deep(.el-table__row) {
  cursor: pointer;
}
</style>
