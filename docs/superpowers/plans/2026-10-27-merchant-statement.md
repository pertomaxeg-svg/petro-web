# Merchant financial statement and settlement foundation — 27 October 2026

Scope: approved engineering0040, first dependent read slice, migration0042. Only approved repository/branch and Supabase project; no Replit/local source environment. Existing accepted0862a5a1 + live0041 baseline.

1. RED actual paid/refunded/settled SQL fixtures prove missing statement and exact earned/refund/debt math.
2. Add one read-only scoped RPC. Central owner/finance/auditor; active merchant owner/manager/finance limited to current branch assignments. No subscription/operational-state confiscation of earned history, no company/worker access.
3. Aggregate each payment once before joins; earned minus unsettled refunds minus actual paid allocations is remaining. Full refunds and paid-out debt are separate. Open refund claims block eligible remainder; eligibility uses immutable original Cairo period/eligible_at. No automatic debt offset. Fixed20 pagination with totals over entire authorized filter.
4. Strict authenticated no-store API; shared Arabic responsive UI reachable from Finance and merchant workspace. Loading/error/empty/refetch, permitted org/branch filters, real details. No fake withdrawal or paid button.
5. SQL + actual API/browser + real JWT (current owner and outsider/worker/revocation), existing regressions and exact schema/defaultACL rollback. Review actual mobile/desktop screenshots.
6. Only after GREEN apply exact tested additive RPC; verify function body/grants/old objects and zero business writes. Record evidence and checkpoint.
Next immediately dependent slice: genuine organization withdrawal/bank-version freeze, allocation holds, refunds-versus-holds, Finance approval/private bank proof/partial bank journal, monthly-boundary tests and role dashboards. This read slice is not a withdrawal, bank payment, runtime release or full0040 completion.
