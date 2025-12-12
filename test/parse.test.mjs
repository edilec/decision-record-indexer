import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_SECTIONS,
  FRONT_MATTER_KEYS,
  STATUS_VALUES,
  decodeUtf8,
  excerpt,
  extractFrontMatter,
  extractHeadings,
  isValidDate,
  normalizeHeading,
  parseFrontMatter,
  parseRecord,
  sectionExcerpt,
} from '../src/parse.mjs'

const LINE_SEPARATOR = String.fromCharCode(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)
const REPLACEMENT = String.fromCharCode(0xfffd)

test('strict decoding rejects bytes that are not UTF-8', () => {
  const decoded = decodeUtf8(Uint8Array.from([0x41, 0xff, 0x42]))
  assert.deepEqual(decoded, { ok: false, reason: 'not-utf8' })
})

test('a record containing a literal replacement character is still valid UTF-8', () => {
  // The decoder decides whether bytes are UTF-8. Looking for U+FFFD in decoded
  // text cannot tell "undecodable bytes" from "a file that talks about U+FFFD",
  // and that confusion is exactly how an unreadable input reports a pass.
  const text = `# Encoding notes\n\nThe replacement character ${REPLACEMENT} is written out here on purpose.\n`
  const decoded = decodeUtf8(new TextEncoder().encode(text))
  assert.deepEqual(decoded, { ok: true, text })
})

test('decoding accepts multi-byte sequences and a byte order mark', () => {
  const decoded = decodeUtf8(new TextEncoder().encode('---\nid: ADR-0001\n---\n\n# Ledger état\n'))
  assert.equal(decoded.ok, true)
  assert.equal(decoded.text.includes('état'), true)
})

test('excerpt removes line and paragraph separators and bounds its output', () => {
  const raw = `alpha${LINE_SEPARATOR}beta${PARAGRAPH_SEPARATOR}gamma`
  assert.equal(excerpt(raw), 'alpha beta gamma')
  assert.equal(excerpt('abcdefghij', 4), 'abcd...')
})

test('front matter extraction reports each way a block can be wrong', () => {
  assert.deepEqual(extractFrontMatter('# No front matter\n', 200), { ok: false, reason: 'missing' })
  assert.deepEqual(extractFrontMatter('---\nid: ADR-1\n', 200), { ok: false, reason: 'unterminated' })
  assert.deepEqual(extractFrontMatter(`---\n${'x: 1\n'.repeat(20)}---\n`, 5), { ok: false, reason: 'too-long' })

  const good = extractFrontMatter('---\nid: ADR-1\n---\n# Title\n', 200)
  assert.deepEqual(good, {
    ok: true,
    frontMatter: ['id: ADR-1'],
    body: ['# Title', ''],
    bodyOffset: 4,
  })
})

test('front matter extraction tolerates carriage returns', () => {
  const extracted = extractFrontMatter('---\r\nid: ADR-1\r\n---\r\n# Title\r\n', 200)
  assert.equal(extracted.ok, true)
  assert.deepEqual(extracted.frontMatter, ['id: ADR-1'])
})

test('the documented front matter subset parses to exactly these values', () => {
  const { values, errors } = parseFrontMatter([
    '# a full-line comment',
    'id: ADR-0007',
    'title: "Use a queue, then stop"',
    'owners: [alice, bob]',
    'systems:',
    '  - ledger',
    '  - billing',
    'tags: []',
  ])
  assert.deepEqual(errors, [])
  assert.deepEqual(
    [...values].map(([key, entry]) => [key, entry.kind, entry.value]),
    [
      ['id', 'scalar', 'ADR-0007'],
      ['title', 'scalar', 'Use a queue, then stop'],
      ['owners', 'list', ['alice', 'bob']],
      ['systems', 'list', ['ledger', 'billing']],
      ['tags', 'list', []],
    ],
  )
})

test('front matter syntax this tool does not support is reported, never guessed at', () => {
  const { errors } = parseFrontMatter([
    'id: ADR-1',
    'id: ADR-2',
    'owners:\tbob',
    'nested:',
    '  inner: value',
    'plain sentence',
    '- orphan item',
  ])
  assert.deepEqual(
    errors.map((error) => error.line),
    [3, 4, 6, 7, 8],
  )
  assert.equal(errors[0].message, 'key "id" appears more than once')
  assert.equal(errors[2].message, 'indented line is not a list item; nested mappings are not supported')
})

test('headings inside fenced code are not headings', () => {
  const body = ['# Title', '```', '# not a heading', '```', '## Context', '~~~', '### also not', '~~~', '## Decision']
  assert.deepEqual(
    extractHeadings(body, 4).map((heading) => [heading.level, heading.normalized, heading.line]),
    [[1, 'title', 4], [2, 'context', 8], [2, 'decision', 12]],
  )
})

test('heading normalisation strips numbering, emphasis and trailing colons', () => {
  assert.equal(normalizeHeading('3. **Decision**:'), 'decision')
  assert.equal(normalizeHeading('2) Context'), 'context')
  assert.equal(normalizeHeading('`Consequences`'), 'consequences')
})

test('a section excerpt stops at the next heading of the same or higher level', () => {
  const body = ['## Decision', 'Use a queue.', '### Detail', 'Bounded.', '## Consequences', 'Not this.']
  const headings = extractHeadings(body, 2)
  assert.equal(sectionExcerpt(body, headings, 'decision'), 'Use a queue. ### Detail Bounded.')
  assert.equal(sectionExcerpt(body, headings, 'context'), '')
})

test('dates are checked against the calendar, never against the clock', () => {
  assert.equal(isValidDate('2024-02-29'), true)
  assert.equal(isValidDate('2026-02-29'), false)
  assert.equal(isValidDate('2026-02-30'), false)
  assert.equal(isValidDate('2026-13-01'), false)
  assert.equal(isValidDate('2026-2-1'), false)
  assert.equal(isValidDate('tomorrow'), false)
})

test('parseRecord folds, de-duplicates and sorts the grouped metadata fields', () => {
  const text = [
    '---',
    'id: ADR-0009',
    'status: Accepted',
    'owners: [Bob, alice, bob]',
    'systems: [Ledger, billing]',
    'supersedes: [ADR-0008]',
    'reviewers: [carol]',
    '---',
    '',
    '# Keep the ledger',
    '',
    '## Context',
    'Something happened.',
    '',
    '## Decision',
    'Keep it.',
  ].join('\n')

  const parsed = parseRecord(text, { maxFrontMatterLines: 200, sections: DEFAULT_SECTIONS })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.fields.status, 'accepted')
  assert.deepEqual(parsed.fields.owners, ['alice', 'bob'])
  assert.deepEqual(parsed.fields.systems, ['billing', 'ledger'])
  assert.deepEqual(parsed.fields.supersedes, ['ADR-0008'])
  assert.equal(parsed.title, 'Keep the ledger')
  assert.deepEqual(parsed.missingSections, ['Consequences'])
  assert.equal(parsed.decision, 'Keep it.')
  assert.deepEqual(
    parsed.problems.map((problem) => [problem.kind, problem.key]),
    [['front-matter-key-unknown', 'reviewers']],
  )
})

test('a list key written as a scalar is a reported field error, not a coerced value', () => {
  const text = '---\nid: ADR-1\nowners: alice\n---\n\n# T\n'
  const parsed = parseRecord(text, { maxFrontMatterLines: 200, sections: [] })
  assert.deepEqual(parsed.fields.owners, [])
  assert.deepEqual(
    parsed.problems.map((problem) => [problem.kind, problem.key]),
    [['front-matter-field-invalid', 'owners']],
  )
})

test('the front matter vocabulary and the status vocabulary are the documented sets', () => {
  assert.deepEqual(FRONT_MATTER_KEYS, [
    'date',
    'id',
    'owners',
    'status',
    'superseded-by',
    'supersedes',
    'systems',
    'tags',
    'title',
  ])
  assert.deepEqual(STATUS_VALUES, ['proposed', 'accepted', 'rejected', 'deprecated', 'superseded'])
})

test('an unclosed inline list or a nested value is refused, not half-parsed', () => {
  const { values, errors } = parseFrontMatter(['owners: [alice', 'tags: {a: 1}', 'title: trailing:'])
  assert.deepEqual(values.size, 0)
  assert.deepEqual(
    errors.map((error) => [error.line, error.message]),
    [
      [2, 'value of "owners" uses unsupported syntax'],
      [3, 'value of "tags" uses unsupported syntax'],
      [4, 'value of "title" uses unsupported syntax'],
    ],
  )
})

test('a scalar key written as a list is a reported field error', () => {
  const parsed = parseRecord('---\nid: ADR-1\ntitle: [a, b]\n---\n\n# T\n', {
    maxFrontMatterLines: 200,
    sections: [],
  })
  assert.equal(parsed.fields.title, '')
  assert.deepEqual(
    parsed.problems.map((problem) => [problem.kind, problem.key, problem.message]),
    [['front-matter-field-invalid', 'title', '"title" must be a single value, not a list']],
  )
})

test('an unparsable front matter line is surfaced through parseRecord', () => {
  const parsed = parseRecord('---\nid: ADR-1\nnot a key value pair\n---\n\n# T\n', {
    maxFrontMatterLines: 200,
    sections: [],
  })
  assert.deepEqual(
    parsed.problems.map((problem) => [problem.kind, problem.line]),
    [['front-matter-invalid', 3]],
  )
})
