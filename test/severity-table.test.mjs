import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { DEFAULT_LIMITS, RULE_SEVERITY, STATUS_VALUES } from '../src/index.mjs'

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Severity decides whether a run fails or passes, so it is the one thing in
 * this tool most worth pinning. Two dozen construction sites each carrying
 * their own literal is exactly the shape that drifts silently; these tests
 * assert the single table, the documented catalog and the shipped source all
 * agree, in both directions.
 */

async function readProjectFile(relativePath) {
  return readFile(resolve(projectDirectory, relativePath), 'utf8')
}

async function documentedSeverities() {
  const text = await readProjectFile('docs/decision-rules.md')
  const rows = [...text.matchAll(/\|\s*`([a-z0-9-]+)`\s*\|\s*(error|warning|info)\s*\|/g)]
  return Object.fromEntries(rows.map((row) => [row[1], row[2]]))
}

test('the documented rule catalog matches the severity table exactly', async () => {
  const documented = await documentedSeverities()

  assert.equal(Object.keys(documented).length, 28)
  assert.deepEqual(
    Object.keys(documented).sort(),
    Object.keys(RULE_SEVERITY).sort(),
    'docs/decision-rules.md and RULE_SEVERITY list different rules',
  )
  assert.deepEqual(documented, { ...RULE_SEVERITY })
})

test('every rule the source emits is defined in the severity table', async () => {
  const source = `${await readProjectFile('src/index.mjs')}\n${await readProjectFile('src/graph.mjs')}`
  const emitted = new Set([...source.matchAll(/ruleId:\s*'([a-z0-9-]+)'/g)].map((match) => match[1]))

  assert.equal(emitted.size > 20, true, 'the rule scan found suspiciously few construction sites')
  for (const ruleId of emitted) {
    assert.ok(Object.hasOwn(RULE_SEVERITY, ruleId), `${ruleId} is emitted but missing from RULE_SEVERITY`)
  }
})

test('no severity literal is written at a finding construction site', async () => {
  // A `severity:` beside a `ruleId:` is the defect this table exists to prevent:
  // it lets one rule be downgraded without the table, the docs or a test noticing.
  for (const path of ['src/index.mjs', 'src/graph.mjs']) {
    const source = await readProjectFile(path)
    assert.equal(
      /severity:\s*'(error|warning|info)'/.test(source),
      false,
      `${path} writes a severity literal instead of reading RULE_SEVERITY`,
    )
  }
})

test('the failures this tool exists to catch are errors, not warnings', () => {
  // Downgrading any of these turns a refusal into a green build.
  assert.equal(RULE_SEVERITY['supersession-cycle'], 'error')
  assert.equal(RULE_SEVERITY['supersession-target-missing'], 'error')
  assert.equal(RULE_SEVERITY['supersession-self'], 'error')
  assert.equal(RULE_SEVERITY['path-escapes-root'], 'error')
  assert.equal(RULE_SEVERITY['record-not-utf8'], 'error')
  assert.equal(RULE_SEVERITY['record-id-duplicate'], 'error')
  assert.equal(RULE_SEVERITY['status-unknown'], 'error')
})

test('every table entry uses a severity the report contract defines', () => {
  for (const [ruleId, severity] of Object.entries(RULE_SEVERITY)) {
    assert.ok(['error', 'warning', 'info'].includes(severity), `${ruleId} has severity ${severity}`)
  }
})

test('the documented limits are the shipped limits', async () => {
  const text = await readProjectFile('docs/decision-rules.md')
  const rows = [...text.matchAll(/\|\s*`(max[A-Za-z]+)`\s*\|\s*`(--[a-z-]+)`\s*\|\s*(\d+)\s*\|/g)]
  const documented = Object.fromEntries(rows.map((row) => [row[1], Number(row[3])]))

  assert.deepEqual(documented, { ...DEFAULT_LIMITS })

  const help = await readProjectFile('bin/decision-record-indexer.mjs')
  for (const row of rows) {
    assert.equal(help.includes(row[2]), true, `${row[2]} is documented but not offered by the CLI`)
  }
})

test('the documented status vocabulary is the shipped vocabulary', async () => {
  const text = await readProjectFile('docs/decision-rules.md')
  for (const status of STATUS_VALUES) {
    assert.equal(text.includes(`\`${status}\``), true, `${status} is accepted but not documented`)
  }
  assert.equal(text.includes('`approved`'), false, 'the docs name a status the tool does not accept')
})
