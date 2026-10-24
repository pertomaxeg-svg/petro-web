# Worker branch/service assignments — 0030

Scope: approved repository/branch and Supabase project `msvgzsfzrqlrfpstthhe`; 0009 remains deferred.
Source SHA-256: `d86bbf3e5649af3c0edb6f39d29a49f27648c1b5036e4798b537a15180550274`.
Rollback SHA-256: `36f12a3148b2e1e1296a1269c8f5b6d7dcff1cd5852763f2d32be5708b82c124`.

## Behavior

Central owner/operations explicitly assign an eligible existing member to one branch/service. Auditors can read; ordinary workers cannot self-assign or access the administrative catalog. Eligibility requires a confirmed Auth account, active profile/account with no mandatory temporary-password reset, active membership with an operational role, granted branch scope and approved/active station/provider branch. Company branches cannot execute merchant services. Providers cannot receive fuel or card-issuance assignments. No Auth account, membership, service price, balance or financial event is created by assignment.

An assignment's active flag and its current execution eligibility are shown separately. Membership/profile/branch revocation takes effect on every capability query, including stale sessions. Restoring membership can restore an otherwise-active assignment's eligibility; permanently remove operational authority by stopping the assignment explicitly. The private execution predicate binds its actor to auth.uid(), and is not executable by public client roles.

Tables use RLS with no direct client grants; scoped SECURITY DEFINER RPCs enforce identity and current authorization. Private command receipts compare exact payloads for idempotency, versions reject stale writes, unique constraints prevent duplicate assignment and immutable private audit rows preserve before/after and actor/time. No changes to existing default ACL, membership rules, fleet admin privileges or financial functions.

Web route `/admin/workforce`: named organization/branch pickers, paginated eligible-member search, service selection, actual paginated assignment list and stop/reactivate actions. No UUID input or manual reason field. `GET /api/operations/capabilities` returns only the caller's eligible branch/service assignments, with no company fleet or wallet disclosure. This foundation does not implement PIN verification, service orders, payment or field NFC.

## HTTP contract

- GET /api/admin/workforce: view=assignments|candidates, branchId/userId UUID filters, search up to 160 characters, page 1–100000, pageSize 1–100. Candidates require a branch.
- POST /api/admin/workforce/assignments: userId, branchId, serviceGroup, active boolean, expectedVersion (0 create), idempotencyKey 12–160 chars. Unknown fields rejected. Version/payload conflict 409; role/scope denial 403; invalid input 400.
- GET /api/operations/capabilities: authenticated caller only; returns items containing assignment/version and organization/branch/service identity. Empty items means no currently executable assignment.

## Acceptance / rollback

RED: GitHub run 40064750383, job 120785528183, failed at the absent worker-assignment RPC as expected. Require GREEN SQL role/scope/replay/revocation tests, actual Express/SQL HTTP tests, browser save/reload/provider-fuel denial and responsive checks before application.

The isolated runner must prove rollback refuses non-empty assignment/audit/receipt tables. Only the disposable runner then removes its synthetic fixtures and verifies exact original schema/default ACL restoration. Live rollback refuses to delete records; if assignments exist, stop access and prepare a data-preserving recovery instead.

Preflight: ledger 0029; new objects absent; snapshot default ACL and legacy status RPC/affected grants. Postflight: new objects, RLS/no direct grants, RPC grants exactly authenticated, unchanged legacy/default ACL. No synthetic live users, memberships or assignments.

Status: applied alone on 24 October 2026, ledger `20261024052703`.
Final GREEN: commit `97fb8ce28d089e9d1466436d12d744f8d033fae1`, run 40066038275, acceptance job 120789493239 and real-auth-storage job 120789493056. SQL/API/browser save/reload, role/scope/replay/revocation/temporary-password/provider-service gates passed. Rollback refused persisted synthetic records and restored the exact schema/default ACL after isolated cleanup. Real Auth/PostgREST worker JWT tests and Storage tests passed using the pinned upstream Docker images.
OpenAPI and generated client/Zod contracts are committed; generation run 40066038258 reports no schema contract drift. The API enforces shared generated request validation and strict mutation fields.
Fresh preflight matched live 0029, source SHA and absent new objects. Postflight: RLS on all three new tables; no direct SELECT/INSERT/UPDATE/DELETE for anon/authenticated/service_role; public RPC ACL only postgres/authenticated; no client execution of the private gate; 24 default ACL scopes/hash and legacy status definition/admin fleet ACL unchanged. Live assignment count zero; no production users, memberships or assignments created.
Operational PIN verification, order/payment/inventory integration, physical NFC, full role-by-role visual review and deployment remain open. This rollout activates the schema/API contract; it does not deploy the web/API runtime.
