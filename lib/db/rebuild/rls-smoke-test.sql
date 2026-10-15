-- Disposable local data only. The enclosing transaction is always rolled back.
BEGIN;

INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at)
VALUES
  ('00000000-0000-4000-8000-000000000001', 'rls-a@example.invalid',
   '{"username":"test_user_a","display_name":"Test A"}'::jsonb, now()),
  ('00000000-0000-4000-8000-000000000002', 'rls-b@example.invalid',
   '{"username":"test_user_b","display_name":"Test B"}'::jsonb, now());

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.petro_profiles
    WHERE user_id = '00000000-0000-4000-8000-000000000001'
      AND account_status = 'pending' AND active = false
  ) THEN
    RAISE EXCEPTION 'auth profile trigger did not create a pending profile';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.petro_platform_roles
    WHERE user_id IN (
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002'
    )
  ) THEN
    RAISE EXCEPTION 'a new user received a platform role automatically';
  END IF;
END
$$;

UPDATE public.petro_profiles
SET active = true, account_status = 'active'
WHERE user_id IN (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002'
);

INSERT INTO public.petro_organizations (id, name, kind, status, created_by)
VALUES
  ('10000000-0000-4000-8000-000000000001', 'Test Org A', 'company', 'active',
   '00000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002', 'Test Org B', 'company', 'active',
   '00000000-0000-4000-8000-000000000002');

INSERT INTO public.petro_branches (id, organization_id, name, status)
VALUES
  ('20000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000001', 'A Branch Allowed', 'active'),
  ('20000000-0000-4000-8000-000000000002',
   '10000000-0000-4000-8000-000000000001', 'A Branch Denied', 'active'),
  ('20000000-0000-4000-8000-000000000003',
   '10000000-0000-4000-8000-000000000002', 'B Branch', 'active');

INSERT INTO public.petro_memberships
  (id, user_id, organization_id, role, scope, active)
VALUES
  ('30000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000001', 'worker', 'branches', true),
  ('30000000-0000-4000-8000-000000000002',
   '00000000-0000-4000-8000-000000000002',
   '10000000-0000-4000-8000-000000000002', 'worker', 'branches', true);

INSERT INTO public.petro_membership_branches
  (organization_id, membership_id, branch_id)
VALUES
  ('10000000-0000-4000-8000-000000000001',
   '30000000-0000-4000-8000-000000000001',
   '20000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002',
   '30000000-0000-4000-8000-000000000002',
   '20000000-0000-4000-8000-000000000003');

INSERT INTO public.petro_membership_invites
  (organization_id, invited_email, role, scope, token_hash, created_by, expires_at)
VALUES
  ('10000000-0000-4000-8000-000000000002', 'test-invite@example.invalid',
   'worker', 'branches', repeat('a', 64),
   '00000000-0000-4000-8000-000000000002', now() + interval '1 day');

DO $$
BEGIN
  BEGIN
    INSERT INTO public.petro_membership_branches
      (organization_id, membership_id, branch_id)
    VALUES
      ('10000000-0000-4000-8000-000000000001',
       '30000000-0000-4000-8000-000000000001',
       '20000000-0000-4000-8000-000000000003');
    RAISE EXCEPTION 'cross-organization branch mapping was accepted';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END
$$;

SET LOCAL request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
DO $$
DECLARE visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count FROM public.petro_organizations;
  IF visible_count <> 1 OR EXISTS (
    SELECT 1 FROM public.petro_organizations
    WHERE id = '10000000-0000-4000-8000-000000000002'
  ) THEN
    RAISE EXCEPTION 'organization tenant isolation failed for user A';
  END IF;

  SELECT count(*) INTO visible_count FROM public.petro_branches;
  IF visible_count <> 1 OR NOT EXISTS (
    SELECT 1 FROM public.petro_branches
    WHERE id = '20000000-0000-4000-8000-000000000001'
  ) OR EXISTS (
    SELECT 1 FROM public.petro_branches
    WHERE id IN (
      '20000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000003'
    )
  ) THEN
    RAISE EXCEPTION 'branch scope isolation failed for user A';
  END IF;

  SELECT count(*) INTO visible_count FROM public.petro_memberships;
  IF visible_count <> 1 THEN
    RAISE EXCEPTION 'membership isolation failed for user A';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.petro_profiles
    WHERE user_id = '00000000-0000-4000-8000-000000000002'
  ) THEN
    RAISE EXCEPTION 'cross-tenant profile read was allowed for user A';
  END IF;

  IF (SELECT count(*) FROM public.petro_membership_invites) <> 0 THEN
    RAISE EXCEPTION 'invite table was readable without an RLS policy';
  END IF;
END
$$;

RESET ROLE;
SET LOCAL request.jwt.claim.sub = '00000000-0000-4000-8000-000000000002';
SET LOCAL ROLE authenticated;
DO $$
DECLARE visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count FROM public.petro_organizations;
  IF visible_count <> 1 OR EXISTS (
    SELECT 1 FROM public.petro_organizations
    WHERE id = '10000000-0000-4000-8000-000000000001'
  ) THEN
    RAISE EXCEPTION 'organization tenant isolation failed for user B';
  END IF;

  SELECT count(*) INTO visible_count FROM public.petro_branches;
  IF visible_count <> 1 OR NOT EXISTS (
    SELECT 1 FROM public.petro_branches
    WHERE id = '20000000-0000-4000-8000-000000000003'
  ) THEN
    RAISE EXCEPTION 'branch scope isolation failed for user B';
  END IF;

  IF has_table_privilege(current_user, 'public.petro_memberships', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated can update memberships directly';
  END IF;
  BEGIN
    EXECUTE
      'UPDATE public.petro_memberships SET role = ''organization_owner''
       WHERE id = ''30000000-0000-4000-8000-000000000002''';
    RAISE EXCEPTION 'direct role escalation was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  IF NOT has_table_privilege(
    current_user, 'public.petro_membership_invites', 'INSERT'
  ) THEN
    RAISE EXCEPTION 'expected invite DML grant was not present in the snapshot';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.petro_membership_invites'::regclass
  ) THEN
    RAISE EXCEPTION 'unexpected invite RLS policy changed the audited schema';
  END IF;
  BEGIN
    INSERT INTO public.petro_membership_invites
      (organization_id, invited_email, role, scope, token_hash, created_by, expires_at)
    VALUES
      ('10000000-0000-4000-8000-000000000002',
       'blocked-invite@example.invalid', 'worker', 'branches',
       repeat('b', 64), '00000000-0000-4000-8000-000000000002',
       now() + interval '1 day');
    RAISE EXCEPTION 'invite insert was unexpectedly accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$$;

RESET ROLE;
SET LOCAL ROLE anon;
DO $$
BEGIN
  BEGIN
    EXECUTE 'SELECT count(*) FROM public.petro_organizations';
    RAISE EXCEPTION 'anonymous organization read was unexpectedly allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  IF has_table_privilege(
    current_user, 'public.petro_membership_invites', 'SELECT'
  ) AND (SELECT count(*) FROM public.petro_membership_invites) <> 0 THEN
    RAISE EXCEPTION 'invite rows were readable by anon without an RLS policy';
  END IF;

  IF NOT has_table_privilege(
    current_user, 'public.petro_membership_invites', 'INSERT'
  ) THEN
    RAISE EXCEPTION 'expected anon invite DML grant was not present in the snapshot';
  END IF;
  BEGIN
    INSERT INTO public.petro_membership_invites
      (organization_id, invited_email, role, scope, token_hash, created_by, expires_at)
    VALUES
      ('10000000-0000-4000-8000-000000000002',
       'anon-invite@example.invalid', 'worker', 'branches',
       repeat('c', 64), '00000000-0000-4000-8000-000000000002',
       now() + interval '1 day');
    RAISE EXCEPTION 'anonymous invite insert was unexpectedly accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$$;

RESET ROLE;
UPDATE public.petro_profiles
SET active = false, account_status = 'suspended'
WHERE user_id = '00000000-0000-4000-8000-000000000001';
SET LOCAL request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
DO $$
DECLARE visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count FROM public.petro_organizations;
  IF visible_count <> 0 THEN
    RAISE EXCEPTION 'disabled account retained organization access';
  END IF;
END
$$;

ROLLBACK;
