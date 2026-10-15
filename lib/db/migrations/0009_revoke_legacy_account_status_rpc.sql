-- Apply only after all API instances use the reasoned 0008 RPC and old
-- authenticated callers have been drained. Keep service_role unchanged.
BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('public.petro_set_account_status(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'expected legacy account status function is missing';
  END IF;
  IF to_regprocedure('public.petro_admin_set_account_status(uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION '0008 reasoned account status function must exist before revocation';
  END IF;
END;
$preflight$;

REVOKE ALL ON FUNCTION public.petro_set_account_status(uuid, text)
  FROM PUBLIC, anon, authenticated;

COMMIT;
