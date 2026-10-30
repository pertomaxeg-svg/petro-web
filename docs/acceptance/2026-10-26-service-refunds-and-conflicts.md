# Service refunds and terminal operational conflicts — 26 October 2026

Source: pertomaxeg-svg/petro-web, branch pertomax-central-orgs-20261015. Database:msvgzsfzrqlrfpstthhe. No Replit agent, local checkout/build, other project/VPS, paid infrastructure or force push.0009 remains deferred.

## Accepted and live

-0039 actual partial/full monetary refund or rejection is live20261026163457. SQL SHA2566fec6d18b95615547daa6aa045570b79c1155ce174f8abf9b54dabb5c4a2d3f4; preserving rollback97588a33fe3b5cbc61dc5c4b46227f7119c4446e38aaa4d1ae3c3e02735b288a.
-0040 permanent operational version conflicts is live20261026171207. SQL SHA25632b54342ff85a3a966656bdb42814fcca6354abb198d51fcb9d51bbd251baa42; function-only rollback863d1cad8e19bd3d9a51fde1c615b6f2772ecf96adf53cb3440342785fa6e718.
- Full final functional source:a77736cfc2c630d8b008a79a7c734dfaa9399942. Actions40365712042: acceptance121722710647 and real-auth-storage121722709880 GREEN; frontend40365712015 and API generation40365711900 GREEN.
- Real Auth test first proved old stale-cancel behavior timed out as504 after about60seconds (correct RED1c004d9398fdacec986c59301928cad1043f89e5 /40364316987). Final test requires exactPT409/409 promptly for cancellation/start/delivery/payment. Consumed/invalid proof retains exact403/42501 authorization denial. Genuine database serialization errors are not relabelled.
- Central Finance monetary UI proves partial approval, exact retry after a committed response loss, one journal/credit document, reload and actual one-page A4 print. Original worker reads real refund history/credit after reload without request/withdraw/decision controls; payment-state cache remount prevents stale unpaid data. Worker viewport bounds and390px capture verified. Manual central mobile/credit/PDF and worker artifact12669036662 inspected successfully.

## Accounting and permissions

Refund credits exact original company/branch funding, debits remaining merchant clearing or separate previously-paid-out merchant debt, retains immutable original payment/receipt and writes a balanced linked refund journal/allocation/SC credit/outbox once. Rejection posts no money. Refund never adds physical stock. Settlement allocation contract is internal; no public bank-payout endpoint or fabricated settlement was built.

Live0039 six function bodies match tested SQL. Live0040 all five complete function definitions match; OIDs/signatures/owners/ACLs/SECURITY modes/configuration unchanged.27 defaultACL scopes unchanged, MD532546594d4afce8f80a0f0ca99564646 under saved serialization. Advisors82 deliberate private RPC-only/no-policy INFO,132 scoped authenticated-definer WARN, pre-existing leaked-password warning1 unchanged. Four new private tables have RLS/no client DML, the new decision RPC enforces current active Finance/owner scope.

## Production data and rollback

No synthetic live orders, proofs, stock movements, payments, refunds, credit documents, settlements or journal rows were created. All remain0. Accounts3→4 solely from the zero-balance system merchant-refund-debt configuration seed; no debt account journal lines.0040 writes no business rows.

0039 refuses removal of any financial decision/allocation/credit/settlement history. Independent clean rollback uses a complete disposable-cluster physical snapshot and exact schema/defaultACL comparison; no normalizing away business definitions/grants.0040 rollback restores exactly the five prior definitions and refuses unreviewed function drift; it does not change financial/stock history.

## Outstanding

This is source/schema acceptance, not a web/API deployment. Approved current runtime URL/hosting/configuration remains unidentified. Company/merchant dashboard integration, physical service-product intake/inspection and warranty, withdrawals/monthly settlement, remaining role dashboards/reports/support/public refinements and final apps/device acceptance remain dependent work. Do not call the full project or engineering0038/0039 complete.
