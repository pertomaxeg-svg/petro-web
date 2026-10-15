# Central organizations/branches migration 0005

**Target:** Supabase project `msvgzsfzrqlrfpstthhe` only
**Migration:** `lib/db/migrations/0005_central_organizations_branches.sql`
**Status:** Applied atomically after local migration tests and a matching live preflight.
**Captured:** 2026-10-15. This document contains schema/permission metadata and aggregate counts only; no user rows or credentials.

## Production preflight (read-only)

- The project-scoped `SUPABASE_DB_URL` matched the approved Supabase project reference. The connection used the approved root CA with certificate and hostname verification; PostgreSQL reported TLS 1.3 and server version 17.11.
- Existing metadata matched the expected pre-0005 baseline: 11 tables, 57 constraints, 22 indexes, 23 functions, 12 RLS policies, and 11 RLS-enabled tables in `public` and `petro_private`.
- `petro_organizations` and `petro_branches` each contained 0 rows. No data rows would be rewritten by the migration's legacy-status mapping.
- The organization columns were `id,name,kind,country_code,currency,status,created_at,created_by`; branch columns were `id,organization_id,name,address,status,created_at`.
- None of the new 0005 columns (`code`, `approval_status`, `operational_status`, `version`) existed. RLS was enabled on the affected tables. The existing branch-to-organization relationship remained in place.
- The three live DB-02 function fingerprints matched: `petro_set_membership` `194fdfaefb42e0190cabcf1ec7c018f7`, `petro_create_invitation` `aaac469f056271aae583f7c4fbf18620`, and `petro_accept_invitation` `32b9f605068e3496dad9b7b1d7f18569`. The invitation table had no direct `anon` or `authenticated` SELECT/INSERT grants.
- `pg_default_acl` contained 24 entries. A SHA-256 digest of the sorted JSON rows `(role, schema, object type, ACL)` was `61410c298f404782b77c664690a5bf1fba9369f4df86a41fe17b70acc8e15f14`. This digest format is recorded for a same-method pre/post comparison; it is not the older snapshot's digest format.
- Six legacy organization/branch write RPCs still existed and had `EXECUTE` for `authenticated`, `service_role`, and owner `postgres`; none had `EXECUTE` for `anon`. Their definitions are not replaced by 0005; the migration revokes their grants to prevent bypassing version checks, separate approval/operational state, reasoned audit events, and branch-parent checks.
- The migration ledger still contained only `20261013111142/petro_foundation` and `20261013111150/petro_plan_versions`. `0004_db02_invitation_permissions.sql` remains applied but historically unrecorded. Neither 0004 nor the ledger will be changed or replayed.
- One active, confirmed owner account with an active profile was present by aggregate count only. Both owner-bootstrap Secrets were absent; no owner credentials or identity values were queried.

## Scope and forward path

`0005` is a single-transaction, additive migration scoped to the existing Pertomax organization and branch tables, their new detail RPCs, and retirement of the six old write-RPC grants. It adds organization/branch codes and contact/location details, separate approval and operational states, optimistic versions, constraints/indexes, and audit-reason enforcement. It does not modify RLS policies, default ACLs, Supabase-wide privileges, Auth identities, owner roles, or records in unrelated tables. Because both tables were empty at preflight, the compatibility mapping leaves no current organization/branch rows to transform.

For a new disposable test database, continue to apply the checked-in schema baseline, the isolated local `auth.users` fixture, the 0004 permission migration once, and then 0005 once. The baseline already represents the structure from 0001–0003; do not replay 0001–0003 on top of it. For the live database, apply only 0005 after its built-in fingerprint, ACL, RLS, and no-partial-columns preflight succeeds. Do not run the baseline, 0001–0004, or write a fabricated history row into `supabase_migrations.schema_migrations`.

## Rollback and recovery

1. If the migration errors before `COMMIT`, PostgreSQL rolls back the full transaction; verify that no 0005 columns/functions/indexes remain and retain the preflight snapshot.
2. After commit but before any new organization or branch is written, pause the new API path. A separately reviewed rollback transaction may drop the 0005 RPCs, indexes, constraints, and added columns, then restore the six legacy RPC grants exactly to `authenticated`, `service_role`, and `postgres`. Do not remove data or alter default ACLs/RLS.
3. Once any new organization or branch data is written, do not drop 0005 columns or audit records. Prefer a forward fix. If the app must be reverted, preserve the additive schema/data, disable the incompatible new API path, and restore legacy RPC grants only after confirming the application version and saved ACL snapshot. Any destructive schema rollback after data exists requires a new review and explicit authorization.

## Application and postflight (read-only)

- The checked-in local PostgreSQL 17 test passed: a fresh baseline, isolated Auth fixture, DB-01 and DB-02 tests, then 0005. The tests covered split approval/operational state, required audit reasons, uniqueness, optimistic concurrency, platform/entity role separation, branch-parent matching, and tenant/branch RLS isolation. All synthetic data was rolled back; no Replit Secret or network database was used.
- `0005_central_organizations_branches.sql` committed successfully as one transaction on the approved project using the project-scoped PostgreSQL Secret and full root-CA TLS verification.
- Postflight counts: 11 tables, 79 constraints, 24 indexes, 32 functions, 12 RLS policies, and 11 RLS-enabled tables. Both organization and branch tables remain empty. The 21 new fields are present; the migration added 22 check constraints and two unique indexes.
- The six retired legacy write RPCs no longer grant `EXECUTE` to `authenticated`, `service_role`, or `anon`. The eight new detail/approval/status RPCs are `SECURITY DEFINER` with empty `search_path`; `authenticated` and `service_role` can execute them, while `anon` cannot.
- The three DB-02 fingerprints still match. `pg_default_acl` remains 24 rows with the same sorted-JSON SHA-256 digest, `61410c298f404782b77c664690a5bf1fba9369f4df86a41fe17b70acc8e15f14`. RLS/policy counts and the two-row Supabase migration ledger are unchanged.
- One active, confirmed owner account with an active profile remains. Owner bootstrap Secrets remain absent. No Auth user, organization, branch, invitation, or audit row was created or modified by the verification.

The database migration is complete. After the branch was loaded into the configured development workflows, `GET /api/healthz` returned HTTP 200, an unauthenticated `GET /api/organizations` returned HTTP 401, and the web root returned HTTP 200 with Arabic RTL markup. The desktop/mobile captures in `CENTRAL-ORGANIZATIONS-ACCEPTANCE.md` show the signed-out access gate only. They do not prove owner UI access or a live authorized data read.
