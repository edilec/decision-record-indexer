---
id: ADR-0013
title: Approve the staged rollout
status: approved
date: 2026-02-30
owners: [release-team]
systems: [deploy]
reviewers: [someone]
tags: [rollout]
---

# Approve the staged rollout

## Context

A rollout needs an agreed gate between stages.

## Decision

Promote a stage only after the previous stage has run for one full day.

## Consequences

A rollout takes longer and a bad stage is caught before the next one starts.
