import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { APP_GUARD } from '@nestjs/core'
import { AuthorizationGuard, AuthorizationModule, GatewayPrincipalGuard, GatewayPrincipalModule } from '@wlisfes/chat-web-base-schema/auth'
import { HttpResponseModule } from '@wlisfes/chat-web-base-schema/interceptor'
import { forRootNacosRuntimeOptions, NacosModule } from '@wlisfes/chat-web-base-schema/nacos'
import { RabbitmqModule } from '@wlisfes/chat-web-base-schema/rabbitmq'
import { RedisModule } from '@wlisfes/chat-web-base-schema/redis'
import { AppController } from '@/app.controller'
import { AppService } from '@/app.service'
import { DatabaseModule } from '@/database/database.module'
import { HealthModule } from '@/health/health.module'
import { SMS_RABBITMQ_VHOST } from '@/modules/dispatch/dispatch.constants'
import { DispatchModule } from '@/modules/dispatch/dispatch.module'
import { setupDispatchTopology } from '@/modules/dispatch/dispatch.topology'

@Module({
    imports: [
        HttpResponseModule,
        ConfigModule.forRoot({ isGlobal: true }),
        NacosModule.forRoot(forRootNacosRuntimeOptions(process.env)),
        RedisModule.forRoot({ database: 5 }),
        RabbitmqModule.forRoot({ vhost: SMS_RABBITMQ_VHOST, setup: setupDispatchTopology }),
        DatabaseModule,
        // 用户认证在网关完成一次；本服务只校验网关签发的身份上下文签名。
        GatewayPrincipalModule,
        // 只有声明 RequirePermissions 的接口才会调用 Auth 服务校验按钮权限。
        AuthorizationModule,
        HealthModule,
        DispatchModule
    ],
    controllers: [AppController],
    providers: [
        AppService,
        { provide: APP_GUARD, useExisting: GatewayPrincipalGuard },
        { provide: APP_GUARD, useExisting: AuthorizationGuard }
    ]
})
export class AppModule {}
