# Merchant statement acceptance — 27 October 2026

## Accepted scope
Engineering0040 read foundation; migration0042. Functional source 806623a19142598bb9ee065607cc55d5f8304f21 on pertomax-central-orgs-20261015. Project remains incomplete; this is not a withdrawal or bank payout.

- One STABLE, scoped authenticated SECURITY DEFINER RPC with empty search_path, no direct private-table grant or data mutation.
- Central owner/finance/auditor and current active merchant owner/manager/finance membership; branch scopes enforced by database. Company finance, worker and Operations alone denied. Revocation takes effect with existing JWT. Earned financial history is not gated by subscription/merchant new-service eligibility.
- Aggregates each original receivable once. Remaining=earned-unsettled refund-actual settlement. Full refund=unsettled reduction+paid-out merchant debt. Remaining=not-yet-eligible+pending-refund dispute+eligible-before-debt. Original immutable Cairo period and eligible_at used; no new clock/eligibility override or automatic debt offset.
- Whole-filter totals and permitted branch breakdown independent of fixed20 payment pagination. Original receipt/payment/order references; private funding/bank identifiers omitted.
- Strict session/no-store GET /api/finance/merchant-statement: organizationId,branchId,page only; invalid/repeated/unknown filters rejected. OpenAPI contract generation passed.
- Shared Arabic responsive actual source UI: /admin/merchant-statement and /workspace/merchant-statement; Finance navigation/breadcrumb/return links and merchant workspace entry. Genuine paid order details, optional disclosure, branch/org filters, refresh, loading/error/empty states. No fake withdrawal/payment button; withdrawalsEnabled=false.

## Verification
- RED57049778c2a56786c30407c1bf4ee787362ce4cb, Actions40521107192/acceptance122248124521 failed exactly MERCHANT_STATEMENT_MISSING.
- Actual SQL fixture first proves partial refund + open refund claim excludes disputed eligibility. Existing actual8750 full refund and10000 settlement/refund history prove9000 paid-out debt, no double subtraction, zero remainder and reconciliation.
- Unauthorized branch including newly created empty branch denied; permitted empty scope returns real zeros. Page100 returns no items but identical whole-scope totals. Read leaves journal count unchanged. Entire synthetic fixture is disposable/rolled back.
- Acceptance Actions40523137663, job122256148056 SUCCESS: type/build/SQL/HTTP/browser, prior finance/fleet/inventory/PIN/cron/physical-return regressions and exact independent schema/defaultACL rollback.
- Real Auth/Storage same run job122256148165 SUCCESS: actual original product paid via genuine worker/PIN. Current month's amount not prematurely eligible; owner and branch-scoped merchant Finance SDK read identical permitted totals. Anonymous/worker/outsider/wrong-company denial, immediate membership revocation without JWT refresh and exact monetary identities passed. No production Auth bypass/test data.
- Actual browser transport to disposable PostgreSQL uses existing synthetic owner session (not claimed native browser authentication). UI totals match API; detail/org filter/reload, correct selected Finance navigation/breadcrumb, no-store, worker denial,390/1280 bounds. Native merchant role is verified separately using real SDK JWT.
- Final artifact12742677098 from40523137663 downloaded for internal QA. Both screenshots manually reviewed: Arabic cards/details fit phone/desktop, title/nav now correct. Internal images are not source assets.
- Frontend40523137414 SUCCESS; API contracts40523137506 SUCCESS.
- Initial native harness had a duplicate membership const; fixed before accepted run; module syntax separately checked. Never counted that failed run as native acceptance.
- Requested Frontend Design/UI UX Pro Max/Canvas Design/Writing Plans/TDD named packages are absent from both current skill catalogues (all pages checked). Used saved plan, meaningful regression-first SQL, actual browser/native tests and manual visual review; no claim those missing skills were installed or applied. Supabase skill/docs used.

## Live rollout
- Applied exact reviewed0042 alone as 20261027144429, name0042_merchant_statement.
- Source SHA256 6692900a04779ad02c714238b9811186d930c5dd8b5e1e9960ea05784a982e48.
- Rollback SHA256 9aa4451f25d87608da0f7536898d75b893ed4114944242075d673c7260c59755.
- Live RPC body SHA256 cd3c05cee380f44b7abd83a943b03d00e039e4839bfd7557a9fd5e14a3ca51be matches source; contract true, stable, ownerpostgres, onlypostgres/authenticated execute.
- Four existing helper/refund/settlement definitions/OIDs/owners/ACL and four original private table OIDs/owners/ACL/RLS unchanged. Current serialization defaultACL MD5 12effceb111a268b05bf3dd09dccdc30 unchanged.
- Original live payments/refund allocations/actual settlements/journals remain0. No accounts, synthetic transfers, stock or business rows created.
- Security advisors exact expected change:85 deliberate private RPC-only no-policy INFO unchanged, authenticated scoped definer findings136→137 (new read RPC), pre-existing leaked-password warning1 unchanged.
- Rollback drops only added read RPC; it neither erases nor rewrites financial history.

## Remaining
No public withdrawal/approval/private bank proof/actual bank payout or real withdrawal holds implemented here. Next saved plan docs/superpowers/plans/2026-10-27-merchant-withdrawals.md, including refund-versus-held allocation lock order and monthly/bank/proof tests. Company/merchant role dashboards, warranties and later approved phases remain. Runtime NOT deployed: current approved hosting URL/configuration remains unidentified. Never equate GitHub/schema acceptance with a released user-facing website.
