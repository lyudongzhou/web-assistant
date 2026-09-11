// 单测公共桩：假 adapter（记录调用序列）+ 假 manifest + 假 importer。
// core 是纯逻辑，可以完全脱离 DOM / 框架来验证编排行为。

export function createFakeAdapter(framework = 'vue', overrides = {}) {
  const calls = []
  const handles = []
  const adapter = {
    framework,
    defaultTagName: `runtime-${framework}`,
    defineContainer(options) {
      calls.push(`defineContainer:${options.tagName}`)
      const handle = { tagName: options.tagName, options, views: [], root: null }
      handles.push(handle)
      return handle
    },
    mountContainer(handle, root) {
      calls.push(`mount:${handle.tagName}`)
      handle.root = root
    },
    patchContainer(handle, view) {
      calls.push(`patch:${view.framework}:${view.tag ?? 'null'}:${view.status}`)
      handle.views.push(view)
    },
    unmountContainer(handle) {
      calls.push(`unmount:${handle.tagName}`)
      handle.root = null
    },
    definePage(mod, api) {
      calls.push(`definePage:${api.tag}`)
    },
    ...overrides,
  }
  return { adapter, calls, handles }
}

export function makeManifest(overrides = {}) {
  return {
    version: 2,
    containers: { vue: { bundle: 'containers/vue.js', tagName: 'runtime-vue' } },
    pages: [
      {
        name: 'UserList',
        tag: 'user-list',
        path: '/users',
        title: '用户列表',
        framework: 'vue',
        bundle: 'pages/userList.js',
        props: [{ name: 'users', type: 'Array' }],
        events: ['search'],
      },
      {
        name: 'UserDetail',
        tag: 'user-detail',
        path: '/users/:id',
        title: '用户详情',
        framework: 'vue',
        bundle: 'pages/userDetail.js',
        props: [{ name: 'user', type: 'Object' }],
      },
    ],
    ...overrides,
  }
}

/** 假 importer：按 URL 返回页面模块 / 容器模块，并记录加载次数 */
export function createFakeImporter(map = {}) {
  const loads = []
  const importImpl = async (url) => {
    loads.push(url)
    if (url in map) {
      const value = map[url]
      return typeof value === 'function' ? value() : value
    }
    if (url.includes('pages/')) return { styles: [`/* ${url} */`], definePage() {} }
    throw new Error(`未知模块：${url}`)
  }
  return { importImpl, loads }
}

export const fakeRoot = () => ({ tagName: 'DIV', children: [] })
