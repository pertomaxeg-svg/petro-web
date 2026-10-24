BEGIN;
CREATE TABLE petro_private.worker_pin_proofs(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 assignment_id uuid NOT NULL REFERENCES public.petro_worker_assignments(id) ON DELETE RESTRICT,
 assignment_version bigint NOT NULL CHECK(assignment_version>0),
 merchant_branch_id uuid NOT NULL REFERENCES public.petro_branches(id) ON DELETE RESTRICT,
 service_group text NOT NULL CHECK(service_group IN ('fuel','wash','oils','batteries','filters','parts','consumables')),
 credential_id uuid NOT NULL REFERENCES public.petro_vehicle_credentials(id) ON DELETE RESTRICT,
 vehicle_id uuid NOT NULL REFERENCES public.petro_fleet_vehicles(id) ON DELETE RESTRICT,
 company_branch_id uuid NOT NULL REFERENCES public.petro_branches(id) ON DELETE RESTRICT,
 link_id uuid NOT NULL REFERENCES public.petro_fleet_driver_links(id) ON DELETE RESTRICT,
 pin_secret_id uuid NOT NULL REFERENCES petro_private.petro_fleet_driver_pair_secrets(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 CHECK(expires_at>created_at)
);
CREATE INDEX worker_pin_proofs_actor_idx ON petro_private.worker_pin_proofs(actor_id,expires_at DESC);
CREATE TABLE petro_private.worker_pin_commands(
 actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 request_key text NOT NULL,
 payload_fingerprint text NOT NULL CHECK(payload_fingerprint ~ '^[0-9a-f]{64}$'),
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(actor_id,request_key)
);
ALTER TABLE petro_private.worker_pin_proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE petro_private.worker_pin_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON petro_private.worker_pin_proofs,petro_private.worker_pin_commands FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.petro_worker_credential_context(p_branch_id uuid,p_service_group text,p_credential_hash text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE vehicle_id uuid;
BEGIN
 IF p_service_group NOT IN ('fuel','wash','oils','batteries','filters','parts','consumables')
 OR p_service_group IS NULL OR NOT coalesce(petro_private.workforce_can_execute(auth.uid(),p_branch_id,p_service_group),false) THEN
 RAISE EXCEPTION 'FORBIDDEN_OPERATION_SCOPE' USING ERRCODE='42501'; END IF;
 IF p_credential_hash IS NULL OR p_credential_hash !~ '^[0-9a-f]{64}$' THEN
 RAISE EXCEPTION 'INVALID_CREDENTIAL_INPUT' USING ERRCODE='22023'; END IF;
 SELECT v.id INTO vehicle_id FROM public.petro_vehicle_credentials c
 JOIN public.petro_fleet_vehicles v ON v.id=c.vehicle_id AND v.status='active'
 JOIN public.petro_organizations o ON o.id=v.organization_id AND o.kind='company' AND o.approval_status='approved' AND o.operational_status='active'
 JOIN public.petro_branches b ON b.id=v.branch_id AND b.organization_id=o.id AND b.approval_status='approved' AND b.operational_status='active'
 WHERE c.token_sha256=p_credential_hash AND c.status='active';
 IF NOT FOUND THEN RETURN jsonb_build_object('recognized',false); END IF;
 -- Opaque identity for server-side HMAC computation only; never full fleet/driver/funding data.
 RETURN jsonb_build_object('recognized',true,'vehicleId',vehicle_id);
END $$;

CREATE FUNCTION petro_private.worker_pin_proof_valid(p_proof_id uuid,p_actor_id uuid,p_branch_id uuid,p_service_group text)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path='' AS $$
 SELECT p_actor_id=auth.uid() AND coalesce(petro_private.workforce_can_execute(p_actor_id,p_branch_id,p_service_group),false)
 AND EXISTS(
  SELECT 1 FROM petro_private.worker_pin_proofs proof
  JOIN public.petro_worker_assignments a ON a.id=proof.assignment_id AND a.user_id=proof.actor_id
    AND a.branch_id=proof.merchant_branch_id AND a.service_group=proof.service_group AND a.active AND a.version=proof.assignment_version
  JOIN public.petro_vehicle_credentials c ON c.id=proof.credential_id AND c.vehicle_id=proof.vehicle_id AND c.status='active'
  JOIN public.petro_fleet_vehicles v ON v.id=proof.vehicle_id AND v.branch_id=proof.company_branch_id AND v.status='active'
  JOIN public.petro_organizations o ON o.id=v.organization_id AND o.kind='company' AND o.approval_status='approved' AND o.operational_status='active'
  JOIN public.petro_branches b ON b.id=v.branch_id AND b.organization_id=o.id AND b.approval_status='approved' AND b.operational_status='active'
  JOIN public.petro_fleet_driver_links l ON l.id=proof.link_id AND l.vehicle_id=v.id AND l.status='active' AND l.starts_at<=clock_timestamp()
  JOIN public.petro_fleet_drivers d ON d.id=l.driver_id AND d.status='active'
  JOIN petro_private.petro_fleet_driver_pair_secrets secret ON secret.id=proof.pin_secret_id AND secret.link_id=l.id AND secret.vehicle_id=v.id AND secret.driver_id=d.id AND secret.active
  WHERE proof.id=p_proof_id AND proof.actor_id=p_actor_id AND proof.merchant_branch_id=p_branch_id
    AND proof.service_group=p_service_group AND proof.expires_at>clock_timestamp() AND proof.consumed_at IS NULL
 )
$$;
REVOKE ALL ON FUNCTION petro_private.worker_pin_proof_valid(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.petro_worker_pin_proof(p_proof_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE proof petro_private.worker_pin_proofs%ROWTYPE; result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT petro_private.workforce_user_active(auth.uid()) THEN
 RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
 SELECT * INTO proof FROM petro_private.worker_pin_proofs WHERE id=p_proof_id AND actor_id=auth.uid();
 IF NOT FOUND OR NOT coalesce(petro_private.worker_pin_proof_valid(proof.id,auth.uid(),proof.merchant_branch_id,proof.service_group),false) THEN
 RETURN jsonb_build_object('valid',false); END IF;
 SELECT jsonb_build_object('valid',true,'locked',false,'verificationId',proof.id,'expiresAt',proof.expires_at,
 'vehicle',jsonb_build_object('plate',v.plate_original,'brand',v.brand,'model',v.model,'fuelType',v.fuel_type,'tankCapacityLiters',v.tank_capacity_liters),
 'driverName',d.full_name) INTO result
 FROM public.petro_fleet_vehicles v JOIN public.petro_fleet_driver_links l ON l.id=proof.link_id
 JOIN public.petro_fleet_drivers d ON d.id=l.driver_id WHERE v.id=proof.vehicle_id;
 RETURN result;
END $$;

CREATE FUNCTION public.petro_worker_verify_pair(p_branch_id uuid,p_service_group text,p_credential_hash text,p_pin_hmac text,p_request_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 actor uuid:=auth.uid(); context jsonb; v_vehicle_id uuid; assignment public.petro_worker_assignments%ROWTYPE;
 credential_id uuid; receipt petro_private.worker_pin_commands%ROWTYPE; fingerprint text;
 limiter petro_private.petro_fleet_pair_rate_limits%ROWTYPE; attempts integer; window_started timestamptz; v_locked_until timestamptz;
 secret_row record; matched_secret uuid; matched_link uuid; supplied bytea; difference integer; byte_index integer;
 proof_id uuid; current_time_value timestamptz:=clock_timestamp(); result jsonb;
BEGIN
 context:=public.petro_worker_credential_context(p_branch_id,p_service_group,p_credential_hash);
 IF p_pin_hmac IS NULL OR p_pin_hmac !~ '^[0-9a-f]{64}$'
 OR p_request_key IS NULL OR char_length(btrim(p_request_key)) NOT BETWEEN 16 AND 120 THEN
 RAISE EXCEPTION 'INVALID_PAIR_INPUT' USING ERRCODE='22023'; END IF;
 fingerprint:=encode(sha256(convert_to(jsonb_build_array(p_branch_id,p_service_group,p_credential_hash,p_pin_hmac)::text,'UTF8')),'hex');
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor::text||':'||p_request_key,0));
 SELECT * INTO receipt FROM petro_private.worker_pin_commands WHERE actor_id=actor AND request_key=p_request_key;
 IF FOUND THEN
  IF receipt.payload_fingerprint<>fingerprint THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='40001'; END IF;
  IF receipt.result->>'valid'='true' THEN RETURN public.petro_worker_pin_proof((receipt.result->>'verificationId')::uuid); END IF;
  RETURN receipt.result;
 END IF;
 IF context->>'recognized'<>'true' THEN
  result:=jsonb_build_object('valid',false,'locked',false);
 ELSE
  v_vehicle_id:=(context->>'vehicleId')::uuid;
  SELECT * INTO assignment FROM public.petro_worker_assignments a
   WHERE a.user_id=actor AND a.branch_id=p_branch_id AND a.service_group=p_service_group AND a.active FOR SHARE;
  IF NOT FOUND OR NOT coalesce(petro_private.workforce_can_execute(actor,p_branch_id,p_service_group),false) THEN
   RAISE EXCEPTION 'FORBIDDEN_OPERATION_SCOPE' USING ERRCODE='42501'; END IF;
  SELECT c.id INTO credential_id FROM public.petro_vehicle_credentials c WHERE c.vehicle_id=v_vehicle_id AND c.token_sha256=p_credential_hash AND c.status='active';
  IF NOT FOUND THEN result:=jsonb_build_object('valid',false,'locked',false);
  ELSE
   INSERT INTO petro_private.petro_fleet_pair_rate_limits(vehicle_id) VALUES(v_vehicle_id) ON CONFLICT DO NOTHING;
   SELECT * INTO limiter FROM petro_private.petro_fleet_pair_rate_limits r WHERE r.vehicle_id=v_vehicle_id FOR UPDATE;
   current_time_value:=clock_timestamp();
   IF limiter.locked_until>current_time_value THEN
    result:=jsonb_build_object('valid',false,'locked',true,'retryAt',limiter.locked_until);
   ELSE
    attempts:=limiter.failed_attempts;window_started:=limiter.window_started_at;v_locked_until:=NULL;
    IF window_started+interval '15 minutes'<=current_time_value THEN attempts:=0;window_started:=current_time_value; END IF;
    supplied:=decode(p_pin_hmac,'hex');
    FOR secret_row IN
     SELECT s.id,s.pin_hmac,l.id AS link_id FROM petro_private.petro_fleet_driver_pair_secrets s
     JOIN public.petro_fleet_driver_links l ON l.id=s.link_id AND l.vehicle_id=s.vehicle_id AND l.driver_id=s.driver_id AND l.status='active' AND l.starts_at<=current_time_value
     JOIN public.petro_fleet_drivers d ON d.id=l.driver_id AND d.status='active'
     WHERE s.vehicle_id=v_vehicle_id AND s.active
    LOOP
     difference:=0;
     FOR byte_index IN 0..31 LOOP difference:=difference | (get_byte(secret_row.pin_hmac,byte_index) # get_byte(supplied,byte_index)); END LOOP;
     IF difference=0 THEN matched_secret:=secret_row.id;matched_link:=secret_row.link_id; END IF;
    END LOOP;
    IF matched_secret IS NOT NULL THEN
     UPDATE petro_private.petro_fleet_pair_rate_limits r SET failed_attempts=0,window_started_at=current_time_value,locked_until=NULL,updated_at=current_time_value WHERE r.vehicle_id=v_vehicle_id;
     INSERT INTO petro_private.worker_pin_proofs(actor_id,assignment_id,assignment_version,merchant_branch_id,service_group,credential_id,vehicle_id,company_branch_id,link_id,pin_secret_id,created_at,expires_at)
     VALUES(actor,assignment.id,assignment.version,p_branch_id,p_service_group,credential_id,v_vehicle_id,(SELECT branch_id FROM public.petro_fleet_vehicles WHERE id=v_vehicle_id),matched_link,matched_secret,current_time_value,current_time_value+interval '2 minutes')
     RETURNING id INTO proof_id;
     result:=public.petro_worker_pin_proof(proof_id);
    ELSE
     attempts:=least(5,attempts+1);
     IF attempts>=5 THEN v_locked_until:=current_time_value+interval '15 minutes'; END IF;
     UPDATE petro_private.petro_fleet_pair_rate_limits r SET failed_attempts=attempts,window_started_at=window_started,locked_until=v_locked_until,updated_at=current_time_value WHERE r.vehicle_id=v_vehicle_id;
     result:=jsonb_build_object('valid',false,'locked',v_locked_until IS NOT NULL,'retryAt',v_locked_until);
    END IF;
   END IF;
  END IF;
 END IF;
 INSERT INTO petro_private.worker_pin_commands(actor_id,request_key,payload_fingerprint,result) VALUES(actor,p_request_key,fingerprint,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.petro_worker_credential_context(uuid,text,text),public.petro_worker_pin_proof(uuid),
 public.petro_worker_verify_pair(uuid,text,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.petro_worker_credential_context(uuid,text,text),public.petro_worker_pin_proof(uuid),
 public.petro_worker_verify_pair(uuid,text,text,text,text) TO authenticated;
COMMIT;
