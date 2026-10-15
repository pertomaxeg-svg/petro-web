BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.petro_membership_invites') IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM pg_class c
       WHERE c.oid = 'public.petro_membership_invites'::regclass
         AND c.relrowsecurity
     ) THEN
    RAISE EXCEPTION
      'DB-02 stopped safely: invitation table or RLS baseline is missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_policy
    WHERE polrelid = 'public.petro_membership_invites'::regclass
  ) THEN
    RAISE EXCEPTION
      'DB-02 stopped safely: invitation RLS policy differs from reviewed baseline';
  END IF;

  IF to_regprocedure(
       'petro_private.can_manage_branch(uuid,uuid)'
     ) IS NULL
     OR to_regprocedure(
       'petro_private.can_view_profile(uuid)'
     ) IS NULL
     OR to_regprocedure(
       'petro_private.can_view_membership(uuid)'
     ) IS NULL
     OR to_regprocedure(
       'public.petro_accept_invitation(text)'
     ) IS NULL
     OR to_regprocedure(
       'public.petro_create_invitation(uuid,text,text,text,uuid[],text)'
     ) IS NULL
     OR to_regprocedure(
       'public.petro_set_membership(uuid,uuid,text,text,uuid[],boolean)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'DB-02 stopped safely: a reviewed function signature is missing';
  END IF;
END
$preflight$;

-- Invites are accessed through authorization-checking SECURITY DEFINER RPCs.
-- Keep RLS enabled with no direct table policy; remove unnecessary direct DML.
REVOKE ALL PRIVILEGES
  ON TABLE public.petro_membership_invites
  FROM PUBLIC, anon, authenticated;

-- These SECURITY DEFINER predicates are implementation helpers used by RLS.
-- Authenticated retains EXECUTE because policies evaluate them as the caller.
REVOKE ALL PRIVILEGES
  ON FUNCTION petro_private.can_manage_branch(uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE
  ON FUNCTION petro_private.can_manage_branch(uuid, uuid)
  TO authenticated;

REVOKE ALL PRIVILEGES
  ON FUNCTION petro_private.can_view_profile(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE
  ON FUNCTION petro_private.can_view_profile(uuid)
  TO authenticated;

REVOKE ALL PRIVILEGES
  ON FUNCTION petro_private.can_view_membership(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE
  ON FUNCTION petro_private.can_view_membership(uuid)
  TO authenticated;

-- This proposal changes only the explicit Pertomax objects named below.
-- In particular, it does not alter database- or schema-level default ACLs.

CREATE OR REPLACE FUNCTION public.petro_set_membership(
  p_organization_id uuid,
  p_user_id uuid,
  p_role text,
  p_scope text,
  p_branch_ids uuid[] DEFAULT '{}'::uuid[],
  p_active boolean DEFAULT true
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  actor_is_platform_admin boolean;
  actor_is_organization_owner boolean;
  v_membership_id uuid;
  branch_count integer;
BEGIN
  -- Platform roles and organization membership roles are separate namespaces.
  -- The platform grantor set is the existing owner/operations pair; a full-scope
  -- organization_owner may grant that organization role only within their org.
  actor_is_platform_admin :=
    petro_private.platform_has(ARRAY['owner', 'operations']::text[]);

  actor_is_organization_owner := EXISTS (
    SELECT 1
    FROM public.petro_memberships m
    JOIN public.petro_organizations o
      ON o.id = m.organization_id
    WHERE m.user_id = actor_id
      AND m.organization_id = p_organization_id
      AND m.active
      AND m.scope = 'organization'
      AND m.role = 'organization_owner'
      AND o.status = 'active'
  );

  IF actor_id IS NULL
     OR NOT petro_private.user_active()
     OR NOT (
       actor_is_platform_admin
       OR petro_private.can_manage_org(p_organization_id)
     ) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- Membership RPC accepts organization roles only; platform owner is never
  -- assignable through a membership or an organization invitation.
  IF p_role NOT IN (
       'organization_owner', 'manager', 'finance', 'worker', 'viewer'
     )
     OR p_scope NOT IN ('organization', 'branches') THEN
    RAISE EXCEPTION 'invalid membership role or scope' USING ERRCODE = '22023';
  END IF;

  IF p_role = 'organization_owner' AND p_scope <> 'organization' THEN
    RAISE EXCEPTION
      'organization owner membership requires organization scope'
      USING ERRCODE = '22023';
  END IF;

  IF p_role = 'organization_owner'
     AND NOT (actor_is_platform_admin OR actor_is_organization_owner) THEN
    RAISE EXCEPTION
      'only platform administrators or organization owners may grant owner role'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id)
     OR NOT EXISTS (
       SELECT 1 FROM public.petro_profiles WHERE user_id = p_user_id
     ) THEN
    RAISE EXCEPTION 'account not found' USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.petro_profiles
    WHERE user_id = p_user_id
      AND account_status = 'suspended'
  ) THEN
    RAISE EXCEPTION 'suspended accounts cannot be assigned'
      USING ERRCODE = '42501';
  END IF;

  IF p_scope = 'organization'
     AND cardinality(coalesce(p_branch_ids, '{}')) <> 0 THEN
    RAISE EXCEPTION
      'organization scope cannot include branch ids'
      USING ERRCODE = '22023';
  END IF;

  IF p_scope = 'branches' THEN
    IF cardinality(coalesce(p_branch_ids, '{}')) = 0 THEN
      RAISE EXCEPTION
        'branch scope requires at least one branch'
        USING ERRCODE = '22023';
    END IF;

    SELECT count(DISTINCT requested.branch_id)
    INTO branch_count
    FROM unnest(p_branch_ids) AS requested(branch_id);

    IF branch_count <> cardinality(p_branch_ids)
       OR EXISTS (
         SELECT 1
         FROM unnest(p_branch_ids) AS requested(branch_id)
         WHERE NOT EXISTS (
           SELECT 1
           FROM public.petro_branches b
           WHERE b.id = requested.branch_id
             AND b.organization_id = p_organization_id
         )
       ) THEN
      RAISE EXCEPTION
        'branch assignment is outside the organization'
        USING ERRCODE = '42501';
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
  WHERE membership_id = v_membership_id
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
  actor_is_platform_admin boolean;
  actor_is_organization_owner boolean;
  invitation_id uuid;
  branch_count integer;
BEGIN
  -- Only the existing platform owner/operations roles or a full-scope owner of
  -- this same active organization may invite an organization_owner.
  actor_is_platform_admin :=
    petro_private.platform_has(ARRAY['owner', 'operations']::text[]);

  actor_is_organization_owner := EXISTS (
    SELECT 1
    FROM public.petro_memberships m
    JOIN public.petro_organizations o
      ON o.id = m.organization_id
    WHERE m.user_id = actor_id
      AND m.organization_id = p_organization_id
      AND m.active
      AND m.scope = 'organization'
      AND m.role = 'organization_owner'
      AND o.status = 'active'
  );

  IF actor_id IS NULL
     OR NOT petro_private.user_active()
     OR NOT (
       actor_is_platform_admin
       OR petro_private.can_manage_org(p_organization_id)
     ) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- This is an organization membership invitation, never a platform-role grant.
  IF p_role NOT IN (
       'organization_owner', 'manager', 'finance', 'worker', 'viewer'
     )
     OR p_scope NOT IN ('organization', 'branches')
     OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR position('@' IN btrim(p_email)) < 2
     OR length(btrim(p_email)) > 254 THEN
    RAISE EXCEPTION 'invalid invitation details' USING ERRCODE = '22023';
  END IF;

  IF p_role = 'organization_owner' AND p_scope <> 'organization' THEN
    RAISE EXCEPTION
      'organization owner invitation requires organization scope'
      USING ERRCODE = '22023';
  END IF;

  IF p_role = 'organization_owner'
     AND NOT (actor_is_platform_admin OR actor_is_organization_owner) THEN
    RAISE EXCEPTION
      'only platform administrators or organization owners may invite an owner'
      USING ERRCODE = '42501';
  END IF;

  IF p_scope = 'organization'
     AND cardinality(coalesce(p_branch_ids, '{}')) <> 0 THEN
    RAISE EXCEPTION
      'organization scope cannot include branch ids'
      USING ERRCODE = '22023';
  END IF;

  IF p_scope = 'branches' THEN
    IF cardinality(coalesce(p_branch_ids, '{}')) = 0 THEN
      RAISE EXCEPTION
        'branch scope requires at least one branch'
        USING ERRCODE = '22023';
    END IF;

    SELECT count(DISTINCT requested.branch_id)
    INTO branch_count
    FROM unnest(p_branch_ids) AS requested(branch_id);

    IF branch_count <> cardinality(p_branch_ids)
       OR EXISTS (
         SELECT 1
         FROM unnest(p_branch_ids) AS requested(branch_id)
         WHERE NOT EXISTS (
           SELECT 1
           FROM public.petro_branches b
           WHERE b.id = requested.branch_id
             AND b.organization_id = p_organization_id
         )
       ) THEN
      RAISE EXCEPTION
        'branch assignment is outside the organization'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  INSERT INTO public.petro_membership_invites (
    organization_id, invited_email, role, scope, branch_ids,
    token_hash, created_by, expires_at
  )
  VALUES (
    p_organization_id, lower(btrim(p_email)), p_role, p_scope,
    coalesce(p_branch_ids, '{}'), p_token_hash, actor_id,
    now() + interval '7 days'
  )
  RETURNING id INTO invitation_id;

  INSERT INTO public.petro_audit_events (
    actor_id, organization_id, action, target_id, detail
  )
  VALUES (
    actor_id,
    p_organization_id,
    'membership.invited',
    invitation_id,
    jsonb_build_object(
      'role', p_role,
      'scope', p_scope,
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

  -- Revalidate the grantor so a pre-DB-02 manager-created owner invitation
  -- cannot be accepted after this policy is installed.
  IF invitation.role = 'organization_owner'
     AND (
       invitation.scope <> 'organization'
       OR NOT (
         EXISTS (
           SELECT 1
           FROM public.petro_platform_roles pr
           JOIN public.petro_profiles p
             ON p.user_id = pr.user_id
           WHERE pr.user_id = invitation.created_by
             AND pr.role IN ('owner', 'operations')
             AND pr.active
             AND p.active
         )
         OR EXISTS (
           SELECT 1
           FROM public.petro_memberships m
           JOIN public.petro_organizations o
             ON o.id = m.organization_id
           JOIN public.petro_profiles p
             ON p.user_id = m.user_id
           WHERE m.user_id = invitation.created_by
             AND m.organization_id = invitation.organization_id
             AND m.active
             AND m.scope = 'organization'
             AND m.role = 'organization_owner'
             AND o.status = 'active'
             AND p.active
         )
       )
     ) THEN
    RAISE EXCEPTION 'invitation is invalid or expired' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.petro_memberships
    WHERE user_id = actor_id
      AND organization_id = invitation.organization_id
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
    actor_id,
    invitation.organization_id,
    'membership.invitation_accepted',
    membership_id,
    jsonb_build_object('invitation_id', invitation.id)
  );

  RETURN membership_id;
END;
$$;

-- Reassert the existing authenticated API path and remove anonymous/public RPC.
REVOKE ALL PRIVILEGES
  ON FUNCTION public.petro_set_membership(
    uuid, uuid, text, text, uuid[], boolean
  )
  FROM PUBLIC, anon;
GRANT EXECUTE
  ON FUNCTION public.petro_set_membership(
    uuid, uuid, text, text, uuid[], boolean
  )
  TO authenticated, service_role;

REVOKE ALL PRIVILEGES
  ON FUNCTION public.petro_create_invitation(
    uuid, text, text, text, uuid[], text
  )
  FROM PUBLIC, anon;
GRANT EXECUTE
  ON FUNCTION public.petro_create_invitation(
    uuid, text, text, text, uuid[], text
  )
  TO authenticated, service_role;

REVOKE ALL PRIVILEGES
  ON FUNCTION public.petro_accept_invitation(text)
  FROM PUBLIC, anon;
GRANT EXECUTE
  ON FUNCTION public.petro_accept_invitation(text)
  TO authenticated, service_role;

DO $verify$
DECLARE
  privilege_name text;
BEGIN
  IF NOT EXISTS (
       SELECT 1
       FROM pg_class c
       WHERE c.oid = 'public.petro_membership_invites'::regclass
         AND c.relrowsecurity
     )
     OR EXISTS (
       SELECT 1
       FROM pg_policy
       WHERE polrelid = 'public.petro_membership_invites'::regclass
     ) THEN
    RAISE EXCEPTION
      'DB-02 verification failed: invite RLS state changed unexpectedly';
  END IF;

  FOREACH privilege_name IN ARRAY ARRAY[
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
  ] LOOP
    IF has_table_privilege(
         'anon', 'public.petro_membership_invites', privilege_name
       )
       OR has_table_privilege(
         'authenticated', 'public.petro_membership_invites', privilege_name
       ) THEN
      RAISE EXCEPTION
        'DB-02 verification failed: direct invitation-table privilege % remains',
        privilege_name;
    END IF;
  END LOOP;

  IF has_function_privilege(
       'anon', 'petro_private.can_manage_branch(uuid,uuid)', 'EXECUTE'
     )
     OR has_function_privilege(
       'anon', 'petro_private.can_view_profile(uuid)', 'EXECUTE'
     )
     OR has_function_privilege(
       'anon', 'petro_private.can_view_membership(uuid)', 'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.petro_create_invitation(uuid,text,text,text,uuid[],text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon', 'public.petro_accept_invitation(text)', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION
      'DB-02 verification failed: anonymous function execution remains';
  END IF;

  IF NOT has_function_privilege(
       'authenticated',
       'public.petro_create_invitation(uuid,text,text,text,uuid[],text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated', 'public.petro_accept_invitation(text)', 'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'petro_private.can_view_profile(uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION
      'DB-02 verification failed: an authenticated call path was removed';
  END IF;
END
$verify$;

COMMIT;
