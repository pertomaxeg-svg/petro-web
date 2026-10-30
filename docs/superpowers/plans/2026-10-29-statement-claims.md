#0045 merchant pending-refund visibility —29October2026

Dependency from accepted0044 and bank payout plan. Before payout, financial readers must distinguish total open refund claims from the portion excluded from unheld availability. Current0043 internally knows claimed but exposes only disputed=min(max(remaining-held,0),claimed); an8750 hold with a1000 open claim shows disputed0. A zero outside-hold partition must not mean no dispute.

Scope: additive read fields `pendingRefundMinor` in each scoped payment, branch and whole-scope totals; sum original undecided/unwithdrawn claim amounts, including claims overlapping holds or actual settled money. Rename existing disputed label accurately, display both, explain overlap and retain exact remaining=held+outside-hold-disputed+immature+eligible partition. No amount/journal/hold/approval/permission changes. Branch/tenant/user scope, page-independent totals, empty zero and authorization remain existing contracts.

Steps:
1. Regression-first SQL assertion: real approved8750 hold plus newly opened1000 refund must expose pending1000/outside-hold0/held8750; before-hold claim shows outside1000, exact totals/branches/page and after resolution/withdrawal transitions. RED with old function.
2.0045 replaces only current statement function body, preserving OID/ACL/owner/security; old exact body as rollback. No tables, policies, defaultACL, business rows or new role grants. Restrict no API writes.
3. Shared Arabic UI/API schema/types display total claims separately at summary/branch/payment detail, mobile no overflow. Update actual browser/native SDK assertions including real1000 claim within approved hold, API equality and scoped readers.
4. Actions SQL/API/browser/nativeAuth/build/contracts, exact empty schema/defaultACL rollback, read-no-money regression. Manual390/1280 screenshots.
5. Save actual evidence/checkpoint. The bounded Replit Agent task permits no new live migration/Secret/publication. Direct routine tested project rollout remains authorized; source/schema acceptance must not be called runtime release.

The actual full/partial external bank payout slice follows as0046 after this read correctness prerequisite, using existing0044 proof. Remaining engineering stages stay open; no repeated broad discovery or completed-flow rebuild.

## Source acceptance

- [x] Expected RED40909113480:MERCHANT_PENDING_REFUND_TOTAL_MISSING.
- [x] Implementation and SQL/API/browser/nativeAuth/build/contracts GREEN at9d5b6d337f4878a5569c6bf16b1ad61dae446949 /40909932596.
- [x] Manual390/1280 artifact12912813975 inspection and exact independent schema/defaultACL rollback.
- [x] Evidence/current continuation/full remaining roadmap saved.
- [x] Exact live0045 apply20261029162321, body/contract/security/old-function/defaultACL/policy/count/advisor postflight passed; no live synthetic business writes.
- [ ] Runtime deployment/current real user browser acceptance remains open; publication is prohibited by current user request.

Actual external bank payout follows as0046. Evidence docs/acceptance/2026-10-29-merchant-pending-refund-totals.md.
