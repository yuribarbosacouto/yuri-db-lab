# Storage Engine

The storage engine uses three concepts: page files, slotted pages, and heap files.

## Page file

`PageFile` stores fixed-size 4096-byte pages on disk. Pages are addressed by numeric page id. The abstraction is intentionally small:

- `allocatePage()`
- `readPage(pageId)`
- `writePage(pageId, page)`
- `pageCount()`

Each written page also updates a sidecar checksum manifest:

```text
tables/users.heap
tables/users.heap.checksums.json
```

On read, `PageFile` recalculates the page checksum and throws if the stored value does not match. Existing legacy pages without a checksum entry can still be read, but every new write records a checksum.

## Slotted page

`SlottedPage` stores variable-size records inside a fixed page.

```text
+-------------------+----------------------+-------------------+
| header            | slot directory       | record payloads   |
| slot count/free   | offset + length each | grow downward     |
+-------------------+----------------------+-------------------+
```

The slot directory grows forward. Record payloads grow backward from the end of the page. Deletes tombstone a slot by setting its length to zero.

## Heap file

`HeapFile` stores JSON-encoded rows in slotted pages. An inserted row returns a `RowId`:

```ts
type RowId = {
  pageId: number;
  slotId: number;
};
```

The row id is stable until the row is deleted. Updates are implemented as delete plus insert, which keeps the storage code simple and makes index rebuilding explicit.

## Indexing

The primary-key and secondary B+Tree indexes map scalar keys to row ids. Index files are page-backed:

```text
indexes/users.id.idx
indexes/users.id.idx.checksums.json
indexes/users.age.idx
indexes/users.age.idx.checksums.json
```

The index file contains a meta page, linked leaf pages, and internal pages. Inserts mutate the file in place: leaf pages split, separator keys propagate through internal pages, and the root is replaced when it overflows.

Indexed reads now search the page-backed file directly:

- point lookups descend from root to leaf;
- range lookups descend to the first matching leaf and then follow the linked leaf chain;
- index-ordered scans stream row ids from leaf pages in key order.

The older full-load path remains available for compatibility and diagnostics, but normal indexed `SELECT` execution no longer needs to rebuild the entire B+Tree in memory.

## Startup recovery

Opening a database triggers logical WAL recovery. The engine replays committed records that were written to the log before the heap saw them, and it undoes records from incomplete transaction batches that may have reached the heap before a crash. Indexes are rebuilt after recovery.

## Known limitations

- Deleted payload bytes are not compacted yet.
- The heap file scans pages linearly for insert space.
- B+Tree deletes and rebalancing are not implemented yet; update/delete paths rebuild affected indexes.
- Checksums detect page corruption, but they do not repair damaged pages.
- Recovery does not yet model fsync policy or atomic directory swaps.
