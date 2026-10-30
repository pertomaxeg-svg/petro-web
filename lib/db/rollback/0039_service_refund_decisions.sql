BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM petro_private.service_refund_decisions) OR EXISTS(SELECT 1 FROM petro_private.service_refund_allocations)
 OR EXISTS(SELECT 1 FROM petro_private.service_refund_documents) OR EXISTS(SELECT 1 FROM petro_private.service_receivable_settlements)
 OR EXISTS(SELECT 1 FROM public.petro_finance_journal_entries WHERE entry_type='service_refund')
 OR EXISTS(SELECT 1 FROM public.petro_finance_journal_lines l JOIN public.petro_finance_accounts a ON a.id=l.account_id WHERE a.account_kind='merchant_refund_receivable')
 OR EXISTS(SELECT 1 FROM public.petro_finance_accounts WHERE account_kind='merchant_refund_receivable' AND(account_code<>'SYS-MERCHANT-REFUND-RECEIVABLE' OR display_name<>'مديونية التجار عن رد خدمات مسوّاة')) THEN
 RAISE EXCEPTION '0039 rollback refuses to remove refund or settlement financial history';END IF;
END $$;
DROP FUNCTION public.petro_decide_service_refund(uuid,bigint,text,text,text,text);
CREATE OR REPLACE FUNCTION public.petro_service_order_refund_requests(p_order_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE p petro_private.service_order_payments%ROWTYPE;pending_amount numeric;items jsonb;can_write boolean;
BEGIN
 IF NOT coalesce(petro_private.service_refund_order_access(p_order_id,false),false) THEN RAISE EXCEPTION 'FORBIDDEN_REFUND' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM petro_private.service_order_payments WHERE order_id=p_order_id;
 can_write:=coalesce(petro_private.service_refund_order_access(p_order_id,true),false);
 SELECT coalesce(sum(r.amount_minor),0) INTO pending_amount FROM petro_private.service_refund_requests r
 WHERE r.order_id=p_order_id AND NOT EXISTS(SELECT 1 FROM petro_private.service_refund_withdrawals w WHERE w.request_id=r.id);
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY (x.status='requested') DESC,x."createdAt" DESC,x.id),'[]'::jsonb) INTO items FROM(
 SELECT r.id,r.order_id AS "orderId",r.amount_minor::text AS "amountMinor",r.category,r.note,r.created_at AS "createdAt",
 pr.display_name AS "requestedByName",CASE WHEN w.request_id IS NULL THEN 'requested' ELSE 'withdrawn' END AS status,
 CASE WHEN w.request_id IS NULL THEN 1 ELSE 2 END AS version,w.created_at AS "withdrawnAt",
 (can_write AND w.request_id IS NULL) AS "canWithdraw"
 FROM petro_private.service_refund_requests r JOIN public.petro_profiles pr ON pr.user_id=r.requested_by
 LEFT JOIN petro_private.service_refund_withdrawals w ON w.request_id=r.id
 WHERE r.order_id=p_order_id ORDER BY (w.request_id IS NULL) DESC,r.created_at DESC,r.id LIMIT 50
 )x;
 RETURN jsonb_build_object('orderId',p_order_id,'paid',p.id IS NOT NULL,'chargedAmountMinor',coalesce(p.charged_amount_minor,0)::text,
 'requestedAmountMinor',pending_amount::text,'remainingRequestableMinor',(coalesce(p.charged_amount_minor,0)-pending_amount)::text,
 'receiptNumber',(SELECT receipt_number FROM petro_private.service_order_receipts WHERE order_id=p_order_id),
 'canRequest',can_write AND p.id IS NOT NULL AND pending_amount<p.charged_amount_minor,
 'items',items,'total',(SELECT count(*) FROM petro_private.service_refund_requests WHERE order_id=p_order_id),
 'financialRefundEnabled',false);
END $$;

CREATE OR REPLACE FUNCTION public.petro_request_service_refund(p_order_id uuid,p_amount_minor text,p_category text,p_note text,p_request_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=auth.uid();p petro_private.service_order_payments%ROWTYPE;amount bigint;normalized_note text:=nullif(btrim(p_note),'');
 fingerprint_value text;receipt petro_private.service_refund_commands%ROWTYPE;pending_amount numeric;open_count bigint;new_id uuid:=gen_random_uuid();result jsonb;
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
 WHERE r.payment_id=p.id AND NOT EXISTS(SELECT 1 FROM petro_private.service_refund_withdrawals w WHERE w.request_id=r.id);
 IF amount+pending_amount>p.charged_amount_minor THEN RAISE EXCEPTION 'REFUND_EXCEEDS_REMAINING_PAYMENT' USING ERRCODE='23514';END IF;
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
 IF p_expected_version<>1 OR EXISTS(SELECT 1 FROM petro_private.service_refund_withdrawals WHERE request_id=r.id) THEN RAISE EXCEPTION 'REFUND_VERSION_CONFLICT' USING ERRCODE='40001';END IF;
 INSERT INTO petro_private.service_refund_withdrawals(request_id,actor_id) VALUES(r.id,actor);
 result:=jsonb_build_object('id',r.id,'orderId',r.order_id,'status','withdrawn','version',2,'moneyRefunded',false);
 INSERT INTO petro_private.service_refund_commands(actor_id,request_key,fingerprint,result) VALUES(actor,p_request_key,fingerprint_value,result);
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION petro_private.guard_service_payment_reversal() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NEW.reverses_entry_id IS NOT NULL AND EXISTS(
 SELECT 1 FROM petro_private.service_order_payments WHERE journal_entry_id=NEW.reverses_entry_id) THEN
 RAISE EXCEPTION 'USE_SERVICE_ORDER_REFUND_WORKFLOW' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;

DROP TABLE petro_private.service_refund_documents;
DROP TABLE petro_private.service_refund_allocations;
DROP TABLE petro_private.service_refund_decisions;
DROP TABLE petro_private.service_receivable_settlements;
DROP FUNCTION petro_private.validate_service_receivable_settlement();
DROP SEQUENCE petro_private.service_credit_document_seq;
DELETE FROM public.petro_finance_accounts WHERE account_kind='merchant_refund_receivable' AND account_code='SYS-MERCHANT-REFUND-RECEIVABLE';
ALTER TABLE public.petro_finance_accounts DROP CONSTRAINT petro_finance_accounts_account_kind_check;
ALTER TABLE public.petro_finance_accounts ADD CONSTRAINT petro_finance_accounts_account_kind_check CHECK ((account_kind = ANY (ARRAY['bank_clearing'::text, 'unallocated_receipts'::text, 'company_funding'::text, 'branch_funding'::text, 'subscription_receipts_held'::text, 'merchant_payable'::text])));
ALTER TABLE public.petro_finance_accounts DROP CONSTRAINT petro_finance_accounts_check;
ALTER TABLE public.petro_finance_accounts ADD CONSTRAINT petro_finance_accounts_check CHECK ((((account_kind = 'company_funding'::text) AND (normal_side = 'credit'::text) AND (organization_id IS NOT NULL) AND (branch_id IS NULL) AND (receiving_bank_account_id IS NULL)) OR ((account_kind = 'branch_funding'::text) AND (normal_side = 'credit'::text) AND (organization_id IS NOT NULL) AND (branch_id IS NOT NULL) AND (receiving_bank_account_id IS NULL)) OR ((account_kind = 'bank_clearing'::text) AND (normal_side = 'debit'::text) AND (organization_id IS NULL) AND (branch_id IS NULL) AND (receiving_bank_account_id IS NOT NULL)) OR ((account_kind = ANY (ARRAY['unallocated_receipts'::text, 'subscription_receipts_held'::text, 'merchant_payable'::text])) AND (normal_side = 'credit'::text) AND (organization_id IS NULL) AND (branch_id IS NULL) AND (receiving_bank_account_id IS NULL))));
ALTER TABLE public.petro_finance_journal_entries DROP CONSTRAINT petro_finance_journal_entries_entry_type_check;
ALTER TABLE public.petro_finance_journal_entries ADD CONSTRAINT petro_finance_journal_entries_entry_type_check CHECK ((entry_type = ANY (ARRAY['bank_receipt'::text, 'topup_allocation'::text, 'subscription_collection'::text, 'internal_transfer'::text, 'reservation_consumption'::text, 'reversal'::text])));
COMMIT;
