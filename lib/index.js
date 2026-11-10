/**
 * source-to-app — DeepSeek Harness plugin adapter.
 *
 * The repository root is the skill itself: SKILL.md, scripts, references and
 * assets sit next to this package. The adapter registers that root with the
 * host skill registry, so one `dsh plugin ... add` is enough.
 *
 * Zero runtime dependencies: only Node's built-in fs/path/url modules.
 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis plugin identity. */
export const name = 'source-to-app'

/** Registry used by this provider. */
export const inject = ['skills']

const SKILL_NAME = 'source-to-app'

/** Packaged skills use the same precedence as bundled local roots. */
const BUNDLED_SKILL_RANK = 600

function fail(path, message) {
  return new Error(`source-to-app: ${path} ${message}`)
}

/**
 * Parse the small YAML subset used by SKILL.md frontmatter.
 * Handles plain scalars, quoted scalars and folded blocks.
 */
export function parseFrontmatter(raw, path) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (match === null) throw fail(path, 'has no YAML frontmatter')

  const fields = {}
  let block = null

  for (const line of match[1].split(/\r?\n/)) {
    if (block !== null) {
      if (/^\s+\S/u.test(line)) {
        fields[block] += (fields[block] === '' ? '' : ' ') + line.trim()
        continue
      }
      block = null
    }

    const pair = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/u.exec(line)
    if (pair === null) continue

    const key = pair[1]
    const value = pair[2].trim()

    if (value === '>-' || value === '>' || value === '|-' || value === '|') {
      fields[key] = ''
      block = key
      continue
    }

    if (value.startsWith('"')) {
      try {
        fields[key] = JSON.parse(value)
      } catch {
        throw fail(path, `has an invalid quoted ${key}`)
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      fields[key] = value.slice(1, -1).replaceAll("''", "'")
    } else {
      fields[key] = value
    }
  }

  return { fields, content: raw.slice(match[0].length).trim() }
}

function describe(raw, path) {
  const { fields } = parseFrontmatter(raw, path)
  const description = fields.description || fields.description_zh || ''
  if (typeof description !== 'string' || description.length === 0) {
    throw fail(path, 'has an empty description')
  }
  return description
}

/**
 * Register this skill with the harness.
 * @param ctx - Context carrying the skill registry.
 * @param config - Optional `skillRoot` for packaged or relocated deployments.
 */
export function apply(ctx, config = {}) {
  const skillRoot = config.skillRoot ?? fileURLToPath(new URL('../', import.meta.url))
  if (!isAbsolute(skillRoot)) throw fail(skillRoot, 'must be an absolute directory')

  const skillPath = join(skillRoot, 'SKILL.md')
  const description = describe(readFileSync(skillPath, 'utf8'), skillPath)

  const candidate = {
    name: SKILL_NAME,
    description,
    invocation: {
      modelInvocable: true,
      userInvocable: true,
    },
    provider: 'source-to-app',
    source: 'bundled',
    rank: BUNDLED_SKILL_RANK,
    resourceBase: {
      kind: 'directory',
      path: skillRoot.split(sep).join('/'),
    },
    locator: skillPath,
  }

  const provider = {
    name: 'source-to-app',
    list: () => Promise.resolve([candidate]),
    async get(entry, options) {
      const { rank: _rank, locator, ...summary } = entry
      const raw = await readFile(locator, { encoding: 'utf8', signal: options.signal })
      return {
        ...summary,
        content: parseFrontmatter(raw, locator).content,
      }
    },
  }

  ctx.skills.registerProvider(() => provider)
}
