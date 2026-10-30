import { Inject, Injectable, Logger } from '@nestjs/common'
import { RedisService } from '@wlisfes/chat-web-base-schema/redis'
import { SRM_WALLET_BALANCE_KEY, WALLET_REDIS } from '@/modules/wallet/wallet.constants'
import { type WalletCanSendResult } from '@/modules/wallet/wallet.interface'
import * as SrmSchema from '@wlisfes/chat-web-base-schema/chat-web-srm-mysql'

/**
 * 发送前直接读取 Finance 钱包 Redis 余额。
 * 预付余额小于等于 0、缺少余额或 Redis 不可用时拒绝；后付始终允许发送。
 */
@Injectable()
export class WalletService {
    private readonly logger = new Logger(WalletService.name)

    constructor(@Inject(WALLET_REDIS) private readonly redisService: RedisService) {}

    public async canSend(userKeyId: number, payMode: SrmSchema.TbSrmUserPayMode | string): Promise<WalletCanSendResult> {
        if (payMode !== SrmSchema.TbSrmUserPayMode.PREPAID) return { allowed: true }
        try {
            const raw = await this.redisService.hGet(SRM_WALLET_BALANCE_KEY, String(userKeyId))
            const balance = Number(raw)
            if (typeof raw !== 'string' || !/^-?\d+$/.test(raw) || !Number.isSafeInteger(balance)) {
                return { allowed: false, reason: '供应商钱包余额缺失，预付不允许发送' }
            }
            if (balance <= 0) {
                return { allowed: false, balance, reason: '预付余额不足' }
            }
            return { allowed: true, balance }
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            this.logger.warn(`读取供应商钱包余额失败：userKeyId=${userKeyId}，原因=${reason}`)
            return { allowed: false, reason: `供应商钱包余额不可用，预付不允许发送：${reason}` }
        }
    }
}
