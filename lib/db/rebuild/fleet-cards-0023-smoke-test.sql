-- Synthetic 0023 integration test. Run only from run-local-test.sh against its
-- disposable PostgreSQL instance; never run on Supabase or a live project DB.
BEGIN;

INSERT INTO auth.users(id,email,raw_user_meta_data,email_confirmed_at)
VALUES
  ('00000000-0000-4000-8000-000000002301','fleet-0023-owner@example.invalid',
    '{"username":"fleet_0023_owner","display_name":"Fleet 0023 Owner"}',now()),
  ('00000000-0000-4000-8000-000000002302','fleet-0023-viewer@example.invalid',
    '{"username":"fleet_0023_viewer","display_name":"Fleet 0023 Viewer"}',now());
UPDATE public.petro_profiles SET active=true,account_status='active'
WHERE user_id IN (
  '00000000-0000-4000-8000-000000002301',
  '00000000-0000-4000-8000-000000002302'
);
INSERT INTO public.petro_platform_roles(user_id,role,active)
VALUES ('00000000-0000-4000-8000-000000002301','owner',true);
INSERT INTO public.petro_organizations(
  id,name,kind,code,status,approval_status,operational_status,created_by
) VALUES (
  '00000000-0000-4000-8000-000000002311','شركة اختبار البطاقات','company','FLEET-0023','active','approved','active',
  '00000000-0000-4000-8000-000000002301'
);
INSERT INTO public.petro_branches(
  id,organization_id,name,code,status,approval_status,operational_status
) VALUES (
  '00000000-0000-4000-8000-000000002321','00000000-0000-4000-8000-000000002311',
  'فرع اختبار البطاقات','FLEET-0023-B1','active','approved','active'
);

SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000002301';

DO $fleet_cards_0023$
DECLARE
  vehicle_result jsonb;
  driver_result jsonb;
  link_result jsonb;
  rotated_result jsonb;
  legacy_driver_result jsonb;
  legacy_link_result jsonb;
  reveal_result jsonb;
  legacy_reveal jsonb;
  ended_result jsonb;
  cards_result jsonb;
  request_id uuid;
  vehicle_id uuid;
  driver_id uuid;
  test_link_id uuid;
  legacy_link_id uuid;
  changed jsonb;
BEGIN
  IF NOT has_function_privilege('authenticated','public.petro_admin_fleet_command(text,jsonb,text,text)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.petro_admin_fleet_pair_pin_reveal(uuid,text)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.petro_admin_fleet_cards_catalog(text,jsonb)','EXECUTE')
     OR has_function_privilege('anon','public.petro_admin_fleet_command(text,jsonb,text,text)','EXECUTE')
     OR has_function_privilege('anon','public.petro_admin_fleet_pair_pin_reveal(uuid,text)','EXECUTE')
     OR has_function_privilege('anon','public.petro_admin_fleet_cards_catalog(text,jsonb)','EXECUTE')
     OR has_function_privilege('service_role','public.petro_admin_fleet_command(text,jsonb,text,text)','EXECUTE')
     OR has_function_privilege('service_role','public.petro_admin_fleet_pair_pin_reveal(uuid,text)','EXECUTE')
     OR has_function_privilege('service_role','public.petro_admin_fleet_cards_catalog(text,jsonb)','EXECUTE')
     OR has_function_privilege('authenticated','public.petro_admin_fleet_command_legacy_0014(text,jsonb,text,text)','EXECUTE')
     OR has_function_privilege('anon','public.petro_admin_fleet_command_legacy_0014(text,jsonb,text,text)','EXECUTE')
     OR has_function_privilege('service_role','public.petro_admin_fleet_command_legacy_0014(text,jsonb,text,text)','EXECUTE')
     OR EXISTS (
       SELECT 1
       FROM pg_proc procedure_row
       CROSS JOIN LATERAL aclexplode(coalesce(
         procedure_row.proacl,
         acldefault('f',procedure_row.proowner)
       )) privilege
       WHERE procedure_row.oid IN (
         'public.petro_admin_fleet_command(text,jsonb,text,text)'::regprocedure,
         'public.petro_admin_fleet_pair_pin_reveal(uuid,text)'::regprocedure,
         'public.petro_admin_fleet_cards_catalog(text,jsonb)'::regprocedure,
         'public.petro_admin_fleet_command_legacy_0014(text,jsonb,text,text)'::regprocedure
       )
         AND privilege.grantee=0
         AND privilege.privilege_type='EXECUTE'
     ) THEN
    RAISE EXCEPTION '0023 function grants are broader than intended';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid='petro_private.petro_fleet_driver_pair_secrets'::regclass
      AND constraint_row.conname='petro_fleet_driver_pair_secrets_key_version_check'
      AND constraint_row.convalidated
      AND regexp_replace(lower(pg_get_constraintdef(constraint_row.oid)),'[()[:space:]]','','g')
          ='checkkey_version>=1andkey_version<=32'
  ) OR EXISTS (
    SELECT 1
    FROM pg_proc procedure_row
    WHERE procedure_row.oid IN (
      'public.petro_admin_fleet_command(text,jsonb,text,text)'::regprocedure,
      'public.petro_admin_fleet_pair_pin_reveal(uuid,text)'::regprocedure,
      'public.petro_admin_fleet_cards_catalog(text,jsonb)'::regprocedure
    )
      AND (
        NOT procedure_row.prosecdef
        OR NOT (
          coalesce(procedure_row.proconfig,'{}'::text[])
          @> ARRAY['search_path=""']::text[]
        )
      )
  ) THEN
    RAISE EXCEPTION '0023 function security settings or key-version constraint differ from the approved contract';
  END IF;

  vehicle_result := public.petro_admin_fleet_command(
    'vehicle.create',
    jsonb_build_object(
      'organizationId','00000000-0000-4000-8000-000000002311',
      'branchId','00000000-0000-4000-8000-000000002321',
      'plateOriginal','س 23 1','plateStandard','س٢٣١','category','سيدان',
      'vehicleType','سيارة','brand','مصنع اختبار','model','طراز الاختبار',
      'modelYear',2024,'fuelType','petrol','credentialType','nfc',
      'fulfillmentMethod','pickup','pickupLocation','مكتب الفرع'
    ),
    'اختبار عرض طلب البطاقة',
    'fleet-0023-vehicle-0001'
  );
  vehicle_id := (vehicle_result->>'id')::uuid;
  request_id := (vehicle_result->>'credentialRequestId')::uuid;
  IF vehicle_id IS NULL OR request_id IS NULL THEN
    RAISE EXCEPTION 'vehicle command did not create the expected NFC request';
  END IF;

  driver_result := public.petro_admin_fleet_command(
    'driver.create',
    jsonb_build_object(
      'organizationId','00000000-0000-4000-8000-000000002311',
      'driverCode','D-0023','fullName','سائق اختبار البطاقات'
    ),
    'اختبار إنشاء سائق',
    'fleet-0023-driver-0001'
  );
  driver_id := (driver_result->>'id')::uuid;
  link_result := public.petro_admin_fleet_command(
    'driver.link.create',
    jsonb_build_object(
      'vehicleId',vehicle_id,'driverId',driver_id,
      'startsAt',now(),'pinHmac',repeat('a',64),
      'pinCiphertext',repeat('ab',32),'pinKeyVersion',1
    ),
    'اختبار تعيين رمز سائق',
    'fleet-0023-link-0001'
  );
  test_link_id := (link_result->>'id')::uuid;
  IF test_link_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM petro_private.petro_fleet_driver_pair_secrets secret
    WHERE secret.link_id=test_link_id AND secret.active
      AND secret.pin_ciphertext=decode(repeat('ab',32),'hex')
  ) THEN
    RAISE EXCEPTION 'driver pair ciphertext was not persisted with its active HMAC row';
  END IF;

  rotated_result := public.petro_admin_fleet_command(
    'driver.pin.rotate',
    jsonb_build_object(
      'linkId',test_link_id,'vehicleId',vehicle_id,'pinHmac',repeat('b',64),
      'pinCiphertext',repeat('cd',32),'pinKeyVersion',1
    ),
    'اختبار تدوير رمز السائق',
    'fleet-0023-pin-rotate-0001'
  );
  IF rotated_result->>'id'<>test_link_id::text OR NOT EXISTS (
    SELECT 1 FROM petro_private.petro_fleet_driver_pair_secrets secret
    WHERE secret.link_id=test_link_id AND secret.active
      AND secret.pin_hmac=decode(repeat('b',64),'hex')
      AND secret.pin_ciphertext=decode(repeat('cd',32),'hex')
  ) THEN
    RAISE EXCEPTION 'PIN rotation did not replace the active encrypted secret';
  END IF;

  reveal_result := public.petro_admin_fleet_pair_pin_reveal(test_link_id,'مراجعة الرمز قبل إعادة إسناد المركبة');
  IF reveal_result->>'resetRequired'<>'false'
     OR reveal_result->>'ciphertext'<>repeat('cd',32)
     OR reveal_result ? 'pinCode' THEN
    RAISE EXCEPTION 'PIN reveal RPC returned an unsafe or incomplete response';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.petro_audit_events audit
    WHERE audit.action='fleet.driver_pin_revealed' AND audit.target_id=test_link_id
      AND audit.detail->>'reason'='مراجعة الرمز قبل إعادة إسناد المركبة'
      AND NOT (audit.detail ?| ARRAY['pin','pinCode','pinHmac','pinHash'])
  ) THEN
    RAISE EXCEPTION 'PIN reveal was not audited without the PIN material';
  END IF;

  legacy_driver_result := public.petro_admin_fleet_command(
    'driver.create',
    jsonb_build_object(
      'organizationId','00000000-0000-4000-8000-000000002311',
      'driverCode','D-0023-LEGACY','fullName','سائق قديم للاختبار'
    ),
    'اختبار سجل قديم',
    'fleet-0023-driver-legacy'
  );
  legacy_link_result := public.petro_admin_fleet_command_legacy_0014(
    'driver.link.create',
    jsonb_build_object(
      'vehicleId',vehicle_id,'driverId',legacy_driver_result->>'id',
      'pinHmac',repeat('c',64)
    ),
    'إنشاء رابط قديم بلا نص مشفر',
    'fleet-0023-link-legacy'
  );
  legacy_link_id := (legacy_link_result->>'id')::uuid;
  legacy_reveal := public.petro_admin_fleet_pair_pin_reveal(legacy_link_id,'فحص سجل رمز قديم');
  IF legacy_reveal->>'resetRequired'<>'true' OR legacy_reveal ? 'ciphertext' THEN
    RAISE EXCEPTION 'legacy HMAC-only row must request safe PIN rotation';
  END IF;

  INSERT INTO public.petro_vehicle_credentials(
    organization_id,branch_id,vehicle_id,credential_type,token_sha256,token_hint,status,
    activated_by,reason
  ) VALUES (
    '00000000-0000-4000-8000-000000002311','00000000-0000-4000-8000-000000002321',
    vehicle_id,'qr',repeat('d',64),'123456','active',
    '00000000-0000-4000-8000-000000002301','اختبار بطاقة QR معزولة'
  );
  INSERT INTO public.petro_fleet_tag_stock_units(unit_code,unit_type,status,created_by)
  VALUES ('FLEET-0023-STOCK-1','nfc','available','00000000-0000-4000-8000-000000002301');

  cards_result := public.petro_admin_fleet_cards_catalog('overview',jsonb_build_object(
    'organizationId','00000000-0000-4000-8000-000000002311'
  ));
  IF (cards_result->'summary'->>'openRequests')::integer<>1
     OR (cards_result->'summary'->>'activeQr')::integer<>1
     OR (cards_result->'summary'->>'availableStock')::integer<>0 THEN
    RAISE EXCEPTION 'cards overview did not return real scoped counts: %',cards_result;
  END IF;
  cards_result := public.petro_admin_fleet_cards_catalog('overview','{}'::jsonb);
  IF (cards_result->'summary'->>'availableStock')::integer<>1 THEN
    RAISE EXCEPTION 'global card overview omitted unassigned central stock: %',cards_result;
  END IF;

  cards_result := public.petro_admin_fleet_cards_catalog('requests',jsonb_build_object(
    'organizationId','00000000-0000-4000-8000-000000002311',
    'vehicleId',vehicle_id,'page',1,'pageSize',10
  ));
  IF (cards_result->>'total')::integer<>1
     OR cards_result->'items'->0->>'fulfillmentMethod'<>'pickup'
     OR cards_result::text ILIKE '%token_sha256%'
     OR cards_result::text ILIKE '%pin_hmac%' THEN
    RAISE EXCEPTION 'card request list scope, fulfillment, or secret filtering failed: %',cards_result;
  END IF;
  cards_result := public.petro_admin_fleet_cards_catalog('issued',jsonb_build_object(
    'organizationId','00000000-0000-4000-8000-000000002311',
    'vehicleId',vehicle_id,'page',1,'pageSize',10
  ));
  IF (cards_result->>'total')::integer<>1
     OR cards_result::text ILIKE '%token_sha256%' THEN
    RAISE EXCEPTION 'issued card list did not return only safe metadata: %',cards_result;
  END IF;
  UPDATE public.petro_vehicle_credentials c SET status='revoked',revoked_at=now()
    WHERE c.vehicle_id=fleet_cards_0023.vehicle_id;
  cards_result := public.petro_admin_fleet_cards_catalog('issued',jsonb_build_object(
    'vehicleId',vehicle_id,'status','inactive','page',1,'pageSize',10
  ));
  IF (cards_result->>'total')::integer<>1
     OR cards_result->'items'->0->>'status'<>'revoked' THEN
    RAISE EXCEPTION 'inactive card category must include revoked issued cards: %',cards_result;
  END IF;
  cards_result := public.petro_admin_fleet_cards_catalog('issued',jsonb_build_object(
    'vehicleId',vehicle_id,'status','active','page',1,'pageSize',10
  ));
  IF (cards_result->>'total')::integer<>0 THEN
    RAISE EXCEPTION 'active category must exclude revoked cards';
  END IF;
  cards_result := public.petro_admin_fleet_cards_catalog('stock','{}'::jsonb);
  IF (cards_result->>'total')::integer<>1 THEN
    RAISE EXCEPTION 'stock list omitted real local stock fixture: %',cards_result;
  END IF;

  PERFORM set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000002302',true);
  BEGIN
    PERFORM public.petro_admin_fleet_pair_pin_reveal(test_link_id,'محاولة مستخدم غير مخول');
    RAISE EXCEPTION 'unauthorized user unexpectedly revealed the PIN';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    PERFORM public.petro_admin_fleet_cards_catalog('requests','{}'::jsonb);
    RAISE EXCEPTION 'unauthorized user unexpectedly read card records';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000002301',true);

  ended_result := public.petro_admin_fleet_command(
    'driver.link.end',
    jsonb_build_object('linkId',test_link_id),
    'اختبار إيقاف الرابط',
    'fleet-0023-link-end-0001'
  );
  IF ended_result->>'status'<>'ended' THEN
    RAISE EXCEPTION 'driver link did not end';
  END IF;
  BEGIN
    PERFORM public.petro_admin_fleet_pair_pin_reveal(test_link_id,'يجب ألا يعرض رابط غير نشط');
    RAISE EXCEPTION 'inactive link unexpectedly revealed the PIN';
  EXCEPTION WHEN no_data_found THEN
    NULL;
  END;
END
$fleet_cards_0023$;

ROLLBACK;
