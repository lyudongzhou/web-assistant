import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hashString,
  injectLightDomStylesBulk,
  resetLightDomStyles,
} from '../dist/dom.js'

// dom.ts 是 core 里唯一碰 DOM 的文件，且全程 typeof 守卫。
// 这里给一个最小 document 桩，验证光 DOM 注入的去重 / append 语义，不引入 jsdom。
function installDomStub() {
  const styles = []
  globalThis.document = {
    head: {
      appendChild(style) {
        styles.push(style)
      },
    },
    createElement(tag) {
      return {
        tagName: tag,
        attrs: {},
        textContent: '',
        setAttribute(name, value) {
          this.attrs[name] = value
        },
      }
    },
    querySelector() {
      return null
    },
  }
  return { styles }
}

test('hashString：稳定、同输入同输出、可作去重 key', () => {
  assert.equal(hashString('a{color:red}'), hashString('a{color:red}'))
  assert.equal(typeof hashString('x'), 'string')
  assert.ok(hashString('x').length > 0)
  // 不同输入哈希不同（FNV-1a，正常不会碰撞；此处只做最小校验）
  assert.notEqual(hashString('a'), hashString('b'))
})

test('injectLightDomStylesBulk：内容去重、append-only、返回新增条数', () => {
  resetLightDomStyles()
  const { styles } = installDomStub()

  const injected = injectLightDomStylesBulk(['a{color:red}', 'a{color:red}', 'b{color:blue}'], 'wa-page')

  assert.equal(injected, 2, '重复内容只注入一次')
  assert.equal(styles.length, 2)
  // 每段都带 data-wa-light 属性（key = prefix + 内容哈希）
  assert.ok(styles.every((s) => typeof s.attrs['data-wa-light'] === 'string'))
  assert.ok(styles.every((s) => s.attrs['data-wa-light'].startsWith('wa-page-')))
  assert.deepEqual(
    styles.map((s) => s.textContent).sort(),
    ['a{color:red}', 'b{color:blue}'].sort(),
  )

  // 再次注入相同内容：不再追加
  const again = injectLightDomStylesBulk(['a{color:red}', 'b{color:blue}'], 'wa-page')
  assert.equal(again, 0)
  assert.equal(styles.length, 2)
})

test('injectLightDomStylesBulk：空项被跳过，缺省 prefix 为 wa-page', () => {
  resetLightDomStyles()
  const { styles } = installDomStub()

  const injected = injectLightDomStylesBulk(['', 'c{color:green}'])
  assert.equal(injected, 1)
  assert.equal(styles.length, 1)
  assert.equal(styles[0].attrs['data-wa-light'].startsWith('wa-page-'), true)
})
