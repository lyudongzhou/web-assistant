// 工作台指标：只读聚合接口 —— 演示「调用点自己挑字段」的上报方式（没有 dataSources 声明）。
import { http } from '../utils/request'
import { reportData } from '../utils/httpClient'
import { buildQuery } from './query'
import type { DashboardOverview, MockFail } from './types'

/** 概览（GET /api/stats/overview） */
export async function getOverview(params: { fail?: MockFail } = {}): Promise<DashboardOverview> {
  const url = `/api/stats/overview${buildQuery({ fail: params.fail })}`
  const overview = await http<DashboardOverview>(url)
  // 显式挑字段：指标卡 + 趋势（原本就只给这些，无需 dataSources 裁剪）
  reportData(
    'dashboard',
    {
      stats: overview.stats.map(({ label, value }) => ({ label, value })),
      trend: overview.trend,
      updatedAt: overview.updatedAt,
    },
    { url },
  )
  return overview
}
