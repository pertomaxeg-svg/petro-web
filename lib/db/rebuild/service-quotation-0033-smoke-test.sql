-- Disposable test gate for scoped service quotation; no live data or secrets.
BEGIN;
DO $$ BEGIN
 IF to_regprocedure('public.petro_worker_service_options(uuid,text,integer,integer)') IS NULL
 OR to_regprocedure('public.petro_worker_quote_service(uuid,uuid,uuid,jsonb,uuid)') IS NULL THEN
 RAISE EXCEPTION 'Scoped worker service quotation is missing'; END IF;
END $$;
ROLLBACK;
