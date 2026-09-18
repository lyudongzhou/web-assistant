import 'reflect-metadata'
import 'dotenv/config'
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'
import { NestFactory } from '@nestjs/core'
import { Logger } from '@nestjs/common'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { AppModule } from './app.module.js'
import { DirectWsAdapter } from './ws/direct-ws.adapter.js'

const logger = new Logger('Bootstrap')

// 服务器无外网时，通过 HTTP(S)_PROXY 走代理访问公网 LLM API（DeepSeek）。
// undici 的全局 fetch 不会自动读取代理变量，这里显式挂 EnvHttpProxyAgent。
// 未配置代理变量时跳过（本地直连，无副作用）。
// 注意：manifest 等内网请求需用 NO_PROXY 排除，否则也会被代理拦截。
if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY) {
  setGlobalDispatcher(new EnvHttpProxyAgent())
}

function applyCliArgs(): void {
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--manifest' && args[i + 1]) {
      // CLI 优先于 .env：两种来源互斥，否则 .env 里的 MANIFEST_URL 会盖掉 --manifest（静默失效）
      process.env.MANIFEST_PATH = args[++i]
      process.env.MANIFEST_URL = ''
    } else if (args[i] === '--manifest-url' && args[i + 1]) {
      process.env.MANIFEST_URL = args[++i]
      process.env.MANIFEST_PATH = ''
    } else if (args[i] === '--port' && args[i + 1]) process.env.PORT = args[++i]
  }
}

function describeManifestSource(): string {
  if (process.env.MANIFEST_URL) return process.env.MANIFEST_URL
  if (process.env.MANIFEST_PATH) return process.env.MANIFEST_PATH
  return '（默认 demo-app/public/wc/manifest.json）'
}

async function bootstrap(): Promise<void> {
  applyCliArgs()
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  )
  app.enableCors({ origin: true })
  app.useWebSocketAdapter(new DirectWsAdapter(app))
  await app.listen(Number(process.env.PORT || 3000), '0.0.0.0')
  const address = await app.getUrl()
  logger.log(`agent-server listening on ${address}`)
  logger.log(`manifest: ${describeManifestSource()}`)
  if (!process.env.DEEPSEEK_API_KEY) logger.warn('⚠️  未配置 DEEPSEEK_API_KEY')
}

void bootstrap().catch((error: unknown) => {
  logger.error('agent-server failed to start', error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
