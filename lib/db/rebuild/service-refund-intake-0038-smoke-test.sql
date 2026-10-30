-- Runs only inside the disposable0037 paid-fixture transaction.
DO $refund_gate$ BEGIN
 IF to_regprocedure('public.petro_service_order_refund_requests(uuid)') IS NULL
 OR to_regprocedure('public.petro_request_service_refund(uuid,text,text,text,text)') IS NULL
 OR to_regprocedure('public.petro_withdraw_service_refund(uuid,bigint,text)') IS NULL THEN
 RAISE EXCEPTION 'REFUND_REQUEST_INTAKE_MISSING';
 END IF;
END $refund_gate$;

DO $refund_intake$
DECLARE o uuid;co uuid;cb uuid;mo uuid;mb uuid;other_branch uuid;r jsonb;replay jsonb;s jsonb;second jsonb;first_id uuid;total_journal bigint;stock bigint;membership uuid;actor uuid;history_id uuid;history_item jsonb;history_index integer;
BEGIN
 SELECT p.order_id,so.company_organization_id,so.company_branch_id,so.merchant_organization_id,so.merchant_branch_id
 INTO STRICT o,co,cb,mo,mb FROM petro_private.service_order_payments p JOIN public.petro_service_orders so ON so.id=p.order_id
 WHERE p.charged_amount_minor=8750;
 SELECT id INTO STRICT other_branch FROM public.petro_branches WHERE organization_id=co AND id<>cb LIMIT 1;
 INSERT INTO auth.users(id,email,raw_user_meta_data,email_confirmed_at) VALUES
 ('00000000-0000-4000-8000-000000003801','refund-company@example.invalid','{"username":"refund_company"}',now()),
 ('00000000-0000-4000-8000-000000003802','refund-other-branch@example.invalid','{"username":"refund_other_branch"}',now()),
 ('00000000-0000-4000-8000-000000003803','refund-merchant@example.invalid','{"username":"refund_merchant"}',now()),
 ('00000000-0000-4000-8000-000000003804','refund-operations@example.invalid','{"username":"refund_operations"}',now());
 UPDATE public.petro_profiles SET active=true,account_status='active',password_change_required=false
 WHERE user_id IN('00000000-0000-4000-8000-000000003801','00000000-0000-4000-8000-000000003802','00000000-0000-4000-8000-000000003803','00000000-0000-4000-8000-000000003804');
 INSERT INTO public.petro_platform_roles(user_id,role,active) VALUES('00000000-0000-4000-8000-000000003804','operations',true);
 membership:=gen_random_uuid();
 INSERT INTO public.petro_memberships(id,user_id,organization_id,role,scope,active) VALUES(membership,'00000000-0000-4000-8000-000000003801',co,'finance','branches',true);
 INSERT INTO public.petro_membership_branches(organization_id,membership_id,branch_id) VALUES(co,membership,cb);
 membership:=gen_random_uuid();
 INSERT INTO public.petro_memberships(id,user_id,organization_id,role,scope,active) VALUES(membership,'00000000-0000-4000-8000-000000003802',co,'manager','branches',true);
 INSERT INTO public.petro_membership_branches(organization_id,membership_id,branch_id) VALUES(co,membership,other_branch);
 membership:=gen_random_uuid();
 INSERT INTO public.petro_memberships(id,user_id,organization_id,role,scope,active) VALUES(membership,'00000000-0000-4000-8000-000000003803',mo,'manager','branches',true);
 INSERT INTO public.petro_membership_branches(organization_id,membership_id,branch_id) VALUES(mo,membership,mb);
 SELECT count(*) INTO total_journal FROM public.petro_finance_journal_entries;
 SELECT count(*) INTO stock FROM public.petro_inventory_movements;
 PERFORM set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000003802',true);
 BEGIN PERFORM public.petro_service_order_refund_requests(o);RAISE EXCEPTION 'Other branch read refund requests';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 BEGIN PERFORM public.petro_request_service_refund(o,'100','quality',NULL,'refund-other-branch-01');RAISE EXCEPTION 'Other branch requested refund';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 FOREACH actor IN ARRAY ARRAY['00000000-0000-4000-8000-000000003803'::uuid,'00000000-0000-4000-8000-000000003804'::uuid,'00000000-0000-4000-8000-000000003702'::uuid] LOOP
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM public.petro_service_order_refund_requests(o);
 BEGIN PERFORM public.petro_request_service_refund(o,'100','quality',NULL,'refund-read-role-denied');RAISE EXCEPTION 'Read role requested company money';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 END LOOP;
 PERFORM set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000003801',true);
 r:=public.petro_request_service_refund(o,'2500','quality',NULL,'refund-first-request-01');
 IF r->>'status'<>'requested' OR r->>'moneyRefunded'<>'false' OR r->>'amountMinor'<>'2500' OR r->>'note' IS NOT NULL THEN RAISE EXCEPTION 'Refund intake fabricated a payment or mandatory note: %',r;END IF;
 first_id:=(r->>'id')::uuid;
 replay:=public.petro_request_service_refund(o,'2500','quality',NULL,'refund-first-request-01');
 IF replay IS DISTINCT FROM r THEN RAISE EXCEPTION 'Refund retry duplicated request';END IF;
 BEGIN PERFORM public.petro_request_service_refund(o,'2600','quality',NULL,'refund-first-request-01');RAISE EXCEPTION 'Refund changed payload reused key';EXCEPTION WHEN unique_violation THEN NULL;END;
 s:=public.petro_service_order_refund_requests(o);
 IF s->>'requestedAmountMinor'<>'2500' OR s->>'remainingRequestableMinor'<>'6250' OR s->>'financialRefundEnabled'<>'true' THEN RAISE EXCEPTION 'Refund capacity incorrect: %',s;END IF;
 second:=public.petro_request_service_refund(o,'6250','quantity','تفاصيل اختيارية','refund-second-request-01');
 BEGIN PERFORM public.petro_request_service_refund(o,'1','billing',NULL,'refund-overflow-request-01');RAISE EXCEPTION 'Refund requests exceeded charged amount';EXCEPTION WHEN check_violation THEN IF SQLERRM<>'REFUND_EXCEEDS_REMAINING_PAYMENT' THEN RAISE;END IF;END;
 BEGIN PERFORM public.petro_withdraw_service_refund(first_id,2,'refund-stale-withdraw-01');RAISE EXCEPTION 'Stale refund withdrawal succeeded';EXCEPTION WHEN SQLSTATE '40001' OR SQLSTATE 'PT409' THEN IF SQLERRM<>'REFUND_VERSION_CONFLICT' THEN RAISE;END IF;END;
 r:=public.petro_withdraw_service_refund(first_id,1,'refund-first-withdraw-01');
 IF r->>'status'<>'withdrawn' OR r->>'version'<>'2' OR r->>'moneyRefunded'<>'false' THEN RAISE EXCEPTION 'Withdrawal changed money';END IF;
 IF public.petro_withdraw_service_refund(first_id,1,'refund-first-withdraw-01') IS DISTINCT FROM r THEN RAISE EXCEPTION 'Withdrawal retry changed result';END IF;
 BEGIN PERFORM public.petro_withdraw_service_refund(first_id,1,'refund-second-withdraw-01');RAISE EXCEPTION 'Withdrawal duplicated history';EXCEPTION WHEN SQLSTATE '40001' OR SQLSTATE 'PT409' THEN IF SQLERRM<>'REFUND_VERSION_CONFLICT' THEN RAISE;END IF;END;
 s:=public.petro_service_order_refund_requests(o);
 IF s->>'requestedAmountMinor'<>'6250' OR s->>'remainingRequestableMinor'<>'2500' THEN RAISE EXCEPTION 'Withdrawal did not release request capacity';END IF;
 PERFORM public.petro_request_service_refund(o,'2500','billing',NULL,'refund-released-capacity-01');

 FOR history_id IN SELECT q.id FROM petro_private.service_refund_requests q WHERE q.order_id=o AND NOT EXISTS(SELECT 1 FROM petro_private.service_refund_withdrawals w WHERE w.request_id=q.id) LOOP
  PERFORM public.petro_withdraw_service_refund(history_id,1,'refund-history-free-'||history_id::text);
 END LOOP;
 history_item:=public.petro_request_service_refund(o,'1','quality',NULL,'refund-history-open-0001');
 history_id:=(history_item->>'id')::uuid;
 FOR history_index IN 1..55 LOOP
  history_item:=public.petro_request_service_refund(o,'1','quality',NULL,'refund-history-request-'||history_index::text);
  PERFORM public.petro_withdraw_service_refund((history_item->>'id')::uuid,1,'refund-history-withdraw-'||history_index::text);
 END LOOP;
 s:=public.petro_service_order_refund_requests(o);
 IF jsonb_array_length(s->'items')<>50 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'items') item WHERE item->>'id'=history_id::text AND(item->>'canWithdraw')::boolean) THEN
 RAISE EXCEPTION 'Older open refund request hidden by withdrawn history';END IF;
 UPDATE public.petro_profiles SET password_change_required=true WHERE user_id='00000000-0000-4000-8000-000000003801';
 BEGIN PERFORM public.petro_service_order_refund_requests(o);RAISE EXCEPTION 'Password-gated user read refund data';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 UPDATE public.petro_profiles SET password_change_required=false WHERE user_id='00000000-0000-4000-8000-000000003801';
 BEGIN UPDATE petro_private.service_refund_requests SET amount_minor=1 WHERE id=first_id;RAISE EXCEPTION 'Refund history edited';EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;END;
 BEGIN DELETE FROM petro_private.service_refund_withdrawals WHERE request_id=first_id;RAISE EXCEPTION 'Withdrawal history erased';EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;END;
 IF(SELECT count(*) FROM public.petro_finance_journal_entries)<>total_journal OR(SELECT count(*) FROM public.petro_inventory_movements)<>stock
 OR(SELECT payment_status FROM public.petro_service_orders WHERE id=o)<>'paid' THEN RAISE EXCEPTION 'Request intake moved money, stock or original payment';END IF;
 IF EXISTS(SELECT 1 FROM pg_class c CROSS JOIN(VALUES('anon'),('authenticated'),('service_role'))r(name) WHERE c.oid IN('petro_private.service_refund_requests'::regclass,'petro_private.service_refund_withdrawals'::regclass,'petro_private.service_refund_commands'::regclass) AND(NOT c.relrowsecurity OR has_table_privilege(r.name,c.oid,'SELECT,INSERT,UPDATE,DELETE'))) THEN RAISE EXCEPTION 'Refund tables exposed';END IF;
END $refund_intake$;

\ir service-refund-decisions-0039-smoke-test.sql
