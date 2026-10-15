-- Narrowly allow confirmed, unassigned accounts to manage only their own
-- organization join request and its private attachments.
-- Apply only to Supabase project msvgzsfzrqlrfpstthhe after live preflight.
-- This does not alter organization data, account state, memberships, global
-- ACLs, default privileges, migration history, or resources outside requests
-- and their private documents.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regclass('public.petro_profiles') IS NULL
     OR to_regclass('public.petro_org_join_requests') IS NULL
     OR to_regclass('public.petro_documents') IS NULL
     OR to_regclass('public.petro_audit_events') IS NULL
     OR to_regclass('auth.users') IS NULL
     OR to_regclass('storage.objects') IS NULL
     OR NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id='petro-private-documents' AND public=false)
     OR to_regprocedure('public.petro_create_org_join_request(uuid,jsonb,jsonb)') IS NULL
     OR to_regprocedure('public.petro_update_org_join_request(uuid,bigint,jsonb,jsonb)') IS NULL
     OR to_regprocedure('public.petro_submit_org_join_request(uuid,bigint)') IS NULL
     OR to_regprocedure('public.petro_withdraw_org_join_request(uuid,bigint)') IS NULL
     OR to_regprocedure('public.petro_create_document_upload(text,uuid,text,text,text,bigint,date)') IS NULL
     OR to_regprocedure('public.petro_complete_document_upload(uuid,text)') IS NULL
     OR to_regprocedure('public.petro_fail_document_upload(uuid)') IS NULL
     OR to_regprocedure('petro_private.can_access_private_document(text,text)') IS NULL THEN
    RAISE EXCEPTION 'ORG_JOIN_0007_PREFLIGHT: expected post-0006 request and private-document resources are missing';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.petro_org_join_requests'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.petro_documents'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='storage.objects'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='petro_org_join_requests' AND policyname='petro_org_join_read')
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='petro_documents' AND policyname='petro_documents_read')
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='petro_private_documents_select')
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='petro_private_documents_insert')
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='petro_private_documents_delete_pending') THEN
    RAISE EXCEPTION 'ORG_JOIN_0007_PREFLIGHT: RLS or the expected scoped policies differ from the reviewed 0006 baseline';
  END IF;
  IF to_regprocedure('petro_private.confirmed_pending_join_user()') IS NOT NULL
     OR to_regprocedure('petro_private.eligible_join_applicant(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'ORG_JOIN_0007_PREFLIGHT: migration helpers already exist; inspect before proceeding';
  END IF;
END
$preflight$;

CREATE FUNCTION petro_private.confirmed_pending_join_user() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1
    FROM auth.users u
    JOIN public.petro_profiles p ON p.user_id=u.id
    WHERE u.id=auth.uid()
      AND u.email_confirmed_at IS NOT NULL
      AND p.login_identifier_type='username'
      AND NOT p.active
      AND p.account_status='pending'
      AND NOT EXISTS (SELECT 1 FROM public.petro_memberships m
        WHERE m.user_id=u.id AND m.active)
  )
$$;

-- Internal helper for a target user; deliberately not executable by client roles.
CREATE FUNCTION petro_private.eligible_join_applicant(p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
AS $$
  SELECT p_user_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM auth.users u
    JOIN public.petro_profiles p ON p.user_id=u.id
    WHERE u.id=p_user_id
      AND u.email_confirmed_at IS NOT NULL
      AND p.login_identifier_type='username'
      AND (
        (p.active AND p.account_status='active')
        OR (NOT p.active AND p.account_status='pending')
      )
  )
$$;

REVOKE ALL ON FUNCTION petro_private.confirmed_pending_join_user() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION petro_private.confirmed_pending_join_user() TO authenticated;
REVOKE ALL ON FUNCTION petro_private.eligible_join_applicant(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.petro_create_org_join_request(
  p_applicant_id uuid,p_organization_data jsonb,p_initial_branch_data jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE
  actor uuid := auth.uid();
  target uuid := coalesce(p_applicant_id,auth.uid());
  pending_actor boolean := petro_private.confirmed_pending_join_user();
  new_id uuid;
BEGIN
  IF actor IS NULL OR NOT (petro_private.user_active() OR pending_actor) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF pending_actor AND p_applicant_id IS NOT NULL THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF target<>actor AND NOT (petro_private.user_active() AND petro_private.can_review_org_requests()) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF NOT petro_private.valid_join_payload(p_organization_data,p_initial_branch_data)
     OR NOT petro_private.eligible_join_applicant(target)
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

CREATE OR REPLACE FUNCTION public.petro_update_org_join_request(
  p_request_id uuid,p_expected_version bigint,p_organization_data jsonb,p_initial_branch_data jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE r public.petro_org_join_requests%ROWTYPE; actor uuid := auth.uid();
BEGIN
  SELECT * INTO r FROM public.petro_org_join_requests WHERE id=p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF actor IS NULL OR NOT (
       petro_private.user_active()
       OR (actor=r.applicant_id AND petro_private.confirmed_pending_join_user())
     )
     OR (actor<>r.applicant_id AND NOT petro_private.can_review_org_requests()) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF r.version<>p_expected_version THEN RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE='40001'; END IF;
  IF r.status NOT IN ('draft','needs_completion')
     OR NOT petro_private.valid_join_payload(p_organization_data,p_initial_branch_data) THEN
    RAISE EXCEPTION 'INVALID_REQUEST_STATE_OR_DATA' USING ERRCODE='22023';
  END IF;
  UPDATE public.petro_org_join_requests SET organization_data=p_organization_data,
    initial_branch_data=p_initial_branch_data,status='draft',version=version+1,updated_at=now()
    WHERE id=p_request_id;
  INSERT INTO public.petro_audit_events(actor_id,action,target_id,detail)
  VALUES (actor,'organization.join_request.updated',p_request_id,jsonb_build_object('version',p_expected_version+1));
END
$$;

CREATE OR REPLACE FUNCTION public.petro_submit_org_join_request(
  p_request_id uuid,p_expected_version bigint
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE r public.petro_org_join_requests%ROWTYPE; actor uuid := auth.uid();
BEGIN
  SELECT * INTO r FROM public.petro_org_join_requests WHERE id=p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF actor IS NULL OR NOT (
       petro_private.user_active()
       OR (actor=r.applicant_id AND petro_private.confirmed_pending_join_user())
     )
     OR (actor<>r.applicant_id AND NOT petro_private.can_review_org_requests()) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF r.version<>p_expected_version THEN RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE='40001'; END IF;
  IF r.status NOT IN ('draft','needs_completion')
     OR NOT petro_private.valid_join_payload(r.organization_data,r.initial_branch_data)
     OR NOT petro_private.eligible_join_applicant(r.applicant_id)
     OR EXISTS (SELECT 1 FROM public.petro_memberships m WHERE m.user_id=r.applicant_id AND m.active) THEN
    RAISE EXCEPTION 'REQUEST_NOT_SUBMITTABLE' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.petro_documents d
             WHERE d.join_request_id=p_request_id AND d.status='pending_upload') THEN
    RAISE EXCEPTION 'DOCUMENT_UPLOAD_INCOMPLETE' USING ERRCODE='55000';
  END IF;
  UPDATE public.petro_org_join_requests SET status='submitted',submitted_at=now(),
    version=version+1,updated_at=now() WHERE id=p_request_id;
  UPDATE public.petro_documents SET status='pending_review',version=version+1
    WHERE join_request_id=p_request_id AND status='attached';
  INSERT INTO public.petro_audit_events(actor_id,action,target_id,detail)
  VALUES(actor,'organization.join_request.submitted',p_request_id,
    jsonb_build_object('version',p_expected_version+1));
END
$$;

CREATE OR REPLACE FUNCTION public.petro_withdraw_org_join_request(
  p_request_id uuid,p_expected_version bigint
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE r public.petro_org_join_requests%ROWTYPE; actor uuid := auth.uid();
BEGIN
  SELECT * INTO r FROM public.petro_org_join_requests WHERE id=p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF actor IS NULL OR NOT (
       petro_private.user_active()
       OR (actor=r.applicant_id AND petro_private.confirmed_pending_join_user())
     )
     OR (actor<>r.applicant_id AND NOT petro_private.can_review_org_requests()) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF r.version<>p_expected_version THEN RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE='40001'; END IF;
  IF r.status NOT IN ('draft','submitted','needs_completion') THEN
    RAISE EXCEPTION 'REQUEST_ALREADY_DECIDED' USING ERRCODE='55000';
  END IF;
  UPDATE public.petro_org_join_requests SET status='withdrawn',version=version+1,updated_at=now(),
    reviewed_by=actor,reviewed_at=now(),decision_reason='سحب قبل القرار'
    WHERE id=p_request_id;
  INSERT INTO public.petro_audit_events(actor_id,action,target_id,detail)
  VALUES(actor,'organization.join_request.withdrawn',p_request_id,'{}'::jsonb);
END
$$;

CREATE OR REPLACE FUNCTION public.petro_create_document_upload(
  p_context_type text,p_context_id uuid,p_document_type text,p_file_name text,
  p_content_type text,p_byte_size bigint,p_expires_on date
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE
  actor uuid:=auth.uid(); org_id uuid; branch_id uuid; allowed boolean:=false;
  pending_actor boolean:=petro_private.confirmed_pending_join_user();
  doc_id uuid; obj_path text;
  j public.petro_org_join_requests%ROWTYPE; c public.petro_org_change_requests%ROWTYPE;
  b public.petro_bank_account_versions%ROWTYPE;
BEGIN
  IF actor IS NULL OR NOT (petro_private.user_active() OR pending_actor)
     OR char_length(btrim(coalesce(p_document_type,''))) NOT BETWEEN 2 AND 80
     OR char_length(coalesce(p_file_name,'')) NOT BETWEEN 1 AND 160
     OR p_content_type NOT IN ('application/pdf','image/png','image/jpeg')
     OR p_byte_size NOT BETWEEN 1 AND 10485760 THEN
    RAISE EXCEPTION 'INVALID_DOCUMENT_INPUT' USING ERRCODE='22023';
  END IF;
  IF p_context_type='join_request' THEN
    SELECT * INTO j FROM public.petro_org_join_requests WHERE id=p_context_id;
    IF FOUND AND j.applicant_id=actor AND j.status IN ('draft','needs_completion') THEN
      allowed:=true;
    ELSIF FOUND AND petro_private.user_active() AND petro_private.can_review_org_requests()
       AND j.status IN ('draft','submitted','needs_completion') THEN
      allowed:=true;
    END IF;
  ELSIF p_context_type='organization' THEN
    org_id:=p_context_id; allowed:=petro_private.user_active() AND petro_private.can_manage_org(org_id);
  ELSIF p_context_type='branch' THEN
    SELECT organization_id INTO org_id FROM public.petro_branches WHERE id=p_context_id;
    branch_id:=p_context_id; allowed:=petro_private.user_active() AND org_id IS NOT NULL
      AND petro_private.can_manage_branch(org_id,branch_id);
  ELSIF p_context_type='change_request' THEN
    SELECT * INTO c FROM public.petro_org_change_requests WHERE id=p_context_id;
    IF FOUND THEN org_id:=c.organization_id; branch_id:=c.branch_id;
      allowed:=petro_private.user_active()
        AND (c.applicant_id=actor OR petro_private.can_review_org_requests())
        AND c.status IN ('submitted','needs_completion');
    END IF;
  ELSIF p_context_type='bank_version' THEN
    SELECT * INTO b FROM public.petro_bank_account_versions WHERE id=p_context_id;
    IF FOUND THEN org_id:=b.organization_id;
      allowed:=petro_private.user_active() AND petro_private.can_manage_bank(org_id)
        AND b.status IN ('pending','needs_completion');
    END IF;
  END IF;
  IF pending_actor AND (p_context_type<>'join_request' OR NOT allowed) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501';
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
    btrim(p_document_type),p_file_name,p_content_type,p_byte_size,
    'documents/'||gen_random_uuid()::text,p_expires_on
  ) RETURNING id,storage_path INTO doc_id,obj_path;
  INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
  VALUES(actor,org_id,'organization.document.upload_started',doc_id,
    jsonb_build_object('context',p_context_type,'mime',p_content_type,'size',p_byte_size));
  RETURN jsonb_build_object('id',doc_id,'objectPath',obj_path,'bucket','petro-private-documents');
END
$$;

CREATE OR REPLACE FUNCTION public.petro_complete_document_upload(
  p_document_id uuid,p_sha256 text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE d public.petro_documents%ROWTYPE; actor uuid:=auth.uid();
BEGIN
  SELECT * INTO d FROM public.petro_documents WHERE id=p_document_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF actor IS NULL OR d.uploader_id<>actor OR d.status<>'pending_upload'
     OR d.upload_expires_at<=now() OR p_sha256 !~ '^[0-9a-f]{64}$'
     OR NOT (
       petro_private.user_active()
       OR (
         petro_private.confirmed_pending_join_user()
         AND d.join_request_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM public.petro_org_join_requests j
           WHERE j.id=d.join_request_id AND j.applicant_id=actor
             AND j.status IN ('draft','needs_completion'))
       )
     ) THEN
    RAISE EXCEPTION 'FORBIDDEN_OR_EXPIRED_UPLOAD' USING ERRCODE='42501';
  END IF;
  UPDATE public.petro_documents
    SET status=CASE WHEN join_request_id IS NOT NULL THEN 'attached' ELSE 'pending_review' END,
        sha256=p_sha256,uploaded_at=now(),version=version+1
    WHERE id=p_document_id;
END
$$;

CREATE OR REPLACE FUNCTION public.petro_fail_document_upload(p_document_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE d public.petro_documents%ROWTYPE; actor uuid:=auth.uid();
BEGIN
  SELECT * INTO d FROM public.petro_documents WHERE id=p_document_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF actor IS NULL OR d.uploader_id<>actor OR d.status<>'pending_upload'
     OR NOT (
       petro_private.user_active()
       OR (
         petro_private.confirmed_pending_join_user()
         AND d.join_request_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM public.petro_org_join_requests j
           WHERE j.id=d.join_request_id AND j.applicant_id=actor
             AND j.status IN ('draft','needs_completion'))
       )
     ) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501';
  END IF;
  UPDATE public.petro_documents SET status='upload_failed',version=version+1 WHERE id=p_document_id;
  INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
  VALUES(actor,d.organization_id,'organization.document.upload_failed',p_document_id,'{}'::jsonb);
END
$$;

CREATE OR REPLACE FUNCTION petro_private.can_access_private_document(
  p_object_path text,p_action text
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.petro_documents d
    WHERE d.storage_path=p_object_path
      AND (
        (p_action='upload' AND d.status='pending_upload' AND d.uploader_id=auth.uid()
          AND d.upload_expires_at>now()
          AND (
            petro_private.user_active()
            OR (petro_private.confirmed_pending_join_user()
              AND d.join_request_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM public.petro_org_join_requests j
                WHERE j.id=d.join_request_id AND j.applicant_id=auth.uid()
                  AND j.status IN ('draft','needs_completion')))
          ))
        OR (p_action='delete' AND d.status='pending_upload' AND d.uploader_id=auth.uid()
          AND (
            petro_private.user_active()
            OR (petro_private.confirmed_pending_join_user()
              AND d.join_request_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM public.petro_org_join_requests j
                WHERE j.id=d.join_request_id AND j.applicant_id=auth.uid()
                  AND j.status IN ('draft','needs_completion')))
          ))
        OR (p_action='read' AND (
          (petro_private.user_active() AND (
            (d.status='attached' AND d.uploader_id=auth.uid())
            OR (d.status IN ('pending_review','approved','needs_completion','rejected')
              AND (
                d.uploader_id=auth.uid()
                OR (d.join_request_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM public.petro_org_join_requests j
                  WHERE j.id=d.join_request_id AND j.applicant_id=auth.uid()
                ))
                OR (d.bank_account_version_id IS NOT NULL AND petro_private.can_manage_bank(d.organization_id))
                OR (d.bank_account_version_id IS NULL AND d.organization_id IS NOT NULL
                  AND (petro_private.can_manage_org(d.organization_id)
                    OR (d.branch_id IS NOT NULL AND petro_private.can_manage_branch(d.organization_id,d.branch_id))))
                OR (d.status IN ('pending_review','needs_completion') AND petro_private.can_review_org_requests())
              )
            )
          ))
          OR (petro_private.confirmed_pending_join_user()
            AND d.join_request_id IS NOT NULL
            AND d.status IN ('attached','pending_review','approved','needs_completion','rejected')
            AND EXISTS (SELECT 1 FROM public.petro_org_join_requests j
              WHERE j.id=d.join_request_id AND j.applicant_id=auth.uid()))
        ))
      )
  )
$$;

DROP POLICY petro_org_join_read ON public.petro_org_join_requests;
CREATE POLICY petro_org_join_read ON public.petro_org_join_requests
  FOR SELECT TO authenticated
  USING (
    (petro_private.user_active()
      AND (applicant_id=auth.uid() OR petro_private.can_review_org_requests()))
    OR (applicant_id=auth.uid() AND petro_private.confirmed_pending_join_user())
  );

DROP POLICY petro_documents_read ON public.petro_documents;
CREATE POLICY petro_documents_read ON public.petro_documents
  FOR SELECT TO authenticated
  USING (
    (petro_private.user_active() AND (
      uploader_id=auth.uid()
      OR (join_request_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.petro_org_join_requests j
        WHERE j.id=join_request_id AND j.applicant_id=auth.uid()
      ))
      OR (bank_account_version_id IS NOT NULL AND petro_private.can_manage_bank(organization_id))
      OR (bank_account_version_id IS NULL AND organization_id IS NOT NULL
        AND (petro_private.can_manage_org(organization_id)
          OR (branch_id IS NOT NULL AND petro_private.can_manage_branch(organization_id,branch_id))))
      OR (status IN ('pending_review','needs_completion') AND petro_private.can_review_org_requests())
    ))
    OR (petro_private.confirmed_pending_join_user()
      AND join_request_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.petro_org_join_requests j
        WHERE j.id=join_request_id AND j.applicant_id=auth.uid()))
  );

COMMIT;
