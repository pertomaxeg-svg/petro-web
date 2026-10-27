BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM petro_private.service_product_returns) OR EXISTS(SELECT 1 FROM petro_private.service_product_return_inspections) OR EXISTS(SELECT 1 FROM petro_private.service_product_return_commands) THEN RAISE EXCEPTION '0041 rollback refuses to remove physical return history';END IF;
END $$;
DROP FUNCTION public.petro_inspect_service_product_return(uuid,bigint,uuid,text,text,text,text);
DROP FUNCTION public.petro_receive_service_product_return(uuid,bigint,uuid,text,text,text);
DROP FUNCTION public.petro_service_product_return_inspections(uuid,integer);
DROP FUNCTION public.petro_service_product_returns(uuid,integer);
DROP TABLE petro_private.service_product_return_inspections;
DROP TABLE petro_private.service_product_return_commands;
DROP TABLE petro_private.service_product_returns;
DROP FUNCTION petro_private.guard_service_product_return_history();
COMMIT;
