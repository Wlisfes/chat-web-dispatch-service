import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'
import { DataSource, EntityManager, In, InjectDataSource } from '@wlisfes/chat-web-base-schema/database'
import { RabbitmqService } from '@wlisfes/chat-web-base-schema/rabbitmq'
import * as SrmSchema from '@wlisfes/chat-web-base-schema/chat-web-srm-mysql'
import { SubmitBalancer, selectQuote, submitQuoteKey } from '@/modules/dispatch/dispatch.submit'
import * as constants from '@/modules/dispatch/dispatch.constants'

interface SubmitSnapshot {
    /** 通道主键 -> 当前可用端口。 */
    senders: Map<number, constants.SimbankSender[]>
    /** 供应商 + 设备 + 国家/地区 -> 已发布且未作废的报价段，按生效时间倒序。 */
    quotes: Map<string, constants.SimbankQuoteCandidate[]>
}

export interface SelectedSubmitSender {
    sender: constants.SimbankSender
    downUsd: number
}

const SUBMIT_CONFIG_TABLES = [
    SrmSchema.TbSrmChannel,
    SrmSchema.TbSrmChannelPort,
    SrmSchema.TbSrmSimbankPort,
    SrmSchema.TbSrmSimbank,
    SrmSchema.TbSrmUser,
    SrmSchema.TbSrmSimbankQuote
]

function groupBy<K, T>(items: T[], key: (item: T) => K): Map<K, T[]> {
    const groups = new Map<K, T[]>()
    for (const item of items) {
        const value = key(item)
        const group = groups.get(value)
        if (group) group.push(item)
        else groups.set(value, [item])
    }
    return groups
}

/**
 * Dispatch 提交缓存。
 *
 * - 启动时全量加载通道端口、设备、供应商和报价；
 * - 收到 SRM 提交配置变更后整体重新加载，定时比较表签名兜底；
 * - 发送短信时只读内存选择端口和成本，不再逐条查询配置表。
 */
@Injectable()
export class DispatchSubmitCacheService implements OnApplicationBootstrap, OnApplicationShutdown {
    private readonly logger = new Logger(DispatchSubmitCacheService.name)
    private readonly balancer = new SubmitBalancer()
    private snapshot?: SubmitSnapshot
    private signature?: string
    private loading?: Promise<void>
    private dirty = false
    private timer?: NodeJS.Timeout
    private readonly loaded: Promise<void>
    private markLoaded!: () => void

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly rabbitmqService: RabbitmqService
    ) {
        this.loaded = new Promise(resolve => (this.markLoaded = resolve))
    }

    public async onApplicationBootstrap(): Promise<void> {
        await this.refresh('启动')
        this.markLoaded()
        await this.rabbitmqService.consume<constants.SubmitConfigChangedPayload>(constants.DISPATCH_SUBMIT_CONFIG_QUEUE, async payload =>
            this.fetchSubmitConfigChanged(payload)
        )
        this.timer = setInterval(() => void this.reconcile(), constants.DISPATCH_SUBMIT_RECONCILE_INTERVAL_MS)
        this.timer.unref()
    }

    public onApplicationShutdown(): void {
        if (this.timer) clearInterval(this.timer)
    }

    public ready(): Promise<void> {
        return this.loaded
    }

    public select(message: constants.SmsChannelMessagePayload, now = Date.now()): SelectedSubmitSender {
        const snapshot = this.current()
        const sender = this.balancer.pick(message.channelKeyId, snapshot.senders.get(message.channelKeyId) ?? [])
        if (!sender) throw new Error(`通道没有可用 SIM 端口：channelKeyId=${message.channelKeyId}`)
        const quoteKey = submitQuoteKey(sender.userKeyId, sender.simbankKeyId, Number(message.countryKeyId))
        return { sender, downUsd: selectQuote(snapshot.quotes.get(quoteKey), now) }
    }

    private current(): SubmitSnapshot {
        if (!this.snapshot) throw new Error('提交缓存尚未加载')
        return this.snapshot
    }

    private async fetchSubmitConfigChanged(payload: constants.SubmitConfigChangedPayload): Promise<'ack'> {
        await this.refresh(`配置变更 version=${payload?.version}`).catch(error =>
            this.logger.error(`提交缓存重新加载失败，继续使用旧快照：${this.errorMessage(error)}`)
        )
        return 'ack'
    }

    private async reconcile(): Promise<void> {
        try {
            if (this.loading) return
            const signature = await this.loadSignature()
            if (signature !== this.signature) await this.refresh('定时校对发现配置变化')
        } catch (error) {
            this.logger.error(`提交缓存校对失败，继续使用旧快照：${this.errorMessage(error)}`)
        }
    }

    private async refresh(reason: string): Promise<void> {
        if (this.loading) {
            this.dirty = true
            return this.loading
        }
        this.loading = (async () => {
            try {
                do {
                    this.dirty = false
                    await this.load(reason)
                } while (this.dirty)
            } finally {
                this.loading = undefined
            }
        })()
        return this.loading
    }

    private async load(reason: string): Promise<void> {
        const startedAt = performance.now()
        const signature = await this.loadSignature()
        const manager = this.dataSource.manager
        const [channels, links, quotes] = await Promise.all([
            manager.find(SrmSchema.TbSrmChannel, {
                where: { status: SrmSchema.TbSrmChannelStatus.ENABLE },
                select: { keyId: true, alias: true, ownerUserUid: true }
            }),
            manager.find(SrmSchema.TbSrmChannelPort, {
                where: { status: SrmSchema.TbSrmChannelPortStatus.ENABLE },
                select: { channelKeyId: true, portKeyId: true, simbankKeyId: true, weight: true }
            }),
            this.loadQuotes(manager)
        ])
        const portKeyIds = [...new Set(links.map(link => link.portKeyId))]
        const simbankKeyIds = [...new Set(links.map(link => link.simbankKeyId))]
        const [ports, simbanks] = await Promise.all([this.loadPorts(manager, portKeyIds), this.loadSimbanks(manager, simbankKeyIds)])
        const users = await this.loadUsers(manager, [...new Set(simbanks.map(simbank => simbank.userKeyId))])
        const senders = this.createSenders(channels, links, ports, simbanks, users)

        this.snapshot = { senders: groupBy(senders, sender => sender.channelKeyId), quotes }
        this.signature = signature
        this.balancer.clear()
        this.logger.log(
            `提交缓存已加载（${reason}）：可用端口=${senders.length}，报价组=${quotes.size}，耗时=${Math.round(performance.now() - startedAt)}ms`
        )
    }

    private async loadPorts(manager: EntityManager, keyIds: number[]): Promise<SrmSchema.TbSrmSimbankPort[]> {
        if (keyIds.length === 0) return []
        return manager.find(SrmSchema.TbSrmSimbankPort, {
            where: {
                keyId: In(keyIds),
                status: SrmSchema.TbSrmSimbankPortStatus.ENABLE,
                insertStatus: SrmSchema.TbSrmSimbankPortInsertStatus.INSERTED,
                activateStatus: SrmSchema.TbSrmSimbankPortActivateStatus.ACTIVE
            },
            select: { keyId: true, simbankKeyId: true, port: true, sim: true, iccid: true }
        })
    }

    private async loadSimbanks(manager: EntityManager, keyIds: number[]): Promise<SrmSchema.TbSrmSimbank[]> {
        if (keyIds.length === 0) return []
        return manager.find(SrmSchema.TbSrmSimbank, {
            where: { keyId: In(keyIds), status: SrmSchema.TbSrmSimbankStatus.ENABLE },
            select: { keyId: true, name: true, alias: true, userKeyId: true, ownerUserUid: true }
        })
    }

    private async loadUsers(manager: EntityManager, keyIds: number[]): Promise<SrmSchema.TbSrmUser[]> {
        if (keyIds.length === 0) return []
        return manager.find(SrmSchema.TbSrmUser, {
            where: { keyId: In(keyIds), status: SrmSchema.TbSrmUserStatus.ENABLE },
            select: { keyId: true, name: true, alias: true }
        })
    }

    private async loadQuotes(manager: EntityManager): Promise<Map<string, constants.SimbankQuoteCandidate[]>> {
        const quotes = await manager.find(SrmSchema.TbSrmSimbankQuote, {
            where: {
                status: In([
                    SrmSchema.TbSrmSimbankQuoteStatus.EFFECTIVE,
                    SrmSchema.TbSrmSimbankQuoteStatus.PENDING,
                    SrmSchema.TbSrmSimbankQuoteStatus.EXPIRED
                ])
            },
            select: {
                userKeyId: true,
                simbankKeyId: true,
                countryKeyId: true,
                downUsd: true,
                effectiveTime: true,
                expiryTime: true
            },
            order: { effectiveTime: 'DESC', keyId: 'DESC' }
        })
        const groups = new Map<string, constants.SimbankQuoteCandidate[]>()
        for (const quote of quotes) {
            const key = submitQuoteKey(quote.userKeyId, quote.simbankKeyId, quote.countryKeyId)
            const group = groups.get(key) ?? []
            group.push({
                downUsd: Number(quote.downUsd),
                effectiveTime: new Date(quote.effectiveTime).getTime(),
                expiryTime: quote.expiryTime ? new Date(quote.expiryTime).getTime() : null
            })
            groups.set(key, group)
        }
        return groups
    }

    private createSenders(
        channels: SrmSchema.TbSrmChannel[],
        links: SrmSchema.TbSrmChannelPort[],
        ports: SrmSchema.TbSrmSimbankPort[],
        simbanks: SrmSchema.TbSrmSimbank[],
        users: SrmSchema.TbSrmUser[]
    ): constants.SimbankSender[] {
        const channelMap = new Map(channels.map(channel => [channel.keyId, channel]))
        const portMap = new Map(ports.map(port => [port.keyId, port]))
        const simbankMap = new Map(simbanks.map(simbank => [simbank.keyId, simbank]))
        const userMap = new Map(users.map(user => [user.keyId, user]))
        return links.flatMap(link => {
            const channel = channelMap.get(link.channelKeyId)
            const port = portMap.get(link.portKeyId)
            const simbank = simbankMap.get(link.simbankKeyId)
            const user = simbank ? userMap.get(simbank.userKeyId) : undefined
            if (!channel || !port || !simbank || !user || port.simbankKeyId !== simbank.keyId || link.weight <= 0) return []
            return [
                {
                    channelKeyId: channel.keyId,
                    channelAlias: channel.alias,
                    channelOwnerUserUid: channel.ownerUserUid,
                    portKeyId: port.keyId,
                    port: port.port,
                    sim: port.sim,
                    iccid: port.iccid,
                    simbankKeyId: simbank.keyId,
                    simbankName: simbank.name,
                    simbankAlias: simbank.alias,
                    userKeyId: user.keyId,
                    userName: user.name,
                    userAlias: user.alias,
                    ownerUserUid: simbank.ownerUserUid,
                    weight: link.weight
                }
            ]
        })
    }

    /** 配置签名：各表行数和最大修改时间。新增、修改、删除都会改变签名。 */
    private async loadSignature(): Promise<string> {
        const rows = await Promise.all(
            SUBMIT_CONFIG_TABLES.map(async entity => {
                const repository = this.dataSource.getRepository(entity)
                const row = await repository
                    .createQueryBuilder('t')
                    .select('COUNT(*)', 'total')
                    .addSelect('MAX(t.modifyTime)', 'modified')
                    .getRawOne<{ total: number | string; modified: Date | string | null }>()
                const modified = row?.modified instanceof Date ? row.modified.getTime() : String(row?.modified ?? '')
                return `${repository.metadata.tableName}:${row?.total ?? 0}:${modified}`
            })
        )
        return rows.join('|')
    }

    private errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error)
    }
}
