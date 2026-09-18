import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

const demoRoot = fileURLToPath(new URL('.', import.meta.url))

/**
 * runtime 里 WC 批次的 URL 前缀（chat-client 约定：`{wcBase}/manifest.json` + `{wcBase}/dist-ce`）。
 *
 * 两条渲染面共用 `/wc`：容器批次（用法 A）读 `/wc/manifest.json` + 加载 `/wc/dist-ce/**`；
 * 宿主直连（用法 B）只读同一份 `/wc/manifest.json`（manifest 里的 containers / bundle 由宿主渲染面忽略）。
 * 因此这里**只有一处**前缀需要与 `public/wc/` 对齐。
 */
const WC_ASSET_URL = '/wc/dist-ce'
/** 真实产物目录（`pnpm build:ce` 产出）—— **必须在 public/ 之外**，见下面注释 */
const WC_ASSET_DIR = 'dist-ce'

/**
 * 把 `pnpm build:ce` 的产物以**同源** URL 提供给宿主页面（`/wc-ce/dist-ce/**`）。
 *
 * ⚠️ 为什么产物不能直接放 `public/`：
 *   runtime 用 `import(url)` 动态加载容器/页面 bundle，vite dev 会给这个请求加 `?import`
 *   并送进**模块转换管线**；而 vite 明确拒绝转换 public/ 里的文件（直接 500：
 *   "This file is in /public and will be copied as-is during build without going through the transform pipeline"）。
 *   所以产物放 public 之外 + 自己注册中间件（在 vite 内部中间件**之前**，完全不进管线）。
 */
function wcCeAssets(): Plugin {
  const from = path.join(demoRoot, WC_ASSET_DIR)
  const mime: Record<string, string> = {
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
  }
  let command = 'serve'
  return {
    name: 'wa-wc-assets',
    config(_config, env) {
      command = env.command
    },
    configureServer(server) {
      // 在内部中间件之前注册（configureServer 里直接 use 即为「前置」）
      server.middlewares.use(WC_ASSET_URL, (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '/').split('?')[0])
        const file = path.join(from, rel)
        if (!file.startsWith(from)) return next()
        fs.readFile(file, (err, data) => {
          if (err) return next()
          res.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream')
          res.setHeader('Cache-Control', 'no-store')
          res.end(data)
        })
      })
    },
    closeBundle() {
      // 生产构建：把产物拷进 dist/，部署后同样是同源
      if (command !== 'build' || !fs.existsSync(from)) return
      fs.cpSync(from, path.join(demoRoot, 'dist', 'wc', 'dist-ce'), { recursive: true })
    },
  }
}

// 宿主 dev server（5173）：三条演示链路共用它（见 src/App.vue 顶部注释）。
//   - 业务路由 + 悬浮 dock   → 用法 B（host）：/wc/manifest.json（同源 public/）
//   - /assistant 路由        → 用法 A（容器/WC）：同一份 /wc/manifest.json + /wc/dist-ce/**（下方中间件映射）
//   - /wc-demo.html          → runtime 层验收台
// 即：**两条链路共用一份清单 / 一份 manifest**，命令只有 analyze + build:ce（见 openspec/changes/unify-page-manifest）。
// 代理：/api → 8080（serve.mjs 的 mock API）；/ws → 3000（agent-server）
export default defineConfig({
  plugins: [vue(), tailwindcss(), wcCeAssets()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    },
  },
})
