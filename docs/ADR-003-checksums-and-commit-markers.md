# ADR 003: Page checksums and commit marker validation

## Status

Accepted

## Context

Version 0.3.0 added automatic startup WAL recovery, but two durability risks remained visible:

- heap pages could be corrupted without detection;
- a transaction batch with a damaged or partial commit marker could be treated as committed.

Production databases handle these problems with stronger write ordering, checksums, commit records, fsync policies, and recovery protocols. Yuri DB Lab needs a smaller version of those ideas that remains inspectable.

## Decision

Add page-level checksums outside the page payload and validate logical commit markers.

The storage layer writes a sidecar manifest next to each heap file:

```text
tables/users.heap
tables/users.heap.checksums.json
```

`PageFile` updates the checksum after every page write and verifies it on read. Legacy pages without manifest entries remain readable, but newly written pages become protected.

For transactions, `commit` WAL records now include a logical `recordCount`. Startup and manual recovery accept a transaction batch only when the marker count matches the number of logical WAL records in the batch. Mismatches are treated as invalid commit markers.

## Consequences

The engine can now detect corrupted persisted pages and reject malformed transaction commits. This moves the lab closer to real storage-engine durability behavior without pretending to implement full production crash safety.

The remaining durability gaps are explicit: fsync policy, atomic file replacement, torn-write handling, page repair, and page-oriented B+Tree persistence.
