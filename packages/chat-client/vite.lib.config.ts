import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 库构建：打成可被其它项目 import 的组件库。
// vue 与 @webassistant/* 运行时依赖全部 external，由宿主/依赖包提供，不进产物。
// 注意：不需要将 vue-router external —— 宿主侧已不再依赖 vue-router（它在容器 bundle 里）。
export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: 'dist',
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: 'index',
      cssFileName: 'style',
    },
    cssCodeSplit: false,
    rollupOptions: {
      external: [
        'vue',
        /^@webassistant\/protocol(\/.*)?$/,
        /^@webassistant\/wc-runtime-core(\/.*)?$/,
        /^@webassistant\/wc-runtime-vue(\/.*)?$/,
      ],
    },
  },
})
