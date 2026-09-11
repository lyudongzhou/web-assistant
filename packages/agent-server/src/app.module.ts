import { Module } from '@nestjs/common'
import { HealthController } from './health/health.controller.js'
import { GatewayModule } from './gateway/gateway.module.js'
import { ManifestModule } from './manifest/manifest.module.js'

@Module({
  imports: [GatewayModule, ManifestModule],
  controllers: [HealthController],
})
export class AppModule {}
