BEGIN;

-- Compare against the stored capacity at authorization time. Legacy vehicles
-- without a recorded capacity keep their existing policy limits.
DO $fuel_tank_guard$
DECLARE
  definition text;
  original_select text := 'SELECT v.organization_id,v.branch_id INTO v_organization_id,v_branch_id';
  guarded_select text := 'SELECT v.organization_id,v.branch_id,v.tank_capacity_liters INTO v_organization_id,v_branch_id,v_tank_capacity';
  anchor text := 'IF NOT FOUND THEN RETURN jsonb_build_object(''allowed'',false,''reason'',''vehicle_not_active''); END IF;';
  guard text := E'\n  IF p_service_group=''fuel'' AND v_tank_capacity IS NOT NULL AND p_quantity>v_tank_capacity THEN\n    RETURN jsonb_build_object(''allowed'',false,''reason'',''fuel_tank_capacity_exceeded'');\n  END IF;';
BEGIN
  definition := pg_catalog.pg_get_functiondef(
    'petro_private.fleet_check_usage_policy_at(uuid,uuid,uuid,uuid,text,bigint,numeric,timestamptz)'::regprocedure
  );
  IF strpos(definition, 'v_tank_capacity')>0
     OR strpos(definition, original_select)=0
     OR strpos(definition, anchor)=0
     OR strpos(definition, 'v_branch_id uuid;')=0 THEN
    RAISE EXCEPTION '0026 evaluator contract differs from reviewed source';
  END IF;
  definition := replace(definition, 'v_branch_id uuid;', E'v_branch_id uuid;\n  v_tank_capacity numeric;');
  definition := replace(definition, original_select, guarded_select);
  definition := replace(definition, anchor, anchor||guard);
  EXECUTE definition;
END
$fuel_tank_guard$;

COMMIT;
