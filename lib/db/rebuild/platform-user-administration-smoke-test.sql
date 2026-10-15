-- Disposable synthetic acceptance tests for 0008.
-- All identities use .invalid addresses and all writes roll back with this transaction.
BEGIN;

INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at)
VALUES
  ('00000000-0000-4000-8000-000000000401', 'platform-owner@example.invalid', '{"username":"platform_owner","display_name":"Platform Owner"}', now()),
  ('00000000-0000-4000-8000-000000000402', 'platform-operations@example.invalid', '{"username":"platform_operations","display_name":"Platform Operations"}', now()),
  ('00000000-0000-4000-8000-000000000403', 'platform-finance@example.invalid', '{"username":"platform_finance","display_name":"Platform Finance"}', now()),
  ('00000000-0000-4000-8000-000000000404', 'platform-auditor@example.invalid', '{"username":"platform_auditor","display_name":"Platform Auditor"}', now()),
  ('00000000-0000-4000-8000-000000000405', 'platform-support@example.invalid', '{"username":"platform_support","display_name":"Platform Support"}', now()),
  ('00000000-0000-4000-8000-000000000406', 'platform-target@example.invalid', '{"username":"platform_target","display_name":"Platform Target"}', now()),
  ('00000000-0000-4000-8000-000000000407', 'platform-pending@example.invalid', '{"username":"platform_pending","display_name":"Platform Pending"}', now()),
  ('00000000-0000-4000-8000-000000000408', 'platform-owner-two@example.invalid', '{"username":"platform_owner_two","display_name":"Platform Owner Two"}', now());

UPDATE public.petro_profiles
SET active = true, account_status = 'active'
WHERE user_id IN (
  '00000000-0000-4000-8000-000000000401',
  '00000000-0000-4000-8000-000000000402',
  '00000000-0000-4000-8000-000000000403',
  '00000000-0000-4000-8000-000000000404',
  '00000000-0000-4000-8000-000000000405',
  '00000000-0000-4000-8000-000000000406',
  '00000000-0000-4000-8000-000000000408'
);
UPDATE public.petro_profiles
SET active = false, account_status = 'pending'
WHERE user_id = '00000000-0000-4000-8000-000000000407';

INSERT INTO public.petro_platform_roles (user_id, role, active)
VALUES
  ('00000000-0000-4000-8000-000000000401', 'owner', true),
  ('00000000-0000-4000-8000-000000000402', 'operations', true),
  ('00000000-0000-4000-8000-000000000403', 'finance', true),
  ('00000000-0000-4000-8000-000000000404', 'auditor', true),
  ('00000000-0000-4000-8000-000000000405', 'support', true),
  ('00000000-0000-4000-8000-000000000408', 'owner', true);

DO $privileges$
BEGIN
  IF NOT has_function_privilege(
       'authenticated',
       'public.petro_admin_list_platform_users(integer,integer,text,text,text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.petro_admin_get_platform_user(uuid)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.petro_admin_set_platform_roles(uuid,text[],text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.petro_admin_set_account_status(uuid,text,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'authenticated role cannot execute the guarded platform-user RPCs';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.petro_admin_list_platform_users(integer,integer,text,text,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.petro_admin_set_platform_roles(uuid,text[],text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.petro_admin_set_account_status(uuid,text,text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.petro_set_account_status(uuid,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.petro_set_account_status(uuid,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION '0008 RPC privileges changed unexpectedly or the legacy transition path is unavailable';
  END IF;
END;
$privileges$;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '00000000-0000-4000-8000-000000000401';

DO $owner_access$
DECLARE
  listed_count integer;
  page_row_count bigint;
  page_total bigint;
  detail jsonb;
  assigned_roles text[];
BEGIN
  SELECT count(*) INTO listed_count
  FROM public.petro_admin_list_platform_users(1, 100, NULL, NULL, NULL);
  IF listed_count <> 8 THEN
    RAISE EXCEPTION 'owner directory did not return all platform profiles';
  END IF;

  SELECT count(*), max(total_count)
  INTO page_row_count, page_total
  FROM public.petro_admin_list_platform_users(1, 2, NULL, NULL, NULL);
  IF page_row_count <> 2 OR page_total <> 8 THEN
    RAISE EXCEPTION 'platform user pagination did not return the page and complete count';
  END IF;

  IF (SELECT count(*) FROM public.petro_admin_list_platform_users(
        1, 25, 'FINANCE', NULL, NULL
      )) <> 1
     OR (SELECT count(*) FROM public.petro_admin_list_platform_users(
        1, 25, NULL, 'pending', NULL
      )) <> 1 THEN
    RAISE EXCEPTION 'platform user search or account-status filter returned the wrong rows';
  END IF;

  SELECT public.petro_admin_get_platform_user('00000000-0000-4000-8000-000000000403')
  INTO detail;
  IF detail #>> '{user,username}' <> 'platform_finance'
     OR detail #> '{user}' ? 'email' THEN
    RAISE EXCEPTION 'platform detail is incorrect or disclosed an Auth email';
  END IF;

  IF (SELECT count(*) FROM public.petro_admin_list_platform_users(
        1, 25, NULL, NULL, 'finance'
      )) <> 1 THEN
    RAISE EXCEPTION 'platform role filter did not select only its matching role';
  END IF;

  assigned_roles := public.petro_admin_set_platform_roles(
    '00000000-0000-4000-8000-000000000406',
    ARRAY['finance']::text[],
    'Synthetic test role assignment'
  );
  SELECT public.petro_admin_get_platform_user('00000000-0000-4000-8000-000000000406')
  INTO detail;
  IF assigned_roles <> ARRAY['finance']::text[]
     OR detail #> '{user,platformRoles}' <> '["finance"]'::jsonb THEN
    RAISE EXCEPTION 'owner role assignment failed: returned %, detail %',
      assigned_roles, detail #> '{user,platformRoles}';
  END IF;
  IF (SELECT count(*) FROM public.petro_admin_list_platform_users(
        1, 25, NULL, NULL, 'finance'
      )) <> 2 THEN
    RAISE EXCEPTION 'platform role filter did not reflect the role assignment';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(detail -> 'activity') AS event
    WHERE event ->> 'reason' = 'Synthetic test role assignment'
  ) THEN
    RAISE EXCEPTION 'platform role change did not preserve its reason in audit';
  END IF;

  PERFORM public.petro_admin_set_account_status(
    '00000000-0000-4000-8000-000000000406',
    'suspended',
    'Synthetic test suspension'
  );
  SELECT public.petro_admin_get_platform_user('00000000-0000-4000-8000-000000000406')
  INTO detail;
  IF detail #>> '{user,active}' <> 'false'
     OR detail #>> '{user,accountStatus}' <> 'suspended' THEN
    RAISE EXCEPTION 'account suspension did not update the profile status';
  END IF;
  IF (SELECT count(*) FROM public.petro_admin_list_platform_users(
        1, 25, NULL, 'suspended', NULL
      )) <> 1 THEN
    RAISE EXCEPTION 'platform account-status filter did not reflect suspension';
  END IF;

  PERFORM public.petro_admin_set_account_status(
    '00000000-0000-4000-8000-000000000406',
    'active',
    'Synthetic test reactivation'
  );
  SELECT public.petro_admin_get_platform_user('00000000-0000-4000-8000-000000000406')
  INTO detail;
  IF detail #>> '{user,active}' <> 'true'
     OR detail #>> '{user,accountStatus}' <> 'active' THEN
    RAISE EXCEPTION 'account reactivation did not update the profile status';
  END IF;

  assigned_roles := public.petro_admin_set_platform_roles(
    '00000000-0000-4000-8000-000000000406',
    ARRAY[]::text[],
    'Synthetic test role removal'
  );
  SELECT public.petro_admin_get_platform_user('00000000-0000-4000-8000-000000000406')
  INTO detail;
  IF assigned_roles <> ARRAY[]::text[]
     OR detail #> '{user,platformRoles}' <> '[]'::jsonb
     OR jsonb_array_length(detail -> 'activity') <> 4
     OR NOT EXISTS (
       SELECT 1
       FROM jsonb_array_elements(detail -> 'activity') AS event
       WHERE event ->> 'reason' = 'Synthetic test suspension'
     ) THEN
    RAISE EXCEPTION 'detail response omitted the sanitized account audit history';
  END IF;

  BEGIN
    PERFORM public.petro_admin_set_platform_roles(
      '00000000-0000-4000-8000-000000000407',
      ARRAY['support']::text[],
      'Synthetic pending account test'
    );
    RAISE EXCEPTION 'inactive account was given a platform role';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    PERFORM public.petro_admin_set_platform_roles(
      '00000000-0000-4000-8000-000000000406',
      ARRAY['admin_catalog']::text[],
      'Synthetic invalid role test'
    );
    RAISE EXCEPTION 'an unsupported platform role was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  BEGIN
    PERFORM public.petro_admin_set_platform_roles(
      '00000000-0000-4000-8000-000000000406',
      ARRAY[]::text[],
      '    '
    );
    RAISE EXCEPTION 'an empty audit reason was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  BEGIN
    PERFORM public.petro_admin_set_platform_roles(
      '00000000-0000-4000-8000-000000000401',
      ARRAY['owner', 'finance']::text[],
      'Synthetic self escalation test'
    );
    RAISE EXCEPTION 'owner changed their own platform roles';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.petro_admin_set_account_status(
      '00000000-0000-4000-8000-000000000401',
      'suspended',
      'Synthetic self suspension test'
    );
    RAISE EXCEPTION 'owner suspended their own account';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$owner_access$;

DO $non_owner_denial$
DECLARE
  actor_id uuid;
BEGIN
  FOREACH actor_id IN ARRAY ARRAY[
    '00000000-0000-4000-8000-000000000402'::uuid,
    '00000000-0000-4000-8000-000000000403'::uuid,
    '00000000-0000-4000-8000-000000000404'::uuid,
    '00000000-0000-4000-8000-000000000405'::uuid
  ] LOOP
    PERFORM set_config('request.jwt.claim.sub', actor_id::text, true);
    BEGIN
      PERFORM public.petro_admin_list_platform_users(1, 25, NULL, NULL, NULL);
      RAISE EXCEPTION 'a non-owner read the central platform-user directory';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    BEGIN
      PERFORM public.petro_admin_get_platform_user(
        '00000000-0000-4000-8000-000000000406'
      );
      RAISE EXCEPTION 'a non-owner read a central platform-user profile';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    BEGIN
      PERFORM public.petro_admin_set_platform_roles(
        '00000000-0000-4000-8000-000000000406',
        ARRAY['support']::text[],
        'Synthetic unauthorized role change'
      );
      RAISE EXCEPTION 'a non-owner changed platform roles';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    BEGIN
      PERFORM public.petro_admin_set_account_status(
        '00000000-0000-4000-8000-000000000406',
        'suspended',
        'Synthetic unauthorized status change'
      );
      RAISE EXCEPTION 'a non-owner changed account status';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;
END;
$non_owner_denial$;

RESET ROLE;
ROLLBACK;
