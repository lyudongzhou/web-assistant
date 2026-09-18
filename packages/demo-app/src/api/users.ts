// 用户资源的唯一数据入口：页面只调这里，上报也只在这里做一次（避免各处散落 reportData）。
//
// 上报口径（本文件是「有界声明」的示范）：
//   reportData('user-list', users, { url })  ← 直接把**原始响应**交出去
//   `/api/users` 的字段白名单与行数上限声明在 wc.pages.json 的 `dataSources` 里，
//   runtime 命中后按 fields / maxRows 摘要才出网（email 不进 agent 视野）。
//   好处：页面不用逐字段挑；边界集中在清单里，改清单即可改边界。
import { http } from '../utils/request'
import { reportData } from '../utils/httpClient'
import { buildQuery } from './query'
import type { MockFail, User, UserCreateForm } from './types'

export interface UserQuery {
  keyword?: string
  /** 错误注入（演示异常链路，agent 会收到错误上报） */
  fail?: MockFail
}

/** 用户列表（GET /api/users） */
export async function listUsers(params: UserQuery = {}): Promise<User[]> {
  const url = `/api/users${buildQuery({ keyword: params.keyword, fail: params.fail })}`
  const users = await http<User[]>(url)
  reportData('user-list', users, { url })
  return users
}

/** 用户详情（GET /api/users/:id）—— 调用点自己挑字段（示例：不给 email） */
export async function getUser(id: string | number): Promise<User> {
  const url = `/api/users/${id}`
  const user = await http<User>(url)
  reportData('user-detail', { id: user.id, name: user.name, role: user.role }, { url })
  return user
}

/** 保存用户（PUT /api/users/:id）—— 返回保存后的完整对象（agent 可据返回值继续规划） */
export async function updateUser(id: string | number, patch: Partial<User>): Promise<User> {
  const url = `/api/users/${id}`
  const user = await http<User>(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  reportData('user-detail', { id: user.id, name: user.name, role: user.role }, { url, method: 'PUT' })
  return user
}

/** 新建用户（POST /api/users）—— 入参就是「新增用户」弹窗的表单类型（agent 预填同一份合同） */
export async function createUser(payload: UserCreateForm): Promise<User> {
  const url = '/api/users'
  const user = await http<User>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  reportData('user-created', { id: user.id, name: user.name, role: user.role }, { url, method: 'POST' })
  return user
}

/** 删除用户（DELETE /api/users/:id） */
export async function deleteUser(id: string | number): Promise<void> {
  const url = `/api/users/${id}`
  await http<{ ok: boolean }>(url, { method: 'DELETE' })
  reportData('user-deleted', { id }, { url, method: 'DELETE' })
}
