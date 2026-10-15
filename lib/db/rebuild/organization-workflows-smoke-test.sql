-- Disposable synthetic acceptance tests for 0006.
-- Storage rows here model PostgreSQL RLS only; they do not use a live object service.
BEGIN;
CREATE TEMP TABLE workflow_test_ids (
  org_a uuid, org_b uuid, branch_a uuid, branch_b uuid,
  join_a uuid, join_b uuid, join_c uuid, join_d uuid,
  change_a uuid, conflict_change uuid,
  bank_account uuid, bank_v1 uuid, bank_v2 uuid, document_id uuid
) ON COMMIT DROP;
GRANT SELECT, UPDATE ON pg_temp.workflow_test_ids TO authenticated;
INSERT INTO pg_temp.workflow_test_ids DEFAULT VALUES;

INSERT INTO auth.users (id,email,raw_user_meta_data,email_confirmed_at)
VALUES
 ('00000000-0000-4000-8000-000000000301','wf-owner@example.invalid','{"username":"wf_owner","display_name":"Workflow Owner"}',now()),
 ('00000000-0000-4000-8000-000000000302','wf-applicant-a@example.invalid','{"username":"wf_applicant_a","display_name":"Applicant A"}',now()),
 ('00000000-0000-4000-8000-000000000303','wf-applicant-b@example.invalid','{"username":"wf_applicant_b","display_name":"Applicant B"}',now()),
 ('00000000-0000-4000-8000-000000000304','wf-applicant-c@example.invalid','{"username":"wf_applicant_c","display_name":"Applicant C"}',now()),
 ('00000000-0000-4000-8000-000000000305','wf-applicant-d@example.invalid','{"username":"wf_applicant_d","display_name":"Applicant D"}',now()),
 ('00000000-0000-4000-8000-000000000306','wf-manager@example.invalid','{"username":"wf_manager","display_name":"Workflow Manager"}',now());

UPDATE public.petro_profiles SET active=true,account_status='active'
WHERE user_id IN (
 '00000000-0000-4000-8000-000000000301','00000000-0000-4000-8000-000000000302',
 '00000000-0000-4000-8000-000000000303','00000000-0000-4000-8000-000000000304',
 '00000000-0000-4000-8000-000000000305','00000000-0000-4000-8000-000000000306'
);
INSERT INTO public.petro_platform_roles(user_id,role,active)
VALUES ('00000000-0000-4000-8000-000000000301','owner',true);

-- User A starts a request, uploads a synthetic document object, and submits.
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000302';
DO $applicant_a_draft$
DECLARE req uuid; doc jsonb; did uuid; path text; sha text:=repeat('a',64);
BEGIN
  req:=public.petro_create_org_join_request(NULL,
    '{"name":"شركة اختبار ووركفلو أ","kind":"company","code":"WF-ORG-A","legalName":null,"contactName":"مسؤول أ","contactPhone":"+201000000001","contactEmail":"wf-a@example.invalid","address":"عنوان أ"}'::jsonb,
    '{"code":"WF-BR-A","name":"فرع أ","address":"عنوان فرع أ","governorate":"القاهرة","latitude":30.04,"longitude":31.23,"hours":{},"contactName":"مسؤول أ","contactPhone":"+201000000001"}'::jsonb);
  BEGIN
    PERFORM public.petro_create_org_join_request(NULL,
      '{"name":"تكرار","kind":"company","code":"WF-DUP","address":"عنوان"}'::jsonb,
      '{"code":"WF-DUP-B","name":"فرع","address":"عنوان","hours":{}}'::jsonb);
    RAISE EXCEPTION 'duplicate open join request was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  doc:=public.petro_create_document_upload('join_request',req,'commercial_record','proof.pdf',
    'application/pdf',512,'2027-12-31');
  did:=(doc->>'id')::uuid; path:=doc->>'objectPath';
  INSERT INTO storage.objects(bucket_id,name,owner_id)
  VALUES('petro-private-documents',path,auth.uid());
  PERFORM public.petro_complete_document_upload(did,sha);
  IF NOT EXISTS (SELECT 1 FROM public.petro_documents WHERE id=did AND status='attached' AND version=2) THEN
    RAISE EXCEPTION 'application document was not held for the join request review';
  END IF;
  BEGIN
    PERFORM public.petro_review_document(did,2,'approve','موافقة مبكرة غير مسموحة');
    RAISE EXCEPTION 'attached application document could be reviewed before request submission';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  UPDATE pg_temp.workflow_test_ids SET join_a=req,document_id=did;
  IF NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id='petro-private-documents' AND name=path) THEN
    RAISE EXCEPTION 'authorized applicant could not access own uploaded object';
  END IF;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000301',true);
  IF EXISTS (SELECT 1 FROM public.petro_documents WHERE id=did)
     OR EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id='petro-private-documents' AND name=path) THEN
    RAISE EXCEPTION 'central reviewer could see an application attachment before submission';
  END IF;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000302',true);
  PERFORM public.petro_submit_org_join_request(req,1);
  IF NOT EXISTS (SELECT 1 FROM public.petro_documents WHERE id=did AND status='pending_review' AND version=3) THEN
    RAISE EXCEPTION 'submitted application documents were not queued for review';
  END IF;
END
$applicant_a_draft$;
RESET ROLE;

-- Central owner requests completion, then approves the same request after resubmission.
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000301';
DO $request_completion$
DECLARE req uuid; did uuid;
BEGIN
  SELECT join_a,document_id INTO req,did FROM pg_temp.workflow_test_ids;
  PERFORM public.petro_review_document(did,3,'approve','تمت مراجعة المستند التجريبي');
  PERFORM public.petro_review_org_join_request(req,2,'needs_completion','يرجى استكمال بيانات الاختبار');
END
$request_completion$;
RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000302';
DO $resubmit_join$
DECLARE req uuid;
BEGIN
  SELECT join_a INTO req FROM pg_temp.workflow_test_ids;
  PERFORM public.petro_update_org_join_request(req,3,
    '{"name":"شركة اختبار ووركفلو أ","kind":"company","code":"WF-ORG-A","legalName":"شركة أ","contactName":"مسؤول أ","contactPhone":"+201000000001","contactEmail":"wf-a@example.invalid","address":"عنوان أ"}'::jsonb,
    '{"code":"WF-BR-A","name":"فرع أ","address":"عنوان فرع أ","governorate":"القاهرة","latitude":30.04,"longitude":31.23,"hours":{},"contactName":"مسؤول أ","contactPhone":"+201000000001"}'::jsonb);
  PERFORM public.petro_submit_org_join_request(req,4);
END
$resubmit_join$;
RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000301';
DO $approve_join_a$
DECLARE req uuid; did uuid; result jsonb; oid uuid; bid uuid;
BEGIN
  SELECT join_a,document_id INTO req,did FROM pg_temp.workflow_test_ids;
  result:=public.petro_review_org_join_request(req,5,'approve','اعتماد طلب اختبار أ');
  oid:=(result->>'organizationId')::uuid; bid:=(result->>'branchId')::uuid;
  UPDATE pg_temp.workflow_test_ids SET org_a=oid,branch_a=bid;
  IF NOT EXISTS (SELECT 1 FROM public.petro_organizations
    WHERE id=oid AND approval_status='approved' AND operational_status='inactive') THEN
    RAISE EXCEPTION 'join approval changed operational state or failed to create approved entity';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.petro_memberships
    WHERE user_id='00000000-0000-4000-8000-000000000302' AND organization_id=oid
      AND role='organization_owner' AND scope='organization' AND active) THEN
    RAISE EXCEPTION 'new entity owner membership was not created';
  END IF;
  IF EXISTS (SELECT 1 FROM public.petro_platform_roles
    WHERE user_id='00000000-0000-4000-8000-000000000302' AND role='owner' AND active) THEN
    RAISE EXCEPTION 'organization join created platform owner role';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.petro_documents WHERE id=did AND organization_id=oid AND branch_id=bid) THEN
    RAISE EXCEPTION 'accepted application document was not linked to the approved entity';
  END IF;
  -- Activate only inside this rolled-back local fixture so membership-level
  -- management and tenant-isolation checks have an active test tenant.
  PERFORM public.petro_set_organization_operational_status(oid,2,'active','تهيئة جهة اختبار معزولة');
  BEGIN
    PERFORM public.petro_review_org_join_request(req,6,'approve','تكرار اعتماد');
    RAISE EXCEPTION 'approved join request was processed more than once';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
END
$approve_join_a$;
RESET ROLE;

-- Applicant B is rejected; applicant C creates a second entity used for cross-branch denial.
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000303';
DO $applicant_b$
DECLARE req uuid;
BEGIN
  req:=public.petro_create_org_join_request(NULL,
    '{"name":"محطة اختبار ووركفلو ب","kind":"station","code":"WF-ORG-B","address":"عنوان ب"}'::jsonb,
    '{"code":"WF-BR-B","name":"فرع ب","address":"عنوان فرع ب","hours":{}}'::jsonb);
  PERFORM public.petro_submit_org_join_request(req,1);
  UPDATE pg_temp.workflow_test_ids SET join_b=req;
END
$applicant_b$;
RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000301';
DO $reject_b$
DECLARE req uuid;
BEGIN
  SELECT join_b INTO req FROM pg_temp.workflow_test_ids;
  PERFORM public.petro_review_org_join_request(req,2,'reject','بيانات الاختبار غير مكتملة');
END
$reject_b$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000304';
DO $applicant_c$
DECLARE req uuid;
BEGIN
  req:=public.petro_create_org_join_request(NULL,
    '{"name":"مقدم اختبار ووركفلو ج","kind":"provider","code":"WF-ORG-C","address":"عنوان ج"}'::jsonb,
    '{"code":"WF-BR-C","name":"فرع ج","address":"عنوان فرع ج","hours":{}}'::jsonb);
  PERFORM public.petro_submit_org_join_request(req,1);
  UPDATE pg_temp.workflow_test_ids SET join_c=req;
END
$applicant_c$;
RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000301';
DO $approve_c$
DECLARE req uuid; result jsonb; oid uuid; bid uuid;
BEGIN
  SELECT join_c INTO req FROM pg_temp.workflow_test_ids;
  result:=public.petro_review_org_join_request(req,2,'approve','اعتماد كيان اختبار ج');
  oid:=(result->>'organizationId')::uuid; bid:=(result->>'branchId')::uuid;
  UPDATE pg_temp.workflow_test_ids SET org_b=oid,branch_b=bid;
END
$approve_c$;
RESET ROLE;

-- Applicant D cannot link a branch owned by another organization or gain platform owner.
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000305';
DO $applicant_d$
DECLARE req uuid;
BEGIN
  req:=public.petro_create_org_join_request(NULL,
    '{"name":"شركة ربط اختبار","kind":"company","code":"WF-ORG-D","address":"عنوان د"}'::jsonb,
    '{"code":"WF-BR-D","name":"فرع د","address":"عنوان د","hours":{}}'::jsonb);
  PERFORM public.petro_submit_org_join_request(req,1);
  UPDATE pg_temp.workflow_test_ids SET join_d=req;
END
$applicant_d$;
RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000301';
DO $bad_cross_branch$
DECLARE req uuid; org_a uuid; branch_b uuid;
BEGIN
  SELECT f.join_d,f.org_a,f.branch_b INTO req,org_a,branch_b FROM pg_temp.workflow_test_ids f;
  BEGIN
    PERFORM public.petro_review_org_join_request(req,2,'approve','محاولة ربط غير صحيحة',org_a,branch_b,'worker');
    RAISE EXCEPTION 'branch from another organization was linked';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.petro_review_org_join_request(req,2,'approve','محاولة دور غير صحيح',org_a,
      (SELECT branch_a FROM pg_temp.workflow_test_ids),'owner');
    RAISE EXCEPTION 'organization membership assigned an unsupported owner role';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END
$bad_cross_branch$;
DO $valid_entity_owner_link$
DECLARE req uuid; org_a uuid; branch_a uuid; result jsonb;
BEGIN
  SELECT f.join_d,f.org_a,f.branch_a INTO req,org_a,branch_a FROM pg_temp.workflow_test_ids f;
  result:=public.petro_review_org_join_request(req,2,'approve','ربط اختبار بصلاحية جهة محددة',org_a,branch_a,'organization_owner');
  IF result->>'status'<>'approved'
     OR NOT EXISTS (SELECT 1 FROM public.petro_memberships
       WHERE user_id='00000000-0000-4000-8000-000000000305' AND organization_id=org_a
         AND role='organization_owner' AND scope='organization' AND active)
     OR EXISTS (SELECT 1 FROM public.petro_platform_roles
       WHERE user_id='00000000-0000-4000-8000-000000000305' AND role='owner' AND active) THEN
    RAISE EXCEPTION 'entity ownership link was not scoped correctly or escalated to platform owner';
  END IF;
END
$valid_entity_owner_link$;
RESET ROLE;

-- Bank proposal is private to owner/finance, versions are append-only, and managers cannot view it.
INSERT INTO public.petro_memberships(user_id,organization_id,role,scope,active)
VALUES('00000000-0000-4000-8000-000000000306',
  (SELECT org_a FROM pg_temp.workflow_test_ids),'manager','organization',true);
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000302';
DO $bank_versions$
DECLARE org_id uuid; out jsonb; account_id uuid; v1 uuid; v2 uuid;
BEGIN
  SELECT org_a INTO org_id FROM pg_temp.workflow_test_ids;
  out:=public.petro_propose_bank_account_version(org_id,NULL,0,'بنك اختبار','شركة اختبار أ','EG123456789012345678');
  account_id:=(out->>'accountId')::uuid; v1:=(out->>'versionId')::uuid;
  UPDATE pg_temp.workflow_test_ids SET bank_account=account_id,bank_v1=v1;
  BEGIN
    PERFORM public.petro_propose_bank_account_version(org_id,
      (SELECT bank_account FROM pg_temp.workflow_test_ids),0,'بنك آخر','شركة أخرى','EG987654321012345678');
    RAISE EXCEPTION 'organization created a second concurrent bank account proposal';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END
$bank_versions$;
RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000301';
DO $bank_approve_first$
DECLARE v1 uuid; result text;
BEGIN
  SELECT bank_v1 INTO v1 FROM pg_temp.workflow_test_ids;
  result:=public.petro_review_bank_account_version(v1,1,'approve','اعتماد نسخة اختبار أولى',0);
  IF result<>'approved' THEN RAISE EXCEPTION 'first bank version approval failed'; END IF;
END
$bank_approve_first$;
RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000302';
DO $bank_propose_second$
DECLARE org_id uuid; acct uuid; out jsonb; v2 uuid;
BEGIN
  SELECT org_a,bank_account INTO org_id,acct FROM pg_temp.workflow_test_ids;
  out:=public.petro_propose_bank_account_version(org_id,acct,1,'بنك محدث','شركة اختبار أ','EG123456789012345679');
  v2:=(out->>'versionId')::uuid;
  UPDATE pg_temp.workflow_test_ids SET bank_v2=v2;
END
$bank_propose_second$;
RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000301';
DO $bank_approve_second$
DECLARE v1 uuid; v2 uuid; result text;
BEGIN
  SELECT bank_v1,bank_v2 INTO v1,v2 FROM pg_temp.workflow_test_ids;
  result:=public.petro_review_bank_account_version(v2,2,'approve','اعتماد نسخة اختبار أحدث',1);
  IF result<>'approved' THEN RAISE EXCEPTION 'second bank version approval failed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.petro_bank_account_versions WHERE id=v1 AND status='superseded'
      AND account_last4='5678')
     OR NOT EXISTS (SELECT 1 FROM public.petro_bank_account_versions WHERE id=v2 AND status='approved')
     OR (SELECT version FROM public.petro_bank_accounts WHERE id=(SELECT bank_account FROM pg_temp.workflow_test_ids))<>2 THEN
    RAISE EXCEPTION 'approved bank history was not preserved or version did not advance';
  END IF;
  IF public.petro_get_bank_account_version(v1)->>'accountIdentifier'<>'EG123456789012345678' THEN
    RAISE EXCEPTION 'authorized bank detail lookup did not return the requested version';
  END IF;
  BEGIN
    PERFORM account_identifier FROM public.petro_bank_account_versions WHERE id=v1;
    RAISE EXCEPTION 'sensitive account identifier was directly selectable';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$bank_approve_second$;
RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000302';
DO $bank_withdraw$
DECLARE org_id uuid; acct uuid; out jsonb; version_id uuid;
BEGIN
  SELECT org_a,bank_account INTO org_id,acct FROM pg_temp.workflow_test_ids;
  out:=public.petro_propose_bank_account_version(org_id,acct,2,'بنك لم يعتمد','شركة اختبار أ','EG555555555555555555');
  version_id:=(out->>'versionId')::uuid;
  BEGIN
    PERFORM public.petro_withdraw_bank_account_version(version_id,2);
    RAISE EXCEPTION 'stale bank proposal version was accepted';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  PERFORM public.petro_withdraw_bank_account_version(version_id,3);
  IF NOT EXISTS (SELECT 1 FROM public.petro_bank_account_versions WHERE id=version_id AND status='withdrawn')
     OR (SELECT version FROM public.petro_bank_accounts WHERE id=acct)<>2
     OR NOT EXISTS (SELECT 1 FROM public.petro_bank_account_versions WHERE id=(SELECT bank_v2 FROM pg_temp.workflow_test_ids) AND status='approved') THEN
    RAISE EXCEPTION 'bank withdrawal changed approved history or ignored optimistic version';
  END IF;
END
$bank_withdraw$;
RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000306';
DO $manager_cannot_read_bank$
DECLARE acct uuid; org_id uuid; version_id uuid;
BEGIN
  SELECT bank_account,org_a,bank_v1 INTO acct,org_id,version_id FROM pg_temp.workflow_test_ids;
  IF EXISTS (SELECT id FROM public.petro_bank_accounts WHERE id=acct)
     OR EXISTS (SELECT organization_id FROM public.petro_bank_account_versions WHERE organization_id=org_id) THEN
    RAISE EXCEPTION 'organization manager accessed restricted bank account details';
  END IF;
  BEGIN
    PERFORM public.petro_get_bank_account_version(version_id);
    RAISE EXCEPTION 'unauthorized organization manager read full bank details';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.petro_propose_bank_account_version(org_id,acct,2,'Bank','Test','EG11111111111111');
    RAISE EXCEPTION 'organization manager proposed a bank change';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$manager_cannot_read_bank$;
RESET ROLE;

-- Sensitive direct edits are denied to an organization owner; review applies only the exact snapshot.
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000302';
DO $change_request$
DECLARE oid uuid; req uuid; version_now bigint;
BEGIN
  SELECT org_a INTO oid FROM pg_temp.workflow_test_ids;
  SELECT version INTO version_now FROM public.petro_organizations WHERE id=oid;
  IF NOT petro_private.can_manage_org(oid) THEN
    RAISE EXCEPTION 'test precondition: expected organization manager access; active %, status %, memberships %',
      petro_private.user_active(),
      (SELECT status FROM public.petro_organizations WHERE id=oid),
      (SELECT string_agg(m.role||':'||m.scope||':'||m.active::text,',')
         FROM public.petro_memberships m WHERE m.organization_id=oid AND m.user_id=auth.uid());
  END IF;
  BEGIN
    PERFORM public.petro_update_organization_details(oid,version_now,'غير مسموح','company','WF-ORG-A',
      NULL,NULL,NULL,NULL,'عنوان أ','محاولة مباشرة');
    RAISE EXCEPTION 'organization owner directly changed sensitive organization fields';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
  req:=public.petro_create_org_change_request(oid,NULL,version_now,'{"address":"عنوان معتمد عبر المراجعة"}'::jsonb);
  UPDATE pg_temp.workflow_test_ids SET change_a=req;
END
$change_request$;
RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000301';
DO $approve_change$
DECLARE req uuid; status text;
BEGIN
  SELECT change_a INTO req FROM pg_temp.workflow_test_ids;
  status:=public.petro_review_org_change_request(req,1,'approve','اعتماد تغيير اختبار موثق');
  IF status<>'approved' OR NOT EXISTS (SELECT 1 FROM public.petro_organizations
    WHERE id=(SELECT org_a FROM pg_temp.workflow_test_ids) AND address='عنوان معتمد عبر المراجعة') THEN
    RAISE EXCEPTION 'organization change request was not applied';
  END IF;
END
$approve_change$;
RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000302';
DO $branch_location_request$
DECLARE oid uuid; bid uuid; req uuid; branch_version bigint;
BEGIN
  SELECT org_a,branch_a INTO oid,bid FROM pg_temp.workflow_test_ids;
  SELECT version INTO branch_version FROM public.petro_branches WHERE id=bid;
  req:=public.petro_create_org_change_request(oid,bid,branch_version,
    '{"latitude":30.1,"longitude":31.2}'::jsonb);
  UPDATE pg_temp.workflow_test_ids SET change_a=req;
END
$branch_location_request$;
RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000301';
DO $branch_location_review$
DECLARE req uuid; result_status text;
BEGIN
  SELECT change_a INTO req FROM pg_temp.workflow_test_ids;
  result_status:=public.petro_review_org_change_request(req,1,'approve','اعتماد موقع الفرع');
  IF result_status<>'approved' OR NOT EXISTS (
    SELECT 1 FROM public.petro_branches WHERE id=(SELECT branch_a FROM pg_temp.workflow_test_ids)
      AND latitude=30.1 AND longitude=31.2
  ) THEN RAISE EXCEPTION 'branch location change was not applied exactly'; END IF;
END
$branch_location_review$;
RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000302';
DO $create_stale_change$
DECLARE oid uuid; req uuid; version_now bigint;
BEGIN
  SELECT org_a INTO oid FROM pg_temp.workflow_test_ids;
  SELECT version INTO version_now FROM public.petro_organizations WHERE id=oid;
  req:=public.petro_create_org_change_request(oid,NULL,version_now,'{"address":"عنوان قديم المقترح"}'::jsonb);
  UPDATE pg_temp.workflow_test_ids SET conflict_change=req;
END
$create_stale_change$;
RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000301';
DO $stale_conflict$
DECLARE req uuid; oid uuid; version_now bigint; result_status text;
BEGIN
  SELECT conflict_change,org_a INTO req,oid FROM pg_temp.workflow_test_ids;
  SELECT version INTO version_now FROM public.petro_organizations WHERE id=oid;
  PERFORM public.petro_update_organization_details(oid,version_now,'شركة محدثة مركزيا','company','WF-ORG-A',
    'شركة أ','مسؤول أ','+201000000001','wf-a@example.invalid','عنوان إداري','تعديل مباشر موثق');
  result_status:=public.petro_review_org_change_request(req,1,'approve','فحص تعارض الإصدار');
  IF result_status<>'conflict' OR NOT EXISTS (SELECT 1 FROM public.petro_org_change_requests r WHERE r.id=req AND r.status='conflict')
    THEN RAISE EXCEPTION 'stale change request was not blocked'; END IF;
END
$stale_conflict$;
RESET ROLE;

-- Organization B cannot read A's requests or private file; anonymous Storage is denied too.
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000303';
DO $tenant_isolation$
DECLARE path text; oid uuid; bid uuid; branch_version bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM public.petro_org_join_requests WHERE id=(SELECT join_a FROM pg_temp.workflow_test_ids))
     OR EXISTS (SELECT 1 FROM public.petro_documents WHERE id=(SELECT document_id FROM pg_temp.workflow_test_ids))
     OR EXISTS (SELECT 1 FROM public.petro_org_change_requests WHERE organization_id=(SELECT org_a FROM pg_temp.workflow_test_ids))
    THEN RAISE EXCEPTION 'cross-organization request or document visibility was granted'; END IF;
  SELECT org_a,branch_a INTO oid,bid FROM pg_temp.workflow_test_ids;
  SELECT version INTO branch_version FROM public.petro_branches WHERE id=bid;
  BEGIN
    PERFORM public.petro_create_org_change_request(oid,bid,branch_version,'{"address":"تعديل غير مخول"}'::jsonb);
    RAISE EXCEPTION 'another organization submitted a branch change';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  SELECT d.storage_path INTO path FROM public.petro_documents d WHERE d.id=(SELECT document_id FROM pg_temp.workflow_test_ids);
  IF path IS NOT NULL AND EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id='petro-private-documents' AND name=path)
    THEN RAISE EXCEPTION 'cross-organization storage object visibility was granted'; END IF;
END
$tenant_isolation$;
RESET ROLE;
SET LOCAL ROLE anon;
SET LOCAL request.jwt.claim.sub='';
DO $anon_denial$
BEGIN
  IF EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id='petro-private-documents')
    THEN RAISE EXCEPTION 'anonymous role read private Storage object'; END IF;
END
$anon_denial$;
RESET ROLE;

-- Verify applicant, org, branch, and link decision states at transaction end.
DO $final_assertions$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.petro_org_join_requests WHERE id=(SELECT join_a FROM pg_temp.workflow_test_ids) AND status='approved')
      OR NOT EXISTS (SELECT 1 FROM public.petro_org_join_requests WHERE id=(SELECT join_b FROM pg_temp.workflow_test_ids) AND status='rejected')
      OR NOT EXISTS (SELECT 1 FROM public.petro_org_join_requests WHERE id=(SELECT join_d FROM pg_temp.workflow_test_ids) AND status='approved')
     OR (SELECT count(*) FROM storage.buckets WHERE id='petro-private-documents' AND public=false)<>1
     OR EXISTS (SELECT 1 FROM public.petro_platform_roles WHERE user_id IN (
       '00000000-0000-4000-8000-000000000302','00000000-0000-4000-8000-000000000303',
       '00000000-0000-4000-8000-000000000304','00000000-0000-4000-8000-000000000305') AND role='owner')
    THEN RAISE EXCEPTION 'workflow final assertions failed'; END IF;
END
$final_assertions$;

ROLLBACK;
