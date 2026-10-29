/** 发送前余额校验结果。 */
export interface WalletCanSendResult {
    allowed: boolean
    /** 钱包本币余额（放大百万倍存储）；Redis 不可用或缺少余额时为空。 */
    balance?: number
    reason?: string
}
