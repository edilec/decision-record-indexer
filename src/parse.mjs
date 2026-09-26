/**
 * Decoding and parsing for a single architecture decision record.
 *
 * Nothing in this module touches the filesystem, the clock, the locale or the
 * network. It turns bytes into a record description, or it says precisely why
 * it could not, and it never repairs or rewrites its input: a decision record
 * is history, and history is read, not edited.
 */

export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

export const STATUS_VALUES = Object.freeze([
  'proposed',
  'accepted',
  'rejected',
  'deprecated',
  'superseded',
])

/**
 * The complete front matter vocabulary.
 *
 * A key outside this set is reported rather than ignored. A silently dropped
 * `supersededby` would remove a supersession edge from the graph and turn a
 * real cycle into a green run, which is the whole failure this tool exists to
 * prevent.
 */
export const SCALAR_KEYS = Object.freeze(['id', 'title', 'status', 'date'])
export const LIST_KEYS = Object.freeze(['owners', 'systems', 'supersedes', 'superseded-by', 'tags'])
export const FRONT_MATTER_KEYS = Object.freeze([...SCALAR_KEYS, ...LIST_KEYS].sort(byCodeUnit))

/** Sections an Edilec decision record is expected to carry. */
export const DEFAULT_SECTIONS = Object.freeze(['Context', 'Decision', 'Consequences'])

/** Keys whose values are lower-cased so that the index groups them exactly once. */
const FOLDED_KEYS = Object.freeze(['status', 'owners', 'systems', 'tags'])

const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const HEADING = /^(#{1,6})\s+(.*)$/
const KEY_LINE = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/
const LIST_ITEM = /^\s*-\s+(.*)$/
const COMMENT_LINE = /^\s*#/
const LEADING_NUMBER = /^\d+[.)]\s+/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Characters removed before any record text is embedded in a report or index.
 * Built from code points rather than written literally, because a literal
 * U+2028 inside a regular expression literal is a syntax error in a module.
 */
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}` +
  `${String.fromCharCode(11)}${String.fromCharCode(12)}` +
  `${String.fromCharCode(14)}-${String.fromCharCode(31)}` +
  `${String.fromCharCode(127)}${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`,
  'g',
)

const BOM = String.fromCharCode(0xfeff)

export const EXCERPT_LIMIT = 200

/** A bounded, single-line excerpt. Record content is data, never an instruction. */
export function excerpt(value, limit = EXCERPT_LIMIT) {
  const flattened = String(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (flattened.length <= limit) return flattened
  return `${flattened.slice(0, limit)}...`
}

/**
 * Decode bytes as UTF-8, strictly.
 *
 * `fatal: true` is the entire point. Decoding leniently and then looking for
 * U+FFFD in the result cannot distinguish undecodable bytes from a file that
 * legitimately contains a replacement character, and that confusion has let an
 * unreadable input report a pass. The decoder decides; the decoded text never
 * gets a vote.
 */
export function decodeUtf8(bytes) {
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }
  } catch {
    return { ok: false, reason: 'not-utf8' }
  }
}

function unquote(raw) {
  const value = raw.trim()
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

function splitInlineList(raw) {
  const inner = raw.slice(1, -1).trim()
  if (inner === '') return []
  return inner.split(',').map((item) => unquote(item)).filter((item) => item !== '')
}

function stripCarriageReturn(value) {
  return value.endsWith('\r') ? value.slice(0, -1) : value
}

/**
 * Locate the front matter block.
 *
 * `maxLines` is enforced here rather than after the fact: a file whose opening
 * delimiter is never closed must not be scanned to its end.
 */
export function extractFrontMatter(text, maxLines) {
  const stripped = text.startsWith(BOM) ? text.slice(1) : text
  const lines = stripped.split('\n').map(stripCarriageReturn)
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return { ok: false, reason: 'missing' }
  }

  for (let index = 1; index < lines.length; index += 1) {
    if (index > maxLines) return { ok: false, reason: 'too-long' }
    if (lines[index].trim() === '---') {
      return {
        ok: true,
        frontMatter: lines.slice(1, index),
        body: lines.slice(index + 1),
        bodyOffset: index + 2,
      }
    }
  }
  return { ok: false, reason: 'unterminated' }
}

/**
 * Parse the documented front matter subset.
 *
 * Supported: `key: scalar`, `key: [a, b]`, and `key:` followed by `- item`
 * lines. Not supported, and reported rather than guessed at: nested mappings,
 * anchors, multi-line scalars, inline comments, and tab indentation. A parser
 * that guesses produces an index nobody can trust.
 */
export function parseFrontMatter(lines) {
  const values = new Map()
  const errors = []
  let pendingList = null

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const lineNumber = index + 2
    if (line.trim() === '') continue
    if (COMMENT_LINE.test(line)) continue
    if (line.includes('\t')) {
      errors.push({ line: lineNumber, message: 'front matter uses a tab character, which is not supported' })
      continue
    }

    const item = LIST_ITEM.exec(line)
    if (item !== null) {
      if (pendingList === null) {
        errors.push({ line: lineNumber, message: 'list item appears before any key that takes a list' })
        continue
      }
      const value = unquote(item[1])
      if (value === '') {
        errors.push({ line: lineNumber, message: `empty list item under "${pendingList}"` })
        continue
      }
      values.get(pendingList).value.push(value)
      continue
    }

    if (/^\s/.test(line)) {
      errors.push({ line: lineNumber, message: 'indented line is not a list item; nested mappings are not supported' })
      continue
    }

    const keyed = KEY_LINE.exec(line)
    if (keyed === null) {
      pendingList = null
      errors.push({ line: lineNumber, message: `line is neither "key: value" nor "- item": ${excerpt(line, 60)}` })
      continue
    }

    const key = keyed[1]
    const rest = keyed[2].trim()
    if (values.has(key)) {
      pendingList = null
      errors.push({ line: lineNumber, message: `key "${key}" appears more than once` })
      continue
    }

    if (rest === '') {
      values.set(key, { kind: 'list', value: [], line: lineNumber })
      pendingList = key
      continue
    }
    pendingList = null
    if (rest.startsWith('[') && rest.endsWith(']')) {
      values.set(key, { kind: 'list', value: splitInlineList(rest), line: lineNumber })
      continue
    }
    if (rest.startsWith('[') || rest.startsWith('{') || rest.endsWith(':')) {
      errors.push({ line: lineNumber, message: `value of "${key}" uses unsupported syntax` })
      continue
    }
    values.set(key, { kind: 'scalar', value: unquote(rest), line: lineNumber })
  }

  return { values, errors }
}

export function normalizeHeading(text) {
  return text
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(LEADING_NUMBER, '')
    .replace(/:+$/, '')
    .trim()
    .toLowerCase()
}

/** Headings outside fenced code, in document order. */
export function extractHeadings(bodyLines, bodyOffset) {
  const headings = []
  let fence = null
  for (let index = 0; index < bodyLines.length; index += 1) {
    const line = bodyLines[index]
    const fenceMatch = FENCE.exec(line)
    if (fenceMatch !== null) {
      const marker = fenceMatch[1][0]
      if (fence === null) fence = marker
      else if (fence === marker) fence = null
      continue
    }
    if (fence !== null) continue
    const match = HEADING.exec(line)
    if (match === null) continue
    headings.push({
      level: match[1].length,
      text: match[2].trim(),
      normalized: normalizeHeading(match[2]),
      line: bodyOffset + index,
      index,
    })
  }
  return headings
}

/** The prose under one heading, bounded, flattened, and safe to embed. */
export function sectionExcerpt(bodyLines, headings, normalized, limit = EXCERPT_LIMIT) {
  const start = headings.find((heading) => heading.normalized === normalized)
  if (start === undefined) return ''
  const next = headings.find((heading) => heading.index > start.index && heading.level <= start.level)
  const end = next === undefined ? bodyLines.length : next.index
  return excerpt(bodyLines.slice(start.index + 1, end).join(' '), limit)
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/**
 * A calendar check, not a clock check. The tool never compares a record date
 * with "now", because that would make the same inputs produce different output
 * tomorrow.
 */
export function isValidDate(value) {
  if (!ISO_DATE.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  if (month < 1 || month > 12 || day < 1) return false
  const lengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= lengths[month - 1]
}

/**
 * Turn decoded record text into fields, headings and bounded content.
 *
 * The return value describes what was found and what was wrong with it. It
 * never decides severity: that belongs to the single table in `index.mjs`.
 */
export function parseRecord(text, { maxFrontMatterLines, sections = DEFAULT_SECTIONS }) {
  const extracted = extractFrontMatter(text, maxFrontMatterLines)
  if (!extracted.ok) return { ok: false, reason: extracted.reason }

  const problems = []
  const { values, errors } = parseFrontMatter(extracted.frontMatter)
  for (const error of errors) {
    problems.push({ kind: 'front-matter-invalid', message: error.message, line: error.line })
  }

  const fields = {
    id: '',
    title: '',
    status: '',
    date: '',
    owners: [],
    systems: [],
    supersedes: [],
    'superseded-by': [],
    tags: [],
  }
  const lineOf = new Map()
  const present = new Set()

  for (const [key, entry] of values) {
    if (!FRONT_MATTER_KEYS.includes(key)) {
      problems.push({ kind: 'front-matter-key-unknown', key, line: entry.line })
      continue
    }
    const wantsList = LIST_KEYS.includes(key)
    if (wantsList && entry.kind !== 'list') {
      problems.push({
        kind: 'front-matter-field-invalid',
        key,
        line: entry.line,
        message: `"${key}" must be a list, written as [a, b] or as "- item" lines`,
      })
      continue
    }
    if (!wantsList && entry.kind !== 'scalar') {
      problems.push({
        kind: 'front-matter-field-invalid',
        key,
        line: entry.line,
        message: `"${key}" must be a single value, not a list`,
      })
      continue
    }

    present.add(key)
    lineOf.set(key, entry.line)
    if (wantsList) {
      const items = entry.value.map((item) => {
        const bounded = excerpt(item, 80)
        return FOLDED_KEYS.includes(key) ? bounded.toLowerCase() : bounded
      })
      fields[key] = [...new Set(items)].sort(byCodeUnit)
    } else {
      const scalar = excerpt(entry.value, key === 'title' ? EXCERPT_LIMIT : 80)
      fields[key] = FOLDED_KEYS.includes(key) ? scalar.toLowerCase() : scalar
    }
  }

  const headings = extractHeadings(extracted.body, extracted.bodyOffset)
  const headingSet = new Set(headings.map((heading) => heading.normalized))
  const firstTitle = headings.find((heading) => heading.level === 1)

  return {
    ok: true,
    fields,
    present,
    lineOf,
    title: present.has('title') && fields.title !== ''
      ? fields.title
      : excerpt(firstTitle === undefined ? '' : firstTitle.text, EXCERPT_LIMIT),
    headings,
    missingSections: sections.filter((name) => !headingSet.has(normalizeHeading(name))),
    decision: sectionExcerpt(extracted.body, headings, normalizeHeading('Decision')),
    problems,
  }
}
