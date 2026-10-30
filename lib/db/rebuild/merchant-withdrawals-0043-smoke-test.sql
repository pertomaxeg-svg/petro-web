-- Disposable paid fixture only. This is a real financial hold, not a payout.
DO $$ BEGIN IF to_regprocedure('public.petro_submit_merchant_withdrawal(uuid,uuid,uuid[],text)') IS NULL THEN RAISE EXCEPTION 'MERCHANT_WITHDRAWAL_INTAKE_MISSING';END IF;END $$;

\ir merchant-withdrawal-0043-fixture.sql
CREATE FUNCTION pg_temp.assert_claims45(p_payment uuid,p_claim text,p_disputed text,p_held text) RETURNS void LANGUAGE plpgsql AS $claims$
DECLARE v petro_private.service_order_receivables%ROWTYPE;s jsonb;x jsonb;b jsonb;expected numeric;
BEGIN
 SELECT * INTO STRICT v FROM petro_private.service_order_receivables WHERE payment_id=p_payment;
 s:=public.petro_merchant_statement(v.merchant_organization_id,v.merchant_branch_id,1);
 SELECT j INTO STRICT x FROM jsonb_array_elements(s->'items')j WHERE j->>'paymentId'=p_payment::text;
 IF x->>'pendingRefundMinor' IS DISTINCT FROM p_claim OR x->>'disputedMinor' IS DISTINCT FROM p_disputed OR x->>'withdrawalReservedMinor' IS DISTINCT FROM p_held THEN RAISE EXCEPTION 'Claim/hold split mismatch: %',x;END IF;
 SELECT coalesce(sum(q.amount_minor),0) INTO expected FROM petro_private.service_refund_requests q JOIN petro_private.service_order_receivables r ON r.payment_id=q.payment_id
 WHERE r.merchant_organization_id=v.merchant_organization_id AND r.merchant_branch_id=v.merchant_branch_id
 AND NOT EXISTS(SELECT 1 FROM petro_private.service_refund_withdrawals w WHERE w.request_id=q.id)
 AND NOT EXISTS(SELECT 1 FROM petro_private.service_refund_decisions d WHERE d.request_id=q.id);
 SELECT j INTO STRICT b FROM jsonb_array_elements(s->'branches')j WHERE j->>'id'=v.merchant_branch_id::text;
 IF (s->'totals'->>'pendingRefundMinor')::numeric IS DISTINCT FROM expected OR (b->>'pendingRefundMinor')::numeric IS DISTINCT FROM expected
 OR public.petro_merchant_statement(v.merchant_organization_id,v.merchant_branch_id,100)->'totals' IS DISTINCT FROM s->'totals' THEN RAISE EXCEPTION 'Scoped claims totals/branch/page mismatch';END IF;
 IF (x->>'remainingMinor')::numeric<>(x->>'withdrawalReservedMinor')::numeric+(x->>'disputedMinor')::numeric+(x->>'eligibleBeforeDebtMinor')::numeric+(x->>'notYetEligibleMinor')::numeric THEN RAISE EXCEPTION 'Total claims incorrectly subtracted twice';END IF;
END $claims$;
DO $withdrawal$
DECLARE source_order uuid;payment uuid;payment2 uuid;w2 jsonb;org uuid;bank jsonb;bank2 jsonb;w jsonb;result jsonb;req jsonb;request_id uuid;baseline bigint;statement jsonb;BEGIN
 PERFORM set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000003701',true);
 SELECT order_id INTO STRICT source_order FROM petro_private.service_order_payments WHERE charged_amount_minor=8750;
 payment:=pg_temp.withdrawal_historical_payment(source_order);
 SELECT merchant_organization_id INTO STRICT org FROM petro_private.service_order_receivables WHERE payment_id=payment;
 bank:=public.petro_propose_bank_account_version(org,NULL,NULL,'بنك اختبار سحب','مستفيد اختبار','EG004300001');
 PERFORM public.petro_review_bank_account_version((bank->>'versionId')::uuid,1,'approve','اعتماد حساب اختبار سحب',0);
 SELECT count(*) INTO baseline FROM public.petro_finance_journal_entries;
 w:=public.petro_submit_merchant_withdrawal(org,(bank->>'versionId')::uuid,ARRAY[payment],'sql-withdrawal-submit-0001');
 request_id:=(w->>'id')::uuid;
 IF w->>'status'<>'submitted' OR w->>'paid'<>'false' OR w->>'amountMinor'<>'8750' OR w->'bank' ? 'identifier' THEN RAISE EXCEPTION 'Withdrawal fabricated payment/leaked bank: %',w;END IF;
 IF public.petro_submit_merchant_withdrawal(org,(bank->>'versionId')::uuid,ARRAY[payment],'sql-withdrawal-submit-0001') IS DISTINCT FROM w THEN RAISE EXCEPTION 'Withdrawal retry duplicated';END IF;
 BEGIN PERFORM public.petro_submit_merchant_withdrawal(org,(bank->>'versionId')::uuid,ARRAY[payment],'sql-withdrawal-overlap-01');RAISE EXCEPTION 'Overlapping withdrawal accepted';EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
 statement:=public.petro_merchant_statement(org,NULL,1);
 IF statement->'totals'->>'withdrawalReservedMinor'<>'8750' THEN RAISE EXCEPTION 'Statement missing actual withdrawal hold';END IF;
 PERFORM public.petro_review_merchant_withdrawal(request_id,1,'approve','sql-withdrawal-approve-01');
 req:=public.petro_request_service_refund((SELECT order_id FROM petro_private.service_order_payments WHERE id=payment),'1000','quality',NULL,'sql-withdrawal-refund-request');
 statement:=public.petro_merchant_statement(org,NULL,1);
 IF NOT(statement->'totals' ? 'pendingRefundMinor') THEN RAISE EXCEPTION 'MERCHANT_PENDING_REFUND_TOTAL_MISSING';END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(statement->'items') x WHERE x->>'paymentId'=payment::text AND x->>'pendingRefundMinor'='1000' AND x->>'disputedMinor'='0' AND x->>'withdrawalReservedMinor'='8750') THEN RAISE EXCEPTION 'Open claim hidden by existing withdrawal hold: %',statement;END IF;
 PERFORM pg_temp.assert_claims45(payment,'1000','0','8750');
 PERFORM public.petro_decide_service_refund((req->>'id')::uuid,1,'refund','1000',NULL,'sql-withdrawal-refund-decision');
 PERFORM pg_temp.assert_claims45(payment,'0','0','7750');
 result:=petro_private.merchant_withdrawal_json(request_id);
 IF result->>'status'<>'submitted' OR result->>'version'<>'3' OR result->>'amountMinor'<>'7750' THEN RAISE EXCEPTION 'Refund did not invalidate approval/reduce hold: %',result;END IF;
 BEGIN PERFORM public.petro_review_merchant_withdrawal(request_id,2,'approve','sql-withdrawal-stale-review');RAISE EXCEPTION 'Stale review approved';EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
 result:=public.petro_review_merchant_withdrawal(request_id,3,'cancel','sql-withdrawal-cancel-01');
 IF result->>'amountMinor'<>'0' OR result->>'status'<>'cancelled' OR petro_private.merchant_withdrawal_held(payment)<>0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(result->'items')x WHERE x->>'heldMinor'<>'0') THEN RAISE EXCEPTION 'Cancellation did not release only open hold';END IF;
 w:=public.petro_submit_merchant_withdrawal(org,(bank->>'versionId')::uuid,ARRAY[payment],'sql-withdrawal-reopened-01');
 IF w->>'amountMinor'<>'7750' THEN RAISE EXCEPTION 'Request reclaimed refunded amount';END IF;
 payment2:=pg_temp.withdrawal_historical_payment(source_order);
 req:=public.petro_request_service_refund((SELECT order_id FROM petro_private.service_order_payments WHERE id=payment2),'1000','quality',NULL,'sql-before-hold-refund-request');
 PERFORM pg_temp.assert_claims45(payment2,'1000','1000','0');
 w2:=public.petro_submit_merchant_withdrawal(org,(bank->>'versionId')::uuid,ARRAY[payment2],'sql-withdrawal-pending-buffer');
 PERFORM pg_temp.assert_claims45(payment2,'1000','1000','7750');
 IF w2->>'amountMinor'<>'7750' THEN RAISE EXCEPTION 'Pending refund not excluded before hold';END IF;
 BEGIN PERFORM public.petro_review_merchant_withdrawal((w2->>'id')::uuid,1,'approve','sql-pending-review-deny');RAISE EXCEPTION 'Open refund approved for payout';EXCEPTION WHEN SQLSTATE 'PT409' THEN IF SQLERRM<>'WITHDRAWAL_REFUND_PENDING' THEN RAISE;END IF;END;
 PERFORM public.petro_decide_service_refund((req->>'id')::uuid,1,'refund','1000',NULL,'sql-before-hold-refund-decision');
 result:=petro_private.merchant_withdrawal_json((w2->>'id')::uuid);
 IF result->>'amountMinor'<>'7750' OR result->>'version'<>'1' THEN RAISE EXCEPTION 'Refund subtracted an already excluded claim twice: %',result;END IF;
 PERFORM pg_temp.assert_claims45(payment2,'0','0','7750');
 PERFORM public.petro_review_merchant_withdrawal((w2->>'id')::uuid,1,'cancel','sql-buffered-hold-cancel');
 req:=public.petro_request_service_refund((SELECT order_id FROM petro_private.service_order_payments WHERE id=payment2),'500','quality',NULL,'sql-claims-withdraw-request');
 PERFORM pg_temp.assert_claims45(payment2,'500','500','0');
 PERFORM public.petro_withdraw_service_refund((req->>'id')::uuid,1,'sql-claims-withdraw-0001');
 PERFORM pg_temp.assert_claims45(payment2,'0','0','0');

 bank2:=public.petro_propose_bank_account_version(org,(bank->>'accountId')::uuid,1,'بنك نسخة جديدة','مستفيد جديد','EG004300002');
 PERFORM public.petro_review_bank_account_version((bank2->>'versionId')::uuid,2,'approve','اعتماد نسخة جديدة للاختبار',1);
 BEGIN PERFORM public.petro_review_merchant_withdrawal((w->>'id')::uuid,1,'approve','sql-withdrawal-bank-change');RAISE EXCEPTION 'Changed bank approved old request';EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
 PERFORM public.petro_review_merchant_withdrawal((w->>'id')::uuid,1,'reject','sql-withdrawal-reject-01');
 IF(SELECT count(*) FROM public.petro_finance_journal_entries)<>baseline+3 THEN RAISE EXCEPTION 'Hold/review/cancel moved money';END IF;
 PERFORM set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000003803',true);
 BEGIN PERFORM public.petro_merchant_withdrawals(org,1);RAISE EXCEPTION 'Branch manager read central withdrawal bank details';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
END $withdrawal$;

\ir merchant-payout-proof-0044-smoke-test.sql
