// 数据源资源：类型来自 src/types/datasource.ts（跨文件自定义类型 —— 验收 analyzer 的类型展开）。
import { http } from '../utils/request'
import { reportData } from '../utils/httpClient'
import { buildQuery } from './query'
import type { DatasourceRequest, DatasourceVO } from '../types/datasource'
import type { MockFail } from './types'

/** 数据源列表（GET /api/datasources） */
export async function listDatasources(params: { fail?: MockFail } = {}): Promise<DatasourceVO[]> {
  const url = `/api/datasources${buildQuery({ fail: params.fail })}`
  const rows = await http<DatasourceVO[]>(url)
  reportData('datasource-list', rows, { url })
  return rows
}

/** 新增数据源（POST /api/datasources）——返回落库后的对象（含 id），供 agent 后续引用 */
export async function saveDatasource(payload: DatasourceRequest): Promise<DatasourceVO> {
  const url = '/api/datasources'
  const created = await http<DatasourceVO>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  reportData('datasource-created', created, { url, method: 'POST' })
  return created
}
