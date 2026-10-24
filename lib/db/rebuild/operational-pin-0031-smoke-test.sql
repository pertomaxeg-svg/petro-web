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

CREATE TEMP TABLE operational_proof_test(id uuid) ON COMMIT DROP;
INSERT INTO pg_temp.operational_proof_test VALUES(NULL);
GRANT SELECT,UPDATE ON pg_temp.operational_proof_test TO authenticated;
INSERT INTO public.petro_fleet_vehicles(id,organization_id,branch_id,plate_original,plate_standard,vehicle_category,vehicle_type,brand,model,fuel_type,created_by,updated_by)
VALUES('00000000-0000-4000-8000-000000003101','00000000-0000-4000-8000-000000003013','00000000-0000-4000-8000-000000003024','OP-PIN-TEST','OP-PIN-TEST','car','car','test','test','petrol','00000000-0000-4000-8000-000000003001','00000000-0000-4000-8000-000000003001');
INSERT INTO public.petro_fleet_drivers(id,organization_id,driver_code,full_name,created_by,updated_by)
VALUES('00000000-0000-4000-8000-000000003102','00000000-0000-4000-8000-000000003013','OP-PIN-DRIVER','سائق تشغيل اختباري','00000000-0000-4000-8000-000000003001','00000000-0000-4000-8000-000000003001');
INSERT INTO public.petro_fleet_driver_links(id,organization_id,vehicle_id,driver_id,reason,created_by)
VALUES('00000000-0000-4000-8000-000000003103','00000000-0000-4000-8000-000000003013','00000000-0000-4000-8000-000000003101','00000000-0000-4000-8000-000000003102','اختبار تحقق التشغيل','00000000-0000-4000-8000-000000003001');
INSERT INTO petro_private.petro_fleet_driver_pair_secrets(id,link_id,organization_id,vehicle_id,driver_id,pin_hmac,created_by)
VALUES('00000000-0000-4000-8000-000000003104','00000000-0000-4000-8000-000000003103','00000000-0000-4000-8000-000000003013','00000000-0000-4000-8000-000000003101','00000000-0000-4000-8000-000000003102',decode(repeat('b',64),'hex'),'00000000-0000-4000-8000-000000003001');
INSERT INTO public.petro_vehicle_credentials(id,organization_id,branch_id,vehicle_id,credential_type,token_sha256,token_hint,status,activated_by,reason)
VALUES('00000000-0000-4000-8000-000000003105','00000000-0000-4000-8000-000000003013','00000000-0000-4000-8000-000000003024','00000000-0000-4000-8000-000000003101','qr',repeat('a',64),'aaaaaa','active','00000000-0000-4000-8000-000000003001','اختبار تعريف التشغيل');
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000003001';
SELECT public.petro_admin_worker_assignment('00000000-0000-4000-8000-000000003002','00000000-0000-4000-8000-000000003021','fuel',true,0,'op-pin-worker-assignment');
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000003002';
DO $operational_pin$
DECLARE context jsonb; bad jsonb; replay jsonb; good jsonb;
BEGIN
 context:=public.petro_worker_credential_context('00000000-0000-4000-8000-000000003021','fuel',repeat('a',64));
 IF context->>'vehicleId' IS DISTINCT FROM '00000000-0000-4000-8000-000000003101' OR context ?| ARRAY['plate','driverName','wallet','balance','pinCode','pinHmac'] THEN
 RAISE EXCEPTION 'Pre-PIN context missing or disclosed fleet/secret data'; END IF;
 BEGIN
 PERFORM public.petro_worker_credential_context('00000000-0000-4000-8000-000000003022','fuel',repeat('a',64));
 RAISE EXCEPTION 'Credential resolution bypassed branch assignment';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 bad:=public.petro_worker_verify_pair('00000000-0000-4000-8000-000000003021','fuel',repeat('a',64),repeat('c',64),'op-pin-wrong-attempt-001');
 replay:=public.petro_worker_verify_pair('00000000-0000-4000-8000-000000003021','fuel',repeat('a',64),repeat('c',64),'op-pin-wrong-attempt-001');
 IF bad->>'valid' IS DISTINCT FROM 'false' OR bad IS DISTINCT FROM replay THEN RAISE EXCEPTION 'Failed PIN retry was not safe'; END IF;
END $operational_pin$;
RESET ROLE;
DO $retry_counter$ BEGIN
 IF (SELECT failed_attempts FROM petro_private.petro_fleet_pair_rate_limits WHERE vehicle_id='00000000-0000-4000-8000-000000003101')<>1 THEN
 RAISE EXCEPTION 'Network retry consumed multiple PIN attempts'; END IF;
END $retry_counter$;
SET LOCAL ROLE authenticated;
DO $correct_pin$
DECLARE good jsonb;replay jsonb;
BEGIN
 good:=public.petro_worker_verify_pair('00000000-0000-4000-8000-000000003021','fuel',repeat('a',64),repeat('b',64),'op-pin-correct-attempt-001');
 IF good->>'valid' IS DISTINCT FROM 'true' OR good->'vehicle'->>'plate' IS DISTINCT FROM 'OP-PIN-TEST' OR good->>'driverName' IS DISTINCT FROM 'سائق تشغيل اختباري'
 OR good::text ILIKE '%pinHmac%' OR good::text ILIKE '%pinCode%' OR good::text ILIKE '%balance%' THEN RAISE EXCEPTION 'Valid PIN proof or limited data failed: %',good; END IF;
 UPDATE pg_temp.operational_proof_test SET id=(good->>'verificationId')::uuid;
 replay:=public.petro_worker_verify_pair('00000000-0000-4000-8000-000000003021','fuel',repeat('a',64),repeat('b',64),'op-pin-correct-attempt-001');
 IF replay->>'verificationId'<>good->>'verificationId' THEN RAISE EXCEPTION 'PIN retry minted a second proof'; END IF;
END $correct_pin$;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000003001';
DO $other_actor$ BEGIN
 IF public.petro_worker_pin_proof((SELECT id FROM pg_temp.operational_proof_test))->>'valid' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Proof reused by another actor'; END IF;
END $other_actor$;
SELECT public.petro_admin_worker_assignment('00000000-0000-4000-8000-000000003002','00000000-0000-4000-8000-000000003021','fuel',false,1,'op-pin-stop-assignment');
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000003002';
DO $revoked_assignment$ BEGIN
 IF public.petro_worker_pin_proof((SELECT id FROM pg_temp.operational_proof_test))->>'valid' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Stopped assignment retained a proof'; END IF;
END $revoked_assignment$;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000003001';
SELECT public.petro_admin_worker_assignment('00000000-0000-4000-8000-000000003002','00000000-0000-4000-8000-000000003021','fuel',true,2,'op-pin-reactivate-assignment');
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000003002';
DO $changed_assignment$ BEGIN
 IF public.petro_worker_pin_proof((SELECT id FROM pg_temp.operational_proof_test))->>'valid' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Old assignment version proof revived'; END IF;
END $changed_assignment$;
DO $fresh_proof$
DECLARE good jsonb;
BEGIN
 good:=public.petro_worker_verify_pair('00000000-0000-4000-8000-000000003021','fuel',repeat('a',64),repeat('b',64),'op-pin-correct-attempt-002');
 IF good->>'valid' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'New assignment could not verify'; END IF;
 UPDATE pg_temp.operational_proof_test SET id=(good->>'verificationId')::uuid;
END $fresh_proof$;
RESET ROLE;
UPDATE petro_private.worker_pin_proofs SET created_at=clock_timestamp()-interval '3 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE id=(SELECT id FROM pg_temp.operational_proof_test);
SET LOCAL ROLE authenticated;
DO $expired_proof$ BEGIN
 IF public.petro_worker_pin_proof((SELECT id FROM pg_temp.operational_proof_test))->>'valid' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Expired proof survived'; END IF;
END $expired_proof$;
DO $rotated_proof$ DECLARE good jsonb; BEGIN
 good:=public.petro_worker_verify_pair('00000000-0000-4000-8000-000000003021','fuel',repeat('a',64),repeat('b',64),'op-pin-correct-attempt-003');
 UPDATE pg_temp.operational_proof_test SET id=(good->>'verificationId')::uuid;
END $rotated_proof$;
RESET ROLE;
UPDATE petro_private.petro_fleet_driver_pair_secrets SET active=false,disabled_at=now(),disabled_by='00000000-0000-4000-8000-000000003001' WHERE id='00000000-0000-4000-8000-000000003104';
SET LOCAL ROLE authenticated;
DO $rotated_secret$ BEGIN
 IF public.petro_worker_pin_proof((SELECT id FROM pg_temp.operational_proof_test))->>'valid' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Rotated PIN secret retained old proof'; END IF;
END $rotated_secret$;
RESET ROLE;
UPDATE petro_private.petro_fleet_driver_pair_secrets SET active=true,disabled_at=NULL,disabled_by=NULL WHERE id='00000000-0000-4000-8000-000000003104';
SET LOCAL ROLE authenticated;
DO $lockout$
DECLARE result jsonb; i integer;
BEGIN
 FOR i IN 1..5 LOOP
  result:=public.petro_worker_verify_pair('00000000-0000-4000-8000-000000003021','fuel',repeat('a',64),repeat('c',64),'op-pin-lock-attempt-'||i::text);
  IF result->>'valid' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Wrong PIN accepted'; END IF;
 END LOOP;
 IF result->>'locked' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Five-attempt lockout missing'; END IF;
 result:=public.petro_worker_verify_pair('00000000-0000-4000-8000-000000003021','fuel',repeat('a',64),repeat('b',64),'op-pin-locked-correct-attempt');
 IF result->>'valid' IS DISTINCT FROM 'false' OR result->>'locked' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Correct PIN bypassed active lockout'; END IF;
END $lockout$;
RESET ROLE;
ROLLBACK;
