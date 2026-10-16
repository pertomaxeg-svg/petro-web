BEGIN;

-- 0014's coverage.assign branch compares the subscription ID to an unqualified
-- request_id name, which is also a column on petro_subscriptions. Route this
-- operation through a narrowly scoped RPC with explicit variable names rather
-- than replacing the entire fleet command dispatcher.
CREATE FUNCTION public.petro_admin_fleet_assign_coverage(
  p_payload jsonb,
  p_reason text,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor uuid := auth.uid();
  vehicle_id uuid;
  v_subscription_id uuid;
  subscription_organization_id uuid;
  subscription_branch_id uuid;
  vehicle_organization_id uuid;
  vehicle_branch_id uuid;
  subscription_billing_unit text;
  subscription_status text;
  subscription_starts_at timestamptz;
  subscription_ends_at timestamptz;
  subscription_cancellation_at timestamptz;
  subscription_units integer;
  requested_start timestamptz;
  payload_hash text;
  previous_action text;
  previous_hash text;
  previous_response jsonb;
  result jsonb;
  assignment_id uuid;
BEGIN
  IF actor IS NULL OR NOT petro_private.fleet_can_manage()
     OR jsonb_typeof(p_payload) <> 'object'
     OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 5 AND 500
     OR char_length(coalesce(p_idempotency_key,'')) NOT BETWEEN 16 AND 120 THEN
    RAISE EXCEPTION 'FORBIDDEN_OR_INVALID_COVERAGE_ASSIGNMENT' USING ERRCODE='42501';
  END IF;

  vehicle_id := nullif(p_payload->>'vehicleId','')::uuid;
  v_subscription_id := nullif(p_payload->>'subscriptionId','')::uuid;
  requested_start := nullif(p_payload->>'startsAt','')::timestamptz;
  IF vehicle_id IS NULL OR v_subscription_id IS NULL OR requested_start IS NULL THEN
    RAISE EXCEPTION 'INVALID_COVERAGE_ASSIGNMENT' USING ERRCODE='22023';
  END IF;
  payload_hash := md5('coverage.assign:' || p_payload::text || ':' || btrim(p_reason));
  PERFORM pg_advisory_xact_lock(hashtextextended(actor::text || ':' || p_idempotency_key,0));

  INSERT INTO public.petro_fleet_idempotency(actor_id,idempotency_key,action,payload_hash)
  VALUES(actor,p_idempotency_key,'coverage.assign',payload_hash)
  ON CONFLICT(actor_id,idempotency_key) DO NOTHING;
  IF NOT FOUND THEN
    SELECT record.action,record.payload_hash,record.response
      INTO previous_action,previous_hash,previous_response
    FROM public.petro_fleet_idempotency record
    WHERE record.actor_id=actor AND record.idempotency_key=p_idempotency_key
    FOR UPDATE;
    IF previous_action<>'coverage.assign' OR previous_hash<>payload_hash THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT' USING ERRCODE='23505';
    END IF;
    IF previous_response IS NULL THEN
      RAISE EXCEPTION 'COVERAGE_ASSIGNMENT_IN_PROGRESS' USING ERRCODE='40001';
    END IF;
    RETURN previous_response || jsonb_build_object('replayed',true);
  END IF;

  SELECT subscription.organization_id,subscription.branch_id,subscription.billing_unit,
         subscription.status,subscription.starts_at,subscription.ends_at,subscription.units,
         subscription.cancellation_effective_at
    INTO subscription_organization_id,subscription_branch_id,subscription_billing_unit,
         subscription_status,subscription_starts_at,subscription_ends_at,subscription_units,
         subscription_cancellation_at
  FROM public.petro_subscriptions AS subscription
  WHERE subscription.id=v_subscription_id
  FOR UPDATE;
  IF NOT FOUND OR subscription_billing_unit<>'vehicle'
     OR subscription_status NOT IN ('active','scheduled')
     OR subscription_ends_at<=now()
     OR (subscription_status='active' AND subscription_starts_at>now())
     OR (subscription_status='scheduled' AND subscription_starts_at<=now())
     OR (subscription_cancellation_at IS NOT NULL
         AND subscription_cancellation_at<=requested_start) THEN
    RAISE EXCEPTION 'VEHICLE_SUBSCRIPTION_NOT_ELIGIBLE' USING ERRCODE='23514';
  END IF;

  SELECT vehicle.organization_id,vehicle.branch_id
    INTO vehicle_organization_id,vehicle_branch_id
  FROM public.petro_fleet_vehicles AS vehicle
  JOIN public.petro_organizations AS organization
    ON organization.id=vehicle.organization_id AND organization.kind='company'
  WHERE vehicle.id=vehicle_id AND vehicle.status='active'
  FOR UPDATE OF vehicle;
  IF NOT FOUND OR vehicle_organization_id<>subscription_organization_id
     OR (subscription_branch_id IS NOT NULL AND subscription_branch_id<>vehicle_branch_id) THEN
    RAISE EXCEPTION 'VEHICLE_SUBSCRIPTION_SCOPE_MISMATCH' USING ERRCODE='23514';
  END IF;

  IF requested_start<now() OR requested_start<subscription_starts_at
     OR requested_start>=subscription_ends_at
     OR (SELECT count(*) FROM public.petro_subscription_vehicle_assignments AS assignment
         WHERE assignment.subscription_id=v_subscription_id
           AND assignment.status='active'
           AND assignment.starts_at<=requested_start
           AND (assignment.ends_at IS NULL OR assignment.ends_at>requested_start))
        >= subscription_units THEN
    RAISE EXCEPTION 'SUBSCRIPTION_COVERAGE_CAPACITY_OR_PERIOD_EXCEEDED' USING ERRCODE='23514';
  END IF;

  INSERT INTO public.petro_subscription_vehicle_assignments(
    subscription_id,organization_id,vehicle_id,starts_at,reason,created_by
  ) VALUES(v_subscription_id,subscription_organization_id,vehicle_id,requested_start,btrim(p_reason),actor)
  RETURNING id INTO assignment_id;
  result := jsonb_build_object(
    'id',assignment_id,'subscriptionId',v_subscription_id,
    'vehicleId',vehicle_id,'status','active','replayed',false
  );
  UPDATE public.petro_fleet_idempotency
  SET response=result
  WHERE actor_id=actor AND idempotency_key=p_idempotency_key;
  INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
  VALUES(actor,subscription_organization_id,'fleet.coverage.assigned',assignment_id,
    jsonb_build_object('subscriptionId',v_subscription_id,'vehicleId',vehicle_id,
      'branchId',vehicle_branch_id,'startsAt',requested_start,'reason',btrim(p_reason)));
  RETURN result;
END;
$$;

CREATE FUNCTION public.petro_admin_fleet_subscription_options(
  p_organization_id uuid DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 20
) RETURNS jsonb
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
  IF NOT petro_private.fleet_can_read()
     OR coalesce(p_page,0) NOT BETWEEN 1 AND 100000
     OR coalesce(p_page_size,0) NOT BETWEEN 1 AND 100
     OR length(coalesce(search_value, '')) > 160 THEN
    RAISE EXCEPTION 'FORBIDDEN_OR_INVALID_FILTER' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO total_count
  FROM public.petro_subscriptions subscription
  JOIN public.petro_organizations organization
    ON organization.id = subscription.organization_id
   AND organization.kind = 'company'
  JOIN public.petro_plans plan
    ON plan.id = subscription.plan_id
   AND plan.audience = 'company'
  LEFT JOIN public.petro_branches branch
    ON branch.id = subscription.branch_id
   AND branch.organization_id = subscription.organization_id
  WHERE subscription.billing_unit = 'vehicle'
    AND subscription.status IN ('active', 'scheduled')
    AND subscription.ends_at > now()
    AND (subscription.branch_id IS NULL OR branch.id IS NOT NULL)
    AND (p_organization_id IS NULL OR subscription.organization_id = p_organization_id)
    AND (search_value IS NULL
      OR organization.name ILIKE '%' || search_value || '%'
      OR branch.name ILIKE '%' || search_value || '%'
      OR plan.name ILIKE '%' || search_value || '%');

  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', rows.subscription_id,
      'subscriptionId', rows.subscription_id,
      'organizationId', rows.organization_id,
      'organizationName', rows.organization_name,
      'branchId', rows.branch_id,
      'branchName', rows.branch_name,
      'planId', rows.plan_id,
      'planName', rows.plan_name,
      'planVersionId', rows.plan_version_id,
      'billingUnit', rows.billing_unit,
      'units', rows.units,
      'coveredUnits', rows.covered_units,
      'status', rows.status,
      'startsAt', rows.starts_at,
      'endsAt', rows.ends_at,
      'snapshotPriceMinor', rows.price_snapshot_minor,
      'currency', 'EGP'
    ) ORDER BY rows.starts_at, rows.subscription_id), '[]'::jsonb)
  INTO items
  FROM (
    SELECT subscription.id AS subscription_id,
      subscription.organization_id, organization.name AS organization_name,
      subscription.branch_id, branch.name AS branch_name,
      subscription.plan_id, plan.name AS plan_name,
      subscription.plan_version_id, subscription.billing_unit,
      subscription.units, subscription.status, subscription.starts_at,
      subscription.ends_at, subscription.price_snapshot_minor,
      (SELECT count(*) FROM public.petro_subscription_vehicle_assignments assignment
       WHERE assignment.subscription_id = subscription.id
         AND assignment.status = 'active'
         AND assignment.starts_at < subscription.ends_at
         AND (assignment.ends_at IS NULL OR assignment.ends_at > subscription.starts_at)
      )::integer AS covered_units
    FROM public.petro_subscriptions subscription
    JOIN public.petro_organizations organization
      ON organization.id = subscription.organization_id
     AND organization.kind = 'company'
    JOIN public.petro_plans plan
      ON plan.id = subscription.plan_id
     AND plan.audience = 'company'
    LEFT JOIN public.petro_branches branch
      ON branch.id = subscription.branch_id
     AND branch.organization_id = subscription.organization_id
    WHERE subscription.billing_unit = 'vehicle'
      AND subscription.status IN ('active', 'scheduled')
      AND subscription.ends_at > now()
      AND (subscription.branch_id IS NULL OR branch.id IS NOT NULL)
      AND (p_organization_id IS NULL OR subscription.organization_id = p_organization_id)
      AND (search_value IS NULL
        OR organization.name ILIKE '%' || search_value || '%'
        OR branch.name ILIKE '%' || search_value || '%'
        OR plan.name ILIKE '%' || search_value || '%')
    ORDER BY subscription.starts_at, subscription.id
    LIMIT p_page_size OFFSET (p_page - 1) * p_page_size
  ) rows;

  RETURN jsonb_build_object(
    'items', items,
    'page', p_page,
    'pageSize', p_page_size,
    'total', total_count,
    'totalPages', ceil(total_count::numeric / p_page_size)::integer
  );
END;
$$;

CREATE FUNCTION public.petro_admin_fleet_stock_options(
  p_search text DEFAULT NULL,
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 20
) RETURNS jsonb
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
     OR coalesce(p_page,0) NOT BETWEEN 1 AND 100000
     OR coalesce(p_page_size,0) NOT BETWEEN 1 AND 100
     OR length(coalesce(search_value,'')) > 160 THEN
    RAISE EXCEPTION 'FORBIDDEN_OR_INVALID_FILTER' USING ERRCODE='42501';
  END IF;

  SELECT count(*) INTO total_count
  FROM public.petro_fleet_tag_stock_units stock
  WHERE stock.status='available'
    AND (search_value IS NULL OR stock.unit_code ILIKE '%' || search_value || '%');

  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', rows.id,
      'unitCode', rows.unit_code,
      'unitType', rows.unit_type,
      'status', rows.status,
      'createdAt', rows.created_at
    ) ORDER BY rows.created_at, rows.id), '[]'::jsonb)
  INTO items
  FROM (
    SELECT stock.id,stock.unit_code,stock.unit_type,stock.status,stock.created_at
    FROM public.petro_fleet_tag_stock_units stock
    WHERE stock.status='available'
      AND (search_value IS NULL OR stock.unit_code ILIKE '%' || search_value || '%')
    ORDER BY stock.created_at,stock.id
    LIMIT p_page_size OFFSET (p_page-1)*p_page_size
  ) rows;

  RETURN jsonb_build_object('items',items,'page',p_page,'pageSize',p_page_size,
    'total',total_count,'totalPages',ceil(total_count::numeric/p_page_size)::integer);
END;
$$;

REVOKE ALL ON FUNCTION public.petro_admin_fleet_subscription_options(uuid, text, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.petro_admin_fleet_subscription_options(uuid, text, integer, integer)
  TO authenticated;
REVOKE ALL ON FUNCTION public.petro_admin_fleet_stock_options(text, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.petro_admin_fleet_stock_options(text, integer, integer)
  TO authenticated;
REVOKE ALL ON FUNCTION public.petro_admin_fleet_assign_coverage(jsonb, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.petro_admin_fleet_assign_coverage(jsonb, text, text)
  TO authenticated;
COMMENT ON FUNCTION public.petro_admin_fleet_subscription_options(uuid, text, integer, integer)
  IS 'Read-only, paginated company vehicle subscription choices for fleet coverage assignment; final eligibility and capacity are revalidated by the command.';
COMMENT ON FUNCTION public.petro_admin_fleet_stock_options(text, integer, integer)
  IS 'Read-only, paginated available NFC stock-unit choices for authorized fleet administrators.';
COMMENT ON FUNCTION public.petro_admin_fleet_assign_coverage(jsonb, text, text)
  IS 'Scoped, idempotent coverage assignment. Revalidates subscription dates, unit capacity, company/branch ownership, and vehicle status.';

COMMIT;
