-- Pertomax EG: read-only prerequisites for live worker service settlement.
-- Every result row is a missing capability or an accounting decision.
-- Run under an administrative SQL role; do not expose this report as a public RPC.
WITH findings AS (
  SELECT 'missing_company_funding' AS issue, count(*)::bigint AS affected
    FROM public.petro_organizations o
    WHERE EXISTS (SELECT 1 FROM public.petro_fleet_vehicles v WHERE v.organization_id = o.id)
      AND NOT EXISTS (
        SELECT 1 FROM public.petro_finance_accounts a
        WHERE a.organization_id = o.id AND a.account_kind = 'company_funding'
      )
  UNION ALL
  SELECT 'missing_merchant_liability_scope', count(*)::bigint
  FROM public.petro_branches b
  WHERE EXISTS (SELECT 1 FROM public.petro_worker_assignments w WHERE w.branch_id=b.id AND w.active)
    AND NOT EXISTS (
      SELECT 1 FROM public.petro_finance_accounts a
      WHERE a.organization_id=b.organization_id AND a.branch_id=b.id
    )
  UNION ALL
  SELECT 'operational_journals', count(*)::bigint
  FROM public.petro_finance_journal_entries
  WHERE entry_type LIKE 'service%'
  UNION ALL
  SELECT 'merchant_payable_system_accounts', count(*)::bigint
  FROM public.petro_finance_accounts
  WHERE account_kind = 'merchant_payable'
)
SELECT issue, affected FROM findings ORDER BY issue;

-- Check allowed kinds separately before introducing a new revenue account.
SELECT pg_get_constraintdef(c.oid) AS allowed_account_kinds
FROM pg_constraint c
WHERE c.conrelid='public.petro_finance_accounts'::regclass
  AND c.conname='petro_finance_accounts_account_kind_check';
