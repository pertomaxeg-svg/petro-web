-- Forward-only, project-scoped workflow expansion for organizations.
-- Do not apply to any Supabase project other than msvgzsfzrqlrfpstthhe.
-- This migration intentionally does not alter migration history, global ACLs,
-- existing organization/branch rows, or policies outside the named resources.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regclass('public.petro_organizations') IS NULL
     OR to_regclass('public.petro_branches') IS NULL
     OR to_regclass('public.petro_memberships') IS NULL
     OR to_regclass('public.petro_profiles') IS NULL
     OR to_regclass('public.petro_audit_events') IS NULL
     OR to_regclass('storage.buckets') IS NULL
     OR to_regclass('storage.objects') IS NULL THEN
    RAISE EXCEPTION 'ORG_WORKFLOWS_PREFLIGHT: expected Supabase and 0005 resources are missing';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='storage.objects'::regclass) THEN
    RAISE EXCEPTION 'ORG_WORKFLOWS_PREFLIGHT: storage.objects RLS is not enabled';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='petro_organizations'
        AND column_name IN ('code','version')) <> 2
     OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='petro_branches'
      AND column_name='version'
  ) THEN
    RAISE EXCEPTION 'ORG_WORKFLOWS_PREFLIGHT: organization schema differs from approved 0005';
  END IF;
  IF to_regclass('public.petro_org_join_requests') IS NOT NULL
     OR to_regclass('public.petro_org_change_requests') IS NOT NULL
     OR to_regclass('public.petro_bank_accounts') IS NOT NULL
     OR to_regclass('public.petro_bank_account_versions') IS NOT NULL
     OR to_regclass('public.petro_documents') IS NOT NULL
      OR EXISTS (SELECT 1 FROM storage.buckets WHERE id='petro-private-documents')
      OR to_regprocedure('public.petro_review_bank_account_version(uuid,bigint,text,text,bigint)') IS NOT NULL
      OR to_regprocedure('petro_private.can_access_private_document(text,text)') IS NOT NULL
      OR EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname IN (
          'petro_private_documents_select','petro_private_documents_insert','petro_private_documents_delete_pending',
          'petro_documents_read','petro_org_join_requests_read','petro_org_change_requests_read',
          'petro_bank_account_read','petro_bank_version_read'
        )
      ) THEN
    RAISE EXCEPTION 'ORG_WORKFLOWS_PREFLIGHT: a target resource already exists; inspect before proceeding';
  END IF;
END
$preflight$;

CREATE FUNCTION petro_private.can_review_org_requests() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
AS $$
  SELECT petro_private.user_active()
     AND petro_private.platform_has(ARRAY['owner','operations']::text[])
$$;

CREATE FUNCTION petro_private.can_manage_bank(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
AS $$
  SELECT petro_private.user_active() AND (
    petro_private.platform_has(ARRAY['owner','finance']::text[])
    OR EXISTS (
      SELECT 1 FROM public.petro_memberships m
      JOIN public.petro_organizations o ON o.id=m.organization_id
      WHERE m.organization_id=p_org AND m.user_id=auth.uid() AND m.active
        AND m.scope='organization' AND m.role IN ('organization_owner','finance')
        AND o.approval_status='approved'
    )
  )
$$;

CREATE TABLE public.petro_org_join_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  organization_data jsonb NOT NULL,
  initial_branch_data jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','needs_completion','rejected','approved','withdrawn')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  decision_reason text,
  approved_organization_id uuid REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  approved_branch_id uuid,
  CHECK (jsonb_typeof(organization_data)='object'),
  CHECK (jsonb_typeof(initial_branch_data)='object'),
  CHECK ((status='approved')=(approved_organization_id IS NOT NULL))
);
CREATE UNIQUE INDEX petro_org_join_one_open_per_applicant
  ON public.petro_org_join_requests(applicant_id)
  WHERE status IN ('draft','submitted','needs_completion');
CREATE INDEX petro_org_join_queue_idx
  ON public.petro_org_join_requests(status,created_at DESC,id);
CREATE INDEX petro_org_join_applicant_idx
  ON public.petro_org_join_requests(applicant_id,created_at DESC);

CREATE TABLE public.petro_org_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  branch_id uuid,
  target_type text NOT NULL CHECK (target_type IN ('organization','branch')),
  applicant_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  expected_entity_version bigint NOT NULL CHECK (expected_entity_version > 0),
  current_snapshot jsonb NOT NULL CHECK (jsonb_typeof(current_snapshot)='object'),
  proposed_data jsonb NOT NULL CHECK (jsonb_typeof(proposed_data)='object'),
  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','needs_completion','approved','rejected','withdrawn','conflict')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  decision_reason text,
  CHECK ((target_type='branch')=(branch_id IS NOT NULL)),
  FOREIGN KEY (branch_id,organization_id)
    REFERENCES public.petro_branches(id,organization_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX petro_org_change_one_open_target
  ON public.petro_org_change_requests(target_type,organization_id,coalesce(branch_id,'00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status IN ('submitted','needs_completion');
CREATE INDEX petro_org_change_queue_idx
  ON public.petro_org_change_requests(status,created_at DESC,id);
CREATE INDEX petro_org_change_org_idx
  ON public.petro_org_change_requests(organization_id,created_at DESC);

CREATE TABLE public.petro_bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','archived')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,organization_id)
);
CREATE INDEX petro_bank_accounts_org_idx
  ON public.petro_bank_accounts(organization_id,status,created_at DESC);

CREATE TABLE public.petro_bank_account_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  bank_name text NOT NULL CHECK (char_length(btrim(bank_name)) BETWEEN 2 AND 120),
  beneficiary_name text NOT NULL CHECK (char_length(btrim(beneficiary_name)) BETWEEN 2 AND 160),
  account_identifier text NOT NULL CHECK (char_length(regexp_replace(account_identifier,'[[:space:]-]','','g')) BETWEEN 5 AND 34),
  account_last4 text NOT NULL CHECK (account_last4 ~ '^[A-Za-z0-9]{4}$'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','needs_completion','approved','superseded','rejected','withdrawn','conflict')),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  decision_reason text,
  FOREIGN KEY (bank_account_id,organization_id)
    REFERENCES public.petro_bank_accounts(id,organization_id) ON DELETE RESTRICT,
  UNIQUE (bank_account_id,version),
  UNIQUE (id,organization_id)
);
CREATE UNIQUE INDEX petro_bank_one_pending_version
  ON public.petro_bank_account_versions(bank_account_id)
  WHERE status IN ('pending','needs_completion');
CREATE INDEX petro_bank_review_queue_idx
  ON public.petro_bank_account_versions(status,created_at DESC,id);
CREATE INDEX petro_bank_org_idx
  ON public.petro_bank_account_versions(organization_id,created_at DESC);

CREATE TABLE public.petro_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  uploader_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  organization_id uuid REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  branch_id uuid,
  join_request_id uuid REFERENCES public.petro_org_join_requests(id) ON DELETE RESTRICT,
  change_request_id uuid REFERENCES public.petro_org_change_requests(id) ON DELETE RESTRICT,
  bank_account_version_id uuid REFERENCES public.petro_bank_account_versions(id) ON DELETE RESTRICT,
  document_type text NOT NULL CHECK (char_length(btrim(document_type)) BETWEEN 2 AND 80),
  file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 160),
  content_type text NOT NULL CHECK (content_type IN ('application/pdf','image/png','image/jpeg')),
  byte_size bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  storage_path text NOT NULL UNIQUE,
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  expires_on date,
  status text NOT NULL DEFAULT 'pending_upload'
    CHECK (status IN ('pending_upload','attached','pending_review','approved','needs_completion','rejected','upload_failed')),
  upload_expires_at timestamptz NOT NULL DEFAULT (now()+interval '20 minutes'),
  uploaded_at timestamptz,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  review_reason text,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (branch_id IS NULL OR organization_id IS NOT NULL),
  CHECK (
    join_request_id IS NOT NULL OR change_request_id IS NOT NULL
    OR bank_account_version_id IS NOT NULL OR organization_id IS NOT NULL
  ),
  FOREIGN KEY (branch_id,organization_id)
    REFERENCES public.petro_branches(id,organization_id) ON DELETE RESTRICT
);
CREATE INDEX petro_documents_org_idx
  ON public.petro_documents(organization_id,branch_id,status,created_at DESC);
CREATE INDEX petro_documents_join_idx
  ON public.petro_documents(join_request_id,created_at DESC);
CREATE INDEX petro_documents_change_idx
  ON public.petro_documents(change_request_id,created_at DESC);
CREATE INDEX petro_documents_review_idx
  ON public.petro_documents(status,created_at DESC);

INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES (
  'petro-private-documents',
  'petro-private-documents',
  false,
  10485760,
  ARRAY['application/pdf','image/png','image/jpeg']::text[]
);

CREATE FUNCTION petro_private.valid_join_payload(p_org jsonb,p_branch jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path TO ''
AS $$
DECLARE
  lat_text text := p_branch->>'latitude';
  lon_text text := p_branch->>'longitude';
BEGIN
  IF jsonb_typeof(p_org) IS DISTINCT FROM 'object' OR jsonb_typeof(p_branch) IS DISTINCT FROM 'object'
     OR char_length(btrim(coalesce(p_org->>'name',''))) NOT BETWEEN 2 AND 160
     OR coalesce(p_org->>'kind','') NOT IN ('company','station','provider')
     OR upper(btrim(coalesce(p_org->>'code',''))) !~ '^[A-Z0-9_-]{2,40}$'
     OR char_length(coalesce(p_org->>'address','')) > 500
     OR char_length(coalesce(p_org->>'legalName','')) > 200
     OR (nullif(btrim(p_org->>'legalName'),'') IS NOT NULL AND char_length(btrim(p_org->>'legalName')) < 2)
     OR char_length(coalesce(p_org->>'contactName','')) > 160
     OR (nullif(btrim(p_org->>'contactName'),'') IS NOT NULL AND char_length(btrim(p_org->>'contactName')) < 2)
     OR char_length(coalesce(p_org->>'contactPhone','')) > 24
     OR (nullif(btrim(p_org->>'contactPhone'),'') IS NOT NULL AND char_length(btrim(p_org->>'contactPhone')) < 5)
     OR char_length(coalesce(p_org->>'contactEmail','')) > 320
     OR (nullif(btrim(p_org->>'contactEmail'),'') IS NOT NULL
       AND btrim(p_org->>'contactEmail') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
     OR char_length(btrim(coalesce(p_branch->>'name',''))) NOT BETWEEN 2 AND 160
     OR upper(btrim(coalesce(p_branch->>'code',''))) !~ '^[A-Z0-9_-]{2,40}$'
     OR char_length(coalesce(p_branch->>'address','')) > 500
     OR char_length(coalesce(p_branch->>'governorate','')) > 100
     OR char_length(coalesce(p_branch->>'contactName','')) > 160
     OR (nullif(btrim(p_branch->>'contactName'),'') IS NOT NULL AND char_length(btrim(p_branch->>'contactName')) < 2)
     OR char_length(coalesce(p_branch->>'contactPhone','')) > 24
     OR (nullif(btrim(p_branch->>'contactPhone'),'') IS NOT NULL AND char_length(btrim(p_branch->>'contactPhone')) < 5)
     OR NOT petro_private.petro_valid_branch_hours(coalesce(p_branch->'hours','{}'::jsonb))
     OR ((lat_text IS NULL) <> (lon_text IS NULL)) THEN
    RETURN false;
  END IF;
  IF lat_text IS NOT NULL THEN
    IF lat_text !~ '^-?[0-9]+(\.[0-9]+)?$' OR lon_text !~ '^-?[0-9]+(\.[0-9]+)?$'
       OR lat_text::numeric NOT BETWEEN -90 AND 90
       OR lon_text::numeric NOT BETWEEN -180 AND 180 THEN
      RETURN false;
    END IF;
  END IF;
  RETURN true;
EXCEPTION WHEN others THEN
  RETURN false;
END
$$;

CREATE FUNCTION petro_private.valid_org_change_data(p_data jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path TO ''
AS $$
BEGIN
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' OR p_data='{}'::jsonb
    OR p_data-'name'-'kind'-'code'-'legalName'-'address'<>'{}'::jsonb THEN RETURN false; END IF;
  IF (p_data ? 'name' AND char_length(btrim(coalesce(p_data->>'name',''))) NOT BETWEEN 2 AND 160)
    OR (p_data ? 'kind' AND coalesce(p_data->>'kind','') NOT IN ('company','station','provider'))
    OR (p_data ? 'code' AND upper(btrim(coalesce(p_data->>'code',''))) !~ '^[A-Z0-9_-]{2,40}$')
    OR (p_data ? 'legalName' AND p_data->>'legalName' IS NOT NULL
        AND char_length(btrim(p_data->>'legalName')) NOT BETWEEN 2 AND 200)
    OR (p_data ? 'address' AND char_length(coalesce(p_data->>'address',''))>500) THEN RETURN false; END IF;
  RETURN true;
END
$$;

CREATE FUNCTION petro_private.valid_branch_change_data(p_data jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path TO ''
AS $$
DECLARE value_text text;
BEGIN
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' OR p_data='{}'::jsonb
    OR p_data-'code'-'name'-'address'-'governorate'-'latitude'-'longitude'<>'{}'::jsonb THEN RETURN false; END IF;
  IF (p_data ? 'code' AND upper(btrim(coalesce(p_data->>'code',''))) !~ '^[A-Z0-9_-]{2,40}$')
    OR (p_data ? 'name' AND char_length(btrim(coalesce(p_data->>'name',''))) NOT BETWEEN 2 AND 160)
    OR (p_data ? 'address' AND char_length(coalesce(p_data->>'address',''))>500)
    OR (p_data ? 'governorate' AND char_length(coalesce(p_data->>'governorate',''))>100) THEN RETURN false; END IF;
  FOREACH value_text IN ARRAY ARRAY[p_data->>'latitude',p_data->>'longitude'] LOOP
    IF value_text IS NOT NULL AND value_text !~ '^-?[0-9]+(\.[0-9]+)?$' THEN RETURN false; END IF;
  END LOOP;
  IF p_data ? 'latitude' AND p_data->>'latitude' IS NOT NULL AND (p_data->>'latitude')::numeric NOT BETWEEN -90 AND 90 THEN RETURN false; END IF;
  IF p_data ? 'longitude' AND p_data->>'longitude' IS NOT NULL AND (p_data->>'longitude')::numeric NOT BETWEEN -180 AND 180 THEN RETURN false; END IF;
  RETURN true;
EXCEPTION WHEN others THEN RETURN false;
END
$$;

CREATE FUNCTION public.petro_create_org_join_request(
  p_applicant_id uuid,p_organization_data jsonb,p_initial_branch_data jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE actor uuid := auth.uid(); target uuid := coalesce(p_applicant_id,auth.uid()); new_id uuid;
BEGIN
  IF actor IS NULL OR NOT petro_private.user_active() THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF target<>actor AND NOT petro_private.can_review_org_requests() THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF NOT petro_private.valid_join_payload(p_organization_data,p_initial_branch_data)
     OR NOT EXISTS (
       SELECT 1 FROM auth.users u JOIN public.petro_profiles p ON p.user_id=u.id
       WHERE u.id=target AND u.email_confirmed_at IS NOT NULL
         AND p.active AND p.account_status='active'
     )
     OR EXISTS (SELECT 1 FROM public.petro_memberships m WHERE m.user_id=target AND m.active) THEN
    RAISE EXCEPTION 'INVALID_OR_INELIGIBLE_APPLICANT' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.petro_org_join_requests(applicant_id,created_by,organization_data,initial_branch_data)
  VALUES (target,actor,p_organization_data,p_initial_branch_data) RETURNING id INTO new_id;
  INSERT INTO public.petro_audit_events(actor_id,action,target_id,detail)
  VALUES (actor,'organization.join_request.created',new_id,
          jsonb_build_object('applicant_id',target,'created_for_other_user',target<>actor));
  RETURN new_id;
END
$$;

CREATE FUNCTION public.petro_update_org_join_request(
  p_request_id uuid,p_expected_version bigint,p_organization_data jsonb,p_initial_branch_data jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE r public.petro_org_join_requests%ROWTYPE; actor uuid := auth.uid();
BEGIN
  SELECT * INTO r FROM public.petro_org_join_requests WHERE id=p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF actor<>r.applicant_id AND NOT petro_private.can_review_org_requests() THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF r.version<>p_expected_version THEN RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE='40001'; END IF;
  IF r.status NOT IN ('draft','needs_completion') OR
     NOT petro_private.valid_join_payload(p_organization_data,p_initial_branch_data) THEN
    RAISE EXCEPTION 'INVALID_REQUEST_STATE_OR_DATA' USING ERRCODE='22023';
  END IF;
  UPDATE public.petro_org_join_requests SET organization_data=p_organization_data,
    initial_branch_data=p_initial_branch_data,status='draft',version=version+1,updated_at=now()
    WHERE id=p_request_id;
  INSERT INTO public.petro_audit_events(actor_id,action,target_id,detail)
  VALUES (actor,'organization.join_request.updated',p_request_id,jsonb_build_object('version',p_expected_version+1));
END
$$;

CREATE FUNCTION public.petro_submit_org_join_request(p_request_id uuid,p_expected_version bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE r public.petro_org_join_requests%ROWTYPE; actor uuid := auth.uid();
BEGIN
  SELECT * INTO r FROM public.petro_org_join_requests WHERE id=p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF actor<>r.applicant_id AND NOT petro_private.can_review_org_requests() THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF r.version<>p_expected_version THEN RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE='40001'; END IF;
  IF r.status NOT IN ('draft','needs_completion')
     OR NOT petro_private.valid_join_payload(r.organization_data,r.initial_branch_data)
     OR NOT EXISTS (SELECT 1 FROM auth.users u JOIN public.petro_profiles p ON p.user_id=u.id
       WHERE u.id=r.applicant_id AND u.email_confirmed_at IS NOT NULL AND p.active AND p.account_status='active')
     OR EXISTS (SELECT 1 FROM public.petro_memberships m WHERE m.user_id=r.applicant_id AND m.active) THEN
    RAISE EXCEPTION 'REQUEST_NOT_SUBMITTABLE' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.petro_documents d WHERE d.join_request_id=p_request_id AND d.status='pending_upload') THEN
    RAISE EXCEPTION 'DOCUMENT_UPLOAD_INCOMPLETE' USING ERRCODE='55000';
  END IF;
  UPDATE public.petro_org_join_requests SET status='submitted',submitted_at=now(),
    version=version+1,updated_at=now() WHERE id=p_request_id;
  UPDATE public.petro_documents SET status='pending_review',version=version+1
    WHERE join_request_id=p_request_id AND status='attached';
  INSERT INTO public.petro_audit_events(actor_id,action,target_id,detail)
  VALUES(actor,'organization.join_request.submitted',p_request_id,jsonb_build_object('version',p_expected_version+1));
END
$$;

CREATE FUNCTION public.petro_withdraw_org_join_request(p_request_id uuid,p_expected_version bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE r public.petro_org_join_requests%ROWTYPE; actor uuid := auth.uid();
BEGIN
  SELECT * INTO r FROM public.petro_org_join_requests WHERE id=p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF actor<>r.applicant_id AND NOT petro_private.can_review_org_requests() THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF r.version<>p_expected_version THEN RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE='40001'; END IF;
  IF r.status NOT IN ('draft','submitted','needs_completion') THEN RAISE EXCEPTION 'REQUEST_ALREADY_DECIDED' USING ERRCODE='55000'; END IF;
  UPDATE public.petro_org_join_requests SET status='withdrawn',version=version+1,updated_at=now(),
    reviewed_by=actor,reviewed_at=now(),decision_reason='سحب قبل القرار'
    WHERE id=p_request_id;
  INSERT INTO public.petro_audit_events(actor_id,action,target_id,detail)
  VALUES(actor,'organization.join_request.withdrawn',p_request_id,'{}'::jsonb);
END
$$;

CREATE FUNCTION public.petro_review_org_join_request(
  p_request_id uuid,p_expected_version bigint,p_action text,p_reason text,
  p_link_organization_id uuid DEFAULT NULL,p_link_branch_id uuid DEFAULT NULL,p_link_role text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE
  r public.petro_org_join_requests%ROWTYPE; actor uuid := auth.uid();
  org_id uuid; result_branch_id uuid; od jsonb; bd jsonb; member_role text;
BEGIN
  IF actor IS NULL OR NOT petro_private.can_review_org_requests()
     OR p_action NOT IN ('approve','reject','needs_completion')
     OR char_length(btrim(coalesce(p_reason,''))) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'FORBIDDEN_OR_INVALID_DECISION' USING ERRCODE='42501';
  END IF;
  SELECT * INTO r FROM public.petro_org_join_requests WHERE id=p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF r.version<>p_expected_version THEN RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE='40001'; END IF;
  IF r.status<>'submitted' THEN RAISE EXCEPTION 'REQUEST_ALREADY_DECIDED_OR_NOT_SUBMITTED' USING ERRCODE='55000'; END IF;

  IF p_action='approve' THEN
    IF EXISTS (SELECT 1 FROM public.petro_memberships m WHERE m.user_id=r.applicant_id AND m.active) THEN
      RAISE EXCEPTION 'APPLICANT_ALREADY_HAS_MEMBERSHIP' USING ERRCODE='55000';
    END IF;
    od := r.organization_data; bd := r.initial_branch_data;
    IF p_link_organization_id IS NULL THEN
      org_id := public.petro_create_organization_details(
        od->>'name',od->>'kind',upper(od->>'code'),od->>'legalName',
        od->>'contactName',od->>'contactPhone',od->>'contactEmail',od->>'address'
      );
      PERFORM public.petro_approve_organization(org_id,1,btrim(p_reason));
      result_branch_id := public.petro_create_branch_details(
        org_id,upper(bd->>'code'),bd->>'name',bd->>'address',bd->>'governorate',
        nullif(bd->>'latitude','')::numeric,nullif(bd->>'longitude','')::numeric,
        coalesce(bd->'hours','{}'::jsonb),bd->>'contactName',bd->>'contactPhone'
      );
      PERFORM public.petro_approve_branch(org_id,result_branch_id,1,btrim(p_reason));
      member_role := 'organization_owner';
      PERFORM public.petro_set_membership(org_id,r.applicant_id,member_role,'organization',ARRAY[]::uuid[],true);
    ELSE
      IF p_link_role IS NULL
       OR p_link_role NOT IN ('organization_owner','manager','finance','worker','viewer')
         OR NOT EXISTS (SELECT 1 FROM public.petro_organizations o
            WHERE o.id=p_link_organization_id AND o.kind=od->>'kind' AND o.approval_status='approved')
         OR (p_link_role<>'organization_owner' AND p_link_branch_id IS NULL)
         OR (p_link_branch_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.petro_branches b
             WHERE b.id=p_link_branch_id AND b.organization_id=p_link_organization_id)) THEN
        RAISE EXCEPTION 'INVALID_LINK_TARGET_OR_ROLE' USING ERRCODE='22023';
      END IF;
      org_id := p_link_organization_id; result_branch_id := p_link_branch_id; member_role := p_link_role;
      IF member_role='organization_owner' THEN
        PERFORM public.petro_set_membership(org_id,r.applicant_id,member_role,'organization',ARRAY[]::uuid[],true);
      ELSE
        PERFORM public.petro_set_membership(org_id,r.applicant_id,member_role,'branches',ARRAY[result_branch_id],true);
      END IF;
    END IF;
    UPDATE public.petro_documents d SET organization_id=org_id,branch_id=coalesce(result_branch_id,d.branch_id)
      WHERE d.join_request_id=p_request_id AND d.status IN ('pending_review','approved');
    UPDATE public.petro_org_join_requests SET status='approved',version=version+1,updated_at=now(),
      reviewed_by=actor,reviewed_at=now(),decision_reason=btrim(p_reason),
      approved_organization_id=org_id,approved_branch_id=result_branch_id WHERE id=p_request_id;
  ELSE
  UPDATE public.petro_org_join_requests SET status=CASE p_action WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE p_action END,
    version=version+1,updated_at=now(),
      reviewed_by=actor,reviewed_at=now(),decision_reason=btrim(p_reason) WHERE id=p_request_id;
  END IF;
  INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
  VALUES(actor,org_id,'organization.join_request.'||CASE p_action WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE p_action END,p_request_id,
    jsonb_build_object('reason',btrim(p_reason),'linked_existing',p_link_organization_id IS NOT NULL,
      'member_role',member_role,'branch_id',result_branch_id));
  RETURN jsonb_build_object('status',CASE p_action WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE p_action END,
    'organizationId',org_id,'branchId',result_branch_id);
END
$$;

CREATE FUNCTION public.petro_create_org_change_request(
  p_organization_id uuid,p_branch_id uuid,p_expected_entity_version bigint,p_proposed_data jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE
  actor uuid := auth.uid(); target_type text; snap jsonb; new_id uuid;
  org public.petro_organizations%ROWTYPE; br public.petro_branches%ROWTYPE;
BEGIN
  IF actor IS NULL OR NOT petro_private.user_active() OR jsonb_typeof(p_proposed_data)<>'object'
     OR p_expected_entity_version<1 THEN RAISE EXCEPTION 'INVALID_INPUT' USING ERRCODE='22023'; END IF;
  IF p_branch_id IS NULL THEN
    target_type := 'organization';
    IF NOT petro_private.can_manage_org(p_organization_id) THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
    SELECT * INTO org FROM public.petro_organizations WHERE id=p_organization_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF org.version<>p_expected_entity_version THEN RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE='40001'; END IF;
    IF NOT petro_private.valid_org_change_data(p_proposed_data) THEN
      RAISE EXCEPTION 'INVALID_CHANGE_FIELDS' USING ERRCODE='22023';
    END IF;
    snap := jsonb_build_object('name',org.name,'kind',org.kind,'code',org.code,
      'legalName',org.legal_name,'address',org.address);
  ELSE
    target_type := 'branch';
    IF NOT petro_private.can_manage_branch(p_organization_id,p_branch_id) THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
    SELECT * INTO br FROM public.petro_branches WHERE id=p_branch_id AND organization_id=p_organization_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF br.version<>p_expected_entity_version THEN RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE='40001'; END IF;
    IF NOT petro_private.valid_branch_change_data(p_proposed_data) THEN
      RAISE EXCEPTION 'INVALID_CHANGE_FIELDS' USING ERRCODE='22023';
    END IF;
    snap := jsonb_build_object('code',br.code,'name',br.name,'address',br.address,
      'governorate',br.governorate,'latitude',br.latitude,'longitude',br.longitude);
    IF ((CASE WHEN p_proposed_data ? 'latitude' THEN (p_proposed_data->>'latitude')::numeric ELSE br.latitude END IS NULL)
        <>
        (CASE WHEN p_proposed_data ? 'longitude' THEN (p_proposed_data->>'longitude')::numeric ELSE br.longitude END IS NULL)) THEN
      RAISE EXCEPTION 'INVALID_COORDINATE_PAIR' USING ERRCODE='22023';
    END IF;
  END IF;
  INSERT INTO public.petro_org_change_requests(
    organization_id,branch_id,target_type,applicant_id,expected_entity_version,current_snapshot,proposed_data
  ) VALUES(p_organization_id,p_branch_id,target_type,actor,p_expected_entity_version,snap,p_proposed_data)
  RETURNING id INTO new_id;
  INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
  VALUES(actor,p_organization_id,'organization.change_requested',new_id,
    jsonb_build_object('target_type',target_type,'branch_id',p_branch_id,'fields',ARRAY(SELECT jsonb_object_keys(p_proposed_data))));
  RETURN new_id;
END
$$;

CREATE FUNCTION public.petro_resubmit_org_change_request(
  p_request_id uuid,p_expected_request_version bigint,p_proposed_data jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE r public.petro_org_change_requests%ROWTYPE; actor uuid:=auth.uid();
  org public.petro_organizations%ROWTYPE; br public.petro_branches%ROWTYPE; snap jsonb;
BEGIN
  SELECT * INTO r FROM public.petro_org_change_requests WHERE id=p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF actor<>r.applicant_id OR r.status<>'needs_completion' THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF r.version<>p_expected_request_version THEN RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE='40001'; END IF;
  IF r.target_type='organization' THEN
    IF NOT petro_private.valid_org_change_data(p_proposed_data)
       OR NOT petro_private.can_manage_org(r.organization_id) THEN RAISE EXCEPTION 'INVALID_CHANGE_FIELDS' USING ERRCODE='22023'; END IF;
    SELECT * INTO org FROM public.petro_organizations WHERE id=r.organization_id FOR SHARE;
    snap:=jsonb_build_object('name',org.name,'kind',org.kind,'code',org.code,'legalName',org.legal_name,'address',org.address);
    UPDATE public.petro_org_change_requests SET expected_entity_version=org.version,current_snapshot=snap,
      proposed_data=p_proposed_data,status='submitted',version=version+1,updated_at=now(),decision_reason=NULL
      WHERE id=p_request_id;
  ELSE
    IF NOT petro_private.valid_branch_change_data(p_proposed_data)
       OR NOT petro_private.can_manage_branch(r.organization_id,r.branch_id)
       THEN RAISE EXCEPTION 'INVALID_CHANGE_FIELDS' USING ERRCODE='22023'; END IF;
    SELECT * INTO br FROM public.petro_branches WHERE id=r.branch_id AND organization_id=r.organization_id FOR SHARE;
    IF ((CASE WHEN p_proposed_data ? 'latitude' THEN (p_proposed_data->>'latitude')::numeric ELSE br.latitude END IS NULL)
        <>
        (CASE WHEN p_proposed_data ? 'longitude' THEN (p_proposed_data->>'longitude')::numeric ELSE br.longitude END IS NULL)) THEN
      RAISE EXCEPTION 'INVALID_COORDINATE_PAIR' USING ERRCODE='22023';
    END IF;
    snap:=jsonb_build_object('code',br.code,'name',br.name,'address',br.address,'governorate',br.governorate,
      'latitude',br.latitude,'longitude',br.longitude);
    UPDATE public.petro_org_change_requests SET expected_entity_version=br.version,current_snapshot=snap,
      proposed_data=p_proposed_data,status='submitted',version=version+1,updated_at=now(),decision_reason=NULL
      WHERE id=p_request_id;
  END IF;
  INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
  VALUES(actor,r.organization_id,'organization.change_resubmitted',p_request_id,jsonb_build_object('fields',ARRAY(SELECT jsonb_object_keys(p_proposed_data))));
END
$$;

CREATE FUNCTION public.petro_withdraw_org_change_request(p_request_id uuid,p_expected_version bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE r public.petro_org_change_requests%ROWTYPE; actor uuid:=auth.uid();
BEGIN
  SELECT * INTO r FROM public.petro_org_change_requests WHERE id=p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF actor<>r.applicant_id OR r.version<>p_expected_version OR r.status NOT IN ('submitted','needs_completion')
    THEN RAISE EXCEPTION 'FORBIDDEN_OR_STALE' USING ERRCODE='42501'; END IF;
  UPDATE public.petro_org_change_requests SET status='withdrawn',version=version+1,updated_at=now(),
    decision_reason='سحب قبل القرار' WHERE id=p_request_id;
  INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
  VALUES(actor,r.organization_id,'organization.change_withdrawn',p_request_id,'{}'::jsonb);
END
$$;

CREATE FUNCTION public.petro_review_org_change_request(
  p_request_id uuid,p_expected_request_version bigint,p_action text,p_reason text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE r public.petro_org_change_requests%ROWTYPE; actor uuid:=auth.uid();
  org public.petro_organizations%ROWTYPE; br public.petro_branches%ROWTYPE;
  d jsonb; changed text;
BEGIN
  IF NOT petro_private.can_review_org_requests() OR p_action NOT IN ('approve','reject','needs_completion')
     OR char_length(btrim(coalesce(p_reason,''))) NOT BETWEEN 5 AND 500
    THEN RAISE EXCEPTION 'FORBIDDEN_OR_INVALID_DECISION' USING ERRCODE='42501'; END IF;
  SELECT * INTO r FROM public.petro_org_change_requests WHERE id=p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF r.version<>p_expected_request_version THEN RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE='40001'; END IF;
  IF r.status NOT IN ('submitted','needs_completion') THEN RAISE EXCEPTION 'REQUEST_ALREADY_DECIDED' USING ERRCODE='55000'; END IF;
  IF p_action='approve' THEN
    d:=r.proposed_data;
    IF r.target_type='organization' THEN
      SELECT * INTO org FROM public.petro_organizations WHERE id=r.organization_id FOR UPDATE;
      IF org.version<>r.expected_entity_version OR
        jsonb_build_object('name',org.name,'kind',org.kind,'code',org.code,'legalName',org.legal_name,'address',org.address)
          IS DISTINCT FROM r.current_snapshot THEN
        UPDATE public.petro_org_change_requests SET status='conflict',version=version+1,updated_at=now(),
          reviewed_by=actor,reviewed_at=now(),decision_reason='تغير السجل بعد تقديم الطلب' WHERE id=p_request_id;
        INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
        VALUES(actor,r.organization_id,'organization.change_conflict',p_request_id,jsonb_build_object('reason',btrim(p_reason)));
        RETURN 'conflict';
      END IF;
      PERFORM public.petro_update_organization_details(
        r.organization_id,org.version,
        CASE WHEN d ? 'name' THEN d->>'name' ELSE org.name END,
        CASE WHEN d ? 'kind' THEN d->>'kind' ELSE org.kind END,
        CASE WHEN d ? 'code' THEN d->>'code' ELSE org.code END,
        CASE WHEN d ? 'legalName' THEN d->>'legalName' ELSE org.legal_name END,
        org.contact_name,org.contact_phone,org.contact_email,
        CASE WHEN d ? 'address' THEN d->>'address' ELSE org.address END,btrim(p_reason)
      );
    ELSE
      SELECT * INTO br FROM public.petro_branches WHERE id=r.branch_id AND organization_id=r.organization_id FOR UPDATE;
      IF br.version<>r.expected_entity_version OR
        jsonb_build_object('code',br.code,'name',br.name,'address',br.address,'governorate',br.governorate,
          'latitude',br.latitude,'longitude',br.longitude) IS DISTINCT FROM r.current_snapshot THEN
        UPDATE public.petro_org_change_requests SET status='conflict',version=version+1,updated_at=now(),
          reviewed_by=actor,reviewed_at=now(),decision_reason='تغير السجل بعد تقديم الطلب' WHERE id=p_request_id;
        INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
        VALUES(actor,r.organization_id,'organization.change_conflict',p_request_id,jsonb_build_object('reason',btrim(p_reason)));
        RETURN 'conflict';
      END IF;
      PERFORM public.petro_update_branch_details(
        r.organization_id,r.branch_id,br.version,
        CASE WHEN d ? 'code' THEN d->>'code' ELSE br.code END,
        CASE WHEN d ? 'name' THEN d->>'name' ELSE br.name END,
        CASE WHEN d ? 'address' THEN d->>'address' ELSE br.address END,
        CASE WHEN d ? 'governorate' THEN d->>'governorate' ELSE br.governorate END,
        CASE WHEN d ? 'latitude' THEN (d->>'latitude')::numeric ELSE br.latitude END,
        CASE WHEN d ? 'longitude' THEN (d->>'longitude')::numeric ELSE br.longitude END,
        br.hours,br.contact_name,br.contact_phone,btrim(p_reason)
      );
    END IF;
  END IF;
  UPDATE public.petro_org_change_requests SET status=CASE p_action WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE p_action END,
    version=version+1,updated_at=now(),
    reviewed_by=actor,reviewed_at=now(),decision_reason=btrim(p_reason) WHERE id=p_request_id;
  INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
  VALUES(actor,r.organization_id,'organization.change.'||CASE p_action WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE p_action END,
    p_request_id,jsonb_build_object('reason',btrim(p_reason)));
  RETURN CASE p_action WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE p_action END;
END
$$;

CREATE FUNCTION public.petro_propose_bank_account_version(
  p_organization_id uuid,p_bank_account_id uuid,p_expected_account_version bigint,
  p_bank_name text,p_beneficiary_name text,p_account_identifier text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE actor uuid:=auth.uid(); account_id uuid; v bigint; account_row public.petro_bank_accounts%ROWTYPE; version_id uuid;
  ident text:=regexp_replace(btrim(coalesce(p_account_identifier,'')),'[[:space:]-]','','g');
BEGIN
  IF actor IS NULL OR NOT petro_private.can_manage_bank(p_organization_id)
     OR char_length(btrim(coalesce(p_bank_name,''))) NOT BETWEEN 2 AND 120
     OR char_length(btrim(coalesce(p_beneficiary_name,''))) NOT BETWEEN 2 AND 160
     OR char_length(ident) NOT BETWEEN 5 AND 34
     OR ident !~ '^[A-Za-z0-9]+$' THEN RAISE EXCEPTION 'FORBIDDEN_OR_INVALID_BANK_DETAILS' USING ERRCODE='42501'; END IF;
  IF p_bank_account_id IS NULL THEN
    INSERT INTO public.petro_bank_accounts(organization_id,created_by)
    VALUES(p_organization_id,actor) RETURNING id INTO account_id;
    v:=1;
  ELSE
    IF p_expected_account_version IS NULL THEN RAISE EXCEPTION 'INVALID_VERSION' USING ERRCODE='22023'; END IF;
    SELECT * INTO account_row FROM public.petro_bank_accounts
      WHERE id=p_bank_account_id AND organization_id=p_organization_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF account_row.version<>p_expected_account_version THEN RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE='40001'; END IF;
    account_id:=account_row.id;
    UPDATE public.petro_bank_account_versions SET status='superseded',
      decision_reason='استبدل بمقترح أحدث'
      WHERE bank_account_id=account_id AND status='needs_completion';
    SELECT coalesce(max(version),0)+1 INTO v FROM public.petro_bank_account_versions WHERE bank_account_id=account_id;
  END IF;
  INSERT INTO public.petro_bank_account_versions(
    bank_account_id,organization_id,version,bank_name,beneficiary_name,account_identifier,account_last4,created_by
  ) VALUES(account_id,p_organization_id,v,btrim(p_bank_name),btrim(p_beneficiary_name),ident,right(ident,4),actor)
  RETURNING id INTO version_id;
  INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
  VALUES(actor,p_organization_id,'organization.bank_version.proposed',version_id,
    jsonb_build_object('bank_account_id',account_id,'version',v,'last4',right(ident,4)));
  RETURN jsonb_build_object('accountId',account_id,'versionId',version_id,'version',v,'status','pending','last4',right(ident,4));
END
$$;

CREATE FUNCTION public.petro_withdraw_bank_account_version(p_version_id uuid,p_expected_version bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE v public.petro_bank_account_versions%ROWTYPE; actor uuid:=auth.uid();
BEGIN
  IF actor IS NULL OR NOT petro_private.user_active() THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO v FROM public.petro_bank_account_versions WHERE id=p_version_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v.created_by<>actor OR NOT petro_private.can_manage_bank(v.organization_id)
     OR v.status NOT IN ('pending','needs_completion') THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF v.version<>p_expected_version THEN RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE='40001'; END IF;
  UPDATE public.petro_bank_account_versions SET status='withdrawn',reviewed_by=actor,reviewed_at=now(),
    decision_reason='سحب قبل القرار' WHERE id=p_version_id;
  INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
  VALUES(actor,v.organization_id,'organization.bank_version.withdrawn',p_version_id,jsonb_build_object('version',v.version));
END
$$;

CREATE FUNCTION public.petro_review_bank_account_version(
  p_version_id uuid,p_expected_request_version bigint,p_action text,p_reason text,p_expected_account_version bigint
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE v public.petro_bank_account_versions%ROWTYPE; a public.petro_bank_accounts%ROWTYPE; actor uuid:=auth.uid();
BEGIN
  IF actor IS NULL OR NOT petro_private.user_active()
     OR NOT petro_private.platform_has(ARRAY['owner','finance']::text[])
     OR p_action NOT IN ('approve','reject','needs_completion')
     OR char_length(btrim(coalesce(p_reason,''))) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'FORBIDDEN_OR_INVALID_DECISION' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v FROM public.petro_bank_account_versions WHERE id=p_version_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v.version<>p_expected_request_version THEN RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE='40001'; END IF;
  IF v.status NOT IN ('pending','needs_completion') THEN RAISE EXCEPTION 'REQUEST_ALREADY_DECIDED' USING ERRCODE='55000'; END IF;
  SELECT * INTO a FROM public.petro_bank_accounts WHERE id=v.bank_account_id AND organization_id=v.organization_id FOR UPDATE;
  IF a.version<>p_expected_account_version THEN
    UPDATE public.petro_bank_account_versions SET status='conflict',reviewed_by=actor,reviewed_at=now(),
      decision_reason='تغير الحساب بعد تقديم المقترح' WHERE id=p_version_id;
    INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
    VALUES(actor,v.organization_id,'organization.bank_version.conflict',p_version_id,jsonb_build_object('version',v.version));
    RETURN 'conflict';
  END IF;
  IF p_action='approve' THEN
    UPDATE public.petro_bank_account_versions SET status='superseded',reviewed_by=actor,reviewed_at=now(),
      decision_reason='استبدال بنسخة معتمدة أحدث'
      WHERE bank_account_id=v.bank_account_id AND status='approved';
    UPDATE public.petro_bank_account_versions SET status='approved',reviewed_by=actor,reviewed_at=now(),
      decision_reason=btrim(p_reason) WHERE id=p_version_id;
    UPDATE public.petro_bank_accounts SET version=version+1,status='active',updated_at=now() WHERE id=v.bank_account_id;
  ELSE
    UPDATE public.petro_bank_account_versions SET status=CASE p_action WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE p_action END,
      reviewed_by=actor,reviewed_at=now(),
      decision_reason=btrim(p_reason) WHERE id=p_version_id;
  END IF;
  INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
  VALUES(actor,v.organization_id,'organization.bank_version.'||CASE p_action WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE p_action END,p_version_id,
    jsonb_build_object('reason',btrim(p_reason),'version',v.version,'last4',right(v.account_identifier,4)));
  RETURN CASE p_action WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE p_action END;
END
$$;

CREATE FUNCTION public.petro_create_document_upload(
  p_context_type text,p_context_id uuid,p_document_type text,p_file_name text,
  p_content_type text,p_byte_size bigint,p_expires_on date
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE actor uuid:=auth.uid(); org_id uuid; branch_id uuid; allowed boolean:=false; doc_id uuid; obj_path text;
  j public.petro_org_join_requests%ROWTYPE; c public.petro_org_change_requests%ROWTYPE;
  b public.petro_bank_account_versions%ROWTYPE;
BEGIN
  IF actor IS NULL OR NOT petro_private.user_active()
     OR char_length(btrim(coalesce(p_document_type,''))) NOT BETWEEN 2 AND 80
     OR char_length(coalesce(p_file_name,'')) NOT BETWEEN 1 AND 160
     OR p_content_type NOT IN ('application/pdf','image/png','image/jpeg')
     OR p_byte_size NOT BETWEEN 1 AND 10485760 THEN RAISE EXCEPTION 'INVALID_DOCUMENT_INPUT' USING ERRCODE='22023'; END IF;
  IF p_context_type='join_request' THEN
    SELECT * INTO j FROM public.petro_org_join_requests WHERE id=p_context_id;
    IF FOUND AND (j.applicant_id=actor OR petro_private.can_review_org_requests())
       AND j.status IN ('draft','submitted','needs_completion') THEN allowed:=true; END IF;
  ELSIF p_context_type='organization' THEN
    org_id:=p_context_id; allowed:=petro_private.can_manage_org(org_id);
  ELSIF p_context_type='branch' THEN
    SELECT organization_id INTO org_id FROM public.petro_branches WHERE id=p_context_id;
    branch_id:=p_context_id; allowed:=org_id IS NOT NULL AND petro_private.can_manage_branch(org_id,branch_id);
  ELSIF p_context_type='change_request' THEN
    SELECT * INTO c FROM public.petro_org_change_requests WHERE id=p_context_id;
    IF FOUND THEN org_id:=c.organization_id; branch_id:=c.branch_id;
      allowed:=(c.applicant_id=actor OR petro_private.can_review_org_requests())
        AND c.status IN ('submitted','needs_completion'); END IF;
  ELSIF p_context_type='bank_version' THEN
    SELECT * INTO b FROM public.petro_bank_account_versions WHERE id=p_context_id;
    IF FOUND THEN org_id:=b.organization_id;
      allowed:=petro_private.can_manage_bank(org_id) AND b.status IN ('pending','needs_completion'); END IF;
  END IF;
  IF NOT allowed THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  INSERT INTO public.petro_documents(
    uploader_id,organization_id,branch_id,join_request_id,change_request_id,bank_account_version_id,
    document_type,file_name,content_type,byte_size,storage_path,expires_on
  )
  VALUES(actor,org_id,branch_id,
    CASE WHEN p_context_type='join_request' THEN p_context_id ELSE NULL END,
    CASE WHEN p_context_type='change_request' THEN p_context_id ELSE NULL END,
    CASE WHEN p_context_type='bank_version' THEN p_context_id ELSE NULL END,
    btrim(p_document_type),p_file_name,p_content_type,p_byte_size,'documents/'||gen_random_uuid()::text,p_expires_on
  ) RETURNING id,storage_path INTO doc_id,obj_path;
  INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
  VALUES(actor,org_id,'organization.document.upload_started',doc_id,jsonb_build_object('context',p_context_type,'mime',p_content_type,'size',p_byte_size));
  RETURN jsonb_build_object('id',doc_id,'objectPath',obj_path,'bucket','petro-private-documents');
END
$$;

CREATE FUNCTION public.petro_complete_document_upload(p_document_id uuid,p_sha256 text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE d public.petro_documents%ROWTYPE; actor uuid:=auth.uid();
BEGIN
  SELECT * INTO d FROM public.petro_documents WHERE id=p_document_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF d.uploader_id<>actor OR d.status<>'pending_upload' OR d.upload_expires_at<=now()
     OR p_sha256 !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'FORBIDDEN_OR_EXPIRED_UPLOAD' USING ERRCODE='42501'; END IF;
  UPDATE public.petro_documents
    SET status=CASE WHEN join_request_id IS NOT NULL THEN 'attached' ELSE 'pending_review' END,
        sha256=p_sha256,uploaded_at=now(),version=version+1
    WHERE id=p_document_id;
END
$$;

CREATE FUNCTION public.petro_fail_document_upload(p_document_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE d public.petro_documents%ROWTYPE; actor uuid:=auth.uid();
BEGIN
  SELECT * INTO d FROM public.petro_documents WHERE id=p_document_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF d.uploader_id<>actor OR d.status<>'pending_upload' THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  UPDATE public.petro_documents SET status='upload_failed',version=version+1 WHERE id=p_document_id;
  INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
  VALUES(actor,d.organization_id,'organization.document.upload_failed',p_document_id,'{}'::jsonb);
END
$$;

CREATE FUNCTION public.petro_review_document(
  p_document_id uuid,p_expected_version bigint,p_action text,p_reason text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE d public.petro_documents%ROWTYPE; actor uuid:=auth.uid();
BEGIN
  IF NOT petro_private.can_review_org_requests() OR p_action NOT IN ('approve','reject','needs_completion')
     OR char_length(btrim(coalesce(p_reason,''))) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'FORBIDDEN_OR_INVALID_DECISION' USING ERRCODE='42501';
  END IF;
  SELECT * INTO d FROM public.petro_documents WHERE id=p_document_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF d.version<>p_expected_version THEN RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE='40001'; END IF;
  IF d.status NOT IN ('pending_review','needs_completion') THEN RAISE EXCEPTION 'DOCUMENT_ALREADY_DECIDED' USING ERRCODE='55000'; END IF;
  UPDATE public.petro_documents SET status=CASE p_action WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE p_action END,
    reviewed_by=actor,reviewed_at=now(),
    review_reason=btrim(p_reason),version=version+1 WHERE id=p_document_id;
  INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
  VALUES(actor,d.organization_id,'organization.document.'||p_action,p_document_id,
    jsonb_build_object('reason',btrim(p_reason),'document_type',d.document_type,'version',p_expected_version+1));
END
$$;

CREATE FUNCTION petro_private.can_access_private_document(p_object_path text,p_action text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.petro_documents d
    WHERE d.storage_path=p_object_path
      AND (
        (p_action='upload' AND d.status='pending_upload' AND d.uploader_id=auth.uid()
          AND d.upload_expires_at>now() AND petro_private.user_active())
        OR (p_action='delete' AND d.status='pending_upload' AND d.uploader_id=auth.uid())
        OR (p_action='read' AND (
          (d.status='attached' AND d.uploader_id=auth.uid() AND petro_private.user_active())
          OR (d.status IN ('pending_review','approved','needs_completion','rejected')
            AND (
              d.uploader_id=auth.uid()
              OR (d.join_request_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM public.petro_org_join_requests j WHERE j.id=d.join_request_id AND j.applicant_id=auth.uid()
              ))
              OR (d.bank_account_version_id IS NOT NULL AND petro_private.can_manage_bank(d.organization_id))
              OR (d.bank_account_version_id IS NULL AND d.organization_id IS NOT NULL
                AND (petro_private.can_manage_org(d.organization_id)
                  OR (d.branch_id IS NOT NULL AND petro_private.can_manage_branch(d.organization_id,d.branch_id))))
              OR (d.status IN ('pending_review','needs_completion') AND petro_private.can_review_org_requests())
            )
          )
        ))
      )
  )
$$;

CREATE FUNCTION petro_private.guard_sensitive_org_edit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
BEGIN
  IF TG_TABLE_NAME='petro_organizations' THEN
    IF NOT petro_private.platform_has(ARRAY['owner','operations']::text[])
       AND (OLD.name IS DISTINCT FROM NEW.name OR OLD.kind IS DISTINCT FROM NEW.kind
         OR OLD.code IS DISTINCT FROM NEW.code OR OLD.legal_name IS DISTINCT FROM NEW.legal_name
         OR OLD.address IS DISTINCT FROM NEW.address) THEN
      RAISE EXCEPTION 'SENSITIVE_CHANGE_REQUIRES_REVIEW' USING ERRCODE='55000';
    END IF;
  ELSIF TG_TABLE_NAME='petro_branches' THEN
    IF NOT petro_private.platform_has(ARRAY['owner','operations']::text[])
       AND (OLD.code IS DISTINCT FROM NEW.code OR OLD.name IS DISTINCT FROM NEW.name
         OR OLD.address IS DISTINCT FROM NEW.address OR OLD.governorate IS DISTINCT FROM NEW.governorate
         OR OLD.latitude IS DISTINCT FROM NEW.latitude OR OLD.longitude IS DISTINCT FROM NEW.longitude) THEN
      RAISE EXCEPTION 'SENSITIVE_CHANGE_REQUIRES_REVIEW' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER petro_organizations_guard_sensitive_edit
  BEFORE UPDATE ON public.petro_organizations FOR EACH ROW EXECUTE FUNCTION petro_private.guard_sensitive_org_edit();
CREATE TRIGGER petro_branches_guard_sensitive_edit
  BEFORE UPDATE ON public.petro_branches FOR EACH ROW EXECUTE FUNCTION petro_private.guard_sensitive_org_edit();

CREATE OR REPLACE FUNCTION public.petro_update_organization_details(
  p_organization_id uuid,p_expected_version bigint,p_name text,p_kind text,p_code text,
  p_legal_name text,p_contact_name text,p_contact_phone text,p_contact_email text,p_address text,p_reason text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE
  actor_id uuid:=auth.uid(); old_row public.petro_organizations%ROWTYPE;
  normalized_code text:=upper(btrim(coalesce(p_code,'')));
  normalized_email text:=nullif(lower(btrim(p_contact_email)),'');
  changed_fields text[];
BEGIN
  IF actor_id IS NULL OR NOT petro_private.user_active()
     OR NOT petro_private.can_manage_org(p_organization_id) THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF p_expected_version IS NULL OR p_expected_version<1 THEN RAISE EXCEPTION 'INVALID_VERSION' USING ERRCODE='22023'; END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 5 AND 500 THEN RAISE EXCEPTION 'INVALID_REASON' USING ERRCODE='22023'; END IF;
  SELECT * INTO old_row FROM public.petro_organizations WHERE id=p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF old_row.version<>p_expected_version THEN RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE='40001'; END IF;
  IF p_name IS NULL OR char_length(btrim(p_name)) NOT BETWEEN 2 AND 160
     OR p_kind NOT IN ('company','station','provider') OR normalized_code !~ '^[A-Z0-9_-]{2,40}$'
     OR (nullif(btrim(p_legal_name),'') IS NOT NULL AND char_length(btrim(p_legal_name))<2)
     OR (nullif(btrim(p_contact_name),'') IS NOT NULL AND char_length(btrim(p_contact_name))<2)
     OR (nullif(btrim(p_contact_phone),'') IS NOT NULL AND char_length(btrim(p_contact_phone))<5)
     OR char_length(coalesce(p_legal_name,''))>200 OR char_length(coalesce(p_contact_name,''))>160
     OR char_length(coalesce(p_contact_phone,''))>24 OR char_length(coalesce(normalized_email,''))>320
     OR (normalized_email IS NOT NULL AND normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
     OR char_length(coalesce(p_address,''))>500 THEN RAISE EXCEPTION 'INVALID_INPUT' USING ERRCODE='22023'; END IF;
  changed_fields:=array_remove(ARRAY[
    CASE WHEN old_row.name IS DISTINCT FROM btrim(p_name) THEN 'name' END,
    CASE WHEN old_row.kind IS DISTINCT FROM p_kind THEN 'kind' END,
    CASE WHEN old_row.code IS DISTINCT FROM normalized_code THEN 'code' END,
    CASE WHEN old_row.legal_name IS DISTINCT FROM nullif(btrim(p_legal_name),'') THEN 'legal_name' END,
    CASE WHEN old_row.contact_name IS DISTINCT FROM nullif(btrim(p_contact_name),'') THEN 'contact_name' END,
    CASE WHEN old_row.contact_phone IS DISTINCT FROM nullif(btrim(p_contact_phone),'') THEN 'contact_phone' END,
    CASE WHEN old_row.contact_email IS DISTINCT FROM normalized_email THEN 'contact_email' END,
    CASE WHEN old_row.address IS DISTINCT FROM coalesce(p_address,'') THEN 'address' END
  ],NULL);
  IF cardinality(changed_fields)=0 THEN RAISE EXCEPTION 'NO_CHANGES' USING ERRCODE='22023'; END IF;
  IF NOT petro_private.platform_has(ARRAY['owner','operations']::text[])
     AND changed_fields && ARRAY['name','kind','code','legal_name','address']::text[] THEN
    RAISE EXCEPTION 'SENSITIVE_CHANGE_REQUIRES_REVIEW' USING ERRCODE='55000';
  END IF;
  UPDATE public.petro_organizations SET name=btrim(p_name),kind=p_kind,code=normalized_code,
    legal_name=nullif(btrim(p_legal_name),''),contact_name=nullif(btrim(p_contact_name),''),
    contact_phone=nullif(btrim(p_contact_phone),''),contact_email=normalized_email,
    address=coalesce(p_address,''),version=version+1,updated_at=now()
  WHERE id=p_organization_id;
  INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
  VALUES(actor_id,p_organization_id,'organization.updated',p_organization_id,
    jsonb_build_object('changed_fields',changed_fields,'reason',btrim(p_reason)));
END
$$;

CREATE OR REPLACE FUNCTION public.petro_update_branch_details(
  p_organization_id uuid,p_branch_id uuid,p_expected_version bigint,p_code text,p_name text,
  p_address text,p_governorate text,p_latitude numeric,p_longitude numeric,p_hours jsonb,
  p_contact_name text,p_contact_phone text,p_reason text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE
  actor_id uuid:=auth.uid(); old_row public.petro_branches%ROWTYPE;
  normalized_code text:=upper(btrim(coalesce(p_code,''))); changed_fields text[];
BEGIN
  IF actor_id IS NULL OR NOT petro_private.user_active()
     OR NOT (petro_private.can_manage_org(p_organization_id) OR petro_private.can_manage_branch(p_organization_id,p_branch_id))
    THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF p_expected_version IS NULL OR p_expected_version<1 THEN RAISE EXCEPTION 'INVALID_VERSION' USING ERRCODE='22023'; END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 5 AND 500 THEN RAISE EXCEPTION 'INVALID_REASON' USING ERRCODE='22023'; END IF;
  SELECT * INTO old_row FROM public.petro_branches
  WHERE id=p_branch_id AND organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF old_row.version<>p_expected_version THEN RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE='40001'; END IF;
  IF p_name IS NULL OR char_length(btrim(p_name)) NOT BETWEEN 2 AND 160
     OR normalized_code !~ '^[A-Z0-9_-]{2,40}$' OR char_length(coalesce(p_address,''))>500
     OR char_length(coalesce(p_governorate,''))>100
     OR (nullif(btrim(p_governorate),'') IS NOT NULL AND char_length(btrim(p_governorate))<2)
     OR ((p_latitude IS NULL)<>(p_longitude IS NULL))
     OR (p_latitude IS NOT NULL AND p_latitude NOT BETWEEN -90 AND 90)
     OR (p_longitude IS NOT NULL AND p_longitude NOT BETWEEN -180 AND 180)
     OR NOT petro_private.petro_valid_branch_hours(coalesce(p_hours,'{}'::jsonb))
     OR char_length(coalesce(p_contact_name,''))>160
     OR (nullif(btrim(p_contact_name),'') IS NOT NULL AND char_length(btrim(p_contact_name))<2)
     OR char_length(coalesce(p_contact_phone,''))>24
     OR (nullif(btrim(p_contact_phone),'') IS NOT NULL AND char_length(btrim(p_contact_phone))<5)
    THEN RAISE EXCEPTION 'INVALID_INPUT' USING ERRCODE='22023'; END IF;
  changed_fields:=array_remove(ARRAY[
    CASE WHEN old_row.code IS DISTINCT FROM normalized_code THEN 'code' END,
    CASE WHEN old_row.name IS DISTINCT FROM btrim(p_name) THEN 'name' END,
    CASE WHEN old_row.address IS DISTINCT FROM coalesce(p_address,'') THEN 'address' END,
    CASE WHEN old_row.governorate IS DISTINCT FROM nullif(btrim(p_governorate),'') THEN 'governorate' END,
    CASE WHEN old_row.latitude IS DISTINCT FROM p_latitude THEN 'latitude' END,
    CASE WHEN old_row.longitude IS DISTINCT FROM p_longitude THEN 'longitude' END,
    CASE WHEN old_row.hours IS DISTINCT FROM coalesce(p_hours,'{}'::jsonb) THEN 'hours' END,
    CASE WHEN old_row.contact_name IS DISTINCT FROM nullif(btrim(p_contact_name),'') THEN 'contact_name' END,
    CASE WHEN old_row.contact_phone IS DISTINCT FROM nullif(btrim(p_contact_phone),'') THEN 'contact_phone' END
  ],NULL);
  IF cardinality(changed_fields)=0 THEN RAISE EXCEPTION 'NO_CHANGES' USING ERRCODE='22023'; END IF;
  IF NOT petro_private.platform_has(ARRAY['owner','operations']::text[])
     AND changed_fields && ARRAY['code','name','address','governorate','latitude','longitude']::text[] THEN
    RAISE EXCEPTION 'SENSITIVE_CHANGE_REQUIRES_REVIEW' USING ERRCODE='55000';
  END IF;
  UPDATE public.petro_branches SET code=normalized_code,name=btrim(p_name),address=coalesce(p_address,''),
    governorate=nullif(btrim(p_governorate),''),latitude=p_latitude,longitude=p_longitude,
    hours=coalesce(p_hours,'{}'::jsonb),contact_name=nullif(btrim(p_contact_name),''),
    contact_phone=nullif(btrim(p_contact_phone),''),version=version+1,updated_at=now()
  WHERE id=p_branch_id AND organization_id=p_organization_id;
  INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
  VALUES(actor_id,p_organization_id,'branch.updated',p_branch_id,
    jsonb_build_object('changed_fields',changed_fields,'reason',btrim(p_reason)));
END
$$;

CREATE FUNCTION public.petro_get_bank_account_version(p_version_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE v public.petro_bank_account_versions%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT petro_private.user_active() THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO v FROM public.petro_bank_account_versions WHERE id=p_version_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF NOT petro_private.can_manage_bank(v.organization_id)
     AND NOT petro_private.platform_has(ARRAY['owner','finance']::text[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501';
  END IF;
  RETURN jsonb_build_object('id',v.id,'bankAccountId',v.bank_account_id,'organizationId',v.organization_id,
    'version',v.version,'bankName',v.bank_name,'beneficiaryName',v.beneficiary_name,
    'accountIdentifier',v.account_identifier,'accountLast4',v.account_last4,'status',v.status);
END
$$;

ALTER TABLE public.petro_org_join_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_org_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_bank_account_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY petro_org_join_read ON public.petro_org_join_requests
  FOR SELECT TO authenticated
  USING (applicant_id=auth.uid() OR petro_private.can_review_org_requests());
CREATE POLICY petro_org_change_read ON public.petro_org_change_requests
  FOR SELECT TO authenticated
  USING (applicant_id=auth.uid() OR petro_private.can_review_org_requests() OR petro_private.can_manage_org(organization_id));
CREATE POLICY petro_bank_account_read ON public.petro_bank_accounts
  FOR SELECT TO authenticated
  USING (petro_private.can_manage_bank(organization_id));
CREATE POLICY petro_bank_version_read ON public.petro_bank_account_versions
  FOR SELECT TO authenticated
  USING (created_by=auth.uid() OR petro_private.can_manage_bank(organization_id));
CREATE POLICY petro_documents_read ON public.petro_documents
  FOR SELECT TO authenticated
  USING (
    uploader_id=auth.uid()
    OR (join_request_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.petro_org_join_requests j WHERE j.id=join_request_id AND j.applicant_id=auth.uid()
    ))
    OR (bank_account_version_id IS NOT NULL AND petro_private.can_manage_bank(organization_id))
    OR (bank_account_version_id IS NULL AND organization_id IS NOT NULL
      AND (petro_private.can_manage_org(organization_id)
        OR (branch_id IS NOT NULL AND petro_private.can_manage_branch(organization_id,branch_id))))
    OR (status IN ('pending_review','needs_completion') AND petro_private.can_review_org_requests())
  );

CREATE POLICY petro_private_documents_select ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id='petro-private-documents' AND petro_private.can_access_private_document(name,'read'));
CREATE POLICY petro_private_documents_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id='petro-private-documents' AND petro_private.can_access_private_document(name,'upload'));
CREATE POLICY petro_private_documents_delete_pending ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id='petro-private-documents' AND petro_private.can_access_private_document(name,'delete'));

REVOKE ALL ON public.petro_org_join_requests, public.petro_org_change_requests,
  public.petro_bank_accounts, public.petro_bank_account_versions, public.petro_documents
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.petro_org_join_requests, public.petro_org_change_requests,
  public.petro_documents TO authenticated;
GRANT SELECT (id,organization_id,status,version,created_by,created_at,updated_at)
  ON public.petro_bank_accounts TO authenticated;
GRANT SELECT (id,bank_account_id,organization_id,version,bank_name,beneficiary_name,
  account_last4,status,created_by,created_at,reviewed_by,reviewed_at,decision_reason)
  ON public.petro_bank_account_versions TO authenticated;

REVOKE ALL ON FUNCTION petro_private.can_review_org_requests() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION petro_private.can_manage_bank(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION petro_private.valid_join_payload(jsonb,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION petro_private.valid_org_change_data(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION petro_private.valid_branch_change_data(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION petro_private.can_access_private_document(text,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION petro_private.guard_sensitive_org_edit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION petro_private.can_review_org_requests() TO authenticated;
GRANT EXECUTE ON FUNCTION petro_private.can_manage_bank(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION petro_private.can_access_private_document(text,text) TO authenticated;

REVOKE ALL ON FUNCTION public.petro_create_org_join_request(uuid,jsonb,jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.petro_update_org_join_request(uuid,bigint,jsonb,jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.petro_submit_org_join_request(uuid,bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.petro_withdraw_org_join_request(uuid,bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.petro_review_org_join_request(uuid,bigint,text,text,uuid,uuid,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.petro_create_org_change_request(uuid,uuid,bigint,jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.petro_resubmit_org_change_request(uuid,bigint,jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.petro_withdraw_org_change_request(uuid,bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.petro_review_org_change_request(uuid,bigint,text,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.petro_propose_bank_account_version(uuid,uuid,bigint,text,text,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.petro_withdraw_bank_account_version(uuid,bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.petro_review_bank_account_version(uuid,bigint,text,text,bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.petro_create_document_upload(text,uuid,text,text,text,bigint,date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.petro_complete_document_upload(uuid,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.petro_fail_document_upload(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.petro_review_document(uuid,bigint,text,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.petro_get_bank_account_version(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.petro_create_org_join_request(uuid,jsonb,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_update_org_join_request(uuid,bigint,jsonb,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_submit_org_join_request(uuid,bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_withdraw_org_join_request(uuid,bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_review_org_join_request(uuid,bigint,text,text,uuid,uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_create_org_change_request(uuid,uuid,bigint,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_resubmit_org_change_request(uuid,bigint,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_withdraw_org_change_request(uuid,bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_review_org_change_request(uuid,bigint,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_propose_bank_account_version(uuid,uuid,bigint,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_withdraw_bank_account_version(uuid,bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_review_bank_account_version(uuid,bigint,text,text,bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_create_document_upload(text,uuid,text,text,text,bigint,date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_complete_document_upload(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_fail_document_upload(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_review_document(uuid,bigint,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_get_bank_account_version(uuid) TO authenticated;

COMMIT;
