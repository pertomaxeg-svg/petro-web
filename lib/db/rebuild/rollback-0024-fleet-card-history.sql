BEGIN;

DROP FUNCTION public.petro_admin_fleet_card_history(jsonb);

DO $rollback_0024$
BEGIN
  IF to_regprocedure('public.petro_admin_fleet_card_history(jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION '0024 rollback left the card history RPC installed';
  END IF;
END
$rollback_0024$;

COMMIT;
