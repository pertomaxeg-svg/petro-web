BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM petro_private.service_refund_requests) OR EXISTS(SELECT 1 FROM petro_private.service_refund_withdrawals) OR EXISTS(SELECT 1 FROM petro_private.service_refund_commands) THEN RAISE EXCEPTION '0038 rollback refuses to remove refund request history';END IF;
END $$;
DROP FUNCTION public.petro_withdraw_service_refund(uuid,bigint,text);
DROP FUNCTION public.petro_request_service_refund(uuid,text,text,text,text);
DROP FUNCTION public.petro_service_order_refund_requests(uuid);
DROP FUNCTION petro_private.service_refund_order_access(uuid,boolean);
DROP TABLE petro_private.service_refund_commands;
DROP TABLE petro_private.service_refund_withdrawals;
DROP TABLE petro_private.service_refund_requests;
DROP FUNCTION petro_private.guard_refund_request_history();
COMMIT;
