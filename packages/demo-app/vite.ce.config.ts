import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { wcVuePlugin, wcBuildPlugin } from '@webassistant/vite-plugin-wc'

// WC 构建：只负责把 wc.pages.json 中的容器与页面编译成 bundle。
// manifest 分析是独立操作：执行 `pnpm analyze`。
export default defineConfig({
  build: {
    // ⚠️ 必须关掉 copyPublicDir：产物目录与 public/ 互不相关，没必要把 public（含 manifest）拷进产物目录。
    copyPublicDir: false,
  },
  plugins: [
    tailwindcss(),
    wcVuePlugin(),
    wcBuildPlugin({
      // 样式落点桥：让「指定包」里往 document 注入的样式镜像进容器 shadow root。
      // 这里锚定到本 demo 的 src/，于是同时覆盖：
      //   - mock 依赖 src/vendor/fakeCssInJs.ts
      //   - 页面自身 src/pages/*.vue（注入点是它的 ?vue&type=script&setup=true 子模块）
      //
      // ⚠️ 正则一定要锚定。反例：`/src[\\/]/` 会命中 element-plus 的
      //    `es/components/<name>/src/*.mjs`（实测 736 个模块），既撑大产物、又把无关样式改道。
      //    真实项目推荐按包名写字符串，如 'element-plus' / '@vueuse/core'。
      styleShim: {
        packages: [
          // 本项目源码（含页面自身与 mock 依赖）
          /packages[\\/]demo-app[\\/]src[\\/]/,
          // vasturiano 图谱生态：这几个包都在模块求值期用 style-inject（rollup-plugin-postcss）
          // 往 document.head 注入 <style>。逐个实测过：
          //   3d-force-graph        → .graph-info-msg / .scene-container .clickable|.grabbable
          //   three-render-objects  → .scene-nav-info / .scene-container canvas:focus
          //   float-tooltip         → .float-tooltip-kap（three-render-objects 的依赖）
          // 不注入、无需加入：three-forcegraph / accessor-fn / kapsule
          /node_modules\/(?:3d-force-graph|three-render-objects|float-tooltip)\//,
        ],
      },
    }),
  ],
})


