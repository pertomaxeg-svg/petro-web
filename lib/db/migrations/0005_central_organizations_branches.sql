-- Forward-only, additive migration for the existing Pertomax organization model.
-- It does not run or record migrations 0001-0004. 0004 must already be applied;
-- the preflight below checks its live RPC fingerprints and invite-table grants.
-- Keep this transaction atomic. Do not deploy by running the full migration folder.
BEGIN;

DO $preflight$
DECLARE
  v_hash text;
BEGIN
  IF to_regclass('public.petro_organizations') IS NULL
     OR to_regclass('public.petro_branches') IS NULL
     OR to_regclass('public.petro_membership_invites') IS NULL THEN
    RAISE EXCEPTION 'CENTRAL_ORGS_PREFLIGHT: expected Pertomax tables are missing';
  END IF;

  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g'))
    INTO v_hash
    FROM pg_proc p
   WHERE p.oid = 'public.petro_set_membership(uuid,uuid,text,text,uuid[],boolean)'::regprocedure;
  IF v_hash IS DISTINCT FROM '194fdfaefb42e0190cabcf1ec7c018f7' THEN
    RAISE EXCEPTION 'CENTRAL_ORGS_PREFLIGHT: DB-02 membership RPC fingerprint differs';
  END IF;

  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g'))
    INTO v_hash
    FROM pg_proc p
   WHERE p.oid = 'public.petro_create_invitation(uuid,text,text,text,uuid[],text)'::regprocedure;
  IF v_hash IS DISTINCT FROM 'aaac469f056271aae583f7c4fbf18620' THEN
    RAISE EXCEPTION 'CENTRAL_ORGS_PREFLIGHT: DB-02 invitation RPC fingerprint differs';
  END IF;

  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g'))
    INTO v_hash
    FROM pg_proc p
   WHERE p.oid = 'public.petro_accept_invitation(text)'::regprocedure;
  IF v_hash IS DISTINCT FROM '32b9f605068e3496dad9b7b1d7f18569' THEN
    RAISE EXCEPTION 'CENTRAL_ORGS_PREFLIGHT: DB-02 acceptance RPC fingerprint differs';
  END IF;

  IF has_table_privilege('anon', 'public.petro_membership_invites', 'SELECT')
     OR has_table_privilege('anon', 'public.petro_membership_invites', 'INSERT')
     OR has_table_privilege('anon', 'public.petro_membership_invites', 'UPDATE')
     OR has_table_privilege('anon', 'public.petro_membership_invites', 'DELETE')
     OR has_table_privilege('authenticated', 'public.petro_membership_invites', 'SELECT')
     OR has_table_privilege('authenticated', 'public.petro_membership_invites', 'INSERT')
     OR has_table_privilege('authenticated', 'public.petro_membership_invites', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.petro_membership_invites', 'DELETE') THEN
    RAISE EXCEPTION 'CENTRAL_ORGS_PREFLIGHT: invitation table grants differ from DB-02';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.petro_organizations'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.petro_branches'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.petro_membership_invites'::regclass) THEN
    RAISE EXCEPTION 'CENTRAL_ORGS_PREFLIGHT: expected RLS is not enabled';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name IN ('petro_organizations', 'petro_branches')
       AND column_name IN ('approval_status', 'operational_status', 'version', 'code')
  ) THEN
    RAISE EXCEPTION 'CENTRAL_ORGS_PREFLIGHT: 0005 columns already exist; inspect, do not replay';
  END IF;
END;
$preflight$;

ALTER TABLE public.petro_organizations
  ADD COLUMN code text,
  ADD COLUMN legal_name text,
  ADD COLUMN contact_name text,
  ADD COLUMN contact_phone text,
  ADD COLUMN contact_email text,
  ADD COLUMN address text NOT NULL DEFAULT '',
  ADD COLUMN approval_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN operational_status text NOT NULL DEFAULT 'inactive',
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN version bigint NOT NULL DEFAULT 1;

ALTER TABLE public.petro_branches
  ADD COLUMN code text,
  ADD COLUMN governorate text,
  ADD COLUMN latitude numeric(9,6),
  ADD COLUMN longitude numeric(9,6),
  ADD COLUMN hours jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN contact_name text,
  ADD COLUMN contact_phone text,
  ADD COLUMN approval_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN operational_status text NOT NULL DEFAULT 'inactive',
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN version bigint NOT NULL DEFAULT 1;

-- Preserve existing combined-state rows and translate them into the new independent states.
UPDATE public.petro_organizations
   SET approval_status = CASE WHEN status IN ('active', 'suspended') THEN 'approved' ELSE 'pending' END,
       operational_status = CASE status WHEN 'active' THEN 'active' WHEN 'suspended' THEN 'suspended' ELSE 'inactive' END;

UPDATE public.petro_branches
   SET approval_status = CASE WHEN status IN ('active', 'suspended') THEN 'approved' ELSE 'pending' END,
       operational_status = CASE status WHEN 'active' THEN 'active' WHEN 'suspended' THEN 'suspended' ELSE 'inactive' END;

ALTER TABLE public.petro_organizations
  ADD CONSTRAINT petro_organizations_code_format_ck
    CHECK (code IS NULL OR (code = upper(btrim(code)) AND code ~ '^[A-Z0-9_-]{2,40}$')),
  ADD CONSTRAINT petro_organizations_legal_name_ck
    CHECK (legal_name IS NULL OR char_length(btrim(legal_name)) BETWEEN 2 AND 200),
  ADD CONSTRAINT petro_organizations_contact_name_ck
    CHECK (contact_name IS NULL OR char_length(btrim(contact_name)) BETWEEN 2 AND 160),
  ADD CONSTRAINT petro_organizations_contact_phone_ck
    CHECK (contact_phone IS NULL OR (char_length(contact_phone) BETWEEN 5 AND 24 AND contact_phone ~ '^[+0-9 ()-]+$')),
  ADD CONSTRAINT petro_organizations_contact_email_ck
    CHECK (contact_email IS NULL OR (char_length(contact_email) <= 320 AND contact_email = lower(btrim(contact_email)) AND position('@' in contact_email) > 1)),
  ADD CONSTRAINT petro_organizations_address_ck
    CHECK (char_length(address) <= 500),
  ADD CONSTRAINT petro_organizations_approval_status_ck
    CHECK (approval_status IN ('pending', 'approved')),
  ADD CONSTRAINT petro_organizations_operational_status_ck
    CHECK (operational_status IN ('inactive', 'active', 'suspended')),
  ADD CONSTRAINT petro_organizations_status_consistency_ck
    CHECK (
      (approval_status = 'approved' OR operational_status = 'inactive')
      AND (
        (operational_status = 'inactive' AND status = 'pending')
        OR (operational_status = 'active' AND status = 'active')
        OR (operational_status = 'suspended' AND status = 'suspended')
      )
    ),
  ADD CONSTRAINT petro_organizations_version_ck CHECK (version > 0);

ALTER TABLE public.petro_branches
  ADD CONSTRAINT petro_branches_code_format_ck
    CHECK (code IS NULL OR (code = upper(btrim(code)) AND code ~ '^[A-Z0-9_-]{2,40}$')),
  ADD CONSTRAINT petro_branches_governorate_ck
    CHECK (governorate IS NULL OR char_length(btrim(governorate)) BETWEEN 2 AND 100),
  ADD CONSTRAINT petro_branches_address_ck CHECK (char_length(address) <= 500),
  ADD CONSTRAINT petro_branches_coordinates_pair_ck
    CHECK (
      (latitude IS NULL AND longitude IS NULL)
      OR (latitude IS NOT NULL AND longitude IS NOT NULL
          AND latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)
    ),
  ADD CONSTRAINT petro_branches_hours_object_ck
    CHECK (jsonb_typeof(hours) = 'object'),
  ADD CONSTRAINT petro_branches_contact_name_ck
    CHECK (contact_name IS NULL OR char_length(btrim(contact_name)) BETWEEN 2 AND 160),
  ADD CONSTRAINT petro_branches_contact_phone_ck
    CHECK (contact_phone IS NULL OR (char_length(contact_phone) BETWEEN 5 AND 24 AND contact_phone ~ '^[+0-9 ()-]+$')),
  ADD CONSTRAINT petro_branches_approval_status_ck
    CHECK (approval_status IN ('pending', 'approved')),
  ADD CONSTRAINT petro_branches_operational_status_ck
    CHECK (operational_status IN ('inactive', 'active', 'suspended')),
  ADD CONSTRAINT petro_branches_status_consistency_ck
    CHECK (
      (approval_status = 'approved' OR operational_status = 'inactive')
      AND (
        (operational_status = 'inactive' AND status = 'pending')
        OR (operational_status = 'active' AND status = 'active')
        OR (operational_status = 'suspended' AND status = 'suspended')
      )
    ),
  ADD CONSTRAINT petro_branches_version_ck CHECK (version > 0);

CREATE UNIQUE INDEX petro_organizations_code_uq
  ON public.petro_organizations (upper(code))
  WHERE code IS NOT NULL;
CREATE UNIQUE INDEX petro_branches_organization_code_uq
  ON public.petro_branches (organization_id, upper(code))
  WHERE code IS NOT NULL;

CREATE FUNCTION petro_private.petro_valid_branch_hours(p_hours jsonb) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE
  SET search_path TO ''
AS $$
DECLARE
  day_key text;
  day_value jsonb;
  open_time text;
  close_time text;
BEGIN
  IF p_hours IS NULL OR jsonb_typeof(p_hours) <> 'object' THEN
    RETURN false;
  END IF;

  FOR day_key, day_value IN SELECT key, value FROM jsonb_each(p_hours) LOOP
    IF day_key NOT IN ('sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat')
       OR jsonb_typeof(day_value) <> 'object'
       OR NOT (day_value ? 'closed')
       OR jsonb_typeof(day_value -> 'closed') <> 'boolean' THEN
      RETURN false;
    END IF;

    IF (day_value ->> 'closed')::boolean THEN
      IF day_value ? 'open' OR day_value ? 'close' THEN
        RETURN false;
      END IF;
    ELSE
      open_time := day_value ->> 'open';
      close_time := day_value ->> 'close';
      IF open_time IS NULL OR close_time IS NULL
         OR open_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         OR close_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
        RETURN false;
      END IF;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION petro_private.petro_valid_branch_hours(jsonb) FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE public.petro_branches
  ADD CONSTRAINT petro_branches_hours_valid_ck
  CHECK (petro_private.petro_valid_branch_hours(hours));

CREATE FUNCTION public.petro_create_organization_details(
  p_name text, p_kind text, p_code text, p_legal_name text,
  p_contact_name text, p_contact_phone text, p_contact_email text, p_address text
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO ''
AS $$
DECLARE
  new_id uuid;
  normalized_code text := upper(btrim(coalesce(p_code, '')));
  normalized_email text := nullif(lower(btrim(p_contact_email)), '');
BEGIN
  IF auth.uid() IS NULL OR NOT petro_private.user_active()
     OR NOT petro_private.platform_has(ARRAY['owner', 'operations']::text[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_name IS NULL OR char_length(btrim(p_name)) NOT BETWEEN 2 AND 160
     OR p_kind NOT IN ('company', 'station', 'provider')
     OR normalized_code !~ '^[A-Z0-9_-]{2,40}$'
     OR (nullif(btrim(p_legal_name), '') IS NOT NULL AND char_length(btrim(p_legal_name)) < 2)
     OR (nullif(btrim(p_contact_name), '') IS NOT NULL AND char_length(btrim(p_contact_name)) < 2)
     OR (nullif(btrim(p_contact_phone), '') IS NOT NULL AND char_length(btrim(p_contact_phone)) < 5)
     OR char_length(coalesce(p_legal_name, '')) > 200
     OR char_length(coalesce(p_contact_name, '')) > 160
     OR char_length(coalesce(p_contact_phone, '')) > 24
     OR char_length(coalesce(normalized_email, '')) > 320
     OR (normalized_email IS NOT NULL AND position('@' in normalized_email) < 2)
     OR char_length(coalesce(p_address, '')) > 500 THEN
    RAISE EXCEPTION 'INVALID_INPUT' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.petro_organizations
    (name, kind, code, legal_name, contact_name, contact_phone, contact_email, address,
     status, approval_status, operational_status, created_by)
  VALUES
    (btrim(p_name), p_kind, normalized_code, nullif(btrim(p_legal_name), ''),
     nullif(btrim(p_contact_name), ''), nullif(btrim(p_contact_phone), ''),
     normalized_email, coalesce(p_address, ''), 'pending', 'pending', 'inactive', auth.uid())
  RETURNING id INTO new_id;

  INSERT INTO public.petro_audit_events(actor_id, organization_id, action, target_id, detail)
  VALUES (auth.uid(), new_id, 'organization.created', new_id,
          jsonb_build_object('kind', p_kind, 'code', normalized_code, 'approval_status', 'pending'));
  RETURN new_id;
END;
$$;

CREATE FUNCTION public.petro_update_organization_details(
  p_organization_id uuid, p_expected_version bigint, p_name text, p_kind text,
  p_code text, p_legal_name text, p_contact_name text, p_contact_phone text,
  p_contact_email text, p_address text, p_reason text
) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  old_row public.petro_organizations%ROWTYPE;
  normalized_code text := upper(btrim(coalesce(p_code, '')));
  normalized_email text := nullif(lower(btrim(p_contact_email)), '');
  changed_fields text[];
BEGIN
  IF actor_id IS NULL OR NOT petro_private.user_active()
     OR NOT petro_private.can_manage_org(p_organization_id) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 1 THEN
    RAISE EXCEPTION 'INVALID_VERSION' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO old_row FROM public.petro_organizations
   WHERE id = p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF old_row.version <> p_expected_version THEN
    RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE = '40001';
  END IF;
  IF p_name IS NULL OR char_length(btrim(p_name)) NOT BETWEEN 2 AND 160
     OR p_kind NOT IN ('company', 'station', 'provider')
     OR normalized_code !~ '^[A-Z0-9_-]{2,40}$'
     OR (nullif(btrim(p_legal_name), '') IS NOT NULL AND char_length(btrim(p_legal_name)) < 2)
     OR (nullif(btrim(p_contact_name), '') IS NOT NULL AND char_length(btrim(p_contact_name)) < 2)
     OR (nullif(btrim(p_contact_phone), '') IS NOT NULL AND char_length(btrim(p_contact_phone)) < 5)
     OR char_length(coalesce(p_legal_name, '')) > 200
     OR char_length(coalesce(p_contact_name, '')) > 160
     OR char_length(coalesce(p_contact_phone, '')) > 24
     OR char_length(coalesce(normalized_email, '')) > 320
     OR (normalized_email IS NOT NULL AND position('@' in normalized_email) < 2)
     OR char_length(coalesce(p_address, '')) > 500
     OR (p_reason IS NOT NULL AND char_length(btrim(p_reason)) NOT BETWEEN 5 AND 500) THEN
    RAISE EXCEPTION 'INVALID_INPUT' USING ERRCODE = '22023';
  END IF;

  changed_fields := array_remove(ARRAY[
    CASE WHEN old_row.name IS DISTINCT FROM btrim(p_name) THEN 'name' END,
    CASE WHEN old_row.kind IS DISTINCT FROM p_kind THEN 'kind' END,
    CASE WHEN old_row.code IS DISTINCT FROM normalized_code THEN 'code' END,
    CASE WHEN old_row.legal_name IS DISTINCT FROM nullif(btrim(p_legal_name), '') THEN 'legal_name' END,
    CASE WHEN old_row.contact_name IS DISTINCT FROM nullif(btrim(p_contact_name), '') THEN 'contact_name' END,
    CASE WHEN old_row.contact_phone IS DISTINCT FROM nullif(btrim(p_contact_phone), '') THEN 'contact_phone' END,
    CASE WHEN old_row.contact_email IS DISTINCT FROM normalized_email THEN 'contact_email' END,
    CASE WHEN old_row.address IS DISTINCT FROM coalesce(p_address, '') THEN 'address' END
  ], NULL);
  IF cardinality(changed_fields) = 0 THEN
    RAISE EXCEPTION 'NO_CHANGES' USING ERRCODE = '22023';
  END IF;

  UPDATE public.petro_organizations
     SET name = btrim(p_name), kind = p_kind, code = normalized_code,
         legal_name = nullif(btrim(p_legal_name), ''),
         contact_name = nullif(btrim(p_contact_name), ''),
         contact_phone = nullif(btrim(p_contact_phone), ''),
         contact_email = normalized_email, address = coalesce(p_address, ''),
         version = version + 1, updated_at = now()
   WHERE id = p_organization_id;

  INSERT INTO public.petro_audit_events(actor_id, organization_id, action, target_id, detail)
  VALUES (actor_id, p_organization_id, 'organization.updated', p_organization_id,
          jsonb_build_object('changed_fields', changed_fields, 'reason', nullif(btrim(p_reason), '')));
END;
$$;

CREATE FUNCTION public.petro_approve_organization(
  p_organization_id uuid, p_expected_version bigint, p_reason text
) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO ''
AS $$
DECLARE
  old_row public.petro_organizations%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT petro_private.user_active()
     OR NOT petro_private.platform_has(ARRAY['owner', 'operations']::text[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 1 THEN
    RAISE EXCEPTION 'INVALID_VERSION' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'INVALID_REASON' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO old_row FROM public.petro_organizations
   WHERE id = p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF old_row.version <> p_expected_version THEN
    RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE = '40001';
  END IF;
  IF old_row.approval_status <> 'pending' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION' USING ERRCODE = '22023';
  END IF;

  UPDATE public.petro_organizations
     SET approval_status = 'approved', version = version + 1, updated_at = now()
   WHERE id = p_organization_id;
  INSERT INTO public.petro_audit_events(actor_id, organization_id, action, target_id, detail)
  VALUES (auth.uid(), p_organization_id, 'organization.approved', p_organization_id,
          jsonb_build_object('approval_before', old_row.approval_status,
                             'approval_after', 'approved',
                             'operational_status', old_row.operational_status,
                             'reason', btrim(p_reason)));
END;
$$;

CREATE FUNCTION public.petro_set_organization_operational_status(
  p_organization_id uuid, p_expected_version bigint, p_operational_status text, p_reason text
) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO ''
AS $$
DECLARE
  old_row public.petro_organizations%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT petro_private.user_active()
     OR NOT petro_private.platform_has(ARRAY['owner', 'operations']::text[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 1 THEN
    RAISE EXCEPTION 'INVALID_VERSION' USING ERRCODE = '22023';
  END IF;
  IF p_operational_status NOT IN ('active', 'suspended')
     OR p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'INVALID_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO old_row FROM public.petro_organizations
   WHERE id = p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF old_row.version <> p_expected_version THEN
    RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE = '40001';
  END IF;
  IF old_row.approval_status <> 'approved'
     OR old_row.operational_status = p_operational_status THEN
    RAISE EXCEPTION 'INVALID_TRANSITION' USING ERRCODE = '22023';
  END IF;

  UPDATE public.petro_organizations
     SET operational_status = p_operational_status,
         status = p_operational_status,
         version = version + 1, updated_at = now()
   WHERE id = p_organization_id;
  INSERT INTO public.petro_audit_events(actor_id, organization_id, action, target_id, detail)
  VALUES (auth.uid(), p_organization_id, 'organization.operational_status_changed', p_organization_id,
          jsonb_build_object('before', old_row.operational_status,
                             'after', p_operational_status, 'reason', btrim(p_reason)));
END;
$$;

CREATE FUNCTION public.petro_create_branch_details(
  p_organization_id uuid, p_code text, p_name text, p_address text,
  p_governorate text, p_latitude numeric, p_longitude numeric, p_hours jsonb,
  p_contact_name text, p_contact_phone text
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO ''
AS $$
DECLARE
  new_id uuid;
  normalized_code text := upper(btrim(coalesce(p_code, '')));
BEGIN
  IF auth.uid() IS NULL OR NOT petro_private.user_active()
     OR NOT petro_private.can_manage_org(p_organization_id) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_name IS NULL OR char_length(btrim(p_name)) NOT BETWEEN 2 AND 160
     OR normalized_code !~ '^[A-Z0-9_-]{2,40}$'
     OR char_length(coalesce(p_address, '')) > 500
     OR char_length(coalesce(p_governorate, '')) > 100
     OR (nullif(btrim(p_governorate), '') IS NOT NULL AND char_length(btrim(p_governorate)) < 2)
     OR ((p_latitude IS NULL) <> (p_longitude IS NULL))
     OR (p_latitude IS NOT NULL AND p_latitude NOT BETWEEN -90 AND 90)
     OR (p_longitude IS NOT NULL AND p_longitude NOT BETWEEN -180 AND 180)
     OR NOT petro_private.petro_valid_branch_hours(coalesce(p_hours, '{}'::jsonb))
     OR char_length(coalesce(p_contact_name, '')) > 160
     OR (nullif(btrim(p_contact_name), '') IS NOT NULL AND char_length(btrim(p_contact_name)) < 2)
     OR char_length(coalesce(p_contact_phone, '')) > 24
     OR (nullif(btrim(p_contact_phone), '') IS NOT NULL AND char_length(btrim(p_contact_phone)) < 5) THEN
    RAISE EXCEPTION 'INVALID_INPUT' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.petro_branches
    (organization_id, code, name, address, governorate, latitude, longitude, hours,
     contact_name, contact_phone, status, approval_status, operational_status)
  VALUES
    (p_organization_id, normalized_code, btrim(p_name), coalesce(p_address, ''),
     nullif(btrim(p_governorate), ''), p_latitude, p_longitude,
     coalesce(p_hours, '{}'::jsonb), nullif(btrim(p_contact_name), ''),
     nullif(btrim(p_contact_phone), ''), 'pending', 'pending', 'inactive')
  RETURNING id INTO new_id;

  INSERT INTO public.petro_audit_events(actor_id, organization_id, action, target_id, detail)
  VALUES (auth.uid(), p_organization_id, 'branch.created', new_id,
          jsonb_build_object('code', normalized_code, 'approval_status', 'pending'));
  RETURN new_id;
END;
$$;

CREATE FUNCTION public.petro_update_branch_details(
  p_organization_id uuid, p_branch_id uuid, p_expected_version bigint,
  p_code text, p_name text, p_address text, p_governorate text,
  p_latitude numeric, p_longitude numeric, p_hours jsonb,
  p_contact_name text, p_contact_phone text, p_reason text
) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  old_row public.petro_branches%ROWTYPE;
  normalized_code text := upper(btrim(coalesce(p_code, '')));
  changed_fields text[];
BEGIN
  IF actor_id IS NULL OR NOT petro_private.user_active()
     OR NOT petro_private.can_manage_org(p_organization_id) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 1 THEN
    RAISE EXCEPTION 'INVALID_VERSION' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO old_row FROM public.petro_branches
   WHERE id = p_branch_id AND organization_id = p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF old_row.version <> p_expected_version THEN
    RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE = '40001';
  END IF;
  IF p_name IS NULL OR char_length(btrim(p_name)) NOT BETWEEN 2 AND 160
     OR normalized_code !~ '^[A-Z0-9_-]{2,40}$'
     OR char_length(coalesce(p_address, '')) > 500
     OR char_length(coalesce(p_governorate, '')) > 100
     OR (nullif(btrim(p_governorate), '') IS NOT NULL AND char_length(btrim(p_governorate)) < 2)
     OR ((p_latitude IS NULL) <> (p_longitude IS NULL))
     OR (p_latitude IS NOT NULL AND p_latitude NOT BETWEEN -90 AND 90)
     OR (p_longitude IS NOT NULL AND p_longitude NOT BETWEEN -180 AND 180)
     OR NOT petro_private.petro_valid_branch_hours(coalesce(p_hours, '{}'::jsonb))
     OR char_length(coalesce(p_contact_name, '')) > 160
     OR (nullif(btrim(p_contact_name), '') IS NOT NULL AND char_length(btrim(p_contact_name)) < 2)
     OR char_length(coalesce(p_contact_phone, '')) > 24
     OR (nullif(btrim(p_contact_phone), '') IS NOT NULL AND char_length(btrim(p_contact_phone)) < 5)
     OR (p_reason IS NOT NULL AND char_length(btrim(p_reason)) NOT BETWEEN 5 AND 500) THEN
    RAISE EXCEPTION 'INVALID_INPUT' USING ERRCODE = '22023';
  END IF;

  changed_fields := array_remove(ARRAY[
    CASE WHEN old_row.code IS DISTINCT FROM normalized_code THEN 'code' END,
    CASE WHEN old_row.name IS DISTINCT FROM btrim(p_name) THEN 'name' END,
    CASE WHEN old_row.address IS DISTINCT FROM coalesce(p_address, '') THEN 'address' END,
    CASE WHEN old_row.governorate IS DISTINCT FROM nullif(btrim(p_governorate), '') THEN 'governorate' END,
    CASE WHEN old_row.latitude IS DISTINCT FROM p_latitude THEN 'latitude' END,
    CASE WHEN old_row.longitude IS DISTINCT FROM p_longitude THEN 'longitude' END,
    CASE WHEN old_row.hours IS DISTINCT FROM coalesce(p_hours, '{}'::jsonb) THEN 'hours' END,
    CASE WHEN old_row.contact_name IS DISTINCT FROM nullif(btrim(p_contact_name), '') THEN 'contact_name' END,
    CASE WHEN old_row.contact_phone IS DISTINCT FROM nullif(btrim(p_contact_phone), '') THEN 'contact_phone' END
  ], NULL);
  IF cardinality(changed_fields) = 0 THEN
    RAISE EXCEPTION 'NO_CHANGES' USING ERRCODE = '22023';
  END IF;

  UPDATE public.petro_branches
     SET code = normalized_code, name = btrim(p_name), address = coalesce(p_address, ''),
         governorate = nullif(btrim(p_governorate), ''), latitude = p_latitude,
         longitude = p_longitude, hours = coalesce(p_hours, '{}'::jsonb),
         contact_name = nullif(btrim(p_contact_name), ''),
         contact_phone = nullif(btrim(p_contact_phone), ''),
         version = version + 1, updated_at = now()
   WHERE id = p_branch_id AND organization_id = p_organization_id;

  INSERT INTO public.petro_audit_events(actor_id, organization_id, action, target_id, detail)
  VALUES (actor_id, p_organization_id, 'branch.updated', p_branch_id,
          jsonb_build_object('changed_fields', changed_fields, 'reason', nullif(btrim(p_reason), '')));
END;
$$;

CREATE FUNCTION public.petro_approve_branch(
  p_organization_id uuid, p_branch_id uuid, p_expected_version bigint, p_reason text
) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO ''
AS $$
DECLARE
  old_row public.petro_branches%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT petro_private.user_active()
     OR NOT petro_private.platform_has(ARRAY['owner', 'operations']::text[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 1 THEN
    RAISE EXCEPTION 'INVALID_VERSION' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'INVALID_REASON' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO old_row FROM public.petro_branches
   WHERE id = p_branch_id AND organization_id = p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF old_row.version <> p_expected_version THEN
    RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE = '40001';
  END IF;
  IF old_row.approval_status <> 'pending' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION' USING ERRCODE = '22023';
  END IF;

  UPDATE public.petro_branches
     SET approval_status = 'approved', version = version + 1, updated_at = now()
   WHERE id = p_branch_id AND organization_id = p_organization_id;
  INSERT INTO public.petro_audit_events(actor_id, organization_id, action, target_id, detail)
  VALUES (auth.uid(), p_organization_id, 'branch.approved', p_branch_id,
          jsonb_build_object('approval_before', old_row.approval_status,
                             'approval_after', 'approved',
                             'operational_status', old_row.operational_status,
                             'reason', btrim(p_reason)));
END;
$$;

CREATE FUNCTION public.petro_set_branch_operational_status(
  p_organization_id uuid, p_branch_id uuid, p_expected_version bigint,
  p_operational_status text, p_reason text
) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO ''
AS $$
DECLARE
  old_row public.petro_branches%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT petro_private.user_active()
     OR NOT petro_private.can_manage_org(p_organization_id) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 1 THEN
    RAISE EXCEPTION 'INVALID_VERSION' USING ERRCODE = '22023';
  END IF;
  IF p_operational_status NOT IN ('active', 'suspended')
     OR p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'INVALID_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO old_row FROM public.petro_branches
   WHERE id = p_branch_id AND organization_id = p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF old_row.version <> p_expected_version THEN
    RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE = '40001';
  END IF;
  IF old_row.approval_status <> 'approved'
     OR old_row.operational_status = p_operational_status THEN
    RAISE EXCEPTION 'INVALID_TRANSITION' USING ERRCODE = '22023';
  END IF;

  UPDATE public.petro_branches
     SET operational_status = p_operational_status, status = p_operational_status,
         version = version + 1, updated_at = now()
   WHERE id = p_branch_id AND organization_id = p_organization_id;
  INSERT INTO public.petro_audit_events(actor_id, organization_id, action, target_id, detail)
  VALUES (auth.uid(), p_organization_id, 'branch.operational_status_changed', p_branch_id,
          jsonb_build_object('before', old_row.operational_status,
                             'after', p_operational_status, 'reason', btrim(p_reason)));
END;
$$;

-- Retire old combined-state write RPCs so callers cannot bypass new versions,
-- approval separation, audit reasons, or parent-organization checks.
REVOKE ALL ON FUNCTION public.petro_create_organization(text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.petro_update_organization(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.petro_set_organization_status(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.petro_create_branch(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.petro_update_branch(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.petro_set_branch_status(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.petro_create_organization_details(text,text,text,text,text,text,text,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.petro_update_organization_details(uuid,bigint,text,text,text,text,text,text,text,text,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.petro_approve_organization(uuid,bigint,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.petro_set_organization_operational_status(uuid,bigint,text,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.petro_create_branch_details(uuid,text,text,text,text,numeric,numeric,jsonb,text,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.petro_update_branch_details(uuid,uuid,bigint,text,text,text,text,numeric,numeric,jsonb,text,text,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.petro_approve_branch(uuid,uuid,bigint,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.petro_set_branch_operational_status(uuid,uuid,bigint,text,text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.petro_create_organization_details(text,text,text,text,text,text,text,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.petro_update_organization_details(uuid,bigint,text,text,text,text,text,text,text,text,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.petro_approve_organization(uuid,bigint,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.petro_set_organization_operational_status(uuid,bigint,text,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.petro_create_branch_details(uuid,text,text,text,text,numeric,numeric,jsonb,text,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.petro_update_branch_details(uuid,uuid,bigint,text,text,text,text,numeric,numeric,jsonb,text,text,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.petro_approve_branch(uuid,uuid,bigint,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.petro_set_branch_operational_status(uuid,uuid,bigint,text,text) TO authenticated, service_role;

COMMIT;
