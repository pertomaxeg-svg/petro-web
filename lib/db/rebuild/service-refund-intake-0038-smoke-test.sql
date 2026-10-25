-- Runs only inside the disposable0037 paid-fixture transaction.
DO $refund_gate$ BEGIN
 IF to_regprocedure('public.petro_service_order_refund_requests(uuid)') IS NULL
 OR to_regprocedure('public.petro_request_service_refund(uuid,text,text,text,text)') IS NULL
 OR to_regprocedure('public.petro_withdraw_service_refund(uuid,bigint,text)') IS NULL THEN
 RAISE EXCEPTION 'REFUND_REQUEST_INTAKE_MISSING';
 END IF;
END $refund_gate$;
