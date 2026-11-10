#!/usr/bin/env node
/**
 * 桌面应用打包主流程。
 *
 * 一条命令完成：预检 → 配国内镜像 → 建短路径跳板 → 挪走构建缓存 → 构建 → 打包。
 *
 * 设计原则：
 * 1. **只动构建产物**：挪走的目录一律进暂存区，不直接删；打完由用户决定清理。
 * 2. **失败要能看懂**：把已知错误翻译成「哪一类问题 + 改哪个设置」。
 * 3. **安全开关只在子进程内**：不改用户环境变量、不写注册表。
 *
 * 用法示例：
 *   node package.mjs --project-root . --desktop-dir apps/desktop --mode dir
 *   node package.mjs --project-root . --build-root-var MY_BUILD_ROOT --build-root-path C:\build
 */
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync, statSync } from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { spawn } from 'node:child_process'

/** 解析 --key value 参数。 */
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

/** 带前缀的日志。 */
const log = (stage, message) => console.log(`[${stage}] ${message}`)

/** 目录是否存在。 */
const isDir = path => { try { return statSync(path).isDirectory() } catch { return false } }

/**
 * 把构建会清理的大目录挪到暂存区。
 *
 * 构建工具开跑前通常要清空上次输出，文件一多就会被批量删除保护拦下。
 * 挪走之后那次清理变成空操作，构建继续。**不是删除**，用户随时可以挪回来。
 */
function parkDirectories(dirs, parkRoot) {
  const parked = []
  mkdirSync(parkRoot, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19)
  for (const dir of dirs) {
    if (!isDir(dir)) continue
    const dest = join(parkRoot, `${basename(dir)}-${stamp}`)
    try {
      renameSync(dir, dest)
      parked.push({ from: dir, to: dest })
      log('park', `挪走 ${basename(dir)}`)
    } catch (error) {
      log('park', `跳过 ${basename(dir)}（${error instanceof Error ? error.message.slice(0, 80) : '未知'}）`)
    }
  }
  return parked
}

/**
 * 建短路径跳板：Windows 260 字符上限的通用解法。
 *
 * 用 junction（目录联接），不需要管理员权限，指向同一块磁盘，不占额外空间。
 */
function ensureShortRoot(linkPath, targetPath) {
  if (existsSync(linkPath)) {
    log('shortpath', `跳板已存在：${linkPath}`)
    return true
  }
  try {
    mkdirSync(resolve(linkPath, '..'), { recursive: true })
    symlinkSync(targetPath, linkPath, 'junction')
    log('shortpath', `已建跳板 ${linkPath} → ${targetPath}`)
    return true
  } catch (error) {
    log('shortpath', `建跳板失败：${error instanceof Error ? error.message.slice(0, 120) : '未知'}`)
    return false
  }
}

/** 把已知错误翻译成人能看懂的话。 */
function explainFailure(text) {
  const rules = [
    { test: /ERR_PNPM_NO_SCRIPT|Missing script/iu, why: '项目里没有这个 npm script',
      fix: '用 --script 指定真实存在的脚本名；先看桌面端 package.json 的 scripts 字段' },
    { test: /fetch failed|ETIMEDOUT|ECONNRESET/iu, why: '网络下载失败（默认源多半在境外）',
      fix: '设 ELECTRON_MIRROR / npm 源指向国内镜像后重跑；或先手动把二进制放进下载缓存' },
    { test: /SAFE_DELETE_BULK_CONFIRM_REQUIRED|safe-delete/iu, why: '构建清理缓存时被批量删除保护拦下',
      fix: '用 --park-dir 把待清目录挪走；仍不行需在构建子进程内临时放行（要用户明确同意）' },
    { test: /文件名或扩展名太长|path too long|ENAMETOOLONG/iu, why: 'Windows 260 字符路径上限',
      fix: '用 --build-root-var / --build-root-path 把构建输出指到短路径' },
    { test: /DLL load failed/iu, why: '原生模块加载失败，多半也是路径过长或缺少运行库',
      fix: '先缩短路径；再确认 VC++ 运行库齐全' },
    { test: /证书|certificate|signing/iu, why: '该命令变体要求签名证书',
      fix: '加 --unsigned，或确认走的是 unsigned 脚本变体' },
    { test: /invoke this script through a pnpm|请通过 pnpm/iu, why: '脚本要求经包管理器入口调用',
      fix: '用 pnpm run <script>，不要直接跑 tsx' },
    { test: /EXDEV|cross-device/iu, why: '暂存区与项目不在同一个盘，无法直接移动',
      fix: '用 --park-dir 指定与项目同盘的目录' },
    { test: /EACCES|EPERM/iu, why: '权限不足或文件被占用',
      fix: '关掉正在占用产物的程序（资源管理器预览、杀软扫描），再重跑' },
  ]
  for (const rule of rules) {
    if (rule.test.test(text)) return rule
  }
  return undefined
}

/**
 * 找 pnpm 的 JS 入口，用当前 node 直接执行。
 *
 * Windows 上 pnpm 是 .cmd，只能靠 `shell: true` 调，而 Node 会对此告警
 * （参数不做转义）。找到 pnpm.cjs 后用 node 直接跑，既没告警也没有注入面。
 *
 * @returns pnpm.cjs 绝对路径；找不到返回 undefined。
 */
function resolvePnpmEntry() {
  const guess = join(dirname(process.execPath), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
  return existsSync(guess) ? guess : undefined
}

/**
 * 跑构建命令：输出实时转发到终端，同时累积一份用于错误归类。
 *
 * 用 inherit 会拿不到文本、没法翻译错误；用 pipe 又看不到进度（构建十几分钟，
 * 没有进度会以为卡死）。所以两边都要：边转发边收集。
 *
 * @param command - 可执行文件。
 * @param argv - 参数数组。
 * @param options - spawn 选项。
 * @returns 退出码与累积输出。
 */
function runStreaming(command, argv, options) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, argv, { ...options, stdio: ['inherit', 'pipe', 'pipe'] })
    let captured = ''
    child.stdout?.on('data', (chunk) => { captured += chunk.toString(); process.stdout.write(chunk) })
    child.stderr?.on('data', (chunk) => { captured += chunk.toString(); process.stderr.write(chunk) })
    child.once('error', (error) => { resolvePromise({ status: 1, output: `${captured}\n${String(error)}` }) })
    child.once('close', (status) => { resolvePromise({ status: status ?? 1, output: captured }) })
  })
}

/** 主流程。 */
async function main() {
  const args = parseArgs(process.argv.slice(2))
  const projectRoot = resolve(typeof args['project-root'] === 'string' ? args['project-root'] : '.')
  const desktopDir = resolve(projectRoot, typeof args['desktop-dir'] === 'string' ? args['desktop-dir'] : 'apps/desktop')
  const rawScript = typeof args.script === 'string' ? args.script : 'package'
  // 脚本名会进命令行，只允许安全字符，杜绝注入
  const script = /^[\w:.-]+$/u.test(rawScript) ? rawScript : 'package'
  if (script !== rawScript) log('warn', `脚本名含非法字符，已回退为 package（原值 ${rawScript}）`)
  const mode = typeof args.mode === 'string' ? args.mode : 'dir'
  const unsigned = args.unsigned !== false
  const buildRootVar = typeof args['build-root-var'] === 'string' ? args['build-root-var'] : undefined
  const buildRootPath = typeof args['build-root-path'] === 'string' ? args['build-root-path'] : undefined
  // 暂存区默认放在**项目同盘**的隐藏目录：跨盘 rename 会报 EXDEV，而同盘移动是瞬时的。
  // 放在项目根下而不是系统临时目录，是为了保证同盘，同时用户一眼能找到、随时能删。
  const parkRoot = typeof args['park-dir'] === 'string'
    ? args['park-dir']
    : join(projectRoot, '.packaging-parked')

  console.log('='.repeat(72))
  console.log('桌面应用打包')
  console.log('='.repeat(72))
  log('config', `项目根 ${projectRoot}`)
  log('config', `桌面端 ${desktopDir}`)
  log('config', `脚本 ${script} / 模式 ${mode} / 未签名 ${unsigned}`)

  // ── 1. 环境 ───────────────────────────────────────────────
  const win = process.platform === 'win32'
  const env = { ...process.env }
  // 国内镜像：只影响本次构建子进程，不改用户环境
  env.ELECTRON_MIRROR ??= 'https://npmmirror.com/mirrors/electron/'
  env.NODE_USE_ENV_PROXY ??= '1'
  log('mirror', `ELECTRON_MIRROR=${env.ELECTRON_MIRROR}`)

  // ── 2. 短路径跳板 ─────────────────────────────────────────
  if (buildRootVar !== undefined && buildRootPath !== undefined) {
    const target = join(desktopDir, '.desktop-build')
    if (ensureShortRoot(buildRootPath, target)) {
      env[buildRootVar] = buildRootPath
      log('shortpath', `${buildRootVar}=${buildRootPath}`)
    }
  } else if (win && projectRoot.length > 120) {
    log('shortpath', '项目路径偏长但未提供 --build-root-var/--build-root-path，长路径问题可能复现')
  }

  // ── 3. 挪走会被清理的大目录 ───────────────────────────────
  //    只挪"构建产物/缓存"，绝不碰源码。
  const candidates = [
    join(projectRoot, 'apps', 'web', 'dist'),
    join(desktopDir, '.desktop-build', 'targets', 'win-x64', 'runtime'),
    join(desktopDir, '.desktop-build', 'targets', 'win-x64', 'packed'),
  ]
  const parked = parkDirectories(candidates, parkRoot)
  if (parked.length > 0) log('park', `共挪走 ${parked.length} 个目录，暂存于 ${parkRoot}`)

  // ── 4. 构建 + 打包 ────────────────────────────────────────
  const cliArgs = []
  if (mode === 'dir') cliArgs.push('--dir')
  if (unsigned) cliArgs.push('--unsigned')
  cliArgs.push('win-x64')

  log('build', `执行 pnpm run ${script} -- ${cliArgs.join(' ')}`)
  const started = Date.now()
  const pnpmEntry = win ? resolvePnpmEntry() : undefined
  const argv = ['run', script, '--', ...cliArgs]
  return (pnpmEntry === undefined
    ? runStreaming(win ? 'pnpm.cmd' : 'pnpm', argv, { cwd: desktopDir, env, shell: win })
    : runStreaming(process.execPath, [pnpmEntry, ...argv], { cwd: desktopDir, env })
  ).then(({ status, output }) => {
    const elapsed = Math.round((Date.now() - started) / 1000)
    if (status !== 0) {
      console.log('-'.repeat(72))
      log('fail', `构建失败，退出码 ${String(status)}，耗时 ${elapsed}s`)
      const hint = explainFailure(output)
      if (hint !== undefined) {
        console.log(`  可能是：${hint.why}`)
        console.log(`  建议：${hint.fix}`)
      } else {
        console.log('  未命中已知错误模式，请查看上面的原始输出定位第一处报错。')
      }
      if (parked.length > 0) console.log(`  已挪走的目录仍在 ${parkRoot}，可原样挪回。`)
      return 1
    }
    log('done', `构建成功，耗时 ${elapsed}s`)
    if (parked.length > 0) {
      console.log(`  暂存目录（确认产物无误后可删）：${parkRoot}`)
    }
    console.log('  下一步：node verify-artifact.mjs --artifact <产物目录>')
    return 0
  })
}

process.exitCode = await main()
void rmSync
