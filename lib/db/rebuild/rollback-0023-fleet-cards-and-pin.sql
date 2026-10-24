-- Rollback for 0023 on the disposable test database or an approved maintenance
-- window. Keep the ciphertext column and widened key-version constraint so no
-- encrypted audit/recovery material is discarded; the restored RPC ignores it.
BEGIN;

DROP FUNCTION public.petro_admin_fleet_cards_catalog(text,jsonb);
DROP FUNCTION public.petro_admin_fleet_pair_pin_reveal(uuid,text);

ALTER FUNCTION public.petro_admin_fleet_command(text,jsonb,text,text)
  RENAME TO petro_admin_fleet_command_wrapper_0023;
REVOKE ALL ON FUNCTION public.petro_admin_fleet_command_wrapper_0023(text,jsonb,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
DROP FUNCTION public.petro_admin_fleet_command_wrapper_0023(text,jsonb,text,text);

ALTER FUNCTION public.petro_admin_fleet_command_legacy_0014(text,jsonb,text,text)
  RENAME TO petro_admin_fleet_command;
REVOKE ALL ON FUNCTION public.petro_admin_fleet_command(text,jsonb,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.petro_admin_fleet_command(text,jsonb,text,text)
  TO authenticated;

COMMIT;
