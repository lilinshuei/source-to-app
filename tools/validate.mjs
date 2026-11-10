import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const EXPECTED = 'source-to-app'
const REQUIRED = [
  "SKILL.md",
  "lib/index.js",
  "cordis.patch.yml",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "SECURITY.md",
  "package.json",
  "tools/validate.mjs",
  "tools/smoke.mjs",
  "scripts/preflight.mjs",
  "scripts/package.mjs",
  "scripts/verify-artifact.mjs",
  "references/pitfalls.md"
]

const forbidden = [
  'C:' + '\\Users', 'C:' + '/Users', 'Admin' + 'istrator',
  '\u674e' + '\u4e34\u6c34', 'Work' + 'Buddy', '@qq' + '.com',
  '\u7cbe\u795e' + '\u4ed3\u5e93', '\u5b66\u4e60' + '\u6587\u4ef6',
  'Mar' + 'vis', '\u7eaa\u5ff5' + '\u65f6\u5149', '\u5355\u673a' + '\u6e38\u620f',
  'Github' + '\u4ed3\u5e93', 'Han' + '1me', 'h' + '1v',
  'E:' + '\\', 'D:' + '\\',
  '\u9632\u706b' + '\u5899', 'fire' + 'wall', 'net' + 'sh', 'New-' + 'NetFirewallRule',
]

let pass = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log('  PASS  ' + name + (detail ? '  ' + detail : ''))
  } else {
    failures.push(name + (detail ? ' :: ' + detail : ''))
    console.log('  FAIL  ' + name + (detail ? '  ' + detail : ''))
  }
}

console.log('=== ' + EXPECTED + ' validation ===\n')

for (const rel of REQUIRED) {
  const full = join(ROOT, rel)
  check('file present: ' + rel, existsSync(full))
}

const skillPath = join(ROOT, 'SKILL.md')
if (existsSync(skillPath)) {
  const raw = readFileSync(skillPath, 'utf8')
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  check('SKILL.md has frontmatter', fm !== null)
  if (fm) {
    const name = /^name:\s*(.+)$/mu.exec(fm[1])
    check('frontmatter name matches repository', name !== null && name[1].trim().replace(/^["']|["']$/g, '') === EXPECTED)

    function fieldValue(key) {
      const lines = fm[1].split(/\r?\n/)
      const index = lines.findIndex((line) => line.startsWith(key + ':'))
      if (index < 0) return ''
      const value = lines[index].slice(key.length + 1).trim()
      if (value === '>-' || value === '>' || value === '|-' || value === '|') {
        const parts = []
        for (let i = index + 1; i < lines.length && /^\s+\S/.test(lines[i]); i += 1) parts.push(lines[i].trim())
        return parts.join(' ')
      }
      return value.replace(/^["']|["']$/g, '')
    }

    const description = fieldValue('description') || fieldValue('description_zh')
    check('description is present', description.length > 10, description.length + ' chars')
    const body = raw.slice(fm[0].length).trim()
    check('SKILL.md body is substantial', body.length > 500, body.length + ' chars')
  }
}

const pkgPath = join(ROOT, 'package.json')
if (existsSync(pkgPath)) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  check('package name matches repository', pkg.name === EXPECTED)
  check('package version is semver', /^\d+\.\d+\.\d+$/.test(pkg.version || ''))
  check('DSH bundle patch is declared', pkg.dsh?.bundle?.patch === './cordis.patch.yml')
  check('main entry exists', existsSync(join(ROOT, pkg.main || '')))
}

check('cordis.patch.yml mounts the plugin', existsSync(join(ROOT, 'cordis.patch.yml')) && readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8').includes(EXPECTED))

const wavPath = join(ROOT, 'assets', 'chime.wav')
if (existsSync(wavPath)) {
  const header = readFileSync(wavPath).subarray(0, 12)
  check('chime.wav is a RIFF/WAVE file', header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WAVE')
}

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const files = walk(ROOT)
const textExt = /\.(md|js|cjs|mjs|json|ya?ml|py|ps1|sh|cmd|html|css|svg|txt)$/i
const leaks = []
let total = 0
for (const full of files) {
  const size = statSync(full).size
  total += size
  if (!textExt.test(full)) continue
  const text = readFileSync(full, 'utf8')
  for (const token of forbidden) {
    if (text.includes(token)) leaks.push(relative(ROOT, full) + ' :: ' + token)
  }
}
check('no personal paths, names, or other-project references', leaks.length === 0, leaks.join(' | '))
check('repository stays small', total < 30 * 1024 * 1024, (total / 1024 / 1024).toFixed(2) + ' MB')

console.log('\n=== summary: PASS=' + pass + ' FAIL=' + failures.length + ' ===')
if (failures.length) {
  console.log(failures.map((f) => ' - ' + f).join('\n'))
  process.exit(1)
}
