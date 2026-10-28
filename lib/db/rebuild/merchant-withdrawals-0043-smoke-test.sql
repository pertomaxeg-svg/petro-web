-- Disposable paid fixture only. This is a real financial hold, not a payout.
DO $$ BEGIN IF to_regprocedure('public.petro_submit_merchant_withdrawal(uuid,uuid,uuid[],text)') IS NULL THEN RAISE EXCEPTION 'MERCHANT_WITHDRAWAL_INTAKE_MISSING';END IF;END $$;
