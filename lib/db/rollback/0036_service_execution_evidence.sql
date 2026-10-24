BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM petro_private.service_order_executions) OR EXISTS(SELECT 1 FROM petro_private.service_order_deliveries)
 OR EXISTS(SELECT 1 FROM petro_private.service_order_evidence) OR EXISTS(SELECT 1 FROM petro_private.service_order_commands WHERE action NOT IN('reserve','cancel'))
 OR EXISTS(SELECT 1 FROM petro_private.service_order_events WHERE kind IN('started','delivered'))
 OR EXISTS(SELECT 1 FROM petro_private.service_documentation_rules WHERE version<>1 OR source<>'engineering_reference_v3') THEN
 RAISE EXCEPTION '0036 rollback refuses to remove execution or evidence history'; END IF;
END $$;
DROP POLICY petro_order_evidence_select ON storage.objects;
DROP POLICY petro_order_evidence_insert ON storage.objects;
DROP FUNCTION public.petro_deliver_service_order(uuid,bigint,jsonb,text);
DROP FUNCTION public.petro_start_service_order(uuid,bigint,text);
DROP FUNCTION public.petro_finalize_service_order_evidence(uuid,text);
DROP FUNCTION public.petro_create_service_order_evidence(uuid,text,text,text,bigint,text);
DROP FUNCTION public.petro_service_order_evidence_file(uuid,text);
DROP FUNCTION public.petro_service_order_execution(uuid);
DROP FUNCTION petro_private.can_access_service_order_evidence(text,text);
DROP FUNCTION petro_private.service_order_documentation_rule(uuid);
DROP FUNCTION petro_private.service_order_identity_current(uuid);
DROP FUNCTION petro_private.service_order_worker_current(uuid);
ALTER TABLE petro_private.service_order_commands DROP COLUMN evidence_id;
ALTER TABLE petro_private.service_order_commands DROP CONSTRAINT service_order_commands_action_check;
ALTER TABLE petro_private.service_order_commands ADD CONSTRAINT service_order_commands_action_check CHECK(action IN('reserve','cancel'));
ALTER TABLE petro_private.service_order_events DROP CONSTRAINT service_order_events_kind_check;
ALTER TABLE petro_private.service_order_events ADD CONSTRAINT service_order_events_kind_check CHECK(kind IN('reserved','cancelled','expiry_failed'));
DROP TABLE petro_private.service_order_deliveries;
DROP TABLE petro_private.service_order_evidence;
DROP TABLE petro_private.service_order_executions;
DROP TABLE petro_private.service_documentation_rules;
DROP FUNCTION petro_private.guard_service_evidence_history();
DROP FUNCTION petro_private.guard_service_execution_history();
COMMIT;
