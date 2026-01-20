# Decision Record Indexer

Read a directory of architecture decision records, check their metadata and their supersession
graph, and derive a searchable local index.

- **Repository:** [edilec/decision-record-indexer](https://github.com/edilec/decision-record-indexer)
- **Area:** Docs & Knowledge
- **License:** MIT

Node built-ins only: no runtime dependencies, no dev dependencies, no network access.

## What it does

- Parses ADR front matter and headings into `id`, `title`, `status`, `date`, `owners`, `systems`,
  `tags`, `supersedes` and `superseded-by`, plus the section names and a bounded excerpt of the
  Decision section.
- Builds the supersession graph from both directions, cross-checks that the two records agree, and
  resolves each historical record to the decision that currently stands.
- **Fails on a supersession cycle** and **fails on a reference to a record that does not exist.**
  A history that claims a decision replaced itself, or that points at nothing, is not a history
  anyone can follow.
- Groups the records by status, owner, affected system and tag into an index you can query.

## What it never does

**It never writes to a decision record.** A superseded decision is the reason the current one
exists; rewriting it to look tidy destroys the record. There is no auto-fix, no reformat and no
status correction. The index is a derived artifact written to a separate destination, and that
destination is refused if it resolves inside the record root — including through a symlinked parent
directory.

Superseded records stay in the index with their full metadata and stay returned by a search.

## Install

```sh
npm install decision-record-indexer
```

Requires Node 22 or newer.

## Command line

```sh
decision-record-indexer --root docs/decisions
decision-record-indexer --root docs/decisions --index build/decisions.index.json --json
decision-record-indexer --root docs/decisions --section Context --section "Rollback plan"
```

```
  --root DIR                 Directory holding the decision records (required)
  --index FILE               Write the derived index here; must be outside --root
  --index-root DIR           Tree the index may be written into (default: cwd)
  --json                     Emit the machine-readable report on stdout
  --section NAME             Required section heading; repeat to declare the whole set
  --max-records N            Maximum records to index (default 2000)
  --max-record-bytes N       Maximum bytes per record (default 262144)
  --max-depth N              Maximum directory depth below the root (default 8)
  --max-front-matter-lines N Maximum front matter lines (default 200)
  --max-chain-depth N        Maximum supersession traversal depth (default 64)
  -h, --help                 Show this help
```

### The index destination is checked before anything is written

A path is not a file. `--index` is refused, with exit `2` and nothing on
stdout, when it is any of these:

| Refused | Why |
| --- | --- |
| A symbolic link | The index would land wherever the link points, not on the path you named. Refused on sight by `lstat`, because resolving the link is itself the dangerous act. A link aimed at a path that does not exist yet is refused for the same reason. |
| Resolving outside `--index-root` | A symlinked directory, or a `..` segment, on the way there does not widen the permitted tree. The parent is resolved and compared, never compared as text. |
| The same file as a record this run read | Compared by device and inode, so a hard link to a decision record is still that record. |
| A newly created index named by a dangling record link | Every discovered record-shaped path is retained as a guard input before it is resolved. Final symlink targets are compared with the destination, including when either file does not yet exist. A link to a different missing file remains an incomplete input, not a write refusal. |
| Inside `--root` | The index is a derived artifact; the archive is read-only. |
| Not a regular file | A directory is not an output file. |

`--index-root` declares the tree the index may be written into and defaults to
the working directory. Missing directories below it are still created, so
`--index build/decisions.index.json` works on a fresh checkout. The option has
no meaning without `--index`.

The guard receives every discovered record-shaped name, including an unreadable
one, but the report counts only records actually indexed. It cannot see a file
the run never treated as a record candidate — a README the walk skips by name
or a note with the wrong extension — so a hard link to one is indistinguishable
from any other path. The index is therefore written to a temporary file and renamed over the
destination: a rename replaces the *name*, so every other name for the file
that was there keeps its content. Measured before that change, `--index` at a
hard link to a skipped README replaced the README with the index and exited
`0`.

Containment is decided before any directory is created, not after. `mkdir` with
`recursive` walks a symlinked parent as happily as a real one, so a check made
once the directory exists is a check made after it was created outside the
root.

stdout carries the report and nothing else; diagnostics go to stderr. Every option that carries a
value may be given only once — a repeated flag is a configuration error rather than a silent
last-wins — and `--section` is the exception, repeated to declare the whole required-section set.

| Exit | Meaning | stdout |
| ---: | --- | --- |
| 0 | every record indexed, graph sound | the report |
| 1 | the record set failed the check | the report |
| 2 | invalid usage or configuration | empty |
| 2 | evidence missing, undecodable or bounded out | an `incomplete` report |

## Library

```js
import { indexDecisionRecords, searchIndex, writeIndexFile, resolveIndexDestination }
  from 'decision-record-indexer'

const { report, index } = await indexDecisionRecords({ root: 'docs/decisions' })

if (report.status !== 'pass') {
  for (const finding of report.findings) {
    console.error(finding.severity, finding.location.file, finding.ruleId, finding.message)
  }
}

// Superseded decisions remain fully accessible.
for (const item of searchIndex(index, { status: 'superseded' })) {
  console.log(item.id, item.title, '->', item.current)
}
```

`searchIndex` accepts `status`, `owner`, `system`, `tag` and `text`. Filters combine, matching folds
case, and results come back in id order. An unknown key throws rather than widening the search.

## A record

```markdown
---
id: ADR-0004
title: Decision records live in the repository they describe
status: accepted
date: 2026-01-27
owners: [platform-team]
systems: [docs]
supersedes: [ADR-0001]
superseded-by: []
tags: [process]
---

# Decision records live in the repository they describe

## Context
...
## Decision
...
## Consequences
...
```

The supported front matter subset, the full rule catalog, the limits and the determinism guarantee
are in [docs/decision-rules.md](./docs/decision-rules.md).

## Examples

```sh
npm run example                                        # clean set, exits 0, writes an index
node bin/decision-record-indexer.mjs --root examples/decisions-broken   # exits 1
```

`examples/decisions-broken` contains a supersession cycle, a reference to a record that does not
exist, a status outside the vocabulary, an unknown front matter key, an impossible date, a record
with no owners and a file with no front matter at all.

## Limits and non-goals

This tool reads what records say about themselves. It **cannot** conclude:

- **whether a decision was right**, or whether anyone still follows it;
- **whether a status is truthful** — `accepted` on a decision everybody abandoned is indexed as
  accepted, and only a disagreement with the supersession graph is detectable;
- **whether the record set is complete** — a decision nobody wrote down leaves no trace, and a clean
  run says nothing about it;
- **whether a prose reference is valid** — only the `supersedes` and `superseded-by` fields form the
  graph, and a link inside the body is not resolved;
- **whether a system or owner name is real** — those vocabularies are uncontrolled, so a typo
  creates a new group rather than an error;
- **anything about an external system.** There is no network access at all.

Further non-goals, deliberately:

- It is not a YAML parser. It supports the documented subset and reports everything else instead of
  guessing, so an unsupported construct is visible rather than silently mis-indexed.
- It does not render, publish or lint the prose of a record.
- It does not fix anything. Every finding names a file and a field for a person to act on.

A run that indexed no record is reported `incomplete` and exits 2. `pass` with nothing checked is
green on no evidence, and this tool does not do that.

## Verification

```sh
npm run check    # lint, tests, the example run, and a pack dry run
```

## License

MIT. See [LICENSE](./LICENSE).
