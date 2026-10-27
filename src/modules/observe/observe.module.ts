import { Module } from '@nestjs/common'
import { ObserveClientService } from '@/modules/observe/observe.client'

/** Observe TCP 客户端模块：Dispatch 调用 Observe 模拟发送。 */
@Module({
    providers: [ObserveClientService],
    exports: [ObserveClientService]
})
export class ObserveModule {}
