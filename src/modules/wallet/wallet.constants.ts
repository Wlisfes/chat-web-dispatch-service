/** 供应商钱包 Redis 注入令牌：连接 Finance 钱包缓存，和 Dispatch 自己的 Redis index 5 分开。 */
export const WALLET_REDIS = Symbol('WALLET_REDIS')

/** 供应商钱包 Redis 在 Nacos 中的配置节点。 */
export const WALLET_REDIS_CONFIG_KEY = 'walletRedis'

/** Finance 供应商钱包缓存所在的 Redis index。 */
export const WALLET_REDIS_DATABASE = 3

/** 全部供应商余额放在同一个哈希，field 为供应商主键。 */
export const SRM_WALLET_BALANCE_KEY = 'chat-web-finance:srm:balances'
