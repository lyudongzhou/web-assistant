// demo 批次自己的请求单例（模拟老项目里的 #/utils/request）。
// 页面 `import http from '../utils/request'` 一行不改；宿主传入的实例由容器的 setup 钩子接管。
export type RequestFn = <T = unknown>(url: string, init?: RequestInit) => Promise<T>

const fallback: RequestFn = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return (await res.json()) as T
}

let impl: RequestFn = fallback

/** 由容器 setup 调用：把宿主传入的 request 接管为批次的共享实现 */
export function setHttp(next?: RequestFn): void {
  if (typeof next === 'function') impl = next
}

export const http: RequestFn = (url, init) => impl(url, init)
export default http
