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

/** 通道事件。SRM 和 Dispatch 各声明一份，字段改动时要同步。 */
/** 全量通道快照。SRM 和 Dispatch 各声明一份，字段改动时要同步。 */
export interface SmsChannelSnapshotPayload {
    version: number
    channels: SmsChannelEventPayload[]
}

export interface SmsChannelEventPayload {
    channelKeyId: number
    alias: string
    /** 通道队列名称：chat.sms.channel.<通道别名>。 */
    queue: string
    type: string
    countryKeyId: number
    status: string
    sendInterval: number
    maxRetry: number
    /** true 表示通道已删除。 */
    deleted: boolean
    /** 发布时间毫秒数；只接受比副本更新的版本。 */
    version: number
}

/** 实例间通知。不携带通道全文，收到后按别名读取 Redis 副本。 */
export interface ChannelNotifyPayload {
    alias: string
    version: number
    deleted: boolean
}

/** 通道队列中的短信。SRM 和 Dispatch 各声明一份，字段改动时要同步。 */
export interface SmsChannelMessagePayload {
    messageId: string
    appKeyId: number
    type: string
    countryKeyId: number
    toNumber: string
    content: string
    submittedAt: string
    routeKeyId: number
    routeAlias: string
    channelKeyId: number
    channelAlias: string
    routedAt: string
}
