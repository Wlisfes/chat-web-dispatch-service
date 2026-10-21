const test = require('node:test')
const assert = require('node:assert/strict')
const { HealthService } = require('../dist/health/health.service')
const { AppService } = require('../dist/app.service')

test('存活检查返回 UP', async () => {
    const service = new HealthService({ entityMetadatas: [] }, { ping: async () => true })
    const result = await service.getLiveness()
    assert.equal(result.status, 'UP')
})

test('尚未注册业务表时只检查数据库连接和 Redis', async () => {
    const queries = []
    const service = new HealthService(
        {
            isInitialized: true,
            entityMetadatas: [],
            async query(sql) {
                queries.push(sql)
                return [{ ok: 1 }]
            }
        },
        { ping: async () => true }
    )
    const result = await service.getReadiness()
    assert.equal(result.status, 'UP')
    assert.equal(result.database.requiredTableCount, 0)
    assert.deepEqual(result.database.missingTables, [])
    assert.equal(result.auth.mode, 'gateway-principal')
    assert.equal(
        queries.some(sql => sql.includes('IN ()')),
        false
    )
})

test('缺失业务表时就绪检查返回 DOWN', async () => {
    const service = new HealthService(
        {
            isInitialized: true,
            entityMetadatas: [{ tableName: 'tb_dispatch_job' }],
            async query() {
                return []
            }
        },
        { ping: async () => true }
    )
    const result = await service.getReadiness()
    assert.equal(result.status, 'DOWN')
    assert.deepEqual(result.database.missingTables, ['tb_dispatch_job'])
})

test('服务信息返回调度服务名称', async () => {
    const service = new AppService({ getLiveness: async () => ({ status: 'UP' }) })
    assert.equal(await service.httpBaseDispatchResolverService(), 'Chat Web Dispatch Service')
})
