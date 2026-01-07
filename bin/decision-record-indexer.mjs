#!/usr/bin/env node

import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  DestinationError,
  formatReport,
  indexDecisionRecords,
  resolveIndexDestination,
  writeIndexFile,
} from '../src/index.mjs'

const HELP = `decision-record-indexer

Index architecture decision records by status, owner, affected system and
supersession, and check the supersession graph. Nothing is fetched, and no
decision record is ever written to.

Usage:
  decision-record-indexer --root DIR [--index FILE] [--json] [--section NAME]... [limits]

Options:
  --root DIR                 Directory holding the decision records (required)
  --index FILE               Write the derived index here; must be outside --root
  --index-root DIR           Tree the index may be written into (default: the
                             working directory); no meaning without --index
  --json                     Emit the machine-readable report on stdout
  --section NAME             Required section heading; repeat to declare the whole
                             set, replacing the default Context, Decision, Consequences
  --max-records N            Maximum records to index (default 2000)
  --max-record-bytes N       Maximum bytes per record (default 262144)
  --max-depth N              Maximum directory depth below the root (default 8)
  --max-front-matter-lines N Maximum front matter lines (default 200)
  --max-chain-depth N        Maximum supersession traversal depth (default 64)
  -h, --help                 Show this help

Every option that carries a value may be given only once: a repeated flag is a
configuration error, not a silent last-wins. --section is the exception, and is
repeated to declare the whole required-section set.

Records are read, never written. A superseded decision stays exactly as it is
and stays in the index, with its successor recorded as "current"; the index is
a derived artifact and the destination is refused if it lies inside --root.

The destination is checked before anything is written, and refused if it is a
symbolic link, if it resolves outside --index-root, if it is the same file as a
record this run read -- compared by device and inode, so a hard link to a
record is still that record -- or if it is not a regular file.

A supersession cycle and a reference to a record that does not exist are both
errors. A run that indexed no record is "incomplete", never a pass.

Exit codes:
  0  every record was indexed and the graph is sound
  1  the record set failed the check
  2  invalid usage or configuration (no report on stdout), or evidence that was
     missing, undecodable or bounded out (an "incomplete" report on stdout)
`

const LIMIT_FLAGS = new Map([
  ['--max-records', 'maxRecords'],
  ['--max-record-bytes', 'maxRecordBytes'],
  ['--max-depth', 'maxDepth'],
  ['--max-front-matter-lines', 'maxFrontMatterLines'],
  ['--max-chain-depth', 'maxChainDepth'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { root: null, index: null, indexRoot: null, json: false, sections: null, limits: {} }
  const given = new Set()

  /**
   * A flag that carries a value is accepted once.
   *
   * Letting it repeat means the earlier value is discarded with no diagnostic,
   * so `--max-records 5 --max-records 1` runs a limit nobody asked for and
   * `--root a --root b` checks a directory nobody named. That is the same
   * defect as an ignored typo, which this tool already refuses. `--section` is
   * the documented exception: repeating it declares a set.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') options.json = true
    else if (argument === '--root') {
      once('--root')
      options.root = takeValue('--root')
    } else if (argument === '--index') {
      once('--index')
      options.index = takeValue('--index')
    } else if (argument === '--index-root') {
      once('--index-root')
      options.indexRoot = takeValue('--index-root')
    } else if (argument === '--section') {
      if (options.sections === null) options.sections = []
      options.sections.push(takeValue('--section'))
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${argument} requires a positive integer`)
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    } else throw new Error(`Unknown option "${argument}"`)
  }

  if (options.root === null) throw new Error('--root is required')
  if (options.indexRoot !== null && options.index === null) {
    throw new Error('--index-root has no meaning without --index')
  }
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }

  // Configuration is settled before any record is read, so a bad root or a
  // destination inside the archive fails with no report rather than half a run.
  let rootReal
  try {
    rootReal = await realpath(resolve(options.root))
  } catch (error) {
    process.stderr.write(`--root could not be read: ${error.code ?? error.message}\n`)
    return 2
  }

  let destination = null
  let writeRootReal = null
  if (options.index !== null) {
    try {
      writeRootReal = await realpath(resolve(options.indexRoot ?? process.cwd()))
    } catch (error) {
      process.stderr.write(`--index-root could not be read: ${error.code ?? error.message}\n`)
      return 2
    }
    try {
      destination = await resolveIndexDestination(rootReal, options.index, writeRootReal)
    } catch (error) {
      process.stderr.write(`--index is not usable: ${error.message}\n`)
      return 2
    }
  }

  let report
  let index
  let sources
  try {
    const result = await indexDecisionRecords({
      root: options.root,
      limits: options.limits,
      ...(options.sections === null ? {} : { sections: options.sections }),
    })
    report = result.report
    index = result.index
    sources = result.sources
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  /**
   * The destination is checked again here, immediately before the write and
   * now knowing which files were read. Configuration time could not do the
   * last of the three checks: a hard link to a record has no target to resolve
   * and shares no path with it, so only device plus inode sees that it is the
   * same file -- and this tool overwrote a decision record that way, exiting 0
   * and reporting "index written". A refused destination is a configuration
   * error, so stdout stays empty.
   */
  if (destination !== null) {
    try {
      await writeIndexFile(destination, index, { inputs: sources, root: writeRootReal })
      process.stderr.write(`index written: ${index.counts.records} record(s), complete=${index.complete}\n`)
    } catch (error) {
      if (error instanceof DestinationError) {
        process.stderr.write(`--index is not usable: ${error.message}\n`)
        return 2
      }
      process.stderr.write(`index could not be written: ${error.code ?? error.message}\n`)
      return 2
    }
  }

  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))

  if (report.status === 'incomplete') {
    process.stderr.write(
      `incomplete: ${report.summary.skipped} file(s) were not indexed out of ${report.summary.files} found.\n`,
    )
    return 2
  }
  return report.status === 'fail' ? 1 : 0
}

process.exitCode = await main(process.argv.slice(2))
