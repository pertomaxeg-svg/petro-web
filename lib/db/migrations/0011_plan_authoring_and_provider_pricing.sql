BEGIN;

ALTER TABLE public.petro_plans
  ADD COLUMN description text NOT NULL DEFAULT '';

ALTER TABLE public.petro_plan_versions
  ADD COLUMN display_name text NOT NULL DEFAULT '',
  ADD COLUMN description text NOT NULL DEFAULT '';

UPDATE public.petro_plan_versions AS version
SET display_name = plan.name,
    description = plan.description
FROM public.petro_plans AS plan
WHERE plan.id = version.plan_id
  AND version.display_name = '';

ALTER TABLE public.petro_plan_price_overrides
  ADD COLUMN supersedes_override_id uuid
    REFERENCES public.petro_plan_price_overrides(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX petro_plan_price_overrides_supersedes_unique
  ON public.petro_plan_price_overrides (supersedes_override_id)
  WHERE supersedes_override_id IS NOT NULL;

-- Custom provider prices are a separate price schedule, not subscription requests.
ALTER TABLE public.petro_subscription_requests
  DROP CONSTRAINT petro_subscription_requests_request_type_check,
  ADD CONSTRAINT petro_subscription_requests_request_type_check
    CHECK (request_type = ANY (ARRAY['new'::text, 'renewal'::text, 'plan_change'::text]));

CREATE TABLE public.petro_billing_settings (
  singleton_id boolean PRIMARY KEY DEFAULT true CHECK (singleton_id),
  company_annual_prices_minor bigint[] NOT NULL DEFAULT ARRAY[50000, 75000, 100000]::bigint[],
  provider_annual_price_minor bigint NOT NULL DEFAULT 500000
    CHECK (provider_annual_price_minor BETWEEN 1 AND 1000000000),
  nfc_issue_price_minor bigint NOT NULL DEFAULT 10000
    CHECK (nfc_issue_price_minor BETWEEN 0 AND 1000000000),
  updated_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(company_annual_prices_minor) BETWEEN 1 AND 5)
);

INSERT INTO public.petro_billing_settings (singleton_id)
VALUES (true);

ALTER TABLE public.petro_billing_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.petro_billing_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.petro_billing_settings TO service_role;

CREATE OR REPLACE FUNCTION petro_private.plan_configuration_valid(p_values jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE item_count integer; distinct_count integer;
BEGIN
  IF p_values IS NULL OR jsonb_typeof(p_values) <> 'array' THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_values) AS entry(item)
    WHERE jsonb_typeof(entry.item) <> 'object'
       OR length(btrim(COALESCE(entry.item ->> 'key', ''))) NOT BETWEEN 1 AND 64
       OR length(btrim(COALESCE(entry.item ->> 'label', ''))) NOT BETWEEN 1 AND 120
       OR NOT (entry.item ? 'value')
       OR jsonb_typeof(entry.item -> 'approved') <> 'boolean'
  ) THEN
    RETURN false;
  END IF;
  SELECT count(*)::integer, count(DISTINCT entry.item ->> 'key')::integer
    INTO item_count, distinct_count
  FROM jsonb_array_elements(p_values) AS entry(item);
  RETURN item_count = distinct_count;
END;
$$;

CREATE OR REPLACE FUNCTION petro_private.guard_plan_version_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.publication_status <> 'draft'
     AND ROW(NEW.plan_id, NEW.version, NEW.display_name, NEW.description,
             NEW.annual_price_minor, NEW.nfc_issue_price_minor, NEW.billing_unit,
             NEW.features, NEW.billing_cycle, NEW.currency, NEW.entitlements,
             NEW.settings, NEW.effective_at)
         IS DISTINCT FROM
         ROW(OLD.plan_id, OLD.version, OLD.display_name, OLD.description,
             OLD.annual_price_minor, OLD.nfc_issue_price_minor, OLD.billing_unit,
             OLD.features, OLD.billing_cycle, OLD.currency, OLD.entitlements,
             OLD.settings, OLD.effective_at) THEN
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

CREATE FUNCTION public.petro_billing_admin_create_plan_v2(
  p_code text,
  p_audience text,
  p_name text,
  p_description text,
  p_price_minor bigint,
  p_billing_unit text,
  p_billing_cycle text,
  p_currency text,
  p_effective_at timestamptz,
  p_entitlements jsonb,
  p_settings jsonb,
  p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE plan_id uuid; version_name text;
BEGIN
  IF NOT petro_private.plan_admin_authorized() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_code IS NULL OR p_code !~ '^[a-z][a-z0-9_-]{2,47}$'
     OR p_audience IS NULL OR p_audience NOT IN ('company', 'provider', 'station')
     OR p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 2 AND 100
     OR p_description IS NULL OR length(p_description) > 1000
     OR p_price_minor IS NULL OR p_price_minor NOT BETWEEN 0 AND 1000000000
     OR (p_audience = 'station' AND p_price_minor <> 0)
     OR (p_audience <> 'station' AND p_price_minor = 0)
     OR p_billing_unit IS NULL
     OR p_billing_unit <> (CASE WHEN p_audience = 'company' THEN 'vehicle' ELSE 'branch' END)
     OR p_billing_cycle IS DISTINCT FROM 'annual' OR p_currency IS DISTINCT FROM 'EGP'
     OR p_effective_at IS NULL OR p_effective_at < now()
     OR NOT petro_private.plan_configuration_valid(p_entitlements)
     OR NOT petro_private.plan_configuration_valid(p_settings)
     OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'invalid plan draft' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.petro_plans (code, audience, name, description, active)
  VALUES (p_code, p_audience, btrim(p_name), btrim(p_description), false)
  RETURNING id INTO plan_id;
  version_name := btrim(p_name);

  INSERT INTO public.petro_plan_versions (
    plan_id, version, display_name, description, annual_price_minor,
    nfc_issue_price_minor, billing_unit, features, effective_at, created_by,
    publication_status, billing_cycle, currency, entitlements, settings
  ) VALUES (
    plan_id, 1, version_name, btrim(p_description), p_price_minor,
    0, p_billing_unit,
    ARRAY(SELECT entry.item ->> 'key' FROM jsonb_array_elements(p_entitlements) AS entry(item)),
    p_effective_at, auth.uid(), 'draft', p_billing_cycle, p_currency, p_entitlements, p_settings
  );

  INSERT INTO public.petro_audit_events(actor_id, organization_id, action, target_id, detail)
  VALUES (auth.uid(), NULL, 'plan.draft_created', plan_id,
          jsonb_build_object('code', p_code, 'audience', p_audience, 'reason', btrim(p_reason)));
  RETURN plan_id;
END;
$$;

CREATE FUNCTION public.petro_billing_admin_add_plan_version_v2(
  p_plan_id uuid,
  p_display_name text,
  p_description text,
  p_price_minor bigint,
  p_billing_unit text,
  p_billing_cycle text,
  p_currency text,
  p_effective_at timestamptz,
  p_entitlements jsonb,
  p_settings jsonb,
  p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE plan_row public.petro_plans%ROWTYPE; next_version integer; version_id uuid;
BEGIN
  IF NOT petro_private.plan_admin_authorized() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO plan_row FROM public.petro_plans WHERE id = p_plan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan not found' USING ERRCODE = 'P0002'; END IF;
  IF p_display_name IS NULL OR length(btrim(p_display_name)) NOT BETWEEN 2 AND 100
     OR p_description IS NULL OR length(p_description) > 1000
     OR p_price_minor IS NULL OR p_price_minor NOT BETWEEN 0 AND 1000000000
     OR (plan_row.audience = 'station' AND p_price_minor <> 0)
     OR (plan_row.audience <> 'station' AND p_price_minor = 0)
     OR p_billing_unit IS NULL
     OR p_billing_unit <> (CASE WHEN plan_row.audience = 'company' THEN 'vehicle' ELSE 'branch' END)
     OR p_billing_cycle IS DISTINCT FROM 'annual' OR p_currency IS DISTINCT FROM 'EGP'
     OR p_effective_at IS NULL OR p_effective_at < now()
     OR NOT petro_private.plan_configuration_valid(p_entitlements)
     OR NOT petro_private.plan_configuration_valid(p_settings)
     OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'invalid plan version draft' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(max(version), 0) + 1 INTO next_version
  FROM public.petro_plan_versions WHERE plan_id = p_plan_id;
  INSERT INTO public.petro_plan_versions (
    plan_id, version, display_name, description, annual_price_minor,
    nfc_issue_price_minor, billing_unit, features, effective_at, created_by,
    publication_status, billing_cycle, currency, entitlements, settings
  ) VALUES (
    p_plan_id, next_version, btrim(p_display_name), btrim(p_description), p_price_minor,
    0, p_billing_unit,
    ARRAY(SELECT entry.item ->> 'key' FROM jsonb_array_elements(p_entitlements) AS entry(item)),
    p_effective_at, auth.uid(), 'draft', p_billing_cycle, p_currency, p_entitlements, p_settings
  ) RETURNING id INTO version_id;

  INSERT INTO public.petro_audit_events(actor_id, organization_id, action, target_id, detail)
  VALUES (auth.uid(), NULL, 'plan.version_drafted', version_id,
          jsonb_build_object('planId', p_plan_id, 'version', next_version, 'reason', btrim(p_reason)));
  RETURN version_id;
END;
$$;

CREATE FUNCTION public.petro_billing_admin_update_draft_version(
  p_plan_id uuid,
  p_version_id uuid,
  p_display_name text,
  p_description text,
  p_price_minor bigint,
  p_billing_unit text,
  p_billing_cycle text,
  p_currency text,
  p_effective_at timestamptz,
  p_entitlements jsonb,
  p_settings jsonb,
  p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE plan_row public.petro_plans%ROWTYPE; version_row public.petro_plan_versions%ROWTYPE;
BEGIN
  IF NOT petro_private.plan_admin_authorized() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO plan_row FROM public.petro_plans WHERE id = p_plan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO version_row FROM public.petro_plan_versions
  WHERE id = p_version_id AND plan_id = p_plan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan version not found' USING ERRCODE = 'P0002'; END IF;
  IF version_row.publication_status <> 'draft' THEN
    RAISE EXCEPTION 'only draft versions can be edited' USING ERRCODE = '55000';
  END IF;
  IF p_display_name IS NULL OR length(btrim(p_display_name)) NOT BETWEEN 2 AND 100
     OR p_description IS NULL OR length(p_description) > 1000
     OR p_price_minor IS NULL OR p_price_minor NOT BETWEEN 0 AND 1000000000
     OR (plan_row.audience = 'station' AND p_price_minor <> 0)
     OR (plan_row.audience <> 'station' AND p_price_minor = 0)
     OR p_billing_unit IS NULL
     OR p_billing_unit <> (CASE WHEN plan_row.audience = 'company' THEN 'vehicle' ELSE 'branch' END)
     OR p_billing_cycle IS DISTINCT FROM 'annual' OR p_currency IS DISTINCT FROM 'EGP'
     OR p_effective_at IS NULL OR p_effective_at < now()
     OR NOT petro_private.plan_configuration_valid(p_entitlements)
     OR NOT petro_private.plan_configuration_valid(p_settings)
     OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'invalid plan version draft' USING ERRCODE = '22023';
  END IF;

  UPDATE public.petro_plan_versions
  SET display_name = btrim(p_display_name), description = btrim(p_description),
      annual_price_minor = p_price_minor, billing_unit = p_billing_unit,
      billing_cycle = p_billing_cycle, currency = p_currency,
      features = ARRAY(SELECT entry.item ->> 'key' FROM jsonb_array_elements(p_entitlements) AS entry(item)),
      effective_at = p_effective_at, entitlements = p_entitlements, settings = p_settings
  WHERE id = p_version_id;
  UPDATE public.petro_plans
  SET name = btrim(p_display_name), description = btrim(p_description)
  WHERE id = p_plan_id;
  INSERT INTO public.petro_audit_events(actor_id, organization_id, action, target_id, detail)
  VALUES (auth.uid(), NULL, 'plan.version_draft_updated', p_version_id,
          jsonb_build_object('planId', p_plan_id, 'reason', btrim(p_reason)));
  RETURN p_version_id;
END;
$$;

CREATE FUNCTION public.petro_billing_admin_update_price_defaults(
  p_company_prices_minor bigint[],
  p_provider_price_minor bigint,
  p_nfc_issue_price_minor bigint,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE result jsonb;
BEGIN
  IF NOT petro_private.plan_admin_authorized() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_company_prices_minor IS NULL
     OR cardinality(p_company_prices_minor) NOT BETWEEN 1 AND 5
     OR EXISTS (SELECT 1 FROM unnest(p_company_prices_minor) price
                WHERE price IS NULL OR price NOT BETWEEN 1 AND 1000000000)
     OR cardinality(p_company_prices_minor) <>
        (SELECT count(DISTINCT price)::integer FROM unnest(p_company_prices_minor) price)
     OR p_provider_price_minor IS NULL OR p_provider_price_minor NOT BETWEEN 1 AND 1000000000
     OR p_nfc_issue_price_minor IS NULL OR p_nfc_issue_price_minor NOT BETWEEN 0 AND 1000000000
     OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'invalid billing price defaults' USING ERRCODE = '22023';
  END IF;
  UPDATE public.petro_billing_settings
  SET company_annual_prices_minor = p_company_prices_minor,
      provider_annual_price_minor = p_provider_price_minor,
      nfc_issue_price_minor = p_nfc_issue_price_minor,
      updated_by = auth.uid(), updated_at = now()
  WHERE singleton_id = true;
  SELECT jsonb_build_object(
    'companyAnnualPricesMinor', company_annual_prices_minor,
    'providerAnnualPriceMinor', provider_annual_price_minor,
    'stationAnnualPriceMinor', 0,
    'nfcIssuePriceMinor', nfc_issue_price_minor,
    'currency', 'EGP', 'billingCycle', 'annual'
  ) INTO result
  FROM public.petro_billing_settings WHERE singleton_id = true;
  INSERT INTO public.petro_audit_events(actor_id, organization_id, action, target_id, detail)
  VALUES (auth.uid(), NULL, 'billing.price_defaults_updated', NULL,
          jsonb_build_object('reason', btrim(p_reason)));
  RETURN result;
END;
$$;

CREATE FUNCTION public.petro_billing_admin_set_provider_price_override(
  p_organization_id uuid,
  p_branch_id uuid,
  p_plan_id uuid,
  p_price_minor bigint,
  p_effective_from timestamptz,
  p_effective_to timestamptz,
  p_supersedes_override_id uuid,
  p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE org_row public.petro_organizations%ROWTYPE; plan_row public.petro_plans%ROWTYPE;
        prior public.petro_plan_price_overrides%ROWTYPE; new_id uuid;
BEGIN
  IF NOT petro_private.plan_admin_authorized() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL OR p_plan_id IS NULL
     OR p_price_minor IS NULL OR p_price_minor NOT BETWEEN 1 AND 1000000000
     OR p_effective_from IS NULL OR p_effective_from < now()
     OR (p_effective_to IS NOT NULL AND p_effective_to <= p_effective_from)
     OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'invalid provider price override' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO org_row FROM public.petro_organizations WHERE id = p_organization_id;
  SELECT * INTO plan_row FROM public.petro_plans WHERE id = p_plan_id;
  IF org_row.id IS NULL OR org_row.kind <> 'provider' OR plan_row.id IS NULL
     OR plan_row.audience <> 'provider' THEN
    RAISE EXCEPTION 'price overrides are limited to provider organizations and plans'
      USING ERRCODE = '23514';
  END IF;
  IF p_branch_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.petro_branches branch
    WHERE branch.id = p_branch_id AND branch.organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'branch does not belong to the selected provider'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_organization_id::text || ':' || COALESCE(p_branch_id::text, '-') || ':' || p_plan_id::text, 0
  ));
  IF p_supersedes_override_id IS NOT NULL THEN
    SELECT * INTO prior FROM public.petro_plan_price_overrides
    WHERE id = p_supersedes_override_id
      AND organization_id = p_organization_id
      AND branch_id IS NOT DISTINCT FROM p_branch_id
      AND plan_id = p_plan_id
    FOR UPDATE;
    IF NOT FOUND OR prior.effective_from >= p_effective_from
       OR (prior.effective_to IS NOT NULL AND prior.effective_to > p_effective_from) THEN
      RAISE EXCEPTION 'prior price version conflicts with the requested period'
        USING ERRCODE = '23505';
    END IF;
    IF prior.effective_to IS NULL THEN
      UPDATE public.petro_plan_price_overrides
      SET effective_to = p_effective_from
      WHERE id = prior.id;
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.petro_plan_price_overrides existing
    WHERE existing.organization_id = p_organization_id
      AND existing.branch_id IS NOT DISTINCT FROM p_branch_id
      AND existing.plan_id = p_plan_id
      AND tstzrange(existing.effective_from, existing.effective_to, '[)')
          && tstzrange(p_effective_from, p_effective_to, '[)')
  ) THEN
    RAISE EXCEPTION 'provider price period overlaps an existing version'
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.petro_plan_price_overrides (
    organization_id, branch_id, plan_id, price_minor, effective_from,
    effective_to, reason, approved_by, supersedes_override_id
  ) VALUES (
    p_organization_id, p_branch_id, p_plan_id, p_price_minor, p_effective_from,
    p_effective_to, btrim(p_reason), auth.uid(), p_supersedes_override_id
  ) RETURNING id INTO new_id;
  INSERT INTO public.petro_audit_events(actor_id, organization_id, action, target_id, detail)
  VALUES (auth.uid(), p_organization_id, 'provider.price_override_created', new_id,
          jsonb_build_object(
            'branchId', p_branch_id, 'planId', p_plan_id, 'priceMinor', p_price_minor,
            'previousOverrideId', p_supersedes_override_id, 'reason', btrim(p_reason)
          ));
  RETURN new_id;
END;
$$;

CREATE FUNCTION public.petro_billing_admin_catalog_v2()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE base_catalog jsonb; plans_value jsonb; overrides_value jsonb; settings_value jsonb;
BEGIN
  IF NOT petro_private.plan_admin_authorized() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  base_catalog := public.petro_billing_admin_catalog();

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', plan.id, 'code', plan.code, 'audience', plan.audience, 'name', plan.name,
    'description', plan.description, 'active', plan.active, 'stopNewAt', plan.stop_new_at,
    'versions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', version.id, 'version', version.version, 'displayName', version.display_name,
        'description', version.description, 'annualPriceMinor', version.annual_price_minor,
        'billingUnit', version.billing_unit, 'billingCycle', version.billing_cycle,
        'currency', version.currency, 'legacyFeatures', version.features,
        'entitlements', version.entitlements, 'settings', version.settings,
        'effectiveAt', version.effective_at,
        'publicationStatus', CASE
          WHEN version.publication_status = 'scheduled' AND version.effective_at <= now()
            THEN 'published'
          ELSE version.publication_status
        END
      ) ORDER BY version.version DESC)
      FROM public.petro_plan_versions version
      WHERE version.plan_id = plan.id
    ), '[]'::jsonb)
  ) ORDER BY plan.audience, plan.code), '[]'::jsonb)
  INTO plans_value
  FROM public.petro_plans plan;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', override.id, 'organizationId', override.organization_id,
    'organizationName', organization.name, 'branchId', override.branch_id,
    'branchName', branch.name, 'planId', override.plan_id, 'planName', plan.name,
    'priceMinor', override.price_minor,
    'standardPriceMinor', (
      SELECT version.annual_price_minor FROM public.petro_plan_versions version
      WHERE version.plan_id = override.plan_id
        AND version.publication_status IN ('published', 'scheduled')
        AND version.effective_at <= override.effective_from
      ORDER BY version.version DESC LIMIT 1
    ),
    'priority', CASE WHEN override.branch_id IS NULL THEN 'organization' ELSE 'branch' END,
    'effectiveFrom', override.effective_from, 'effectiveTo', override.effective_to,
    'reason', override.reason, 'approvedBy', override.approved_by,
    'approverName', approver.display_name,
    'previousOverrideId', override.supersedes_override_id,
    'previousPriceMinor', previous_override.price_minor,
    'createdAt', override.created_at
  ) ORDER BY override.created_at DESC), '[]'::jsonb)
  INTO overrides_value
  FROM public.petro_plan_price_overrides override
  JOIN public.petro_organizations organization ON organization.id = override.organization_id
  LEFT JOIN public.petro_branches branch
    ON branch.organization_id = override.organization_id AND branch.id = override.branch_id
  JOIN public.petro_plans plan ON plan.id = override.plan_id
  LEFT JOIN public.petro_profiles approver ON approver.user_id = override.approved_by
  LEFT JOIN public.petro_plan_price_overrides previous_override
    ON previous_override.id = override.supersedes_override_id;

  SELECT jsonb_build_object(
    'companyAnnualPricesMinor', company_annual_prices_minor,
    'providerAnnualPriceMinor', provider_annual_price_minor,
    'stationAnnualPriceMinor', 0,
    'nfcIssuePriceMinor', nfc_issue_price_minor,
    'currency', 'EGP', 'billingCycle', 'annual',
    'updatedAt', updated_at
  ) INTO settings_value
  FROM public.petro_billing_settings WHERE singleton_id = true;

  RETURN jsonb_build_object(
    'plans', plans_value,
    'requests', COALESCE(base_catalog -> 'requests', '[]'::jsonb),
    'subscriptions', COALESCE(base_catalog -> 'subscriptions', '[]'::jsonb),
    'pricingDefaults', settings_value,
    'priceOverrides', overrides_value
  );
END;
$$;

REVOKE ALL ON FUNCTION petro_private.plan_configuration_valid(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.petro_billing_admin_create_plan_v2(
  text, text, text, text, bigint, text, text, text, timestamptz, jsonb, jsonb, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.petro_billing_admin_add_plan_version_v2(
  uuid, text, text, bigint, text, text, text, timestamptz, jsonb, jsonb, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.petro_billing_admin_update_draft_version(
  uuid, uuid, text, text, bigint, text, text, text, timestamptz, jsonb, jsonb, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.petro_billing_admin_update_price_defaults(
  bigint[], bigint, bigint, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.petro_billing_admin_set_provider_price_override(
  uuid, uuid, uuid, bigint, timestamptz, timestamptz, uuid, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.petro_billing_admin_catalog_v2()
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.petro_billing_admin_create_plan_v2(
  text, text, text, text, bigint, text, text, text, timestamptz, jsonb, jsonb, text
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_billing_admin_add_plan_version_v2(
  uuid, text, text, bigint, text, text, text, timestamptz, jsonb, jsonb, text
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_billing_admin_update_draft_version(
  uuid, uuid, text, text, bigint, text, text, text, timestamptz, jsonb, jsonb, text
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_billing_admin_update_price_defaults(
  bigint[], bigint, bigint, text
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_billing_admin_set_provider_price_override(
  uuid, uuid, uuid, bigint, timestamptz, timestamptz, uuid, text
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_billing_admin_catalog_v2()
  TO authenticated;

COMMIT;
