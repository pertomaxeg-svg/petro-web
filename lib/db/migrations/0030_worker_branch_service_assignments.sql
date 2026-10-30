BEGIN;

CREATE TABLE public.petro_worker_assignments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
 branch_id uuid NOT NULL,
 service_group text NOT NULL CHECK(service_group IN ('fuel','wash','oils','batteries','filters','parts','consumables','card_issuance')),
 active boolean NOT NULL DEFAULT true,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 updated_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,branch_id,service_group),
 FOREIGN KEY(organization_id,branch_id) REFERENCES public.petro_branches(organization_id,id) ON DELETE RESTRICT
);
CREATE INDEX petro_worker_assignments_branch_idx ON public.petro_worker_assignments(branch_id,active,user_id);
ALTER TABLE public.petro_worker_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.petro_worker_assignments FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE petro_private.worker_assignment_commands (
 actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 request_key text NOT NULL,
 payload jsonb NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(actor_id,request_key)
);
CREATE TABLE petro_private.worker_assignment_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 assignment_id uuid NOT NULL REFERENCES public.petro_worker_assignments(id) ON DELETE RESTRICT,
 actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 before_record jsonb,
 after_record jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX worker_assignment_events_assignment_idx ON petro_private.worker_assignment_events(assignment_id,created_at DESC);
ALTER TABLE petro_private.worker_assignment_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE petro_private.worker_assignment_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON petro_private.worker_assignment_commands,petro_private.worker_assignment_events FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION petro_private.workforce_user_active(p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.petro_profiles p JOIN auth.users u ON u.id=p.user_id
 WHERE p.user_id=p_user_id AND p.active AND p.account_status='active' AND NOT p.password_change_required AND u.email_confirmed_at IS NOT NULL)
$$;
CREATE FUNCTION petro_private.workforce_member_eligible(p_user_id uuid,p_branch_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT petro_private.workforce_user_active(p_user_id) AND EXISTS(
 SELECT 1 FROM public.petro_branches b JOIN public.petro_organizations o ON o.id=b.organization_id
 JOIN public.petro_memberships m ON m.organization_id=o.id AND m.user_id=p_user_id AND m.active
 WHERE b.id=p_branch_id AND o.kind IN ('station','provider')
 AND o.approval_status='approved' AND o.operational_status='active'
 AND b.approval_status='approved' AND b.operational_status='active'
 AND m.role IN ('worker','manager','organization_owner')
 AND (m.scope='organization' OR EXISTS(SELECT 1 FROM public.petro_membership_branches mb
 WHERE mb.membership_id=m.id AND mb.organization_id=o.id AND mb.branch_id=b.id)))
$$;
CREATE FUNCTION petro_private.workforce_can_execute(p_actor_id uuid,p_branch_id uuid,p_service_group text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT p_actor_id=auth.uid() AND petro_private.workforce_member_eligible(p_actor_id,p_branch_id)
 AND EXISTS(SELECT 1 FROM public.petro_worker_assignments a
 JOIN public.petro_organizations o ON o.id=a.organization_id
 WHERE a.user_id=p_actor_id AND a.branch_id=p_branch_id AND a.service_group=p_service_group AND a.active
 AND (o.kind='station' OR p_service_group NOT IN ('fuel','card_issuance')))
$$;
REVOKE ALL ON FUNCTION petro_private.workforce_user_active(uuid),petro_private.workforce_member_eligible(uuid,uuid),petro_private.workforce_can_execute(uuid,uuid,text)
FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.petro_admin_worker_assignment(
 p_user_id uuid,p_branch_id uuid,p_service_group text,p_active boolean,p_expected_version bigint,p_request_key text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=auth.uid(); branch_record record; existing public.petro_worker_assignments%ROWTYPE;
 saved public.petro_worker_assignments%ROWTYPE; receipt record; payload jsonb; result jsonb;
BEGIN
 IF NOT petro_private.fleet_can_manage() OR NOT petro_private.workforce_user_active(actor) THEN
 RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF p_user_id IS NULL OR p_branch_id IS NULL OR p_active IS NULL OR p_expected_version IS NULL OR p_expected_version<0
 OR p_service_group IS NULL OR p_service_group NOT IN ('fuel','wash','oils','batteries','filters','parts','consumables','card_issuance')
 OR p_request_key IS NULL OR char_length(btrim(p_request_key)) NOT BETWEEN 12 AND 160 THEN
 RAISE EXCEPTION 'INVALID_WORKER_ASSIGNMENT' USING ERRCODE='22023'; END IF;
 payload:=jsonb_build_object('userId',p_user_id,'branchId',p_branch_id,'serviceGroup',p_service_group,'active',p_active,'expectedVersion',p_expected_version);
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor::text||':'||p_request_key,0));
 SELECT * INTO receipt FROM petro_private.worker_assignment_commands WHERE actor_id=actor AND request_key=p_request_key;
 IF FOUND THEN
  IF receipt.payload IS DISTINCT FROM payload THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='40001'; END IF;
  RETURN receipt.result;
 END IF;
 SELECT b.organization_id,o.kind INTO branch_record FROM public.petro_branches b
 JOIN public.petro_organizations o ON o.id=b.organization_id WHERE b.id=p_branch_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'BRANCH_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 IF p_active AND (branch_record.kind='company' OR (branch_record.kind='provider' AND p_service_group IN ('fuel','card_issuance'))) THEN
 RAISE EXCEPTION 'SERVICE_NOT_ALLOWED_FOR_ORGANIZATION' USING ERRCODE='23514'; END IF;
 SELECT * INTO existing FROM public.petro_worker_assignments
 WHERE user_id=p_user_id AND branch_id=p_branch_id AND service_group=p_service_group FOR UPDATE;
 IF coalesce(existing.version,0)<>p_expected_version THEN RAISE EXCEPTION 'ASSIGNMENT_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
 IF p_active AND NOT petro_private.workforce_member_eligible(p_user_id,p_branch_id) THEN
 RAISE EXCEPTION 'ACTIVE_BRANCH_MEMBERSHIP_REQUIRED' USING ERRCODE='42501'; END IF;
 IF existing.id IS NULL THEN
  IF NOT p_active THEN RAISE EXCEPTION 'ASSIGNMENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  INSERT INTO public.petro_worker_assignments(user_id,organization_id,branch_id,service_group,active,created_by,updated_by)
  VALUES(p_user_id,branch_record.organization_id,p_branch_id,p_service_group,true,actor,actor) RETURNING * INTO saved;
 ELSE
  UPDATE public.petro_worker_assignments SET active=p_active,version=version+1,updated_by=actor,updated_at=now()
  WHERE id=existing.id RETURNING * INTO saved;
 END IF;
 INSERT INTO petro_private.worker_assignment_events(assignment_id,actor_id,before_record,after_record)
 VALUES(saved.id,actor,CASE WHEN existing.id IS NULL THEN NULL ELSE to_jsonb(existing) END,to_jsonb(saved));
 result:=jsonb_build_object('id',saved.id,'userId',saved.user_id,'branchId',saved.branch_id,
 'serviceGroup',saved.service_group,'active',saved.active,'version',saved.version);
 INSERT INTO petro_private.worker_assignment_commands(actor_id,request_key,payload,result) VALUES(actor,p_request_key,payload,result);
 RETURN result;
END $$;

CREATE FUNCTION public.petro_admin_worker_assignments(p_filters jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
 selected_branch uuid:=nullif(p_filters->>'branchId','')::uuid;
 selected_user uuid:=nullif(p_filters->>'userId','')::uuid;
 selected_view text:=coalesce(p_filters->>'view','assignments');
 page_no integer:=least(100000,greatest(1,coalesce((p_filters->>'page')::integer,1)));
 page_size integer:=least(100,greatest(1,coalesce((p_filters->>'pageSize')::integer,20)));
 search_text text:=nullif(btrim(p_filters->>'search'),'');
 result jsonb;
BEGIN
 IF NOT petro_private.fleet_can_read() OR NOT petro_private.workforce_user_active(auth.uid()) THEN
 RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF selected_view='candidates' THEN
  IF selected_branch IS NULL THEN RAISE EXCEPTION 'BRANCH_REQUIRED' USING ERRCODE='22023'; END IF;
  WITH filtered AS (
   SELECT p.user_id,p.display_name,p.username FROM public.petro_profiles p
   WHERE petro_private.workforce_member_eligible(p.user_id,selected_branch)
   AND (search_text IS NULL OR p.display_name ILIKE '%'||search_text||'%' OR p.username ILIKE '%'||search_text||'%')
  ) SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(to_jsonb(f) ORDER BY f."displayName",f."userId") FROM
   (SELECT user_id AS "userId",display_name AS "displayName",username FROM filtered ORDER BY display_name,user_id
    LIMIT page_size OFFSET (page_no-1)*page_size) f),'[]'::jsonb),'total',(SELECT count(*) FROM filtered),'page',page_no,'pageSize',page_size,
   'organizationKind',(SELECT o.kind FROM public.petro_branches b JOIN public.petro_organizations o ON o.id=b.organization_id WHERE b.id=selected_branch))
  INTO result;
 ELSIF selected_view='assignments' THEN
  WITH filtered AS (
   SELECT a.id,a.user_id AS "userId",p.display_name AS "displayName",a.organization_id AS "organizationId",
   o.name AS "organizationName",o.kind AS "organizationKind",a.branch_id AS "branchId",b.name AS "branchName",
   a.service_group AS "serviceGroup",a.active,a.version,a.updated_at AS "updatedAt",
   (a.active AND petro_private.workforce_member_eligible(a.user_id,a.branch_id)
     AND (o.kind='station' OR a.service_group NOT IN ('fuel','card_issuance'))) AS "canExecute"
   FROM public.petro_worker_assignments a JOIN public.petro_profiles p ON p.user_id=a.user_id
   JOIN public.petro_organizations o ON o.id=a.organization_id JOIN public.petro_branches b ON b.id=a.branch_id
   WHERE (selected_branch IS NULL OR a.branch_id=selected_branch) AND (selected_user IS NULL OR a.user_id=selected_user)
   AND (search_text IS NULL OR p.display_name ILIKE '%'||search_text||'%' OR o.name ILIKE '%'||search_text||'%' OR b.name ILIKE '%'||search_text||'%')
  ) SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(to_jsonb(f) ORDER BY f."updatedAt" DESC,f.id) FROM
   (SELECT * FROM filtered ORDER BY "updatedAt" DESC,id LIMIT page_size OFFSET(page_no-1)*page_size) f),'[]'::jsonb),
   'total',(SELECT count(*) FROM filtered),'page',page_no,'pageSize',page_size,'canManage',petro_private.fleet_can_manage()) INTO result;
 ELSE RAISE EXCEPTION 'INVALID_WORKFORCE_VIEW' USING ERRCODE='22023';
 END IF;
 RETURN result;
END $$;

CREATE FUNCTION public.petro_worker_capabilities() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT petro_private.workforce_user_active(auth.uid()) THEN
 RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
 SELECT jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object(
 'assignmentId',a.id,'assignmentVersion',a.version,'branchId',a.branch_id,'branchName',b.name,
 'organizationId',a.organization_id,'organizationName',o.name,'organizationKind',o.kind,'serviceGroup',a.service_group)
 ORDER BY o.name,b.name,a.service_group),'[]'::jsonb)) INTO result
 FROM public.petro_worker_assignments a JOIN public.petro_branches b ON b.id=a.branch_id
 JOIN public.petro_organizations o ON o.id=a.organization_id
 WHERE a.user_id=auth.uid() AND petro_private.workforce_can_execute(auth.uid(),a.branch_id,a.service_group);
 RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.petro_admin_worker_assignment(uuid,uuid,text,boolean,bigint,text),
 public.petro_admin_worker_assignments(jsonb),public.petro_worker_capabilities() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.petro_admin_worker_assignment(uuid,uuid,text,boolean,bigint,text),
 public.petro_admin_worker_assignments(jsonb),public.petro_worker_capabilities() TO authenticated;
COMMIT;
