import { ApiProperty } from '@nestjs/swagger'

/** 调度服务存活检查响应：GET /health/live。 */
export class ServiceLivenessResponseDto {
    @ApiProperty({ description: '服务状态', enum: ['UP'], example: 'UP' })
    status: 'UP'

    @ApiProperty({ description: '检查时间', example: '2026-08-23T04:00:00.000Z' })
    timestamp: string
}

/** 依赖状态结构：ServiceReadinessResponseDto 使用。 */
export class ServiceDependencyResponseDto {
    @ApiProperty({ description: '依赖是否连接成功', example: true })
    connected: boolean

    @ApiProperty({ description: '必需数据表数量', required: false, example: 0 })
    requiredTableCount?: number

    @ApiProperty({ description: '缺失的数据表', type: [String], required: false, example: [] })
    missingTables?: string[]

    @ApiProperty({ description: '检查失败原因', required: false, example: '连接超时' })
    error?: string
}

/** 鉴权模式结构。 */
export class ServiceAuthModeResponseDto {
    @ApiProperty({ description: '鉴权模式', example: 'gateway-principal' })
    mode: 'gateway-principal'
}

/** 调度服务就绪检查响应：GET /health、GET /health/ready。 */
export class ServiceReadinessResponseDto {
    @ApiProperty({ description: '服务就绪状态', enum: ['UP', 'DOWN'], example: 'UP' })
    status: 'UP' | 'DOWN'

    @ApiProperty({ description: '检查时间', example: '2026-08-23T04:00:00.000Z' })
    timestamp: string

    @ApiProperty({ description: '数据库状态', type: ServiceDependencyResponseDto })
    database: ServiceDependencyResponseDto

    @ApiProperty({ description: 'Redis 状态', type: ServiceDependencyResponseDto })
    redis: ServiceDependencyResponseDto

    @ApiProperty({ description: '鉴权模式', type: ServiceAuthModeResponseDto })
    auth: ServiceAuthModeResponseDto
}
