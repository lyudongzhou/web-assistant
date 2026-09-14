// 欢迎页用到的「图片」资源。
//
// 设计取舍：欢迎页是**可发布库**的一部分，运行时外链图片（CSP / 离线 / 许可）风险高，
// 所以这里把图片全部做成**自包含的 SVG data URI**：
//   - 不依赖外网、无二进制资源、可任意缩放；
//   - 能力卡片的缩略图按 `tag` 确定性生成，保证「同一能力 → 同一张图」，且彼此有区分度。
//
// 宿主若想换成真实图片，可整体替换 WelcomePage（`welcome` prop / `#welcome` 插槽）。

/** 调色板：[主色, 次色, 高光色] */
const PALETTES: Array<[string, string, string]> = [
  ['#3b82f6', '#8b5cf6', '#22d3ee'],
  ['#6366f1', '#ec4899', '#f59e0b'],
  ['#0ea5e9', '#14b8a6', '#a3e635'],
  ['#8b5cf6', '#f472b6', '#38bdf8'],
  ['#f59e0b', '#ef4444', '#fbbf24'],
  ['#10b981', '#3b82f6', '#a7f3d0'],
  ['#7c3aed', '#2563eb', '#c4b5fd'],
  ['#0891b2', '#22d3ee', '#818cf8'],
]

/** FNV-1a 32bit：把任意字符串稳定映射成一个整数 */
function hashString(input: string): number {
  let h = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function toDataUri(svg: string): string {
  // 注意：encodeURIComponent 不转义 ( ) —— 它们在不带引号的 CSS url() 里非法，
  // 会让整条 background-image 声明被浏览器丢弃（SVG 内部的 url(#id) 引用就会带括号）。
  // 这里额外把括号转义掉，保证 data URI 在 CSS / HTML 两种上下文里都安全。
  const encoded = encodeURIComponent(svg).replace(/\(/g, '%28').replace(/\)/g, '%29')
  return `data:image/svg+xml,${encoded}`
}

/**
 * 能力卡片的缩略图：按 seed（通常是能力 tag）确定性生成一张抽象渐变图。
 * 同一 seed 永远得到同一张图。
 */
export function capabilityThumbnail(seed: string): string {
  const h = hashString(seed || 'webassistant')
  const [c1, c2, c3] = PALETTES[h % PALETTES.length]

  const angle = 110 + (h % 100) // 渐变角度（度）
  const x2 = Math.cos((angle * Math.PI) / 180).toFixed(2)
  const y2 = Math.sin((angle * Math.PI) / 180).toFixed(2)

  const blobCx = 60 + (h % 200)
  const blobCy = 20 + ((h >> 5) % 100)
  const blobR = 90 + ((h >> 9) % 60)
  const spotCx = 40 + ((h >> 3) % 240)
  const spotCy = 20 + ((h >> 7) % 140)
  const spotR = 18 + ((h >> 11) % 26)

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice">
<defs>
<linearGradient id="lg" x1="0" y1="0" x2="${x2}" y2="${y2}">
<stop offset="0" stop-color="${c1}"/>
<stop offset="0.55" stop-color="${c2}"/>
<stop offset="1" stop-color="${c3}"/>
</linearGradient>
<radialGradient id="bl" cx="50%" cy="50%" r="50%">
<stop offset="0" stop-color="#ffffff" stop-opacity="0.55"/>
<stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
</radialGradient>
</defs>
<rect width="320" height="180" fill="url(#lg)"/>
<circle cx="${blobCx}" cy="${blobCy}" r="${blobR}" fill="url(#bl)"/>
<circle cx="${spotCx}" cy="${spotCy}" r="${spotR}" fill="#ffffff" fill-opacity="0.32"/>
<path d="M0 138 Q80 106 160 130 T320 112 L320 180 L0 180 Z" fill="#0b1220" fill-opacity="0.16"/>
</svg>`

  return toDataUri(svg)
}

/**
 * 欢迎页 hero 背景图：一张淡雅的浅色渐变 + 三团柔光（品牌蓝 / 紫 / 青）。
 * 与默认主题（浅色、`--wa-primary: #3b82f6`）协调，文字保持可读。
 */
export const WELCOME_HERO_BG = toDataUri(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 600" preserveAspectRatio="xMidYMid slice">
<defs>
<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#eef2ff"/>
<stop offset="0.5" stop-color="#f8fafc"/>
<stop offset="1" stop-color="#eff6ff"/>
</linearGradient>
<radialGradient id="b1" cx="0.16" cy="0.2" r="0.62">
<stop offset="0" stop-color="#93c5fd" stop-opacity="0.55"/>
<stop offset="1" stop-color="#93c5fd" stop-opacity="0"/>
</radialGradient>
<radialGradient id="b2" cx="0.86" cy="0.14" r="0.55">
<stop offset="0" stop-color="#c4b5fd" stop-opacity="0.5"/>
<stop offset="1" stop-color="#c4b5fd" stop-opacity="0"/>
</radialGradient>
<radialGradient id="b3" cx="0.62" cy="0.98" r="0.6">
<stop offset="0" stop-color="#67e8f9" stop-opacity="0.42"/>
<stop offset="1" stop-color="#67e8f9" stop-opacity="0"/>
</radialGradient>
</defs>
<rect width="1200" height="600" fill="url(#g)"/>
<rect width="1200" height="600" fill="url(#b1)"/>
<rect width="1200" height="600" fill="url(#b2)"/>
<rect width="1200" height="600" fill="url(#b3)"/>
</svg>`,
)
