-- Only inside disposable paid-order acceptance transaction.
DO $refund_decision_gate$ BEGIN
 IF to_regprocedure('public.petro_decide_service_refund(uuid,bigint,text,text,text,text)') IS NULL
 OR to_regclass('petro_private.service_refund_decisions') IS NULL
 OR to_regclass('petro_private.service_refund_allocations') IS NULL THEN
 RAISE EXCEPTION 'ACTUAL_REFUND_DECISION_MISSING';END IF;
END $refund_decision_gate$;
