---
id: ADR-0002
title: Use PostgreSQL for the ledger
status: accepted
date: 2025-04-18
owners:
  - ledger-team
  - platform-team
systems:
  - ledger
  - billing
tags: [database, storage]
---

# Use PostgreSQL for the ledger

## Context

The ledger needs multi-row transactions and a schema that a reviewer can read.

## Decision

Store ledger entries in PostgreSQL, one schema per tenant, with all balance
changes written inside a single transaction.

## Consequences

Operational load moves to the database team. Cross-tenant reporting needs an
explicit export rather than a join.
