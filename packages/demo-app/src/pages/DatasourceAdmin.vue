<template>
  <!-- @description 数据源管理页，用类型写法声明 props/emits，支持保存、刷新与提交新建数据源 -->
  <div id="cssinjs-probe" class="cssinjs-probe-p1 cssinjs-probe-direct" style="padding: 16px;">
    <h2 style="margin: 0 0 16px; font-size: 18px;">数据源管理</h2>
    <!-- 宿主 store 镜像：页面代码零改动读 pinia（值由宿主推来）——见 src/ce/container.ts 的 createStoreMirror -->
    <div
      style="
        margin: 0 0 12px;
        padding: 8px 12px;
        border-radius: 6px;
        background: rgb(238, 242, 255);
        color: rgb(67, 56, 202);
        font-size: 12px;
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
      "
    >
      <span>
        store 镜像：{{ auth.user?.name ?? '未登录' }}（{{ auth.user?.role ?? '—' }}）· token
        {{ auth.token ? auth.token.slice(0, 12) + '…' : '（空）' }}
      </span>
      <span>· 接口依赖 store 的 token 时看这里：{{ authEcho }}</span>
      <el-button size="small" @click="whoami">带 token 请求一次 /api/whoami</el-button>
    </div>
    <el-table :data="rows" border>
      <el-table-column prop="id" label="ID" width="80" />
      <el-table-column prop="name" label="名称" />
      <el-table-column prop="host" label="主机" />
      <el-table-column prop="port" label="端口" width="100" />
      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <el-tag :type="row.status === 'active' ? 'success' : 'info'">{{ row.status }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="负责人" width="140">
        <template #default="{ row }">{{ row.owner?.displayName ?? '—' }}</template>
      </el-table-column>
    </el-table>
    <div style="margin-top: 16px; display: flex; gap: 8px;">
      <el-button type="primary" @click="onSubmit">提交</el-button>
      <el-button @click="refresh(true)">刷新</el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
// 本页刻意使用「类型写法」声明 props / emits，并且类型都来自跨文件 import ——
// 用来验收 analyzer 的 vue-tsc 内核是否把自定义类型展开成真实字段结构。
import { computed, onMounted, ref } from 'vue'
import { DatasourceKind } from '../types/datasource'
import type { DatasourceOwner, DatasourceRequest, DatasourceVO } from '../types/datasource'
import { injectByAppendChild, injectByInsertRule } from '../vendor/fakeCssInJs'
import http from '../utils/request'
import { useAuthStore } from '../stores/authStore'

const props = defineProps<{
  // 外部可注入数据源列表；不传则用内置 mock
  sources?: DatasourceVO[]
  // 负责人信息（演示嵌套自定义类型展开）
  owner?: DatasourceOwner
  // 只展示启用中的数据源
  onlyEnabled?: boolean
}>()

const emit = defineEmits<{
  // 提交新建数据源
  submit: [payload: DatasourceRequest]
  // 选中某条数据源
  select: [source: DatasourceVO]
  // 关闭（可选原因）
  close: [reason?: string]
}>()

const mockSources: DatasourceVO[] = [
  {
    id: 1,
    name: '主库',
    host: '10.0.0.1',
    port: 3306,
    tags: ['prod'],
    enabled: true,
    status: 'active',
    kind: DatasourceKind.MySQL,
    owner: { id: 1, displayName: '张三' },
  },
]

const rows = computed(() => {
  const list = props.sources?.length ? props.sources : mockSources
  return props.onlyEnabled ? list.filter((item) => item.enabled) : list
})

// —— 宿主 store 镜像示例 ——
// 页面里就是普通的 `useAuthStore()`：CE 模式下值由宿主推来（容器 createStoreMirror），SPA 模式下是本应用的 store。
// 本批次 pinia 与宿主 pinia 是**两个实例**（两份 vue 副本），数据靠快照单向同步，不是共享实例。
const auth = useAuthStore()
const authEcho = ref('（未请求）')

/** 带 token 请求一次：验证「宿主 store 的 token → 请求头」链路（容器 setup 里的 axios 拦截器按需现读 getToken） */
async function whoami(): Promise<void> {
  try {
    const data = await http<{ authorization: string | null }>('/api/whoami')
    authEcho.value = data.authorization ?? '（服务端没收到 Authorization）'
  } catch (cause) {
    authEcho.value = `请求失败：${(cause as Error).message}`
  }
}

/** 保存数据源，返回保存后的完整对象（agent 可据返回值继续规划） */
async function save(data: DatasourceRequest): Promise<DatasourceVO> {
  // emit('submit', data)
  return {
    id: 0,
    name: data.name,
    host: data.host,
    port: data.port ?? 0,
    tags: [],
    enabled: true,
    status: 'active',
    kind: DatasourceKind.MySQL,
    owner: data.owner ?? null,
  }
}

/** 重新拉取数据源列表，返回条数 */
async function refresh(force?: boolean): Promise<number> {
  if (force) emit('close', 'refresh')
  return rows.value.length
}

function onSubmit(): void {
  void save({ name: '新数据源', host: '127.0.0.1', owner: props.owner })
}

defineExpose({ save, refresh, onSubmit })

// —— styleShim 验收探针 ——
// 走「模拟 CSS-in-JS 依赖」的两条注入路径（P1 / P2），从裸 document 往 head 注入样式。
// 构建成 WC 后，它们会被镜像进容器 <runtime-vue> 的 shadow root，从而作用到本页（见 vite.ce.config.ts）。
onMounted(() => {
  injectByAppendChild('.cssinjs-probe-p1{outline:3px dashed rgb(22,163,74)}')
  injectByInsertRule('#cssinjs-probe{background:rgb(240,253,244)}')

  // —— 对照项：**页面自身**直写 document ——
  // 本页面不在 styleShim.packages 名单里，所以页面里的裸 document 不会被遮蔽，
  // 这条规则**不会**进 shadow root（用来印证「遮蔽只对被指定包生效」）。
  const direct = document.createElement('style')
  direct.textContent = '.cssinjs-probe-direct{outline:3px solid rgb(220,38,38)}'
  document.head.appendChild(direct)
})
</script>
