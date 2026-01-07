import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/*
 * These drive the real CLI rather than calling the guard directly. A guard
 * asserted through its own exported function is defended by a declaration; an
 * exit code and the bytes left in a file on disk cannot be edited into
 * agreement.
 *
 * Every refusal below was measured destroying the named file first, with the
 * run exiting 0 and reporting "index written": a symbolic link at --index
 * replaced an 11-byte file outside the archive with a 5 kB index, a link aimed
 * at a path that did not exist created that file outside the archive, a
 * symlinked parent did the same one level up, and a hard link to a decision
 * record overwrote the record -- the one thing this tool promises never to
 * write to.
 *
 * The allowed cases are not optional: a guard that refuses every destination
 * passes a data-loss test while making --index useless.
 */

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/decision-record-indexer.mjs')
const BYSTANDER = 'a file this tool was never asked to touch\n'

const RECORD = [
  '---',
  'id: ADR-0001',
  'title: Decision one',
  'status: accepted',
  'date: 2026-01-01',
  'owners: [team]',
  'systems: [core]',
  '---',
  '',
  '# Decision one',
  '',
  '## Context',
  'Because.',
  '',
  '## Decision',
  'Do it.',
  '',
  '## Consequences',
  'It is done.',
  '',
].join('\n')

/**
 * base/
 *   records/0001-a.md  the archive, which is never written to
 *   work/              the working directory and the default --index-root
 *     nested/          a real subdirectory of the write root
 *   elsewhere/         outside the write root, where the bystanders live
 */
async function workspace(t) {
  const base = await mkdtemp(join(tmpdir(), 'decision-record-indexer-guard-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const records = join(base, 'records')
  const work = join(base, 'work')
  const nested = join(work, 'nested')
  const elsewhere = join(base, 'elsewhere')
  await mkdir(records)
  await mkdir(work)
  await mkdir(nested)
  await mkdir(elsewhere)
  const record = join(records, '0001-a.md')
  await writeFile(record, RECORD, 'utf8')
  return { base, records, record, work, nested, elsewhere }
}

/** The CLI runs with `work` as its working directory, so that is the write root. */
async function index(space, destination, extra = []) {
  const args = ['--root', space.records, '--index', destination, '--json', ...extra]
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd: space.work })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

test('a symlink at the destination is refused on sight and its target survives', async (t) => {
  const space = await workspace(t)
  const bystander = join(space.work, 'precious.txt')
  await writeFile(bystander, BYSTANDER, 'utf8')
  await symlink(bystander, join(space.work, 'index.json'))

  const result = await index(space, 'index.json')
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--index is a symbolic link/)
  assert.equal(await readFile(bystander, 'utf8'), BYSTANDER)
  assert.equal((await lstat(join(space.work, 'index.json'))).isSymbolicLink(), true)
})

test('a symlink pointing out of the write root is refused and its target survives', async (t) => {
  const space = await workspace(t)
  const bystander = join(space.elsewhere, 'precious.txt')
  await writeFile(bystander, BYSTANDER, 'utf8')
  await symlink(bystander, join(space.work, 'index.json'))

  const result = await index(space, 'index.json')
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--index is not usable/)
  assert.equal(await readFile(bystander, 'utf8'), BYSTANDER)
})

test('a symlink aimed at a path that does not exist yet creates nothing', async (t) => {
  const space = await workspace(t)
  const absent = join(space.elsewhere, 'created-outside.json')
  await symlink(absent, join(space.work, 'index.json'))

  const result = await index(space, 'index.json')
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--index is a symbolic link/)
  assert.deepEqual(await readdir(space.elsewhere), [])
})

test('a symlinked parent directory is refused and the file behind it survives', async (t) => {
  const space = await workspace(t)
  const bystander = join(space.elsewhere, 'precious.txt')
  await writeFile(bystander, BYSTANDER, 'utf8')
  await symlink(space.elsewhere, join(space.work, 'link'))

  const result = await index(space, 'link/precious.txt')
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /outside the permitted root/)
  assert.equal(await readFile(bystander, 'utf8'), BYSTANDER)
})

test('a symlinked parent is refused before its missing subdirectory is created', async (t) => {
  const space = await workspace(t)
  await symlink(space.elsewhere, join(space.work, 'link'))

  const result = await index(space, 'link/made-up/index.json')
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /outside the permitted root/)
  assert.deepEqual(await readdir(space.elsewhere), [])
})

test('a hard link to a decision record is refused and the record survives', async (t) => {
  const space = await workspace(t)
  await link(space.record, join(space.work, 'index.json'))

  const result = await index(space, 'index.json')
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /same file as an input/)
  assert.equal(await readFile(space.record, 'utf8'), RECORD)
  assert.equal(await readFile(join(space.work, 'index.json'), 'utf8'), RECORD)
})

test('a lexical ".." escape out of the write root is refused', async (t) => {
  const space = await workspace(t)
  const bystander = join(space.elsewhere, 'precious.txt')
  await writeFile(bystander, BYSTANDER, 'utf8')

  const result = await index(space, '../elsewhere/precious.txt')
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /outside the permitted root/)
  assert.equal(await readFile(bystander, 'utf8'), BYSTANDER)
})

test('a destination that is a directory is refused', async (t) => {
  const space = await workspace(t)

  const result = await index(space, 'nested')
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /is a directory, not a file/)
})

test('a destination inside the decision record root is still refused', async (t) => {
  const space = await workspace(t)

  const result = await index(space, join(space.records, 'index.json'), ['--index-root', space.base])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /inside the decision record root/)
  assert.deepEqual(await readdir(space.records), ['0001-a.md'])
})

test('--index-root without --index is a usage error, not a silently ignored option', async (t) => {
  const space = await workspace(t)
  const { code, stdout, stderr } = await run(
    process.execPath,
    [CLI, '--root', space.records, '--index-root', space.base, '--json'],
    { cwd: space.work },
  ).then(() => ({ code: 0, stdout: '', stderr: '' }), (error) => error)

  assert.equal(code, 2)
  assert.equal(stdout, '')
  assert.match(stderr, /--index-root has no meaning without --index/)
})

test('a plain new file in the write root is allowed', async (t) => {
  const space = await workspace(t)

  const result = await index(space, 'index.json')
  assert.equal(result.code, 0)
  assert.equal(JSON.parse(result.stdout).status, 'pass')
  const written = JSON.parse(await readFile(join(space.work, 'index.json'), 'utf8'))
  assert.deepEqual(written.records.map((item) => item.id), ['ADR-0001'])
})

test('a real subdirectory of the write root is allowed', async (t) => {
  const space = await workspace(t)

  const result = await index(space, 'nested/index.json')
  assert.equal(result.code, 0)
  assert.equal(JSON.parse(await readFile(join(space.nested, 'index.json'), 'utf8')).counts.records, 1)
})

test('a subdirectory that does not exist yet is still created inside the write root', async (t) => {
  const space = await workspace(t)

  const result = await index(space, 'build/index.json')
  assert.equal(result.code, 0)
  assert.equal(JSON.parse(await readFile(join(space.work, 'build', 'index.json'), 'utf8')).counts.records, 1)
})

test('an existing regular file that is not a record is overwritten', async (t) => {
  const space = await workspace(t)
  const destination = join(space.work, 'index.json')
  await writeFile(destination, 'stale index\n', 'utf8')

  const result = await index(space, 'index.json')
  assert.equal(result.code, 0)
  assert.equal(JSON.parse(await readFile(destination, 'utf8')).counts.records, 1)
})

test('a write root the operator widens covers what it names', async (t) => {
  const space = await workspace(t)
  const destination = join(space.elsewhere, 'index.json')

  const refused = await index(space, destination)
  assert.equal(refused.code, 2)
  assert.equal(refused.stdout, '')
  assert.deepEqual(await readdir(space.elsewhere), [])

  const allowed = await index(space, destination, ['--index-root', space.base])
  assert.equal(allowed.code, 0)
  assert.equal(JSON.parse(await readFile(destination, 'utf8')).counts.records, 1)
})
