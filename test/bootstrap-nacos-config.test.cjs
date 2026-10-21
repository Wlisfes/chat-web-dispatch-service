const test = require('node:test')
const assert = require('node:assert/strict')
const { createDispatchConfig, ensureGatewayRoute, validateDispatchConfig } = require('../deploy/bootstrap-nacos-config.cjs')

const source = `server:
  port: 5070
gateway:
  feign:
    service_token: "token"
    url: http://chat-web-gateway-service:5000
    timeout: 3000
  principal:
    secret: "secret"
    maxAgeSeconds: 60
database:
  chat-web-srm:
    host: mysql
redis:
  host: chat-web-redis
  port: 6379
  database: 4
  password: ""
`

test('Dispatch Nacos 配置复制网关凭据并把 Redis 固定到 index 5', () => {
    const content = createDispatchConfig(source, {
        DISPATCH_MYSQL_DATABASE: 'chat-web-dispatch',
        DISPATCH_MYSQL_USERNAME: 'chat_web_dispatch_service',
        DISPATCH_MYSQL_PASSWORD: 'secret-pass',
        DISPATCH_MYSQL_HOST: 'mysql'
    })
    validateDispatchConfig(content)
    assert.match(content, /port: 5080/)
    assert.match(content, /chat-web-dispatch:/)
    assert.match(content, /database: 5/)
    assert.doesNotMatch(content, /chat-web-srm:/)
    assert.throws(() => createDispatchConfig(source, { DISPATCH_MYSQL_DATABASE: 'chat-web-srm' }), /必须为 chat-web-dispatch/)
})

test('网关配置缺少 Dispatch 路由时追加，重复执行不覆盖', () => {
    const gateway = `gateway:\n  routes:\n    - id: srm\n      prefix: /api/srm\n    - id: feign-srm\n      prefix: /feign/srm\n`
    const route = {
        id: 'dispatch',
        prefix: '/api/dispatch',
        serviceName: 'chat-web-dispatch-service',
        fallbackUrl: 'http://chat-web-dispatch-service:5080'
    }
    const once = ensureGatewayRoute(gateway, route)
    assert.match(once, /prefix: \/api\/dispatch/)
    assert.equal(ensureGatewayRoute(once, route), once)
})
