/**
 * decision-record-indexer
 *
 * Reads a directory of architecture decision records, checks their metadata
 * and their supersession graph, and derives a searchable index.
 *
 * Two properties are structural rather than incidental:
 *
 * 1. The record set is opened read-only. The index is written to a separate
 *    destination that is refused if it lies inside the record root. A
 *    superseded decision is still part of the history: rewriting it to look
 *    tidy destroys the thing the record exists to preserve, so this tool has
 *    no write path into a record and no auto-fix of any kind.
 * 2. A supersession cycle and a reference to a record that does not exist are
 *    both errors. A history that claims a decision replaced itself, or that
 *    points at nothing, is not a history anyone can follow.
 */

import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'

import { buildSupersessionGraph } from './graph.mjs'
import { assertWritableDestination } from './write-guard.mjs'
import {
  DEFAULT_SECTIONS,
  STATUS_VALUES,
  byCodeUnit,
  decodeUtf8,
  excerpt,
  isValidDate,
  normalizeHeading,
  parseRecord,
} from './parse.mjs'

export const TOOL_ID = 'decision-record-indexer'
export const REPORT_SCHEMA_VERSION = '1'
export const INDEX_SCHEMA_VERSION = '1'

/**
 * Bounds are part of the contract, not a safety net.
 *
 * A decision archive is ordinary untrusted input: it can hold a generated
 * 40 MB record, a directory tree that nests forever, or a supersession chain
 * built to make a graph walk quadratic. Every limit below is explicit,
 * overridable from the CLI, and reported by name when it is hit. Exceeding one
 * produces a finding and an `incomplete` report -- never a quietly shorter
 * answer, and never a pass.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxRecords: 2000,
  maxRecordBytes: 262144,
  maxDepth: 8,
  maxFrontMatterLines: 200,
  maxChainDepth: 64,
})

/**
 * The authoritative rule severity table.
 *
 * Severity is the whole difference between a run that fails and one that
 * passes. Spread across two dozen construction sites as a literal it drifts
 * silently, and flipping one security- or integrity-relevant rule down to a
 * warning turns a refusal into a green build with every test still passing.
 * Every finding takes its severity from here, an unknown rule id throws, and
 * `docs/decision-rules.md` is asserted against this table in both directions.
 */
export const RULE_SEVERITY = Object.freeze({
  'date-invalid': 'warning',
  'directory-too-deep': 'error',
  'front-matter-field-invalid': 'error',
  'front-matter-invalid': 'error',
  'front-matter-key-unknown': 'warning',
  'front-matter-missing': 'error',
  'front-matter-too-long': 'error',
  'no-records-found': 'warning',
  'owners-missing': 'warning',
  'path-escapes-root': 'error',
  'record-id-duplicate': 'error',
  'record-id-mismatch': 'warning',
  'record-id-missing': 'error',
  'record-not-utf8': 'error',
  'record-too-large': 'error',
  'record-unreadable': 'error',
  'section-missing': 'warning',
  'status-missing': 'error',
  'status-supersession-mismatch': 'warning',
  'status-unknown': 'error',
  'supersession-asymmetric': 'warning',
  'supersession-cycle': 'error',
  'supersession-self': 'error',
  'supersession-target-missing': 'error',
  'supersession-too-deep': 'error',
  'systems-missing': 'info',
  'title-missing': 'warning',
  'too-many-records': 'error',
})

const RECORD_EXTENSIONS = Object.freeze(['.markdown', '.md'])
const SKIPPED_DIRECTORIES = Object.freeze(['node_modules'])
const SKIPPED_FILENAMES = Object.freeze(['index.md', 'readme.md', 'template.md'])
const ALLOWED_OPTIONS = Object.freeze(['limits', 'root', 'sections'])
const MAX_SECTIONS = 16
const ANCESTOR_PROBE_LIMIT = 64
const ROOT_LOCATION = Object.freeze({ file: '.', pointer: '/' })

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Containment, checked on real paths.
 *
 * Refusing `../` and absolute strings is not confinement: a symbolic link
 * planted inside the declared root resolves out of the tree without ever
 * spelling a traversal. Every candidate here has been through `realpath`
 * before it reaches this function.
 */
export function isInside(root, candidate) {
  if (candidate === root) return true
  return candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

export function validateLimits(overrides = {}) {
  if (!isRecord(overrides)) throw new TypeError('Limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name)) throw new TypeError(`Unknown limit "${name}"`)
    if (!Number.isInteger(value) || value < 1) {
      throw new TypeError(`Limit "${name}" must be a positive integer`)
    }
    limits[name] = value
  }
  return Object.freeze(limits)
}

export function validateSections(sections) {
  if (sections === undefined) return DEFAULT_SECTIONS
  if (!Array.isArray(sections)) throw new TypeError('Sections must be an array of names')
  if (sections.length > MAX_SECTIONS) {
    throw new TypeError(`At most ${MAX_SECTIONS} required sections may be declared`)
  }
  const seen = new Set()
  for (const name of sections) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new TypeError('Every required section name must be a non-empty string')
    }
    if (name.length > 80) throw new TypeError(`Required section name is too long: ${excerpt(name, 40)}`)
    const normalized = normalizeHeading(name)
    if (seen.has(normalized)) throw new TypeError(`Required section "${name}" is declared twice`)
    seen.add(normalized)
  }
  return Object.freeze([...sections])
}

/**
 * Resolve the index destination and refuse anything inside the record root.
 *
 * The destination usually does not exist yet, so the nearest existing ancestor
 * is resolved and the remaining segments are appended to it. That still
 * defeats a symlinked parent directory, which is the way a "separate
 * destination" quietly becomes a file written into the archive.
 *
 * `writeRootReal`, when given, is the real path of the tree the index may be
 * written into. It is checked here as well as in the write guard because this
 * runs before any directory is created: a destination whose parent does not
 * exist yet would otherwise have its parent created outside that tree before
 * the guard refused the write.
 */
export async function resolveIndexDestination(rootReal, destination, writeRootReal = null) {
  if (typeof destination !== 'string' || destination.trim() === '') {
    throw new TypeError('Index destination must be a non-empty path')
  }
  const absolute = resolve(destination)

  /**
   * The probe starts at the PARENT, never at the destination itself. Calling
   * `realpath` on the destination resolves a symbolic link sitting there, and
   * resolving it is the dangerous act: the caller would be handed the link's
   * target and would write through a link nobody named. The last segment is
   * therefore always carried as a tail segment, and a symbolic link at the
   * destination is refused on sight by the write guard instead.
   */
  const tail = [basename(absolute)]
  let probe = dirname(absolute)
  let realBase = null

  for (let step = 0; step < ANCESTOR_PROBE_LIMIT; step += 1) {
    try {
      realBase = await realpath(probe)
      break
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        throw new TypeError(`Index destination could not be resolved: ${error.code ?? 'unknown error'}`)
      }
      const parent = dirname(probe)
      if (parent === probe) throw new TypeError('Index destination has no existing ancestor directory')
      tail.unshift(basename(probe))
      probe = parent
    }
  }
  if (realBase === null) throw new TypeError('Index destination is nested too deeply to resolve')

  const resolved = join(realBase, ...tail)
  if (isInside(rootReal, resolved)) {
    throw new TypeError(
      'Index destination is inside the decision record root; the index is a derived artifact and must be written elsewhere',
    )
  }
  if (writeRootReal !== null && !isInside(writeRootReal, resolved)) {
    throw new TypeError(
      `Index destination resolves to ${resolved}, which is outside the permitted root. `
      + 'A link or a ".." segment on the way there does not widen it. '
      + 'Pass --index-root to declare the tree the index may be written into.',
    )
  }
  // lstat, not stat: a symbolic link aimed at a directory is refused as a link
  // by the write guard, with the reason that actually applies to it.
  let entry = null
  try {
    entry = await lstat(resolved)
  } catch {
    entry = null
  }
  if (entry !== null && entry.isDirectory()) {
    throw new TypeError('Index destination is a directory, not a file')
  }

  /**
   * The path as named is returned, not the resolved one. Containment has to be
   * decided on the resolved path, but handing that back to the caller hands
   * back a path with the symlink already followed: writing to it goes straight
   * through the link the caller never asked for, which is how a destination
   * named inside the working tree overwrote the file it pointed at. The write
   * guard lstats what it is given, so it must be given what the caller named.
   */
  return absolute
}

function createCollector() {
  return { rows: [], incomplete: false }
}

function record(collector, row) {
  collector.rows.push({ pointer: '/', line: 0, ...row })
}

/**
 * Walk the record root.
 *
 * Directory entries are sorted by UTF-16 code unit before use, so the order
 * records are visited never depends on the order the filesystem returned them.
 * Every entry is resolved to its real path and re-checked against the real
 * root before anything is read from it, and a real path already visited is not
 * visited twice.
 */
async function collectRecordFiles(rootReal, limits, collector) {
  const files = []
  const visited = new Set([rootReal])
  let stopped = false

  async function walk(absolute, relativePath, depth) {
    if (stopped) return
    if (depth > limits.maxDepth) {
      record(collector, {
        file: relativePath === '' ? '.' : relativePath,
        ruleId: 'directory-too-deep',
        message: `Directory nesting exceeded the maxDepth limit of ${limits.maxDepth}; its contents were not examined.`,
        suggestion: 'Raise --max-depth or flatten the decision archive.',
      })
      collector.incomplete = true
      return
    }

    let entries
    try {
      entries = await readdir(absolute, { withFileTypes: true })
    } catch (error) {
      record(collector, {
        file: relativePath === '' ? '.' : relativePath,
        ruleId: 'record-unreadable',
        message: `Directory could not be read: ${error.code ?? 'unknown error'}.`,
      })
      collector.incomplete = true
      return
    }

    entries.sort((left, right) => byCodeUnit(left.name, right.name))

    for (const entry of entries) {
      if (stopped) return
      if (entry.name.startsWith('.')) continue
      const childRelative = relativePath === '' ? entry.name : `${relativePath}/${entry.name}`
      const childAbsolute = join(absolute, entry.name)

      // Resolve and inspect in one step: an entry whose real path cannot be
      // obtained is unknown evidence, and unknown evidence is never a pass.
      let realPath
      let info
      try {
        realPath = await realpath(childAbsolute)
        info = await stat(realPath)
      } catch (error) {
        record(collector, {
          file: childRelative,
          ruleId: 'record-unreadable',
          message: `Entry could not be resolved: ${error.code ?? 'unknown error'}.`,
        })
        collector.incomplete = true
        continue
      }

      // Containment is decided on the real path, before the entry is opened or
      // walked. Neither its content nor its location leaves this function.
      if (!isInside(rootReal, realPath)) {
        record(collector, {
          file: childRelative,
          ruleId: 'path-escapes-root',
          message: 'Entry resolves outside the decision record root and was refused; its content was never read.',
          suggestion: 'Move the record inside the root, or index the other location separately.',
        })
        continue
      }
      if (visited.has(realPath)) continue
      visited.add(realPath)

      if (info.isDirectory()) {
        if (SKIPPED_DIRECTORIES.includes(entry.name)) continue
        await walk(realPath, childRelative, depth + 1)
        continue
      }
      if (!RECORD_EXTENSIONS.includes(extname(entry.name).toLowerCase())) continue
      if (SKIPPED_FILENAMES.includes(entry.name.toLowerCase())) continue

      // An entry named like a record that is not a regular file -- a FIFO, a
      // socket, a device node -- cannot be read as one, and reading from it
      // could block forever. Dropping it in silence would leave an unexamined
      // record-shaped entry inside a passing run, so it is reported and the
      // run is incomplete. Entries that are not record-shaped stay skipped in
      // silence: they were never candidates.
      if (!info.isFile()) {
        record(collector, {
          file: childRelative,
          ruleId: 'record-unreadable',
          message: 'Entry is named like a record but is not a regular file, so nothing could be read from it.',
          suggestion: 'Remove the entry, or replace it with a regular Markdown file.',
        })
        collector.incomplete = true
        continue
      }

      if (files.length >= limits.maxRecords) {
        record(collector, {
          file: childRelative,
          ruleId: 'too-many-records',
          message: `Root holds more than the maxRecords limit of ${limits.maxRecords}; the scan stopped here.`,
          suggestion: 'Raise --max-records or index a smaller subtree.',
        })
        collector.incomplete = true
        stopped = true
        return
      }
      files.push({ file: childRelative, realPath, size: info.size })
    }
  }

  await walk(rootReal, '', 0)
  files.sort((left, right) => byCodeUnit(left.file, right.file))
  return files
}

const FRONT_MATTER_REASONS = Object.freeze({
  missing: {
    ruleId: 'front-matter-missing',
    message: 'Record has no front matter block; the first line must be "---".',
    suggestion: 'Add a front matter block declaring at least id and status.',
  },
  unterminated: {
    ruleId: 'front-matter-invalid',
    message: 'Front matter block opened with "---" but was never closed.',
    suggestion: 'Close the block with a line containing only "---".',
  },
})

/** Read and parse one record file. Nothing is written back, ever. */
async function loadRecord(collector, limits, sections, entry) {
  if (entry.size > limits.maxRecordBytes) {
    record(collector, {
      file: entry.file,
      ruleId: 'record-too-large',
      message: `Record is ${entry.size} bytes, above the maxRecordBytes limit of ${limits.maxRecordBytes}; it was not parsed.`,
      suggestion: 'Raise --max-record-bytes or split the record.',
    })
    collector.incomplete = true
    return null
  }

  let bytes
  try {
    bytes = await readFile(entry.realPath)
  } catch (error) {
    record(collector, {
      file: entry.file,
      ruleId: 'record-unreadable',
      message: `Record could not be read: ${error.code ?? 'unknown error'}.`,
    })
    collector.incomplete = true
    return null
  }

  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    record(collector, {
      file: entry.file,
      ruleId: 'record-not-utf8',
      message: 'Record is not valid UTF-8; it was not parsed and nothing was indexed from it.',
      suggestion: 'Re-encode the record as UTF-8.',
    })
    collector.incomplete = true
    return null
  }

  const parsed = parseRecord(decoded.text, { maxFrontMatterLines: limits.maxFrontMatterLines, sections })
  if (!parsed.ok) {
    if (parsed.reason === 'too-long') {
      record(collector, {
        file: entry.file,
        pointer: '/front-matter',
        ruleId: 'front-matter-too-long',
        message: `Front matter did not close within the maxFrontMatterLines limit of ${limits.maxFrontMatterLines}; the record was not parsed.`,
        suggestion: 'Raise --max-front-matter-lines or shorten the front matter.',
      })
      collector.incomplete = true
      return null
    }
    const reason = FRONT_MATTER_REASONS[parsed.reason]
    record(collector, { file: entry.file, pointer: '/front-matter', ...reason })
    return null
  }
  return parsed
}

const LEADING_DIGITS = /^(\d+)/
const ID_DIGITS = /(\d+)/

/** A filename that numbers itself must agree with the id it declares. */
function filenameDisagrees(file, id) {
  const name = basename(file)
  const fromName = LEADING_DIGITS.exec(name)
  const fromId = ID_DIGITS.exec(id)
  if (fromName === null || fromId === null) return false
  return Number(fromName[1]) !== Number(fromId[1])
}

/** Turn one parsed record into index fields, reporting every metadata problem. */
function describeRecord(collector, entry, parsed) {
  for (const problem of parsed.problems) {
    if (problem.kind === 'front-matter-key-unknown') {
      record(collector, {
        file: entry.file,
        pointer: `/front-matter/${problem.key}`,
        line: problem.line,
        ruleId: 'front-matter-key-unknown',
        message: `Front matter key "${problem.key}" is not part of the documented vocabulary and was not indexed.`,
        suggestion: 'Remove the key, or correct it to one of: id, title, status, date, owners, systems, supersedes, superseded-by, tags.',
      })
      continue
    }
    if (problem.kind === 'front-matter-field-invalid') {
      record(collector, {
        file: entry.file,
        pointer: `/front-matter/${problem.key}`,
        line: problem.line,
        ruleId: 'front-matter-field-invalid',
        message: problem.message,
      })
      continue
    }
    record(collector, {
      file: entry.file,
      pointer: '/front-matter',
      line: problem.line,
      ruleId: 'front-matter-invalid',
      message: `Front matter line ${problem.line} could not be parsed: ${problem.message}.`,
    })
  }

  const fields = parsed.fields
  const id = fields.id

  if (id === '') {
    record(collector, {
      file: entry.file,
      pointer: '/front-matter/id',
      ruleId: 'record-id-missing',
      message: 'Record declares no id, so nothing can reference it and it cannot enter the index.',
      suggestion: 'Add an id such as "id: ADR-0007".',
    })
  } else if (filenameDisagrees(entry.file, id)) {
    record(collector, {
      file: entry.file,
      pointer: '/front-matter/id',
      ruleId: 'record-id-mismatch',
      message: `Filename numbers this record differently from its declared id "${id}".`,
      evidence: excerpt(basename(entry.file), 80),
      suggestion: 'Rename the file or correct the id so a reader following a reference lands on the right record.',
    })
  }

  if (!parsed.present.has('status') || fields.status === '') {
    record(collector, {
      file: entry.file,
      pointer: '/front-matter/status',
      ruleId: 'status-missing',
      message: `Record declares no status; one of ${STATUS_VALUES.join(', ')} is required.`,
    })
  } else if (!STATUS_VALUES.includes(fields.status)) {
    record(collector, {
      file: entry.file,
      pointer: '/front-matter/status',
      ruleId: 'status-unknown',
      message: `Status "${fields.status}" is outside the vocabulary ${STATUS_VALUES.join(', ')}.`,
      evidence: excerpt(fields.status, 40),
    })
  }

  if (parsed.title === '') {
    record(collector, {
      file: entry.file,
      pointer: '/front-matter/title',
      ruleId: 'title-missing',
      message: 'Record has neither a title in front matter nor a level-one heading.',
    })
  }
  if (fields.owners.length === 0) {
    record(collector, {
      file: entry.file,
      pointer: '/front-matter/owners',
      ruleId: 'owners-missing',
      message: 'Record names no owners, so the index cannot say who to ask about it.',
    })
  }
  if (fields.systems.length === 0) {
    record(collector, {
      file: entry.file,
      pointer: '/front-matter/systems',
      ruleId: 'systems-missing',
      message: 'Record names no affected systems, so it will not appear in any system view of the index.',
    })
  }
  if (parsed.present.has('date') && !isValidDate(fields.date)) {
    record(collector, {
      file: entry.file,
      pointer: '/front-matter/date',
      ruleId: 'date-invalid',
      message: 'Date is not a calendar date in YYYY-MM-DD form.',
      evidence: excerpt(fields.date, 40),
    })
  }

  for (const section of parsed.missingSections) {
    record(collector, {
      file: entry.file,
      pointer: `/sections/${normalizeHeading(section)}`,
      ruleId: 'section-missing',
      message: `Record has no "${section}" heading.`,
    })
  }

  if (id === '') return null
  return {
    id,
    file: entry.file,
    title: parsed.title,
    status: fields.status,
    date: fields.date,
    owners: fields.owners,
    systems: fields.systems,
    tags: fields.tags,
    supersedes: fields.supersedes,
    supersededBy: fields['superseded-by'],
    sections: [...new Set(parsed.headings.map((heading) => heading.normalized))].sort(byCodeUnit),
    decision: parsed.decision,
  }
}

/** Report the supersession graph. Cycles and dangling references are errors. */
function reportGraph(collector, records, graph) {
  const known = new Map(records.map((item) => [item.id, item]))

  for (const edge of graph.selfEdges) {
    for (const declaration of edge.declarations) {
      record(collector, {
        file: declaration.file,
        pointer: declaration.pointer,
        ruleId: 'supersession-self',
        message: `Record "${edge.from}" declares that it supersedes itself.`,
        evidence: excerpt(edge.from, 40),
      })
    }
  }

  for (const { edge, absent } of graph.missing) {
    for (const declaration of edge.declarations) {
      record(collector, {
        file: declaration.file,
        pointer: declaration.pointer,
        ruleId: 'supersession-target-missing',
        message: `Supersession references record "${absent}", which is not in the indexed record set.`,
        evidence: excerpt(absent, 40),
        suggestion: 'Correct the reference, or add the record so the history it points at can be read.',
      })
    }
  }

  for (const cycle of graph.cycles) {
    const anchor = known.get(cycle[0])
    // Bounded even for a loop through a thousand records: a finding is a
    // message for a person, not a dump of the graph.
    const chain = excerpt([...cycle, cycle[0]].join(' -> '), 160)
    record(collector, {
      file: anchor === undefined ? ROOT_LOCATION.file : anchor.file,
      pointer: '/supersedes',
      ruleId: 'supersession-cycle',
      message: `Supersession forms a cycle of ${cycle.length} record(s): ${chain}. No record in it can be the decision that stands.`,
      evidence: chain,
      suggestion: 'Remove one of the supersession declarations so the chain has an end.',
    })
  }

  if (graph.depthExceeded) {
    record(collector, {
      ...ROOT_LOCATION,
      ruleId: 'supersession-too-deep',
      message: 'Supersession traversal exceeded the maxChainDepth limit; the graph was not fully checked.',
      suggestion: 'Raise --max-chain-depth.',
    })
    collector.incomplete = true
  }

  for (const { edge, missingSide, missingOn } of graph.asymmetric) {
    record(collector, {
      file: missingOn.file,
      pointer: `/front-matter/${missingSide}`,
      ruleId: 'supersession-asymmetric',
      message: `"${edge.from}" supersedes "${edge.to}", but ${missingOn.id} does not declare the matching ${missingSide} entry.`,
      suggestion: `Add the reciprocal ${missingSide} entry so the relationship reads the same from both records.`,
    })
  }

  const supersededIds = new Set(graph.live.map((edge) => edge.to))
  for (const item of records) {
    if (supersededIds.has(item.id) && item.status !== 'superseded' && STATUS_VALUES.includes(item.status)) {
      record(collector, {
        file: item.file,
        pointer: '/front-matter/status',
        ruleId: 'status-supersession-mismatch',
        message: `Record is superseded by another record but its status is "${item.status}".`,
        suggestion: 'Set the status to superseded; the record itself stays exactly where it is.',
      })
      continue
    }
    if (!supersededIds.has(item.id) && item.status === 'superseded') {
      record(collector, {
        file: item.file,
        pointer: '/front-matter/status',
        ruleId: 'status-supersession-mismatch',
        message: 'Record has status superseded but no other record declares that it supersedes it.',
        suggestion: 'Name the superseding record, or correct the status.',
      })
    }
  }
}

function groupBy(records, pick) {
  const groups = new Map()
  for (const item of records) {
    for (const key of pick(item)) {
      if (key === '') continue
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(item.id)
    }
  }
  const keys = [...groups.keys()].sort(byCodeUnit)
  const result = {}
  for (const key of keys) result[key] = groups.get(key).sort(byCodeUnit)
  return result
}

/**
 * Build one finding, taking its severity from the single table.
 *
 * Exported so a test can prove the refusal below actually throws: a rule that
 * can be emitted without a table entry is a rule whose severity nobody pinned.
 */
export function createFinding(row) {
  const severity = RULE_SEVERITY[row.ruleId]
  if (severity === undefined) {
    throw new Error(
      `Rule "${row.ruleId}" is not in RULE_SEVERITY; add it to the table and to docs/decision-rules.md.`,
    )
  }
  const finding = {
    ruleId: row.ruleId,
    severity,
    message: row.message,
    location: { file: row.file, pointer: row.pointer },
  }
  if (row.evidence !== undefined && row.evidence !== '') finding.evidence = row.evidence
  if (row.suggestion !== undefined) finding.suggestion = row.suggestion
  if (row.line > 0) finding.line = row.line
  return finding
}

/**
 * Index a directory of decision records.
 *
 * Nothing here reads the network, the clock, the locale or the environment, so
 * two runs over the same bytes produce byte-identical output. The record root
 * is opened read-only; the returned index is a derived value that the caller
 * decides where to put.
 */
export async function indexDecisionRecords(options = {}) {
  if (!isRecord(options)) throw new TypeError('Options must be an object')
  for (const key of Object.keys(options)) {
    if (!ALLOWED_OPTIONS.includes(key)) throw new TypeError(`Unknown option "${key}"`)
  }
  if (typeof options.root !== 'string' || options.root.trim() === '') {
    throw new TypeError('A decision record root is required')
  }
  const limits = validateLimits(options.limits ?? {})
  const sections = validateSections(options.sections)

  let rootReal
  try {
    rootReal = await realpath(resolve(options.root))
  } catch (error) {
    throw new TypeError(`Decision record root could not be read: ${error.code ?? 'unknown error'}`)
  }
  const rootInfo = await stat(rootReal)
  if (!rootInfo.isDirectory()) throw new TypeError('Decision record root must be a directory')

  const collector = createCollector()
  const files = await collectRecordFiles(rootReal, limits, collector)

  const records = []
  const byId = new Map()
  let skipped = 0

  for (const entry of files) {
    const parsed = await loadRecord(collector, limits, sections, entry)
    if (parsed === null) {
      skipped += 1
      continue
    }
    const described = describeRecord(collector, entry, parsed)
    if (described === null) {
      skipped += 1
      continue
    }
    const existing = byId.get(described.id)
    if (existing !== undefined) {
      record(collector, {
        file: described.file,
        pointer: '/front-matter/id',
        ruleId: 'record-id-duplicate',
        message: `Record id "${described.id}" is already declared by ${existing.file}; this record was not indexed because references to the id would be ambiguous.`,
        evidence: excerpt(described.id, 40),
        suggestion: 'Give one of the two records a distinct id. Neither file needs to be rewritten otherwise.',
      })
      skipped += 1
      continue
    }
    byId.set(described.id, described)
    records.push(described)
  }

  records.sort((left, right) => byCodeUnit(left.id, right.id))
  const graph = buildSupersessionGraph(records, limits.maxChainDepth)
  reportGraph(collector, records, graph)

  /**
   * Green on no evidence is a defect, not a clean bill of health. An empty
   * record set means the run obtained nothing to judge, so it is reported and
   * the run is incomplete -- it can never be a pass.
   */
  if (records.length === 0) {
    record(collector, {
      ...ROOT_LOCATION,
      ruleId: 'no-records-found',
      message: `No decision record was indexed, so this run checked nothing. ${files.length} candidate file(s) were found.`,
      suggestion: 'Point --root at the directory that holds the decision records.',
    })
    collector.incomplete = true
  }

  collector.rows.sort((left, right) =>
    byCodeUnit(left.file, right.file) ||
    byCodeUnit(left.pointer, right.pointer) ||
    byCodeUnit(left.ruleId, right.ruleId) ||
    left.line - right.line ||
    byCodeUnit(left.message, right.message))

  const findings = collector.rows.map(createFinding)
  const errors = findings.filter((item) => item.severity === 'error').length
  const warnings = findings.filter((item) => item.severity === 'warning').length
  const status = collector.incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass'

  const indexRecords = records.map((item) => ({
    id: item.id,
    file: item.file,
    title: item.title,
    status: item.status,
    date: item.date,
    owners: item.owners,
    systems: item.systems,
    tags: item.tags,
    supersedes: item.supersedes,
    supersededBy: item.supersededBy,
    current: graph.current.get(item.id),
    sections: item.sections,
    decision: item.decision,
  }))

  const index = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    complete: status !== 'incomplete',
    statusVocabulary: [...STATUS_VALUES],
    counts: {
      records: indexRecords.length,
      edges: graph.live.length,
      cycles: graph.cycles.length,
      unresolved: graph.missing.length,
      skipped,
    },
    records: indexRecords,
    byStatus: groupBy(indexRecords, (item) => [item.status]),
    byOwner: groupBy(indexRecords, (item) => item.owners),
    bySystem: groupBy(indexRecords, (item) => item.systems),
    byTag: groupBy(indexRecords, (item) => item.tags),
    supersession: {
      edges: graph.live.map((edge) => ({ from: edge.from, to: edge.to })),
      cycles: graph.cycles.map((cycle) => [...cycle]),
      unresolved: graph.missing
        .map(({ edge, absent }) => ({ from: edge.from, to: edge.to, missing: absent }))
        .sort((left, right) => byCodeUnit(left.from, right.from) || byCodeUnit(left.to, right.to)),
    },
  }

  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: indexRecords.length,
      errors,
      warnings,
      info: findings.length - errors - warnings,
      files: files.length,
      skipped,
      edges: graph.live.length,
      cycles: graph.cycles.length,
      unresolved: graph.missing.length,
      superseded: indexRecords.filter((item) => item.status === 'superseded').length,
      owners: Object.keys(index.byOwner).length,
      systems: Object.keys(index.bySystem).length,
    },
    findings,
  }

  /**
   * `sources` is the real path of every record file this run actually read.
   * The caller needs it to prove the index destination is not one of them: a
   * hard link to a record has no target to resolve and shares no path with it,
   * so only device plus inode sees that it is the same file. This tool
   * destroyed a decision record exactly that way before the check existed.
   */
  return { report, index, sources: files.map((entry) => entry.realPath) }
}

const SEARCH_KEYS = Object.freeze(['owner', 'status', 'system', 'tag', 'text'])

/**
 * Query a derived index.
 *
 * Every filter is a conjunction, matching is exact for the folded metadata
 * fields and a case-insensitive substring for `text`. An unknown query key
 * throws rather than being ignored: a typo that silently widens a search is
 * the same defect as a typo that silently disables a check.
 */
export function searchIndex(index, query = {}) {
  if (!isRecord(index) || !Array.isArray(index.records)) {
    throw new TypeError('Search needs a decision index with a records array')
  }
  if (!isRecord(query)) throw new TypeError('Query must be an object')
  for (const key of Object.keys(query)) {
    if (!SEARCH_KEYS.includes(key)) {
      throw new TypeError(`Unknown search key "${key}"; supported keys are ${SEARCH_KEYS.join(', ')}`)
    }
    if (typeof query[key] !== 'string') throw new TypeError(`Search value for "${key}" must be a string`)
  }

  const wanted = {
    status: query.status === undefined ? null : query.status.toLowerCase(),
    owner: query.owner === undefined ? null : query.owner.toLowerCase(),
    system: query.system === undefined ? null : query.system.toLowerCase(),
    tag: query.tag === undefined ? null : query.tag.toLowerCase(),
    text: query.text === undefined ? null : query.text.toLowerCase(),
  }

  const matches = index.records.filter((item) => {
    if (wanted.status !== null && item.status !== wanted.status) return false
    if (wanted.owner !== null && !item.owners.includes(wanted.owner)) return false
    if (wanted.system !== null && !item.systems.includes(wanted.system)) return false
    if (wanted.tag !== null && !item.tags.includes(wanted.tag)) return false
    if (wanted.text !== null) {
      const haystack = `${item.id} ${item.title} ${item.decision} ${item.tags.join(' ')}`.toLowerCase()
      if (!haystack.includes(wanted.text)) return false
    }
    return true
  })

  return matches.slice().sort((left, right) => byCodeUnit(left.id, right.id))
}

/**
 * Serialise the derived index to its own destination. Records are never
 * touched -- and that promise is enforced here, at the only place this package
 * writes anything, rather than left to each caller.
 *
 * The destination is checked immediately before the write, because a path is
 * not a file: a symbolic link there puts the index wherever the link points, a
 * symlinked parent does the same one level up, and a hard link to a record
 * shares no path with it but is the same file. This tool overwrote a decision
 * record through the third of those and exited 0 reporting "index written".
 *
 * Missing parent directories are still created, so `--index build/index.json`
 * works on a fresh checkout; `root` is what stops that from happening outside
 * the tree the caller declared.
 */
export async function writeIndexFile(destination, index, options = {}) {
  const { inputs = [], root = null } = options
  await mkdir(dirname(resolve(destination)), { recursive: true })
  const target = await assertWritableDestination(destination, {
    inputs,
    root,
    label: '--index',
    rootLabel: '--index-root',
  })
  await writeFile(target, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  return target
}

const SEVERITY_WIDTH = 7

export function formatReport(report) {
  const { summary } = report
  const lines = [
    `${summary.checked} record(s) indexed from ${summary.files} file(s): ${summary.errors} error, ${summary.warnings} warning, ${summary.info} info, status ${report.status}.`,
    `supersession: ${summary.edges} edge(s), ${summary.cycles} cycle(s), ${summary.unresolved} unresolved reference(s), ${summary.superseded} superseded record(s) still indexed.`,
  ]
  for (const finding of report.findings) {
    const place = finding.line === undefined
      ? `${finding.location.file}${finding.location.pointer}`
      : `${finding.location.file}:${finding.line}${finding.location.pointer}`
    lines.push(`${finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH)} ${place} ${finding.ruleId} ${finding.message}`)
  }
  return `${lines.join('\n')}\n`
}

export {
  DEFAULT_SECTIONS,
  STATUS_VALUES,
  byCodeUnit,
  decodeUtf8,
  parseFrontMatter,
  parseRecord,
} from './parse.mjs'
export { buildSupersessionGraph, canonicalCycle, findCycles, resolveCurrent } from './graph.mjs'
export { DestinationError, assertWritableDestination } from './write-guard.mjs'
