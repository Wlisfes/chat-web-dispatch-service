'use strict'

/** 部署前准备 Dispatch Nacos 配置，并给网关追加 /api/dispatch 与 /feign/dispatch。已有配置只补齐 SRM 库连接和钱包 Redis，不覆盖其他配置。 */

function required(name, environment = process.env) {
    const value = environment[name]
    if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少环境变量：${name}`)
    return value.trim()
}

function scalar(value) {
    return JSON.stringify(value)
}

function getBaseUrl(environment = process.env) {
    const server = required('NACOS_SERVER', environment)
    return (/^https?:\/\//i.test(server) ? server : `http://${server}`).replace(/\/$/, '')
}

async function getNacosAccessToken(environment = process.env) {
    const username = environment.NACOS_USERNAME?.trim()
    const password = environment.NACOS_PASSWORD
    if (!username || password === undefined) return undefined
    const response = await fetch(`${getBaseUrl(environment)}/nacos/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username, password })
    })
    if (!response.ok) throw new Error(`Nacos 鉴权失败：HTTP ${response.status}`)
    const result = await response.json()
    if (typeof result.accessToken !== 'string' || !result.accessToken.trim()) throw new Error('Nacos 鉴权响应缺少 accessToken')
    return result.accessToken
}

async function configUrl(dataId, environment = process.env) {
    const parameters = new URLSearchParams({
        dataId,
        group: environment.NACOS_CONFIG_GROUP?.trim() || 'DEFAULT_GROUP',
        tenant: environment.NACOS_NAMESPACE?.trim() || 'public'
    })
    const accessToken = await getNacosAccessToken(environment)
    if (accessToken) parameters.set('accessToken', accessToken)
    return `${getBaseUrl(environment)}/nacos/v1/cs/configs?${parameters}`
}

async function readConfig(dataId, environment = process.env) {
    const response = await fetch(await configUrl(dataId, environment))
    if (response.status === 404) return undefined
    if (!response.ok) throw new Error(`读取 Nacos 配置失败：${dataId} HTTP ${response.status}`)
    const content = await response.text()
    return content.trim() ? content.replace(/\r\n?/g, '\n') : undefined
}

async function writeConfig(dataId, content, environment = process.env) {
    const response = await fetch(await configUrl(dataId, environment), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ content })
    })
    if (!response.ok) throw new Error(`写入 Nacos 配置失败：${dataId} HTTP ${response.status}`)
}

function topLevelBlock(content, name) {
    const lines = content.replace(/\r\n?/g, '\n').split('\n')
    const start = lines.findIndex(line => line === `${name}:`)
    if (start < 0) return undefined
    let end = lines.findIndex((line, index) => index > start && line.trim() && !line.startsWith(' ') && !line.startsWith('#'))
    if (end < 0) end = lines.length
    return lines.slice(start, end).join('\n').trimEnd()
}

function createDispatchConfig(source, environment = process.env) {
    const gateway = topLevelBlock(source, 'gateway')
    const redis = topLevelBlock(source, 'redis')
    if (!gateway || !redis) throw new Error('来源 Nacos 配置缺少 gateway 或 redis，无法生成 Dispatch 配置')
    const database = required('DISPATCH_MYSQL_DATABASE', environment)
    if (database !== 'chat-web-srm') throw new Error('DISPATCH_MYSQL_DATABASE 必须为 chat-web-srm')
    return `# 服务监听配置。
server:
  # 容器内 HTTP 监听端口。
  port: 5080

# 服务间调用与网关身份上下文验签配置；从现有服务复制，必须与 Gateway 保持一致。
${gateway}

# Dispatch 读写 SRM 设备短信记录；账号只授权 tb_srm_simbank_message。
${databaseConfig(environment)}
# Redis 连接配置；Dispatch 独占 index 5。
${redis.replace(/database:\s*\d+/, 'database: 5')}
`
}

function databaseConfig(environment = process.env) {
    const database = required('DISPATCH_MYSQL_DATABASE', environment)
    if (database !== 'chat-web-srm') throw new Error('DISPATCH_MYSQL_DATABASE 必须为 chat-web-srm')
    return `database:
  chat-web-srm:
    host: ${scalar(environment.DISPATCH_MYSQL_HOST?.trim() || 'mysql')}
    port: ${Number(environment.DISPATCH_MYSQL_PORT || 3306)}
    database: ${scalar(database)}
    username: ${scalar(required('DISPATCH_MYSQL_USERNAME', environment))}
    password: ${scalar(required('DISPATCH_MYSQL_PASSWORD', environment))}
    charset: "utf8mb4"
    timezone: "+08:00"
`
}

/** 旧配置连接 chat-web-dispatch 时替换为 SRM 库；已有 chat-web-srm 时保留人工配置。 */
function ensureSrmDatabaseConfig(content, environment = process.env) {
    if (content.includes('chat-web-srm:')) return content
    const lines = content.replace(/\r\n?/g, '\n').split('\n')
    const start = lines.findIndex(line => line === 'database:')
    if (start < 0) return `${content.trimEnd()}\n\n# Dispatch 读写 SRM 设备短信记录；账号只授权 tb_srm_simbank_message。\n${databaseConfig(environment)}`
    let end = start + 1
    while (end < lines.length && (!lines[end] || /^\s/.test(lines[end]))) end += 1
    const replacement = databaseConfig(environment).trimEnd().split('\n')
    lines.splice(start, end - start, ...replacement)
    return `${lines.join('\n').replace(/\n*$/, '')}\n`
}

/** 从 Finance 配置复制 Redis 连接，生成 Dispatch 读取供应商钱包余额使用的 walletRedis 节点。 */
function walletRedisConfig(source) {
    const redis = topLevelBlock(source, 'redis')
    if (!redis) throw new Error('chat-web-finance-service.yaml 缺少 redis，无法生成 Dispatch walletRedis')
    return redis.replace(/^redis:/, 'walletRedis:').replace(/^(\s{2}database:\s*)\d+\s*$/m, '$13')
}

/** 已有 walletRedis 时保留人工配置；缺少时追加到末尾。 */
function ensureWalletRedisConfig(content, source) {
    if (topLevelBlock(content, 'walletRedis')) return content
    return `${content.trimEnd()}\n\n# 读取 Finance 供应商钱包余额；database 必须固定为 3。\n${walletRedisConfig(source)}\n`
}

function validateDispatchConfig(content, dataId = 'chat-web-dispatch-service.yaml') {
    const port = dataId.endsWith('-development.yaml') ? 5081 : 5080
    if (!new RegExp(`^\\s{2}port:\\s*${port}\\s*$`, 'm').test(content)) throw new Error(`Dispatch Nacos 配置缺少 server.port: ${port}`)
    if (!content.includes('chat-web-srm:')) throw new Error('Dispatch Nacos 配置缺少 database.chat-web-srm')
    if (!/database:\s*5/.test(content)) throw new Error('Dispatch Redis database 必须为 5')
    const walletRedis = topLevelBlock(content, 'walletRedis')
    if (!walletRedis) throw new Error('Dispatch Nacos 配置缺少 walletRedis')
    if (!/^\s{2}database:\s*3\s*$/m.test(walletRedis)) throw new Error('Dispatch walletRedis database 必须为 3')
    if (!content.includes('service_token:') || !content.includes('secret:')) throw new Error('Dispatch Nacos 配置缺少网关凭据')
    return content
}

function ensureGatewayRoute(content, route, marker = '    - id: srm\n') {
    if (content.includes(`prefix: ${route.prefix}`) || content.includes(`prefix: "${route.prefix}"`)) return content
    const block = [
        `    - id: ${route.id}`,
        `      prefix: ${route.prefix}`,
        `      serviceName: ${route.serviceName}`,
        `      fallbackUrl: ${route.fallbackUrl}`,
        '      fallbackEnabled: false',
        '      enabled: true',
        ''
    ].join('\n')
    if (content.includes(marker)) return content.replace(marker, `${block}${marker}`)
    const routesHeader = 'routes:\n'
    const routesAt = content.indexOf(routesHeader)
    if (routesAt < 0) throw new Error(`网关配置缺少 routes，无法追加 ${route.prefix}`)
    const insertAt = routesAt + routesHeader.length
    return `${content.slice(0, insertAt)}${block}${content.slice(insertAt)}`
}

const DISPATCH_ROUTES = [
    {
        id: 'dispatch',
        prefix: '/api/dispatch',
        serviceName: 'chat-web-dispatch-service',
        fallbackUrl: 'http://chat-web-dispatch-service:5080'
    },
    {
        id: 'feign-dispatch',
        prefix: '/feign/dispatch',
        serviceName: 'chat-web-dispatch-service',
        fallbackUrl: 'http://chat-web-dispatch-service:5080'
    }
]

/** Dispatch 使用 development Data ID 时读取同环境 Finance 配置，避免把容器内 Redis 地址写入本地开发配置。 */
function financeConfigDataId(dispatchDataId) {
    return dispatchDataId.endsWith('-development.yaml') ? 'chat-web-finance-service-development.yaml' : 'chat-web-finance-service.yaml'
}

async function ensureDispatchConfig(environment = process.env) {
    const dataId = environment.NACOS_CONFIG_DATA_ID?.trim() || 'chat-web-dispatch-service.yaml'
    const existing = await readConfig(dataId, environment)
    const financeDataId = financeConfigDataId(dataId)
    const finance = await readConfig(financeDataId, environment)
    if (!finance) throw new Error(`未找到 ${financeDataId}，无法复制钱包 Redis 配置`)
    if (existing) {
        const updated = ensureWalletRedisConfig(ensureSrmDatabaseConfig(existing, environment), finance)
        validateDispatchConfig(updated, dataId)
        if (updated !== existing) await writeConfig(dataId, updated, environment)
        return false
    }
    const source = await readConfig('chat-web-srm-service.yaml', environment)
    if (!source) throw new Error('未找到 chat-web-srm-service.yaml，无法复制网关和 Redis 配置')
    const content = validateDispatchConfig(ensureWalletRedisConfig(createDispatchConfig(source, environment), finance), dataId)
    await writeConfig(dataId, content, environment)
    return true
}

async function ensureGatewayRoutes(environment = process.env) {
    const dataIds = ['chat-web-gateway-service.yaml', 'chat-web-gateway-service-development.yaml']
    for (const dataId of dataIds) {
        const existing = await readConfig(dataId, environment)
        if (!existing) continue
        const updated = DISPATCH_ROUTES.reduce(
            (content, route) => ensureGatewayRoute(content, route, route.prefix.startsWith('/feign/') ? '    - id: feign-srm\n' : '    - id: srm\n'),
            existing
        )
        if (updated !== existing) await writeConfig(dataId, updated, environment)
    }
}

async function main() {
    const created = await ensureDispatchConfig()
    await ensureGatewayRoutes()
    process.stdout.write(created ? 'Dispatch Nacos 配置已创建，网关路由已检查\n' : 'Dispatch Nacos 配置已存在且校验通过，网关路由已检查\n')
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
        process.exitCode = 1
    })
}

module.exports = {
    createDispatchConfig,
    ensureGatewayRoute,
    ensureSrmDatabaseConfig,
    ensureWalletRedisConfig,
    financeConfigDataId,
    validateDispatchConfig,
    walletRedisConfig,
    DISPATCH_ROUTES
}