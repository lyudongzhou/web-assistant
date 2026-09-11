import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { wcVuePlugin, wcBuildPlugin } from '@webassistant/vite-plugin-wc'

// WC 构建：只负责把 wc.pages.json 中的容器与页面编译成 bundle。
// manifest 分析是独立操作：执行 `pnpm analyze`。
export default defineConfig({
  plugins: [tailwindcss(), wcVuePlugin(), wcBuildPlugin()],
})
