-- Commits disposable fixtures into the local throwaway cluster for the real
-- SQL/connection-level reserve integration test. The cluster is dropped by the
-- caller; this script never runs against Supabase.
INSERT INTO auth.users(id,email,raw_user_meta_data,email_confirmed_at)
VALUES
 ('00000000-0000-4000-8000-000000001601','fleet-it-owner@example.invalid',
  '{"username":"fleet_it_owner"}',now())
ON CONFLICT (id) DO NOTHING;
UPDATE public.petro_profiles SET active=true,account_status='active'
WHERE user_id='00000000-0000-4000-8000-000000001601';
INSERT INTO public.petro_platform_roles(user_id,role,active)
VALUES ('00000000-0000-4000-8000-000000001601','owner',true)
ON CONFLICT (user_id,role) DO UPDATE SET active=true;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000001601',false);
SELECT public.petro_create_organization_details(
 'شركة أسطول تكامل معزول','company','FLEET-IT-A',NULL,
 'مسؤول الاختبار','+201000001601','fleet-it-a@example.invalid','عنوان اختبار'
);
SELECT public.petro_create_organization_details(
 'شركة عزل أسطول معزول','company','FLEET-IT-B',NULL,
 'مسؤول الاختبار','+201000001602','fleet-it-b@example.invalid','عنوان اختبار'
);
RESET ROLE;

DO $setup$
DECLARE
  actor uuid := '00000000-0000-4000-8000-000000001601';
  org_a uuid; org_b uuid; branch_a uuid; branch_a2 uuid; branch_b uuid;
  plan_id uuid := '00000000-0000-4000-8000-000000001611';
  version_id uuid := '00000000-0000-4000-8000-000000001612';
  request_id uuid := '00000000-0000-4000-8000-000000001613';
  subscription_id uuid := '00000000-0000-4000-8000-000000001614';
  third_request_id uuid := '00000000-0000-4000-8000-000000001625';
  third_subscription_id uuid := '00000000-0000-4000-8000-000000001626';
  merchant_org uuid;
  merchant_branch uuid;
  branch_policy_id uuid := '00000000-0000-4000-8000-000000001621';
  branch_account uuid; bank_id uuid; bank_account uuid;
  v1 jsonb; v2 jsonb; v3 jsonb; vb jsonb;
  d1 jsonb; d2 jsonb; d3 jsonb; db jsonb;
  l1 jsonb; l2 jsonb; l3 jsonb; lb jsonb;
  covered jsonb; covered_replay jsonb;
  vehicle_id uuid; branch_result uuid;
  vehicle_ids uuid[];
  policy_id uuid;
  svc text; action_error text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub',actor::text,true);
  SELECT id INTO org_a FROM public.petro_organizations WHERE code='FLEET-IT-A';
  SELECT id INTO org_b FROM public.petro_organizations WHERE code='FLEET-IT-B';
  PERFORM public.petro_approve_organization(org_a,1,'اعتماد شركة تكامل أسطول معزولة');
  PERFORM public.petro_set_organization_operational_status(org_a,2,'active','تفعيل شركة تكامل أسطول معزولة');
  PERFORM public.petro_approve_organization(org_b,1,'اعتماد شركة عزل أسطول معزولة');
  PERFORM public.petro_set_organization_operational_status(org_b,2,'active','تفعيل شركة عزل أسطول معزولة');
  branch_a := public.petro_create_branch_details(
    org_a,'FLEET-IT-A1','فرع تكامل أسطول','عنوان اختبار','القاهرة',
    NULL,NULL,'{}'::jsonb,'مسؤول الفرع','+201000001611');
  PERFORM public.petro_approve_branch(org_a,branch_a,1,'اعتماد فرع تكامل أسطول');
  PERFORM public.petro_set_branch_operational_status(org_a,branch_a,2,'active','تفعيل فرع تكامل أسطول');
  branch_a2 := public.petro_create_branch_details(
    org_a,'FLEET-IT-A2','فرع ثان لتكامل الأسطول','عنوان اختبار','القاهرة',
    NULL,NULL,'{}'::jsonb,'مسؤول الفرع','+201000001613');
  PERFORM public.petro_approve_branch(org_a,branch_a2,1,'اعتماد الفرع الثاني لتكامل الأسطول');
  PERFORM public.petro_set_branch_operational_status(org_a,branch_a2,2,'active','تفعيل الفرع الثاني لتكامل الأسطول');
  branch_b := public.petro_create_branch_details(
    org_b,'FLEET-IT-B1','فرع عزل أسطول','عنوان اختبار','القاهرة',
    NULL,NULL,'{}'::jsonb,'مسؤول الفرع','+201000001612');
  PERFORM public.petro_approve_branch(org_b,branch_b,1,'اعتماد فرع عزل أسطول');
  PERFORM public.petro_set_branch_operational_status(org_b,branch_b,2,'active','تفعيل فرع عزل أسطول');
  merchant_org := public.petro_create_organization_details(
    'محطة أسطول تكامل معزولة','station','FLEET-IT-M',NULL,
    'مسؤول اختبار','+201000001603','fleet-it-merchant@example.invalid','عنوان اختبار');
  PERFORM public.petro_approve_organization(merchant_org,1,'اعتماد محطة اختبار معزولة');
  PERFORM public.petro_set_organization_operational_status(merchant_org,2,'active','تفعيل محطة اختبار معزولة');
  merchant_branch := public.petro_create_branch_details(
    merchant_org,'FLEET-IT-M1','فرع محطة تكامل','عنوان اختبار','القاهرة',
    NULL,NULL,'{}'::jsonb,'مسؤول الفرع','+201000001604');
  PERFORM public.petro_approve_branch(merchant_org,merchant_branch,1,'اعتماد فرع محطة اختبار');
  PERFORM public.petro_set_branch_operational_status(merchant_org,merchant_branch,2,'active','تفعيل فرع محطة اختبار');

  INSERT INTO public.petro_plans(id,code,audience,name,active,description)
  VALUES(plan_id,'FLEET-IT-VEHICLE','company','خطة مركبات تكامل اختبارية',true,'synthetic fixture');
  INSERT INTO public.petro_plan_versions(
    id,plan_id,version,annual_price_minor,billing_unit,created_by,effective_at,
    display_name,description,publication_status,billing_cycle,currency,entitlements,settings
  ) VALUES(version_id,plan_id,1,50000,'vehicle',actor,now()-interval '1 day',
    'خطة مركبات تكامل اختبارية','synthetic fixture','published','annual','EGP','[]','[]');
  INSERT INTO public.petro_subscription_requests(
    id,organization_id,branch_id,request_type,plan_id,plan_version_id,requested_units,
    starts_at,ends_at,coverage_state,request_status,reason,submitted_by,reviewed_by,reviewed_at
  ) VALUES(request_id,org_a,branch_a,'new',plan_id,version_id,2,
    now()-interval '2 years',now()+interval '1 year','verified','approved',
    'اشتراك نشط اصطناعي لاختبار عقد التغطية',actor,actor,now());
  INSERT INTO public.petro_subscriptions(
    id,request_id,organization_id,branch_id,plan_id,plan_version_id,plan_snapshot,
    price_snapshot_minor,billing_unit,units,starts_at,ends_at,status,created_by
  ) VALUES(subscription_id,request_id,org_a,branch_a,plan_id,version_id,
    '{"fixture":"isolated","accountingApproved":false}',50000,'vehicle',2,
    now()-interval '2 years',now()+interval '1 year','active',actor);
  INSERT INTO public.petro_subscription_requests(
    id,organization_id,branch_id,request_type,plan_id,plan_version_id,requested_units,
    starts_at,ends_at,coverage_state,request_status,reason,submitted_by,reviewed_by,reviewed_at
  ) VALUES('00000000-0000-4000-8000-000000001623',org_a,branch_a,'new',plan_id,version_id,1,
    now()-interval '3 days',now()-interval '1 day','verified','approved',
    'اشتراك منتهي اصطناعي لاختبار الرفض',actor,actor,now());
  INSERT INTO public.petro_subscriptions(
    id,request_id,organization_id,branch_id,plan_id,plan_version_id,plan_snapshot,
    price_snapshot_minor,billing_unit,units,starts_at,ends_at,status,created_by
  ) VALUES('00000000-0000-4000-8000-000000001624','00000000-0000-4000-8000-000000001623',
    org_a,branch_a,plan_id,version_id,'{"fixture":"expired","accountingApproved":false}',
    50000,'vehicle',1,now()-interval '3 days',now()-interval '1 day','active',actor);
  INSERT INTO public.petro_subscription_requests(
    id,organization_id,branch_id,request_type,plan_id,plan_version_id,requested_units,
    starts_at,ends_at,coverage_state,request_status,reason,submitted_by,reviewed_by,reviewed_at
  ) VALUES(third_request_id,org_a,branch_a,'new',plan_id,version_id,1,
    now()-interval '2 years',now()+interval '1 year','verified','approved',
    'اشتراك اصطناعي مستقل للمركبة الثالثة في قاعدة الاختبار',actor,actor,now());
  INSERT INTO public.petro_subscriptions(
    id,request_id,organization_id,branch_id,plan_id,plan_version_id,plan_snapshot,
    price_snapshot_minor,billing_unit,units,starts_at,ends_at,status,created_by
  ) VALUES(third_subscription_id,third_request_id,org_a,branch_a,plan_id,version_id,
    '{"fixture":"isolated-third-vehicle","accountingApproved":false}',50000,'vehicle',1,
    now()-interval '2 years',now()+interval '1 year','active',actor);

  SELECT public.petro_admin_fleet_command('vehicle.create',jsonb_build_object(
    'organizationId',org_a,'branchId',branch_a,'plateOriginal','FLEET IT 1','plateStandard','FLEETIT1',
    'category','sedan','vehicleType','car','brand','Test','model','One','fuelType','petrol',
    'internalCode','FLEET-IT-A-1'),'إنشاء مركبة اصطناعية','fleet-it-a-vehicle-1') INTO v1;
  SELECT public.petro_admin_fleet_command('vehicle.create',jsonb_build_object(
    'organizationId',org_a,'branchId',branch_a,'plateOriginal','FLEET IT 2','plateStandard','FLEETIT2',
    'category','sedan','vehicleType','car','brand','Test','model','Two','fuelType','petrol',
    'internalCode','FLEET-IT-A-2'),'إنشاء مركبة اصطناعية','fleet-it-a-vehicle-2') INTO v2;
  SELECT public.petro_admin_fleet_command('vehicle.create',jsonb_build_object(
    'organizationId',org_a,'branchId',branch_a,'plateOriginal','FLEET IT 3','plateStandard','FLEETIT3',
    'category','sedan','vehicleType','car','brand','Test','model','Three','fuelType','petrol',
    'internalCode','FLEET-IT-A-3'),'إنشاء مركبة اصطناعية','fleet-it-a-vehicle-3') INTO v3;
  SELECT public.petro_admin_fleet_command('vehicle.create',jsonb_build_object(
    'organizationId',org_b,'branchId',branch_b,'plateOriginal','FLEET IT B1','plateStandard','FLEETITB1',
    'category','sedan','vehicleType','car','brand','Test','model','Other','fuelType','petrol',
    'internalCode','FLEET-IT-B-1'),'إنشاء مركبة اصطناعية لشركة أخرى','fleet-it-b-vehicle-1') INTO vb;
  vehicle_ids := ARRAY[(v1->>'id')::uuid,(v2->>'id')::uuid,(v3->>'id')::uuid,(vb->>'id')::uuid];

  SELECT public.petro_admin_fleet_command('driver.create',jsonb_build_object(
    'organizationId',org_a,'driverCode','FLEET-IT-D1','fullName','سائق تكامل أول'),
    'إنشاء سائق اصطناعي','fleet-it-a-driver-1') INTO d1;
  SELECT public.petro_admin_fleet_command('driver.create',jsonb_build_object(
    'organizationId',org_a,'driverCode','FLEET-IT-D2','fullName','سائق تكامل ثان'),
    'إنشاء سائق اصطناعي','fleet-it-a-driver-2') INTO d2;
  SELECT public.petro_admin_fleet_command('driver.create',jsonb_build_object(
    'organizationId',org_a,'driverCode','FLEET-IT-D3','fullName','سائق تكامل ثالث'),
    'إنشاء سائق اصطناعي','fleet-it-a-driver-3') INTO d3;
  SELECT public.petro_admin_fleet_command('driver.create',jsonb_build_object(
    'organizationId',org_b,'driverCode','FLEET-IT-DB','fullName','سائق عزل'),
    'إنشاء سائق اصطناعي لشركة أخرى','fleet-it-b-driver-1') INTO db;
  SELECT public.petro_admin_fleet_command('driver.link.create',jsonb_build_object(
    'vehicleId',v1->>'id','driverId',d1->>'id','startsAt','2024-07-01T12:00:00Z',
    'pinHmac',repeat('a',64),'pinCiphertext',repeat('0',64),'pinKeyVersion',1),
    'ربط سائق اصطناعي','fleet-it-a-link-1') INTO l1;
  SELECT public.petro_admin_fleet_command('driver.link.create',jsonb_build_object(
    'vehicleId',v2->>'id','driverId',d2->>'id',
    'pinHmac',repeat('b',64),'pinCiphertext',repeat('0',64),'pinKeyVersion',1),
    'ربط سائق اصطناعي','fleet-it-a-link-2') INTO l2;
  SELECT public.petro_admin_fleet_command('driver.link.create',jsonb_build_object(
    'vehicleId',v3->>'id','driverId',d3->>'id',
    'pinHmac',repeat('c',64),'pinCiphertext',repeat('0',64),'pinKeyVersion',1),
    'ربط سائق اصطناعي','fleet-it-a-link-3') INTO l3;
  SELECT public.petro_admin_fleet_command('driver.link.create',jsonb_build_object(
    'vehicleId',vb->>'id','driverId',db->>'id',
    'pinHmac',repeat('d',64),'pinCiphertext',repeat('0',64),'pinKeyVersion',1),
    'ربط سائق اصطناعي لشركة أخرى','fleet-it-b-link-1') INTO lb;

  SELECT public.petro_admin_fleet_assign_coverage(jsonb_build_object(
    'vehicleId',v1->>'id','subscriptionId',subscription_id,'startsAt',now()),
    'تغطية مركبة اصطناعية','fleet-it-coverage-1') INTO covered;
  SELECT public.petro_admin_fleet_assign_coverage(jsonb_build_object(
    'vehicleId',v1->>'id','subscriptionId',subscription_id,'startsAt',now()),
    'تغطية مركبة اصطناعية','fleet-it-coverage-1') INTO covered_replay;
  IF covered_replay->>'id'<>covered->>'id' OR covered_replay->>'replayed'<>'true' THEN
    RAISE EXCEPTION 'coverage assignment did not replay its original result';
  END IF;
  BEGIN
    PERFORM public.petro_admin_fleet_assign_coverage(jsonb_build_object(
      'vehicleId',v1->>'id','subscriptionId',subscription_id,'startsAt',now()+interval '1 second'),
      'حمولة مختلفة','fleet-it-coverage-1');
    RAISE EXCEPTION 'coverage idempotency accepted a changed payload';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    PERFORM public.petro_admin_fleet_assign_coverage(jsonb_build_object(
      'vehicleId',v1->>'id','subscriptionId',subscription_id,'startsAt',now()),
      'سبب مختلف','fleet-it-coverage-1');
    RAISE EXCEPTION 'coverage idempotency accepted a changed reason';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    PERFORM public.petro_admin_fleet_assign_coverage(jsonb_build_object(
      'vehicleId',v1->>'id','subscriptionId',subscription_id,'startsAt',now()),
      'تغطية مكررة اصطناعية','fleet-it-coverage-duplicate');
    RAISE EXCEPTION 'duplicate active vehicle coverage was accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  SELECT public.petro_admin_fleet_assign_coverage(jsonb_build_object(
    'vehicleId',v2->>'id','subscriptionId',subscription_id,'startsAt',now()),
    'تغطية مركبة اصطناعية','fleet-it-coverage-2') INTO covered;
  BEGIN
    PERFORM public.petro_admin_fleet_assign_coverage(jsonb_build_object(
      'vehicleId',v3->>'id','subscriptionId',subscription_id,'startsAt',now()),
      'تجاوز سعة اصطناعي','fleet-it-coverage-over');
    RAISE EXCEPTION 'coverage capacity overflow was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    PERFORM public.petro_admin_fleet_assign_coverage(jsonb_build_object(
      'vehicleId',vb->>'id','subscriptionId',subscription_id,'startsAt',now()),
      'محاولة عزل شركة اصطناعية','fleet-it-coverage-cross-company');
    RAISE EXCEPTION 'cross-company coverage was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    PERFORM public.petro_admin_fleet_assign_coverage(jsonb_build_object(
      'vehicleId',v3->>'id','subscriptionId','00000000-0000-4000-8000-000000001624',
      'startsAt',now()),'اشتراك منتهي اصطناعي','fleet-it-coverage-expired');
    RAISE EXCEPTION 'expired subscription coverage was accepted';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS action_error=MESSAGE_TEXT;
    IF action_error<>'VEHICLE_SUBSCRIPTION_NOT_ELIGIBLE' THEN RAISE; END IF;
  END;
  PERFORM public.petro_admin_fleet_assign_coverage(jsonb_build_object(
    'vehicleId',v3->>'id','subscriptionId',third_subscription_id,'startsAt',now()),
    'تغطية اصطناعية للمركبة الثالثة','fleet-it-coverage-3');

  INSERT INTO public.petro_fleet_policy_versions(
    id,organization_id,branch_id,vehicle_id,scope_kind,version_no,status,effective_from,
    allowed_weekdays,start_time,end_time,allowed_merchant_organization_ids,
    allowed_merchant_branch_ids,max_operation_minor,max_operation_quantity,
    daily_amount_limit_minor,weekly_amount_limit_minor,monthly_amount_limit_minor,
    daily_quantity_limit,weekly_quantity_limit,monthly_quantity_limit,reason,created_by,published_by,published_at
  ) VALUES(branch_policy_id,org_a,branch_a,NULL,'branch',1,'published',now()-interval '2 years',
    ARRAY[1,2,3,4,5,6,7]::smallint[],'00:00','23:59:59.999999',
    ARRAY[merchant_org],ARRAY[merchant_branch],1000000,100,10000000,20000000,40000000,
    1000,2000,4000,'سياسة فرع اصطناعية',actor,actor,now());
  INSERT INTO public.petro_fleet_policy_rules(
    policy_version_id,service_group,enabled,max_operation_minor,max_operation_quantity,
    daily_amount_limit_minor,weekly_amount_limit_minor,monthly_amount_limit_minor,
    daily_quantity_limit,weekly_quantity_limit,monthly_quantity_limit
  )
  SELECT branch_policy_id,service_group,true,1000000,100,10000000,20000000,40000000,1000,2000,4000
  FROM unnest(ARRAY['fuel','wash','oils','parts']::text[]) service_group;

  FOREACH vehicle_id IN ARRAY vehicle_ids[1:3] LOOP
    policy_id := gen_random_uuid();
    INSERT INTO public.petro_fleet_policy_versions(
      id,organization_id,branch_id,vehicle_id,scope_kind,version_no,status,effective_from,
      allowed_weekdays,start_time,end_time,allowed_merchant_organization_ids,
      allowed_merchant_branch_ids,max_operation_minor,max_operation_quantity,
      daily_amount_limit_minor,weekly_amount_limit_minor,monthly_amount_limit_minor,
      daily_quantity_limit,weekly_quantity_limit,monthly_quantity_limit,reason,created_by,published_by,published_at
     ) VALUES(policy_id,org_a,branch_a,vehicle_id,'vehicle',1,'published',now()-interval '2 years',
      ARRAY[1,2,3,4,5,6,7]::smallint[],'00:00','23:59:59.999999',
      ARRAY[merchant_org],ARRAY[merchant_branch],1000000,100,
      1000000,2000000,4000000,100,200,400,'سياسة مركبة اصطناعية',actor,actor,now());
    INSERT INTO public.petro_fleet_policy_rules(
      policy_version_id,service_group,enabled,max_operation_minor,max_operation_quantity,
      daily_amount_limit_minor,weekly_amount_limit_minor,monthly_amount_limit_minor,
      daily_quantity_limit,weekly_quantity_limit,monthly_quantity_limit
    ) VALUES
      (policy_id,'fuel',true,1000000,100,1000000,2000000,4000000,100,200,400),
      (policy_id,'wash',true,1000000,100,1000000,2000000,4000000,100,200,400),
      (policy_id,'oils',false,0,0,0,0,0,0,0,0),
      (policy_id,'parts',true,1000000,100,1000000,2000000,4000000,100,200,400);
  END LOOP;

  bank_id := gen_random_uuid();
  INSERT INTO public.petro_finance_bank_accounts(
    id,bank_name,display_label,account_last4,status,reason,created_by,approved_by,approved_at
  ) VALUES(bank_id,'بنك اصطناعي للاختبار','وجهة محلية اصطناعية','1601','active',
    'حساب اصطناعي لقاعدة الاختبار فقط',actor,actor,now());
  INSERT INTO public.petro_finance_accounts(
    account_code,display_name,account_kind,normal_side,receiving_bank_account_id
  ) VALUES('FLEET-IT-BANK-1601','بنك اختبار محلي','bank_clearing','debit',bank_id)
  RETURNING id INTO bank_account;
  branch_account := petro_private.finance_account_for_scope(org_a,branch_a);
  PERFORM petro_private.finance_post_entry(
    gen_random_uuid(),'bank_receipt',gen_random_uuid(),org_a,'FLEET-IT-FUNDING-10000',
    'تمويل اصطناعي محلي لاختبار حجز الأسطول',
    jsonb_build_array(
      jsonb_build_object('accountId',bank_account,'side','debit','amountMinor','1000000'),
      jsonb_build_object('accountId',branch_account,'side','credit','amountMinor','1000000')
    )
  );
END
$setup$;
