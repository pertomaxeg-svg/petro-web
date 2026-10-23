BEGIN;

-- Zero means "not configured" for monthly and period-quantity caps. Existing
-- positive values retain their current meaning; no records are rewritten.
ALTER TABLE public.petro_fleet_policy_versions
  DROP CONSTRAINT IF EXISTS petro_fleet_policy_versions_monthly_amount_limit_minor_check,
  DROP CONSTRAINT IF EXISTS petro_fleet_policy_versions_daily_quantity_limit_check,
  DROP CONSTRAINT IF EXISTS petro_fleet_policy_versions_weekly_quantity_limit_check,
  DROP CONSTRAINT IF EXISTS petro_fleet_policy_versions_monthly_quantity_limit_check,
  ADD CONSTRAINT petro_fleet_policy_versions_monthly_amount_limit_minor_check
    CHECK (monthly_amount_limit_minor >= 0),
  ADD CONSTRAINT petro_fleet_policy_versions_daily_quantity_limit_check
    CHECK (daily_quantity_limit >= 0),
  ADD CONSTRAINT petro_fleet_policy_versions_weekly_quantity_limit_check
    CHECK (weekly_quantity_limit >= 0),
  ADD CONSTRAINT petro_fleet_policy_versions_monthly_quantity_limit_check
    CHECK (monthly_quantity_limit >= 0);

ALTER TABLE public.petro_fleet_policy_rules
  DROP CONSTRAINT IF EXISTS petro_fleet_policy_rules_enabled_limits_check,
  ADD CONSTRAINT petro_fleet_policy_rules_enabled_limits_check CHECK (
    NOT enabled OR (
      max_operation_minor > 0
      AND max_operation_quantity > 0
      AND daily_amount_limit_minor > 0
      AND weekly_amount_limit_minor > 0
      AND monthly_amount_limit_minor >= 0
      AND daily_quantity_limit >= 0
      AND weekly_quantity_limit >= 0
      AND monthly_quantity_limit >= 0
    )
  );

DO $fleet_onboarding_limit_contract$
DECLARE
  reserve_definition text;
  summaries_definition text;
  target text;
  replacement text;
  pair text[];
  replacements text[][] := ARRAY[
    ARRAY['v_month_amount+p_amount_minor>v_vehicle_policy.monthly_amount_limit_minor','(v_vehicle_policy.monthly_amount_limit_minor>0 AND v_month_amount+p_amount_minor>v_vehicle_policy.monthly_amount_limit_minor)'],
    ARRAY['v_day_quantity+p_quantity>v_vehicle_policy.daily_quantity_limit','(v_vehicle_policy.daily_quantity_limit>0 AND v_day_quantity+p_quantity>v_vehicle_policy.daily_quantity_limit)'],
    ARRAY['v_week_quantity+p_quantity>v_vehicle_policy.weekly_quantity_limit','(v_vehicle_policy.weekly_quantity_limit>0 AND v_week_quantity+p_quantity>v_vehicle_policy.weekly_quantity_limit)'],
    ARRAY['v_month_quantity+p_quantity>v_vehicle_policy.monthly_quantity_limit','(v_vehicle_policy.monthly_quantity_limit>0 AND v_month_quantity+p_quantity>v_vehicle_policy.monthly_quantity_limit)'],
    ARRAY['v_month_amount+p_amount_minor>v_branch_policy.monthly_amount_limit_minor','(v_branch_policy.monthly_amount_limit_minor>0 AND v_month_amount+p_amount_minor>v_branch_policy.monthly_amount_limit_minor)'],
    ARRAY['v_day_quantity+p_quantity>v_branch_policy.daily_quantity_limit','(v_branch_policy.daily_quantity_limit>0 AND v_day_quantity+p_quantity>v_branch_policy.daily_quantity_limit)'],
    ARRAY['v_week_quantity+p_quantity>v_branch_policy.weekly_quantity_limit','(v_branch_policy.weekly_quantity_limit>0 AND v_week_quantity+p_quantity>v_branch_policy.weekly_quantity_limit)'],
    ARRAY['v_month_quantity+p_quantity>v_branch_policy.monthly_quantity_limit','(v_branch_policy.monthly_quantity_limit>0 AND v_month_quantity+p_quantity>v_branch_policy.monthly_quantity_limit)'],
    ARRAY['v_month_amount+p_amount_minor>v_vehicle_rule.monthly_amount_limit_minor','(v_vehicle_rule.monthly_amount_limit_minor>0 AND v_month_amount+p_amount_minor>v_vehicle_rule.monthly_amount_limit_minor)'],
    ARRAY['v_day_quantity+p_quantity>v_vehicle_rule.daily_quantity_limit','(v_vehicle_rule.daily_quantity_limit>0 AND v_day_quantity+p_quantity>v_vehicle_rule.daily_quantity_limit)'],
    ARRAY['v_week_quantity+p_quantity>v_vehicle_rule.weekly_quantity_limit','(v_vehicle_rule.weekly_quantity_limit>0 AND v_week_quantity+p_quantity>v_vehicle_rule.weekly_quantity_limit)'],
    ARRAY['v_month_quantity+p_quantity>v_vehicle_rule.monthly_quantity_limit','(v_vehicle_rule.monthly_quantity_limit>0 AND v_month_quantity+p_quantity>v_vehicle_rule.monthly_quantity_limit)'],
    ARRAY['v_month_amount+p_amount_minor>v_branch_rule.monthly_amount_limit_minor','(v_branch_rule.monthly_amount_limit_minor>0 AND v_month_amount+p_amount_minor>v_branch_rule.monthly_amount_limit_minor)'],
    ARRAY['v_day_quantity+p_quantity>v_branch_rule.daily_quantity_limit','(v_branch_rule.daily_quantity_limit>0 AND v_day_quantity+p_quantity>v_branch_rule.daily_quantity_limit)'],
    ARRAY['v_week_quantity+p_quantity>v_branch_rule.weekly_quantity_limit','(v_branch_rule.weekly_quantity_limit>0 AND v_week_quantity+p_quantity>v_branch_rule.weekly_quantity_limit)'],
    ARRAY['v_month_quantity+p_quantity>v_branch_rule.monthly_quantity_limit','(v_branch_rule.monthly_quantity_limit>0 AND v_month_quantity+p_quantity>v_branch_rule.monthly_quantity_limit)']
  ];
BEGIN
  reserve_definition := pg_catalog.pg_get_functiondef(
    'public.petro_fleet_reserve_usage(uuid,uuid,uuid,uuid,uuid,text,bigint,numeric,text,text,uuid)'::regprocedure
  );
  FOREACH pair SLICE 1 IN ARRAY replacements LOOP
    target := pair[1];
    replacement := pair[2];
    IF pg_catalog.strpos(reserve_definition, target) = 0 THEN
      RAISE EXCEPTION '0025 could not locate optional-limit check: %', target;
    END IF;
    reserve_definition := pg_catalog.replace(reserve_definition, target, replacement);
  END LOOP;
  EXECUTE reserve_definition;

  summaries_definition := pg_catalog.pg_get_functiondef(
    'public.petro_admin_fleet_company_summaries(uuid,text,integer,integer)'::regprocedure
  );
  IF pg_catalog.strpos(
      summaries_definition,
      '''nfcIssuePriceMinor'', issue_price, ''onboardingCapabilitiesVersion'', 2'
    ) = 0 THEN
    RAISE EXCEPTION '0025 could not locate fleet onboarding capability metadata';
  END IF;
  summaries_definition := pg_catalog.replace(
    summaries_definition,
    '''nfcIssuePriceMinor'', issue_price, ''onboardingCapabilitiesVersion'', 2',
    '''nfcIssuePriceMinor'', issue_price, ''onboardingCapabilitiesVersion'', 3'
  );
  EXECUTE summaries_definition;
END
$fleet_onboarding_limit_contract$;

COMMIT;
