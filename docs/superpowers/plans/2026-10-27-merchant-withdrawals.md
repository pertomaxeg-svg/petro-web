# Merchant withdrawal and actual bank payout — continuation after0042

Approved engineering0040; do not restart repository discovery. Financial statement is a read foundation, not paid withdrawal acceptance. Only approved repository/branch/Supabase.0009 deferred; no live synthetic financial data or actual automatic bank transfer.

## Existing exact interfaces
-0037 private immutable service_order_receivables: payment/order, merchant organization/branch, original clearing control account, earned amount, Cairo period and frozen eligible_at/policy.
-0039 private service_refund_allocations: original payment, actual amount, unsettled reduction and paid-out merchant debt; service_receivable_settlements: only actual posted balanced merchant settlement allocations. Private validate_service_receivable_settlement already checks current platform Finance/owner, original payable and bank-credit journal, pending claims and remaining capacity. Do not expose an unchecked table insertion endpoint.
-0006 public petro_bank_accounts/version records: active account + current reviewed approved version; full identifier stays protected. Freeze approved version and beneficiary in private request snapshot. Return masked last4 only.
-0012 finance_post_entry UUID/type/source/org/reference/reason/lines validates exact balanced EGP and writes journal/audit/outbox. Merchant payments use MERCHANT-SETTLEMENT reference and actual debit original payable/credit approved platform bank account. Statement alone never calls it.
-0012 petro_finance_bank_accounts is the platform bank registry, distinct from0006 beneficiary bank versions.
-0042 statement: read scope uses current active merchant organization_owner/manager/finance membership, including branch limitations; central owner/finance/auditor. No expiry confiscation or automatic debt offset.

## Required build sequence and acceptance
1. Save narrow data model/API/role contract before code. Central organization request belongs to merchant organization-level manager/owner/finance. Branch manager internal request goes to that organization manager; it must not compete as independent platform withdrawal. Separate financial read and bank-write powers.
2. Add versioned request projection with immutable request/decision/allocation/adjustment/command history. Freeze exact reviewed current beneficiary version on submission. Reserve only selected eligible unpaid original receivables. No arbitrary amount unless explicit partial-withdrawal policy exists; do not invent that policy. Actual partial bank disbursement remains separately supported per approved reference.
3. Unify locking across submit/review/payout/refund. Document and prove one lock order before modifying0039; naive request-then-payment payout versus payment-then-request refund can deadlock. Serialize merchant lane consistently before payment/request rows; deterministic account order. Maintain real database serialization handling and domain PT409.
4. Refund during an unpaid withdrawal must atomically reduce reserved claim and record immutable request adjustment/version/outbox. Paid part becomes original0039 merchant debt. Never hide negative balances, leave orphaned holds, or automatically debit future earnings without approved offset policy. Until debt disposition is explicit, show review blocker rather than promise withdrawable cash.
5. Submission/rejection/cancellation/approval remain idempotent actor-key commands with exact fingerprints. Reject/cancel releases unpaid allocations only; paid allocations/history cannot disappear. An expired subscription or stopped new-service access cannot remove financial read/earned rights.
6. Finance/owner records actual external bank event with unique bank reference, date, amount, frozen beneficiary and genuinely uploaded/verified private proof. Merchant cannot mark own request paid; no generic status dropdown, invented proof or simulated live transfer. Historical beneficiary changes require explicit review; never silently redirect to new bank details.
7. Post balanced original clearing/bank journal and immutable payout allocations once. Partial payment has remaining held/released according explicit configured policy, not assumed UI behavior. Genuine bank evidence Storage namespace and scoped access need real Auth/Storage tests; no public signed URLs or sensitive bank data in response/log.
8. Extend0042 whole-scope statement and branch breakdown with real withdrawal holds, released/unpaid/paid states. Keep full refunds versus unsettled reduction/debt distinct and earned=unsettled-refund+actual-paid+remaining. Never substitute request or approval for payment.
9. Shared Arabic responsive merchant request/detail/history and central review/proof/payment queue, every meaningful action backed by actual API/RPC. Current branch scope, empty/error/loading/uncertain-commit exact retry, filters/page/reload; no fake payout button.

## Tests before live migration
- RED genuine missing flow in disposable paid fixtures; native current-month earnings deny early submission.
- Historical eligible fixture must be isolated and retain actual balanced original journal plus frozen original period; no production clock override or editing live immutable eligibility.
- Two overlapping withdrawals and last-unit allocation; partial original remainder; mixed authorized/unauthorized branches, company/worker/other merchant denial, revocation with unchanged JWT.
- Full/partial bank payment, exact retry/lost response, duplicate bank ref, amount above remaining, missing/unverified/wrong-scope proof, stale bank versions, cancellation/rejection release unpaid only.
- Refund-before-submit, refund-versus-held/payout race, after-paid merchant debt, no double funding credit, Cairo month/DST boundaries, independent ledger/subledger matching.
- Real merchant+Finance JWT and Storage, real HTTP/browser save/reload/mobile/desktop screenshots and proof access denial. Existing payment/refund/physical-return/cron/role regressions stay green.
- Data-preserving rollback refuses any withdrawal/payout/adjustment history and restores changed old definitions/grants exactly on independent empty disposable snapshot.
- Only exact fully accepted migration applied live; pre/post function+table ACL/owner/defaultACL/security counts and zero synthetic business writes.

After financial acceptance: finish scoped merchant/company dashboard integration and warranties, reconciled reports/documents/support/outbox/public refinements; apps/devices last. Runtime hosting/configuration remains separately unidentified; source/schema success is not deployment.
