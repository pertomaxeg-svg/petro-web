# Platform-user account creation and temporary password gate

## Scope

Migration `0020_platform_user_temporary_passwords.sql` adds one profile flag and one
owner-only RPC. It does not alter existing role rows, authentication settings,
default ACLs, account data, organization memberships, or the deferred `0009`.
Temporary passwords are provided by an authorized owner, used only in the
Supabase Auth signup request, never returned or logged, and never stored in
application tables. The user must set a different password before using
protected platform routes.

The RPC is callable only by `authenticated`; it checks the active owner role,
rejects self-assignment and suspended accounts, permits initial role assignment
for a pending account, records the reason, and treats an identical retry as a
no-op. It cannot overwrite role history.

## Required preflight before applying to the approved Supabase project

1. Confirm the connected project reference is exactly `msvgzsfzrqlrfpstthhe`.
2. Confirm the migration ledger contains the approved prior sequence through
   `0019` and does not contain `0020`; do not replay earlier migrations.
3. Compare the current `petro_profiles` definition, platform-role function
   signature, role table and function ACLs with the tested migration contract.
4. Record the current default-ACL fingerprint and verify it after application.
5. Save a read-only schema snapshot and confirm the column and function are not
   already present with conflicting definitions.

The migration is transactional and add-only. The local disposable rebuild
applies it after the existing migrations, checks the default-ACL fingerprint,
and runs `platform-user-provisioning-smoke-test.sql` before any live application.

## Live preflight and application record

- Source SHA-256: `a99001b508848f9564ce7817d9bf984e239dee19e24e723c17a5be06a8578ef0`.
- The approved migration runner validates the full known migration sequence,
  verifies `0009` remains absent, snapshots all default ACL scopes and the
  legacy/0008 status RPC definitions and grants, then applies only 0020 in one
  transaction. It checks the new column's exact type/default, the RPC body,
  `SECURITY DEFINER`/empty `search_path`, and the narrow execution ACL.
- On 2026-10-19 the live preflight matched PostgreSQL 17.11 over verified TLS
  1.3. The exact source was absent from the schema and migration ledger before
  application; 0008 and the legacy account-status RPC matched their reviewed
  definitions and grants. The all-scope default-ACL snapshot was 24 scopes /
  300 grant rows, SHA-256
  `65e09b76b80628c531e6e223128f0a201befefeb9eaa75685dae5dafdc337cea`.
- After explicit owner approval, only 0020 was applied. The ledger version is
  `20261019143829`, with source SHA-256
  `a99001b508848f9564ce7817d9bf984e239dee19e24e723c17a5be06a8578ef0`.
  Postflight confirmed the column default/type, exact RPC body and narrow
  grants; `pg_default_acl` remained unchanged; the 0008 and legacy RPC
  definitions/grants remained unchanged; 0009 remains absent. No users,
  organizations, or business records were created.
- Rollback remains forward-compatible: do not drop the additive schema or
  rewrite the ledger. If a release issue appears, disable the new endpoint and
  run the previous API; keep the schema and reset gates for any account created
  later. The runner retained the pre-apply ACL and status-RPC snapshots in
  memory for the transaction; no separate full schema dump was created.

## Current state and access model

- Migration 0020 is applied to the approved live Supabase project. The API's
  schema readiness check can now pass, so the authorized owner may create a
  platform-user account using the tested flow.
- The owner assigns one or more existing platform-role bundles. The form shows
  the real sections granted by those bundles; it does not support arbitrary
  per-user permission overrides because the current authorization model has no
  such control.
- After email confirmation, the account still follows the existing pending
  approval state. An owner activates it separately; the user must also replace
  the temporary password before accessing protected sections.
- No live user or organization account was created for verification.

## Rollback and recovery

If the migration fails before commit, PostgreSQL rolls the transaction back.
After a successful commit, do not drop the column or role RPC: accounts may
already depend on the reset gate and audit record. If a release defect is found,
disable the new account-creation endpoint and use the previous application
version; it ignores the additive column and leaves account/role data intact.
Keep the reset gate in place for any account already marked. Re-enable the
endpoint only after the route and RPC are corrected and re-tested.

## Verification boundaries

Automated tests use only `.invalid` identities in the disposable local
PostgreSQL cluster and a local fake Auth transport. They do not send email or
create real accounts. Production email confirmation remains Supabase Auth's
existing behavior. No live account should be created to verify this feature.
