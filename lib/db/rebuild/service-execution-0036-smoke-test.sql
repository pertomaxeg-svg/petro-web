-- Disposable execution/evidence acceptance. Never run on production.
BEGIN;
DO $$ BEGIN
 IF to_regprocedure('public.petro_start_service_order(uuid,bigint,text)') IS NULL
 OR to_regprocedure('public.petro_deliver_service_order(uuid,bigint,jsonb,text)') IS NULL
 OR to_regprocedure('public.petro_service_order_execution(uuid)') IS NULL
 OR to_regclass('petro_private.service_order_evidence') IS NULL THEN
 RAISE EXCEPTION 'Actual service execution and evidence are missing'; END IF;
END $$;
ROLLBACK;
