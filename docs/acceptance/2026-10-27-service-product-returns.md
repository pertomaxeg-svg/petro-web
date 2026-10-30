# Service product physical returns — accepted 27 October 2026

Repository pertomaxeg-svg/petro-web, approved branch pertomax-central-orgs-20261015; Supabase msvgzsfzrqlrfpstthhe. Source changes direct GitHub, schema direct Supabase, all writes for tests confined to disposable GitHub Actions fixtures.0009 deferred.

## Acceptance evidence

- Functional source:0862a5a1f8fd7d23cc5f0061835a63161c91c676.
- Full [verification40460054475](https://github.com/pertomaxeg-svg/petro-web/actions/runs/40460054475): acceptance122042229908 + real-auth-storage122042229734 GREEN.
- Frontend40460054440 and API generation40460054436 GREEN. Original RED40367802339 /121730134684 failed for the missing return function before implementation.
- [Mobile form and worker evidence](https://github.com/pertomaxeg-svg/petro-web/actions/runs/40460054475/artifacts/12713604862) manually inspected, including visible intake/inspection fields. Earlier desktop/mobile completed-state evidence12713996426 also inspected.
- SQL: original consumed product linkage, fully refunded product can physically return independently, wrong location/over-return/stale/changed key/worker write denial, quarantine hold rejects generic transfer, exact replay and immutable history, no new money, accepted stock lineage.
- Real isolated Auth/Storage/Supabase SDK: actual paid two-unit product, concurrent receipt commands have one winner, two genuine partial receipts, accepted and damaged dispositions, concurrent exact inspection replay, original worker history read-only, outsider/private-table/revoked-assignment denial, unchanged journal count.
- Actual browser: product booked/delivered/PIN-paid via API; committed receipt/inspection responses deliberately lost then retried with exact commands. One receipt/inspection remains after reload; real paginated history and unchanged paid record, desktop/mobile bounds and worker controls tested.
- Existing plans/fuel/fleet/cards/images/worker payment/refunds, Auth/Storage, cron and rollback regressions remain green.

## Live postflight

Migration20261027062211, name0041_service_product_returns. SQL SHA256d54f1bf03db823a03401f3cd94fe246b5dd90e4c054f6ecceb4f707a68ccd45a; preserving rollback3ad62a224852f1e0b389a1b3772f7cadb4516385536d0948ac824b59936c5af7. Five applied function bodies exactly match the tested source. Existing five inventory/access helpers and nine table security/ACL/owner/OIDs unchanged;27 defaultACL scopes unchanged, MD532546594d4afce8f80a0f0ca99564646 under saved serialization.

Three new private history tables have RLS and no direct client grants; four new public RPCs check current active actor/order/merchant branch permissions. Advisors85 RPC-only no-policy INFO and136 scoped authenticated-definer WARN (expected +3 private tables/+4 RPCs); pre-existing leaked-password warning1 unchanged.

No synthetic production locations, products, stock movements, orders, payments, refunds, transfers or users. New physical returns/inspections/commands0; existing orders/movements/journals0. No original helper definitions or broad/default grants changed.

## Inventory semantics and rollback

An actual return adds on-hand and an equal inspection hold in same-branch quarantine. Only a linked authorized inspection releases exactly its remaining quantity, removing it from quarantine and adding it once to accepted or damaged stock. Existing generic inventory issue-return guards remain unchanged. Original consumed stock, product unit/serial snapshots, actual actors/times, approved inventory documents and append-only movements provide lineage. Refund does not restore stock; physical return/inspection does not move money.

Rollback refuses any physical return/inspection/command history. A complete disposable-cluster pre-monetary snapshot is used only for independent clean rollback; exact schema/defaultACL comparisons pass. The financial history refusal and earlier function-only rollback also remain tested.

## Scope still open

This accepts intake/inspection, not full warranty or all project scope. Warranty terms/claims/replacement, company/merchant dashboards and mandatory merchant eligibility/withdrawal/monthly settlement remain dependent work. No runtime deployment was performed: approved current hosting/configuration/URL remains unidentified. No real NFC/device field test or bank transfer is claimed.
