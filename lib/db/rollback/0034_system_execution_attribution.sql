BEGIN;
DO $guard$
BEGIN
 IF EXISTS(SELECT 1 FROM public.petro_finance_reservations WHERE closed_by_system IS NOT NULL)
 OR EXISTS(SELECT 1 FROM public.petro_inventory_reservations WHERE completed_by_system IS NOT NULL)
 OR EXISTS(SELECT 1 FROM public.petro_inventory_movements WHERE system_actor IS NOT NULL) THEN
 RAISE EXCEPTION '0034 rollback refuses to discard system execution attribution'; END IF;
END $guard$;
DO $history$
DECLARE definition text; new_fragment text:=$new$'actorName',CASE WHEN m.system_actor IS NOT NULL THEN 'النظام' ELSE coalesce(nullif(profile.display_name,''),'مسؤول مخزون') END,
        'actorKind',CASE WHEN m.system_actor IS NOT NULL THEN 'system' ELSE 'user' END,
        'systemActor',m.system_actor,$new$;
BEGIN
 SELECT pg_get_functiondef(to_regprocedure('public.petro_inventory_admin_query(text,jsonb)')) INTO definition;
 IF definition IS NULL OR position(new_fragment IN definition)=0 THEN RAISE EXCEPTION '0034 rollback inventory history source differs'; END IF;
 EXECUTE replace(definition,new_fragment,$old$'actorName',coalesce(nullif(profile.display_name,''),'مسؤول مخزون'),$old$);
END $history$;
ALTER TABLE public.petro_inventory_movements DROP CONSTRAINT petro_inventory_movement_actor_check;
ALTER TABLE public.petro_inventory_movements ALTER COLUMN actor_id SET NOT NULL;
ALTER TABLE public.petro_inventory_reservations DROP CONSTRAINT petro_inventory_reservations_system_completion_check;
ALTER TABLE public.petro_finance_reservations DROP CONSTRAINT petro_finance_reservations_closure_actor_check;
ALTER TABLE public.petro_finance_reservations ADD CONSTRAINT petro_finance_reservations_check CHECK(
 (status='active' AND closed_by IS NULL AND closed_at IS NULL)
 OR (status<>'active' AND closed_by IS NOT NULL AND closed_at IS NOT NULL)
);
ALTER TABLE public.petro_inventory_movements DROP COLUMN system_actor;
ALTER TABLE public.petro_inventory_reservations DROP COLUMN completed_by_system;
ALTER TABLE public.petro_finance_reservations DROP COLUMN closed_by_system;
COMMIT;
