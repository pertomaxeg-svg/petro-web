BEGIN;

-- A reservation can only be consumed against a separately posted, balanced
-- service-side entry. This migration does not create a service-order workflow.
ALTER TABLE public.petro_finance_journal_entries
  DROP CONSTRAINT petro_finance_journal_entries_entry_type_check;
ALTER TABLE public.petro_finance_journal_entries
  ADD CONSTRAINT petro_finance_journal_entries_entry_type_check
  CHECK (entry_type IN (
    'bank_receipt','topup_allocation','subscription_collection',
    'internal_transfer','reservation_consumption','reversal'
  ));

ALTER TABLE public.petro_finance_reservations
  ADD COLUMN consumed_entry_id uuid
    REFERENCES public.petro_finance_journal_entries(id) ON DELETE RESTRICT,
  ADD CONSTRAINT petro_finance_reservation_consumed_entry_check
    CHECK ((status='consumed') = (consumed_entry_id IS NOT NULL));

CREATE FUNCTION petro_private.finance_consume_reservation(
  p_reservation_id uuid, p_journal_entry_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE reservation public.petro_finance_reservations%ROWTYPE;
  account public.petro_finance_accounts%ROWTYPE;
  entry public.petro_finance_journal_entries%ROWTYPE;
  account_debit bigint; total_debit bigint; total_credit bigint;
BEGIN
  IF p_reservation_id IS NULL OR p_journal_entry_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_RESERVATION_CAPTURE' USING ERRCODE='22023';
  END IF;
  SELECT * INTO reservation FROM public.petro_finance_reservations
  WHERE id=p_reservation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RESERVATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM public.petro_finance_accounts WHERE id=reservation.account_id FOR UPDATE;
  IF reservation.status='consumed' THEN
    IF reservation.consumed_entry_id=p_journal_entry_id THEN
      RETURN jsonb_build_object('id',reservation.id,'journalEntryId',p_journal_entry_id,
        'status','consumed','replayed',true);
    END IF;
    RAISE EXCEPTION 'RESERVATION_ALREADY_CONSUMED' USING ERRCODE='23505';
  END IF;
  IF reservation.status<>'active' THEN
    RAISE EXCEPTION 'RESERVATION_NOT_CONSUMABLE' USING ERRCODE='55000';
  END IF;

  SELECT * INTO account FROM public.petro_finance_accounts
  WHERE id=reservation.account_id;
  SELECT * INTO entry FROM public.petro_finance_journal_entries
  WHERE id=p_journal_entry_id FOR UPDATE;
  IF NOT FOUND OR entry.entry_type<>'reservation_consumption'
     OR entry.source_id<>reservation.source_id
     OR entry.organization_id IS DISTINCT FROM account.organization_id THEN
    RAISE EXCEPTION 'RESERVATION_CAPTURE_SOURCE_MISMATCH' USING ERRCODE='23514';
  END IF;
  SELECT
    COALESCE(sum(line.amount_minor) FILTER (
      WHERE line.account_id=reservation.account_id AND line.side='debit'),0)::bigint,
    COALESCE(sum(line.amount_minor) FILTER (WHERE line.side='debit'),0)::bigint,
    COALESCE(sum(line.amount_minor) FILTER (WHERE line.side='credit'),0)::bigint
  INTO account_debit,total_debit,total_credit
  FROM public.petro_finance_journal_lines line
  WHERE line.entry_id=entry.id;
  IF account_debit<>reservation.amount_minor
     OR total_debit<>reservation.amount_minor OR total_credit<>total_debit THEN
    RAISE EXCEPTION 'RESERVATION_CAPTURE_AMOUNT_MISMATCH' USING ERRCODE='23514';
  END IF;

  UPDATE public.petro_finance_reservations
  SET status='consumed',closed_by=entry.actor_id,closed_at=now(),
      consumed_entry_id=entry.id
  WHERE id=reservation.id AND status='active';
  IF NOT FOUND THEN RAISE EXCEPTION 'RESERVATION_STATE_CHANGED' USING ERRCODE='40001'; END IF;
  INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
  VALUES(entry.actor_id,account.organization_id,'finance.reservation.consumed',
    reservation.id,jsonb_build_object('entryId',entry.id,'sourceType',reservation.source_type,
      'sourceId',reservation.source_id,'amountMinor',reservation.amount_minor::text,
      'currency','EGP','reason',reservation.reason));
  INSERT INTO public.petro_finance_outbox(event_type,source_type,source_id,payload)
  VALUES('finance.reservation.consumed','reservation',reservation.id,
    jsonb_build_object('reservationId',reservation.id,'entryId',entry.id,
      'organizationId',account.organization_id,'amountMinor',reservation.amount_minor::text,
      'currency','EGP'));
  RETURN jsonb_build_object('id',reservation.id,'journalEntryId',entry.id,
    'status','consumed','replayed',false);
END
$$;

CREATE FUNCTION public.petro_finance_admin_receipt_detail(p_receipt_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE result jsonb; is_finance boolean;
BEGIN
  IF NOT petro_private.finance_can_read() THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF p_receipt_id IS NULL THEN RAISE EXCEPTION 'INVALID_RECEIPT_ID' USING ERRCODE='22023'; END IF;
  is_finance:=petro_private.platform_has(ARRAY['owner','finance']::text[]);
  SELECT jsonb_build_object(
    'id',receipt.id,
    'receiptNumber',receipt.receipt_number,
    'organizationId',receipt.organization_id,
    'organizationName',organization.name,
    'organizationKind',organization.kind,
    'branchId',receipt.branch_id,
    'branchName',branch.name,
    'receivingBankAccountId',receipt.receiving_bank_account_id,
    'receivingBankName',bank.bank_name,
    'receivingAccountLabel',bank.display_label,
    'receivingAccountLast4',CASE WHEN is_finance THEN bank.account_last4 ELSE NULL END,
    'payerBankName',receipt.payer_bank_name,
    'bankReference',CASE WHEN is_finance THEN receipt.bank_reference ELSE NULL END,
    'maskedReference',right(receipt.bank_reference,4),
    'amountMinor',receipt.amount_minor::text,
    'currency',receipt.currency,
    'reason',receipt.reason,
    'status',receipt.status,
    'verifiedAgainstBank',receipt.verified_bank_transfer,
    'recordedBy',receipt.recorded_by,
    'createdAt',receipt.created_at,
    'journal',jsonb_build_object(
      'id',entry.id,'entryType',entry.entry_type,'reference',entry.reference,
      'reason',entry.reason,'occurredAt',entry.occurred_at,
      'debitMinor',COALESCE((SELECT sum(line.amount_minor) FROM public.petro_finance_journal_lines line
        WHERE line.entry_id=entry.id AND line.side='debit'),0)::text,
      'creditMinor',COALESCE((SELECT sum(line.amount_minor) FROM public.petro_finance_journal_lines line
        WHERE line.entry_id=entry.id AND line.side='credit'),0)::text,
      'lines',COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'accountId',line.account_id,'accountName',account.display_name,
        'accountKind',account.account_kind,'side',line.side,
        'amountMinor',line.amount_minor::text,'currency',line.currency
      ) ORDER BY line.id)
      FROM public.petro_finance_journal_lines line
      JOIN public.petro_finance_accounts account ON account.id=line.account_id
      WHERE line.entry_id=entry.id),'[]'::jsonb)
    ),
    'allocations',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id',allocation.id,'targetType',allocation.target_type,'targetId',allocation.target_id,
        'targetStatus',CASE allocation.target_type
          WHEN 'topup' THEN topup.status ELSE subscription.status END,
        'targetReference',CASE WHEN is_finance AND allocation.target_type='topup'
          THEN topup.bank_reference ELSE NULL END,
        'planName',plan_version.display_name,
        'planVersionId',subscription.plan_version_id,
        'subscriptionRequestId',subscription.request_id,
        'snapshotPriceMinor',subscription.price_snapshot_minor::text,
        'planSnapshot',subscription.plan_snapshot,
        'units',subscription.units,
        'amountMinor',allocation.amount_minor::text,'currency','EGP',
        'status',allocation.status,'reason',allocation.reason,
        'journalEntryId',allocation.journal_entry_id,'allocatedBy',allocation.allocated_by,
        'createdAt',allocation.created_at
      ) ORDER BY allocation.created_at,allocation.id)
      FROM public.petro_finance_receipt_allocations allocation
      LEFT JOIN public.petro_finance_topup_requests topup
        ON allocation.target_type='topup' AND topup.id=allocation.target_id
      LEFT JOIN public.petro_subscriptions subscription
        ON allocation.target_type='subscription' AND subscription.id=allocation.target_id
      LEFT JOIN public.petro_plan_versions plan_version
        ON plan_version.id=subscription.plan_version_id
      WHERE allocation.receipt_id=receipt.id
    ),'[]'::jsonb),
    'documents',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id',document.id,'documentType',document.document_type,
        'fileName',document.file_name,'contentType',document.content_type,
        'byteSize',document.byte_size,'status',document.status,
        'uploadedAt',document.uploaded_at,'createdAt',document.created_at,
        'subscriptionRequestId',document.finance_subscription_request_id
      ) ORDER BY document.created_at,document.id)
      FROM public.petro_documents document
      WHERE document.finance_bank_receipt_id=receipt.id
         OR document.finance_subscription_request_id IN (
           SELECT subscription.request_id
           FROM public.petro_finance_receipt_allocations allocation
           JOIN public.petro_subscriptions subscription
             ON allocation.target_type='subscription' AND subscription.id=allocation.target_id
           WHERE allocation.receipt_id=receipt.id
         )
    ),'[]'::jsonb)
  ) INTO result
  FROM public.petro_finance_bank_receipts receipt
  JOIN public.petro_organizations organization ON organization.id=receipt.organization_id
  LEFT JOIN public.petro_branches branch
    ON branch.id=receipt.branch_id AND branch.organization_id=receipt.organization_id
  JOIN public.petro_finance_bank_accounts bank ON bank.id=receipt.receiving_bank_account_id
  JOIN public.petro_finance_journal_entries entry ON entry.id=receipt.journal_entry_id
  WHERE receipt.id=p_receipt_id;
  IF result IS NULL THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN result;
END
$$;

REVOKE ALL ON FUNCTION petro_private.finance_consume_reservation(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION petro_private.finance_consume_reservation(uuid,uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.petro_finance_admin_receipt_detail(uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.petro_finance_admin_receipt_detail(uuid)
  TO authenticated;

COMMIT;
