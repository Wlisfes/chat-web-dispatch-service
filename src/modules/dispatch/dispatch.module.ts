import { Module } from '@nestjs/common'
import { DispatchChannelNotifier } from '@/modules/dispatch/dispatch.notifier'
import { DispatchSubmitCacheService } from '@/modules/dispatch/dispatch.submit.cache'
import { DispatchService } from '@/modules/dispatch/dispatch.service'
import { DispatchSubmitRecorder } from '@/modules/dispatch/dispatch.submit.service'
import { DispatchSendService } from '@/modules/dispatch/dispatch.send.service'
import { ObserveModule } from '@/modules/observe/observe.module'

/** 短信消费模块：只消费队列，不提供接口。入库后通过 Observe 模拟设备发送。 */
@Module({
    imports: [ObserveModule],
    providers: [DispatchChannelNotifier, DispatchSubmitCacheService, DispatchSubmitRecorder, DispatchSendService, DispatchService]
})
export class DispatchModule {}
