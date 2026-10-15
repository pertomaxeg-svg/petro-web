-- Disposable local-only acceptance tests for 0010. All fixtures are synthetic and roll back.
BEGIN;

INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at)
VALUES
  ('00000000-0000-4000-8000-000000000901', 'billing-owner@example.invalid',
   '{"username":"billing_owner_test","display_name":"Billing Owner Test"}', now()),
  ('00000000-0000-4000-8000-000000000902', 'billing-operations@example.invalid',
   '{"username":"billing_operations_test","display_name":"Billing Operations Test"}', now());

UPDATE public.petro_profiles
SET active = true, account_status = 'active'
WHERE user_id IN ('00000000-0000-4000-8000-000000000901', '00000000-0000-4000-8000-000000000902');

INSERT INTO public.petro_platform_roles (user_id, role, active)
VALUES
  ('00000000-0000-4000-8000-000000000901', 'owner', true),
  ('00000000-0000-4000-8000-000000000902', 'operations', true);

CREATE TEMP TABLE billing_test_ids (
  owner_id uuid NOT NULL,
  operations_id uuid NOT NULL,
  provider_org uuid NOT NULL,
  provider_branch uuid NOT NULL,
  station_org uuid NOT NULL,
  station_branch uuid NOT NULL,
  station_branch_expired uuid NOT NULL,
  company_org uuid NOT NULL,
  provider_plan uuid NOT NULL,
  provider_version uuid NOT NULL,
  station_plan uuid NOT NULL,
  station_version uuid NOT NULL,
  company_plan uuid NOT NULL,
  company_version uuid NOT NULL,
  provider_request uuid NOT NULL,
  provider_subscription uuid NOT NULL,
  overlap_request uuid NOT NULL,
  station_request uuid NOT NULL,
  station_subscription uuid NOT NULL,
  expired_request uuid NOT NULL,
  company_request uuid NOT NULL
) ON COMMIT DROP;
GRANT SELECT, INSERT ON pg_temp.billing_test_ids TO authenticated, service_role;

DO $privileges$
BEGIN
  IF NOT has_function_privilege('authenticated', 'public.petro_billing_admin_catalog()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.petro_billing_admin_create_plan(text,text,text,bigint,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.petro_billing_admin_create_request(uuid,uuid,text,uuid,uuid,uuid,bigint,timestamptz,timestamptz,text,text,boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.petro_billing_admin_catalog()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.petro_billing_admin_create_plan(text,text,text,bigint,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'petro_private.subscription_allows_new_service(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'petro_private.subscription_allows_new_service(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'billing RPC privileges are not restricted as expected';
  END IF;
END
$privileges$;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '00000000-0000-4000-8000-000000000901';

DO $billing_acceptance$
DECLARE
  provider_org_id uuid;
  provider_branch_id uuid;
  station_org_id uuid;
  station_branch_id uuid;
  station_expired_branch_id uuid;
  company_org_id uuid;
  provider_plan_id uuid;
  provider_version_id uuid;
  station_plan_id uuid;
  station_version_id uuid;
  station_change_plan_id uuid;
  station_change_version_id uuid;
  company_plan_id uuid;
  company_version_id uuid;
  provider_request_id uuid;
  provider_subscription_id uuid;
  overlap_request_id uuid;
  station_request_id uuid;
  station_subscription_id uuid;
  station_change_request_id uuid;
  station_change_subscription_id uuid;
  station_renewal_request_id uuid;
  station_renewal_subscription_id uuid;
  expired_request_id uuid;
  company_request_id uuid;
  version_one uuid;
  action_status text;
  catalog jsonb;
  coverage text;
BEGIN
  provider_org_id := public.petro_create_organization_details(
    'مزود اختبار الباقات', 'provider', 'BILLING-PROVIDER', NULL, 'مسؤول الاختبار',
    '+201000000901', 'provider@example.invalid', 'عنوان اختبار'
  );
  station_org_id := public.petro_create_organization_details(
    'محطة اختبار مجانية', 'station', 'BILLING-STATION', NULL, 'مسؤول الاختبار',
    '+201000000902', 'station@example.invalid', 'عنوان اختبار'
  );
  company_org_id := public.petro_create_organization_details(
    'شركة اختبار الأسطول', 'company', 'BILLING-COMPANY', NULL, 'مسؤول الاختبار',
    '+201000000903', 'company@example.invalid', 'عنوان اختبار'
  );

  PERFORM public.petro_approve_organization(provider_org_id, 1, 'اعتماد جهة اختبار الباقات');
  PERFORM public.petro_set_organization_operational_status(provider_org_id, 2, 'active', 'تفعيل جهة الاختبار');
  PERFORM public.petro_approve_organization(station_org_id, 1, 'اعتماد جهة اختبار الباقات');
  PERFORM public.petro_set_organization_operational_status(station_org_id, 2, 'active', 'تفعيل جهة الاختبار');
  PERFORM public.petro_approve_organization(company_org_id, 1, 'اعتماد جهة اختبار الباقات');
  PERFORM public.petro_set_organization_operational_status(company_org_id, 2, 'active', 'تفعيل جهة الاختبار');

  provider_branch_id := public.petro_create_branch_details(
    provider_org_id, 'BILL-PROVIDER-1', 'فرع مزود الاختبار', 'عنوان اختبار', 'القاهرة',
    NULL, NULL, '{}'::jsonb, 'مسؤول الفرع', '+201000000911'
  );
  station_branch_id := public.petro_create_branch_details(
    station_org_id, 'BILL-STATION-1', 'فرع المحطة الأول', 'عنوان اختبار', 'القاهرة',
    NULL, NULL, '{}'::jsonb, 'مسؤول الفرع', '+201000000912'
  );
  station_expired_branch_id := public.petro_create_branch_details(
    station_org_id, 'BILL-STATION-2', 'فرع المحطة الثاني', 'عنوان اختبار', 'الإسكندرية',
    NULL, NULL, '{}'::jsonb, 'مسؤول الفرع', '+201000000913'
  );
  PERFORM public.petro_approve_branch(provider_org_id, provider_branch_id, 1, 'اعتماد فرع الاختبار');
  PERFORM public.petro_set_branch_operational_status(provider_org_id, provider_branch_id, 2, 'active', 'تفعيل فرع الاختبار');
  PERFORM public.petro_approve_branch(station_org_id, station_branch_id, 1, 'اعتماد فرع الاختبار');
  PERFORM public.petro_set_branch_operational_status(station_org_id, station_branch_id, 2, 'active', 'تفعيل فرع الاختبار');
  PERFORM public.petro_approve_branch(station_org_id, station_expired_branch_id, 1, 'اعتماد فرع الاختبار');
  PERFORM public.petro_set_branch_operational_status(station_org_id, station_expired_branch_id, 2, 'active', 'تفعيل فرع الاختبار');

  provider_plan_id := public.petro_billing_admin_create_plan(
    'billing-provider-smoke', 'provider', 'باقة مزود اختبار', 500000, 'إنشاء خطة اختبار'
  );
  catalog := public.petro_billing_admin_catalog();
  SELECT (version_item ->> 'id')::uuid INTO version_one
  FROM jsonb_array_elements(catalog -> 'plans') plan_item
  CROSS JOIN LATERAL jsonb_array_elements(plan_item -> 'versions') version_item
  WHERE plan_item ->> 'id' = provider_plan_id::text AND (version_item ->> 'version')::integer = 1;
  BEGIN
    PERFORM public.petro_billing_admin_publish_plan_version(provider_plan_id, version_one, 'محاولة نشر بلا حقوق');
    RAISE EXCEPTION 'empty plan rights were published';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;
  provider_version_id := public.petro_billing_admin_add_plan_version(
    provider_plan_id, 500000, now() + interval '1 day',
    '[{"key":"wash_services","label":"خدمات الغسيل","value":true,"approved":true}]'::jsonb,
    '[]'::jsonb, 'إعداد حقوق خطة الاختبار'
  );
  action_status := public.petro_billing_admin_publish_plan_version(
    provider_plan_id, provider_version_id, 'اعتماد حقوق خطة الاختبار'
  );
  IF action_status <> 'scheduled' THEN
    RAISE EXCEPTION 'future plan version was not scheduled';
  END IF;

  station_plan_id := public.petro_billing_admin_create_plan(
    'billing-station-smoke', 'station', 'خطة محطة مجانية للاختبار', 0, 'إنشاء خطة اختبار'
  );
  station_version_id := public.petro_billing_admin_add_plan_version(
    station_plan_id, 0, now(),
    '[{"key":"wash_services","label":"خدمات المحطة","value":true,"approved":false}]'::jsonb,
    '[]'::jsonb, 'إعداد حقوق محطة الاختبار'
  );
  BEGIN
    PERFORM public.petro_billing_admin_publish_plan_version(station_plan_id, station_version_id, 'محاولة نشر حق غير معتمد');
    RAISE EXCEPTION 'unapproved station rights were published';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;
  station_version_id := public.petro_billing_admin_add_plan_version(
    station_plan_id, 0, now(),
    '[{"key":"wash_services","label":"خدمات المحطة","value":true,"approved":true}]'::jsonb,
    '[]'::jsonb, 'اعتماد حق محطة الاختبار'
  );
  action_status := public.petro_billing_admin_publish_plan_version(
    station_plan_id, station_version_id, 'اعتماد حقوق محطة الاختبار'
  );
  IF action_status <> 'published' THEN
    RAISE EXCEPTION 'approved free station plan did not publish';
  END IF;

  company_plan_id := public.petro_billing_admin_create_plan(
    'billing-company-smoke', 'company', 'خطة شركة اختبار', 50000, 'إنشاء خطة اختبار'
  );
  company_version_id := public.petro_billing_admin_add_plan_version(
    company_plan_id, 50000, now(),
    '[{"key":"vehicle_registry","label":"تغطية المركبات","value":true,"approved":true}]'::jsonb,
    '[]'::jsonb, 'إعداد حقوق شركة الاختبار'
  );
  PERFORM public.petro_billing_admin_publish_plan_version(company_plan_id, company_version_id, 'اعتماد خطة اختبار');

  provider_request_id := public.petro_billing_admin_create_request(
    provider_org_id, provider_branch_id, 'custom_price', NULL, provider_plan_id, provider_version_id,
    550000, now() + interval '2 days', now() + interval '367 days',
    'فرع واحد موثق', 'طلب سعر مخصص للاختبار', true
  );
  provider_subscription_id := public.petro_billing_admin_review_request(
    provider_request_id, 'approve', 'اعتماد سعر الفرع للاختبار'
  );
  catalog := public.petro_billing_admin_catalog();
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(catalog -> 'subscriptions') subscription_item
    WHERE subscription_item ->> 'id' = provider_subscription_id::text
      AND subscription_item ->> 'status' = 'pending_payment'
      AND subscription_item ->> 'priceSnapshotMinor' = '550000'
      AND subscription_item ->> 'billingUnit' = 'branch'
      AND subscription_item ->> 'units' = '1'
      AND subscription_item #>> '{planSnapshot,priceOverride}' = 'true'
  ) THEN
    RAISE EXCEPTION 'paid custom price was not stored as a pending-payment snapshot';
  END IF;

  overlap_request_id := public.petro_billing_admin_create_request(
    provider_org_id, provider_branch_id, 'new', NULL, provider_plan_id, provider_version_id,
    NULL, now() + interval '2 days', now() + interval '367 days',
    'فرع واحد موثق', 'طلب متعارض للاختبار', true
  );
  BEGIN
    PERFORM public.petro_billing_admin_review_request(overlap_request_id, 'approve', 'محاولة اعتماد متعارض');
    RAISE EXCEPTION 'overlapping pending-payment subscription was approved';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
  BEGIN
    PERFORM public.petro_billing_admin_create_request(
      provider_org_id, provider_branch_id, 'new', NULL, provider_plan_id, provider_version_id,
      NULL, now() + interval '2 days', now() + interval '367 days',
      'فرع واحد موثق', 'طلب مكرر للاختبار', true
    );
    RAISE EXCEPTION 'duplicate open request was created';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  BEGIN
    PERFORM public.petro_billing_admin_create_request(
      station_org_id, station_branch_id, 'custom_price', NULL, station_plan_id, station_version_id,
      10000, now() + interval '2 days', now() + interval '367 days',
      'فرع المحطة', 'محاولة سعر مدفوع للمحطة', false
    );
    RAISE EXCEPTION 'paid custom price was accepted for a station';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  station_request_id := public.petro_billing_admin_create_request(
    station_org_id, station_branch_id, 'new', NULL, station_plan_id, station_version_id,
    NULL, now(), now() + interval '365 days', 'فرع المحطة الأول', 'طلب محطة مجاني للاختبار', true
  );
  station_subscription_id := public.petro_billing_admin_review_request(
    station_request_id, 'approve', 'اعتماد المحطة المجانية للاختبار'
  );
  catalog := public.petro_billing_admin_catalog();
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(catalog -> 'subscriptions') subscription_item
    WHERE subscription_item ->> 'id' = station_subscription_id::text
      AND subscription_item ->> 'status' = 'active'
      AND subscription_item ->> 'priceSnapshotMinor' = '0'
      AND subscription_item ->> 'billingUnit' = 'branch'
      AND subscription_item #>> '{planSnapshot,currency}' = 'EGP'
  ) THEN
    RAISE EXCEPTION 'approved station subscription was not free and active';
  END IF;

  station_change_plan_id := public.petro_billing_admin_create_plan(
    'billing-station-change', 'station', 'خطة محطة بديلة للاختبار', 0, 'إنشاء نسخة تغيير محلية'
  );
  station_change_version_id := public.petro_billing_admin_add_plan_version(
    station_change_plan_id, 0, now(),
    '[{"key":"station_access_test","label":"استحقاق اختبار المحطة","value":true,"approved":true}]'::jsonb,
    '[]'::jsonb, 'إعداد نسخة المحطة البديلة للاختبار'
  );
  PERFORM public.petro_billing_admin_publish_plan_version(
    station_change_plan_id, station_change_version_id, 'اعتماد نسخة اختبار المحطة'
  );
  station_change_request_id := public.petro_billing_admin_create_request(
    station_org_id, station_branch_id, 'plan_change', station_subscription_id,
    station_change_plan_id, station_change_version_id, NULL,
    now() + interval '365 days', now() + interval '730 days',
    'الفرع نفسه، تغيير خطة مجاني', 'طلب تغيير خطة المحطة للاختبار', true
  );
  station_change_subscription_id := public.petro_billing_admin_review_request(
    station_change_request_id, 'approve', 'اعتماد تغيير خطة المحطة للاختبار'
  );
  station_renewal_request_id := public.petro_billing_admin_create_request(
    station_org_id, station_branch_id, 'renewal', station_change_subscription_id,
    station_change_plan_id, station_change_version_id, NULL,
    now() + interval '730 days', now() + interval '1095 days',
    'تجديد الفرع نفسه بعد انتهاء المدة السابقة', 'طلب تجديد مجاني للاختبار', true
  );
  station_renewal_subscription_id := public.petro_billing_admin_review_request(
    station_renewal_request_id, 'approve', 'اعتماد تجديد المحطة للاختبار'
  );
  catalog := public.petro_billing_admin_catalog();
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(catalog -> 'subscriptions') subscription_item
    WHERE subscription_item ->> 'id' = station_change_subscription_id::text
      AND subscription_item ->> 'status' = 'scheduled'
      AND subscription_item #>> '{planSnapshot,priceMinor}' = '0'
  ) OR NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(catalog -> 'subscriptions') subscription_item
    WHERE subscription_item ->> 'id' = station_renewal_subscription_id::text
      AND subscription_item ->> 'status' = 'scheduled'
      AND subscription_item #>> '{planSnapshot,priceMinor}' = '0'
  ) THEN
    RAISE EXCEPTION 'station plan-change or renewal did not preserve the free scheduled terms';
  END IF;

  expired_request_id := public.petro_billing_admin_create_request(
    station_org_id, station_expired_branch_id, 'new', NULL, station_plan_id, station_version_id,
    NULL, now(), now() + interval '365 days', 'فرع المحطة الثاني', 'طلب انتهاء فرع للاختبار', false
  );

  company_request_id := public.petro_billing_admin_create_request(
    company_org_id, NULL, 'new', NULL, company_plan_id, company_version_id,
    NULL, now(), now() + interval '365 days', 'لا يوجد سجل أسطول معتمد', 'مسودة بلا أسطول للاختبار', false
  );
  catalog := public.petro_billing_admin_catalog();
  SELECT request_item ->> 'coverageState' INTO coverage
  FROM jsonb_array_elements(catalog -> 'requests') request_item
  WHERE request_item ->> 'id' = company_request_id::text;
  IF coverage <> 'fleet_registry_missing' THEN
    RAISE EXCEPTION 'company coverage was not marked as missing fleet registry';
  END IF;
  BEGIN
    PERFORM public.petro_billing_admin_create_request(
      company_org_id, NULL, 'new', NULL, company_plan_id, company_version_id,
      NULL, now(), now() + interval '365 days', 'لا يوجد سجل أسطول معتمد', 'محاولة إرسال بلا أسطول', true
    );
    RAISE EXCEPTION 'company request submitted without verified fleet coverage';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;

  BEGIN
    PERFORM public.petro_billing_admin_create_request(
      provider_org_id, station_branch_id, 'new', NULL, provider_plan_id, provider_version_id,
      NULL, now() + interval '2 days', now() + interval '367 days',
      'فرع غير تابع للجهة', 'محاولة نطاق غير مصرح', false
    );
    RAISE EXCEPTION 'cross-organization branch reference was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  catalog := public.petro_billing_admin_catalog();
  IF jsonb_array_length(catalog -> 'plans') < 3
     OR jsonb_array_length(catalog -> 'requests') < 4
     OR jsonb_array_length(catalog -> 'subscriptions') < 2 THEN
    RAISE EXCEPTION 'billing catalog omitted saved test records';
  END IF;

  INSERT INTO pg_temp.billing_test_ids VALUES (
    '00000000-0000-4000-8000-000000000901',
    '00000000-0000-4000-8000-000000000902',
    provider_org_id, provider_branch_id, station_org_id, station_branch_id,
    station_expired_branch_id, company_org_id, provider_plan_id, provider_version_id,
    station_plan_id, station_version_id, company_plan_id, company_version_id,
    provider_request_id, provider_subscription_id, overlap_request_id, station_request_id,
    station_subscription_id, expired_request_id, company_request_id
  );
END
$billing_acceptance$;
RESET ROLE;

DO $immutable_snapshots$
DECLARE
  ids pg_temp.billing_test_ids%ROWTYPE;
  preserved_price bigint;
  preserved_end timestamptz;
BEGIN
  SELECT * INTO ids FROM pg_temp.billing_test_ids;
  IF (SELECT count(*) FROM public.petro_plan_price_overrides
      WHERE organization_id = ids.provider_org AND branch_id = ids.provider_branch
        AND plan_id = ids.provider_plan AND price_minor = 550000) <> 1 THEN
    RAISE EXCEPTION 'custom price override was not scoped and recorded';
  END IF;
  BEGIN
    UPDATE public.petro_plan_versions SET annual_price_minor = 1 WHERE id = ids.provider_version;
    RAISE EXCEPTION 'published plan version price was mutable';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;
  BEGIN
    UPDATE public.petro_subscriptions SET price_snapshot_minor = 1
    WHERE id = ids.provider_subscription;
    RAISE EXCEPTION 'subscription price snapshot was mutable';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;
  SELECT price_snapshot_minor, ends_at INTO preserved_price, preserved_end
  FROM public.petro_subscriptions WHERE id = ids.provider_subscription;
  PERFORM public.petro_billing_admin_cancel_subscription(
    ids.provider_subscription, now() + interval '30 days', 'إلغاء مستقبلي للاختبار'
  );
  IF NOT EXISTS (
    SELECT 1 FROM public.petro_subscriptions
    WHERE id = ids.provider_subscription AND price_snapshot_minor = preserved_price
      AND ends_at = preserved_end AND cancellation_effective_at > now()
  ) THEN
    RAISE EXCEPTION 'cancellation changed the subscription''s historical terms';
  END IF;

  INSERT INTO public.petro_subscriptions (
    request_id, organization_id, branch_id, plan_id, plan_version_id, plan_snapshot,
    price_snapshot_minor, billing_unit, units, starts_at, ends_at, status, created_by
  ) SELECT ids.expired_request, ids.station_org, ids.station_branch_expired,
           ids.station_plan, ids.station_version,
           jsonb_build_object('planId', ids.station_plan, 'priceMinor', 0, 'currency', 'EGP'),
           0, 'branch', 1, now() - interval '2 days', now() - interval '1 day',
           'active', ids.owner_id;
END
$immutable_snapshots$;

RESET ROLE;
SET LOCAL ROLE service_role;
DO $branch_service_gate$
DECLARE
  ids pg_temp.billing_test_ids%ROWTYPE;
BEGIN
  SELECT * INTO ids FROM pg_temp.billing_test_ids;
  IF NOT petro_private.subscription_allows_new_service(ids.station_org, ids.station_branch)
     OR petro_private.subscription_allows_new_service(ids.station_org, ids.station_branch_expired)
     OR petro_private.subscription_allows_new_service(ids.provider_org, ids.provider_branch) THEN
    RAISE EXCEPTION 'branch-level service gate failed active, expired, or pending-payment isolation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.petro_subscriptions
    WHERE id = (SELECT id FROM public.petro_subscriptions
                WHERE branch_id = ids.station_branch_expired ORDER BY created_at DESC LIMIT 1)
      AND ends_at > now()
  ) THEN
    RAISE EXCEPTION 'expired branch test record was unexpectedly current';
  END IF;
END
$branch_service_gate$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claim.sub',
  (SELECT operations_id::text FROM pg_temp.billing_test_ids),
  true
);
DO $owner_only$
BEGIN
  BEGIN
    PERFORM public.petro_billing_admin_catalog();
    RAISE EXCEPTION 'non-owner read the plan and subscription administration catalog';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$owner_only$;

ROLLBACK;
