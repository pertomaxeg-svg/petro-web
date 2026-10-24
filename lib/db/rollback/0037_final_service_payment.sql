BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM petro_private.service_order_payments) OR EXISTS(SELECT 1 FROM petro_private.service_order_receipts)
 OR EXISTS(SELECT 1 FROM petro_private.service_order_receivables) OR EXISTS(SELECT 1 FROM petro_private.service_order_confirmation_commands)
 OR EXISTS(SELECT 1 FROM petro_private.merchant_settlement_policy_versions WHERE version_no<>1 OR source<>'engineering_reference_v3' OR organization_id IS NOT NULL OR branch_id IS NOT NULL)
 OR EXISTS(SELECT 1 FROM petro_private.service_order_events WHERE kind='paid') THEN
 RAISE EXCEPTION '0037 rollback refuses to remove financial or confirmation history';END IF;
END $$;
DROP FUNCTION public.petro_confirm_service_order(uuid,bigint,text,text);
DROP FUNCTION public.petro_service_order_payment_context(uuid);
DROP FUNCTION public.petro_service_order_payment(uuid);
ALTER TABLE petro_private.service_order_events DROP CONSTRAINT service_order_events_kind_check;
ALTER TABLE petro_private.service_order_events ADD CONSTRAINT service_order_events_kind_check CHECK(kind IN('reserved','cancelled','expiry_failed','started','delivered'));
DROP TABLE petro_private.service_order_confirmation_commands;
DROP TABLE petro_private.service_order_receipts;
DROP TABLE petro_private.service_order_receivables;
DROP TABLE petro_private.service_order_payments;
DROP TABLE petro_private.merchant_settlement_policy_versions;
DROP SEQUENCE petro_private.service_receipt_number_seq;
DROP FUNCTION petro_private.guard_service_payment_history();
COMMIT;
