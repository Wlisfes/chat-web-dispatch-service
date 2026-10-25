import * as constants from '@/modules/dispatch/dispatch.constants'

/** 对账结果。调用方只调整本进程订阅，不写 Redis。 */
export interface ReconcilePlan {
    /** Redis 中比本地新的通道。 */
    adopt: constants.SmsChannelEventPayload[]
    /** 本地有、Redis 没有的通道，视为已删除。 */
    remove: constants.SmsChannelEventPayload[]
    /** 版本不比本地新，只校正订阅是否还在。 */
    repair: constants.SmsChannelEventPayload[]
}

/** 解析 Redis 中的通道副本。损坏的字段不能当成删除。 */
export function parseChannel(value: string): constants.SmsChannelEventPayload | undefined {
    let parsed: unknown
    try {
        parsed = JSON.parse(value)
    } catch {
        return undefined
    }
    if (!parsed || typeof parsed !== 'object') return undefined
    const channel = parsed as constants.SmsChannelEventPayload
    if (typeof channel.alias !== 'string' || !channel.alias.trim() || !Number.isInteger(channel.version)) return undefined
    if (typeof channel.deleted !== 'boolean') return undefined
    if (typeof channel.queue !== 'string' || !channel.queue) channel.queue = `chat.sms.channel.${channel.alias}`
    return channel
}

/** 解析实例间通知。字段不全就忽略，等下一轮对账。 */
export function parseNotify(value: string): constants.ChannelNotifyPayload | undefined {
    let parsed: unknown
    try {
        parsed = JSON.parse(value)
    } catch {
        return undefined
    }
    if (!parsed || typeof parsed !== 'object') return undefined
    const notify = parsed as constants.ChannelNotifyPayload
    if (typeof notify.alias !== 'string' || !notify.alias.trim()) return undefined
    if (!Number.isInteger(notify.version) || typeof notify.deleted !== 'boolean') return undefined
    return { alias: notify.alias, version: notify.version, deleted: notify.deleted }
}

/** 本地版本不比传入版本旧时，不能用旧事件覆盖。 */
export function isStale(current: constants.SmsChannelEventPayload | undefined, version: number): boolean {
    return Boolean(current && current.version >= version)
}

/**
 * 以 Redis 副本为准生成订阅校正计划。
 * 某个字段解析失败时保留本地订阅，避免一条坏数据把通道取消掉。
 */
export function planReconcile(local: ReadonlyMap<string, constants.SmsChannelEventPayload>, remote: Record<string, string>): ReconcilePlan {
    const adopt: constants.SmsChannelEventPayload[] = []
    const remove: constants.SmsChannelEventPayload[] = []
    const repair: constants.SmsChannelEventPayload[] = []
    const seen = new Set<string>()
    for (const [alias, raw] of Object.entries(remote)) {
        const channel = parseChannel(raw)
        if (!channel || channel.alias !== alias) {
            seen.add(alias)
            continue
        }
        seen.add(alias)
        const current = local.get(alias)
        if (!current || current.version < channel.version) adopt.push(channel)
        else if (current.version === channel.version) repair.push(channel)
        else repair.push(current)
    }
    for (const [alias, current] of local) {
        if (!seen.has(alias)) remove.push(current)
    }
    return { adopt, remove, repair }
}

/** 对账动作。Redis 中已不存在的通道必须删除，不能因为版本相同而保留订阅。 */
export type LocalActionType = 'adopt' | 'drop' | 'sync'

export interface LocalAction {
    type: LocalActionType
    channel: constants.SmsChannelEventPayload
}

export function localActions(plan: ReconcilePlan): LocalAction[] {
    const actions: LocalAction[] = []
    for (const channel of plan.adopt) actions.push({ type: channel.deleted ? 'drop' : 'adopt', channel })
    for (const channel of plan.remove) actions.push({ type: 'drop', channel })
    for (const channel of plan.repair) actions.push({ type: channel.deleted ? 'drop' : 'sync', channel })
    return actions
}
