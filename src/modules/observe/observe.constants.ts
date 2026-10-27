/** Docker 内 Observe 默认地址：容器名 + TCP 端口。 */
export const OBSERVE_DEFAULT_HOST = 'chat-web-observe-service'
export const OBSERVE_DEFAULT_PORT = 5101
/** 单次 TCP 调用默认超时毫秒数。 */
export const OBSERVE_DEFAULT_TIMEOUT_MS = 5000

export interface ObserveClientOptions {
    host: string
    port: number
    timeout: number
}

/** 解析 Nacos `observe` 节点；未配置时使用 Docker 内默认地址。 */
export function resolveObserveClientConfig(config: unknown): ObserveClientOptions {
    const record = config && typeof config === 'object' && !Array.isArray(config) ? (config as Record<string, unknown>) : {}
    const host = typeof record.host === 'string' && record.host.trim() ? record.host.trim() : OBSERVE_DEFAULT_HOST
    const port = Number(record.port ?? OBSERVE_DEFAULT_PORT)
    const timeout = Number(record.timeout ?? OBSERVE_DEFAULT_TIMEOUT_MS)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Nacos observe.port 必须是 1-65535 之间的整数')
    if (!Number.isInteger(timeout) || timeout < 100) throw new Error('Nacos observe.timeout 必须是不小于 100 的整数毫秒数')
    return { host, port, timeout }
}
