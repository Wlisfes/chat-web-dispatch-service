import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'
import { ObserveEnqueueResult, ObservePingPayload, ObservePingResult, ObserveSubmitPayload } from '@wlisfes/chat-web-base-schema/observe'
import { resolveObserveClientConfig, type ObserveClientOptions } from '@/modules/observe/observe.constants'
import { ClientProxy, ClientProxyFactory, Transport } from '@nestjs/microservices'
import { OBSERVE_PATTERN } from '@wlisfes/chat-web-base-schema/observe'
import { ConfigService } from '@nestjs/config'
import { firstValueFrom, timeout } from 'rxjs'

/** Observe TCP 客户端：Dispatch 通过它调用 Observe 模拟发送。连接按需建立，断开后下次调用自动重连。 */
@Injectable()
export class ObserveClientService implements OnApplicationBootstrap, OnApplicationShutdown {
    private readonly logger = new Logger(ObserveClientService.name)
    private client?: ClientProxy
    private options?: ObserveClientOptions

    constructor(private readonly configService: ConfigService) {}

    /** 启动后检查一次连通性；Observe 未启动时只记录日志，不阻塞 Dispatch 启动。 */
    public async onApplicationBootstrap(): Promise<void> {
        void this.ping().then(
            result => this.logger.log(`Observe TCP 已连通：${this.address()}，service=${result.service}，timestamp=${result.timestamp}`),
            error =>
                this.logger.warn(`Observe TCP 连接失败：${this.address()}，原因=${error instanceof Error ? error.message : String(error)}`)
        )
    }

    public async onApplicationShutdown(): Promise<void> {
        await this.client?.close()
    }

    /** 连通性检查。 */
    public async ping(): Promise<ObservePingResult> {
        const payload: ObservePingPayload = {
            from: process.env.NACOS_SERVICE_NAME || 'chat-web-dispatch-service',
            timestamp: new Date().toISOString()
        }
        return await this.send<ObservePingResult>(OBSERVE_PATTERN.PING, payload)
    }

    /** 异步提交：进入端口发送队列后立即返回受理结果；连接失败或超时抛错，由调用方决定如何记录。 */
    public async enqueue(payload: ObserveSubmitPayload): Promise<ObserveEnqueueResult> {
        return await this.send<ObserveEnqueueResult>(OBSERVE_PATTERN.ENQUEUE, payload)
    }

    private async send<T>(pattern: string, payload: unknown): Promise<T> {
        const options = this.resolveOptions()
        return await firstValueFrom(this.getClient().send<T>(pattern, payload).pipe(timeout(options.timeout)))
    }

    private getClient(): ClientProxy {
        if (this.client) return this.client
        const { host, port } = this.resolveOptions()
        this.client = ClientProxyFactory.create({ transport: Transport.TCP, options: { host, port } })
        return this.client
    }

    private resolveOptions(): ObserveClientOptions {
        this.options ??= resolveObserveClientConfig(this.configService.get('observe'))
        return this.options
    }

    private address(): string {
        try {
            const { host, port } = this.resolveOptions()
            return `${host}:${port}`
        } catch {
            return '未配置'
        }
    }
}
