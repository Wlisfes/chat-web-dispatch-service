const test = require('node:test')
const assert = require('node:assert/strict')
const { DispatchSendService } = require('../dist/modules/dispatch/dispatch.send.service')
const { DispatchSubmitRecorder } = require('../dist/modules/dispatch/dispatch.submit.service')
const { DispatchReceiptService } = require('../dist/modules/dispatch/dispatch.receipt.service')

const record = { keyId: 99, portKeyId: 2001, simbankKeyId: 3001, sendStatus: 'submitted' }
const payload = {
    message: { msgId: 'm1', toNumber: '8613800138000', segments: 1, countryKeyId: 1077 },
    route: { channelKeyId: 1001, channelAlias: 'C1' }
}

function recorder(affected = 1) {
    const calls = []
    const accepted = []
    const reassigned = []
    return {
        calls,
        accepted,
        reassigned,
        complete: async (keyId, outcome, msgId) => (calls.push({ keyId, outcome, msgId }), affected > 0),
        accept: async keyId => accepted.push(keyId),
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

test('设备受理后保持 submitted 等待回执，预付计费，并传通道发送间隔', async () => {
    let request
    const observe = { enqueue: async body => ((request = body), accepted) }
    const rec = recorder()
    const outcome = await new DispatchSendService(observe, rec, cache()).send(payload, record)
    assert.deepEqual(request, { msgId: 'm1', msgKeyId: 99, simbankKeyId: 3001, portKeyId: 2001, sendInterval: 3000 })
    assert.equal(outcome.pending, true)
    assert.equal(outcome.sendStatus, 'submitted')
    assert.equal(rec.calls.length, 0, '受理时不写回结果')
    assert.deepEqual(rec.accepted, [99])
})

test('设备拒绝（发送条件不满足）时写回 failed，不计费', async () => {
    const observe = {
        enqueue: async () => ({ msgId: 'm1', accepted: false, statusCode: 'PORT_OFFLINE', statusMessage: '端口离线', time: 'bad' })
    }
    const rec = recorder()
    const outcome = await new DispatchSendService(observe, rec, cache()).send(payload, record)
    assert.equal(outcome.sendStatus, 'failed')
    assert.equal(rec.calls[0].outcome.statusMessage, '端口离线')
    assert.ok(rec.calls[0].outcome.sendTime instanceof Date)
    assert.equal(rec.accepted.length, 0)
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

test('首次投递不查询设备状态，直接提交', async () => {
    let queried = false
    const observe = { query: async () => ((queried = true), { msgId: 'm1', found: false }), enqueue: async () => accepted }
    const outcome = await new DispatchSendService(observe, recorder(), cache()).send(payload, record)
    assert.equal(queried, false)
    assert.equal(outcome.pending, true)
})

test('重投时设备已发送过：使用设备结果写回，不重复提交', async () => {
    let submitted = false
    const observe = {
        query: async ({ msgId }) => ({
            msgId,
            found: true,
            state: 'settled',
            accepted: true,
            result: { msgId, sendStatus: 'success', statusCode: 'OK', statusMessage: '', sendTime: '2026-10-28T01:00:00.000Z' }
        }),
        enqueue: async () => ((submitted = true), accepted)
    }
    const rec = recorder()
    const outcome = await new DispatchSendService(observe, rec, cache()).send(payload, { ...record, redelivered: true })
    assert.equal(submitted, false)
    assert.equal(outcome.recovered, true)
    assert.equal(outcome.sendStatus, 'success')
    assert.equal(rec.calls[0].outcome.accepted, true, '设备受理过，写回时补写预付计费')
    assert.equal(rec.calls[0].outcome.sendTime.toISOString(), '2026-10-28T01:00:00.000Z')
})

test('重投时设备排队或发送中：不重复提交，继续等待回执', async () => {
    let submitted = false
    const observe = {
        query: async ({ msgId }) => ({ msgId, found: true, state: 'queued', accepted: true }),
        enqueue: async () => ((submitted = true), accepted)
    }
    const rec = recorder()
    const outcome = await new DispatchSendService(observe, rec, cache()).send(payload, { ...record, redelivered: true })
    assert.equal(submitted, false)
    assert.equal(outcome.pending, true)
    assert.equal(outcome.recovered, true)
    assert.equal(rec.calls.length, 0)
})

test('重投时设备没有收到过：重新提交', async () => {
    let submitted = 0
    const observe = { query: async ({ msgId }) => ({ msgId, found: false }), enqueue: async () => (submitted++, accepted) }
    const outcome = await new DispatchSendService(observe, recorder(), cache()).send(payload, { ...record, redelivered: true })
    assert.equal(submitted, 1)
    assert.equal(outcome.recovered, undefined)
    assert.equal(outcome.pending, true)
})

test('重投时查询失败：不重新提交，记为提交失败', async () => {
    let submitted = false
    const observe = {
        query: async () => {
            throw new Error('Timeout has occurred')
        },
        enqueue: async () => ((submitted = true), accepted)
    }
    const rec = recorder()
    const outcome = await new DispatchSendService(observe, rec, cache()).send(payload, { ...record, redelivered: true })
    assert.equal(submitted, false)
    assert.equal(outcome.sendStatus, 'rejected')
    assert.equal(outcome.statusCode, 'OBSERVE_UNAVAILABLE')
    assert.match(rec.calls[0].outcome.statusMessage, /查询失败，未重新发送/)
})

test('设备回执：按 msgKeyId + msgId 写回结果，缺少定位信息时丢弃', async () => {
    const rec = recorder()
    const receipts = new DispatchReceiptService({}, {}, {}, rec)
    await receipts.fetchReceipt({
        msgId: 'm1',
        msgKeyId: 99,
        simbankKeyId: 3001,
        portKeyId: 2001,
        sendStatus: 'success',
        statusCode: 'OK',
        statusMessage: '',
        sendTime: '2026-10-28T02:00:00.000Z'
    })
    assert.equal(rec.calls[0].keyId, 99)
    assert.equal(rec.calls[0].msgId, 'm1')
    assert.equal(rec.calls[0].outcome.sendStatus, 'success')
    assert.equal(rec.calls[0].outcome.accepted, true)
    assert.equal(await receipts.fetchReceipt({ msgId: 'm1' }), 'ack')
    assert.equal(rec.calls.length, 1)
})

test('回执超时检查：有结果写回，排队中继续等待，设备没有记录记为失败，查询失败下一轮再查', async () => {
    const rows = [
        { keyId: 1, msgId: 'done' },
        { keyId: 2, msgId: 'queued' },
        { keyId: 3, msgId: 'lost' },
        { keyId: 4, msgId: 'error' }
    ]
    let where
    const dataSource = { getRepository: () => ({ find: async options => ((where = options.where), rows) }) }
    const observe = {
        query: async ({ msgId }) => {
            if (msgId === 'error') throw new Error('Timeout has occurred')
            if (msgId === 'queued') return { msgId, found: true, state: 'sending', accepted: true }
            if (msgId === 'lost') return { msgId, found: false }
            return {
                msgId,
                found: true,
                state: 'settled',
                accepted: true,
                result: { msgId, sendStatus: 'failed', statusCode: 'SIMULATED_FAILURE', statusMessage: '', sendTime: '' }
            }
        }
    }
    const rec = recorder()
    await new DispatchReceiptService(dataSource, {}, observe, rec).check(Date.parse('2026-10-28T03:00:00.000Z'))
    assert.equal(where.sendStatus, 'submitted')
    assert.deepEqual(
        rec.calls.map(call => [call.keyId, call.outcome.sendStatus, call.outcome.statusCode]),
        [
            [1, 'failed', 'SIMULATED_FAILURE'],
            [3, 'failed', 'RECEIPT_TIMEOUT']
        ]
    )
})

test('写回结果只更新仍为 submitted 的记录', async () => {
    let captured
    const dataSource = {
        transaction: async work => work(dataSource),
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
    const saved = await new DispatchSubmitRecorder(dataSource, {}, { add: async () => {}, flush: async () => {} }).complete(99, {
        sendStatus: 'success',
        statusCode: 'OK',
        statusMessage: 'x'.repeat(600),
        sendTime: new Date()
    })
    assert.equal(saved, false)
    assert.equal(captured.where.params.submitted, 'submitted')
    assert.equal(captured.values.statusMessage.length, 512)
})

/** complete() 用的假数据源：update 影响行数可控，回查发送记录返回快照。 */
function completeDataSource({ affected = 1, snapshot }) {
    const dataSource = {
        transaction: async work => work(dataSource),
        createQueryBuilder: () => {
            const builder = {
                update: () => builder,
                set: () => builder,
                where: () => builder,
                updateEntity: () => builder,
                execute: async () => ({ affected })
            }
            return builder
        },
        getRepository: () => ({ findOne: async () => snapshot })
    }
    return dataSource
}

function outbox() {
    const added = []
    return { added, add: async (_manager, billing) => billing && added.push(billing), flush: async () => {} }
}

const snapshot = (payMode, overrides = {}) => ({
    keyId: 99,
    msgId: 'm1',
    userKeyId: 4001,
    simbankKeyId: 3001,
    portKeyId: 2001,
    payMode,
    segments: 2,
    cost: 108200,
    ...overrides
})

test('后付供应商：写回 success 时同事务生成计费事件', async () => {
    const box = outbox()
    const sendTime = new Date('2026-10-28T02:00:00.000Z')
    const saved = await new DispatchSubmitRecorder(completeDataSource({ snapshot: snapshot('postpaid') }), {}, box).complete(99, {
        sendStatus: 'success',
        statusCode: 'OK',
        statusMessage: '',
        sendTime
    })
    assert.equal(saved, true)
    assert.equal(box.added.length, 1)
    assert.equal(box.added[0].eventId, 'm1:success')
    assert.equal(box.added[0].trigger, 'success')
    assert.equal(box.added[0].costUsd, 108200)
    assert.equal(box.added[0].occurredTime, '2026-10-28T02:00:00.000Z')
})

test('后付发送失败、预付发送成功、记录状态已被推进时都不在写回节点计费', async () => {
    const cases = [
        [{ snapshot: snapshot('postpaid') }, 'failed'],
        [{ snapshot: snapshot('prepaid') }, 'success'],
        [{ affected: 0, snapshot: snapshot('postpaid') }, 'success'],
        [{ snapshot: snapshot(null) }, 'success']
    ]
    for (const [options, sendStatus] of cases) {
        const box = outbox()
        await new DispatchSubmitRecorder(completeDataSource(options), {}, box).complete(99, {
            sendStatus,
            statusCode: 'X',
            statusMessage: '',
            sendTime: new Date()
        })
        assert.equal(box.added.length, 0, JSON.stringify({ options, sendStatus }))
    }
})

test('设备受理过的结果写回：预付补写受理计费（幂等），后付成功写成功计费，未受理不计费', async () => {
    const cases = [
        ['prepaid', 'failed', true, ['m1:submitted']],
        ['postpaid', 'success', true, ['m1:success']],
        ['prepaid', 'rejected', false, []]
    ]
    for (const [payMode, sendStatus, accepted, events] of cases) {
        const box = outbox()
        await new DispatchSubmitRecorder(completeDataSource({ snapshot: snapshot(payMode) }), {}, box).complete(99, {
            sendStatus,
            statusCode: 'X',
            statusMessage: '',
            sendTime: new Date(),
            accepted
        })
        assert.deepEqual(
            box.added.map(item => item.eventId),
            events,
            JSON.stringify({ payMode, sendStatus, accepted })
        )
    }
})

test('计费事件发件箱：发布成功标记已发布，失败记录原因等待补发', async () => {
    const { DispatchBillingOutbox } = require('../dist/modules/dispatch/dispatch.billing.outbox')
    const rows = [
        { keyId: 1, eventId: 'a:submitted', attempts: 0, payload: JSON.stringify({ eventId: 'a:submitted' }) },
        { keyId: 2, eventId: 'b:submitted', attempts: 3, payload: JSON.stringify({ eventId: 'b:submitted' }) }
    ]
    const updates = []
    const dataSource = {
        getRepository: () => ({
            find: async () => rows,
            update: async (where, values) => updates.push({ where, values })
        })
    }
    const published = []
    const rabbitmq = {
        publish: async (exchange, routingKey, payload, options) => {
            if (payload.eventId === 'b:submitted') throw new Error('RabbitMQ 通道尚未就绪')
            published.push({ exchange, routingKey, payload, options })
        }
    }
    await new DispatchBillingOutbox(dataSource, rabbitmq).flush()
    assert.deepEqual(
        published.map(item => [item.exchange, item.routingKey, item.options.messageId]),
        [['chat.sms.billing.exchange', 'sms.billing.srm.user', 'a:submitted']]
    )
    const failed = updates.find(item => item.where.keyId === 2)
    assert.equal(failed.values.attempts, 4)
    assert.match(failed.values.lastError, /尚未就绪/)
    const done = updates.find(item => item.values.status === 'published')
    assert.ok(done, '发布成功的事件标记为已发布')
})
