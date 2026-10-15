# DB-01/DB-02 — isolated schema reconstruction and permission tests

This directory is a test-only reconstruction aid for Pertomax EG. It is not a production migration and must never be applied to the approved Supabase project or to an existing database.

## Snapshot scope

`current-schema.sql` was generated on 2026-10-15 from the approved Supabase project `msvgzsfzrqlrfpstthhe` using PostgreSQL 17 `pg_dump --schema-only --no-owner` for `public` and `petro_private`. It contains schema definitions only, not table rows. It preserves grants, RLS, policies, constraints, indexes, functions, and default privileges. Object owners are normalized by `--no-owner`.

Supabase-managed `auth` is intentionally not included. `local-auth-bootstrap.sql` creates a minimal local-only `auth.users` table and `auth.uid()` function. The snapshot contains `petro_private.handle_auth_user()` but excludes the trigger on managed `auth.users`; `local-auth-post-baseline.sql` recreates and verifies that single trigger for local testing. These fixtures are not a substitute for Supabase Auth and do not create an account, send mail, or use any project Secret.

## Rebuild and test

Run:

```sh
bash lib/db/rebuild/run-local-test.sh
```

The test requires PostgreSQL 17 client/server tools (`initdb`, `pg_ctl`, `psql`, and `pg_dump`) on `PATH`. It creates a temporary cluster under `/tmp` with TCP listening disabled, creates the local Auth stub, loads the saved schema baseline, recreates the Auth trigger fixture, verifies object counts, and compares a schema dump to the snapshot **before** later changes. It then runs the DB-01 checks, applies 0004–0009 in sequence while comparing `pg_default_acl` before and after each migration, runs the DB-02 and platform-user SQL checks, and executes the actual API management router over local HTTP with a fake Supabase transport backed only by the temporary PostgreSQL cluster. The runner removes the cluster even on failure.

## Snapshot and migration relationship

- `current-schema.sql` is the current `public`/`petro_private` baseline, not a historical migration. It contains the current application object definitions and the effects represented by migrations `0001`–`0003`; never replay those files over this baseline.
- `0001` contains earlier foundation/auth/management changes and assumes pieces of the schema already exist. `0002` updates username/Auth-profile behavior and creates the `auth.users` profile trigger. `0003` adds sign-in rate-limit storage. The Auth-managed trigger is outside the snapshot scope; the local fixture recreates its final state without replaying `0002`. Objects from `0003` that are within the captured schemas are already in the baseline.
- The current Supabase migration ledger was not changed. The DB-01 review found ledger labels `petro_foundation` and `petro_plan_versions` without matching SQL source files in the repository; `0001`–`0003` names do not match those ledger entries. Do not invent historical source files, edit the ledger to make it appear complete, or use these files as a fresh-install chain.
- `0004_db02_invitation_permissions.sql` is a forward migration **after the baseline**. It passed the disposable local tests and was applied to the approved Supabase project on 2026-10-15 after explicit approval and live preflight comparison. The live snapshot and post-apply evidence are in `docs/DB-02-PRODUCTION-SNAPSHOT-2026-10-15.md`; the existing migration ledger was left untouched.
- `0008_platform_user_administration.sql` adds owner-only platform-user RPCs and preserves the legacy status RPC for API compatibility. `0009_revoke_legacy_account_status_rpc.sql` is the later cutover step: it removes only `PUBLIC`, `anon`, and `authenticated` execution from the legacy RPC while preserving `service_role`. Both passed isolated tests; neither has been applied to Supabase. Follow `docs/PLATFORM-USER-ADMIN-ROLLOUT.md` before any live application.

## Tested boundaries and remaining limits

- DB-01 tests continue to cover tenant/branch reads, cross-organization branch-link rejection, disabled-account denial, anonymous denial, direct role-write denial, invite-table RLS default-deny, and no automatic first-owner behavior.
- DB-02 adds direct invite-table privilege denial, authenticated RPC availability, anonymous RPC denial, full default-ACL catalog equality before/after the proposed migration, authorized and unauthorized invitation flows, one-time acceptance, stale manager-issued owner-invite rejection, manager-to-owner escalation denial, actual platform-role allow/deny cases, role-namespace separation, organization-owner delegation, and tenant/branch isolation.
- All test users use `.invalid` addresses. SQL acceptance fixtures roll back; API integration fixtures exist only in the temporary local cluster, which the runner removes on success or failure.
- The local fixture validates SQL/RLS using a local `auth.uid()` stub. It does not prove real Supabase Auth sessions, SMTP, or production API behavior.
- Migrations 0004–0009 do not change default ACLs in any schema. Existing baseline defaults for future public objects remain as-is; this is a separate unresolved policy risk, not a claim that future objects are automatically safe.
- No live DDL, DML, grant, RLS, owner, bootstrap, Secret, or migration-ledger change was made for 0008/0009.
