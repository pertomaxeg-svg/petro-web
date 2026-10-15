BEGIN;

ALTER TABLE public.petro_plans
  DROP CONSTRAINT petro_plans_audience_check;
ALTER TABLE public.petro_plans
  ADD CONSTRAINT petro_plans_audience_check
    CHECK (audience = ANY (ARRAY['company'::text, 'provider'::text, 'station'::text]));
ALTER TABLE public.petro_plans
  ADD COLUMN stop_new_at timestamptz;

ALTER TABLE public.petro_plan_versions
  ADD COLUMN publication_status text NOT NULL DEFAULT 'published',
  ADD COLUMN billing_cycle text NOT NULL DEFAULT 'annual',
  ADD COLUMN currency text NOT NULL DEFAULT 'EGP',
  ADD COLUMN entitlements jsonb,
  ADD COLUMN settings jsonb;
ALTER TABLE public.petro_plan_versions
  ADD CONSTRAINT petro_plan_versions_publication_status_check
    CHECK (publication_status = ANY (ARRAY['draft'::text, 'scheduled'::text, 'published'::text, 'retired'::text])),
  ADD CONSTRAINT petro_plan_versions_billing_cycle_check CHECK (billing_cycle = 'annual'),
  ADD CONSTRAINT petro_plan_versions_currency_check CHECK (currency = 'EGP'),
  ADD CONSTRAINT petro_plan_versions_entitlements_check
    CHECK (entitlements IS NULL OR jsonb_typeof(entitlements) = 'array'),
  ADD CONSTRAINT petro_plan_versions_settings_check
    CHECK (settings IS NULL OR jsonb_typeof(settings) = 'array');

CREATE TABLE public.petro_plan_price_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  branch_id uuid REFERENCES public.petro_branches(id) ON DELETE RESTRICT,
  plan_id uuid NOT NULL REFERENCES public.petro_plans(id) ON DELETE RESTRICT,
  price_minor bigint NOT NULL CHECK (price_minor > 0 AND price_minor <= 1000000000),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 5 AND 500),
  approved_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE TABLE public.petro_subscription_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  branch_id uuid REFERENCES public.petro_branches(id) ON DELETE RESTRICT,
  current_subscription_id uuid,
  request_type text NOT NULL CHECK (request_type = ANY (ARRAY['new'::text, 'renewal'::text, 'plan_change'::text, 'custom_price'::text])),
  plan_id uuid NOT NULL REFERENCES public.petro_plans(id) ON DELETE RESTRICT,
  plan_version_id uuid NOT NULL REFERENCES public.petro_plan_versions(id) ON DELETE RESTRICT,
  requested_price_minor bigint CHECK (requested_price_minor IS NULL OR requested_price_minor BETWEEN 0 AND 1000000000),
  requested_units integer CHECK (requested_units IS NULL OR requested_units > 0),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  coverage_state text NOT NULL CHECK (coverage_state = ANY (ARRAY['verified'::text, 'fleet_registry_missing'::text, 'branch_unverified'::text])),
  coverage_note text NOT NULL DEFAULT '' CHECK (length(coverage_note) <= 1000),
  request_status text NOT NULL DEFAULT 'draft' CHECK (request_status = ANY (ARRAY['draft'::text, 'submitted'::text, 'needs_changes'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text])),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 5 AND 500),
  submitted_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  decision_reason text CHECK (decision_reason IS NULL OR length(btrim(decision_reason)) BETWEEN 5 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (
    (request_type = 'custom_price' AND requested_price_minor IS NOT NULL)
    OR (request_type <> 'custom_price' AND requested_price_minor IS NULL)
  ),
  CHECK (
    (request_type IN ('renewal', 'plan_change') AND current_subscription_id IS NOT NULL)
    OR (request_type IN ('new', 'custom_price') AND current_subscription_id IS NULL)
  )
);

CREATE TABLE public.petro_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE REFERENCES public.petro_subscription_requests(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  branch_id uuid REFERENCES public.petro_branches(id) ON DELETE RESTRICT,
  plan_id uuid NOT NULL REFERENCES public.petro_plans(id) ON DELETE RESTRICT,
  plan_version_id uuid NOT NULL REFERENCES public.petro_plan_versions(id) ON DELETE RESTRICT,
  plan_snapshot jsonb NOT NULL CHECK (jsonb_typeof(plan_snapshot) = 'object'),
  price_snapshot_minor bigint NOT NULL CHECK (price_snapshot_minor >= 0 AND price_snapshot_minor <= 1000000000),
  billing_unit text NOT NULL CHECK (billing_unit = ANY (ARRAY['vehicle'::text, 'branch'::text])),
  units integer NOT NULL CHECK (units > 0),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status = ANY (ARRAY['pending_payment'::text, 'scheduled'::text, 'active'::text, 'expired'::text, 'suspended'::text, 'cancelled'::text])),
  cancellation_effective_at timestamptz,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (cancellation_effective_at IS NULL OR cancellation_effective_at >= created_at)
);
ALTER TABLE public.petro_subscription_requests
  ADD CONSTRAINT petro_subscription_requests_current_subscription_fk
    FOREIGN KEY (current_subscription_id) REFERENCES public.petro_subscriptions(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX petro_subscription_requests_open_dedup
  ON public.petro_subscription_requests
    (organization_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
     request_type, plan_id, plan_version_id,
     coalesce(current_subscription_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE request_status IN ('draft', 'submitted', 'needs_changes');
CREATE INDEX petro_subscription_requests_queue
  ON public.petro_subscription_requests (request_status, created_at DESC);
CREATE INDEX petro_subscriptions_scope
  ON public.petro_subscriptions (organization_id, branch_id, status, starts_at, ends_at);
CREATE INDEX petro_plan_price_overrides_scope
  ON public.petro_plan_price_overrides (organization_id, branch_id, plan_id, effective_from, effective_to);

ALTER TABLE public.petro_plan_price_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_subscription_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.petro_plan_price_overrides, public.petro_subscription_requests, public.petro_subscriptions
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.petro_plan_price_overrides, public.petro_subscription_requests, public.petro_subscriptions
  TO service_role;

CREATE FUNCTION petro_private.guard_plan_version_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.publication_status <> 'draft'
     AND ROW(NEW.plan_id, NEW.version, NEW.annual_price_minor, NEW.nfc_issue_price_minor,
             NEW.billing_unit, NEW.features, NEW.billing_cycle, NEW.currency,
             NEW.entitlements, NEW.settings, NEW.effective_at)
         IS DISTINCT FROM
         ROW(OLD.plan_id, OLD.version, OLD.annual_price_minor, OLD.nfc_issue_price_minor,
             OLD.billing_unit, OLD.features, OLD.billing_cycle, OLD.currency,
             OLD.entitlements, OLD.settings, OLD.effective_at) THEN
    RAISE EXCEPTION 'published plan versions are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.publication_status <> 'draft'
     AND NEW.publication_status IS DISTINCT FROM OLD.publication_status
     AND NOT (OLD.publication_status = 'published' AND NEW.publication_status = 'retired') THEN
    RAISE EXCEPTION 'invalid plan version state transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER petro_plan_version_immutable
  BEFORE UPDATE ON public.petro_plan_versions
  FOR EACH ROW EXECUTE FUNCTION petro_private.guard_plan_version_immutability();

CREATE FUNCTION petro_private.guard_subscription_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF ROW(NEW.request_id, NEW.organization_id, NEW.branch_id, NEW.plan_id, NEW.plan_version_id,
         NEW.plan_snapshot, NEW.price_snapshot_minor, NEW.billing_unit, NEW.units, NEW.starts_at, NEW.ends_at)
     IS DISTINCT FROM
     ROW(OLD.request_id, OLD.organization_id, OLD.branch_id, OLD.plan_id, OLD.plan_version_id,
         OLD.plan_snapshot, OLD.price_snapshot_minor, OLD.billing_unit, OLD.units, OLD.starts_at, OLD.ends_at) THEN
    RAISE EXCEPTION 'subscription snapshots and term dates are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.cancellation_effective_at IS NOT NULL
     AND NEW.cancellation_effective_at IS DISTINCT FROM OLD.cancellation_effective_at THEN
    RAISE EXCEPTION 'subscription cancellation date is immutable once set' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER petro_subscription_snapshot_immutable
  BEFORE UPDATE ON public.petro_subscriptions
  FOR EACH ROW EXECUTE FUNCTION petro_private.guard_subscription_snapshot();

CREATE FUNCTION petro_private.plan_admin_authorized()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT auth.uid() IS NOT NULL
     AND petro_private.user_active()
     AND petro_private.platform_has(ARRAY['owner']::text[])
$$;

CREATE FUNCTION public.petro_billing_admin_catalog()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE result jsonb;
BEGIN
  IF NOT petro_private.plan_admin_authorized() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  SELECT jsonb_build_object(
    'plans', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', p.id, 'code', p.code, 'audience', p.audience, 'name', p.name,
        'active', p.active, 'stopNewAt', p.stop_new_at,
        'versions', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', v.id, 'version', v.version, 'annualPriceMinor', v.annual_price_minor,
            'nfcIssuePriceMinor', v.nfc_issue_price_minor, 'billingUnit', v.billing_unit,
            'billingCycle', v.billing_cycle, 'currency', v.currency,
            'legacyFeatures', v.features, 'entitlements', v.entitlements, 'settings', v.settings,
            'effectiveAt', v.effective_at,
            'publicationStatus', CASE
              WHEN v.publication_status = 'scheduled' AND v.effective_at <= now() THEN 'published'
              ELSE v.publication_status
            END
          ) ORDER BY v.version DESC)
          FROM public.petro_plan_versions v WHERE v.plan_id = p.id
        ), '[]'::jsonb)
      ) ORDER BY p.audience, p.code)
      FROM public.petro_plans p
    ), '[]'::jsonb),
    'requests', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', r.id, 'organizationId', r.organization_id, 'organizationName', o.name,
        'branchId', r.branch_id, 'branchName', b.name, 'requestType', r.request_type,
        'currentSubscriptionId', r.current_subscription_id, 'planId', r.plan_id,
        'planVersionId', r.plan_version_id, 'requestedPriceMinor', r.requested_price_minor,
        'requestedUnits', r.requested_units, 'startsAt', r.starts_at, 'endsAt', r.ends_at,
        'coverageState', r.coverage_state, 'coverageNote', r.coverage_note,
        'status', r.request_status, 'reason', r.reason, 'decisionReason', r.decision_reason,
        'createdAt', r.created_at
      ) ORDER BY r.created_at DESC)
      FROM (
        SELECT * FROM public.petro_subscription_requests ORDER BY created_at DESC LIMIT 500
      ) r
      JOIN public.petro_organizations o ON o.id = r.organization_id
      LEFT JOIN public.petro_branches b ON b.id = r.branch_id
    ), '[]'::jsonb),
    'subscriptions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', s.id, 'organizationId', s.organization_id, 'organizationName', o.name,
        'branchId', s.branch_id, 'branchName', b.name, 'planId', s.plan_id,
        'planVersionId', s.plan_version_id, 'planSnapshot', s.plan_snapshot,
        'priceSnapshotMinor', s.price_snapshot_minor, 'billingUnit', s.billing_unit,
        'units', s.units, 'startsAt', s.starts_at, 'endsAt', s.ends_at,
        'status', CASE
          WHEN s.status = 'active' AND s.cancellation_effective_at <= now() THEN 'cancelled'
          WHEN s.status = 'active' AND s.ends_at <= now() THEN 'expired'
          WHEN s.status = 'scheduled' AND s.starts_at <= now() AND s.ends_at > now() THEN 'active'
          ELSE s.status
        END,
        'cancellationEffectiveAt', s.cancellation_effective_at, 'createdAt', s.created_at
      ) ORDER BY s.created_at DESC)
      FROM (
        SELECT * FROM public.petro_subscriptions ORDER BY created_at DESC LIMIT 500
      ) s
      JOIN public.petro_organizations o ON o.id = s.organization_id
      LEFT JOIN public.petro_branches b ON b.id = s.branch_id
    ), '[]'::jsonb)
  ) INTO result;
  RETURN result;
END;
$$;

CREATE FUNCTION public.petro_billing_admin_create_plan(
  p_code text, p_audience text, p_name text, p_annual_price_minor bigint, p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE plan_id uuid; billing_unit_value text;
BEGIN
  IF NOT petro_private.plan_admin_authorized() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_code IS NULL OR p_code !~ '^[a-z][a-z0-9_-]{2,47}$'
     OR p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 2 AND 100
     OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 5 AND 500
     OR p_audience IS NULL OR p_audience NOT IN ('company', 'provider', 'station')
     OR p_annual_price_minor IS NULL
     OR (p_audience = 'company' AND p_annual_price_minor NOT IN (50000, 75000, 100000))
     OR (p_audience = 'provider' AND p_annual_price_minor <> 500000)
     OR (p_audience = 'station' AND p_annual_price_minor <> 0) THEN
    RAISE EXCEPTION 'invalid plan draft' USING ERRCODE = '22023';
  END IF;
  billing_unit_value := CASE WHEN p_audience = 'company' THEN 'vehicle' ELSE 'branch' END;
  INSERT INTO public.petro_plans (code, audience, name, active)
  VALUES (p_code, p_audience, btrim(p_name), false)
  RETURNING id INTO plan_id;
  INSERT INTO public.petro_plan_versions (
    plan_id, version, annual_price_minor, nfc_issue_price_minor, billing_unit,
    features, effective_at, created_by, publication_status, billing_cycle, currency,
    entitlements, settings
  ) VALUES (
    plan_id, 1, p_annual_price_minor, 10000, billing_unit_value,
    ARRAY[]::text[], now(), auth.uid(), 'draft', 'annual', 'EGP', '[]'::jsonb, '[]'::jsonb
  );
  INSERT INTO public.petro_audit_events(actor_id, organization_id, action, target_id, detail)
  VALUES (auth.uid(), NULL, 'plan.draft_created', plan_id,
          jsonb_build_object('code', p_code, 'audience', p_audience, 'reason', btrim(p_reason)));
  RETURN plan_id;
END;
$$;

CREATE FUNCTION public.petro_billing_admin_add_plan_version(
  p_plan_id uuid, p_annual_price_minor bigint, p_effective_at timestamptz,
  p_entitlements jsonb, p_settings jsonb, p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE plan_row public.petro_plans%ROWTYPE; next_version integer; version_id uuid; unit_value text;
BEGIN
  IF NOT petro_private.plan_admin_authorized() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 5 AND 500
     OR p_effective_at IS NULL OR p_effective_at < now()
     OR p_annual_price_minor IS NULL
     OR p_entitlements IS NULL OR jsonb_typeof(p_entitlements) <> 'array'
     OR p_settings IS NULL OR jsonb_typeof(p_settings) <> 'array'
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(
         CASE WHEN jsonb_typeof(p_entitlements) = 'array' THEN p_entitlements ELSE '[]'::jsonb END
       ) item
       WHERE jsonb_typeof(item) <> 'object'
         OR length(btrim(COALESCE(item ->> 'key', ''))) NOT BETWEEN 1 AND 64
         OR length(btrim(COALESCE(item ->> 'label', ''))) NOT BETWEEN 1 AND 120
         OR NOT (item ? 'value')
         OR COALESCE(item ->> 'approved', 'false') NOT IN ('true', 'false')
     )
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(
         CASE WHEN jsonb_typeof(p_settings) = 'array' THEN p_settings ELSE '[]'::jsonb END
       ) item
       WHERE jsonb_typeof(item) <> 'object'
         OR length(btrim(COALESCE(item ->> 'key', ''))) NOT BETWEEN 1 AND 64
         OR length(btrim(COALESCE(item ->> 'label', ''))) NOT BETWEEN 1 AND 120
         OR NOT (item ? 'value')
         OR COALESCE(item ->> 'approved', 'false') NOT IN ('true', 'false')
     )
     OR (SELECT count(*) FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(p_entitlements) = 'array' THEN p_entitlements ELSE '[]'::jsonb END
         ))
        <> (SELECT count(DISTINCT item ->> 'key') FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(p_entitlements) = 'array' THEN p_entitlements ELSE '[]'::jsonb END
         ) item)
     OR (SELECT count(*) FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(p_settings) = 'array' THEN p_settings ELSE '[]'::jsonb END
         ))
        <> (SELECT count(DISTINCT item ->> 'key') FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(p_settings) = 'array' THEN p_settings ELSE '[]'::jsonb END
         ) item) THEN
    RAISE EXCEPTION 'invalid plan version draft' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO plan_row FROM public.petro_plans WHERE id = p_plan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan not found' USING ERRCODE = 'P0002'; END IF;
  IF (plan_row.audience = 'company' AND p_annual_price_minor NOT IN (50000, 75000, 100000))
     OR (plan_row.audience = 'provider' AND p_annual_price_minor <> 500000)
     OR (plan_row.audience = 'station' AND p_annual_price_minor <> 0) THEN
    RAISE EXCEPTION 'base price is outside the approved schedule' USING ERRCODE = '22023';
  END IF;
  unit_value := CASE WHEN plan_row.audience = 'company' THEN 'vehicle' ELSE 'branch' END;
  SELECT COALESCE(max(version), 0) + 1 INTO next_version
  FROM public.petro_plan_versions WHERE plan_id = p_plan_id;
  INSERT INTO public.petro_plan_versions (
    plan_id, version, annual_price_minor, nfc_issue_price_minor, billing_unit, features,
    effective_at, created_by, publication_status, billing_cycle, currency, entitlements, settings
  ) VALUES (
    p_plan_id, next_version, p_annual_price_minor, 10000, unit_value,
    ARRAY(SELECT item ->> 'key' FROM jsonb_array_elements(p_entitlements) item),
    p_effective_at, auth.uid(), 'draft', 'annual', 'EGP', p_entitlements, p_settings
  ) RETURNING id INTO version_id;
  INSERT INTO public.petro_audit_events(actor_id, organization_id, action, target_id, detail)
  VALUES (auth.uid(), NULL, 'plan.version_drafted', version_id,
          jsonb_build_object('planId', p_plan_id, 'version', next_version, 'reason', btrim(p_reason)));
  RETURN version_id;
END;
$$;

CREATE FUNCTION public.petro_billing_admin_publish_plan_version(
  p_plan_id uuid, p_version_id uuid, p_reason text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE version_row public.petro_plan_versions%ROWTYPE; next_state text;
BEGIN
  IF NOT petro_private.plan_admin_authorized() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'reason required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO version_row FROM public.petro_plan_versions
  WHERE id = p_version_id AND plan_id = p_plan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan version not found' USING ERRCODE = 'P0002'; END IF;
  IF version_row.publication_status <> 'draft'
     OR version_row.entitlements IS NULL
     OR jsonb_array_length(version_row.entitlements) = 0
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(version_row.entitlements) item WHERE item ->> 'approved' <> 'true')
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(version_row.settings, '[]'::jsonb)) item WHERE item ->> 'approved' <> 'true') THEN
    RAISE EXCEPTION 'plan rights and settings require explicit approval' USING ERRCODE = '55000';
  END IF;
  next_state := CASE WHEN version_row.effective_at > now() THEN 'scheduled' ELSE 'published' END;
  UPDATE public.petro_plan_versions SET publication_status = next_state WHERE id = p_version_id;
  UPDATE public.petro_plans SET active = true WHERE id = p_plan_id;
  INSERT INTO public.petro_audit_events(actor_id, organization_id, action, target_id, detail)
  VALUES (auth.uid(), NULL, 'plan.version_published', p_version_id,
          jsonb_build_object('planId', p_plan_id, 'status', next_state, 'reason', btrim(p_reason)));
  RETURN next_state;
END;
$$;

CREATE FUNCTION public.petro_billing_admin_set_plan_stop(
  p_plan_id uuid, p_stop_new_at timestamptz, p_reason text
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE result timestamptz;
BEGIN
  IF NOT petro_private.plan_admin_authorized() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 5 AND 500
      OR (p_stop_new_at IS NOT NULL AND p_stop_new_at <= now()) THEN
    RAISE EXCEPTION 'invalid future stop date or reason' USING ERRCODE = '22023';
  END IF;
  UPDATE public.petro_plans SET stop_new_at = p_stop_new_at
  WHERE id = p_plan_id RETURNING stop_new_at INTO result;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan not found' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO public.petro_audit_events(actor_id, organization_id, action, target_id, detail)
  VALUES (auth.uid(), NULL, 'plan.stop_scheduled', p_plan_id,
          jsonb_build_object('stopNewAt', p_stop_new_at, 'reason', btrim(p_reason)));
  RETURN result;
END;
$$;

CREATE FUNCTION public.petro_billing_admin_create_request(
  p_organization_id uuid, p_branch_id uuid, p_request_type text,
  p_current_subscription_id uuid, p_plan_id uuid, p_plan_version_id uuid,
  p_requested_price_minor bigint, p_starts_at timestamptz, p_ends_at timestamptz,
  p_coverage_note text, p_reason text, p_submit boolean
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE org_row public.petro_organizations%ROWTYPE; plan_row public.petro_plans%ROWTYPE;
        version_row public.petro_plan_versions%ROWTYPE; coverage_value text; request_id uuid;
BEGIN
  IF NOT petro_private.plan_admin_authorized() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_request_type IS NULL OR p_request_type NOT IN ('new', 'renewal', 'plan_change', 'custom_price')
     OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 5 AND 500
     OR p_starts_at IS NULL OR p_starts_at < now()
     OR p_ends_at IS NULL OR p_ends_at <= p_starts_at
     OR (p_coverage_note IS NOT NULL AND length(p_coverage_note) > 1000)
     OR (p_request_type = 'custom_price' AND (p_requested_price_minor IS NULL OR p_requested_price_minor <= 0))
     OR (p_request_type <> 'custom_price' AND p_requested_price_minor IS NOT NULL)
     OR (p_request_type IN ('renewal', 'plan_change') AND p_current_subscription_id IS NULL)
     OR (p_request_type IN ('new', 'custom_price') AND p_current_subscription_id IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid subscription request' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO org_row FROM public.petro_organizations WHERE id = p_organization_id;
  SELECT * INTO plan_row FROM public.petro_plans WHERE id = p_plan_id;
  SELECT * INTO version_row FROM public.petro_plan_versions
    WHERE id = p_plan_version_id AND plan_id = p_plan_id;
  IF org_row.id IS NULL OR plan_row.id IS NULL OR version_row.id IS NULL THEN
    RAISE EXCEPTION 'subscription request target not found' USING ERRCODE = 'P0002';
  END IF;
  IF org_row.kind <> plan_row.audience THEN
    RAISE EXCEPTION 'plan audience does not match organization type' USING ERRCODE = '23514';
  END IF;
  IF p_request_type = 'custom_price' AND plan_row.audience = 'station' THEN
    RAISE EXCEPTION 'station subscriptions must remain free' USING ERRCODE = '23514';
  END IF;
  IF p_current_subscription_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.petro_subscriptions s
    WHERE s.id = p_current_subscription_id AND s.organization_id = p_organization_id
      AND s.branch_id IS NOT DISTINCT FROM p_branch_id
      AND s.status IN ('pending_payment', 'scheduled', 'active')
      AND (s.cancellation_effective_at IS NULL OR s.cancellation_effective_at > now())
  ) THEN
    RAISE EXCEPTION 'current subscription does not match request scope' USING ERRCODE = '23514';
  END IF;
  IF p_branch_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.petro_branches b
    WHERE b.id = p_branch_id AND b.organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'branch does not belong to the organization' USING ERRCODE = '23514';
  END IF;
  IF version_row.billing_unit = 'branch' THEN
    IF p_branch_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.petro_branches b
      WHERE b.id = p_branch_id AND b.organization_id = p_organization_id
        AND b.status = 'active' AND b.approval_status = 'approved'
        AND b.operational_status = 'active'
    ) THEN
      coverage_value := 'branch_unverified';
    ELSE
      coverage_value := 'verified';
    END IF;
  ELSE
    coverage_value := 'fleet_registry_missing';
  END IF;
  IF p_submit AND (
    coverage_value <> 'verified'
    OR org_row.status <> 'active'
    OR org_row.approval_status <> 'approved'
    OR org_row.operational_status <> 'active'
    OR NOT plan_row.active
    OR (plan_row.stop_new_at IS NOT NULL AND plan_row.stop_new_at <= now())
    OR version_row.publication_status NOT IN ('published', 'scheduled')
    OR version_row.effective_at > p_starts_at
    OR version_row.entitlements IS NULL
    OR jsonb_array_length(version_row.entitlements) = 0
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(version_row.entitlements) item WHERE item ->> 'approved' <> 'true')
  ) THEN
    RAISE EXCEPTION 'request cannot be submitted until scope and approved plan rights are available' USING ERRCODE = '55000';
  END IF;
  IF p_requested_price_minor = 0 AND plan_row.audience <> 'station' THEN
    RAISE EXCEPTION 'zero-price subscriptions are only allowed for stations' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.petro_subscription_requests (
    organization_id, branch_id, current_subscription_id, request_type, plan_id, plan_version_id,
    requested_price_minor, requested_units, starts_at, ends_at, coverage_state, coverage_note,
    request_status, reason, submitted_by
  ) VALUES (
    p_organization_id, p_branch_id, p_current_subscription_id, p_request_type, p_plan_id, p_plan_version_id,
    p_requested_price_minor, CASE WHEN version_row.billing_unit = 'branch' THEN 1 ELSE NULL END,
    p_starts_at, p_ends_at, coverage_value, COALESCE(p_coverage_note, ''),
    CASE WHEN p_submit THEN 'submitted' ELSE 'draft' END, btrim(p_reason), auth.uid()
  ) RETURNING id INTO request_id;
  INSERT INTO public.petro_audit_events(actor_id, organization_id, action, target_id, detail)
  VALUES (auth.uid(), p_organization_id, 'subscription.request_created', request_id,
          jsonb_build_object('requestType', p_request_type, 'planId', p_plan_id, 'status', CASE WHEN p_submit THEN 'submitted' ELSE 'draft' END, 'reason', btrim(p_reason)));
  RETURN request_id;
END;
$$;

CREATE FUNCTION public.petro_billing_admin_review_request(
  p_request_id uuid, p_decision text, p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE req public.petro_subscription_requests%ROWTYPE; org_row public.petro_organizations%ROWTYPE;
        plan_row public.petro_plans%ROWTYPE; version_row public.petro_plan_versions%ROWTYPE;
        price_value bigint; unit_value text; subscription_id uuid; snapshot_value jsonb;
BEGIN
  IF NOT petro_private.plan_admin_authorized() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'needs_changes', 'reject', 'cancel')
     OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'invalid review decision or reason' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO req FROM public.petro_subscription_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'subscription request not found' USING ERRCODE = 'P0002'; END IF;
  IF req.request_status NOT IN ('submitted', 'needs_changes') THEN
    RAISE EXCEPTION 'request is not reviewable' USING ERRCODE = '55000';
  END IF;
  IF p_decision = 'approve' THEN
    SELECT * INTO org_row FROM public.petro_organizations WHERE id = req.organization_id;
    SELECT * INTO plan_row FROM public.petro_plans WHERE id = req.plan_id;
    SELECT * INTO version_row FROM public.petro_plan_versions WHERE id = req.plan_version_id;
    IF org_row.status <> 'active' OR org_row.approval_status <> 'approved'
       OR org_row.operational_status <> 'active' OR plan_row.audience <> org_row.kind
       OR NOT plan_row.active
       OR version_row.publication_status NOT IN ('published', 'scheduled')
        OR version_row.effective_at > req.starts_at
       OR version_row.entitlements IS NULL OR jsonb_array_length(version_row.entitlements) = 0
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(version_row.entitlements) item WHERE item ->> 'approved' <> 'true')
        OR req.coverage_state <> 'verified' THEN
      RAISE EXCEPTION 'plan, organization, or coverage is not ready for approval' USING ERRCODE = '55000';
    END IF;
    IF req.request_type = 'custom_price' AND org_row.kind = 'station' THEN
      RAISE EXCEPTION 'station subscriptions must remain free' USING ERRCODE = '23514';
    END IF;
    unit_value := version_row.billing_unit;
    IF unit_value = 'vehicle' THEN
      RAISE EXCEPTION 'fleet registry and verified vehicle coverage are required' USING ERRCODE = '55000';
    END IF;
    IF req.branch_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.petro_branches b
      WHERE b.id = req.branch_id AND b.organization_id = req.organization_id
        AND b.status = 'active' AND b.approval_status = 'approved'
        AND b.operational_status = 'active'
    ) THEN
      RAISE EXCEPTION 'active branch coverage is required' USING ERRCODE = '55000';
    END IF;
    price_value := COALESCE(req.requested_price_minor, version_row.annual_price_minor);
    IF price_value = 0 AND org_row.kind <> 'station' THEN
      RAISE EXCEPTION 'zero-price subscriptions are only allowed for stations' USING ERRCODE = '23514';
    END IF;
    IF req.request_type = 'custom_price' THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(
        req.organization_id::text || ':' || COALESCE(req.branch_id::text, '-') || ':' || req.plan_id::text, 0
      ));
      IF EXISTS (
        SELECT 1 FROM public.petro_plan_price_overrides po
        WHERE po.organization_id = req.organization_id AND po.branch_id IS NOT DISTINCT FROM req.branch_id
          AND po.plan_id = req.plan_id
          AND tstzrange(po.effective_from, po.effective_to, '[)') && tstzrange(req.starts_at, req.ends_at, '[)')
      ) THEN
        RAISE EXCEPTION 'custom price period overlaps an existing override' USING ERRCODE = '23505';
      END IF;
      INSERT INTO public.petro_plan_price_overrides (
        organization_id, branch_id, plan_id, price_minor, effective_from, effective_to, reason, approved_by
      ) VALUES (
        req.organization_id, req.branch_id, req.plan_id, price_value, req.starts_at, req.ends_at, btrim(p_reason), auth.uid()
      );
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(
      req.organization_id::text || ':' || COALESCE(req.branch_id::text, '-'), 0
    ));
    IF EXISTS (
      SELECT 1 FROM public.petro_subscriptions s
      WHERE s.organization_id = req.organization_id
        AND s.branch_id IS NOT DISTINCT FROM req.branch_id
        AND s.status IN ('pending_payment', 'scheduled', 'active')
        AND (s.cancellation_effective_at IS NULL OR s.cancellation_effective_at > req.starts_at)
        AND tstzrange(s.starts_at, s.ends_at, '[)') && tstzrange(req.starts_at, req.ends_at, '[)')
    ) THEN
      RAISE EXCEPTION 'subscription period conflicts with an existing subscription' USING ERRCODE = '23505';
    END IF;
    snapshot_value := jsonb_build_object(
      'planId', plan_row.id, 'planCode', plan_row.code, 'planName', plan_row.name,
      'audience', plan_row.audience, 'versionId', version_row.id, 'version', version_row.version,
      'priceMinor', price_value, 'currency', 'EGP', 'billingUnit', unit_value,
      'billingCycle', 'annual', 'units', req.requested_units,
      'nfcIssuePriceMinor', version_row.nfc_issue_price_minor,
      'legacyFeatures', version_row.features, 'entitlements', version_row.entitlements,
      'settings', version_row.settings, 'priceOverride', req.request_type = 'custom_price'
    );
    INSERT INTO public.petro_subscriptions (
      request_id, organization_id, branch_id, plan_id, plan_version_id, plan_snapshot,
      price_snapshot_minor, billing_unit, units, starts_at, ends_at, status, created_by
    ) VALUES (
      req.id, req.organization_id, req.branch_id, req.plan_id, req.plan_version_id, snapshot_value,
      price_value, unit_value, COALESCE(req.requested_units, 1), req.starts_at, req.ends_at,
      CASE WHEN price_value > 0 THEN 'pending_payment'
           WHEN req.starts_at > now() THEN 'scheduled'
           ELSE 'active' END,
      auth.uid()
    ) RETURNING id INTO subscription_id;
  END IF;
  UPDATE public.petro_subscription_requests
  SET request_status = CASE p_decision
        WHEN 'approve' THEN 'approved'
        WHEN 'needs_changes' THEN 'needs_changes'
        WHEN 'reject' THEN 'rejected'
        ELSE 'cancelled'
      END,
      reviewed_by = auth.uid(), reviewed_at = now(), decision_reason = btrim(p_reason), updated_at = now()
  WHERE id = req.id;
  INSERT INTO public.petro_audit_events(actor_id, organization_id, action, target_id, detail)
  VALUES (auth.uid(), req.organization_id, 'subscription.request_reviewed', req.id,
          jsonb_build_object('decision', p_decision, 'reason', btrim(p_reason), 'subscriptionId', subscription_id));
  RETURN subscription_id;
END;
$$;

CREATE FUNCTION public.petro_billing_admin_cancel_subscription(
  p_subscription_id uuid, p_effective_at timestamptz, p_reason text
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE result timestamptz; org_id uuid;
BEGIN
  IF NOT petro_private.plan_admin_authorized() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_effective_at IS NULL OR p_effective_at <= now()
     OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'cancellation requires a future date and reason' USING ERRCODE = '22023';
  END IF;
  UPDATE public.petro_subscriptions
  SET cancellation_effective_at = p_effective_at
  WHERE id = p_subscription_id AND cancellation_effective_at IS NULL
    AND status IN ('active', 'scheduled', 'pending_payment')
  RETURNING cancellation_effective_at, organization_id INTO result, org_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'subscription not cancellable' USING ERRCODE = '55000'; END IF;
  INSERT INTO public.petro_audit_events(actor_id, organization_id, action, target_id, detail)
  VALUES (auth.uid(), org_id, 'subscription.cancellation_scheduled', p_subscription_id,
          jsonb_build_object('effectiveAt', result, 'reason', btrim(p_reason)));
  RETURN result;
END;
$$;

CREATE FUNCTION petro_private.subscription_allows_new_service(p_organization_id uuid, p_branch_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.petro_subscriptions s
    WHERE s.organization_id = p_organization_id
      AND s.branch_id = p_branch_id
      AND s.billing_unit = 'branch'
      AND s.status IN ('active', 'scheduled')
      AND s.starts_at <= now()
      AND s.ends_at > now()
      AND (s.cancellation_effective_at IS NULL OR s.cancellation_effective_at > now())
  )
$$;

REVOKE ALL ON FUNCTION petro_private.plan_admin_authorized() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION petro_private.subscription_allows_new_service(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA petro_private TO service_role;
GRANT EXECUTE ON FUNCTION petro_private.plan_admin_authorized() TO service_role;
GRANT EXECUTE ON FUNCTION petro_private.subscription_allows_new_service(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.petro_billing_admin_catalog() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.petro_billing_admin_create_plan(text, text, text, bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.petro_billing_admin_add_plan_version(uuid, bigint, timestamptz, jsonb, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.petro_billing_admin_publish_plan_version(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.petro_billing_admin_set_plan_stop(uuid, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.petro_billing_admin_create_request(uuid, uuid, text, uuid, uuid, uuid, bigint, timestamptz, timestamptz, text, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.petro_billing_admin_review_request(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.petro_billing_admin_cancel_subscription(uuid, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.petro_billing_admin_catalog() TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_billing_admin_create_plan(text, text, text, bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_billing_admin_add_plan_version(uuid, bigint, timestamptz, jsonb, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_billing_admin_publish_plan_version(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_billing_admin_set_plan_stop(uuid, timestamptz, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_billing_admin_create_request(uuid, uuid, text, uuid, uuid, uuid, bigint, timestamptz, timestamptz, text, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_billing_admin_review_request(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_billing_admin_cancel_subscription(uuid, timestamptz, text) TO authenticated;

COMMIT;
