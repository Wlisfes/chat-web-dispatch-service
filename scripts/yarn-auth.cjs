const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const GITHUB_PACKAGES_HOST = 'npm.pkg.github.com'
const GITHUB_PACKAGES_REGISTRY = `https://${GITHUB_PACKAGES_HOST}`
const AUTH_CHECK_URL = `${GITHUB_PACKAGES_REGISTRY}/@wlisfes%2fchat-web-base-schema`
const AUTH_LINE_PATTERN = /^\s*\/\/npm\.pkg\.github\.com\/:_authToken\s*=\s*(.+?)\s*$/i

function getUserConfigPath() {
    return process.env.NPM_CONFIG_USERCONFIG || process.env.npm_config_userconfig || path.join(os.homedir(), '.npmrc')
}

function readUserConfig() {
    try {
        return fs.readFileSync(getUserConfigPath(), 'utf8')
    } catch {
        return ''
    }
}

function expandEnvironmentVariables(value) {
    return value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? '')
}

function getUserConfigToken(userConfig) {
    for (const line of userConfig.split(/\r?\n/)) {
        const match = line.match(AUTH_LINE_PATTERN)

        if (match) {
            const token = expandEnvironmentVariables(match[1].replace(/^(['"])(.*)\1$/, '$2')).trim()
            return token || undefined
        }
    }

    return undefined
}

function getGitHubCliToken() {
    const result = spawnSync('gh', ['auth', 'token', '--hostname', 'github.com'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true
    })
    const token = result.stdout?.trim()

    return result.status === 0 && token ? token : undefined
}

function getTokenCandidates(userConfig) {
    const candidates = [
        { source: 'NODE_AUTH_TOKEN', token: process.env.NODE_AUTH_TOKEN?.trim() },
        { source: '用户级 .npmrc', token: getUserConfigToken(userConfig) },
        { source: 'GitHub CLI', token: getGitHubCliToken() }
    ]
    const seen = new Set()

    return candidates.filter(candidate => {
        if (!candidate.token || seen.has(candidate.token)) {
            return false
        }

        seen.add(candidate.token)
        return true
    })
}

async function checkToken(token) {
    try {
        const response = await fetch(AUTH_CHECK_URL, {
            headers: {
                Accept: 'application/vnd.npm.install-v1+json',
                Authorization: `Bearer ${token}`
            },
            signal: AbortSignal.timeout(10000)
        })

        await response.body?.cancel()

        if (response.ok) {
            return 'valid'
        }

        return response.status === 401 || response.status === 403 ? 'invalid' : 'unknown'
    } catch {
        return 'unknown'
    }
}

async function resolveAuthToken(userConfig) {
    const candidates = getTokenCandidates(userConfig)
    const rejectedSources = []
    let fallback

    for (const candidate of candidates) {
        const status = await checkToken(candidate.token)

        if (status === 'valid') {
            return candidate.token
        }

        if (status === 'invalid') {
            rejectedSources.push(candidate.source)
        } else if (!fallback) {
            fallback = candidate
        }
    }

    if (fallback) {
        console.warn(`无法验证 GitHub Packages 凭据，将继续使用 ${fallback.source}。`)
        return fallback.token
    }

    const detail = rejectedSources.length ? `已拒绝：${rejectedSources.join('、')}。` : ''
    throw new Error(
        `未找到可访问 GitHub Packages 的凭据。${detail}请执行 gh auth refresh -h github.com -s read:packages，或在用户级 .npmrc 中配置具有 read:packages 权限的 //npm.pkg.github.com/:_authToken。`
    )
}

function createUserConfig(userConfig) {
    const lines = userConfig.split(/\r?\n/).filter(line => !AUTH_LINE_PATTERN.test(line) && !/^\s*@wlisfes:registry\s*=/i.test(line))

    while (lines.at(-1) === '') {
        lines.pop()
    }

    return [
        ...lines,
        `@wlisfes:registry=${GITHUB_PACKAGES_REGISTRY}`,
        `//${GITHUB_PACKAGES_HOST}/:_authToken=\${NODE_AUTH_TOKEN}`,
        'always-auth=true',
        ''
    ].join('\n')
}

function resolveYarnCli() {
    if (process.env.npm_execpath) {
        return process.env.npm_execpath
    }

    if (process.platform !== 'win32') {
        return undefined
    }

    const result = spawnSync('where.exe', ['yarn.cmd'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true
    })
    const launchers = result.stdout?.split(/\r?\n/).filter(Boolean) ?? []

    for (const launcher of launchers) {
        const yarnCli = path.join(path.dirname(launcher), 'node_modules', 'yarn', 'bin', 'yarn.js')
        if (fs.existsSync(yarnCli)) {
            return yarnCli
        }
    }

    throw new Error('未找到 Yarn 1.x CLI，请确认 yarn 命令已正确安装。')
}

function runYarn(args, env) {
    const yarnCli = resolveYarnCli()

    if (yarnCli) {
        return spawnSync(process.execPath, [yarnCli, ...args], {
            env,
            stdio: 'inherit',
            windowsHide: true
        })
    }

    return spawnSync('yarn', args, {
        env,
        stdio: 'inherit',
        windowsHide: true
    })
}

async function main() {
    const args = process.argv.slice(2)
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-web-yarn-'))
    const tempUserConfig = path.join(tempDirectory, '.npmrc')

    try {
        const userConfig = readUserConfig()
        const token = await resolveAuthToken(userConfig)
        const environment = {
            ...process.env,
            NODE_AUTH_TOKEN: token,
            NPM_CONFIG_USERCONFIG: tempUserConfig
        }

        delete environment.npm_config_userconfig
        fs.writeFileSync(tempUserConfig, createUserConfig(userConfig), {
            mode: 0o600
        })

        const result = runYarn(args, environment)

        if (result.error) {
            throw result.error
        }

        process.exitCode = result.status ?? 1
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
    } finally {
        fs.rmSync(tempDirectory, { recursive: true, force: true })
    }
}

void main()
