# Merchant withdrawal intake and review — 28 October 2026

Accepted functional source bb5cb7855be0b30112a9c917f4178d800490c838, approved branch pertomax-central-orgs-20261015. Engineering0040 remains open; this is genuine intake/holds/review, not an actual bank payout.

## Behavior
- Four authenticated scoped RPCs: petro_merchant_withdrawals(uuid,integer), petro_merchant_withdrawal_options(uuid,integer), petro_submit_merchant_withdrawal(uuid,uuid,uuid[],text), petro_review_merchant_withdrawal(uuid,bigint,text,text).
- Five private immutable RLS/no-client-grant tables: merchant_withdrawals, merchant_withdrawal_allocations, merchant_withdrawal_events, merchant_withdrawal_releases, merchant_withdrawal_commands. Five private invoker helpers, one refund-allocation trigger; no old monetary/bank function rewritten.
- Organization-level merchant owner/manager/finance submits or cancels. Platform owner/Finance approves or rejects. Auditor reads masked data. Branch-limited manager/finance, worker, company finance and outsider cannot create competing central requests. Branch internal request-to-organization workflow remains a later required slice.
- Selected original payment rows lock in UUID order before request row. Each selected payment reserves its entire current eligible remainder, after actual refunds/settlements/open claims/other holds; no client-supplied amount. Different overlapping commands permit one winner. Actor/key fingerprint receipts replay exactly.
- Approved active beneficiary bank version frozen privately (including identifier/revision); only masked last4/beneficiary/name returned. Current account locks precede its already-approved version so0006 approval can supersede old versions without inversion. Changed bank revision/approval blocks request approval; never silently redirects payment.
- Original0039 actual refund atomically releases only excess held amount, appends immutable adjustment/version/outbox and invalidates approval if reduced. A claim already excluded before request creation is not subtracted again when refunded. Refund mutation code/ledger remains unchanged.
- Approval with an open refund claim is refused. Cancel/reject releases only remaining held allocation and preserves all history. Request/review never writes a bank journal or marks paid.
-0042 statement now includes withdrawalReservedMinor; remaining partitions into holds, pending-refund restriction outside holds, immature and eligible remainder. No automatic merchant-debt offset. withdrawalsEnabled=true means intake; bankPayoutEnabled=false.
- Session/no-store strict API: GET/POST /api/finance/merchant-withdrawals/:organizationId, GET .../:organizationId/options, POST .../:id/review. Unknown/extra fields and non-string review actions rejected400, domain PT409 maps409. No actor/account amount injection.
- Real shared Arabic UI inside merchant statement after selecting organization: bank selection, genuine eligible receipt selection/pages, bounded100 selection, held request/history and approve/reject/cancel. No mandatory documented-reason field, paid button or fabricated proof. Uncertain commit freezes scope/actions and retries exact command.

## Evidence
RED0da68b132dfe6cb82aa593ec32c21fee0bbc17bb / run40750062051 job123034080877 failed exactly MERCHANT_WITHDRAWAL_INTAKE_MISSING.
Final full run40754149378 GREEN: acceptance123048424422 and real-auth-storage123048423899. Frontend40754149379 and contracts40754149349 GREEN.
- SQL: genuine balanced historical fixture original8750; one hold, exact replay/overlap denial, refund1000 reduces approved8750 to pending7750, stale rejection, cancellation items held0, new request7750, changed-bank refusal/rejection. Second fixture excludes pending1000 before holding7750; actual refund leaves hold7750/version1 (no double reduction), unresolved claim blocks approval. Only original historical imports and actual refunds add journals, holds never do.
- Historical fixture is explicit disposable INSERT-only import using a genuine balanced journal and coherent copied original funding/payment references. No immutable UPDATE/DELETE, trigger disabling or production clock override. It is not claimed to be a genuine SDK transaction in the historical past.
- Actual SDK/JWT: genuine current-month paid product fails early submission; real merchant organization Finance role submits. Concurrent overlapping requests yield one8750 hold, exact replay, worker/anonymous/outsider denial, merchant cannot approve own request, platform approval without bank debit, actual1000 refund resets version/status/hold, merchant cancels7750, revoked membership immediately denied. Existing Auth/Storage/cron/PIN/payment/refund/inventory/return regressions pass.
- Actual browser uses existing isolated synthetic owner session to real disposable API/PostgreSQL, not native browser Auth. Middleware drops committed HTTP201 specifically, waits for rendered error/enabled retry (not transient in-flight controls), asserts fault consumed, and exact retry yields one request. Approval remains unpaid, cancellation persists after reload and selected scope. Extra-action object with malformed toString rejects400.
- Final screenshots artifact12845522672: actual visible receipt/bank selection390, approved/history390 and1280. Downloaded internal QA images manually reviewed; controls fit and bank identifier remains masked.
- Exact independent clean schema/defaultACL rollback and history refusal passed. Rollback refuses even cancelled withdrawal history.
- Orval combined path/query schemas use scoped param=false for the two new list operations (router still validates UUIDs). Named request component schemas avoid Body export collisions without disabling body validation.

## Live
Applied exact0043 alone as 20261028193127; name0043_merchant_withdrawal_intake.
Source SHA256 f4b26c431a74ea14d5365c0c22390d186345e7ebd111a9d7c41584ccd94f0c7e; rollback 182da642851463899886a2bc8344c5c7df2f1131294d01f45c12ffe1b87a45c3.
All10 live function bodies (9 new + intentionally updated statement) match accepted source; contract true.
Four old refund/settlement/bank function definitions/OIDs/owners/ACL and five original table OIDs/owners/ACL/RLS unchanged. DefaultACL MD5 12effceb111a268b05bf3dd09dccdc30 unchanged.
Old orders/payments/refunds/settlements/journals0 before/after. New requests/allocations/events/releases/commands0; no live synthetic records, bank version, price, money or stock writes.
Advisors exact expected addition:85→90 deliberate private RPC-only no-policy INFO;137→141 scoped authenticated-definer findings; pre-existing password warning1 unchanged. PostgREST schema reload notified.

## Remaining
No bank proof upload/verification, actual bank disbursement journal, payout allocation, partial paid/release policy, or branch internal request flow yet. No automatic debt netting. Read-only dispute partition excludes amounts already held; next payout UI should expose total pending claims separately so the partition is not confused with total open claim value.
Follow docs/superpowers/plans/2026-10-28-bank-payouts.md. Then warranties/role dashboards/reconciled reports/documents/support/outbox/public refinements, apps/devices last. Runtime NOT deployed: current approved hosting URL/configuration remains unidentified; source/schema acceptance is not a released website.
