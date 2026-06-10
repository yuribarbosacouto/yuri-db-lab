# Roadmap

This roadmap is based on the portfolio audit priorities: automation first, then tests/documentation, then deeper architecture.

## Phase 1: working systems slice

- [x] SQL parser
- [x] Slotted pages
- [x] Heap files
- [x] Write-ahead log
- [x] Primary-key B+Tree
- [x] Secondary indexes
- [x] Query planner explanations
- [x] `ORDER BY` and `LIMIT`
- [x] WAL recovery into a fresh directory
- [x] Persisted index snapshots
- [x] CLI and shell
- [x] Benchmarks
- [x] Local Workbench UI
- [x] CI, CodeQL, Dependabot, Pages

## Phase 2: durability

- [x] WAL replay into a fresh directory
- [x] WAL replay at startup
- [x] Crash simulation tests
- [x] Atomic commit marker validation
- [x] Storage checksums
- [ ] Fsync strategy
- [ ] Page compaction

## Phase 3: query engine

- [x] Query planner
- [ ] Cost comparison between index lookup and heap scan
- [x] Secondary indexes
- [x] Basic sort and limit
- [ ] Simple aggregation

## Phase 4: scale and correctness

- [x] Persistent B+Tree page layout
- [x] Incremental mutable B+Tree insert splits
- [x] Direct on-disk index search
- [ ] B+Tree delete/rebalance
- [ ] Property-based tests for pages and parser
- [ ] Concurrency model
- [ ] Snapshot read experiments
- [ ] Benchmark history published in docs

## Phase 5: open-source polish

- [x] Releases with changelog
- [x] Architecture decision records for major changes
- [ ] More issue labels and contribution guide examples
- [x] Demo dataset
- [x] Guided demo walkthrough

## Phase 6: deeper inspection

- [ ] Visual page-path comparison for multiple predicates
- [ ] Benchmark history with saved runs
- [ ] Recovery scenarios for invalid commit markers and committed transaction replay
