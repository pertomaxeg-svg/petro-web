---
name: Deferred trigger testing
description: Validate shared PostgreSQL triggers and commit-time constraints in rollback-only tests.
---

When one trigger function serves multiple table shapes, read `NEW`/`OLD` fields generically rather than referencing a field absent from some trigger's row type. A test that always rolls back can hide deferred constraint-trigger failures; force deferred constraints immediate before finishing the test transaction.

**Why:** A financial entry/line balance trigger must work for both table records, and an error deferred to commit is otherwise invisible in a test that rolls back first.

**How to apply:** Use generic record access in shared triggers, and include an explicit commit-time validation step in local tests before rolling back their synthetic data.
