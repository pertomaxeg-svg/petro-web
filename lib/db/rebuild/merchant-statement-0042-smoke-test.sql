-- Isolated actual paid/refunded/settled fixtures only; no production test writes.
DO $statement_gate$ BEGIN
 IF to_regprocedure('public.petro_merchant_statement(uuid,uuid,integer)') IS NULL THEN
 RAISE EXCEPTION 'MERCHANT_STATEMENT_MISSING';END IF;
END $statement_gate$;
DO $statement$
DECLARE p petro_private.service_order_payments%ROWTYPE;v petro_private.service_order_receivables%ROWTYPE;s jsonb;x jsonb;other_org uuid;empty_branch uuid;actor uuid;before_journals bigint;
BEGIN
 PERFORM set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000003701',true);
 SELECT * INTO STRICT p FROM petro_private.service_order_payments WHERE charged_amount_minor=10000;
 SELECT * INTO STRICT v FROM petro_private.service_order_receivables WHERE payment_id=p.id;
 SELECT count(*) INTO before_journals FROM public.petro_finance_journal_entries;
 s:=public.petro_merchant_statement(v.merchant_organization_id,v.merchant_branch_id,1);
 SELECT j INTO STRICT x FROM jsonb_array_elements(s->'items')j WHERE j->>'paymentId'=p.id::text;
 IF x->>'earnedMinor'<>'10000' OR x->>'refundedMinor'<>'10000' OR x->>'unsettledRefundMinor'<>'1000' OR x->>'settledMinor'<>'9000' OR x->>'remainingMinor'<>'0' OR x->>'merchantDebtMinor'<>'9000' OR x->>'eligibleBeforeDebtMinor'<>'0' THEN RAISE EXCEPTION 'Statement double counted after-settlement refund: %',x;END IF;
 IF(s->'totals'->>'earnedMinor')::numeric<>(s->'totals'->>'unsettledRefundMinor')::numeric+(s->'totals'->>'settledMinor')::numeric+(s->'totals'->>'remainingMinor')::numeric
 OR(s->'totals'->>'refundedMinor')::numeric<>(s->'totals'->>'unsettledRefundMinor')::numeric+(s->'totals'->>'merchantDebtMinor')::numeric
 OR(s->'totals'->>'remainingMinor')::numeric<>(s->'totals'->>'eligibleBeforeDebtMinor')::numeric+(s->'totals'->>'notYetEligibleMinor')::numeric+(s->'totals'->>'disputedMinor')::numeric THEN RAISE EXCEPTION 'Statement failed reconciliation';END IF;
 empty_branch:=public.petro_create_branch_details(v.merchant_organization_id,'STATEMENT-EMPTY','فرع كشف بلا خدمات','عنوان اختبار','القاهرة',NULL,NULL,'{}'::jsonb,'اختبار','+201000004201');
 IF public.petro_merchant_statement(v.merchant_organization_id,empty_branch,1)->>'total'<>'0'
 OR public.petro_merchant_statement(v.merchant_organization_id,empty_branch,1)->'totals'->>'earnedMinor'<>'0' THEN RAISE EXCEPTION 'Empty statement fabricated money';END IF;
 IF (s->'totals'->>'merchantDebtMinor')::numeric<9000 OR s->>'withdrawalsEnabled'<>'false' THEN RAISE EXCEPTION 'Debt hidden or payout fabricated';END IF;
 IF s->'totals' IS DISTINCT FROM public.petro_merchant_statement(v.merchant_organization_id,v.merchant_branch_id,100)->'totals'
 OR jsonb_array_length(public.petro_merchant_statement(v.merchant_organization_id,v.merchant_branch_id,100)->'items')<>0 THEN RAISE EXCEPTION 'Pagination changed financial totals';END IF;
 FOREACH actor IN ARRAY ARRAY['00000000-0000-4000-8000-000000003801'::uuid,'00000000-0000-4000-8000-000000003804'::uuid,'00000000-0000-4000-8000-000000003702'::uuid] LOOP
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 BEGIN PERFORM public.petro_merchant_statement(NULL,NULL,1);RAISE EXCEPTION 'Non-financial/worker/company read merchant statement';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 END LOOP;
 PERFORM set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000003803',true);
 s:=public.petro_merchant_statement(v.merchant_organization_id,NULL,1);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(s->'branches')j WHERE j->>'id'<>v.merchant_branch_id::text)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(s->'items')j WHERE j->>'branchId'<>v.merchant_branch_id::text) THEN RAISE EXCEPTION 'Branch scope leaked';END IF;
 BEGIN PERFORM public.petro_merchant_statement(v.merchant_organization_id,empty_branch,1);RAISE EXCEPTION 'Branch member read unauthorized branch';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 SELECT id INTO other_org FROM public.petro_organizations WHERE kind='company' LIMIT 1;
 BEGIN PERFORM public.petro_merchant_statement(other_org,NULL,1);RAISE EXCEPTION 'Merchant read other organization';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 BEGIN PERFORM public.petro_merchant_statement(NULL,NULL,0);RAISE EXCEPTION 'Page zero accepted';EXCEPTION WHEN invalid_parameter_value THEN NULL;END;
 UPDATE public.petro_memberships SET active=false WHERE user_id='00000000-0000-4000-8000-000000003803';
 BEGIN PERFORM public.petro_merchant_statement(v.merchant_organization_id,NULL,1);RAISE EXCEPTION 'Revoked member kept financial access';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 UPDATE public.petro_memberships SET active=true WHERE user_id='00000000-0000-4000-8000-000000003803';
 IF(SELECT count(*) FROM public.petro_finance_journal_entries)<>before_journals THEN RAISE EXCEPTION 'Statement moved money';END IF;
END $statement$;
