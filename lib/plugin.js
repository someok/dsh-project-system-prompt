/**
 * Project-level SYSTEM.md support for DeepSeek Harness.
 *
 * Every model step, the system prompt is assembled for the agent that is about
 * to run. This plugin listens on the `system-prompt/assemble` waterfall and
 * rewrites that assembly from project files, resolved against the session's
 * project root — the nearest ancestor of the session working directory that
 * contains `.git`, or the working directory itself when there is none:
 *
 * 1. Override — `<root>/.dsh/SYSTEM.md`, then `<root>/SYSTEM.md`. When either
 *    file exists and holds non-blank text, the rendered system prompt for that
 *    request becomes exactly that text: the selected agent preset's own prompt
 *    sections (persona, harness identity, tool guidance) are replaced.
 * 2. Append — `<root>/.dsh/SYSTEM.append.md`, then `<root>/SYSTEM.append.md`.
 *    When either file exists and holds non-blank text, its text is appended
 *    after the rest of the prompt — after the override text when case 1 also
 *    applies, otherwise after the mode's own sections.
 * 3. Neither file present: the assembly passes through untouched, so the
 *    selected mode keeps owning the prompt.
 *
 * Variables — project text may reference the prompt variables the harness
 * registered for this assembly (`{{model}}`, `{{cwd}}`, `{{provider}}`, plus any
 * variable another plugin registers):
 *
 * - A reference whose variable is registered and holds a string is replaced by
 *   its value.
 * - Every other reference — unknown name, malformed group, or a registered
 *   variable with no value — stays literal. Unlike the harness's own strict
 *   rendering, project text can never fail an assembly, so a stray `{{` in a
 *   prompt is harmless. Substituted values are not scanned again.
 * - `\{{` renders a literal `{{` (only while interpolation is enabled).
 *
 * A file may opt out of interpolation, or state it explicitly, with
 * frontmatter on the first line:
 *
 * ```markdown
 * ---
 * interpolate: false
 * ---
 * ```
 *
 * A recognized block is removed from the prompt text. It is only recognized
 * when every line in it is `key: value` with a known key, so an ordinary
 * markdown rule at the top of a file is never eaten.
 *
 * Files are re-read on every assembly, so editing one takes effect on the next
 * model step of every session working in that project; deleting it restores
 * the mode's prompt the same way. Read failures and blank files fall back
 * rather than failing the assembly.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs'
import { dirname, join, parse, resolve } from 'node:path'

/** Cordis plugin name. */
export const name = 'project-system-prompt'

/** Override candidates, in precedence order. */
const OVERRIDE_CANDIDATES = ['.dsh/SYSTEM.md', 'SYSTEM.md']

/** Append candidates, in precedence order. */
const APPEND_CANDIDATES = ['.dsh/SYSTEM.append.md', 'SYSTEM.append.md']

/** Largest source file read for one candidate, in bytes. */
const MAX_SOURCE_BYTES = 1024 * 1024

/** Section name used when a project file replaces the prompt. */
const OVERRIDE_SECTION = 'project:system'

/** Section name used when a project file extends the prompt. */
const APPEND_SECTION = 'project:system-append'

/** Open and close lines of an optional frontmatter block. */
const FRONTMATTER_FENCE = /^---[ \t]*$/

/** One `key: value` frontmatter entry. */
const FRONTMATTER_ENTRY = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/

/** Frontmatter keys this plugin understands. */
const FRONTMATTER_KEYS = new Set(['interpolate'])

/** Variable names the prompt registry accepts. */
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/

/** An escaped `{{`, or one complete `{{...}}` reference group. */
const REFERENCE_OR_ESCAPE = /\\(\{\{)|(\{\{([^{}]*)\}\})/g

/**
 * Read one file with a bounded buffer.
 * @param path - absolute file path.
 * @returns the decoded text, or `undefined` when the file cannot be read.
 */
function readCapped(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const take = Math.min(size, MAX_SOURCE_BYTES)
    const buffer = Buffer.alloc(take)
    const read = readSync(fd, buffer, 0, take, 0)
    const text = buffer.subarray(0, read).toString('utf8')
    return size > MAX_SOURCE_BYTES ? `${text}\n\n[SYSTEM.md truncated at ${MAX_SOURCE_BYTES} bytes]` : text
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Resolve the project root for one working directory.
 * @param cwd - the session working directory.
 * @returns the nearest ancestor holding `.git`, else the resolved cwd.
 */
export function findProjectRoot(cwd) {
  const fallback = resolve(cwd)
  const { root } = parse(fallback)
  let cursor = fallback
  for (;;) {
    if (existsSync(join(cursor, '.git'))) return cursor
    if (cursor === root) return fallback
    const parent = dirname(cursor)
    if (parent === cursor) return fallback
    cursor = parent
  }
}

/**
 * Parse the accepted boolean spellings.
 * @param raw - the trimmed frontmatter value.
 * @returns the boolean, or `undefined` when the spelling is not accepted.
 */
function parseBoolean(raw) {
  switch (raw.toLowerCase()) {
    case 'true':
    case 'yes':
    case 'on':
    case '1':
      return true
    case 'false':
    case 'no':
    case 'off':
    case '0':
      return false
    default:
      return undefined
  }
}

/**
 * Split an optional frontmatter block from a source file.
 *
 * The block is recognized only when the first line is a fence, a later line
 * closes it, and every line between is a recognized `key: value` entry; an
 * unrecognized block stays in the body, so prompt prose is never eaten.
 * @param text - the trimmed file text.
 * @returns the body, the interpolation setting, and a diagnostic note.
 */
export function parseSource(text) {
  const lines = text.split('\n')
  if (lines.length < 3 || !FRONTMATTER_FENCE.test(lines[0])) return { body: text, interpolate: true }
  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (FRONTMATTER_FENCE.test(lines[index])) {
      end = index
      break
    }
  }
  if (end < 0) return { body: text, interpolate: true }
  const entries = new Map()
  for (let index = 1; index < end; index += 1) {
    const line = lines[index].trim()
    if (line === '') continue
    const match = FRONTMATTER_ENTRY.exec(line)
    if (match === null) return { body: text, interpolate: true, note: `frontmatter line ${index + 1} is not "key: value"; keeping it as prompt text` }
    if (!FRONTMATTER_KEYS.has(match[1])) return { body: text, interpolate: true, note: `unsupported frontmatter key "${match[1]}"; keeping it as prompt text` }
    entries.set(match[1], match[2].trim())
  }
  const body = lines.slice(end + 1).join('\n').replace(/^\n/, '')
  const raw = entries.get('interpolate')
  if (raw === undefined) return { body, interpolate: true }
  const value = parseBoolean(raw)
  if (value === undefined) return { body, interpolate: true, note: `interpolate expects a boolean, got "${raw}"; using true` }
  return { body, interpolate: value }
}

/**
 * Substitute the prompt variables this assembly actually defines.
 * @param text - the prompt text.
 * @param variables - the assembled variable map.
 * @returns the rendered text plus every name left literal.
 */
export function substituteVariables(text, variables) {
  const unresolved = new Set()
  const rendered = text.replace(REFERENCE_OR_ESCAPE, (match, escaped, group, inner) => {
    if (escaped !== undefined) return '{{'
    const value = VARIABLE_NAME.test(inner) ? variables[inner] : undefined
    if (typeof value !== 'string') {
      unresolved.add(inner)
      return group
    }
    return value
  })
  return { text: rendered, unresolved }
}

/**
 * Apply frontmatter and variable substitution to one source file.
 * @param source - the trimmed file text.
 * @param variables - the assembled variable map.
 * @param path - the source path, for diagnostics.
 * @returns the rendered text and any notes worth logging.
 */
function renderSource(source, variables, path) {
  const { body, interpolate, note } = parseSource(source)
  if (!interpolate) return { text: body, notes: note === undefined ? [] : [`${path}: ${note}`] }
  const { text, unresolved } = substituteVariables(body, variables)
  const notes = []
  if (note !== undefined) notes.push(`${path}: ${note}`)
  if (unresolved.size > 0) notes.push(`${path}: left literal (no value in this assembly): ${[...unresolved].sort().join(', ')}`)
  return { text, notes }
}

/**
 * Read the first candidate below `root` that exists and holds usable text.
 * @param root - project root directory.
 * @param candidates - relative candidate paths, in precedence order.
 * @param variables - the assembled variable map.
 * @returns the path and rendered text, or `undefined` when no candidate applies.
 */
function firstUsable(root, candidates, variables) {
  for (const candidate of candidates) {
    const path = join(root, candidate)
    if (!existsSync(path)) continue
    const source = readCapped(path)
    if (source === undefined) continue
    const trimmed = source.trim()
    if (trimmed.length === 0) continue
    const rendered = renderSource(trimmed, variables, path)
    if (rendered.text.trim().length === 0) continue
    return { path, ...rendered }
  }
  return undefined
}

/**
 * Resolve both project prompt inputs for one working directory.
 * @param cwd - the session working directory.
 * @param variables - the assembled variable map.
 * @returns the root plus whichever inputs apply.
 */
export function resolveProjectPrompt(cwd, variables = {}) {
  const root = findProjectRoot(cwd)
  return {
    root,
    override: firstUsable(root, OVERRIDE_CANDIDATES, variables),
    append: firstUsable(root, APPEND_CANDIDATES, variables),
  }
}

/**
 * Register the project-prompt waterfall listener.
 * @param ctx - the mounting plugin context.
 */
export function apply(ctx) {
  let lastResolution
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const assembled = await next()
    try {
      const cwd = context?.agent?.session?.header?.cwd
      if (typeof cwd !== 'string' || cwd.length === 0) return assembled
      const variables = assembled.variables ?? {}
      const { override, append } = resolveProjectPrompt(cwd, variables)
      if (override === undefined && append === undefined) return assembled
      const notes = [...(override?.notes ?? []), ...(append?.notes ?? [])]
      const resolved = `${override?.path ?? '-'} | ${append?.path ?? '-'} | ${notes.join(' ; ')}`
      if (resolved !== lastResolution) {
        lastResolution = resolved
        ctx.logger?.info?.('project-system-prompt: %s', resolved)
      }
      if (override !== undefined) {
        const text = append === undefined ? override.text : `${override.text}\n\n${append.text}`
        return { ...assembled, sections: [{ name: OVERRIDE_SECTION, text, interpolate: false }] }
      }
      return {
        ...assembled,
        sections: [...assembled.sections, { name: APPEND_SECTION, text: append.text, interpolate: false }],
      }
    } catch (error) {
      ctx.logger?.warn?.('project-system-prompt: assembly rewrite skipped: %o', error)
      return assembled
    }
  })
}
