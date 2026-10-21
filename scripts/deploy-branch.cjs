const fs = require('node:fs')
const { execFileSync, spawnSync } = require('node:child_process')

/**
 * 一步完成发布：把当前分支合并到 main，并把当前分支快进到 main。
 *
 * 发布动作拆成三步：推送当前分支、通过 PR 合并到 main、再把当前分支快进到 main。
 * 第三步是必须的：GitHub 的 Merge commit 会在 main 上新建一条合并提交，
 * 当前分支指针不会移动，不快进就会一直显示 behind，其他设备同步不到最新代码。
 */

const MAIN_BRANCH = 'main'
const PACKAGE_FILE = 'package.json'

/** Windows 下 gh 是 .cmd，需要走 shell 才能找到；参数带空格时不能用 shell 拼接，因此这里解析出真实可执行文件路径。 */
function resolveCommand(command) {
    if (process.platform !== 'win32' || command !== 'gh') {
        return command
    }
    try {
        const found = execFileSync('where.exe', ['gh'], { encoding: 'utf8' })
            .split(/\r?\n/)
            .map(item => item.trim())
            .filter(Boolean)
        return found.find(item => item.toLowerCase().endsWith('.exe')) ?? found[0] ?? command
    } catch {
        return command
    }
}

/** 执行命令并返回标准输出。 */
function run(command, args) {
    return execFileSync(resolveCommand(command), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** 执行命令并直接输出到终端。参数不经过 shell，避免带空格的标题被拆成多个参数。 */
function runInherit(command, args) {
    const result = spawnSync(resolveCommand(command), args, { stdio: 'inherit' })
    if (result.error) {
        throw result.error
    }
    if (result.status !== 0) {
        throw new Error(`命令执行失败：${command} ${args.join(' ')}`)
    }
}

/** 当前分支名称。 */
function currentBranch() {
    return run('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
}

/** 工作区是否存在未提交改动。 */
function hasLocalChanges() {
    return run('git', ['status', '--porcelain']).length > 0
}

/** 统计两个提交之间的提交数量。 */
function countCommits(range) {
    return Number(run('git', ['rev-list', '--count', range]))
}

/** 读取当前分支已存在的待合并 PR 编号。 */
function findOpenPullRequest(branch) {
    const output = run('gh', ['pr', 'list', '--base', MAIN_BRANCH, '--head', branch, '--state', 'open', '--json', 'number'])
    const list = JSON.parse(output || '[]')
    return list.length > 0 ? list[0].number : undefined
}

/** 创建发布 PR 并返回编号。 */
function createPullRequest(branch, title) {
    runInherit('gh', ['pr', 'create', '--base', MAIN_BRANCH, '--head', branch, '--title', title, '--body', title])
    const number = findOpenPullRequest(branch)
    if (!number) {
        throw new Error('创建 PR 后未能读取到编号，请在 GitHub 上确认后重试')
    }
    return number
}

/** 读取 package.json 原文、缩进和换行符，改写后保持原有格式。 */
function readPackage() {
    const raw = fs.readFileSync(PACKAGE_FILE, 'utf8')
    const eol = raw.includes('\r\n') ? '\r\n' : '\n'
    const indentMatch = raw.match(/\n(\s+)"/)
    return { raw, eol, indent: indentMatch ? indentMatch[1].length : 4, json: JSON.parse(raw) }
}

/** 写回 package.json 的版本号。 */
function writeVersion(version) {
    const { eol, indent, json } = readPackage()
    json.version = version
    let next = JSON.stringify(json, null, indent) + '\n'
    if (eol === '\r\n') next = next.replace(/\n/g, '\r\n')
    fs.writeFileSync(PACKAGE_FILE, next)
}

/** 递增补丁号。 */
function bumpPatch(version) {
    const parts = version.split('.').map(Number)
    if (parts.length !== 3 || parts.some(item => !Number.isInteger(item))) {
        throw new Error(`package.json 版本号格式无效：${version}`)
    }
    return `${parts[0]}.${parts[1]}.${parts[2] + 1}`
}

/** main 上已发布的版本号；读取失败时返回 undefined。 */
function publishedVersion() {
    try {
        const raw = run('git', ['show', `origin/${MAIN_BRANCH}:${PACKAGE_FILE}`])
        return JSON.parse(raw).version
    } catch {
        return undefined
    }
}

/**
 * 准备本次发布的版本号。
 *
 * 只有当前版本号已经发布到 main 时才递增；若上一次发布失败，当前版本号还没进入 main，
 * 直接沿用同一个版本号重试，不会因为反复执行而把版本号越推越高。
 */
function prepareVersion() {
    const current = readPackage().json.version
    if (typeof current !== 'string' || current.length === 0) {
        return undefined
    }
    const published = publishedVersion()
    if (published !== current) {
        console.log(`沿用当前版本号 ${current}（上一次发布未进入 ${MAIN_BRANCH}）`)
        return current
    }
    const next = bumpPatch(current)
    writeVersion(next)
    runInherit('git', ['add', PACKAGE_FILE])
    runInherit('git', ['commit', '-m', `chore(release): v${next}`])
    console.log(`版本号 ${current} -> ${next}`)
    return next
}

function main() {
    const branch = currentBranch()
    if (branch === MAIN_BRANCH) {
        throw new Error(`当前已在 ${MAIN_BRANCH} 分支，发布必须在业务分支上执行`)
    }
    if (hasLocalChanges()) {
        throw new Error('工作区存在未提交改动，请先提交后再发布')
    }

    console.log(`[1/5] 同步远端分支信息`)
    runInherit('git', ['fetch', 'origin', MAIN_BRANCH, branch])

    console.log(`[2/5] 准备发布版本号`)
    const version = prepareVersion()

    console.log(`[3/5] 推送 ${branch} 到远端`)
    runInherit('git', ['push', 'origin', branch])
    runInherit('git', ['fetch', 'origin', MAIN_BRANCH, branch])
    const ahead = countCommits(`origin/${MAIN_BRANCH}..origin/${branch}`)

    if (ahead === 0) {
        console.log(`${branch} 没有需要发布的提交，跳过合并`)
    } else {
        console.log(`[4/5] ${branch} 有 ${ahead} 个提交待发布，合并到 ${MAIN_BRANCH}`)
        const title = version ? `release: v${version}` : `release: ${branch} 合并到 ${MAIN_BRANCH}`
        const existing = findOpenPullRequest(branch)
        const number = existing ?? createPullRequest(branch, title)
        console.log(`合并 PR #${number}`)
        runInherit('gh', ['pr', 'merge', String(number), '--merge', '--delete-branch=false'])
        runInherit('git', ['fetch', 'origin', MAIN_BRANCH])
    }

    console.log(`[5/5] 把 ${branch} 快进到 ${MAIN_BRANCH}`)
    const behind = countCommits(`${branch}..origin/${MAIN_BRANCH}`)
    if (behind === 0) {
        console.log(`${branch} 已与 ${MAIN_BRANCH} 保持一致`)
        return
    }
    runInherit('git', ['merge', '--ff-only', `origin/${MAIN_BRANCH}`])
    runInherit('git', ['push', 'origin', branch])
    console.log(`发布完成：${branch} 与 ${MAIN_BRANCH} 已一致`)
}

try {
    main()
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
}
