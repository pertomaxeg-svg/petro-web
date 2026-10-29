-- Disposable withdrawal fixture; genuine upload is verified separately against native Storage.
DO $$ BEGIN IF to_regprocedure('public.petro_create_merchant_payout_proof(uuid,bigint,text,text,bigint,text)') IS NULL THEN RAISE EXCEPTION 'MERCHANT_PAYOUT_PROOF_MISSING';END IF;END $$;

DO $proof$
DECLARE source_order uuid;payment uuid;org uuid;bank uuid;w jsonb;i jsonb;second jsonb;r jsonb;before_journal bigint;object_id uuid:=gen_random_uuid();BEGIN
 PERFORM set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000003701',true);
 SELECT p.order_id INTO STRICT source_order FROM petro_private.service_order_payments p JOIN petro_private.service_order_receivables v ON v.payment_id=p.id WHERE p.charged_amount_minor=8750 AND v.eligible_at>statement_timestamp() LIMIT 1;
 payment:=pg_temp.withdrawal_historical_payment(source_order);
 SELECT merchant_organization_id INTO STRICT org FROM petro_private.service_order_receivables WHERE payment_id=payment;
 SELECT v.id INTO STRICT bank FROM public.petro_bank_account_versions v JOIN public.petro_bank_accounts a ON a.id=v.bank_account_id WHERE v.organization_id=org AND v.status='approved' AND a.status='active' LIMIT 1;
 w:=public.petro_submit_merchant_withdrawal(org,bank,ARRAY[payment],'sql-proof-withdrawal-submit');
 BEGIN PERFORM public.petro_create_merchant_payout_proof((w->>'id')::uuid,1,'proof.png','image/png',68,'sql-proof-unapproved-01');RAISE EXCEPTION 'Unapproved request accepted bank proof';EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
 PERFORM public.petro_review_merchant_withdrawal((w->>'id')::uuid,1,'approve','sql-proof-withdrawal-approve');
 SELECT count(*) INTO before_journal FROM public.petro_finance_journal_entries;
 i:=public.petro_create_merchant_payout_proof((w->>'id')::uuid,2,'proof.png','image/png',68,'sql-proof-create-intent-01');
 IF public.petro_create_merchant_payout_proof((w->>'id')::uuid,2,'proof.png','image/png',68,'sql-proof-create-intent-01')->>'id'<>i->>'id' THEN RAISE EXCEPTION 'Proof intent replay duplicated';END IF;
 BEGIN PERFORM public.petro_create_merchant_payout_proof((w->>'id')::uuid,2,'different.png','image/png',68,'sql-proof-create-intent-01');RAISE EXCEPTION 'Changed proof reused key';EXCEPTION WHEN unique_violation THEN NULL;END;
 BEGIN PERFORM public.petro_accept_merchant_payout_proof((i->>'id')::uuid,repeat('a',64),'sql-proof-missing-object');RAISE EXCEPTION 'Missing object accepted';EXCEPTION WHEN check_violation THEN NULL;END;
 -- Metadata simulation only. Actual object upload/download verified by native Supabase suite.
 INSERT INTO storage.objects(id,bucket_id,name,owner_id,metadata) VALUES(object_id,'petro-private-documents',i->>'objectPath',auth.uid()::text,'{"size":67,"mimetype":"image/png","eTag":"isolated-etag"}');
 BEGIN PERFORM public.petro_accept_merchant_payout_proof((i->>'id')::uuid,repeat('a',64),'sql-proof-wrong-size');RAISE EXCEPTION 'Wrong metadata size accepted';EXCEPTION WHEN check_violation THEN NULL;END;
 UPDATE storage.objects SET metadata='{"size":68,"mimetype":"image/png","eTag":"isolated-etag"}' WHERE id=object_id;
 r:=public.petro_accept_merchant_payout_proof((i->>'id')::uuid,repeat('a',64),'sql-proof-accept-0001');
 IF r->>'status'<>'accepted' OR r->>'current'<>'true' OR r->>'sha256'<>repeat('a',64) THEN RAISE EXCEPTION 'Accepted proof metadata invalid';END IF;
 IF public.petro_accept_merchant_payout_proof((i->>'id')::uuid,repeat('a',64),'sql-proof-accept-0001') IS DISTINCT FROM r THEN RAISE EXCEPTION 'Acceptance replay changed';END IF;
 BEGIN PERFORM public.petro_accept_merchant_payout_proof((i->>'id')::uuid,repeat('b',64),'sql-proof-accept-0001');RAISE EXCEPTION 'Changed digest reused key';EXCEPTION WHEN unique_violation THEN NULL;END;
 BEGIN UPDATE petro_private.merchant_payout_proof_acceptances SET sha256=repeat('b',64) WHERE proof_id=(i->>'id')::uuid;RAISE EXCEPTION 'Accepted proof edited';EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;END;
 second:=public.petro_create_merchant_payout_proof((w->>'id')::uuid,2,'pending.png','image/png',68,'sql-proof-stale-pending');
 PERFORM public.petro_review_merchant_withdrawal((w->>'id')::uuid,2,'cancel','sql-proof-withdrawal-cancel');
 BEGIN PERFORM public.petro_accept_merchant_payout_proof((second->>'id')::uuid,repeat('a',64),'sql-proof-stale-finalize');RAISE EXCEPTION 'Stale proof accepted';EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
 IF public.petro_merchant_payout_proof_file((i->>'id')::uuid,'read')->>'current'<>'false' THEN RAISE EXCEPTION 'Cancelled approval proof stayed current';END IF;
 IF(SELECT count(*) FROM public.petro_finance_journal_entries)<>before_journal THEN RAISE EXCEPTION 'Proof charged money';END IF;
 PERFORM set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000003803',true);
 BEGIN PERFORM public.petro_merchant_payout_proofs((w->>'id')::uuid);RAISE EXCEPTION 'Branch-only actor read bank proof';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
END $proof$;
