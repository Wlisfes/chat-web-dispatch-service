const test = require('node:test')
const assert = require('node:assert/strict')
const {
    createDispatchConfig,
    ensureGatewayRoute,
    ensureSrmDatabaseConfig,
    ensureWalletRedisConfig,
    financeConfigDataId,
    validateDispatchConfig
} = require('../deploy/bootstrap-nacos-config.cjs')

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

const finance = `redis:
  host: chat-web-redis
  port: 6379
  database: 3
  password: "secret"
`

const environment = {
    DISPATCH_MYSQL_DATABASE: 'chat-web-srm',
    DISPATCH_MYSQL_USERNAME: 'chat_web_dispatch_service',
    DISPATCH_MYSQL_PASSWORD: 'secret-pass',
    DISPATCH_MYSQL_HOST: 'mysql'
}

test('Dispatch Nacos 配置连接 SRM 库并把 Redis 固定到 index 5', () => {
    const content = ensureWalletRedisConfig(createDispatchConfig(source, environment), finance)
    validateDispatchConfig(content)
    assert.match(content, /walletRedis:\n  host: chat-web-redis\n  port: 6379\n  database: 3/)
    assert.match(content, /port: 5080/)
    assert.match(content, /chat-web-srm:/)
    assert.match(content, /username: "chat_web_dispatch_service"/)
    assert.match(content, /database: 5/)
    assert.doesNotMatch(content, /chat-web-dispatch:/)
    assert.throws(
        () => createDispatchConfig(source, { ...environment, DISPATCH_MYSQL_DATABASE: 'chat-web-dispatch' }),
        /必须为 chat-web-srm/
    )
})

test('旧 Dispatch 配置会把数据库连接替换为 SRM 库并保留其他配置', () => {
    const existing = `server:
  port: 5080
gateway:
  feign:
    service_token: token
  principal:
    secret: secret
database:
  chat-web-dispatch:
    host: mysql
    database: chat-web-dispatch
    username: chat_web_dispatch_service
    password: old-pass
redis:
  database: 5
`
    const updated = ensureWalletRedisConfig(ensureSrmDatabaseConfig(existing, environment), finance)
    validateDispatchConfig(updated)
    assert.match(updated, /chat-web-srm:/)
    assert.match(updated, /database: "chat-web-srm"/)
    assert.doesNotMatch(updated, /chat-web-dispatch:/)
    assert.match(updated, /redis:\n  database: 5/)
    assert.equal(ensureWalletRedisConfig(ensureSrmDatabaseConfig(updated, environment), finance), updated)
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

test('开发环境 Dispatch 从开发环境 Finance 配置复制钱包 Redis', () => {
    assert.equal(financeConfigDataId('chat-web-dispatch-service-development.yaml'), 'chat-web-finance-service-development.yaml')
    assert.equal(financeConfigDataId('chat-web-dispatch-service.yaml'), 'chat-web-finance-service.yaml')
})
