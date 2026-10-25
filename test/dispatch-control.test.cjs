const test = require('node:test')
const assert = require('node:assert/strict')
const { parseChannel, parseNotify, planReconcile, localActions, isStale } = require('../dist/modules/dispatch/dispatch.control')
const { redisConnectionUrl } = require('../dist/modules/dispatch/dispatch.notifier')

function channel(alias, version, status = 'enable', deleted = false) {
    return {
        channelKeyId: 1,
        alias,
        queue: `chat.sms.channel.${alias}`,
        type: 'sms',
        countryKeyId: 86,
        status,
        sendInterval: 1000,
        maxRetry: 3,
        deleted,
        version
    }
}

test('损坏的 Redis 副本不能被当成删除', () => {
    const local = new Map([['a', channel('a', 2)]])
    const plan = planReconcile(local, { a: '{', b: JSON.stringify(channel('b', 1)) })
    assert.deepEqual(
        plan.adopt.map(item => item.alias),
        ['b']
    )
    assert.deepEqual(plan.remove, [])
})

test('对账只采纳更新的副本，并删除 Redis 中已经不存在的通道', () => {
    const local = new Map([
        ['old', channel('old', 1)],
        ['same', channel('same', 3, 'enable')],
        ['newer', channel('newer', 5)]
    ])
    const plan = planReconcile(local, {
        same: JSON.stringify(channel('same', 3, 'disable')),
        newer: JSON.stringify(channel('newer', 4, 'disable')),
        added: JSON.stringify(channel('added', 2))
    })
    assert.deepEqual(
        plan.adopt.map(item => item.alias),
        ['added']
    )
    assert.deepEqual(
        plan.remove.map(item => item.alias),
        ['old']
    )
    assert.deepEqual(
        plan.repair.map(item => item.alias),
        ['same', 'newer']
    )
    assert.equal(plan.repair.find(item => item.alias === 'same').status, 'disable')
    assert.equal(plan.repair.find(item => item.alias === 'newer').status, 'enable')
    assert.equal(isStale(channel('a', 3), 3), true)
    assert.equal(isStale(channel('a', 3), 4), false)
})

test('通知和副本缺字段时忽略', () => {
    assert.equal(parseNotify('{"alias":"a","version":1}'), undefined)
    assert.deepEqual(parseNotify('{"alias":"a","version":2,"deleted":true}'), { alias: 'a', version: 2, deleted: true })
    assert.equal(parseChannel('{"alias":"a","version":1,"deleted":false}').queue, 'chat.sms.channel.a')
    assert.equal(parseChannel('not-json'), undefined)
})

test('Redis 通知连接地址编码凭据且不改库号', () => {
    const url = redisConnectionUrl({
        host: 'chat-web-redis',
        port: '6379',
        database: 5,
        username: 'dispatch',
        password: 'a@b c',
        tls: false
    })
    assert.equal(url, 'redis://dispatch:a%40b%20c@chat-web-redis:6379/5')
})

test('Redis 中已删除的通道即使版本相同也要取消订阅', () => {
    const gone = channel('gone', 4)
    const plan = planReconcile(new Map([['gone', gone]]), {})
    assert.deepEqual(
        localActions(plan).map(action => action.type + ':' + action.channel.alias),
        ['drop:gone']
    )
    assert.equal(isStale(gone, gone.version), true)
})
