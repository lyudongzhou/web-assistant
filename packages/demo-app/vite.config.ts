import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// 普通 SPA 模式：vue-router 多页面，用于开发时验证页面功能。
// /api 代理到 demo-app 的 mock 静态服务器（serve.mjs，8080）—— dev 模式下页面用 fetch('/api/...') 拉数据
// /ws 代理到 agent-server（3000）—— 用法 B 验收台（host.html）的对话链路
//
// 多页入口：index.html（既有 SPA）+ host.html（用法 B：宿主直连 router 的验收台）
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  build: {
    rollupOptions: {
      input: {
        index: 'index.html',
        host: 'host.html',
      },
    },
  },
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
