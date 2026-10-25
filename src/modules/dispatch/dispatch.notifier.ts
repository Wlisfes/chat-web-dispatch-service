import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createClient, RedisClientType } from 'redis'
import { parseNotify } from '@/modules/dispatch/dispatch.control'
import * as constants from '@/modules/dispatch/dispatch.constants'

/** 用 Nacos 的 redis 节点拼连接地址。Pub/Sub 本身不区分 database，地址仍与命令连接保持一致。 */
export function redisConnectionUrl(config: unknown): string {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('缺少 Nacos Redis 配置节点：redis')
    const record = config as Record<string, unknown>
    const host = requiredString('Redis 配置 host', record.host)
    const port = requiredInteger('Redis 配置 port', record.port, 1, 65_535)
    const database = requiredInteger('Redis 配置 database', record.database, 0, 15)
    const username = optionalString(record.username)
    const password = optionalString(record.password)
    const credentials = password
        ? `${username ? `${encodeURIComponent(username)}:` : ':'}${encodeURIComponent(password)}@`
        : username
          ? `${encodeURIComponent(username)}@`
          : ''
    const protocol = record.tls === true || record.tls === 'true' ? 'rediss' : 'redis'
    return `${protocol}://${credentials}${host}:${port}/${database}`
}

function requiredString(name: string, value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 必须是非空字符串`)
    return value.trim()
}

function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function requiredInteger(name: string, value: unknown, minimum: number, maximum: number): number {
    const configured = Number(value)
    if (!Number.isInteger(configured) || configured < minimum || configured > maximum) {
        throw new Error(`${name} 必须是 ${minimum}-${maximum} 之间的整数`)
    }
    return configured
}

/** Dispatch 实例间通知。订阅连接不能再发命令，所以发布和订阅各用一条连接。 */
@Injectable()
export class DispatchChannelNotifier implements OnApplicationShutdown {
    private readonly logger = new Logger(DispatchChannelNotifier.name)
    private publisher?: RedisClientType
    private subscriber?: RedisClientType

    constructor(private readonly configService: ConfigService) {}

    /** 订阅通道变更。Nacos 配置由 RedisService 在更早的启动钩子中加载。 */
    public async start(onNotify: (notify: constants.ChannelNotifyPayload) => Promise<void>): Promise<void> {
        const url = redisConnectionUrl(this.configService.get('redis'))
        const socket = { reconnectStrategy: (retries: number) => Math.min(retries * 200, 3000) }
        this.publisher = createClient({ url, socket })
        this.subscriber = createClient({ url, socket })
        this.publisher.on('error', error => this.logger.error(`Dispatch 通知发布连接错误：${this.errorMessage(error)}`))
        this.subscriber.on('error', error => this.logger.error(`Dispatch 通知订阅连接错误：${this.errorMessage(error)}`))
        await this.publisher.connect()
        await this.subscriber.connect()
        await this.subscriber.subscribe(constants.DISPATCH_CHANNEL_NOTIFY_CHANNEL, message => {
            void this.receive(message, onNotify)
        })
        this.logger.log(`已订阅通道变更通知：${constants.DISPATCH_CHANNEL_NOTIFY_CHANNEL}`)
    }

    /** 通知其他实例。调用方必须先写完 Redis。 */
    public async publish(notify: constants.ChannelNotifyPayload): Promise<void> {
        if (!this.publisher?.isOpen) throw new Error('Dispatch 通道通知尚未连接')
        await this.publisher.publish(constants.DISPATCH_CHANNEL_NOTIFY_CHANNEL, JSON.stringify(notify))
    }

    public async onApplicationShutdown(): Promise<void> {
        await this.close(this.subscriber)
        await this.close(this.publisher)
        this.subscriber = undefined
        this.publisher = undefined
    }

    private async receive(message: string, onNotify: (notify: constants.ChannelNotifyPayload) => Promise<void>): Promise<void> {
        const notify = parseNotify(message)
        if (!notify) return
        try {
            await onNotify(notify)
        } catch (error) {
            this.logger.error(`处理通道变更通知失败：alias=${notify.alias}，原因=${this.errorMessage(error)}`)
        }
    }

    private async close(client: RedisClientType | undefined): Promise<void> {
        if (!client?.isOpen) return
        try {
            await client.quit()
        } catch (error) {
            this.logger.warn(`关闭 Dispatch 通知连接失败：${this.errorMessage(error)}`)
        }
    }

    private errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error)
    }
}
