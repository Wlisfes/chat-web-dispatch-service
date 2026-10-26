import { Module } from '@nestjs/common'
import { DispatchChannelNotifier } from '@/modules/dispatch/dispatch.notifier'
import { DispatchSubmitCacheService } from '@/modules/dispatch/dispatch.submit.cache'
import { DispatchService } from '@/modules/dispatch/dispatch.service'
import { DispatchSubmitRecorder } from '@/modules/dispatch/dispatch.submit.service'

/** 短信消费模块：只消费队列，不提供接口。 */
@Module({
    providers: [DispatchChannelNotifier, DispatchSubmitCacheService, DispatchSubmitRecorder, DispatchService]
})
export class DispatchModule {}
