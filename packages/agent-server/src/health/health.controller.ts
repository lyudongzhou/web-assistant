import { Controller, Get } from '@nestjs/common'

@Controller('health')
export class HealthController {
  @Get()
  health(): { ok: true; hasApiKey: boolean } {
    return {
      ok: true,
      hasApiKey: Boolean(process.env.DEEPSEEK_API_KEY),
    }
  }
}
