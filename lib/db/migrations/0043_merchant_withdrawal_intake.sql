BEGIN;
SET LOCAL lock_timeout='5s';
DO $ BEGIN IF(SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('public.petro_merchant_statement(uuid,uuid,integer)')) IS DISTINCT FROM 'cd3c05cee380f44b7abd83a943b03d00e039e4839bfd7557a9fd5e14a3ca51be' THEN RAISE EXCEPTION '0043 statement source drift';END IF;END $;
CREATE TABLE petro_private.merchant_withdrawals(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
 bank_version_id uuid NOT NULL REFERENCES public.petro_bank_account_versions(id) ON DELETE RESTRICT,
 bank_snapshot jsonb NOT NULL CHECK(jsonb_typeof(bank_snapshot)='object'),
 created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,created_at timestamptz NOT NULL DEFAULT transaction_timestamp());
CREATE INDEX merchant_withdrawals_org_time ON petro_private.merchant_withdrawals(organization_id,created_at DESC,id);
CREATE TABLE petro_private.merchant_withdrawal_allocations(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),withdrawal_id uuid NOT NULL REFERENCES petro_private.merchant_withdrawals(id) ON DELETE RESTRICT,
 payment_id uuid NOT NULL REFERENCES petro_private.service_order_payments(id) ON DELETE RESTRICT,
 amount_minor bigint NOT NULL CHECK(amount_minor>0),UNIQUE(withdrawal_id,payment_id));
CREATE INDEX merchant_withdrawal_allocations_payment ON petro_private.merchant_withdrawal_allocations(payment_id);
CREATE TABLE petro_private.merchant_withdrawal_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),withdrawal_id uuid NOT NULL REFERENCES petro_private.merchant_withdrawals(id) ON DELETE RESTRICT,
 version bigint NOT NULL CHECK(version>0),kind text NOT NULL CHECK(kind IN('submitted','approved','rejected','cancelled','refund_adjusted')),
 state text NOT NULL CHECK(state IN('submitted','approved','rejected','cancelled')),
 actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 remaining_minor bigint NOT NULL CHECK(remaining_minor>=0),UNIQUE(withdrawal_id,version));
CREATE TABLE petro_private.merchant_withdrawal_releases(
 allocation_id uuid NOT NULL REFERENCES petro_private.merchant_withdrawal_allocations(id) ON DELETE RESTRICT,
 event_id uuid NOT NULL REFERENCES petro_private.merchant_withdrawal_events(id) ON DELETE RESTRICT,
 refund_request_id uuid REFERENCES petro_private.service_refund_allocations(request_id) ON DELETE RESTRICT,
 amount_minor bigint NOT NULL CHECK(amount_minor>0),PRIMARY KEY(allocation_id,event_id));
CREATE TABLE petro_private.merchant_withdrawal_commands(
 actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,request_key text NOT NULL CHECK(char_length(request_key) BETWEEN 16 AND 120),
 fingerprint text NOT NULL CHECK(fingerprint~'^[0-9a-f]{64}$'),withdrawal_id uuid NOT NULL REFERENCES petro_private.merchant_withdrawals(id) ON DELETE RESTRICT,
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),PRIMARY KEY(actor_id,request_key));
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['merchant_withdrawals','merchant_withdrawal_allocations','merchant_withdrawal_events','merchant_withdrawal_releases','merchant_withdrawal_commands'] LOOP
 EXECUTE format('ALTER TABLE petro_private.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON petro_private.%I FROM PUBLIC,anon,authenticated,service_role',t);
 EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON petro_private.%I FOR EACH ROW EXECUTE FUNCTION petro_private.guard_service_payment_history()',t||'_immutable',t);
END LOOP;END $$;
CREATE FUNCTION petro_private.merchant_withdrawal_scope(p_org uuid,p_write boolean) RETURNS boolean LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT coalesce(petro_private.workforce_user_active(auth.uid()),false) AND EXISTS(SELECT 1 FROM public.petro_organizations o WHERE o.id=p_org AND o.kind IN('station','provider') AND(
 petro_private.platform_has(CASE WHEN p_write THEN ARRAY['owner','finance']::text[] ELSE ARRAY['owner','finance','auditor']::text[] END)
 OR EXISTS(SELECT 1 FROM public.petro_memberships m WHERE m.organization_id=o.id AND m.user_id=auth.uid() AND m.active AND m.scope='organization' AND m.role IN('organization_owner','manager','finance'))))
$$;
CREATE FUNCTION petro_private.merchant_withdrawal_held(p_payment uuid) RETURNS numeric LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT coalesce(sum(a.amount_minor-coalesce((SELECT sum(r.amount_minor) FROM petro_private.merchant_withdrawal_releases r WHERE r.allocation_id=a.id),0)),0)
 FROM petro_private.merchant_withdrawal_allocations a
 WHERE a.payment_id=p_payment AND(SELECT e.state FROM petro_private.merchant_withdrawal_events e WHERE e.withdrawal_id=a.withdrawal_id ORDER BY e.version DESC LIMIT 1) IN('submitted','approved')
$$;
CREATE FUNCTION petro_private.merchant_withdrawal_capacity(p_payment uuid) RETURNS bigint LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT CASE WHEN v.eligible_at>statement_timestamp() THEN 0 ELSE greatest(v.earned_amount_minor
 -coalesce((SELECT sum(r.unsettled_amount_minor) FROM petro_private.service_refund_allocations r WHERE r.payment_id=v.payment_id),0)
 -coalesce((SELECT sum(s.amount_minor) FROM petro_private.service_receivable_settlements s WHERE s.payment_id=v.payment_id),0)
 -coalesce((SELECT sum(r.amount_minor) FROM petro_private.service_refund_requests r WHERE r.payment_id=v.payment_id
 AND NOT EXISTS(SELECT 1 FROM petro_private.service_refund_withdrawals w WHERE w.request_id=r.id)
 AND NOT EXISTS(SELECT 1 FROM petro_private.service_refund_decisions d WHERE d.request_id=r.id)),0)
 -petro_private.merchant_withdrawal_held(v.payment_id),0)::bigint END
 FROM petro_private.service_order_receivables v WHERE v.payment_id=p_payment
$$;
CREATE FUNCTION petro_private.merchant_withdrawal_json(p_id uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT jsonb_build_object('id',w.id,'organizationId',w.organization_id,'organizationName',o.name,'createdAt',w.created_at,
 'createdByName',(SELECT display_name FROM public.petro_profiles WHERE user_id=w.created_by),
 'version',e.version,'status',e.state,'amountMinor',e.remaining_minor::text,
 'originalAmountMinor',(SELECT sum(amount_minor)::text FROM petro_private.merchant_withdrawal_allocations WHERE withdrawal_id=w.id),
 'bank',jsonb_build_object('versionId',w.bank_version_id,'name',w.bank_snapshot->>'bankName','beneficiaryName',w.bank_snapshot->>'beneficiaryName','last4',w.bank_snapshot->>'last4'),
 'canCancel',e.state IN('submitted','approved') AND petro_private.merchant_withdrawal_scope(w.organization_id,true),
 'canReview',e.state='submitted' AND coalesce(petro_private.platform_has(ARRAY['owner','finance']::text[]),false),
 'paid',false,
 'items',(SELECT coalesce(jsonb_agg(jsonb_build_object('paymentId',a.payment_id,'orderId',v.order_id,'branchId',v.merchant_branch_id,'branchName',b.name,'receiptNumber',r.receipt_number,
 'originalAmountMinor',a.amount_minor::text,'heldMinor',(a.amount_minor-coalesce((SELECT sum(x.amount_minor) FROM petro_private.merchant_withdrawal_releases x WHERE x.allocation_id=a.id),0))::text) ORDER BY a.payment_id),'[]'::jsonb)
 FROM petro_private.merchant_withdrawal_allocations a JOIN petro_private.service_order_receivables v ON v.payment_id=a.payment_id JOIN public.petro_branches b ON b.id=v.merchant_branch_id
 JOIN petro_private.service_order_receipts r ON r.payment_id=a.payment_id WHERE a.withdrawal_id=w.id),
 'events',(SELECT jsonb_agg(jsonb_build_object('version',x.version,'kind',x.kind,'status',x.state,'amountMinor',x.remaining_minor::text,'createdAt',x.created_at,'actorName',p.display_name) ORDER BY x.version)
 FROM petro_private.merchant_withdrawal_events x JOIN public.petro_profiles p ON p.user_id=x.actor_id WHERE x.withdrawal_id=w.id))
 FROM petro_private.merchant_withdrawals w JOIN public.petro_organizations o ON o.id=w.organization_id
 CROSS JOIN LATERAL(SELECT * FROM petro_private.merchant_withdrawal_events WHERE withdrawal_id=w.id ORDER BY version DESC LIMIT 1)e WHERE w.id=p_id
$$;
CREATE FUNCTION public.petro_merchant_withdrawals(p_organization_id uuid,p_page integer DEFAULT 1) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;BEGIN
 IF NOT coalesce(petro_private.merchant_withdrawal_scope(p_organization_id,false),false) THEN RAISE EXCEPTION 'FORBIDDEN_WITHDRAWAL' USING ERRCODE='42501';END IF;
 IF p_page IS NULL OR p_page NOT BETWEEN 1 AND 100000 THEN RAISE EXCEPTION 'INVALID_WITHDRAWAL' USING ERRCODE='22023';END IF;
 SELECT jsonb_build_object('page',p_page,'pageSize',20,'canSubmit',petro_private.merchant_withdrawal_scope(p_organization_id,true),'bankPayoutEnabled',false,
 'total',(SELECT count(*) FROM petro_private.merchant_withdrawals WHERE organization_id=p_organization_id),
 'items',coalesce((SELECT jsonb_agg(petro_private.merchant_withdrawal_json(x.id) ORDER BY x.created_at DESC,x.id) FROM(SELECT id,created_at FROM petro_private.merchant_withdrawals WHERE organization_id=p_organization_id ORDER BY created_at DESC,id LIMIT 20 OFFSET((p_page-1)*20))x),'[]'::jsonb),
 'banks',coalesce((SELECT jsonb_agg(jsonb_build_object('id',v.id,'bankName',v.bank_name,'beneficiaryName',v.beneficiary_name,'last4',v.account_last4) ORDER BY v.created_at,v.id)
 FROM public.petro_bank_account_versions v JOIN public.petro_bank_accounts a ON a.id=v.bank_account_id AND a.organization_id=v.organization_id WHERE v.organization_id=p_organization_id AND v.status='approved' AND a.status='active'),'[]'::jsonb))
 INTO result;RETURN result;
END $$;
CREATE FUNCTION public.petro_merchant_withdrawal_options(p_organization_id uuid,p_page integer DEFAULT 1) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;BEGIN
 IF NOT coalesce(petro_private.merchant_withdrawal_scope(p_organization_id,true),false) THEN RAISE EXCEPTION 'FORBIDDEN_WITHDRAWAL' USING ERRCODE='42501';END IF;
 IF p_page IS NULL OR p_page NOT BETWEEN 1 AND 100000 THEN RAISE EXCEPTION 'INVALID_WITHDRAWAL' USING ERRCODE='22023';END IF;
 WITH x AS MATERIALIZED(SELECT v.*,petro_private.merchant_withdrawal_capacity(v.payment_id) AS available FROM petro_private.service_order_receivables v WHERE v.merchant_organization_id=p_organization_id),
 page_rows AS(SELECT * FROM x WHERE available>0 ORDER BY eligible_at,payment_id LIMIT 20 OFFSET((p_page-1)*20))
 SELECT jsonb_build_object('page',p_page,'pageSize',20,'total',(SELECT count(*) FROM x WHERE available>0),
 'items',coalesce((SELECT jsonb_agg(jsonb_build_object('paymentId',v.payment_id,'receiptNumber',r.receipt_number,'branchName',b.name,'amountMinor',v.available::text,'eligibleAt',v.eligible_at) ORDER BY v.eligible_at,v.payment_id)
 FROM page_rows v JOIN public.petro_branches b ON b.id=v.merchant_branch_id JOIN petro_private.service_order_receipts r ON r.payment_id=v.payment_id),'[]'::jsonb)) INTO result;RETURN result;
END $$;
CREATE FUNCTION public.petro_submit_merchant_withdrawal(p_organization_id uuid,p_bank_version_id uuid,p_payment_ids uuid[],p_request_key text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=auth.uid();fingerprint_value text;c petro_private.merchant_withdrawal_commands%ROWTYPE;bank public.petro_bank_account_versions%ROWTYPE;account public.petro_bank_accounts%ROWTYPE;
 p uuid;sorted uuid[];amount bigint;total_amount bigint:=0;new_id uuid:=gen_random_uuid();result jsonb;BEGIN
 IF NOT coalesce(petro_private.merchant_withdrawal_scope(p_organization_id,true),false) THEN RAISE EXCEPTION 'FORBIDDEN_WITHDRAWAL' USING ERRCODE='42501';END IF;
 IF p_bank_version_id IS NULL OR p_request_key IS NULL OR p_request_key!~'^[A-Za-z0-9._:-]{16,120}$' OR cardinality(p_payment_ids) IS NULL OR cardinality(p_payment_ids) NOT BETWEEN 1 AND 100 OR array_position(p_payment_ids,NULL) IS NOT NULL THEN RAISE EXCEPTION 'INVALID_WITHDRAWAL' USING ERRCODE='22023';END IF;
 SELECT array_agg(x ORDER BY x) INTO sorted FROM(SELECT DISTINCT unnest(p_payment_ids) x)s;
 IF cardinality(sorted)<>cardinality(p_payment_ids) THEN RAISE EXCEPTION 'INVALID_WITHDRAWAL' USING ERRCODE='22023';END IF;
 fingerprint_value:=encode(sha256(convert_to(jsonb_build_array('submit',p_organization_id,p_bank_version_id,sorted)::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('withdrawal-command:'||actor::text||':'||p_request_key,0));
 SELECT * INTO c FROM petro_private.merchant_withdrawal_commands WHERE actor_id=actor AND request_key=p_request_key;
 IF FOUND THEN IF c.fingerprint<>fingerprint_value THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';END IF;RETURN c.result;END IF;
 PERFORM 1 FROM petro_private.service_order_payments WHERE id=ANY(sorted) ORDER BY id FOR UPDATE;
 IF(SELECT count(*) FROM petro_private.service_order_receivables WHERE payment_id=ANY(sorted) AND merchant_organization_id=p_organization_id)<>cardinality(sorted) THEN RAISE EXCEPTION 'FORBIDDEN_WITHDRAWAL' USING ERRCODE='42501';END IF;
 SELECT * INTO bank FROM public.petro_bank_account_versions WHERE id=p_bank_version_id AND organization_id=p_organization_id FOR SHARE;
 IF NOT FOUND OR bank.status<>'approved' THEN RAISE EXCEPTION 'WITHDRAWAL_BANK_CHANGED' USING ERRCODE='PT409';END IF;
 SELECT * INTO account FROM public.petro_bank_accounts WHERE id=bank.bank_account_id FOR SHARE;
 IF account.status<>'active' THEN RAISE EXCEPTION 'WITHDRAWAL_BANK_CHANGED' USING ERRCODE='PT409';END IF;
 IF NOT coalesce(petro_private.merchant_withdrawal_scope(p_organization_id,true),false) THEN RAISE EXCEPTION 'FORBIDDEN_WITHDRAWAL' USING ERRCODE='42501';END IF;
 INSERT INTO petro_private.merchant_withdrawals(id,organization_id,bank_version_id,bank_snapshot,created_by)
 VALUES(new_id,p_organization_id,bank.id,jsonb_build_object('accountId',account.id,'accountRevision',account.version,'bankName',bank.bank_name,'beneficiaryName',bank.beneficiary_name,'identifier',bank.account_identifier,'last4',bank.account_last4,'reviewedAt',bank.reviewed_at),actor);
 FOREACH p IN ARRAY sorted LOOP
 amount:=petro_private.merchant_withdrawal_capacity(p);
 IF coalesce(amount,0)<=0 THEN RAISE EXCEPTION 'WITHDRAWAL_NO_ELIGIBLE_REMAINDER' USING ERRCODE='PT409';END IF;
 total_amount:=total_amount+amount;
 INSERT INTO petro_private.merchant_withdrawal_allocations(withdrawal_id,payment_id,amount_minor) VALUES(new_id,p,amount);
 END LOOP;
 INSERT INTO petro_private.merchant_withdrawal_events(withdrawal_id,version,kind,state,actor_id,remaining_minor) VALUES(new_id,1,'submitted','submitted',actor,total_amount);
 result:=petro_private.merchant_withdrawal_json(new_id);
 INSERT INTO petro_private.merchant_withdrawal_commands VALUES(actor,p_request_key,fingerprint_value,new_id,result);
 INSERT INTO public.petro_finance_outbox(event_type,source_type,source_id,payload) VALUES('merchant.withdrawal.submitted','merchant_withdrawal',new_id,jsonb_build_object('organizationId',p_organization_id,'amountMinor',total_amount::text));
 RETURN result;
END $$;
CREATE FUNCTION public.petro_review_merchant_withdrawal(p_id uuid,p_expected_version bigint,p_action text,p_request_key text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=auth.uid();w petro_private.merchant_withdrawals%ROWTYPE;e petro_private.merchant_withdrawal_events%ROWTYPE;c petro_private.merchant_withdrawal_commands%ROWTYPE;
 fp text;result jsonb;new_event uuid:=gen_random_uuid();new_state text;bank public.petro_bank_account_versions%ROWTYPE;account public.petro_bank_accounts%ROWTYPE;BEGIN
 SELECT * INTO w FROM petro_private.merchant_withdrawals WHERE id=p_id;
 IF NOT FOUND OR NOT coalesce(petro_private.merchant_withdrawal_scope(w.organization_id,true),false) OR(p_action IS DISTINCT FROM 'cancel' AND NOT coalesce(petro_private.platform_has(ARRAY['owner','finance']::text[]),false)) THEN RAISE EXCEPTION 'FORBIDDEN_WITHDRAWAL' USING ERRCODE='42501';END IF;
 IF p_expected_version IS NULL OR p_expected_version<1 OR p_action IS NULL OR p_action NOT IN('approve','reject','cancel') OR p_request_key IS NULL OR p_request_key!~'^[A-Za-z0-9._:-]{16,120}$' THEN RAISE EXCEPTION 'INVALID_WITHDRAWAL' USING ERRCODE='22023';END IF;
 fp:=encode(sha256(convert_to(jsonb_build_array('review',p_id,p_expected_version,p_action)::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('withdrawal-command:'||actor::text||':'||p_request_key,0));
 SELECT * INTO c FROM petro_private.merchant_withdrawal_commands WHERE actor_id=actor AND request_key=p_request_key;
 IF FOUND THEN IF c.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';END IF;RETURN c.result;END IF;
 PERFORM 1 FROM petro_private.service_order_payments WHERE id IN(SELECT payment_id FROM petro_private.merchant_withdrawal_allocations WHERE withdrawal_id=p_id) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM petro_private.merchant_withdrawals WHERE id=p_id FOR UPDATE;
 IF NOT coalesce(petro_private.merchant_withdrawal_scope(w.organization_id,true),false) OR(p_action<>'cancel' AND NOT coalesce(petro_private.platform_has(ARRAY['owner','finance']::text[]),false)) THEN RAISE EXCEPTION 'FORBIDDEN_WITHDRAWAL' USING ERRCODE='42501';END IF;
 SELECT * INTO STRICT e FROM petro_private.merchant_withdrawal_events WHERE withdrawal_id=p_id ORDER BY version DESC LIMIT 1;
 IF e.version<>p_expected_version OR e.state NOT IN('submitted','approved') OR(p_action IN('approve','reject') AND e.state<>'submitted') THEN RAISE EXCEPTION 'WITHDRAWAL_VERSION_CONFLICT' USING ERRCODE='PT409';END IF;
 IF p_action='approve' THEN
 SELECT * INTO bank FROM public.petro_bank_account_versions WHERE id=w.bank_version_id FOR SHARE;
 SELECT * INTO account FROM public.petro_bank_accounts WHERE id=bank.bank_account_id FOR SHARE;
 IF bank.status<>'approved' OR account.status<>'active' OR account.version<>(w.bank_snapshot->>'accountRevision')::bigint THEN RAISE EXCEPTION 'WITHDRAWAL_BANK_CHANGED' USING ERRCODE='PT409';END IF;
 IF EXISTS(SELECT 1 FROM petro_private.service_refund_requests r JOIN petro_private.merchant_withdrawal_allocations a ON a.payment_id=r.payment_id WHERE a.withdrawal_id=p_id
 AND NOT EXISTS(SELECT 1 FROM petro_private.service_refund_withdrawals x WHERE x.request_id=r.id) AND NOT EXISTS(SELECT 1 FROM petro_private.service_refund_decisions d WHERE d.request_id=r.id)) THEN RAISE EXCEPTION 'WITHDRAWAL_REFUND_PENDING' USING ERRCODE='PT409';END IF;
 END IF;
 new_state:=CASE p_action WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE 'cancelled' END;
 INSERT INTO petro_private.merchant_withdrawal_events(id,withdrawal_id,version,kind,state,actor_id,remaining_minor) VALUES(new_event,p_id,e.version+1,new_state,new_state,actor,CASE WHEN p_action='approve' THEN e.remaining_minor ELSE 0 END);
 IF p_action<>'approve' THEN
 INSERT INTO petro_private.merchant_withdrawal_releases(allocation_id,event_id,amount_minor)
 SELECT a.id,new_event,a.amount_minor-coalesce((SELECT sum(amount_minor) FROM petro_private.merchant_withdrawal_releases WHERE allocation_id=a.id),0)
 FROM petro_private.merchant_withdrawal_allocations a WHERE a.withdrawal_id=p_id AND a.amount_minor>coalesce((SELECT sum(amount_minor) FROM petro_private.merchant_withdrawal_releases WHERE allocation_id=a.id),0);
 END IF;
 result:=petro_private.merchant_withdrawal_json(p_id);
 INSERT INTO petro_private.merchant_withdrawal_commands VALUES(actor,p_request_key,fp,p_id,result);
 INSERT INTO public.petro_finance_outbox(event_type,source_type,source_id,payload) VALUES('merchant.withdrawal.'||new_state,'merchant_withdrawal_event',new_event,jsonb_build_object('withdrawalId',p_id,'version',e.version+1));
 RETURN result;
END $$;
CREATE FUNCTION petro_private.adjust_withdrawal_after_refund() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE a record;e petro_private.merchant_withdrawal_events%ROWTYPE;remaining bigint:=NEW.unsettled_amount_minor;release_amount bigint;event_id uuid;new_amount bigint;BEGIN
 -- Caller holds the original payment and financial accounts. This hook never takes other payment/account locks.
 FOR a IN SELECT x.*,x.amount_minor-coalesce((SELECT sum(amount_minor) FROM petro_private.merchant_withdrawal_releases WHERE allocation_id=x.id),0) AS held
 FROM petro_private.merchant_withdrawal_allocations x WHERE x.payment_id=NEW.payment_id ORDER BY x.withdrawal_id,x.id LOOP
 IF remaining<=0 THEN EXIT;END IF;
 PERFORM 1 FROM petro_private.merchant_withdrawals WHERE id=a.withdrawal_id FOR UPDATE;
 SELECT * INTO STRICT e FROM petro_private.merchant_withdrawal_events WHERE withdrawal_id=a.withdrawal_id ORDER BY version DESC LIMIT 1;
 IF e.state NOT IN('submitted','approved') OR a.held<=0 THEN CONTINUE;END IF;
 release_amount:=least(a.held,remaining);remaining:=remaining-release_amount;new_amount:=e.remaining_minor-release_amount;event_id:=gen_random_uuid();
 INSERT INTO petro_private.merchant_withdrawal_events(id,withdrawal_id,version,kind,state,actor_id,remaining_minor)
 VALUES(event_id,a.withdrawal_id,e.version+1,'refund_adjusted',CASE WHEN new_amount=0 THEN 'cancelled' ELSE 'submitted' END,auth.uid(),new_amount);
 INSERT INTO petro_private.merchant_withdrawal_releases(allocation_id,event_id,refund_request_id,amount_minor) VALUES(a.id,event_id,NEW.request_id,release_amount);
 INSERT INTO public.petro_finance_outbox(event_type,source_type,source_id,payload) VALUES('merchant.withdrawal.refund_adjusted','merchant_withdrawal_event',event_id,jsonb_build_object('withdrawalId',a.withdrawal_id,'refundRequestId',NEW.request_id,'amountMinor',release_amount::text));
 END LOOP;RETURN NEW;
END $$;
CREATE TRIGGER merchant_withdrawal_refund_adjust AFTER INSERT ON petro_private.service_refund_allocations FOR EACH ROW EXECUTE FUNCTION petro_private.adjust_withdrawal_after_refund();
CREATE OR REPLACE FUNCTION public.petro_merchant_statement(p_organization_id uuid DEFAULT NULL,p_branch_id uuid DEFAULT NULL,p_page integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=auth.uid();central boolean;result jsonb;as_of timestamptz:=statement_timestamp();
BEGIN
 IF NOT coalesce(petro_private.workforce_user_active(actor),false) THEN RAISE EXCEPTION 'FORBIDDEN_MERCHANT_STATEMENT' USING ERRCODE='42501';END IF;
 IF p_page IS NULL OR p_page<1 OR p_page>100000 THEN RAISE EXCEPTION 'INVALID_STATEMENT_FILTER' USING ERRCODE='22023';END IF;
 central:=coalesce(petro_private.platform_has(ARRAY['owner','finance','auditor']::text[]),false);
 IF (NOT central OR p_organization_id IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM public.petro_organizations o WHERE o.kind IN('station','provider') AND(p_organization_id IS NULL OR o.id=p_organization_id)
 AND(central OR EXISTS(SELECT 1 FROM public.petro_memberships m WHERE m.organization_id=o.id AND m.user_id=actor AND m.active AND m.role IN('organization_owner','manager','finance')))) THEN
 RAISE EXCEPTION 'FORBIDDEN_MERCHANT_STATEMENT' USING ERRCODE='42501';END IF;
 IF p_branch_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.petro_branches b JOIN public.petro_organizations o ON o.id=b.organization_id
 WHERE b.id=p_branch_id AND o.kind IN('station','provider') AND(p_organization_id IS NULL OR o.id=p_organization_id)
 AND(central OR EXISTS(SELECT 1 FROM public.petro_memberships m WHERE m.organization_id=b.organization_id AND m.user_id=actor AND m.active AND m.role IN('organization_owner','manager','finance')
 AND(m.scope='organization' OR EXISTS(SELECT 1 FROM public.petro_membership_branches mb WHERE mb.membership_id=m.id AND mb.organization_id=b.organization_id AND mb.branch_id=b.id))))) THEN
 RAISE EXCEPTION 'FORBIDDEN_MERCHANT_STATEMENT' USING ERRCODE='42501';END IF;
 WITH allowed_orgs AS MATERIALIZED(
 SELECT o.id,o.name,o.kind FROM public.petro_organizations o WHERE o.kind IN('station','provider')
 AND(central OR EXISTS(SELECT 1 FROM public.petro_memberships m WHERE m.organization_id=o.id AND m.user_id=actor AND m.active AND m.role IN('organization_owner','manager','finance')))
 ),allowed_branches AS MATERIALIZED(
 SELECT b.id,b.organization_id,b.name,o.name AS org_name FROM public.petro_branches b JOIN allowed_orgs o ON o.id=b.organization_id
 WHERE(p_organization_id IS NULL OR o.id=p_organization_id)
 AND(central OR EXISTS(SELECT 1 FROM public.petro_memberships m WHERE m.organization_id=b.organization_id AND m.user_id=actor AND m.active AND m.role IN('organization_owner','manager','finance')
 AND(m.scope='organization' OR EXISTS(SELECT 1 FROM public.petro_membership_branches mb WHERE mb.membership_id=m.id AND mb.organization_id=b.organization_id AND mb.branch_id=b.id))))
 ),source AS MATERIALIZED(
 SELECT v.*,b.name AS branch_name,b.org_name,receipt.receipt_number,
 coalesce(r.refunded,0) AS refunded,coalesce(r.unsettled_refund,0) AS unsettled_refund,coalesce(r.debt,0) AS debt,
 coalesce(s.paid,0) AS paid,coalesce(c.claimed,0) AS claimed,petro_private.merchant_withdrawal_held(v.payment_id) AS held
 FROM petro_private.service_order_receivables v JOIN allowed_branches b ON b.id=v.merchant_branch_id AND b.organization_id=v.merchant_organization_id
 JOIN petro_private.service_order_receipts receipt ON receipt.payment_id=v.payment_id
 LEFT JOIN LATERAL(SELECT sum(a.amount_minor) AS refunded,sum(a.unsettled_amount_minor) AS unsettled_refund,sum(a.merchant_debt_minor) AS debt FROM petro_private.service_refund_allocations a WHERE a.payment_id=v.payment_id)r ON true
 LEFT JOIN LATERAL(SELECT sum(a.amount_minor) AS paid FROM petro_private.service_receivable_settlements a WHERE a.payment_id=v.payment_id)s ON true
 LEFT JOIN LATERAL(SELECT sum(q.amount_minor) AS claimed FROM petro_private.service_refund_requests q WHERE q.payment_id=v.payment_id
 AND NOT EXISTS(SELECT 1 FROM petro_private.service_refund_withdrawals w WHERE w.request_id=q.id)
 AND NOT EXISTS(SELECT 1 FROM petro_private.service_refund_decisions d WHERE d.request_id=q.id))c ON true
 WHERE(p_branch_id IS NULL OR b.id=p_branch_id)
 ),balances AS MATERIALIZED(
 SELECT *,greatest(earned_amount_minor-unsettled_refund-paid,0) AS remaining FROM source
 ),scoped AS MATERIALIZED(
 SELECT *,least(greatest(remaining-held,0),claimed) AS disputed,
 CASE WHEN eligible_at<=as_of THEN greatest(remaining-claimed-held,0) ELSE 0 END AS eligible,
 CASE WHEN eligible_at>as_of THEN greatest(remaining-claimed-held,0) ELSE 0 END AS immature
 FROM balances
 ),page_rows AS(
 SELECT * FROM scoped ORDER BY earned_at DESC,order_id DESC LIMIT 20 OFFSET ((p_page-1)*20)
 ),branch_summary AS(
 SELECT merchant_branch_id,sum(earned_amount_minor) AS earned,sum(refunded) AS refunded,sum(paid) AS paid,sum(remaining) AS remaining,
 sum(debt) AS debt,sum(held) AS held,sum(disputed) AS disputed,sum(eligible) AS eligible,sum(immature) AS immature
 FROM scoped GROUP BY merchant_branch_id
 )
 SELECT jsonb_build_object('asOf',as_of,'currency','EGP','timezone','Africa/Cairo','page',p_page,'pageSize',20,'withdrawalsEnabled',true,'bankPayoutEnabled',false,
 'total',(SELECT count(*) FROM scoped),
 'organizations',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'kind',kind) ORDER BY name,id),'[]'::jsonb) FROM allowed_orgs),
 'branches',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',b.id,'organizationId',b.organization_id,'name',b.name,
 'earnedMinor',coalesce(s.earned,0)::text,'refundedMinor',coalesce(s.refunded,0)::text,'settledMinor',coalesce(s.paid,0)::text,
 'withdrawalReservedMinor',coalesce(s.held,0)::text,'remainingMinor',coalesce(s.remaining,0)::text,'merchantDebtMinor',coalesce(s.debt,0)::text,'disputedMinor',coalesce(s.disputed,0)::text,
 'eligibleBeforeDebtMinor',coalesce(s.eligible,0)::text,'notYetEligibleMinor',coalesce(s.immature,0)::text) ORDER BY b.name,b.id),'[]'::jsonb)
 FROM allowed_branches b LEFT JOIN branch_summary s ON s.merchant_branch_id=b.id WHERE(p_branch_id IS NULL OR b.id=p_branch_id)),
 'totals',(SELECT jsonb_build_object('earnedMinor',coalesce(sum(earned_amount_minor),0)::text,'refundedMinor',coalesce(sum(refunded),0)::text,
 'unsettledRefundMinor',coalesce(sum(unsettled_refund),0)::text,'settledMinor',coalesce(sum(paid),0)::text,'remainingMinor',coalesce(sum(remaining),0)::text,
 'withdrawalReservedMinor',coalesce(sum(held),0)::text,'merchantDebtMinor',coalesce(sum(debt),0)::text,'disputedMinor',coalesce(sum(disputed),0)::text,'eligibleBeforeDebtMinor',coalesce(sum(eligible),0)::text,
 'notYetEligibleMinor',coalesce(sum(immature),0)::text) FROM scoped),
 'items',(SELECT coalesce(jsonb_agg(jsonb_build_object('orderId',order_id,'paymentId',payment_id,'organizationId',merchant_organization_id,'organizationName',org_name,
 'branchId',merchant_branch_id,'branchName',branch_name,'receiptNumber',receipt_number,'earnedAt',earned_at,'periodStart',period_start,'periodEnd',period_end,'eligibleAt',eligible_at,
 'settlementPolicyId',settlement_policy_id,'earnedMinor',earned_amount_minor::text,'refundedMinor',refunded::text,'unsettledRefundMinor',unsettled_refund::text,
 'withdrawalReservedMinor',held::text,'settledMinor',paid::text,'remainingMinor',remaining::text,'merchantDebtMinor',debt::text,'disputedMinor',disputed::text,'eligibleBeforeDebtMinor',eligible::text,'notYetEligibleMinor',immature::text)
 ORDER BY earned_at DESC,order_id DESC),'[]'::jsonb) FROM page_rows))
 INTO result;
 RETURN result;
END $$;

REVOKE ALL ON FUNCTION petro_private.merchant_withdrawal_scope(uuid,boolean),petro_private.merchant_withdrawal_held(uuid),petro_private.merchant_withdrawal_capacity(uuid),petro_private.merchant_withdrawal_json(uuid),petro_private.adjust_withdrawal_after_refund() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.petro_merchant_withdrawals(uuid,integer),public.petro_merchant_withdrawal_options(uuid,integer),public.petro_submit_merchant_withdrawal(uuid,uuid,uuid[],text),public.petro_review_merchant_withdrawal(uuid,bigint,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.petro_merchant_withdrawals(uuid,integer),public.petro_merchant_withdrawal_options(uuid,integer),public.petro_submit_merchant_withdrawal(uuid,uuid,uuid[],text),public.petro_review_merchant_withdrawal(uuid,bigint,text,text) TO authenticated;
COMMIT;
