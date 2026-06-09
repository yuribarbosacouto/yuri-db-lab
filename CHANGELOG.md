# Changelog

All notable changes to Yuri DB Lab are documented here.

## [0.3.0] - 2026-06-09

### Added

- Automatic startup WAL recovery when opening a database directory.
- Idempotent redo for committed autocommit and transaction WAL records.
- Undo handling for incomplete transaction batches left without a `commit` marker.
- Startup recovery report exposed through `YuriDatabase.startupRecovery()`.
- Crash simulation tests covering redo, committed transaction replay, and undo of uncommitted heap changes.
- ADR 002 documenting the startup WAL recovery decision and remaining durability limits.

### Changed

- Indexes are rebuilt after startup recovery so stale snapshots do not survive crash paths.
- Roadmap, architecture, storage, query engine, README, and docs site now describe the durability model more precisely.

## [0.2.0] - 2026-06-09

### Added

- Secondary indexes with `CREATE INDEX` and `CREATE UNIQUE INDEX`.
- Rule-based query planner that reports `primary-key-index`, `secondary-index`, `index-ordered-scan`, or `heap-scan`.
- `ORDER BY`, `LIMIT`, persisted index snapshots, WAL recovery into a fresh directory, and CLI recovery command.
- Query engine documentation and additional tests for storage/page invariants.

### Clarified

- The project is a database systems lab, not a production database.
- WAL recovery and B+Tree persistence are partial/experimental and documented as such.

## [0.1.0] - 2026-06-09

### Added

- SQL parser, slotted pages, heap files, JSONL WAL, primary-key B+Tree, transactions, CLI, benchmarks, docs, CI, CodeQL, Dependabot, and Pages.
