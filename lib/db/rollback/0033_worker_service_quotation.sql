BEGIN;
DROP FUNCTION public.petro_worker_quote_service(uuid,uuid,uuid,jsonb,uuid);
DROP FUNCTION public.petro_worker_service_options(uuid,text,integer,integer);
DROP FUNCTION petro_private.worker_service_item_price(jsonb,uuid);
DROP FUNCTION petro_private.worker_service_quote_context(uuid);
COMMIT;
