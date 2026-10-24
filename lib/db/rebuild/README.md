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

The test requires PostgreSQL 17 client/server tools (`initdb`, `pg_ctl`, `psql`, and `pg_dump`) on `PATH`. It creates a temporary cluster under `/tmp` with TCP listening disabled, creates the local Auth stub, loads the saved schema baseline, recreates the Auth trigger fixture, verifies object counts, and compares a schema dump to the snapshot **before** later changes. It runs the organization, user, billing, finance, and fleet SQL checks; applies each proposed migration to the disposable database while comparing default ACLs; and runs local HTTP router checks. The fleet-finance harness calls the real PostgreSQL policy, coverage, reservation, and ledger functions over synthetic fixtures; it does not use a fake Supabase response for those integration assertions. The runner removes the cluster even on failure.

## Snapshot and migration relationship

- `current-schema.sql` is the current `public`/`petro_private` baseline, not a historical migration. It contains the current application object definitions and the effects represented by migrations `0001`–`0003`; never replay those files over this baseline.
- `0001` contains earlier foundation/auth/management changes and assumes pieces of the schema already exist. `0002` updates username/Auth-profile behavior and creates the `auth.users` profile trigger. `0003` adds sign-in rate-limit storage. The Auth-managed trigger is outside the snapshot scope; the local fixture recreates its final state without replaying `0002`. Objects from `0003` that are within the captured schemas are already in the baseline.
- The current Supabase migration ledger was not changed. The DB-01 review found ledger labels `petro_foundation` and `petro_plan_versions` without matching SQL source files in the repository; `0001`–`0003` names do not match those ledger entries. Do not invent historical source files, edit the ledger to make it appear complete, or use these files as a fresh-install chain.
- `0004_db02_invitation_permissions.sql` is a forward migration **after the baseline**. It passed the disposable local tests and was applied to the approved Supabase project on 2026-10-15 after explicit approval and live preflight comparison. The live snapshot and post-apply evidence are in `docs/DB-02-PRODUCTION-SNAPSHOT-2026-10-15.md`; the existing migration ledger was left untouched.
- `0008_platform_user_administration.sql` adds owner-only platform-user RPCs and preserves the legacy status RPC for API compatibility. `0009_revoke_legacy_account_status_rpc.sql` is the later cutover step: it removes only `PUBLIC`, `anon`, and `authenticated` execution from the legacy RPC while preserving `service_role`. Both passed isolated tests; neither has been applied to Supabase. Follow `docs/PLATFORM-USER-ADMIN-ROLLOUT.md` before any live application.
- `0014_fleet_registry_and_controls.sql` is applied to the approved project. `0015_fleet_subscription_options.sql` is an additive, source-fingerprinted forward migration for coverage assignment and scoped subscription/available-stock choices; its live apply record and rollback plan are in `docs/FLEET-ADMIN-0015-ROLLBACK-PLAN.md`. The 0015 fixtures exist only in the temporary local cluster.
- `0016_fleet_history_and_admin_directory.sql` is tested in the disposable-cluster runner. It preserves branch snapshots on vehicle moves, blocks moves with active usage reservations, and adds scoped company summaries and immutable expected-consumption versions. Before any live apply, compare only the affected foreign keys and RPC ACLs and follow `docs/FLEET-ADMIN-0016-ROLLBACK-PLAN.md`; retain the additive schema on a code rollback.
- `0017_catalog_services_and_fuel_pricing.sql` is an additive catalog migration. It seeds only measurement units, service categories, and fuel types—never merchant items, prices, stock, or transactions. The disposable test verifies tenant and branch ownership, price history, rounding, idempotency, direct-table denial, and role-specific RPCs. Its exact live rollout gate and non-destructive rollback are documented in `docs/CATALOG-SERVICES-0017-ROLLBACK-PLAN.md`.
- `0023_fleet_card_center_and_driver_pin_recovery.sql` was applied alone to the approved Supabase project on 2026-10-21 after explicit approval, a source-fingerprinted dry run, and a rollback plan. The disposable test covers the card catalog, encrypted PIN recovery, and rollback. The live postflight checked the migration ledger, exact RPC grants, preserved 0022 fleet contracts, 24 default-ACL scopes, 300 grant rows, and left 0009 deferred. See `docs/FLEET-CARDS-0023-ROLLBACK-PLAN.md`; rollback retains the nullable ciphertext column and widened constraint.

## Tested boundaries and remaining limits

- DB-01 tests continue to cover tenant/branch reads, cross-organization branch-link rejection, disabled-account denial, anonymous denial, direct role-write denial, invite-table RLS default-deny, and no automatic first-owner behavior.
- DB-02 adds direct invite-table privilege denial, authenticated RPC availability, anonymous RPC denial, full default-ACL catalog equality before/after the proposed migration, authorized and unauthorized invitation flows, one-time acceptance, stale manager-issued owner-invite rejection, manager-to-owner escalation denial, actual platform-role allow/deny cases, role-namespace separation, organization-owner delegation, and tenant/branch isolation.
- All test users use `.invalid` addresses. SQL acceptance fixtures roll back; API integration fixtures exist only in the temporary local cluster, which the runner removes on success or failure.
- The local fixture validates SQL/RLS using a local `auth.uid()` stub. It does not prove real Supabase Auth sessions, SMTP, or production API behavior.
- Migrations 0004–0009 and 0017 do not change default ACLs in any schema. Existing baseline defaults for future public objects remain as-is; this is a separate unresolved policy risk, not a claim that future objects are automatically safe.
- 0008 and 0010–0015 were applied only through their reviewed, project-scoped rollout records; 0009 remains deferred and no live data fixtures were inserted. The local runner does not apply 0009.
- Local tests simulate private document storage; they do not prove real Supabase Storage RLS, signed-download access, or an authenticated owner’s rendered admin UI. Do not treat the local PostgreSQL Auth stub as a live user session.
