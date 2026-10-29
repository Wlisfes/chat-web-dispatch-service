/** 供应商钱包 Redis 注入令牌：连接 Finance 钱包缓存，和 Dispatch 自己的 Redis index 5 分开。 */
export const WALLET_REDIS = Symbol('WALLET_REDIS')

/** 供应商钱包 Redis 在 Nacos 中的配置节点。 */
export const WALLET_REDIS_CONFIG_KEY = 'walletRedis'

/** Finance 供应商钱包缓存所在的 Redis index。 */
export const WALLET_REDIS_DATABASE = 3

/** Finance 供应商钱包 Redis 哈希键前缀。 */
export const SRM_WALLET_REDIS_PREFIX = 'chat-web-finance:srm:wallet'

/** 钱包哈希中的余额字段。 */
export const SRM_WALLET_BALANCE_FIELD = 'balance'

/** 生成供应商钱包 Redis 哈希键。 */
export function srmWalletRedisKey(userKeyId: number): string {
    return `${SRM_WALLET_REDIS_PREFIX}:${userKeyId}`
}
