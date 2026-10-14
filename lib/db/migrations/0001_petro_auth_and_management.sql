BEGIN;

ALTER TABLE public.petro_profiles
  ADD COLUMN IF NOT EXISTS username text,
  ADD COLUMN IF NOT EXISTS login_identifier_type text,
  ADD COLUMN IF NOT EXISTS account_status text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.petro_profiles'::regclass
      AND conname = 'petro_profiles_username_format'
  ) THEN
    ALTER TABLE public.petro_profiles
      ADD CONSTRAINT petro_profiles_username_format
      CHECK (
        username IS NULL
        OR (
          username = lower(username)
          AND username ~ '^[a-z0-9][a-z0-9_.-]{2,31}$'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.petro_profiles'::regclass
      AND conname = 'petro_profiles_login_identifier_type'
  ) THEN
    ALTER TABLE public.petro_profiles
      ADD CONSTRAINT petro_profiles_login_identifier_type
      CHECK (
        login_identifier_type IS NULL
        OR login_identifier_type IN ('email', 'username')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.petro_profiles'::regclass
      AND conname = 'petro_profiles_account_status'
  ) THEN
    ALTER TABLE public.petro_profiles
      ADD CONSTRAINT petro_profiles_account_status
      CHECK (
        account_status IS NULL
        OR account_status IN ('pending', 'active', 'suspended')
      );
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS petro_profiles_username_ci_unique
  ON public.petro_profiles (lower(username))
  WHERE username IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.petro_membership_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES public.petro_organizations(id) ON DELETE CASCADE,
  invited_email text NOT NULL,
  role text NOT NULL
    CHECK (role IN ('organization_owner', 'manager', 'finance', 'worker', 'viewer')),
  scope text NOT NULL CHECK (scope IN ('organization', 'branches')),
  branch_ids uuid[] NOT NULL DEFAULT '{}',
  token_hash text NOT NULL UNIQUE
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_by uuid REFERENCES auth.users(id),
  accepted_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT petro_membership_invites_email_normalized
    CHECK (invited_email = lower(btrim(invited_email)))
);

ALTER TABLE public.petro_membership_invites ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION petro_private.can_manage_branch(
  p_organization_id uuid,
  p_branch_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT petro_private.user_active()
    AND (
      petro_private.can_manage_org(p_organization_id)
      OR EXISTS (
        SELECT 1
        FROM public.petro_memberships m
        JOIN public.petro_membership_branches mb
          ON mb.membership_id = m.id
         AND mb.organization_id = m.organization_id
        WHERE m.user_id = auth.uid()
          AND m.organization_id = p_organization_id
          AND m.active
          AND m.scope = 'branches'
          AND m.role IN ('organization_owner', 'manager')
          AND mb.branch_id = p_branch_id
      )
    );
$$;

CREATE OR REPLACE FUNCTION petro_private.can_view_profile(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_user_id = auth.uid()
    OR (
      petro_private.user_active()
      AND (
        petro_private.platform_has(ARRAY['owner', 'operations']::text[])
        OR EXISTS (
          SELECT 1
          FROM public.petro_memberships target_membership
          WHERE target_membership.user_id = p_user_id
            AND target_membership.active
            AND (
              petro_private.can_manage_org(target_membership.organization_id)
              OR EXISTS (
                SELECT 1
                FROM public.petro_membership_branches target_branch
                WHERE target_branch.membership_id = target_membership.id
                  AND target_branch.organization_id = target_membership.organization_id
                  AND petro_private.can_read_branch(
                    target_membership.organization_id,
                    target_branch.branch_id
                  )
              )
            )
        )
      )
    );
$$;

GRANT EXECUTE ON FUNCTION petro_private.can_manage_branch(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION petro_private.can_view_profile(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION petro_private.can_view_membership(p_membership_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT petro_private.user_active()
    AND EXISTS (
      SELECT 1
      FROM public.petro_memberships target_membership
      WHERE target_membership.id = p_membership_id
        AND (
          target_membership.user_id = auth.uid()
          OR petro_private.can_manage_org(target_membership.organization_id)
          OR EXISTS (
            SELECT 1
            FROM public.petro_membership_branches target_branch
            WHERE target_branch.membership_id = target_membership.id
              AND target_branch.organization_id = target_membership.organization_id
              AND petro_private.can_read_branch(
                target_membership.organization_id,
                target_branch.branch_id
              )
          )
        )
    );
$$;

GRANT EXECUTE ON FUNCTION petro_private.can_view_membership(uuid) TO authenticated;

DROP POLICY IF EXISTS petro_profiles_manager_read ON public.petro_profiles;
CREATE POLICY petro_profiles_manager_read
  ON public.petro_profiles
  FOR SELECT
  TO authenticated
  USING (petro_private.can_view_profile(user_id));

DROP POLICY IF EXISTS petro_memberships_manager_read ON public.petro_memberships;
CREATE POLICY petro_memberships_manager_read
  ON public.petro_memberships
  FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR (
      petro_private.user_active()
      AND (
        petro_private.can_manage_org(organization_id)
        OR petro_private.can_view_membership(id)
      )
    )
  );

DO $$
DECLARE
  existing_policy record;
BEGIN
  FOR existing_policy IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'petro_membership_branches'
      AND cmd = 'SELECT'
  LOOP
    EXECUTE format(
      'DROP POLICY %I ON public.petro_membership_branches',
      existing_policy.policyname
    );
  END LOOP;
END;
$$;

CREATE POLICY petro_membership_branches_scoped_read
  ON public.petro_membership_branches
  FOR SELECT
  TO authenticated
  USING (
    petro_private.user_active()
    AND EXISTS (
      SELECT 1
      FROM public.petro_memberships m
      WHERE m.id = public.petro_membership_branches.membership_id
        AND m.organization_id = public.petro_membership_branches.organization_id
        AND (
          m.user_id = auth.uid()
          OR petro_private.can_manage_org(public.petro_membership_branches.organization_id)
          OR petro_private.can_read_branch(
            public.petro_membership_branches.organization_id,
            public.petro_membership_branches.branch_id
          )
        )
    )
  );

DROP POLICY IF EXISTS petro_audit_events_org_manager_read ON public.petro_audit_events;
CREATE POLICY petro_audit_events_org_manager_read
  ON public.petro_audit_events
  FOR SELECT
  TO authenticated
  USING (
    petro_private.user_active()
    AND organization_id IS NOT NULL
    AND petro_private.can_manage_org(organization_id)
  );

CREATE OR REPLACE FUNCTION public.petro_set_membership(
  p_organization_id uuid,
  p_user_id uuid,
  p_role text,
  p_scope text,
  p_branch_ids uuid[] DEFAULT '{}',
  p_active boolean DEFAULT true
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  v_membership_id uuid;
  branch_count integer;
BEGIN
  IF actor_id IS NULL
     OR NOT petro_private.user_active()
     OR NOT (
       petro_private.platform_has(ARRAY['owner', 'operations']::text[])
       OR petro_private.can_manage_org(p_organization_id)
     ) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_role NOT IN ('organization_owner', 'manager', 'finance', 'worker', 'viewer')
     OR p_scope NOT IN ('organization', 'branches') THEN
    RAISE EXCEPTION 'invalid membership role or scope' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id)
     OR NOT EXISTS (SELECT 1 FROM public.petro_profiles WHERE user_id = p_user_id) THEN
    RAISE EXCEPTION 'account not found' USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.petro_profiles
    WHERE user_id = p_user_id
      AND account_status = 'suspended'
  ) THEN
    RAISE EXCEPTION 'suspended accounts cannot be assigned' USING ERRCODE = '42501';
  END IF;

  IF p_scope = 'organization' AND cardinality(coalesce(p_branch_ids, '{}')) <> 0 THEN
    RAISE EXCEPTION 'organization scope cannot include branch ids' USING ERRCODE = '22023';
  END IF;

  IF p_scope = 'branches' THEN
    IF cardinality(coalesce(p_branch_ids, '{}')) = 0 THEN
      RAISE EXCEPTION 'branch scope requires at least one branch' USING ERRCODE = '22023';
    END IF;

    SELECT count(DISTINCT requested.branch_id)
    INTO branch_count
    FROM unnest(p_branch_ids) AS requested(branch_id);

    IF branch_count <> cardinality(p_branch_ids)
       OR EXISTS (
         SELECT 1
         FROM unnest(p_branch_ids) AS requested(branch_id)
         WHERE NOT EXISTS (
           SELECT 1 FROM public.petro_branches b
           WHERE b.id = requested.branch_id
             AND b.organization_id = p_organization_id
         )
       ) THEN
      RAISE EXCEPTION 'branch assignment is outside the organization' USING ERRCODE = '42501';
    END IF;
  END IF;

  INSERT INTO public.petro_memberships (
    user_id, organization_id, role, scope, active
  )
  VALUES (
    p_user_id, p_organization_id, p_role, p_scope, p_active
  )
  ON CONFLICT (user_id, organization_id)
  DO UPDATE SET
    role = EXCLUDED.role,
    scope = EXCLUDED.scope,
    active = EXCLUDED.active
  RETURNING id INTO v_membership_id;

  DELETE FROM public.petro_membership_branches
  WHERE petro_membership_branches.membership_id = v_membership_id
    AND organization_id = p_organization_id;

  IF p_scope = 'branches' THEN
    INSERT INTO public.petro_membership_branches (
      organization_id, membership_id, branch_id
    )
    SELECT p_organization_id, v_membership_id, requested.branch_id
    FROM unnest(p_branch_ids) AS requested(branch_id);
  END IF;

  UPDATE public.petro_profiles
  SET active = true,
      account_status = 'active'
  WHERE user_id = p_user_id
    AND account_status = 'pending';

  INSERT INTO public.petro_audit_events (
    actor_id, organization_id, action, target_id, detail
  )
  VALUES (
    actor_id,
    p_organization_id,
    'membership.assigned',
    p_user_id,
    jsonb_build_object(
      'role', p_role,
      'scope', p_scope,
      'active', p_active,
      'branch_count', cardinality(coalesce(p_branch_ids, '{}'))
    )
  );

  RETURN v_membership_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.petro_set_account_status(
  p_user_id uuid,
  p_status text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  active_owner_count integer;
BEGIN
  IF actor_id IS NULL
     OR NOT petro_private.user_active()
     OR NOT petro_private.platform_has(ARRAY['owner', 'operations']::text[]) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_status NOT IN ('active', 'suspended') THEN
    RAISE EXCEPTION 'invalid account status' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.petro_profiles WHERE user_id = p_user_id) THEN
    RAISE EXCEPTION 'account not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_status = 'suspended' AND EXISTS (
    SELECT 1 FROM public.petro_platform_roles
    WHERE user_id = p_user_id AND role = 'owner' AND active
  ) THEN
    SELECT count(*)
    INTO active_owner_count
    FROM public.petro_platform_roles pr
    JOIN public.petro_profiles p ON p.user_id = pr.user_id
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
    jsonb_build_object('status', p_status)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.petro_update_organization(
  p_organization_id uuid,
  p_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
BEGIN
  IF actor_id IS NULL
     OR NOT petro_private.user_active()
     OR NOT petro_private.can_manage_org(p_organization_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF length(btrim(p_name)) < 2 OR length(btrim(p_name)) > 160 THEN
    RAISE EXCEPTION 'invalid organization name' USING ERRCODE = '22023';
  END IF;

  UPDATE public.petro_organizations
  SET name = btrim(p_name)
  WHERE id = p_organization_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.petro_audit_events (
    actor_id, organization_id, action, target_id, detail
  )
  VALUES (
    actor_id, p_organization_id, 'organization.updated', p_organization_id,
    jsonb_build_object('name', btrim(p_name))
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.petro_update_branch(
  p_organization_id uuid,
  p_branch_id uuid,
  p_name text,
  p_address text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
BEGIN
  IF actor_id IS NULL
     OR NOT petro_private.user_active()
     OR NOT petro_private.can_manage_org(p_organization_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF length(btrim(p_name)) < 2 OR length(btrim(p_name)) > 160
     OR length(btrim(p_address)) > 500 THEN
    RAISE EXCEPTION 'invalid branch details' USING ERRCODE = '22023';
  END IF;

  UPDATE public.petro_branches
  SET name = btrim(p_name), address = btrim(p_address)
  WHERE id = p_branch_id
    AND organization_id = p_organization_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'branch not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.petro_audit_events (
    actor_id, organization_id, action, target_id, detail
  )
  VALUES (
    actor_id, p_organization_id, 'branch.updated', p_branch_id,
    jsonb_build_object('name', btrim(p_name), 'address', btrim(p_address))
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.petro_set_branch_status(
  p_organization_id uuid,
  p_branch_id uuid,
  p_status text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  previous_status text;
BEGIN
  IF actor_id IS NULL
     OR NOT petro_private.user_active()
     OR NOT petro_private.can_manage_org(p_organization_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_status NOT IN ('pending', 'active', 'suspended') THEN
    RAISE EXCEPTION 'invalid branch status' USING ERRCODE = '22023';
  END IF;

  SELECT status
  INTO previous_status
  FROM public.petro_branches
  WHERE id = p_branch_id
    AND organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'branch not found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.petro_branches
  SET status = p_status
  WHERE id = p_branch_id
    AND organization_id = p_organization_id;

  INSERT INTO public.petro_audit_events (
    actor_id, organization_id, action, target_id, detail
  )
  VALUES (
    actor_id, p_organization_id, 'branch.status_changed', p_branch_id,
    jsonb_build_object('before', previous_status, 'after', p_status)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.petro_create_invitation(
  p_organization_id uuid,
  p_email text,
  p_role text,
  p_scope text,
  p_branch_ids uuid[],
  p_token_hash text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  invitation_id uuid;
  branch_count integer;
BEGIN
  IF actor_id IS NULL
     OR NOT petro_private.user_active()
     OR NOT (
       petro_private.platform_has(ARRAY['owner', 'operations']::text[])
       OR petro_private.can_manage_org(p_organization_id)
     ) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_role NOT IN ('organization_owner', 'manager', 'finance', 'worker', 'viewer')
     OR p_scope NOT IN ('organization', 'branches')
     OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR position('@' IN btrim(p_email)) < 2
     OR length(btrim(p_email)) > 254 THEN
    RAISE EXCEPTION 'invalid invitation details' USING ERRCODE = '22023';
  END IF;

  IF p_scope = 'organization' AND cardinality(coalesce(p_branch_ids, '{}')) <> 0 THEN
    RAISE EXCEPTION 'organization scope cannot include branch ids' USING ERRCODE = '22023';
  END IF;

  IF p_scope = 'branches' THEN
    IF cardinality(coalesce(p_branch_ids, '{}')) = 0 THEN
      RAISE EXCEPTION 'branch scope requires at least one branch' USING ERRCODE = '22023';
    END IF;

    SELECT count(DISTINCT requested.branch_id)
    INTO branch_count
    FROM unnest(p_branch_ids) AS requested(branch_id);

    IF branch_count <> cardinality(p_branch_ids)
       OR EXISTS (
         SELECT 1
         FROM unnest(p_branch_ids) AS requested(branch_id)
         WHERE NOT EXISTS (
           SELECT 1 FROM public.petro_branches b
           WHERE b.id = requested.branch_id
             AND b.organization_id = p_organization_id
         )
       ) THEN
      RAISE EXCEPTION 'branch assignment is outside the organization' USING ERRCODE = '42501';
    END IF;
  END IF;

  INSERT INTO public.petro_membership_invites (
    organization_id, invited_email, role, scope, branch_ids,
    token_hash, created_by, expires_at
  )
  VALUES (
    p_organization_id, lower(btrim(p_email)), p_role, p_scope,
    coalesce(p_branch_ids, '{}'), p_token_hash, actor_id, now() + interval '7 days'
  )
  RETURNING id INTO invitation_id;

  INSERT INTO public.petro_audit_events (
    actor_id, organization_id, action, target_id, detail
  )
  VALUES (
    actor_id, p_organization_id, 'membership.invited', invitation_id,
    jsonb_build_object(
      'role', p_role, 'scope', p_scope,
      'branch_count', cardinality(coalesce(p_branch_ids, '{}'))
    )
  );

  RETURN invitation_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.petro_accept_invitation(p_token_hash text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  actor_email text;
  invitation public.petro_membership_invites%ROWTYPE;
  membership_id uuid;
BEGIN
  IF actor_id IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT lower(email)
  INTO actor_email
  FROM auth.users
  WHERE id = actor_id
    AND email_confirmed_at IS NOT NULL;

  IF actor_email IS NULL THEN
    RAISE EXCEPTION 'verified recovery email required' USING ERRCODE = '42501';
  END IF;

  SELECT *
  INTO invitation
  FROM public.petro_membership_invites
  WHERE token_hash = p_token_hash
    AND accepted_at IS NULL
    AND revoked_at IS NULL
    AND expires_at > now()
  FOR UPDATE;

  IF NOT FOUND OR invitation.invited_email <> actor_email THEN
    RAISE EXCEPTION 'invitation is invalid or expired' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.petro_memberships
    WHERE user_id = actor_id AND organization_id = invitation.organization_id
  ) THEN
    RAISE EXCEPTION 'membership already exists' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.petro_memberships (
    user_id, organization_id, role, scope, active
  )
  VALUES (
    actor_id, invitation.organization_id, invitation.role, invitation.scope, true
  )
  RETURNING id INTO membership_id;

  IF invitation.scope = 'branches' THEN
    INSERT INTO public.petro_membership_branches (
      organization_id, membership_id, branch_id
    )
    SELECT invitation.organization_id, membership_id, requested.branch_id
    FROM unnest(invitation.branch_ids) AS requested(branch_id);
  END IF;

  UPDATE public.petro_profiles
  SET active = true, account_status = 'active'
  WHERE user_id = actor_id
    AND account_status = 'pending';

  UPDATE public.petro_membership_invites
  SET accepted_by = actor_id, accepted_at = now()
  WHERE id = invitation.id;

  INSERT INTO public.petro_audit_events (
    actor_id, organization_id, action, target_id, detail
  )
  VALUES (
    actor_id, invitation.organization_id, 'membership.invitation_accepted',
    membership_id, jsonb_build_object('invitation_id', invitation.id)
  );

  RETURN membership_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.petro_list_invitations(p_organization_id uuid)
RETURNS TABLE (
  id uuid,
  invited_email text,
  role text,
  scope text,
  branch_ids uuid[],
  created_at timestamptz,
  expires_at timestamptz,
  accepted_at timestamptz,
  revoked_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT petro_private.user_active()
     OR NOT (
       petro_private.platform_has(ARRAY['owner', 'operations']::text[])
       OR petro_private.can_manage_org(p_organization_id)
     ) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT i.id, i.invited_email, i.role, i.scope, i.branch_ids,
         i.created_at, i.expires_at, i.accepted_at, i.revoked_at
  FROM public.petro_membership_invites i
  WHERE i.organization_id = p_organization_id
  ORDER BY i.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.petro_revoke_invitation(p_invitation_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  invitation public.petro_membership_invites%ROWTYPE;
BEGIN
  IF actor_id IS NULL OR NOT petro_private.user_active() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO invitation
  FROM public.petro_membership_invites
  WHERE id = p_invitation_id
  FOR UPDATE;

  IF NOT FOUND
     OR NOT (
       petro_private.platform_has(ARRAY['owner', 'operations']::text[])
       OR petro_private.can_manage_org(invitation.organization_id)
     ) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF invitation.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'accepted invitations cannot be revoked' USING ERRCODE = '23514';
  END IF;

  UPDATE public.petro_membership_invites
  SET revoked_at = now()
  WHERE id = p_invitation_id;

  INSERT INTO public.petro_audit_events (
    actor_id, organization_id, action, target_id, detail
  )
  VALUES (
    actor_id, invitation.organization_id, 'membership.invitation_revoked',
    p_invitation_id, '{}'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.petro_set_membership(uuid, uuid, text, text, uuid[], boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.petro_set_account_status(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.petro_update_organization(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.petro_update_branch(uuid, uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.petro_set_branch_status(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.petro_create_invitation(uuid, text, text, text, uuid[], text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.petro_accept_invitation(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.petro_list_invitations(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.petro_revoke_invitation(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.petro_set_membership(uuid, uuid, text, text, uuid[], boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_set_account_status(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_update_organization(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_update_branch(uuid, uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_set_branch_status(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_create_invitation(uuid, text, text, text, uuid[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_accept_invitation(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_list_invitations(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_revoke_invitation(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION petro_private.handle_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  normalized_username text;
  identifier_type text;
BEGIN
  normalized_username := nullif(
    lower(btrim(coalesce(NEW.raw_user_meta_data->>'username', ''))),
    ''
  );
  identifier_type := coalesce(
    nullif(NEW.raw_user_meta_data->>'login_identifier_type', ''),
    CASE WHEN normalized_username IS NULL THEN 'email' ELSE 'username' END
  );

  INSERT INTO public.petro_profiles (
    user_id, display_name, active, username,
    login_identifier_type, account_status
  )
  VALUES (
    NEW.id,
    coalesce(
      nullif(btrim(NEW.raw_user_meta_data->>'display_name'), ''),
      nullif(NEW.email, ''),
      'مستخدم'
    ),
    false,
    normalized_username,
    identifier_type,
    'pending'
  )
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

COMMIT;
