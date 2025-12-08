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

ADR-0001 put every record in one central archive. Records drifted away from the
code they described and reviewers stopped reading them.

## Decision

Each repository keeps its own decision records next to its source, and a
derived index is generated from them. ADR-0001 stays exactly as written: it is
the reason this rule exists.

## Consequences

The index is rebuilt per repository. Superseded records remain readable in
place and are still returned by a search of the index.
