-- Synthetic integration checks for the current fleet onboarding contract. Run only inside run-local-test.sh's
-- disposable PostgreSQL cluster; never run against Supabase.
BEGIN;

INSERT INTO auth.users(id,email,raw_user_meta_data,email_confirmed_at)
VALUES
  ('00000000-0000-4000-8000-000000002201','fleet-0022-owner@example.invalid',
    '{"username":"fleet_0022_owner","display_name":"Fleet 0022 Owner"}',now());
UPDATE public.petro_profiles SET active=true,account_status='active'
WHERE user_id='00000000-0000-4000-8000-000000002201';
INSERT INTO public.petro_platform_roles(user_id,role,active)
VALUES ('00000000-0000-4000-8000-000000002201','owner',true);
INSERT INTO public.petro_organizations(
  id,name,kind,code,status,approval_status,operational_status,created_by
) VALUES (
  '00000000-0000-4000-8000-000000002211','اختبار 0022','company','FLEET-0022','active','approved','active',
  '00000000-0000-4000-8000-000000002201'
), (
  '00000000-0000-4000-8000-000000002212','محطة اختبار 0022','station','FLEET-0022-ST','active','approved','active',
  '00000000-0000-4000-8000-000000002201'
);
INSERT INTO public.petro_branches(
  id,organization_id,name,code,status,approval_status,operational_status
) VALUES (
  '00000000-0000-4000-8000-000000002221','00000000-0000-4000-8000-000000002211',
  'فرع اختبار 0022','FLEET-0022-B1','active','approved','active'
), (
  '00000000-0000-4000-8000-000000002222','00000000-0000-4000-8000-000000002212',
  'فرع محطة اختبار 0022','FLEET-0022-S1','active','approved','active'
);

SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000002201';

DO $fleet_onboarding_0022$
DECLARE
  created jsonb;
  replayed jsonb;
  pickup_vehicle jsonb;
  pickup_request jsonb;
  catalog_row jsonb;
  summary_row jsonb;
  policy_result jsonb;
  published jsonb;
  policy_rules jsonb;
  v_vehicle_id uuid;
  request_id uuid;
  rule_count integer;
BEGIN
  created := public.petro_admin_fleet_command(
    'vehicle.create',
    jsonb_build_object(
      'organizationId','00000000-0000-4000-8000-000000002211',
      'branchId','00000000-0000-4000-8000-000000002221',
      'plateOriginal','س ٢٢ ١','plateStandard','س٢٢١','category','سيدان',
      'vehicleType','سيارة','brand','مصنع اختباري','model','طراز ٢٢',
      'modelYear',2024,'fuelType','petrol','tankCapacityLiters',52.5,
      'credentialType','nfc','fulfillmentMethod','install',
      'installationAddress','شارع اختبار 22، القاهرة',
      'fulfillmentContactName','مسؤول الاختبار',
      'fulfillmentContactPhone','01000002201'
    ),
    'اختبار تسجيل مركبة مع تركيب NFC',
    'fleet-0022-create-vehicle-0001'
  );
  v_vehicle_id := (created->>'id')::uuid;
  request_id := (created->>'credentialRequestId')::uuid;
  IF v_vehicle_id IS NULL OR request_id IS NULL THEN
    RAISE EXCEPTION 'vehicle onboarding did not return the created NFC request';
  END IF;

  replayed := public.petro_admin_fleet_command(
    'vehicle.create',
    jsonb_build_object(
      'organizationId','00000000-0000-4000-8000-000000002211',
      'branchId','00000000-0000-4000-8000-000000002221',
      'plateOriginal','س ٢٢ ١','plateStandard','س٢٢١','category','سيدان',
      'vehicleType','سيارة','brand','مصنع اختباري','model','طراز ٢٢',
      'modelYear',2024,'fuelType','petrol','tankCapacityLiters',52.5,
      'credentialType','nfc','fulfillmentMethod','install',
      'installationAddress','شارع اختبار 22، القاهرة',
      'fulfillmentContactName','مسؤول الاختبار',
      'fulfillmentContactPhone','01000002201'
    ),
    'اختبار تسجيل مركبة مع تركيب NFC',
    'fleet-0022-create-vehicle-0001'
  );
  IF replayed->>'replayed'<>'true' OR replayed->>'id'<>created->>'id'
     OR (SELECT count(*) FROM public.petro_fleet_vehicles
         WHERE organization_id='00000000-0000-4000-8000-000000002211')<>1
     OR (SELECT count(*) FROM public.petro_fleet_credential_requests request_row
         WHERE request_row.vehicle_id=v_vehicle_id AND request_row.credential_type='nfc')<>1 THEN
    RAISE EXCEPTION 'vehicle and NFC request retry was not idempotent: %',replayed;
  END IF;

  IF (SELECT tank_capacity_liters FROM public.petro_fleet_vehicles WHERE id=v_vehicle_id)<>52.5 THEN
    RAISE EXCEPTION 'tank capacity was not persisted';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.petro_fleet_credential_requests
    WHERE id=request_id AND fulfillment_method='install'
      AND installation_address='شارع اختبار 22، القاهرة'
      AND fulfillment_contact_phone='01000002201'
      AND status='requested' AND payment_state='awaiting_collection'
  ) THEN
    RAISE EXCEPTION 'install request details were not persisted as a request without claiming payment';
  END IF;

  catalog_row := public.petro_admin_fleet_catalog('vehicle',jsonb_build_object('id',v_vehicle_id));
  IF catalog_row->'vehicle'->>'tankCapacityLiters'<>'52.500'
     AND catalog_row->'vehicle'->>'tankCapacityLiters'<>'52.5' THEN
    RAISE EXCEPTION 'vehicle catalog readback omitted tank capacity: %',catalog_row;
  END IF;
  catalog_row := public.petro_admin_fleet_catalog('credentials',jsonb_build_object('vehicleId',v_vehicle_id));
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(catalog_row->'items') request
    WHERE request->>'id'=request_id::text
      AND request->>'fulfillmentMethod'='install'
      AND request->>'installationAddress'='شارع اختبار 22، القاهرة'
  ) THEN
    RAISE EXCEPTION 'request catalog readback omitted fulfillment details: %',catalog_row;
  END IF;

  pickup_vehicle := public.petro_admin_fleet_command(
    'vehicle.create',
    jsonb_build_object(
      'organizationId','00000000-0000-4000-8000-000000002211',
      'branchId','00000000-0000-4000-8000-000000002221',
      'plateOriginal','س ٢٢ ٢','plateStandard','س٢٢٢','category','سيدان',
      'vehicleType','سيارة','brand','مصنع اختباري','model','طراز ٢٢',
      'modelYear',2024,'fuelType','petrol','tankCapacityLiters',NULL
    ),
    'اختبار مركبة الاستلام',
    'fleet-0022-create-vehicle-0002'
  );
  pickup_request := public.petro_admin_fleet_command(
    'credential.request',
    jsonb_build_object(
      'vehicleId',pickup_vehicle->>'id','credentialType','nfc','requestType','issue',
      'fulfillmentMethod','pickup','pickupLocation','مكتب الفرع الرئيسي',
      'fulfillmentContactName','مسؤول الاستلام'
    ),
    'اختبار طلب NFC للاستلام',
    'fleet-0022-request-pickup-0001'
  );
  IF NOT EXISTS (
    SELECT 1 FROM public.petro_fleet_credential_requests
    WHERE id=(pickup_request->>'id')::uuid AND fulfillment_method='pickup'
      AND pickup_location='مكتب الفرع الرئيسي'
  ) THEN
    RAISE EXCEPTION 'pickup request details were not persisted';
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
    'serviceGroup',group_name,'enabled',group_name='batteries',
    'maxOperationMinor',CASE WHEN group_name='batteries' THEN 10000 ELSE 0 END,
    'maxOperationQuantity',CASE WHEN group_name='batteries' THEN 1 ELSE 0 END,
    'dailyAmountLimitMinor',CASE WHEN group_name='batteries' THEN 20000 ELSE 0 END,
    'weeklyAmountLimitMinor',CASE WHEN group_name='batteries' THEN 50000 ELSE 0 END,
     'monthlyAmountLimitMinor',0,
     'dailyQuantityLimit',0,
     'weeklyQuantityLimit',0,
     'monthlyQuantityLimit',0
  ) ORDER BY group_name) INTO policy_rules
  FROM (VALUES ('fuel'),('wash'),('oils'),('batteries'),('filters'),('parts'),('consumables')) groups(group_name);
  IF jsonb_array_length(policy_rules)<>7 THEN RAISE EXCEPTION 'test policy rules fixture is incomplete'; END IF;

  policy_result := public.petro_admin_fleet_command(
    'policy.create',
    jsonb_build_object(
      'scope','vehicle','organizationId','00000000-0000-4000-8000-000000002211',
      'branchId','00000000-0000-4000-8000-000000002221','vehicleId',v_vehicle_id,
      'effectiveFrom',now()+interval '1 day','allowedWeekdays',jsonb_build_array(1,2,3,4,5,6,7),
      'startTime','00:00','endTime','23:59',
      'allowedMerchantOrganizationIds',jsonb_build_array('00000000-0000-4000-8000-000000002212'),
      'allowedMerchantBranchIds',jsonb_build_array('00000000-0000-4000-8000-000000002222'),
      'maxOperationMinor',100000,
      'maxOperationQuantity',100,'dailyAmountLimitMinor',200000,
       'weeklyAmountLimitMinor',500000,'monthlyAmountLimitMinor',0,
       'dailyQuantityLimit',0,'weeklyQuantityLimit',0,'monthlyQuantityLimit',0,
      'rules',policy_rules
    ),
    'اختبار سياسة حدود مؤرخة',
    'fleet-0022-policy-create-0001'
  );
  published := public.petro_admin_fleet_command(
    'policy.publish',jsonb_build_object('policyVersionId',policy_result->>'id'),
    'اختبار نشر سياسة حدود',
    'fleet-0022-policy-publish-0001'
  );
  SELECT count(*) INTO rule_count FROM public.petro_fleet_policy_rules
  WHERE policy_version_id=(policy_result->>'id')::uuid;
  IF rule_count<>7 OR published->>'status'<>'published'
     OR NOT EXISTS (
       SELECT 1 FROM public.petro_fleet_policy_rules
       WHERE policy_version_id=(policy_result->>'id')::uuid
          AND service_group='batteries' AND enabled
          AND monthly_amount_limit_minor=0
          AND daily_quantity_limit=0 AND weekly_quantity_limit=0 AND monthly_quantity_limit=0
     ) THEN
    RAISE EXCEPTION 'policy service groups were not stored and published separately';
  END IF;

  summary_row := public.petro_admin_fleet_company_summaries(
    '00000000-0000-4000-8000-000000002211',NULL,1,10
  );
  IF summary_row->>'onboardingCapabilitiesVersion'<>'3' THEN
    RAISE EXCEPTION 'fleet onboarding capability version was not reported: %',summary_row;
  END IF;
  IF pg_catalog.strpos(pg_catalog.pg_get_functiondef(
      'public.petro_fleet_reserve_usage(uuid,uuid,uuid,uuid,uuid,text,bigint,numeric,text,text,uuid)'::regprocedure
    ), '(v_vehicle_policy.monthly_amount_limit_minor>0 AND v_month_amount+p_amount_minor>v_vehicle_policy.monthly_amount_limit_minor)')=0 THEN
    RAISE EXCEPTION 'optional monthly cap is still evaluated as zero in the reservation routine';
  END IF;
END
$fleet_onboarding_0022$;

ROLLBACK;
