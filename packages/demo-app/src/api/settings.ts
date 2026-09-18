// 站点设置：GET 需要登录（Authorization），用来演示「401 → 登录守卫 → token 回填 → 重试」这条完整链路。
import { http } from '../utils/request'
import { reportData } from '../utils/httpClient'
import { buildQuery } from './query'
import type { AppSettings, MockFail } from './types'

/** 读取设置（GET /api/settings，需要 Authorization） */
export async function getSettings(params: { fail?: MockFail } = {}): Promise<AppSettings> {
  const url = `/api/settings${buildQuery({ fail: params.fail })}`
  const settings = await http<AppSettings>(url)
  // 上报只给可配置项；version 这类服务端字段不留痕
  reportData(
    'settings',
    { siteName: settings.siteName, locale: settings.locale, notify: settings.notify },
    { url },
  )
  return settings
}

/** 保存设置（PUT /api/settings）—— 返回落库后的对象，agent 可据此确认写入成功 */
export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const url = '/api/settings'
  const settings = await http<AppSettings>(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  reportData(
    'settings',
    { siteName: settings.siteName, locale: settings.locale, notify: settings.notify },
    { url, method: 'PUT' },
  )
  return settings
}
