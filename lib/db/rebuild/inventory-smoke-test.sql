-- Disposable local-only inventory acceptance test. All synthetic rows roll back.
BEGIN;

INSERT INTO auth.users (id,email,raw_user_meta_data,email_confirmed_at) VALUES
  ('00000000-0000-4000-8000-000000000921','inventory-owner@example.invalid','{"username":"inventory_owner","display_name":"مالك مخزون محلي"}',now()),
  ('00000000-0000-4000-8000-000000000922','inventory-manager@example.invalid','{"username":"inventory_manager","display_name":"مدير مخزون محلي"}',now()),
  ('00000000-0000-4000-8000-000000000923','inventory-worker@example.invalid','{"username":"inventory_worker","display_name":"عامل مخزون محلي"}',now()),
  ('00000000-0000-4000-8000-000000000924','inventory-company@example.invalid','{"username":"inventory_company","display_name":"شركة مستهلكة محلية"}',now());
UPDATE public.petro_profiles SET active=true,account_status='active'
WHERE user_id BETWEEN '00000000-0000-4000-8000-000000000921'::uuid
                  AND '00000000-0000-4000-8000-000000000924'::uuid;
INSERT INTO public.petro_platform_roles(user_id,role,active)
VALUES ('00000000-0000-4000-8000-000000000921','owner',true);

CREATE TEMP TABLE inventory_test_ids(
  merchant_id uuid, branch_one uuid, branch_two uuid, other_merchant uuid, other_branch uuid,
  company_id uuid, company_branch uuid, item_id uuid, sellable_one uuid, sellable_two uuid,
  quarantine_id uuid, damaged_id uuid, worker_doc_id uuid
) ON COMMIT DROP;
GRANT SELECT,INSERT,UPDATE ON pg_temp.inventory_test_ids TO authenticated;

DO $seed$
DECLARE
  merchant uuid; branch_one uuid; branch_two uuid; other_merchant uuid; other_branch uuid;
  company uuid; company_branch uuid; category uuid; item uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000921',true);
  merchant:=public.petro_create_organization_details(
    'مخزون محطة اختبار','station','INV-STATION-LOCAL',NULL,'مسؤول محلي',
    '+201000000921','inventory.station@example.invalid','عنوان اختبار محلي'
  );
  PERFORM public.petro_approve_organization(merchant,1,'اعتماد بيانات اختبار محلية');
  PERFORM public.petro_set_organization_operational_status(merchant,2,'active','تفعيل بيانات اختبار محلية');
  branch_one:=public.petro_create_branch_details(
    merchant,'INV-ST-1','فرع المخزون الأول','عنوان اختبار','القاهرة',NULL,NULL,'{}','مسؤول الفرع','+201000000931'
  );
  branch_two:=public.petro_create_branch_details(
    merchant,'INV-ST-2','فرع المخزون الثاني','عنوان اختبار','القاهرة',NULL,NULL,'{}','مسؤول الفرع','+201000000932'
  );
  PERFORM public.petro_approve_branch(merchant,branch_one,1,'اعتماد بيانات اختبار محلية');
  PERFORM public.petro_set_branch_operational_status(merchant,branch_one,2,'active','تفعيل بيانات اختبار محلية');
  PERFORM public.petro_approve_branch(merchant,branch_two,1,'اعتماد بيانات اختبار محلية');
  PERFORM public.petro_set_branch_operational_status(merchant,branch_two,2,'active','تفعيل بيانات اختبار محلية');

  other_merchant:=public.petro_create_organization_details(
    'مقدم مخزون اختبار','provider','INV-PROVIDER-LOCAL',NULL,'مسؤول محلي',
    '+201000000922','inventory.provider@example.invalid','عنوان اختبار محلي'
  );
  PERFORM public.petro_approve_organization(other_merchant,1,'اعتماد بيانات اختبار محلية');
  PERFORM public.petro_set_organization_operational_status(other_merchant,2,'active','تفعيل بيانات اختبار محلية');
  other_branch:=public.petro_create_branch_details(
    other_merchant,'INV-PR-1','فرع مقدم اختبار','عنوان اختبار','الجيزة',NULL,NULL,'{}','مسؤول الفرع','+201000000933'
  );
  PERFORM public.petro_approve_branch(other_merchant,other_branch,1,'اعتماد بيانات اختبار محلية');
  PERFORM public.petro_set_branch_operational_status(other_merchant,other_branch,2,'active','تفعيل بيانات اختبار محلية');

  company:=public.petro_create_organization_details(
    'شركة مستهلكة اختبار','company','INV-COMPANY-LOCAL',NULL,'مسؤول محلي',
    '+201000000923','inventory.company@example.invalid','عنوان اختبار محلي'
  );
  PERFORM public.petro_approve_organization(company,1,'اعتماد بيانات اختبار محلية');
  PERFORM public.petro_set_organization_operational_status(company,2,'active','تفعيل بيانات اختبار محلية');
  company_branch:=public.petro_create_branch_details(
    company,'INV-CO-1','فرع الشركة المستهلكة','عنوان اختبار','القاهرة',NULL,NULL,'{}','مسؤول الفرع','+201000000934'
  );
  PERFORM public.petro_approve_branch(company,company_branch,1,'اعتماد بيانات اختبار محلية');
  PERFORM public.petro_set_branch_operational_status(company,company_branch,2,'active','تفعيل بيانات اختبار محلية');

  INSERT INTO public.petro_memberships(user_id,organization_id,role,scope,active)
  VALUES
    ('00000000-0000-4000-8000-000000000921',merchant,'organization_owner','organization',true),
    ('00000000-0000-4000-8000-000000000922',merchant,'manager','branches',true),
    ('00000000-0000-4000-8000-000000000923',merchant,'worker','branches',true),
    ('00000000-0000-4000-8000-000000000924',company,'organization_owner','organization',true);
  INSERT INTO public.petro_membership_branches(organization_id,membership_id,branch_id)
    SELECT merchant,id,branch_one FROM public.petro_memberships
    WHERE organization_id=merchant AND user_id IN (
      '00000000-0000-4000-8000-000000000922',
      '00000000-0000-4000-8000-000000000923'
    );

  SELECT id INTO category FROM public.petro_catalog_categories WHERE code='oils' AND active;
  IF category IS NULL THEN RAISE EXCEPTION 'active local catalog category oils was not found'; END IF;
  INSERT INTO public.petro_catalog_items(
    organization_id,category_id,item_kind,name,description,internal_code,unit_code,
    attributes,display_status,review_status,created_by,updated_by
  ) VALUES (
    merchant,category,'product','زيت اختبار محلي','fixture only','INV-OIL-LOCAL','litre',
    '{}'::jsonb,'active','approved',
    '00000000-0000-4000-8000-000000000921','00000000-0000-4000-8000-000000000921'
  ) RETURNING id INTO item;
  INSERT INTO pg_temp.inventory_test_ids(
    merchant_id,branch_one,branch_two,other_merchant,other_branch,company_id,company_branch,item_id
  ) VALUES (merchant,branch_one,branch_two,other_merchant,other_branch,company,company_branch,item);
END
$seed$;

DO $acl$
BEGIN
  IF has_table_privilege('anon','public.petro_inventory_balances','SELECT')
     OR has_table_privilege('authenticated','public.petro_inventory_balances','SELECT')
     OR has_table_privilege('service_role','public.petro_inventory_balances','SELECT')
     OR has_table_privilege('authenticated','public.petro_inventory_movements','UPDATE')
     OR has_function_privilege('anon','public.petro_inventory_admin_query(text,jsonb)','EXECUTE')
     OR has_function_privilege('service_role','public.petro_inventory_admin_query(text,jsonb)','EXECUTE')
     OR has_function_privilege('authenticated','petro_private.inventory_apply_delta(uuid,uuid,uuid,numeric,numeric,uuid,uuid,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'inventory table/helper/RPC grants are broader than intended';
  END IF;
END
$acl$;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000921';
DO $inventory_owner$
DECLARE
  ids record; response jsonb; replay jsonb; doc_id uuid; reservation_id uuid;
  source_location uuid; target_location uuid; quarantine_location uuid; damaged_location uuid;
  before_total numeric; after_total numeric; balance jsonb; item uuid; query_result jsonb;
BEGIN
  SELECT * INTO STRICT ids FROM pg_temp.inventory_test_ids;
  item:=ids.item_id;

  response:=public.petro_inventory_admin_command('location.create',
    jsonb_build_object('organizationId',ids.merchant_id,'branchId',ids.branch_one,'name','مخزن صالح','kind','sellable','reason','إنشاء موقع اختبار محلي'),
    'inventory-location-sellable-0001');
  source_location:=(response->>'id')::uuid;
  UPDATE pg_temp.inventory_test_ids SET sellable_one=source_location;
  response:=public.petro_inventory_admin_command('location.create',
    jsonb_build_object('organizationId',ids.merchant_id,'branchId',ids.branch_two,'name','مخزن فرع ثان','kind','sellable','reason','إنشاء موقع اختبار محلي'),
    'inventory-location-sellable-0002');
  target_location:=(response->>'id')::uuid;
  UPDATE pg_temp.inventory_test_ids SET sellable_two=target_location;
  response:=public.petro_inventory_admin_command('location.create',
    jsonb_build_object('organizationId',ids.merchant_id,'branchId',ids.branch_one,'name','منطقة مرتجع','kind','quarantine','reason','إنشاء موقع اختبار محلي'),
    'inventory-location-quarantine-01');
  quarantine_location:=(response->>'id')::uuid;
  response:=public.petro_inventory_admin_command('location.create',
    jsonb_build_object('organizationId',ids.merchant_id,'branchId',ids.branch_one,'name','منطقة تالف','kind','damaged','reason','إنشاء موقع اختبار محلي'),
    'inventory-location-damaged-0001');
  damaged_location:=(response->>'id')::uuid;
  UPDATE pg_temp.inventory_test_ids SET quarantine_id=quarantine_location,damaged_id=damaged_location;

  doc_id:=(public.petro_inventory_admin_command('document.create',
    jsonb_build_object('organizationId',ids.merchant_id,'sourceLocationId',source_location,'type','receipt',
      'reason','استلام اختبار محلي','lines',jsonb_build_array(jsonb_build_object('itemId',item,'quantity','10.500000'))),
    'inventory-receipt-create-0001')->>'id')::uuid;
  PERFORM public.petro_inventory_admin_command('document.review',
    jsonb_build_object('documentId',doc_id,'decision','approve','reason','اعتماد استلام اختبار محلي'),
    'inventory-receipt-approve-01');
  balance:=public.petro_inventory_admin_query('balances',jsonb_build_object('locationId',source_location))->'items'->0;
  IF (balance->>'onHand')::numeric<>10.5 OR (balance->>'available')::numeric<>10.5 THEN
    RAISE EXCEPTION 'receipt balance did not match ledger';
  END IF;
  before_total:=(balance->>'onHand')::numeric;

  response:=public.petro_inventory_admin_command('reservation.reserve',
    jsonb_build_object('organizationId',ids.merchant_id,'locationId',source_location,'itemId',item,
      'quantity','4.000000','sourceReference','00000000-0000-4000-8000-000000000941','reason','حجز محلي لاختبار المخزون'),
    'inventory-reserve-0001');
  reservation_id:=(response->>'id')::uuid;
  replay:=public.petro_inventory_admin_command('reservation.reserve',
    jsonb_build_object('organizationId',ids.merchant_id,'locationId',source_location,'itemId',item,
      'quantity','4.000000','sourceReference','00000000-0000-4000-8000-000000000941','reason','حجز محلي لاختبار المخزون'),
    'inventory-reserve-0001');
  IF replay->>'id'<>reservation_id::text THEN RAISE EXCEPTION 'same idempotency key did not replay original reservation'; END IF;
  BEGIN
    PERFORM public.petro_inventory_admin_command('reservation.reserve',
      jsonb_build_object('organizationId',ids.merchant_id,'locationId',source_location,'itemId',item,
        'quantity','3.000000','sourceReference','00000000-0000-4000-8000-000000000942','reason','حمولة مختلفة بنفس المرجع'),
      'inventory-reserve-0001');
    RAISE EXCEPTION 'changed payload reused an inventory idempotency key';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  balance:=public.petro_inventory_admin_query('balances',jsonb_build_object('locationId',source_location))->'items'->0;
  IF (balance->>'onHand')::numeric<>10.5 OR (balance->>'reserved')::numeric<>4
    OR (balance->>'available')::numeric<>6.5 THEN RAISE EXCEPTION 'reservation did not split on-hand/reserved/available'; END IF;
  BEGIN
    PERFORM public.petro_inventory_admin_command('reservation.reserve',
      jsonb_build_object('organizationId',ids.merchant_id,'locationId',source_location,'itemId',item,
        'quantity','7.000000','sourceReference','00000000-0000-4000-8000-000000000943','reason','حجز زائد يجب رفضه'),
      'inventory-reserve-overflow-01');
    RAISE EXCEPTION 'inventory allowed reservation above available stock';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  PERFORM public.petro_inventory_admin_command('reservation.release',
    jsonb_build_object('reservationId',reservation_id,'reason','تحرير حجز اختبار محلي'),
    'inventory-reserve-release-01');
  response:=public.petro_inventory_admin_command('reservation.reserve',
    jsonb_build_object('organizationId',ids.merchant_id,'locationId',source_location,'itemId',item,
      'quantity','2.000000','sourceReference','00000000-0000-4000-8000-000000000944','reason','حجز ثان للاختبار'),
    'inventory-reserve-0002');
  reservation_id:=(response->>'id')::uuid;
  PERFORM public.petro_inventory_admin_command('reservation.consume',
    jsonb_build_object('reservationId',reservation_id,'reason','استهلاك حجز اختبار محلي'),
    'inventory-reserve-consume-01');
  BEGIN
    PERFORM public.petro_inventory_admin_command('reservation.consume',
      jsonb_build_object('reservationId',reservation_id,'reason','تكرار استهلاك محلي'),
      'inventory-reserve-consume-02');
    RAISE EXCEPTION 'inventory allowed a reservation to be consumed twice';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;

  doc_id:=(public.petro_inventory_admin_command('document.create',
    jsonb_build_object('organizationId',ids.merchant_id,'sourceLocationId',source_location,
      'targetLocationId',target_location,'type','transfer','reason','نقل مخزون بين فرعين محليًا',
      'lines',jsonb_build_array(jsonb_build_object('itemId',item,'quantity','3.000000'))),
    'inventory-transfer-create-01')->>'id')::uuid;
  PERFORM public.petro_inventory_admin_command('document.review',
    jsonb_build_object('documentId',doc_id,'decision','approve','reason','اعتماد نقل اختبار محلي'),
    'inventory-transfer-approve-01');
  balance:=public.petro_inventory_admin_query('balances',jsonb_build_object('locationId',source_location))->'items'->0;
  IF (balance->>'onHand')::numeric<>5.5 THEN RAISE EXCEPTION 'transfer source was not reduced exactly once'; END IF;
  balance:=public.petro_inventory_admin_query('balances',jsonb_build_object('locationId',target_location))->'items'->0;
  IF (balance->>'onHand')::numeric<>3 THEN RAISE EXCEPTION 'transfer target was not increased exactly once'; END IF;

  doc_id:=(public.petro_inventory_admin_command('document.create',
    jsonb_build_object('organizationId',ids.merchant_id,'sourceLocationId',source_location,'type','issue',
      'reason','صرف زائد لاختبار الرفض','lines',jsonb_build_array(jsonb_build_object('itemId',item,'quantity','6.000000'))),
    'inventory-issue-create-0001')->>'id')::uuid;
  BEGIN
    PERFORM public.petro_inventory_admin_command('document.review',
      jsonb_build_object('documentId',doc_id,'decision','approve','reason','يجب أن يرفض الرصيد غير الكافي'),
      'inventory-issue-approve-01');
    RAISE EXCEPTION 'inventory approved an issue larger than on-hand stock';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF public.petro_inventory_admin_query('document',jsonb_build_object('documentId',doc_id))
      #>> '{document,status}'<>'pending' THEN
    RAISE EXCEPTION 'failed approval left a partial status change';
  END IF;

  doc_id:=(public.petro_inventory_admin_command('document.create',
    jsonb_build_object('organizationId',ids.merchant_id,'sourceLocationId',source_location,
      'targetLocationId',quarantine_location,'type','return','reason','مرتجع اختبار معزول',
      'lines',jsonb_build_array(jsonb_build_object('itemId',item,'quantity','1.000000'))),
    'inventory-return-create-0001')->>'id')::uuid;
  PERFORM public.petro_inventory_admin_command('document.review',
    jsonb_build_object('documentId',doc_id,'decision','approve','reason','اعتماد مرتجع معزول'),
    'inventory-return-approve-01');
  doc_id:=(public.petro_inventory_admin_command('document.create',
    jsonb_build_object('organizationId',ids.merchant_id,'sourceLocationId',source_location,
      'targetLocationId',damaged_location,'type','damage','reason','تالف اختبار معزول',
      'lines',jsonb_build_array(jsonb_build_object('itemId',item,'quantity','1.000000'))),
    'inventory-damage-create-0001')->>'id')::uuid;
  PERFORM public.petro_inventory_admin_command('document.review',
    jsonb_build_object('documentId',doc_id,'decision','approve','reason','اعتماد تالف معزول'),
    'inventory-damage-approve-01');

  balance:=public.petro_inventory_admin_query('balances',jsonb_build_object('locationId',source_location))->'items'->0;
  after_total:=(balance->>'onHand')::numeric;
  IF after_total<>before_total-2-3-1 THEN RAISE EXCEPTION 'movement totals did not reconcile'; END IF;
  query_result:=public.petro_inventory_admin_query('reconciliation',jsonb_build_object('organizationId',ids.merchant_id));
  IF query_result->>'consistent'<>'true' THEN RAISE EXCEPTION 'inventory ledger and derived balances disagree'; END IF;
  BEGIN
    UPDATE public.petro_inventory_movements SET reason='محاولة تعديل ممنوعة'
    WHERE id=(SELECT min(id) FROM public.petro_inventory_movements WHERE organization_id=ids.merchant_id);
    RAISE EXCEPTION 'inventory ledger allowed in-place mutation';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$inventory_owner$;

DO $draft_time_boundary$
DECLARE plan_id uuid; version_id uuid; result_id uuid;
BEGIN
  plan_id:=public.petro_billing_admin_create_plan_v2(
    'inventory-draft-time-local','company','خطة اختبار الوقت','مسودة محلية',
    60000,'vehicle','annual','EGP',now()+interval '1 day',
    '[{"key":"vehicle_registry","label":"تغطية المركبات","value":false,"approved":false}]'::jsonb,
    '[]'::jsonb,'إنشاء مسودة اختبار محلية'
  );
  version_id:=public.petro_billing_admin_add_plan_version_v2(
    plan_id,'نسخة قابلة للتحرير','مسودة محلية',65000,'vehicle','annual','EGP',
    now()-interval '2 minutes',
    '[{"key":"vehicle_registry","label":"تغطية المركبات","value":false,"approved":false}]'::jsonb,
    '[]'::jsonb,'إنشاء مسودة بتاريخ سابق للاختبار'
  );
  result_id:=public.petro_billing_admin_update_draft_version(
    plan_id,version_id,'نسخة قابلة للتحرير','مسودة معدلة',70000,'vehicle','annual','EGP',
    now()-interval '3 minutes',
    '[{"key":"vehicle_registry","label":"تغطية المركبات","value":false,"approved":false}]'::jsonb,
    '[]'::jsonb,'تعديل مسودة اختبار محلية'
  );
  IF result_id<>version_id OR NOT EXISTS (
    SELECT 1 FROM public.petro_plan_versions
    WHERE id=version_id AND publication_status='draft' AND effective_at<now()
  ) THEN
    RAISE EXCEPTION 'draft timestamp boundary prevents a delayed edit';
  END IF;
END
$draft_time_boundary$;

SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000922';
DO $branch_manager$
DECLARE ids record; response jsonb; worker_doc uuid; scoped jsonb;
BEGIN
  SELECT * INTO STRICT ids FROM pg_temp.inventory_test_ids;
  scoped:=public.petro_inventory_admin_query('locations',jsonb_build_object('organizationId',ids.merchant_id));
  IF jsonb_array_length(scoped->'items')<>3 THEN
    RAISE EXCEPTION 'branch manager could not see only their scoped locations';
  END IF;
  BEGIN
    PERFORM public.petro_inventory_admin_command('location.create',
      jsonb_build_object('organizationId',ids.merchant_id,'branchId',ids.branch_two,'name','مخزن خارج النطاق','kind','sellable','reason','محاولة محلية خارج نطاق الفرع'),
      'inventory-location-out-of-scope-01');
    RAISE EXCEPTION 'branch manager created a location outside their branch scope';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000923',true);
  worker_doc:=(public.petro_inventory_admin_command('document.create',
    jsonb_build_object('organizationId',ids.merchant_id,'sourceLocationId',ids.sellable_one,'type','receipt',
      'reason','طلب استلام أنشأه عامل محلي','lines',jsonb_build_array(jsonb_build_object('itemId',ids.item_id,'quantity','1.000000'))),
    'inventory-worker-document-01')->>'id')::uuid;
  BEGIN
    PERFORM public.petro_inventory_admin_command('document.review',
      jsonb_build_object('documentId',worker_doc,'decision','approve','reason','محاولة اعتماد عامل محلي'),
      'inventory-worker-review-denied-01');
    RAISE EXCEPTION 'worker reviewed their own inventory document';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$branch_manager$;

SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000924';
DO $consumer_isolation$
DECLARE ids record;
BEGIN
  SELECT * INTO STRICT ids FROM pg_temp.inventory_test_ids;
  BEGIN
    PERFORM public.petro_inventory_admin_query('locations',jsonb_build_object('organizationId',ids.merchant_id));
    RAISE EXCEPTION 'consumer company read merchant stock';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$consumer_isolation$;

ROLLBACK;
