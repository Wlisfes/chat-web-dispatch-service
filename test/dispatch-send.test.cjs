const test = require('node:test')
const assert = require('node:assert/strict')
const { DispatchSendService } = require('../dist/modules/dispatch/dispatch.send.service')
const { DispatchSubmitRecorder } = require('../dist/modules/dispatch/dispatch.submit.service')
const { WalletService } = require('../dist/modules/wallet/wallet.service')

const record = { keyId: 99, portKeyId: 2001, simbankKeyId: 3001, sendStatus: 'submitted' }
const payload = {
    message: { msgId: 'm1', toNumber: '8613800138000', segments: 1, countryKeyId: 1077 },
    route: { channelKeyId: 1001, channelAlias: 'C1' }
}

function recorder(affected = 1) {
    const calls = []
    const reassigned = []
    return {
        calls,
        reassigned,
        complete: async (keyId, outcome, msgId) => (calls.push({ keyId, outcome, msgId }), affected > 0),
        reassign: async (keyId, _payload, selected) => (reassigned.push({ keyId, portKeyId: selected.sender.portKeyId }), true)
    }
}

function cache(ports = [2002], sendInterval = 3000) {
    return {
        sendInterval: () => sendInterval,
        selectExcept: (_payload, excluded) => {
            const port = ports.find(item => !excluded.has(item))
            return port ? { sender: { portKeyId: port, simbankKeyId: 3002 }, downUsd: 0 } : undefined
        }
    }
}

const accepted = { msgId: 'm1', accepted: true, statusCode: 'QUEUED', statusMessage: '已进入端口发送队列', time: '' }

test('设备受理后保持 submitted 等待回执，并传通道发送间隔', async () => {
    let request
    const observe = { enqueue: async body => ((request = body), accepted) }
    const rec = recorder()
    const outcome = await new DispatchSendService(observe, rec, cache()).send(payload, record)
    assert.deepEqual(request, { msgId: 'm1', msgKeyId: 99, simbankKeyId: 3001, portKeyId: 2001, sendInterval: 3000 })
    assert.equal(outcome.pending, true)
    assert.equal(outcome.sendStatus, 'submitted')
    assert.equal(rec.calls.length, 0, '受理时不写回结果')
})

test('设备拒绝（发送条件不满足）时写回 failed', async () => {
    const observe = {
        enqueue: async () => ({ msgId: 'm1', accepted: false, statusCode: 'PORT_OFFLINE', statusMessage: '端口离线', time: 'bad' })
    }
    const rec = recorder()
    const outcome = await new DispatchSendService(observe, rec, cache()).send(payload, record)
    assert.equal(outcome.sendStatus, 'failed')
    assert.equal(rec.calls[0].outcome.statusMessage, '端口离线')
    assert.ok(rec.calls[0].outcome.sendTime instanceof Date)
})

test('Observe 不可用时记为提交失败，不抛错', async () => {
    const observe = {
        enqueue: async () => {
            throw new Error('connect ECONNREFUSED')
        }
    }
    const rec = recorder()
    const outcome = await new DispatchSendService(observe, rec, cache()).send(payload, record)
    assert.equal(outcome.sendStatus, 'rejected')
    assert.equal(outcome.statusCode, 'OBSERVE_UNAVAILABLE')
    assert.match(rec.calls[0].outcome.statusMessage, /ECONNREFUSED/)
})

test('端口忙时换到其他端口提交，并改写发送记录的端口', async () => {
    const ports = []
    const observe = {
        enqueue: async body => {
            ports.push(body.portKeyId)
            return body.portKeyId === 2001
                ? { msgId: 'm1', accepted: false, statusCode: 'PORT_BUSY', statusMessage: '', time: '' }
                : accepted
        }
    }
    const rec = recorder()
    const outcome = await new DispatchSendService(observe, rec, cache([2002])).send(payload, record)
    assert.deepEqual(ports, [2001, 2002])
    assert.deepEqual(rec.reassigned, [{ keyId: 99, portKeyId: 2002 }])
    assert.equal(outcome.pending, true)
    assert.equal(outcome.portKeyId, 2002)
})

test('所有端口都忙且超过最长等待时记为提交失败', async () => {
    const observe = { enqueue: async () => ({ msgId: 'm1', accepted: false, statusCode: 'PORT_BUSY', statusMessage: '', time: '' }) }
    const rec = recorder()
    const service = new DispatchSendService(observe, rec, cache([2001]))
    service.busyRetryMs = 1
    service.busyMaxWaitMs = 10
    const outcome = await service.send(payload, record)
    assert.equal(outcome.sendStatus, 'rejected')
    assert.equal(outcome.statusCode, 'PORT_BUSY')
})

test('重投时已有最终结果的记录跳过发送', async () => {
    let called = false
    const observe = { enqueue: async () => ((called = true), accepted) }
    const rec = recorder()
    const outcome = await new DispatchSendService(observe, rec, cache()).send(payload, { ...record, sendStatus: 'success' })
    assert.equal(outcome.skipped, true)
    assert.equal(called, false)
    assert.equal(rec.calls.length, 0)
})

test('写回结果只更新仍为 submitted 的记录', async () => {
    let captured
    const dataSource = {
        createQueryBuilder: () => {
            const builder = {
                update: () => builder,
                set: values => ((captured = { values }), builder),
                where: (sql, params) => ((captured.where = { sql, params }), builder),
                updateEntity: () => builder,
                execute: async () => ({ affected: 0 })
            }
            return builder
        }
    }
    const saved = await new DispatchSubmitRecorder(dataSource, {}).complete(99, {
        sendStatus: 'success',
        statusCode: 'OK',
        statusMessage: 'x'.repeat(600),
        sendTime: new Date()
    })
    assert.equal(saved, false)
    assert.equal(captured.where.params.submitted, 'submitted')
    assert.equal(captured.values.statusMessage.length, 512)
})

test('重投时记录仍为 submitted：重新提交，由 Observe 按短信ID去重', async () => {
    let submitted = 0
    const observe = { enqueue: async () => (submitted++, accepted) }
    const outcome = await new DispatchSendService(observe, recorder(), cache()).send(payload, record)
    assert.equal(submitted, 1)
    assert.equal(outcome.pending, true)
})

test('预付供应商发送前直接读取 Redis 余额，余额不足时拒绝发送', async () => {
    const reads = []
    const walletRedis = {
        hGetAll: async key => (reads.push(key), { balance: '0', credit: '0' })
    }
    let called = false
    const observe = { enqueue: async () => ((called = true), accepted) }
    const rec = recorder()
    const submitCache = { ...cache(), senderOf: () => ({ userKeyId: 7, payMode: 'prepaid' }) }
    const outcome = await new DispatchSendService(observe, rec, submitCache, new WalletService(walletRedis)).send(payload, record)
    assert.deepEqual(reads, ['chat-web-finance:srm:wallet:7'])
    assert.equal(called, false)
    assert.equal(outcome.statusCode, 'INSUFFICIENT_BALANCE')
})

test('后付供应商不读取 Redis 余额，预付余额充足时允许发送', async () => {
    let reads = 0
    const walletRedis = { hGetAll: async () => (reads++, { balance: '10' }) }
    const wallet = new WalletService(walletRedis)
    assert.deepEqual(await wallet.canSend(7, 'postpaid'), { allowed: true })
    assert.equal(reads, 0)
    assert.deepEqual(await wallet.canSend(7, 'prepaid'), { allowed: true, balance: 10 })
})
