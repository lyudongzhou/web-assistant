// CLI 入口：analyzer --config <wc.pages.json> [--out <manifest.json>] [--tsconfig <tsconfig.json>] [--ai-cache <file>] [--no-ai]
import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'
import { MANIFEST_FILE } from '@webassistant/protocol'
import { analyze } from './analyze.js'

interface Args {
  config?: string
  out?: string
  aiCache?: string
  tsconfig?: string
  envFile?: string
  noAi: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { noAi: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--config' || arg === '-c') args.config = argv[++i]
    else if (arg === '--out' || arg === '-o') args.out = argv[++i]
    else if (arg === '--ai-cache') args.aiCache = argv[++i]
    else if (arg === '--tsconfig') args.tsconfig = argv[++i]
    else if (arg === '--env-file') args.envFile = argv[++i]
    else if (arg === '--no-ai') args.noAi = true
  }
  return args
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const configPath = path.resolve(process.cwd(), args.config ?? process.env.WC_PAGES ?? '')
  if (!args.config && !process.env.WC_PAGES) {
    console.error('用法：analyzer --config <wc.pages.json> [--out <manifest.json>] [--tsconfig <tsconfig.json>] [--env-file <file>] [--ai-cache <file>] [--no-ai]')
    process.exit(1)
  }
  if (!fs.existsSync(configPath)) {
    console.error(`找不到配置文件：${configPath}`)
    process.exit(1)
  }

  const outPath = args.out
    ? path.resolve(process.cwd(), args.out)
    : path.join(path.dirname(configPath), MANIFEST_FILE)

  const projectRoot = path.dirname(configPath)
  const envFiles = args.envFile
    ? [path.resolve(process.cwd(), args.envFile)]
    : [path.join(projectRoot, '.env.local'), path.join(projectRoot, '.env')]
  // 先加载 .env.local，再加载 .env；dotenv 默认不覆盖已有环境变量，
  // 因此 .env.local 优先于 .env，已有的 process.env 仍具有最高优先级。
  for (const envFile of envFiles) {
    if (fs.existsSync(envFile)) dotenv.config({ path: envFile })
  }
  const loadedEnvFiles = envFiles.filter((file) => fs.existsSync(file))

  const aiCacheFile = args.aiCache
    ? path.resolve(process.cwd(), args.aiCache)
    : path.join(projectRoot, '.analyze-cache.json')

  const manifest = await analyze({
    configPath,
    outPath,
    noAi: args.noAi,
    tsconfigPath: args.tsconfig ? path.resolve(process.cwd(), args.tsconfig) : undefined,
    aiCacheFile,
  })
  fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`)

  console.log(`✓ 生成 ${outPath}（manifest v${manifest.version}，${manifest.pages.length} 个页面）`)
  console.log(`  AI 缓存：${aiCacheFile}`)
  console.log(
    `  AI 环境：${loadedEnvFiles.length ? loadedEnvFiles.join(', ') : '未找到宿主 .env，使用进程环境'}`,
  )
  for (const [framework, container] of Object.entries(manifest.containers)) {
    console.log(`  容器 [${framework}] <${container.tagName}> → ${container.bundle}`)
  }
  for (const page of manifest.pages) {
    console.log(`  - <${page.tag}> ${page.title ?? ''}（${page.path}）→ ${page.bundle}`)
    console.log(`      keywords: ${page.keywords?.join(', ') || '(无)'}`)
    console.log(
      `      props: ${page.props?.map((p) => p.name).join(', ') || '(无)'}` +
        `  events: ${page.events?.join(', ') || '(无)'}`,
    )
    console.log(
      `      exposes: ${page.exposes?.map((m) => `${m.name}${m.signature ?? ''}`).join(' | ') || '(无)'}` +
        `  emits: ${page.emits?.map((e) => `${e.name}${e.payloadType ? `<${e.payloadType}>` : ''}`).join(' | ') || '(无)'}`,
    )
  }
}

await main()
