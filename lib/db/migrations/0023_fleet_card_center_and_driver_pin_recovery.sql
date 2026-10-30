BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('public.petro_admin_fleet_command(text,jsonb,text,text)') IS NULL THEN
    RAISE EXCEPTION '0023 preflight failed: expected fleet command is missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'petro_private'
      AND table_name = 'petro_fleet_driver_pair_secrets'
      AND column_name = 'pin_ciphertext'
  ) THEN
    RAISE EXCEPTION '0023 must not be replayed; encrypted PIN column already exists';
  END IF;
END
$preflight$;

ALTER TABLE petro_private.petro_fleet_driver_pair_secrets
  DROP CONSTRAINT petro_fleet_driver_pair_secrets_key_version_check;
ALTER TABLE petro_private.petro_fleet_driver_pair_secrets
  ADD CONSTRAINT petro_fleet_driver_pair_secrets_key_version_check
  CHECK (key_version BETWEEN 1 AND 32);
ALTER TABLE petro_private.petro_fleet_driver_pair_secrets
  ADD COLUMN pin_ciphertext bytea,
  ADD CONSTRAINT petro_fleet_driver_pair_secrets_ciphertext_size_check
    CHECK (pin_ciphertext IS NULL OR octet_length(pin_ciphertext) BETWEEN 28 AND 512);

ALTER FUNCTION public.petro_admin_fleet_command(text,jsonb,text,text)
  RENAME TO petro_admin_fleet_command_legacy_0014;
REVOKE ALL ON FUNCTION public.petro_admin_fleet_command_legacy_0014(text,jsonb,text,text)
  FROM PUBLIC, anon, authenticated, service_role;

-- The preserved 0014 body has PL/pgSQL-variable/column ambiguity when ending
-- or rotating a driver link. Qualify those statements before exposing them.
DO $fleet_link_predicate_fix$
DECLARE
  definition text;
  patched_definition text;
BEGIN
  definition := pg_get_functiondef(
    'public.petro_admin_fleet_command_legacy_0014(text,jsonb,text,text)'::regprocedure
  );
  IF definition !~ 'secret[.]link_id[[:space:]]*=[[:space:]]*link_id'
     OR definition !~ 'verification[.]link_id[[:space:]]*=[[:space:]]*link_id'
     OR definition !~ 'UPDATE[[:space:]]+public[.]petro_fleet_driver_links[[:space:]]+SET[[:space:]]+status=''ended'''
     OR definition !~ 'RETURNING[[:space:]]+organization_id[[:space:]]*,[[:space:]]*vehicle_id[[:space:]]*,[[:space:]]*driver_id[[:space:]]+INTO' THEN
    RAISE EXCEPTION 'FLEET_LINK_PREDICATE_SOURCE_MISMATCH';
  END IF;
  patched_definition := regexp_replace(
    definition,
    'secret[.]link_id[[:space:]]*=[[:space:]]*link_id',
    'secret.link_id=(p_payload->>''linkId'')::uuid',
    'g'
  );
  patched_definition := regexp_replace(
    patched_definition,
    'verification[.]link_id[[:space:]]*=[[:space:]]*link_id',
    'verification.link_id=(p_payload->>''linkId'')::uuid',
    'g'
  );
  patched_definition := regexp_replace(
    patched_definition,
    'UPDATE[[:space:]]+public[.]petro_fleet_driver_links[[:space:]]+SET[[:space:]]+status=''ended''',
    'UPDATE public.petro_fleet_driver_links AS changed_link SET status=''ended''',
    'g'
  );
  patched_definition := regexp_replace(
    patched_definition,
    'RETURNING[[:space:]]+organization_id[[:space:]]*,[[:space:]]*vehicle_id[[:space:]]*,[[:space:]]*driver_id[[:space:]]+INTO',
    'RETURNING changed_link.organization_id,changed_link.vehicle_id,changed_link.driver_id INTO',
    'g'
  );
  IF patched_definition = definition
     OR patched_definition ~ 'secret[.]link_id[[:space:]]*=[[:space:]]*link_id'
     OR patched_definition ~ 'verification[.]link_id[[:space:]]*=[[:space:]]*link_id'
     OR patched_definition ~ 'RETURNING[[:space:]]+organization_id[[:space:]]*,[[:space:]]*vehicle_id[[:space:]]*,[[:space:]]*driver_id[[:space:]]+INTO'
     OR patched_definition !~ 'UPDATE[[:space:]]+public[.]petro_fleet_driver_links[[:space:]]+AS[[:space:]]+changed_link[[:space:]]+SET[[:space:]]+status=''ended''' THEN
    RAISE EXCEPTION 'FLEET_LINK_PREDICATE_PATCH_FAILED';
  END IF;
  EXECUTE patched_definition;
END
$fleet_link_predicate_fix$;

CREATE FUNCTION public.petro_admin_fleet_command(
  p_action text, p_payload jsonb, p_reason text, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  legacy_payload jsonb;
  result jsonb;
  target_link_id uuid;
  pin_ciphertext_hex text;
  pin_hmac_hex text;
  key_version_value integer;
BEGIN
  legacy_payload := coalesce(p_payload, '{}'::jsonb);
  IF p_action IN ('driver.link.create','driver.pin.rotate') THEN
    pin_ciphertext_hex := legacy_payload->>'pinCiphertext';
    pin_hmac_hex := legacy_payload->>'pinHmac';
    key_version_value := nullif(legacy_payload->>'pinKeyVersion','')::integer;
    IF pin_ciphertext_hex IS NULL
       OR length(pin_ciphertext_hex) NOT BETWEEN 56 AND 1024
       OR pin_ciphertext_hex !~ '^[0-9a-f]+$'
       OR length(pin_ciphertext_hex) % 2 <> 0
       OR pin_hmac_hex IS NULL
       OR pin_hmac_hex !~ '^[0-9a-f]{64}$'
       OR key_version_value IS NULL
       OR key_version_value NOT BETWEEN 1 AND 32 THEN
      RAISE EXCEPTION 'FLEET_PIN_ENCRYPTION_REQUIRED' USING ERRCODE = '22023';
    END IF;
  END IF;

  legacy_payload := legacy_payload - 'pinCiphertext' - 'pinKeyVersion';
  result := public.petro_admin_fleet_command_legacy_0014(
    p_action, legacy_payload, p_reason, p_idempotency_key
  );

  IF p_action IN ('driver.link.create','driver.pin.rotate') THEN
    target_link_id := CASE
      WHEN p_action = 'driver.pin.rotate' THEN nullif(legacy_payload->>'linkId','')::uuid
      ELSE coalesce(
        nullif(result->>'linkId','')::uuid,
        nullif(result->>'id','')::uuid
      )
    END;
    IF target_link_id IS NULL THEN
      RAISE EXCEPTION 'FLEET_PIN_LINK_RESULT_MISSING' USING ERRCODE = '55000';
    END IF;

    UPDATE petro_private.petro_fleet_driver_pair_secrets secret
    SET pin_ciphertext = decode(pin_ciphertext_hex, 'hex'),
        key_version = key_version_value
    WHERE secret.link_id = target_link_id
      AND secret.active
      AND secret.pin_hmac = decode(pin_hmac_hex, 'hex');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'FLEET_PIN_SECRET_ROW_NOT_FOUND' USING ERRCODE = '55000';
    END IF;
  END IF;

  RETURN result;
END
$$;

CREATE FUNCTION public.petro_admin_fleet_pair_pin_reveal(
  p_link_id uuid, p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  secret_row petro_private.petro_fleet_driver_pair_secrets%ROWTYPE;
BEGIN
  IF NOT petro_private.fleet_can_manage() THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_link_id IS NULL OR char_length(btrim(coalesce(p_reason,''))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'INVALID_INPUT' USING ERRCODE = '22023';
  END IF;

  SELECT secret.*
    INTO secret_row
  FROM petro_private.petro_fleet_driver_pair_secrets secret
  JOIN public.petro_fleet_driver_links link
    ON link.id = secret.link_id
   AND link.organization_id = secret.organization_id
   AND link.vehicle_id = secret.vehicle_id
   AND link.driver_id = secret.driver_id
  JOIN public.petro_fleet_vehicles vehicle
    ON vehicle.id = secret.vehicle_id
   AND vehicle.organization_id = secret.organization_id
  JOIN public.petro_fleet_drivers driver
    ON driver.id = secret.driver_id
   AND driver.organization_id = secret.organization_id
  WHERE secret.link_id = p_link_id
    AND secret.active
    AND link.status = 'active'
    AND link.starts_at <= now()
    AND (link.ends_at IS NULL OR link.ends_at > now())
    AND vehicle.status = 'active'
    AND driver.status = 'active'
  FOR UPDATE OF secret;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'FLEET_PIN_LINK_NOT_ACTIVE' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.petro_audit_events (
    actor_id, organization_id, action, target_id, detail
  ) VALUES (
    actor_id,
    secret_row.organization_id,
    CASE WHEN secret_row.pin_ciphertext IS NULL
      THEN 'fleet.driver_pin_reveal_unavailable'
      ELSE 'fleet.driver_pin_revealed'
    END,
    secret_row.link_id,
    jsonb_build_object(
      'reason', btrim(p_reason),
      'vehicleId', secret_row.vehicle_id,
      'driverId', secret_row.driver_id,
      'keyVersion', secret_row.key_version
    )
  );

  IF secret_row.pin_ciphertext IS NULL THEN
    RETURN jsonb_build_object('resetRequired', true);
  END IF;

  RETURN jsonb_build_object(
    'resetRequired', false,
    'vehicleId', secret_row.vehicle_id,
    'keyVersion', secret_row.key_version,
    'ciphertext', encode(secret_row.pin_ciphertext, 'hex')
  );
END
$$;

CREATE FUNCTION public.petro_admin_fleet_cards_catalog(
  p_view text, p_filters jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  page_no integer := least(100000, greatest(1, coalesce((p_filters->>'page')::integer, 1)));
  page_size integer := least(100, greatest(1, coalesce((p_filters->>'pageSize')::integer, 20)));
  selected_organization uuid := nullif(p_filters->>'organizationId','')::uuid;
  selected_vehicle uuid := nullif(p_filters->>'vehicleId','')::uuid;
  selected_status text := nullif(btrim(p_filters->>'status'),'');
  search_text text := nullif(btrim(p_filters->>'search'),'');
  result jsonb;
BEGIN
  IF NOT petro_private.fleet_can_read() THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_view IS NULL OR p_view NOT IN ('overview','requests','issued','stock','history') THEN
    RAISE EXCEPTION 'INVALID_CARD_VIEW' USING ERRCODE = '22023';
  END IF;

  IF p_view = 'overview' THEN
    SELECT jsonb_build_object(
      'view', p_view,
      'items', '[]'::jsonb,
      'summary', jsonb_build_object(
        'openRequests', count(*) FILTER (WHERE request.status IN ('requested','approved','assigned','scheduled','installed')),
        'awaitingCollection', count(*) FILTER (WHERE request.payment_state = 'awaiting_collection'),
        'activeNfc', (SELECT count(*) FROM public.petro_vehicle_credentials c
          WHERE c.credential_type='nfc' AND c.status='active'
            AND (selected_organization IS NULL OR c.organization_id=selected_organization)
            AND (selected_vehicle IS NULL OR c.vehicle_id=selected_vehicle)),
        'activeQr', (SELECT count(*) FROM public.petro_vehicle_credentials c
          WHERE c.credential_type='qr' AND c.status='active'
            AND (selected_organization IS NULL OR c.organization_id=selected_organization)
            AND (selected_vehicle IS NULL OR c.vehicle_id=selected_vehicle)),
        'availableStock', (SELECT count(*) FROM public.petro_fleet_tag_stock_units s
          LEFT JOIN public.petro_fleet_credential_requests r ON r.id=s.request_id
          WHERE s.status='available'
            AND (selected_organization IS NULL OR r.organization_id=selected_organization)
            AND (selected_vehicle IS NULL OR r.vehicle_id=selected_vehicle)),
        'reservedStock', (SELECT count(*) FROM public.petro_fleet_tag_stock_units s
          LEFT JOIN public.petro_fleet_credential_requests r ON r.id=s.request_id
          WHERE s.status='reserved'
            AND (selected_organization IS NULL OR r.organization_id=selected_organization)
            AND (selected_vehicle IS NULL OR r.vehicle_id=selected_vehicle)),
        'damagedStock', (SELECT count(*) FROM public.petro_fleet_tag_stock_units s
          LEFT JOIN public.petro_fleet_credential_requests r ON r.id=s.request_id
          WHERE s.status='damaged'
            AND (selected_organization IS NULL OR r.organization_id=selected_organization)
            AND (selected_vehicle IS NULL OR r.vehicle_id=selected_vehicle)),
        'lostStock', (SELECT count(*) FROM public.petro_fleet_tag_stock_units s
          LEFT JOIN public.petro_fleet_credential_requests r ON r.id=s.request_id
          WHERE s.status='lost'
            AND (selected_organization IS NULL OR r.organization_id=selected_organization)
            AND (selected_vehicle IS NULL OR r.vehicle_id=selected_vehicle))
      ),
      'total', 0,
      'page', page_no,
      'pageSize', page_size
    )
    INTO result
    FROM public.petro_fleet_credential_requests request
    WHERE (selected_organization IS NULL OR request.organization_id=selected_organization)
      AND (selected_vehicle IS NULL OR request.vehicle_id=selected_vehicle);
    RETURN result;
  ELSIF p_view = 'requests' THEN
    WITH filtered AS (
      SELECT request.*, vehicle.plate_standard, organization.name AS organization_name,
        branch.name AS branch_name
      FROM public.petro_fleet_credential_requests request
      JOIN public.petro_fleet_vehicles vehicle ON vehicle.id=request.vehicle_id
      JOIN public.petro_organizations organization ON organization.id=request.organization_id
      JOIN public.petro_branches branch
        ON branch.id=request.branch_id AND branch.organization_id=request.organization_id
      WHERE (selected_organization IS NULL OR request.organization_id=selected_organization)
        AND (selected_vehicle IS NULL OR request.vehicle_id=selected_vehicle)
        AND (selected_status IS NULL OR request.status=selected_status)
        AND (search_text IS NULL OR vehicle.plate_standard ILIKE '%'||search_text||'%'
          OR organization.name ILIKE '%'||search_text||'%'
          OR branch.name ILIKE '%'||search_text||'%'
          OR request.fulfillment_contact_name ILIKE '%'||search_text||'%')
    )
    SELECT jsonb_build_object(
      'view',p_view,
      'items',coalesce(jsonb_agg(jsonb_build_object(
        'id',request.id,'organizationId',request.organization_id,'organizationName',request.organization_name,
        'branchId',request.branch_id,'branchName',request.branch_name,'vehicleId',request.vehicle_id,
        'plate',request.plate_standard,'type',request.credential_type,'requestType',request.request_type,
        'status',request.status,'paymentState',request.payment_state,'issuePriceMinor',request.issue_price_minor,
        'previousCredentialId',request.previous_credential_id,
        'scheduledAt',request.scheduled_at,'proofDocumentId',request.proof_document_id,
        'waiverReason',request.waiver_reason,'approvedAt',request.approved_at,
        'fulfillmentMethod',request.fulfillment_method,'installationAddress',request.installation_address,
        'pickupLocation',request.pickup_location,'fulfillmentContactName',request.fulfillment_contact_name,
        'fulfillmentContactPhone',request.fulfillment_contact_phone,'reason',request.reason,
        'createdAt',request.created_at,'updatedAt',request.updated_at)
        ORDER BY request.created_at DESC,request.id),'[]'::jsonb),
      'total',(SELECT count(*) FROM filtered),'page',page_no,'pageSize',page_size
    )
    INTO result
    FROM (
      SELECT * FROM filtered ORDER BY created_at DESC,id
      LIMIT page_size OFFSET (page_no-1)*page_size
    ) request;
    RETURN result;
  ELSIF p_view = 'issued' THEN
    WITH filtered AS (
      SELECT credential.*, vehicle.plate_standard, organization.name AS organization_name,
        branch.name AS branch_name
      FROM public.petro_vehicle_credentials credential
      JOIN public.petro_fleet_vehicles vehicle ON vehicle.id=credential.vehicle_id
      JOIN public.petro_organizations organization ON organization.id=credential.organization_id
      JOIN public.petro_branches branch
        ON branch.id=credential.branch_id AND branch.organization_id=credential.organization_id
      WHERE (selected_organization IS NULL OR credential.organization_id=selected_organization)
        AND (selected_vehicle IS NULL OR credential.vehicle_id=selected_vehicle)
        AND (selected_status IS NULL OR credential.status=selected_status)
        AND (search_text IS NULL OR vehicle.plate_standard ILIKE '%'||search_text||'%'
          OR organization.name ILIKE '%'||search_text||'%'
          OR branch.name ILIKE '%'||search_text||'%')
    )
    SELECT jsonb_build_object(
      'view',p_view,
      'items',coalesce(jsonb_agg(jsonb_build_object(
        'id',credential.id,'organizationId',credential.organization_id,
        'organizationName',credential.organization_name,'branchId',credential.branch_id,
        'branchName',credential.branch_name,'vehicleId',credential.vehicle_id,
        'plate',credential.plate_standard,'type',credential.credential_type,
        'status',credential.status,'requestId',credential.request_id,
        'activatedAt',credential.activated_at,'revokedAt',credential.revoked_at,
        'reason',credential.reason)
        ORDER BY credential.activated_at DESC,credential.id),'[]'::jsonb),
      'total',(SELECT count(*) FROM filtered),'page',page_no,'pageSize',page_size
    )
    INTO result
    FROM (
      SELECT * FROM filtered ORDER BY activated_at DESC,id
      LIMIT page_size OFFSET (page_no-1)*page_size
    ) credential;
    RETURN result;
  ELSIF p_view = 'stock' THEN
    WITH filtered AS (
      SELECT stock.*, request.status AS request_status, request.organization_id,
        request.branch_id, request.vehicle_id, vehicle.plate_standard,
        organization.name AS organization_name, branch.name AS branch_name
      FROM public.petro_fleet_tag_stock_units stock
      LEFT JOIN public.petro_fleet_credential_requests request ON request.id=stock.request_id
      LEFT JOIN public.petro_fleet_vehicles vehicle ON vehicle.id=request.vehicle_id
      LEFT JOIN public.petro_organizations organization ON organization.id=request.organization_id
      LEFT JOIN public.petro_branches branch
        ON branch.id=request.branch_id AND branch.organization_id=request.organization_id
      WHERE (selected_organization IS NULL OR request.organization_id=selected_organization)
        AND (selected_vehicle IS NULL OR request.vehicle_id=selected_vehicle)
        AND (selected_status IS NULL OR stock.status=selected_status)
        AND (search_text IS NULL OR stock.unit_code ILIKE '%'||search_text||'%'
          OR coalesce(vehicle.plate_standard,'') ILIKE '%'||search_text||'%'
          OR coalesce(organization.name,'') ILIKE '%'||search_text||'%')
    )
    SELECT jsonb_build_object(
      'view',p_view,
      'items',coalesce(jsonb_agg(jsonb_build_object(
        'id',stock.id,'unitCode',stock.unit_code,'unitType',stock.unit_type,'status',stock.status,
        'requestStatus',stock.request_status,'organizationId',stock.organization_id,
        'organizationName',stock.organization_name,'branchId',stock.branch_id,
        'branchName',stock.branch_name,'vehicleId',stock.vehicle_id,'plate',stock.plate_standard,
        'createdAt',stock.created_at)
        ORDER BY stock.created_at DESC,stock.id),'[]'::jsonb),
      'total',(SELECT count(*) FROM filtered),'page',page_no,'pageSize',page_size
    )
    INTO result
    FROM (
      SELECT * FROM filtered ORDER BY created_at DESC,id
      LIMIT page_size OFFSET (page_no-1)*page_size
    ) stock;
    RETURN result;
  ELSE
    WITH filtered AS (
      SELECT audit.*, organization.name AS organization_name
      FROM public.petro_audit_events audit
      LEFT JOIN public.petro_organizations organization ON organization.id=audit.organization_id
      WHERE (audit.action ILIKE '%credential%' OR audit.action ILIKE '%tag_stock%')
        AND (selected_organization IS NULL OR audit.organization_id=selected_organization)
        AND (selected_vehicle IS NULL
          OR audit.detail->>'vehicleId'=selected_vehicle::text
          OR audit.target_id IN (
            SELECT request.id FROM public.petro_fleet_credential_requests request
            WHERE request.vehicle_id=selected_vehicle
          )
          OR audit.target_id IN (
            SELECT credential.id FROM public.petro_vehicle_credentials credential
            WHERE credential.vehicle_id=selected_vehicle
          )
          OR audit.target_id IN (
            SELECT stock.id FROM public.petro_fleet_tag_stock_units stock
            JOIN public.petro_fleet_credential_requests request ON request.id=stock.request_id
            WHERE request.vehicle_id=selected_vehicle
          ))
        AND (search_text IS NULL OR audit.action ILIKE '%'||search_text||'%'
          OR organization.name ILIKE '%'||search_text||'%'
          OR coalesce(audit.detail->>'reason','') ILIKE '%'||search_text||'%')
    )
    SELECT jsonb_build_object(
      'view',p_view,
      'items',coalesce(jsonb_agg(jsonb_build_object(
        'id',audit.id,'organizationId',audit.organization_id,
        'organizationName',audit.organization_name,'action',audit.action,
        'reason',audit.detail->>'reason','createdAt',audit.occurred_at)
        ORDER BY audit.occurred_at DESC,audit.id),'[]'::jsonb),
      'total',(SELECT count(*) FROM filtered),'page',page_no,'pageSize',page_size
    )
    INTO result
    FROM (
      SELECT * FROM filtered ORDER BY occurred_at DESC,id
      LIMIT page_size OFFSET (page_no-1)*page_size
    ) audit;
    RETURN result;
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.petro_admin_fleet_command(text,jsonb,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.petro_admin_fleet_command(text,jsonb,text,text)
  TO authenticated;

REVOKE ALL ON FUNCTION public.petro_admin_fleet_pair_pin_reveal(uuid,text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.petro_admin_fleet_pair_pin_reveal(uuid,text)
  TO authenticated;

REVOKE ALL ON FUNCTION public.petro_admin_fleet_cards_catalog(text,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.petro_admin_fleet_cards_catalog(text,jsonb)
  TO authenticated;

COMMENT ON FUNCTION public.petro_admin_fleet_pair_pin_reveal(uuid,text) IS
  'Reveals an active driver-vehicle PIN only after central fleet authorization and records a reasoned audit event. Legacy HMAC-only pairs require rotation.';

COMMIT;
