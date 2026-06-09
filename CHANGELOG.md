# Changelog

All notable changes to Yuri DB Lab are documented here.

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
