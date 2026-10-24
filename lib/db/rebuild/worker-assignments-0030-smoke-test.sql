-- Disposable PostgreSQL acceptance only; never run on the live project.
BEGIN;
INSERT INTO auth.users(id,email,raw_user_meta_data,email_confirmed_at) VALUES
('00000000-0000-4000-8000-000000003001','worker-owner@example.invalid','{"username":"worker_owner","display_name":"Worker Owner"}',now()),
('00000000-0000-4000-8000-000000003002','worker-staff@example.invalid','{"username":"worker_staff","display_name":"Worker Staff"}',now()),
('00000000-0000-4000-8000-000000003003','worker-viewer@example.invalid','{"username":"worker_viewer","display_name":"Worker Viewer"}',now());
UPDATE public.petro_profiles SET active=true,account_status='active'
WHERE user_id IN ('00000000-0000-4000-8000-000000003001','00000000-0000-4000-8000-000000003002','00000000-0000-4000-8000-000000003003');
INSERT INTO public.petro_platform_roles(user_id,role,active) VALUES('00000000-0000-4000-8000-000000003001','owner',true);
INSERT INTO public.petro_organizations(id,name,kind,code,status,approval_status,operational_status,created_by) VALUES
('00000000-0000-4000-8000-000000003011','محطة العمال','station','WORKER-ST','active','approved','active','00000000-0000-4000-8000-000000003001'),
('00000000-0000-4000-8000-000000003012','مقدم العمال','provider','WORKER-PR','active','approved','active','00000000-0000-4000-8000-000000003001'),
('00000000-0000-4000-8000-000000003013','شركة العمال','company','WORKER-CO','active','approved','active','00000000-0000-4000-8000-000000003001');
INSERT INTO public.petro_branches(id,organization_id,name,code,status,approval_status,operational_status) VALUES
('00000000-0000-4000-8000-000000003021','00000000-0000-4000-8000-000000003011','فرع العامل','WORKER-ST-A','active','approved','active'),
('00000000-0000-4000-8000-000000003022','00000000-0000-4000-8000-000000003011','فرع آخر','WORKER-ST-B','active','approved','active'),
('00000000-0000-4000-8000-000000003023','00000000-0000-4000-8000-000000003012','فرع المقدم','WORKER-PR-A','active','approved','active'),
('00000000-0000-4000-8000-000000003024','00000000-0000-4000-8000-000000003013','فرع الشركة','WORKER-CO-A','active','approved','active');
INSERT INTO public.petro_memberships(id,user_id,organization_id,role,scope,active) VALUES
('00000000-0000-4000-8000-000000003031','00000000-0000-4000-8000-000000003002','00000000-0000-4000-8000-000000003011','worker','branches',true),
('00000000-0000-4000-8000-000000003032','00000000-0000-4000-8000-000000003002','00000000-0000-4000-8000-000000003012','worker','branches',true),
('00000000-0000-4000-8000-000000003033','00000000-0000-4000-8000-000000003002','00000000-0000-4000-8000-000000003013','worker','branches',true),
('00000000-0000-4000-8000-000000003034','00000000-0000-4000-8000-000000003003','00000000-0000-4000-8000-000000003011','viewer','branches',true);
INSERT INTO public.petro_membership_branches(organization_id,membership_id,branch_id) VALUES
('00000000-0000-4000-8000-000000003011','00000000-0000-4000-8000-000000003031','00000000-0000-4000-8000-000000003021'),
('00000000-0000-4000-8000-000000003012','00000000-0000-4000-8000-000000003032','00000000-0000-4000-8000-000000003023'),
('00000000-0000-4000-8000-000000003013','00000000-0000-4000-8000-000000003033','00000000-0000-4000-8000-000000003024'),
('00000000-0000-4000-8000-000000003011','00000000-0000-4000-8000-000000003034','00000000-0000-4000-8000-000000003021');
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000003001';
DO $assignment$
DECLARE first_result jsonb; replay jsonb;
BEGIN
 first_result:=public.petro_admin_worker_assignment('00000000-0000-4000-8000-000000003002','00000000-0000-4000-8000-000000003021','fuel',true,0,'worker-test-create');
 replay:=public.petro_admin_worker_assignment('00000000-0000-4000-8000-000000003002','00000000-0000-4000-8000-000000003021','fuel',true,0,'worker-test-create');
 IF first_result IS DISTINCT FROM replay OR first_result->>'version'<>'1' THEN RAISE EXCEPTION 'Assignment replay/version failed'; END IF;
 BEGIN PERFORM public.petro_admin_worker_assignment('00000000-0000-4000-8000-000000003002','00000000-0000-4000-8000-000000003021','fuel',false,1,'worker-test-create'); RAISE EXCEPTION 'Changed replay accepted'; EXCEPTION WHEN serialization_failure THEN NULL; END;
 BEGIN PERFORM public.petro_admin_worker_assignment('00000000-0000-4000-8000-000000003002','00000000-0000-4000-8000-000000003021','fuel',false,0,'worker-test-stale'); RAISE EXCEPTION 'Stale version accepted'; EXCEPTION WHEN serialization_failure THEN NULL; END;
 BEGIN PERFORM public.petro_admin_worker_assignment('00000000-0000-4000-8000-000000003002','00000000-0000-4000-8000-000000003022','fuel',true,0,'worker-test-cross-branch'); RAISE EXCEPTION 'Unassigned branch accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM public.petro_admin_worker_assignment('00000000-0000-4000-8000-000000003002','00000000-0000-4000-8000-000000003023','fuel',true,0,'worker-test-provider-fuel'); RAISE EXCEPTION 'Provider fuel accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN PERFORM public.petro_admin_worker_assignment('00000000-0000-4000-8000-000000003002','00000000-0000-4000-8000-000000003024','wash',true,0,'worker-test-company'); RAISE EXCEPTION 'Company operation accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN PERFORM public.petro_admin_worker_assignment('00000000-0000-4000-8000-000000003003','00000000-0000-4000-8000-000000003021','wash',true,0,'worker-test-viewer'); RAISE EXCEPTION 'Viewer execution assigned'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $assignment$;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000003002';
DO $worker$ BEGIN
 IF jsonb_array_length(public.petro_worker_capabilities()->'items')<>1 THEN RAISE EXCEPTION 'Worker capability missing'; END IF;
 BEGIN PERFORM public.petro_admin_worker_assignment('00000000-0000-4000-8000-000000003002','00000000-0000-4000-8000-000000003021','wash',true,0,'worker-test-self'); RAISE EXCEPTION 'Worker self assignment accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM public.petro_admin_fleet_catalog('vehicles','{}'); RAISE EXCEPTION 'Worker gained admin fleet read'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $worker$;
RESET ROLE;
UPDATE public.petro_memberships SET active=false WHERE id='00000000-0000-4000-8000-000000003031';
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000003002';
DO $revoked$ BEGIN
 IF jsonb_array_length(public.petro_worker_capabilities()->'items')<>0 THEN RAISE EXCEPTION 'Revoked membership retained capability'; END IF;
END $revoked$;
RESET ROLE;
ROLLBACK;
