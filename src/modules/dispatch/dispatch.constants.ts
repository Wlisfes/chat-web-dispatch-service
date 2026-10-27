import type * as SrmSchema from '@wlisfes/chat-web-base-schema/chat-web-srm-mysql'
import { randomUUID } from 'node:crypto'

/** RabbitMQ 虚拟主机；SMS、SRM、Dispatch 的 Nacos `rabbitmq.vhost` 必须都是这个值。 */
export const SMS_RABBITMQ_VHOST = '/chat-sms'
/** 短信交换机，通道事件经它投递。 */
export const SMS_EXCHANGE = 'chat.sms.exchange'
/** 通道交换机：SRM 选路后按通道别名投递到通道队列。 */
export const SMS_CHANNEL_EXCHANGE = 'chat.sms.channel.exchange'
/** 通道事件队列：SRM 在通道增删改、启停后发布。竞争消费，只由一个 Dispatch 实例写入 Redis。 */
export const SMS_CHANNEL_EVENT_QUEUE = 'chat.sms.channel.event'
export const SMS_CHANNEL_EVENT_ROUTING_KEY = 'sms.channel.event'
/** 通道快照队列：只保留最新一份全量补发，队列长度限制为 1。 */
export const SMS_CHANNEL_SNAPSHOT_QUEUE = 'chat.sms.channel.snapshot'
export const SMS_CHANNEL_SNAPSHOT_ROUTING_KEY = 'sms.channel.snapshot'

/** Dispatch 自己的通道副本，Redis 哈希：field 为通道别名，value 为通道事件 JSON。不设过期时间。 */
export const DISPATCH_CHANNEL_SNAPSHOT_KEY = 'chat-web-dispatch:sms:channel'
/** 通道变更通知。Redis Pub/Sub 不按 index 隔离，频道名必须只给 Dispatch 使用。 */
export const DISPATCH_CHANNEL_NOTIFY_CHANNEL = 'chat-web-dispatch:sms:channel:notify'
/** 通知丢失或实例断线时，按 Redis 副本校正本地订阅的间隔。 */
export const DISPATCH_CHANNEL_RECONCILE_INTERVAL_MS = 15_000

/** SRM 提交配置变更广播。通道、端口、设备、供应商和报价变更后发布，每个 Dispatch 实例收到后重新加载提交缓存。 */
export const SMS_ROUTE_CONFIG_EXCHANGE = 'chat.sms.route.config.exchange'
/** 本实例接收提交配置变更的临时队列：独占、连接断开自动删除，重连时由拓扑重新声明。 */
export const DISPATCH_SUBMIT_CONFIG_QUEUE = `chat.sms.dispatch.submit.${randomUUID()}`
/** 变更消息丢失或实例断线时，按数据库签名校对提交缓存的间隔。 */
export const DISPATCH_SUBMIT_RECONCILE_INTERVAL_MS = 30_000

/** 实例间通知。不携带通道全文，收到后按别名读取 Redis 副本。 */
export interface ChannelNotifyPayload {
    alias: string
    version: number
    deleted: boolean
}

/** 提交缓存中的可用端口，以及写入发送记录需要的通道、设备和供应商快照。 */
export interface SimbankSender {
    channelKeyId: number
    channelAlias: string
    channelOwnerUserUid: string
    portKeyId: number
    port: number
    sim: string | null
    iccid: string | null
    simbankKeyId: number
    simbankName: string
    simbankAlias: string | null
    userKeyId: number
    userName: string
    userAlias: string | null
    ownerUserUid: string
    weight: number
}

/** 提交缓存中的报价时间段：按发送当时的时间挑选生效报价。 */
export interface SimbankQuoteCandidate {
    downUsd: number
    effectiveTime: number
    expiryTime: number | null
}

/** 发送记录写入或复用后的定位信息。 */
export interface SimbankMessageResult {
    keyId: number
    portKeyId: number
    simbankKeyId: number
    /** 当前发送状态：新写入为 submitted；重投时为已有记录的状态。 */
    sendStatus: SrmSchema.TbSrmSimbankMessageSendStatus
}

/** Observe 不可用（连接失败、超时）时写入发送记录的状态码。 */
export const OBSERVE_UNAVAILABLE_CODE = 'OBSERVE_UNAVAILABLE'
/** 发送记录状态说明字段长度上限：tb_srm_simbank_message.status_message varchar(512)。 */
export const STATUS_MESSAGE_MAX_LENGTH = 512

/** 写回发送记录的发送结果。 */
export interface SimbankMessageOutcome {
    sendStatus: SrmSchema.TbSrmSimbankMessageSendStatus
    statusCode: string
    statusMessage: string
    sendTime: Date
}
