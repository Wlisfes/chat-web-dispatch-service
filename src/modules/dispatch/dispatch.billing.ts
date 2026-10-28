import { type SrmUserBillingPayload } from '@wlisfes/chat-web-base-schema/rabbitmq'
import * as SrmSchema from '@wlisfes/chat-web-base-schema/chat-web-srm-mysql'

/** 发送记录中计费需要的快照字段。 */
export type BillingRecord = Pick<
    SrmSchema.TbSrmSimbankMessage,
    'keyId' | 'msgId' | 'userKeyId' | 'simbankKeyId' | 'portKeyId' | 'payMode' | 'segments' | 'cost'
>

/**
 * 供应商计费触发规则：预付供应商在短信提交到设备时计费，后付供应商在设备发送成功时计费。
 * 返回本节点是否需要为这条记录计费；付款模式缺失（历史记录）时不计费。
 */
export function billingTriggerOf(
    payMode: SrmSchema.TbSrmUserPayMode | null | undefined,
    status: SrmSchema.TbSrmSimbankMessageSendStatus
): SrmSchema.TbSrmBillingOutboxTrigger | undefined {
    if (payMode === SrmSchema.TbSrmUserPayMode.PREPAID && status === SrmSchema.TbSrmSimbankMessageSendStatus.SUBMITTED) {
        return SrmSchema.TbSrmBillingOutboxTrigger.SUBMITTED
    }
    if (payMode === SrmSchema.TbSrmUserPayMode.POSTPAID && status === SrmSchema.TbSrmSimbankMessageSendStatus.SUCCESS) {
        return SrmSchema.TbSrmBillingOutboxTrigger.SUCCESS
    }
    return undefined
}

/** 按发送记录快照生成计费事件；不满足计费条件时返回 undefined。 */
export function createSrmUserBilling(
    record: BillingRecord,
    status: SrmSchema.TbSrmSimbankMessageSendStatus,
    occurredTime: Date
): SrmUserBillingPayload | undefined {
    const trigger = billingTriggerOf(record.payMode, status)
    if (!trigger || !record.msgId) return undefined
    return {
        eventId: `${record.msgId}:${trigger}`,
        msgId: record.msgId,
        msgKeyId: record.keyId,
        userKeyId: record.userKeyId,
        simbankKeyId: record.simbankKeyId,
        portKeyId: record.portKeyId,
        payMode: record.payMode,
        trigger,
        segments: record.segments,
        costUsd: Number(record.cost) || 0,
        occurredTime: occurredTime.toISOString()
    }
}

/** 计费事件转为发件箱记录。 */
export function toOutboxRow(billing: SrmUserBillingPayload): Partial<SrmSchema.TbSrmBillingOutbox> {
    return {
        eventId: billing.eventId,
        msgId: billing.msgId,
        trigger: billing.trigger as SrmSchema.TbSrmBillingOutboxTrigger,
        payload: JSON.stringify(billing),
        status: SrmSchema.TbSrmBillingOutboxStatus.PENDING,
        attempts: 0
    }
}
