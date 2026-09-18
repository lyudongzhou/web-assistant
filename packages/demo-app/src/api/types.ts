// 领域模型（演示后台的「业务事实」）。
//
// 与 src/types/datasource.ts 的区别：
//   - 本文件：页面与 api 层共用的模型（简单对象，直接写字段）
//   - types/datasource.ts：**刻意用自定义类型/枚举 + 跨文件 import**，用来验收 analyzer 的
//     vue-tsc 类型展开能力（见 docs/analyzer-type-resolution.md）
//
// 字段选择有意图：email / phone 这类「能识别到人」的字段**不**给 agent 看（dataSources 白名单里排除）。

export type UserRole = '管理员' | '普通用户' | '访客'

export interface User {
  id: number
  name: string
  email: string
  role: UserRole
  /** 最近登录时间（ISO 字符串） */
  lastLoginAt: string
}

export type OrderStatus = 'pending' | 'paid' | 'shipped' | 'done' | 'canceled'

export interface Order {
  id: string
  customer: string
  /** 用户 id（与 /api/users 的 id 对应，供 agent 跨页导航） */
  userId: number
  amount: number
  status: OrderStatus
  createdAt: string
}

export interface TrendPoint {
  date: string
  orders: number
  gmv: number
}

export interface DashboardOverview {
  /** 顶部指标卡 */
  stats: Array<{ key: string; label: string; value: string }>
  /** 近 7 日趋势 */
  trend: TrendPoint[]
  updatedAt: string
}

export type Locale = 'zh-CN' | 'en-US'

export interface AppSettings {
  siteName: string
  locale: Locale
  notify: boolean
  /** 只读项：服务端返回、不允许前端改（演示「表单里混着不可改字段」） */
  version: string
}

/** 新增用户表单（=「新增用户」弹窗的三个输入；agent 经 UserList.openCreateDialog 预填） */
export interface UserCreateForm {
  name: string
  email: string
  role: UserRole
}

/** 编辑用户表单（=用户详情页的三个可编辑输入；id / lastLoginAt 不可改） */
export interface UserEditForm {
  name: string
  email: string
  role: UserRole
}

/** 站点设置表单（=设置页可编辑项；version 是服务端只读项，不进 agent 的预填合同） */
export interface SettingsForm {
  siteName: string
  locale: Locale
  notify: boolean
}

/** mock 后端的错误注入开关（演示异常链路：错误也要能被 agent 看见） */
export type MockFail = '500' | '401' | 'slow'
