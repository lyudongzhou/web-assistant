import { Module } from '@nestjs/common'
import { SessionModule } from '../session/session.module.js'
import { ManifestModule } from '../manifest/manifest.module.js'
import { RpcModule } from '../rpc/rpc.module.js'
import { AgentModule } from '../agent/agent.module.js'
import { AgentGateway } from './agent.gateway.js'

@Module({
  imports: [SessionModule, ManifestModule, RpcModule, AgentModule],
  providers: [AgentGateway],
})
export class GatewayModule {}
