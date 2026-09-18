// 宿主直连（用法 B）**manifest 地址**的归一：`{base}/manifest.json` 这个映射只写一处。
//
// 为什么单独一个零依赖模块：
//   1. 宿主手写这个映射最容易出错，且错了**不报错** —— 只是拿不到页面目录（agent 静默失明）；
//   2. 与 chat-client 的 `wcBase` 缺省值保持一致（'/wc'），两边不再各写一个常量；
//   3. 纯函数，便于单测（不拉起 vue / vue-router）。

/** chat-client 注入的 runtime 构造上下文（结构性类型：wc-runtime-vue 不依赖 chat-client） */
export interface HostRuntimeContextLike {
  /** manifest 基址（chat-client 的 `wcBase`，缺省 '/wc'） */
  base?: string
  /** 首屏目标（`initialPage` 解析结果；host 模式缺省为 `null`） */
  initial?: { tag: string } | null
}

/** 与 chat-client 的 `wcBase` 缺省值一致 */
export const DEFAULT_MANIFEST_BASE = '/wc'

/**
 * 解析宿主侧 manifest 地址：显式 `manifestUrl` 优先，否则 `{base}/manifest.json`。
 * `base` 末尾的 `/` 会被吃掉，避免拼出 `//manifest.json`。
 */
export function resolveHostManifestUrl(
  manifestUrl: string | undefined,
  context?: HostRuntimeContextLike,
): string {
  if (manifestUrl) return manifestUrl
  const base = context?.base || DEFAULT_MANIFEST_BASE
  return `${base.replace(/\/$/, '')}/manifest.json`
}
