-- DB-02 tests against the proposed 0004 migration in a disposable local DB.
-- All identities, organizations, invitations and probe objects are rolled back.
BEGIN;

INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at)
VALUES
  ('00000000-0000-4000-8000-000000000101', 'owner-a@example.invalid',
   '{"username":"db02_owner_a","display_name":"DB02 Owner A"}'::jsonb, now()),
  ('00000000-0000-4000-8000-000000000102', 'manager-a@example.invalid',
   '{"username":"db02_manager_a","display_name":"DB02 Manager A"}'::jsonb, now()),
  ('00000000-0000-4000-8000-000000000103', 'branch-manager-a@example.invalid',
   '{"username":"db02_branch_manager_a","display_name":"DB02 Branch Manager A"}'::jsonb, now()),
  ('00000000-0000-4000-8000-000000000104', 'worker-a@example.invalid',
   '{"username":"db02_worker_a","display_name":"DB02 Worker A"}'::jsonb, now()),
  ('00000000-0000-4000-8000-000000000105', 'co-owner-a@example.invalid',
   '{"username":"db02_co_owner_a","display_name":"DB02 Co-owner A"}'::jsonb, now()),
  ('00000000-0000-4000-8000-000000000106', 'owner-b@example.invalid',
   '{"username":"db02_owner_b","display_name":"DB02 Owner B"}'::jsonb, now()),
  ('00000000-0000-4000-8000-000000000107', 'assigned-owner-a@example.invalid',
   '{"username":"db02_assigned_owner_a","display_name":"DB02 Assigned Owner A"}'::jsonb, now()),
  ('00000000-0000-4000-8000-000000000108', 'legacy-owner-a@example.invalid',
   '{"username":"db02_legacy_owner_a","display_name":"DB02 Legacy Owner A"}'::jsonb, now()),
  ('00000000-0000-4000-8000-000000000109', 'platform-owner@example.invalid',
   '{"username":"db02_platform_owner","display_name":"DB02 Platform Owner"}'::jsonb, now()),
  ('00000000-0000-4000-8000-000000000110', 'platform-operations@example.invalid',
   '{"username":"db02_platform_operations","display_name":"DB02 Platform Operations"}'::jsonb, now()),
  ('00000000-0000-4000-8000-000000000111', 'platform-finance@example.invalid',
   '{"username":"db02_platform_finance","display_name":"DB02 Platform Finance"}'::jsonb, now()),
  ('00000000-0000-4000-8000-000000000112', 'platform-support@example.invalid',
   '{"username":"db02_platform_support","display_name":"DB02 Platform Support"}'::jsonb, now()),
  ('00000000-0000-4000-8000-000000000113', 'platform-auditor@example.invalid',
   '{"username":"db02_platform_auditor","display_name":"DB02 Platform Auditor"}'::jsonb, now()),
  ('00000000-0000-4000-8000-000000000114', 'operations-invitee@example.invalid',
   '{"username":"db02_operations_invitee","display_name":"DB02 Operations Invitee"}'::jsonb, now());

UPDATE public.petro_profiles
SET active = true, account_status = 'active'
WHERE user_id IN (
  '00000000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000102',
  '00000000-0000-4000-8000-000000000103',
  '00000000-0000-4000-8000-000000000104',
  '00000000-0000-4000-8000-000000000105',
  '00000000-0000-4000-8000-000000000106',
  '00000000-0000-4000-8000-000000000107',
  '00000000-0000-4000-8000-000000000108',
  '00000000-0000-4000-8000-000000000109',
  '00000000-0000-4000-8000-000000000110',
  '00000000-0000-4000-8000-000000000111',
  '00000000-0000-4000-8000-000000000112',
  '00000000-0000-4000-8000-000000000113',
  '00000000-0000-4000-8000-000000000114'
);

INSERT INTO public.petro_platform_roles (user_id, role, active)
VALUES
  ('00000000-0000-4000-8000-000000000109', 'owner', true),
  ('00000000-0000-4000-8000-000000000110', 'operations', true),
  ('00000000-0000-4000-8000-000000000111', 'finance', true),
  ('00000000-0000-4000-8000-000000000112', 'support', true),
  ('00000000-0000-4000-8000-000000000113', 'auditor', true);

INSERT INTO public.petro_organizations (id, name, kind, status, created_by)
VALUES
  ('10000000-0000-4000-8000-000000000101', 'DB02 Org A', 'company', 'active',
   '00000000-0000-4000-8000-000000000101'),
  ('10000000-0000-4000-8000-000000000102', 'DB02 Org B', 'company', 'active',
   '00000000-0000-4000-8000-000000000106');

INSERT INTO public.petro_branches (id, organization_id, name, status)
VALUES
  ('20000000-0000-4000-8000-000000000101',
   '10000000-0000-4000-8000-000000000101', 'DB02 A Branch 1', 'active'),
  ('20000000-0000-4000-8000-000000000102',
   '10000000-0000-4000-8000-000000000101', 'DB02 A Branch 2', 'active'),
  ('20000000-0000-4000-8000-000000000103',
   '10000000-0000-4000-8000-000000000102', 'DB02 B Branch 1', 'active');

INSERT INTO public.petro_memberships
  (id, user_id, organization_id, role, scope, active)
VALUES
  ('30000000-0000-4000-8000-000000000101',
   '00000000-0000-4000-8000-000000000101',
   '10000000-0000-4000-8000-000000000101',
   'organization_owner', 'organization', true),
  ('30000000-0000-4000-8000-000000000102',
   '00000000-0000-4000-8000-000000000102',
   '10000000-0000-4000-8000-000000000101',
   'manager', 'organization', true),
  ('30000000-0000-4000-8000-000000000103',
   '00000000-0000-4000-8000-000000000103',
   '10000000-0000-4000-8000-000000000101',
   'manager', 'branches', true),
  ('30000000-0000-4000-8000-000000000104',
   '00000000-0000-4000-8000-000000000106',
   '10000000-0000-4000-8000-000000000102',
   'organization_owner', 'organization', true);

INSERT INTO public.petro_membership_branches
  (organization_id, membership_id, branch_id)
VALUES
  ('10000000-0000-4000-8000-000000000101',
   '30000000-0000-4000-8000-000000000103',
   '20000000-0000-4000-8000-000000000101');

-- Simulates a pending owner invitation created before DB-02 by a manager.
INSERT INTO public.petro_membership_invites
  (organization_id, invited_email, role, scope, branch_ids, token_hash,
   created_by, expires_at)
VALUES
  ('10000000-0000-4000-8000-000000000101',
   'legacy-owner-a@example.invalid', 'organization_owner', 'organization',
   '{}', repeat('d', 64), '00000000-0000-4000-8000-000000000102',
   now() + interval '1 day');

DO $acl$
DECLARE
  privilege_name text;
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM pg_class
       WHERE oid = 'public.petro_membership_invites'::regclass
         AND relrowsecurity
     )
     OR EXISTS (
       SELECT 1 FROM pg_policy
       WHERE polrelid = 'public.petro_membership_invites'::regclass
     ) THEN
    RAISE EXCEPTION 'invite table RLS must remain enabled with no direct policy';
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
      RAISE EXCEPTION 'direct invitation table privilege % remains', privilege_name;
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
     ) THEN
    RAISE EXCEPTION 'anon retains execute access to a protected RPC/helper';
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
       'authenticated', 'public.petro_revoke_invitation(uuid)', 'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated', 'petro_private.can_view_profile(uuid)', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'an authenticated application path lost required EXECUTE';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname LIKE 'petro_%'
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'anon can execute a public Pertomax RPC';
  END IF;
END
$acl$;

-- run-local-test.sh compares the complete pg_default_acl catalog before and
-- after each migration application. DB-02 intentionally leaves all defaults
-- unchanged; this test focuses on the explicit Pertomax resources below.

-- Platform owner can grant an organization role, but cannot pass its own
-- platform-role name through a membership or organization invitation.
SET LOCAL request.jwt.claim.sub = '00000000-0000-4000-8000-000000000109';
SET LOCAL ROLE authenticated;
DO $platform_owner_role_boundary$
BEGIN
  PERFORM public.petro_set_membership(
    '10000000-0000-4000-8000-000000000101',
    '00000000-0000-4000-8000-000000000107',
    'organization_owner',
    'organization',
    '{}',
    true
  );

  BEGIN
    PERFORM public.petro_set_membership(
      '10000000-0000-4000-8000-000000000101',
      '00000000-0000-4000-8000-000000000107',
      'owner',
      'organization',
      '{}',
      true
    );
    RAISE EXCEPTION 'platform owner role was assigned as organization membership';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;

  BEGIN
    PERFORM public.petro_create_invitation(
      '10000000-0000-4000-8000-000000000101',
      'platform-owner-role@example.invalid',
      'owner',
      'organization',
      '{}',
      repeat('9', 64)
    );
    RAISE EXCEPTION 'platform owner role was issued through organization invitation';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
END
$platform_owner_role_boundary$;
RESET ROLE;

-- The actual platform operations role is an existing grantor role; the
-- invitation still creates only an organization membership for its recipient.
SET LOCAL request.jwt.claim.sub = '00000000-0000-4000-8000-000000000110';
SET LOCAL ROLE authenticated;
SELECT public.petro_create_invitation(
  '10000000-0000-4000-8000-000000000101',
  'operations-invitee@example.invalid',
  'organization_owner',
  'organization',
  '{}',
  repeat('e', 64)
);
RESET ROLE;
SET LOCAL request.jwt.claim.sub = '00000000-0000-4000-8000-000000000114';
SET LOCAL ROLE authenticated;
SELECT public.petro_accept_invitation(repeat('e', 64));
DO $operations_invite_scope$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM public.petro_memberships
       WHERE user_id = auth.uid()
         AND organization_id = '10000000-0000-4000-8000-000000000101'
         AND role = 'organization_owner'
         AND scope = 'organization'
     )
     OR EXISTS (
       SELECT 1 FROM public.petro_platform_roles
       WHERE user_id = auth.uid()
     ) THEN
    RAISE EXCEPTION 'organization invitation changed or assigned a platform role';
  END IF;
END
$operations_invite_scope$;
RESET ROLE;

-- Other existing platform roles are not organization-owner grantors.
SET LOCAL ROLE authenticated;
DO $platform_non_grantors$
DECLARE
  actor_id uuid;
BEGIN
  FOREACH actor_id IN ARRAY ARRAY[
    '00000000-0000-4000-8000-000000000111'::uuid,
    '00000000-0000-4000-8000-000000000112'::uuid,
    '00000000-0000-4000-8000-000000000113'::uuid
  ] LOOP
    PERFORM set_config('request.jwt.claim.sub', actor_id::text, true);
    BEGIN
      PERFORM public.petro_create_invitation(
        '10000000-0000-4000-8000-000000000101',
        'non-grantor-role@example.invalid',
        'organization_owner',
        'organization',
        '{}',
        repeat('8', 64)
      );
      RAISE EXCEPTION 'platform finance/support/auditor granted organization ownership';
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;
  END LOOP;
END
$platform_non_grantors$;
RESET ROLE;

-- Direct table access is denied; authorized invitation RPC remains usable.
SET LOCAL request.jwt.claim.sub = '00000000-0000-4000-8000-000000000102';
SET LOCAL ROLE authenticated;
DO $manager_direct$
BEGIN
  IF has_table_privilege(current_user, 'public.petro_membership_invites', 'SELECT')
     OR has_table_privilege(current_user, 'public.petro_membership_invites', 'INSERT') THEN
    RAISE EXCEPTION 'authenticated has direct invite-table privilege';
  END IF;

  BEGIN
    PERFORM 1 FROM public.petro_membership_invites;
    RAISE EXCEPTION 'direct invitation SELECT unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    INSERT INTO public.petro_membership_invites
      (organization_id, invited_email, role, scope, token_hash, created_by, expires_at)
    VALUES
      ('10000000-0000-4000-8000-000000000101',
       'direct@example.invalid', 'worker', 'organization', repeat('e', 64),
       '00000000-0000-4000-8000-000000000102', now() + interval '1 day');
    RAISE EXCEPTION 'direct invitation INSERT unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$manager_direct$;

SELECT public.petro_create_invitation(
  '10000000-0000-4000-8000-000000000101',
  'worker-a@example.invalid',
  'worker',
  'branches',
  ARRAY['20000000-0000-4000-8000-000000000101'::uuid],
  repeat('a', 64)
) AS manager_invite_id
\gset
SELECT set_config('db02.manager_invite_id', :'manager_invite_id', true);

DO $manager_authorized$
BEGIN
  IF (SELECT count(*) FROM public.petro_list_invitations(
        '10000000-0000-4000-8000-000000000101'
      )) <> 3 THEN
    RAISE EXCEPTION 'authorized organization manager cannot list scoped invitations';
  END IF;

  BEGIN
    PERFORM public.petro_create_invitation(
      '10000000-0000-4000-8000-000000000101',
      'escalation@example.invalid',
      'organization_owner',
      'organization',
      '{}',
      repeat('f', 64)
    );
    RAISE EXCEPTION 'manager-created organization-owner invitation was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    PERFORM public.petro_set_membership(
      '10000000-0000-4000-8000-000000000101',
      '00000000-0000-4000-8000-000000000107',
      'organization_owner',
      'organization',
      '{}',
      true
    );
    RAISE EXCEPTION 'manager assigned organization-owner role';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    PERFORM public.petro_set_membership(
      '10000000-0000-4000-8000-000000000101',
      auth.uid(),
      'organization_owner',
      'organization',
      '{}',
      true
    );
    RAISE EXCEPTION 'manager promoted its own account to organization owner';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    PERFORM public.petro_set_membership(
      '10000000-0000-4000-8000-000000000101',
      '00000000-0000-4000-8000-000000000107',
      'worker',
      'branches',
      ARRAY['20000000-0000-4000-8000-000000000103'::uuid],
      true
    );
    RAISE EXCEPTION 'manager assigned a branch from another organization';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$manager_authorized$;
RESET ROLE;

-- A branch-scoped manager cannot manage organization-wide invitations.
SET LOCAL request.jwt.claim.sub = '00000000-0000-4000-8000-000000000103';
SET LOCAL ROLE authenticated;
DO $branch_manager_denied$
BEGIN
  BEGIN
    PERFORM public.petro_create_invitation(
      '10000000-0000-4000-8000-000000000101',
      'branch-manager@example.invalid',
      'worker',
      'branches',
      ARRAY['20000000-0000-4000-8000-000000000101'::uuid],
      repeat('b', 64)
    );
    RAISE EXCEPTION 'branch-scoped manager created an organization invitation';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$branch_manager_denied$;
RESET ROLE;

-- A different organization's owner cannot inspect or revoke Org A invites.
SET LOCAL request.jwt.claim.sub = '00000000-0000-4000-8000-000000000106';
SET LOCAL ROLE authenticated;
DO $cross_org_denied$
DECLARE invite_id uuid := current_setting('db02.manager_invite_id')::uuid;
BEGIN
  BEGIN
    PERFORM 1 FROM public.petro_list_invitations(
      '10000000-0000-4000-8000-000000000101'
    );
    RAISE EXCEPTION 'cross-organization invitation listing was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    PERFORM public.petro_revoke_invitation(invite_id);
    RAISE EXCEPTION 'cross-organization invitation revoke was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    PERFORM public.petro_create_invitation(
      '10000000-0000-4000-8000-000000000101',
      'cross-organization-owner@example.invalid',
      'organization_owner',
      'organization',
      '{}',
      repeat('7', 64)
    );
    RAISE EXCEPTION 'an organization owner granted ownership in another organization';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$cross_org_denied$;
RESET ROLE;

-- The manager retains normal invitation creation/list/revoke rights.
SET LOCAL request.jwt.claim.sub = '00000000-0000-4000-8000-000000000102';
SET LOCAL ROLE authenticated;
SELECT public.petro_revoke_invitation(
  current_setting('db02.manager_invite_id')::uuid
);
DO $revoke_verified$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.petro_list_invitations(
      '10000000-0000-4000-8000-000000000101'
    ) i
    WHERE i.id = current_setting('db02.manager_invite_id')::uuid
      AND i.revoked_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'authorized invitation revocation did not persist';
  END IF;
END
$revoke_verified$;
RESET ROLE;

-- A valid manager-created worker invitation can be accepted once by the
-- confirmed account with the matching email, and receives only branch A1.
SET LOCAL request.jwt.claim.sub = '00000000-0000-4000-8000-000000000102';
SET LOCAL ROLE authenticated;
SELECT public.petro_create_invitation(
  '10000000-0000-4000-8000-000000000101',
  'worker-a@example.invalid',
  'worker',
  'branches',
  ARRAY['20000000-0000-4000-8000-000000000101'::uuid],
  repeat('b', 64)
);
RESET ROLE;

SET LOCAL request.jwt.claim.sub = '00000000-0000-4000-8000-000000000104';
SET LOCAL ROLE authenticated;
SELECT public.petro_accept_invitation(repeat('b', 64));
DO $second_accept_denied$
BEGIN
  BEGIN
    PERFORM public.petro_accept_invitation(repeat('b', 64));
    RAISE EXCEPTION 'invitation token was accepted twice';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$second_accept_denied$;

DO $worker_isolation$
DECLARE visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count FROM public.petro_organizations;
  IF visible_count <> 1 OR NOT EXISTS (
    SELECT 1
    FROM public.petro_organizations
    WHERE id = '10000000-0000-4000-8000-000000000101'
  ) THEN
    RAISE EXCEPTION 'invited worker did not receive only the invited organization';
  END IF;

  SELECT count(*) INTO visible_count FROM public.petro_branches;
  IF visible_count <> 1 OR NOT EXISTS (
    SELECT 1
    FROM public.petro_branches
    WHERE id = '20000000-0000-4000-8000-000000000101'
  ) OR EXISTS (
    SELECT 1 FROM public.petro_branches
    WHERE id IN (
      '20000000-0000-4000-8000-000000000102',
      '20000000-0000-4000-8000-000000000103'
    )
  ) THEN
    RAISE EXCEPTION 'invited worker branch isolation failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.petro_memberships
    WHERE user_id = auth.uid()
      AND organization_id = '10000000-0000-4000-8000-000000000101'
      AND role = 'worker'
      AND scope = 'branches'
  ) THEN
    RAISE EXCEPTION 'invitation did not create the expected limited membership';
  END IF;
END
$worker_isolation$;
RESET ROLE;

-- Only a full-scope organization owner may issue or assign another owner.
SET LOCAL request.jwt.claim.sub = '00000000-0000-4000-8000-000000000101';
SET LOCAL ROLE authenticated;
SELECT public.petro_set_membership(
  '10000000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000107',
  'organization_owner',
  'organization',
  '{}',
  true
);
DO $owner_scope_guard$
BEGIN
  BEGIN
    PERFORM public.petro_set_membership(
      '10000000-0000-4000-8000-000000000101',
      '00000000-0000-4000-8000-000000000107',
      'organization_owner',
      'branches',
      ARRAY['20000000-0000-4000-8000-000000000101'::uuid],
      true
    );
    RAISE EXCEPTION 'branch-scoped organization owner role was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
END
$owner_scope_guard$;
SELECT public.petro_create_invitation(
  '10000000-0000-4000-8000-000000000101',
  'co-owner-a@example.invalid',
  'organization_owner',
  'organization',
  '{}',
  repeat('c', 64)
);
RESET ROLE;

-- A pre-existing owner invite from a manager is rejected at acceptance.
SET LOCAL request.jwt.claim.sub = '00000000-0000-4000-8000-000000000108';
SET LOCAL ROLE authenticated;
DO $legacy_owner_invite_denied$
BEGIN
  BEGIN
    PERFORM public.petro_accept_invitation(repeat('d', 64));
    RAISE EXCEPTION 'legacy manager-created owner invitation was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$legacy_owner_invite_denied$;
RESET ROLE;

-- Wrong email is denied; a valid owner-created invite succeeds once.
SET LOCAL request.jwt.claim.sub = '00000000-0000-4000-8000-000000000106';
SET LOCAL ROLE authenticated;
DO $wrong_email_denied$
BEGIN
  BEGIN
    PERFORM public.petro_accept_invitation(repeat('c', 64));
    RAISE EXCEPTION 'invitation was accepted by the wrong email';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$wrong_email_denied$;
RESET ROLE;

SET LOCAL request.jwt.claim.sub = '00000000-0000-4000-8000-000000000105';
SET LOCAL ROLE authenticated;
SELECT public.petro_accept_invitation(repeat('c', 64));
DO $owner_invite_verified$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.petro_memberships
    WHERE user_id = auth.uid()
      AND organization_id = '10000000-0000-4000-8000-000000000101'
      AND role = 'organization_owner'
      AND scope = 'organization'
  ) OR EXISTS (
    SELECT 1 FROM public.petro_platform_roles
    WHERE user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'organization owner invitation changed or assigned a platform role';
  END IF;
END
$owner_invite_verified$;
RESET ROLE;

-- Existing RLS tenant isolation remains effective for Org B's owner.
SET LOCAL request.jwt.claim.sub = '00000000-0000-4000-8000-000000000106';
SET LOCAL ROLE authenticated;
DO $org_b_isolation$
DECLARE visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count FROM public.petro_organizations;
  IF visible_count <> 1 OR NOT EXISTS (
    SELECT 1
    FROM public.petro_organizations
    WHERE id = '10000000-0000-4000-8000-000000000102'
  ) THEN
    RAISE EXCEPTION 'organization B isolation failed after DB-02';
  END IF;
END
$org_b_isolation$;
RESET ROLE;

-- Anon cannot use the RPC or the underlying table directly.
SET LOCAL ROLE anon;
DO $anon_denied$
BEGIN
  IF has_table_privilege(current_user, 'public.petro_membership_invites', 'SELECT')
     OR has_table_privilege(current_user, 'public.petro_membership_invites', 'INSERT')
     OR has_function_privilege(
       current_user,
       'public.petro_create_invitation(uuid,text,text,text,uuid[],text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'anon retains a direct invite privilege';
  END IF;

  BEGIN
    PERFORM 1 FROM public.petro_membership_invites;
    RAISE EXCEPTION 'anon direct invitation SELECT unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    PERFORM public.petro_create_invitation(
      '10000000-0000-4000-8000-000000000101',
      'anon@example.invalid',
      'worker',
      'organization',
      '{}',
      repeat('9', 64)
    );
    RAISE EXCEPTION 'anon invitation RPC unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$anon_denied$;

ROLLBACK;
