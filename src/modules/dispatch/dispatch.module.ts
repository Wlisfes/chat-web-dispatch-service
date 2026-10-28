import { Module } from '@nestjs/common'
import { DispatchChannelNotifier } from '@/modules/dispatch/dispatch.notifier'
import { DispatchSubmitCacheService } from '@/modules/dispatch/dispatch.submit.cache'
import { DispatchService } from '@/modules/dispatch/dispatch.service'
import { DispatchSubmitRecorder } from '@/modules/dispatch/dispatch.submit.service'
import { DispatchSendService } from '@/modules/dispatch/dispatch.send.service'
import { ObserveModule } from '@/modules/observe/observe.module'
import { DispatchBillingOutbox } from '@/modules/dispatch/dispatch.billing.outbox'
import { DispatchReceiptService } from '@/modules/dispatch/dispatch.receipt.service'

/** 短信消费模块：只消费队列，不提供接口。入库后异步提交 Observe。设备回执由 Hooks 入队后逐条写回，本服务只做回执超时补偿。 */
@Module({
    imports: [ObserveModule],
    providers: [
        DispatchChannelNotifier,
        DispatchSubmitCacheService,
        DispatchBillingOutbox,
        DispatchSubmitRecorder,
        DispatchSendService,
        DispatchReceiptService,
        DispatchService
    ]
})
export class DispatchModule {}
