-- Disposable acceptance gate for actual order reserve/cancel/expiry.
BEGIN;
DO $$ BEGIN
 IF to_regclass('public.petro_service_orders') IS NULL
 OR to_regprocedure('public.petro_worker_reserve_service_order(uuid,uuid,uuid,jsonb,uuid,text)') IS NULL
 OR to_regprocedure('public.petro_service_orders_query(jsonb)') IS NULL
 OR to_regprocedure('public.petro_cancel_service_order(uuid,bigint,text)') IS NULL
 OR to_regprocedure('petro_private.petro_expire_service_orders(integer)') IS NULL THEN
 RAISE EXCEPTION 'Actual service order reservation and expiry are missing'; END IF;
END $$;
ROLLBACK;
