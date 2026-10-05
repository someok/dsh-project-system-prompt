/**
 * Resolution, frontmatter, and interpolation tests for the
 * project-system-prompt plugin.
 *
 * Drives the real `apply()` listener with a fake Cordis context, so assembly
 * rewriting is exercised end to end without a running harness.
 *
 * Run: node --test test/plugin.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, findProjectRoot, parseSource, substituteVariables } from '../lib/plugin.js'

/** Build one fake plugin context and the listener it registered. */
function harness() {
  let listener
  const ctx = {
    logger: { info() {}, warn() {} },
    on(name, handler) {
      assert.equal(name, 'system-prompt/assemble')
      listener = handler
    },
  }
  apply(ctx)
  assert.ok(listener, 'listener registered')
  return listener
}

/** Build a project tree under a fresh temp directory. */
function project(files = {}, { git = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'psp-'))
  if (git) mkdirSync(join(root, '.git'))
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  return root
}

const MODE = [{ name: 'deployment:persona-prefix', text: 'mode prompt' }]

/** Assemble through the listener with the mode's own sections in place. */
async function assemble(cwd, { sections = MODE, variables = {} } = {}) {
  const listener = harness()
  const assembly = { sections, contexts: [], tools: [], variables }
  return listener(assembly, { agent: { session: { header: { cwd } } } }, async () => assembly)
}

test('no project files leaves the mode prompt untouched', async () => {
  const root = project()
  const assembled = await assemble(root)
  assert.deepEqual(assembled.sections, MODE)
})

test('SYSTEM.md at the root replaces every mode section', async () => {
  const root = project({ 'SYSTEM.md': 'you are a project agent\n' })
  const assembled = await assemble(root)
  assert.deepEqual(assembled.sections, [{ name: 'project:system', text: 'you are a project agent', interpolate: false }])
})

test('.dsh/SYSTEM.md wins over SYSTEM.md', async () => {
  const root = project({ 'SYSTEM.md': 'outer', '.dsh/SYSTEM.md': 'inner' })
  const assembled = await assemble(root)
  assert.equal(assembled.sections.length, 1)
  assert.equal(assembled.sections[0].text, 'inner')
})

test('SYSTEM.append.md is appended after the mode sections', async () => {
  const root = project({ 'SYSTEM.append.md': 'extra rules' })
  const assembled = await assemble(root)
  assert.deepEqual(assembled.sections.at(-1), { name: 'project:system-append', text: 'extra rules', interpolate: false })
  assert.equal(assembled.sections.length, 2)
})

test('.dsh/SYSTEM.append.md wins over SYSTEM.append.md', async () => {
  const root = project({ 'SYSTEM.append.md': 'outer', '.dsh/SYSTEM.append.md': 'inner' })
  const assembled = await assemble(root)
  assert.equal(assembled.sections.at(-1).text, 'inner')
})

test('override and append compose into one complete section', async () => {
  const root = project({ '.dsh/SYSTEM.md': 'base', '.dsh/SYSTEM.append.md': 'tail' })
  const assembled = await assemble(root)
  assert.deepEqual(assembled.sections, [{ name: 'project:system', text: 'base\n\ntail', interpolate: false }])
})

test('a blank override falls back to the mode prompt', async () => {
  const root = project({ 'SYSTEM.md': '   \n\n' })
  const assembled = await assemble(root)
  assert.deepEqual(assembled.sections, MODE)
})

test('a blank override still lets append apply', async () => {
  const root = project({ 'SYSTEM.md': '  ', 'SYSTEM.append.md': 'tail' })
  const assembled = await assemble(root)
  assert.equal(assembled.sections.length, 2)
  assert.equal(assembled.sections.at(-1).text, 'tail')
})

test('a nested session directory resolves to the git root', async () => {
  const root = project({ 'SYSTEM.md': 'root prompt' })
  const nested = join(root, 'packages', 'app', 'src')
  mkdirSync(nested, { recursive: true })
  assert.equal(findProjectRoot(nested), root)
  const assembled = await assemble(nested)
  assert.equal(assembled.sections[0].text, 'root prompt')
})

test('without .git the session directory itself is the project root', async () => {
  const root = project({ 'SYSTEM.md': 'cwd prompt' }, { git: false })
  const nested = join(root, 'nested')
  mkdirSync(nested)
  assert.deepEqual((await assemble(nested)).sections, MODE)
  assert.equal((await assemble(root)).sections[0].text, 'cwd prompt')
})

test('an unreadable candidate (directory in its place) does not throw', async () => {
  const root = project()
  mkdirSync(join(root, 'SYSTEM.md'))
  const assembled = await assemble(root)
  assert.deepEqual(assembled.sections, MODE)
})

test('an assembly without an agent passes through', async () => {
  const root = project({ 'SYSTEM.md': 'never used' })
  const listener = harness()
  const assembly = { sections: [{ name: 'x', text: 'mode' }], contexts: [], tools: [], variables: {} }
  const assembled = await listener(assembly, {}, async () => assembly)
  assert.equal(assembled.sections[0].text, 'mode')
  rmSync(root, { recursive: true, force: true })
})

test('registered variables are substituted', async () => {
  const root = project({ 'SYSTEM.md': 'model={{model}} cwd={{cwd}} provider={{provider}}' })
  const assembled = await assemble(root, {
    variables: { model: 'deepseek-v4.1-flash', cwd: '/w/proj', provider: 'opencode-go' },
  })
  assert.equal(assembled.sections[0].text, 'model=deepseek-v4.1-flash cwd=/w/proj provider=opencode-go')
  assert.equal(assembled.sections[0].interpolate, false)
})

test('variables are substituted in append files too', async () => {
  const root = project({ 'SYSTEM.append.md': 'running from {{cwd}}' })
  const assembled = await assemble(root, { variables: { cwd: '/w/proj' } })
  assert.deepEqual(assembled.sections.at(-1), { name: 'project:system-append', text: 'running from /w/proj', interpolate: false })
})

test('unknown, malformed, and valueless references stay literal without failing', async () => {
  const root = project({ 'SYSTEM.md': 'a={{nope}} b={{a.b}} c={{ spaced }} d={{model}} e={{unset}} f=lone {{ brace' })
  const assembled = await assemble(root, { variables: { model: 'M', unset: undefined } })
  assert.equal(assembled.sections[0].text, 'a={{nope}} b={{a.b}} c={{ spaced }} d=M e={{unset}} f=lone {{ brace')
})

test('substituted values are not scanned again', async () => {
  const root = project({ 'SYSTEM.md': 'x={{outer}}' })
  const assembled = await assemble(root, { variables: { outer: '{{inner}}', inner: 'boom' } })
  assert.equal(assembled.sections[0].text, 'x={{inner}}')
})

test('a backslash escapes a reference', async () => {
  const root = project({ 'SYSTEM.md': 'literal \\{{cwd}} and real {{cwd}}' })
  const assembled = await assemble(root, { variables: { cwd: '/w/proj' } })
  assert.equal(assembled.sections[0].text, 'literal {{cwd}} and real /w/proj')
})

test('frontmatter turns interpolation off and is stripped', async () => {
  const root = project({ 'SYSTEM.md': '---\ninterpolate: false\n---\nkeep {{cwd}} literal\n' })
  const assembled = await assemble(root, { variables: { cwd: '/w/proj' } })
  assert.deepEqual(assembled.sections, [{ name: 'project:system', text: 'keep {{cwd}} literal', interpolate: false }])
})

test('frontmatter may state interpolation explicitly', async () => {
  const root = project({ 'SYSTEM.md': '---\ninterpolate: yes\n---\nhello {{cwd}}' })
  const assembled = await assemble(root, { variables: { cwd: '/w/proj' } })
  assert.equal(assembled.sections[0].text, 'hello /w/proj')
})

test('a bare fence block is prompt text, not frontmatter', async () => {
  const root = project({ 'SYSTEM.md': '---\nsome prose\n---\nmore prose' })
  const assembled = await assemble(root)
  assert.equal(assembled.sections[0].text, '---\nsome prose\n---\nmore prose')
})

test('a block with an unsupported key is prompt text', async () => {
  const root = project({ 'SYSTEM.md': '---\ntitle: x\n---\nbody' })
  const assembled = await assemble(root)
  assert.equal(assembled.sections[0].text, '---\ntitle: x\n---\nbody')
})

test('an invalid boolean keeps interpolation on', async () => {
  const root = project({ 'SYSTEM.md': '---\ninterpolate: maybe\n---\n{{cwd}}' })
  const assembled = await assemble(root, { variables: { cwd: '/w/proj' } })
  assert.equal(assembled.sections[0].text, '/w/proj')
})

test('a frontmatter-only file falls back to the mode prompt', async () => {
  const root = project({ 'SYSTEM.md': '---\ninterpolate: false\n---\n' })
  const assembled = await assemble(root)
  assert.deepEqual(assembled.sections, MODE)
})

test('parseSource reads the accepted frontmatter spellings', () => {
  for (const off of ['false', 'no', 'off', '0', 'FALSE']) {
    assert.equal(parseSource(`---\ninterpolate: ${off}\n---\nbody`).interpolate, false, off)
  }
  for (const on of ['true', 'yes', 'on', '1']) {
    assert.equal(parseSource(`---\ninterpolate: ${on}\n---\nbody`).interpolate, true, on)
  }
  assert.equal(parseSource('no frontmatter').interpolate, true)
})

test('substituteVariables reports what it left literal', () => {
  const { text, unresolved } = substituteVariables('{{cwd}} {{nope}} {{bad.name}}', { cwd: '/w' })
  assert.equal(text, '/w {{nope}} {{bad.name}}')
  assert.deepEqual([...unresolved].sort(), ['bad.name', 'nope'])
})
