-- Synthetic, transaction-isolated coverage for migration 0020.
BEGIN;

INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at)
VALUES
  ('00000000-0000-4000-8000-000000000a01', 'provision-owner@example.invalid',
   '{"username":"provision_owner","display_name":"Provision Owner"}', now()),
  ('00000000-0000-4000-8000-000000000a02', 'provision-operations@example.invalid',
   '{"username":"provision_operations","display_name":"Provision Operations"}', now()),
  ('00000000-0000-4000-8000-000000000a03', 'provision-target@example.invalid',
   '{"username":"provision_target","display_name":"Provision Target"}', NULL);

UPDATE public.petro_profiles
SET active = true, account_status = 'active'
WHERE user_id IN (
  '00000000-0000-4000-8000-000000000a01',
  '00000000-0000-4000-8000-000000000a02'
);

INSERT INTO public.petro_platform_roles (user_id, role, active)
VALUES
  ('00000000-0000-4000-8000-000000000a01', 'owner', true),
  ('00000000-0000-4000-8000-000000000a02', 'operations', true);

DO $migration_contract$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.petro_profiles
    WHERE user_id = '00000000-0000-4000-8000-000000000a03'
      AND active = false
      AND account_status = 'pending'
      AND password_change_required = false
  ) THEN
    RAISE EXCEPTION 'new profile did not receive the safe default password-reset state';
  END IF;

  IF NOT has_function_privilege(
       'authenticated',
       'public.petro_admin_create_platform_user_access(uuid,text[],text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.petro_admin_create_platform_user_access(uuid,text[],text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.petro_admin_create_platform_user_access(uuid,text[],text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'initial role-assignment RPC has an unexpected execution grant';
  END IF;
END;
$migration_contract$;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '00000000-0000-4000-8000-000000000a01';

DO $owner_create$
DECLARE
  assigned text[];
  detail jsonb;
  before_activity integer;
  after_activity integer;
BEGIN
  detail := public.petro_admin_get_platform_user(
    '00000000-0000-4000-8000-000000000a03'
  );
  before_activity := jsonb_array_length(detail -> 'activity');

  assigned := public.petro_admin_create_platform_user_access(
    '00000000-0000-4000-8000-000000000a03',
    ARRAY['finance', 'auditor']::text[],
    'Synthetic initial platform access'
  );
  detail := public.petro_admin_get_platform_user(
    '00000000-0000-4000-8000-000000000a03'
  );
  after_activity := jsonb_array_length(detail -> 'activity');

  IF assigned <> ARRAY['auditor', 'finance']::text[]
     OR NOT (detail #> '{user,platformRoles}' @> '["auditor","finance"]'::jsonb)
     OR detail #>> '{user,active}' <> 'false'
     OR after_activity <> before_activity + 1 THEN
    RAISE EXCEPTION 'owner could not stage roles and audit on a pending account: roles %, user %, activity count % -> %',
      assigned, detail -> 'user', before_activity, after_activity;
  END IF;

  PERFORM public.petro_admin_create_platform_user_access(
    '00000000-0000-4000-8000-000000000a03',
    ARRAY['finance', 'auditor']::text[],
    'Synthetic retry with same roles'
  );

  detail := public.petro_admin_get_platform_user(
    '00000000-0000-4000-8000-000000000a03'
  );
  IF jsonb_array_length(detail -> 'activity') <> after_activity THEN
    RAISE EXCEPTION 'idempotent initial role retry wrote another audit event';
  END IF;

  BEGIN
    PERFORM public.petro_admin_create_platform_user_access(
      '00000000-0000-4000-8000-000000000a03',
      ARRAY['operations']::text[],
      'Synthetic changed role replay'
    );
    RAISE EXCEPTION 'changed role replay replaced the initial assignment';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(detail -> 'activity') AS event
    WHERE event ->> 'reason' = 'Synthetic initial platform access'
  ) THEN
    RAISE EXCEPTION 'initial access was not audited with its reason';
  END IF;
END;
$owner_create$;

DO $owner_denials$
BEGIN
  BEGIN
    PERFORM public.petro_admin_create_platform_user_access(
      '00000000-0000-4000-8000-000000000a03',
      ARRAY['unknown_role']::text[],
      'Synthetic invalid role'
    );
    RAISE EXCEPTION 'unsupported role was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  BEGIN
    PERFORM public.petro_admin_create_platform_user_access(
      '00000000-0000-4000-8000-000000000a03',
      ARRAY['finance']::text[],
      ' '
    );
    RAISE EXCEPTION 'missing reason was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END;
$owner_denials$;

RESET ROLE;
DO $persisted_roles$
BEGIN
  IF (SELECT count(*) FROM public.petro_platform_roles
      WHERE user_id = '00000000-0000-4000-8000-000000000a03' AND active) <> 2
     OR (SELECT active FROM public.petro_profiles
         WHERE user_id = '00000000-0000-4000-8000-000000000a03')
     OR NOT (SELECT password_change_required FROM public.petro_profiles
             WHERE user_id = '00000000-0000-4000-8000-000000000a03') THEN
    RAISE EXCEPTION 'initial role assignment did not persist roles, pending status, and password reset gate';
  END IF;
END;
$persisted_roles$;

UPDATE auth.users
SET email_confirmed_at = now()
WHERE id = '00000000-0000-4000-8000-000000000a03';

DO $confirmation_keeps_reset_gate$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.petro_profiles
    WHERE user_id = '00000000-0000-4000-8000-000000000a03'
      AND active = false
      AND account_status = 'pending'
      AND password_change_required = true
  ) THEN
    RAISE EXCEPTION 'email confirmation changed the pending approval state or cleared the reset gate';
  END IF;
END;
$confirmation_keeps_reset_gate$;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '00000000-0000-4000-8000-000000000a02';
DO $non_owner_denial$
BEGIN
  BEGIN
    PERFORM public.petro_admin_create_platform_user_access(
      '00000000-0000-4000-8000-000000000a03',
      ARRAY['support']::text[],
      'Synthetic operations attempt'
    );
    RAISE EXCEPTION 'non-owner assigned initial platform access';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$non_owner_denial$;

RESET ROLE;
ROLLBACK;
