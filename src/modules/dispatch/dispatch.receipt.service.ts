import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'
import { DataSource, InjectDataSource, LessThan } from '@wlisfes/chat-web-base-schema/database'
import { ObserveClientService } from '@/modules/observe/observe.client'
import { toSimbankOutcome } from '@/modules/dispatch/dispatch.send.service'
import { DispatchSubmitRecorder } from '@/modules/dispatch/dispatch.submit.service'
import * as SrmSchema from '@wlisfes/chat-web-base-schema/chat-web-srm-mysql'
import * as constants from '@/modules/dispatch/dispatch.constants'

/**
 * 回执超时检查。设备回执的状态写回已由 Hooks 消费队列处理。
 * 提交超过超时时间仍为 submitted 时，按短信ID查询设备侧状态：有结果写回；排队或发送中继续等待；
 * 设备没有记录时记为发送失败，不重新发送。
 */
@Injectable()
export class DispatchReceiptService implements OnApplicationBootstrap, OnApplicationShutdown {
    private readonly logger = new Logger(DispatchReceiptService.name)
    private timer?: NodeJS.Timeout
    private checking?: Promise<void>

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly observeClient: ObserveClientService,
        private readonly submitRecorder: DispatchSubmitRecorder
    ) {}

    public onApplicationBootstrap(): void {
        this.timer = setInterval(() => void this.check(), constants.DISPATCH_RECEIPT_CHECK_INTERVAL_MS)
        this.timer.unref()
    }

    public onApplicationShutdown(): void {
        if (this.timer) clearInterval(this.timer)
    }

    /** 回执超时检查；上一轮未结束时复用同一次。 */
    public async check(now = Date.now()): Promise<void> {
        this.checking ??= this.checkTimeout(now).finally(() => (this.checking = undefined))
        return this.checking
    }

    private async checkTimeout(now: number): Promise<void> {
        let rows: Pick<SrmSchema.TbSrmSimbankMessage, 'keyId' | 'msgId'>[]
        try {
            rows = await this.dataSource.getRepository(SrmSchema.TbSrmSimbankMessage).find({
                where: {
                    sendStatus: SrmSchema.TbSrmSimbankMessageSendStatus.SUBMITTED,
                    createTime: LessThan(new Date(now - constants.DISPATCH_RECEIPT_TIMEOUT_MS))
                },
                select: { keyId: true, msgId: true },
                order: { createTime: 'ASC' },
                take: constants.DISPATCH_RECEIPT_CHECK_BATCH
            })
        } catch (error) {
            this.logger.error(`读取回执超时记录失败：${errorMessage(error)}`)
            return
        }
        for (const row of rows) {
            try {
                await this.resolve(row)
            } catch (error) {
                // Observe 不可用时不改记录，下一轮再查。
                this.logger.warn(`回执超时查询失败，下一轮重试：msgId=${row.msgId}，原因=${errorMessage(error)}`)
            }
        }
    }

    private async resolve(row: Pick<SrmSchema.TbSrmSimbankMessage, 'keyId' | 'msgId'>): Promise<void> {
        const queried = await this.observeClient.query({ msgId: row.msgId })
        if (queried?.found && !queried.result) return
        const outcome = queried?.found
            ? toSimbankOutcome(queried.result, queried.accepted === true)
            : {
                  sendStatus: SrmSchema.TbSrmSimbankMessageSendStatus.FAILED,
                  statusCode: constants.RECEIPT_TIMEOUT_CODE,
                  statusMessage: '设备回执超时，设备侧没有这条短信的发送记录',
                  sendTime: new Date()
              }
        const saved = await this.submitRecorder.complete(row.keyId, outcome, row.msgId)
        if (saved) {
            this.logger.warn(
                `回执超时已补偿：msgId=${row.msgId}，msgKeyId=${row.keyId}，sendStatus=${outcome.sendStatus}，statusCode=${outcome.statusCode}`
            )
        }
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
