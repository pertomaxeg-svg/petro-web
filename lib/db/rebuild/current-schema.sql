--
-- PostgreSQL database dump
--

-- Dumped from database version 17.11
-- Dumped by pg_dump version 17.5

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: petro_private; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA petro_private;


--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: can_manage_branch(uuid, uuid); Type: FUNCTION; Schema: petro_private; Owner: -
--

CREATE FUNCTION petro_private.can_manage_branch(p_organization_id uuid, p_branch_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
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


--
-- Name: can_manage_org(uuid); Type: FUNCTION; Schema: petro_private; Owner: -
--

CREATE FUNCTION petro_private.can_manage_org(p_org uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
 select petro_private.user_active() and (
  petro_private.platform_has(array['owner','operations']) or exists(
   select 1 from public.petro_memberships m join public.petro_organizations o on o.id=m.organization_id
   where m.user_id=auth.uid() and m.organization_id=p_org and m.active
   and m.scope='organization' and m.role in ('organization_owner','manager') and o.status='active'))
$$;


--
-- Name: can_read_branch(uuid, uuid); Type: FUNCTION; Schema: petro_private; Owner: -
--

CREATE FUNCTION petro_private.can_read_branch(p_org uuid, p_branch uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
 select petro_private.user_active() and exists(
  select 1 from public.petro_branches b where b.id=p_branch and b.organization_id=p_org
  and (petro_private.platform_has(array['owner','operations','finance','support','auditor']) or exists(
    select 1 from public.petro_memberships m where m.organization_id=p_org and m.user_id=auth.uid() and m.active
      and (m.scope='organization' or exists(select 1 from public.petro_membership_branches g
        where g.membership_id=m.id and g.organization_id=p_org and g.branch_id=p_branch)))))
$$;


--
-- Name: can_read_org(uuid); Type: FUNCTION; Schema: petro_private; Owner: -
--

CREATE FUNCTION petro_private.can_read_org(p_org uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
 select petro_private.user_active() and (
  petro_private.platform_has(array['owner','operations','finance','support','auditor']) or
  exists(select 1 from public.petro_memberships m where m.user_id=auth.uid() and m.organization_id=p_org and m.active))
$$;


--
-- Name: can_view_membership(uuid); Type: FUNCTION; Schema: petro_private; Owner: -
--

CREATE FUNCTION petro_private.can_view_membership(p_membership_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
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


--
-- Name: can_view_profile(uuid); Type: FUNCTION; Schema: petro_private; Owner: -
--

CREATE FUNCTION petro_private.can_view_profile(p_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
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


--
-- Name: handle_auth_user(); Type: FUNCTION; Schema: petro_private; Owner: -
--

CREATE FUNCTION petro_private.handle_auth_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
DECLARE
  normalized_username text;
  normalized_display_name text;
BEGIN
  IF NEW.email IS NULL OR btrim(NEW.email) = '' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A recovery email is required for a Pertomax account';
  END IF;

  normalized_username := nullif(
    lower(btrim(coalesce(NEW.raw_user_meta_data->>'username', ''))),
    ''
  );

  IF normalized_username IS NULL
     OR normalized_username !~ '^[a-z0-9][a-z0-9_.-]{2,31}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A valid username is required for a Pertomax account';
  END IF;

  normalized_display_name := nullif(
    left(btrim(coalesce(NEW.raw_user_meta_data->>'display_name', '')), 120),
    ''
  );
  IF normalized_display_name IS NULL
     OR lower(normalized_display_name) = lower(coalesce(NEW.email, '')) THEN
    normalized_display_name := 'مستخدم جديد';
  END IF;

  INSERT INTO public.petro_profiles (
    user_id,
    display_name,
    active,
    username,
    login_identifier_type,
    account_status
  )
  VALUES (
    NEW.id,
    normalized_display_name,
    false,
    normalized_username,
    'username',
    'pending'
  )
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$_$;


--
-- Name: platform_has(text[]); Type: FUNCTION; Schema: petro_private; Owner: -
--

CREATE FUNCTION petro_private.platform_has(p_roles text[]) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
 select petro_private.user_active() and exists(
   select 1 from public.petro_platform_roles r
   where r.user_id=auth.uid() and r.active and r.role=any(p_roles))
$$;


--
-- Name: user_active(); Type: FUNCTION; Schema: petro_private; Owner: -
--

CREATE FUNCTION petro_private.user_active() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists(select 1 from public.petro_profiles p where p.user_id=auth.uid() and p.active)
$$;


--
-- Name: petro_accept_invitation(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.petro_accept_invitation(p_token_hash text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
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


--
-- Name: petro_access_context(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.petro_access_context() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare result jsonb;
begin
 if auth.uid() is null or not petro_private.user_active() then
  raise exception 'ACCOUNT_INACTIVE' using errcode='42501';
 end if;
 select jsonb_build_object(
  'user_id',auth.uid(),
  'display_name',(select p.display_name from public.petro_profiles p where p.user_id=auth.uid()),
  'platform_roles',coalesce((select jsonb_agg(r.role order by r.role) from public.petro_platform_roles r
    where r.user_id=auth.uid() and r.active),'[]'::jsonb),
  'memberships',coalesce((select jsonb_agg(jsonb_build_object('organization_id',m.organization_id,
    'role',m.role,'scope',m.scope,'kind',o.kind,'name',o.name))
    from public.petro_memberships m join public.petro_organizations o on o.id=m.organization_id
    where m.user_id=auth.uid() and m.active),'[]'::jsonb)
 ) into result;
 return result;
end $$;


--
-- Name: petro_create_branch(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.petro_create_branch(p_organization_id uuid, p_name text, p_address text DEFAULT ''::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare new_id uuid;
begin
 if not petro_private.can_manage_org(p_organization_id) then
  raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if p_name is null or char_length(trim(p_name)) not between 2 and 160 or char_length(coalesce(p_address,''))>500 then
  raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 insert into public.petro_branches(organization_id,name,address)
 values(p_organization_id,trim(p_name),coalesce(p_address,'')) returning id into new_id;
 insert into public.petro_audit_events(actor_id,organization_id,action,target_id)
 values(auth.uid(),p_organization_id,'branch.created',new_id);
 return new_id;
end $$;


--
-- Name: petro_create_invitation(uuid, text, text, text, uuid[], text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.petro_create_invitation(p_organization_id uuid, p_email text, p_role text, p_scope text, p_branch_ids uuid[], p_token_hash text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
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
$_$;


--
-- Name: petro_create_organization(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.petro_create_organization(p_name text, p_kind text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare new_id uuid;
begin
 if not petro_private.platform_has(array['owner','operations']) then
  raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if p_name is null or char_length(trim(p_name)) not between 2 and 160
   or p_kind is null or p_kind not in ('company','station','provider') then
  raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 insert into public.petro_organizations(name,kind,created_by) values(trim(p_name),p_kind,auth.uid()) returning id into new_id;
 insert into public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
 values(auth.uid(),new_id,'organization.created',new_id,jsonb_build_object('kind',p_kind));
 return new_id;
end $$;


--
-- Name: petro_list_invitations(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.petro_list_invitations(p_organization_id uuid) RETURNS TABLE(id uuid, invited_email text, role text, scope text, branch_ids uuid[], created_at timestamp with time zone, expires_at timestamp with time zone, accepted_at timestamp with time zone, revoked_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
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


--
-- Name: petro_publish_plan_price(uuid, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.petro_publish_plan_price(p_plan_id uuid, p_annual_price_minor bigint) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare prior public.petro_plan_versions%rowtype; new_id uuid;
begin
 if not petro_private.platform_has(array['owner']) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if p_annual_price_minor is null or p_annual_price_minor not between 0 and 1000000000 then
  raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 perform 1 from public.petro_plans where id=p_plan_id for update;
 if not found then raise exception 'NOT_FOUND' using errcode='22023'; end if;
 select * into prior from public.petro_plan_versions where plan_id=p_plan_id order by version desc limit 1;
 insert into public.petro_plan_versions(plan_id,version,annual_price_minor,nfc_issue_price_minor,billing_unit,features,created_by)
 values(p_plan_id,prior.version+1,p_annual_price_minor,prior.nfc_issue_price_minor,prior.billing_unit,prior.features,auth.uid()) returning id into new_id;
 insert into public.petro_audit_events(actor_id,action,target_id,detail)
 values(auth.uid(),'plan.price_version_created',new_id,jsonb_build_object('plan_id',p_plan_id,'price_minor',p_annual_price_minor));
 return new_id;
end $$;


--
-- Name: petro_revoke_invitation(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.petro_revoke_invitation(p_invitation_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
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


--
-- Name: petro_set_account_status(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.petro_set_account_status(p_user_id uuid, p_status text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
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


--
-- Name: petro_set_branch_status(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.petro_set_branch_status(p_organization_id uuid, p_branch_id uuid, p_status text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
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


--
-- Name: petro_set_membership(uuid, uuid, text, text, uuid[], boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.petro_set_membership(p_organization_id uuid, p_user_id uuid, p_role text, p_scope text, p_branch_ids uuid[] DEFAULT '{}'::uuid[], p_active boolean DEFAULT true) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
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


--
-- Name: petro_set_organization_status(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.petro_set_organization_status(p_organization_id uuid, p_status text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare old_status text;
begin
 if not petro_private.platform_has(array['owner','operations']) then
  raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if p_status is null or p_status not in ('pending','active','suspended') then
  raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 select status into old_status from public.petro_organizations where id=p_organization_id for update;
 if not found then raise exception 'NOT_FOUND' using errcode='22023'; end if;
 update public.petro_organizations set status=p_status where id=p_organization_id;
 insert into public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
 values(auth.uid(),p_organization_id,'organization.status_changed',p_organization_id,
   jsonb_build_object('before',old_status,'after',p_status));
end $$;


--
-- Name: petro_update_branch(uuid, uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.petro_update_branch(p_organization_id uuid, p_branch_id uuid, p_name text, p_address text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
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


--
-- Name: petro_update_organization(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.petro_update_organization(p_organization_id uuid, p_name text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
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


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: petro_auth_signin_limits; Type: TABLE; Schema: petro_private; Owner: -
--

CREATE TABLE petro_private.petro_auth_signin_limits (
    bucket_key text NOT NULL,
    attempt_count integer NOT NULL,
    window_started_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT petro_auth_signin_limits_attempt_count_check CHECK (((attempt_count >= 1) AND (attempt_count <= 100))),
    CONSTRAINT petro_auth_signin_limits_bucket_key_check CHECK ((bucket_key ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: TABLE petro_auth_signin_limits; Type: COMMENT; Schema: petro_private; Owner: -
--

COMMENT ON TABLE petro_private.petro_auth_signin_limits IS 'Stores HMAC-only per-IP-and-identifier sign-in attempt buckets; never store raw IPs or identifiers.';


--
-- Name: petro_audit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.petro_audit_events (
    id bigint NOT NULL,
    actor_id uuid NOT NULL,
    organization_id uuid,
    action text NOT NULL,
    target_id uuid,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: petro_audit_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.petro_audit_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petro_audit_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: petro_branches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.petro_branches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    address text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT petro_branches_name_check CHECK (((char_length(TRIM(BOTH FROM name)) >= 2) AND (char_length(TRIM(BOTH FROM name)) <= 160))),
    CONSTRAINT petro_branches_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'suspended'::text])))
);


--
-- Name: petro_membership_branches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.petro_membership_branches (
    organization_id uuid NOT NULL,
    membership_id uuid NOT NULL,
    branch_id uuid NOT NULL
);


--
-- Name: petro_membership_invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.petro_membership_invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    invited_email text NOT NULL,
    role text NOT NULL,
    scope text NOT NULL,
    branch_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    token_hash text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    accepted_by uuid,
    accepted_at timestamp with time zone,
    revoked_at timestamp with time zone,
    CONSTRAINT petro_membership_invites_email_normalized CHECK ((invited_email = lower(btrim(invited_email)))),
    CONSTRAINT petro_membership_invites_role_check CHECK ((role = ANY (ARRAY['organization_owner'::text, 'manager'::text, 'finance'::text, 'worker'::text, 'viewer'::text]))),
    CONSTRAINT petro_membership_invites_scope_check CHECK ((scope = ANY (ARRAY['organization'::text, 'branches'::text]))),
    CONSTRAINT petro_membership_invites_token_hash_check CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: petro_memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.petro_memberships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    role text NOT NULL,
    scope text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    CONSTRAINT branch_worker_scope CHECK (((role <> 'worker'::text) OR (scope = 'branches'::text))),
    CONSTRAINT petro_memberships_role_check CHECK ((role = ANY (ARRAY['organization_owner'::text, 'manager'::text, 'finance'::text, 'worker'::text, 'viewer'::text]))),
    CONSTRAINT petro_memberships_scope_check CHECK ((scope = ANY (ARRAY['organization'::text, 'branches'::text])))
);


--
-- Name: petro_organizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.petro_organizations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    country_code text DEFAULT 'EG'::text NOT NULL,
    currency text DEFAULT 'EGP'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT petro_organizations_country_code_check CHECK ((country_code = 'EG'::text)),
    CONSTRAINT petro_organizations_currency_check CHECK ((currency = 'EGP'::text)),
    CONSTRAINT petro_organizations_kind_check CHECK ((kind = ANY (ARRAY['company'::text, 'station'::text, 'provider'::text]))),
    CONSTRAINT petro_organizations_name_check CHECK (((char_length(TRIM(BOTH FROM name)) >= 2) AND (char_length(TRIM(BOTH FROM name)) <= 160))),
    CONSTRAINT petro_organizations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'suspended'::text])))
);


--
-- Name: petro_plan_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.petro_plan_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    plan_id uuid NOT NULL,
    version integer NOT NULL,
    annual_price_minor bigint NOT NULL,
    nfc_issue_price_minor bigint DEFAULT 10000 NOT NULL,
    billing_unit text NOT NULL,
    features text[] DEFAULT '{}'::text[] NOT NULL,
    effective_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT petro_plan_versions_annual_price_minor_check CHECK (((annual_price_minor >= 0) AND (annual_price_minor <= 1000000000))),
    CONSTRAINT petro_plan_versions_billing_unit_check CHECK ((billing_unit = ANY (ARRAY['vehicle'::text, 'branch'::text]))),
    CONSTRAINT petro_plan_versions_nfc_issue_price_minor_check CHECK ((nfc_issue_price_minor >= 0)),
    CONSTRAINT petro_plan_versions_version_check CHECK ((version > 0))
);


--
-- Name: petro_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.petro_plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    audience text NOT NULL,
    name text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    CONSTRAINT petro_plans_audience_check CHECK ((audience = ANY (ARRAY['company'::text, 'provider'::text])))
);


--
-- Name: petro_platform_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.petro_platform_roles (
    user_id uuid NOT NULL,
    role text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    CONSTRAINT petro_platform_roles_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'operations'::text, 'finance'::text, 'support'::text, 'auditor'::text])))
);


--
-- Name: petro_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.petro_profiles (
    user_id uuid NOT NULL,
    display_name text DEFAULT ''::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    username text NOT NULL,
    login_identifier_type text DEFAULT 'username'::text NOT NULL,
    account_status text,
    CONSTRAINT petro_profiles_account_status CHECK (((account_status IS NULL) OR (account_status = ANY (ARRAY['pending'::text, 'active'::text, 'suspended'::text])))),
    CONSTRAINT petro_profiles_login_identifier_type CHECK ((login_identifier_type = 'username'::text)),
    CONSTRAINT petro_profiles_username_format CHECK (((username IS NULL) OR ((username = lower(username)) AND (username ~ '^[a-z0-9][a-z0-9_.-]{2,31}$'::text))))
);


--
-- Name: petro_auth_signin_limits petro_auth_signin_limits_pkey; Type: CONSTRAINT; Schema: petro_private; Owner: -
--

ALTER TABLE ONLY petro_private.petro_auth_signin_limits
    ADD CONSTRAINT petro_auth_signin_limits_pkey PRIMARY KEY (bucket_key);


--
-- Name: petro_audit_events petro_audit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.petro_audit_events
    ADD CONSTRAINT petro_audit_events_pkey PRIMARY KEY (id);


--
-- Name: petro_branches petro_branches_organization_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.petro_branches
    ADD CONSTRAINT petro_branches_organization_id_id_key UNIQUE (organization_id, id);


--
-- Name: petro_branches petro_branches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.petro_branches
    ADD CONSTRAINT petro_branches_pkey PRIMARY KEY (id);


--
-- Name: petro_membership_branches petro_membership_branches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.petro_membership_branches
    ADD CONSTRAINT petro_membership_branches_pkey PRIMARY KEY (membership_id, branch_id);


--
-- Name: petro_membership_invites petro_membership_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.petro_membership_invites
    ADD CONSTRAINT petro_membership_invites_pkey PRIMARY KEY (id);


--
-- Name: petro_membership_invites petro_membership_invites_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.petro_membership_invites
    ADD CONSTRAINT petro_membership_invites_token_hash_key UNIQUE (token_hash);


--
-- Name: petro_memberships petro_memberships_organization_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.petro_memberships
    ADD CONSTRAINT petro_memberships_organization_id_id_key UNIQUE (organization_id, id);


--
-- Name: petro_memberships petro_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.petro_memberships
    ADD CONSTRAINT petro_memberships_pkey PRIMARY KEY (id);


--
-- Name: petro_memberships petro_memberships_user_id_organization_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.petro_memberships
    ADD CONSTRAINT petro_memberships_user_id_organization_id_key UNIQUE (user_id, organization_id);


--
-- Name: petro_organizations petro_organizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.petro_organizations
    ADD CONSTRAINT petro_organizations_pkey PRIMARY KEY (id);


--
-- Name: petro_plan_versions petro_plan_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.petro_plan_versions
    ADD CONSTRAINT petro_plan_versions_pkey PRIMARY KEY (id);


--
-- Name: petro_plan_versions petro_plan_versions_plan_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.petro_plan_versions
    ADD CONSTRAINT petro_plan_versions_plan_id_version_key UNIQUE (plan_id, version);


--
-- Name: petro_plans petro_plans_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.petro_plans
    ADD CONSTRAINT petro_plans_code_key UNIQUE (code);


--
-- Name: petro_plans petro_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.petro_plans
    ADD CONSTRAINT petro_plans_pkey PRIMARY KEY (id);


--
-- Name: petro_platform_roles petro_platform_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.petro_platform_roles
    ADD CONSTRAINT petro_platform_roles_pkey PRIMARY KEY (user_id, role);


--
-- Name: petro_profiles petro_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.petro_profiles
    ADD CONSTRAINT petro_profiles_pkey PRIMARY KEY (user_id);


--
-- Name: petro_auth_signin_limits_updated_at_idx; Type: INDEX; Schema: petro_private; Owner: -
--

CREATE INDEX petro_auth_signin_limits_updated_at_idx ON petro_private.petro_auth_signin_limits USING btree (updated_at);


--
-- Name: petro_audit_org_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX petro_audit_org_time_idx ON public.petro_audit_events USING btree (organization_id, occurred_at DESC);


--
-- Name: petro_branches_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX petro_branches_org_idx ON public.petro_branches USING btree (organization_id);


--
-- Name: petro_memberships_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX petro_memberships_user_idx ON public.petro_memberships USING btree (user_id) WHERE active;


--
-- Name: petro_profiles_username_ci_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX petro_profiles_username_ci_unique ON public.petro_profiles USING btree (lower(username)) WHERE (username IS NOT NULL);


--
-- Name: petro_audit_events petro_audit_events_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.petro_audit_events
    ADD CONSTRAINT petro_audit_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: petro_audit_events petro_audit_events_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.petro_audit_events
    ADD CONSTRAINT petro_audit_events_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.petro_organizations(id) ON DELETE RESTRICT;


--
-- Name: petro_branches petro_branches_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.petro_branches
    ADD CONSTRAINT petro_branches_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.petro_organizations(id) ON DELETE RESTRICT;


--
-- Name: petro_membership_branches petro_membership_branches_organization_id_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.petro_membership_branches
    ADD CONSTRAINT petro_membership_branches_organization_id_branch_id_fkey FOREIGN KEY (organization_id, branch_id) REFERENCES public.petro_branches(organization_id, id) ON DELETE RESTRICT;


--
-- Name: petro_membership_branches petro_membership_branches_organization_id_membership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.petro_membership_branches
    ADD CONSTRAINT petro_membership_branches_organization_id_membership_id_fkey FOREIGN KEY (organization_id, membership_id) REFERENCES public.petro_memberships(organization_id, id) ON DELETE RESTRICT;


--
-- Name: petro_membership_invites petro_membership_invites_accepted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.petro_membership_invites
    ADD CONSTRAINT petro_membership_invites_accepted_by_fkey FOREIGN KEY (accepted_by) REFERENCES auth.users(id);


--
-- Name: petro_membership_invites petro_membership_invites_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.petro_membership_invites
    ADD CONSTRAINT petro_membership_invites_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: petro_membership_invites petro_membership_invites_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.petro_membership_invites
    ADD CONSTRAINT petro_membership_invites_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.petro_organizations(id) ON DELETE CASCADE;


--
-- Name: petro_memberships petro_memberships_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.petro_memberships
    ADD CONSTRAINT petro_memberships_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.petro_organizations(id) ON DELETE RESTRICT;


--
-- Name: petro_memberships petro_memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.petro_memberships
    ADD CONSTRAINT petro_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: petro_organizations petro_organizations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.petro_organizations
    ADD CONSTRAINT petro_organizations_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: petro_plan_versions petro_plan_versions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.petro_plan_versions
    ADD CONSTRAINT petro_plan_versions_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: petro_plan_versions petro_plan_versions_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.petro_plan_versions
    ADD CONSTRAINT petro_plan_versions_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.petro_plans(id) ON DELETE RESTRICT;


--
-- Name: petro_platform_roles petro_platform_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.petro_platform_roles
    ADD CONSTRAINT petro_platform_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: petro_profiles petro_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.petro_profiles
    ADD CONSTRAINT petro_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: petro_auth_signin_limits; Type: ROW SECURITY; Schema: petro_private; Owner: -
--

ALTER TABLE petro_private.petro_auth_signin_limits ENABLE ROW LEVEL SECURITY;

--
-- Name: petro_audit_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.petro_audit_events ENABLE ROW LEVEL SECURITY;

--
-- Name: petro_audit_events petro_audit_events_org_manager_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY petro_audit_events_org_manager_read ON public.petro_audit_events FOR SELECT TO authenticated USING ((petro_private.user_active() AND (organization_id IS NOT NULL) AND petro_private.can_manage_org(organization_id)));


--
-- Name: petro_audit_events petro_audit_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY petro_audit_read ON public.petro_audit_events FOR SELECT TO authenticated USING (petro_private.platform_has(ARRAY['owner'::text, 'auditor'::text]));


--
-- Name: petro_branches petro_branch_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY petro_branch_read ON public.petro_branches FOR SELECT TO authenticated USING (petro_private.can_read_branch(organization_id, id));


--
-- Name: petro_branches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.petro_branches ENABLE ROW LEVEL SECURITY;

--
-- Name: petro_membership_branches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.petro_membership_branches ENABLE ROW LEVEL SECURITY;

--
-- Name: petro_membership_branches petro_membership_branches_scoped_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY petro_membership_branches_scoped_read ON public.petro_membership_branches FOR SELECT TO authenticated USING ((petro_private.user_active() AND (EXISTS ( SELECT 1
   FROM public.petro_memberships m
  WHERE ((m.id = petro_membership_branches.membership_id) AND (m.organization_id = petro_membership_branches.organization_id) AND ((m.user_id = auth.uid()) OR petro_private.can_manage_org(petro_membership_branches.organization_id) OR petro_private.can_read_branch(petro_membership_branches.organization_id, petro_membership_branches.branch_id)))))));


--
-- Name: petro_membership_invites; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.petro_membership_invites ENABLE ROW LEVEL SECURITY;

--
-- Name: petro_memberships petro_membership_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY petro_membership_read ON public.petro_memberships FOR SELECT TO authenticated USING ((petro_private.user_active() AND ((user_id = auth.uid()) OR petro_private.platform_has(ARRAY['owner'::text, 'operations'::text]))));


--
-- Name: petro_memberships; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.petro_memberships ENABLE ROW LEVEL SECURITY;

--
-- Name: petro_memberships petro_memberships_manager_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY petro_memberships_manager_read ON public.petro_memberships FOR SELECT TO authenticated USING (((user_id = auth.uid()) OR (petro_private.user_active() AND (petro_private.can_manage_org(organization_id) OR petro_private.can_view_membership(id)))));


--
-- Name: petro_organizations petro_org_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY petro_org_read ON public.petro_organizations FOR SELECT TO authenticated USING (petro_private.can_read_org(id));


--
-- Name: petro_organizations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.petro_organizations ENABLE ROW LEVEL SECURITY;

--
-- Name: petro_plans petro_plan_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY petro_plan_read ON public.petro_plans FOR SELECT TO authenticated USING ((petro_private.user_active() AND (active OR petro_private.platform_has(ARRAY['owner'::text]))));


--
-- Name: petro_plan_versions petro_plan_version_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY petro_plan_version_read ON public.petro_plan_versions FOR SELECT TO authenticated USING ((petro_private.user_active() AND (EXISTS ( SELECT 1
   FROM public.petro_plans p
  WHERE (p.id = petro_plan_versions.plan_id)))));


--
-- Name: petro_plan_versions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.petro_plan_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: petro_plans; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.petro_plans ENABLE ROW LEVEL SECURITY;

--
-- Name: petro_platform_roles petro_platform_role_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY petro_platform_role_read ON public.petro_platform_roles FOR SELECT TO authenticated USING (((user_id = auth.uid()) AND petro_private.user_active()));


--
-- Name: petro_platform_roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.petro_platform_roles ENABLE ROW LEVEL SECURITY;

--
-- Name: petro_profiles petro_profile_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY petro_profile_read ON public.petro_profiles FOR SELECT TO authenticated USING (((user_id = auth.uid()) OR petro_private.platform_has(ARRAY['owner'::text, 'operations'::text])));


--
-- Name: petro_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.petro_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: petro_profiles petro_profiles_manager_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY petro_profiles_manager_read ON public.petro_profiles FOR SELECT TO authenticated USING (petro_private.can_view_profile(user_id));


--
-- Name: SCHEMA petro_private; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA petro_private TO authenticated;


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION can_manage_branch(p_organization_id uuid, p_branch_id uuid); Type: ACL; Schema: petro_private; Owner: -
--

GRANT ALL ON FUNCTION petro_private.can_manage_branch(p_organization_id uuid, p_branch_id uuid) TO authenticated;


--
-- Name: FUNCTION can_manage_org(p_org uuid); Type: ACL; Schema: petro_private; Owner: -
--

REVOKE ALL ON FUNCTION petro_private.can_manage_org(p_org uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION petro_private.can_manage_org(p_org uuid) TO authenticated;


--
-- Name: FUNCTION can_read_branch(p_org uuid, p_branch uuid); Type: ACL; Schema: petro_private; Owner: -
--

REVOKE ALL ON FUNCTION petro_private.can_read_branch(p_org uuid, p_branch uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION petro_private.can_read_branch(p_org uuid, p_branch uuid) TO authenticated;


--
-- Name: FUNCTION can_read_org(p_org uuid); Type: ACL; Schema: petro_private; Owner: -
--

REVOKE ALL ON FUNCTION petro_private.can_read_org(p_org uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION petro_private.can_read_org(p_org uuid) TO authenticated;


--
-- Name: FUNCTION can_view_membership(p_membership_id uuid); Type: ACL; Schema: petro_private; Owner: -
--

GRANT ALL ON FUNCTION petro_private.can_view_membership(p_membership_id uuid) TO authenticated;


--
-- Name: FUNCTION can_view_profile(p_user_id uuid); Type: ACL; Schema: petro_private; Owner: -
--

GRANT ALL ON FUNCTION petro_private.can_view_profile(p_user_id uuid) TO authenticated;


--
-- Name: FUNCTION handle_auth_user(); Type: ACL; Schema: petro_private; Owner: -
--

REVOKE ALL ON FUNCTION petro_private.handle_auth_user() FROM PUBLIC;


--
-- Name: FUNCTION platform_has(p_roles text[]); Type: ACL; Schema: petro_private; Owner: -
--

REVOKE ALL ON FUNCTION petro_private.platform_has(p_roles text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION petro_private.platform_has(p_roles text[]) TO authenticated;


--
-- Name: FUNCTION user_active(); Type: ACL; Schema: petro_private; Owner: -
--

REVOKE ALL ON FUNCTION petro_private.user_active() FROM PUBLIC;
GRANT ALL ON FUNCTION petro_private.user_active() TO authenticated;


--
-- Name: FUNCTION petro_accept_invitation(p_token_hash text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.petro_accept_invitation(p_token_hash text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.petro_accept_invitation(p_token_hash text) TO authenticated;
GRANT ALL ON FUNCTION public.petro_accept_invitation(p_token_hash text) TO service_role;


--
-- Name: FUNCTION petro_access_context(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.petro_access_context() FROM PUBLIC;
GRANT ALL ON FUNCTION public.petro_access_context() TO authenticated;
GRANT ALL ON FUNCTION public.petro_access_context() TO service_role;


--
-- Name: FUNCTION petro_create_branch(p_organization_id uuid, p_name text, p_address text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.petro_create_branch(p_organization_id uuid, p_name text, p_address text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.petro_create_branch(p_organization_id uuid, p_name text, p_address text) TO authenticated;
GRANT ALL ON FUNCTION public.petro_create_branch(p_organization_id uuid, p_name text, p_address text) TO service_role;


--
-- Name: FUNCTION petro_create_invitation(p_organization_id uuid, p_email text, p_role text, p_scope text, p_branch_ids uuid[], p_token_hash text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.petro_create_invitation(p_organization_id uuid, p_email text, p_role text, p_scope text, p_branch_ids uuid[], p_token_hash text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.petro_create_invitation(p_organization_id uuid, p_email text, p_role text, p_scope text, p_branch_ids uuid[], p_token_hash text) TO authenticated;
GRANT ALL ON FUNCTION public.petro_create_invitation(p_organization_id uuid, p_email text, p_role text, p_scope text, p_branch_ids uuid[], p_token_hash text) TO service_role;


--
-- Name: FUNCTION petro_create_organization(p_name text, p_kind text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.petro_create_organization(p_name text, p_kind text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.petro_create_organization(p_name text, p_kind text) TO authenticated;
GRANT ALL ON FUNCTION public.petro_create_organization(p_name text, p_kind text) TO service_role;


--
-- Name: FUNCTION petro_list_invitations(p_organization_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.petro_list_invitations(p_organization_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.petro_list_invitations(p_organization_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.petro_list_invitations(p_organization_id uuid) TO service_role;


--
-- Name: FUNCTION petro_publish_plan_price(p_plan_id uuid, p_annual_price_minor bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.petro_publish_plan_price(p_plan_id uuid, p_annual_price_minor bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.petro_publish_plan_price(p_plan_id uuid, p_annual_price_minor bigint) TO authenticated;
GRANT ALL ON FUNCTION public.petro_publish_plan_price(p_plan_id uuid, p_annual_price_minor bigint) TO service_role;


--
-- Name: FUNCTION petro_revoke_invitation(p_invitation_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.petro_revoke_invitation(p_invitation_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.petro_revoke_invitation(p_invitation_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.petro_revoke_invitation(p_invitation_id uuid) TO service_role;


--
-- Name: FUNCTION petro_set_account_status(p_user_id uuid, p_status text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.petro_set_account_status(p_user_id uuid, p_status text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.petro_set_account_status(p_user_id uuid, p_status text) TO authenticated;
GRANT ALL ON FUNCTION public.petro_set_account_status(p_user_id uuid, p_status text) TO service_role;


--
-- Name: FUNCTION petro_set_branch_status(p_organization_id uuid, p_branch_id uuid, p_status text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.petro_set_branch_status(p_organization_id uuid, p_branch_id uuid, p_status text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.petro_set_branch_status(p_organization_id uuid, p_branch_id uuid, p_status text) TO authenticated;
GRANT ALL ON FUNCTION public.petro_set_branch_status(p_organization_id uuid, p_branch_id uuid, p_status text) TO service_role;


--
-- Name: FUNCTION petro_set_membership(p_organization_id uuid, p_user_id uuid, p_role text, p_scope text, p_branch_ids uuid[], p_active boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.petro_set_membership(p_organization_id uuid, p_user_id uuid, p_role text, p_scope text, p_branch_ids uuid[], p_active boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.petro_set_membership(p_organization_id uuid, p_user_id uuid, p_role text, p_scope text, p_branch_ids uuid[], p_active boolean) TO authenticated;
GRANT ALL ON FUNCTION public.petro_set_membership(p_organization_id uuid, p_user_id uuid, p_role text, p_scope text, p_branch_ids uuid[], p_active boolean) TO service_role;


--
-- Name: FUNCTION petro_set_organization_status(p_organization_id uuid, p_status text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.petro_set_organization_status(p_organization_id uuid, p_status text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.petro_set_organization_status(p_organization_id uuid, p_status text) TO authenticated;
GRANT ALL ON FUNCTION public.petro_set_organization_status(p_organization_id uuid, p_status text) TO service_role;


--
-- Name: FUNCTION petro_update_branch(p_organization_id uuid, p_branch_id uuid, p_name text, p_address text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.petro_update_branch(p_organization_id uuid, p_branch_id uuid, p_name text, p_address text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.petro_update_branch(p_organization_id uuid, p_branch_id uuid, p_name text, p_address text) TO authenticated;
GRANT ALL ON FUNCTION public.petro_update_branch(p_organization_id uuid, p_branch_id uuid, p_name text, p_address text) TO service_role;


--
-- Name: FUNCTION petro_update_organization(p_organization_id uuid, p_name text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.petro_update_organization(p_organization_id uuid, p_name text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.petro_update_organization(p_organization_id uuid, p_name text) TO authenticated;
GRANT ALL ON FUNCTION public.petro_update_organization(p_organization_id uuid, p_name text) TO service_role;


--
-- Name: TABLE petro_audit_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.petro_audit_events TO service_role;
GRANT SELECT ON TABLE public.petro_audit_events TO authenticated;


--
-- Name: SEQUENCE petro_audit_events_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.petro_audit_events_id_seq TO anon;
GRANT ALL ON SEQUENCE public.petro_audit_events_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.petro_audit_events_id_seq TO service_role;


--
-- Name: TABLE petro_branches; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.petro_branches TO service_role;
GRANT SELECT ON TABLE public.petro_branches TO authenticated;


--
-- Name: TABLE petro_membership_branches; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.petro_membership_branches TO service_role;
GRANT SELECT ON TABLE public.petro_membership_branches TO authenticated;


--
-- Name: TABLE petro_membership_invites; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.petro_membership_invites TO anon;
GRANT ALL ON TABLE public.petro_membership_invites TO authenticated;
GRANT ALL ON TABLE public.petro_membership_invites TO service_role;


--
-- Name: TABLE petro_memberships; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.petro_memberships TO service_role;
GRANT SELECT ON TABLE public.petro_memberships TO authenticated;


--
-- Name: TABLE petro_organizations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.petro_organizations TO service_role;
GRANT SELECT ON TABLE public.petro_organizations TO authenticated;


--
-- Name: TABLE petro_plan_versions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.petro_plan_versions TO service_role;
GRANT SELECT ON TABLE public.petro_plan_versions TO authenticated;


--
-- Name: TABLE petro_plans; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.petro_plans TO service_role;
GRANT SELECT ON TABLE public.petro_plans TO authenticated;


--
-- Name: TABLE petro_platform_roles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.petro_platform_roles TO service_role;
GRANT SELECT ON TABLE public.petro_platform_roles TO authenticated;


--
-- Name: TABLE petro_profiles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.petro_profiles TO service_role;
GRANT SELECT ON TABLE public.petro_profiles TO authenticated;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- PostgreSQL database dump complete
--

