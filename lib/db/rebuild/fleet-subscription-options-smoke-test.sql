-- Synthetic acceptance for 0015. Runs only inside the disposable PostgreSQL cluster.
BEGIN;

INSERT INTO auth.users(id,email,raw_user_meta_data,email_confirmed_at)
VALUES
  ('00000000-0000-4000-8000-000000001501','fleet-options-owner@example.invalid',
   '{"username":"fleet_options_owner","display_name":"Fleet Options Owner"}',now()),
  ('00000000-0000-4000-8000-000000001502','fleet-options-support@example.invalid',
   '{"username":"fleet_options_support","display_name":"Fleet Options Support"}',now());
UPDATE public.petro_profiles SET active=true,account_status='active'
WHERE user_id IN ('00000000-0000-4000-8000-000000001501','00000000-0000-4000-8000-000000001502');
INSERT INTO public.petro_platform_roles(user_id,role,active)
VALUES
  ('00000000-0000-4000-8000-000000001501','owner',true),
  ('00000000-0000-4000-8000-000000001502','support',true);

INSERT INTO public.petro_organizations(
  id,name,kind,code,status,approval_status,operational_status,created_by
) VALUES
  ('00000000-0000-4000-8000-000000001511','شركة تغطية اختبار','company','COV-TEST-A',
   'active','approved','active','00000000-0000-4000-8000-000000001501');
INSERT INTO public.petro_branches(
  id,organization_id,name,code,status,approval_status,operational_status
) VALUES
  ('00000000-0000-4000-8000-000000001521','00000000-0000-4000-8000-000000001511',
   'فرع تغطية اختبار','COV-TEST-A1','active','approved','active');

INSERT INTO public.petro_plans(id,code,audience,name,active,description)
VALUES
  ('00000000-0000-4000-8000-000000001531','COV-VEHICLE','company','خطة مركبات اختبار',true,'اختبار معزول'),
  ('00000000-0000-4000-8000-000000001532','COV-BRANCH','company','خطة فروع اختبار',true,'اختبار معزول');
INSERT INTO public.petro_plan_versions(
  id,plan_id,version,annual_price_minor,billing_unit,created_by,effective_at,
  display_name,description,publication_status,billing_cycle,currency,entitlements,settings
) VALUES
  ('00000000-0000-4000-8000-000000001541','00000000-0000-4000-8000-000000001531',
   1,50000,'vehicle','00000000-0000-4000-8000-000000001501',now()-interval '1 day',
   'خطة مركبات اختبار','اختبار معزول','published','annual','EGP','[]','[]'),
  ('00000000-0000-4000-8000-000000001542','00000000-0000-4000-8000-000000001532',
   1,50000,'branch','00000000-0000-4000-8000-000000001501',now()-interval '1 day',
   'خطة فروع اختبار','اختبار معزول','published','annual','EGP','[]','[]');

INSERT INTO public.petro_subscription_requests(
  id,organization_id,branch_id,request_type,plan_id,plan_version_id,requested_units,
  starts_at,ends_at,coverage_state,request_status,reason,submitted_by,reviewed_by,reviewed_at
) VALUES
  ('00000000-0000-4000-8000-000000001551','00000000-0000-4000-8000-000000001511',
   '00000000-0000-4000-8000-000000001521','new','00000000-0000-4000-8000-000000001531',
   '00000000-0000-4000-8000-000000001541',2,now()-interval '1 day',now()+interval '1 year',
   'verified','approved','اشتراك مركبات اختباري','00000000-0000-4000-8000-000000001501',
   '00000000-0000-4000-8000-000000001501',now()),
  ('00000000-0000-4000-8000-000000001552','00000000-0000-4000-8000-000000001511',
   '00000000-0000-4000-8000-000000001521','new','00000000-0000-4000-8000-000000001531',
   '00000000-0000-4000-8000-000000001541',2,now()+interval '3 hours',now()+interval '1 year',
   'verified','approved','اشتراك مجدول اختباري','00000000-0000-4000-8000-000000001501',
   '00000000-0000-4000-8000-000000001501',now()),
  ('00000000-0000-4000-8000-000000001553','00000000-0000-4000-8000-000000001511',
   '00000000-0000-4000-8000-000000001521','new','00000000-0000-4000-8000-000000001532',
   '00000000-0000-4000-8000-000000001542',1,now()-interval '1 day',now()+interval '1 year',
   'verified','approved','اشتراك فرع اختباري','00000000-0000-4000-8000-000000001501',
   '00000000-0000-4000-8000-000000001501',now()),
  ('00000000-0000-4000-8000-000000001554','00000000-0000-4000-8000-000000001511',
   '00000000-0000-4000-8000-000000001521','new','00000000-0000-4000-8000-000000001531',
   '00000000-0000-4000-8000-000000001541',2,now()-interval '1 day',now()+interval '1 year',
   'verified','approved','اشتراك غير مدفوع اختباري','00000000-0000-4000-8000-000000001501',
   '00000000-0000-4000-8000-000000001501',now());
INSERT INTO public.petro_subscriptions(
  id,request_id,organization_id,branch_id,plan_id,plan_version_id,plan_snapshot,
  price_snapshot_minor,billing_unit,units,starts_at,ends_at,status,created_by
) VALUES
  ('00000000-0000-4000-8000-000000001561','00000000-0000-4000-8000-000000001551',
   '00000000-0000-4000-8000-000000001511','00000000-0000-4000-8000-000000001521',
   '00000000-0000-4000-8000-000000001531','00000000-0000-4000-8000-000000001541',
   '{"fixture":"synthetic","version":1}',50000,'vehicle',2,now()-interval '1 day',
   now()+interval '1 year','active','00000000-0000-4000-8000-000000001501'),
  ('00000000-0000-4000-8000-000000001562','00000000-0000-4000-8000-000000001552',
   '00000000-0000-4000-8000-000000001511','00000000-0000-4000-8000-000000001521',
   '00000000-0000-4000-8000-000000001531','00000000-0000-4000-8000-000000001541',
   '{"fixture":"synthetic","version":1}',50000,'vehicle',2,now()+interval '3 hours',
   now()+interval '1 year','scheduled','00000000-0000-4000-8000-000000001501'),
  ('00000000-0000-4000-8000-000000001563','00000000-0000-4000-8000-000000001553',
   '00000000-0000-4000-8000-000000001511','00000000-0000-4000-8000-000000001521',
   '00000000-0000-4000-8000-000000001532','00000000-0000-4000-8000-000000001542',
   '{"fixture":"synthetic","version":1}',50000,'branch',1,now()-interval '1 day',
   now()+interval '1 year','active','00000000-0000-4000-8000-000000001501'),
  ('00000000-0000-4000-8000-000000001564','00000000-0000-4000-8000-000000001554',
   '00000000-0000-4000-8000-000000001511','00000000-0000-4000-8000-000000001521',
   '00000000-0000-4000-8000-000000001531','00000000-0000-4000-8000-000000001541',
   '{"fixture":"synthetic","version":1}',50000,'vehicle',2,now()-interval '1 day',
   now()+interval '1 year','pending_payment','00000000-0000-4000-8000-000000001501');

INSERT INTO public.petro_fleet_tag_stock_units(id,unit_code,status,created_by)
VALUES
  ('00000000-0000-4000-8000-000000001571','NFC-TEST-AVAILABLE-A','available','00000000-0000-4000-8000-000000001501'),
  ('00000000-0000-4000-8000-000000001572','NFC-TEST-AVAILABLE-B','available','00000000-0000-4000-8000-000000001501'),
  ('00000000-0000-4000-8000-000000001573','NFC-TEST-DAMAGED','damaged','00000000-0000-4000-8000-000000001501');

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000001501';
DO $subscription_options$
DECLARE result jsonb; stock_result jsonb;
BEGIN
  IF NOT has_function_privilege(
       'authenticated',
       'public.petro_admin_fleet_subscription_options(uuid,text,integer,integer)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.petro_admin_fleet_subscription_options(uuid,text,integer,integer)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'fleet subscription option privileges are not restricted';
  END IF;
  result := public.petro_admin_fleet_subscription_options(
    '00000000-0000-4000-8000-000000001511', 'اختبار', 1, 20
  );
  IF jsonb_array_length(result->'items') <> 2
     OR NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(result->'items') item
       WHERE item->>'subscriptionId'='00000000-0000-4000-8000-000000001561'
         AND item->>'planName'='خطة مركبات اختبار'
         AND item->>'billingUnit'='vehicle'
     )
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(result->'items') item
       WHERE item->>'subscriptionId' IN (
         '00000000-0000-4000-8000-000000001563',
         '00000000-0000-4000-8000-000000001564'
       )
     ) THEN
    RAISE EXCEPTION 'selector did not include active/scheduled vehicle-only subscriptions: %', result;
  END IF;
  IF jsonb_array_length((public.petro_admin_fleet_subscription_options(
      '00000000-0000-4000-8000-000000001511', 'no matching plan', 1, 20
    ))->'items') <> 0 THEN
    RAISE EXCEPTION 'selector search did not constrain results';
  END IF;
  IF NOT has_function_privilege(
       'authenticated','public.petro_admin_fleet_stock_options(text,integer,integer)','EXECUTE'
     )
     OR has_function_privilege(
       'anon','public.petro_admin_fleet_stock_options(text,integer,integer)','EXECUTE'
     ) THEN
    RAISE EXCEPTION 'stock option privileges are not restricted';
  END IF;
  stock_result := public.petro_admin_fleet_stock_options('NFC-TEST-AVAILABLE',1,20);
  IF jsonb_array_length(stock_result->'items')<>2
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(stock_result->'items') item
       WHERE item->>'status'<>'available'
          OR item->>'unitCode' NOT LIKE 'NFC-TEST-AVAILABLE-%'
     ) THEN
    RAISE EXCEPTION 'stock selector returned unavailable or unrelated units: %',stock_result;
  END IF;
END
$subscription_options$;

RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000001502';
DO $subscription_options_role_gate$
BEGIN
  BEGIN
    PERFORM public.petro_admin_fleet_subscription_options(NULL,NULL,1,20);
    RAISE EXCEPTION 'support role read vehicle subscription choices';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    PERFORM public.petro_admin_fleet_stock_options(NULL,1,20);
    RAISE EXCEPTION 'support role read stock unit choices';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$subscription_options_role_gate$;
ROLLBACK;
