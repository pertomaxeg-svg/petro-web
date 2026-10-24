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
Status: accepted and live as20261024161411. All196 existing application functions and77 table contracts preserved. All24 pre-existing defaultACL scopes unchanged; Supabase managed issue_pg_cron_access added3 cron-only postgres defaults (total27). Native minutely job actually succeeded live at2026-10-24T16:15:00Z on empty orders. No business test records. See the precise postflight note below. Web/API remains undeployed.
Next: actual execution/evidence/physical issue, final re-entered driver code, payment/capture/merchant receivables/receipt; then refunds/withdrawals/settlements and remaining dashboards/reports/apps. Runtime hosting destination remains unverified; web/API not deployed.

##24 October2026 —0035 reservation/cancellation/native expiry accepted and live
Source commit63e549d77cd8663aefa00ea86bceb194e35471bf passed full run40090483494: acceptance120861959098 and real-auth-storage120861959202. Actual HTTP/browser booking/reload/cancel recovered deliberately lost commit responses without duplicate orders; real JWT transactions enforced one-proof and last-stock concurrency; committed native cron released fuel/product holds once with zero physical stock issue. Generated contracts passed. Source34a537e41a9fab9e26413c6b5bc5ad9beba158e4d1c5e7428e05c4cd641df126; rollbackbbc2e6e0727a8957bb8876d691651325d361fc8e553e474a6d802bcb53dfce94.
Applied alone via approved Supabase connector as20261024161411. Direct postflight: new9 functions/3 RLS tables and public/private grants matched; all196 preceding application function definitions/ACL/owners and77 preceding table ACL/RLS/owners unchanged; legacy status unchanged;0009 deferred. Existing24 defaultACL scopes unchanged. Supabase's pre-existing issue_pg_cron_access event trigger added3 NEW supabase_admin/cron defaults granting onlypostgres; total27. These managed scopes were retained, not misreported as an unchanged total or revoked. Plain disposable PostgreSQL does not model that managed trigger; fresh-host CLI runner strict-ACL check may intentionally stop for review. Do not broaden its ACL exception without a focused test.
Native job1 pertomax_service_order_expiry is active/minutely/postgres; actual live run succeeded at2026-10-24T16:15:00Z with no business records. Orders/commands/events/finance holds/inventory reservations/movements all0. Live business expiry was not artificially induced. Advisor categories unchanged:66 RLS/no-policy INFO (RPC-only tables),119 authenticated-definer WARN (scoped RPCs), existing leaked-password warning1.
Runtime web/API remains NOT deployed. Hosting destination/runtime secret readiness unverified; no production Edge Functions exist. Next: actual order start/evidence/delivery/physical stock issue and final PIN/capture/merchant receivables/receipt, then settlement/refunds and remaining role dashboards/public pages/reports/apps. No completed payment or whole-project acceptance claimed.
