import * as constants from '@/modules/dispatch/dispatch.constants'

/** 发送报价按 供应商 + 设备 + 国家/地区 分组。 */
export function submitQuoteKey(userKeyId: number, simbankKeyId: number, countryKeyId: number): string {
    return `${userKeyId}:${simbankKeyId}:${countryKeyId}`
}

/** 按发送当时的时间挑选报价；同时有多段时取生效时间最新的一段。 */
export function selectQuote(quotes: constants.SimbankQuoteCandidate[] | undefined, now = Date.now()): number {
    const quote = quotes?.find(item => item.effectiveTime <= now && (item.expiryTime === null || item.expiryTime > now))
    return quote?.downUsd ?? 0
}

/**
 * 端口平滑加权轮询。
 *
 * 每个通道单独维护状态；端口增删或权重变化后，新端口从 0 开始。
 * 多个 Dispatch 实例各自轮询，整体仍接近按权重分配。
 */
export class SubmitBalancer {
    private readonly groups = new Map<number, Map<number, number>>()

    public pick(channelKeyId: number, senders: constants.SimbankSender[]): constants.SimbankSender | undefined {
        const available = senders.filter(sender => sender.weight > 0).sort((a, b) => a.portKeyId - b.portKeyId)
        if (available.length === 0) return undefined
        if (available.length === 1) return available[0]

        const previous = this.groups.get(channelKeyId) ?? new Map<number, number>()
        const next = new Map<number, number>()
        const total = available.reduce((sum, sender) => sum + sender.weight, 0)
        let selected = available[0]
        let best = -Infinity
        for (const sender of available) {
            const current = (previous.get(sender.portKeyId) ?? 0) + sender.weight
            next.set(sender.portKeyId, current)
            if (current > best) {
                best = current
                selected = sender
            }
        }
        next.set(selected.portKeyId, best - total)
        this.groups.set(channelKeyId, next)
        return selected
    }

    public clear(): void {
        this.groups.clear()
    }
}
