#!/usr/bin/env node
/**
 * 打包前环境体检。10 秒内跑完，不构建、不修改任何东西。
 *
 * 目的：把「二十分钟后才发现打不了」的问题，提前到开打前暴露。
 *
 * 用法：
 *   node preflight.mjs --project-root <项目根> [--desktop-dir apps/desktop]
 *
 * 退出码：0 = 可以开打；1 = 有阻塞项；2 = 有警告但可继续。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

/** 一条检查结果。 */
const results = []
const push = (level, title, detail, fix) => results.push({ level, title, detail, fix })

/** 解析 --key value 形式的参数。 */
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else { out[key] = next; i++ }
  }
  return out
}

/** 读 JSON，失败返回 undefined。 */
function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined }
}

/** 把 ">=24.9" 这类约束粗略转成最低主版本号。 */
function minMajor(range) {
  if (typeof range !== 'string') return undefined
  const m = /(\d+)(?:\.(\d+))?/u.exec(range.replace(/[^0-9.]/gu, ' ').trim())
  return m ? Number(m[1]) : undefined
}

/** 主流程。 */
function main() {
  const args = parseArgs(process.argv.slice(2))
  const projectRoot = resolve(typeof args['project-root'] === 'string' ? args['project-root'] : '.')
  const desktopDir = resolve(projectRoot, typeof args['desktop-dir'] === 'string' ? args['desktop-dir'] : 'apps/desktop')

  // 1. 项目结构
  if (!existsSync(join(projectRoot, 'package.json'))) {
    push('block', '项目根没有 package.json', projectRoot, '用 --project-root 指向真正的项目根')
  }
  if (!existsSync(join(desktopDir, 'package.json'))) {
    push('block', '桌面端子目录没有 package.json', desktopDir, '用 --desktop-dir 指向含 package.json 的子目录')
  }

  // 2. Node 版本（优先读项目声明的 engines）
  const rootPkg = readJson(join(projectRoot, 'package.json'))
  const required = minMajor(rootPkg?.engines?.node)
  const current = Number(process.versions.node.split('.')[0])
  if (required !== undefined && current < required) {
    push('block', `Node 版本过低：需要 >= ${required}，当前 ${process.versions.node}`,
      '项目 engines 声明的版本比当前运行时高', '切到满足要求的 Node 再跑（多版本机器上常见）')
  } else if (required !== undefined) {
    push('ok', `Node 版本满足要求（>= ${required}，当前 ${process.versions.node}）`)
  } else {
    push('ok', `Node 版本 ${process.versions.node}（项目未声明 engines，跳过校验）`)
  }

  // 3. 路径长度：Windows 260 字符上限，构建输出会再叠加几十层
  const LONG_LIMIT = 120
  if (process.platform === 'win32' && projectRoot.length > LONG_LIMIT) {
    push('warn', `项目路径偏长（${projectRoot.length} 字符，阈值 ${LONG_LIMIT}）`,
      '构建输出会在此基础上继续叠加，容易触发 Windows 260 字符上限',
      '用 --build-root-var / --build-root-path 把构建输出指到短路径（如 C:\\build）')
  } else {
    push('ok', `项目路径长度 ${projectRoot.length} 字符，安全`)
  }

  // 4. 磁盘空间（构建中间产物通常是产物的 2 倍）
  try {
    const drive = projectRoot.slice(0, 2)
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `(Get-PSDrive ${drive[0]}).Free`], { encoding: 'utf8' }).trim()
    const freeGb = Number(out) / 1024 ** 3
    if (Number.isFinite(freeGb)) {
      if (freeGb < 5) push('block', `磁盘可用空间不足：${freeGb.toFixed(1)} GB`, `${drive} 剩余空间`, '至少留 10 GB')
      else if (freeGb < 15) push('warn', `磁盘可用空间偏紧：${freeGb.toFixed(1)} GB`, `${drive} 剩余空间`, '建议清出 15 GB 以上')
      else push('ok', `磁盘可用空间 ${freeGb.toFixed(1)} GB`)
    }
  } catch {
    push('warn', '读不到磁盘可用空间', 'PowerShell 调用失败', '手动确认剩余空间 > 15 GB')
  }

  // 5. 国内镜像（只提示，不修改）
  const mirrors = [
    ['ELECTRON_MIRROR', 'Electron 二进制镜像', 'https://npmmirror.com/mirrors/electron/'],
    ['npm_config_registry', 'npm 源', 'https://registry.npmmirror.com'],
  ]
  for (const [name, label, example] of mirrors) {
    const value = process.env[name]
    if (value === undefined || value === '') {
      push('warn', `${label}未设置（${name}）`, '默认会走境外源，国内大概率超时',
        `设 ${name} 指向国内镜像，例如 ${example}`)
    } else if (/npmmirror|taobao|aliyun|cnpm|huaweicloud|tencent/iu.test(value)) {
      push('ok', `${label}已是国内源：${value}`)
    } else {
      push('warn', `${label}指向境外源：${value}`, '可能超时', `换成国内镜像，例如 ${example}`)
    }
  }

  // 6. 包管理器与 tsx
  //    Windows 上 pnpm 是 .cmd，直接 execFile 找不到；优先用 pnpm.cjs + 当前 node 执行，
  //    既避开 shell 告警，也没有参数转义问题。
  const win = process.platform === 'win32'
  const pnpmEntry = win
    ? join(dirname(process.execPath), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    : undefined
  const pnpmProbe = pnpmEntry !== undefined && existsSync(pnpmEntry)
    ? { cmd: process.execPath, args: [pnpmEntry, '--version'] }
    : { cmd: win ? 'pnpm.cmd' : 'pnpm', args: ['--version'] }
  try {
    const v = execFileSync(pnpmProbe.cmd, pnpmProbe.args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: pnpmProbe.cmd === 'pnpm.cmd',
    }).trim()
    push('ok', `包管理器 pnpm 可用（${v}）`)
  } catch {
    push('block', '包管理器 pnpm 不在 PATH 里', '命令执行失败', '安装 pnpm 并确认在 PATH 中')
  }
  try {
    const v = execFileSync('node', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    push('ok', `Node 可用（${v}）`)
  } catch {
    push('block', 'Node 不在 PATH 里', '命令执行失败', '安装 Node 并确认在 PATH 中')
  }

  // 7. 构建脚本是否存在
  const desktopPkg = readJson(join(desktopDir, 'package.json'))
  const scripts = desktopPkg?.scripts ?? {}
  const wanted = ['package', 'package:dir']
  const found = wanted.filter(name => typeof scripts[name] === 'string')
  if (found.length === 0) {
    push('warn', '桌面端子目录没有 package / package:dir 脚本', Object.keys(scripts).join(', ').slice(0, 200),
      '确认 --script 要传的脚本名')
  } else {
    push('ok', `可用打包脚本：${found.join(' / ')}`)
  }

  // 8. 上次构建残留（可能触发批量删除拦截）
  const buildRoot = join(desktopDir, '.desktop-build')
  if (existsSync(buildRoot)) {
    let count = 0
    try {
      const walk = (dir) => {
        for (const entry of readdirSyncSafe(dir)) {
          count++
          if (count > 5000) return
          const full = join(dir, entry)
          try { if (statSync(full).isDirectory()) walk(full) } catch { /* 忽略 */ }
        }
      }
      walk(buildRoot)
      if (count > 50) {
        push('warn', `上次构建残留 ${count}+ 个条目（${buildRoot}）`,
          '构建开始前会清空这些目录，条目过多可能被安全策略拦截',
          '用 package.mjs 的 --park-dir 先把它们挪走，或手动清理')
      } else {
        push('ok', '构建残留很少，不会触发批量删除拦截')
      }
    } catch {
      push('ok', '构建目录存在（未能统计条目数）')
    }
  } else {
    push('ok', '首次构建（无残留）')
  }

  // 输出
  const icon = { ok: '✓', warn: '!', block: '✗' }
  console.log('='.repeat(72))
  console.log('打包环境体检')
  console.log('='.repeat(72))
  for (const r of results) {
    console.log(`${icon[r.level]} ${r.title}`)
    if (r.level !== 'ok' && r.detail) console.log(`    现象：${r.detail}`)
    if (r.level !== 'ok' && r.fix) console.log(`    处理：${r.fix}`)
  }
  const blocks = results.filter(r => r.level === 'block').length
  const warns = results.filter(r => r.level === 'warn').length
  console.log('-'.repeat(72))
  console.log(`阻塞 ${blocks} 项 / 警告 ${warns} 项 / 通过 ${results.filter(r => r.level === 'ok').length} 项`)
  if (blocks > 0) { console.log('结论：先修阻塞项再打包'); return 1 }
  if (warns > 0) { console.log('结论：可以打，但建议先处理警告'); return 2 }
  console.log('结论：环境就绪，可以打包')
  return 0
}

/** readdirSync 的安全包装：目录读不到时返回空数组，不抛。 */
function readdirSyncSafe(dir) {
  try { return readdirSync(dir) } catch { return [] }
}

process.exitCode = main()
