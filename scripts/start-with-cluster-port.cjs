'use strict'

const crypto = require('node:crypto')
const net = require('node:net')
const { spawn } = require('node:child_process')

const DEFAULT_CLUSTER_PORT = 7777
const RANDOM_PORT_MIN = 20_000
const RANDOM_PORT_MAX = 45_000
const RANDOM_PORT_ATTEMPTS = 20

function parsePort(value) {
    if (value === undefined || value === '') return DEFAULT_CLUSTER_PORT
    const port = Number(value)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error('NODE_CLUSTER_CLIENT_PORT 必须是 1-65535 之间的整数')
    }
    return port
}

/** 检测端口是否可以由当前进程独占监听。 */
function isPortAvailable(port) {
    return new Promise((resolve, reject) => {
        const server = net.createServer()
        const onError = error => {
            server.close()
            if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false)
            else reject(error)
        }
        server.once('error', onError)
        server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
            server.close(error => {
                if (error) reject(error)
                else resolve(true)
            })
        })
    })
}

/** 默认端口冲突时随机选择一个本机可用端口。 */
async function resolveClusterPort(configuredPort) {
    const preferredPort = parsePort(configuredPort)
    if (await isPortAvailable(preferredPort)) return { port: preferredPort, changed: false }

    for (let attempt = 0; attempt < RANDOM_PORT_ATTEMPTS; attempt += 1) {
        const candidate = crypto.randomInt(RANDOM_PORT_MIN, RANDOM_PORT_MAX + 1)
        if (await isPortAvailable(candidate)) return { port: candidate, changed: true }
    }

    throw new Error(`Nacos 供应商端端口 ${preferredPort} 已被占用，且未找到可用的随机端口`)
}

async function main() {
    const args = process.argv.slice(2)
    if (!args.length) throw new Error('缺少 Nest 启动参数')

    const preferredPort = parsePort(process.env.NODE_CLUSTER_CLIENT_PORT)
    const resolved = await resolveClusterPort(preferredPort)
    process.env.NODE_CLUSTER_CLIENT_PORT = String(resolved.port)
    if (resolved.changed) {
        process.stderr.write(`Nacos 供应商端端口 ${preferredPort} 冲突，已切换到随机端口 ${resolved.port}\n`)
    }

    const nestCli = require.resolve('@nestjs/cli/bin/nest.js')
    const child = spawn(process.execPath, [nestCli, ...args], {
        env: process.env,
        stdio: 'inherit'
    })
    child.once('error', error => {
        process.stderr.write(`${error.message}\n`)
        process.exitCode = 1
    })
    child.once('exit', (code, signal) => {
        process.exitCode = typeof code === 'number' ? code : signal ? 1 : 0
    })
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
        process.exitCode = 1
    })
}

module.exports = { isPortAvailable, parsePort, resolveClusterPort }
