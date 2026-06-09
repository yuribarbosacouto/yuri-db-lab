# ADR 001: Build a database systems lab

## Status

Accepted

## Context

The portfolio audit recommended stronger documentation, CI, tests, security automation, and more substantial architecture. The later benchmark discussion raised the bar: projects should be compared with highly starred and technically durable repositories, not only with small dashboards.

## Decision

Create a from-scratch database lab as the next flagship project.

The project will focus on:

- storage internals,
- query execution,
- indexing,
- durability,
- tests,
- documentation,
- reproducible CLI usage.

## Consequences

This gives the portfolio a project with systems depth and a clear learning path. It also avoids exaggerating scale: the project is not Linux, Chromium, or TensorFlow. It is a compact system that borrows their engineering habits.
