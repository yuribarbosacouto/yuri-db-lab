# Changelog

All notable changes to Yuri DB Lab are documented here.

## [0.5.0] - 2026-06-09

### Added

- Page-backed B+Tree index snapshot format under `indexes/*.idx`.
- Index meta pages, linked leaf pages, and internal pages persisted through `PageFile`.
- Checksum manifests for persisted index page files.
- Legacy fallback for older `indexes/*.idx.json` snapshots.
- `IndexStore.inspect()` diagnostics for the index storage format.
- Tests for paged index persistence, legacy JSON fallback, and database-level `*.idx` creation.
- ADR 004 documenting the page-backed index snapshot decision and remaining mutable B+Tree work.

### Changed

- `YuriDatabase` now writes indexes to `indexes/*.idx` instead of `indexes/*.idx.json`.
- Storage, query engine, architecture, roadmap, README, and docs site now describe paged index snapshots.

## [0.4.0] - 2026-06-09

### Added

- Page-level checksum manifests for persisted heap pages.
- Corruption detection when reading pages whose checksums no longer match.
- Transaction commit markers now include logical `recordCount` values.
- Startup and manual WAL recovery reject transaction batches whose commit marker count does not match the batch.
- Tests for page corruption detection, invalid commit markers, and commit marker record counts.
- ADR 003 documenting page checksums and commit marker validation.

### Changed

- Storage, recovery, architecture, roadmap, README, and docs site now describe the stronger durability checks.

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
