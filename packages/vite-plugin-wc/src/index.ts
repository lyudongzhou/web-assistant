// @webassistant/vite-plugin-wc
// 由 wc.pages.json 驱动：把一个 framework 批次的「容器 + 页面」编译成一组可被 runtime 动态加载的 bundle。
//
// 产物结构（与 @webassistant/protocol 的命名规则一致，manifest 里引用的就是这些路径）：
//   dist-ce/containers/<framework>.js   容器（默认导出 adapter，自带框架与 UI 库）
//   dist-ce/pages/<camelTag>.js         每页一个（几 KB，公共依赖走共享 chunk）
//   dist-ce/chunk-*.js                  容器与页面共享的 vue / element-plus 等
//
// 硬约束：容器与页面必须同一次构建 —— 只有这样它们才共享同一份框架实例，
// 页面 WC 才能继承容器 provide 的 services（详见 wc-runtime-core/README 第 1 节）。
import path from "node:path";
import { createRequire } from "node:module";
import vue from "@vitejs/plugin-vue";
import { STYLE_SINK_API_KEY } from "@webassistant/wc-runtime-core/styleSink";
import {
  CONTAINER_ENTRY_KEY,
  containerBundlePath,
  kebabToCamel,
  pageBundlePath,
  resolveTag,
} from "@webassistant/protocol";
import type { Plugin, UserConfig } from "vite";
import { loadWcPages } from "./config.js";
import { pageEntrySource, prepareEntryDir, writeEntry } from "./entries.js";
import { collectAliases, resolveSpecifier, type AliasMap } from "./resolve.js";

// —— 样式聚合（B1）：把「页面依赖树里的共享组件样式」也内联进页面 styles 导出 ——
// custom-element 编译下每个 <style> 变成 `?vue&type=style&...&inline` 子模块，最终产物是 `export default "<css>"`。
const STYLE_INLINE_RE = /\.vue\?vue&type=style[^?]*[?&]inline(?:&|$)/
// 页面入口里的注入占位（entries.ts 的 JSON.parse("__WC_PAGE_STYLES_JSON__")），构建期替换成真实数组。
const STYLE_SENTINEL_RE = /JSON\.parse\(\s*["']__WC_PAGE_STYLES_JSON__["']\s*\)/

/** code-split 后的 chunk 形状（只取样式聚合需要的字段） */
type BundleChunk = {
  fileName: string
  code: string
  modules: Record<string, unknown>
  imports: readonly string[]
  dynamicImports: readonly string[]
}

/** 从 `export default "<css>"` 里取出 css 字符串；失败返回 null */
function extractInlineCss(code: string): string | null {
  const m = /export\s+default\s+("(?:\\.|[^"\\])*")/.exec(code)
  if (!m) return null
  try {
    return JSON.parse(m[1]) as string
  } catch {
    return null
  }
}

export interface WcPluginOptions {
  /** wc.pages.json 路径（相对项目根） */
  configPath?: string;
  /** 项目根，缺省 process.cwd()（wcBuildPlugin 会用 Vite 解析后的 root 覆盖） */
  root?: string;
  /** 显式别名，缺省读项目 package.json 的 imports */
  aliases?: AliasMap;
  /** 入口文件缓存目录 */
  entryDir?: string;
  /** 产物目录 */
  outDir?: string;
  /**
   * 额外需要排除（external、保留 import、不打进产物）的包/模式。
   * 在默认的 node 内置模块排除之上追加，原样传给 build.rollupOptions.external。
   *
   * 适用场景：页面依赖树里出现了 node-only 的构建期依赖（如 @tailwindcss/vite → jiti）。
   * 这类包只能跑在 Node、且其背后的 devtools/构建工具代码在浏览器产物里是不该被执行的死路径，
   * 一旦被 external:[] 强制「全打包」就会崩（node:module 等无对应浏览器导出）。
   */
  external?: (string | RegExp)[];
  /**
   * 样式落点桥：让「指定包」里往 document 注入的样式镜像进容器 shadow root。
   *
   * 原理：给匹配到的包模块前置
   *   `import "virtual:webassistant/style-sink"`（副作用 prelude，装上 shadowDocument 工厂）
   *   `var document = globalThis[Symbol.for("webassistant.styleSink.api")].shadowDocument(globalThis.document)`
   * Rollup 会把该本地绑定改名成 `document$N`，因此遮蔽范围**只收敛在被指定的包内**，
   * 同 chunk 的 vue / 运行时代码不受影响。
   *
   * 已知缺口（有意不覆盖）：window.document / globalThis.document 等全局属性路径、
   * 未列入 packages 的子依赖、`const doc = document` 逃逸出被遮蔽模块。
   */
  styleShim?: WcStyleShimOptions;
}

export interface WcStyleShimOptions {
  /**
   * 需要遮蔽 document 的包。字符串按 `/node_modules/<name>/` 片段匹配；
   * 正则直接测模块 id（可用于本地 mock 依赖，如 /src[\\/]vendor[\\/]fakeCssInJs/）。
   */
  packages?: (string | RegExp)[];
}

// —— 忽略 <style module>（CSS Module）——
// custom-element 模式下 @vitejs/plugin-vue 会直接抛错：
//   `<style module> is not supported in custom elements mode.`
// 因此在 vue 插件之前把 <style module> 整块剥掉（shadow DOM 隔离下这类 class 也基本用不上），
// 后续若要支持 CSS Module 再另行处理。
const STYLE_MODULE_BLOCK_RE = /<style\b([^>]*)>[\s\S]*?<\/style\s*>/g

/** 从 SFC 源码中剥离所有 <style module> 块；返回剥离后的源码与剥离数量 */
function stripStyleModules(code: string): { code: string; removed: number } {
  let removed = 0
  const next = code.replace(STYLE_MODULE_BLOCK_RE, (full, attrs: string) => {
    // 仅当 module 是独立属性名（排除 data-module 这类自定义属性）才剥离
    if (/(^|[\s"'])module(?=\s*=|\s|$)/.test(attrs)) {
      removed++
      return ""
    }
    return full
  })
  return { code: next, removed }
}

/**
 * 返回 [忽略 style-module 的 pre 插件, @vitejs/plugin-vue] 两个插件。
 * 其 customElement 过滤 = 项目内所有 .vue（排除 node_modules）。
 * 这样页面与共享组件都按 custom-element 编译，<style> 一律内联成 .styles（不再抽出 shared.css），
 * 共享组件样式再由 wcBuildPlugin 聚合进各页面 bundle。**仅用于 WC 构建**，SPA 模式用普通 vue()。
 *
 * 注：custom-element 模式不支持 <style module>（plugin-vue 会抛错），pre 插件会先把它剥掉。
 */
export function wcVuePlugin(_options: WcPluginOptions = {}): Plugin[] {
  const filter = /^((?!node_modules).)*\.vue$/

  const stripStyleModule: Plugin = {
    name: "webassistant:wc-strip-style-module",
    enforce: "pre",
    transform(code, id) {
      if (!filter.test(id)) return null
      const { code: next, removed } = stripStyleModules(code)
      if (removed === 0) return null
      this.warn(
        `[webassistant:wc] 忽略 ${removed} 个 <style module>（custom-element 模式暂不支持 CSS Module）`,
      )
      return { code: next, map: null }
    },
  }

  return [stripStyleModule, vue({ customElement: filter }) as Plugin]
}

// —— 样式落点桥（styleShim）——
// 必须用 transform（模块级）注入，**不能用 output.banner**：banner 在渲染完成之后追加、
// 不经过 Rollup 作用域分析，`var document` 会变成 chunk 级绑定、污染整个 chunk，
// 「只影响被指定包」的精确隔离就没了。
const SHIM_PRELUDE_ID = "virtual:webassistant/style-sink";
const RESOLVED_PRELUDE_ID = "\0" + SHIM_PRELUDE_ID;
/** 只对 JS/TS 模块注入（包里的 JSON / CSS 等一律不碰） */
const SHIM_MODULE_RE = /\.(mjs|cjs|js|jsx|ts|tsx)$/;
/** 匹配到的模块数超过这个数就告警一次（多半是 packages 模式写太宽） */
const SHIM_BROAD_MATCH_WARN = 200;

/**
 * 判断模块 id 是否「可注入」。要点：
 * - 裸 `.vue` 会被 @vitejs/plugin-vue 整体替换，注入无效 → 只接受它的**脚本子模块**
 *   （`Foo.vue?vue&type=script&setup=true&lang.ts`）
 * - SFC 的 style / template / custom 子模块导出的是字符串，一律不碰
 * - 其余只认 js/ts 系扩展名
 */
function isShimmableId(normalized: string): boolean {
  const queryIndex = normalized.indexOf("?");
  const filePath = queryIndex === -1 ? normalized : normalized.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : normalized.slice(queryIndex);
  if (/\.vue$/i.test(filePath)) return /[?&]type=script(?:&|$)/.test(query);
  if (/[?&]type=(style|template|custom)(?:&|$)/.test(query)) return false;
  return SHIM_MODULE_RE.test(filePath);
}

/**
 * 包匹配：字符串按 `/node_modules/<name>/` 片段，正则直接测**去掉 query 的模块路径**。
 *
 * ⚠️ 正则务必锚定到具体路径。例：`/src[\\/]/` 会误伤一大批包 ——
 * element-plus 等把源码放在 `es/components/<name>/src/*.mjs`，一个宽泛的 `src/` 就能命中几百个模块。
 */
function createShimMatcher(packages: readonly (string | RegExp)[]): (id: string) => boolean {
  const fragments: string[] = [];
  const regexes: RegExp[] = [];
  for (const entry of packages) {
    if (entry instanceof RegExp) regexes.push(entry);
    else fragments.push(`/node_modules/${entry.replace(/^\/+|\/+$/g, "")}/`);
  }
  return (id) => {
    if (!id || id.startsWith("\0")) return false;
    const normalized = id.replace(/\\/g, "/");
    const queryIndex = normalized.indexOf("?");
    const filePath = queryIndex === -1 ? normalized : normalized.slice(0, queryIndex);
    if (!isShimmableId(normalized)) return false;
    for (const fragment of fragments) if (filePath.includes(fragment)) return true;
    for (const regex of regexes) if (regex.test(filePath)) return true;
    return false;
  };
}

/** 定位 wc-runtime-core 的 styleSink 入口（供 prelude 引用）；解析不到就退回裸说明符 */
function resolveStyleSinkEntry(): string {
  try {
    return createRequire(import.meta.url).resolve("@webassistant/wc-runtime-core/styleSink");
  } catch {
    return "@webassistant/wc-runtime-core/styleSink";
  }
}

function createStyleShimPlugin(shim?: WcStyleShimOptions): Plugin | null {
  const packages = shim?.packages ?? [];
  if (!packages.length) return null;
  const matches = createShimMatcher(packages);
  const key = JSON.stringify(STYLE_SINK_API_KEY);
  // prelude import 必须在最前：它装上 shadowDocument 工厂，保证先于本模块求值。
  // 防御式写法：工厂缺席时退化成真 document（不崩、只是不镜像）。
  const banner =
    `import ${JSON.stringify(SHIM_PRELUDE_ID)};\n` +
    `var document = ((globalThis[Symbol.for(${key})] || {}).shadowDocument || function (d) { return d })(globalThis.document);\n`;
  let matched = 0;
  let warnedBroad = false;
  return {
    name: "webassistant:style-shim",
    enforce: "pre",
    transform(code, id) {
      if (!matches(id)) return null;
      matched += 1;
      if (!warnedBroad && matched > SHIM_BROAD_MATCH_WARN) {
        warnedBroad = true;
        this.warn(
          `[webassistant:wc] styleShim 已匹配 ${matched}+ 个模块，可能把 packages 写得太宽了` +
            `（例：/src[\\/]/ 会命中 element-plus 的 es/components/*/src/*.mjs）。建议锚定到具体包/目录。`,
        );
      }
      return { code: banner + code, map: null };
    },
  };
}

/**
 * 读 wc.pages.json → 生成页面入口 → 配置 library 多入口构建。
 *
 * wc.pages.json（v2）：
 * ```json
 * {
 *   "framework": "vue",
 *   "container": "src/ce/container.ts",
 *   "pages": [
 *     { "name": "UserList", "tag": "user-list", "path": "/users", "title": "用户列表",
 *       "component": "src/pages/UserList.vue" }
 *   ]
 * }
 * ```
 */
export function wcBuildPlugin(options: WcPluginOptions = {}): Plugin[] {
  const entryDirName = options.entryDir ?? "node_modules/.wc-entry";
  let root = options.root ?? process.cwd();

  const innerExternal: (string | RegExp)[] = [/^node:[a-z]/];
  if (options.external && options.external.length > 0)
    innerExternal.push(...options.external);

  // —— 样式聚合（B1）共享状态 ——
  // 每个 ?vue&type=style&...&inline 子模块的最终 CSS（moduleId → css）
  const styleCss = new Map<string, string>();
  // 本批页面组件的绝对路径（用于把页面自身样式排除出聚合，避免与入口里的 Page.styles 重复）
  const pageComponentPaths = new Set<string>();
  // 本批页面入口的产物文件名（pages/<tag>.js），generateBundle 据此识别页面 chunk
  const pageFileNames = new Set<string>();

  const buildPlugin: Plugin = {
    name: "webassistant:wc-build",
    enforce: "pre",

    config(resolved): UserConfig {
      root = resolved.root ?? root;
      const aliases = collectAliases(root, options.aliases);
      const config = loadWcPages(root, options.configPath);
      const entryDir = prepareEntryDir(path.resolve(root, entryDirName));

      // WC 构建必须有容器入口（省略 container 的 wc.pages.json 是「宿主直连批次」，
      // 只跑 analyzer / wcManifestPlugin 生成页面目录，不该走本插件）
      const containerEntry = config.container;
      if (!containerEntry) {
        throw new Error(
          `${options.configPath ?? 'wc.pages.json'} 缺少 container：WC 构建（wcVuePlugin）需要容器入口。` +
            '宿主直连模式（用法 B）请只使用 analyzer 或 wcManifestPlugin 生成 manifest，不要走 WC 构建。',
        );
      }

      // 容器入口直接指向宿主项目那个文件（它默认导出 adapter），产物落到 containers/<framework>.js
      const entries: Record<string, string> = {
        [CONTAINER_ENTRY_KEY]: resolveSpecifier(containerEntry, root, aliases),
      };
      const fileNames = new Map<string, string>([
        [CONTAINER_ENTRY_KEY, containerBundlePath(config.framework)],
      ]);

      for (const page of config.pages) {
        const tag = resolveTag(page);
        const entryName = kebabToCamel(tag);
        const component = resolveSpecifier(page.component, root, aliases);
        const source = pageEntrySource({
          component,
          pageHelper: config.pageHelper,
          tag,
        });
        entries[entryName] = writeEntry(entryDir, `${entryName}.js`, source);
        const bundlePath = pageBundlePath(tag);
        fileNames.set(entryName, bundlePath);
        pageFileNames.add(bundlePath);
        pageComponentPaths.add(component);
      }

      return {
        // vue 产物里的 process.env.NODE_ENV 在库模式下不会被替换，显式 define
        define: { "process.env.NODE_ENV": JSON.stringify("production") },
        build: {
          outDir: options.outDir ?? "dist-ce",
          emptyOutDir: true,
          lib: {
            entry: entries,
            formats: ["es"],
            fileName: (_format, entryName) =>
              fileNames.get(entryName) ?? `${entryName}.js`,
            // 所有 .vue 已按 custom-element 内联样式，不再产生外部 css（旧版会抽出 shared.css）。
          },
          // node-only 依赖通过 rollup external（/^node:/）跳过导出检查；
          // 其它 external 由调用方显式追加。
          // 其余公共依赖（vue / element-plus / pinia 等）仍走默认全部打进来，容器与页面共享同批 chunk。
          rollupOptions: {
            external: innerExternal,
            treeshake: {
              moduleSideEffects: (id) => {
                // 告诉打包器：所有 node: 开头的内置模块都没有副作用
                // 只要变量没有在业务逻辑里被真实执行，连同 import 语句直接整行删掉！
                if (id.startsWith("node:")) {
                  return false;
                }
                return true; // 保持其他模块的默认副作用判定
              },
            },
          },
        },
      };
    },
  };

  const styleCollectPlugin: Plugin = {
    name: "webassistant:wc-collect-styles",
    // post：等 Vite 的 CSS 插件把 ?inline 样式编译成 `export default "<css>"` 之后再取。
    enforce: "post",

    transform(code, id) {
      if (!STYLE_INLINE_RE.test(id)) return null
      const css = extractInlineCss(code)
      if (css != null) styleCss.set(id, css)
      return null
    },

    generateBundle(_options, bundle) {
      // 建立 fileName → chunk 映射，用于沿 import 关系做闭包。
      // 被多个页面共用的组件会被 Rollup code-split 成独立 chunk（如 domain-selector 所在组件），
      // 其样式模块不在页面 chunk 自己的 output.modules 里，必须顺着 imports / dynamicImports 追进去聚合。
      const chunks = new Map<string, BundleChunk>()
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type === "chunk") chunks.set(fileName, output)
      }

      for (const [fileName, chunk] of chunks) {
        if (!pageFileNames.has(fileName)) continue

        // 页面 chunk 及其所有可达 chunk（static + dynamic import）的模块 id 并集
        const moduleIds = new Set<string>()
        const visited = new Set<string>()
        const collect = (current: BundleChunk) => {
          if (visited.has(current.fileName)) return
          visited.add(current.fileName)
          for (const id of Object.keys(current.modules)) moduleIds.add(id)
          for (const dep of current.imports) {
            const next = chunks.get(dep)
            if (next) collect(next)
          }
          for (const dep of current.dynamicImports) {
            const next = chunks.get(dep)
            if (next) collect(next)
          }
        }
        collect(chunk)

        const cssList: string[] = []
        const seen = new Set<string>()
        for (const moduleId of [...moduleIds].sort()) {
          const css = styleCss.get(moduleId)
          if (!css) continue
          // 页面自身样式已由入口里的 Page.styles 注入，这里只聚合共享组件样式。
          if (pageComponentPaths.has(moduleId.split("?")[0])) continue
          if (seen.has(css)) continue
          seen.add(css)
          cssList.push(css)
        }

        const injected = cssList.length
          ? `[${cssList.map((css) => JSON.stringify(css)).join(",")}]`
          : "[]"
        const next = chunk.code.replace(STYLE_SENTINEL_RE, injected)
        if (next === chunk.code) {
          this.warn(
            `[webassistant:wc] 页面 ${fileName} 未找到样式注入占位，共享组件样式可能丢失`,
          )
        }
        chunk.code = next
      }
    },
  };

  // prelude：副作用安装 shadowDocument 工厂（由 shimPlugin 前置 import）
  const preludePlugin: Plugin = {
    name: "webassistant:style-sink-prelude",
    resolveId(id) {
      return id === SHIM_PRELUDE_ID ? RESOLVED_PRELUDE_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_PRELUDE_ID) return null;
      return `import { installStyleSink } from ${JSON.stringify(resolveStyleSinkEntry())};\ninstallStyleSink();\n`;
    },
  };
  const shimPlugin = createStyleShimPlugin(options.styleShim);

  return shimPlugin
    ? [buildPlugin, shimPlugin, preludePlugin, styleCollectPlugin]
    : [buildPlugin, styleCollectPlugin];
}

export type { WcPagesConfig, WcPageEntry } from "@webassistant/protocol";
export { loadWcPages } from "./config.js";
export { wcManifestPlugin, generateManifestIncremental } from "./manifest.js";
export type { WcManifestOptions } from "./manifest.js";
