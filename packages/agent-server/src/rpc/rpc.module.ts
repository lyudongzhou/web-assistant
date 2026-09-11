import { Module } from '@nestjs/common'
import { RpcService } from './rpc.service.js'

@Module({
  providers: [RpcService],
  exports: [RpcService],
})
export class RpcModule {}
