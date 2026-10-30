#0045 pending-refund claim visibility —29October2026

## Accepted source scope

Repository pertomaxeg-svg/petro-web, branch pertomax-central-orgs-20261015 only. Functional source **9d5b6d337f4878a5569c6bf16b1ad61dae446949**.

- [Full independent40909932596](https://github.com/pertomaxeg-svg/petro-web/actions/runs/40909932596): SQL/API/browser acceptance123574824095 SUCCESS; genuine isolated Auth/Storage123574822954 SUCCESS.
- [Frontend40909932719](https://github.com/pertomaxeg-svg/petro-web/actions/runs/40909932719): SUCCESS.
- [API generation40909932661](https://github.com/pertomaxeg-svg/petro-web/actions/runs/40909932661): SUCCESS.
- Regression-first source5569b6f4daf2084a3e9042b0767f786f9a67439a / run40909113480 / acceptance123571928619 failed exactly `MERCHANT_PENDING_REFUND_TOTAL_MISSING`; native prior baseline123571928069 passed. The RED was corrected, not counted as acceptance.
- [Browser artifact12912813975](https://github.com/pertomaxeg-svg/petro-web/actions/runs/40909932596/artifacts/12912813975): actual390px/1280px proof/statement screenshots manually inspected; new pending-refund total and distinct outside-hold card fit both widths, branch total is visible. Existing private proof interaction remains accepted.

## Bug and resulting behavior

An approved8750-piaster withdrawal hold followed by a1000-piaster open refund claim previously returned `disputedMinor=0`, because that field only describes disputed remaining funds outside the withdrawal hold. UI labelled it as the whole pending-refund amount, incorrectly suggesting no open claim.

New `pendingRefundMinor` returns the full undecided/unwithdrawn claim total for each authorized original payment, branch and whole-scope summary. Existing `disputedMinor` still represents `min(max(remaining-held,0),claimed)`; eligibility/holds/paid/debt and their reconciliation are unchanged. Full claims may overlap held or settled money and must not be added as another remaining-money partition.

Shared Arabic UI now displays “إجمالي طلبات الاسترداد المعلّقة” separately from “معلّق خارج حجز السحب”, includes branch/payment detail and explains the overlap. It does not subtract the same claim twice, create a bank transfer, move money or confer new permissions. Existing loading/error/empty/filter/pagination/current-session behavior remains.

## Implementation and validation

-0045 replaces only public.petro_merchant_statement(uuid,uuid,integer), retaining current scoped authorization, SECURITY DEFINER/STABLE/empty search_path and existing grants. No new table/policy/default grant or write endpoint.
- OpenAPI amounts/branch contract documents the total versus partition semantics. Shared UI uses the actual returned value; no fixture-derived total or assumed zero.
- SQL tests:1000claim inside8750hold; claim before7750hold; exact payment/branch/whole-scope totals; page100 retains same totals; actual refund clears claim and retains correct7750hold; subsequent500claim and withdrawal restore zero without money movement; prior scope/revocation/reconciliation tests remain.
- Genuine Supabase Auth/PostgREST job uses actual merchant finance JWT, current approved hold and actual pending refund. Merchant and central Finance branch totals agree; after real refund the claim clears without duplicate subtraction. Existing denied outsider/worker/anon/revoked membership coverage and real Storage regressions remain GREEN.
- Browser uses existing isolated synthetic owner session with disposable API/PostgreSQL. It creates an actual1000refund via HTTP while the8750hold remains, refreshes the visible statement, asserts both summary amounts equal actual API and preserves unpaid withdrawal/proof behavior. This is not a production authenticated dashboard or real external bank transfer test.
- Empty independent rollback restores exact public/private schema and every defaultACL scope using the precise previous0043 statement body; no data is deleted. Statement is read-only and old ledger movement checks still pass.
- Source SQL SHA256 **c6ac74bb1893171c560e89646c3814edb363d6a7f8097a82e35cde0df9ba48de**.
- Exact rollback SHA256 **8ccfc9744226eedea026423bfa85c2659369bd91fa586cf2ac64ec28ffdc0a38**.
- Approved migration runner allowlist/probe synchronized with this source; no CLI/live apply executed.

## Live0045 rollout and postflight

Applied exact accepted SQL to approved Supabase project via migration tool, record **20261029162321**. Contracttrue; live body SHA256 **4e3067aee2a73ac98cb03795a10fa848cf1826f1d02637659ea01c84eecb0118** matches tested source. Statement OID23370, owner16388, ACLpostgres/authenticated, STABLE/SECURITY DEFINER/empty search_path unchanged.

Four protected withdrawal/refund/held/adjustment function bodies/OIDs/ACL/owners unchanged. All policies MD50619c3aba937dfd4fb276b3a393ee1c4 and defaultACL MD512effceb111a268b05bf3dd09dccdc30 unchanged. Existing journals/withdrawals/refund allocations/settlements remain0. No live synthetic users/files/prices/business transactions. Security advisors unchanged93 RPC-only RLS/no-policy INFO,145 exposed authenticated-definer notices, pre-existing password warning1. Schema cache reload notified.

Current project development authorization covers this routine read-only function rollout. The earlier no-live-migration instruction was the bounded Replit Agent's task scope, not a global prohibition on authorized direct project work. No Secrets, publication, paid resources or other project/VPS touched.

## Runtime limits and continuation

**0045 source accepted and live schema applied.** Web/API runtime has not been deployed; no real user browser session or external transfer is claimed. A read-only approved Supabase metadata query29October confirmed organizations/branches/memberships/statement/0044proof functions exist; this does not prove a real browser account has the required role, nor resolve Replit's separate connector403.

Replit's prior Free-only run ended after10minutes, with a saved checkpoint and last message describing Auth/API success and its connector403; no new command was sent to it in this source slice. The full completed Replit execution report/latest protected preview acceptance remains unverified.

The approved broader bank payout milestone now follows as **0046 actual full/partial external bank recording**, after this0045 financial read correctness prerequisite. Existing0044 private proof is not payment. Follow2026-10-28-bank-payouts.md; no automatic merchant debt offset or second company debit. Overall remaining stage map is2026-10-29-remaining-roadmap.md. Branch internal requests, warranty, role dashboards, reports/documents/support/public refinement and worker apps/device acceptance remain open. Do not announce the whole project complete.
