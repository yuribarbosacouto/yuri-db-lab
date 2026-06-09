# Query Engine

The v0.2 query engine adds a small planner and secondary indexes. The point is not to mimic PostgreSQL, but to make query execution inspectable.

## Planner strategies

`planSelect` can choose four strategies:

- `primary-key-index`: equality predicate on the primary key.
- `secondary-index`: predicate on a column with a user-created index.
- `index-ordered-scan`: no predicate, but `ORDER BY` can stream through an index.
- `heap-scan`: fallback when no index matches the query shape.

Each `SELECT` returns the chosen plan in `QueryResult.plan`, and the CLI prints the strategy.

## Secondary indexes

```sql
create index idx_users_age on users (age);
create unique index idx_users_email on users (email);
```

Index metadata is stored in `catalog.json`. Index snapshots are written as page-backed files under `indexes/*.idx`, with checksum manifests next to them. Older `indexes/*.idx.json` snapshots can still be loaded as a compatibility fallback.

## Predicate support

The planner can use indexed predicates for:

```text
= > >= < <=
```

Strict range predicates are first fetched through an inclusive B+Tree range and then filtered with the predicate evaluator.

## Ordering and limit

```sql
select id, age from users where age >= 18 order by age desc limit 10;
```

Rows are ordered after retrieval. If there is no predicate and the `ORDER BY` column is indexed, the planner can choose an index-ordered scan.

## Recovery

When `YuriDatabase` opens a directory, it reads `wal.jsonl` and performs startup recovery:

- autocommit mutation records are replayed idempotently;
- records inside `begin`/`commit` batches are replayed only after a valid commit marker;
- new commit markers carry a logical `recordCount`, and mismatches are rejected as invalid batches;
- records inside an incomplete transaction batch are undone in reverse order;
- indexes are rebuilt after recovery so stale snapshots do not survive a crash path.

The startup report is available from code:

```ts
const db = new YuriDatabase(".ydb");
console.log(db.startupRecovery());
```

The CLI can rebuild a fresh database directory from the write-ahead log:

```bash
node apps/cli/dist/index.js recover --from .ydb --to .ydb-recovered
```

Recovery replays committed transaction batches and ignores rolled-back writes. It resolves updates and deletes by primary key so recovered `RowId`s do not need to match the source database.
