BEGIN;

ALTER TABLE public.petro_fleet_vehicles
  ADD COLUMN tank_capacity_liters numeric(9,3);
ALTER TABLE public.petro_fleet_vehicles
  ADD CONSTRAINT petro_fleet_vehicles_tank_capacity_check
  CHECK (tank_capacity_liters IS NULL OR tank_capacity_liters > 0);

ALTER TABLE public.petro_fleet_credential_requests
  ADD COLUMN fulfillment_method text NOT NULL DEFAULT 'unspecified'
    CHECK (fulfillment_method IN ('unspecified','install','pickup')),
  ADD COLUMN installation_address text,
  ADD COLUMN pickup_location text,
  ADD COLUMN fulfillment_contact_name text,
  ADD COLUMN fulfillment_contact_phone text,
  ADD CONSTRAINT petro_fleet_credential_fulfillment_details_check CHECK (
    (fulfillment_method = 'unspecified')
    OR (fulfillment_method = 'install'
        AND char_length(btrim(coalesce(installation_address,''))) BETWEEN 4 AND 500
        AND char_length(btrim(coalesce(fulfillment_contact_phone,''))) BETWEEN 3 AND 40)
    OR (fulfillment_method = 'pickup'
        AND char_length(btrim(coalesce(pickup_location,''))) BETWEEN 2 AND 200)
  );

ALTER TABLE public.petro_fleet_policy_rules
  DROP CONSTRAINT petro_fleet_policy_rules_service_group_check,
  ADD CONSTRAINT petro_fleet_policy_rules_service_group_check
    CHECK (service_group IN ('fuel','wash','oils','batteries','filters','parts','consumables'));

ALTER TABLE public.petro_fleet_usage_reservations
  DROP CONSTRAINT petro_fleet_usage_reservations_service_group_check,
  ADD CONSTRAINT petro_fleet_usage_reservations_service_group_check
    CHECK (service_group IN ('fuel','wash','oils','batteries','filters','parts','consumables'));

DO $fleet_onboarding_patch$
DECLARE
  command_definition text;
  catalog_definition text;
  policy_definition text;
  summaries_definition text;
BEGIN
  command_definition := pg_catalog.pg_get_functiondef(
    'public.petro_admin_fleet_command(text,jsonb,text,text)'::regprocedure
  );
  catalog_definition := pg_catalog.pg_get_functiondef(
    'public.petro_admin_fleet_catalog(text,jsonb)'::regprocedure
  );
  policy_definition := pg_catalog.pg_get_functiondef(
    'petro_private.fleet_check_usage_policy_at(uuid,uuid,uuid,uuid,text,bigint,numeric,timestamptz)'::regprocedure
  );
  summaries_definition := pg_catalog.pg_get_functiondef(
    'public.petro_admin_fleet_company_summaries(uuid,text,integer,integer)'::regprocedure
  );

  IF pg_catalog.strpos(command_definition,
      'internal_code,fuel_type,created_by,updated_by') = 0
     OR pg_catalog.strpos(command_definition,
      'btrim(p_payload->>''fuelType''),actor,actor') = 0
     OR pg_catalog.strpos(command_definition,
      'fuel_type=btrim(p_payload->>''fuelType''),version=version+1') = 0
     OR pg_catalog.strpos(command_definition,
      'issue_price_minor,reason,created_by') = 0
     OR pg_catalog.strpos(command_definition,
      'issue_price_minor,previous_credential_id,reason,created_by') = 0
     OR pg_catalog.strpos(command_definition,
      'jsonb_array_length(p_payload->''rules'')<>4') = 0 THEN
    RAISE EXCEPTION '0022 could not locate the expected fleet command fragments';
  END IF;
  command_definition := pg_catalog.replace(
    command_definition,
    'internal_code,fuel_type,created_by,updated_by',
    'internal_code,fuel_type,tank_capacity_liters,created_by,updated_by'
  );
  command_definition := pg_catalog.replace(
    command_definition,
    'btrim(p_payload->>''fuelType''),actor,actor',
    'btrim(p_payload->>''fuelType''),nullif(p_payload->>''tankCapacityLiters'','''')::numeric,actor,actor'
  );
  command_definition := pg_catalog.replace(
    command_definition,
    'nullif(btrim(rule_row->>''internalCode''),''''),btrim(rule_row->>''fuelType''),actor,actor',
    'nullif(btrim(rule_row->>''internalCode''),''''),btrim(rule_row->>''fuelType''),nullif(rule_row->>''tankCapacityLiters'','''')::numeric,actor,actor'
  );
  command_definition := pg_catalog.replace(
    command_definition,
    'fuel_type=btrim(p_payload->>''fuelType''),version=version+1',
    'fuel_type=btrim(p_payload->>''fuelType''),tank_capacity_liters=nullif(p_payload->>''tankCapacityLiters'','''')::numeric,version=version+1'
  );
  command_definition := pg_catalog.replace(
    command_definition,
    'issue_price_minor,reason,created_by',
    'issue_price_minor,fulfillment_method,installation_address,pickup_location,fulfillment_contact_name,fulfillment_contact_phone,reason,created_by'
  );
  command_definition := pg_catalog.replace(
    command_definition,
    'CASE WHEN credential_type=''nfc'' THEN credential_price ELSE 0 END,p_reason,actor',
    'CASE WHEN credential_type=''nfc'' THEN credential_price ELSE 0 END,coalesce(nullif(p_payload->>''fulfillmentMethod'',''''),''unspecified''),nullif(btrim(p_payload->>''installationAddress''),''''),nullif(btrim(p_payload->>''pickupLocation''),''''),nullif(btrim(p_payload->>''fulfillmentContactName''),''''),nullif(btrim(p_payload->>''fulfillmentContactPhone''),''''),p_reason,actor'
  );
  command_definition := pg_catalog.replace(
    command_definition,
    'issue_price_minor,previous_credential_id,reason,created_by',
    'issue_price_minor,previous_credential_id,fulfillment_method,installation_address,pickup_location,fulfillment_contact_name,fulfillment_contact_phone,reason,created_by'
  );
  command_definition := pg_catalog.replace(
    command_definition,
    'nullif(p_payload->>''previousCredentialId'','''')::uuid,p_reason,actor',
    'nullif(p_payload->>''previousCredentialId'','''')::uuid,coalesce(nullif(p_payload->>''fulfillmentMethod'',''''),''unspecified''),nullif(btrim(p_payload->>''installationAddress''),''''),nullif(btrim(p_payload->>''pickupLocation''),''''),nullif(btrim(p_payload->>''fulfillmentContactName''),''''),nullif(btrim(p_payload->>''fulfillmentContactPhone''),''''),p_reason,actor'
  );
  command_definition := pg_catalog.replace(
    command_definition,
    'jsonb_array_length(p_payload->''rules'')<>4',
    'jsonb_array_length(p_payload->''rules'')<>7'
  );
  command_definition := pg_catalog.replace(command_definition, '<>4', '<>7');
  IF pg_catalog.strpos(command_definition, 'tankCapacityLiters') = 0
     OR pg_catalog.strpos(command_definition, 'fulfillment_method') = 0
     OR pg_catalog.strpos(command_definition, 'jsonb_array_length(p_payload->''rules'')<>7') = 0 THEN
    RAISE EXCEPTION '0022 did not update all fleet command fragments';
  END IF;

  IF pg_catalog.strpos(summaries_definition, '''nfcIssuePriceMinor'', issue_price') = 0 THEN
    RAISE EXCEPTION '0022 could not locate the fleet capability metadata fields';
  END IF;
  summaries_definition := pg_catalog.replace(
    summaries_definition,
    '''nfcIssuePriceMinor'', issue_price',
    '''nfcIssuePriceMinor'', issue_price, ''onboardingCapabilitiesVersion'', 2'
  );
  EXECUTE summaries_definition;
  EXECUTE command_definition;

  IF pg_catalog.strpos(catalog_definition, '''fuelType'', f.fuel_type') = 0
     OR pg_catalog.strpos(catalog_definition, '''fuelType'',v.fuel_type') = 0
     OR pg_catalog.strpos(catalog_definition, '''waiverReason'',r.waiver_reason') = 0 THEN
    RAISE EXCEPTION '0022 could not locate the expected fleet catalog fragments';
  END IF;
  catalog_definition := pg_catalog.replace(
    catalog_definition,
    '''fuelType'', f.fuel_type,',
    '''fuelType'', f.fuel_type, ''tankCapacityLiters'', f.tank_capacity_liters,'
  );
  catalog_definition := pg_catalog.replace(
    catalog_definition,
    '''fuelType'',v.fuel_type,''status''',
    '''fuelType'',v.fuel_type,''tankCapacityLiters'',v.tank_capacity_liters,''status'''
  );
  catalog_definition := pg_catalog.replace(
    catalog_definition,
    '''waiverReason'',r.waiver_reason,''approvedBy''',
    '''waiverReason'',r.waiver_reason,''fulfillmentMethod'',r.fulfillment_method,''installationAddress'',r.installation_address,''pickupLocation'',r.pickup_location,''fulfillmentContactName'',r.fulfillment_contact_name,''fulfillmentContactPhone'',r.fulfillment_contact_phone,''approvedBy'''
  );
  EXECUTE catalog_definition;

  IF pg_catalog.strpos(policy_definition,
      'p_service_group NOT IN (''fuel'',''wash'',''oils'',''parts'')') = 0 THEN
    RAISE EXCEPTION '0022 could not locate the expected fleet usage policy allow-list';
  END IF;
  policy_definition := pg_catalog.replace(
    policy_definition,
    'p_service_group NOT IN (''fuel'',''wash'',''oils'',''parts'')',
    'p_service_group NOT IN (''fuel'',''wash'',''oils'',''batteries'',''filters'',''parts'',''consumables'')'
  );
  EXECUTE policy_definition;
END
$fleet_onboarding_patch$;

COMMIT;
