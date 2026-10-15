-- Disposable local-only acceptance tests for 0005.
-- Every fixture is synthetic and the transaction is rolled back at the end.
BEGIN;
CREATE TEMP TABLE central_test_ids (
  org_a uuid NOT NULL,
  org_b uuid NOT NULL,
  branch_a uuid,
  branch_b uuid
) ON COMMIT DROP;
GRANT SELECT, UPDATE ON pg_temp.central_test_ids TO authenticated;

INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at)
VALUES
  ('00000000-0000-4000-8000-000000000201', 'central-owner@example.invalid', '{"username":"central_owner_test","display_name":"Central Owner Test"}', now()),
  ('00000000-0000-4000-8000-000000000202', 'org-a-manager@example.invalid', '{"username":"org_a_manager_test","display_name":"Org A Manager Test"}', now()),
  ('00000000-0000-4000-8000-000000000203', 'branch-a-manager@example.invalid', '{"username":"branch_a_manager_test","display_name":"Branch A Manager Test"}', now()),
  ('00000000-0000-4000-8000-000000000204', 'org-b-manager@example.invalid', '{"username":"org_b_manager_test","display_name":"Org B Manager Test"}', now());

UPDATE public.petro_profiles
   SET active = true, account_status = 'active'
 WHERE user_id IN (
   '00000000-0000-4000-8000-000000000201',
   '00000000-0000-4000-8000-000000000202',
   '00000000-0000-4000-8000-000000000203',
   '00000000-0000-4000-8000-000000000204'
 );

INSERT INTO public.petro_platform_roles(user_id, role, active)
VALUES ('00000000-0000-4000-8000-000000000201', 'owner', true);

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '00000000-0000-4000-8000-000000000201';

DO $create_organizations$
BEGIN
  PERFORM public.petro_create_organization_details(
    'شركة اختبار أ', 'company', 'TEST-ORG-A', NULL, 'مسؤول أ', '+201000000001',
    'org-a@example.invalid', 'عنوان اختبار أ'
  );
  PERFORM public.petro_create_organization_details(
    'محطة اختبار ب', 'station', 'TEST-ORG-B', NULL, NULL, NULL, NULL, 'عنوان اختبار ب'
  );

  IF NOT EXISTS (
    SELECT 1 FROM public.petro_organizations
     WHERE code = 'TEST-ORG-A' AND approval_status = 'pending'
       AND operational_status = 'inactive' AND status = 'pending' AND version = 1
  ) THEN
    RAISE EXCEPTION 'new organization did not start pending and inactive';
  END IF;

  BEGIN
    PERFORM public.petro_create_organization_details(
      'شركة مكررة', 'company', 'TEST-ORG-A', NULL, NULL, NULL, NULL, ''
    );
    RAISE EXCEPTION 'duplicate organization code unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END
$create_organizations$;
RESET ROLE;

INSERT INTO pg_temp.central_test_ids(org_a, org_b)
SELECT
  (SELECT id FROM public.petro_organizations WHERE code = 'TEST-ORG-A'),
  (SELECT id FROM public.petro_organizations WHERE code = 'TEST-ORG-B');

INSERT INTO public.petro_memberships(user_id, organization_id, role, scope, active)
SELECT '00000000-0000-4000-8000-000000000202', id, 'manager', 'organization', true
  FROM public.petro_organizations WHERE code = 'TEST-ORG-A';
INSERT INTO public.petro_memberships(user_id, organization_id, role, scope, active)
SELECT '00000000-0000-4000-8000-000000000203', id, 'manager', 'branches', true
  FROM public.petro_organizations WHERE code = 'TEST-ORG-A';
INSERT INTO public.petro_memberships(user_id, organization_id, role, scope, active)
SELECT '00000000-0000-4000-8000-000000000204', id, 'organization_owner', 'organization', true
  FROM public.petro_organizations WHERE code = 'TEST-ORG-B';

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '00000000-0000-4000-8000-000000000202';
DO $non_owner_denial$
DECLARE
  org_a uuid;
  org_b uuid;
BEGIN
  SELECT fixture.org_a, fixture.org_b INTO org_a, org_b FROM pg_temp.central_test_ids fixture;
  BEGIN
    PERFORM public.petro_create_organization_details(
      'جهة غير مخولة', 'company', 'TEST-DENIED', NULL, NULL, NULL, NULL, ''
    );
    RAISE EXCEPTION 'organization manager created a platform organization';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    PERFORM public.petro_approve_organization(org_a, 1, 'اعتماد غير مخول');
    RAISE EXCEPTION 'organization manager approved an organization';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    PERFORM public.petro_update_organization_details(
      org_b, 1, 'محاولة تعديل', 'station', 'TEST-ORG-B', NULL, NULL, NULL,
      NULL, '', 'محاولة عابرة'
    );
    RAISE EXCEPTION 'manager from organization A modified organization B';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$non_owner_denial$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '00000000-0000-4000-8000-000000000201';
DO $approve_organizations$
DECLARE
  org_id uuid;
BEGIN
  SELECT id INTO org_id FROM public.petro_organizations WHERE code = 'TEST-ORG-A';
  BEGIN
    PERFORM public.petro_set_organization_operational_status(org_id, 1, 'active', 'تفعيل قبل الاعتماد');
    RAISE EXCEPTION 'unapproved organization was activated';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
  PERFORM public.petro_approve_organization(org_id, 1, 'اعتماد اختبار موثق');
  IF NOT EXISTS (
    SELECT 1 FROM public.petro_organizations
     WHERE id = org_id AND approval_status = 'approved'
       AND operational_status = 'inactive' AND status = 'pending' AND version = 2
  ) THEN
    RAISE EXCEPTION 'approval changed operational state or failed to increment version';
  END IF;
  PERFORM public.petro_set_organization_operational_status(org_id, 2, 'active', 'تفعيل بعد الاعتماد');
  SELECT id INTO org_id FROM public.petro_organizations WHERE code = 'TEST-ORG-B';
  PERFORM public.petro_approve_organization(org_id, 1, 'اعتماد جهة الاختبار');
  PERFORM public.petro_set_organization_operational_status(org_id, 2, 'active', 'تفعيل جهة الاختبار');
END
$approve_organizations$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '00000000-0000-4000-8000-000000000202';
DO $manager_create_branch$
<<manager_create_branch>>
DECLARE
  org_a uuid;
  org_b uuid;
  version_before bigint;
  branch_a uuid;
  branch_b uuid;
BEGIN
  SELECT fixture.org_a, fixture.org_b INTO org_a, org_b FROM pg_temp.central_test_ids fixture;
  SELECT version INTO version_before FROM public.petro_organizations WHERE id = org_a;
  PERFORM public.petro_update_organization_details(
    org_a, version_before, 'شركة اختبار أ بعد التعديل', 'company', 'TEST-ORG-A-2',
    NULL, 'مسؤول أ', '+201000000001', 'org-a@example.invalid', 'عنوان اختبار أ',
    'تصحيح بيانات اختبار'
  );
  BEGIN
    PERFORM public.petro_update_organization_details(
      org_a, version_before, 'تعديل قديم', 'company', 'TEST-ORG-A-3',
      NULL, NULL, NULL, NULL, '', 'نسخة قديمة'
    );
    RAISE EXCEPTION 'stale organization update unexpectedly succeeded';
  EXCEPTION WHEN serialization_failure THEN
    NULL;
  END;

  branch_a := public.petro_create_branch_details(
    org_a, 'TEST-BRANCH-1', 'فرع اختبار أ١', 'عنوان الفرع أ١', 'القاهرة',
    30.0444, 31.2357,
    '{"sun":{"closed":true},"mon":{"closed":false,"open":"09:00","close":"17:00"}}'::jsonb,
    'مسؤول الفرع', '+201000000002'
  );
  PERFORM public.petro_create_branch_details(
    org_a, 'TEST-BRANCH-2', 'فرع اختبار أ٢', 'عنوان الفرع أ٢', NULL,
    NULL, NULL, '{}'::jsonb, NULL, NULL
  );
  BEGIN
    PERFORM public.petro_create_branch_details(
      org_b, 'TEST-BRANCH-1', 'فرع مرفوض', '', NULL, NULL, NULL, '{}'::jsonb, NULL, NULL
    );
    RAISE EXCEPTION 'manager from organization A created a branch in organization B';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000204', true);
  branch_b := public.petro_create_branch_details(
    org_b, 'TEST-BRANCH-1', 'فرع اختبار ب١', 'عنوان الفرع ب١', NULL,
    NULL, NULL, '{}'::jsonb, NULL, NULL
  );
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000202', true);

  BEGIN
    PERFORM public.petro_create_branch_details(
      org_a, 'TEST-BRANCH-1', 'فرع مكرر', '', NULL, NULL, NULL, '{}'::jsonb, NULL, NULL
    );
    RAISE EXCEPTION 'duplicate branch code within one organization unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  BEGIN
    PERFORM public.petro_update_branch_details(
      org_a, branch_b, 1, 'TEST-BRANCH-1', 'ربط خاطئ', '', NULL,
      NULL, NULL, '{}'::jsonb, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'branch was reassigned across organizations';
  EXCEPTION WHEN no_data_found THEN
    NULL;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM public.petro_branches
     WHERE id = branch_a AND organization_id = org_a
       AND approval_status = 'pending' AND operational_status = 'inactive'
       AND latitude = 30.044400 AND longitude = 31.235700 AND version = 1
  ) THEN
    RAISE EXCEPTION 'branch fields, fixed parent, or initial states are incorrect';
  END IF;
  UPDATE pg_temp.central_test_ids
     SET branch_a = manager_create_branch.branch_a,
         branch_b = manager_create_branch.branch_b;
END
$manager_create_branch$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '00000000-0000-4000-8000-000000000202';
DO $organization_isolation$
DECLARE
  org_a uuid;
  org_b uuid;
BEGIN
  SELECT fixture.org_a, fixture.org_b INTO org_a, org_b FROM pg_temp.central_test_ids fixture;
  IF (SELECT count(*) FROM public.petro_organizations WHERE id = org_a) <> 1
     OR (SELECT count(*) FROM public.petro_organizations WHERE id = org_b) <> 0
     OR (SELECT count(*) FROM public.petro_branches WHERE organization_id = org_b) <> 0 THEN
    RAISE EXCEPTION 'organization A manager can see organization B data';
  END IF;
END
$organization_isolation$;
RESET ROLE;

INSERT INTO public.petro_membership_branches(organization_id, membership_id, branch_id)
SELECT org.id, membership.id, branch.id
  FROM public.petro_organizations org
  JOIN public.petro_memberships membership
    ON membership.organization_id = org.id
   AND membership.user_id = '00000000-0000-4000-8000-000000000203'
  JOIN public.petro_branches branch
    ON branch.organization_id = org.id AND branch.code = 'TEST-BRANCH-1'
 WHERE org.code = 'TEST-ORG-A-2';

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '00000000-0000-4000-8000-000000000203';
DO $branch_scope_isolation$
DECLARE
  org_a uuid;
  org_b uuid;
  branch_a uuid;
BEGIN
  SELECT fixture.org_a, fixture.org_b, fixture.branch_a
    INTO org_a, org_b, branch_a FROM pg_temp.central_test_ids fixture;
  IF (SELECT count(*) FROM public.petro_branches WHERE organization_id = org_a) <> 1
     OR (SELECT count(*) FROM public.petro_branches WHERE organization_id = org_b) <> 0 THEN
    RAISE EXCEPTION 'branch-scoped manager can see an unauthorized branch';
  END IF;
  BEGIN
    PERFORM public.petro_approve_branch(
      org_a,
      branch_a,
      1,
      'اعتماد غير مخول'
    );
    RAISE EXCEPTION 'branch manager approved a branch';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$branch_scope_isolation$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '00000000-0000-4000-8000-000000000201';
DO $branch_approval_and_audit$
DECLARE
  org_a uuid;
  branch_a uuid;
BEGIN
  SELECT fixture.org_a, fixture.branch_a INTO org_a, branch_a FROM pg_temp.central_test_ids fixture;
  PERFORM public.petro_approve_branch(org_a, branch_a, 1, 'اعتماد فرع اختبار');
  IF NOT EXISTS (
    SELECT 1 FROM public.petro_branches
     WHERE id = branch_a AND approval_status = 'approved'
       AND operational_status = 'inactive' AND version = 2
  ) THEN
    RAISE EXCEPTION 'branch approval activated the branch or failed to increment version';
  END IF;
  PERFORM public.petro_set_branch_operational_status(org_a, branch_a, 2, 'active', 'تشغيل فرع الاختبار');
END
$branch_approval_and_audit$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '00000000-0000-4000-8000-000000000202';
DO $branch_suspend_reactivate$
DECLARE
  org_a uuid;
  branch_a uuid;
BEGIN
  SELECT fixture.org_a, fixture.branch_a INTO org_a, branch_a FROM pg_temp.central_test_ids fixture;
  PERFORM public.petro_set_branch_operational_status(org_a, branch_a, 3, 'suspended', 'إيقاف فرع الاختبار');
  PERFORM public.petro_set_branch_operational_status(org_a, branch_a, 4, 'active', 'إعادة تشغيل فرع الاختبار');
END
$branch_suspend_reactivate$;
RESET ROLE;

DO $final_assertions$
DECLARE
  org_a uuid;
  branch_a uuid;
BEGIN
  SELECT fixture.org_a, fixture.branch_a INTO org_a, branch_a FROM pg_temp.central_test_ids fixture;
  IF (SELECT version FROM public.petro_branches WHERE id = branch_a) <> 5
     OR (SELECT operational_status FROM public.petro_branches WHERE id = branch_a) <> 'active' THEN
    RAISE EXCEPTION 'branch transitions did not preserve operational state/version';
  END IF;
  IF (SELECT count(*) FROM public.petro_audit_events
       WHERE organization_id = org_a AND target_id = branch_a
         AND action IN ('branch.approved', 'branch.operational_status_changed')
         AND detail ? 'reason'
         AND occurred_at IS NOT NULL AND actor_id IS NOT NULL) <> 4 THEN
    RAISE EXCEPTION 'approval/status audit events are incomplete';
  END IF;
  IF has_function_privilege('authenticated', 'public.petro_create_organization(text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.petro_create_branch(uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.petro_set_organization_status(uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.petro_set_branch_status(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'legacy combined-state write RPC remains executable by authenticated';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.petro_create_organization_details(text,text,text,text,text,text,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.petro_approve_branch(uuid,uuid,bigint,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'required scoped organization/branch RPC path is missing';
  END IF;
END
$final_assertions$;

ROLLBACK;
