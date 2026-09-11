import { Module } from '@nestjs/common'
import { ManifestModule } from '../manifest/manifest.module.js'
import { RpcModule } from '../rpc/rpc.module.js'
import { SessionModule } from '../session/session.module.js'
import { AgentService } from './agent.service.js'

@Module({
  imports: [ManifestModule, RpcModule, SessionModule],
  providers: [AgentService],
  exports: [AgentService],
})
export class AgentModule {}
