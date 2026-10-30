# Service product physical returns — migration 0041

## Dependencies and scope

Approved post-payment engineering task0039; migration IDs are separate.0036 actual consumed stock/delivery,0037 actual payment and0039 monetary refunds are live.0040 operational terminal conflicts is accepted and live20261026171207. Start from existing0021 inventory/quarantine/damage contracts. Generic inventory return correctly accepts manual issue movements only; service delivery records consume movements. Do not weaken generic guards or add stock because money was refunded.

## Slice1: real intake and inspection

- Central owner/Operations and current merchant inventory approvers (existing inventory_can_write with approval=true) receive/inspect only authorized original merchant branches. Finance/company/ordinary worker cannot move physical stock. Original current worker, company scoped managers/finance, merchant managers/finance and central scoped readers see actual history under existing service-order/refund read scope.
- Private immutable returns, inspections and actor/key command tables with RLS and no direct client grants. New scoped authenticated RPCs with empty search paths; no caller-controlled identity/system GUC or broad grants.
- Receive only a paid delivered product's remaining actual consumed quantity. Lock original order and its genuine reservation/consume movement. Check original frozen unit scale; retired catalog status must not invent a new sale or forbid safe original-item custody. Add once into an active same-branch quarantine location. Approved inventory document/line/movement retains original consume linkage, actual actor/time and original product/serial snapshots. No automatic sellable stock.
- Inspect received remaining quantity once: transfer exactly accepted units from quarantine to same-branch sellable or damaged location. Preserve original return lineage and immutable disposition. Never duplicate a quarantined unit in two locations; no financial entry or company charge.
- Actor/key fingerprint replay after lost response, expected-version terminalPT409, changed payload conflict, remaining-quantity/scale bounds and atomic rollback. Physical history prevents destructive migration rollback; independent empty fixture restores exact schema/defaultACL.
- Read paginated actual receipt/inspection history and complete aggregate quantities: delivered, returned, returnable, quarantined awaiting inspection, accepted and damaged. Actual role capabilities and scoped locations supplied by database; no fabricated queue entries.
- Shared real UI on product-order details: summaries, quarantine intake, inspection controls for authorized actors, read-only worker history, optional notes, loading/empty/error/retry, genuine pagination, reload and mobile. No mandatory documented-reason field. Existing inventory location management remains the source of quarantine/sellable/damaged locations.

## Verification

SQL RED first against the existing fully refunded paid product: no automatic stock restoration yet. Genuine positive receipt/inspection, over-return, unit scale, wrong target, exact replay, changed key, stale version, worker read-only, balanced stock lineage, no money and immutable history. API strict payload/scope and lost-response retry. Native real JWT product booking/start/delivery/actual PIN payment/private evidence if required, physical return/damage disposition, concurrency, direct-table and revoked-worker denials. Browser real saved product receipt, inspection/reload/mobile; preserving rollback and exact source pins/defaultACL.

## Later dependent slices

Warranty terms/claims/replacement and company/merchant dashboard integration remain separate approved dependent work. Do not fabricate old warranty coverage or mark all engineering0039 complete after intake/inspection alone. Withdrawal/monthly settlement and remaining role dashboards follow the approved post-payment plan. No runtime release is implied; approved hosting/current URL/configuration remains unidentified.

## Accepted intake/inspection slice — 27 October 2026

- LIVE 20261027062211; source SHA256d54f1bf03db823a03401f3cd94fe246b5dd90e4c054f6ecceb4f707a68ccd45a, preserving rollback3ad62a224852f1e0b389a1b3772f7cadb4516385536d0948ac824b59936c5af7.
- Functional source0862a5a1f8fd7d23cc5f0061835a63161c91c676 / Actions40460054475: acceptance122042229908 and real-auth-storage122042229734 GREEN; frontend40460054440/API generation40460054436 GREEN.
- Mobile fields and actual intake/inspection forms, worker read-only state and desktop post-inspection views manually inspected (artifacts12713604862 and12713996426).
- Actual partial receipt race, two dispositions, held quarantine/non-bypass, exact replay, uncertain committed HTTP-response retry, reload/history, no money, worker/outsider/revocation denial and preserving exact rollback all passed.
- Quarantine adds on-hand AND inspection holds; linked inspection removes its exact held quantity before adding accepted/damaged stock. Existing generic inventory guards were preserved.
- Five applied function bodies exact; five old helper definitions/grants/owners and nine existing table ACL/RLS/owners/OIDs unchanged;27 defaultACL scopes unchanged. New private history rows0 and existing orders/movements/journals0. No synthetic production stock/location/product/user/payment records.
- This closes intake/inspection only. Warranty terms/claims/replacement and company/merchant dashboard integration remain pending; engineering0039 is not wholly complete. No runtime deployment claimed.
