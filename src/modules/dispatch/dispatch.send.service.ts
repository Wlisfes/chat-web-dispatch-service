import { Injectable } from '@nestjs/common'
import { type ObserveSubmitResult } from '@wlisfes/chat-web-base-schema/observe'
import { ObserveClientService } from '@/modules/observe/observe.client'
import { DispatchSubmitRecorder } from '@/modules/dispatch/dispatch.submit.service'
import * as SrmSchema from '@wlisfes/chat-web-base-schema/chat-web-srm-mysql'
import * as constants from '@/modules/dispatch/dispatch.constants'

/** 已有最终结果的发送记录，重投时不再重复发送。 */
const SETTLED_STATUSES = new Set<SrmSchema.TbSrmSimbankMessageSendStatus>([
    SrmSchema.TbSrmSimbankMessageSendStatus.SUCCESS,
    SrmSchema.TbSrmSimbankMessageSendStatus.FAILED,
    SrmSchema.TbSrmSimbankMessageSendStatus.REJECTED,
    SrmSchema.TbSrmSimbankMessageSendStatus.DELIVERED
])

/** 本次发送的处理结果，用于日志。 */
export interface DispatchSendOutcome {
    /** true 表示已有最终结果，本次跳过发送。 */
    skipped: boolean
    sendStatus: SrmSchema.TbSrmSimbankMessageSendStatus
    statusCode?: string
    statusMessage?: string
    /** false 表示结果未写入：记录状态已被其他流程推进。 */
    saved?: boolean
}

/**
 * 发送记录写入后调用 Observe 模拟设备发送，并把结果写回发送记录。
 * Observe 不可用时记为提交失败（rejected），不重新入队，避免同一条短信反复占用端口。
 */
@Injectable()
export class DispatchSendService {
    constructor(
        private readonly observeClient: ObserveClientService,
        private readonly submitRecorder: DispatchSubmitRecorder
    ) {}

    public async send(msgId: string, record: constants.SimbankMessageResult): Promise<DispatchSendOutcome> {
        if (SETTLED_STATUSES.has(record.sendStatus)) return { skipped: true, sendStatus: record.sendStatus }
        const outcome = await this.callObserve(msgId, record)
        const saved = await this.submitRecorder.complete(record.keyId, outcome)
        return {
            skipped: false,
            saved,
            sendStatus: outcome.sendStatus,
            statusCode: outcome.statusCode,
            statusMessage: outcome.statusMessage
        }
    }

    private async callObserve(msgId: string, record: constants.SimbankMessageResult): Promise<constants.SimbankMessageOutcome> {
        let result: ObserveSubmitResult
        try {
            result = await this.observeClient.submit({
                msgId,
                msgKeyId: record.keyId,
                simbankKeyId: record.simbankKeyId,
                portKeyId: record.portKeyId
            })
        } catch (error) {
            return {
                sendStatus: SrmSchema.TbSrmSimbankMessageSendStatus.REJECTED,
                statusCode: constants.OBSERVE_UNAVAILABLE_CODE,
                statusMessage: `Observe 调用失败：${error instanceof Error ? error.message : String(error)}`,
                sendTime: new Date()
            }
        }
        return {
            sendStatus:
                result?.sendStatus === 'success'
                    ? SrmSchema.TbSrmSimbankMessageSendStatus.SUCCESS
                    : SrmSchema.TbSrmSimbankMessageSendStatus.FAILED,
            statusCode: String(result?.statusCode ?? 'UNKNOWN'),
            statusMessage: String(result?.statusMessage ?? ''),
            sendTime: this.parseTime(result?.sendTime)
        }
    }

    private parseTime(value: unknown): Date {
        const time = typeof value === 'string' ? new Date(value) : undefined
        return time && !Number.isNaN(time.getTime()) ? time : new Date()
    }
}
