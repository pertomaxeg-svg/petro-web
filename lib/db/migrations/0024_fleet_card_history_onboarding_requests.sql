BEGIN;

-- A vehicle created with an optional NFC/QR request is recorded as one
-- vehicle_create audit action. Project that persisted request into the card
-- activity view unless its own credential-request audit event already exists.
-- Rollback: revert the API route to petro_admin_fleet_cards_catalog for
-- history and DROP FUNCTION public.petro_admin_fleet_card_history(jsonb).
CREATE FUNCTION public.petro_admin_fleet_card_history(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
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

  WITH activity AS (
    SELECT
      audit.id::text AS id,
      audit.organization_id,
      organization.name AS organization_name,
      audit.action,
      audit.detail->>'reason' AS reason,
      audit.occurred_at AS created_at,
      NULL::uuid AS vehicle_id,
      NULL::text AS plate
    FROM public.petro_audit_events audit
    LEFT JOIN public.petro_organizations organization
      ON organization.id = audit.organization_id
    WHERE selected_status IS NULL
      AND (audit.action ILIKE '%credential%' OR audit.action ILIKE '%tag_stock%')
      AND (selected_organization IS NULL OR audit.organization_id = selected_organization)
      AND (
        selected_vehicle IS NULL
        OR audit.detail->>'vehicleId' = selected_vehicle::text
        OR audit.target_id IN (
          SELECT request.id
          FROM public.petro_fleet_credential_requests request
          WHERE request.vehicle_id = selected_vehicle
        )
        OR audit.target_id IN (
          SELECT credential.id
          FROM public.petro_vehicle_credentials credential
          WHERE credential.vehicle_id = selected_vehicle
        )
        OR audit.target_id IN (
          SELECT stock.id
          FROM public.petro_fleet_tag_stock_units stock
          JOIN public.petro_fleet_credential_requests request
            ON request.id = stock.request_id
          WHERE request.vehicle_id = selected_vehicle
        )
      )
      AND (
        search_text IS NULL
        OR audit.action ILIKE '%'||search_text||'%'
        OR organization.name ILIKE '%'||search_text||'%'
        OR coalesce(audit.detail->>'reason','') ILIKE '%'||search_text||'%'
        OR EXISTS (
          SELECT 1
          FROM public.petro_fleet_credential_requests request
          JOIN public.petro_fleet_vehicles vehicle ON vehicle.id = request.vehicle_id
          WHERE request.id = audit.target_id
            AND vehicle.plate_standard ILIKE '%'||search_text||'%'
        )
        OR EXISTS (
          SELECT 1
          FROM public.petro_vehicle_credentials credential
          JOIN public.petro_fleet_vehicles vehicle ON vehicle.id = credential.vehicle_id
          WHERE credential.id = audit.target_id
            AND vehicle.plate_standard ILIKE '%'||search_text||'%'
        )
        OR EXISTS (
          SELECT 1
          FROM public.petro_fleet_tag_stock_units stock
          JOIN public.petro_fleet_credential_requests request ON request.id = stock.request_id
          JOIN public.petro_fleet_vehicles vehicle ON vehicle.id = request.vehicle_id
          WHERE stock.id = audit.target_id
            AND vehicle.plate_standard ILIKE '%'||search_text||'%'
        )
      )

    UNION ALL

    SELECT
      request.id::text AS id,
      request.organization_id,
      organization.name AS organization_name,
      'fleet.credential_request'::text AS action,
      request.reason,
      request.created_at,
      request.vehicle_id,
      vehicle.plate_standard AS plate
    FROM public.petro_fleet_credential_requests request
    JOIN public.petro_organizations organization ON organization.id = request.organization_id
    JOIN public.petro_fleet_vehicles vehicle ON vehicle.id = request.vehicle_id
    WHERE (selected_organization IS NULL OR request.organization_id = selected_organization)
      AND (selected_vehicle IS NULL OR request.vehicle_id = selected_vehicle)
      AND (selected_status IS NULL OR request.status = selected_status)
      AND (
        search_text IS NULL
        OR vehicle.plate_standard ILIKE '%'||search_text||'%'
        OR organization.name ILIKE '%'||search_text||'%'
        OR request.reason ILIKE '%'||search_text||'%'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.petro_audit_events audit
        WHERE audit.organization_id = request.organization_id
          AND audit.target_id = request.id
          AND audit.action ILIKE '%credential%'
      )
  )
  SELECT jsonb_build_object(
    'view', 'history',
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'id', activity.id,
      'organizationId', activity.organization_id,
      'organizationName', activity.organization_name,
      'action', activity.action,
      'reason', activity.reason,
      'createdAt', activity.created_at,
      'vehicleId', activity.vehicle_id,
      'plate', activity.plate
    ) ORDER BY activity.created_at DESC, activity.id DESC), '[]'::jsonb),
    'total', (SELECT count(*) FROM activity),
    'page', page_no,
    'pageSize', page_size
  )
  INTO result
  FROM (
    SELECT *
    FROM activity
    ORDER BY created_at DESC, id DESC
    LIMIT page_size OFFSET (page_no-1)*page_size
  ) activity;

  RETURN result;
END
$$;

REVOKE ALL ON FUNCTION public.petro_admin_fleet_card_history(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.petro_admin_fleet_card_history(jsonb)
  TO authenticated;
COMMENT ON FUNCTION public.petro_admin_fleet_card_history(jsonb) IS
  'Returns scoped card audit activity and persisted onboarding credential requests for authorized fleet administrators.';

COMMIT;
