<template>
  <!-- @description 用户详情页，展示并编辑单个用户的姓名、邮箱、角色，支持保存 -->
  <div style="padding: 16px; max-width: 400px">
    <h2 style="margin: 0 0 16px; font-size: 18px">用户详情</h2>
    <div v-if="loading" style="color: #9ca3af; margin-bottom: 12px">
      加载中…
    </div>
    <div v-else-if="loadError" style="color: #dc2626; margin-bottom: 12px">
      {{ loadError }}
    </div>
    <el-form label-width="60px">
      <el-form-item label="姓名">
        <el-input v-model="form.name" />
      </el-form-item>
      <el-form-item label="邮箱">
        <el-input v-model="form.email" />
      </el-form-item>
      <el-form-item label="角色">
        <el-select v-model="form.role" style="width: 100%">
          <el-option label="管理员" value="管理员" />
          <el-option label="普通用户" value="普通用户" />
          <el-option label="访客" value="访客" />
        </el-select>
      </el-form-item>
      <el-button type="primary" :disabled="loading" @click="onSave"
        >保存</el-button
      >
    </el-form>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, watch, type PropType } from "vue";
import { useRoute } from "vue-router";
import { reportData } from "../utils/httpClient";
import { http } from "../utils/request";
import type { User } from "../data";

const props = defineProps({
  // 外部传入完整的用户对象（agent/宿主直接渲染时用，二选一）
  user: { type: Object as PropType<Partial<User>>, default: () => ({}) },
  // 路由参数 id（agent 传 id 按需拉取）
  id: { type: [String, Number] as PropType<string | number>, default: "" },
});

const emit = defineEmits(["save"]);

// 注入的 route（组件通过 router.push 导航时，从 params.id 查数据）
const route = useRoute();

const form = reactive({ name: "", email: "", role: "普通用户" });
const loading = ref(false);
const loadError = ref("");
console.log("id:", route.params?.id);
// 解析出有效的 id：优先 props.id，其次路由 params.id
function resolveId(): string | undefined {
  const raw = props.id ?? route.params?.id;
  if (raw === "" || raw === undefined || raw === null) return undefined;
  return String(raw);
}

// 通过 http 从 mock API 拉取用户（agent 能否看到，取决于下面是否显式上报）
async function fetchUser(id: string) {
  loading.value = true;
  loadError.value = "";
  try {
    const url = `/api/users/${id}`;
    const user = await http<Partial<User>>(url);
    if (user && (user.name || user.email || user.role)) {
      Object.assign(form, user);
      // 显式上报给 agent：只给 id / name / role（先自己挑字段，别把整个响应丢出去）
      reportData("user-detail", { id, name: user.name, role: user.role });
    } else {
      loadError.value = `未找到用户 id=${id}`;
    }
  } catch (e) {
    loadError.value = `加载失败：${(e as Error).message}`;
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.id, route.params?.id, props.user] as const,
  () => {
    const id = resolveId();
    if (id) {
      void fetchUser(id);
    } else if (props.user && Object.keys(props.user).length) {
      // 外部直传 user 对象：直接使用，不发请求
      Object.assign(form, props.user);
      loadError.value = "";
    } else {
      loadError.value = "缺少用户 id";
    }
  },
  { immediate: true },
);

function onSave() {
  emit("save", { ...form });
}
</script>
