// 原型 fixture：跨文件类型（在 .vue 里被 import 后展开成字段结构）
export type DatasourceStatus = 'active' | 'disabled'

export enum DatasourceKind {
  MySQL = 'mysql',
  Redis = 'redis',
}

export interface DatasourceOwner {
  id: number
  /** 展示名 */
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

/** 筛选条件（用来覆盖 `Partial<T>` / `Promise<T>` 这类外部泛型包装的项目内类型） */
export interface DatasourceFilter {
  keyword: string
  datasourceType: string
  status: string
  testStatus: string
}
