---
id: ADR-0001
title: Record architecture decisions
status: superseded
date: 2025-03-04
owners: [platform-team]
systems: [docs]
supersedes: []
superseded-by: [ADR-0004]
tags: [process]
---

# Record architecture decisions

## Context

Decisions were being agreed in chat and lost. Nobody could answer why a
component looked the way it did six months later.

## Decision

Keep one Markdown record per decision in this directory, numbered in sequence,
with front matter carrying the status, owners and affected systems.

## Consequences

Every change of direction costs one short file. Old records are never deleted
or edited once accepted; a later record supersedes them instead.
