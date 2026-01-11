# Rules, limits and determinism

This document is the reference for what `decision-record-indexer` reads, what each rule means, what
the derived index contains, and what the tool refuses to claim. Rule ids are stable: renaming one is
a breaking change and is recorded in the changelog.

## What is read

The tool walks the directory given as `--root` and reads files ending in `.md` or `.markdown`.

- Entries whose name begins with `.` are skipped, as is any directory named `node_modules`.
- `index.md`, `readme.md` and `template.md` are skipped by name (case-insensitively): they are
  navigation and scaffolding, not decisions.
- Every entry is resolved to its real path and checked against the real root before it is opened.
  An entry that resolves outside the root is refused and reported as `path-escapes-root`; its
  contents never reach the report or the index.
- A real path already seen is not read twice, so a symbolic link inside the root cannot duplicate a
  record or loop a directory walk.
- An entry whose name matches the record convention but that is not a regular file — a FIFO, a
  socket, a device node — is reported as `record-unreadable` and makes the run `incomplete`. It is
  never opened: reading one can block forever, and an unexamined record-shaped entry must not sit
  inside a passing run. An entry that is not record-shaped is skipped in silence, as above.
- File bytes are decoded with `TextDecoder('utf-8', { fatal: true })`. Whether bytes are UTF-8 is
  the decoder's decision; the decoded text is never inspected to make that judgement.

**Nothing in the root is ever written to.** There is no auto-fix, no reformat, and no status
rewrite. A superseded decision is the history that explains why the current one exists, so the tool
that reads it has no write path into it. The derived index goes to `--index`, which is refused if
it resolves inside the root.

That refusal is not enough on its own, because a path is not a file. `--index` is also refused, with
exit `2` and empty stdout, when it is a symbolic link (refused on sight by `lstat`, since resolving
the link is the dangerous act — including a link aimed at a path that does not exist yet), when its
parent resolves outside `--index-root`, when it is the same file as a record this run read (compared
by device and inode, so a hard link to a record is still that record), or when it is not a regular
file. Each of those was measured overwriting a file while the run exited `0`.

## Front matter

Front matter is a block delimited by a line containing only `---` at the very start of the file
(a byte order mark is allowed before it), closed by another such line.

Supported syntax, and nothing else:

```
---
id: ADR-0004
title: Decision records live in the repository they describe
status: accepted
date: 2026-01-27
owners: [platform-team]
systems:
  - docs
supersedes: [ADR-0001]
superseded-by: []
tags: [process]
---
```

- `key: scalar`, optionally quoted with `"` or `'`. Escape sequences inside quotes are not
  interpreted.
- `key: [a, b]` for an inline list, and `key: []` for an empty one.
- `key:` followed by `- item` lines for a block list.
- Full-line comments beginning with `#`. Inline comments are **not** supported.
- Nested mappings, anchors, multi-line scalars and tab indentation are **not** supported and are
  reported as `front-matter-invalid` rather than guessed at.

| Key | Shape | Notes |
| --- | --- | --- |
| `id` | scalar | Required. The identity every supersession reference resolves against. |
| `title` | scalar | Falls back to the first level-one heading. |
| `status` | scalar | One of `proposed`, `accepted`, `rejected`, `deprecated`, `superseded`. |
| `date` | scalar | `YYYY-MM-DD`, checked against the calendar, never against the clock. |
| `owners` | list | Lower-cased for grouping. |
| `systems` | list | Lower-cased for grouping. |
| `supersedes` | list | Ids this record replaces. |
| `superseded-by` | list | Ids that replace this record. |
| `tags` | list | Lower-cased for grouping. |

`status`, `owners`, `systems` and `tags` are lower-cased, de-duplicated and sorted by code unit so
each value groups exactly once. `id`, `supersedes` and `superseded-by` keep their case: they are
identities, not labels.

Any other key is reported as `front-matter-key-unknown` and is not indexed. This is deliberate: a
`supersededby` that was silently ignored would remove an edge from the graph, and a removed edge is
how a real cycle becomes a green run.

## Supersession

An edge points **from** the record that supersedes **to** the record it replaces. Both fields
produce edges:

- `supersedes: [X]` on record `R` produces `R -> X`.
- `superseded-by: [Y]` on record `R` produces `Y -> R`.

Identical edges from the two directions collapse into one edge that remembers both declarations, so
a finding can name the exact file and field. An edge declared from only one side is reported as
`supersession-asymmetric` against the record that is silent — reported, never repaired.

`current` in the index is the record reached by following edges forward until no further edge
exists. It is `null` when the record is not superseded, and also `null` when the chain branches,
enters a cycle, or exceeds `maxChainDepth`: in each of those cases there is no single honest answer,
and inventing one would misrepresent the history.

## Rule catalog

| Rule | Severity | Meaning |
| --- | --- | --- |
| `date-invalid` | warning | `date` is not a calendar date in `YYYY-MM-DD` form. |
| `directory-too-deep` | error | Directory nesting exceeded `maxDepth`; its contents were not examined. |
| `front-matter-field-invalid` | error | A list key was written as a scalar, or a scalar key as a list. |
| `front-matter-invalid` | error | A front matter line could not be parsed, or the block was never closed. |
| `front-matter-key-unknown` | warning | A key outside the documented vocabulary; it was not indexed. |
| `front-matter-missing` | error | The file has no front matter block, so it is not a decision record. |
| `front-matter-too-long` | error | Front matter did not close within `maxFrontMatterLines`. |
| `no-records-found` | warning | No record was indexed, so the run checked nothing. |
| `owners-missing` | warning | The record names no owners. |
| `path-escapes-root` | error | An entry resolves outside the real record root and was refused unread. |
| `record-id-duplicate` | error | Two records claim one id, so references to it are ambiguous. |
| `record-id-mismatch` | warning | The filename numbers the record differently from its declared id. |
| `record-id-missing` | error | The record declares no id, so nothing can reference it. |
| `record-not-utf8` | error | The bytes are not valid UTF-8; the record was not parsed. |
| `record-too-large` | error | The record exceeds `maxRecordBytes` and was not parsed. |
| `record-unreadable` | error | A file or directory could not be read or resolved, or a record-shaped entry is not a regular file. |
| `section-missing` | warning | A required section heading is absent. |
| `status-missing` | error | The record declares no status. |
| `status-supersession-mismatch` | warning | Status and the supersession graph disagree. |
| `status-unknown` | error | Status is outside the documented vocabulary. |
| `supersession-asymmetric` | warning | Only one of the two records declares the relationship. |
| `supersession-cycle` | error | Supersession forms a loop; no record in it can be the decision that stands. |
| `supersession-self` | error | A record declares that it supersedes itself. |
| `supersession-target-missing` | error | A supersession references a record that is not in the set. |
| `supersession-too-deep` | error | Graph traversal exceeded `maxChainDepth`; the graph was not fully checked. |
| `systems-missing` | info | The record names no affected systems. |
| `title-missing` | warning | The record has neither a title nor a level-one heading. |
| `too-many-records` | error | The root holds more than `maxRecords` records; the scan stopped. |

Severity is not written at the point a finding is constructed. It is read from a single frozen
`RULE_SEVERITY` table in `src/index.mjs`, a rule missing from that table throws rather than
defaulting to anything, and `test/severity-table.test.mjs` asserts this catalog and that table
against each other in both directions. Because a coordinated edit to both would agree with itself,
that file also pins every rule's severity rule by rule, independently of either.

## Limits

| Limit | CLI flag | Default | Exceeding it |
| --- | --- | ---: | --- |
| `maxRecords` | `--max-records` | 2000 | `too-many-records`, run is `incomplete` |
| `maxRecordBytes` | `--max-record-bytes` | 262144 | `record-too-large`, run is `incomplete` |
| `maxDepth` | `--max-depth` | 8 | `directory-too-deep`, run is `incomplete` |
| `maxFrontMatterLines` | `--max-front-matter-lines` | 200 | `front-matter-too-long`, run is `incomplete` |
| `maxChainDepth` | `--max-chain-depth` | 64 | `supersession-too-deep`, run is `incomplete` |

Every limit is enforced where it is documented and has a test that fails if the enforcement is
removed. Exceeding a limit is always an explicit finding and an `incomplete` report — never a
silently shorter answer, and never a pass.

An unknown limit name, an unknown option key, a duplicate required section, an unknown search key
and a value-carrying CLI flag given more than once are all refused as configuration errors. A
one-character typo must not quietly turn a real failure into a green run, and neither must a value
the caller can no longer see: `--root a --root b` and `--max-records 5 --max-records 1` are refused
rather than resolved by last-wins. `--section` is repeatable by design and declares the whole set.

## Report

The report follows the Edilec tool report contract v1.

- `status` is `pass`, `fail` or `incomplete`.
- `summary` carries `checked` (records indexed), `errors`, `warnings`, `info`, `files`, `skipped`,
  `edges`, `cycles`, `unresolved`, `superseded`, `owners` and `systems`.
- `location.file` is always relative to the record root, never an absolute host path.
- `location.pointer` is a documented field path: `/front-matter`, `/front-matter/<key>`,
  `/sections/<normalised name>`, `/supersedes/<n>`, `/superseded-by/<n>`, or `/` for a
  root-level finding whose `file` is `.`.
- `evidence` is a bounded, flattened excerpt with control characters, `U+2028` and `U+2029` removed.

### Exit codes

| Code | Meaning | stdout |
| ---: | --- | --- |
| 0 | every record indexed, graph sound | the report |
| 1 | the record set failed the check | the report |
| 2 | invalid usage or configuration | **empty** — the message is on stderr |
| 2 | evidence missing, undecodable or bounded out | an `incomplete` report |

A run that indexed nothing is `incomplete`, never a pass. `pass` with `checked: 0` is green on no
evidence, so `no-records-found` is emitted and the run is marked incomplete on that path.

## Determinism

- Directory entries are sorted by UTF-16 code unit before use, so filesystem enumeration order never
  reaches the output.
- Comparisons use a plain code-unit comparator. `localeCompare` is never used anywhere in this tool:
  its result depends on ICU data that varies between Node builds.
- Findings sort by `(location.file, location.pointer, ruleId, line, message)`.
- Records, group keys, edges and cycles all sort by code unit. A cycle is rotated to start at its
  smallest member, so the same loop always serialises identically.
- Nothing reads the wall clock, the locale, the environment or the network. Two runs over the same
  bytes produce byte-identical stdout.

Two runs inside one process and one locale agree with each other whatever the comparator does, so
`test/determinism.test.mjs` pins the properties themselves: the comparator's own ordering against
pairs an English collator orders the other way, each sort that stands between directory enumeration
and the report, and the absence of `localeCompare`, the clock, a random source, the environment and
the network from the shipped source.

## What this tool cannot conclude

- Whether a decision was **correct**, or whether it is still being followed. It reads what the
  records say about themselves.
- Whether a status is **truthful**. `status: accepted` on a decision everybody abandoned is indexed
  as accepted; only a disagreement with the supersession graph is detectable.
- Whether the record set is **complete**. A decision that was never written down leaves no trace,
  and a clean run says nothing about it.
- Whether a **prose reference** to another decision is valid. Only the `supersedes` and
  `superseded-by` fields form the graph; a link inside the body is not resolved.
- Whether an affected system name is **real**. `systems` is an uncontrolled vocabulary, so a typo
  creates a new group rather than an error.
