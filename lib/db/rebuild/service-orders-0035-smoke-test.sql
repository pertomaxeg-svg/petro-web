-- Disposable acceptance gate for actual order reserve/cancel/expiry.
BEGIN;
DO $$ BEGIN
 IF to_regclass('public.petro_service_orders') IS NULL
 OR to_regprocedure('public.petro_worker_reserve_service_order(uuid,uuid,uuid,jsonb,uuid,text)') IS NULL
 OR to_regprocedure('public.petro_service_orders_query(jsonb)') IS NULL
 OR to_regprocedure('public.petro_cancel_service_order(uuid,bigint,text)') IS NULL
 OR to_regprocedure('petro_private.petro_expire_service_orders(integer)') IS NULL THEN
 RAISE EXCEPTION 'Actual service order reservation and expiry are missing'; END IF;
END $$;
-- Commits disposable fixtures into the local throwaway cluster for the real
-- SQL/connection-level reserve integration test. The cluster is dropped by the
-- caller; this script never runs against Supabase.
INSERT INTO auth.users(id,email,raw_user_meta_data,email_confirmed_at)
VALUES
 ('00000000-0000-4000-8000-000000003501','order-it-owner@example.invalid',
  '{"username":"order_it_owner"}',now())
ON CONFLICT (id) DO NOTHING;
UPDATE public.petro_profiles SET active=true,account_status='active'
WHERE user_id='00000000-0000-4000-8000-000000003501';
INSERT INTO public.petro_platform_roles(user_id,role,active)
VALUES ('00000000-0000-4000-8000-000000003501','owner',true)
ON CONFLICT (user_id,role) DO UPDATE SET active=true;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000003501',false);
SELECT public.petro_create_organization_details(
 'شركة أسطول تكامل معزول','company','ORDER-IT-A',NULL,
 'مسؤول الاختبار','+201000001601','order-it-a@example.invalid','عنوان اختبار'
);
SELECT public.petro_create_organization_details(
 'شركة عزل أسطول معزول','company','ORDER-IT-B',NULL,
 'مسؤول الاختبار','+201000001602','order-it-b@example.invalid','عنوان اختبار'
);
RESET ROLE;

DO $setup$
DECLARE
  actor uuid := '00000000-0000-4000-8000-000000003501';
  org_a uuid; org_b uuid; branch_a uuid; branch_a2 uuid; branch_b uuid;
  plan_id uuid := '00000000-0000-4000-8000-000000003511';
  version_id uuid := '00000000-0000-4000-8000-000000003512';
  request_id uuid := '00000000-0000-4000-8000-000000003513';
  subscription_id uuid := '00000000-0000-4000-8000-000000003514';
  third_request_id uuid := '00000000-0000-4000-8000-000000003525';
  third_subscription_id uuid := '00000000-0000-4000-8000-000000003526';
  merchant_org uuid;
  merchant_branch uuid;
  branch_policy_id uuid := '00000000-0000-4000-8000-000000003521';
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
  SELECT id INTO org_a FROM public.petro_organizations WHERE code='ORDER-IT-A';
  SELECT id INTO org_b FROM public.petro_organizations WHERE code='ORDER-IT-B';
  PERFORM public.petro_approve_organization(org_a,1,'اعتماد شركة تكامل أسطول معزولة');
  PERFORM public.petro_set_organization_operational_status(org_a,2,'active','تفعيل شركة تكامل أسطول معزولة');
  PERFORM public.petro_approve_organization(org_b,1,'اعتماد شركة عزل أسطول معزولة');
  PERFORM public.petro_set_organization_operational_status(org_b,2,'active','تفعيل شركة عزل أسطول معزولة');
  branch_a := public.petro_create_branch_details(
    org_a,'ORDER-IT-A1','فرع تكامل أسطول','عنوان اختبار','القاهرة',
    NULL,NULL,'{}'::jsonb,'مسؤول الفرع','+201000001611');
  PERFORM public.petro_approve_branch(org_a,branch_a,1,'اعتماد فرع تكامل أسطول');
  PERFORM public.petro_set_branch_operational_status(org_a,branch_a,2,'active','تفعيل فرع تكامل أسطول');
  branch_a2 := public.petro_create_branch_details(
    org_a,'ORDER-IT-A2','فرع ثان لتكامل الأسطول','عنوان اختبار','القاهرة',
    NULL,NULL,'{}'::jsonb,'مسؤول الفرع','+201000001613');
  PERFORM public.petro_approve_branch(org_a,branch_a2,1,'اعتماد الفرع الثاني لتكامل الأسطول');
  PERFORM public.petro_set_branch_operational_status(org_a,branch_a2,2,'active','تفعيل الفرع الثاني لتكامل الأسطول');
  branch_b := public.petro_create_branch_details(
    org_b,'ORDER-IT-B1','فرع عزل أسطول','عنوان اختبار','القاهرة',
    NULL,NULL,'{}'::jsonb,'مسؤول الفرع','+201000001612');
  PERFORM public.petro_approve_branch(org_b,branch_b,1,'اعتماد فرع عزل أسطول');
  PERFORM public.petro_set_branch_operational_status(org_b,branch_b,2,'active','تفعيل فرع عزل أسطول');
  merchant_org := public.petro_create_organization_details(
    'محطة أسطول تكامل معزولة','station','ORDER-IT-M',NULL,
    'مسؤول اختبار','+201000001603','order-it-merchant@example.invalid','عنوان اختبار');
  PERFORM public.petro_approve_organization(merchant_org,1,'اعتماد محطة اختبار معزولة');
  PERFORM public.petro_set_organization_operational_status(merchant_org,2,'active','تفعيل محطة اختبار معزولة');
  merchant_branch := public.petro_create_branch_details(
    merchant_org,'ORDER-IT-M1','فرع محطة تكامل','عنوان اختبار','القاهرة',
    NULL,NULL,'{}'::jsonb,'مسؤول الفرع','+201000001604');
  PERFORM public.petro_approve_branch(merchant_org,merchant_branch,1,'اعتماد فرع محطة اختبار');
  PERFORM public.petro_set_branch_operational_status(merchant_org,merchant_branch,2,'active','تفعيل فرع محطة اختبار');

  INSERT INTO public.petro_plans(id,code,audience,name,active,description)
  VALUES(plan_id,'ORDER-IT-VEHICLE','company','خطة مركبات تكامل اختبارية',true,'synthetic fixture');
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
  ) VALUES('00000000-0000-4000-8000-000000003523',org_a,branch_a,'new',plan_id,version_id,1,
    now()-interval '3 days',now()-interval '1 day','verified','approved',
    'اشتراك منتهي اصطناعي لاختبار الرفض',actor,actor,now());
  INSERT INTO public.petro_subscriptions(
    id,request_id,organization_id,branch_id,plan_id,plan_version_id,plan_snapshot,
    price_snapshot_minor,billing_unit,units,starts_at,ends_at,status,created_by
  ) VALUES('00000000-0000-4000-8000-000000003524','00000000-0000-4000-8000-000000003523',
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
    'internalCode','ORDER-IT-A-1'),'إنشاء مركبة اصطناعية','order-it-a-vehicle-1') INTO v1;
  SELECT public.petro_admin_fleet_command('vehicle.create',jsonb_build_object(
    'organizationId',org_a,'branchId',branch_a,'plateOriginal','FLEET IT 2','plateStandard','FLEETIT2',
    'category','sedan','vehicleType','car','brand','Test','model','Two','fuelType','petrol',
    'internalCode','ORDER-IT-A-2'),'إنشاء مركبة اصطناعية','order-it-a-vehicle-2') INTO v2;
  SELECT public.petro_admin_fleet_command('vehicle.create',jsonb_build_object(
    'organizationId',org_a,'branchId',branch_a,'plateOriginal','FLEET IT 3','plateStandard','FLEETIT3',
    'category','sedan','vehicleType','car','brand','Test','model','Three','fuelType','petrol',
    'internalCode','ORDER-IT-A-3'),'إنشاء مركبة اصطناعية','order-it-a-vehicle-3') INTO v3;
  SELECT public.petro_admin_fleet_command('vehicle.create',jsonb_build_object(
    'organizationId',org_b,'branchId',branch_b,'plateOriginal','FLEET IT B1','plateStandard','FLEETITB1',
    'category','sedan','vehicleType','car','brand','Test','model','Other','fuelType','petrol',
    'internalCode','ORDER-IT-B-1'),'إنشاء مركبة اصطناعية لشركة أخرى','order-it-b-vehicle-1') INTO vb;
  vehicle_ids := ARRAY[(v1->>'id')::uuid,(v2->>'id')::uuid,(v3->>'id')::uuid,(vb->>'id')::uuid];

  SELECT public.petro_admin_fleet_command('driver.create',jsonb_build_object(
    'organizationId',org_a,'driverCode','ORDER-IT-D1','fullName','سائق تكامل أول'),
    'إنشاء سائق اصطناعي','order-it-a-driver-1') INTO d1;
  SELECT public.petro_admin_fleet_command('driver.create',jsonb_build_object(
    'organizationId',org_a,'driverCode','ORDER-IT-D2','fullName','سائق تكامل ثان'),
    'إنشاء سائق اصطناعي','order-it-a-driver-2') INTO d2;
  SELECT public.petro_admin_fleet_command('driver.create',jsonb_build_object(
    'organizationId',org_a,'driverCode','ORDER-IT-D3','fullName','سائق تكامل ثالث'),
    'إنشاء سائق اصطناعي','order-it-a-driver-3') INTO d3;
  SELECT public.petro_admin_fleet_command('driver.create',jsonb_build_object(
    'organizationId',org_b,'driverCode','ORDER-IT-DB','fullName','سائق عزل'),
    'إنشاء سائق اصطناعي لشركة أخرى','order-it-b-driver-1') INTO db;
  SELECT public.petro_admin_fleet_command('driver.link.create',jsonb_build_object(
    'vehicleId',v1->>'id','driverId',d1->>'id','startsAt','2024-07-01T12:00:00Z',
    'pinHmac',repeat('a',64),'pinCiphertext',repeat('0',64),'pinKeyVersion',1),
    'ربط سائق اصطناعي','order-it-a-link-1') INTO l1;
  SELECT public.petro_admin_fleet_command('driver.link.create',jsonb_build_object(
    'vehicleId',v2->>'id','driverId',d2->>'id',
    'pinHmac',repeat('b',64),'pinCiphertext',repeat('0',64),'pinKeyVersion',1),
    'ربط سائق اصطناعي','order-it-a-link-2') INTO l2;
  SELECT public.petro_admin_fleet_command('driver.link.create',jsonb_build_object(
    'vehicleId',v3->>'id','driverId',d3->>'id',
    'pinHmac',repeat('c',64),'pinCiphertext',repeat('0',64),'pinKeyVersion',1),
    'ربط سائق اصطناعي','order-it-a-link-3') INTO l3;
  SELECT public.petro_admin_fleet_command('driver.link.create',jsonb_build_object(
    'vehicleId',vb->>'id','driverId',db->>'id',
    'pinHmac',repeat('d',64),'pinCiphertext',repeat('0',64),'pinKeyVersion',1),
    'ربط سائق اصطناعي لشركة أخرى','order-it-b-link-1') INTO lb;

  SELECT public.petro_admin_fleet_assign_coverage(jsonb_build_object(
    'vehicleId',v1->>'id','subscriptionId',subscription_id,'startsAt',now()),
    'تغطية مركبة اصطناعية','order-it-coverage-1') INTO covered;
  SELECT public.petro_admin_fleet_assign_coverage(jsonb_build_object(
    'vehicleId',v1->>'id','subscriptionId',subscription_id,'startsAt',now()),
    'تغطية مركبة اصطناعية','order-it-coverage-1') INTO covered_replay;
  IF covered_replay->>'id'<>covered->>'id' OR covered_replay->>'replayed'<>'true' THEN
    RAISE EXCEPTION 'coverage assignment did not replay its original result';
  END IF;
  BEGIN
    PERFORM public.petro_admin_fleet_assign_coverage(jsonb_build_object(
      'vehicleId',v1->>'id','subscriptionId',subscription_id,'startsAt',now()+interval '1 second'),
      'حمولة مختلفة','order-it-coverage-1');
    RAISE EXCEPTION 'coverage idempotency accepted a changed payload';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    PERFORM public.petro_admin_fleet_assign_coverage(jsonb_build_object(
      'vehicleId',v1->>'id','subscriptionId',subscription_id,'startsAt',now()),
      'سبب مختلف','order-it-coverage-1');
    RAISE EXCEPTION 'coverage idempotency accepted a changed reason';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    PERFORM public.petro_admin_fleet_assign_coverage(jsonb_build_object(
      'vehicleId',v1->>'id','subscriptionId',subscription_id,'startsAt',now()),
      'تغطية مكررة اصطناعية','order-it-coverage-duplicate');
    RAISE EXCEPTION 'duplicate active vehicle coverage was accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  SELECT public.petro_admin_fleet_assign_coverage(jsonb_build_object(
    'vehicleId',v2->>'id','subscriptionId',subscription_id,'startsAt',now()),
    'تغطية مركبة اصطناعية','order-it-coverage-2') INTO covered;
  BEGIN
    PERFORM public.petro_admin_fleet_assign_coverage(jsonb_build_object(
      'vehicleId',v3->>'id','subscriptionId',subscription_id,'startsAt',now()),
      'تجاوز سعة اصطناعي','order-it-coverage-over');
    RAISE EXCEPTION 'coverage capacity overflow was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    PERFORM public.petro_admin_fleet_assign_coverage(jsonb_build_object(
      'vehicleId',vb->>'id','subscriptionId',subscription_id,'startsAt',now()),
      'محاولة عزل شركة اصطناعية','order-it-coverage-cross-company');
    RAISE EXCEPTION 'cross-company coverage was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    PERFORM public.petro_admin_fleet_assign_coverage(jsonb_build_object(
      'vehicleId',v3->>'id','subscriptionId','00000000-0000-4000-8000-000000003524',
      'startsAt',now()),'اشتراك منتهي اصطناعي','order-it-coverage-expired');
    RAISE EXCEPTION 'expired subscription coverage was accepted';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS action_error=MESSAGE_TEXT;
    IF action_error<>'VEHICLE_SUBSCRIPTION_NOT_ELIGIBLE' THEN RAISE; END IF;
  END;
  PERFORM public.petro_admin_fleet_assign_coverage(jsonb_build_object(
    'vehicleId',v3->>'id','subscriptionId',third_subscription_id,'startsAt',now()),
    'تغطية اصطناعية للمركبة الثالثة','order-it-coverage-3');

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
  ) VALUES(bank_id,'بنك اصطناعي للاختبار','وجهة محلية اصطناعية','3501','active',
    'حساب اصطناعي لقاعدة الاختبار فقط',actor,actor,now());
  INSERT INTO public.petro_finance_accounts(
    account_code,display_name,account_kind,normal_side,receiving_bank_account_id
  ) VALUES('ORDER-IT-BANK-1601','بنك اختبار محلي','bank_clearing','debit',bank_id)
  RETURNING id INTO bank_account;
  branch_account := petro_private.finance_account_for_scope(org_a,branch_a);
  PERFORM petro_private.finance_post_entry(
    gen_random_uuid(),'bank_receipt',gen_random_uuid(),org_a,'ORDER-IT-FUNDING-10000',
    'تمويل اصطناعي محلي لاختبار حجز الأسطول',
    jsonb_build_array(
      jsonb_build_object('accountId',bank_account,'side','debit','amountMinor','1000000'),
      jsonb_build_object('accountId',branch_account,'side','credit','amountMinor','1000000')
    )
  );
END
$setup$;

CREATE TEMP TABLE order_test(ids jsonb) ON COMMIT DROP;
GRANT SELECT ON pg_temp.order_test TO authenticated;
INSERT INTO auth.users(id,email,raw_user_meta_data,email_confirmed_at) VALUES
 ('00000000-0000-4000-8000-000000003502','order-worker@example.invalid','{"username":"order_worker"}',now());
UPDATE public.petro_profiles SET active=true,account_status='active',password_change_required=false WHERE user_id='00000000-0000-4000-8000-000000003502';
DO $fixtures$
DECLARE actor uuid:='00000000-0000-4000-8000-000000003501'; worker uuid:='00000000-0000-4000-8000-000000003502';
 merchant record; vehicle record; membership uuid:=gen_random_uuid(); fuel uuid:=gen_random_uuid(); price uuid:=gen_random_uuid();
 wash_item uuid:=gen_random_uuid(); wash_price uuid:=gen_random_uuid(); part uuid:=gen_random_uuid(); part_price uuid:=gen_random_uuid(); location uuid:=gen_random_uuid();
 credential uuid:=gen_random_uuid(); fuel_proof jsonb; wash_proof jsonb; part_proof jsonb;
BEGIN
 SELECT b.id AS branch_id,o.id AS org_id INTO STRICT merchant FROM public.petro_organizations o JOIN public.petro_branches b ON b.organization_id=o.id WHERE o.code='ORDER-IT-M' AND b.code='ORDER-IT-M1';
 SELECT v.id,l.id AS link_id INTO STRICT vehicle FROM public.petro_fleet_vehicles v JOIN public.petro_organizations o ON o.id=v.organization_id JOIN public.petro_fleet_driver_links l ON l.vehicle_id=v.id AND l.status='active' WHERE o.code='ORDER-IT-A' AND v.internal_code='ORDER-IT-A-1';
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
 INSERT INTO pg_temp.order_test VALUES(jsonb_build_object('fuel',fuel,'price',price,'wash',wash_item,'washPrice',wash_price,'part',part,'partPrice',part_price,
 'location',location,'fuelProof',fuel_proof->>'verificationId','washProof',wash_proof->>'verificationId','partProof',part_proof->>'verificationId','vehicle',vehicle.id));
END $fixtures$;

SET LOCAL ROLE authenticated;
DO $order_flow$
DECLARE ids jsonb; v_order jsonb; v_replay jsonb; v_detail jsonb; v_cancel jsonb;
BEGIN
 SELECT q.ids INTO ids FROM pg_temp.order_test q;
 v_order:=public.petro_worker_reserve_service_order((ids->>'fuelProof')::uuid,(ids->>'fuel')::uuid,(ids->>'price')::uuid,'{"amountMinor":"10000"}',NULL,'order-fuel-reservation-001');
 IF v_order->>'status' IS DISTINCT FROM 'reserved' OR v_order->>'paymentStatus' IS DISTINCT FROM 'held' OR v_order->>'amountMinor' IS DISTINCT FROM '10000' OR (v_order->>'quantity')::numeric<>8 THEN
 RAISE EXCEPTION 'Order did not create a real typed reservation: %',v_order; END IF;
 v_replay:=public.petro_worker_reserve_service_order((ids->>'fuelProof')::uuid,(ids->>'fuel')::uuid,(ids->>'price')::uuid,'{"amountMinor":"10000"}',NULL,'order-fuel-reservation-001');
 IF v_replay->>'id' IS DISTINCT FROM v_order->>'id' THEN RAISE EXCEPTION 'Committed reservation retry duplicated order'; END IF;
 BEGIN
  PERFORM public.petro_worker_reserve_service_order((ids->>'fuelProof')::uuid,(ids->>'fuel')::uuid,(ids->>'price')::uuid,'{"amountMinor":"10001"}',NULL,'order-fuel-reservation-001');
  RAISE EXCEPTION 'Changed reservation payload reused key';
 EXCEPTION WHEN unique_violation OR serialization_failure OR SQLSTATE 'PT409' THEN IF SQLSTATE='PT409' AND SQLERRM NOT IN('OPERATIONAL_PROOF_ALREADY_USED','ORDER_VERSION_CONFLICT') THEN RAISE;END IF; END;
 BEGIN
  PERFORM public.petro_worker_reserve_service_order((ids->>'fuelProof')::uuid,(ids->>'fuel')::uuid,(ids->>'price')::uuid,'{"amountMinor":"10000"}',NULL,'order-fuel-proof-reused-001');
  RAISE EXCEPTION 'Consumed first proof booked another order';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 v_detail:=public.petro_service_orders_query(jsonb_build_object('orderId',v_order->>'id'));
 IF v_detail->>'id' IS DISTINCT FROM v_order->>'id' OR v_detail->>'paymentStatus' IS DISTINCT FROM 'held' THEN RAISE EXCEPTION 'Owned order reload lost committed state'; END IF;
 BEGIN
  PERFORM public.petro_cancel_service_order((v_order->>'id')::uuid,99,'order-cancel-stale-0001');
  RAISE EXCEPTION 'Stale cancel version accepted';
 EXCEPTION WHEN serialization_failure OR SQLSTATE 'PT409' THEN IF SQLSTATE='PT409' AND SQLERRM<>'ORDER_VERSION_CONFLICT' THEN RAISE;END IF; END;
 v_cancel:=public.petro_cancel_service_order((v_order->>'id')::uuid,(v_order->>'version')::bigint,'order-fuel-cancel-0001');
 IF v_cancel->>'status' IS DISTINCT FROM 'cancelled' OR v_cancel->>'paymentStatus' IS DISTINCT FROM 'unpaid' THEN RAISE EXCEPTION 'Unstarted cancellation did not release order'; END IF;
 v_replay:=public.petro_cancel_service_order((v_order->>'id')::uuid,(v_order->>'version')::bigint,'order-fuel-cancel-0001');
 IF v_replay->>'id' IS DISTINCT FROM v_order->>'id' OR v_replay->>'version' IS DISTINCT FROM v_cancel->>'version' THEN RAISE EXCEPTION 'Cancellation retry changed state twice'; END IF;
END $order_flow$;
RESET ROLE;
DO $atomic_and_expiry$
DECLARE ids jsonb; v_order jsonb; v_detail jsonb; v_proof jsonb; v_branch uuid; v_out jsonb; v_before bigint; v_hold uuid;
BEGIN
 SELECT q.ids INTO ids FROM pg_temp.order_test q;
 SELECT merchant_branch_id INTO v_branch FROM petro_private.worker_pin_proofs WHERE id=(ids->>'partProof')::uuid;
 v_order:=public.petro_worker_reserve_service_order((ids->>'partProof')::uuid,(ids->>'part')::uuid,(ids->>'partPrice')::uuid,'{"quantity":"1"}',(ids->>'location')::uuid,'order-product-reserve-01');
 IF v_order->>'status' IS DISTINCT FROM 'reserved' THEN RAISE EXCEPTION 'Product order was not reserved'; END IF;
 IF (SELECT reserved FROM public.petro_inventory_balances WHERE location_id=(ids->>'location')::uuid AND item_id=(ids->>'part')::uuid)<>2 THEN RAISE EXCEPTION 'Product order did not hold actual stock'; END IF;
 SELECT count(*) INTO v_before FROM public.petro_finance_reservations WHERE status='active';
 v_proof:=public.petro_worker_verify_pair(v_branch,'parts',repeat('e',64),repeat('a',64),'order-product-proof-02');
 BEGIN
  PERFORM public.petro_worker_reserve_service_order((v_proof->>'verificationId')::uuid,(ids->>'part')::uuid,(ids->>'partPrice')::uuid,'{"quantity":"1"}',(ids->>'location')::uuid,'order-product-no-stock-1');
  RAISE EXCEPTION 'Out-of-stock order accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 IF (SELECT count(*) FROM public.petro_finance_reservations WHERE status='active')<>v_before THEN RAISE EXCEPTION 'Failed stock booking left orphan financial hold'; END IF;
 UPDATE public.petro_service_orders SET expires_at=clock_timestamp()-interval '1 second',created_at=clock_timestamp()-interval '16 minutes' WHERE id=(v_order->>'id')::uuid;
 v_out:=petro_private.petro_expire_service_orders(100);
 v_detail:=public.petro_service_orders_query(jsonb_build_object('orderId',v_order->>'id'));
 IF v_detail->>'status' IS DISTINCT FROM 'cancelled' OR v_detail->>'paymentStatus' IS DISTINCT FROM 'unpaid' THEN RAISE EXCEPTION 'Expiry did not release an unstarted order'; END IF;
 IF (SELECT on_hand FROM public.petro_inventory_balances WHERE location_id=(ids->>'location')::uuid AND item_id=(ids->>'part')::uuid)<>2
 OR (SELECT reserved FROM public.petro_inventory_balances WHERE location_id=(ids->>'location')::uuid AND item_id=(ids->>'part')::uuid)<>1 THEN RAISE EXCEPTION 'Expiry changed physical stock or failed to release reserved stock'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.petro_inventory_movements m JOIN public.petro_service_orders o ON o.inventory_reservation_id=m.reservation_id
  WHERE o.id=(v_order->>'id')::uuid AND m.movement_kind='release' AND m.actor_id IS NULL AND m.system_actor='service_order_expiry' AND m.on_hand_delta=0) THEN RAISE EXCEPTION 'Expiry forged stock executor or restocked issued goods'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.petro_finance_reservations f JOIN public.petro_fleet_usage_reservations u ON u.finance_reservation_id=f.id JOIN public.petro_service_orders o ON o.usage_reservation_id=u.id
  WHERE o.id=(v_order->>'id')::uuid AND f.status='released' AND f.closed_by IS NULL AND f.closed_by_system='service_order_expiry') THEN RAISE EXCEPTION 'Expiry forged financial executor'; END IF;
 v_proof:=public.petro_worker_verify_pair(v_branch,'fuel',repeat('e',64),repeat('a',64),'order-started-proof-001');
 v_order:=public.petro_worker_reserve_service_order((v_proof->>'verificationId')::uuid,(ids->>'fuel')::uuid,(ids->>'price')::uuid,'{"amountMinor":"10000"}',NULL,'order-started-reserve-001');
 UPDATE public.petro_service_orders SET status='in_progress',started_at=clock_timestamp(),expires_at=clock_timestamp()-interval '1 second',created_at=clock_timestamp()-interval '16 minutes' WHERE id=(v_order->>'id')::uuid;
 PERFORM petro_private.petro_expire_service_orders(100);
 IF (SELECT status FROM public.petro_service_orders WHERE id=(v_order->>'id')::uuid)<>'in_progress' THEN RAISE EXCEPTION 'Expiry released work that already started'; END IF;
 BEGIN
  PERFORM public.petro_cancel_service_order((v_order->>'id')::uuid,(v_order->>'version')::bigint,'order-started-cancel-001');
  RAISE EXCEPTION 'Cancellation released started work';
 EXCEPTION WHEN object_not_in_prerequisite_state OR check_violation THEN NULL; END;
END $atomic_and_expiry$;
ROLLBACK;
