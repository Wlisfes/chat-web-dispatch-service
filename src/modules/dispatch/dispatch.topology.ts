import type { ConfirmChannel } from 'amqplib'
import * as constants from '@/modules/dispatch/dispatch.constants'

/**
 * 声明 Dispatch 用到的固定拓扑，每次（重新）连接都会执行，声明是幂等的。
 * 通道快照队列只保留最新一份，参数必须与 SRM 声明的完全一致。
 */
export async function setupDispatchTopology(channel: ConfirmChannel): Promise<void> {
    await channel.assertExchange(constants.SMS_EXCHANGE, 'direct', { durable: true })
    await channel.assertExchange(constants.SMS_CHANNEL_EXCHANGE, 'direct', { durable: true })
    await channel.assertQueue(constants.SMS_CHANNEL_EVENT_QUEUE, { durable: true })
    await channel.bindQueue(constants.SMS_CHANNEL_EVENT_QUEUE, constants.SMS_EXCHANGE, constants.SMS_CHANNEL_EVENT_ROUTING_KEY)
    await channel.assertQueue(constants.SMS_CHANNEL_SNAPSHOT_QUEUE, {
        durable: true,
        maxLength: 1,
        overflow: 'drop-head'
    })
    await channel.bindQueue(constants.SMS_CHANNEL_SNAPSHOT_QUEUE, constants.SMS_EXCHANGE, constants.SMS_CHANNEL_SNAPSHOT_ROUTING_KEY)
    await channel.assertExchange(constants.SMS_ROUTE_CONFIG_EXCHANGE, 'fanout', { durable: true })
    await channel.assertQueue(constants.DISPATCH_SUBMIT_CONFIG_QUEUE, { durable: false, exclusive: true, autoDelete: true })
    await channel.bindQueue(constants.DISPATCH_SUBMIT_CONFIG_QUEUE, constants.SMS_ROUTE_CONFIG_EXCHANGE, '')
}
