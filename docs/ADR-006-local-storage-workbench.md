# ADR 006: Local Storage Workbench

## Status

Accepted

## Context

The project now has enough real internals to be difficult to evaluate through README snippets alone. A CLI can prove the engine works, but it hides the storage effects that make this lab valuable: generated files, WAL records, heap pages, query plans, and B+Tree index pages.

The goal is not to create a decorative product shell. The goal is to make the database visible while it runs.

## Decision

Add `apps/workbench`, a local browser UI backed by a small Node HTTP server. The Workbench can seed a demo database, execute SQL, and render the resulting storage state:

- result tables and query messages
- planner strategy, reason, estimated cost, and index column
- database files with sizes
- JSONL WAL timeline
- heap pages with row counts and sample payloads
- page-backed B+Tree indexes with root, leaf, internal page, key, and entry summaries

The default data directory is `.workbench-db`, separate from the CLI default `.ydb`, so demos are repeatable and resettable.

## Consequences

- The project now has an immediate way to show the engine in action without requiring a user to know the CLI first.
- The UI increases product credibility while still serving the technical lab instead of masking it.
- Workbench snapshots currently inspect page files through core storage primitives. If the on-disk format changes, the Workbench must be updated alongside the engine.
- The UI is local-first and not a hosted multi-user database service.
