BEGIN;
-- Explicit system attribution for future unstarted service-order expiry only.
ALTER TABLE public.petro_finance_reservations ADD COLUMN closed_by_system text;
ALTER TABLE public.petro_inventory_reservations ADD COLUMN completed_by_system text;
ALTER TABLE public.petro_inventory_movements ADD COLUMN system_actor text;
ALTER TABLE public.petro_finance_reservations DROP CONSTRAINT petro_finance_reservations_check;
ALTER TABLE public.petro_finance_reservations ADD CONSTRAINT petro_finance_reservations_closure_actor_check CHECK(
 (status='active' AND closed_by IS NULL AND closed_by_system IS NULL AND closed_at IS NULL)
 OR (status='released' AND closed_at IS NOT NULL AND (
   (closed_by IS NOT NULL AND closed_by_system IS NULL)
   OR (closed_by IS NULL AND closed_by_system IS NOT NULL AND closed_by_system='service_order_expiry' AND source_type='fleet_usage')))
 OR (status='consumed' AND closed_by IS NOT NULL AND closed_by_system IS NULL AND closed_at IS NOT NULL)
);
ALTER TABLE public.petro_inventory_reservations ADD CONSTRAINT petro_inventory_reservations_system_completion_check CHECK(
 completed_by_system IS NULL OR (
  completed_by_system='service_order_expiry' AND status='released' AND completed_by IS NULL AND completed_at IS NOT NULL)
);
ALTER TABLE public.petro_inventory_movements ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE public.petro_inventory_movements ADD CONSTRAINT petro_inventory_movement_actor_check CHECK(
 (actor_id IS NOT NULL AND system_actor IS NULL)
 OR (actor_id IS NULL AND system_actor IS NOT NULL AND system_actor='service_order_expiry' AND movement_kind='release'
  AND reservation_id IS NOT NULL AND document_id IS NULL AND on_hand_delta=0 AND reserved_delta<0)
);
DO $history$
DECLARE definition text; old_fragment text:=$old$'actorName',coalesce(nullif(profile.display_name,''),'مسؤول مخزون'),$old$;
BEGIN
 SELECT pg_get_functiondef(to_regprocedure('public.petro_inventory_admin_query(text,jsonb)')) INTO definition;
 IF definition IS NULL OR position(old_fragment IN definition)=0 THEN RAISE EXCEPTION '0034 inventory history source differs from reviewed baseline'; END IF;
 definition:=replace(definition,old_fragment,
 $new$'actorName',CASE WHEN m.system_actor IS NOT NULL THEN 'النظام' ELSE coalesce(nullif(profile.display_name,''),'مسؤول مخزون') END,
        'actorKind',CASE WHEN m.system_actor IS NOT NULL THEN 'system' ELSE 'user' END,
        'systemActor',m.system_actor,$new$);
 EXECUTE definition;
END $history$;
COMMIT;
