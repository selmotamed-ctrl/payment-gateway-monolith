# Part Template

Copy this file into the relevant `project-design/parts/<area>/` directory and replace every placeholder.

```md
---
id: area.part
title: Part Title
status: partial
confidence: high
last_verified: 2026-11-03
verified_against: 5a24f6f+working-tree
code:
  - path/to/code/**
design_sources:
  - design/relevant-design.md#section
tests:
  - path/to/test/**
gaps:
  - Short description of a known gap
---

# Part Title

## 1. Purpose and scope

What this part owns, what it explicitly does not own, and which users/systems depend on it.

## 2. Design intent (extracted and synthesized from ./design)

The complete relevant design extracted from the historical `design/**` sources, corrected where the code has evolved. Preserve important rationale, state machines, contracts, invariants and edge cases. Do not merely link to the old files.

## 3. As-built architecture

The actual code structure, modules, data flow, dependencies and runtime composition, with code references.

## 4. Contracts and invariants

APIs, request/response shapes, database constraints, state transitions, authorization rules, money rules and other non-negotiables.

## 5. Data / API / config / deployment surface

Schema models, routes, environment keys, deploy settings, generated appendices and operational surfaces.

## 6. Operational usage

How to run, configure, test, observe, troubleshoot and safely change this part.

## 7. Status and deviations

### Implemented

### Partial

### Missing / deferred

### Known bugs / risks

Each item must state whether it is a code gap, a documentation gap, or an intentional deferral.

## 8. Verification and tests

Commands, test files, benchmarks and acceptance gates. State which suites skip without PostgreSQL/Redis/live hosts.

## 9. Source references

### Old design sections

### Code paths

### Generated appendices

## 10. Change history

Dated entries or a pointer to `project-design/TRACKER.md`.
```
