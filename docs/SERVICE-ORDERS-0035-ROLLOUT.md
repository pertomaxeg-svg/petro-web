# Actual service order reservation —0035

Approved repository pertomaxeg-svg/petro-web, branch pertomax-central-orgs-20261015; Supabase msvgzsfzrqlrfpstthhe only.0009 remains deferred.

## Verified behavior
Actual first-proof consumption, current quote recheck, policy/funding hold and product stock reservation commit atomically. Caller-bound exact retry returns the persisted order after proof consumption. Versioned cancellation releases only unstarted holds. The private native pg_cron job expires unstarted15-minute reservations in bounded100-row batches with SKIP LOCKED, bounded retry/backoff and review_required after5 failures. Explicit system attribution from0034 preserves honest history, exact financial release and zero physical stock issue on expiry.

Public/private order tables use RLS with no direct client DML. Public RPCs require current active confirmed account/password gate and worker scope or central read/cancel role. Private helpers/expiry are postgres-only SECURITY INVOKER. No service-role claim or scheduler Auth principal is manufactured. Worker and central order screens expose real reserve/read/cancel/history. Reserved means held; no payment, stock delivery, invoice or merchant settlement is claimed.

## Acceptance
Full GREEN:63e549d77cd8663aefa00ea86bceb194e35471bf / GitHub Actions40090483494.
- Acceptance job120861959098: types/build/unit/SQL/API/browser, responsive layouts, reload, exact retries after lost booking/cancellation responses and preserving schema/defaultACL rollback.
- Real Auth/Storage job120861959202: actual confirmed JWT scope/revocation, private vehicle/odometer upload/download, committed native fuel/product expiry and concurrent one-proof/last-stock winners.
- Source SHA-256:34a537e41a9fab9e26413c6b5bc5ad9beba158e4d1c5e7428e05c4cd641df126.
- Rollback SHA-256:bbc2e6e0727a8957bb8876d691651325d361fc8e553e474a6d802bcb53dfce94.
- Approved runner allowlist matches source. SQL source begins BEGIN; and ends COMMIT;. Absence-safe live contract probe returnedfalse before activation.
- Direct preflight:196 existing function definitions/ACL/owners,77 tables/ACL/RLS/owners and24 defaultACL scopes captured.0034 remains latest live migration before application; orders absent; no finance/stock reservations. pg_cron1.6.4 available/preloaded, not installed.

## Rollback
Reviewed source lib/db/rollback/0035_service_order_reservation.sql refuses any retained order/command/event history; checks scheduler job owner and exact command before unscheduling only pertomax_service_order_expiry. Drops only new application objects. Retains pg_cron dependency and never removes unrelated jobs. Do not delete business or immutable stock/finance history to force a downgrade. Rollback/schema/ACL preservation and history refusal were tested only in disposable environments.

## Activation and remaining scope
Status: accepted; live activation/postflight pending. Apply only the exact0035 source, then compare all captured pre-existing definitions/grants/defaultACL and new contract/scheduler metadata. Verify real live scheduler execution without creating production business test records. Do not confuse schema activation with web/API deployment.
Next: actual execution/evidence/physical issue, final re-entered driver code, payment/capture/merchant receivables/receipt; then refunds/withdrawals/settlements and remaining dashboards/reports/apps. Runtime hosting destination remains unverified; web/API not deployed.
