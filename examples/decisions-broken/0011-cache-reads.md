---
id: ADR-0011
title: Cache reads at the edge
status: accepted
date: 2026-03-02
owners: [edge-team]
systems: [cdn]
supersedes: [ADR-0010]
tags: [cache]
---

# Cache reads at the edge

## Context

Read latency from the origin was too high for the catalogue pages.

## Decision

Cache read responses at the edge with a short time to live.

## Consequences

Stale catalogue entries are served for the length of the time to live.
