---
id: ADR-0005
title: Reject shared service accounts
status: rejected
date: 2026-02-09
owners: [security-team]
systems: [identity]
tags: [access]
---

# Reject shared service accounts

## Context

A proposal asked for one shared account per environment to simplify rotation.

## Decision

Rejected. Each workload keeps its own identity, because a shared account makes
an audit trail unattributable.

## Consequences

Rotation stays per workload. The rejected proposal is kept here so it is not
re-proposed without the reasoning.
