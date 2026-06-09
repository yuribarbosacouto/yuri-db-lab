# ADR 002: Startup WAL recovery

## Status

Accepted

## Context

Version 0.2.0 could rebuild a fresh database directory from `wal.jsonl`, but opening an existing directory trusted the current heap and catalog files. That left an important durability gap: if a process stopped after writing WAL records but before fully applying heap/index changes, startup could expose stale or uncommitted state.

## Decision

Run logical WAL recovery whenever `YuriDatabase` opens a directory.

Startup recovery will:

- replay committed autocommit records idempotently;
- replay records inside `begin`/`commit` batches only after the `commit` marker;
- undo records from incomplete transaction batches in reverse order;
- rebuild indexes after recovery;
- expose a `startupRecovery()` report for tests, diagnostics, and future CLI visibility.

The explicit `recover --from --to` command remains useful for rebuilding a separate directory from WAL.

## Consequences

The database now has a real crash-recovery path for the lab's logical WAL model. This improves the project from a manual recovery demo to a more database-like runtime.

This does not yet model every durability guarantee of a production engine. Future work still includes fsync strategy, atomic commit marker validation, torn page checksums, page compaction, and persistent B+Tree page storage.
