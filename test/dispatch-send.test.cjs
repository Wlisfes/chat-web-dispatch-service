const test = require('node:test')
const assert = require('node:assert/strict')
const { DispatchSendService } = require('../dist/modules/dispatch/dispatch.send.service')
const { DispatchSubmitRecorder } = require('../dist/modules/dispatch/dispatch.submit.service')

const record = { keyId: 99, portKeyId: 2001, simbankKeyId: 3001, sendStatus: 'submitted' }

function recorder(affected = 1) {
    const calls = []
    return { calls, complete: async (keyId, outcome) => (calls.push({ keyId, outcome }), affected > 0) }
}

test('Observe 返回成功时写回 success 和设备结果', async () => {
    let request
    const observe = {
        submit: async payload => {
            request = payload
            return {
                msgId: payload.msgId,
                sendStatus: 'success',
                statusCode: 'OK',
                statusMessage: '模拟设备发送成功',
                sendTime: '2026-10-27T15:00:00.000Z'
            }
        }
    }
    const rec = recorder()
    const outcome = await new DispatchSendService(observe, rec).send('m1', record)
    assert.deepEqual(request, { msgId: 'm1', msgKeyId: 99, simbankKeyId: 3001, portKeyId: 2001 })
    assert.equal(outcome.sendStatus, 'success')
    assert.equal(outcome.saved, true)
    assert.equal(rec.calls[0].keyId, 99)
    assert.equal(rec.calls[0].outcome.statusCode, 'OK')
    assert.equal(rec.calls[0].outcome.sendTime.toISOString(), '2026-10-27T15:00:00.000Z')
})

test('Observe 返回失败时写回 failed 和失败原因', async () => {
    const observe = {
        submit: async () => ({ sendStatus: 'failed', statusCode: 'PORT_OFFLINE', statusMessage: '端口离线', sendTime: 'bad' })
    }
    const rec = recorder()
    const outcome = await new DispatchSendService(observe, rec).send('m1', record)
    assert.equal(outcome.sendStatus, 'failed')
    assert.equal(rec.calls[0].outcome.statusMessage, '端口离线')
    assert.ok(rec.calls[0].outcome.sendTime instanceof Date)
})

test('Observe 不可用时记为提交失败，不抛错', async () => {
    const observe = {
        submit: async () => {
            throw new Error('connect ECONNREFUSED')
        }
    }
    const rec = recorder()
    const outcome = await new DispatchSendService(observe, rec).send('m1', record)
    assert.equal(outcome.sendStatus, 'rejected')
    assert.equal(outcome.statusCode, 'OBSERVE_UNAVAILABLE')
    assert.match(rec.calls[0].outcome.statusMessage, /ECONNREFUSED/)
})

test('重投时已有最终结果的记录跳过发送', async () => {
    let called = false
    const observe = {
        submit: async () => {
            called = true
        }
    }
    const rec = recorder()
    const outcome = await new DispatchSendService(observe, rec).send('m1', { ...record, sendStatus: 'success' })
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
