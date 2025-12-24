import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  DEFAULT_LIMITS,
  RULE_SEVERITY,
  createFinding,
  formatReport,
  indexDecisionRecords,
  isInside,
  resolveIndexDestination,
  searchIndex,
  validateLimits,
  validateSections,
  writeIndexFile,
} from '../src/index.mjs'

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLEAN_ROOT = join(projectDirectory, 'examples/decisions-clean')
const BROKEN_ROOT = join(projectDirectory, 'examples/decisions-broken')

async function withTemporary(run) {
  const directory = await mkdtemp(join(tmpdir(), 'decision-record-indexer-'))
  try {
    return await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const execFileAsync = promisify(execFile)

/** A named pipe: an entry that looks like a record and can never be read as one. */
async function makeFifo(path) {
  await execFileAsync('mkfifo', [path])
}

async function writeRecord(root, name, lines) {
  const path = join(root, name)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8')
  return path
}

function record(id, extra = [], status = 'accepted') {
  return [
    '---',
    `id: ${id}`,
    `title: Decision ${id}`,
    `status: ${status}`,
    'date: 2026-01-01',
    'owners: [team]',
    'systems: [core]',
    ...extra,
    '---',
    '',
    `# Decision ${id}`,
    '',
    '## Context',
    'Because.',
    '',
    '## Decision',
    'Do it.',
    '',
    '## Consequences',
    'Consequences follow.',
  ]
}

/** Every byte and timestamp under a directory, so a run can be proved read-only. */
async function snapshot(root) {
  const entries = await readdir(root, { withFileTypes: true, recursive: true })
  const rows = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    const info = await stat(path)
    rows.push([path, info.size, info.mtimeMs, await readFile(path, 'utf8')])
  }
  return rows.sort((left, right) => (left[0] === right[0] ? 0 : left[0] < right[0] ? -1 : 1))
}

test('acceptance: the clean example set indexes cleanly and passes', async () => {
  const { report, index } = await indexDecisionRecords({ root: CLEAN_ROOT })

  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.checked, 5)
  assert.equal(report.summary.errors, 0)
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.tool, 'decision-record-indexer')

  assert.deepEqual(index.records.map((item) => item.id), [
    'ADR-0001',
    'ADR-0002',
    'ADR-0003',
    'ADR-0004',
    'ADR-0005',
  ])
  assert.deepEqual(index.supersession.edges, [{ from: 'ADR-0004', to: 'ADR-0001' }])
  assert.deepEqual(index.supersession.cycles, [])
  assert.deepEqual(index.supersession.unresolved, [])
  assert.deepEqual(index.byStatus, {
    accepted: ['ADR-0002', 'ADR-0004'],
    proposed: ['ADR-0003'],
    rejected: ['ADR-0005'],
    superseded: ['ADR-0001'],
  })
  assert.deepEqual(index.bySystem, {
    billing: ['ADR-0002'],
    docs: ['ADR-0001', 'ADR-0004'],
    identity: ['ADR-0005'],
    ledger: ['ADR-0002'],
    telemetry: ['ADR-0003'],
  })
})

test('acceptance: a superseded decision stays in the index, unchanged, and stays findable', async () => {
  const before = await snapshot(CLEAN_ROOT)
  const { index } = await indexDecisionRecords({ root: CLEAN_ROOT })

  const superseded = searchIndex(index, { status: 'superseded' })
  assert.deepEqual(
    superseded.map((item) => [item.id, item.file, item.current, item.supersededBy]),
    [['ADR-0001', '0001-record-architecture-decisions.md', 'ADR-0004', ['ADR-0004']]],
  )
  assert.equal(superseded[0].title, 'Record architecture decisions')
  assert.equal(superseded[0].decision.startsWith('Keep one Markdown record per decision'), true)

  // Reading history must not rewrite it: not one byte, not one timestamp.
  assert.deepEqual(await snapshot(CLEAN_ROOT), before)
})

test('acceptance: the broken example set fails with exactly these findings, in this order', async () => {
  const { report } = await indexDecisionRecords({ root: BROKEN_ROOT })

  assert.equal(report.status, 'fail')
  assert.deepEqual(
    report.findings.map((finding) => [finding.location.file, finding.location.pointer, finding.ruleId]),
    [
      ['0010-cache-writes.md', '/front-matter/status', 'status-supersession-mismatch'],
      ['0010-cache-writes.md', '/front-matter/superseded-by', 'supersession-asymmetric'],
      ['0010-cache-writes.md', '/supersedes', 'supersession-cycle'],
      ['0011-cache-reads.md', '/front-matter/status', 'status-supersession-mismatch'],
      ['0011-cache-reads.md', '/front-matter/superseded-by', 'supersession-asymmetric'],
      ['0012-retire-the-queue.md', '/front-matter/owners', 'owners-missing'],
      ['0012-retire-the-queue.md', '/sections/consequences', 'section-missing'],
      ['0012-retire-the-queue.md', '/supersedes/0', 'supersession-target-missing'],
      ['0013-approve-the-rollout.md', '/front-matter/date', 'date-invalid'],
      ['0013-approve-the-rollout.md', '/front-matter/reviewers', 'front-matter-key-unknown'],
      ['0013-approve-the-rollout.md', '/front-matter/status', 'status-unknown'],
      ['notes-without-front-matter.md', '/front-matter', 'front-matter-missing'],
    ],
  )
  assert.equal(report.summary.errors, 4)
  assert.equal(report.summary.warnings, 8)
})

test('acceptance: a supersession cycle fails the run', async () => {
  await withTemporary(async (directory) => {
    await writeRecord(directory, '0001-a.md', record('ADR-0001', ['supersedes: [ADR-0002]']))
    await writeRecord(directory, '0002-b.md', record('ADR-0002', ['supersedes: [ADR-0001]']))

    const { report, index } = await indexDecisionRecords({ root: directory })
    assert.equal(report.status, 'fail')
    const cycle = report.findings.filter((finding) => finding.ruleId === 'supersession-cycle')
    assert.equal(cycle.length, 1)
    assert.equal(cycle[0].severity, 'error')
    assert.equal(
      cycle[0].message,
      'Supersession forms a cycle of 2 record(s): ADR-0001 -> ADR-0002 -> ADR-0001. No record in it can be the decision that stands.',
    )
    assert.deepEqual(index.supersession.cycles, [['ADR-0001', 'ADR-0002']])
    assert.deepEqual(index.records.map((item) => item.current), [null, null])
  })
})

test('acceptance: a record that supersedes itself fails the run', async () => {
  await withTemporary(async (directory) => {
    await writeRecord(directory, '0001-a.md', record('ADR-0001', ['supersedes: [ADR-0001]']))
    const { report } = await indexDecisionRecords({ root: directory })
    assert.equal(report.status, 'fail')
    assert.deepEqual(
      report.findings.map((finding) => [finding.ruleId, finding.severity, finding.location.pointer]),
      [['supersession-self', 'error', '/supersedes/0']],
    )
  })
})

test('acceptance: a supersession target that does not exist fails the run', async () => {
  await withTemporary(async (directory) => {
    await writeRecord(directory, '0001-a.md', record('ADR-0001', ['superseded-by: [ADR-4242]']))
    const { report, index } = await indexDecisionRecords({ root: directory })

    assert.equal(report.status, 'fail')
    assert.deepEqual(
      report.findings.map((finding) => [finding.ruleId, finding.severity, finding.location.pointer, finding.evidence]),
      [['supersession-target-missing', 'error', '/superseded-by/0', 'ADR-4242']],
    )
    assert.deepEqual(index.supersession.unresolved, [
      { from: 'ADR-4242', to: 'ADR-0001', missing: 'ADR-4242' },
    ])
  })
})

test('a chain of supersessions resolves every historical record to the decision that stands', async () => {
  await withTemporary(async (directory) => {
    await writeRecord(directory, '0001-a.md', record('ADR-0001', ['superseded-by: [ADR-0002]'], 'superseded'))
    await writeRecord(
      directory,
      '0002-b.md',
      record('ADR-0002', ['supersedes: [ADR-0001]', 'superseded-by: [ADR-0003]'], 'superseded'),
    )
    await writeRecord(directory, '0003-c.md', record('ADR-0003', ['supersedes: [ADR-0002]']))

    const { report, index } = await indexDecisionRecords({ root: directory })
    assert.equal(report.status, 'pass')
    assert.deepEqual(
      index.records.map((item) => [item.id, item.status, item.current]),
      [
        ['ADR-0001', 'superseded', 'ADR-0003'],
        ['ADR-0002', 'superseded', 'ADR-0003'],
        ['ADR-0003', 'accepted', null],
      ],
    )
  })
})

test('a status that disagrees with the graph is reported in both directions', async () => {
  await withTemporary(async (directory) => {
    await writeRecord(directory, '0001-a.md', record('ADR-0001', ['superseded-by: [ADR-0002]']))
    await writeRecord(directory, '0002-b.md', record('ADR-0002', ['supersedes: [ADR-0001]'], 'superseded'))

    const { report } = await indexDecisionRecords({ root: directory })
    assert.deepEqual(
      report.findings.map((finding) => [finding.location.file, finding.ruleId, finding.message]),
      [
        [
          '0001-a.md',
          'status-supersession-mismatch',
          'Record is superseded by another record but its status is "accepted".',
        ],
        [
          '0002-b.md',
          'status-supersession-mismatch',
          'Record has status superseded but no other record declares that it supersedes it.',
        ],
      ],
    )
  })
})

test('an empty record set is incomplete, never a pass on no evidence', async () => {
  await withTemporary(async (directory) => {
    const { report, index } = await indexDecisionRecords({ root: directory })

    // If the incomplete flag on this path were removed, status would become
    // "pass" with checked 0 -- green on nothing checked at all. The severity of
    // the accompanying finding is only a warning, so the flag is the one thing
    // standing between an empty archive and a clean bill of health.
    assert.equal(report.status, 'incomplete')
    assert.notEqual(report.status, 'pass')
    assert.equal(report.summary.checked, 0)
    assert.deepEqual(
      report.findings.map((finding) => [finding.ruleId, finding.severity, finding.location.file]),
      [['no-records-found', 'warning', '.']],
    )
    assert.equal(index.complete, false)
    assert.equal(index.status, 'incomplete')
  })
})

test('a root holding only unindexable files is incomplete, not a pass', async () => {
  await withTemporary(async (directory) => {
    await writeFile(join(directory, '0001-a.md'), '# no front matter\n', 'utf8')
    const { report } = await indexDecisionRecords({ root: directory })

    assert.equal(report.status, 'incomplete')
    assert.deepEqual(report.findings.map((finding) => finding.ruleId), [
      'no-records-found',
      'front-matter-missing',
    ])
    assert.equal(report.summary.files, 1)
    assert.equal(report.summary.skipped, 1)
  })
})

test('a record that could not be indexed never rides along inside a passing run', async (t) => {
  // Each case puts one unindexable record beside one good one, so the run has
  // something to report a pass on. Nothing on these three paths sets the
  // `incomplete` flag: the severity of the accompanying rule is the only thing
  // between each of these runs and a green one, and a root holding a file the
  // tool could not parse, or could not give an identity, must never pass.
  await t.test('front matter that is opened and never closed', async () => {
    await withTemporary(async (directory) => {
      await writeRecord(directory, '0001-a.md', record('ADR-0001'))
      await writeFile(join(directory, '0003-unterminated.md'), '---\nid: ADR-0003\nstatus: accepted\n', 'utf8')

      const { report, index } = await indexDecisionRecords({ root: directory })

      assert.equal(report.status, 'fail')
      assert.notEqual(report.status, 'pass')
      assert.deepEqual(
        report.findings.map((finding) => [finding.location.file, finding.ruleId, finding.severity]),
        [['0003-unterminated.md', 'front-matter-invalid', 'error']],
      )
      assert.equal(report.summary.errors, 1)
      assert.equal(report.summary.skipped, 1)
      assert.equal(report.summary.files, 2)
      assert.deepEqual(index.records.map((item) => item.id), ['ADR-0001'])
    })
  })

  await t.test('a file with no front matter at all', async () => {
    await withTemporary(async (directory) => {
      await writeRecord(directory, '0001-a.md', record('ADR-0001'))
      await writeFile(join(directory, '0004-notes.md'), '# Just notes\n\nNo front matter here.\n', 'utf8')

      const { report, index } = await indexDecisionRecords({ root: directory })

      assert.equal(report.status, 'fail')
      assert.deepEqual(
        report.findings.map((finding) => [finding.location.file, finding.ruleId, finding.severity]),
        [['0004-notes.md', 'front-matter-missing', 'error']],
      )
      assert.equal(report.summary.skipped, 1)
      assert.deepEqual(index.records.map((item) => item.id), ['ADR-0001'])
    })
  })

  await t.test('a record that declares no id', async () => {
    await withTemporary(async (directory) => {
      await writeRecord(directory, '0001-a.md', record('ADR-0001'))
      await writeRecord(directory, '0005-noid.md', [
        '---',
        'title: Decision without an id',
        'status: accepted',
        'date: 2026-01-01',
        'owners: [team]',
        'systems: [core]',
        '---',
        '',
        '# Decision without an id',
        '',
        '## Context',
        'Because.',
        '',
        '## Decision',
        'Do it.',
        '',
        '## Consequences',
        'Consequences follow.',
      ])

      const { report, index } = await indexDecisionRecords({ root: directory })

      assert.equal(report.status, 'fail')
      assert.notEqual(report.status, 'pass')
      assert.deepEqual(
        report.findings.map((finding) => [finding.location.file, finding.ruleId, finding.severity]),
        [['0005-noid.md', 'record-id-missing', 'error']],
      )
      assert.equal(report.summary.skipped, 1)
      assert.deepEqual(index.records.map((item) => item.id), ['ADR-0001'])
    })
  })
})

test('a record that is not UTF-8 is incomplete evidence, never a pass', async () => {
  await withTemporary(async (directory) => {
    await writeRecord(directory, '0001-a.md', record('ADR-0001'))
    await writeFile(join(directory, '0002-b.md'), Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x0a]))

    const { report } = await indexDecisionRecords({ root: directory })
    assert.equal(report.status, 'incomplete')
    assert.deepEqual(
      report.findings.map((finding) => [finding.location.file, finding.ruleId, finding.severity]),
      [['0002-b.md', 'record-not-utf8', 'error']],
    )
    assert.equal(report.summary.checked, 1)
    assert.equal(report.summary.skipped, 1)
  })
})

test('evidence that could not be obtained is incomplete, never a pass', async (t) => {
  // Each of these is a place where the run failed to read something. Every one
  // asserts "incomplete" rather than merely "not pass", so deleting the flag
  // that marks the run incomplete fails the test even though the accompanying
  // finding would still be an error.
  await t.test('a dangling symlink cannot be resolved', async () => {
    await withTemporary(async (directory) => {
      await writeRecord(directory, '0001-a.md', record('ADR-0001'))
      await symlink(join(directory, 'gone.md'), join(directory, '0002-dangling.md'))

      const { report } = await indexDecisionRecords({ root: directory })
      assert.equal(report.status, 'incomplete')
      assert.deepEqual(
        report.findings.map((finding) => [finding.location.file, finding.ruleId, finding.message]),
        [['0002-dangling.md', 'record-unreadable', 'Entry could not be resolved: ENOENT.']],
      )
    })
  })

  await t.test('a record whose bytes cannot be read', { skip: process.getuid?.() === 0 }, async () => {
    await withTemporary(async (directory) => {
      await writeRecord(directory, '0001-a.md', record('ADR-0001'))
      const locked = await writeRecord(directory, '0002-locked.md', record('ADR-0002'))
      await chmod(locked, 0o000)

      const { report } = await indexDecisionRecords({ root: directory })
      assert.equal(report.status, 'incomplete')
      assert.deepEqual(
        report.findings.map((finding) => [finding.location.file, finding.ruleId, finding.severity]),
        [['0002-locked.md', 'record-unreadable', 'error']],
      )
      assert.equal(report.summary.checked, 1)
      await chmod(locked, 0o600)
    })
  })

  await t.test('an entry named like a record that is not a regular file', { skip: process.platform === 'win32' }, async () => {
    await withTemporary(async (directory) => {
      await writeRecord(directory, '0001-a.md', record('ADR-0001'))
      await makeFifo(join(directory, '0002-pipe.md'))

      const { report, index } = await indexDecisionRecords({ root: directory })

      // Silently dropping this entry would report a clean bill of health over a
      // root holding a record-shaped thing nobody examined.
      assert.equal(report.status, 'incomplete')
      assert.notEqual(report.status, 'pass')
      assert.deepEqual(
        report.findings.map((finding) => [finding.location.file, finding.ruleId, finding.severity]),
        [['0002-pipe.md', 'record-unreadable', 'error']],
      )
      assert.equal(
        report.findings[0].message,
        'Entry is named like a record but is not a regular file, so nothing could be read from it.',
      )
      assert.equal(index.complete, false)
      assert.deepEqual(index.records.map((item) => item.id), ['ADR-0001'])
    })
  })

  await t.test('a directory that cannot be listed', { skip: process.getuid?.() === 0 }, async () => {
    await withTemporary(async (directory) => {
      await writeRecord(directory, '0001-a.md', record('ADR-0001'))
      const locked = join(directory, 'archive')
      await mkdir(locked)
      await chmod(locked, 0o000)

      const { report } = await indexDecisionRecords({ root: directory })
      assert.equal(report.status, 'incomplete')
      assert.deepEqual(
        report.findings.map((finding) => [finding.location.file, finding.ruleId]),
        [['archive', 'record-unreadable']],
      )
      await chmod(locked, 0o700)
    })
  })
})

test('each documented limit is enforced and makes the run incomplete', async (t) => {
  await t.test('maxRecords', async () => {
    await withTemporary(async (directory) => {
      await writeRecord(directory, '0001-a.md', record('ADR-0001'))
      await writeRecord(directory, '0002-b.md', record('ADR-0002'))
      await writeRecord(directory, '0003-c.md', record('ADR-0003'))

      const { report } = await indexDecisionRecords({ root: directory, limits: { maxRecords: 2 } })
      assert.equal(report.status, 'incomplete')
      assert.equal(report.summary.checked, 2)
      assert.deepEqual(
        report.findings.map((finding) => [finding.location.file, finding.ruleId]),
        [['0003-c.md', 'too-many-records']],
      )
    })
  })

  await t.test('maxRecordBytes', async () => {
    await withTemporary(async (directory) => {
      await writeRecord(directory, '0001-a.md', record('ADR-0001'))
      const { report } = await indexDecisionRecords({ root: directory, limits: { maxRecordBytes: 32 } })
      assert.equal(report.status, 'incomplete')
      assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['no-records-found', 'record-too-large'])
    })
  })

  await t.test('maxDepth', async () => {
    await withTemporary(async (directory) => {
      await writeRecord(directory, 'a/b/c/0001-a.md', record('ADR-0001'))
      const { report } = await indexDecisionRecords({ root: directory, limits: { maxDepth: 2 } })
      assert.equal(report.status, 'incomplete')
      assert.deepEqual(
        report.findings.map((finding) => [finding.location.file, finding.ruleId]),
        [['.', 'no-records-found'], ['a/b/c', 'directory-too-deep']],
      )
    })
  })

  await t.test('maxFrontMatterLines', async () => {
    await withTemporary(async (directory) => {
      await writeRecord(directory, '0001-a.md', record('ADR-0001'))
      const { report } = await indexDecisionRecords({ root: directory, limits: { maxFrontMatterLines: 3 } })
      assert.equal(report.status, 'incomplete')
      assert.deepEqual(
        report.findings.map((finding) => [finding.ruleId, finding.location.pointer]),
        [['no-records-found', '/'], ['front-matter-too-long', '/front-matter']],
      )
    })
  })

  await t.test('maxChainDepth', async () => {
    await withTemporary(async (directory) => {
      for (let number = 1; number <= 6; number += 1) {
        const extra = []
        if (number < 6) extra.push(`supersedes: [ADR-000${number + 1}]`)
        if (number > 1) extra.push(`superseded-by: [ADR-000${number - 1}]`)
        const status = number === 1 ? 'accepted' : 'superseded'
        await writeRecord(directory, `000${number}-a.md`, record(`ADR-000${number}`, extra, status))
      }

      const deep = await indexDecisionRecords({ root: directory, limits: { maxChainDepth: 3 } })
      assert.equal(deep.report.status, 'incomplete')
      assert.deepEqual(
        deep.report.findings
          .filter((finding) => finding.ruleId === 'supersession-too-deep')
          .map((finding) => [finding.severity, finding.location.file]),
        [['error', '.']],
      )
      assert.deepEqual(deep.index.records.map((item) => item.current), [null, null, null, null, null, null])

      const shallow = await indexDecisionRecords({ root: directory, limits: { maxChainDepth: 64 } })
      assert.equal(shallow.report.status, 'pass')
      assert.deepEqual(shallow.index.records.map((item) => item.current), [
        null,
        'ADR-0001',
        'ADR-0001',
        'ADR-0001',
        'ADR-0001',
        'ADR-0001',
      ])
    })
  })
})

test('a symlink to a file outside the root is refused and its content never reaches the report', async () => {
  await withTemporary(async (outside) => {
    await writeFile(join(outside, 'secret.md'), '---\nid: OUTSIDE-1\n---\n\n# tangerine-passphrase\n', 'utf8')
    await withTemporary(async (directory) => {
      await writeRecord(directory, '0001-a.md', record('ADR-0001'))
      await symlink(join(outside, 'secret.md'), join(directory, '0002-escape.md'))

      const { report, index } = await indexDecisionRecords({ root: directory })
      const serialized = JSON.stringify({ report, index })

      assert.deepEqual(
        report.findings.map((finding) => [finding.location.file, finding.ruleId, finding.severity]),
        [['0002-escape.md', 'path-escapes-root', 'error']],
      )
      assert.equal(report.status, 'fail')
      assert.equal(serialized.includes('tangerine-passphrase'), false)
      assert.equal(serialized.includes('OUTSIDE-1'), false)
      assert.equal(serialized.includes(outside), false)
      assert.deepEqual(index.records.map((item) => item.id), ['ADR-0001'])
    })
  })
})

test('a symlink to a directory outside the root is refused and never walked', async () => {
  await withTemporary(async (outside) => {
    await mkdir(join(outside, 'archive'))
    await writeFile(join(outside, 'archive', '0099-x.md'), '---\nid: OUTSIDE-2\n---\n\n# kumquat-token\n', 'utf8')
    await withTemporary(async (directory) => {
      await writeRecord(directory, '0001-a.md', record('ADR-0001'))
      await symlink(join(outside, 'archive'), join(directory, 'linked'))

      const { report, index } = await indexDecisionRecords({ root: directory })
      const serialized = JSON.stringify({ report, index })

      assert.deepEqual(
        report.findings.map((finding) => [finding.location.file, finding.ruleId]),
        [['linked', 'path-escapes-root']],
      )
      assert.equal(serialized.includes('kumquat-token'), false)
      assert.equal(serialized.includes('OUTSIDE-2'), false)
      assert.equal(serialized.includes(outside), false)
    })
  })
})

test('a symlink that stays inside the root does not index the same record twice', async () => {
  await withTemporary(async (directory) => {
    await writeRecord(directory, '0001-a.md', record('ADR-0001'))
    await symlink(join(directory, '0001-a.md'), join(directory, '0002-alias.md'))

    const { report, index } = await indexDecisionRecords({ root: directory })
    assert.equal(report.status, 'pass')
    assert.deepEqual(index.records.map((item) => item.file), ['0001-a.md'])
    assert.equal(report.summary.files, 1)
  })
})

test('two records claiming one id is an error, and neither file is rewritten', async () => {
  await withTemporary(async (directory) => {
    await writeRecord(directory, '0001-a.md', record('ADR-0001'))
    await writeRecord(directory, '0001-duplicate.md', record('ADR-0001'))
    const before = await snapshot(directory)

    const { report, index } = await indexDecisionRecords({ root: directory })
    assert.equal(report.status, 'fail')
    assert.deepEqual(
      report.findings.map((finding) => [finding.location.file, finding.ruleId, finding.severity]),
      [['0001-duplicate.md', 'record-id-duplicate', 'error']],
    )
    assert.deepEqual(index.records.map((item) => item.file), ['0001-a.md'])
    assert.deepEqual(await snapshot(directory), before)
  })
})

test('required sections are configurable and the choice is actually applied', async () => {
  await withTemporary(async (directory) => {
    await writeRecord(directory, '0001-a.md', record('ADR-0001'))

    const standard = await indexDecisionRecords({ root: directory })
    assert.deepEqual(standard.report.findings, [])

    const stricter = await indexDecisionRecords({ root: directory, sections: ['Context', 'Rollback plan'] })
    assert.deepEqual(
      stricter.report.findings.map((finding) => [finding.ruleId, finding.location.pointer, finding.message]),
      [['section-missing', '/sections/rollback plan', 'Record has no "Rollback plan" heading.']],
    )
  })
})

test('a filename that numbers a record differently from its id is reported', async () => {
  await withTemporary(async (directory) => {
    await writeRecord(directory, '0007-mismatch.md', record('ADR-0003'))
    const { report } = await indexDecisionRecords({ root: directory })
    assert.deepEqual(
      report.findings.map((finding) => [finding.ruleId, finding.severity, finding.evidence]),
      [['record-id-mismatch', 'warning', '0007-mismatch.md']],
    )
  })
})

test('a record with no id cannot be indexed and is reported', async () => {
  await withTemporary(async (directory) => {
    await writeFile(
      join(directory, '0001-a.md'),
      '---\nstatus: accepted\nowners: [team]\nsystems: [core]\n---\n\n# Untitled decision\n\n## Context\nx\n\n## Decision\ny\n\n## Consequences\nz\n',
      'utf8',
    )
    const { report } = await indexDecisionRecords({ root: directory })
    assert.equal(report.status, 'incomplete')
    assert.deepEqual(
      report.findings.map((finding) => [finding.ruleId, finding.location.pointer]),
      [['no-records-found', '/'], ['record-id-missing', '/front-matter/id']],
    )
  })
})

test('unknown configuration is refused rather than quietly ignored', async () => {
  await assert.rejects(
    () => indexDecisionRecords({ root: CLEAN_ROOT, section: ['Context'] }),
    /Unknown option "section"/,
  )
  assert.throws(() => validateLimits({ maxRecrods: 5 }), /Unknown limit "maxRecrods"/)
  assert.throws(() => validateLimits({ maxRecords: 0 }), /must be a positive integer/)
  assert.throws(() => validateSections(['Context', 'context']), /declared twice/)
  assert.throws(() => validateSections('Context'), /must be an array/)
  assert.throws(() => searchIndex({ records: [] }, { owners: 'team' }), /Unknown search key "owners"/)
  assert.deepEqual({ ...validateLimits({}) }, { ...DEFAULT_LIMITS })
})

test('a finding cannot be built for a rule the severity table does not define', () => {
  assert.throws(
    () => createFinding({ ruleId: 'invented-rule', message: 'x', file: 'a.md', pointer: '/' }),
    /not in RULE_SEVERITY/,
  )
  assert.deepEqual(
    createFinding({ ruleId: 'title-missing', message: 'x', file: 'a.md', pointer: '/front-matter/title', line: 0 }),
    {
      ruleId: 'title-missing',
      severity: RULE_SEVERITY['title-missing'],
      message: 'x',
      location: { file: 'a.md', pointer: '/front-matter/title' },
    },
  )
})

test('search filters combine, fold case and return records in id order', async () => {
  const { index } = await indexDecisionRecords({ root: CLEAN_ROOT })

  assert.deepEqual(searchIndex(index, { owner: 'Platform-Team' }).map((item) => item.id), [
    'ADR-0001',
    'ADR-0002',
    'ADR-0004',
  ])
  assert.deepEqual(searchIndex(index, { owner: 'ledger-team' }).map((item) => item.id), ['ADR-0002'])
  assert.deepEqual(searchIndex(index, { system: 'ledger' }).map((item) => item.id), ['ADR-0002'])
  assert.deepEqual(searchIndex(index, { tag: 'process', status: 'accepted' }).map((item) => item.id), ['ADR-0004'])
  assert.deepEqual(searchIndex(index, { text: 'PostgreSQL' }).map((item) => item.id), ['ADR-0002'])
  assert.deepEqual(searchIndex(index, { status: 'deprecated' }), [])
  assert.deepEqual(searchIndex(index, {}).map((item) => item.id), index.records.map((item) => item.id))
})

test('two runs over the same records produce byte-identical output', async () => {
  const first = await indexDecisionRecords({ root: BROKEN_ROOT })
  const second = await indexDecisionRecords({ root: BROKEN_ROOT })
  assert.equal(JSON.stringify(first.report), JSON.stringify(second.report))
  assert.equal(JSON.stringify(first.index), JSON.stringify(second.index))
})

test('the index destination is refused inside the record root, symlinked parent included', async () => {
  await withTemporary(async (directory) => {
    const root = join(directory, 'decisions')
    await mkdir(root)
    await writeRecord(root, '0001-a.md', record('ADR-0001'))
    await mkdir(join(directory, 'sneaky'))
    await symlink(root, join(directory, 'sneaky', 'back-inside'))
    const rootReal = await realpath(root)

    await assert.rejects(
      () => resolveIndexDestination(rootReal, join(root, 'index.json')),
      /inside the decision record root/,
    )
    await assert.rejects(
      () => resolveIndexDestination(rootReal, join(root, 'nested', 'deep', 'index.json')),
      /inside the decision record root/,
    )
    await assert.rejects(
      () => resolveIndexDestination(rootReal, join(directory, 'sneaky', 'back-inside', 'index.json')),
      /inside the decision record root/,
    )
    await assert.rejects(() => resolveIndexDestination(rootReal, root), /inside the decision record root/)
    await assert.rejects(() => resolveIndexDestination(rootReal, directory), /is a directory, not a file/)

    const allowed = await resolveIndexDestination(rootReal, join(directory, 'out', 'index.json'))
    assert.equal(isInside(rootReal, allowed), false)

    const { index } = await indexDecisionRecords({ root })
    await writeIndexFile(allowed, index)
    const written = JSON.parse(await readFile(allowed, 'utf8'))
    assert.deepEqual(written.records.map((item) => item.id), ['ADR-0001'])
    assert.deepEqual(await readdir(root), ['0001-a.md'])
  })
})

test('a missing root is a configuration error, not a report', async () => {
  await assert.rejects(
    () => indexDecisionRecords({ root: join(CLEAN_ROOT, 'does-not-exist') }),
    /could not be read: ENOENT/,
  )
  await assert.rejects(
    () => indexDecisionRecords({ root: join(CLEAN_ROOT, '0001-record-architecture-decisions.md') }),
    /must be a directory/,
  )
  await assert.rejects(() => indexDecisionRecords({}), /A decision record root is required/)
})

test('a record missing its descriptive metadata is reported field by field', async () => {
  await withTemporary(async (directory) => {
    await writeFile(
      join(directory, '0001-a.md'),
      '---\nid: ADR-0001\n---\n\n## Context\nx\n\n## Decision\ny\n\n## Consequences\nz\n',
      'utf8',
    )
    const { report, index } = await indexDecisionRecords({ root: directory })

    assert.equal(report.status, 'fail')
    assert.deepEqual(
      report.findings.map((finding) => [finding.location.pointer, finding.ruleId, finding.severity]),
      [
        ['/front-matter/owners', 'owners-missing', 'warning'],
        ['/front-matter/status', 'status-missing', 'error'],
        ['/front-matter/systems', 'systems-missing', 'info'],
        ['/front-matter/title', 'title-missing', 'warning'],
      ],
    )
    assert.equal(report.summary.info, 1)
    // The record is still indexed: an incomplete record is still history.
    assert.deepEqual(index.records.map((item) => [item.id, item.status, item.title]), [['ADR-0001', '', '']])
    assert.deepEqual(index.byStatus, {})
  })
})

test('formatReport renders each finding with its location, rule and message', async () => {
  await withTemporary(async (directory) => {
    await writeRecord(directory, '0001-a.md', record('ADR-0001', ['supersedes: [ADR-0001]']))
    const { report } = await indexDecisionRecords({ root: directory })

    assert.deepEqual(formatReport(report).split('\n'), [
      '1 record(s) indexed from 1 file(s): 1 error, 0 warning, 0 info, status fail.',
      'supersession: 0 edge(s), 0 cycle(s), 0 unresolved reference(s), 0 superseded record(s) still indexed.',
      'ERROR   0001-a.md/supersedes/0 supersession-self Record "ADR-0001" declares that it supersedes itself.',
      '',
    ])
  })
})

test('search and destination helpers refuse arguments that are not what they claim', async () => {
  assert.throws(() => searchIndex({ nope: true }, {}), /needs a decision index with a records array/)
  assert.throws(() => searchIndex({ records: [] }, 'status'), /Query must be an object/)
  assert.throws(() => searchIndex({ records: [] }, { status: 7 }), /must be a string/)
  assert.throws(() => validateSections([42]), /non-empty string/)
  assert.throws(() => validateSections(['x'.repeat(81)]), /too long/)
  assert.throws(
    () => validateSections(Array.from({ length: 17 }, (unused, position) => `Section ${position}`)),
    /At most 16 required sections/,
  )
  await assert.rejects(() => resolveIndexDestination('/tmp', ''), /non-empty path/)
})
