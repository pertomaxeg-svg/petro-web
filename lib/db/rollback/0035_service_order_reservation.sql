BEGIN;
DO $guard$
BEGIN
 IF EXISTS(SELECT 1 FROM public.petro_service_orders)
 OR EXISTS(SELECT 1 FROM petro_private.service_order_commands)
 OR EXISTS(SELECT 1 FROM petro_private.service_order_events) THEN
 RAISE EXCEPTION '0035 rollback refuses to remove service order history'; END IF;
 IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='pertomax_service_order_expiry'
 AND(username<>current_user OR command<>'SELECT petro_private.petro_expire_service_orders(100);')) THEN
 RAISE EXCEPTION '0035 rollback job ownership/command changed'; END IF;
 PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname='pertomax_service_order_expiry' AND username=current_user;
END $guard$;
DROP FUNCTION public.petro_cancel_service_order(uuid,bigint,text);
DROP FUNCTION public.petro_service_orders_query(jsonb);
DROP FUNCTION public.petro_worker_reserve_service_order(uuid,uuid,uuid,jsonb,uuid,text);
DROP FUNCTION petro_private.petro_expire_service_orders(integer);
DROP FUNCTION petro_private.cancel_service_order_core(uuid,uuid,text,bigint);
DROP FUNCTION petro_private.service_order_view(uuid);
DROP FUNCTION petro_private.service_order_readable(uuid);
DROP FUNCTION petro_private.service_order_central(boolean);
DROP TABLE petro_private.service_order_events;
DROP FUNCTION petro_private.guard_service_order_event();
DROP TABLE petro_private.service_order_commands;
DROP TABLE public.petro_service_orders;
-- Retain pg_cron dependency; never remove unrelated scheduled jobs.
COMMIT;
