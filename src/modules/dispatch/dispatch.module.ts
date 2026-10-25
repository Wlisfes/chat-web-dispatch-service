import { Module } from '@nestjs/common'
import { DispatchChannelNotifier } from '@/modules/dispatch/dispatch.notifier'
import { DispatchService } from '@/modules/dispatch/dispatch.service'

/** 短信消费模块：只消费队列，不提供接口。 */
@Module({
    providers: [DispatchChannelNotifier, DispatchService]
})
export class DispatchModule {}
