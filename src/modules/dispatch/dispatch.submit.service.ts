import { Injectable } from '@nestjs/common'
import { type ChannelQueuePayload } from '@wlisfes/chat-web-base-schema/rabbitmq'
import { DataSource, InjectDataSource } from '@wlisfes/chat-web-base-schema/database'
import { DispatchSubmitCacheService, type SelectedSubmitSender } from '@/modules/dispatch/dispatch.submit.cache'
import * as SrmSchema from '@wlisfes/chat-web-base-schema/chat-web-srm-mysql'
import * as constants from '@/modules/dispatch/dispatch.constants'

/**
 * 从提交缓存选择端口，并按 msgId 幂等写入 SRM 设备短信记录。
 * Dispatch 只负责提交阶段：写入记录、端口忙换端口、提交失败写回；设备回执写回和供应商计费由 Hooks 处理。
 */
@Injectable()
export class DispatchSubmitRecorder {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly submitCache: DispatchSubmitCacheService
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
     * 端口发送队列已满时换端口：把发送记录的端口、设备、供应商和成本快照改为新端口。
     * 只更新仍处于 submitted 的记录，返回 false 表示记录状态已被其他流程推进。
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
     * 提交失败时写回结果。只更新仍处于 submitted 的记录，避免重投或乱序时覆盖已有结果。
     * 返回 false 表示记录状态已被其他流程推进，本次结果未写入。
     */
    public async complete(keyId: number, outcome: constants.SimbankMessageOutcome): Promise<boolean> {
        const result = await this.dataSource
            .createQueryBuilder()
            .update(SrmSchema.TbSrmSimbankMessage)
            .set({
                sendStatus: outcome.sendStatus,
                statusCode: outcome.statusCode.slice(0, 32),
                statusMessage: outcome.statusMessage.slice(0, constants.STATUS_MESSAGE_MAX_LENGTH),
                sendTime: outcome.sendTime
            })
            .where('keyId = :keyId AND sendStatus = :submitted', { keyId, submitted: SrmSchema.TbSrmSimbankMessageSendStatus.SUBMITTED })
            .updateEntity(false)
            .execute()
        return Boolean(result.affected)
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
        return record
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
