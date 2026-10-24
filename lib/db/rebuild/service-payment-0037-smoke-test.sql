-- Disposable payment acceptance gate; never run against production.
BEGIN;
DO $$ BEGIN
 IF to_regprocedure('public.petro_confirm_service_order(uuid,bigint,text,text)') IS NULL
 OR to_regprocedure('public.petro_service_order_payment(uuid)') IS NULL
 OR to_regprocedure('public.petro_service_order_payment_context(uuid)') IS NULL
 OR to_regclass('petro_private.service_order_payments') IS NULL
 OR to_regclass('petro_private.service_order_receivables') IS NULL THEN
 RAISE EXCEPTION 'Final order confirmation and actual payment are missing';END IF;
END $$;
ROLLBACK;
