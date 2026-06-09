# ADR 005: Mutable page-backed index inserts

## Status

Accepted

## Context

Version 0.5.0 introduced page-backed B+Tree index snapshots. That improved storage realism, but inserts still rewrote the full index snapshot. A more realistic storage engine should mutate index pages incrementally.

Full mutable B+Tree behavior includes insert, delete, split, merge, redistribution, free-page reuse, crash-safe page updates, and direct disk-page search. Implementing all of that at once would make the lab harder to verify.

## Decision

Add mutable insert support to page-backed index files.

`IndexStore.insert()` now:

- descends from the root page to the target leaf;
- inserts row ids into existing keys or inserts a new key in sorted order;
- splits oversized leaf pages and updates the leaf chain;
- propagates separator keys into parent internal pages;
- splits oversized internal pages;
- creates a new root page when the old root overflows.

`YuriDatabase` uses this path for row inserts after a table/index already exists. Update and delete paths still rebuild affected indexes because delete/rebalance is a separate correctness problem.

## Consequences

The project now has a real mutable insert path for persisted B+Tree pages. This is a meaningful step beyond snapshots and better matches the architecture of storage engines.

The remaining work is explicit: delete/rebalance, free-page reuse, direct on-disk search, and crash-safe multi-page index updates.
