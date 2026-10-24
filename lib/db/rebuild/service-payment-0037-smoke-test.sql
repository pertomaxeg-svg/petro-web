-- Disposable payment acceptance gate; never run against production.
BEGIN;
DO $$ BEGIN
 IF to_regprocedure('public.petro_confirm_service_order(uuid,bigint,text,text)') IS NULL
 OR to_regprocedure('public.petro_service_order_payment(uuid)') IS NULL
 OR to_regprocedure('public.petro_service_order_payment_context(uuid)') IS NULL
 OR to_regclass('petro_private.service_order_payments') IS NULL
 OR to_regclass('petro_private.service_order_receivables') IS NULL THEN
 RAISE EXCEPTION 'Final order confirmation and actual payment are missing';END IF;
END $$;

-- Commits disposable fixtures into the local throwaway cluster for the real
-- SQL/connection-level reserve integration test. The cluster is dropped by the
-- caller; this script never runs against Supabase.
INSERT INTO auth.users(id,email,raw_user_meta_data,email_confirmed_at)
VALUES
 ('00000000-0000-4000-8000-000000003701','pay-it-owner@example.invalid',
  '{"username":"pay_it_owner"}',now())
ON CONFLICT (id) DO NOTHING;
UPDATE public.petro_profiles SET active=true,account_status='active'
WHERE user_id='00000000-0000-4000-8000-000000003701';
INSERT INTO public.petro_platform_roles(user_id,role,active)
VALUES ('00000000-0000-4000-8000-000000003701','owner',true)
ON CONFLICT (user_id,role) DO UPDATE SET active=true;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000003701',false);
SELECT public.petro_create_organization_details(
 'شركة أسطول تكامل معزول','company','PAY-IT-A',NULL,
 'مسؤول الاختبار','+201000001601','pay-it-a@example.invalid','عنوان اختبار'
);
SELECT public.petro_create_organization_details(
 'شركة عزل أسطول معزول','company','PAY-IT-B',NULL,
 'مسؤول الاختبار','+201000001602','pay-it-b@example.invalid','عنوان اختبار'
);
RESET ROLE;

DO $setup$
DECLARE
  actor uuid := '00000000-0000-4000-8000-000000003701';
  org_a uuid; org_b uuid; branch_a uuid; branch_a2 uuid; branch_b uuid;
  plan_id uuid := '00000000-0000-4000-8000-000000003711';
  version_id uuid := '00000000-0000-4000-8000-000000003712';
  request_id uuid := '00000000-0000-4000-8000-000000003713';
  subscription_id uuid := '00000000-0000-4000-8000-000000003714';
  third_request_id uuid := '00000000-0000-4000-8000-000000003725';
  third_subscription_id uuid := '00000000-0000-4000-8000-000000003726';
  merchant_org uuid;
  merchant_branch uuid;
  branch_policy_id uuid := '00000000-0000-4000-8000-000000003721';
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
  SELECT id INTO org_a FROM public.petro_organizations WHERE code='PAY-IT-A';
  SELECT id INTO org_b FROM public.petro_organizations WHERE code='PAY-IT-B';
  PERFORM public.petro_approve_organization(org_a,1,'اعتماد شركة تكامل أسطول معزولة');
  PERFORM public.petro_set_organization_operational_status(org_a,2,'active','تفعيل شركة تكامل أسطول معزولة');
  PERFORM public.petro_approve_organization(org_b,1,'اعتماد شركة عزل أسطول معزولة');
  PERFORM public.petro_set_organization_operational_status(org_b,2,'active','تفعيل شركة عزل أسطول معزولة');
  branch_a := public.petro_create_branch_details(
    org_a,'PAY-IT-A1','فرع تكامل أسطول','عنوان اختبار','القاهرة',
    NULL,NULL,'{}'::jsonb,'مسؤول الفرع','+201000001611');
  PERFORM public.petro_approve_branch(org_a,branch_a,1,'اعتماد فرع تكامل أسطول');
  PERFORM public.petro_set_branch_operational_status(org_a,branch_a,2,'active','تفعيل فرع تكامل أسطول');
  branch_a2 := public.petro_create_branch_details(
    org_a,'PAY-IT-A2','فرع ثان لتكامل الأسطول','عنوان اختبار','القاهرة',
    NULL,NULL,'{}'::jsonb,'مسؤول الفرع','+201000001613');
  PERFORM public.petro_approve_branch(org_a,branch_a2,1,'اعتماد الفرع الثاني لتكامل الأسطول');
  PERFORM public.petro_set_branch_operational_status(org_a,branch_a2,2,'active','تفعيل الفرع الثاني لتكامل الأسطول');
  branch_b := public.petro_create_branch_details(
    org_b,'PAY-IT-B1','فرع عزل أسطول','عنوان اختبار','القاهرة',
    NULL,NULL,'{}'::jsonb,'مسؤول الفرع','+201000001612');
  PERFORM public.petro_approve_branch(org_b,branch_b,1,'اعتماد فرع عزل أسطول');
  PERFORM public.petro_set_branch_operational_status(org_b,branch_b,2,'active','تفعيل فرع عزل أسطول');
  merchant_org := public.petro_create_organization_details(
    'محطة أسطول تكامل معزولة','station','PAY-IT-M',NULL,
    'مسؤول اختبار','+201000001603','pay-it-merchant@example.invalid','عنوان اختبار');
  PERFORM public.petro_approve_organization(merchant_org,1,'اعتماد محطة اختبار معزولة');
  PERFORM public.petro_set_organization_operational_status(merchant_org,2,'active','تفعيل محطة اختبار معزولة');
  merchant_branch := public.petro_create_branch_details(
    merchant_org,'PAY-IT-M1','فرع محطة تكامل','عنوان اختبار','القاهرة',
    NULL,NULL,'{}'::jsonb,'مسؤول الفرع','+201000001604');
  PERFORM public.petro_approve_branch(merchant_org,merchant_branch,1,'اعتماد فرع محطة اختبار');
  PERFORM public.petro_set_branch_operational_status(merchant_org,merchant_branch,2,'active','تفعيل فرع محطة اختبار');

  INSERT INTO public.petro_plans(id,code,audience,name,active,description)
  VALUES(plan_id,'PAY-IT-VEHICLE','company','خطة مركبات تكامل اختبارية',true,'synthetic fixture');
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
  ) VALUES('00000000-0000-4000-8000-000000003723',org_a,branch_a,'new',plan_id,version_id,1,
    now()-interval '3 days',now()-interval '1 day','verified','approved',
    'اشتراك منتهي اصطناعي لاختبار الرفض',actor,actor,now());
  INSERT INTO public.petro_subscriptions(
    id,request_id,organization_id,branch_id,plan_id,plan_version_id,plan_snapshot,
    price_snapshot_minor,billing_unit,units,starts_at,ends_at,status,created_by
  ) VALUES('00000000-0000-4000-8000-000000003724','00000000-0000-4000-8000-000000003723',
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
    'internalCode','PAY-IT-A-1'),'إنشاء مركبة اصطناعية','pay-it-a-vehicle-1') INTO v1;
  SELECT public.petro_admin_fleet_command('vehicle.create',jsonb_build_object(
    'organizationId',org_a,'branchId',branch_a,'plateOriginal','FLEET IT 2','plateStandard','FLEETIT2',
    'category','sedan','vehicleType','car','brand','Test','model','Two','fuelType','petrol',
    'internalCode','PAY-IT-A-2'),'إنشاء مركبة اصطناعية','pay-it-a-vehicle-2') INTO v2;
  SELECT public.petro_admin_fleet_command('vehicle.create',jsonb_build_object(
    'organizationId',org_a,'branchId',branch_a,'plateOriginal','FLEET IT 3','plateStandard','FLEETIT3',
    'category','sedan','vehicleType','car','brand','Test','model','Three','fuelType','petrol',
    'internalCode','PAY-IT-A-3'),'إنشاء مركبة اصطناعية','pay-it-a-vehicle-3') INTO v3;
  SELECT public.petro_admin_fleet_command('vehicle.create',jsonb_build_object(
    'organizationId',org_b,'branchId',branch_b,'plateOriginal','FLEET IT B1','plateStandard','FLEETITB1',
    'category','sedan','vehicleType','car','brand','Test','model','Other','fuelType','petrol',
    'internalCode','PAY-IT-B-1'),'إنشاء مركبة اصطناعية لشركة أخرى','pay-it-b-vehicle-1') INTO vb;
  vehicle_ids := ARRAY[(v1->>'id')::uuid,(v2->>'id')::uuid,(v3->>'id')::uuid,(vb->>'id')::uuid];

  SELECT public.petro_admin_fleet_command('driver.create',jsonb_build_object(
    'organizationId',org_a,'driverCode','PAY-IT-D1','fullName','سائق تكامل أول'),
    'إنشاء سائق اصطناعي','pay-it-a-driver-1') INTO d1;
  SELECT public.petro_admin_fleet_command('driver.create',jsonb_build_object(
    'organizationId',org_a,'driverCode','PAY-IT-D2','fullName','سائق تكامل ثان'),
    'إنشاء سائق اصطناعي','pay-it-a-driver-2') INTO d2;
  SELECT public.petro_admin_fleet_command('driver.create',jsonb_build_object(
    'organizationId',org_a,'driverCode','PAY-IT-D3','fullName','سائق تكامل ثالث'),
    'إنشاء سائق اصطناعي','pay-it-a-driver-3') INTO d3;
  SELECT public.petro_admin_fleet_command('driver.create',jsonb_build_object(
    'organizationId',org_b,'driverCode','PAY-IT-DB','fullName','سائق عزل'),
    'إنشاء سائق اصطناعي لشركة أخرى','pay-it-b-driver-1') INTO db;
  SELECT public.petro_admin_fleet_command('driver.link.create',jsonb_build_object(
    'vehicleId',v1->>'id','driverId',d1->>'id','startsAt','2024-07-01T12:00:00Z',
    'pinHmac',repeat('a',64),'pinCiphertext',repeat('0',64),'pinKeyVersion',1),
    'ربط سائق اصطناعي','pay-it-a-link-1') INTO l1;
  SELECT public.petro_admin_fleet_command('driver.link.create',jsonb_build_object(
    'vehicleId',v2->>'id','driverId',d2->>'id',
    'pinHmac',repeat('b',64),'pinCiphertext',repeat('0',64),'pinKeyVersion',1),
    'ربط سائق اصطناعي','pay-it-a-link-2') INTO l2;
  SELECT public.petro_admin_fleet_command('driver.link.create',jsonb_build_object(
    'vehicleId',v3->>'id','driverId',d3->>'id',
    'pinHmac',repeat('c',64),'pinCiphertext',repeat('0',64),'pinKeyVersion',1),
    'ربط سائق اصطناعي','pay-it-a-link-3') INTO l3;
  SELECT public.petro_admin_fleet_command('driver.link.create',jsonb_build_object(
    'vehicleId',vb->>'id','driverId',db->>'id',
    'pinHmac',repeat('d',64),'pinCiphertext',repeat('0',64),'pinKeyVersion',1),
    'ربط سائق اصطناعي لشركة أخرى','pay-it-b-link-1') INTO lb;

  SELECT public.petro_admin_fleet_assign_coverage(jsonb_build_object(
    'vehicleId',v1->>'id','subscriptionId',subscription_id,'startsAt',now()),
    'تغطية مركبة اصطناعية','pay-it-coverage-1') INTO covered;
  SELECT public.petro_admin_fleet_assign_coverage(jsonb_build_object(
    'vehicleId',v1->>'id','subscriptionId',subscription_id,'startsAt',now()),
    'تغطية مركبة اصطناعية','pay-it-coverage-1') INTO covered_replay;
  IF covered_replay->>'id'<>covered->>'id' OR covered_replay->>'replayed'<>'true' THEN
    RAISE EXCEPTION 'coverage assignment did not replay its original result';
  END IF;
  BEGIN
    PERFORM public.petro_admin_fleet_assign_coverage(jsonb_build_object(
      'vehicleId',v1->>'id','subscriptionId',subscription_id,'startsAt',now()+interval '1 second'),
      'حمولة مختلفة','pay-it-coverage-1');
    RAISE EXCEPTION 'coverage idempotency accepted a changed payload';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    PERFORM public.petro_admin_fleet_assign_coverage(jsonb_build_object(
      'vehicleId',v1->>'id','subscriptionId',subscription_id,'startsAt',now()),
      'سبب مختلف','pay-it-coverage-1');
    RAISE EXCEPTION 'coverage idempotency accepted a changed reason';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    PERFORM public.petro_admin_fleet_assign_coverage(jsonb_build_object(
      'vehicleId',v1->>'id','subscriptionId',subscription_id,'startsAt',now()),
      'تغطية مكررة اصطناعية','pay-it-coverage-duplicate');
    RAISE EXCEPTION 'duplicate active vehicle coverage was accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  SELECT public.petro_admin_fleet_assign_coverage(jsonb_build_object(
    'vehicleId',v2->>'id','subscriptionId',subscription_id,'startsAt',now()),
    'تغطية مركبة اصطناعية','pay-it-coverage-2') INTO covered;
  BEGIN
    PERFORM public.petro_admin_fleet_assign_coverage(jsonb_build_object(
      'vehicleId',v3->>'id','subscriptionId',subscription_id,'startsAt',now()),
      'تجاوز سعة اصطناعي','pay-it-coverage-over');
    RAISE EXCEPTION 'coverage capacity overflow was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    PERFORM public.petro_admin_fleet_assign_coverage(jsonb_build_object(
      'vehicleId',vb->>'id','subscriptionId',subscription_id,'startsAt',now()),
      'محاولة عزل شركة اصطناعية','pay-it-coverage-cross-company');
    RAISE EXCEPTION 'cross-company coverage was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    PERFORM public.petro_admin_fleet_assign_coverage(jsonb_build_object(
      'vehicleId',v3->>'id','subscriptionId','00000000-0000-4000-8000-000000003724',
      'startsAt',now()),'اشتراك منتهي اصطناعي','pay-it-coverage-expired');
    RAISE EXCEPTION 'expired subscription coverage was accepted';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS action_error=MESSAGE_TEXT;
    IF action_error<>'VEHICLE_SUBSCRIPTION_NOT_ELIGIBLE' THEN RAISE; END IF;
  END;
  PERFORM public.petro_admin_fleet_assign_coverage(jsonb_build_object(
    'vehicleId',v3->>'id','subscriptionId',third_subscription_id,'startsAt',now()),
    'تغطية اصطناعية للمركبة الثالثة','pay-it-coverage-3');

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
  ) VALUES(bank_id,'بنك اصطناعي للاختبار','وجهة محلية اصطناعية','3701','active',
    'حساب اصطناعي لقاعدة الاختبار فقط',actor,actor,now());
  INSERT INTO public.petro_finance_accounts(
    account_code,display_name,account_kind,normal_side,receiving_bank_account_id
  ) VALUES('PAY-IT-BANK-1601','بنك اختبار محلي','bank_clearing','debit',bank_id)
  RETURNING id INTO bank_account;
  branch_account := petro_private.finance_account_for_scope(org_a,branch_a);
  PERFORM petro_private.finance_post_entry(
    gen_random_uuid(),'bank_receipt',gen_random_uuid(),org_a,'PAY-IT-FUNDING-10000',
    'تمويل اصطناعي محلي لاختبار حجز الأسطول',
    jsonb_build_array(
      jsonb_build_object('accountId',bank_account,'side','debit','amountMinor','1000000'),
      jsonb_build_object('accountId',branch_account,'side','credit','amountMinor','1000000')
    )
  );
END
$setup$;

CREATE TEMP TABLE payment_test(ids jsonb) ON COMMIT DROP;
GRANT SELECT ON pg_temp.payment_test TO authenticated;
INSERT INTO auth.users(id,email,raw_user_meta_data,email_confirmed_at) VALUES
 ('00000000-0000-4000-8000-000000003702','order-worker@example.invalid','{"username":"order_worker"}',now());
UPDATE public.petro_profiles SET active=true,account_status='active',password_change_required=false WHERE user_id='00000000-0000-4000-8000-000000003702';
DO $fixtures$
DECLARE actor uuid:='00000000-0000-4000-8000-000000003701'; worker uuid:='00000000-0000-4000-8000-000000003702';
 merchant record; vehicle record; membership uuid:=gen_random_uuid(); fuel uuid:=gen_random_uuid(); price uuid:=gen_random_uuid();
 wash_item uuid:=gen_random_uuid(); wash_price uuid:=gen_random_uuid(); part uuid:=gen_random_uuid(); part_price uuid:=gen_random_uuid(); location uuid:=gen_random_uuid();
 credential uuid:=gen_random_uuid(); fuel_proof jsonb; wash_proof jsonb; part_proof jsonb;
BEGIN
 SELECT b.id AS branch_id,o.id AS org_id INTO STRICT merchant FROM public.petro_organizations o JOIN public.petro_branches b ON b.organization_id=o.id WHERE o.code='PAY-IT-M' AND b.code='PAY-IT-M1';
 SELECT v.id,l.id AS link_id INTO STRICT vehicle FROM public.petro_fleet_vehicles v JOIN public.petro_organizations o ON o.id=v.organization_id JOIN public.petro_fleet_driver_links l ON l.vehicle_id=v.id AND l.status='active' WHERE o.code='PAY-IT-A' AND v.internal_code='PAY-IT-A-1';
 UPDATE public.petro_fleet_vehicles SET fuel_type='order_gasoline',tank_capacity_liters=50 WHERE id=vehicle.id;
 INSERT INTO public.petro_memberships(id,user_id,organization_id,role,scope,active) VALUES(membership,worker,merchant.org_id,'worker','branches',true);
 INSERT INTO public.petro_membership_branches(organization_id,membership_id,branch_id) VALUES(merchant.org_id,membership,merchant.branch_id);
 PERFORM public.petro_admin_worker_assignment(worker,merchant.branch_id,'fuel',true,0,'order-worker-fuel-0001');
 PERFORM public.petro_admin_worker_assignment(worker,merchant.branch_id,'wash',true,0,'order-worker-wash-0001');
 PERFORM public.petro_admin_worker_assignment(worker,merchant.branch_id,'parts',true,0,'order-worker-parts-001');
 INSERT INTO public.petro_vehicle_credentials(id,organization_id,branch_id,vehicle_id,credential_type,token_sha256,token_hint,status,activated_by,reason)
 SELECT credential,v.organization_id,v.branch_id,v.id,'qr',repeat('e',64),'eeeeee','active',actor,'تعريف اختبار تسعير الخدمة' FROM public.petro_fleet_vehicles v WHERE v.id=vehicle.id;
 INSERT INTO public.petro_fuel_types(id,code,name_ar,vehicle_fuel_family,unit_code,created_by,updated_by) VALUES(fuel,'order_gasoline','وقود اختبار التسعير','gasoline','litre',actor,actor);
 INSERT INTO public.petro_fuel_price_versions(id,fuel_type_id,version,price_per_unit,unit_code,valid_from,status,reason,created_by,published_at,published_by)
 VALUES(price,fuel,1,12.5,'litre',now()-interval '1 second','published','سعر وقود اختبار التسعير',actor,now(),actor);
 INSERT INTO public.petro_catalog_items(id,organization_id,category_id,item_kind,name,unit_code,attributes,display_status,review_status,created_by,updated_by)
 SELECT wash_item,merchant.org_id,id,'service','غسيل اختبار التسعير','service','{"washMode":"interior_exterior","vehicleType":"car","vehicleSize":"medium"}'::jsonb,'active','approved',actor,actor FROM public.petro_catalog_categories WHERE code='wash';
 INSERT INTO public.petro_catalog_items(id,organization_id,category_id,item_kind,name,brand_name,unit_code,display_status,review_status,created_by,updated_by)
 SELECT part,merchant.org_id,id,'product','قطعة اختبار التسعير','ماركة الاختبار','piece','active','approved',actor,actor FROM public.petro_catalog_categories WHERE code='parts';
 INSERT INTO public.petro_catalog_branch_availability(organization_id,item_id,branch_id,available,reason,created_by,updated_by)
 VALUES(merchant.org_id,wash_item,merchant.branch_id,true,'توفير خدمة اختبار',actor,actor),(merchant.org_id,part,merchant.branch_id,true,'توفير قطعة اختبار',actor,actor);
 INSERT INTO public.petro_catalog_price_versions(id,organization_id,item_id,branch_id,version,price_minor,valid_from,status,reason,created_by,published_at,published_by)
 VALUES(wash_price,merchant.org_id,wash_item,NULL,1,2500,now()-interval '1 second','published','سعر غسيل اختبار',actor,now(),actor),
 (part_price,merchant.org_id,part,merchant.branch_id,1,10000,now()-interval '1 second','published','سعر قطعة اختبار',actor,now(),actor);
 INSERT INTO public.petro_inventory_locations(id,organization_id,branch_id,name,location_kind,created_by) VALUES(location,merchant.org_id,merchant.branch_id,'مخزن بيع اختباري','sellable',actor);
 INSERT INTO public.petro_inventory_balances(organization_id,location_id,item_id,on_hand,reserved) VALUES(merchant.org_id,location,part,2,1);
 PERFORM set_config('request.jwt.claim.sub',worker::text,true);
 fuel_proof:=public.petro_worker_verify_pair(merchant.branch_id,'fuel',repeat('e',64),repeat('a',64),'order-fuel-identity-001');
 wash_proof:=public.petro_worker_verify_pair(merchant.branch_id,'wash',repeat('e',64),repeat('a',64),'order-wash-identity-001');
 part_proof:=public.petro_worker_verify_pair(merchant.branch_id,'parts',repeat('e',64),repeat('a',64),'order-part-identity-001');
 IF fuel_proof->>'valid' IS DISTINCT FROM 'true' OR wash_proof->>'valid' IS DISTINCT FROM 'true' OR part_proof->>'valid' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Quote identity fixture invalid'; END IF;
 INSERT INTO pg_temp.payment_test VALUES(jsonb_build_object('fuel',fuel,'price',price,'wash',wash_item,'washPrice',wash_price,'part',part,'partPrice',part_price,
 'location',location,'fuelProof',fuel_proof->>'verificationId','washProof',wash_proof->>'verificationId','partProof',part_proof->>'verificationId','vehicle',vehicle.id));
END $fixtures$;



DO $payment$
DECLARE ids jsonb;o jsonb;image jsonb;r jsonb;v_order uuid;v_entry uuid;payment_id uuid;funding_account uuid;hold_id uuid;
 total_before bigint;attempts_before integer;stock_before bigint;charge_count bigint;i integer;context jsonb;receipt_json jsonb;first_negative jsonb;
BEGIN
 SELECT q.ids INTO ids FROM pg_temp.payment_test q;
 PERFORM set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000003702',true);
 o:=public.petro_worker_reserve_service_order((ids->>'fuelProof')::uuid,(ids->>'fuel')::uuid,(ids->>'price')::uuid,'{"amountMinor":"10000"}',NULL,'pay-fuel-reserve-0001');
 v_order:=(o->>'id')::uuid;
 BEGIN PERFORM public.petro_confirm_service_order(v_order,1,repeat('a',64),'pay-before-delivery-01');RAISE EXCEPTION 'Undelivered order paid';EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;END;
 PERFORM public.petro_start_service_order(v_order,1,'pay-fuel-start-0001');
 image:=public.petro_create_service_order_evidence(v_order,'odometer','payment-meter.png','image/png',68,'pay-meter-intent-0001');
 INSERT INTO storage.objects(bucket_id,name,owner_id,metadata)VALUES('petro-private-documents',image->>'objectPath','00000000-0000-4000-8000-000000003702','{"size":68,"mimetype":"image/png"}');
 PERFORM public.petro_finalize_service_order_evidence((image->>'id')::uuid,'pay-meter-finalize-001');
 PERFORM public.petro_deliver_service_order(v_order,2,'{"actualQuantity":"7","readingKm":"1000"}','pay-fuel-deliver-0001');
 context:=public.petro_service_order_payment_context(v_order);
 IF context->>'vehicleId' IS DISTINCT FROM ids->>'vehicle' OR (SELECT count(*) FROM jsonb_object_keys(context))<>1 THEN RAISE EXCEPTION 'Confirmation context leaked unrelated data';END IF;
 SELECT f.account_id,f.id INTO funding_account,hold_id FROM public.petro_finance_reservations f JOIN public.petro_fleet_usage_reservations u ON u.finance_reservation_id=f.id JOIN public.petro_service_orders so ON so.usage_reservation_id=u.id WHERE so.id=v_order;
 SELECT count(*) INTO total_before FROM public.petro_finance_journal_entries;
 first_negative:=public.petro_confirm_service_order(v_order,3,repeat('b',64),'pay-wrong-pin-first-01');
 IF first_negative->>'paid'<>'false' OR first_negative->>'locked'<>'false' THEN RAISE EXCEPTION 'Wrong final PIN was accepted';END IF;
 SELECT failed_attempts INTO attempts_before FROM petro_private.petro_fleet_pair_rate_limits WHERE vehicle_id=(ids->>'vehicle')::uuid;
 IF attempts_before<>1 THEN RAISE EXCEPTION 'Wrong PIN attempt rolled back';END IF;
 r:=public.petro_confirm_service_order(v_order,3,repeat('b',64),'pay-wrong-pin-first-01');
 IF r IS DISTINCT FROM first_negative OR(SELECT failed_attempts FROM petro_private.petro_fleet_pair_rate_limits WHERE vehicle_id=(ids->>'vehicle')::uuid)<>attempts_before THEN RAISE EXCEPTION 'Negative retry consumed another attempt';END IF;
 BEGIN PERFORM public.petro_confirm_service_order(v_order,3,repeat('a',64),'pay-wrong-pin-first-01');RAISE EXCEPTION 'Changed PIN reused final request key';EXCEPTION WHEN unique_violation THEN NULL;END;
 FOR i IN 2..5 LOOP PERFORM public.petro_confirm_service_order(v_order,3,repeat('b',64),'pay-wrong-pin-attempt-'||i::text);END LOOP;
 r:=public.petro_confirm_service_order(v_order,3,repeat('a',64),'pay-correct-while-locked');
 IF r->>'locked'<>'true' OR r->>'paid'<>'false' THEN RAISE EXCEPTION 'Shared vehicle lock bypassed';END IF;
 IF(SELECT count(*) FROM public.petro_finance_journal_entries)<>total_before OR EXISTS(SELECT 1 FROM petro_private.service_order_payments WHERE order_id=v_order) THEN RAISE EXCEPTION 'Wrong/locked PIN created financial data';END IF;
 UPDATE petro_private.petro_fleet_pair_rate_limits SET window_started_at=clock_timestamp()-interval '16 minutes',locked_until=clock_timestamp()-interval '1 second' WHERE vehicle_id=(ids->>'vehicle')::uuid;
 PERFORM set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000003701',true);
 BEGIN PERFORM public.petro_confirm_service_order(v_order,3,repeat('a',64),'pay-owner-no-bypass-01');RAISE EXCEPTION 'Owner bypassed final worker confirmation';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 PERFORM set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000003702',true);
 SELECT count(*) INTO stock_before FROM public.petro_inventory_movements;
 r:=public.petro_confirm_service_order(v_order,3,repeat('a',64),'pay-fuel-confirmation-01');
 IF r->>'paid'<>'true' OR r->>'paymentStatus'<>'paid' OR r->'payment'->>'chargedAmountMinor'<>'8750' OR r->'payment'->>'releasedAmountMinor'<>'1250' OR(r->>'version')::integer<>4 THEN RAISE EXCEPTION 'Actual charge/released difference/paid state wrong: %',r;END IF;
 v_entry:=(r->'payment'->>'journalEntryId')::uuid;
 IF(SELECT status FROM public.petro_finance_reservations WHERE id=hold_id)<>'consumed' OR(SELECT amount_minor FROM public.petro_finance_reservations WHERE id=hold_id)<>8750 THEN RAISE EXCEPTION 'Hold did not capture only actual amount';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.petro_fleet_usage_reservations u JOIN public.petro_service_orders so ON so.usage_reservation_id=u.id WHERE so.id=v_order AND u.status='consumed' AND u.amount_minor=8750 AND u.quantity=7 AND u.consumed_entry_id=v_entry) THEN RAISE EXCEPTION 'Usage amount/quantity did not match actual capture';END IF;
 IF(SELECT ledger_balance_minor FROM public.petro_finance_account_balances WHERE account_id=funding_account)<>991250 OR(SELECT available_minor FROM public.petro_finance_account_balances WHERE account_id=funding_account)<>991250 OR(SELECT reserved_minor FROM public.petro_finance_account_balances WHERE account_id=funding_account)<>0 THEN RAISE EXCEPTION 'Exact company funding/hold/release balance mismatch';END IF;
 IF(SELECT sum(amount_minor) FROM public.petro_finance_journal_lines l WHERE l.entry_id=v_entry AND l.side='debit')<>8750 OR(SELECT sum(amount_minor) FROM public.petro_finance_journal_lines l WHERE l.entry_id=v_entry AND l.side='credit')<>8750 THEN RAISE EXCEPTION 'Capture journal imbalance';END IF;
 IF(SELECT earned_amount_minor FROM petro_private.service_order_receivables WHERE order_id=v_order)<>8750 OR(SELECT count(*) FROM petro_private.service_order_receipts WHERE order_id=v_order)<>1 THEN RAISE EXCEPTION 'Merchant receivable/receipt mismatch';END IF;
 IF NOT EXISTS(SELECT 1 FROM petro_private.service_order_receivables v JOIN public.petro_service_orders so ON so.id=v.order_id WHERE v.order_id=v_order AND v.merchant_branch_id=so.merchant_branch_id AND v.merchant_organization_id=so.merchant_organization_id AND v.eligible_at>=v.period_end AND v.settlement_snapshot->>'timezone'='Africa/Cairo') THEN RAISE EXCEPTION 'Merchant scope/settlement period snapshot absent';END IF;
 receipt_json:=r->'payment'->'receipt'->'snapshot';
 IF receipt_json->>'documentKind'<>'service_receipt' OR receipt_json->>'taxTreatment'<>'not_configured' OR receipt_json->>'quantity'<>'7' OR receipt_json->>'chargedAmountMinor'<>'8750' OR receipt_json ? 'pinCode' OR receipt_json ? 'pinHmac' THEN RAISE EXCEPTION 'Receipt fabricated tax, amount or secret';END IF;
 IF(SELECT count(*) FROM public.petro_finance_outbox WHERE source_type='service_order' AND source_id=v_order AND event_type='order.paid')<>1 THEN RAISE EXCEPTION 'Payment outbox is not unique';END IF;
 SELECT count(*) INTO charge_count FROM public.petro_finance_journal_entries;
 IF public.petro_confirm_service_order(v_order,3,repeat('a',64),'pay-fuel-confirmation-01') IS DISTINCT FROM r THEN RAISE EXCEPTION 'Post-commit receipt replay changed';END IF;
 IF(SELECT count(*) FROM public.petro_finance_journal_entries)<>charge_count OR(SELECT count(*) FROM public.petro_inventory_movements)<>stock_before THEN RAISE EXCEPTION 'Payment/retry duplicated journal or physical stock';END IF;
 BEGIN PERFORM public.petro_confirm_service_order(v_order,4,repeat('a',64),'pay-second-key-denied-01');RAISE EXCEPTION 'Paid order charged by second key';EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;END;
 BEGIN UPDATE petro_private.service_order_payments SET charged_amount_minor=1 WHERE order_id=v_order;RAISE EXCEPTION 'Payment history edited';EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;END;
 BEGIN UPDATE petro_private.service_order_receipts SET snapshot='{}' WHERE order_id=v_order;RAISE EXCEPTION 'Receipt history edited';EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;END;
END $payment$;

DO $product_payment$
DECLARE ids jsonb;o jsonb;r jsonb;movements_before bigint;
BEGIN
 SELECT q.ids INTO ids FROM pg_temp.payment_test q;
 PERFORM set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000003702',true);
 o:=public.petro_worker_reserve_service_order((ids->>'partProof')::uuid,(ids->>'part')::uuid,(ids->>'partPrice')::uuid,'{"quantity":"1"}',(ids->>'location')::uuid,'pay-part-reserve-0001');
 PERFORM public.petro_start_service_order((o->>'id')::uuid,1,'pay-part-start-0001');
 PERFORM public.petro_deliver_service_order((o->>'id')::uuid,2,'{"actualQuantity":"1"}','pay-part-deliver-0001');
 SELECT count(*) INTO movements_before FROM public.petro_inventory_movements;
 r:=public.petro_confirm_service_order((o->>'id')::uuid,3,repeat('a',64),'pay-part-confirm-0001');
 IF r->>'paid'<>'true' OR r->'payment'->>'chargedAmountMinor'<>'10000' OR r->'payment'->>'releasedAmountMinor'<>'0' THEN RAISE EXCEPTION 'Product actual payment mismatch';END IF;
 PERFORM public.petro_confirm_service_order((o->>'id')::uuid,3,repeat('a',64),'pay-part-confirm-0001');
 IF(SELECT count(*) FROM public.petro_inventory_movements)<>movements_before THEN RAISE EXCEPTION 'Product payment issued/restocked physical stock twice';END IF;
END $product_payment$;

SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
