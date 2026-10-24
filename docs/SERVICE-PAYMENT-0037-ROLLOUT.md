#0037 final confirmation and actual financial capture

Scope: approved repo/branch/project only.0036 accepted/live20261024171306;0009 deferred.
RED gate e89a492 /40115665824 acceptance120936299353 failed for missing final confirmation/payment; actual Auth/Storage0036 regression passed120936299437.

New actual payment transaction verifies the current SAME driver/vehicle HMAC without storing the PIN, using the shared vehicle five/15-minute rate limiter. Wrong/locked attempts commit negative actor/order/key receipts; changed payload conflicts and retries do not spend attempts again. Positive payment requires immutable documented delivery, current identity/scope and genuine held funds, locks the relevant rows, captures only the actual amount and releases the unused authorization. Legacy wrappers/grants are unchanged; no manufactured service-role claims.

Existing finance_post_entry and finance_consume_reservation enforce balanced journal and exact amount. Own hold is narrowed to actual amount only inside the locked complete payment transaction. Order/event/payment receipt preserve original booked authorization and released difference. Funding and merchant control clearing balance once; separate immutable branch-scoped merchant receivable allocates that single clearing credit. No physical stock issue or restock in payment.

Immutable service receipt freezes party/vehicle/price/quantity/actual/booked/released amount and journal/actor/time; taxTreatment not_configured means no fabricated VAT rate or tax invoice. A service receipt is produced, not an invented legal tax invoice. Versioned default monthly Cairo settlement policy preserves period/eligibility snapshots for future payout workflow. Business posting time follows the existing immutable journal transaction timestamp; brute-force expiry uses real wall clock.

Require actual SQL/API/browser/real JWT final-code, lock/replay/concurrency/revocation/insufficient-funds, one capture/receipt/receivable/outbox and zero repeated stock delta. Preserving rollback refuses any payment or negative confirmation history; never delete actual ledger history. Source/rollback hashes to be pinned after SQL acceptance. NOT applied live; API/UI pending.
