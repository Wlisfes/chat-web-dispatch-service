import * as SrmSchema from '@wlisfes/chat-web-base-schema/chat-web-srm-mysql'

/** Dispatch 直接读写 SRM 库中的设备短信记录，不调用 SRM 接口。 */
export const DISPATCH_MYSQL_CONFIG_KEY = 'database.chat-web-srm'

/** 发送记录需要读取通道、端口、设备、供应商和报价快照；表都由 SRM 拥有，Dispatch 不建表。 */
export const DISPATCH_MYSQL_ENTITIES = [
    SrmSchema.TbSrmSimbankMessage,
    SrmSchema.TbSrmChannel,
    SrmSchema.TbSrmChannelPort,
    SrmSchema.TbSrmSimbankPort,
    SrmSchema.TbSrmSimbank,
    SrmSchema.TbSrmUser,
    SrmSchema.TbSrmSimbankQuote
] as const
