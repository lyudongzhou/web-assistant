import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addStyleTarget,
  currentStyleTargets,
  installStyleSink,
  removeStyleTarget,
  resetStyleSink,
  shadowDocument,
  beginStyleScope,
  endStyleScope,
  activateStyleScope,
  clearStyleScopes,
  DEFAULT_STYLE_SCOPE,
  STYLE_SINK_API_KEY,
} from '../dist/styleSink.js'

// styleSink.ts 全程 typeof 守卫、不依赖真 DOM。这里给最小桩验证：
// 「改道」模型（库自己的真节点移进容器 shadow root）、页级 scope（摘下/挂回）、代理透传。
// 真实的品牌校验（Illegal invocation）与 shadow root 行为留给 demo 端到端验证。

function makeSheetStub() {
  const rules = []
  return {
    get cssRules() {
      return rules
    },
    insertRule(rule) {
      rules.push({ cssText: rule })
      return rules.length - 1
    },
    deleteRule(index) {
      rules.splice(index, 1)
    },
  }
}

// 用原型承载 textContent / appendChild / append，贴近真实 DOM。
const nodeProto = {
  get textContent() {
    return this._text == null ? '' : this._text
  },
  set textContent(value) {
    this._text = value == null ? '' : String(value)
  },
  appendChild(child) {
    if (!this._kids) this._kids = []
    if (child && typeof child === 'object') child.parentNode = this
    this._kids.push(child)
    // 模拟真实行为：追加文本节点会改变 textContent
    if (child && typeof child === 'object' && typeof child.text === 'string') {
      this._text = (this._text == null ? '' : this._text) + child.text
    }
    return child
  },
  append(...children) {
    for (const child of children) this.appendChild(child)
  },
  setAttribute(name, value) {
    this.attrs[name] = value
  },
}

function makeNodeStub(tag) {
  const el = Object.create(nodeProto)
  el.tagName = tag
  el.parentNode = null
  el.rel = undefined
  el.href = undefined
  el.attrs = {}
  el._connected = false
  el._sheet = null
  el._text = ''
  el._kids = []
  // <style> 只有连上文档（head 或已连接的 shadow root）后才有 sheet
  Object.defineProperty(el, 'sheet', {
    configurable: true,
    get() {
      if (!this._connected) return null
      if (!this._sheet) this._sheet = makeSheetStub()
      return this._sheet
    },
  })
  return el
}

function connect(node) {
  if (node && typeof node === 'object' && '_connected' in node) node._connected = true
  return node
}

/** head / body：真实文档容器（appendChild 会把节点连上文档） */
function makeContainerStub(tagName) {
  return {
    tagName,
    children: [],
    appendChild(node) {
      this.children.push(connect(node))
      if (node && typeof node === 'object') node.parentNode = this
      return node
    },
    insertBefore(node) {
      this.children.unshift(connect(node))
      if (node && typeof node === 'object') node.parentNode = this
      return node
    },
    removeChild(node) {
      const index = this.children.indexOf(node)
      if (index >= 0) this.children.splice(index, 1)
      if (node && typeof node === 'object') node.parentNode = null
      return node
    },
    append(...nodes) {
      for (const node of nodes) this.appendChild(node)
    },
    prepend(...nodes) {
      for (const node of nodes) this.children.unshift(connect(node))
    },
  }
}

/** shadow root：容器已挂在文档里 —— 插进来的 <style> 也算 connected（有 sheet） */
function makeShadowStub() {
  return {
    children: [],
    appendChild(node) {
      const index = this.children.indexOf(node)
      if (index >= 0) this.children.splice(index, 1)
      this.children.push(connect(node))
      if (node && typeof node === 'object') node.parentNode = this
      return node
    },
    removeChild(node) {
      const index = this.children.indexOf(node)
      if (index >= 0) this.children.splice(index, 1)
      if (node && typeof node === 'object') node.parentNode = null
      return node
    },
  }
}

function installDomStub() {
  const head = makeContainerStub('HEAD')
  const body = makeContainerStub('BODY')
  const document = {
    head,
    body,
    createElement: (tag) => makeNodeStub(String(tag).toUpperCase()),
    createTextNode: (text) => ({ text: String(text) }),
    querySelector: () => null,
  }
  return { document, head, body }
}


test('无 target：样式原样进文档（不改道）', () => {
  resetStyleSink()
  const { document, head } = installDomStub()
  const doc = shadowDocument(document)

  const style = document.createElement('style')
  style.textContent = 'a{color:red}'
  doc.head.appendChild(style)

  assert.equal(head.children.length, 1, '原生插入仍照常发生')
  assert.equal(style.parentNode, head)
  assert.deepEqual(currentStyleTargets(), [])
})

test('有 target：样式真节点被改道进 shadow root（head 里没有）', () => {
  resetStyleSink()
  const { document, head } = installDomStub()
  const target = makeShadowStub()
  addStyleTarget(target)
  const doc = shadowDocument(document)

  const style = document.createElement('style')
  style.textContent = 'b{color:blue}'
  const returned = doc.head.appendChild(style)

  assert.equal(returned, style, 'appendChild 返回原节点')
  assert.equal(target.children.length, 1)
  assert.equal(head.children.length, 0, 'head 里不再有副本')
  assert.equal(target.children[0], style, '就是库自己那个真节点（非克隆）')
  assert.equal(style.parentNode, target)
  assert.equal(style.attrs['data-wa-shadow'], DEFAULT_STYLE_SCOPE)
})

test('不再按内容去重：两次同内容注入各自改道', () => {
  resetStyleSink()
  const { document } = installDomStub()
  const target = makeShadowStub()
  addStyleTarget(target)
  const doc = shadowDocument(document)

  const a = document.createElement('style')
  a.textContent = 'dup{color:red}'
  doc.head.appendChild(a)
  const b = document.createElement('style')
  b.textContent = 'dup{color:red}'
  doc.head.appendChild(b)

  assert.equal(target.children.length, 2)
})

test('P2：空 <style> + sheet.insertRule —— 改道后自身 sheet 生效', () => {
  resetStyleSink()
  const { document } = installDomStub()
  const target = makeShadowStub()
  addStyleTarget(target)
  const doc = shadowDocument(document)

  const style = doc.createElement('style')
  doc.head.appendChild(style)
  assert.equal(style.parentNode, target, '改道进容器')
  assert.ok(style.sheet, '连上已连接的 shadow root 后 sheet 存在')
  style.sheet.insertRule('x{color:green}', 0)
  assert.equal(style.sheet.cssRules[0].cssText, 'x{color:green}')
})

test('style-inject 写法：改道后 appendChild(textNode) 直接作用于该节点', () => {
  resetStyleSink()
  const { document } = installDomStub()
  const target = makeShadowStub()
  addStyleTarget(target)
  const doc = shadowDocument(document)

  const style = doc.createElement('style')
  style.type = 'text/css'
  doc.head.appendChild(style)
  assert.equal(style.parentNode, target)

  style.appendChild(document.createTextNode('.graph-info-msg { color: lavender }'))
  assert.equal(style.textContent, '.graph-info-msg { color: lavender }')
})

test('插入之后 style.textContent = css 直接作用于该节点', () => {
  resetStyleSink()
  const { document } = installDomStub()
  const target = makeShadowStub()
  addStyleTarget(target)
  const doc = shadowDocument(document)

  const style = doc.createElement('style')
  doc.head.appendChild(style)
  style.textContent = '.late { color: red }'
  assert.equal(style.textContent, '.late { color: red }')
  assert.equal(target.children[0], style)
})

test('三家同时「空着插入」：三份都改道，各自独立', () => {
  resetStyleSink()
  const { document } = installDomStub()
  const target = makeShadowStub()
  addStyleTarget(target)
  const doc = shadowDocument(document)

  const a = doc.createElement('style')
  const b = doc.createElement('style')
  const c = doc.createElement('style')
  doc.head.appendChild(a)
  doc.head.appendChild(b)
  doc.head.appendChild(c)
  assert.equal(target.children.length, 3)

  a.appendChild(document.createTextNode('.a{}'))
  b.appendChild(document.createTextNode('.b{}'))
  c.appendChild(document.createTextNode('.c{}'))
  assert.deepEqual(
    target.children.map((s) => s.textContent),
    ['.a{}', '.b{}', '.c{}'],
  )
})

test('只改道 <link rel="stylesheet">；其它节点仍进 head', () => {
  resetStyleSink()
  const { document, head } = installDomStub()
  const target = makeShadowStub()
  addStyleTarget(target)
  const doc = shadowDocument(document)

  const sheet = document.createElement('link')
  sheet.rel = 'stylesheet'
  sheet.href = '/a.css'
  doc.head.appendChild(sheet)
  assert.equal(target.children.length, 1)

  const icon = document.createElement('link')
  icon.rel = 'icon'
  icon.href = '/f.ico'
  doc.head.appendChild(icon)
  assert.equal(target.children.length, 1, 'rel!=stylesheet 不改道')
  assert.equal(head.children.length, 1, 'icon 仍进 head')

  const div = document.createElement('div')
  doc.head.appendChild(div)
  assert.equal(target.children.length, 1, '非样式节点不改道')
  assert.equal(head.children.length, 2)
})

test('body 上的样式插入同样被接管', () => {
  resetStyleSink()
  const { document, body } = installDomStub()
  const target = makeShadowStub()
  addStyleTarget(target)
  const doc = shadowDocument(document)

  const style = document.createElement('style')
  style.textContent = 'body-rule{}'
  doc.body.appendChild(style)
  assert.equal(target.children.length, 1)
  assert.equal(body.children.length, 0, 'body 里不再有副本')
})

test('多 target：按单容器假设只投 targets[0]', () => {
  resetStyleSink()
  const { document } = installDomStub()
  const t1 = makeShadowStub()
  const t2 = makeShadowStub()
  addStyleTarget(t1)
  addStyleTarget(t2)
  const doc = shadowDocument(document)

  const style = document.createElement('style')
  style.textContent = 'multi{}'
  doc.head.appendChild(style)

  assert.equal(t1.children.length, 1)
  assert.equal(t2.children.length, 0, '单容器假设：只有第一个 target 收到')
})

test('注销 target 后不再改道（退回 head）', () => {
  resetStyleSink()
  const { document, head } = installDomStub()
  const target = makeShadowStub()
  addStyleTarget(target)
  const doc = shadowDocument(document)

  const first = document.createElement('style')
  doc.head.appendChild(first)
  assert.equal(target.children.length, 1)

  removeStyleTarget(target)
  assert.deepEqual(currentStyleTargets(), [])

  const second = document.createElement('style')
  doc.head.appendChild(second)
  assert.equal(target.children.length, 1, '注销后不再改道')
  assert.equal(head.children.length, 1, '退回原生 head 插入')
})

test('removeChild 兜底：改道节点不在 head 里也能被「移除」', () => {
  resetStyleSink()
  const { document } = installDomStub()
  const target = makeShadowStub()
  addStyleTarget(target)
  const doc = shadowDocument(document)

  const style = document.createElement('style')
  doc.head.appendChild(style)
  assert.equal(target.children.length, 1)

  doc.head.removeChild(style)
  assert.equal(target.children.length, 0, '从容器移除')
})

test('页级 scope：只挂当前页，切走摘下、切回挂回', () => {
  resetStyleSink()
  const { document } = installDomStub()
  const target = makeShadowStub()
  addStyleTarget(target)
  const doc = shadowDocument(document)

  activateStyleScope('page-a')
  beginStyleScope('page-a')
  const a = doc.createElement('style')
  a.textContent = 'a{}'
  doc.head.appendChild(a)
  endStyleScope()
  assert.equal(target.children.length, 1, '当前页的样式立即挂上')

  // 切到别的页：page-a 的节点被摘下（保留在组里）
  activateStyleScope('page-b')
  assert.equal(target.children.length, 0, 'page-a 节点被摘下')
  assert.equal(a.parentNode, null)

  beginStyleScope('page-b')
  const b = doc.createElement('style')
  b.textContent = 'b{}'
  doc.head.appendChild(b)
  endStyleScope()
  assert.equal(target.children.length, 1)
  assert.equal(target.children[0], b)

  // 切回 page-a：page-b 摘下，page-a 挂回（原节点复用）
  activateStyleScope('page-a')
  assert.equal(target.children.length, 1)
  assert.equal(target.children[0], a)

  // 未激活的 scope 注入只暂存、不挂
  beginStyleScope('page-c')
  const c = doc.createElement('style')
  c.textContent = 'c{}'
  doc.head.appendChild(c)
  endStyleScope()
  assert.equal(target.children.length, 1, 'page-c 未激活 → 暂存不挂')

  clearStyleScopes()
  assert.equal(target.children.length, 0, 'clear 后全部摘除')
})

test('容器级注入（无 begin，兜底 scope）恒定挂着、不随切页摘下', () => {
  resetStyleSink()
  const { document } = installDomStub()
  const target = makeShadowStub()
  addStyleTarget(target)
  const doc = shadowDocument(document)

  // 未 beginStyleScope：归属兜底 scope
  const containerStyle = doc.createElement('style')
  containerStyle.textContent = 'container-level{}'
  doc.head.appendChild(containerStyle)
  assert.equal(target.children.length, 1)
  assert.equal(containerStyle.attrs['data-wa-shadow'], DEFAULT_STYLE_SCOPE)

  // 切页不应把它摘下
  activateStyleScope('page-x')
  assert.equal(target.children.length, 1, '兜底 scope 不参与页级摘挂')
  assert.equal(containerStyle.parentNode, target)

  activateStyleScope(null)
  assert.equal(target.children.length, 1, '已无当前页也仍在')
})

test('代理透传：head/body 返回缓存代理，其余属性原样可用', () => {
  resetStyleSink()
  const { document } = installDomStub()
  const doc = shadowDocument(document)

  assert.equal(doc.head, doc.head, 'head 返回同一个缓存代理')
  assert.equal(doc.body, doc.body, 'body 返回同一个缓存代理')
  assert.notEqual(doc.head, document.head, 'head 确为代理而非原对象')
  assert.equal(doc.head.tagName, 'HEAD', '属性读取透传')
  assert.equal(typeof doc.createElement, 'function')
  assert.equal(doc.createElement('div').tagName, 'DIV', '工厂方法可正常调用')
  assert.equal(typeof doc.querySelector, 'function')
})

test('installStyleSink：挂到 globalThis 且幂等（key 与代码生成一致）', () => {
  const api = installStyleSink()
  assert.equal(typeof api.shadowDocument, 'function')
  assert.equal(typeof api.addStyleTarget, 'function')
  assert.equal(typeof api.removeStyleTarget, 'function')
  assert.equal(typeof api.currentStyleTargets, 'function')
  assert.equal(typeof api.beginStyleScope, 'function')
  assert.equal(typeof api.endStyleScope, 'function')
  assert.equal(typeof api.activateStyleScope, 'function')
  assert.equal(typeof api.clearStyleScopes, 'function')

  assert.equal(globalThis[Symbol.for(STYLE_SINK_API_KEY)], api)
  assert.equal(installStyleSink(), api, '重复调用返回同一份')
  assert.equal(STYLE_SINK_API_KEY, 'webassistant.styleSink.api')
})
