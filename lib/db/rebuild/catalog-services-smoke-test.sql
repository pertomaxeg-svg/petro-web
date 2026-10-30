-- Disposable local-only acceptance coverage for migration 0017.
-- Synthetic organizations, memberships, catalog rows and prices roll back together.
BEGIN;

INSERT INTO auth.users (id,email,raw_user_meta_data,email_confirmed_at) VALUES
  ('00000000-0000-4000-8000-000000000901','catalog-owner@example.invalid','{"username":"catalog_owner","display_name":"مالك اختبار"}',now()),
  ('00000000-0000-4000-8000-000000000902','catalog-operations@example.invalid','{"username":"catalog_operations","display_name":"عمليات اختبار"}',now()),
  ('00000000-0000-4000-8000-000000000903','catalog-finance@example.invalid','{"username":"catalog_finance","display_name":"مالية اختبار"}',now()),
  ('00000000-0000-4000-8000-000000000904','catalog-station@example.invalid','{"username":"catalog_station","display_name":"محطة اختبار"}',now()),
  ('00000000-0000-4000-8000-000000000905','catalog-branch@example.invalid','{"username":"catalog_branch","display_name":"مدير فرع اختبار"}',now()),
  ('00000000-0000-4000-8000-000000000906','catalog-provider@example.invalid','{"username":"catalog_provider","display_name":"مقدم اختبار"}',now());

UPDATE public.petro_profiles SET active=true,account_status='active'
WHERE user_id BETWEEN '00000000-0000-4000-8000-000000000901'::uuid
                  AND '00000000-0000-4000-8000-000000000906'::uuid;

INSERT INTO public.petro_platform_roles(user_id,role,active) VALUES
  ('00000000-0000-4000-8000-000000000901','owner',true),
  ('00000000-0000-4000-8000-000000000902','operations',true),
  ('00000000-0000-4000-8000-000000000903','finance',true);

DO $acl$
BEGIN
  IF has_table_privilege('anon','public.petro_catalog_items','SELECT')
     OR has_table_privilege('authenticated','public.petro_catalog_items','SELECT')
     OR has_table_privilege('service_role','public.petro_catalog_items','SELECT')
     OR NOT has_function_privilege('authenticated','public.petro_catalog_command(text,jsonb,text,text)','EXECUTE')
     OR has_function_privilege('anon','public.petro_catalog_command(text,jsonb,text,text)','EXECUTE')
     OR has_function_privilege('service_role','public.petro_catalog_command(text,jsonb,text,text)','EXECUTE')
     OR has_function_privilege('authenticated','petro_private.catalog_attributes_valid(text,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION '0017 table/helper/RPC grants are broader than intended';
  END IF;
END
$acl$;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000901';
DO $fixtures$
DECLARE
  station_id uuid;
  provider_id uuid;
  station_branch_id uuid;
  station_second_branch_id uuid;
  provider_branch_id uuid;
BEGIN
  station_id:=public.petro_create_organization_details(
    'محطة كتالوج اختبار','station','CATALOG-STATION',NULL,'مسؤول الاختبار',
    '+201000000901','station.catalog@example.invalid','عنوان اختبار'
  );
  provider_id:=public.petro_create_organization_details(
    'مقدم كتالوج اختبار','provider','CATALOG-PROVIDER',NULL,'مسؤول الاختبار',
    '+201000000902','provider.catalog@example.invalid','عنوان اختبار'
  );
  PERFORM public.petro_approve_organization(station_id,1,'اعتماد جهة محلية للاختبار');
  PERFORM public.petro_set_organization_operational_status(station_id,2,'active','تفعيل جهة محلية للاختبار');
  PERFORM public.petro_approve_organization(provider_id,1,'اعتماد جهة محلية للاختبار');
  PERFORM public.petro_set_organization_operational_status(provider_id,2,'active','تفعيل جهة محلية للاختبار');

  station_branch_id:=public.petro_create_branch_details(
    station_id,'CAT-ST-1','فرع المحطة الأول','عنوان اختبار','القاهرة',NULL,NULL,'{}','مسؤول فرع','+201000000911'
  );
  station_second_branch_id:=public.petro_create_branch_details(
    station_id,'CAT-ST-2','فرع المحطة الثاني','عنوان اختبار','القاهرة',NULL,NULL,'{}','مسؤول فرع','+201000000912'
  );
  provider_branch_id:=public.petro_create_branch_details(
    provider_id,'CAT-PR-1','فرع مقدم الخدمة','عنوان اختبار','الجيزة',NULL,NULL,'{}','مسؤول فرع','+201000000913'
  );
  PERFORM public.petro_approve_branch(station_id,station_branch_id,1,'اعتماد فرع محلي للاختبار');
  PERFORM public.petro_set_branch_operational_status(station_id,station_branch_id,2,'active','تفعيل فرع محلي للاختبار');
  PERFORM public.petro_approve_branch(station_id,station_second_branch_id,1,'اعتماد فرع محلي للاختبار');
  PERFORM public.petro_set_branch_operational_status(station_id,station_second_branch_id,2,'active','تفعيل فرع محلي للاختبار');
  PERFORM public.petro_approve_branch(provider_id,provider_branch_id,1,'اعتماد فرع محلي للاختبار');
  PERFORM public.petro_set_branch_operational_status(provider_id,provider_branch_id,2,'active','تفعيل فرع محلي للاختبار');
END
$fixtures$;
RESET ROLE;

INSERT INTO public.petro_memberships(user_id,organization_id,role,scope,active)
SELECT '00000000-0000-4000-8000-000000000904',o.id,'organization_owner','organization',true
FROM public.petro_organizations o WHERE o.code='CATALOG-STATION';
INSERT INTO public.petro_memberships(user_id,organization_id,role,scope,active)
SELECT '00000000-0000-4000-8000-000000000905',o.id,'manager','branches',true
FROM public.petro_organizations o WHERE o.code='CATALOG-STATION';
INSERT INTO public.petro_membership_branches(organization_id,membership_id,branch_id)
SELECT m.organization_id,m.id,b.id
FROM public.petro_memberships m
JOIN public.petro_organizations o ON o.id=m.organization_id AND o.code='CATALOG-STATION'
JOIN public.petro_branches b ON b.organization_id=o.id AND b.code='CAT-ST-1'
WHERE m.user_id='00000000-0000-4000-8000-000000000905';
INSERT INTO public.petro_memberships(user_id,organization_id,role,scope,active)
SELECT '00000000-0000-4000-8000-000000000906',o.id,'organization_owner','organization',true
FROM public.petro_organizations o WHERE o.code='CATALOG-PROVIDER';

CREATE TEMP TABLE catalog_test_ids(
  station_id uuid NOT NULL, station_branch_id uuid NOT NULL, station_branch_2_id uuid NOT NULL,
  provider_id uuid NOT NULL, provider_branch_id uuid NOT NULL, item_id uuid NOT NULL,
  category_id uuid NOT NULL, fuel_category_id uuid NOT NULL, fuel_type_id uuid NOT NULL, image_id uuid NOT NULL
) ON COMMIT DROP;
GRANT SELECT,UPDATE ON pg_temp.catalog_test_ids TO authenticated;
INSERT INTO pg_temp.catalog_test_ids
SELECT station.id,station_branch.id,station_branch_2.id,provider.id,provider_branch.id,gen_random_uuid(),
  wash.id,fuel_category.id,fuel.id,gen_random_uuid()
FROM public.petro_organizations station
JOIN public.petro_branches station_branch ON station_branch.organization_id=station.id AND station_branch.code='CAT-ST-1'
JOIN public.petro_branches station_branch_2 ON station_branch_2.organization_id=station.id AND station_branch_2.code='CAT-ST-2'
JOIN public.petro_organizations provider ON provider.code='CATALOG-PROVIDER'
JOIN public.petro_branches provider_branch ON provider_branch.organization_id=provider.id AND provider_branch.code='CAT-PR-1'
CROSS JOIN public.petro_catalog_categories wash
CROSS JOIN public.petro_catalog_categories fuel_category
CROSS JOIN public.petro_fuel_types fuel
WHERE station.code='CATALOG-STATION' AND wash.code='wash'
  AND fuel_category.code='fuel' AND fuel.code='gasoline_92';

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000904';
DO $merchant_catalog$
<<merchant_catalog>>
DECLARE
  station_id uuid;
  station_branch_id uuid;
  station_branch_2_id uuid;
  provider_id uuid;
  provider_branch_id uuid;
  category_id uuid;
  fuel_category_id uuid;
  fuel_id uuid;
  item_id uuid;
  image_id uuid;
  response jsonb;
  local_start text;
  local_future text;
BEGIN
  SELECT c.station_id,c.station_branch_id,c.station_branch_2_id,c.provider_id,c.provider_branch_id,
    c.category_id,c.fuel_category_id,c.fuel_type_id INTO station_id,station_branch_id,station_branch_2_id,
    provider_id,provider_branch_id,category_id,fuel_category_id,fuel_id
  FROM pg_temp.catalog_test_ids c LIMIT 1;

  response:=public.petro_catalog_reference_data();
  IF jsonb_array_length(response->'categories')<1 OR jsonb_array_length(response->'units')<1 THEN
    RAISE EXCEPTION 'merchant reference data is empty';
  END IF;
  BEGIN
    PERFORM public.petro_catalog_admin_organizations(NULL,NULL,1,20);
    RAISE EXCEPTION 'merchant read central merchant directory';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.petro_catalog_command('item.create',
      jsonb_build_object('organizationId',station_id,'categoryId',fuel_category_id,'kind','product',
        'name','وقود غير مسموح','unitCode','litre','attributes','{}'::jsonb),
      'محاولة اختبار منع الوقود','catalog-denied-fuel-merchant-0001');
    RAISE EXCEPTION 'station created a merchant-owned fuel item';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;

  response:=public.petro_catalog_command('item.create',
    jsonb_build_object('organizationId',station_id,'categoryId',category_id,'kind','service',
      'name','غسيل تجريبي معزول','description','اختبار محلي فقط','internalCode','LOCAL-WASH-1',
       'unitCode','service','attributes',jsonb_build_object('washMode','exterior','vehicleType','سيارة اختبار',
         'vehicleSize','متوسطة','vehicleTypes',jsonb_build_array('نوع اختبار'),'durationMinutes',20,
         'included','غسيل خارجي','addOns',jsonb_build_array('تلميع اختباري'))),
    'إنشاء سجل كتالوج محلي للاختبار','catalog-item-create-key-000001');
  item_id:=(response->>'id')::uuid;
  IF response->>'status'<>'draft' THEN RAISE EXCEPTION 'merchant item was not saved as draft'; END IF;
  response:=public.petro_catalog_command('item.update',
    jsonb_build_object('itemId',item_id,'expectedVersion',1,'name','غسيل تجريبي معدل',
      'unitCode','service','attributes',jsonb_build_object('washMode','exterior',
        'vehicleType','سيارة اختبار','vehicleSize','متوسطة','included','غسيل خارجي')),
    'اختبار تحديث نسخة الغسيل المحلية','catalog-wash-valid-update-0001');
  IF (response->>'version')::integer<>2 THEN RAISE EXCEPTION 'valid wash update did not create version two'; END IF;
  BEGIN
    PERFORM public.petro_catalog_command('item.update',
      jsonb_build_object('itemId',item_id,'expectedVersion',2,'name','غسيل بلا فئة',
        'unitCode','piece','attributes',jsonb_build_object('included','غسيل فقط')),
      'اختبار منع حذف خصائص الغسيل','catalog-wash-invalid-update-0001');
    RAISE EXCEPTION 'wash update removed its type, vehicle, size or service unit';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF (public.petro_catalog_command('item.create',
      jsonb_build_object('organizationId',station_id,'categoryId',category_id,'kind','service',
        'name','غسيل تجريبي معزول','description','اختبار محلي فقط','internalCode','LOCAL-WASH-1',
        'unitCode','service','attributes',jsonb_build_object('washMode','exterior','vehicleType','سيارة اختبار',
          'vehicleSize','متوسطة','vehicleTypes',jsonb_build_array('نوع اختبار'),'durationMinutes',20,
          'included','غسيل خارجي','addOns',jsonb_build_array('تلميع اختباري'))),
      'إنشاء سجل كتالوج محلي للاختبار','catalog-item-create-key-000001')->>'replayed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'same idempotency key did not return the original result';
  END IF;
  BEGIN
    PERFORM public.petro_catalog_command('item.create',
      jsonb_build_object('organizationId',station_id,'categoryId',category_id,'kind','service',
        'name','غسيل بلا نوع أو حجم','unitCode','service',
        'attributes',jsonb_build_object('included','غسيل فقط')),
      'رفض خدمة غسيل غير محددة محليًا','catalog-wash-variant-invalid-0001');
    RAISE EXCEPTION 'wash item without wash mode/type/size was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.petro_catalog_command('item.create',
      jsonb_build_object('organizationId',station_id,'categoryId',category_id,'kind','service',
        'name','محتوى مختلف','unitCode','service','attributes','{}'::jsonb),
      'إعادة استخدام غير صحيحة','catalog-item-create-key-000001');
    RAISE EXCEPTION 'idempotency key accepted a different payload';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  local_start:=to_char(now() AT TIME ZONE 'Africa/Cairo','YYYY-MM-DD HH24:MI:SS.US');
  response:=public.petro_catalog_command('item.price.create_draft',
    jsonb_build_object('itemId',item_id,'priceMinor','12550','validFromLocal',local_start),
    'سعر محلي للاختبار','catalog-org-price-draft-key-0001');
  IF response->>'status'<>'draft' THEN RAISE EXCEPTION 'merchant price was not drafted'; END IF;

  UPDATE pg_temp.catalog_test_ids AS ids
  SET item_id=merchant_catalog.item_id
  WHERE ids.station_id=merchant_catalog.station_id;
END
$merchant_catalog$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000902';
DO $central_review$
DECLARE fixture record; response jsonb;
BEGIN
  SELECT * INTO fixture FROM pg_temp.catalog_test_ids;
  BEGIN
    PERFORM public.petro_catalog_command('item.create',
      jsonb_build_object('organizationId',fixture.station_id,'categoryId',fixture.category_id,
        'kind','service','name','محاولة إدارة مركزية دون تفويض','unitCode','service','attributes','{}'::jsonb),
      'اختبار رفض تعديل كتالوج تاجر دون عضوية','catalog-central-merchant-write-denied-01');
    RAISE EXCEPTION 'central platform role edited a merchant catalog without a merchant membership';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.petro_catalog_command('item.review',
      jsonb_build_object('itemId',fixture.item_id,'reviewStatus','approved','expectedVersion',0),
      'محاولة stale','catalog-review-stale-key-0001');
    RAISE EXCEPTION 'stale item review unexpectedly succeeded';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  response:=public.petro_catalog_command('item.review',
    jsonb_build_object('itemId',fixture.item_id,'reviewStatus','approved','expectedVersion',2),
    'مراجعة محلية للاختبار','catalog-review-ok-key-000001');
  IF response->>'reviewStatus'<>'approved' THEN RAISE EXCEPTION 'central review did not approve item'; END IF;
  BEGIN
    PERFORM public.petro_catalog_command('item.status',
      jsonb_build_object('itemId',fixture.item_id,'status','active','expectedVersion',3),
      'محاولة تفعيل مركزي دون ملكية','catalog-central-item-activation-denied');
    RAISE EXCEPTION 'central reviewer activated merchant item';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$central_review$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000904';
DO $merchant_activation$
DECLARE fixture record; response jsonb;
BEGIN
  SELECT * INTO fixture FROM pg_temp.catalog_test_ids;
  response:=public.petro_catalog_command('item.status',
    jsonb_build_object('itemId',fixture.item_id,'status','active','expectedVersion',3),
    'تفعيل محلي بعد المراجعة','catalog-item-active-key-000001');
  IF response->>'status'<>'active' THEN RAISE EXCEPTION 'approved merchant item did not activate'; END IF;
END
$merchant_activation$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000902';
DO $central_suspension$
DECLARE fixture record; response jsonb;
BEGIN
  SELECT * INTO fixture FROM pg_temp.catalog_test_ids;
  response:=public.petro_catalog_command('item.status',
    jsonb_build_object('itemId',fixture.item_id,'status','suspended','expectedVersion',4),
    'إيقاف مركزي موثق في اختبار معزول','catalog-central-suspend-key-00001');
  IF response->>'status'<>'suspended' THEN RAISE EXCEPTION 'central suspension failed'; END IF;
END
$central_suspension$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000904';
DO $merchant_cannot_lift_suspension$
DECLARE fixture record;
BEGIN
  SELECT * INTO fixture FROM pg_temp.catalog_test_ids;
  BEGIN
    PERFORM public.petro_catalog_command('item.status',
      jsonb_build_object('itemId',fixture.item_id,'status','active','expectedVersion',5),
      'محاولة تفعيل بعد إيقاف مركزي','catalog-merchant-lift-denied-01');
    RAISE EXCEPTION 'merchant bypassed central suspension';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$merchant_cannot_lift_suspension$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000902';
DO $central_lift$
DECLARE fixture record; response jsonb;
BEGIN
  SELECT * INTO fixture FROM pg_temp.catalog_test_ids;
  response:=public.petro_catalog_command('item.status',
    jsonb_build_object('itemId',fixture.item_id,'status','active','expectedVersion',5),
    'رفع إيقاف مركزي بعد المراجعة في اختبار معزول','catalog-central-lift-key-00001');
  IF response->>'status'<>'active' THEN RAISE EXCEPTION 'authorized central suspension lift failed'; END IF;
END
$central_lift$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000904';
DO $merchant_prices$
DECLARE fixture record; response jsonb; first_price uuid; second_price uuid; before_count integer;
  local_start text; local_later text;
BEGIN
  SELECT * INTO fixture FROM pg_temp.catalog_test_ids;
  response:=public.petro_catalog_command('item.branch_availability',
    jsonb_build_object('itemId',fixture.item_id,'branchId',fixture.station_branch_id,
      'available',true,'expectedVersion',0),
    'إتاحة محلية','catalog-availability-create-key-001');
  IF response->>'available'<>'true' THEN RAISE EXCEPTION 'branch availability was not saved'; END IF;
  BEGIN
    PERFORM public.petro_catalog_command('item.branch_availability',
      jsonb_build_object('itemId',fixture.item_id,'branchId',fixture.station_branch_id,
        'available',false,'expectedVersion',0),
      'محاولة نسخة قديمة','catalog-availability-stale-key-001');
    RAISE EXCEPTION 'stale branch availability update unexpectedly succeeded';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  BEGIN
    PERFORM public.petro_catalog_command('item.branch_availability',
      jsonb_build_object('itemId',fixture.item_id,'branchId',fixture.provider_branch_id,
        'available',true,'expectedVersion',0),
      'محاولة ربط بفرع جهة أخرى','catalog-availability-cross-key-001');
    RAISE EXCEPTION 'merchant linked item to another organization branch';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  local_start:=to_char((now()+interval '1 hour') AT TIME ZONE 'Africa/Cairo','YYYY-MM-DD HH24:MI:SS.US');
  local_later:=to_char((now()+interval '2 hours') AT TIME ZONE 'Africa/Cairo','YYYY-MM-DD HH24:MI:SS.US');
  response:=public.petro_catalog_command('item.price.create_draft',
    jsonb_build_object('itemId',fixture.item_id,'branchId',fixture.station_branch_id,
      'priceMinor','14500','validFromLocal',local_start),
    'سعر فرعي أول','catalog-branch-price-one-key-01');
  first_price:=(response->>'id')::uuid;
  response:=public.petro_catalog_command('item.price.publish',
    jsonb_build_object('priceVersionId',first_price),
    'نشر سعر فرعي محلي','catalog-branch-price-one-pub-01');
  IF response->>'status'<>'published' THEN RAISE EXCEPTION 'branch price did not publish'; END IF;
  response:=public.petro_catalog_command('item.price.create_draft',
    jsonb_build_object('itemId',fixture.item_id,'branchId',fixture.station_branch_id,
      'priceMinor','16000','validFromLocal',local_later),
    'سعر فرعي تالٍ','catalog-branch-price-two-key-01');
  second_price:=(response->>'id')::uuid;
  PERFORM public.petro_catalog_command('item.price.publish',
    jsonb_build_object('priceVersionId',second_price),'نشر سعر تالٍ بلا تداخل','catalog-branch-price-two-pub-01');
  response:=public.petro_catalog_item_detail(fixture.item_id);
  SELECT count(*) INTO before_count
  FROM jsonb_array_elements(response->'prices') AS versions(value)
  WHERE versions.value->>'status'='published' AND versions.value->>'validTo' IS NULL;
  IF before_count<>1 THEN RAISE EXCEPTION 'catalog price schedule is ambiguous'; END IF;

  BEGIN
    response:=public.petro_catalog_command('item.price.create_draft',
      jsonb_build_object('itemId',fixture.item_id,'branchId',fixture.station_branch_id,
        'priceMinor','17000','validFromLocal',to_char((now()+interval '90 minutes') AT TIME ZONE 'Africa/Cairo','YYYY-MM-DD HH24:MI:SS.US')),
      'سعر متداخل للاختبار','catalog-overlap-price-draft-key-01');
    BEGIN
      PERFORM public.petro_catalog_command('item.price.publish',
        jsonb_build_object('priceVersionId',(response->>'id')::uuid),
        'محاولة نشر متداخل','catalog-overlap-price-publish-key-01');
      RAISE EXCEPTION 'overlapping catalog price was published';
    EXCEPTION WHEN exclusion_violation THEN NULL;
    END;
  END;
END
$merchant_prices$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000905';
DO $branch_manager$
DECLARE fixture record; response jsonb;
BEGIN
  SELECT * INTO fixture FROM pg_temp.catalog_test_ids;
  response:=public.petro_catalog_list_items(fixture.station_id,fixture.station_branch_id,NULL,NULL,NULL,NULL,1,20);
  IF (response->>'total')::integer<>1 THEN RAISE EXCEPTION 'branch-scoped manager did not see own branch item'; END IF;
  BEGIN
    PERFORM public.petro_catalog_list_items(fixture.provider_id,fixture.provider_branch_id,NULL,NULL,NULL,NULL,1,20);
    RAISE EXCEPTION 'branch manager read another merchant catalog';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.petro_catalog_item_detail(fixture.item_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE;
  END;
END
$branch_manager$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000906';
DO $provider_guard$
DECLARE fixture record;
BEGIN
  SELECT * INTO fixture FROM pg_temp.catalog_test_ids;
  BEGIN
    PERFORM public.petro_catalog_command('item.create',
      jsonb_build_object('organizationId',fixture.provider_id,'categoryId',fixture.fuel_type_id,'kind','product',
        'name','وقود لمقدم الخدمة','unitCode','litre','attributes','{}'::jsonb),
      'منع وقود مقدم الخدمة','catalog-provider-fuel-denial-01');
    RAISE EXCEPTION 'service provider created fuel item';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
  BEGIN
    PERFORM public.petro_catalog_item_detail(fixture.item_id);
    RAISE EXCEPTION 'provider read another organization item';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$provider_guard$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000901';
DO $fuel_and_image$
DECLARE fixture record; response jsonb; price_id uuid; image_id uuid; image_info jsonb;
  start_local text; fuel_id uuid; amount_minor text; quantity_text text;
BEGIN
  SELECT * INTO fixture FROM pg_temp.catalog_test_ids;
  response:=public.petro_catalog_admin_fuel_list(NULL,1,20);
  SELECT (fuel.value->>'id')::uuid INTO fuel_id
  FROM jsonb_array_elements(response->'items') AS fuel(value)
  WHERE fuel.value->>'code'='gasoline_92';
  IF (SELECT fuel.value->>'currentPrice'
      FROM jsonb_array_elements(response->'items') AS fuel(value)
      WHERE fuel.value->>'code'='gasoline_92') IS NOT NULL THEN
    RAISE EXCEPTION 'fresh test database unexpectedly seeded a reference price';
  END IF;
  start_local:=to_char(now() AT TIME ZONE 'Africa/Cairo','YYYY-MM-DD HH24:MI:SS.US');
  response:=public.petro_catalog_command('fuel.price.create_draft',
    jsonb_build_object('fuelTypeId',fuel_id,'pricePerUnit','15.123456','validFromLocal',start_local),
    'سعر تجريبي معزول وليس سعر سوق','catalog-fuel-price-create-key-01');
  price_id:=(response->>'id')::uuid;
  response:=public.petro_catalog_command('fuel.price.publish',
    jsonb_build_object('priceVersionId',price_id),'نشر مرجع محلي للاختبار','catalog-fuel-price-publish-key-01');
  IF response->>'status'<>'published' THEN RAISE EXCEPTION 'central fuel price did not publish'; END IF;
  response:=public.petro_catalog_fuel_preview(fuel_id,2.5,NULL);
  amount_minor:=response->>'amountMinor';
  IF response->>'available'<>'true' OR amount_minor<>'3781'
     OR response->>'financialOperation'<>'false' THEN
    RAISE EXCEPTION 'fuel preview failed exact EGP piastre rounding';
  END IF;
  response:=public.petro_catalog_fuel_preview(fuel_id,NULL,1234);
  quantity_text:=response->>'quantity';
  IF response->>'available'<>'true' OR quantity_text IS NULL THEN
    RAISE EXCEPTION 'amount-to-quantity fuel preview failed';
  END IF;
  BEGIN
    PERFORM public.petro_catalog_command('fuel.type.create',
      jsonb_build_object('code','gasoline_piece_test','nameAr','وقود بوحدة خاطئة',
        'vehicleFuelFamily','gasoline','unitCode','piece'),
      'اختبار منع وحدة غير متوافقة','catalog-fuel-unit-invalid-0001');
    RAISE EXCEPTION 'gasoline fuel type with piece unit was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.petro_catalog_command('fuel.type.create',
      jsonb_build_object('code','natural_gas_unmapped_test','nameAr','غاز بلا وحدة معتمدة',
        'vehicleFuelFamily','natural_gas','unitCode','litre'),
      'اختبار منع التخمين بوحدة الغاز','catalog-fuel-unit-unmapped-0001');
    RAISE EXCEPTION 'fuel family without explicit unit mapping was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  IF (public.petro_catalog_item_detail(fixture.item_id)->'images') IS NULL THEN
    RAISE EXCEPTION 'item image metadata response is malformed';
  END IF;
END
$fuel_and_image$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000904';
DO $merchant_image$
DECLARE fixture record; response jsonb; image_id uuid; image_info jsonb;
BEGIN
  SELECT * INTO fixture FROM pg_temp.catalog_test_ids;
  response:=public.petro_catalog_command('item.image.intent',
    jsonb_build_object('itemId',fixture.item_id,'fileName','local-image.png','contentType','image/png','byteSize',12),
    'رفع صورة محلية معزولة','catalog-image-intent-key-0001');
  image_id:=(response->>'id')::uuid;
  image_info:=public.petro_catalog_image_upload_info(image_id);
  IF image_info->>'path' IS NULL OR image_info->>'path' LIKE '%/documents/%' THEN
    RAISE EXCEPTION 'private catalog image intent did not return a scoped path to uploader';
  END IF;
END
$merchant_image$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000903';
DO $finance_read_only$
BEGIN
  PERFORM public.petro_catalog_admin_categories();
  PERFORM public.petro_catalog_admin_fuel_list(NULL,1,20);
  BEGIN
    PERFORM public.petro_catalog_command('fuel.type.create',
      jsonb_build_object('code','test_prohibited','nameAr','نوع ممنوع','vehicleFuelFamily','other','unitCode','litre'),
      'محاولة إنشاء غير مخولة','catalog-finance-write-denied-001');
    RAISE EXCEPTION 'finance role modified central fuel catalog';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$finance_read_only$;
RESET ROLE;

ROLLBACK;
