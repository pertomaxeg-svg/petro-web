BEGIN;

-- Fleet acceptance follow-up:
-- 1) Preserve historical branch snapshots when a vehicle moves.
-- 2) Block a move while money is actively reserved for that vehicle.
-- 3) Add immutable, versioned expected fuel-consumption rates.
-- 4) Expose paginated company/branch summaries and the current NFC issue price.

ALTER TABLE public.petro_fleet_policy_versions
  DROP CONSTRAINT petro_fleet_policy_versions_vehicle_scope_fk,
  ADD CONSTRAINT petro_fleet_policy_versions_vehicle_scope_fk
    FOREIGN KEY (vehicle_id, organization_id)
    REFERENCES public.petro_fleet_vehicles(id, organization_id) ON DELETE RESTRICT;

ALTER TABLE public.petro_fleet_usage_reservations
  DROP CONSTRAINT petro_fleet_usage_reservation_vehicle_scope_fk,
  ADD CONSTRAINT petro_fleet_usage_reservation_vehicle_scope_fk
    FOREIGN KEY (vehicle_id, organization_id)
    REFERENCES public.petro_fleet_vehicles(id, organization_id) ON DELETE RESTRICT,
  ADD CONSTRAINT petro_fleet_usage_reservation_branch_scope_fk
    FOREIGN KEY (branch_id, organization_id)
    REFERENCES public.petro_branches(id, organization_id) ON DELETE RESTRICT;

DO $$
DECLARE constraint_name text;
BEGIN
  SELECT constraint_row.conname INTO constraint_name
  FROM pg_catalog.pg_constraint constraint_row
  WHERE constraint_row.conrelid = 'public.petro_vehicle_credentials'::regclass
    AND constraint_row.contype = 'f'
    AND pg_catalog.pg_get_constraintdef(constraint_row.oid)
      LIKE 'FOREIGN KEY (vehicle_id, organization_id, branch_id)%';
  IF constraint_name IS NULL THEN
    RAISE EXCEPTION 'Expected vehicle/organization/branch foreign key on credentials';
  END IF;
  EXECUTE format('ALTER TABLE public.petro_vehicle_credentials DROP CONSTRAINT %I', constraint_name);
END
$$;

ALTER TABLE public.petro_vehicle_credentials
  ADD CONSTRAINT petro_vehicle_credentials_vehicle_scope_fk
    FOREIGN KEY (vehicle_id, organization_id)
    REFERENCES public.petro_fleet_vehicles(id, organization_id) ON DELETE RESTRICT,
  ADD CONSTRAINT petro_vehicle_credentials_branch_scope_fk
    FOREIGN KEY (branch_id, organization_id)
    REFERENCES public.petro_branches(id, organization_id) ON DELETE RESTRICT;

DO $$
DECLARE constraint_name text;
BEGIN
  SELECT constraint_row.conname INTO constraint_name
  FROM pg_catalog.pg_constraint constraint_row
  WHERE constraint_row.conrelid = 'public.petro_fleet_credential_requests'::regclass
    AND constraint_row.contype = 'f'
    AND pg_catalog.pg_get_constraintdef(constraint_row.oid)
      LIKE 'FOREIGN KEY (vehicle_id, organization_id, branch_id)%';
  IF constraint_name IS NULL THEN
    RAISE EXCEPTION 'Expected vehicle/organization/branch foreign key on credential requests';
  END IF;
  EXECUTE format('ALTER TABLE public.petro_fleet_credential_requests DROP CONSTRAINT %I', constraint_name);
END
$$;

ALTER TABLE public.petro_fleet_credential_requests
  ADD CONSTRAINT petro_fleet_credential_requests_vehicle_scope_fk
    FOREIGN KEY (vehicle_id, organization_id)
    REFERENCES public.petro_fleet_vehicles(id, organization_id) ON DELETE RESTRICT,
  ADD CONSTRAINT petro_fleet_credential_requests_branch_scope_fk
    FOREIGN KEY (branch_id, organization_id)
    REFERENCES public.petro_branches(id, organization_id) ON DELETE RESTRICT;

DO $$
DECLARE constraint_name text;
BEGIN
  SELECT constraint_row.conname INTO constraint_name
  FROM pg_catalog.pg_constraint constraint_row
  WHERE constraint_row.conrelid = 'public.petro_vehicle_odometer_events'::regclass
    AND constraint_row.contype = 'f'
    AND pg_catalog.pg_get_constraintdef(constraint_row.oid)
      LIKE 'FOREIGN KEY (vehicle_id, organization_id, branch_id)%';
  IF constraint_name IS NULL THEN
    RAISE EXCEPTION 'Expected vehicle/organization/branch foreign key on odometer events';
  END IF;
  EXECUTE format('ALTER TABLE public.petro_vehicle_odometer_events DROP CONSTRAINT %I', constraint_name);
END
$$;

ALTER TABLE public.petro_vehicle_odometer_events
  ADD CONSTRAINT petro_vehicle_odometer_events_vehicle_scope_fk
    FOREIGN KEY (vehicle_id, organization_id)
    REFERENCES public.petro_fleet_vehicles(id, organization_id) ON DELETE RESTRICT,
  ADD CONSTRAINT petro_vehicle_odometer_events_branch_scope_fk
    FOREIGN KEY (branch_id, organization_id)
    REFERENCES public.petro_branches(id, organization_id) ON DELETE RESTRICT;

DO $$
DECLARE constraint_name text;
BEGIN
  SELECT constraint_row.conname INTO constraint_name
  FROM pg_catalog.pg_constraint constraint_row
  WHERE constraint_row.conrelid = 'public.petro_vehicle_maintenance_records'::regclass
    AND constraint_row.contype = 'f'
    AND pg_catalog.pg_get_constraintdef(constraint_row.oid)
      LIKE 'FOREIGN KEY (vehicle_id, organization_id, branch_id)%';
  IF constraint_name IS NULL THEN
    RAISE EXCEPTION 'Expected vehicle/organization/branch foreign key on maintenance records';
  END IF;
  EXECUTE format('ALTER TABLE public.petro_vehicle_maintenance_records DROP CONSTRAINT %I', constraint_name);
END
$$;

ALTER TABLE public.petro_vehicle_maintenance_records
  ADD CONSTRAINT petro_vehicle_maintenance_records_vehicle_scope_fk
    FOREIGN KEY (vehicle_id, organization_id)
    REFERENCES public.petro_fleet_vehicles(id, organization_id) ON DELETE RESTRICT,
  ADD CONSTRAINT petro_vehicle_maintenance_records_branch_scope_fk
    FOREIGN KEY (branch_id, organization_id)
    REFERENCES public.petro_branches(id, organization_id) ON DELETE RESTRICT;

ALTER TABLE public.petro_documents
  DROP CONSTRAINT petro_documents_vehicle_scope_fk,
  ADD CONSTRAINT petro_documents_vehicle_scope_fk
    FOREIGN KEY (vehicle_id, organization_id)
    REFERENCES public.petro_fleet_vehicles(id, organization_id) ON DELETE RESTRICT;

CREATE FUNCTION petro_private.prevent_fleet_move_with_reserved_usage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.branch_id IS DISTINCT FROM OLD.branch_id
     AND EXISTS (
       SELECT 1
       FROM public.petro_fleet_usage_reservations reservation
       WHERE reservation.vehicle_id = OLD.id
         AND reservation.organization_id = OLD.organization_id
         AND reservation.status = 'reserved'
     ) THEN
    RAISE EXCEPTION 'FLEET_MOVE_HAS_OPEN_RESERVATIONS' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION petro_private.prevent_fleet_move_with_reserved_usage()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER petro_fleet_vehicle_move_reserved_guard
  BEFORE UPDATE OF branch_id ON public.petro_fleet_vehicles
  FOR EACH ROW EXECUTE FUNCTION petro_private.prevent_fleet_move_with_reserved_usage();

-- Keep production policy evaluation bound to now(), while giving isolated
-- PostgreSQL tests a deterministic clock for Cairo day/week/month boundaries.
DO $$
DECLARE
  source_definition text;
  helper_definition text;
BEGIN
  source_definition := pg_catalog.pg_get_functiondef(
    'petro_private.fleet_check_usage_policy(uuid,uuid,uuid,uuid,text,bigint,numeric)'::regprocedure
  );
  helper_definition := pg_catalog.regexp_replace(
    source_definition,
    'FUNCTION petro_private\.fleet_check_usage_policy\(',
    'FUNCTION petro_private.fleet_check_usage_policy_at(',
    'i'
  );
  helper_definition := pg_catalog.regexp_replace(
    helper_definition,
    'p_quantity numeric\)',
    'p_quantity numeric, p_as_of timestamptz)',
    'i'
  );
  helper_definition := pg_catalog.replace(helper_definition, 'now()', 'p_as_of');
  IF helper_definition = source_definition
     OR pg_catalog.strpos(helper_definition, 'p_as_of timestamptz') = 0
     OR pg_catalog.strpos(helper_definition, 'now()') > 0 THEN
    RAISE EXCEPTION 'Could not derive the deterministic fleet policy evaluator';
  END IF;
  EXECUTE helper_definition;
END
$$;

CREATE OR REPLACE FUNCTION petro_private.fleet_check_usage_policy(
  p_vehicle_id uuid, p_driver_link_id uuid, p_merchant_organization_id uuid,
  p_merchant_branch_id uuid, p_service_group text, p_amount_minor bigint,
  p_quantity numeric
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT petro_private.fleet_check_usage_policy_at(
    p_vehicle_id, p_driver_link_id, p_merchant_organization_id,
    p_merchant_branch_id, p_service_group, p_amount_minor, p_quantity, now()
  )
$$;

REVOKE ALL ON FUNCTION petro_private.fleet_check_usage_policy_at(
  uuid, uuid, uuid, uuid, text, bigint, numeric, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;

-- Persist the supplied link start time; retain the original command's
-- authorization, idempotency, audit, and PIN handling unchanged.
DO $$
DECLARE
  source_definition text;
  patched_definition text;
  replacement_statement text;
BEGIN
  source_definition := pg_catalog.pg_get_functiondef(
    'public.petro_admin_fleet_command(text,jsonb,text,text)'::regprocedure
  );
  replacement_statement := pg_catalog.format(
    'INSERT INTO public.petro_fleet_driver_links(organization_id,vehicle_id,driver_id,starts_at,reason,created_by)
       VALUES(org_id,vehicle_id,driver_id,coalesce(nullif(p_payload->>%s,%s)::timestamptz,now()),p_reason,actor) RETURNING id INTO link_id;',
    pg_catalog.quote_literal('startsAt'),
    pg_catalog.quote_literal('')
  );
  patched_definition := pg_catalog.regexp_replace(
    source_definition,
    'INSERT INTO public\.petro_fleet_driver_links\s*\(\s*organization_id\s*,\s*vehicle_id\s*,\s*driver_id\s*,\s*reason\s*,\s*created_by\s*\)\s*VALUES\s*\(\s*org_id\s*,\s*vehicle_id\s*,\s*driver_id\s*,\s*p_reason\s*,\s*actor\s*\)\s*RETURNING\s+id\s+INTO\s+link_id\s*;',
    replacement_statement,
    'i'
  );
  IF patched_definition = source_definition
     OR pg_catalog.strpos(patched_definition, 'starts_at,reason,created_by') = 0 THEN
    RAISE EXCEPTION 'Could not preserve the approved driver-link insertion while adding its start date';
  END IF;
  EXECUTE patched_definition;
END
$$;

CREATE TABLE public.petro_fleet_consumption_rate_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  branch_id uuid,
  version_no integer NOT NULL CHECK (version_no > 0),
  liters_per_100km numeric(9,3) NOT NULL CHECK (liters_per_100km > 0),
  effective_from timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT petro_fleet_consumption_rate_branch_scope_fk
    FOREIGN KEY (branch_id, organization_id)
    REFERENCES public.petro_branches(id, organization_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX petro_fleet_consumption_company_version_unique
  ON public.petro_fleet_consumption_rate_versions (organization_id, version_no)
  WHERE branch_id IS NULL;
CREATE UNIQUE INDEX petro_fleet_consumption_branch_version_unique
  ON public.petro_fleet_consumption_rate_versions (branch_id, version_no)
  WHERE branch_id IS NOT NULL;
CREATE INDEX petro_fleet_consumption_rate_history_idx
  ON public.petro_fleet_consumption_rate_versions
    (organization_id, branch_id, effective_from DESC, version_no DESC);

ALTER TABLE public.petro_fleet_consumption_rate_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.petro_fleet_consumption_rate_versions
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION petro_private.prevent_fleet_consumption_rate_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'FLEET_CONSUMPTION_RATE_HISTORY_IS_APPEND_ONLY' USING ERRCODE = '55000';
END
$$;

REVOKE ALL ON FUNCTION petro_private.prevent_fleet_consumption_rate_mutation()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER petro_fleet_consumption_rate_append_only
  BEFORE UPDATE OR DELETE ON public.petro_fleet_consumption_rate_versions
  FOR EACH ROW EXECUTE FUNCTION petro_private.prevent_fleet_consumption_rate_mutation();

CREATE FUNCTION public.petro_admin_fleet_company_summaries(
  p_organization_id uuid DEFAULT NULL,
  p_query text DEFAULT NULL,
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  page_no integer := least(100000, greatest(1, coalesce(p_page, 1)));
  page_size integer := least(100, greatest(1, coalesce(p_page_size, 20)));
  search_text text := nullif(btrim(p_query), '');
  company_result jsonb;
  branch_result jsonb;
  total_count bigint;
  issue_price bigint;
BEGIN
  IF NOT petro_private.fleet_can_read() THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT nfc_issue_price_minor INTO issue_price
    FROM public.petro_billing_settings WHERE singleton_id = true;

  IF p_organization_id IS NOT NULL THEN
    SELECT jsonb_build_object(
      'id', organization.id,
      'name', organization.name,
      'code', organization.code,
      'branchCount', (SELECT count(*) FROM public.petro_branches branch
        WHERE branch.organization_id = organization.id),
      'vehicleCount', (SELECT count(*) FROM public.petro_fleet_vehicles vehicle
        WHERE vehicle.organization_id = organization.id),
      'activeVehicleCount', (SELECT count(*) FROM public.petro_fleet_vehicles vehicle
        WHERE vehicle.organization_id = organization.id AND vehicle.status = 'active'),
      'activeDriverCount', (SELECT count(*) FROM public.petro_fleet_drivers driver
        WHERE driver.organization_id = organization.id AND driver.status = 'active'),
      'coveredVehicleCount', (SELECT count(DISTINCT assignment.vehicle_id)
        FROM public.petro_subscription_vehicle_assignments assignment
        JOIN public.petro_subscriptions subscription ON subscription.id = assignment.subscription_id
        WHERE assignment.organization_id = organization.id AND assignment.status = 'active'
          AND assignment.starts_at <= now() AND (assignment.ends_at IS NULL OR assignment.ends_at > now())
          AND subscription.status IN ('active','scheduled')
          AND subscription.starts_at <= now() AND subscription.ends_at > now()
          AND (subscription.cancellation_effective_at IS NULL
            OR subscription.cancellation_effective_at > now()))
    ) INTO company_result
    FROM public.petro_organizations organization
    WHERE organization.id = p_organization_id AND organization.kind = 'company';

    IF company_result IS NULL THEN
      RAISE EXCEPTION 'COMPANY_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;

    SELECT count(*) INTO total_count
      FROM public.petro_branches branch
      WHERE branch.organization_id = p_organization_id;

    SELECT coalesce(jsonb_agg(
      jsonb_build_object(
        'id', branch.id,
        'name', branch.name,
        'vehicleCount', (SELECT count(*) FROM public.petro_fleet_vehicles vehicle
          WHERE vehicle.branch_id = branch.id AND vehicle.organization_id = p_organization_id),
        'activeVehicleCount', (SELECT count(*) FROM public.petro_fleet_vehicles vehicle
          WHERE vehicle.branch_id = branch.id AND vehicle.organization_id = p_organization_id
            AND vehicle.status = 'active'),
        'vehicleCountsByStatus', coalesce((
          SELECT jsonb_object_agg(status_counts.status, status_counts.count)
          FROM (
            SELECT vehicle.status, count(*) AS count
            FROM public.petro_fleet_vehicles vehicle
            WHERE vehicle.branch_id = branch.id
              AND vehicle.organization_id = p_organization_id
            GROUP BY vehicle.status
          ) status_counts
        ), '{}'::jsonb)
      ) ORDER BY branch.name, branch.id
    ), '[]'::jsonb) INTO branch_result
    FROM (
      SELECT branch.id, branch.name
      FROM public.petro_branches branch
      WHERE branch.organization_id = p_organization_id
      ORDER BY branch.name, branch.id
      LIMIT page_size OFFSET (page_no - 1) * page_size
    ) branch;

    RETURN jsonb_build_object(
      'company', company_result,
      'branches', branch_result,
      'branchTotal', total_count,
      'page', page_no,
      'pageSize', page_size,
      'nfcIssuePriceMinor', issue_price
    );
  END IF;

  SELECT count(*) INTO total_count
    FROM public.petro_organizations organization
    WHERE organization.kind = 'company'
      AND (search_text IS NULL OR organization.name ILIKE '%' || search_text || '%'
        OR organization.code ILIKE '%' || search_text || '%');

  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'id', company.id,
      'name', company.name,
      'code', company.code,
      'branchCount', (SELECT count(*) FROM public.petro_branches branch
        WHERE branch.organization_id = company.id),
      'vehicleCount', (SELECT count(*) FROM public.petro_fleet_vehicles vehicle
        WHERE vehicle.organization_id = company.id),
      'activeVehicleCount', (SELECT count(*) FROM public.petro_fleet_vehicles vehicle
        WHERE vehicle.organization_id = company.id AND vehicle.status = 'active'),
      'activeDriverCount', (SELECT count(*) FROM public.petro_fleet_drivers driver
        WHERE driver.organization_id = company.id AND driver.status = 'active'),
      'coveredVehicleCount', (SELECT count(DISTINCT assignment.vehicle_id)
        FROM public.petro_subscription_vehicle_assignments assignment
        JOIN public.petro_subscriptions subscription ON subscription.id = assignment.subscription_id
        WHERE assignment.organization_id = company.id AND assignment.status = 'active'
          AND assignment.starts_at <= now() AND (assignment.ends_at IS NULL OR assignment.ends_at > now())
          AND subscription.status IN ('active','scheduled')
          AND subscription.starts_at <= now() AND subscription.ends_at > now()
          AND (subscription.cancellation_effective_at IS NULL
            OR subscription.cancellation_effective_at > now()))
    ) ORDER BY company.name, company.id
  ), '[]'::jsonb) INTO company_result
  FROM (
    SELECT organization.id, organization.name, organization.code
    FROM public.petro_organizations organization
    WHERE organization.kind = 'company'
      AND (search_text IS NULL OR organization.name ILIKE '%' || search_text || '%'
        OR organization.code ILIKE '%' || search_text || '%')
    ORDER BY organization.name, organization.id
    LIMIT page_size OFFSET (page_no - 1) * page_size
  ) company;

  RETURN jsonb_build_object(
    'items', company_result,
    'total', total_count,
    'page', page_no,
    'pageSize', page_size,
    'nfcIssuePriceMinor', issue_price
  );
END
$$;

CREATE FUNCTION public.petro_admin_fleet_driver_detail(p_driver_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  result jsonb;
BEGIN
  IF NOT petro_private.fleet_can_read() THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'id', driver.id,
    'organizationId', driver.organization_id,
    'organizationName', organization.name,
    'organizationCode', organization.code,
    'driverCode', driver.driver_code,
    'fullName', driver.full_name,
    'phone', driver.phone,
    'status', driver.status,
    'version', driver.version,
    'createdAt', driver.created_at,
    'updatedAt', driver.updated_at,
    'links', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', link.id,
        'vehicleId', link.vehicle_id,
        'vehiclePlate', vehicle.plate_standard,
        'branchId', vehicle.branch_id,
        'branchName', branch.name,
        'status', link.status,
        'startsAt', link.starts_at,
        'endsAt', link.ends_at,
        'reason', link.reason
      ) ORDER BY link.starts_at DESC, link.id)
      FROM public.petro_fleet_driver_links link
      JOIN public.petro_fleet_vehicles vehicle
        ON vehicle.id = link.vehicle_id AND vehicle.organization_id = link.organization_id
      JOIN public.petro_branches branch
        ON branch.id = vehicle.branch_id AND branch.organization_id = vehicle.organization_id
      WHERE link.driver_id = driver.id AND link.organization_id = driver.organization_id
    ), '[]'::jsonb)
  ) INTO result
  FROM public.petro_fleet_drivers driver
  JOIN public.petro_organizations organization
    ON organization.id = driver.organization_id AND organization.kind = 'company'
  WHERE driver.id = p_driver_id;

  IF result IS NULL THEN
    RAISE EXCEPTION 'DRIVER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  RETURN result;
END
$$;

CREATE FUNCTION public.petro_admin_fleet_consumption_rates(
  p_organization_id uuid,
  p_branch_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  current_rate jsonb;
  history_result jsonb;
BEGIN
  IF NOT petro_private.fleet_can_read() THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.petro_organizations organization
    WHERE organization.id = p_organization_id AND organization.kind = 'company'
  ) THEN
    RAISE EXCEPTION 'COMPANY_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF p_branch_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.petro_branches branch
    WHERE branch.id = p_branch_id AND branch.organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'BRANCH_SCOPE_MISMATCH' USING ERRCODE = '23514';
  END IF;

  IF p_branch_id IS NOT NULL THEN
    SELECT jsonb_build_object(
      'version', rate.version_no,
      'litersPer100Km', rate.liters_per_100km,
      'effectiveFrom', rate.effective_from,
      'scope', 'branch',
      'reason', rate.reason,
      'createdAt', rate.created_at
    ) INTO current_rate
    FROM public.petro_fleet_consumption_rate_versions rate
    WHERE rate.organization_id = p_organization_id
      AND rate.branch_id = p_branch_id AND rate.effective_from <= now()
    ORDER BY rate.effective_from DESC, rate.version_no DESC
    LIMIT 1;
  END IF;

  IF current_rate IS NULL THEN
    SELECT jsonb_build_object(
      'version', rate.version_no,
      'litersPer100Km', rate.liters_per_100km,
      'effectiveFrom', rate.effective_from,
      'scope', 'company',
      'reason', rate.reason,
      'createdAt', rate.created_at
    ) INTO current_rate
    FROM public.petro_fleet_consumption_rate_versions rate
    WHERE rate.organization_id = p_organization_id
      AND rate.branch_id IS NULL AND rate.effective_from <= now()
    ORDER BY rate.effective_from DESC, rate.version_no DESC
    LIMIT 1;
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'version', rate.version_no,
    'litersPer100Km', rate.liters_per_100km,
    'effectiveFrom', rate.effective_from,
    'scope', CASE WHEN rate.branch_id IS NULL THEN 'company' ELSE 'branch' END,
    'reason', rate.reason,
    'createdAt', rate.created_at
  ) ORDER BY rate.created_at DESC, rate.version_no DESC), '[]'::jsonb)
    INTO history_result
    FROM public.petro_fleet_consumption_rate_versions rate
    WHERE rate.organization_id = p_organization_id
      AND (p_branch_id IS NULL OR rate.branch_id IS NULL OR rate.branch_id = p_branch_id);

  RETURN jsonb_build_object(
    'current', current_rate,
    'history', history_result,
    'organizationId', p_organization_id,
    'branchId', p_branch_id
  );
END
$$;

CREATE FUNCTION public.petro_admin_fleet_stock_reservations(
  p_search text DEFAULT NULL,
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  search_value text := nullif(btrim(p_search), '');
  items jsonb;
  total_count bigint;
BEGIN
  IF NOT petro_private.fleet_can_manage()
     OR coalesce(p_page, 0) NOT BETWEEN 1 AND 100000
     OR coalesce(p_page_size, 0) NOT BETWEEN 1 AND 100
     OR length(coalesce(search_value, '')) > 160 THEN
    RAISE EXCEPTION 'FORBIDDEN_OR_INVALID_FILTER' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO total_count
  FROM public.petro_fleet_tag_stock_units stock
  JOIN public.petro_fleet_credential_requests request
    ON request.id = stock.request_id
  JOIN public.petro_fleet_vehicles vehicle
    ON vehicle.id = request.vehicle_id AND vehicle.organization_id = request.organization_id
  JOIN public.petro_organizations organization
    ON organization.id = request.organization_id
  JOIN public.petro_branches branch
    ON branch.id = request.branch_id AND branch.organization_id = request.organization_id
  WHERE stock.status = 'reserved'
    AND (search_value IS NULL
      OR stock.unit_code ILIKE '%' || search_value || '%'
      OR vehicle.plate_standard ILIKE '%' || search_value || '%'
      OR organization.name ILIKE '%' || search_value || '%'
      OR branch.name ILIKE '%' || search_value || '%'
      OR request.id::text ILIKE '%' || search_value || '%');

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', rows.stock_unit_id,
    'stockUnitId', rows.stock_unit_id,
    'unitCode', rows.unit_code,
    'unitType', rows.unit_type,
    'requestId', rows.request_id,
    'requestStatus', rows.request_status,
    'credentialType', rows.credential_type,
    'vehicleId', rows.vehicle_id,
    'vehiclePlate', rows.vehicle_plate,
    'organizationId', rows.organization_id,
    'organizationName', rows.organization_name,
    'branchId', rows.branch_id,
    'branchName', rows.branch_name,
    'assignedTo', rows.assigned_to,
    'scheduledAt', rows.scheduled_at,
    'reservedAt', rows.reserved_at
  ) ORDER BY rows.reserved_at DESC, rows.stock_unit_id), '[]'::jsonb)
  INTO items
  FROM (
    SELECT stock.id AS stock_unit_id, stock.unit_code, stock.unit_type,
      request.id AS request_id, request.status AS request_status,
      request.credential_type, request.vehicle_id, vehicle.plate_standard AS vehicle_plate,
      request.organization_id, organization.name AS organization_name,
      request.branch_id, branch.name AS branch_name, request.assigned_to,
      request.scheduled_at, stock.created_at AS reserved_at
    FROM public.petro_fleet_tag_stock_units stock
    JOIN public.petro_fleet_credential_requests request
      ON request.id = stock.request_id
    JOIN public.petro_fleet_vehicles vehicle
      ON vehicle.id = request.vehicle_id AND vehicle.organization_id = request.organization_id
    JOIN public.petro_organizations organization
      ON organization.id = request.organization_id
    JOIN public.petro_branches branch
      ON branch.id = request.branch_id AND branch.organization_id = request.organization_id
    WHERE stock.status = 'reserved'
      AND (search_value IS NULL
        OR stock.unit_code ILIKE '%' || search_value || '%'
        OR vehicle.plate_standard ILIKE '%' || search_value || '%'
        OR organization.name ILIKE '%' || search_value || '%'
        OR branch.name ILIKE '%' || search_value || '%'
        OR request.id::text ILIKE '%' || search_value || '%')
    ORDER BY stock.created_at DESC, stock.id
    LIMIT p_page_size OFFSET (p_page - 1) * p_page_size
  ) rows;

  RETURN jsonb_build_object(
    'items', items,
    'page', p_page,
    'pageSize', p_page_size,
    'total', total_count,
    'totalPages', ceil(total_count::numeric / p_page_size)::integer
  );
END
$$;

CREATE FUNCTION public.petro_admin_fleet_set_consumption_rate(
  p_organization_id uuid,
  p_branch_id uuid,
  p_liters_per_100km numeric,
  p_reason text,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor uuid := auth.uid();
  idempotency_id bigint;
  previous_action text;
  previous_hash text;
  previous_response jsonb;
  request_payload jsonb;
  request_hash text;
  next_version integer;
  created_row public.petro_fleet_consumption_rate_versions%ROWTYPE;
  result jsonb;
BEGIN
  IF NOT petro_private.fleet_can_manage() THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL
     OR p_liters_per_100km IS NULL
     OR p_liters_per_100km <= 0
     OR p_liters_per_100km <> round(p_liters_per_100km, 3)
     OR char_length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 500
     OR char_length(coalesce(p_idempotency_key, '')) NOT BETWEEN 16 AND 120 THEN
    RAISE EXCEPTION 'INVALID_FLEET_CONSUMPTION_RATE' USING ERRCODE = '22023';
  END IF;

  request_payload := jsonb_build_object(
    'organizationId', p_organization_id,
    'branchId', p_branch_id,
    'litersPer100Km', p_liters_per_100km,
    'reason', btrim(p_reason)
  );
  request_hash := md5('fleet.consumption_rate.create:' || request_payload::text);
  INSERT INTO public.petro_fleet_idempotency(actor_id, idempotency_key, action, payload_hash)
    VALUES (actor, p_idempotency_key, 'fleet.consumption_rate.create', request_hash)
    ON CONFLICT (actor_id, idempotency_key) DO NOTHING
    RETURNING id INTO idempotency_id;

  IF idempotency_id IS NULL THEN
    SELECT entry.action, entry.payload_hash, entry.response
      INTO previous_action, previous_hash, previous_response
      FROM public.petro_fleet_idempotency entry
      WHERE entry.actor_id = actor AND entry.idempotency_key = p_idempotency_key
      FOR UPDATE;
    IF previous_action <> 'fleet.consumption_rate.create'
       OR previous_hash <> request_hash THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT' USING ERRCODE = '23505';
    END IF;
    IF previous_response IS NULL THEN
      RAISE EXCEPTION 'IDEMPOTENT_REQUEST_IN_PROGRESS' USING ERRCODE = '40001';
    END IF;
    RETURN previous_response || jsonb_build_object('replayed', true);
  END IF;

  PERFORM 1 FROM public.petro_organizations organization
    WHERE organization.id = p_organization_id AND organization.kind = 'company'
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'COMPANY_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF p_branch_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.petro_branches branch
    WHERE branch.id = p_branch_id AND branch.organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'BRANCH_SCOPE_MISMATCH' USING ERRCODE = '23514';
  END IF;

  SELECT coalesce(max(rate.version_no), 0) + 1 INTO next_version
    FROM public.petro_fleet_consumption_rate_versions rate
    WHERE rate.organization_id = p_organization_id
      AND rate.branch_id IS NOT DISTINCT FROM p_branch_id;

  INSERT INTO public.petro_fleet_consumption_rate_versions(
    organization_id, branch_id, version_no, liters_per_100km, effective_from,
    reason, created_by
  ) VALUES (
    p_organization_id, p_branch_id, next_version, p_liters_per_100km, now(),
    btrim(p_reason), actor
  ) RETURNING * INTO created_row;

  result := jsonb_build_object(
    'id', created_row.id,
    'version', created_row.version_no,
    'litersPer100Km', created_row.liters_per_100km,
    'effectiveFrom', created_row.effective_from,
    'scope', CASE WHEN created_row.branch_id IS NULL THEN 'company' ELSE 'branch' END,
    'reason', created_row.reason,
    'createdAt', created_row.created_at
  );
  UPDATE public.petro_fleet_idempotency
    SET response = result
    WHERE id = idempotency_id;
  RETURN result;
END
$$;

REVOKE ALL ON FUNCTION public.petro_admin_fleet_company_summaries(uuid, text, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.petro_admin_fleet_driver_detail(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.petro_admin_fleet_stock_reservations(text, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.petro_admin_fleet_consumption_rates(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.petro_admin_fleet_set_consumption_rate(uuid, uuid, numeric, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.petro_admin_fleet_company_summaries(uuid, text, integer, integer)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_admin_fleet_driver_detail(uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_admin_fleet_stock_reservations(text, integer, integer)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_admin_fleet_consumption_rates(uuid, uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_admin_fleet_set_consumption_rate(uuid, uuid, numeric, text, text)
  TO authenticated;

COMMIT;
