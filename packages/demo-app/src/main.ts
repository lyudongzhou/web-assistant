// SPA 入口：普通 Vue 应用（router + router-view + element-plus），仅用于开发时验证页面功能。
// 页面被编译成 WC 的那条链路走 vite.ce.config.ts（容器 + 页面同批构建）。
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import './ce/tailwind.css'
import App from './App.vue'
import router from './router'

createApp(App).use(router).use(createPinia()).use(ElementPlus).mount('#app')
