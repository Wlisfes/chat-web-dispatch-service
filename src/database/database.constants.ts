import * as SrmSchema from '@wlisfes/chat-web-base-schema/chat-web-srm-mysql'

/** Dispatch 直接读写 SRM 库中的设备短信记录，不调用 SRM 接口。 */
export const DISPATCH_MYSQL_CONFIG_KEY = 'database.chat-web-srm'

/** 表由 SRM 拥有；Dispatch 只注册发送记录实体，不在本服务建表。 */
export const DISPATCH_MYSQL_ENTITIES = [SrmSchema.TbSrmSimbankMessage] as const
