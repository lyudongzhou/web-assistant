// 说明符解析：别名（package.json imports / options.aliases）→ 相对/绝对路径 → 裸包名原样返回。
import fs from 'node:fs'
import path from 'node:path'

export type AliasMap = Record<string, string>

/** 读取 package.json 的 imports 字段（Node subpath imports，如 "#/*": "./src/*"） */
export function readPackageImports(root: string): AliasMap {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')) as {
      imports?: AliasMap
    }
    return pkg.imports ?? {}
  } catch {
    return {}
  }
}

/** 别名映射：支持 "*" 通配（"#/*": "./src/*"）与精确匹配（"#": "./src"）；未命中返回 null */
export function applyAliases(specifier: string, aliases: AliasMap): string | null {
  for (const [key, value] of Object.entries(aliases)) {
    const star = key.indexOf('*')
    if (star !== -1) {
      const prefix = key.slice(0, star)
      const suffix = key.slice(star + 1)
      if (specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
        const matched = specifier.slice(prefix.length, specifier.length - suffix.length)
        return value.replace('*', matched)
      }
    } else if (specifier === key) {
      return value
    }
  }
  return null
}

/** 裸包名：@scope/pkg，或不含 / 与 . 的简单名（vue、element-plus） */
export function isBareImport(specifier: string): boolean {
  return specifier.startsWith('@') || (!specifier.includes('/') && !specifier.includes('.'))
}

export function resolveSpecifier(specifier: string, root: string, aliases: AliasMap): string {
  const aliased = applyAliases(specifier, aliases)
  if (aliased != null) {
    return aliased.startsWith('.') || aliased.startsWith('/') ? path.resolve(root, aliased) : aliased
  }
  if (isBareImport(specifier)) return specifier
  return path.resolve(root, specifier)
}

export function collectAliases(root: string, aliases?: AliasMap): AliasMap {
  return aliases ?? readPackageImports(root)
}
