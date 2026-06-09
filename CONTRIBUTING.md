# Contributing

Thanks for taking a look at Yuri DB Lab. This project is meant to be readable, testable, and useful for studying database internals.

## Local setup

```bash
npm install
npm run build
npm test
npm run bench -- --rows 1000
```

## Development rules

- Keep storage changes covered by tests.
- Document new SQL syntax in `docs/SQL_DIALECT.md`.
- Add an ADR for architectural decisions that affect persistence, transactions, or indexing.
- Prefer small PRs with one clear behavior change.

## Pull request checklist

- Tests pass locally.
- Typecheck passes locally.
- The README or docs are updated when user-facing behavior changes.
- Benchmarks are included when performance behavior changes.
