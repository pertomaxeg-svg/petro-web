# DB-01 — isolated schema reconstruction

This directory is a test-only reconstruction aid for Pertomax EG. It is not a production migration and must never be applied to the approved Supabase project or to an existing database.

## Snapshot scope

`current-schema.sql` was generated on 2026-10-15 from the approved Supabase project `msvgzsfzrqlrfpstthhe` using PostgreSQL 17 `pg_dump --schema-only --no-owner` for `public` and `petro_private`. It contains schema definitions only, not table rows. It preserves grants, RLS, policies, constraints, indexes, functions, and default privileges. Object owners are normalized by `--no-owner`.

Supabase-managed `auth` is intentionally not included. `local-auth-bootstrap.sql` creates a minimal local-only `auth.users` table and `auth.uid()` function so foreign keys and RLS policies can be tested. It is not a substitute for Supabase Auth and does not create an account, send mail, or use any project Secret.

## Rebuild and test

Run:

```sh
bash lib/db/rebuild/run-local-test.sh
```

The test requires PostgreSQL 17 client/server tools (`initdb`, `pg_ctl`, `psql`, and `pg_dump`) on `PATH`. It creates a temporary cluster under `/tmp`, disables TCP listening, loads the snapshot into a fresh local database, applies migrations `0002` and `0003` locally, checks object counts and compares the resulting schema dump with the saved snapshot, runs the RLS tests, then stops and removes the temporary cluster.

The snapshot is the **current final state**. It already contains the effects of `0001`–`0003`; the test does not replay `0001`, whose earlier-state operations can duplicate objects when applied to the final state. `0002` and `0003` are replayed locally only as an idempotency check. This does not repair the Supabase migration ledger or make the existing migration files a complete migration chain from zero.

## Tested boundaries and remaining limits

- The local fixture uses two fabricated users in separate organizations and three branches. Tests cover tenant and assigned-branch reads, cross-organization branch-link rejection, disabled-account read denial, anonymous read denial, direct role-write denial, invitation-table default-deny RLS despite its explicit DML grants, and the absence of automatic first-user ownership.
- The test fixture rolls back its sample rows and the script removes the whole local cluster even on failure.
- These checks validate the restored SQL/RLS behavior with a local `auth.uid()` stub. They do not prove real Supabase Auth sessions, email delivery, or production API behavior.
- No live DDL, DML, grant, RLS, owner, bootstrap, Secret, or migration-ledger change is part of this procedure.
