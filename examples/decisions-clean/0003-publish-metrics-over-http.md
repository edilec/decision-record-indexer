---
id: ADR-0003
title: Publish metrics over HTTP
status: proposed
date: 2025-06-02
owners: [observability-team]
systems: [telemetry]
tags: [metrics]
---

# Publish metrics over HTTP

## Context

Metrics are currently pushed to a collector that only one team can configure.

## Decision

Expose a read-only metrics endpoint on each service and let the collector
scrape it.

## Consequences

Each service gains one endpoint to secure. Collector configuration becomes a
single scrape list rather than per-service credentials.
