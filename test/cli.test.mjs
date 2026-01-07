import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/decision-record-indexer.mjs')
const CLEAN_ROOT = join(projectDirectory, 'examples/decisions-clean')
const BROKEN_ROOT = join(projectDirectory, 'examples/decisions-broken')

/** Run the real binary and report what actually reached each stream. */
async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd: projectDirectory })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

async function withTemporary(body) {
  const directory = await mkdtemp(join(tmpdir(), 'decision-record-indexer-cli-'))
  try {
    return await body(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

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

test('--help prints usage on stdout and exits 0', async () => {
  const result = await cli(['--help'])
  assert.equal(result.code, 0)
  assert.equal(result.stderr, '')
  assert.equal(result.stdout.startsWith('decision-record-indexer'), true)
  assert.equal(result.stdout.includes('--max-chain-depth'), true)
  assert.equal(result.stdout.includes('Exit codes:'), true)
})

test('a clean archive exits 0 and stdout carries only the JSON report', async () => {
  const result = await cli(['--root', CLEAN_ROOT, '--json'])
  assert.equal(result.code, 0)

  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'pass')
  assert.equal(report.tool, 'decision-record-indexer')
  assert.equal(report.summary.checked, 5)
  assert.deepEqual(report.findings, [])
  assert.equal(result.stdout.endsWith('}\n'), true)
})

test('a failing archive exits 1 and names both integrity failures', async () => {
  const result = await cli(['--root', BROKEN_ROOT, '--json'])
  assert.equal(result.code, 1)

  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'fail')
  const errors = report.findings.filter((finding) => finding.severity === 'error').map((finding) => finding.ruleId)
  assert.deepEqual(errors.sort(), [
    'front-matter-missing',
    'status-unknown',
    'supersession-cycle',
    'supersession-target-missing',
  ])
})

test('the human summary goes to stdout and mentions the graph', async () => {
  const result = await cli(['--root', CLEAN_ROOT])
  assert.equal(result.code, 0)
  assert.equal(result.stdout.includes('5 record(s) indexed from 5 file(s)'), true)
  assert.equal(result.stdout.includes('1 superseded record(s) still indexed'), true)
})

test('an unknown option is a configuration error: stdout stays empty, exit 2', async () => {
  const result = await cli(['--root', CLEAN_ROOT, '--max-recrods', '5'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr.startsWith('Unknown option "--max-recrods"'), true)
})

test('a missing or unusable root is a configuration error with no report', async (t) => {
  await t.test('no root at all', async () => {
    const result = await cli(['--json'])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr.startsWith('--root is required'), true)
  })

  await t.test('a root that does not exist', async () => {
    const result = await cli(['--root', join(CLEAN_ROOT, 'nope')])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '--root could not be read: ENOENT\n')
  })

  await t.test('a limit that is not a positive integer', async () => {
    const result = await cli(['--root', CLEAN_ROOT, '--max-records', '0'])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr.startsWith('--max-records requires a positive integer'), true)
  })
})

test('a flag that carries a value is accepted once, never silently last-wins', async (t) => {
  // A repeated flag used to overwrite the earlier value with no diagnostic, so
  // the run was configured by something the caller could not see in their own
  // command line: --root a --root b checked a directory nobody named, and
  // --max-records 5 --max-records 1 applied a limit nobody asked for.
  await t.test('--root twice', async () => {
    await withTemporary(async (directory) => {
      const result = await cli(['--root', directory, '--root', CLEAN_ROOT, '--json'])
      assert.equal(result.code, 2)
      assert.equal(result.stdout, '')
      assert.equal(result.stderr.startsWith('--root was given more than once'), true)
    })
  })

  await t.test('--index twice', async () => {
    await withTemporary(async (directory) => {
      const result = await cli([
        '--root', CLEAN_ROOT,
        '--index', join(directory, 'one.json'),
        '--index', join(directory, 'two.json'),
      ])
      assert.equal(result.code, 2)
      assert.equal(result.stdout, '')
      assert.equal(result.stderr.startsWith('--index was given more than once'), true)
      assert.deepEqual(await readdir(directory), [])
    })
  })

  await t.test('a limit flag twice', async () => {
    const result = await cli(['--root', CLEAN_ROOT, '--json', '--max-records', '5', '--max-records', '1'])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr.startsWith('--max-records was given more than once'), true)
  })

  await t.test('--section stays repeatable and every value is applied', async () => {
    // Refusing this would be an over-correction: --section declares a set.
    await withTemporary(async (directory) => {
      await writeFile(join(directory, '0001-a.md'), RECORD, 'utf8')
      const result = await cli([
        '--root', directory, '--json',
        '--section', 'Context', '--section', 'Rollback plan', '--section', 'Sign-off',
      ])
      assert.equal(result.code, 0)
      assert.deepEqual(
        JSON.parse(result.stdout).findings.map((finding) => finding.location.pointer),
        ['/sections/rollback plan', '/sections/sign-off'],
      )
    })
  })

  await t.test('--json twice is the same switch, not a discarded value', async () => {
    const result = await cli(['--root', CLEAN_ROOT, '--json', '--json'])
    assert.equal(result.code, 0)
    assert.equal(JSON.parse(result.stdout).status, 'pass')
  })
})

test('an empty archive exits 2 with an incomplete report on stdout', async () => {
  await withTemporary(async (directory) => {
    const result = await cli(['--root', directory, '--json'])
    assert.equal(result.code, 2)

    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.checked, 0)
    assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['no-records-found'])
    assert.equal(result.stderr.includes('incomplete:'), true)
  })
})

test('an undecodable record exits 2 with an incomplete report, never a pass', async () => {
  await withTemporary(async (directory) => {
    await writeFile(join(directory, '0001-a.md'), RECORD, 'utf8')
    await writeFile(join(directory, '0002-b.md'), Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xc3, 0x28, 0x0a]))

    const result = await cli(['--root', directory, '--json'])
    assert.equal(result.code, 2)

    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'incomplete')
    assert.deepEqual(
      report.findings.map((finding) => [finding.location.file, finding.ruleId]),
      [['0002-b.md', 'record-not-utf8']],
    )
  })
})

test('--index writes the derived index outside the root and leaves the records alone', async () => {
  await withTemporary(async (directory) => {
    const root = join(directory, 'decisions')
    await mkdir(root)
    await writeFile(join(root, '0001-a.md'), RECORD, 'utf8')
    const destination = join(directory, 'build', 'decisions.index.json')

    // --index-root declares the tree the index may be written into; it
    // defaults to the working directory, and this one is a temporary directory.
    const result = await cli(['--root', root, '--index', destination, '--index-root', directory])
    assert.equal(result.code, 0)
    assert.equal(result.stderr, 'index written: 1 record(s), complete=true\n')

    const index = JSON.parse(await readFile(destination, 'utf8'))
    assert.equal(index.schemaVersion, '1')
    assert.deepEqual(index.records.map((item) => [item.id, item.status]), [['ADR-0001', 'accepted']])
    assert.deepEqual(index.byOwner, { team: ['ADR-0001'] })
    assert.deepEqual(await readdir(root), ['0001-a.md'])
  })
})

test('--index inside the record root is refused before anything is written', async () => {
  await withTemporary(async (directory) => {
    const root = join(directory, 'decisions')
    await mkdir(root)
    await writeFile(join(root, '0001-a.md'), RECORD, 'utf8')

    const result = await cli(['--root', root, '--index', join(root, 'index.json')])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr.includes('inside the decision record root'), true)
    assert.deepEqual(await readdir(root), ['0001-a.md'])
  })
})

test('--section is wired through to the check, not accepted and ignored', async () => {
  await withTemporary(async (directory) => {
    await writeFile(join(directory, '0001-a.md'), RECORD, 'utf8')

    const standard = await cli(['--root', directory, '--json'])
    assert.equal(standard.code, 0)
    assert.deepEqual(JSON.parse(standard.stdout).findings, [])

    const stricter = await cli(['--root', directory, '--json', '--section', 'Context', '--section', 'Rollback plan'])
    assert.equal(stricter.code, 0)
    assert.deepEqual(
      JSON.parse(stricter.stdout).findings.map((finding) => [finding.ruleId, finding.location.pointer]),
      [['section-missing', '/sections/rollback plan']],
    )
  })
})

test('--max-records is wired through and reported by name', async () => {
  await withTemporary(async (directory) => {
    await writeFile(join(directory, '0001-a.md'), RECORD, 'utf8')
    await writeFile(join(directory, '0002-b.md'), RECORD.replace(/ADR-0001/g, 'ADR-0002'), 'utf8')

    const result = await cli(['--root', directory, '--json', '--max-records', '1'])
    assert.equal(result.code, 2)

    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.checked, 1)
    assert.deepEqual(
      report.findings.map((finding) => [finding.location.file, finding.ruleId]),
      [['0002-b.md', 'too-many-records']],
    )
    assert.equal(report.findings[0].message.includes('maxRecords limit of 1'), true)
  })
})

test('every documented limit flag reaches the check it names', async (t) => {
  // A flag listed in --help that the CLI never wires through is a documented
  // limit that is silently ignored, which is how a typo turns a real failure
  // into a green run. Each case below proves the flag reaches its own rule.
  const cases = [
    [CLEAN_ROOT, '--max-records', '1', 'too-many-records'],
    [CLEAN_ROOT, '--max-record-bytes', '100', 'record-too-large'],
    [CLEAN_ROOT, '--max-front-matter-lines', '2', 'front-matter-too-long'],
    [BROKEN_ROOT, '--max-chain-depth', '1', 'supersession-too-deep'],
  ]

  for (const [root, flag, value, ruleId] of cases) {
    await t.test(flag, async () => {
      const result = await cli(['--root', root, '--json', flag, value])
      assert.equal(result.code, 2)
      const report = JSON.parse(result.stdout)
      assert.equal(report.status, 'incomplete')
      assert.equal(
        report.findings.some((finding) => finding.ruleId === ruleId),
        true,
        `${flag} did not produce ${ruleId}`,
      )
    })
  }

  await t.test('--max-depth', async () => {
    await withTemporary(async (directory) => {
      await mkdir(join(directory, 'a', 'b'), { recursive: true })
      await writeFile(join(directory, 'a', 'b', '0001-a.md'), RECORD, 'utf8')

      const shallow = await cli(['--root', directory, '--json', '--max-depth', '1'])
      assert.equal(shallow.code, 2)
      assert.deepEqual(
        JSON.parse(shallow.stdout).findings.map((finding) => [finding.location.file, finding.ruleId]),
        [['.', 'no-records-found'], ['a/b', 'directory-too-deep']],
      )

      const deep = await cli(['--root', directory, '--json', '--max-depth', '4'])
      assert.equal(deep.code, 0)
      assert.equal(JSON.parse(deep.stdout).summary.checked, 1)
    })
  })
})

test('two identical runs write byte-identical stdout', async () => {
  const first = await cli(['--root', BROKEN_ROOT, '--json'])
  const second = await cli(['--root', BROKEN_ROOT, '--json'])
  assert.equal(first.code, 1)
  assert.equal(first.stdout, second.stdout)
  assert.equal(first.stdout.length > 500, true)
})
