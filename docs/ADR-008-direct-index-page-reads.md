# ADR 008: Direct Index Page Reads

## Status

Accepted

## Context

Yuri DB Lab already persisted B+Tree indexes as page-backed files and could mutate inserts in place. The remaining gap was read behavior: indexed queries could still depend on loading the whole persisted tree into an in-memory `BPlusTree`.

That made the file format inspectable, but not yet central to query execution.

## Decision

Add direct page-backed read methods to `IndexStore`:

- `search(table, column, key)` descends from meta/root through internal pages to a leaf page.
- `range(table, column, min, max)` descends to the first relevant leaf and follows linked leaves.
- `entries(table, column)` streams leaf entries in key order for index-ordered scans.

`YuriDatabase` now uses those methods for indexed `SELECT` execution and duplicate checks. Opening a database with existing page-backed indexes no longer loads every index into memory just to make queries work.

Recovery undo keeps a heap-scan fallback because a crash can leave a row in the heap before the corresponding index mutation reaches disk.

## Consequences

- The persisted B+Tree file is now part of the live query path, not only a snapshot artifact.
- Index lookup behavior is closer to a real storage engine.
- The in-memory B+Tree builder remains useful for index rebuilds, compatibility loading, and diagnostics.
- Delete/rebalance is still future work; update and delete paths rebuild affected indexes.
