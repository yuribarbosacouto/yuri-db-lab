# ADR 007: Guided System Demo

## Status

Accepted

## Context

The Workbench made storage internals visible, but raw panels alone did not answer why the project matters. A user could see files, WAL records, pages, and plans without understanding the engineering claim being demonstrated.

The project needs a proof flow: one action that turns implementation details into evidence.

## Decision

Add a guided Workbench demo that runs real database operations and renders their observable consequences:

- compare the same query before and after `CREATE INDEX`
- show the planner moving from `heap-scan` to `secondary-index`
- show ordered scans through an index
- insert after index creation and prove the mutable index path still finds the row
- trace the B+Tree page path for a lookup key
- simulate an incomplete transaction in a separate scratch database and show startup recovery undoing the dirty heap record

The guided demo stays local-first and uses the same core engine APIs as the CLI.

## Consequences

- The UI now explains the project through state transitions instead of static explanation.
- The demo is more convincing for portfolio review because it shows planner, storage, indexing, and recovery in one path.
- The Workbench server has a small amount of scenario orchestration code, so future storage format changes must keep the demo path updated.
