# ADR 004: Page-backed B+Tree index snapshots

## Status

Accepted

## Context

Earlier versions persisted indexes as a single JSON snapshot file. That was useful for proving index rebuild/load behavior, but it did not resemble the page-oriented shape used by real storage engines.

The next step should increase systems realism without pretending the project already has a fully mutable on-disk B+Tree.

## Decision

Persist index snapshots as page-backed files under `indexes/*.idx`.

Each index file is written through `PageFile` and contains:

- page `0`: metadata, including root page id and first leaf page id;
- leaf pages: sorted key to `RowId[]` entries plus `nextPageId`;
- internal pages: separator keys and child page ids.

The database still serves queries through the in-memory `BPlusTree`. Loading an index scans the persisted leaf chain and rebuilds the in-memory tree. Older `indexes/*.idx.json` files remain readable as a compatibility fallback.

## Consequences

The project now has a real page layout for persisted index snapshots, checksum protection for index pages, and a clearer path toward a mutable disk B+Tree.

This is not yet an incremental on-disk B+Tree. Rebuilds rewrite the page-backed snapshot, and future work still needs mutable page splits, parent updates, free-page reuse, and search directly over disk pages.
