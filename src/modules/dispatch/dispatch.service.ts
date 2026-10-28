import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'
import { RabbitmqService, ChannelEventPayload, ChannelQueuePayload, ChannelSnapshotPayload } from '@wlisfes/chat-web-base-schema/rabbitmq'
import { RedisService } from '@wlisfes/chat-web-base-schema/redis'
import { isStale, localActions, parseChannel, planReconcile } from '@/modules/dispatch/dispatch.control'
import { DispatchSubmitCacheService } from '@/modules/dispatch/dispatch.submit.cache'
import { DispatchSubmitRecorder } from '@/modules/dispatch/dispatch.submit.service'
import { DispatchSendService } from '@/modules/dispatch/dispatch.send.service'
import { DispatchChannelNotifier } from '@/modules/dispatch/dispatch.notifier'
import * as constants from '@/modules/dispatch/dispatch.constants'

/**
 * 通道队列消费。
 *
 * - 通道名单存放在 Dispatch 自己的 Redis（db 5）。SRM 的事件队列是竞争消费，只有一个实例负责写入；
 * - 写入后向 Redis Pub/Sub 发通知，每个实例只改自己的订阅，不再写 Redis；
 * - 通知丢失时按 Redis 副本对账。启用的通道订阅，停用或删除的通道取消订阅，队列和积压消息保留；
 * - 短信队列仍是竞争消费，一条短信只由一个实例处理。选端口写入 SRM 设备短信记录后，通过 Observe 模拟设备发送并写回结果。
 */
@Injectable()
export class DispatchService implements OnApplicationBootstrap, OnApplicationShutdown {
    private readonly logger = new Logger(DispatchService.name)
    /** 内存中的通道副本。订阅状态以它为准，Redis 是跨实例的来源。 */
    private readonly channels = new Map<string, ChannelEventPayload>()
    private mutation: Promise<void> = Promise.resolve()
    private reconcileTimer?: NodeJS.Timeout
    private reconciling = false

    constructor(
        private readonly rabbitmqService: RabbitmqService,
        private readonly redisService: RedisService,
        private readonly notifier: DispatchChannelNotifier,
        private readonly submitRecorder: DispatchSubmitRecorder,
        private readonly submitCache: DispatchSubmitCacheService,
        private readonly sendService: DispatchSendService
    ) {}

    public async onApplicationBootstrap(): Promise<void> {
        // 提交缓存加载完成后再恢复通道订阅，避免启动瞬间消费短信时没有可用端口快照。
        await this.submitCache.ready()
        await this.exclusive(async () => {
            await this.restoreFromRedis()
        })
        await this.notifier.start(notify => this.onNotify(notify))
        await this.reconcile()
        this.reconcileTimer = setInterval(() => void this.reconcile(), constants.DISPATCH_CHANNEL_RECONCILE_INTERVAL_MS)
        await this.rabbitmqService.consume<ChannelSnapshotPayload>(constants.SMS_CHANNEL_SNAPSHOT_QUEUE, async snapshot => {
            await this.applySnapshot(snapshot)
            return 'ack'
        })
        await this.rabbitmqService.consume<ChannelEventPayload>(constants.SMS_CHANNEL_EVENT_QUEUE, async event => {
            await this.accept(event)
            return 'ack'
        })
    }

    public async onApplicationShutdown(): Promise<void> {
        if (this.reconcileTimer) clearInterval(this.reconcileTimer)
        this.reconcileTimer = undefined
    }

    /** 快照是全量名单。不在快照里的通道视为已删除。比本地更新的快照才应用，避免旧快照覆盖新事件。 */
    private async applySnapshot(snapshot: ChannelSnapshotPayload): Promise<void> {
        const stored: constants.ChannelNotifyPayload[] = []
        await this.exclusive(async () => {
            const remote = await this.redisService.hGetAll(constants.DISPATCH_CHANNEL_SNAPSHOT_KEY)
            const newest = Math.max(0, ...this.versions(this.channels.values()), ...this.versions(Object.values(remote).map(parseChannel)))
            if (snapshot.version <= newest) return
            const aliases = new Set(snapshot.channels.map(channel => channel.alias))
            for (const channel of snapshot.channels) {
                const notify = await this.persist({ ...channel, deleted: false, version: snapshot.version })
                if (notify) stored.push(notify)
            }
            for (const alias of [...this.channels.keys()]) {
                if (aliases.has(alias)) continue
                const current = this.channels.get(alias)
                if (!current) continue
                const notify = await this.persist({ ...current, deleted: true, version: snapshot.version })
                if (notify) stored.push(notify)
            }
            this.logger.log(`已应用通道快照：${snapshot.channels.length} 条`)
        })
        await this.publishAll(stored)
    }

    /** 处理 SRM 通道事件：旧版本直接丢弃；新版本先写 Redis，再通知其他实例。 */
    private async accept(event: ChannelEventPayload): Promise<void> {
        const notify = await this.exclusive(() => this.persist(event))
        if (notify) await this.publishAll([notify])
    }

    /** 其他实例收到通知后只改本地订阅。Redis 已由写事件的实例更新。 */
    private async onNotify(notify: constants.ChannelNotifyPayload): Promise<void> {
        await this.exclusive(async () => {
            const snapshot = await this.redisService.hGetAll(constants.DISPATCH_CHANNEL_SNAPSHOT_KEY)
            const raw = snapshot[notify.alias]
            const channel = raw ? parseChannel(raw) : undefined
            if (notify.deleted) {
                if (channel && channel.version >= notify.version) {
                    await this.adopt(channel)
                    return
                }
                const current = this.channels.get(notify.alias)
                if (!current || isStale(current, notify.version)) return
                await this.adopt({ ...current, deleted: true, version: notify.version })
                return
            }
            if (!channel || channel.version < notify.version) return
            await this.adopt(channel)
        })
    }

    /** 通知可能丢失。按 Redis 副本把缺失的订阅补上，把已经删除的订阅取消。 */
    private async reconcile(): Promise<void> {
        if (this.reconciling) return
        this.reconciling = true
        try {
            await this.exclusive(async () => {
                const remote = await this.redisService.hGetAll(constants.DISPATCH_CHANNEL_SNAPSHOT_KEY)
                for (const action of localActions(planReconcile(this.channels, remote))) {
                    if (action.type === 'drop') await this.drop(action.channel)
                    else if (action.type === 'adopt') await this.adopt(action.channel)
                    else {
                        this.channels.set(action.channel.alias, action.channel)
                        await this.sync(action.channel)
                    }
                }
            })
        } catch (error) {
            this.logger.error(`通道订阅对账失败：${error instanceof Error ? error.message : String(error)}`)
        } finally {
            this.reconciling = false
        }
    }

    private async restoreFromRedis(): Promise<void> {
        const snapshot = await this.redisService.hGetAll(constants.DISPATCH_CHANNEL_SNAPSHOT_KEY)
        for (const value of Object.values(snapshot)) {
            const channel = parseChannel(value)
            if (!channel) continue
            await this.adopt(channel)
        }
        this.logger.log(`已从副本恢复通道：${this.channels.size} 条`)
    }

    private versions(channels: Iterable<ChannelEventPayload | undefined>): number[] {
        return [...channels].flatMap(channel => (channel ? [channel.version] : []))
    }

    /** 把变更写入 Redis 并更新本进程。返回需要广播的通知；旧版本返回 undefined。 */
    private async persist(event: ChannelEventPayload): Promise<constants.ChannelNotifyPayload | undefined> {
        if (isStale(this.channels.get(event.alias), event.version)) return undefined
        if (event.deleted) await this.redisService.hDel(constants.DISPATCH_CHANNEL_SNAPSHOT_KEY, event.alias)
        else await this.redisService.hSet(constants.DISPATCH_CHANNEL_SNAPSHOT_KEY, event.alias, JSON.stringify(event))
        await this.adopt(event)
        this.logger.log(`通道已更新：alias=${event.alias}，status=${event.deleted ? 'deleted' : event.status}`)
        return { alias: event.alias, version: event.version, deleted: event.deleted }
    }

    /** Redis 中已经没有的通道直接取消订阅，不受版本相同即视为旧事件的限制。 */
    private async drop(channel: ChannelEventPayload): Promise<void> {
        this.channels.delete(channel.alias)
        await this.sync({ ...channel, deleted: true })
    }

    /** 按版本更新内存副本，并让本进程的订阅与通道状态一致。不写 Redis。 */
    private async adopt(event: ChannelEventPayload): Promise<void> {
        const current = this.channels.get(event.alias)
        if (current && isStale(current, event.version)) {
            await this.sync(current)
            return
        }
        if (event.deleted) this.channels.delete(event.alias)
        else this.channels.set(event.alias, event)
        await this.sync(event)
    }

    /** 让订阅状态与通道一致：启用且未删除才订阅。 */
    private async sync(channel: ChannelEventPayload): Promise<void> {
        const active = !channel.deleted && channel.status === 'enable'
        const consuming = this.rabbitmqService.isConsuming(channel.queue)
        if (active && !consuming) {
            await this.rabbitmqService.assertQueue(channel.queue, { durable: true })
            await this.rabbitmqService.bindQueue(channel.queue, constants.SMS_CHANNEL_EXCHANGE, channel.alias)
            await this.rabbitmqService.consume<ChannelQueuePayload>(channel.queue, async payload => {
                return this.fetchSender(payload)
            })
        } else if (!active && consuming) {
            await this.rabbitmqService.cancel(channel.queue)
        }
    }

    private async publishAll(notifications: constants.ChannelNotifyPayload[]): Promise<void> {
        for (const notify of notifications) {
            try {
                await this.notifier.publish(notify)
            } catch (error) {
                this.logger.error(
                    `通道变更通知发布失败：alias=${notify.alias}，原因=${error instanceof Error ? error.message : String(error)}`
                )
            }
        }
    }

    /** 串行化本进程的副本更新，避免对账和通知互相覆盖。发布通知必须放在锁外。 */
    private async exclusive<T>(work: () => Promise<T>): Promise<T> {
        const previous = this.mutation
        let release: () => void = () => undefined
        this.mutation = new Promise(resolve => {
            release = resolve
        })
        await previous
        try {
            return await work()
        } finally {
            release()
        }
    }

    /**
     * 发送短信：按 msgId 幂等写入发送记录，再异步提交 Observe 端口发送队列，受理后确认 MQ 消息。
     * 发送结果由设备回执写回。入库失败时抛错，由 MQ 拒绝并进入死信；提交失败只写入发送记录，不重新入队。
     */
    private async fetchSender(payload: ChannelQueuePayload): Promise<'ack'> {
        const { message, route } = payload
        const startedAt = performance.now()
        const record = await this.submitRecorder.submit(payload)
        const outcome = await this.sendService.send(payload, record)
        const portKeyId = outcome.portKeyId ?? record.portKeyId
        const moved = portKeyId !== record.portKeyId ? `（端口忙，已从 ${record.portKeyId} 换到 ${portKeyId}）` : ''
        const summary = `msgId=${message.msgId}，msgKeyId=${record.keyId}，channel=${route.channelAlias}，portKeyId=${portKeyId}${moved}，toNumber=${message.toNumber}`
        const elapsed = `耗时=${Math.round(performance.now() - startedAt)}ms`
        if (outcome.skipped) {
            this.logger.log(`短信已有发送结果，跳过重复发送：${summary}，sendStatus=${outcome.sendStatus}，${elapsed}`)
        } else if (outcome.pending) {
            this.logger.log(`短信已提交设备，等待回执：${summary}，statusCode=${outcome.statusCode}，${elapsed}`)
        } else {
            this.logger.warn(
                `短信提交失败：${summary}，sendStatus=${outcome.sendStatus}，statusCode=${outcome.statusCode}，原因=${outcome.statusMessage}，${elapsed}`
            )
        }
        if (outcome.saved === false) {
            this.logger.warn(`提交结果未写入，记录状态已变更：msgId=${message.msgId}，msgKeyId=${record.keyId}`)
        }
        return 'ack'
    }
}
