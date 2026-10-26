BEGIN;
CREATE TABLE petro_private.service_refund_requests(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 order_id uuid NOT NULL REFERENCES public.petro_service_orders(id) ON DELETE RESTRICT,
 payment_id uuid NOT NULL REFERENCES petro_private.service_order_payments(id) ON DELETE RESTRICT,
 amount_minor bigint NOT NULL CHECK(amount_minor>0),
 category text NOT NULL CHECK(category IN('not_received','quality','quantity','billing')),
 note text CHECK(note IS NULL OR char_length(note)<=1000),
 requested_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX service_refund_requests_order_idx ON petro_private.service_refund_requests(order_id,created_at DESC,id);
CREATE TABLE petro_private.service_refund_withdrawals(
 request_id uuid PRIMARY KEY REFERENCES petro_private.service_refund_requests(id) ON DELETE RESTRICT,
 actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE petro_private.service_refund_commands(
 actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 request_key text NOT NULL CHECK(char_length(request_key) BETWEEN 16 AND 120),
 fingerprint text NOT NULL CHECK(fingerprint~'^[0-9a-f]{64}$'),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(actor_id,request_key)
);
ALTER TABLE petro_private.service_refund_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE petro_private.service_refund_withdrawals ENABLE ROW LEVEL SECURITY;
ALTER TABLE petro_private.service_refund_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON petro_private.service_refund_requests,petro_private.service_refund_withdrawals,petro_private.service_refund_commands FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION petro_private.guard_refund_request_history() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Refund request history is immutable' USING ERRCODE='55000';END $$;
REVOKE ALL ON FUNCTION petro_private.guard_refund_request_history() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER service_refund_request_immutable BEFORE UPDATE OR DELETE ON petro_private.service_refund_requests FOR EACH ROW EXECUTE FUNCTION petro_private.guard_refund_request_history();
CREATE TRIGGER service_refund_withdrawal_immutable BEFORE UPDATE OR DELETE ON petro_private.service_refund_withdrawals FOR EACH ROW EXECUTE FUNCTION petro_private.guard_refund_request_history();
CREATE TRIGGER service_refund_command_immutable BEFORE UPDATE OR DELETE ON petro_private.service_refund_commands FOR EACH ROW EXECUTE FUNCTION petro_private.guard_refund_request_history();

CREATE FUNCTION petro_private.service_refund_order_access(p_order_id uuid,p_write boolean) RETURNS boolean
LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT coalesce(petro_private.workforce_user_active(auth.uid()),false) AND EXISTS(
 SELECT 1 FROM public.petro_service_orders o WHERE o.id=p_order_id AND(
 petro_private.platform_has(CASE WHEN p_write THEN ARRAY['owner','finance']::text[] ELSE ARRAY['owner','finance','operations','auditor']::text[] END)
 OR EXISTS(SELECT 1 FROM public.petro_memberships m WHERE m.user_id=auth.uid() AND m.active
 AND m.organization_id=o.company_organization_id AND m.role IN('organization_owner','manager','finance')
 AND(m.scope='organization' OR EXISTS(SELECT 1 FROM public.petro_membership_branches mb WHERE mb.membership_id=m.id AND mb.organization_id=m.organization_id AND mb.branch_id=o.company_branch_id)))
 OR(NOT p_write AND(
 coalesce(petro_private.service_order_worker_current(o.id),false)
 OR EXISTS(SELECT 1 FROM public.petro_memberships m WHERE m.user_id=auth.uid() AND m.active
 AND m.organization_id=o.merchant_organization_id AND m.role IN('organization_owner','manager','finance')
 AND(m.scope='organization' OR EXISTS(SELECT 1 FROM public.petro_membership_branches mb WHERE mb.membership_id=m.id AND mb.organization_id=m.organization_id AND mb.branch_id=o.merchant_branch_id)))
 ))))
$$;
REVOKE ALL ON FUNCTION petro_private.service_refund_order_access(uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.petro_service_order_refund_requests(p_order_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE p petro_private.service_order_payments%ROWTYPE;pending_amount numeric;items jsonb;can_write boolean;
BEGIN
 IF NOT coalesce(petro_private.service_refund_order_access(p_order_id,false),false) THEN RAISE EXCEPTION 'FORBIDDEN_REFUND' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM petro_private.service_order_payments WHERE order_id=p_order_id;
 can_write:=coalesce(petro_private.service_refund_order_access(p_order_id,true),false);
 SELECT coalesce(sum(r.amount_minor),0) INTO pending_amount FROM petro_private.service_refund_requests r
 WHERE r.order_id=p_order_id AND NOT EXISTS(SELECT 1 FROM petro_private.service_refund_withdrawals w WHERE w.request_id=r.id);
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x."createdAt" DESC,x.id),'[]'::jsonb) INTO items FROM(
 SELECT r.id,r.order_id AS "orderId",r.amount_minor::text AS "amountMinor",r.category,r.note,r.created_at AS "createdAt",
 pr.display_name AS "requestedByName",CASE WHEN w.request_id IS NULL THEN 'requested' ELSE 'withdrawn' END AS status,
 CASE WHEN w.request_id IS NULL THEN 1 ELSE 2 END AS version,w.created_at AS "withdrawnAt",
 (can_write AND w.request_id IS NULL) AS "canWithdraw"
 FROM petro_private.service_refund_requests r JOIN public.petro_profiles pr ON pr.user_id=r.requested_by
 LEFT JOIN petro_private.service_refund_withdrawals w ON w.request_id=r.id
 WHERE r.order_id=p_order_id ORDER BY r.created_at DESC,r.id LIMIT 50
 )x;
 RETURN jsonb_build_object('orderId',p_order_id,'paid',p.id IS NOT NULL,'chargedAmountMinor',coalesce(p.charged_amount_minor,0)::text,
 'requestedAmountMinor',pending_amount::text,'remainingRequestableMinor',(coalesce(p.charged_amount_minor,0)-pending_amount)::text,
 'receiptNumber',(SELECT receipt_number FROM petro_private.service_order_receipts WHERE order_id=p_order_id),
 'canRequest',can_write AND p.id IS NOT NULL AND pending_amount<p.charged_amount_minor,
 'items',items,'total',(SELECT count(*) FROM petro_private.service_refund_requests WHERE order_id=p_order_id),
 'financialRefundEnabled',false);
END $$;

CREATE FUNCTION public.petro_request_service_refund(p_order_id uuid,p_amount_minor text,p_category text,p_note text,p_request_key text) RETURNS jsonb
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

CREATE FUNCTION public.petro_withdraw_service_refund(p_request_id uuid,p_expected_version bigint,p_request_key text) RETURNS jsonb
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
REVOKE ALL ON FUNCTION public.petro_service_order_refund_requests(uuid),public.petro_request_service_refund(uuid,text,text,text,text),public.petro_withdraw_service_refund(uuid,bigint,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.petro_service_order_refund_requests(uuid),public.petro_request_service_refund(uuid,text,text,text,text),public.petro_withdraw_service_refund(uuid,bigint,text) TO authenticated;
COMMIT;
