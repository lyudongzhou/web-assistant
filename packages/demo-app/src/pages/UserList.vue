<template>
  <!-- @description 用户列表页，展示所有用户数据，支持按姓名或邮箱搜索、分页浏览、删除用户和查看详情 -->
  <div class="p-4">
    <TestCmp></TestCmp>
    <div class="mb-4 flex items-center justify-between">
      <h2 class="m-0 text-lg text-gray-900">
        用户列表<span
          v-if="greeting"
          class="ml-3 text-xs font-normal text-gray-500"
          >{{ greeting }}</span
        >
      </h2>
      <div class="flex gap-2">
        <el-input
          v-model="keyword"
          placeholder="搜索姓名或邮箱"
          style="width: 220px"
          clearable
          @input="onSearch"
        />
        <el-button type="primary" @click="openCreate">新增用户</el-button>
      </div>
    </div>

    <!-- pinia store 演示：容器注入的 store 在页面间共享同一实例 -->
    <div class="mb-3 rounded bg-indigo-50 px-3 py-2 text-xs text-indigo-700">
      store.displayName = <b>{{ userStore.displayName }}</b>
      <el-button
        size="small"
        class="ml-2"
        @click="
          userStore.setUser({
            name: '李四',
            email: 'lisi@example.com',
            role: '普通用户',
          })
        "
        >改 store</el-button
      >
    </div>

    <el-table :data="pagedUsers" border>
      <el-table-column prop="id" label="ID" width="80" />
      <el-table-column prop="name" label="姓名" />
      <el-table-column prop="email" label="邮箱" />
      <el-table-column prop="role" label="角色" width="100" />
      <el-table-column label="操作" width="160">
        <template #default="{ row }">
          <el-button size="small" @click="onView(row)">详情</el-button>
          <el-button size="small" type="danger" @click="onDelete(row)"
            >删除</el-button
          >
        </template>
      </el-table-column>
    </el-table>

    <div class="mt-4 flex justify-center">
      <el-pagination
        background
        layout="prev, pager, next"
        :total="filtered.length"
        :page-size="pageSize"
        :current-page="page"
        @current-change="onPageChange"
      />
    </div>

    <el-dialog v-model="createVisible" title="新增用户" width="400px">
      <div class="text-red">123</div>
      <el-form label-width="60px">
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
        <el-button type="primary" @click="submitCreate">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch, type PropType } from "vue";
import { useRouter } from "vue-router";
import { tryUseRuntimeServices } from "@webassistant/wc-runtime-vue";
import { http } from "../utils/request";
import { reportData } from "../utils/httpClient";
import { useUserStore } from "../stores/userStore";
import type { User } from "../data";
import TestCmp from "../components/TestCmp.vue";
const props = defineProps({
  // 外部可注入用户数据；不传则用内置 http 获取（便于独立演示）
  users: { type: Array as PropType<User[]>, default: () => [] },
  /** 关键词（agent 通过 props 传入过滤条件） */
  keyword: { type: String, default: "" },
});

const emit = defineEmits(["search", "delete", "page-change", "create"]);

// 注入的 router（老项目代码原样使用 useRouter，无需改成 emit）
const router = useRouter();

// 宿主注入的服务（runtime 容器外跑时为 null，所以用 try 版本，SPA 模式也能跑）
const runtime = tryUseRuntimeServices();
const greeting = computed(() => {
  if (!runtime) return "";
  const who = (runtime.state.user as { name?: string } | undefined)?.name;
  return who ? runtime.t("当前登录：") + who : runtime.t("未登录");
});

// —— pinia store 示例（容器 plugins 注入 createPinia，页面同批构建共享同一实例）——
const userStore = useUserStore();

const keyword = ref(props.keyword || "");
const page = ref(1);
const pageSize = 5;

// 页面数据：通过 http 从 mock API 拉取。
// agent 侧要看到这份数据 = 在下面的调用点**显式** reportData；不调就没有任何数据出浏览器，
// 也没有任何人替页面「自动」上报（runtime 不拦请求）。
const allUsers = ref<User[]>([]);

async function fetchUsers(name?: string) {
  try {
    const url = name
      ? `/api/users?name=${encodeURIComponent(name)}`
      : "/api/users";
    const list = await http<User[]>(url);
    allUsers.value = list;
    // 显式上报给 agent：只给 id / name / role（邮箱不给），agent 据此拿到可继续操作的 id
    reportData(
      "user-list",
      list.map((u) => ({ id: u.id, name: u.name, role: u.role })),
    );
  } catch {
    allUsers.value = [];
  }
}

// props.keyword 变化时同步搜索
watch(
  () => props.keyword,
  (kw) => {
    if (kw !== undefined) {
      keyword.value = kw;
      fetchUsers(kw || undefined);
    }
  },
);

onMounted(() => {
  // 外部传了 users 直接用；否则从 API 拉取
  if (props.users.length) {
    allUsers.value = props.users as User[];
  } else {
    fetchUsers();
  }
});

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  if (!kw) return allUsers.value;
  return allUsers.value.filter(
    (u) =>
      u.name.toLowerCase().includes(kw) || u.email.toLowerCase().includes(kw),
  );
});

const pagedUsers = computed(() =>
  filtered.value.slice((page.value - 1) * pageSize, page.value * pageSize),
);

function onSearch() {
  page.value = 1;
  fetchUsers(keyword.value.trim() || undefined);
  emit("search", keyword.value);
}
function onView(u: User) {
  // 换路由：老代码原样，router.push 到详情页（只传 id，详情页按 id 查数据）
  router.push({ name: "UserDetail", params: { id: u.id } });
}
function onDelete(u: User) {
  emit("delete", u);
}
function onPageChange(p: number) {
  page.value = p;
  emit("page-change", p);
}

// —— 新增用户 dialog（el-dialog）——
const createVisible = ref(false);
const createForm = reactive({ name: "", email: "", role: "普通用户" });

function openCreate() {
  createForm.name = "";
  createForm.email = "";
  createForm.role = "普通用户";
  createVisible.value = true;
}
function submitCreate() {
  emit("create", { ...createForm });
  createVisible.value = false;
}

// —— agent 可调用的方法（defineExpose → analyzer → manifest.exposes → prompt 注入）——
/** 重新拉取列表（可带关键词覆盖搜索框），返回本次过滤后的条数 */
async function refresh(keywordText?: string): Promise<number> {
  if (typeof keywordText === "string") keyword.value = keywordText;
  page.value = 1;
  await fetchUsers(keyword.value.trim() || undefined);
  return filtered.value.length;
}
/** 设置筛选关键词并立即查询（等价于在搜索框输入后点搜索） */
async function setKeyword(kw: string): Promise<number> {
  return refresh(kw);
}
defineExpose({ refresh, setKeyword });
</script>

<style scoped>
h2 {
  color: #1f2937;
  border-bottom: 1px solid #e5e7eb;
}
.text-red {
  color: red;
}
</style>
