import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

export interface ChargeCanSendResult {
    allowed: boolean
    balanceUsd?: number
    reason?: string
}

/** 发送前问 Charge：预付余额小于等于 0 不能发，后付可以发。Charge 不可用时预付拒绝、后付放行。 */
@Injectable()
export class ChargeClientService {
    private readonly logger = new Logger(ChargeClientService.name)
    public post: typeof fetch = (input, init) => fetch(input, init)

    constructor(private readonly configService: ConfigService) {}

    public async canSend(userKeyId: number, payMode: string): Promise<ChargeCanSendResult> {
        const base = String(this.configService.get('charge.url') || '').replace(/\/$/, '')
        if (!base) return this.unavailable(payMode, '未配置 charge.url')
        try {
            const response = await this.post(`${base}/srm/can-send`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ userKeyId, payMode }),
                signal: AbortSignal.timeout(Number(this.configService.get('charge.timeout') || 3000))
            })
            if (!response.ok) return this.unavailable(payMode, `Charge 返回 HTTP ${response.status}`)
            const body = (await response.json()) as { data?: ChargeCanSendResult } & ChargeCanSendResult
            return body.data?.allowed === undefined ? body : body.data
        } catch (error) {
            return this.unavailable(payMode, error instanceof Error ? error.message : String(error))
        }
    }

    private unavailable(payMode: string, reason: string): ChargeCanSendResult {
        this.logger.warn(`扣费服务不可用：${reason}`)
        if (payMode === 'prepaid') return { allowed: false, reason: `扣费服务不可用，预付不允许发送：${reason}` }
        return { allowed: true, reason }
    }
}
