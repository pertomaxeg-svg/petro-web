BEGIN;

-- Financial core for Pertomax EG. All amounts are integer piasters (EGP minor
-- units). No opening balances, bank accounts, receipts, or subscription
-- collections are seeded by this migration.
CREATE TABLE public.petro_finance_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  currency text NOT NULL DEFAULT 'EGP' CHECK (currency = 'EGP'),
  tax_policy_status text NOT NULL DEFAULT 'unconfigured'
    CHECK (tax_policy_status IN ('unconfigured','approved')),
  subscription_accounting_status text NOT NULL DEFAULT 'unconfigured'
    CHECK (subscription_accounting_status IN ('unconfigured','approved')),
  subscription_activation_enabled boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (subscription_activation_enabled = false OR subscription_accounting_status = 'approved')
);
INSERT INTO public.petro_finance_settings(singleton) VALUES (true);

CREATE TABLE public.petro_finance_bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_name text NOT NULL CHECK (length(btrim(bank_name)) BETWEEN 2 AND 100),
  display_label text NOT NULL CHECK (length(btrim(display_label)) BETWEEN 2 AND 100),
  account_last4 text NOT NULL CHECK (account_last4 ~ '^[0-9]{4}$'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','active','disabled')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 5 AND 500),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  approved_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'pending' AND approved_by IS NULL AND approved_at IS NULL)
      OR (status IN ('active','disabled') AND approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE UNIQUE INDEX petro_finance_bank_account_identity_unique
  ON public.petro_finance_bank_accounts (lower(bank_name), account_last4)
  WHERE status <> 'disabled';
CREATE INDEX petro_finance_bank_accounts_queue
  ON public.petro_finance_bank_accounts(status, created_at DESC);

CREATE TABLE public.petro_finance_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_code text NOT NULL UNIQUE,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 2 AND 160),
  account_kind text NOT NULL CHECK (account_kind IN (
    'bank_clearing','unallocated_receipts','company_funding',
    'branch_funding','subscription_receipts_held','merchant_payable'
  )),
  normal_side text NOT NULL CHECK (normal_side IN ('debit','credit')),
  organization_id uuid REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  branch_id uuid,
  receiving_bank_account_id uuid REFERENCES public.petro_finance_bank_accounts(id) ON DELETE RESTRICT,
  currency text NOT NULL DEFAULT 'EGP' CHECK (currency = 'EGP'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (account_kind = 'company_funding' AND normal_side = 'credit'
      AND organization_id IS NOT NULL AND branch_id IS NULL AND receiving_bank_account_id IS NULL)
    OR
    (account_kind = 'branch_funding' AND normal_side = 'credit'
      AND organization_id IS NOT NULL AND branch_id IS NOT NULL AND receiving_bank_account_id IS NULL)
    OR
    (account_kind = 'bank_clearing' AND normal_side = 'debit'
      AND organization_id IS NULL AND branch_id IS NULL AND receiving_bank_account_id IS NOT NULL)
    OR
    (account_kind IN ('unallocated_receipts','subscription_receipts_held','merchant_payable')
      AND normal_side = 'credit' AND organization_id IS NULL AND branch_id IS NULL
      AND receiving_bank_account_id IS NULL)
  ),
  FOREIGN KEY (branch_id, organization_id)
    REFERENCES public.petro_branches(id, organization_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX petro_finance_company_funding_account_unique
  ON public.petro_finance_accounts(organization_id)
  WHERE account_kind = 'company_funding';
CREATE UNIQUE INDEX petro_finance_branch_funding_account_unique
  ON public.petro_finance_accounts(organization_id, branch_id)
  WHERE account_kind = 'branch_funding';
CREATE UNIQUE INDEX petro_finance_bank_clearing_account_unique
  ON public.petro_finance_accounts(receiving_bank_account_id)
  WHERE account_kind = 'bank_clearing';
CREATE UNIQUE INDEX petro_finance_control_account_unique
  ON public.petro_finance_accounts(account_kind)
  WHERE account_kind IN ('unallocated_receipts','subscription_receipts_held','merchant_payable');

INSERT INTO public.petro_finance_accounts(account_code, display_name, account_kind, normal_side)
VALUES
  ('SYS-UNALLOCATED-RECEIPTS','متحصلات بنكية غير مخصصة','unallocated_receipts','credit'),
  ('SYS-SUBSCRIPTION-HELD','تحصيلات اشتراك معلقة على الاعتماد','subscription_receipts_held','credit'),
  ('SYS-MERCHANT-PAYABLE','مستحقات التجار — حساب ضبط','merchant_payable','credit');

CREATE TABLE public.petro_finance_journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_type text NOT NULL CHECK (entry_type IN (
    'bank_receipt','topup_allocation','subscription_collection',
    'internal_transfer','reversal'
  )),
  source_id uuid NOT NULL,
  organization_id uuid REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  reference text NOT NULL CHECK (length(btrim(reference)) BETWEEN 2 AND 160),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 5 AND 500),
  currency text NOT NULL DEFAULT 'EGP' CHECK (currency = 'EGP'),
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  reverses_entry_id uuid REFERENCES public.petro_finance_journal_entries(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((entry_type = 'reversal') = (reverses_entry_id IS NOT NULL))
);
CREATE UNIQUE INDEX petro_finance_journal_reference_unique
  ON public.petro_finance_journal_entries(lower(reference));
CREATE UNIQUE INDEX petro_finance_journal_one_reversal
  ON public.petro_finance_journal_entries(reverses_entry_id)
  WHERE reverses_entry_id IS NOT NULL;
CREATE INDEX petro_finance_journal_scope_time
  ON public.petro_finance_journal_entries(organization_id, occurred_at DESC, id);
CREATE INDEX petro_finance_journal_type_time
  ON public.petro_finance_journal_entries(entry_type, occurred_at DESC, id);

CREATE TABLE public.petro_finance_journal_lines (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id uuid NOT NULL REFERENCES public.petro_finance_journal_entries(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES public.petro_finance_accounts(id) ON DELETE RESTRICT,
  side text NOT NULL CHECK (side IN ('debit','credit')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL DEFAULT 'EGP' CHECK (currency = 'EGP'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX petro_finance_journal_lines_entry_idx
  ON public.petro_finance_journal_lines(entry_id, id);
CREATE INDEX petro_finance_journal_lines_account_idx
  ON public.petro_finance_journal_lines(account_id, entry_id);

CREATE TABLE public.petro_finance_topup_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  requested_amount_minor bigint NOT NULL CHECK (requested_amount_minor BETWEEN 1 AND 1000000000000),
  payer_bank_name text NOT NULL CHECK (length(btrim(payer_bank_name)) BETWEEN 2 AND 100),
  bank_reference text NOT NULL CHECK (length(btrim(bank_reference)) BETWEEN 2 AND 160),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 5 AND 500),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','submitted','needs_info','rejected','partially_funded','funded','cancelled'
  )),
  submitted_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  decision_reason text CHECK (decision_reason IS NULL OR length(btrim(decision_reason)) BETWEEN 5 AND 500),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX petro_finance_topup_queue
  ON public.petro_finance_topup_requests(status, created_at DESC, id);
CREATE INDEX petro_finance_topup_org
  ON public.petro_finance_topup_requests(organization_id, created_at DESC, id);
CREATE UNIQUE INDEX petro_finance_topup_reference_unique
  ON public.petro_finance_topup_requests(lower(regexp_replace(btrim(bank_reference), '[[:space:]]+', '', 'g')));

CREATE TABLE public.petro_finance_bank_reference_registry (
  normalized_reference text PRIMARY KEY CHECK (length(normalized_reference) BETWEEN 2 AND 160),
  reference_value text NOT NULL CHECK (length(btrim(reference_value)) BETWEEN 2 AND 160),
  topup_request_id uuid UNIQUE REFERENCES public.petro_finance_topup_requests(id) ON DELETE RESTRICT,
  receipt_id uuid UNIQUE,
  status text NOT NULL CHECK (status IN ('claimed','verified','released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (topup_request_id IS NOT NULL OR receipt_id IS NOT NULL)
);

CREATE TABLE public.petro_finance_bank_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_number text NOT NULL UNIQUE,
  organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  branch_id uuid,
  receiving_bank_account_id uuid NOT NULL REFERENCES public.petro_finance_bank_accounts(id) ON DELETE RESTRICT,
  payer_bank_name text NOT NULL CHECK (length(btrim(payer_bank_name)) BETWEEN 2 AND 100),
  bank_reference text NOT NULL CHECK (length(btrim(bank_reference)) BETWEEN 2 AND 160),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 1000000000000),
  currency text NOT NULL DEFAULT 'EGP' CHECK (currency = 'EGP'),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 5 AND 500),
  status text NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed','partially_allocated','fully_allocated','reversed')),
  recorded_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  verified_bank_transfer boolean NOT NULL DEFAULT true CHECK (verified_bank_transfer),
  journal_entry_id uuid UNIQUE REFERENCES public.petro_finance_journal_entries(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (journal_entry_id IS NOT NULL),
  FOREIGN KEY (branch_id, organization_id)
    REFERENCES public.petro_branches(id, organization_id) ON DELETE RESTRICT
);
CREATE INDEX petro_finance_receipts_time
  ON public.petro_finance_bank_receipts(created_at DESC, id);
CREATE UNIQUE INDEX petro_finance_receipt_reference_unique
  ON public.petro_finance_bank_receipts(lower(regexp_replace(btrim(bank_reference), '[[:space:]]+', '', 'g')));

ALTER TABLE public.petro_finance_bank_reference_registry
  ADD CONSTRAINT petro_finance_reference_receipt_fk
  FOREIGN KEY (receipt_id) REFERENCES public.petro_finance_bank_receipts(id) ON DELETE RESTRICT;

CREATE TABLE public.petro_finance_receipt_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL REFERENCES public.petro_finance_bank_receipts(id) ON DELETE RESTRICT,
  target_type text NOT NULL CHECK (target_type IN ('topup','subscription')),
  target_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 1000000000000),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 5 AND 500),
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  allocated_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  journal_entry_id uuid UNIQUE REFERENCES public.petro_finance_journal_entries(id) ON DELETE RESTRICT,
  reversed_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  reversed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'posted' AND reversed_by IS NULL AND reversed_at IS NULL)
      OR (status = 'reversed' AND reversed_by IS NOT NULL AND reversed_at IS NOT NULL)),
  CHECK (journal_entry_id IS NOT NULL)
);
CREATE INDEX petro_finance_allocations_receipt
  ON public.petro_finance_receipt_allocations(receipt_id, created_at, id);
CREATE INDEX petro_finance_allocations_target
  ON public.petro_finance_receipt_allocations(target_type, target_id, status);

CREATE TABLE public.petro_finance_subscription_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL UNIQUE REFERENCES public.petro_subscriptions(id) ON DELETE RESTRICT,
  subscription_request_id uuid NOT NULL REFERENCES public.petro_subscription_requests(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  branch_id uuid,
  plan_id uuid NOT NULL REFERENCES public.petro_plans(id) ON DELETE RESTRICT,
  plan_version_id uuid NOT NULL REFERENCES public.petro_plan_versions(id) ON DELETE RESTRICT,
  price_snapshot_minor bigint NOT NULL CHECK (price_snapshot_minor > 0),
  units integer NOT NULL CHECK (units > 0),
  amount_due_minor bigint NOT NULL CHECK (amount_due_minor > 0),
  amount_collected_minor bigint NOT NULL DEFAULT 0 CHECK (amount_collected_minor BETWEEN 0 AND amount_due_minor),
  currency text NOT NULL DEFAULT 'EGP' CHECK (currency = 'EGP'),
  status text NOT NULL DEFAULT 'unpaid'
    CHECK (status IN ('unpaid','partially_collected','collected_on_hold','reversed')),
  activation_blocker text NOT NULL DEFAULT 'subscription_accounting_policy_unconfigured'
    CHECK (activation_blocker IN ('subscription_accounting_policy_unconfigured','coverage_not_eligible','none')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (branch_id, organization_id)
    REFERENCES public.petro_branches(id, organization_id) ON DELETE RESTRICT
);
CREATE INDEX petro_finance_subscription_collections_status
  ON public.petro_finance_subscription_collections(status, created_at DESC, id);
CREATE INDEX petro_finance_subscription_collections_org
  ON public.petro_finance_subscription_collections(organization_id, branch_id, created_at DESC);

CREATE TABLE public.petro_finance_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  source_account_id uuid NOT NULL REFERENCES public.petro_finance_accounts(id) ON DELETE RESTRICT,
  target_account_id uuid NOT NULL REFERENCES public.petro_finance_accounts(id) ON DELETE RESTRICT,
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 1000000000000),
  reference text NOT NULL CHECK (length(btrim(reference)) BETWEEN 2 AND 160),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 5 AND 500),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  journal_entry_id uuid UNIQUE REFERENCES public.petro_finance_journal_entries(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_account_id <> target_account_id),
  CHECK (journal_entry_id IS NOT NULL)
);
CREATE UNIQUE INDEX petro_finance_transfer_reference_unique
  ON public.petro_finance_transfers(lower(reference));
CREATE INDEX petro_finance_transfer_org_time
  ON public.petro_finance_transfers(organization_id, created_at DESC, id);

CREATE TABLE public.petro_finance_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.petro_finance_accounts(id) ON DELETE RESTRICT,
  source_type text NOT NULL CHECK (length(btrim(source_type)) BETWEEN 2 AND 60),
  source_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 1000000000000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','consumed')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 5 AND 500),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  closed_at timestamptz,
  CHECK ((status = 'active' AND closed_by IS NULL AND closed_at IS NULL)
      OR (status <> 'active' AND closed_by IS NOT NULL AND closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX petro_finance_reservation_active_source
  ON public.petro_finance_reservations(account_id, source_type, source_id)
  WHERE status = 'active';
CREATE INDEX petro_finance_reservations_account_status
  ON public.petro_finance_reservations(account_id, status);

CREATE TABLE public.petro_finance_commands (
  action text NOT NULL CHECK (length(btrim(action)) BETWEEN 2 AND 80),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 160),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{32}$'),
  response jsonb,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(action, idempotency_key)
);

CREATE TABLE public.petro_finance_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type text NOT NULL CHECK (length(btrim(event_type)) BETWEEN 2 AND 100),
  source_type text NOT NULL CHECK (length(btrim(source_type)) BETWEEN 2 AND 60),
  source_id uuid NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE UNIQUE INDEX petro_finance_outbox_source_unique
  ON public.petro_finance_outbox(event_type, source_type, source_id);
CREATE INDEX petro_finance_outbox_pending
  ON public.petro_finance_outbox(created_at, id) WHERE delivered_at IS NULL;

ALTER TABLE public.petro_documents
  ADD COLUMN finance_topup_request_id uuid
    REFERENCES public.petro_finance_topup_requests(id) ON DELETE RESTRICT,
  ADD COLUMN finance_subscription_request_id uuid
    REFERENCES public.petro_subscription_requests(id) ON DELETE RESTRICT,
  ADD COLUMN finance_bank_receipt_id uuid
    REFERENCES public.petro_finance_bank_receipts(id) ON DELETE RESTRICT,
  ADD CONSTRAINT petro_documents_finance_context_check
    CHECK (num_nonnulls(finance_topup_request_id, finance_subscription_request_id, finance_bank_receipt_id) <= 1);
CREATE INDEX petro_documents_finance_topup_idx
  ON public.petro_documents(finance_topup_request_id, status, created_at DESC)
  WHERE finance_topup_request_id IS NOT NULL;
CREATE INDEX petro_documents_finance_subscription_idx
  ON public.petro_documents(finance_subscription_request_id, status, created_at DESC)
  WHERE finance_subscription_request_id IS NOT NULL;
CREATE INDEX petro_documents_finance_receipt_idx
  ON public.petro_documents(finance_bank_receipt_id, status, created_at DESC)
  WHERE finance_bank_receipt_id IS NOT NULL;

ALTER TABLE public.petro_finance_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_finance_bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_finance_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_finance_journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_finance_journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_finance_topup_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_finance_bank_reference_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_finance_bank_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_finance_receipt_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_finance_subscription_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_finance_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_finance_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_finance_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_finance_outbox ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.petro_finance_settings, public.petro_finance_bank_accounts,
  public.petro_finance_accounts, public.petro_finance_journal_entries,
  public.petro_finance_journal_lines, public.petro_finance_topup_requests,
  public.petro_finance_bank_reference_registry, public.petro_finance_bank_receipts,
  public.petro_finance_receipt_allocations, public.petro_finance_subscription_collections,
  public.petro_finance_transfers, public.petro_finance_reservations,
  public.petro_finance_commands, public.petro_finance_outbox
  FROM PUBLIC, anon, authenticated, service_role;

CREATE VIEW public.petro_finance_account_balances WITH (security_invoker = true) AS
SELECT account.id AS account_id, account.account_code, account.display_name,
       account.account_kind, account.organization_id, account.branch_id,
       account.receiving_bank_account_id, account.currency, account.normal_side,
       COALESCE(SUM(
         CASE WHEN account.normal_side = 'debit'
           THEN CASE WHEN line.side = 'debit' THEN line.amount_minor ELSE -line.amount_minor END
           ELSE CASE WHEN line.side = 'credit' THEN line.amount_minor ELSE -line.amount_minor END
         END
       ), 0)::bigint AS ledger_balance_minor,
       COALESCE(reserved.amount_minor, 0)::bigint AS reserved_minor,
       (COALESCE(SUM(
         CASE WHEN account.normal_side = 'debit'
           THEN CASE WHEN line.side = 'debit' THEN line.amount_minor ELSE -line.amount_minor END
           ELSE CASE WHEN line.side = 'credit' THEN line.amount_minor ELSE -line.amount_minor END
         END
       ), 0) - COALESCE(reserved.amount_minor, 0))::bigint AS available_minor
FROM public.petro_finance_accounts account
LEFT JOIN public.petro_finance_journal_lines line ON line.account_id = account.id
LEFT JOIN LATERAL (
  SELECT SUM(reservation.amount_minor)::bigint AS amount_minor
  FROM public.petro_finance_reservations reservation
  WHERE reservation.account_id = account.id AND reservation.status = 'active'
) reserved ON true
GROUP BY account.id, account.account_code, account.display_name, account.account_kind,
         account.organization_id, account.branch_id, account.receiving_bank_account_id,
         account.currency, account.normal_side, reserved.amount_minor;
REVOKE ALL ON public.petro_finance_account_balances FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.petro_finance_journal_entries IS
  'Immutable posted EGP journal. Use integer piasters, balanced lines, source references, and reversal entries only.';
COMMENT ON TABLE public.petro_finance_reservations IS
  'Off-ledger holds. Available funds equal the derived ledger balance less active reservations.';
COMMENT ON TABLE public.petro_finance_subscription_collections IS
  'Immutable subscription price/version snapshot; cash is held separately from company service funding until accounting policy is approved.';
COMMENT ON TABLE public.petro_finance_bank_accounts IS
  'Platform receiving destinations store only display label, bank name, and last four digits; never a full account credential.';

CREATE FUNCTION petro_private.finance_can_read() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT petro_private.platform_has(ARRAY['owner','finance','auditor']::text[])
$$;

CREATE FUNCTION petro_private.finance_can_mutate() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT petro_private.platform_has(ARRAY['owner','finance']::text[])
$$;

CREATE FUNCTION petro_private.finance_can_submit() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT petro_private.platform_has(ARRAY['owner','finance','operations']::text[])
$$;

CREATE FUNCTION petro_private.finance_begin_command(
  p_action text, p_key text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE payload_hash text; prior public.petro_finance_commands%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR p_action IS NULL OR length(btrim(p_action)) NOT BETWEEN 2 AND 80
     OR p_key IS NULL OR length(btrim(p_key)) NOT BETWEEN 8 AND 160
     OR p_payload IS NULL THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_INPUT' USING ERRCODE = '22023';
  END IF;
  payload_hash := md5(p_payload::text);
  INSERT INTO public.petro_finance_commands(action,idempotency_key,payload_hash,created_by)
  VALUES (p_action,btrim(p_key),payload_hash,auth.uid())
  ON CONFLICT (action,idempotency_key) DO NOTHING;
  SELECT * INTO prior FROM public.petro_finance_commands
  WHERE action=p_action AND idempotency_key=btrim(p_key) FOR UPDATE;
  IF prior.payload_hash <> payload_hash THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH' USING ERRCODE = '23505';
  END IF;
  IF prior.response IS NOT NULL THEN RETURN prior.response; END IF;
  IF prior.created_by <> auth.uid() THEN
    RAISE EXCEPTION 'IDEMPOTENCY_COMMAND_IN_PROGRESS' USING ERRCODE = '40001';
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION petro_private.finance_finish_command(
  p_action text, p_key text, p_response jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  UPDATE public.petro_finance_commands
  SET response=p_response
  WHERE action=p_action AND idempotency_key=btrim(p_key)
    AND created_by=auth.uid() AND response IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESPONSE_NOT_WRITTEN' USING ERRCODE = '55000';
  END IF;
END
$$;

CREATE FUNCTION petro_private.finance_post_entry(
  p_entry_id uuid, p_entry_type text, p_source_id uuid, p_organization_id uuid,
  p_reference text, p_reason text, p_lines jsonb, p_reverses_entry_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE debit_total numeric; credit_total numeric; line_count integer;
BEGIN
  IF p_entry_id IS NULL OR p_source_id IS NULL OR p_reference IS NULL
     OR p_reason IS NULL OR jsonb_typeof(p_lines) <> 'array'
     OR jsonb_array_length(p_lines) < 2 THEN
    RAISE EXCEPTION 'INVALID_JOURNAL_ENTRY' USING ERRCODE = '22023';
  END IF;
  SELECT count(*),
         sum((item.value->>'amountMinor')::numeric) FILTER (WHERE item.value->>'side'='debit'),
         sum((item.value->>'amountMinor')::numeric) FILTER (WHERE item.value->>'side'='credit')
  INTO line_count,debit_total,credit_total
  FROM jsonb_array_elements(p_lines) AS item(value);
  IF line_count < 2 OR debit_total IS NULL OR credit_total IS NULL
     OR debit_total <= 0 OR debit_total <> credit_total
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_lines) AS item(value)
       WHERE item.value->>'side' NOT IN ('debit','credit')
         OR (item.value->>'amountMinor') !~ '^[1-9][0-9]{0,12}$'
         OR NOT EXISTS (
           SELECT 1 FROM public.petro_finance_accounts account
           WHERE account.id=(item.value->>'accountId')::uuid
             AND account.currency='EGP'
         )
     ) THEN
    RAISE EXCEPTION 'UNBALANCED_OR_INVALID_JOURNAL_ENTRY' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.petro_finance_journal_entries(
    id,entry_type,source_id,organization_id,reference,reason,actor_id,reverses_entry_id
  ) VALUES (
    p_entry_id,p_entry_type,p_source_id,p_organization_id,btrim(p_reference),btrim(p_reason),
    auth.uid(),p_reverses_entry_id
  );
  INSERT INTO public.petro_finance_journal_lines(entry_id,account_id,side,amount_minor)
  SELECT p_entry_id,(item.value->>'accountId')::uuid,item.value->>'side',
         (item.value->>'amountMinor')::bigint
  FROM jsonb_array_elements(p_lines) AS item(value);
  INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
  VALUES (auth.uid(),p_organization_id,'finance.journal.posted',p_entry_id,
    jsonb_build_object('entryType',p_entry_type,'reference',btrim(p_reference),
      'reason',btrim(p_reason),'currency','EGP','debitMinor',debit_total::text));
  INSERT INTO public.petro_finance_outbox(event_type,source_type,source_id,payload)
  VALUES ('finance.journal.posted',p_entry_type,p_entry_id,
    jsonb_build_object('entryId',p_entry_id,'organizationId',p_organization_id,
      'reference',btrim(p_reference),'currency','EGP'));
  RETURN p_entry_id;
END
$$;

CREATE FUNCTION petro_private.finance_account_for_scope(
  p_organization_id uuid, p_branch_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE org public.petro_organizations%ROWTYPE; branch_name text; account_id uuid;
BEGIN
  SELECT * INTO org FROM public.petro_organizations WHERE id=p_organization_id;
  IF NOT FOUND OR org.kind <> 'company' OR org.status <> 'active'
     OR org.approval_status <> 'approved' OR org.operational_status <> 'active' THEN
    RAISE EXCEPTION 'COMPANY_NOT_ELIGIBLE_FOR_FUNDING' USING ERRCODE = '55000';
  END IF;
  IF p_branch_id IS NULL THEN
    INSERT INTO public.petro_finance_accounts(
      account_code,display_name,account_kind,normal_side,organization_id
    ) VALUES (
      'COMPANY:'||p_organization_id::text,'رئيسي — '||org.name,
      'company_funding','credit',p_organization_id
    ) ON CONFLICT (organization_id) WHERE account_kind='company_funding' DO NOTHING;
    SELECT id INTO account_id FROM public.petro_finance_accounts
    WHERE organization_id=p_organization_id AND account_kind='company_funding';
  ELSE
    SELECT name INTO branch_name FROM public.petro_branches
    WHERE id=p_branch_id AND organization_id=p_organization_id AND status='active'
      AND approval_status='approved' AND operational_status='active';
    IF NOT FOUND THEN RAISE EXCEPTION 'BRANCH_NOT_ELIGIBLE_FOR_FUNDING' USING ERRCODE = '55000'; END IF;
    INSERT INTO public.petro_finance_accounts(
      account_code,display_name,account_kind,normal_side,organization_id,branch_id
    ) VALUES (
      'BRANCH:'||p_branch_id::text,'فرع — '||branch_name,
      'branch_funding','credit',p_organization_id,p_branch_id
    ) ON CONFLICT (organization_id,branch_id) WHERE account_kind='branch_funding' DO NOTHING;
    SELECT id INTO account_id FROM public.petro_finance_accounts
    WHERE organization_id=p_organization_id AND branch_id=p_branch_id
      AND account_kind='branch_funding';
  END IF;
  RETURN account_id;
END
$$;

CREATE FUNCTION petro_private.finance_bank_asset(p_bank_account_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE bank public.petro_finance_bank_accounts%ROWTYPE; account_id uuid;
BEGIN
  SELECT * INTO bank FROM public.petro_finance_bank_accounts
  WHERE id=p_bank_account_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RECEIVING_BANK_ACCOUNT_NOT_ACTIVE' USING ERRCODE = '55000'; END IF;
  INSERT INTO public.petro_finance_accounts(
    account_code,display_name,account_kind,normal_side,receiving_bank_account_id
  ) VALUES (
    'BANK:'||bank.id::text,bank.bank_name||' — •••• '||bank.account_last4,
    'bank_clearing','debit',bank.id
  ) ON CONFLICT (receiving_bank_account_id) WHERE account_kind='bank_clearing' DO NOTHING;
  SELECT id INTO account_id FROM public.petro_finance_accounts
  WHERE receiving_bank_account_id=bank.id AND account_kind='bank_clearing';
  RETURN account_id;
END
$$;

CREATE FUNCTION petro_private.finance_normalize_reference(p_reference text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT lower(regexp_replace(btrim(coalesce(p_reference,'')), '[[:space:]]+', '', 'g'))
$$;

CREATE FUNCTION petro_private.guard_finance_journal_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'FINANCIAL_JOURNAL_IS_IMMUTABLE' USING ERRCODE = '55000';
END
$$;
CREATE TRIGGER petro_finance_journal_entries_immutable
  BEFORE UPDATE OR DELETE ON public.petro_finance_journal_entries
  FOR EACH ROW EXECUTE FUNCTION petro_private.guard_finance_journal_immutable();
CREATE TRIGGER petro_finance_journal_lines_immutable
  BEFORE UPDATE OR DELETE ON public.petro_finance_journal_lines
  FOR EACH ROW EXECUTE FUNCTION petro_private.guard_finance_journal_immutable();

CREATE FUNCTION petro_private.assert_finance_entry_balanced() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE entry_uuid uuid;
BEGIN
  entry_uuid := CASE WHEN TG_TABLE_NAME='petro_finance_journal_entries'
    THEN (to_jsonb(NEW)->>'id')::uuid
    ELSE (to_jsonb(NEW)->>'entry_id')::uuid END;
  IF NOT EXISTS (
    SELECT 1 FROM public.petro_finance_journal_entries entry WHERE entry.id=entry_uuid
  ) OR (SELECT count(*) FROM public.petro_finance_journal_lines line WHERE line.entry_id=entry_uuid) < 2
     OR (SELECT COALESCE(sum(amount_minor),0) FROM public.petro_finance_journal_lines
         WHERE entry_id=entry_uuid AND side='debit')
        <> (SELECT COALESCE(sum(amount_minor),0) FROM public.petro_finance_journal_lines
            WHERE entry_id=entry_uuid AND side='credit') THEN
    RAISE EXCEPTION 'FINANCIAL_JOURNAL_ENTRY_MUST_BALANCE' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER petro_finance_entry_balance_check
  AFTER INSERT ON public.petro_finance_journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION petro_private.assert_finance_entry_balanced();
CREATE CONSTRAINT TRIGGER petro_finance_lines_balance_check
  AFTER INSERT ON public.petro_finance_journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION petro_private.assert_finance_entry_balanced();

CREATE FUNCTION public.petro_finance_admin_summary() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE totals record; roles text[];
BEGIN
  IF NOT petro_private.finance_can_read() THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(array_agg(role ORDER BY role),'{}'::text[]) INTO roles
  FROM public.petro_platform_roles WHERE user_id=auth.uid() AND active;
  SELECT
    COALESCE(sum(ledger_balance_minor) FILTER (WHERE account_kind IN ('company_funding','branch_funding')),0)::text AS customer_funds,
    COALESCE(sum(reserved_minor) FILTER (WHERE account_kind IN ('company_funding','branch_funding')),0)::text AS reserved,
    COALESCE(sum(available_minor) FILTER (WHERE account_kind IN ('company_funding','branch_funding')),0)::text AS available,
    COALESCE(sum(ledger_balance_minor) FILTER (WHERE account_kind='unallocated_receipts'),0)::text AS unallocated,
    COALESCE(sum(ledger_balance_minor) FILTER (WHERE account_kind='subscription_receipts_held'),0)::text AS subscription_held,
    COALESCE(sum(ledger_balance_minor) FILTER (WHERE account_kind='merchant_payable'),0)::text AS merchant_payable
  INTO totals FROM public.petro_finance_account_balances;
  RETURN jsonb_build_object(
    'currency','EGP','roles',to_jsonb(roles),
    'companyFundsMinor',totals.customer_funds,'reservedMinor',totals.reserved,
    'availableMinor',totals.available,'unallocatedReceiptsMinor',totals.unallocated,
    'subscriptionHeldMinor',totals.subscription_held,'merchantPayableMinor',totals.merchant_payable,
    'pendingTopups',(SELECT count(*) FROM public.petro_finance_topup_requests WHERE status IN ('submitted','needs_info')),
    'pendingBankAccounts',(SELECT count(*) FROM public.petro_finance_bank_accounts WHERE status='pending'),
    'collectedSubscriptionsOnHold',(SELECT count(*) FROM public.petro_finance_subscription_collections WHERE status='collected_on_hold'),
    'accountingPolicy',jsonb_build_object(
      'tax', (SELECT tax_policy_status FROM public.petro_finance_settings WHERE singleton),
      'subscription', (SELECT subscription_accounting_status FROM public.petro_finance_settings WHERE singleton),
      'activationEnabled', (SELECT subscription_activation_enabled FROM public.petro_finance_settings WHERE singleton)
    ),
    'financialOperations','manual_bank_verification_only'
  );
END
$$;

CREATE FUNCTION public.petro_finance_admin_organizations(
  p_search text DEFAULT NULL, p_page integer DEFAULT 1, p_page_size integer DEFAULT 20
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE items jsonb; total_count bigint; search_value text:=nullif(btrim(p_search),'');
BEGIN
  IF NOT petro_private.finance_can_submit() OR p_page NOT BETWEEN 1 AND 100000
     OR p_page_size NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'FORBIDDEN_OR_INVALID_PAGE' USING ERRCODE='42501'; END IF;
  SELECT count(*) INTO total_count FROM public.petro_organizations organization
  WHERE organization.kind IN ('company','provider') AND organization.status='active'
    AND organization.approval_status='approved' AND organization.operational_status='active'
    AND (organization.kind='company' OR petro_private.finance_can_mutate())
    AND (organization.kind='company' OR EXISTS (
      SELECT 1 FROM public.petro_branches branch
      WHERE branch.organization_id=organization.id AND branch.status='active'
        AND branch.approval_status='approved' AND branch.operational_status='active'
    ))
    AND (search_value IS NULL OR organization.name ILIKE '%'||search_value||'%'
      OR organization.code ILIKE '%'||search_value||'%' OR EXISTS (
        SELECT 1 FROM public.petro_branches branch
        WHERE branch.organization_id=organization.id AND branch.status='active'
          AND branch.approval_status='approved' AND branch.operational_status='active'
          AND branch.name ILIKE '%'||search_value||'%'
      ));
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',page_rows.id,'name',page_rows.name,'code',page_rows.code,
    'kind',page_rows.kind,'branches',page_rows.branches
  ) ORDER BY page_rows.name),'[]'::jsonb) INTO items
  FROM (
    SELECT organization.id,organization.name,organization.code,organization.kind,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',branch.id,'name',branch.name)
        ORDER BY branch.name),'[]'::jsonb)
       FROM public.petro_branches branch
       WHERE branch.organization_id=organization.id AND branch.status='active'
         AND branch.approval_status='approved' AND branch.operational_status='active'
      ) AS branches
    FROM public.petro_organizations organization
    WHERE organization.kind IN ('company','provider') AND organization.status='active'
      AND organization.approval_status='approved' AND organization.operational_status='active'
      AND (organization.kind='company' OR petro_private.finance_can_mutate())
      AND (organization.kind='company' OR EXISTS (
        SELECT 1 FROM public.petro_branches branch
        WHERE branch.organization_id=organization.id AND branch.status='active'
          AND branch.approval_status='approved' AND branch.operational_status='active'
      ))
      AND (search_value IS NULL OR organization.name ILIKE '%'||search_value||'%'
        OR organization.code ILIKE '%'||search_value||'%' OR EXISTS (
          SELECT 1 FROM public.petro_branches branch
          WHERE branch.organization_id=organization.id AND branch.status='active'
            AND branch.approval_status='approved' AND branch.operational_status='active'
            AND branch.name ILIKE '%'||search_value||'%'
        ))
    ORDER BY organization.name,organization.id LIMIT p_page_size OFFSET (p_page-1)*p_page_size
  ) page_rows;
  RETURN jsonb_build_object('items',items,'page',p_page,'pageSize',p_page_size,
    'total',total_count,'totalPages',CEIL(total_count::numeric/p_page_size)::integer);
END
$$;

CREATE FUNCTION public.petro_finance_admin_accounts(
  p_search text DEFAULT NULL, p_page integer DEFAULT 1, p_page_size integer DEFAULT 20
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE items jsonb; total_count bigint; search_value text:=nullif(btrim(p_search),'');
BEGIN
  IF NOT petro_private.finance_can_read() OR p_page NOT BETWEEN 1 AND 100000
     OR p_page_size NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'FORBIDDEN_OR_INVALID_PAGE' USING ERRCODE='42501'; END IF;
  SELECT count(*) INTO total_count
  FROM public.petro_finance_account_balances balance
  LEFT JOIN public.petro_organizations organization ON organization.id=balance.organization_id
  LEFT JOIN public.petro_branches branch ON branch.id=balance.branch_id
  WHERE balance.account_kind IN ('company_funding','branch_funding')
    AND (search_value IS NULL OR organization.name ILIKE '%'||search_value||'%'
      OR branch.name ILIKE '%'||search_value||'%' OR organization.code ILIKE '%'||search_value||'%');
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'accountId',rows.account_id,'organizationId',rows.organization_id,
    'organizationName',rows.organization_name,'branchId',rows.branch_id,
    'branchName',rows.branch_name,'accountKind',rows.account_kind,'currency','EGP',
    'ledgerBalanceMinor',rows.ledger_balance_minor,'reservedMinor',rows.reserved_minor,
    'availableMinor',rows.available_minor
  ) ORDER BY rows.organization_name,rows.branch_name NULLS FIRST),'[]'::jsonb) INTO items
  FROM (
    SELECT balance.account_id,balance.organization_id,organization.name AS organization_name,
      balance.branch_id,branch.name AS branch_name,balance.account_kind,
      balance.ledger_balance_minor::text,balance.reserved_minor::text,balance.available_minor::text
    FROM public.petro_finance_account_balances balance
    LEFT JOIN public.petro_organizations organization ON organization.id=balance.organization_id
    LEFT JOIN public.petro_branches branch ON branch.id=balance.branch_id
    WHERE balance.account_kind IN ('company_funding','branch_funding')
      AND (search_value IS NULL OR organization.name ILIKE '%'||search_value||'%'
        OR branch.name ILIKE '%'||search_value||'%' OR organization.code ILIKE '%'||search_value||'%')
    ORDER BY organization.name,branch.name NULLS FIRST,balance.account_id
    LIMIT p_page_size OFFSET (p_page-1)*p_page_size
  ) rows;
  RETURN jsonb_build_object('items',items,'page',p_page,'pageSize',p_page_size,
    'total',total_count,'totalPages',CEIL(total_count::numeric/p_page_size)::integer);
END
$$;

CREATE FUNCTION public.petro_finance_admin_bank_accounts() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT petro_private.finance_can_read() THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('items',COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id',bank.id,'bankName',bank.bank_name,
      'displayLabel',bank.display_label,'accountLast4',bank.account_last4,'status',bank.status,
      'reason',bank.reason,'createdBy',bank.created_by,'approvedBy',bank.approved_by,
      'createdAt',bank.created_at,'approvedAt',bank.approved_at)
      ORDER BY bank.created_at DESC)
    FROM public.petro_finance_bank_accounts bank
  ),'[]'::jsonb));
END
$$;

CREATE FUNCTION public.petro_finance_admin_add_bank_account(
  p_bank_name text, p_display_label text, p_account_last4 text,
  p_reason text, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE cached jsonb; bank_id uuid:=gen_random_uuid(); result jsonb;
BEGIN
  IF NOT petro_private.finance_can_mutate() THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF length(btrim(coalesce(p_bank_name,''))) NOT BETWEEN 2 AND 100
     OR length(btrim(coalesce(p_display_label,''))) NOT BETWEEN 2 AND 100
     OR coalesce(p_account_last4,'') !~ '^[0-9]{4}$'
     OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'INVALID_BANK_ACCOUNT' USING ERRCODE='22023';
  END IF;
  cached:=petro_private.finance_begin_command('bank_account.create',p_idempotency_key,
    jsonb_build_object('bankName',btrim(p_bank_name),'label',btrim(p_display_label),
      'last4',p_account_last4,'reason',btrim(p_reason)));
  IF cached IS NOT NULL THEN RETURN cached; END IF;
  INSERT INTO public.petro_finance_bank_accounts(
    bank_name,display_label,account_last4,reason,created_by
  ) VALUES (btrim(p_bank_name),btrim(p_display_label),p_account_last4,btrim(p_reason),auth.uid())
  RETURNING id INTO bank_id;
  INSERT INTO public.petro_audit_events(actor_id,action,target_id,detail)
  VALUES (auth.uid(),'finance.receiving_bank_account.created',bank_id,
    jsonb_build_object('bankName',btrim(p_bank_name),'label',btrim(p_display_label),
      'last4',p_account_last4,'reason',btrim(p_reason),'status','pending'));
  result:=jsonb_build_object('id',bank_id,'status','pending','message','أُضيف وجهة استقبال ببيانات مقنّعة وتنتظر اعتماد شخص آخر.');
  PERFORM petro_private.finance_finish_command('bank_account.create',p_idempotency_key,result);
  RETURN result;
END
$$;

CREATE FUNCTION public.petro_finance_admin_approve_bank_account(
  p_bank_account_id uuid, p_reason text, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE cached jsonb; bank public.petro_finance_bank_accounts%ROWTYPE; result jsonb;
BEGIN
  IF NOT petro_private.finance_can_mutate() THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF p_bank_account_id IS NULL OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'INVALID_BANK_ACCOUNT_REVIEW' USING ERRCODE='22023';
  END IF;
  cached:=petro_private.finance_begin_command('bank_account.approve',p_idempotency_key,
    jsonb_build_object('id',p_bank_account_id,'reason',btrim(p_reason)));
  IF cached IS NOT NULL THEN RETURN cached; END IF;
  SELECT * INTO bank FROM public.petro_finance_bank_accounts WHERE id=p_bank_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF bank.status <> 'pending' OR bank.created_by=auth.uid() THEN
    RAISE EXCEPTION 'BANK_ACCOUNT_REQUIRES_INDEPENDENT_REVIEW' USING ERRCODE='55000';
  END IF;
  UPDATE public.petro_finance_bank_accounts SET status='active',approved_by=auth.uid(),
    approved_at=now(),updated_at=now() WHERE id=bank.id;
  INSERT INTO public.petro_audit_events(actor_id,action,target_id,detail)
  VALUES (auth.uid(),'finance.receiving_bank_account.approved',bank.id,
    jsonb_build_object('reason',btrim(p_reason),'last4',bank.account_last4));
  result:=jsonb_build_object('id',bank.id,'status','active','message','تم اعتماد وجهة الاستقبال.');
  PERFORM petro_private.finance_finish_command('bank_account.approve',p_idempotency_key,result);
  RETURN result;
END
$$;

CREATE FUNCTION public.petro_finance_admin_create_topup(
  p_organization_id uuid, p_amount_minor bigint, p_payer_bank_name text,
  p_bank_reference text, p_reason text, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE cached jsonb; new_id uuid:=gen_random_uuid(); org public.petro_organizations%ROWTYPE; result jsonb;
BEGIN
  IF NOT petro_private.finance_can_submit() THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF p_organization_id IS NULL OR p_amount_minor NOT BETWEEN 1 AND 1000000000000
     OR length(btrim(coalesce(p_payer_bank_name,''))) NOT BETWEEN 2 AND 100
     OR length(btrim(coalesce(p_bank_reference,''))) NOT BETWEEN 2 AND 160
     OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'INVALID_TOPUP_REQUEST' USING ERRCODE='22023';
  END IF;
  SELECT * INTO org FROM public.petro_organizations WHERE id=p_organization_id;
  IF NOT FOUND OR org.kind <> 'company' OR org.status <> 'active'
     OR org.approval_status <> 'approved' OR org.operational_status <> 'active' THEN
    RAISE EXCEPTION 'COMPANY_NOT_ELIGIBLE_FOR_FUNDING' USING ERRCODE='55000';
  END IF;
  cached:=petro_private.finance_begin_command('topup.create',p_idempotency_key,
    jsonb_build_object('organizationId',p_organization_id,'amountMinor',p_amount_minor,
      'payerBank',btrim(p_payer_bank_name),'reference',petro_private.finance_normalize_reference(p_bank_reference),
      'reason',btrim(p_reason)));
  IF cached IS NOT NULL THEN RETURN cached; END IF;
  INSERT INTO public.petro_finance_topup_requests(
    id,organization_id,requested_amount_minor,payer_bank_name,bank_reference,reason,submitted_by
  ) VALUES (new_id,p_organization_id,p_amount_minor,btrim(p_payer_bank_name),
    btrim(p_bank_reference),btrim(p_reason),auth.uid());
  INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
  VALUES (auth.uid(),p_organization_id,'finance.topup.draft_created',new_id,
    jsonb_build_object('amountMinor',p_amount_minor::text,'currency','EGP','reason',btrim(p_reason)));
  result:=jsonb_build_object('id',new_id,'status','draft','version',1,'message','حُفظ طلب الشحن كمسودة؛ لا يوجد قيد أو رصيد حتى اعتماد التحويل الفعلي.');
  PERFORM petro_private.finance_finish_command('topup.create',p_idempotency_key,result);
  RETURN result;
END
$$;

CREATE FUNCTION public.petro_finance_admin_update_topup(
  p_topup_id uuid, p_expected_version bigint, p_amount_minor bigint,
  p_payer_bank_name text, p_bank_reference text, p_reason text, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE cached jsonb; request_row public.petro_finance_topup_requests%ROWTYPE; result jsonb;
BEGIN
  IF NOT petro_private.finance_can_submit() THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF p_topup_id IS NULL OR p_expected_version IS NULL
     OR p_amount_minor NOT BETWEEN 1 AND 1000000000000
     OR length(btrim(coalesce(p_payer_bank_name,''))) NOT BETWEEN 2 AND 100
     OR length(btrim(coalesce(p_bank_reference,''))) NOT BETWEEN 2 AND 160
     OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'INVALID_TOPUP_REQUEST' USING ERRCODE='22023';
  END IF;
  cached:=petro_private.finance_begin_command('topup.update',p_idempotency_key,
    jsonb_build_object('id',p_topup_id,'version',p_expected_version,'amountMinor',p_amount_minor,
      'payerBank',btrim(p_payer_bank_name),'reference',petro_private.finance_normalize_reference(p_bank_reference),
      'reason',btrim(p_reason)));
  IF cached IS NOT NULL THEN RETURN cached; END IF;
  SELECT * INTO request_row FROM public.petro_finance_topup_requests WHERE id=p_topup_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF request_row.status NOT IN ('draft','needs_info') OR request_row.version<>p_expected_version
     OR (request_row.submitted_by<>auth.uid() AND NOT petro_private.platform_has(ARRAY['owner','finance']::text[])) THEN
    RAISE EXCEPTION 'TOPUP_VERSION_OR_STATUS_CONFLICT' USING ERRCODE='40001';
  END IF;
  UPDATE public.petro_finance_bank_reference_registry
  SET status='released',updated_at=now()
  WHERE topup_request_id=request_row.id AND receipt_id IS NULL;
  UPDATE public.petro_finance_topup_requests
  SET requested_amount_minor=p_amount_minor,payer_bank_name=btrim(p_payer_bank_name),
      bank_reference=btrim(p_bank_reference),reason=btrim(p_reason),status='draft',
      decision_reason=NULL,reviewed_by=NULL,reviewed_at=NULL,version=version+1,updated_at=now()
  WHERE id=request_row.id;
  INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
  VALUES(auth.uid(),request_row.organization_id,'finance.topup.draft_updated',request_row.id,
    jsonb_build_object('version',p_expected_version+1,'reason',btrim(p_reason)));
  result:=jsonb_build_object('id',request_row.id,'status','draft','version',p_expected_version+1,'message','تم تحديث المسودة دون أثر مالي.');
  PERFORM petro_private.finance_finish_command('topup.update',p_idempotency_key,result);
  RETURN result;
END
$$;

CREATE FUNCTION public.petro_finance_admin_submit_topup(
  p_topup_id uuid, p_expected_version bigint, p_reason text, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE cached jsonb; request_row public.petro_finance_topup_requests%ROWTYPE;
  normalized_ref text; result jsonb;
BEGIN
  IF NOT petro_private.finance_can_submit() THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF p_topup_id IS NULL OR p_expected_version IS NULL
     OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'INVALID_TOPUP_SUBMISSION' USING ERRCODE='22023';
  END IF;
  cached:=petro_private.finance_begin_command('topup.submit',p_idempotency_key,
    jsonb_build_object('id',p_topup_id,'version',p_expected_version,'reason',btrim(p_reason)));
  IF cached IS NOT NULL THEN RETURN cached; END IF;
  SELECT * INTO request_row FROM public.petro_finance_topup_requests WHERE id=p_topup_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF request_row.status NOT IN ('draft','needs_info') OR request_row.version<>p_expected_version
     OR (request_row.submitted_by<>auth.uid() AND NOT petro_private.platform_has(ARRAY['owner','finance']::text[]))
     OR NOT EXISTS (
       SELECT 1 FROM public.petro_documents document
       WHERE document.finance_topup_request_id=request_row.id
         AND document.status IN ('pending_review','approved') AND document.uploaded_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'TOPUP_REQUIRES_CURRENT_VERSION_AND_PRIVATE_EVIDENCE' USING ERRCODE='55000';
  END IF;
  normalized_ref:=petro_private.finance_normalize_reference(request_row.bank_reference);
  INSERT INTO public.petro_finance_bank_reference_registry(
    normalized_reference,reference_value,topup_request_id,status
  ) VALUES (normalized_ref,request_row.bank_reference,request_row.id,'claimed')
  ON CONFLICT (normalized_reference) DO UPDATE
    SET reference_value=EXCLUDED.reference_value,topup_request_id=EXCLUDED.topup_request_id,
        status='claimed',updated_at=now()
    WHERE petro_finance_bank_reference_registry.status='released'
      AND petro_finance_bank_reference_registry.receipt_id IS NULL
       OR (petro_finance_bank_reference_registry.status='claimed'
         AND petro_finance_bank_reference_registry.receipt_id IS NULL
         AND petro_finance_bank_reference_registry.topup_request_id=EXCLUDED.topup_request_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'BANK_REFERENCE_ALREADY_CLAIMED' USING ERRCODE='23505'; END IF;
  UPDATE public.petro_finance_topup_requests
  SET status='submitted',reviewed_by=NULL,reviewed_at=NULL,decision_reason=NULL,
      version=version+1,updated_at=now()
  WHERE id=request_row.id;
  INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
  VALUES(auth.uid(),request_row.organization_id,'finance.topup.submitted',request_row.id,
    jsonb_build_object('version',p_expected_version+1,'reason',btrim(p_reason)));
  result:=jsonb_build_object('id',request_row.id,'status','submitted','version',p_expected_version+1,'message','أُرسل الطلب للمراجعة؛ المرفق وحده لا يثبت القبض.');
  PERFORM petro_private.finance_finish_command('topup.submit',p_idempotency_key,result);
  RETURN result;
END
$$;

CREATE FUNCTION public.petro_finance_admin_review_topup(
  p_topup_id uuid, p_expected_version bigint, p_decision text,
  p_reason text, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE cached jsonb; request_row public.petro_finance_topup_requests%ROWTYPE; result jsonb;
BEGIN
  IF NOT petro_private.finance_can_mutate() THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF p_topup_id IS NULL OR p_expected_version IS NULL
     OR p_decision NOT IN ('needs_info','reject')
     OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'INVALID_TOPUP_REVIEW' USING ERRCODE='22023';
  END IF;
  cached:=petro_private.finance_begin_command('topup.review',p_idempotency_key,
    jsonb_build_object('id',p_topup_id,'version',p_expected_version,
      'decision',p_decision,'reason',btrim(p_reason)));
  IF cached IS NOT NULL THEN RETURN cached; END IF;
  SELECT * INTO request_row FROM public.petro_finance_topup_requests WHERE id=p_topup_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF request_row.status<>'submitted' OR request_row.version<>p_expected_version
     OR request_row.submitted_by=auth.uid() THEN
    RAISE EXCEPTION 'TOPUP_REVIEW_CONFLICT_OR_SELF_APPROVAL' USING ERRCODE='40001';
  END IF;
  UPDATE public.petro_finance_topup_requests
  SET status=p_decision,reviewed_by=auth.uid(),reviewed_at=now(),
      decision_reason=btrim(p_reason),version=version+1,updated_at=now()
  WHERE id=request_row.id;
  INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
  VALUES(auth.uid(),request_row.organization_id,'finance.topup.'||p_decision,request_row.id,
    jsonb_build_object('version',p_expected_version+1,'reason',btrim(p_reason)));
  result:=jsonb_build_object('id',request_row.id,'status',p_decision,'version',p_expected_version+1,'message',
    CASE p_decision WHEN 'needs_info' THEN 'طُلب استكمال البيانات.' ELSE 'رُفض الطلب بسبب موثق.' END);
  PERFORM petro_private.finance_finish_command('topup.review',p_idempotency_key,result);
  RETURN result;
END
$$;

CREATE FUNCTION public.petro_finance_admin_list_topups(
  p_status text DEFAULT NULL, p_search text DEFAULT NULL,
  p_page integer DEFAULT 1, p_page_size integer DEFAULT 20
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE items jsonb; total_count bigint; search_value text:=nullif(btrim(p_search),'');
  is_finance boolean:=petro_private.platform_has(ARRAY['owner','finance']::text[]);
BEGIN
  IF NOT petro_private.finance_can_read() AND NOT petro_private.platform_has(ARRAY['operations']::text[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF p_page NOT BETWEEN 1 AND 100000 OR p_page_size NOT BETWEEN 1 AND 100
     OR (p_status IS NOT NULL AND p_status NOT IN ('draft','submitted','needs_info','rejected','partially_funded','funded','cancelled')) THEN
    RAISE EXCEPTION 'INVALID_FILTER' USING ERRCODE='22023';
  END IF;
  SELECT count(*) INTO total_count
  FROM public.petro_finance_topup_requests request
  JOIN public.petro_organizations organization ON organization.id=request.organization_id
  WHERE (p_status IS NULL OR request.status=p_status)
    AND (petro_private.platform_has(ARRAY['owner','finance','auditor']::text[]) OR request.submitted_by=auth.uid())
    AND (search_value IS NULL OR organization.name ILIKE '%'||search_value||'%'
      OR organization.code ILIKE '%'||search_value||'%' OR request.bank_reference ILIKE '%'||search_value||'%'
      OR request.id::text ILIKE '%'||search_value||'%');
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',rows.id,'organizationId',rows.organization_id,'organizationName',rows.organization_name,
    'requestedAmountMinor',rows.requested_amount_minor,'currency','EGP',
    'payerBankName',rows.payer_bank_name,
    'bankReference',CASE WHEN is_finance OR rows.submitted_by=auth.uid() THEN rows.bank_reference ELSE NULL END,
    'maskedReference',right(rows.bank_reference,4),'reason',rows.reason,'status',rows.status,
    'submittedBy',rows.submitted_by,'reviewedBy',rows.reviewed_by,
    'reviewedAt',rows.reviewed_at,'decisionReason',rows.decision_reason,
    'version',rows.version,'createdAt',rows.created_at,
    'evidenceCount',rows.evidence_count,'allocatedMinor',rows.allocated_minor
  ) ORDER BY rows.created_at DESC),'[]'::jsonb) INTO items
  FROM (
    SELECT request.*,organization.name AS organization_name,
      (SELECT count(*) FROM public.petro_documents document
       WHERE document.finance_topup_request_id=request.id AND document.uploaded_at IS NOT NULL)::integer AS evidence_count,
      COALESCE((SELECT sum(allocation.amount_minor) FROM public.petro_finance_receipt_allocations allocation
        WHERE allocation.target_type='topup' AND allocation.target_id=request.id AND allocation.status='posted'),0)::text AS allocated_minor
    FROM public.petro_finance_topup_requests request
    JOIN public.petro_organizations organization ON organization.id=request.organization_id
    WHERE (p_status IS NULL OR request.status=p_status)
      AND (petro_private.platform_has(ARRAY['owner','finance','auditor']::text[]) OR request.submitted_by=auth.uid())
      AND (search_value IS NULL OR organization.name ILIKE '%'||search_value||'%'
        OR organization.code ILIKE '%'||search_value||'%' OR request.bank_reference ILIKE '%'||search_value||'%'
        OR request.id::text ILIKE '%'||search_value||'%')
    ORDER BY request.created_at DESC,request.id
    LIMIT p_page_size OFFSET (p_page-1)*p_page_size
  ) rows;
  RETURN jsonb_build_object('items',items,'page',p_page,'pageSize',p_page_size,
    'total',total_count,'totalPages',CEIL(total_count::numeric/p_page_size)::integer);
END
$$;

CREATE OR REPLACE FUNCTION petro_private.can_read_finance_document(p_object_path text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT petro_private.user_active() AND EXISTS (
    SELECT 1 FROM public.petro_documents document
    WHERE document.storage_path=p_object_path
      AND document.uploaded_at IS NOT NULL
      AND (document.finance_topup_request_id IS NOT NULL
        OR document.finance_subscription_request_id IS NOT NULL
        OR document.finance_bank_receipt_id IS NOT NULL)
      AND (document.uploader_id=auth.uid()
        OR petro_private.platform_has(ARRAY['owner','finance']::text[]))
  )
$$;

CREATE POLICY petro_finance_documents_read
  ON public.petro_documents FOR SELECT TO authenticated
  USING (
    (finance_topup_request_id IS NOT NULL OR finance_subscription_request_id IS NOT NULL
      OR finance_bank_receipt_id IS NOT NULL)
    AND (uploader_id=auth.uid() OR petro_private.platform_has(ARRAY['owner','finance']::text[]))
  );
CREATE POLICY petro_finance_storage_evidence_read
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id='petro-private-documents'
    AND petro_private.can_read_finance_document(name)
  );

CREATE OR REPLACE FUNCTION public.petro_finance_create_document_upload(
  p_context_type text, p_context_id uuid, p_document_type text, p_file_name text,
  p_content_type text, p_byte_size bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE org_id uuid; branch_id uuid; actor uuid:=auth.uid(); doc_id uuid; object_path text;
  allowed boolean:=false; receipt public.petro_finance_bank_receipts%ROWTYPE;
BEGIN
  IF actor IS NULL OR NOT petro_private.user_active()
     OR p_context_type NOT IN ('topup_request','subscription_request','receipt')
     OR length(btrim(coalesce(p_document_type,''))) NOT BETWEEN 2 AND 80
     OR length(coalesce(p_file_name,'')) NOT BETWEEN 1 AND 160
     OR p_content_type NOT IN ('application/pdf','image/png','image/jpeg')
     OR p_byte_size NOT BETWEEN 1 AND 10485760 THEN
    RAISE EXCEPTION 'INVALID_FINANCE_DOCUMENT_INPUT' USING ERRCODE='22023';
  END IF;
  IF p_context_type='topup_request' THEN
    SELECT organization_id INTO org_id FROM public.petro_finance_topup_requests
    WHERE id=p_context_id AND status IN ('draft','needs_info','submitted')
      AND (submitted_by=actor OR petro_private.platform_has(ARRAY['owner','finance','operations']::text[]));
    allowed:=org_id IS NOT NULL AND petro_private.finance_can_submit();
  ELSIF p_context_type='subscription_request' THEN
    SELECT request.organization_id,request.branch_id INTO org_id,branch_id
    FROM public.petro_subscription_requests request
    WHERE request.id=p_context_id AND request.request_status IN ('submitted','approved','needs_changes')
      AND petro_private.finance_can_submit();
    allowed:=org_id IS NOT NULL;
  ELSE
    SELECT * INTO receipt FROM public.petro_finance_bank_receipts
    WHERE id=p_context_id AND status<>'reversed';
    IF FOUND THEN
      org_id:=receipt.organization_id; branch_id:=receipt.branch_id;
      allowed:=receipt.recorded_by=actor OR petro_private.finance_can_mutate();
    END IF;
  END IF;
  IF NOT allowed THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  doc_id:=gen_random_uuid();
  object_path:='documents/'||gen_random_uuid()::text;
  INSERT INTO public.petro_documents(
    id,uploader_id,organization_id,branch_id,finance_topup_request_id,
    finance_subscription_request_id,finance_bank_receipt_id,document_type,file_name,content_type,
    byte_size,storage_path
  ) VALUES (
    doc_id,actor,org_id,branch_id,
    CASE WHEN p_context_type='topup_request' THEN p_context_id ELSE NULL END,
    CASE WHEN p_context_type='subscription_request' THEN p_context_id ELSE NULL END,
    CASE WHEN p_context_type='receipt' THEN p_context_id ELSE NULL END,
    btrim(p_document_type),p_file_name,p_content_type,p_byte_size,object_path
  );
  INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
  VALUES(actor,org_id,'finance.document.upload_started',doc_id,
    jsonb_build_object('contextType',p_context_type,'contextId',p_context_id,'mime',p_content_type,'size',p_byte_size));
  RETURN jsonb_build_object('id',doc_id,'objectPath',object_path,'bucket','petro-private-documents');
END
$$;

CREATE FUNCTION petro_private.finance_record_receipt(
  p_organization_id uuid, p_branch_id uuid, p_receiving_bank_account_id uuid,
  p_payer_bank_name text, p_bank_reference text, p_amount_minor bigint,
  p_reason text, p_topup_request_id uuid, p_allow_topup_submitter boolean
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE new_receipt_id uuid:=gen_random_uuid(); entry_id uuid:=gen_random_uuid();
  unallocated_account uuid; bank_asset_account uuid;
  request_row public.petro_finance_topup_requests%ROWTYPE;
  registry_row public.petro_finance_bank_reference_registry%ROWTYPE;
  normalized_ref text; org public.petro_organizations%ROWTYPE; receipt_no text;
BEGIN
  IF p_organization_id IS NULL OR p_receiving_bank_account_id IS NULL
     OR length(btrim(coalesce(p_payer_bank_name,''))) NOT BETWEEN 2 AND 100
     OR length(btrim(coalesce(p_bank_reference,''))) NOT BETWEEN 2 AND 160
     OR p_amount_minor NOT BETWEEN 1 AND 1000000000000
     OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'INVALID_BANK_RECEIPT' USING ERRCODE='22023';
  END IF;
  SELECT * INTO org FROM public.petro_organizations WHERE id=p_organization_id;
  IF NOT FOUND OR org.kind='station' OR org.status<>'active'
     OR org.approval_status<>'approved' OR org.operational_status<>'active' THEN
    RAISE EXCEPTION 'ORGANIZATION_NOT_ELIGIBLE_FOR_RECEIPT' USING ERRCODE='55000';
  END IF;
  IF p_branch_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.petro_branches branch
    WHERE branch.id=p_branch_id AND branch.organization_id=p_organization_id
      AND branch.status='active' AND branch.approval_status='approved'
      AND branch.operational_status='active'
  ) THEN
    RAISE EXCEPTION 'BRANCH_NOT_ELIGIBLE_FOR_RECEIPT' USING ERRCODE='55000';
  END IF;
  IF org.kind='company' AND p_branch_id IS NOT NULL THEN
    RAISE EXCEPTION 'COMPANY_TOPUPS_USE_THE_MAIN_ACCOUNT' USING ERRCODE='23514';
  END IF;
  IF org.kind='provider' AND p_branch_id IS NULL THEN
    RAISE EXCEPTION 'PROVIDER_RECEIPTS_REQUIRE_A_BRANCH' USING ERRCODE='23514';
  END IF;
  normalized_ref:=petro_private.finance_normalize_reference(p_bank_reference);
  IF p_topup_request_id IS NOT NULL THEN
    SELECT * INTO request_row FROM public.petro_finance_topup_requests
    WHERE id=p_topup_request_id FOR UPDATE;
    IF NOT FOUND OR request_row.organization_id<>p_organization_id OR p_branch_id IS NOT NULL
       OR request_row.status NOT IN ('submitted','partially_funded')
       OR petro_private.finance_normalize_reference(request_row.bank_reference)<>normalized_ref
       OR (request_row.submitted_by=auth.uid() AND NOT p_allow_topup_submitter) THEN
      RAISE EXCEPTION 'TOPUP_RECEIPT_SCOPE_OR_REVIEW_CONFLICT' USING ERRCODE='55000';
    END IF;
  END IF;
  SELECT * INTO registry_row FROM public.petro_finance_bank_reference_registry
  WHERE normalized_reference=normalized_ref FOR UPDATE;
  IF FOUND THEN
    IF registry_row.receipt_id IS NOT NULL OR registry_row.status='released'
       OR (registry_row.topup_request_id IS NOT NULL
         AND p_topup_request_id IS NOT NULL
         AND registry_row.topup_request_id<>p_topup_request_id) THEN
      RAISE EXCEPTION 'BANK_REFERENCE_ALREADY_RECEIVED_OR_CLAIMED' USING ERRCODE='23505';
    END IF;
    IF p_topup_request_id IS NOT NULL AND registry_row.topup_request_id<>p_topup_request_id THEN
      RAISE EXCEPTION 'BANK_REFERENCE_CLAIM_MISMATCH' USING ERRCODE='23505';
    END IF;
  END IF;
  bank_asset_account:=petro_private.finance_bank_asset(p_receiving_bank_account_id);
  SELECT id INTO unallocated_account FROM public.petro_finance_accounts
  WHERE account_kind='unallocated_receipts';
  IF unallocated_account IS NULL THEN RAISE EXCEPTION 'UNALLOCATED_ACCOUNT_MISSING' USING ERRCODE='55000'; END IF;
  receipt_no:='RCV-'||upper(substr(replace(new_receipt_id::text,'-',''),1,12));
  PERFORM petro_private.finance_post_entry(
    entry_id,'bank_receipt',new_receipt_id,p_organization_id,receipt_no,btrim(p_reason),
    jsonb_build_array(
      jsonb_build_object('accountId',bank_asset_account,'side','debit','amountMinor',p_amount_minor::text),
      jsonb_build_object('accountId',unallocated_account,'side','credit','amountMinor',p_amount_minor::text)
    )
  );
  INSERT INTO public.petro_finance_bank_receipts(
    id,receipt_number,organization_id,branch_id,receiving_bank_account_id,
    payer_bank_name,bank_reference,amount_minor,reason,recorded_by,
    verified_bank_transfer,journal_entry_id
  ) VALUES (
    new_receipt_id,receipt_no,p_organization_id,p_branch_id,p_receiving_bank_account_id,
    btrim(p_payer_bank_name),btrim(p_bank_reference),p_amount_minor,btrim(p_reason),
    auth.uid(),true,entry_id
  );
  IF registry_row.normalized_reference IS NULL THEN
    INSERT INTO public.petro_finance_bank_reference_registry(
      normalized_reference,reference_value,topup_request_id,receipt_id,status
    ) VALUES (normalized_ref,btrim(p_bank_reference),p_topup_request_id,new_receipt_id,'verified');
  ELSE
    UPDATE public.petro_finance_bank_reference_registry
    SET reference_value=btrim(p_bank_reference),receipt_id=new_receipt_id,
        status='verified',updated_at=now()
    WHERE normalized_reference=normalized_ref AND receipt_id IS NULL AND status='claimed';
    IF NOT FOUND THEN RAISE EXCEPTION 'BANK_REFERENCE_ALREADY_RECEIVED' USING ERRCODE='23505'; END IF;
  END IF;
  INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
  VALUES(auth.uid(),p_organization_id,'finance.bank_receipt.recorded',new_receipt_id,
    jsonb_build_object('receiptNumber',receipt_no,'amountMinor',p_amount_minor::text,
      'currency','EGP','bankReferenceLast4',right(btrim(p_bank_reference),4),
      'reason',btrim(p_reason),'verifiedAgainstActualBankTransfer',true));
  RETURN new_receipt_id;
END
$$;

CREATE FUNCTION petro_private.finance_allocate_receipt(
  p_receipt_id uuid, p_target_type text, p_target_id uuid,
  p_amount_minor bigint, p_reason text, p_allow_receipt_recorder boolean
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE receipt public.petro_finance_bank_receipts%ROWTYPE;
  topup public.petro_finance_topup_requests%ROWTYPE;
  subscription public.petro_subscriptions%ROWTYPE;
  subscription_request public.petro_subscription_requests%ROWTYPE;
  collection public.petro_finance_subscription_collections%ROWTYPE;
  allocation_id uuid:=gen_random_uuid(); entry_id uuid:=gen_random_uuid();
  available_receipt bigint; target_open bigint; debit_account uuid; credit_account uuid;
  due_numeric numeric; result_org uuid; policy_state text; activation_enabled boolean;
BEGIN
  IF p_receipt_id IS NULL OR p_target_id IS NULL OR p_target_type NOT IN ('topup','subscription')
     OR p_amount_minor NOT BETWEEN 1 AND 1000000000000
     OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'INVALID_RECEIPT_ALLOCATION' USING ERRCODE='22023';
  END IF;
  SELECT * INTO receipt FROM public.petro_finance_bank_receipts
  WHERE id=p_receipt_id FOR UPDATE;
  IF NOT FOUND OR receipt.status='reversed' THEN
    RAISE EXCEPTION 'RECEIPT_NOT_ALLOCATABLE' USING ERRCODE='55000';
  END IF;
  IF receipt.recorded_by=auth.uid() AND NOT p_allow_receipt_recorder THEN
    RAISE EXCEPTION 'RECEIPT_ALLOCATION_REQUIRES_INDEPENDENT_REVIEW' USING ERRCODE='55000';
  END IF;
  SELECT receipt.amount_minor-COALESCE(sum(amount_minor) FILTER (WHERE status='posted'),0)
  INTO available_receipt
  FROM public.petro_finance_receipt_allocations WHERE receipt_id=receipt.id;
  IF p_amount_minor>available_receipt THEN
    RAISE EXCEPTION 'RECEIPT_ALLOCATION_EXCEEDS_UNALLOCATED_AMOUNT' USING ERRCODE='23514';
  END IF;
  SELECT id INTO debit_account FROM public.petro_finance_accounts
  WHERE account_kind='unallocated_receipts';
  result_org:=receipt.organization_id;
  IF p_target_type='topup' THEN
    SELECT * INTO topup FROM public.petro_finance_topup_requests
    WHERE id=p_target_id FOR UPDATE;
    IF NOT FOUND OR topup.organization_id<>receipt.organization_id
       OR topup.status NOT IN ('submitted','partially_funded')
       OR topup.submitted_by=auth.uid()
       OR petro_private.finance_normalize_reference(topup.bank_reference)
          <>petro_private.finance_normalize_reference(receipt.bank_reference) THEN
      RAISE EXCEPTION 'TOPUP_ALLOCATION_SCOPE_OR_REVIEW_CONFLICT' USING ERRCODE='55000';
    END IF;
    SELECT topup.requested_amount_minor-COALESCE(sum(allocation.amount_minor)
      FILTER (WHERE allocation.status='posted'),0)
    INTO target_open FROM public.petro_finance_receipt_allocations allocation
    WHERE allocation.target_type='topup' AND allocation.target_id=topup.id;
    IF p_amount_minor>target_open THEN
      RAISE EXCEPTION 'TOPUP_REQUEST_ALREADY_SATISFIED' USING ERRCODE='23514';
    END IF;
    credit_account:=petro_private.finance_account_for_scope(topup.organization_id,NULL);
  ELSE
    SELECT * INTO subscription FROM public.petro_subscriptions
    WHERE id=p_target_id FOR UPDATE;
    IF NOT FOUND OR subscription.organization_id<>receipt.organization_id
       OR subscription.branch_id IS DISTINCT FROM receipt.branch_id
       OR subscription.status<>'pending_payment' THEN
      RAISE EXCEPTION 'SUBSCRIPTION_NOT_COLLECTIBLE' USING ERRCODE='55000';
    END IF;
    SELECT * INTO subscription_request FROM public.petro_subscription_requests
    WHERE id=subscription.request_id FOR UPDATE;
    IF NOT FOUND OR subscription_request.request_status<>'approved'
       OR subscription_request.reviewed_by=auth.uid() OR subscription.price_snapshot_minor<=0 THEN
      RAISE EXCEPTION 'SUBSCRIPTION_REVIEW_OR_PRICE_CONFLICT' USING ERRCODE='55000';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.petro_documents document
      WHERE document.uploaded_at IS NOT NULL
        AND document.status IN ('pending_review','approved')
        AND (document.finance_bank_receipt_id=receipt.id
          OR document.finance_subscription_request_id=subscription.request_id)
    ) THEN
      RAISE EXCEPTION 'SUBSCRIPTION_COLLECTION_REQUIRES_PRIVATE_EVIDENCE' USING ERRCODE='55000';
    END IF;
    due_numeric:=subscription.price_snapshot_minor::numeric*subscription.units::numeric;
    IF due_numeric<=0 OR due_numeric>9223372036854775807 THEN
      RAISE EXCEPTION 'SUBSCRIPTION_AMOUNT_OUT_OF_RANGE' USING ERRCODE='22003';
    END IF;
    SELECT subscription_accounting_status,subscription_activation_enabled
    INTO policy_state,activation_enabled
    FROM public.petro_finance_settings WHERE singleton;
    INSERT INTO public.petro_finance_subscription_collections(
      subscription_id,subscription_request_id,organization_id,branch_id,
      plan_id,plan_version_id,price_snapshot_minor,units,amount_due_minor,
      activation_blocker
    ) VALUES (
      subscription.id,subscription.request_id,subscription.organization_id,
      subscription.branch_id,subscription.plan_id,subscription.plan_version_id,
      subscription.price_snapshot_minor,subscription.units,due_numeric::bigint,
      CASE WHEN policy_state<>'approved' OR NOT activation_enabled
        THEN 'subscription_accounting_policy_unconfigured'
        WHEN subscription_request.coverage_state<>'verified' THEN 'coverage_not_eligible'
        ELSE 'none' END
    ) ON CONFLICT (subscription_id) DO NOTHING;
    SELECT * INTO collection FROM public.petro_finance_subscription_collections
    WHERE subscription_id=subscription.id FOR UPDATE;
    target_open:=collection.amount_due_minor-collection.amount_collected_minor;
    IF p_amount_minor>target_open THEN
      RAISE EXCEPTION 'SUBSCRIPTION_ALREADY_PAID_OR_OVERALLOCATED' USING ERRCODE='23514';
    END IF;
    SELECT id INTO credit_account FROM public.petro_finance_accounts
    WHERE account_kind='subscription_receipts_held';
  END IF;
  IF debit_account IS NULL OR credit_account IS NULL THEN
    RAISE EXCEPTION 'FINANCE_CONTROL_ACCOUNT_MISSING' USING ERRCODE='55000';
  END IF;
  PERFORM petro_private.finance_post_entry(
    entry_id,CASE WHEN p_target_type='topup' THEN 'topup_allocation' ELSE 'subscription_collection' END,
    allocation_id,result_org,'ALC-'||upper(substr(replace(allocation_id::text,'-',''),1,12)),
    btrim(p_reason),jsonb_build_array(
      jsonb_build_object('accountId',debit_account,'side','debit','amountMinor',p_amount_minor::text),
      jsonb_build_object('accountId',credit_account,'side','credit','amountMinor',p_amount_minor::text)
    )
  );
  INSERT INTO public.petro_finance_receipt_allocations(
    id,receipt_id,target_type,target_id,amount_minor,reason,allocated_by,journal_entry_id
  ) VALUES(allocation_id,p_receipt_id,p_target_type,p_target_id,p_amount_minor,
    btrim(p_reason),auth.uid(),entry_id);
  IF p_target_type='topup' THEN
    SELECT topup.requested_amount_minor-COALESCE(sum(allocation.amount_minor)
      FILTER (WHERE allocation.status='posted'),0)
    INTO target_open FROM public.petro_finance_receipt_allocations allocation
    WHERE allocation.target_type='topup' AND allocation.target_id=topup.id;
    UPDATE public.petro_finance_topup_requests
    SET status=CASE WHEN target_open=0 THEN 'funded' ELSE 'partially_funded' END,
        reviewed_by=auth.uid(),reviewed_at=now(),decision_reason=btrim(p_reason),
        version=version+1,updated_at=now()
    WHERE id=topup.id;
  ELSE
    SELECT subscription_accounting_status,subscription_activation_enabled
    INTO policy_state,activation_enabled FROM public.petro_finance_settings WHERE singleton;
    UPDATE public.petro_finance_subscription_collections
    SET amount_collected_minor=amount_collected_minor+p_amount_minor,
        status=CASE WHEN amount_collected_minor+p_amount_minor=amount_due_minor
          THEN 'collected_on_hold' ELSE 'partially_collected' END,
        activation_blocker=CASE WHEN policy_state<>'approved' OR NOT activation_enabled
          THEN 'subscription_accounting_policy_unconfigured'
          WHEN subscription_request.coverage_state<>'verified' THEN 'coverage_not_eligible'
          ELSE 'none' END,
        updated_at=now()
    WHERE subscription_id=subscription.id;
  END IF;
  UPDATE public.petro_finance_bank_receipts receipt_row
  SET status=CASE WHEN receipt_row.amount_minor-COALESCE((
    SELECT sum(allocation.amount_minor) FROM public.petro_finance_receipt_allocations allocation
    WHERE allocation.receipt_id=receipt_row.id AND allocation.status='posted'
  ),0)=0 THEN 'fully_allocated' ELSE 'partially_allocated' END
  WHERE receipt_row.id=receipt.id;
  INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
  VALUES(auth.uid(),result_org,'finance.receipt.allocated',allocation_id,
    jsonb_build_object('receiptId',receipt.id,'targetType',p_target_type,'targetId',p_target_id,
      'amountMinor',p_amount_minor::text,'currency','EGP','reason',btrim(p_reason)));
  RETURN allocation_id;
END
$$;

CREATE FUNCTION public.petro_finance_admin_record_receipt(
  p_organization_id uuid, p_branch_id uuid, p_receiving_bank_account_id uuid,
  p_payer_bank_name text, p_bank_reference text, p_amount_minor bigint,
  p_reason text, p_confirmed_against_bank boolean, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE cached jsonb; receipt_id uuid; result jsonb;
BEGIN
  IF NOT petro_private.finance_can_mutate() THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF p_confirmed_against_bank IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'BANK_TRANSFER_MUST_BE_VERIFIED' USING ERRCODE='55000';
  END IF;
  cached:=petro_private.finance_begin_command('receipt.record',p_idempotency_key,
    jsonb_build_object('organizationId',p_organization_id,'branchId',p_branch_id,
      'bankAccountId',p_receiving_bank_account_id,'payerBank',btrim(p_payer_bank_name),
      'reference',petro_private.finance_normalize_reference(p_bank_reference),
      'amountMinor',p_amount_minor,'reason',btrim(p_reason),'confirmed',p_confirmed_against_bank));
  IF cached IS NOT NULL THEN RETURN cached; END IF;
  receipt_id:=petro_private.finance_record_receipt(
    p_organization_id,p_branch_id,p_receiving_bank_account_id,p_payer_bank_name,
    p_bank_reference,p_amount_minor,p_reason,NULL,false
  );
  result:=jsonb_build_object('id',receipt_id,
    'receiptNumber',(SELECT receipt_number FROM public.petro_finance_bank_receipts WHERE id=receipt_id),
    'amountMinor',p_amount_minor::text,'currency','EGP','status','confirmed',
    'message','سُجل القبض الفعلي كرصيد غير مخصص؛ لا يضيف رصيد خدمات قبل تخصيصه.');
  PERFORM petro_private.finance_finish_command('receipt.record',p_idempotency_key,result);
  RETURN result;
END
$$;

CREATE FUNCTION public.petro_finance_admin_approve_topup(
  p_topup_id uuid, p_bank_account_id uuid, p_actual_amount_minor bigint,
  p_allocation_amount_minor bigint, p_reason text, p_confirmed_against_bank boolean,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE cached jsonb; request_row public.petro_finance_topup_requests%ROWTYPE;
  v_receipt_id uuid; allocation_id uuid; outstanding bigint; actual_allocation bigint;
  result jsonb; existing_receipt uuid; receipt_amount bigint;
BEGIN
  IF NOT petro_private.finance_can_mutate() THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF p_confirmed_against_bank IS DISTINCT FROM true
     OR p_actual_amount_minor NOT BETWEEN 1 AND 1000000000000
     OR (p_allocation_amount_minor IS NOT NULL AND p_allocation_amount_minor NOT BETWEEN 1 AND 1000000000000)
     OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'INVALID_OR_UNVERIFIED_TOPUP_APPROVAL' USING ERRCODE='22023';
  END IF;
  cached:=petro_private.finance_begin_command('topup.approve',p_idempotency_key,
    jsonb_build_object('id',p_topup_id,'bankAccountId',p_bank_account_id,
      'actualAmountMinor',p_actual_amount_minor,'allocationAmountMinor',p_allocation_amount_minor,
      'reason',btrim(p_reason),'confirmed',p_confirmed_against_bank));
  IF cached IS NOT NULL THEN RETURN cached; END IF;
  SELECT * INTO request_row FROM public.petro_finance_topup_requests WHERE id=p_topup_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF request_row.status NOT IN ('submitted','partially_funded')
     OR request_row.submitted_by=auth.uid()
     OR NOT EXISTS (SELECT 1 FROM public.petro_documents document
       WHERE document.finance_topup_request_id=request_row.id
         AND document.status IN ('pending_review','approved') AND document.uploaded_at IS NOT NULL) THEN
    RAISE EXCEPTION 'TOPUP_REQUIRES_EVIDENCE_AND_INDEPENDENT_REVIEW' USING ERRCODE='55000';
  END IF;
  SELECT registry.receipt_id INTO existing_receipt
  FROM public.petro_finance_bank_reference_registry registry
  WHERE registry.normalized_reference=petro_private.finance_normalize_reference(request_row.bank_reference)
    AND registry.topup_request_id=request_row.id FOR UPDATE;
  SELECT request_row.requested_amount_minor-COALESCE(sum(allocation.amount_minor)
    FILTER (WHERE allocation.status='posted'),0)
  INTO outstanding FROM public.petro_finance_receipt_allocations allocation
  WHERE allocation.target_type='topup' AND allocation.target_id=request_row.id;
  IF outstanding<=0 THEN RAISE EXCEPTION 'TOPUP_ALREADY_FUNDED' USING ERRCODE='55000'; END IF;
  actual_allocation:=COALESCE(p_allocation_amount_minor,LEAST(p_actual_amount_minor,outstanding));
  IF actual_allocation>LEAST(p_actual_amount_minor,outstanding) THEN
    RAISE EXCEPTION 'TOPUP_ALLOCATION_EXCEEDS_REQUEST_OR_RECEIPT' USING ERRCODE='23514';
  END IF;
  IF existing_receipt IS NULL THEN
    v_receipt_id:=petro_private.finance_record_receipt(
      request_row.organization_id,NULL,p_bank_account_id,request_row.payer_bank_name,
      request_row.bank_reference,p_actual_amount_minor,p_reason,request_row.id,false
    );
  ELSE
    v_receipt_id:=existing_receipt;
    SELECT amount_minor INTO receipt_amount FROM public.petro_finance_bank_receipts
    WHERE id=v_receipt_id AND organization_id=request_row.organization_id;
    IF NOT FOUND OR receipt_amount<>p_actual_amount_minor THEN
      RAISE EXCEPTION 'RECEIPT_AMOUNT_OR_ORGANIZATION_MISMATCH' USING ERRCODE='23514';
    END IF;
  END IF;
  allocation_id:=petro_private.finance_allocate_receipt(
    v_receipt_id,'topup',request_row.id,actual_allocation,p_reason,true
  );
  result:=jsonb_build_object('id',request_row.id,'receiptId',v_receipt_id,
    'allocationId',allocation_id,'status',(SELECT status FROM public.petro_finance_topup_requests WHERE id=request_row.id),
    'actualAmountMinor',p_actual_amount_minor::text,'allocatedAmountMinor',actual_allocation::text,
    'unallocatedAmountMinor',(SELECT receipt.amount_minor-COALESCE(sum(allocation.amount_minor)
      FILTER (WHERE allocation.status='posted'),0)
      FROM public.petro_finance_bank_receipts receipt
      LEFT JOIN public.petro_finance_receipt_allocations allocation ON allocation.receipt_id=receipt.id
      WHERE receipt.id=v_receipt_id GROUP BY receipt.id)::text,
    'currency','EGP','message','تمت مطابقة التحويل وتسجيل القبض والتخصيص في معاملة واحدة. أي فائض بقي غير مخصص.');
  PERFORM petro_private.finance_finish_command('topup.approve',p_idempotency_key,result);
  RETURN result;
END
$$;

CREATE FUNCTION public.petro_finance_admin_list_receipts(
  p_search text DEFAULT NULL, p_page integer DEFAULT 1, p_page_size integer DEFAULT 20
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE items jsonb; total_count bigint; search_value text:=nullif(btrim(p_search),'');
  is_finance boolean:=petro_private.platform_has(ARRAY['owner','finance']::text[]);
BEGIN
  IF NOT petro_private.finance_can_read() OR p_page NOT BETWEEN 1 AND 100000
     OR p_page_size NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'FORBIDDEN_OR_INVALID_PAGE' USING ERRCODE='42501'; END IF;
  SELECT count(*) INTO total_count
  FROM public.petro_finance_bank_receipts receipt
  JOIN public.petro_organizations organization ON organization.id=receipt.organization_id
  WHERE search_value IS NULL OR organization.name ILIKE '%'||search_value||'%'
    OR receipt.receipt_number ILIKE '%'||search_value||'%'
    OR receipt.bank_reference ILIKE '%'||search_value||'%';
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',rows.id,'receiptNumber',rows.receipt_number,'organizationId',rows.organization_id,
    'organizationName',rows.organization_name,'branchId',rows.branch_id,'amountMinor',rows.amount_minor,
    'currency','EGP','payerBankName',rows.payer_bank_name,
    'bankReference',CASE WHEN is_finance THEN rows.bank_reference ELSE NULL END,
    'maskedReference',right(rows.bank_reference,4),'reason',rows.reason,'status',rows.status,
    'recordedBy',rows.recorded_by,'createdAt',rows.created_at,'allocatedMinor',rows.allocated_minor,
    'unallocatedMinor',rows.unallocated_minor
  ) ORDER BY rows.created_at DESC),'[]'::jsonb) INTO items
  FROM (
    SELECT receipt.*,organization.name AS organization_name,
      COALESCE((SELECT sum(allocation.amount_minor) FROM public.petro_finance_receipt_allocations allocation
        WHERE allocation.receipt_id=receipt.id AND allocation.status='posted'),0)::text AS allocated_minor,
      (receipt.amount_minor-COALESCE((SELECT sum(allocation.amount_minor) FROM public.petro_finance_receipt_allocations allocation
        WHERE allocation.receipt_id=receipt.id AND allocation.status='posted'),0))::text AS unallocated_minor
    FROM public.petro_finance_bank_receipts receipt
    JOIN public.petro_organizations organization ON organization.id=receipt.organization_id
    WHERE search_value IS NULL OR organization.name ILIKE '%'||search_value||'%'
      OR receipt.receipt_number ILIKE '%'||search_value||'%'
      OR receipt.bank_reference ILIKE '%'||search_value||'%'
    ORDER BY receipt.created_at DESC,receipt.id
    LIMIT p_page_size OFFSET (p_page-1)*p_page_size
  ) rows;
  RETURN jsonb_build_object('items',items,'page',p_page,'pageSize',p_page_size,
    'total',total_count,'totalPages',CEIL(total_count::numeric/p_page_size)::integer);
END
$$;

CREATE FUNCTION public.petro_finance_admin_allocate_receipt(
  p_receipt_id uuid, p_target_type text, p_target_id uuid,
  p_amount_minor bigint, p_reason text, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE cached jsonb; allocation_id uuid; result jsonb;
BEGIN
  IF NOT petro_private.finance_can_mutate() THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  cached:=petro_private.finance_begin_command('receipt.allocate',p_idempotency_key,
    jsonb_build_object('receiptId',p_receipt_id,'targetType',p_target_type,
      'targetId',p_target_id,'amountMinor',p_amount_minor,'reason',btrim(p_reason)));
  IF cached IS NOT NULL THEN RETURN cached; END IF;
  allocation_id:=petro_private.finance_allocate_receipt(
    p_receipt_id,p_target_type,p_target_id,p_amount_minor,p_reason,false
  );
  result:=jsonb_build_object('id',allocation_id,'receiptId',p_receipt_id,
    'targetType',p_target_type,'targetId',p_target_id,'amountMinor',p_amount_minor::text,
    'currency','EGP','message','تم تخصيص جزء من إيصال مؤكد؛ لا يتجاوز إجمالي التخصيص قيمة الإيصال.');
  PERFORM petro_private.finance_finish_command('receipt.allocate',p_idempotency_key,result);
  RETURN result;
END
$$;

REVOKE ALL ON FUNCTION petro_private.finance_record_receipt(uuid,uuid,uuid,text,text,bigint,text,uuid,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION petro_private.finance_allocate_receipt(uuid,text,uuid,bigint,text,boolean) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.petro_finance_admin_transfer(
  p_organization_id uuid, p_source_branch_id uuid, p_target_branch_id uuid,
  p_amount_minor bigint, p_reference text, p_reason text, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE cached jsonb; source_account uuid; target_account uuid; entry_id uuid:=gen_random_uuid();
  transfer_id uuid:=gen_random_uuid(); available_value bigint; result jsonb;
BEGIN
  IF NOT petro_private.finance_can_mutate() THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF p_organization_id IS NULL OR p_amount_minor NOT BETWEEN 1 AND 1000000000000
     OR length(btrim(coalesce(p_reference,''))) NOT BETWEEN 2 AND 160
     OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 5 AND 500
     OR ((p_source_branch_id IS NULL)=(p_target_branch_id IS NULL)) THEN
    RAISE EXCEPTION 'INVALID_INTERNAL_TRANSFER' USING ERRCODE='22023';
  END IF;
  cached:=petro_private.finance_begin_command('transfer.create',p_idempotency_key,
    jsonb_build_object('organizationId',p_organization_id,'sourceBranchId',p_source_branch_id,
      'targetBranchId',p_target_branch_id,'amountMinor',p_amount_minor,
      'reference',btrim(p_reference),'reason',btrim(p_reason)));
  IF cached IS NOT NULL THEN RETURN cached; END IF;
  source_account:=petro_private.finance_account_for_scope(p_organization_id,p_source_branch_id);
  target_account:=petro_private.finance_account_for_scope(p_organization_id,p_target_branch_id);
  PERFORM account.id FROM public.petro_finance_accounts account
  WHERE account.id IN (source_account,target_account) ORDER BY account.id FOR UPDATE;
  SELECT balance.available_minor INTO available_value
  FROM public.petro_finance_account_balances balance WHERE balance.account_id=source_account;
  IF available_value IS NULL OR available_value<p_amount_minor THEN
    RAISE EXCEPTION 'INSUFFICIENT_AVAILABLE_FUNDS' USING ERRCODE='23514';
  END IF;
  PERFORM petro_private.finance_post_entry(
    entry_id,'internal_transfer',transfer_id,p_organization_id,btrim(p_reference),btrim(p_reason),
    jsonb_build_array(
      jsonb_build_object('accountId',source_account,'side','debit','amountMinor',p_amount_minor::text),
      jsonb_build_object('accountId',target_account,'side','credit','amountMinor',p_amount_minor::text)
    )
  );
  INSERT INTO public.petro_finance_transfers(
    id,organization_id,source_account_id,target_account_id,amount_minor,
    reference,reason,created_by,journal_entry_id
  ) VALUES (
    transfer_id,p_organization_id,source_account,target_account,p_amount_minor,
    btrim(p_reference),btrim(p_reason),auth.uid(),entry_id
  );
  result:=jsonb_build_object('id',transfer_id,'journalEntryId',entry_id,
    'organizationId',p_organization_id,'sourceAccountId',source_account,
    'targetAccountId',target_account,'amountMinor',p_amount_minor::text,'currency','EGP',
    'reference',btrim(p_reference),'message','تم النقل داخل حسابات الشركة؛ لم يتغير إجمالي تمويلها.');
  PERFORM petro_private.finance_finish_command('transfer.create',p_idempotency_key,result);
  RETURN result;
END
$$;

CREATE FUNCTION public.petro_finance_admin_list_transfers(
  p_organization_id uuid DEFAULT NULL, p_page integer DEFAULT 1, p_page_size integer DEFAULT 20
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE items jsonb; total_count bigint;
BEGIN
  IF NOT petro_private.finance_can_read() OR p_page NOT BETWEEN 1 AND 100000
     OR p_page_size NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'FORBIDDEN_OR_INVALID_PAGE' USING ERRCODE='42501'; END IF;
  SELECT count(*) INTO total_count FROM public.petro_finance_transfers transfer
  WHERE p_organization_id IS NULL OR transfer.organization_id=p_organization_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',rows.id,'organizationId',rows.organization_id,'organizationName',rows.organization_name,
    'sourceAccountId',rows.source_account_id,'sourceAccountName',rows.source_account_name,
    'targetAccountId',rows.target_account_id,'targetAccountName',rows.target_account_name,
    'amountMinor',rows.amount_minor,'reference',rows.reference,'reason',rows.reason,
    'createdBy',rows.created_by,'createdAt',rows.created_at,'journalEntryId',rows.journal_entry_id
  ) ORDER BY rows.created_at DESC),'[]'::jsonb) INTO items
  FROM (
    SELECT transfer.*,organization.name AS organization_name,
      source.display_name AS source_account_name,target.display_name AS target_account_name
    FROM public.petro_finance_transfers transfer
    JOIN public.petro_organizations organization ON organization.id=transfer.organization_id
    JOIN public.petro_finance_accounts source ON source.id=transfer.source_account_id
    JOIN public.petro_finance_accounts target ON target.id=transfer.target_account_id
    WHERE p_organization_id IS NULL OR transfer.organization_id=p_organization_id
    ORDER BY transfer.created_at DESC,transfer.id
    LIMIT p_page_size OFFSET (p_page-1)*p_page_size
  ) rows;
  RETURN jsonb_build_object('items',items,'page',p_page,'pageSize',p_page_size,
    'total',total_count,'totalPages',CEIL(total_count::numeric/p_page_size)::integer);
END
$$;

CREATE FUNCTION public.petro_finance_admin_list_subscriptions(
  p_search text DEFAULT NULL, p_status text DEFAULT NULL,
  p_page integer DEFAULT 1, p_page_size integer DEFAULT 20
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE items jsonb; total_count bigint; search_value text:=nullif(btrim(p_search),'');
BEGIN
  IF NOT petro_private.finance_can_read() OR p_page NOT BETWEEN 1 AND 100000
     OR p_page_size NOT BETWEEN 1 AND 100
     OR (p_status IS NOT NULL AND p_status NOT IN ('unpaid','partially_collected','collected_on_hold','reversed')) THEN
    RAISE EXCEPTION 'FORBIDDEN_OR_INVALID_FILTER' USING ERRCODE='42501';
  END IF;
  SELECT count(*) INTO total_count
  FROM public.petro_subscriptions subscription
  JOIN public.petro_organizations organization ON organization.id=subscription.organization_id
  LEFT JOIN public.petro_branches branch ON branch.id=subscription.branch_id
  WHERE subscription.status='pending_payment'
    AND (p_status IS NULL OR COALESCE((
      SELECT collection.status FROM public.petro_finance_subscription_collections collection
      WHERE collection.subscription_id=subscription.id
    ),'unpaid')=p_status)
    AND (search_value IS NULL OR organization.name ILIKE '%'||search_value||'%'
      OR branch.name ILIKE '%'||search_value||'%' OR subscription.id::text ILIKE '%'||search_value||'%');
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'subscriptionId',rows.subscription_id,'requestId',rows.request_id,
    'organizationId',rows.organization_id,'organizationName',rows.organization_name,
    'branchId',rows.branch_id,'branchName',rows.branch_name,
    'planId',rows.plan_id,'planName',rows.plan_name,'planVersionId',rows.plan_version_id,
    'snapshotPriceMinor',rows.price_snapshot_minor,'units',rows.units,
    'amountDueMinor',rows.amount_due_minor,'amountCollectedMinor',rows.amount_collected_minor,
    'currency','EGP','collectionStatus',rows.collection_status,
    'activationBlocker',rows.activation_blocker,'subscriptionStatus',rows.subscription_status,
    'startsAt',rows.starts_at,'endsAt',rows.ends_at,'requestReviewedBy',rows.reviewed_by
  ) ORDER BY rows.starts_at DESC),'[]'::jsonb) INTO items
  FROM (
    SELECT subscription.id AS subscription_id,subscription.request_id,subscription.organization_id,
      organization.name AS organization_name,subscription.branch_id,branch.name AS branch_name,
      subscription.plan_id,plan.name AS plan_name,subscription.plan_version_id,
      subscription.price_snapshot_minor::text,subscription.units,
      COALESCE(collection.amount_due_minor,(subscription.price_snapshot_minor::numeric*subscription.units)::bigint)::text AS amount_due_minor,
      COALESCE(collection.amount_collected_minor,0)::text AS amount_collected_minor,
      COALESCE(collection.status,'unpaid') AS collection_status,
      COALESCE(collection.activation_blocker,'subscription_accounting_policy_unconfigured') AS activation_blocker,
      subscription.status AS subscription_status,subscription.starts_at,subscription.ends_at,
      request.reviewed_by
    FROM public.petro_subscriptions subscription
    JOIN public.petro_organizations organization ON organization.id=subscription.organization_id
    LEFT JOIN public.petro_branches branch ON branch.id=subscription.branch_id
    JOIN public.petro_plans plan ON plan.id=subscription.plan_id
    JOIN public.petro_subscription_requests request ON request.id=subscription.request_id
    LEFT JOIN public.petro_finance_subscription_collections collection ON collection.subscription_id=subscription.id
    WHERE subscription.status='pending_payment'
      AND (p_status IS NULL OR COALESCE(collection.status,'unpaid')=p_status)
      AND (search_value IS NULL OR organization.name ILIKE '%'||search_value||'%'
        OR branch.name ILIKE '%'||search_value||'%' OR subscription.id::text ILIKE '%'||search_value||'%')
    ORDER BY subscription.starts_at DESC,subscription.id
    LIMIT p_page_size OFFSET (p_page-1)*p_page_size
  ) rows;
  RETURN jsonb_build_object('items',items,'page',p_page,'pageSize',p_page_size,
    'total',total_count,'totalPages',CEIL(total_count::numeric/p_page_size)::integer);
END
$$;

CREATE FUNCTION public.petro_finance_admin_list_journal(
  p_organization_id uuid DEFAULT NULL, p_account_id uuid DEFAULT NULL,
  p_entry_type text DEFAULT NULL, p_search text DEFAULT NULL,
  p_page integer DEFAULT 1, p_page_size integer DEFAULT 20
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE items jsonb; total_count bigint; search_value text:=nullif(btrim(p_search),'');
BEGIN
  IF NOT petro_private.finance_can_read() OR p_page NOT BETWEEN 1 AND 100000
     OR p_page_size NOT BETWEEN 1 AND 100
     OR (p_entry_type IS NOT NULL AND p_entry_type NOT IN (
       'bank_receipt','topup_allocation','subscription_collection','internal_transfer','reversal'
     )) THEN RAISE EXCEPTION 'FORBIDDEN_OR_INVALID_FILTER' USING ERRCODE='42501'; END IF;
  SELECT count(*) INTO total_count
  FROM public.petro_finance_journal_entries entry
  LEFT JOIN public.petro_organizations organization ON organization.id=entry.organization_id
  WHERE (p_organization_id IS NULL OR entry.organization_id=p_organization_id)
    AND (p_entry_type IS NULL OR entry.entry_type=p_entry_type)
    AND (p_account_id IS NULL OR EXISTS (
      SELECT 1 FROM public.petro_finance_journal_lines line
      WHERE line.entry_id=entry.id AND line.account_id=p_account_id
    ))
    AND (search_value IS NULL OR entry.reference ILIKE '%'||search_value||'%'
      OR entry.reason ILIKE '%'||search_value||'%' OR organization.name ILIKE '%'||search_value||'%'
      OR entry.id::text ILIKE '%'||search_value||'%');
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',rows.id,'entryType',rows.entry_type,'sourceId',rows.source_id,
    'organizationId',rows.organization_id,'organizationName',rows.organization_name,
    'reference',rows.reference,'reason',rows.reason,'actorId',rows.actor_id,
    'actorName',rows.actor_name,'occurredAt',rows.occurred_at,
    'debitMinor',rows.debit_minor,'creditMinor',rows.credit_minor,'reversesEntryId',rows.reverses_entry_id
  ) ORDER BY rows.occurred_at DESC),'[]'::jsonb) INTO items
  FROM (
    SELECT entry.*,organization.name AS organization_name,profile.display_name AS actor_name,
      COALESCE(sum(line.amount_minor) FILTER (WHERE line.side='debit'),0)::text AS debit_minor,
      COALESCE(sum(line.amount_minor) FILTER (WHERE line.side='credit'),0)::text AS credit_minor
    FROM public.petro_finance_journal_entries entry
    LEFT JOIN public.petro_organizations organization ON organization.id=entry.organization_id
    LEFT JOIN public.petro_profiles profile ON profile.user_id=entry.actor_id
    JOIN public.petro_finance_journal_lines line ON line.entry_id=entry.id
    WHERE (p_organization_id IS NULL OR entry.organization_id=p_organization_id)
      AND (p_entry_type IS NULL OR entry.entry_type=p_entry_type)
      AND (p_account_id IS NULL OR EXISTS (
        SELECT 1 FROM public.petro_finance_journal_lines selected_line
        WHERE selected_line.entry_id=entry.id AND selected_line.account_id=p_account_id
      ))
      AND (search_value IS NULL OR entry.reference ILIKE '%'||search_value||'%'
        OR entry.reason ILIKE '%'||search_value||'%' OR organization.name ILIKE '%'||search_value||'%'
        OR entry.id::text ILIKE '%'||search_value||'%')
    GROUP BY entry.id,organization.name,profile.display_name
    ORDER BY entry.occurred_at DESC,entry.id
    LIMIT p_page_size OFFSET (p_page-1)*p_page_size
  ) rows;
  RETURN jsonb_build_object('items',items,'page',p_page,'pageSize',p_page_size,
    'total',total_count,'totalPages',CEIL(total_count::numeric/p_page_size)::integer);
END
$$;

CREATE FUNCTION public.petro_finance_admin_journal_detail(p_entry_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE result jsonb;
BEGIN
  IF NOT petro_private.finance_can_read() THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT jsonb_build_object(
    'id',entry.id,'entryType',entry.entry_type,'sourceId',entry.source_id,
    'organizationId',entry.organization_id,'organizationName',organization.name,
    'reference',entry.reference,'reason',entry.reason,'currency',entry.currency,
    'actorId',entry.actor_id,'actorName',profile.display_name,'occurredAt',entry.occurred_at,
    'reversesEntryId',entry.reverses_entry_id,
    'lines',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'accountId',account.id,'accountName',account.display_name,'accountKind',account.account_kind,
      'side',line.side,'amountMinor',line.amount_minor::text,'currency',line.currency
    ) ORDER BY line.id) FROM public.petro_finance_journal_lines line
      JOIN public.petro_finance_accounts account ON account.id=line.account_id
      WHERE line.entry_id=entry.id),'[]'::jsonb)
  ) INTO result
  FROM public.petro_finance_journal_entries entry
  LEFT JOIN public.petro_organizations organization ON organization.id=entry.organization_id
  LEFT JOIN public.petro_profiles profile ON profile.user_id=entry.actor_id
  WHERE entry.id=p_entry_id;
  IF result IS NULL THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN result;
END
$$;

CREATE FUNCTION public.petro_finance_admin_reconciliation() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE unbalanced bigint; overallocated_receipts bigint; overfunded_topups bigint;
  mismatched_collections bigint; negative_accounts bigint; items jsonb;
BEGIN
  IF NOT petro_private.finance_can_read() THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT count(*) INTO unbalanced
  FROM (
    SELECT entry.id
    FROM public.petro_finance_journal_entries entry
    LEFT JOIN public.petro_finance_journal_lines line ON line.entry_id=entry.id
    GROUP BY entry.id
    HAVING count(line.id)<2
      OR COALESCE(sum(line.amount_minor) FILTER (WHERE line.side='debit'),0)
         <> COALESCE(sum(line.amount_minor) FILTER (WHERE line.side='credit'),0)
  ) bad;
  SELECT count(*) INTO overallocated_receipts
  FROM public.petro_finance_bank_receipts receipt
  WHERE COALESCE((SELECT sum(allocation.amount_minor) FROM public.petro_finance_receipt_allocations allocation
    WHERE allocation.receipt_id=receipt.id AND allocation.status='posted'),0)>receipt.amount_minor;
  SELECT count(*) INTO overfunded_topups
  FROM public.petro_finance_topup_requests request
  WHERE COALESCE((SELECT sum(allocation.amount_minor) FROM public.petro_finance_receipt_allocations allocation
    WHERE allocation.target_type='topup' AND allocation.target_id=request.id AND allocation.status='posted'),0)
    >request.requested_amount_minor;
  SELECT count(*) INTO mismatched_collections
  FROM public.petro_finance_subscription_collections collection
  WHERE collection.amount_collected_minor<>COALESCE((
    SELECT sum(allocation.amount_minor) FROM public.petro_finance_receipt_allocations allocation
    WHERE allocation.target_type='subscription' AND allocation.target_id=collection.subscription_id
      AND allocation.status='posted'
  ),0) OR collection.amount_collected_minor>collection.amount_due_minor;
  SELECT count(*) INTO negative_accounts
  FROM public.petro_finance_account_balances balance
  WHERE balance.ledger_balance_minor<0 OR balance.available_minor<0;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'accountId',balance.account_id,'accountName',balance.display_name,'accountKind',balance.account_kind,
    'ledgerBalanceMinor',balance.ledger_balance_minor::text,'reservedMinor',balance.reserved_minor::text,
    'availableMinor',balance.available_minor::text
  ) ORDER BY balance.account_code),'[]'::jsonb) INTO items
  FROM public.petro_finance_account_balances balance
  WHERE balance.ledger_balance_minor<0 OR balance.available_minor<0;
  RETURN jsonb_build_object(
    'status',CASE WHEN unbalanced+overallocated_receipts+overfunded_topups+mismatched_collections+negative_accounts=0
      THEN 'balanced' ELSE 'issues_found' END,
    'unbalancedEntries',unbalanced,'overallocatedReceipts',overallocated_receipts,
    'overfundedTopups',overfunded_topups,'mismatchedSubscriptionCollections',mismatched_collections,
    'negativeOrOverreservedAccounts',negative_accounts,'issues',items,
    'autoRepairPerformed',false,'checkedAt',clock_timestamp()
  );
END
$$;

CREATE FUNCTION public.petro_finance_admin_reverse_journal(
  p_entry_id uuid, p_reason text, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE cached jsonb; original public.petro_finance_journal_entries%ROWTYPE;
  reversal_id uuid:=gen_random_uuid(); ref text; lines jsonb; amount_delta bigint;
  account_row record; current_balance bigint; reserved_amount bigint; result jsonb;
  affected_receipt_id uuid;
BEGIN
  IF NOT petro_private.finance_can_mutate() THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF p_entry_id IS NULL OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'INVALID_REVERSAL' USING ERRCODE='22023';
  END IF;
  cached:=petro_private.finance_begin_command('journal.reverse',p_idempotency_key,
    jsonb_build_object('entryId',p_entry_id,'reason',btrim(p_reason)));
  IF cached IS NOT NULL THEN RETURN cached; END IF;
  SELECT * INTO original FROM public.petro_finance_journal_entries
  WHERE id=p_entry_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF original.entry_type='reversal' OR EXISTS (
    SELECT 1 FROM public.petro_finance_journal_entries WHERE reverses_entry_id=original.id
  ) THEN RAISE EXCEPTION 'JOURNAL_ENTRY_ALREADY_REVERSED' USING ERRCODE='23505'; END IF;
  IF original.entry_type='bank_receipt' AND EXISTS (
    SELECT 1 FROM public.petro_finance_receipt_allocations allocation
    WHERE allocation.receipt_id=original.source_id AND allocation.status='posted'
  ) THEN RAISE EXCEPTION 'REVERSE_RECEIPT_ALLOCATIONS_FIRST' USING ERRCODE='55000'; END IF;
  PERFORM account.id FROM public.petro_finance_accounts account
  WHERE account.id IN (SELECT line.account_id FROM public.petro_finance_journal_lines line WHERE line.entry_id=original.id)
  ORDER BY account.id FOR UPDATE;
  FOR account_row IN
    SELECT DISTINCT account.id AS account_id,account.account_kind,account.normal_side
    FROM public.petro_finance_journal_lines original_line
    JOIN public.petro_finance_accounts account ON account.id=original_line.account_id
    WHERE original_line.entry_id=original.id
  LOOP
    SELECT CASE WHEN account_row.normal_side='credit'
      THEN COALESCE(sum(CASE WHEN line.side='credit' THEN line.amount_minor ELSE -line.amount_minor END),0)
      ELSE COALESCE(sum(CASE WHEN line.side='debit' THEN line.amount_minor ELSE -line.amount_minor END),0)
      END::bigint INTO current_balance
    FROM public.petro_finance_journal_lines line
    WHERE line.account_id=account_row.account_id;
    SELECT COALESCE(sum(reservation.amount_minor),0)::bigint INTO reserved_amount
    FROM public.petro_finance_reservations reservation
    WHERE reservation.account_id=account_row.account_id AND reservation.status='active';
    SELECT COALESCE(sum(CASE
      WHEN (account_row.normal_side='credit' AND line.side='debit')
        OR (account_row.normal_side='debit' AND line.side='credit')
      THEN line.amount_minor ELSE -line.amount_minor END),0)::bigint
    INTO amount_delta
    FROM public.petro_finance_journal_lines line
    WHERE line.entry_id=original.id AND line.account_id=account_row.account_id;
    IF current_balance+amount_delta<0
       OR (account_row.account_kind IN ('company_funding','branch_funding')
         AND current_balance+amount_delta-reserved_amount<0) THEN
      RAISE EXCEPTION 'REVERSAL_WOULD_CREATE_NEGATIVE_OR_RESERVED_BALANCE' USING ERRCODE='23514';
    END IF;
  END LOOP;
  ref:='REV-'||upper(substr(replace(reversal_id::text,'-',''),1,16));
  SELECT jsonb_agg(jsonb_build_object(
    'accountId',line.account_id,'side',CASE line.side WHEN 'debit' THEN 'credit' ELSE 'debit' END,
    'amountMinor',line.amount_minor::text
  ) ORDER BY line.id) INTO lines
  FROM public.petro_finance_journal_lines line WHERE line.entry_id=original.id;
  PERFORM petro_private.finance_post_entry(
    reversal_id,'reversal',original.id,original.organization_id,ref,btrim(p_reason),lines,original.id
  );
  IF original.entry_type='bank_receipt' THEN
    UPDATE public.petro_finance_bank_receipts SET status='reversed'
    WHERE id=original.source_id;
  ELSIF original.entry_type IN ('topup_allocation','subscription_collection') THEN
    UPDATE public.petro_finance_receipt_allocations SET status='reversed',
      reversed_by=auth.uid(),reversed_at=now()
    WHERE journal_entry_id=original.id AND status='posted';
    SELECT receipt_id INTO affected_receipt_id
    FROM public.petro_finance_receipt_allocations WHERE journal_entry_id=original.id;
    IF original.entry_type='topup_allocation' THEN
      UPDATE public.petro_finance_topup_requests request
      SET status=CASE WHEN COALESCE((SELECT sum(allocation.amount_minor)
        FROM public.petro_finance_receipt_allocations allocation
        WHERE allocation.target_type='topup' AND allocation.target_id=request.id
          AND allocation.status='posted'),0)=0 THEN 'submitted' ELSE 'partially_funded' END,
        version=version+1,updated_at=now()
      WHERE request.id=(SELECT target_id FROM public.petro_finance_receipt_allocations WHERE journal_entry_id=original.id);
    ELSE
      UPDATE public.petro_finance_subscription_collections collection
      SET amount_collected_minor=GREATEST(0,amount_collected_minor-(
          SELECT sum(line.amount_minor) FROM public.petro_finance_journal_lines line
          WHERE line.entry_id=original.id AND line.side='credit'
        )),
        status=CASE WHEN amount_collected_minor=(
          SELECT sum(line.amount_minor) FROM public.petro_finance_journal_lines line
          WHERE line.entry_id=original.id AND line.side='credit'
        ) THEN 'unpaid' ELSE 'partially_collected' END,
        updated_at=now()
      WHERE collection.subscription_id=(SELECT target_id FROM public.petro_finance_receipt_allocations WHERE journal_entry_id=original.id);
    END IF;
    UPDATE public.petro_finance_bank_receipts receipt_row
    SET status=CASE
      WHEN COALESCE((SELECT sum(allocation.amount_minor)
        FROM public.petro_finance_receipt_allocations allocation
        WHERE allocation.receipt_id=receipt_row.id AND allocation.status='posted'),0)=0
        THEN 'confirmed'
      WHEN COALESCE((SELECT sum(allocation.amount_minor)
        FROM public.petro_finance_receipt_allocations allocation
        WHERE allocation.receipt_id=receipt_row.id AND allocation.status='posted'),0)=receipt_row.amount_minor
        THEN 'fully_allocated'
      ELSE 'partially_allocated' END
    WHERE receipt_row.id=affected_receipt_id;
  END IF;
  result:=jsonb_build_object('id',reversal_id,'reversesEntryId',original.id,
    'reference',ref,'status','posted','message','أُنشئ قيد عكسي مرتبط بالأصل؛ لم يُعدّل القيد السابق.');
  PERFORM petro_private.finance_finish_command('journal.reverse',p_idempotency_key,result);
  RETURN result;
END
$$;

CREATE FUNCTION petro_private.finance_reserve_funds(
  p_account_id uuid, p_source_type text, p_source_id uuid,
  p_amount_minor bigint, p_reason text, p_actor_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE account public.petro_finance_accounts%ROWTYPE; available_value bigint; reservation_id uuid;
BEGIN
  IF p_actor_id IS NULL OR p_amount_minor NOT BETWEEN 1 AND 1000000000000
     OR length(btrim(coalesce(p_source_type,''))) NOT BETWEEN 2 AND 60
     OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'INVALID_FUND_RESERVATION' USING ERRCODE='22023';
  END IF;
  SELECT * INTO account FROM public.petro_finance_accounts WHERE id=p_account_id FOR UPDATE;
  IF NOT FOUND OR account.account_kind NOT IN ('company_funding','branch_funding') THEN
    RAISE EXCEPTION 'FUNDING_ACCOUNT_REQUIRED' USING ERRCODE='55000';
  END IF;
  SELECT balance.available_minor INTO available_value
  FROM public.petro_finance_account_balances balance WHERE balance.account_id=account.id;
  IF available_value<p_amount_minor THEN RAISE EXCEPTION 'INSUFFICIENT_AVAILABLE_FUNDS' USING ERRCODE='23514'; END IF;
  INSERT INTO public.petro_finance_reservations(
    account_id,source_type,source_id,amount_minor,reason,created_by
  ) VALUES (p_account_id,btrim(p_source_type),p_source_id,p_amount_minor,btrim(p_reason),p_actor_id)
  RETURNING id INTO reservation_id;
  RETURN reservation_id;
END
$$;

CREATE FUNCTION petro_private.finance_release_reservation(
  p_reservation_id uuid, p_actor_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE reservation public.petro_finance_reservations%ROWTYPE;
BEGIN
  SELECT * INTO reservation FROM public.petro_finance_reservations
  WHERE id=p_reservation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM public.petro_finance_accounts WHERE id=reservation.account_id FOR UPDATE;
  IF reservation.status='released' THEN RETURN; END IF;
  IF reservation.status<>'active' OR p_actor_id IS NULL THEN
    RAISE EXCEPTION 'RESERVATION_NOT_RELEASABLE' USING ERRCODE='55000';
  END IF;
  UPDATE public.petro_finance_reservations
  SET status='released',closed_by=p_actor_id,closed_at=now()
  WHERE id=reservation.id;
END
$$;

REVOKE ALL ON FUNCTION petro_private.finance_reserve_funds(uuid,text,uuid,bigint,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION petro_private.finance_release_reservation(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.petro_finance_admin_transfer(uuid,uuid,uuid,bigint,text,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.petro_finance_admin_list_transfers(uuid,integer,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.petro_finance_admin_list_subscriptions(text,text,integer,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.petro_finance_admin_list_journal(uuid,uuid,text,text,integer,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.petro_finance_admin_journal_detail(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.petro_finance_admin_reconciliation() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.petro_finance_admin_reverse_journal(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_admin_transfer(uuid,uuid,uuid,bigint,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_admin_list_transfers(uuid,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_admin_list_subscriptions(text,text,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_admin_list_journal(uuid,uuid,text,text,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_admin_journal_detail(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_admin_reconciliation() TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_admin_reverse_journal(uuid,text,text) TO authenticated;

CREATE FUNCTION public.petro_finance_admin_disable_bank_account(
  p_bank_account_id uuid, p_reason text, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE cached jsonb; bank public.petro_finance_bank_accounts%ROWTYPE; result jsonb;
BEGIN
  IF NOT petro_private.finance_can_mutate() THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF p_bank_account_id IS NULL OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'INVALID_BANK_ACCOUNT_DISABLE' USING ERRCODE='22023';
  END IF;
  cached:=petro_private.finance_begin_command('bank_account.disable',p_idempotency_key,
    jsonb_build_object('id',p_bank_account_id,'reason',btrim(p_reason)));
  IF cached IS NOT NULL THEN RETURN cached; END IF;
  SELECT * INTO bank FROM public.petro_finance_bank_accounts
  WHERE id=p_bank_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF bank.status<>'active' THEN RAISE EXCEPTION 'BANK_ACCOUNT_NOT_ACTIVE' USING ERRCODE='55000'; END IF;
  UPDATE public.petro_finance_bank_accounts SET status='disabled',
    disabled_by=auth.uid(),disabled_at=now(),disable_reason=btrim(p_reason)
  WHERE id=bank.id;
  INSERT INTO public.petro_audit_events(actor_id,action,target_id,detail)
  VALUES(auth.uid(),'finance.receiving_bank_account.disabled',bank.id,
    jsonb_build_object('reason',btrim(p_reason),'last4',bank.account_last4));
  result:=jsonb_build_object('id',bank.id,'status','disabled','message','أُوقف الحساب للاستقبالات المستقبلية؛ لم تُحذف الحركات السابقة.');
  PERFORM petro_private.finance_finish_command('bank_account.disable',p_idempotency_key,result);
  RETURN result;
END
$$;

CREATE FUNCTION public.petro_finance_admin_topup_detail(p_topup_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE result jsonb;
BEGIN
  IF NOT petro_private.finance_can_read()
     AND NOT petro_private.platform_has(ARRAY['operations']::text[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501';
  END IF;
  SELECT jsonb_build_object(
    'id',request.id,'organizationId',request.organization_id,'organizationName',organization.name,
    'requestedAmountMinor',request.requested_amount_minor::text,'currency','EGP',
    'payerBankName',request.payer_bank_name,
    'bankReference',CASE WHEN petro_private.platform_has(ARRAY['owner','finance']::text[])
      OR request.submitted_by=auth.uid() THEN request.bank_reference ELSE NULL END,
    'maskedReference',right(request.bank_reference,4),'reason',request.reason,'status',request.status,
    'submittedBy',request.submitted_by,'reviewedBy',request.reviewed_by,
    'reviewedAt',request.reviewed_at,'decisionReason',request.decision_reason,
    'version',request.version,'createdAt',request.created_at,'updatedAt',request.updated_at,
    'allocations',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id',allocation.id,'receiptId',allocation.receipt_id,'amountMinor',allocation.amount_minor::text,
      'status',allocation.status,'reason',allocation.reason,'allocatedBy',allocation.allocated_by,
      'createdAt',allocation.created_at,'journalEntryId',allocation.journal_entry_id
    ) ORDER BY allocation.created_at,allocation.id)
      FROM public.petro_finance_receipt_allocations allocation
      WHERE allocation.target_type='topup' AND allocation.target_id=request.id),'[]'::jsonb),
    'evidence',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id',document.id,'documentType',document.document_type,'fileName',document.file_name,
      'contentType',document.content_type,'byteSize',document.byte_size,'status',document.status,
      'uploadedAt',document.uploaded_at
    ) ORDER BY document.created_at,document.id)
      FROM public.petro_documents document
      WHERE document.finance_topup_request_id=request.id AND document.uploaded_at IS NOT NULL),'[]'::jsonb)
  ) INTO result
  FROM public.petro_finance_topup_requests request
  JOIN public.petro_organizations organization ON organization.id=request.organization_id
  WHERE request.id=p_topup_id
    AND (petro_private.platform_has(ARRAY['owner','finance','auditor']::text[])
      OR request.submitted_by=auth.uid());
  IF result IS NULL THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN result;
END
$$;

REVOKE ALL ON FUNCTION petro_private.finance_can_read() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION petro_private.finance_can_mutate() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION petro_private.finance_can_submit() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION petro_private.finance_begin_command(text,text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION petro_private.finance_finish_command(text,text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION petro_private.finance_post_entry(uuid,text,uuid,uuid,text,text,jsonb,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION petro_private.finance_account_for_scope(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION petro_private.finance_bank_asset(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION petro_private.finance_normalize_reference(text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION petro_private.guard_finance_journal_immutable() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION petro_private.assert_finance_entry_balanced() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION petro_private.finance_record_receipt(uuid,uuid,uuid,text,text,bigint,text,uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION petro_private.finance_allocate_receipt(uuid,text,uuid,bigint,text,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION petro_private.finance_reserve_funds(uuid,text,uuid,bigint,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION petro_private.finance_release_reservation(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION petro_private.can_read_finance_document(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION petro_private.can_read_finance_document(text) TO authenticated;
GRANT EXECUTE ON FUNCTION petro_private.finance_reserve_funds(uuid,text,uuid,bigint,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION petro_private.finance_release_reservation(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.petro_finance_admin_summary() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.petro_finance_admin_organizations(text,integer,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.petro_finance_admin_accounts(text,integer,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.petro_finance_admin_bank_accounts() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.petro_finance_admin_add_bank_account(text,text,text,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.petro_finance_admin_approve_bank_account(uuid,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.petro_finance_admin_create_topup(uuid,bigint,text,text,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.petro_finance_admin_update_topup(uuid,bigint,bigint,text,text,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.petro_finance_admin_submit_topup(uuid,bigint,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.petro_finance_admin_review_topup(uuid,bigint,text,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.petro_finance_admin_list_topups(text,text,integer,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.petro_finance_admin_topup_detail(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.petro_finance_admin_disable_bank_account(uuid,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.petro_finance_admin_record_receipt(uuid,uuid,uuid,text,text,bigint,text,boolean,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.petro_finance_admin_approve_topup(uuid,uuid,bigint,bigint,text,boolean,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.petro_finance_admin_list_receipts(text,integer,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.petro_finance_admin_allocate_receipt(uuid,text,uuid,bigint,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.petro_finance_admin_transfer(uuid,uuid,uuid,bigint,text,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.petro_finance_admin_list_transfers(uuid,integer,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.petro_finance_admin_list_subscriptions(text,text,integer,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.petro_finance_admin_list_journal(uuid,uuid,text,text,integer,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.petro_finance_admin_journal_detail(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.petro_finance_admin_reconciliation() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.petro_finance_admin_reverse_journal(uuid,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.petro_finance_create_document_upload(text,uuid,text,text,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_admin_summary() TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_admin_organizations(text,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_admin_accounts(text,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_admin_bank_accounts() TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_admin_add_bank_account(text,text,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_admin_approve_bank_account(uuid,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_admin_create_topup(uuid,bigint,text,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_admin_update_topup(uuid,bigint,bigint,text,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_admin_submit_topup(uuid,bigint,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_admin_review_topup(uuid,bigint,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_admin_list_topups(text,text,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_admin_topup_detail(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_admin_disable_bank_account(uuid,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_admin_record_receipt(uuid,uuid,uuid,text,text,bigint,text,boolean,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_admin_approve_topup(uuid,uuid,bigint,bigint,text,boolean,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_admin_list_receipts(text,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_admin_allocate_receipt(uuid,text,uuid,bigint,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_admin_transfer(uuid,uuid,uuid,bigint,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_admin_list_transfers(uuid,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_admin_list_subscriptions(text,text,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_admin_list_journal(uuid,uuid,text,text,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_admin_journal_detail(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_admin_reconciliation() TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_admin_reverse_journal(uuid,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_create_document_upload(text,uuid,text,text,text,bigint) TO authenticated;

COMMIT;
