#!/usr/bin/env node
/**
 * 产物校验：不看"命令有没有报错"，只看"包里到底有什么"。
 *
 * 用法：
 *   node verify-artifact.mjs --artifact <产物目录>
 *   node verify-artifact.mjs --artifact <产物目录> --expect resources/model.bin --expect exe
 *   node verify-artifact.mjs --artifact <产物目录> --expect-in-asar "某段关键字符串"
 *
 * 退出码：0 = 通过；1 = 有阻塞问题。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'

/** 解析参数（--expect 可重复）。 */
function parseArgs(argv) {
  const out = { expect: [], expectInAsar: [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) { out[key] = true; continue }
    if (key === 'expect') out.expect.push(next)
    else if (key === 'expect-in-asar') out.expectInAsar.push(next)
    else out[key] = next
    i++
  }
  return out
}

/** 递归统计文件数与总字节。 */
function walk(dir) {
  let files = 0
  let bytes = 0
  let newest = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try { entries = readdirSync(current, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) { stack.push(full); continue }
      try {
        const info = statSync(full)
        files++
        bytes += info.size
        if (info.mtimeMs > newest) newest = info.mtimeMs
      } catch { /* 忽略读不到的 */ }
    }
  }
  return { files, bytes, newest }
}

const MB = n => (n / 1024 ** 2).toFixed(1)
const GB = n => (n / 1024 ** 3).toFixed(2)

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (typeof args.artifact !== 'string') {
    console.error('用法：node verify-artifact.mjs --artifact <产物目录> [--expect <相对路径>]... [--expect-in-asar <字符串>]...')
    return 1
  }
  const artifact = resolve(args.artifact)
  if (!existsSync(artifact)) {
    console.error(`✗ 产物目录不存在：${artifact}`)
    return 1
  }

  console.log('='.repeat(72))
  console.log('产物校验')
  console.log('='.repeat(72))
  console.log(`目录：${artifact}`)

  // 1. 规模
  const { files, bytes, newest } = walk(artifact)
  console.log(`文件数：${files}`)
  console.log(`总体积：${GB(bytes)} GB`)
  console.log(`最新文件时间：${new Date(newest).toLocaleString('zh-CN')}`)

  let problems = 0

  // 2. 新鲜度：产物应该是刚打的
  const ageHours = (Date.now() - newest) / 36e5
  if (ageHours > 24) {
    console.log(`! 产物最新文件已是 ${ageHours.toFixed(1)} 小时前，可能不是本次构建的`)
    problems++
  } else {
    console.log('✓ 产物是新的（24 小时内）')
  }

  // 3. 可执行文件
  const topEntries = readdirSync(artifact, { withFileTypes: true })
  const exes = topEntries.filter(e => e.isFile() && e.name.toLowerCase().endsWith('.exe'))
  if (exes.length === 0) {
    console.log('! 顶层没有 .exe，确认产物形态是否符合预期')
    problems++
  } else {
    for (const exe of exes) {
      const size = statSync(join(artifact, exe.name)).size
      console.log(`✓ 可执行文件 ${exe.name}（${MB(size)} MB）`)
    }
  }

  // 4. 关键文件必须存在
  for (const rel of args.expect) {
    const full = join(artifact, rel)
    if (existsSync(full)) {
      const size = statSync(full).size
      console.log(`✓ 关键文件存在 ${rel}（${size > 1048576 ? `${MB(size)} MB` : `${size} B`}）`)
    } else {
      console.log(`✗ 关键文件缺失 ${rel}`)
      problems++
    }
  }

  // 5. 包内代码是否是新版（asar 里搜字符串）
  const asarPath = join(artifact, 'resources', 'app.asar')
  if (args.expectInAsar.length > 0) {
    if (!existsSync(asarPath)) {
      console.log('✗ 找不到 resources/app.asar，无法校验包内代码')
      problems++
    } else {
      const text = readFileSync(asarPath).toString('utf8')
      for (const needle of args.expectInAsar) {
        if (text.includes(needle)) console.log(`✓ 包内含「${needle}」`)
        else { console.log(`✗ 包内缺少「${needle}」——可能打的是旧代码`); problems++ }
      }
    }
  }

  console.log('-'.repeat(72))
  if (problems === 0) {
    console.log('结论：通过。')
    return 0
  }
  console.log(`结论：${problems} 项待确认，见上方 ✗ / ! 标记。`)
  return 1
}

process.exitCode = main()
void basename
