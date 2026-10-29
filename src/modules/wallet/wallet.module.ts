import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { NacosService } from '@wlisfes/chat-web-base-schema/nacos'
import { RedisService } from '@wlisfes/chat-web-base-schema/redis'
import { WALLET_REDIS, WALLET_REDIS_CONFIG_KEY, WALLET_REDIS_DATABASE } from '@/modules/wallet/wallet.constants'
import { WalletService } from '@/modules/wallet/wallet.service'

/** 供应商钱包余额：使用独立 Redis 连接读取 Finance index 3，不影响 Dispatch 自己的 index 5。 */
@Module({
    providers: [
        {
            provide: WALLET_REDIS,
            inject: [ConfigService, NacosService],
            useFactory: (configService: ConfigService, nacosService: NacosService) =>
                new RedisService(configService, { database: WALLET_REDIS_DATABASE, configKey: WALLET_REDIS_CONFIG_KEY }, nacosService)
        },
        WalletService
    ],
    exports: [WalletService]
})
export class WalletModule {}
