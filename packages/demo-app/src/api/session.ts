// 会话资源：登录 / 身份回显。
//
// ★ 上报的反例（有意为之）：这两个接口**不**上报给 agent。
//   「不是所有请求都该上报」——token、凭证、个人标识这类数据永远不要出浏览器。
//   显式上报的好处正在这里：漏报是默认行为，误报需要有意识地写一行。
import { http } from '../utils/request'
import type { MockFail } from './types'

export interface SessionUser {
  name: string
  role: string
}

export interface LoginResult {
  token: string
  user: SessionUser
}

/** 登录（POST /api/login）—— demo 后端不校验密码，只用来演示宿主 store 的 token 链路 */
export async function login(name: string): Promise<LoginResult> {
  return http<LoginResult>('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

/** 回显请求头里的 Authorization（GET /api/whoami）—— 验证「宿主 store 的 token → 请求头」是否生效 */
export async function whoami(params: { fail?: MockFail } = {}): Promise<{ authorization: string | null }> {
  const suffix = params.fail ? `?fail=${params.fail}` : ''
  return http<{ authorization: string | null }>(`/api/whoami${suffix}`)
}
