// bundle 加载器：动态 import 容器 / 页面产物。
// - inflight 去重：同一 URL 并发只加载一次
// - 成功缓存、失败不缓存（可重试）
// - importImpl 可注入，便于单测与非浏览器环境
export interface BundleLoader {
  load<T = unknown>(url: string): Promise<T>
  isLoaded(url: string): boolean
  reset(url?: string): void
}

export function createBundleLoader(
  importImpl: (url: string) => Promise<unknown> = (url) => import(/* @vite-ignore */ url),
): BundleLoader {
  const done = new Map<string, unknown>()
  const inflight = new Map<string, Promise<unknown>>()

  return {
    load<T>(url: string): Promise<T> {
      if (done.has(url)) return Promise.resolve(done.get(url) as T)
      const existing = inflight.get(url)
      if (existing) return existing as Promise<T>
      const task = Promise.resolve()
        .then(() => importImpl(url))
        .then((mod) => {
          done.set(url, mod)
          inflight.delete(url)
          return mod
        })
        .catch((error) => {
          // 失败不缓存，允许调用方重试
          inflight.delete(url)
          throw error
        })
      inflight.set(url, task)
      return task as Promise<T>
    },
    isLoaded(url) {
      return done.has(url)
    },
    reset(url) {
      if (url === undefined) {
        done.clear()
        inflight.clear()
        return
      }
      done.delete(url)
      inflight.delete(url)
    },
  }
}

/** 拉取文本资源（共享样式），失败返回 null 并告警，不阻断启动 */
export async function fetchText(
  url: string,
  fetchImpl: typeof fetch | undefined = typeof fetch === 'function' ? fetch : undefined,
): Promise<string | null> {
  if (!fetchImpl) return null
  try {
    const res = await fetchImpl(url)
    if (!res.ok) {
      console.warn(`[wc-runtime] 资源加载失败：${url} (${res.status})`)
      return null
    }
    return await res.text()
  } catch (error) {
    console.warn(`[wc-runtime] 资源加载异常：${url}`, error)
    return null
  }
}
