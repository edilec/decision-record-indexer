import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { byCodeUnit, indexDecisionRecords } from '../src/index.mjs'

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Determinism is a headline guarantee of this tool: two runs over the same
 * bytes produce byte-identical output, whatever the locale, the Node build or
 * the order the filesystem hands back its entries.
 *
 * Two runs in one process and one locale cannot prove any of that. Every test
 * here pins the property that would actually break: the comparator's own
 * ordering, each sort that stands between enumeration order and the report, and
 * the absence of the ambient sources the documentation promises are unread.
 */

const SHIPPED_SOURCE = ['src/index.mjs', 'src/parse.mjs', 'src/graph.mjs', 'bin/decision-record-indexer.mjs']

async function withTemporary(body) {
  const directory = await mkdtemp(join(tmpdir(), 'decision-record-indexer-determinism-'))
  try {
    return await body(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function writeRecord(root, name, lines) {
  const path = join(root, name)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8')
  return path
}

function record(id, systems = ['core']) {
  return [
    '---',
    `id: ${id}`,
    `title: Decision ${id}`,
    'status: accepted',
    'owners: [team]',
    `systems: [${systems.join(', ')}]`,
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

test('no comparison in the shipped source is locale-sensitive', async () => {
  // `localeCompare` reads ICU data that differs between Node builds and between
  // locales, so swapping it in changes real output order while two runs in one
  // process still agree with each other. Nothing else in the suite can see that,
  // which is why the source is asserted directly.
  for (const path of SHIPPED_SOURCE) {
    const source = await readFile(resolve(projectDirectory, path), 'utf8')
    assert.equal(
      source.includes('localeCompare'),
      false,
      `${path} compares with localeCompare, whose result depends on ICU data`,
    )
  }
})

test('nothing in the shipped source reads the clock, a random source or the environment', async () => {
  const forbidden = [
    [/Math\.random/, 'a random source'],
    [/Date\.now|new Date\(/, 'the wall clock'],
    [/process\.env/, 'the environment'],
    [/node:https?|node:net|node:dns|\bfetch\(/, 'the network'],
  ]
  for (const path of SHIPPED_SOURCE) {
    const source = await readFile(resolve(projectDirectory, path), 'utf8')
    for (const [pattern, what] of forbidden) {
      assert.equal(pattern.test(source), false, `${path} reads ${what}, so two runs need not agree`)
    }
  }
})

test('byCodeUnit orders by UTF-16 code unit, which is not collation order', () => {
  // Every one of these pairs is ordered the other way round by an English
  // collator, so a locale-sensitive comparator cannot satisfy them.
  assert.equal(byCodeUnit('ADR-Banana', 'ADR-apple') < 0, true)
  assert.equal(byCodeUnit('ADR-apple', 'ADR-Apple') > 0, true)
  assert.equal(byCodeUnit('ADR-cherry', 'ADR-Äpfel') < 0, true)
  assert.equal(byCodeUnit('ADR-0001', 'ADR-0001'), 0)
  assert.deepEqual(
    ['ADR-cherry', 'ADR-Äpfel', 'ADR-Banana', 'ADR-apple'].sort(byCodeUnit),
    ['ADR-Banana', 'ADR-apple', 'ADR-cherry', 'ADR-Äpfel'],
  )
})

test('record ids and group keys reach the index in code-unit order, not collation order', async () => {
  await withTemporary(async (directory) => {
    await writeRecord(directory, 'banana.md', record('ADR-Banana', ['zebra', 'ärger']))
    await writeRecord(directory, 'apple.md', record('ADR-apple', ['zebra']))
    await writeRecord(directory, 'cherry.md', record('ADR-cherry', ['ärger']))
    await writeRecord(directory, 'apfel.md', record('ADR-Äpfel', ['zebra']))

    const { report, index } = await indexDecisionRecords({ root: directory })
    assert.equal(report.status, 'pass')

    assert.deepEqual(index.records.map((item) => item.id), [
      'ADR-Banana',
      'ADR-apple',
      'ADR-cherry',
      'ADR-Äpfel',
    ])
    assert.deepEqual(Object.keys(index.bySystem), ['zebra', 'ärger'])
    assert.deepEqual(index.bySystem.zebra, ['ADR-Banana', 'ADR-apple', 'ADR-Äpfel'])
    assert.deepEqual(index.records[0].systems, ['zebra', 'ärger'])
  })
})

test('the record array is ordered by id, never by the name of the file it came from', async () => {
  await withTemporary(async (directory) => {
    await writeRecord(directory, 'aaa-first.md', record('ADR-0099'))
    await writeRecord(directory, 'zzz-last.md', record('ADR-0001'))

    const { report, index } = await indexDecisionRecords({ root: directory })
    assert.equal(report.status, 'pass')
    assert.deepEqual(
      index.records.map((item) => [item.id, item.file]),
      [['ADR-0001', 'zzz-last.md'], ['ADR-0099', 'aaa-first.md']],
    )
  })
})

test('which record wins a duplicate id follows path order, not the order the walk reached them', async () => {
  // The walk descends into "a" before it reads "a-b.md", because "a" sorts
  // first as a directory entry -- but "a-b.md" sorts before "a/z.md" as a path.
  // Without the sort over collected files, the record that keeps the id is
  // whichever the walk happened to reach first.
  await withTemporary(async (directory) => {
    await writeRecord(directory, 'a/z.md', record('ADR-0001'))
    await writeRecord(directory, 'a-b.md', record('ADR-0001'))

    const { report, index } = await indexDecisionRecords({ root: directory })
    assert.equal(report.status, 'fail')
    assert.deepEqual(index.records.map((item) => item.file), ['a-b.md'])
    assert.deepEqual(
      report.findings.map((finding) => [finding.location.file, finding.ruleId]),
      [['a/z.md', 'record-id-duplicate']],
    )
    assert.equal(report.findings[0].message.includes('already declared by a-b.md'), true)
  })
})

test('which records a limit keeps follows code-unit order, not the order the filesystem listed them', async () => {
  // A directory listing is commonly returned in UTF-8 byte order, which agrees
  // with UTF-16 code-unit order for almost every name -- except across an
  // astral character and a high BMP one, where the two orders are opposite.
  // That is the one pair that can tell a sorted walk from an unsorted one here.
  const astral = `${String.fromCodePoint(0x1f600)}.md`
  const highBmp = `${String.fromCharCode(0xfffd)}.md`
  assert.equal(byCodeUnit(astral, highBmp) < 0, true)

  await withTemporary(async (directory) => {
    await writeRecord(directory, astral, record('ADR-ASTRAL'))
    await writeRecord(directory, highBmp, record('ADR-REPLACEMENT'))

    const { report, index } = await indexDecisionRecords({ root: directory, limits: { maxRecords: 1 } })
    assert.equal(report.status, 'incomplete')
    assert.deepEqual(index.records.map((item) => item.id), ['ADR-ASTRAL'])
    assert.deepEqual(
      report.findings.map((finding) => [finding.location.file, finding.ruleId]),
      [[highBmp, 'too-many-records']],
    )
  })
})
