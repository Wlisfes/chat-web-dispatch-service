const test = require('node:test')
const assert = require('node:assert/strict')
const { DispatchSubmitRecorder } = require('../dist/modules/dispatch/dispatch.submit.service')
const { SubmitBalancer, selectQuote } = require('../dist/modules/dispatch/dispatch.submit')

function message(overrides = {}) {
    return {
        message: {
            msgId: 'c2f45ce1-30a5-4d14-b0d7-cb76b10f0e21',
            userKeyId: 10241010,
            userName: '客户',
            appKeyId: 1002009,
            appId: 'APP',
            type: 'MRKT',
            countryKeyId: 1077,
            mcc: '460',
            toNumber: '8613800138000',
            content: 'hello',
            contentLength: 5,
            encoding: 'GSM7',
            segments: 2,
            price: 108200,
            submitTime: '2026-10-26T00:00:00.000Z',
            ...overrides.message
        },
        route: {
            routeKeyId: 1,
            routeAlias: 'R1',
            channelKeyId: 1001,
            channelAlias: 'C1',
            submitTime: '2026-10-26T00:00:01.000Z',
            ...overrides.route
        }
    }
}

function sender(overrides = {}) {
    return {
        channelKeyId: 1001,
        channelAlias: 'C1',
        channelOwnerUserUid: 'owner-channel',
        portKeyId: 2001,
        port: 3,
        sim: '8613000000000',
        iccid: '8986',
        simbankKeyId: 3001,
        simbankName: '设备',
        simbankAlias: 'SB1',
        userKeyId: 4001,
        userName: '供应商',
        userAlias: 'SU1',
        ownerUserUid: 'owner-user',
        weight: 10,
        ...overrides
    }
}

function fakeDataSource({ duplicate = false, existing = { keyId: 12, portKeyId: 22, simbankKeyId: 32, sendStatus: 'success' } } = {}) {
    let inserted
    let lookups = 0
    return {
        dataSource: {
            createQueryBuilder: () => ({
                insert: () => ({
                    into: () => ({
                        values: values => {
                            inserted = values
                            return {
                                orIgnore: () => ({
                                    updateEntity: () => ({
                                        execute: async () =>
                                            duplicate
                                                ? { identifiers: [], raw: { affectedRows: 0, insertId: 0 } }
                                                : { identifiers: [{ keyId: 99 }], raw: { affectedRows: 1, insertId: 99 } }
                                    })
                                })
                            }
                        }
                    })
                })
            }),
            getRepository: () => ({
                findOne: async () => {
                    lookups += 1
                    return existing
                }
            })
        },
        inserted: () => inserted,
        lookups: () => lookups
    }
}

test('发送记录正常路径只插入一次，并写入缓存中的端口和成本快照', async () => {
    const fake = fakeDataSource()
    const cache = { select: () => ({ sender: sender(), downUsd: 54100 }) }
    const result = await new DispatchSubmitRecorder(fake.dataSource, cache).submit(message())
    const row = fake.inserted()
    assert.deepEqual(result, { keyId: 99, portKeyId: 2001, simbankKeyId: 3001, sendStatus: 'submitted' })
    assert.equal(fake.lookups(), 0)
    assert.equal(row.msgId, 'c2f45ce1-30a5-4d14-b0d7-cb76b10f0e21')
    assert.equal(row.source, 'down')
    assert.equal(row.sendStatus, 'submitted')
    assert.equal(row.fromNumber, '8613000000000')
    assert.equal(row.cost, 108200)
    assert.equal(row.price, 108200)
})

test('同一个 msgId 重投时插入被忽略，再回查已有记录', async () => {
    const fake = fakeDataSource({ duplicate: true })
    const cache = { select: () => ({ sender: sender(), downUsd: 54100 }) }
    const result = await new DispatchSubmitRecorder(fake.dataSource, cache).submit(message())
    assert.deepEqual(result, { keyId: 12, portKeyId: 22, simbankKeyId: 32, sendStatus: 'success' })
    assert.equal(fake.lookups(), 1)
})

test('提交缓存没有可用端口时拒绝入库', async () => {
    const fake = fakeDataSource()
    const cache = {
        select: () => {
            throw new Error('通道没有可用 SIM 端口：channelKeyId=1001')
        }
    }
    await assert.rejects(() => new DispatchSubmitRecorder(fake.dataSource, cache).submit(message()), /通道没有可用 SIM 端口/)
    assert.equal(fake.inserted(), undefined)
})

test('端口按权重平滑轮询', () => {
    const balancer = new SubmitBalancer()
    const senders = [sender({ portKeyId: 1, weight: 3 }), sender({ portKeyId: 2, weight: 1 })]
    const picked = Array.from({ length: 8 }, () => balancer.pick(1001, senders).portKeyId)
    assert.deepEqual(picked, [1, 1, 2, 1, 1, 1, 2, 1])
})

test('报价按发送时间选择生效段', () => {
    const quotes = [
        { downUsd: 30000, effectiveTime: 2_000, expiryTime: null },
        { downUsd: 50000, effectiveTime: 1_000, expiryTime: 2_000 }
    ]
    assert.equal(selectQuote(quotes, 1_500), 50000)
    assert.equal(selectQuote(quotes, 2_500), 30000)
    assert.equal(selectQuote(quotes, 500), 0)
})
