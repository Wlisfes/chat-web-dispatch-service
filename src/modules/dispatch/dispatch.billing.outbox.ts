import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'
import { DataSource, EntityManager, In, InjectDataSource } from '@wlisfes/chat-web-base-schema/database'
import {
    RabbitmqService,
    SMS_BILLING_EXCHANGE,
    SMS_SRM_USER_BILLING_ROUTING_KEY,
    type SrmUserBillingPayload
} from '@wlisfes/chat-web-base-schema/rabbitmq'
import { toOutboxRow } from '@/modules/dispatch/dispatch.billing'
import * as SrmSchema from '@wlisfes/chat-web-base-schema/chat-web-srm-mysql'
import * as constants from '@/modules/dispatch/dispatch.constants'

/**
 * 供应商计费事件发件箱。
 *
 * - 写入：调用方在写发送记录的同一事务里调用 add，事务提交后调用 flush 立即发布；
 * - 发布：发布成功标记为已发布，失败只记录原因，不影响发送流程；
 * - 补发：定时扫描待发布事件，覆盖发布失败、进程在提交后发布前重启等情况，保证计费事件不丢。
 */
@Injectable()
export class DispatchBillingOutbox implements OnApplicationBootstrap, OnApplicationShutdown {
    private readonly logger = new Logger(DispatchBillingOutbox.name)
    private timer?: NodeJS.Timeout
    private flushing?: Promise<void>

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly rabbitmqService: RabbitmqService
    ) {}

    public onApplicationBootstrap(): void {
        this.timer = setInterval(() => void this.flush(), constants.DISPATCH_BILLING_OUTBOX_INTERVAL_MS)
        this.timer.unref()
    }

    public onApplicationShutdown(): void {
        if (this.timer) clearInterval(this.timer)
    }

    /** 在调用方事务内写入计费事件；同一 eventId 重复写入时忽略，保证一条短信同一节点只计费一次。 */
    public async add(manager: EntityManager, billing: SrmUserBillingPayload | undefined): Promise<void> {
        if (!billing) return
        await manager
            .createQueryBuilder()
            .insert()
            .into(SrmSchema.TbSrmBillingOutbox)
            .values(toOutboxRow(billing))
            .orIgnore()
            .updateEntity(false)
            .execute()
    }

    /** 发布待发布的计费事件；已有发布在进行时复用同一次，避免并发重复发布。 */
    public async flush(): Promise<void> {
        this.flushing ??= this.publishPending().finally(() => (this.flushing = undefined))
        return this.flushing
    }

    private async publishPending(): Promise<void> {
        const repository = this.dataSource.getRepository(SrmSchema.TbSrmBillingOutbox)
        let rows: SrmSchema.TbSrmBillingOutbox[]
        try {
            rows = await repository.find({
                where: { status: SrmSchema.TbSrmBillingOutboxStatus.PENDING },
                order: { keyId: 'ASC' },
                take: constants.DISPATCH_BILLING_OUTBOX_BATCH
            })
        } catch (error) {
            this.logger.error(`读取计费事件发件箱失败：${this.errorMessage(error)}`)
            return
        }
        const published: number[] = []
        for (const row of rows) {
            try {
                const billing = JSON.parse(row.payload) as SrmUserBillingPayload
                await this.rabbitmqService.publish(SMS_BILLING_EXCHANGE, SMS_SRM_USER_BILLING_ROUTING_KEY, billing, {
                    messageId: row.eventId
                })
                published.push(row.keyId)
            } catch (error) {
                const message = this.errorMessage(error).slice(0, constants.BILLING_OUTBOX_ERROR_MAX_LENGTH)
                this.logger.warn(`计费事件发布失败，等待补发：eventId=${row.eventId}，原因=${message}`)
                await repository
                    .update({ keyId: row.keyId }, { attempts: row.attempts + 1, lastError: message })
                    .catch(updateError => this.logger.error(`记录计费事件发布失败原因失败：${this.errorMessage(updateError)}`))
            }
        }
        if (published.length === 0) return
        await repository
            .update({ keyId: In(published) }, { status: SrmSchema.TbSrmBillingOutboxStatus.PUBLISHED, publishedTime: new Date() })
            .catch(error =>
                this.logger.error(`标记计费事件已发布失败，下次会重复发布（Finance 按 eventId 幂等）：${this.errorMessage(error)}`)
            )
    }

    private errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error)
    }
}
