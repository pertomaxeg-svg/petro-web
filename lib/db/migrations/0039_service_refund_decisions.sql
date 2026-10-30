BEGIN;
ALTER TABLE public.petro_finance_accounts DROP CONSTRAINT petro_finance_accounts_account_kind_check;
ALTER TABLE public.petro_finance_accounts ADD CONSTRAINT petro_finance_accounts_account_kind_check CHECK ((account_kind = ANY (ARRAY['bank_clearing'::text, 'unallocated_receipts'::text, 'company_funding'::text, 'branch_funding'::text, 'subscription_receipts_held'::text, 'merchant_payable'::text, 'merchant_refund_receivable'::text])));
ALTER TABLE public.petro_finance_accounts DROP CONSTRAINT petro_finance_accounts_check;
ALTER TABLE public.petro_finance_accounts ADD CONSTRAINT petro_finance_accounts_check CHECK (((((account_kind = 'company_funding'::text) AND (normal_side = 'credit'::text) AND (organization_id IS NOT NULL) AND (branch_id IS NULL) AND (receiving_bank_account_id IS NULL)) OR ((account_kind = 'branch_funding'::text) AND (normal_side = 'credit'::text) AND (organization_id IS NOT NULL) AND (branch_id IS NOT NULL) AND (receiving_bank_account_id IS NULL)) OR ((account_kind = 'bank_clearing'::text) AND (normal_side = 'debit'::text) AND (organization_id IS NULL) AND (branch_id IS NULL) AND (receiving_bank_account_id IS NOT NULL)) OR ((account_kind = ANY (ARRAY['unallocated_receipts'::text, 'subscription_receipts_held'::text, 'merchant_payable'::text])) AND (normal_side = 'credit'::text) AND (organization_id IS NULL) AND (branch_id IS NULL) AND (receiving_bank_account_id IS NULL)))) OR (account_kind='merchant_refund_receivable' AND normal_side='debit' AND organization_id IS NULL AND branch_id IS NULL AND receiving_bank_account_id IS NULL AND account_code='SYS-MERCHANT-REFUND-RECEIVABLE'));
ALTER TABLE public.petro_finance_journal_entries DROP CONSTRAINT petro_finance_journal_entries_entry_type_check;
ALTER TABLE public.petro_finance_journal_entries ADD CONSTRAINT petro_finance_journal_entries_entry_type_check CHECK ((entry_type = ANY (ARRAY['bank_receipt'::text, 'topup_allocation'::text, 'subscription_collection'::text, 'internal_transfer'::text, 'reservation_consumption'::text, 'service_refund'::text, 'reversal'::text])));
INSERT INTO public.petro_finance_accounts(account_code,display_name,account_kind,normal_side)
VALUES('SYS-MERCHANT-REFUND-RECEIVABLE','مديونية التجار عن رد خدمات مسوّاة','merchant_refund_receivable','debit');
CREATE TABLE petro_private.service_refund_decisions(
 request_id uuid PRIMARY KEY REFERENCES petro_private.service_refund_requests(id) ON DELETE RESTRICT,
 payment_id uuid NOT NULL REFERENCES petro_private.service_order_payments(id) ON DELETE RESTRICT,
 action text NOT NULL CHECK(action IN('refund','reject')),
 amount_minor bigint NOT NULL CHECK(amount_minor>=0),
 note text CHECK(note IS NULL OR char_length(note)<=1000),
 decided_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 decided_at timestamptz NOT NULL,
 CHECK((action='refund' AND amount_minor>0) OR(action='reject' AND amount_minor=0)),
 UNIQUE(request_id,payment_id)
);
CREATE TABLE petro_private.service_refund_allocations(
 request_id uuid PRIMARY KEY,
 payment_id uuid NOT NULL REFERENCES petro_private.service_order_payments(id) ON DELETE RESTRICT,
 journal_entry_id uuid NOT NULL UNIQUE REFERENCES public.petro_finance_journal_entries(id) ON DELETE RESTRICT,
 funding_account_id uuid NOT NULL REFERENCES public.petro_finance_accounts(id) ON DELETE RESTRICT,
 amount_minor bigint NOT NULL CHECK(amount_minor>0),
 unsettled_amount_minor bigint NOT NULL CHECK(unsettled_amount_minor>=0),
 merchant_debt_minor bigint NOT NULL CHECK(merchant_debt_minor>=0),
 merchant_organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
 merchant_branch_id uuid NOT NULL,
 created_at timestamptz NOT NULL,
 FOREIGN KEY(request_id,payment_id) REFERENCES petro_private.service_refund_decisions(request_id,payment_id) ON DELETE RESTRICT,
 FOREIGN KEY(merchant_branch_id,merchant_organization_id) REFERENCES public.petro_branches(id,organization_id) ON DELETE RESTRICT,
 CHECK(unsettled_amount_minor+merchant_debt_minor=amount_minor)
);
CREATE INDEX service_refund_allocations_payment_idx ON petro_private.service_refund_allocations(payment_id);
CREATE INDEX service_refund_allocations_merchant_idx ON petro_private.service_refund_allocations(merchant_organization_id,merchant_branch_id,created_at);
CREATE SEQUENCE petro_private.service_credit_document_seq;
REVOKE ALL ON SEQUENCE petro_private.service_credit_document_seq FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE petro_private.service_refund_documents(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 request_id uuid NOT NULL UNIQUE REFERENCES petro_private.service_refund_allocations(request_id) ON DELETE RESTRICT,
 document_number text NOT NULL UNIQUE,snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),issued_at timestamptz NOT NULL
);
-- Actual payout allocations only; no endpoint fabricates a settled receivable.
CREATE TABLE petro_private.service_receivable_settlements(
 payment_id uuid NOT NULL REFERENCES petro_private.service_order_payments(id) ON DELETE RESTRICT,
 journal_entry_id uuid NOT NULL REFERENCES public.petro_finance_journal_entries(id) ON DELETE RESTRICT,
 amount_minor bigint NOT NULL CHECK(amount_minor>0),
 created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 PRIMARY KEY(payment_id,journal_entry_id)
);
CREATE INDEX service_receivable_settlements_entry_idx ON petro_private.service_receivable_settlements(journal_entry_id);
ALTER TABLE petro_private.service_refund_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE petro_private.service_refund_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE petro_private.service_refund_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE petro_private.service_receivable_settlements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON petro_private.service_refund_decisions,petro_private.service_refund_allocations,petro_private.service_refund_documents,petro_private.service_receivable_settlements FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER service_refund_decision_immutable BEFORE UPDATE OR DELETE ON petro_private.service_refund_decisions FOR EACH ROW EXECUTE FUNCTION petro_private.guard_refund_request_history();
CREATE TRIGGER service_refund_allocation_immutable BEFORE UPDATE OR DELETE ON petro_private.service_refund_allocations FOR EACH ROW EXECUTE FUNCTION petro_private.guard_refund_request_history();
CREATE TRIGGER service_refund_document_immutable BEFORE UPDATE OR DELETE ON petro_private.service_refund_documents FOR EACH ROW EXECUTE FUNCTION petro_private.guard_refund_request_history();
CREATE TRIGGER service_receivable_settlement_immutable BEFORE UPDATE OR DELETE ON petro_private.service_receivable_settlements FOR EACH ROW EXECUTE FUNCTION petro_private.guard_refund_request_history();

CREATE FUNCTION petro_private.validate_service_receivable_settlement() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE p petro_private.service_order_payments%ROWTYPE;v petro_private.service_order_receivables%ROWTYPE;j public.petro_finance_journal_entries%ROWTYPE;
 already_settled numeric;already_refunded numeric;pending_claims numeric;entry_allocated numeric;entry_debit numeric;bank_credit numeric;
BEGIN
 IF NOT coalesce(petro_private.workforce_user_active(auth.uid()),false) OR NOT petro_private.platform_has(ARRAY['owner','finance']::text[]) OR NEW.created_by IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'FORBIDDEN_SETTLEMENT' USING ERRCODE='42501';END IF;
 SELECT * INTO STRICT p FROM petro_private.service_order_payments WHERE id=NEW.payment_id FOR UPDATE;
 SELECT * INTO STRICT v FROM petro_private.service_order_receivables WHERE payment_id=p.id;
 SELECT * INTO STRICT j FROM public.petro_finance_journal_entries WHERE id=NEW.journal_entry_id FOR UPDATE;
 IF j.entry_type<>'internal_transfer' OR j.organization_id IS DISTINCT FROM v.merchant_organization_id OR j.actor_id IS DISTINCT FROM NEW.created_by
 OR j.reference NOT LIKE 'MERCHANT-SETTLEMENT:%' THEN RAISE EXCEPTION 'SETTLEMENT_JOURNAL_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT coalesce(sum(amount_minor),0) INTO already_settled FROM petro_private.service_receivable_settlements WHERE payment_id=p.id;
 SELECT coalesce(sum(unsettled_amount_minor),0) INTO already_refunded FROM petro_private.service_refund_allocations WHERE payment_id=p.id;
 SELECT coalesce(sum(r.amount_minor),0) INTO pending_claims FROM petro_private.service_refund_requests r WHERE r.payment_id=p.id
 AND NOT EXISTS(SELECT 1 FROM petro_private.service_refund_withdrawals WHERE request_id=r.id)
 AND NOT EXISTS(SELECT 1 FROM petro_private.service_refund_decisions WHERE request_id=r.id);
 IF NEW.amount_minor+already_settled+already_refunded+pending_claims>v.earned_amount_minor THEN RAISE EXCEPTION 'SETTLEMENT_EXCEEDS_RECEIVABLE' USING ERRCODE='23514';END IF;
 SELECT coalesce(sum(amount_minor),0) INTO entry_allocated FROM petro_private.service_receivable_settlements WHERE journal_entry_id=j.id;
 SELECT coalesce(sum(amount_minor),0) INTO entry_debit FROM public.petro_finance_journal_lines WHERE entry_id=j.id AND account_id=v.control_account_id AND side='debit';
 SELECT coalesce(sum(l.amount_minor),0) INTO bank_credit FROM public.petro_finance_journal_lines l JOIN public.petro_finance_accounts a ON a.id=l.account_id WHERE l.entry_id=j.id AND l.side='credit' AND a.account_kind='bank_clearing';
 IF entry_allocated+NEW.amount_minor>entry_debit OR entry_allocated+NEW.amount_minor>bank_credit THEN RAISE EXCEPTION 'SETTLEMENT_ALLOCATION_JOURNAL_MISMATCH' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION petro_private.validate_service_receivable_settlement() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER service_receivable_settlement_validate BEFORE INSERT ON petro_private.service_receivable_settlements FOR EACH ROW EXECUTE FUNCTION petro_private.validate_service_receivable_settlement();

CREATE OR REPLACE FUNCTION petro_private.guard_service_payment_reversal() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NEW.reverses_entry_id IS NOT NULL AND(EXISTS(SELECT 1 FROM petro_private.service_order_payments WHERE journal_entry_id=NEW.reverses_entry_id)
 OR EXISTS(SELECT 1 FROM petro_private.service_refund_allocations WHERE journal_entry_id=NEW.reverses_entry_id)) THEN
 RAISE EXCEPTION 'USE_SERVICE_ORDER_REFUND_WORKFLOW' USING ERRCODE='55000';
 END IF;
 IF NEW.reverses_entry_id IS NOT NULL AND EXISTS(SELECT 1 FROM petro_private.service_receivable_settlements WHERE journal_entry_id=NEW.reverses_entry_id) THEN
 RAISE EXCEPTION 'USE_SERVICE_SETTLEMENT_ADJUSTMENT_WORKFLOW' USING ERRCODE='55000';END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION public.petro_decide_service_refund(p_request_id uuid,p_expected_version bigint,p_action text,p_amount_minor text,p_note text,p_request_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=auth.uid();r petro_private.service_refund_requests%ROWTYPE;p petro_private.service_order_payments%ROWTYPE;v petro_private.service_order_receivables%ROWTYPE;
 fingerprint_value text;command petro_private.service_refund_commands%ROWTYPE;result jsonb;amount bigint;note_value text:=nullif(btrim(p_note),'');
 refunded numeric;settled numeric;used_unsettled numeric;unsettled bigint;debt bigint;funding uuid;debt_account uuid;account_record public.petro_finance_accounts%ROWTYPE;
 entry uuid:=gen_random_uuid();document_id uuid:=gen_random_uuid();document_number_value text;original_receipt petro_private.service_order_receipts%ROWTYPE;
 lines jsonb;snapshot_value jsonb;confirmed_at_value timestamptz:=transaction_timestamp();counter bigint;available numeric;
BEGIN
 IF NOT coalesce(petro_private.workforce_user_active(actor),false) OR NOT petro_private.platform_has(ARRAY['owner','finance']::text[]) THEN RAISE EXCEPTION 'FORBIDDEN_REFUND_DECISION' USING ERRCODE='42501';END IF;
 IF p_expected_version IS NULL OR p_expected_version<1 OR p_action IS NULL OR p_action NOT IN('refund','reject')
 OR(p_action='refund' AND(p_amount_minor IS NULL OR p_amount_minor!~'^[1-9][0-9]{0,12}$'))
 OR(p_action='reject' AND p_amount_minor IS NOT NULL) OR char_length(coalesce(note_value,''))>1000
 OR p_request_key IS NULL OR p_request_key!~'^[A-Za-z0-9._:-]{16,120}$' THEN RAISE EXCEPTION 'INVALID_REFUND_DECISION' USING ERRCODE='22023';END IF;
 amount:=CASE WHEN p_action='refund' THEN p_amount_minor::bigint ELSE 0 END;
 fingerprint_value:=encode(sha256(convert_to(jsonb_build_array('decide',p_request_id,p_expected_version,p_action,p_amount_minor,note_value)::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('refund-command:'||actor::text||':'||p_request_key,0));
 SELECT * INTO command FROM petro_private.service_refund_commands WHERE actor_id=actor AND request_key=p_request_key;
 IF FOUND THEN IF command.fingerprint<>fingerprint_value THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';END IF;RETURN command.result;END IF;
 SELECT * INTO r FROM petro_private.service_refund_requests WHERE id=p_request_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'REFUND_REQUEST_NOT_FOUND' USING ERRCODE='P0002';END IF;
 SELECT * INTO STRICT p FROM petro_private.service_order_payments WHERE id=r.payment_id FOR UPDATE;
 IF NOT coalesce(petro_private.workforce_user_active(actor),false) OR NOT petro_private.platform_has(ARRAY['owner','finance']::text[]) THEN RAISE EXCEPTION 'FORBIDDEN_REFUND_DECISION' USING ERRCODE='42501';END IF;
 IF p_expected_version<>1 OR EXISTS(SELECT 1 FROM petro_private.service_refund_withdrawals WHERE request_id=r.id) OR EXISTS(SELECT 1 FROM petro_private.service_refund_decisions WHERE request_id=r.id) THEN RAISE EXCEPTION 'REFUND_VERSION_CONFLICT' USING ERRCODE='PT409';END IF;
 IF amount>r.amount_minor THEN RAISE EXCEPTION 'REFUND_EXCEEDS_REQUEST' USING ERRCODE='23514';END IF;
 SELECT coalesce(sum(amount_minor),0) INTO refunded FROM petro_private.service_refund_allocations WHERE payment_id=p.id;
 IF amount+refunded>p.charged_amount_minor THEN RAISE EXCEPTION 'REFUND_EXCEEDS_REMAINING_PAYMENT' USING ERRCODE='23514';END IF;
 IF p_action='refund' THEN
 SELECT * INTO STRICT v FROM petro_private.service_order_receivables WHERE payment_id=p.id;
 SELECT * INTO STRICT original_receipt FROM petro_private.service_order_receipts WHERE payment_id=p.id;
 SELECT account_id INTO STRICT funding FROM public.petro_finance_reservations WHERE id=p.financial_reservation_id;
 SELECT * INTO STRICT account_record FROM public.petro_finance_accounts WHERE id=funding;
 IF account_record.account_kind NOT IN('company_funding','branch_funding') OR account_record.normal_side<>'credit' OR account_record.currency<>'EGP'
 OR NOT EXISTS(SELECT 1 FROM public.petro_service_orders o WHERE o.id=p.order_id AND o.company_organization_id=account_record.organization_id
 AND(account_record.account_kind='company_funding' OR o.company_branch_id=account_record.branch_id))
 OR NOT EXISTS(SELECT 1 FROM public.petro_finance_journal_lines WHERE entry_id=p.journal_entry_id AND account_id=funding AND side='debit' AND amount_minor=p.charged_amount_minor)
 OR NOT EXISTS(SELECT 1 FROM public.petro_finance_journal_lines WHERE entry_id=p.journal_entry_id AND account_id=v.control_account_id AND side='credit' AND amount_minor=p.charged_amount_minor) THEN RAISE EXCEPTION 'REFUND_ORIGINAL_FUNDING_MISMATCH' USING ERRCODE='55000';END IF;
 SELECT id INTO STRICT debt_account FROM public.petro_finance_accounts WHERE account_kind='merchant_refund_receivable' AND account_code='SYS-MERCHANT-REFUND-RECEIVABLE' AND normal_side='debit';
 PERFORM 1 FROM public.petro_finance_accounts WHERE id IN(funding,v.control_account_id,debt_account) ORDER BY id FOR UPDATE;
 SELECT coalesce(sum(amount_minor),0) INTO settled FROM petro_private.service_receivable_settlements WHERE payment_id=p.id;
 SELECT coalesce(sum(unsettled_amount_minor),0) INTO used_unsettled FROM petro_private.service_refund_allocations WHERE payment_id=p.id;
 unsettled:=least(amount,greatest(v.earned_amount_minor-settled-used_unsettled,0))::bigint;debt:=amount-unsettled;
 SELECT available_minor INTO available FROM public.petro_finance_account_balances WHERE account_id=v.control_account_id;
 IF coalesce(available,0)<unsettled THEN RAISE EXCEPTION 'REFUND_CONTROL_REQUIRES_REVIEW' USING ERRCODE='23514';END IF;
 INSERT INTO petro_private.service_refund_decisions(request_id,payment_id,action,amount_minor,note,decided_by,decided_at) VALUES(r.id,p.id,p_action,amount,note_value,actor,confirmed_at_value);
 lines:=jsonb_build_array(jsonb_build_object('accountId',funding,'side','credit','amountMinor',amount::text));
 IF unsettled>0 THEN lines:=lines||jsonb_build_array(jsonb_build_object('accountId',v.control_account_id,'side','debit','amountMinor',unsettled::text));END IF;
 IF debt>0 THEN lines:=lines||jsonb_build_array(jsonb_build_object('accountId',debt_account,'side','debit','amountMinor',debt::text));END IF;
 PERFORM petro_private.finance_post_entry(entry,'service_refund',r.id,account_record.organization_id,'SERVICE-REFUND:'||r.id::text,'رد فعلي لقيمة خدمة إلى حساب تمويلها الأصلي',lines);
 INSERT INTO petro_private.service_refund_allocations(request_id,payment_id,journal_entry_id,funding_account_id,amount_minor,unsettled_amount_minor,merchant_debt_minor,merchant_organization_id,merchant_branch_id,created_at)
 VALUES(r.id,p.id,entry,funding,amount,unsettled,debt,v.merchant_organization_id,v.merchant_branch_id,confirmed_at_value);
 counter:=nextval('petro_private.service_credit_document_seq');
 document_number_value:='SC-'||to_char(confirmed_at_value AT TIME ZONE 'Africa/Cairo','YYYY')||'-'||lpad(counter::text,greatest(8,char_length(counter::text)),'0');
 snapshot_value:=jsonb_build_object('documentKind','service_credit','taxTreatment','not_configured','currency','EGP','documentNumber',document_number_value,
 'requestId',r.id,'orderId',p.order_id,'originalPaymentId',p.id,'originalJournalEntryId',p.journal_entry_id,'originalReceiptNumber',original_receipt.receipt_number,
 'refundedAmountMinor',amount::text,'requestedAmountMinor',r.amount_minor::text,'journalEntryId',entry,'fundingAccountId',funding,
 'company',original_receipt.snapshot->'company','companyBranch',original_receipt.snapshot->'companyBranch','merchant',original_receipt.snapshot->'merchant','vehicle',original_receipt.snapshot->'vehicle',
 'decidedBy',(SELECT display_name FROM public.petro_profiles WHERE user_id=actor),'issuedAt',confirmed_at_value);
 INSERT INTO petro_private.service_refund_documents(id,request_id,document_number,snapshot,issued_at) VALUES(document_id,r.id,document_number_value,snapshot_value,confirmed_at_value);
 INSERT INTO public.petro_finance_outbox(event_type,source_type,source_id,payload) VALUES('order.refunded','service_refund',r.id,jsonb_build_object('requestId',r.id,'orderId',p.order_id,'paymentId',p.id,'amountMinor',amount::text,'documentId',document_id,'currency','EGP'));
 ELSE
 INSERT INTO petro_private.service_refund_decisions(request_id,payment_id,action,amount_minor,note,decided_by,decided_at) VALUES(r.id,p.id,p_action,0,note_value,actor,confirmed_at_value);
 END IF;
 result:=jsonb_build_object('id',r.id,'orderId',r.order_id,'status',CASE WHEN p_action='refund' THEN 'refunded' ELSE 'rejected' END,'version',2,'moneyRefunded',p_action='refund',
 'refundedAmountMinor',amount::text,'journalEntryId',CASE WHEN p_action='refund' THEN entry END,'documentNumber',document_number_value);
 INSERT INTO petro_private.service_refund_commands(actor_id,request_key,fingerprint,result) VALUES(actor,p_request_key,fingerprint_value,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.petro_decide_service_refund(uuid,bigint,text,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.petro_decide_service_refund(uuid,bigint,text,text,text,text) TO authenticated;
CREATE OR REPLACE FUNCTION public.petro_service_order_refund_requests(p_order_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE p petro_private.service_order_payments%ROWTYPE;pending_amount numeric;refunded_amount numeric;items jsonb;can_write boolean;can_decide boolean;
BEGIN
 IF NOT coalesce(petro_private.service_refund_order_access(p_order_id,false),false) THEN RAISE EXCEPTION 'FORBIDDEN_REFUND' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM petro_private.service_order_payments WHERE order_id=p_order_id;
 can_write:=coalesce(petro_private.service_refund_order_access(p_order_id,true),false);
 can_decide:=coalesce(petro_private.workforce_user_active(auth.uid()),false) AND petro_private.platform_has(ARRAY['owner','finance']::text[]);
 SELECT coalesce(sum(amount_minor),0) INTO refunded_amount FROM petro_private.service_refund_allocations WHERE payment_id=p.id;
 SELECT coalesce(sum(r.amount_minor),0) INTO pending_amount FROM petro_private.service_refund_requests r WHERE r.order_id=p_order_id
 AND NOT EXISTS(SELECT 1 FROM petro_private.service_refund_withdrawals w WHERE w.request_id=r.id)
 AND NOT EXISTS(SELECT 1 FROM petro_private.service_refund_decisions d WHERE d.request_id=r.id);
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY(x.status='requested')DESC,x."createdAt" DESC,x.id),'[]'::jsonb) INTO items FROM(
 SELECT r.id,r.order_id AS "orderId",r.amount_minor::text AS "amountMinor",r.category,r.note,r.created_at AS "createdAt",pr.display_name AS "requestedByName",
 CASE WHEN w.request_id IS NOT NULL THEN 'withdrawn' WHEN d.action='refund' THEN 'refunded' WHEN d.action='reject' THEN 'rejected' ELSE 'requested' END AS status,
 CASE WHEN w.request_id IS NULL AND d.request_id IS NULL THEN 1 ELSE 2 END AS version,w.created_at AS "withdrawnAt",
 (can_write AND w.request_id IS NULL AND d.request_id IS NULL) AS "canWithdraw",
 (can_decide AND w.request_id IS NULL AND d.request_id IS NULL) AS "canDecide",
 CASE WHEN d.request_id IS NOT NULL THEN jsonb_build_object('action',d.action,'amountMinor',d.amount_minor::text,'note',d.note,'decidedAt',d.decided_at,'decidedByName',dp.display_name,
 'document',CASE WHEN doc.id IS NOT NULL THEN jsonb_build_object('number',doc.document_number,'issuedAt',doc.issued_at,'snapshot',doc.snapshot) END) END AS decision
 FROM petro_private.service_refund_requests r JOIN public.petro_profiles pr ON pr.user_id=r.requested_by
 LEFT JOIN petro_private.service_refund_withdrawals w ON w.request_id=r.id
 LEFT JOIN petro_private.service_refund_decisions d ON d.request_id=r.id
 LEFT JOIN public.petro_profiles dp ON dp.user_id=d.decided_by
 LEFT JOIN petro_private.service_refund_documents doc ON doc.request_id=r.id
 WHERE r.order_id=p_order_id ORDER BY(w.request_id IS NULL AND d.request_id IS NULL)DESC,r.created_at DESC,r.id LIMIT 50
 )x;
 RETURN jsonb_build_object('orderId',p_order_id,'paid',p.id IS NOT NULL,'chargedAmountMinor',coalesce(p.charged_amount_minor,0)::text,
 'requestedAmountMinor',pending_amount::text,'refundedAmountMinor',refunded_amount::text,
 'remainingRefundableMinor',(coalesce(p.charged_amount_minor,0)-refunded_amount)::text,
 'remainingRequestableMinor',(coalesce(p.charged_amount_minor,0)-refunded_amount-pending_amount)::text,
 'receiptNumber',(SELECT receipt_number FROM petro_private.service_order_receipts WHERE order_id=p_order_id),
 'canRequest',can_write AND p.id IS NOT NULL AND pending_amount+refunded_amount<p.charged_amount_minor,
 'items',items,'total',(SELECT count(*) FROM petro_private.service_refund_requests WHERE order_id=p_order_id),'financialRefundEnabled',true);
END $$;
CREATE OR REPLACE FUNCTION public.petro_request_service_refund(p_order_id uuid,p_amount_minor text,p_category text,p_note text,p_request_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=auth.uid();p petro_private.service_order_payments%ROWTYPE;amount bigint;normalized_note text:=nullif(btrim(p_note),'');
 fingerprint_value text;receipt petro_private.service_refund_commands%ROWTYPE;pending_amount numeric;refunded_amount numeric;open_count bigint;new_id uuid:=gen_random_uuid();result jsonb;
BEGIN
 IF NOT coalesce(petro_private.service_refund_order_access(p_order_id,true),false) THEN RAISE EXCEPTION 'FORBIDDEN_REFUND' USING ERRCODE='42501';END IF;
 IF p_amount_minor IS NULL OR p_amount_minor!~'^[1-9][0-9]{0,17}$' OR p_category IS NULL OR p_category NOT IN('not_received','quality','quantity','billing')
 OR char_length(coalesce(normalized_note,''))>1000 OR p_request_key IS NULL OR p_request_key!~'^[A-Za-z0-9._:-]{16,120}$' THEN RAISE EXCEPTION 'INVALID_REFUND_REQUEST' USING ERRCODE='22023';END IF;
 amount:=p_amount_minor::bigint;
 fingerprint_value:=encode(sha256(convert_to(jsonb_build_array('request',p_order_id,p_amount_minor,p_category,normalized_note)::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('refund-command:'||actor::text||':'||p_request_key,0));
 SELECT * INTO receipt FROM petro_private.service_refund_commands WHERE actor_id=actor AND request_key=p_request_key;
 IF FOUND THEN IF receipt.fingerprint<>fingerprint_value THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';END IF;RETURN receipt.result;END IF;
 SELECT * INTO p FROM petro_private.service_order_payments WHERE order_id=p_order_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'REFUND_REQUIRES_PAID_ORDER' USING ERRCODE='55000';END IF;
 IF NOT coalesce(petro_private.service_refund_order_access(p_order_id,true),false) THEN RAISE EXCEPTION 'FORBIDDEN_REFUND' USING ERRCODE='42501';END IF;
 SELECT coalesce(sum(r.amount_minor),0),count(*) INTO pending_amount,open_count FROM petro_private.service_refund_requests r
 WHERE r.payment_id=p.id AND NOT EXISTS(SELECT 1 FROM petro_private.service_refund_withdrawals w WHERE w.request_id=r.id) AND NOT EXISTS(SELECT 1 FROM petro_private.service_refund_decisions d WHERE d.request_id=r.id);
 SELECT coalesce(sum(amount_minor),0) INTO refunded_amount FROM petro_private.service_refund_allocations WHERE payment_id=p.id;
 IF amount+pending_amount+refunded_amount>p.charged_amount_minor THEN RAISE EXCEPTION 'REFUND_EXCEEDS_REMAINING_PAYMENT' USING ERRCODE='23514';END IF;
 IF open_count>=20 THEN RAISE EXCEPTION 'REFUND_OPEN_REQUEST_LIMIT' USING ERRCODE='55000';END IF;
 INSERT INTO petro_private.service_refund_requests(id,order_id,payment_id,amount_minor,category,note,requested_by)
 VALUES(new_id,p_order_id,p.id,amount,p_category,normalized_note,actor);
 result:=jsonb_build_object('id',new_id,'orderId',p_order_id,'amountMinor',amount::text,'category',p_category,'note',normalized_note,'status','requested','version',1,'moneyRefunded',false);
 INSERT INTO petro_private.service_refund_commands(actor_id,request_key,fingerprint,result) VALUES(actor,p_request_key,fingerprint_value,result);
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.petro_withdraw_service_refund(p_request_id uuid,p_expected_version bigint,p_request_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=auth.uid();r petro_private.service_refund_requests%ROWTYPE;fingerprint_value text;receipt petro_private.service_refund_commands%ROWTYPE;result jsonb;
BEGIN
 SELECT * INTO r FROM petro_private.service_refund_requests WHERE id=p_request_id;
 IF NOT FOUND OR NOT coalesce(petro_private.service_refund_order_access(r.order_id,true),false) THEN RAISE EXCEPTION 'FORBIDDEN_REFUND' USING ERRCODE='42501';END IF;
 IF p_expected_version IS NULL OR p_expected_version<1 OR p_request_key IS NULL OR p_request_key!~'^[A-Za-z0-9._:-]{16,120}$' THEN RAISE EXCEPTION 'INVALID_REFUND_REQUEST' USING ERRCODE='22023';END IF;
 fingerprint_value:=encode(sha256(convert_to(jsonb_build_array('withdraw',p_request_id,p_expected_version)::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('refund-command:'||actor::text||':'||p_request_key,0));
 SELECT * INTO receipt FROM petro_private.service_refund_commands WHERE actor_id=actor AND request_key=p_request_key;
 IF FOUND THEN IF receipt.fingerprint<>fingerprint_value THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';END IF;RETURN receipt.result;END IF;
 PERFORM 1 FROM petro_private.service_order_payments WHERE id=r.payment_id FOR UPDATE;
 IF NOT coalesce(petro_private.service_refund_order_access(r.order_id,true),false) THEN RAISE EXCEPTION 'FORBIDDEN_REFUND' USING ERRCODE='42501';END IF;
 IF p_expected_version<>1 OR EXISTS(SELECT 1 FROM petro_private.service_refund_withdrawals WHERE request_id=r.id) OR EXISTS(SELECT 1 FROM petro_private.service_refund_decisions WHERE request_id=r.id) THEN RAISE EXCEPTION 'REFUND_VERSION_CONFLICT' USING ERRCODE='PT409';END IF;
 INSERT INTO petro_private.service_refund_withdrawals(request_id,actor_id) VALUES(r.id,actor);
 result:=jsonb_build_object('id',r.id,'orderId',r.order_id,'status','withdrawn','version',2,'moneyRefunded',false);
 INSERT INTO petro_private.service_refund_commands(actor_id,request_key,fingerprint,result) VALUES(actor,p_request_key,fingerprint_value,result);
 RETURN result;
END $$;

COMMIT;
