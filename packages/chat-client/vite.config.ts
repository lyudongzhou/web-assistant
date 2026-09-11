import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// SPA demo：/wc 代理到 demo-app 的静态服务器（manifest + WC 产物），/api 和 /ws 代理到 agent-server
export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/wc': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/wc/, ''),
      },
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
