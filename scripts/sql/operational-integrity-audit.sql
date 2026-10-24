-- Pertomax EG: read-only finance and worker integrity checks.
-- Run in Supabase SQL editor with a trusted administrative role.
-- Every query should return zero rows when no violations exist.

-- Posted journal entries must have at least two lines and balance per currency.
SELECT e.id, e.reference, e.currency,
       COUNT(l.id) AS line_count,
       COALESCE(SUM(CASE WHEN l.side = 'debit' THEN l.amount_minor
                         WHEN l.side = 'credit' THEN -l.amount_minor
                         ELSE 0 END), 0) AS imbalance_minor
FROM public.petro_finance_journal_entries e
LEFT JOIN public.petro_finance_journal_lines l ON l.entry_id = e.id
GROUP BY e.id, e.reference, e.currency
HAVING COUNT(l.id) < 2
    OR COALESCE(SUM(CASE WHEN l.side = 'debit' THEN l.amount_minor
                         WHEN l.side = 'credit' THEN -l.amount_minor
                         ELSE 0 END), 0) <> 0
    OR COUNT(l.id) FILTER (WHERE l.currency IS DISTINCT FROM e.currency
                             OR l.side NOT IN ('debit','credit')
                             OR l.amount_minor <= 0) > 0;

-- An active reservation must represent a positive amount.
SELECT id, account_id, amount_minor, status
FROM public.petro_finance_reservations
WHERE status = 'active' AND amount_minor <= 0;

-- A worker cannot have duplicate active assignments to the same branch and service.
SELECT user_id, organization_id, branch_id, service_group, COUNT(*) AS duplicates
FROM public.petro_worker_assignments
WHERE active = true
GROUP BY user_id, organization_id, branch_id, service_group
HAVING COUNT(*) > 1;

-- Confirm row-level security remains enabled on sensitive tables.
SELECT n.nspname AS schema_name, c.relname AS table_name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relname IN ('petro_finance_journal_entries',
                    'petro_finance_journal_lines',
                    'petro_finance_reservations',
                    'petro_worker_assignments')
  AND NOT c.relrowsecurity;
