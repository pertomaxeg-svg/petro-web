-- Disposable synthetic acceptance checks for 0014 only.
-- This file runs exclusively against the temporary PostgreSQL cluster created by run-local-test.sh.
BEGIN;

CREATE TEMP TABLE fleet_test_ids (
  owner_id uuid,
  auditor_id uuid,
  org_a uuid,
  org_b uuid,
  branch_a1 uuid,
  branch_a2 uuid,
  branch_b uuid,
  vehicle_id uuid,
  driver_id uuid,
  link_id uuid
) ON COMMIT DROP;
GRANT SELECT, UPDATE ON pg_temp.fleet_test_ids TO authenticated;
INSERT INTO pg_temp.fleet_test_ids VALUES (
  '00000000-0000-4000-8000-000000000801',
  '00000000-0000-4000-8000-000000000802',
  '00000000-0000-4000-8000-000000000811',
  '00000000-0000-4000-8000-000000000812',
  '00000000-0000-4000-8000-000000000821',
  '00000000-0000-4000-8000-000000000822',
  '00000000-0000-4000-8000-000000000823',
  NULL,NULL,NULL
);

INSERT INTO auth.users(id,email,raw_user_meta_data,email_confirmed_at)
VALUES
  ('00000000-0000-4000-8000-000000000801','fleet-owner@example.invalid',
    '{"username":"fleet_owner","display_name":"Fleet Owner"}',now()),
  ('00000000-0000-4000-8000-000000000802','fleet-auditor@example.invalid',
    '{"username":"fleet_auditor","display_name":"Fleet Auditor"}',now());
UPDATE public.petro_profiles SET active=true,account_status='active'
WHERE user_id IN ('00000000-0000-4000-8000-000000000801','00000000-0000-4000-8000-000000000802');
INSERT INTO public.petro_platform_roles(user_id,role,active)
VALUES
  ('00000000-0000-4000-8000-000000000801','owner',true),
  ('00000000-0000-4000-8000-000000000802','auditor',true);

INSERT INTO public.petro_organizations(
  id,name,kind,code,status,approval_status,operational_status,created_by
) VALUES
  ('00000000-0000-4000-8000-000000000811','أسطول اختبار أ','company','FLEET-TEST-A','active','approved','active',
   '00000000-0000-4000-8000-000000000801'),
  ('00000000-0000-4000-8000-000000000812','أسطول اختبار ب','company','FLEET-TEST-B','active','approved','active',
   '00000000-0000-4000-8000-000000000801'),
  ('00000000-0000-4000-8000-000000000813','محطة اختبار','station','FLEET-TEST-ST','active','approved','active',
   '00000000-0000-4000-8000-000000000801');
INSERT INTO public.petro_branches(
  id,organization_id,name,code,status,approval_status,operational_status
) VALUES
  ('00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000811','فرع أ١','FLEET-A1','active','approved','active'),
  ('00000000-0000-4000-8000-000000000822','00000000-0000-4000-8000-000000000811','فرع أ٢','FLEET-A2','active','approved','active'),
  ('00000000-0000-4000-8000-000000000823','00000000-0000-4000-8000-000000000812','فرع ب','FLEET-B1','active','approved','active'),
  ('00000000-0000-4000-8000-000000000824','00000000-0000-4000-8000-000000000813','فرع محطة','FLEET-ST1','active','approved','active');

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000801';

DO $fleet_write_and_isolation$
DECLARE
  ids record;
  first_result jsonb;
  replay_result jsonb;
  vehicle_result jsonb;
  driver_result jsonb;
  link_result jsonb;
  verify_result jsonb;
  wrong_result jsonb;
  policy_result jsonb;
  publish_result jsonb;
  import_result jsonb;
  apply_result jsonb;
  bad_import_result jsonb;
  catalog_result jsonb;
  qr_request_result jsonb;
  qr_approval_result jsonb;
  qr_activation_result jsonb;
  qr_replace_result jsonb;
  nfc_request_result jsonb;
  nfc_approval_result jsonb;
  odometer_result jsonb;
  low_odometer_result jsonb;
  maintenance_result jsonb;
  qr_original_id uuid;
  catalog_view text;
  bad_job_id uuid;
  i integer;
BEGIN
  SELECT * INTO ids FROM pg_temp.fleet_test_ids;
  BEGIN
    INSERT INTO public.petro_fleet_vehicles(
      organization_id,branch_id,plate_original,plate_standard,vehicle_category,vehicle_type,
      brand,model,fuel_type,created_by,updated_by
    ) VALUES(ids.org_a,ids.branch_a1,'م س ١','MS1','sedan','car','Test','T1','petrol',ids.owner_id,ids.owner_id);
    RAISE EXCEPTION 'direct fleet table write was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  first_result := public.petro_admin_fleet_command(
    'vehicle.create',
    jsonb_build_object(
      'organizationId',ids.org_a,'branchId',ids.branch_a1,'plateOriginal','م س ١',
      'plateStandard','MS1','category','sedan','vehicleType','car','brand','Test','model','T1',
      'modelYear',2024,'chassisNumber','TEST-CHASSIS-1','internalCode','FLEET-A-1',
      'fuelType','petrol'
    ),
    'اختبار إنشاء مركبة',
    'fleet-smoke-vehicle-create-001'
  );
  IF first_result->>'status'<>'active' OR first_result->>'version'<>'1' THEN
    RAISE EXCEPTION 'vehicle creation returned an unexpected result: %',first_result;
  END IF;
  UPDATE pg_temp.fleet_test_ids SET vehicle_id=(first_result->>'id')::uuid;
  replay_result := public.petro_admin_fleet_command(
    'vehicle.create',
    jsonb_build_object(
      'organizationId',ids.org_a,'branchId',ids.branch_a1,'plateOriginal','م س ١',
      'plateStandard','MS1','category','sedan','vehicleType','car','brand','Test','model','T1',
      'modelYear',2024,'chassisNumber','TEST-CHASSIS-1','internalCode','FLEET-A-1',
      'fuelType','petrol'
    ),
    'اختبار إنشاء مركبة',
    'fleet-smoke-vehicle-create-001'
  );
  IF replay_result->>'replayed'<>'true' OR replay_result->>'id'<>first_result->>'id' THEN
    RAISE EXCEPTION 'vehicle idempotency did not replay the original result';
  END IF;
  BEGIN
    PERFORM public.petro_admin_fleet_command(
      'vehicle.create',
      jsonb_build_object(
        'organizationId',ids.org_a,'branchId',ids.branch_a1,'plateOriginal','م س ٢',
        'plateStandard','MS2','category','sedan','vehicleType','car','brand','Test','model','T2',
        'modelYear',2024,'chassisNumber','TEST-CHASSIS-2','internalCode','FLEET-A-2',
        'fuelType','petrol'
      ),
      'اختبار اختلاف المحتوى',
      'fleet-smoke-vehicle-create-001'
    );
    RAISE EXCEPTION 'different payload reused the same idempotency key';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  vehicle_result := public.petro_admin_fleet_command(
    'vehicle.move',
    jsonb_build_object('vehicleId',first_result->>'id','targetBranchId',ids.branch_a2,'expectedVersion',1),
    'اختبار نقل داخل الشركة',
    'fleet-smoke-vehicle-move-001'
  );
  IF vehicle_result->>'historyPreserved'<>'true' OR vehicle_result->>'branchId'<>ids.branch_a2::text THEN
    RAISE EXCEPTION 'same-company branch transfer did not preserve history';
  END IF;
  BEGIN
    PERFORM public.petro_admin_fleet_command(
      'vehicle.move',
      jsonb_build_object('vehicleId',first_result->>'id','targetBranchId',ids.branch_b,'expectedVersion',2),
      'اختبار عزل الشركة',
      'fleet-smoke-vehicle-move-cross-company'
    );
    RAISE EXCEPTION 'vehicle moved to a branch belonging to another company';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  driver_result := public.petro_admin_fleet_command(
    'driver.create',
    jsonb_build_object('organizationId',ids.org_a,'driverCode','D-001','fullName','سائق اختبار','phone','+201000000001'),
    'اختبار إنشاء سائق',
    'fleet-smoke-driver-create-001'
  );
  UPDATE pg_temp.fleet_test_ids SET driver_id=(driver_result->>'id')::uuid;
  link_result := public.petro_admin_fleet_command(
    'driver.link.create',
    jsonb_build_object(
      'vehicleId',first_result->>'id','driverId',driver_result->>'id',
      'pinHmac',repeat('a',64)
    ),
    'اختبار ربط سائق بمركبة',
    'fleet-smoke-driver-link-001'
  );
  UPDATE pg_temp.fleet_test_ids SET link_id=(link_result->>'id')::uuid;
  verify_result := public.petro_admin_fleet_verify_driver_pair((link_result->>'id')::uuid,repeat('a',64));
  IF verify_result->>'valid'<>'true' OR verify_result->>'verificationId' IS NULL THEN
    RAISE EXCEPTION 'correct driver-vehicle pair code did not verify';
  END IF;
  FOR i IN 1..5 LOOP
    wrong_result := public.petro_admin_fleet_verify_driver_pair((link_result->>'id')::uuid,repeat('b',64));
  END LOOP;
  IF wrong_result->>'locked'<>'true' THEN
    RAISE EXCEPTION 'pair verification did not apply the configured failed-attempt lock';
  END IF;
  policy_result := public.petro_admin_fleet_command(
    'policy.create',
    jsonb_build_object(
      'scope','branch','organizationId',ids.org_a,'branchId',ids.branch_a1,'vehicleId',NULL,
      'effectiveFrom',now()+interval '1 day','allowedWeekdays',jsonb_build_array(1,2,3,4,5,6,7),
      'startTime','08:00','endTime','22:00',
      'allowedMerchantOrganizationIds',jsonb_build_array('00000000-0000-4000-8000-000000000813'),
      'allowedMerchantBranchIds',jsonb_build_array('00000000-0000-4000-8000-000000000824'),
      'maxOperationMinor',1000000,'maxOperationQuantity',100,
      'dailyAmountLimitMinor',5000000,'weeklyAmountLimitMinor',10000000,'monthlyAmountLimitMinor',20000000,
      'dailyQuantityLimit',500,'weeklyQuantityLimit',1000,'monthlyQuantityLimit',2000,
      'rules',jsonb_build_array(
        jsonb_build_object('serviceGroup','fuel','enabled',true,'maxOperationMinor',100000,'maxOperationQuantity',20,'dailyAmountLimitMinor',500000,'weeklyAmountLimitMinor',1000000,'monthlyAmountLimitMinor',2000000,'dailyQuantityLimit',50,'weeklyQuantityLimit',100,'monthlyQuantityLimit',200),
        jsonb_build_object('serviceGroup','wash','enabled',true,'maxOperationMinor',100000,'maxOperationQuantity',20,'dailyAmountLimitMinor',500000,'weeklyAmountLimitMinor',1000000,'monthlyAmountLimitMinor',2000000,'dailyQuantityLimit',50,'weeklyQuantityLimit',100,'monthlyQuantityLimit',200),
        jsonb_build_object('serviceGroup','oils','enabled',true,'maxOperationMinor',100000,'maxOperationQuantity',20,'dailyAmountLimitMinor',500000,'weeklyAmountLimitMinor',1000000,'monthlyAmountLimitMinor',2000000,'dailyQuantityLimit',50,'weeklyQuantityLimit',100,'monthlyQuantityLimit',200),
        jsonb_build_object('serviceGroup','parts','enabled',true,'maxOperationMinor',100000,'maxOperationQuantity',20,'dailyAmountLimitMinor',500000,'weeklyAmountLimitMinor',1000000,'monthlyAmountLimitMinor',2000000,'dailyQuantityLimit',50,'weeklyQuantityLimit',100,'monthlyQuantityLimit',200)
      )
    ),
    'اختبار إنشاء سياسة مؤرخة',
    'fleet-smoke-policy-create-001'
  );
  publish_result := public.petro_admin_fleet_command(
    'policy.publish',jsonb_build_object('policyVersionId',policy_result->>'id'),
    'اختبار نشر سياسة مستقبلية','fleet-smoke-policy-publish-001'
  );
  IF publish_result->>'status'<>'published' THEN
    RAISE EXCEPTION 'valid future policy was not published';
  END IF;
  BEGIN
    PERFORM public.petro_admin_fleet_command(
      'policy.update',jsonb_build_object('policyVersionId',policy_result->>'id'),
      'اختبار منع تعديل نسخة منشورة','fleet-smoke-policy-update-closed'
    );
    RAISE EXCEPTION 'published policy version was mutable';
  EXCEPTION WHEN no_data_found THEN
    NULL;
  END;

  qr_request_result := public.petro_admin_fleet_command(
    'credential.request',jsonb_build_object(
      'vehicleId',first_result->>'id','credentialType','qr','requestType','issue'
    ),'طلب QR اصطناعي','fleet-smoke-qr-request'
  );
  qr_approval_result := public.petro_admin_fleet_command(
    'credential.approve',jsonb_build_object('requestId',qr_request_result->>'id','waive',false),
    'اعتماد طلب QR اصطناعي','fleet-smoke-qr-approve'
  );
  qr_activation_result := public.petro_admin_fleet_command(
    'credential.activate_qr',jsonb_build_object(
      'requestId',qr_request_result->>'id','tokenSha256',repeat('c',64),'tokenHint','abcdef'
    ),'تفعيل QR اصطناعي','fleet-smoke-qr-activate'
  );
  IF qr_approval_result->>'status'<>'approved' OR qr_activation_result->>'status'<>'active' THEN
    RAISE EXCEPTION 'approved QR request did not activate';
  END IF;
  qr_original_id := (qr_activation_result->>'id')::uuid;
  qr_replace_result := public.petro_admin_fleet_command(
    'credential.request',jsonb_build_object(
      'vehicleId',first_result->>'id','credentialType','qr','requestType','replace',
      'previousCredentialId',qr_activation_result->>'id'
    ),'طلب استبدال QR اصطناعي','fleet-smoke-qr-replace'
  );
  PERFORM public.petro_admin_fleet_command(
    'credential.approve',jsonb_build_object('requestId',qr_replace_result->>'id','waive',false),
    'اعتماد استبدال QR اصطناعي','fleet-smoke-qr-replace-approve'
  );
  BEGIN
    PERFORM public.petro_admin_fleet_command(
      'credential.activate_qr',jsonb_build_object(
        'requestId',qr_replace_result->>'id','tokenSha256',repeat('c',64),'tokenHint','abcdef'
      ),'اختبار فشل استبدال QR','fleet-smoke-qr-replace-fail'
    );
    RAISE EXCEPTION 'duplicate credential token was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
  qr_activation_result := public.petro_admin_fleet_command(
    'credential.activate_qr',jsonb_build_object(
      'requestId',qr_replace_result->>'id','tokenSha256',repeat('d',64),'tokenHint','fedcba'
    ),'تفعيل QR بديل اصطناعي','fleet-smoke-qr-replace-success'
  );
  IF qr_activation_result->>'status'<>'active' THEN
    RAISE EXCEPTION 'QR replacement did not atomically replace the old credential';
  END IF;
  BEGIN
    PERFORM public.petro_admin_fleet_command(
      'credential.stop',jsonb_build_object('credentialId',qr_original_id),
      'الرمز القديم لم يعد نشطًا','fleet-smoke-stop-replaced-qr'
    );
    RAISE EXCEPTION 'replaced QR credential remained active';
  EXCEPTION WHEN no_data_found THEN
    NULL;
  END;

  nfc_request_result := public.petro_admin_fleet_command(
    'credential.request',jsonb_build_object(
      'vehicleId',first_result->>'id','credentialType','nfc','requestType','issue'
    ),'طلب NFC اصطناعي بلا تحصيل','fleet-smoke-nfc-request'
  );
  nfc_approval_result := public.petro_admin_fleet_command(
    'credential.approve',jsonb_build_object('requestId',nfc_request_result->>'id','waive',false),
    'موافقة أولية على طلب NFC','fleet-smoke-nfc-approve'
  );
  BEGIN
    PERFORM public.petro_admin_fleet_command(
      'credential.activate_nfc',jsonb_build_object(
        'requestId',nfc_request_result->>'id','tokenSha256',repeat('e',64),'tokenHint','123abc'
      ),'رفض التفعيل دون قبض أو إثبات تركيب','fleet-smoke-nfc-block'
    );
    RAISE EXCEPTION 'NFC activated without collection or installation evidence';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  IF nfc_approval_result->>'paymentState'<>'awaiting_collection' THEN
    RAISE EXCEPTION 'uncollected NFC request became active';
  END IF;

  odometer_result := public.petro_admin_fleet_command(
    'odometer.record',jsonb_build_object(
      'vehicleId',first_result->>'id','readingKm',1000,'recordedAt',now(),'source','synthetic'
    ),'قراءة عداد اصطناعية','fleet-smoke-odometer-first'
  );
  low_odometer_result := public.petro_admin_fleet_command(
    'odometer.record',jsonb_build_object(
      'vehicleId',first_result->>'id','readingKm',900,'recordedAt',now(),'source','synthetic'
    ),'قراءة أقل للمراجعة','fleet-smoke-odometer-low'
  );
  IF odometer_result->>'status'<>'accepted' OR low_odometer_result->>'status'<>'pending_review' THEN
    RAISE EXCEPTION 'odometer regression did not enter review';
  END IF;
  PERFORM public.petro_admin_fleet_command(
    'odometer.review',jsonb_build_object('eventId',low_odometer_result->>'id','decision','rejected'),
    'رفض قراءة عداد غير موثوقة','fleet-smoke-odometer-review'
  );
  maintenance_result := public.petro_admin_fleet_command(
    'maintenance.create',jsonb_build_object(
      'vehicleId',first_result->>'id','maintenanceType','oil','performedAt',now(),
      'notes','synthetic test only','nextDueKm',2000
    ),'تسجيل صيانة اصطناعية','fleet-smoke-maintenance'
  );
  PERFORM public.petro_admin_fleet_command(
    'odometer.record',jsonb_build_object(
      'vehicleId',first_result->>'id','readingKm',2500,'recordedAt',now(),'source','synthetic'
    ),'قراءة تتجاوز استحقاق الصيانة','fleet-smoke-odometer-due'
  );
  IF maintenance_result->>'status'<>'recorded' THEN
    RAISE EXCEPTION 'maintenance record was not saved';
  END IF;

  import_result := public.petro_admin_fleet_command(
    'import.preview',
    jsonb_build_object(
      'vehicles',jsonb_build_array(jsonb_build_object(
        'organizationId',ids.org_a,'branchId',ids.branch_a1,'plateOriginal','م س ٣',
        'plateStandard','MS3','category','sedan','vehicleType','car','brand','Test','model','T3',
        'modelYear','2024','chassisNumber','TEST-CHASSIS-3','internalCode','FLEET-A-3','fuelType','petrol'
      )),
      'drivers',jsonb_build_array(jsonb_build_object(
        'organizationId',ids.org_a,'driverCode','D-003','fullName','سائق مستورد','phone','+201000000003'
      )),
      'policies','[]'::jsonb,'validationErrors','[]'::jsonb
    ),
    'اختبار معاينة استيراد',
    'fleet-smoke-import-preview-001'
  );
  IF jsonb_array_length(import_result->'validationErrors')<>0 THEN
    RAISE EXCEPTION 'valid synthetic import preview returned validation errors: %',import_result;
  END IF;
  apply_result := public.petro_admin_fleet_command(
    'import.apply',jsonb_build_object('jobId',import_result->>'id'),
    'اختبار تطبيق ذري',
    'fleet-smoke-import-apply-001'
  );
  IF apply_result->>'status'<>'applied' THEN RAISE EXCEPTION 'valid import was not applied atomically'; END IF;
  apply_result := public.petro_admin_fleet_command(
    'import.apply',jsonb_build_object('jobId',import_result->>'id'),
    'اختبار تطبيق ذري',
    'fleet-smoke-import-apply-001'
  );
  IF apply_result->>'replayed'<>'true' THEN RAISE EXCEPTION 'import retry did not replay original result'; END IF;
  bad_import_result := public.petro_admin_fleet_command(
    'import.preview',
    jsonb_build_object(
      'vehicles',jsonb_build_array(jsonb_build_object(
        'organizationId',ids.org_a,'branchId',ids.branch_a1,'plateOriginal','م س ١',
        'plateStandard','MS1','category','sedan','vehicleType','car','brand','Test','model','T1',
        'modelYear','2024','chassisNumber','TEST-CHASSIS-1','internalCode','FLEET-A-X','fuelType','petrol'
      )),
      'drivers','[]'::jsonb,'policies','[]'::jsonb,'validationErrors','[]'::jsonb
    ),
    'اختبار معاينة تعارض',
    'fleet-smoke-import-preview-duplicate'
  );
  bad_job_id := (bad_import_result->>'id')::uuid;
  IF jsonb_array_length(bad_import_result->'validationErrors')=0 THEN
    RAISE EXCEPTION 'duplicate existing vehicle was not identified during preview';
  END IF;
  BEGIN
    PERFORM public.petro_admin_fleet_command(
      'import.apply',jsonb_build_object('jobId',bad_job_id),
      'اختبار منع تطبيق متعارض','fleet-smoke-import-apply-duplicate'
    );
    RAISE EXCEPTION 'import with preview errors was applied';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  FOREACH catalog_view IN ARRAY ARRAY[
    'vehicles','drivers','policies','coverage','credentials','documents',
    'odometer','maintenance','events','imports'
  ] LOOP
    catalog_result := public.petro_admin_fleet_catalog(
      catalog_view,jsonb_build_object('page',1,'pageSize',1,'sort','oldest')
    );
    IF jsonb_typeof(catalog_result->'items')<>'array'
       OR catalog_result->>'pageSize'<>'1' THEN
      RAISE EXCEPTION 'paginated fleet catalog failed for view %: %',catalog_view,catalog_result;
    END IF;
  END LOOP;
  IF to_regclass('public.petro_vehicle_wallets') IS NOT NULL THEN
    RAISE EXCEPTION 'a vehicle wallet table exists in parallel to branch financing';
  END IF;
END
$fleet_write_and_isolation$;

RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000802';
DO $fleet_auditor_read_only$
DECLARE ids record; catalog_result jsonb;
BEGIN
  SELECT * INTO ids FROM pg_temp.fleet_test_ids;
  catalog_result := public.petro_admin_fleet_catalog('vehicles',jsonb_build_object('organizationId',ids.org_a));
  IF jsonb_typeof(catalog_result->'items')<>'array' THEN
    RAISE EXCEPTION 'auditor fleet catalog read did not return a list';
  END IF;
  BEGIN
    PERFORM public.petro_admin_fleet_command(
      'vehicle.status',
      jsonb_build_object('vehicleId',ids.vehicle_id,'status','suspended','expectedVersion',2),
      'اختبار منع تعديل المراجع',
      'fleet-smoke-auditor-command-001'
    );
    RAISE EXCEPTION 'auditor performed a fleet mutation';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$fleet_auditor_read_only$;
RESET ROLE;

ROLLBACK;
