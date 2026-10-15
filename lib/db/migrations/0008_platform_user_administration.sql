BEGIN;

CREATE FUNCTION public.petro_admin_list_platform_users(
  p_page integer,
  p_page_size integer,
  p_search text DEFAULT NULL,
  p_account_status text DEFAULT NULL,
  p_role text DEFAULT NULL
)
RETURNS TABLE (
  user_id uuid,
  username text,
  display_name text,
  active boolean,
  account_status text,
  created_at timestamptz,
  platform_roles text[],
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
BEGIN
  IF actor_id IS NULL
     OR NOT petro_private.user_active()
     OR NOT petro_private.platform_has(ARRAY['owner']::text[]) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_page IS NULL OR p_page < 1 OR p_page > 1000000
     OR p_page_size IS NULL OR p_page_size < 1 OR p_page_size > 100
     OR (p_search IS NOT NULL AND (length(btrim(p_search)) < 2 OR length(btrim(p_search)) > 100))
     OR (p_account_status IS NOT NULL
         AND p_account_status NOT IN ('pending', 'active', 'suspended'))
     OR (p_role IS NOT NULL
         AND p_role NOT IN ('owner', 'operations', 'finance', 'support', 'auditor')) THEN
    RAISE EXCEPTION 'invalid platform user filters' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH filtered_users AS (
    SELECT
      p.user_id,
      p.username,
      p.display_name,
      p.active,
      COALESCE(p.account_status, CASE WHEN p.active THEN 'active' ELSE 'pending' END) AS account_status,
      p.created_at,
      COALESCE(
        array_agg(DISTINCT pr.role ORDER BY pr.role) FILTER (WHERE pr.active),
        ARRAY[]::text[]
      ) AS platform_roles
    FROM public.petro_profiles AS p
    LEFT JOIN public.petro_platform_roles AS pr ON pr.user_id = p.user_id
    WHERE
      (
        p_search IS NULL
        OR strpos(lower(COALESCE(p.username, '')), lower(btrim(p_search))) > 0
        OR strpos(lower(COALESCE(p.display_name, '')), lower(btrim(p_search))) > 0
      )
      AND (
        p_account_status IS NULL
        OR COALESCE(p.account_status, CASE WHEN p.active THEN 'active' ELSE 'pending' END)
             = p_account_status
      )
      AND (
        p_role IS NULL
        OR EXISTS (
          SELECT 1
          FROM public.petro_platform_roles AS role_filter
          WHERE role_filter.user_id = p.user_id
            AND role_filter.role = p_role
            AND role_filter.active
        )
      )
    GROUP BY p.user_id, p.username, p.display_name, p.active, p.account_status, p.created_at
  )
  SELECT
    f.user_id,
    f.username,
    f.display_name,
    f.active,
    f.account_status,
    f.created_at,
    f.platform_roles,
    count(*) OVER () AS total_count
  FROM filtered_users AS f
  ORDER BY f.created_at DESC, f.user_id
  LIMIT p_page_size
  OFFSET ((p_page::bigint - 1) * p_page_size);
END;
$$;

CREATE FUNCTION public.petro_admin_get_platform_user(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  result jsonb;
BEGIN
  IF actor_id IS NULL
     OR NOT petro_private.user_active()
     OR NOT petro_private.platform_has(ARRAY['owner']::text[]) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'user', jsonb_build_object(
      'userId', p.user_id,
      'username', p.username,
      'displayName', p.display_name,
      'active', p.active,
      'accountStatus', COALESCE(p.account_status, CASE WHEN p.active THEN 'active' ELSE 'pending' END),
      'createdAt', p.created_at,
      'platformRoles', COALESCE((
        SELECT jsonb_agg(pr.role ORDER BY pr.role)
        FROM public.petro_platform_roles AS pr
        WHERE pr.user_id = p.user_id AND pr.active
      ), '[]'::jsonb)
    ),
    'activity', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'activityId', e.id::text,
          'action', e.action,
          'occurredAt', e.occurred_at,
          'actorUsername', actor.username,
          'actorDisplayName', actor.display_name,
          'status', CASE
            WHEN e.action = 'account.status_changed' THEN e.detail ->> 'status'
            ELSE NULL
          END,
          'reason', e.detail ->> 'reason',
          'previousRoles', COALESCE(e.detail -> 'previous_roles', '[]'::jsonb),
          'newRoles', COALESCE(e.detail -> 'new_roles', '[]'::jsonb)
        )
        ORDER BY e.occurred_at DESC, e.id DESC
      )
      FROM (
        SELECT ae.id, ae.actor_id, ae.action, ae.detail, ae.occurred_at
        FROM public.petro_audit_events AS ae
        WHERE ae.target_id = p.user_id
          AND ae.action IN ('account.status_changed', 'platform.roles_changed')
        ORDER BY ae.occurred_at DESC, ae.id DESC
        LIMIT 25
      ) AS e
      LEFT JOIN public.petro_profiles AS actor ON actor.user_id = e.actor_id
    ), '[]'::jsonb)
  )
  INTO result
  FROM public.petro_profiles AS p
  WHERE p.user_id = p_user_id;

  IF result IS NULL THEN
    RAISE EXCEPTION 'platform user not found' USING ERRCODE = 'P0002';
  END IF;

  RETURN result;
END;
$$;

CREATE FUNCTION public.petro_admin_set_platform_roles(
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
  current_roles text[];
  requested_roles text[];
  active_owner_count integer;
BEGIN
  IF actor_id IS NULL
     OR NOT petro_private.user_active()
     OR NOT petro_private.platform_has(ARRAY['owner']::text[]) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_user_id IS NULL OR p_roles IS NULL
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
    RAISE EXCEPTION 'invalid platform role change' USING ERRCODE = '22023';
  END IF;

  IF actor_id = p_user_id THEN
    RAISE EXCEPTION 'self role changes are not allowed' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.petro_profiles WHERE user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'platform user not found' USING ERRCODE = 'P0002';
  END IF;

  LOCK TABLE public.petro_platform_roles IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.petro_profiles IN SHARE ROW EXCLUSIVE MODE;

  SELECT COALESCE(array_agg(pr.role ORDER BY pr.role), ARRAY[]::text[])
  INTO current_roles
  FROM public.petro_platform_roles AS pr
  WHERE pr.user_id = p_user_id AND pr.active;

  SELECT COALESCE(array_agg(requested.role ORDER BY requested.role), ARRAY[]::text[])
  INTO requested_roles
  FROM unnest(p_roles) AS requested(role);

  IF current_roles = requested_roles THEN
    RETURN requested_roles;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(requested_roles) AS requested(role)
    WHERE NOT (requested.role = ANY(current_roles))
  ) AND EXISTS (
    SELECT 1
    FROM public.petro_profiles AS target
    WHERE target.user_id = p_user_id
      AND (NOT target.active OR target.account_status = 'suspended')
  ) THEN
    RAISE EXCEPTION 'target account must be active before granting platform roles'
      USING ERRCODE = '23514';
  END IF;

  IF 'owner' = ANY(current_roles)
     AND NOT ('owner' = ANY(requested_roles))
     AND EXISTS (
       SELECT 1 FROM public.petro_profiles
       WHERE user_id = p_user_id AND active
     ) THEN
    SELECT count(*)
    INTO active_owner_count
    FROM public.petro_platform_roles AS pr
    JOIN public.petro_profiles AS profile ON profile.user_id = pr.user_id
    WHERE pr.role = 'owner' AND pr.active AND profile.active;

    IF active_owner_count <= 1 THEN
      RAISE EXCEPTION 'cannot remove the last active platform owner' USING ERRCODE = '23514';
    END IF;
  END IF;

  UPDATE public.petro_platform_roles AS pr
  SET active = (pr.role = ANY(requested_roles))
  WHERE pr.user_id = p_user_id
    AND pr.active IS DISTINCT FROM (pr.role = ANY(requested_roles));

  INSERT INTO public.petro_platform_roles (user_id, role, active)
  SELECT p_user_id, requested.role, true
  FROM unnest(requested_roles) AS requested(role)
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.petro_platform_roles AS existing
    WHERE existing.user_id = p_user_id AND existing.role = requested.role
  );

  INSERT INTO public.petro_audit_events (
    actor_id, organization_id, action, target_id, detail
  )
  VALUES (
    actor_id, NULL, 'platform.roles_changed', p_user_id,
    jsonb_build_object(
      'previous_roles', current_roles,
      'new_roles', requested_roles,
      'reason', btrim(p_reason)
    )
  );

  RETURN requested_roles;
END;
$$;

CREATE FUNCTION public.petro_admin_set_account_status(
  p_user_id uuid,
  p_status text,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  current_status text;
  active_owner_count integer;
BEGIN
  IF actor_id IS NULL
     OR NOT petro_private.user_active()
     OR NOT petro_private.platform_has(ARRAY['owner']::text[]) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_status IS NULL OR p_status NOT IN ('active', 'suspended')
     OR p_reason IS NULL OR length(btrim(p_reason)) < 5 OR length(btrim(p_reason)) > 500 THEN
    RAISE EXCEPTION 'invalid account status change' USING ERRCODE = '22023';
  END IF;

  IF actor_id = p_user_id THEN
    RAISE EXCEPTION 'self account status changes are not allowed' USING ERRCODE = '42501';
  END IF;

  LOCK TABLE public.petro_platform_roles IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.petro_profiles IN SHARE ROW EXCLUSIVE MODE;

  SELECT COALESCE(p.account_status, CASE WHEN p.active THEN 'active' ELSE 'pending' END)
  INTO current_status
  FROM public.petro_profiles AS p
  WHERE p.user_id = p_user_id;

  IF current_status IS NULL THEN
    RAISE EXCEPTION 'platform user not found' USING ERRCODE = 'P0002';
  END IF;

  IF current_status = p_status THEN
    RETURN;
  END IF;

  IF p_status = 'suspended' AND EXISTS (
    SELECT 1
    FROM public.petro_platform_roles AS pr
    JOIN public.petro_profiles AS profile ON profile.user_id = pr.user_id
    WHERE pr.user_id = p_user_id AND pr.role = 'owner' AND pr.active AND profile.active
  ) THEN
    SELECT count(*)
    INTO active_owner_count
    FROM public.petro_platform_roles AS pr
    JOIN public.petro_profiles AS p ON p.user_id = pr.user_id
    WHERE pr.role = 'owner' AND pr.active AND p.active;

    IF active_owner_count <= 1 THEN
      RAISE EXCEPTION 'cannot suspend the last active platform owner' USING ERRCODE = '23514';
    END IF;
  END IF;

  UPDATE public.petro_profiles
  SET active = (p_status = 'active'),
      account_status = p_status
  WHERE user_id = p_user_id;

  INSERT INTO public.petro_audit_events (
    actor_id, organization_id, action, target_id, detail
  )
  VALUES (
    actor_id, NULL, 'account.status_changed', p_user_id,
    jsonb_build_object('status', p_status, 'reason', btrim(p_reason))
  );
END;
$$;

COMMENT ON FUNCTION public.petro_admin_list_platform_users(integer, integer, text, text, text)
  IS 'Owner-only, paginated platform-user directory; never returns Auth email or credentials.';
COMMENT ON FUNCTION public.petro_admin_get_platform_user(uuid)
  IS 'Owner-only platform account detail with a sanitized role/status audit timeline.';
COMMENT ON FUNCTION public.petro_admin_set_platform_roles(uuid, text[], text)
  IS 'Owner-only audited platform role replacement; prevents self-change and last-owner removal.';
COMMENT ON FUNCTION public.petro_admin_set_account_status(uuid, text, text)
  IS 'Owner-only audited account status change; prevents self-change and last-owner suspension.';

REVOKE ALL ON FUNCTION public.petro_admin_list_platform_users(integer, integer, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.petro_admin_get_platform_user(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.petro_admin_set_platform_roles(uuid, text[], text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.petro_admin_set_account_status(uuid, text, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.petro_admin_list_platform_users(integer, integer, text, text, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_admin_get_platform_user(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_admin_set_platform_roles(uuid, text[], text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_admin_set_account_status(uuid, text, text)
  TO authenticated;

COMMIT;
