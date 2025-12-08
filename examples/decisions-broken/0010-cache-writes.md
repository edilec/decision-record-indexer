---
id: ADR-0010
title: Cache writes at the edge
status: accepted
date: 2026-03-01
owners: [edge-team]
systems: [cdn]
supersedes: [ADR-0011]
tags: [cache]
---

# Cache writes at the edge

## Context

Write latency from the origin was too high for the checkout flow.

## Decision

Buffer writes at the edge and flush them to the origin asynchronously.

## Consequences

A flush failure is invisible to the caller until the next read.
