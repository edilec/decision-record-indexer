# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Fixed

- `--index` could destroy a file the tool was never asked to write to, and the
  run exited `0` reporting `index written`. Reproduced four ways before the fix:
  a symbolic link at the destination replaced the file it pointed at, a link
  aimed at a path that did not exist created that file outside the archive, a
  symlinked parent directory did the same one level up, and a hard link to a
  decision record overwrote the record itself — the one thing this tool
  promises never to write to. The destination is now checked immediately before
  the write by `assertWritableDestination`: a symbolic link is refused on sight
  by `lstat`, the parent is resolved and compared against `--index-root`, and
  identity against every record the run read is compared by device and inode.
  A refused destination exits `2` with empty stdout.
- `resolveIndexDestination` returned the destination with its own symbolic link
  already resolved, which handed the caller a path that writes through a link
  nobody named. It now decides containment on the resolved path and returns the
  path as named, and probes ancestors from the parent so the destination itself
  is never passed to `realpath`.
- A hard link to a file inside the record root that the run never opened still
  destroyed that file, and exited `0` reporting `index written`. The identity
  check can only compare against the records the run actually read, so a README
  the walk skips by name, a note with the wrong extension, or a record bounded
  out by `--max-records` was invisible to it, and the in-place write rewrote
  the file through the shared inode. The index is now written to a temporary
  file and renamed over the destination, so the write replaces the name and
  every other name for the old file keeps its content.
- `writeIndexFile` created missing parent directories before it checked
  containment, so a destination reached through a symlinked parent had a
  directory created outside `root` and only then was refused. Its own
  documentation claimed `root` prevented that. Containment is now decided on
  the nearest existing ancestor, before `mkdir` runs.

### Added

- `--index-root`, the tree `--index` may be written into. It defaults to the
  working directory, still creates missing directories below itself, and has no
  meaning without `--index`.
- `sources` on the result of `indexDecisionRecords`: the real path of every
  record file the run read, which is what proves a destination is not one of
  them.

- a front matter parser for the documented subset — scalars, inline lists, block
  lists and full-line comments — that reports nested mappings, tab indentation,
  duplicate keys and unparsable lines instead of guessing at them, and reports
  any key outside the vocabulary rather than dropping it silently;
- strict UTF-8 decoding with `TextDecoder('utf-8', { fatal: true })`, so whether
  a record is decodable is the decoder's decision and never an inference drawn
  from the decoded text;
- heading and section extraction that ignores fenced code, a required-section
  check whose set is configurable from the CLI, and a bounded excerpt of the
  Decision section for text search;
- the supersession graph, built from both `supersedes` and `superseded-by`, with
  self-supersession, references to records that do not exist, and cycles all
  reported as errors, cycles rotated to a canonical form so the same loop always
  serialises identically, and each historical record resolved forward to the
  decision that currently stands;
- `status-supersession-mismatch` and `supersession-asymmetric` for the two ways
  a record's own metadata can disagree with the graph, both reported and neither
  repaired;
- a derived index — records, `byStatus`, `byOwner`, `bySystem`, `byTag` and the
  supersession edges, cycles and unresolved references — written only to a
  destination outside the record root, checked against the real path so a
  symlinked parent cannot put it back inside;
- `searchIndex` over that index by status, owner, system, tag and text, with an
  unknown query key refused rather than ignored;
- explicit record-count, byte, directory-depth, front-matter-line and
  supersession-depth limits, each reported by name when hit and each making the
  run `incomplete` instead of truncating;
- real-path containment for every entry under the root, so a symbolic link to a
  file or a directory outside the tree is refused unread and none of its content
  reaches the report or the index;
- `record-unreadable` for an entry named like a record that is not a regular
  file — a FIFO, a socket, a device node — which is reported and makes the run
  `incomplete` rather than being dropped in silence inside a passing run;
- a CLI with `--help`, `--json`, `--index`, `--section` and the limit flags, the
  report on stdout, diagnostics on stderr, and exit codes 0 / 1 / 2 — with an
  empty stdout for a configuration error and an `incomplete` report for evidence
  that could not be obtained, and with a repeated value-carrying flag refused as
  a configuration error instead of silently overwriting the earlier value;
- runnable clean and deliberately broken example record sets; the broken set
  spreads its findings over five files, so the documented finding order is
  demonstrated as well as the rules;
- the rule catalog, front matter vocabulary, limits, report shape, exit codes,
  determinism guarantee and the list of things this tool cannot conclude in
  `docs/decision-rules.md`.

### Guaranteed

- No decision record is ever written to. The index is a derived artifact with
  its own destination, and there is no auto-fix of any kind.
- A run that indexed no record is `incomplete` and exits 2. `pass` with
  `checked: 0` is not reachable.
- Every finding takes its severity from one frozen `ruleId -> severity` table;
  an unknown rule id throws, the table is asserted against the documented
  catalog in both directions, and every severity is additionally pinned rule by
  rule, so downgrading a rule in both the table and the catalog is still caught.
- No wall clock, locale, `localeCompare`, random source, network access or
  filesystem enumeration order affects the output.

No release has been published.
