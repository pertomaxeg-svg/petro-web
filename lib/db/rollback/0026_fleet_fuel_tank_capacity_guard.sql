BEGIN;

DO $fuel_tank_guard_rollback$
DECLARE
  definition text;
  guarded_select text := 'SELECT v.organization_id,v.branch_id,v.tank_capacity_liters INTO v_organization_id,v_branch_id,v_tank_capacity';
  original_select text := 'SELECT v.organization_id,v.branch_id INTO v_organization_id,v_branch_id';
  guard text := E'\n  IF p_service_group=''fuel'' AND v_tank_capacity IS NOT NULL AND p_quantity>v_tank_capacity THEN\n    RETURN jsonb_build_object(''allowed'',false,''reason'',''fuel_tank_capacity_exceeded'');\n  END IF;';
BEGIN
  definition := pg_catalog.pg_get_functiondef(
    'petro_private.fleet_check_usage_policy_at(uuid,uuid,uuid,uuid,text,bigint,numeric,timestamptz)'::regprocedure
  );
  IF strpos(definition, guarded_select)=0 OR strpos(definition, guard)=0
     OR strpos(definition, E'\n  v_tank_capacity numeric;')=0 THEN
    RAISE EXCEPTION '0026 rollback evaluator differs from reviewed source';
  END IF;
  definition := replace(definition, guarded_select, original_select);
  definition := replace(definition, guard, '');
  definition := replace(definition, E'\n  v_tank_capacity numeric;', '');
  EXECUTE definition;
END
$fuel_tank_guard_rollback$;

COMMIT;
