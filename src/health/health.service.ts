import { Injectable } from '@nestjs/common'
import { InjectDataSource, DataSource } from '@wlisfes/chat-web-base-schema/database'
import { RedisService } from '@wlisfes/chat-web-base-schema/redis'
import * as HealthDto from '@/health/dto/health.dto'

type TableRow = { tableName: string }

@Injectable()
export class HealthService {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly redisService: RedisService
    ) {}

    /**调度服务存活状态。*/
    public async getLiveness(): Promise<HealthDto.ServiceLivenessResponseDto> {
        return { status: 'UP', timestamp: new Date().toISOString() }
    }

    /**调度服务就绪状态。尚未注册业务表时只检查数据库连接。*/
    public async getReadiness(): Promise<HealthDto.ServiceReadinessResponseDto> {
        const requiredTables = [...new Set(this.dataSource.entityMetadatas.map(metadata => metadata.tableName))].sort()
        let databaseReady = false
        let database: HealthDto.ServiceDependencyResponseDto
        try {
            if (requiredTables.length === 0) {
                await this.dataSource.query('SELECT 1')
                databaseReady = this.dataSource.isInitialized
                database = { connected: this.dataSource.isInitialized, requiredTableCount: 0, missingTables: [] }
            } else {
                const rows = (await this.dataSource.query(
                    `SELECT table_name AS tableName FROM information_schema.tables
                     WHERE table_schema = DATABASE() AND table_name IN (${requiredTables.map(() => '?').join(', ')})`,
                    requiredTables
                )) as TableRow[]
                const existing = new Set(rows.map(row => row.tableName))
                const missingTables = requiredTables.filter(table => !existing.has(table))
                databaseReady = this.dataSource.isInitialized && missingTables.length === 0
                database = { connected: this.dataSource.isInitialized, requiredTableCount: requiredTables.length, missingTables }
            }
        } catch (error) {
            database = { connected: false, error: error instanceof Error ? error.message : String(error) }
        }
        let redisReady = false
        try {
            redisReady = await this.redisService.ping()
        } catch {
            redisReady = false
        }
        return {
            status: databaseReady && redisReady ? 'UP' : 'DOWN',
            database,
            redis: { connected: redisReady },
            auth: { mode: 'gateway-principal' },
            timestamp: new Date().toISOString()
        }
    }
}
