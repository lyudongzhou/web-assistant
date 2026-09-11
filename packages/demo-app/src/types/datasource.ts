// 数据源管理相关类型 —— 跨文件类型解析的验收样本：
// 页面只 import 类型名，analyzer 要把它展开成真实字段结构写进 manifest。
export type DatasourceStatus = 'active' | 'disabled'

export enum DatasourceKind {
  MySQL = 'mysql',
  Redis = 'redis',
}

export interface DatasourceOwner {
  id: number
  /** 负责人展示名 */
  displayName: string
}

export interface DatasourceVO {
  id: number
  name: string
  host: string
  port: number
  tags: string[]
  enabled: boolean
  status: DatasourceStatus
  kind: DatasourceKind
  owner: DatasourceOwner | null
}

export interface DatasourceRequest {
  name: string
  host: string
  port?: number
  status?: DatasourceStatus
  /** 连接参数 */
  options?: Record<string, string>
  owner?: DatasourceOwner
}
