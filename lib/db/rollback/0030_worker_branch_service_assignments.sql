BEGIN;
DO $safe_empty_rollback$ BEGIN
 IF EXISTS(SELECT 1 FROM public.petro_worker_assignments)
 OR EXISTS(SELECT 1 FROM petro_private.worker_assignment_commands)
 OR EXISTS(SELECT 1 FROM petro_private.worker_assignment_events) THEN
  RAISE EXCEPTION '0030 rollback refuses to delete workforce records; disable access and prepare a data-preserving recovery';
 END IF;
END $safe_empty_rollback$;
DROP FUNCTION public.petro_admin_worker_assignment(uuid,uuid,text,boolean,bigint,text);
DROP FUNCTION public.petro_admin_worker_assignments(jsonb);
DROP FUNCTION public.petro_worker_capabilities();
DROP FUNCTION petro_private.workforce_can_execute(uuid,uuid,text);
DROP FUNCTION petro_private.workforce_member_eligible(uuid,uuid);
DROP FUNCTION petro_private.workforce_user_active(uuid);
DROP TABLE petro_private.worker_assignment_events,petro_private.worker_assignment_commands;
DROP TABLE public.petro_worker_assignments;
COMMIT;
