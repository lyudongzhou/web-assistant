import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// 普通 SPA 模式：vue-router 多页面，用于开发时验证页面功能。
// /api 代理到 demo-app 的 mock 静态服务器（serve.mjs，8080）—— dev 模式下页面用 fetch('/api/...') 拉数据
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
})
