BEGIN;

ALTER TABLE public.petro_profiles
  ADD COLUMN IF NOT EXISTS password_change_required boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.petro_admin_create_platform_user_access(
  p_user_id uuid,
  p_roles text[],
  p_reason text
)
RETURNS text[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  profile_active boolean;
  account_state text;
  current_roles text[];
  requested_roles text[];
  role_row_count integer;
  audit_count bigint;
BEGIN
  IF actor_id IS NULL
     OR NOT petro_private.user_active()
     OR NOT petro_private.platform_has(ARRAY['owner']::text[]) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_user_id IS NULL OR p_user_id = actor_id
     OR p_roles IS NULL OR cardinality(p_roles) < 1 OR cardinality(p_roles) > 5
     OR p_reason IS NULL OR length(btrim(p_reason)) < 5 OR length(btrim(p_reason)) > 500
     OR EXISTS (
       SELECT 1
       FROM unnest(p_roles) AS requested(role)
       WHERE requested.role IS NULL
          OR requested.role NOT IN ('owner', 'operations', 'finance', 'support', 'auditor')
     )
     OR cardinality(p_roles) <> (
       SELECT count(DISTINCT requested.role)
       FROM unnest(p_roles) AS requested(role)
     ) THEN
    RAISE EXCEPTION 'invalid initial platform access' USING ERRCODE = '22023';
  END IF;

  LOCK TABLE public.petro_platform_roles IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.petro_profiles IN SHARE ROW EXCLUSIVE MODE;

  SELECT profile.active,
         COALESCE(profile.account_status, CASE WHEN profile.active THEN 'active' ELSE 'pending' END)
  INTO profile_active, account_state
  FROM public.petro_profiles AS profile
  WHERE profile.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'platform user not found' USING ERRCODE = 'P0002';
  END IF;
  IF account_state = 'suspended' THEN
    RAISE EXCEPTION 'suspended account cannot receive initial platform access'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(array_agg(role ORDER BY role), ARRAY[]::text[]), count(*)
  INTO current_roles, role_row_count
  FROM public.petro_platform_roles
  WHERE user_id = p_user_id AND active;

  requested_roles := ARRAY(
    SELECT role
    FROM unnest(p_roles) AS requested(role)
    ORDER BY role
  );

  IF role_row_count = cardinality(requested_roles)
     AND current_roles = requested_roles
     AND NOT EXISTS (
       SELECT 1
       FROM public.petro_platform_roles
       WHERE user_id = p_user_id AND NOT active
     ) THEN
    RETURN requested_roles;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.petro_platform_roles
    WHERE user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'platform account already has role history'
      USING ERRCODE = '23505';
  END IF;

  UPDATE public.petro_profiles
  SET password_change_required = true
  WHERE user_id = p_user_id;

  INSERT INTO public.petro_platform_roles (user_id, role, active)
  SELECT p_user_id, requested.role, true
  FROM unnest(requested_roles) AS requested(role);

  INSERT INTO public.petro_audit_events (
    actor_id, organization_id, action, target_id, detail
  )
  VALUES (
    actor_id, NULL, 'platform.roles_changed', p_user_id,
    jsonb_build_object(
      'previous_roles', ARRAY[]::text[],
      'new_roles', requested_roles,
      'reason', btrim(p_reason),
      'account_created_by_owner', true,
      'target_was_pending', NOT profile_active
    )
  );

  GET DIAGNOSTICS audit_count = ROW_COUNT;
  IF audit_count <> 1 THEN
    RAISE EXCEPTION 'platform access audit was not recorded';
  END IF;

  RETURN requested_roles;
END;
$$;

REVOKE ALL ON FUNCTION public.petro_admin_create_platform_user_access(uuid, text[], text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.petro_admin_create_platform_user_access(uuid, text[], text)
  TO authenticated;

COMMENT ON FUNCTION public.petro_admin_create_platform_user_access(uuid, text[], text)
  IS 'Owner-only initial role assignment for a newly created account; permits pending accounts and records the reason.';

COMMIT;
