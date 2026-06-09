# Roadmap

This roadmap is based on the portfolio audit priorities: automation first, then tests/documentation, then deeper architecture.

## Phase 1: working systems slice

- [x] SQL parser
- [x] Slotted pages
- [x] Heap files
- [x] Write-ahead log
- [x] Primary-key B+Tree
- [x] CLI and shell
- [x] Benchmarks
- [x] CI, CodeQL, Dependabot, Pages

## Phase 2: durability

- [ ] WAL replay at startup
- [ ] Crash simulation tests
- [ ] Atomic commit marker validation
- [ ] Storage checksums
- [ ] Page compaction

## Phase 3: query engine

- [ ] Query planner
- [ ] Cost comparison between index lookup and heap scan
- [ ] Secondary indexes
- [ ] Sort and limit
- [ ] Simple aggregation

## Phase 4: scale and correctness

- [ ] Persistent B+Tree page layout
- [ ] Property-based tests for pages and parser
- [ ] Concurrency model
- [ ] Snapshot read experiments
- [ ] Benchmark history published in docs

## Phase 5: open-source polish

- [ ] Releases with changelog
- [ ] Architecture decision records for major changes
- [ ] More issue labels and contribution guide examples
- [ ] Demo dataset and walkthrough
