import { Injectable } from '@nestjs/common'
import { type ChannelQueuePayload } from '@wlisfes/chat-web-base-schema/rabbitmq'
import { DataSource, InjectDataSource } from '@wlisfes/chat-web-base-schema/database'
import { DispatchSubmitCacheService, type SelectedSubmitSender } from '@/modules/dispatch/dispatch.submit.cache'
import { DispatchBillingOutbox } from '@/modules/dispatch/dispatch.billing.outbox'
import { createSrmUserBilling } from '@/modules/dispatch/dispatch.billing'
import * as SrmSchema from '@wlisfes/chat-web-base-schema/chat-web-srm-mysql'
import * as constants from '@/modules/dispatch/dispatch.constants'

/** 生成计费事件需要的发送记录快照字段。 */
const BILLING_SELECT = {
    keyId: true,
    msgId: true,
    userKeyId: true,
    simbankKeyId: true,
    portKeyId: true,
    payMode: true,
    segments: true,
    cost: true
} as const

/**
 * 从提交缓存选择端口，并按 msgId 幂等写入 SRM 设备短信记录；只有 Dispatch 写发送记录。
 *
 * 供应商计费事件和发送记录状态在同一事务中写入，提交后由发件箱发布：
 * - 预付：设备受理（进入端口发送队列）时计费，设备拒绝或 Observe 不可用时不计费；
 * - 后付：设备发送成功写回 success 时计费。
 */
@Injectable()
export class DispatchSubmitRecorder {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly submitCache: DispatchSubmitCacheService,
        private readonly billingOutbox: DispatchBillingOutbox
    ) {}

    /** 正常路径只执行一次 INSERT；同一条短信重投时才回查已有记录。 */
    public async submit(payload: ChannelQueuePayload): Promise<constants.SimbankMessageResult> {
        const { sender, downUsd } = this.submitCache.select(payload)
        const record = this.createRecord(payload, sender, downUsd)
        const result = await this.dataSource
            .createQueryBuilder()
            .insert()
            .into(SrmSchema.TbSrmSimbankMessage)
            .values(record)
            .orIgnore()
            .updateEntity(false)
            .execute()
        const keyId = this.insertedKeyId(result)
        if (keyId) {
            return {
                keyId,
                portKeyId: sender.portKeyId,
                simbankKeyId: sender.simbankKeyId,
                sendStatus: SrmSchema.TbSrmSimbankMessageSendStatus.SUBMITTED
            }
        }
        return await this.findExistingRecord(payload.message.msgId)
    }

    /**
     * 设备已受理：预付供应商写入计费事件。按 eventId 幂等，重投、回执、超时检查重复调用只计费一次。
     * 后付供应商在写回 success 时计费，这里不处理。
     */
    public async accept(keyId: number): Promise<void> {
        const snapshot = await this.dataSource
            .getRepository(SrmSchema.TbSrmSimbankMessage)
            .findOne({ where: { keyId }, select: BILLING_SELECT })
        const billing = snapshot ? createSrmUserBilling(snapshot, SrmSchema.TbSrmSimbankMessageSendStatus.SUBMITTED, new Date()) : undefined
        if (!billing) return
        await this.billingOutbox.add(this.dataSource.manager, billing)
        void this.billingOutbox.flush()
    }

    /**
     * 端口发送队列已满时换端口：把发送记录的端口、设备、供应商和成本快照改为新端口。
     * 只更新仍处于 submitted 的记录；设备受理前还没有计费，换端口不影响计费。返回 false 表示记录状态已被其他流程推进。
     */
    public async reassign(keyId: number, payload: ChannelQueuePayload, selected: SelectedSubmitSender): Promise<boolean> {
        const segments = this.positiveInteger(payload.message.segments, 1)
        const result = await this.dataSource
            .createQueryBuilder()
            .update(SrmSchema.TbSrmSimbankMessage)
            .set(this.senderFields(selected.sender, selected.downUsd, segments))
            .where('keyId = :keyId AND sendStatus = :submitted', {
                keyId,
                submitted: SrmSchema.TbSrmSimbankMessageSendStatus.SUBMITTED
            })
            .updateEntity(false)
            .execute()
        return Boolean(result.affected)
    }

    /**
     * 写回发送结果。只更新仍处于 submitted 的记录，避免重投、重复回执或乱序时覆盖已有结果。
     * 传入 msgId 时同时校验短信ID，防止回执中的发送记录主键错误时写错记录。
     * 返回 false 表示记录状态已被其他流程推进，本次结果未写入。
     */
    public async complete(keyId: number, outcome: constants.SimbankMessageOutcome, msgId?: string): Promise<boolean> {
        const saved = await this.dataSource.transaction(async manager => {
            const where = msgId
                ? 'keyId = :keyId AND sendStatus = :submitted AND msgId = :msgId'
                : 'keyId = :keyId AND sendStatus = :submitted'
            const result = await manager
                .createQueryBuilder()
                .update(SrmSchema.TbSrmSimbankMessage)
                .set({
                    sendStatus: outcome.sendStatus,
                    statusCode: outcome.statusCode.slice(0, 32),
                    statusMessage: outcome.statusMessage.slice(0, constants.STATUS_MESSAGE_MAX_LENGTH),
                    sendTime: outcome.sendTime
                })
                .where(where, { keyId, msgId, submitted: SrmSchema.TbSrmSimbankMessageSendStatus.SUBMITTED })
                .updateEntity(false)
                .execute()
            if (!result.affected) return false
            const success = outcome.sendStatus === SrmSchema.TbSrmSimbankMessageSendStatus.SUCCESS
            if (!outcome.accepted && !success) return true
            // 结果写回和计费事件在同一事务中写入：设备受理过补写预付计费（幂等），本次真正推进到 success 时写后付计费。
            const snapshot = await manager
                .getRepository(SrmSchema.TbSrmSimbankMessage)
                .findOne({ where: { keyId }, select: BILLING_SELECT })
            if (!snapshot) return true
            if (outcome.accepted) {
                await this.billingOutbox.add(
                    manager,
                    createSrmUserBilling(snapshot, SrmSchema.TbSrmSimbankMessageSendStatus.SUBMITTED, outcome.sendTime)
                )
            }
            if (success) await this.billingOutbox.add(manager, createSrmUserBilling(snapshot, outcome.sendStatus, outcome.sendTime))
            return true
        })
        if (saved) void this.billingOutbox.flush()
        return saved
    }

    private createRecord(
        { message, route }: ChannelQueuePayload,
        sender: constants.SimbankSender,
        downUsd: number
    ): Partial<SrmSchema.TbSrmSimbankMessage> {
        const segments = this.positiveInteger(message.segments, 1)
        return {
            msgId: message.msgId,
            source: SrmSchema.TbSrmSimbankMessageSource.DOWN,
            type: message.type as SrmSchema.TbSrmSimbankMessageType,
            toNumber: message.toNumber,
            content: message.content,
            encoding: message.encoding as SrmSchema.TbSrmSimbankMessageEncoding,
            contentLength: message.contentLength,
            segments,
            countryKeyId: Number(message.countryKeyId),
            mcc: message.mcc,
            sendStatus: SrmSchema.TbSrmSimbankMessageSendStatus.SUBMITTED,
            sendTime: new Date(),
            routeKeyId: route.routeKeyId,
            routeAlias: route.routeAlias,
            channelKeyId: sender.channelKeyId,
            channelAlias: sender.channelAlias,
            channelOwnerUserUid: sender.channelOwnerUserUid,
            ...this.senderFields(sender, downUsd, segments),
            price: this.nonNegativeNumber(message.price)
        }
    }

    /** 发送记录中随端口变化的快照：端口、设备、供应商和成本。 */
    private senderFields(sender: constants.SimbankSender, downUsd: number, segments: number): Partial<SrmSchema.TbSrmSimbankMessage> {
        return {
            fromNumber: sender.sim || String(sender.port),
            simbankKeyId: sender.simbankKeyId,
            simbankName: sender.simbankName,
            simbankAlias: sender.simbankAlias,
            userKeyId: sender.userKeyId,
            userName: sender.userName,
            userAlias: sender.userAlias,
            ownerUserUid: sender.ownerUserUid,
            payMode: sender.payMode,
            portKeyId: sender.portKeyId,
            port: sender.port,
            sim: sender.sim,
            iccid: sender.iccid,
            cost: this.nonNegativeNumber(downUsd) * segments
        }
    }

    private insertedKeyId(result: { raw?: unknown }): number | undefined {
        const raw = result.raw as { affectedRows?: number; insertId?: number } | undefined
        if (!raw?.affectedRows) return undefined
        const keyId = Number(raw.insertId)
        return Number.isInteger(keyId) && keyId > 0 ? keyId : undefined
    }

    private async findExistingRecord(msgId: string): Promise<constants.SimbankMessageResult> {
        const record = await this.dataSource.getRepository(SrmSchema.TbSrmSimbankMessage).findOne({
            where: { msgId },
            select: { keyId: true, portKeyId: true, simbankKeyId: true, sendStatus: true }
        })
        if (!record) {
            throw new Error(`发送记录写入后未找到：msgId=${msgId}`)
        }
        return { ...record, redelivered: true }
    }

    private positiveInteger(value: unknown, fallback: number): number {
        const number = Number(value)
        return Number.isInteger(number) && number > 0 ? number : fallback
    }

    private nonNegativeNumber(value: unknown): number {
        const number = Number(value ?? 0)
        return Number.isFinite(number) && number > 0 ? number : 0
    }
}
