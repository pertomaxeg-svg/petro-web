BEGIN;
CREATE OR REPLACE FUNCTION public.petro_fleet_reserve_usage(
  p_vehicle_id uuid, p_driver_link_id uuid, p_pair_verification_id uuid,
  p_merchant_organization_id uuid, p_merchant_branch_id uuid, p_service_group text,
  p_amount_minor bigint, p_quantity numeric, p_request_key text, p_reason text, p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_scope jsonb;
  v_org_id uuid;
  v_branch_id uuid;
  v_account_id uuid;
  v_finance_reservation_id uuid;
  v_usage_id uuid;
  v_existing public.petro_fleet_usage_reservations%ROWTYPE;
  v_hash text;
BEGIN
  IF coalesce(current_setting('request.jwt.claim.role',true),'')<>'service_role' OR p_actor_id IS NULL
    OR char_length(coalesce(p_request_key,'')) NOT BETWEEN 16 AND 120
    OR char_length(btrim(coalesce(p_reason,''))) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'FORBIDDEN_OR_INVALID_RESERVATION' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_key,0));
  v_hash := md5(concat_ws('|',p_vehicle_id,p_driver_link_id,p_pair_verification_id,
    p_merchant_organization_id,p_merchant_branch_id,p_service_group,p_amount_minor,p_quantity));
  SELECT * INTO v_existing FROM public.petro_fleet_usage_reservations u
    WHERE u.request_key=p_request_key FOR UPDATE;
  IF FOUND THEN
    IF v_existing.payload_hash<>v_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('id',v_existing.id,'status',v_existing.status,'replayed',true,
      'branchId',v_existing.branch_id,'amountMinor',v_existing.amount_minor);
  END IF;
  SELECT v.organization_id,v.branch_id INTO v_org_id,v_branch_id
    FROM public.petro_fleet_vehicles v
    WHERE v.id=p_vehicle_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VEHICLE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM public.petro_branches b WHERE b.id=v_branch_id FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM petro_private.petro_fleet_pair_verifications pv
    JOIN public.petro_fleet_driver_links l ON l.id=pv.link_id AND l.status='active'
    JOIN petro_private.petro_fleet_driver_pair_secrets s ON s.link_id=l.id AND s.active
    WHERE pv.id=p_pair_verification_id AND pv.link_id=p_driver_link_id
      AND pv.vehicle_id=p_vehicle_id AND pv.expires_at>now() AND pv.consumed_at IS NULL
  ) THEN RAISE EXCEPTION 'DRIVER_PAIR_VERIFICATION_REQUIRED' USING ERRCODE='42501'; END IF;
  v_scope := petro_private.fleet_check_usage_policy(
    p_vehicle_id,p_driver_link_id,p_merchant_organization_id,p_merchant_branch_id,
    p_service_group,p_amount_minor,p_quantity
  );
  IF coalesce((v_scope->>'allowed')::boolean,false)=false THEN
    RAISE EXCEPTION 'FLEET_POLICY_DENIED: %',coalesce(v_scope->>'reason','not_allowed')
      USING ERRCODE='23514';
  END IF;
  v_account_id := petro_private.finance_account_for_scope(v_org_id,v_branch_id);
  IF v_account_id IS NULL THEN RAISE EXCEPTION 'BRANCH_FUNDING_ACCOUNT_MISSING' USING ERRCODE='23514'; END IF;
  INSERT INTO public.petro_fleet_usage_reservations(
    organization_id,branch_id,vehicle_id,driver_link_id,service_group,
    merchant_organization_id,merchant_branch_id,amount_minor,quantity,
    request_key,payload_hash,vehicle_policy_version_id,branch_policy_version_id,created_by
  ) VALUES (
    v_org_id,v_branch_id,p_vehicle_id,p_driver_link_id,p_service_group,
    p_merchant_organization_id,p_merchant_branch_id,p_amount_minor,p_quantity,
    p_request_key,v_hash,(v_scope->>'vehiclePolicyVersionId')::uuid,
    (v_scope->>'branchPolicyVersionId')::uuid,p_actor_id
  ) RETURNING id INTO v_usage_id;
  v_finance_reservation_id := petro_private.finance_reserve_funds(
    v_account_id,'fleet_usage',v_usage_id,p_amount_minor,p_reason,p_actor_id
  );
  UPDATE public.petro_fleet_usage_reservations SET finance_reservation_id=v_finance_reservation_id
    WHERE id=v_usage_id;
  UPDATE petro_private.petro_fleet_pair_verifications SET consumed_at=now()
    WHERE id=p_pair_verification_id AND consumed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'DRIVER_PAIR_VERIFICATION_ALREADY_USED' USING ERRCODE='40001'; END IF;
  RETURN jsonb_build_object('id',v_usage_id,'status','reserved','replayed',false,
    'branchId',v_branch_id,'amountMinor',p_amount_minor,'financeReservationId',v_finance_reservation_id);
END
$$;
DROP FUNCTION petro_private.fleet_reserve_usage_core(uuid,uuid,uuid,uuid,uuid,text,bigint,numeric,text,text,uuid);
COMMIT;
