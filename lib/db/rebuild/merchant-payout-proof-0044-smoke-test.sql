-- Disposable withdrawal fixture; genuine upload is verified separately against native Storage.
DO $$ BEGIN IF to_regprocedure('public.petro_create_merchant_payout_proof(uuid,bigint,text,text,bigint,text)') IS NULL THEN RAISE EXCEPTION 'MERCHANT_PAYOUT_PROOF_MISSING';END IF;END $$;
