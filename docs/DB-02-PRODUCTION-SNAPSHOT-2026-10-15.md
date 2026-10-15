# DB-02 live pre-apply snapshot

**Target:** Supabase project `msvgzsfzrqlrfpstthhe`
**Captured:** 2026-10-15, before applying `0004_db02_invitation_permissions.sql`
**Scope:** definitions and ACL metadata only; no table rows, user identifiers, emails, tokens, or credentials were queried or saved.

## Connection and baseline checks

- The configured `SUPABASE_DB_URL` identified the approved project. PostgreSQL 17.0.11 connection succeeded with `verify-full` TLS using the approved Supabase root CA.
- Application-schema counts matched the tested baseline: 11 tables, 57 constraints, 22 indexes, 23 functions, 12 RLS policies, and 11 RLS-enabled tables.
- The migration ledger contained only `20261013111142 / petro_foundation` and `20261013111150 / petro_plan_versions`; no DB-02 entry existed. The ledger was not modified.
- Exactly one platform-owner role was active, and its linked profile was active. The owner bootstrap Secrets were absent in the API environment; `/api/auth/bootstrap-status` returned `{"available":false}`.
- `pg_default_acl`: 24 rows; SHA-256 `c67dda3b72383eb566fb6ed9683684d29955671fd16b84d1efb31ea6aeb489c6`. This records the all-schema default-ACL state to compare after the migration.

## Invitation table definition and access

`public.petro_membership_invites` was owned by `postgres`; RLS was enabled, `FORCE ROW LEVEL SECURITY` was off, and it had no policies.

| Column | Type | Nullability | Default |
|---|---|---|---|
| `id` | `uuid` | not null | `gen_random_uuid()` |
| `organization_id` | `uuid` | not null | — |
| `invited_email` | `text` | not null | — |
| `role` | `text` | not null | — |
| `scope` | `text` | not null | — |
| `branch_ids` | `uuid[]` | not null | `'{}'::uuid[]` |
| `token_hash` | `text` | not null | — |
| `created_by` | `uuid` | not null | — |
| `created_at` | `timestamptz` | not null | `now()` |
| `expires_at` | `timestamptz` | not null | — |
| `accepted_by` | `uuid` | nullable | — |
| `accepted_at` | `timestamptz` | nullable | — |
| `revoked_at` | `timestamptz` | nullable | — |

Constraints: primary key on `id`; unique `token_hash`; foreign keys from `accepted_by` and `created_by` to `auth.users(id)` and from `organization_id` to `petro_organizations(id)` with cascade delete; checks for normalized email, allowed organization roles, allowed scope, and 64-character lowercase hexadecimal token hash. Indexes: the primary-key index and unique token-hash index.

Before DB-02, direct table ACLs granted all table privileges to `anon`, `authenticated`, `service_role`, and owner `postgres`. No direct ACL entry existed for `PUBLIC`.

Canonical fingerprint of the table definition, indexes, constraints, RLS state, policies, owner, and ACL: `d630b46b551b322ad4ce47ba6989051b`.

## Function definitions and ACLs

Each source fingerprint below is MD5 of `prosrc` after removing whitespace. The fingerprints and function security configuration matched the reviewed `lib/db/rebuild/current-schema.sql` baseline.

| Function | Source fingerprint | Security / search path | Pre-apply `EXECUTE` |
|---|---|---|---|
| `petro_accept_invitation(text)` | `6803167dc48366f8a3aa38d730eb0117` | `SECURITY DEFINER`, empty | `authenticated`, `service_role`, `postgres` |
| `petro_create_invitation(uuid,text,text,text,uuid[],text)` | `81c98b0c5c9958edd5ed574e69bf9c9c` | `SECURITY DEFINER`, empty | `authenticated`, `service_role`, `postgres` |
| `petro_set_membership(uuid,uuid,text,text,uuid[],boolean)` | `b44f5b0b2669b64e163f5d809e33850b` | `SECURITY DEFINER`, empty | `authenticated`, `service_role`, `postgres` |
| `petro_private.can_manage_branch(uuid,uuid)` | `a1201fdf7a384c55f6bcf93e4e05462d` | `SECURITY DEFINER`, empty | `PUBLIC`, `authenticated`, `postgres` |
| `petro_private.can_view_profile(uuid)` | `90a390e235ba31013e63d5dc469b8c66` | `SECURITY DEFINER`, empty | `PUBLIC`, `authenticated`, `postgres` |
| `petro_private.can_view_membership(uuid)` | `23b0f0c8c74cc1c5e215bddf5082a321` | `SECURITY DEFINER`, empty | `PUBLIC`, `authenticated`, `postgres` |

## Restoration reference

The exact pre-apply bodies of the three RPCs are in `lib/db/rebuild/current-schema.sql`; their fingerprints above matched the live definitions before application. If a later, separately authorized rollback is needed, restore only those three RPC definitions from that baseline, restore the captured table grants to `anon`, `authenticated`, and `service_role`, and restore `PUBLIC EXECUTE` on the three helper functions. Do not replay the whole baseline, change RLS, alter any default ACL, or touch other schemas. The migration itself is transactional, so any error before commit must roll back the complete change.

## Post-apply verification

The approved migration from commit `99ae4a4a079214d07226b6021c66538a671fb227` committed successfully in one transaction on 2026-10-15. Its postconditions were checked before `COMMIT` and independently read again afterward.

- The invitation table remains owned by `postgres`, RLS enabled, not forced, and with no policy. Its ACL is now `postgres` and `service_role`; `anon` and `authenticated` have no direct table privileges for `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, or `TRIGGER`.
- The three helper functions retain `EXECUTE` for `authenticated` and `postgres`; `PUBLIC` and anonymous execution are absent. The three RPCs retain `EXECUTE` for `authenticated`, `service_role`, and `postgres`. All six remain `SECURITY DEFINER` with an empty `search_path`.
- Post-apply RPC fingerprints (same whitespace-stripped method): `petro_set_membership` `194fdfaefb42e0190cabcf1ec7c018f7`; `petro_create_invitation` `aaac469f056271aae583f7c4fbf18620`; `petro_accept_invitation` `32b9f605068e3496dad9b7b1d7f18569`. Helper fingerprints remained identical to the pre-apply values.
- All-schema `pg_default_acl` remained at 24 rows with the same SHA-256 fingerprint above. The application-schema counts stayed at 11 tables, 57 constraints, 22 indexes, 23 functions, 12 policies, and 11 RLS-enabled tables.
- The single active platform-owner role and linked active profile remain active. Owner bootstrap Secrets are absent and `/api/auth/bootstrap-status` returns `available:false`. The migration ledger still contains only its two pre-existing entries; no historical or new ledger row was written.
- `/api/healthz` returned HTTP 200. The public web preview rendered successfully. No login, invitation, or email flow was tested with a real Auth session; no test account or invitation was created.
