---
id: ADR-0012
title: Retire the legacy queue
status: accepted
date: 2026-03-04
systems: [messaging]
supersedes: [ADR-0099]
tags: [messaging]
---

# Retire the legacy queue

## Context

The legacy queue has no owner and no client left on a supported release.

## Decision

Remove the legacy queue after the last consumer migrates.
