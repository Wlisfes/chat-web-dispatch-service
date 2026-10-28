import { Injectable, Logger } from '@nestjs/common'
import { type ChannelQueuePayload } from '@wlisfes/chat-web-base-schema/rabbitmq'
import { OBSERVE_SUBMIT_CODE, type ObserveQueryResult, type ObserveSubmitResult } from '@wlisfes/chat-web-base-schema/observe'
import { ObserveClientService } from '@/modules/observe/observe.client'
import { DispatchSubmitCacheService } from '@/modules/dispatch/dispatch.submit.cache'
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

/** 本次提交的处理结果，用于日志。 */
export interface DispatchSendOutcome {
    /** true 表示已有最终结果，本次跳过发送。 */
    skipped: boolean
    /** true 表示设备已受理，发送记录保持 submitted，等待设备回执写回结果。 */
    pending?: boolean
    sendStatus: SrmSchema.TbSrmSimbankMessageSendStatus
    statusCode?: string
    statusMessage?: string
    /** false 表示结果未写入：记录状态已被其他流程推进。 */
    saved?: boolean
    /** true 表示重投时设备已收到过这条短信，本次没有重新提交。 */
    recovered?: boolean
    /** 最终提交的端口；端口忙换端口后与发送记录写入时不同。 */
    portKeyId?: number
}

/** Observe 设备结果转为发送记录结果。 */
export function toSimbankOutcome(result: ObserveSubmitResult, accepted: boolean): constants.SimbankMessageOutcome {
    return {
        sendStatus:
            result.sendStatus === 'success'
                ? SrmSchema.TbSrmSimbankMessageSendStatus.SUCCESS
                : SrmSchema.TbSrmSimbankMessageSendStatus.FAILED,
        statusCode: String(result.statusCode ?? 'UNKNOWN'),
        statusMessage: String(result.statusMessage ?? ''),
        sendTime: parseTime(result.sendTime),
        accepted
    }
}

export function parseTime(value: unknown): Date {
    const time = typeof value === 'string' ? new Date(value) : undefined
    return time && !Number.isNaN(time.getTime()) ? time : new Date()
}

/**
 * 发送记录写入后异步提交给 Observe：Observe 受理（进入端口发送队列）后立即返回，Dispatch 确认 MQ 消息，
 * 发送结果由 Observe → Hooks → 回执队列送达，DispatchReceiptService 写回；回执丢失由 DispatchReceiptChecker 超时查询补偿。
 *
 * - 端口发送队列已满（PORT_BUSY）：换通道内其他端口提交；全部忙时等待后重试，超过最长等待记为提交失败；
 * - 发送条件不满足：设备拒绝，写回 failed；
 * - Observe 不可用：记为提交失败（rejected），不重新入队，避免同一条短信反复占用端口；
 * - 重投且记录仍为 submitted：先按短信ID查询设备侧状态，设备收到过就不再提交；查询失败时不提交，宁可少发也不重复发。
 */
@Injectable()
export class DispatchSendService {
    private readonly logger = new Logger(DispatchSendService.name)
    /** 端口忙时的等待间隔和最长等待；测试时可替换。 */
    public busyRetryMs = constants.DISPATCH_PORT_BUSY_RETRY_MS
    public busyMaxWaitMs = constants.DISPATCH_PORT_BUSY_MAX_WAIT_MS

    constructor(
        private readonly observeClient: ObserveClientService,
        private readonly submitRecorder: DispatchSubmitRecorder,
        private readonly submitCache: DispatchSubmitCacheService
    ) {}

    public async send(payload: ChannelQueuePayload, record: constants.SimbankMessageResult): Promise<DispatchSendOutcome> {
        const msgId = payload.message.msgId
        if (SETTLED_STATUSES.has(record.sendStatus)) return { skipped: true, sendStatus: record.sendStatus }
        if (record.redelivered) {
            const recovered = await this.recover(msgId, record)
            if (recovered) return recovered
        }
        return await this.enqueue(payload, record)
    }

    /**
     * 重投时查询设备侧状态。设备没有收到过返回 undefined，由调用方重新提交；
     * 排队或发送中保持 submitted 等待回执；已有结果直接写回；查询失败记为提交失败，不重新提交。
     */
    private async recover(msgId: string, record: constants.SimbankMessageResult): Promise<DispatchSendOutcome | undefined> {
        let queried: ObserveQueryResult
        try {
            queried = await this.observeClient.query({ msgId })
        } catch (error) {
            return await this.finish(record, {
                sendStatus: SrmSchema.TbSrmSimbankMessageSendStatus.REJECTED,
                statusCode: constants.OBSERVE_UNAVAILABLE_CODE,
                statusMessage: `Observe 发送状态查询失败，未重新发送：${errorMessage(error)}`,
                sendTime: new Date()
            })
        }
        if (!queried?.found) return undefined
        if (queried.result)
            return { ...(await this.finish(record, toSimbankOutcome(queried.result, queried.accepted === true))), recovered: true }
        await this.acceptBilling(record.keyId)
        return {
            skipped: false,
            pending: true,
            recovered: true,
            sendStatus: SrmSchema.TbSrmSimbankMessageSendStatus.SUBMITTED,
            statusCode: OBSERVE_SUBMIT_CODE.QUEUED,
            portKeyId: record.portKeyId
        }
    }

    /** 提交到端口发送队列；端口忙时换端口，全部忙时等待重试。 */
    private async enqueue(payload: ChannelQueuePayload, record: constants.SimbankMessageResult): Promise<DispatchSendOutcome> {
        const { message, route } = payload
        const startedAt = Date.now()
        const busy = new Set<number>()
        let current = { portKeyId: record.portKeyId, simbankKeyId: record.simbankKeyId }
        for (;;) {
            let admission
            try {
                admission = await this.observeClient.enqueue({
                    msgId: message.msgId,
                    msgKeyId: record.keyId,
                    simbankKeyId: current.simbankKeyId,
                    portKeyId: current.portKeyId,
                    sendInterval: this.submitCache.sendInterval(route.channelKeyId)
                })
            } catch (error) {
                return await this.finish(record, {
                    sendStatus: SrmSchema.TbSrmSimbankMessageSendStatus.REJECTED,
                    statusCode: constants.OBSERVE_UNAVAILABLE_CODE,
                    statusMessage: `通道发送失败：${errorMessage(error)}`,
                    sendTime: new Date()
                })
            }
            if (admission.accepted) {
                await this.acceptBilling(record.keyId)
                return {
                    skipped: false,
                    pending: true,
                    sendStatus: SrmSchema.TbSrmSimbankMessageSendStatus.SUBMITTED,
                    statusCode: String(admission.statusCode),
                    statusMessage: String(admission.statusMessage ?? ''),
                    portKeyId: current.portKeyId
                }
            }
            if (admission.statusCode !== OBSERVE_SUBMIT_CODE.PORT_BUSY) {
                return await this.finish(record, {
                    sendStatus: SrmSchema.TbSrmSimbankMessageSendStatus.FAILED,
                    statusCode: String(admission.statusCode ?? 'UNKNOWN'),
                    statusMessage: String(admission.statusMessage ?? ''),
                    sendTime: parseTime(admission.time)
                })
            }
            // 端口忙：换一个没忙过的端口；都忙过时等待后从头再选，超过最长等待记为提交失败。
            busy.add(current.portKeyId)
            let selected = this.submitCache.selectExcept(payload, busy)
            if (!selected) {
                if (Date.now() - startedAt >= this.busyMaxWaitMs) {
                    return await this.finish(record, {
                        sendStatus: SrmSchema.TbSrmSimbankMessageSendStatus.REJECTED,
                        statusCode: constants.PORT_BUSY_CODE,
                        statusMessage: `通道所有端口发送队列已满，等待 ${this.busyMaxWaitMs}ms 后仍无法提交`,
                        sendTime: new Date()
                    })
                }
                await new Promise(resolve => setTimeout(resolve, this.busyRetryMs))
                busy.clear()
                selected = this.submitCache.selectExcept(payload, busy)
            }
            if (!selected) {
                return await this.finish(record, {
                    sendStatus: SrmSchema.TbSrmSimbankMessageSendStatus.REJECTED,
                    statusCode: constants.NO_AVAILABLE_PORT_CODE,
                    statusMessage: `通道没有可用 SIM 端口：channelKeyId=${route.channelKeyId}`,
                    sendTime: new Date()
                })
            }
            if (selected.sender.portKeyId !== current.portKeyId) {
                const moved = await this.submitRecorder.reassign(record.keyId, payload, selected)
                if (!moved) return { skipped: false, saved: false, sendStatus: record.sendStatus, portKeyId: current.portKeyId }
                current = { portKeyId: selected.sender.portKeyId, simbankKeyId: selected.sender.simbankKeyId }
            }
        }
    }

    /**
     * 设备已受理：写入预付计费事件。写入失败不影响确认 MQ 消息（设备已在发送），
     * 回执或超时检查写回结果时会在同一事务中再次幂等写入。
     */
    private async acceptBilling(keyId: number): Promise<void> {
        await this.submitRecorder
            .accept(keyId)
            .catch(error => this.logger.warn(`预付计费事件写入失败，写回结果时补写：msgKeyId=${keyId}，原因=${errorMessage(error)}`))
    }

    private async finish(record: constants.SimbankMessageResult, outcome: constants.SimbankMessageOutcome): Promise<DispatchSendOutcome> {
        const saved = await this.submitRecorder.complete(record.keyId, outcome)
        return {
            skipped: false,
            saved,
            sendStatus: outcome.sendStatus,
            statusCode: outcome.statusCode,
            statusMessage: outcome.statusMessage
        }
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
