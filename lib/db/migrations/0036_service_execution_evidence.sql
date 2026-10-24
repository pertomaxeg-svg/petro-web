BEGIN;
CREATE TABLE petro_private.service_documentation_rules(
 service_group text NOT NULL CHECK(service_group IN('fuel','wash','oils','parts','batteries','filters','consumables')),
 version integer NOT NULL CHECK(version>0),effective_at timestamptz NOT NULL DEFAULT now(),
 odometer_required boolean NOT NULL,wash_before_required boolean NOT NULL,wash_after_required boolean NOT NULL,serial_required boolean NOT NULL,
 source text NOT NULL DEFAULT 'engineering_reference_v3',PRIMARY KEY(service_group,version)
);
INSERT INTO petro_private.service_documentation_rules(service_group,version,odometer_required,wash_before_required,wash_after_required,serial_required)
SELECT s,1,s IN('fuel','oils'),s='wash',s='wash',false FROM unnest(ARRAY['fuel','wash','oils','parts','batteries','filters','consumables'])s;
CREATE TABLE petro_private.service_order_executions(
 order_id uuid PRIMARY KEY REFERENCES public.petro_service_orders(id) ON DELETE RESTRICT,
 rule_snapshot jsonb NOT NULL CHECK(jsonb_typeof(rule_snapshot)='object'),
 started_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 started_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE petro_private.service_order_evidence(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid NOT NULL REFERENCES public.petro_service_orders(id) ON DELETE RESTRICT,
 uploader_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 kind text NOT NULL CHECK(kind IN('odometer','wash_before','wash_after','serial')),
 file_name text NOT NULL CHECK(char_length(file_name) BETWEEN 1 AND 160),
 content_type text NOT NULL CHECK(content_type IN('image/png','image/jpeg')),
 byte_size bigint NOT NULL CHECK(byte_size BETWEEN 1 AND 10485760),
 object_path text NOT NULL UNIQUE,status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','accepted')),
 upload_expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '20 minutes',
 storage_object_id uuid,accepted_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((status='pending' AND storage_object_id IS NULL AND accepted_at IS NULL) OR(status='accepted' AND storage_object_id IS NOT NULL AND accepted_at IS NOT NULL))
);
CREATE INDEX service_order_evidence_order ON petro_private.service_order_evidence(order_id,kind,status);
CREATE TABLE petro_private.service_order_deliveries(
 order_id uuid PRIMARY KEY REFERENCES public.petro_service_orders(id) ON DELETE RESTRICT,
 actual_quantity numeric(20,3) NOT NULL CHECK(actual_quantity>0),actual_amount_minor bigint NOT NULL CHECK(actual_amount_minor>0),
 unit_price_minor numeric NOT NULL CHECK(unit_price_minor>0),
 odometer_event_id uuid REFERENCES public.petro_vehicle_odometer_events(id) ON DELETE RESTRICT,
 serial_number text CHECK(serial_number IS NULL OR char_length(serial_number) BETWEEN 1 AND 120),
 identity_current boolean NOT NULL,performed_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 performed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE petro_private.service_order_commands ADD COLUMN evidence_id uuid REFERENCES petro_private.service_order_evidence(id) ON DELETE RESTRICT;
ALTER TABLE petro_private.service_order_commands DROP CONSTRAINT service_order_commands_action_check;
ALTER TABLE petro_private.service_order_commands ADD CONSTRAINT service_order_commands_action_check CHECK(action IN('reserve','cancel','start','deliver','evidence.create','evidence.finalize'));
ALTER TABLE petro_private.service_order_events DROP CONSTRAINT service_order_events_kind_check;
ALTER TABLE petro_private.service_order_events ADD CONSTRAINT service_order_events_kind_check CHECK(kind IN('reserved','cancelled','expiry_failed','started','delivered'));
ALTER TABLE petro_private.service_documentation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE petro_private.service_order_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE petro_private.service_order_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE petro_private.service_order_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON petro_private.service_documentation_rules,petro_private.service_order_executions,petro_private.service_order_evidence,petro_private.service_order_deliveries FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION petro_private.guard_service_execution_history() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Service execution history is immutable' USING ERRCODE='55000'; END $$;
REVOKE ALL ON FUNCTION petro_private.guard_service_execution_history() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER documentation_rules_immutable BEFORE UPDATE OR DELETE ON petro_private.service_documentation_rules FOR EACH ROW EXECUTE FUNCTION petro_private.guard_service_execution_history();
CREATE TRIGGER order_execution_immutable BEFORE UPDATE OR DELETE ON petro_private.service_order_executions FOR EACH ROW EXECUTE FUNCTION petro_private.guard_service_execution_history();
CREATE TRIGGER order_delivery_immutable BEFORE UPDATE OR DELETE ON petro_private.service_order_deliveries FOR EACH ROW EXECUTE FUNCTION petro_private.guard_service_execution_history();
CREATE FUNCTION petro_private.guard_service_evidence_history() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.status='accepted' OR (to_jsonb(NEW)-ARRAY['status','accepted_at','storage_object_id']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['status','accepted_at','storage_object_id'])
 OR NEW.status<>'accepted' OR NEW.storage_object_id IS NULL OR NEW.accepted_at IS NULL THEN RAISE EXCEPTION 'Service evidence is immutable' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION petro_private.guard_service_evidence_history() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER order_evidence_immutable BEFORE UPDATE OR DELETE ON petro_private.service_order_evidence FOR EACH ROW EXECUTE FUNCTION petro_private.guard_service_evidence_history();

CREATE FUNCTION petro_private.service_order_worker_current(p_order_id uuid) RETURNS boolean LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path='' AS $$
 SELECT coalesce(petro_private.workforce_user_active(auth.uid()),false) AND EXISTS(
 SELECT 1 FROM public.petro_service_orders o WHERE o.id=p_order_id AND o.created_by=auth.uid()
 AND coalesce(petro_private.workforce_can_execute(auth.uid(),o.merchant_branch_id,o.service_group),false))
$$;
CREATE FUNCTION petro_private.service_order_identity_current(p_order_id uuid) RETURNS boolean LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path='' AS $$
 SELECT coalesce(petro_private.service_order_worker_current(p_order_id),false) AND EXISTS(
 SELECT 1 FROM public.petro_service_orders o
 JOIN petro_private.worker_pin_proofs p ON p.id=o.first_proof_id AND p.actor_id=o.created_by AND p.vehicle_id=o.vehicle_id AND p.link_id=o.driver_link_id AND p.consumed_at IS NOT NULL
 JOIN public.petro_worker_assignments a ON a.id=p.assignment_id AND a.version=p.assignment_version AND a.active
 JOIN public.petro_vehicle_credentials c ON c.id=p.credential_id AND c.vehicle_id=o.vehicle_id AND c.status='active'
 JOIN public.petro_fleet_vehicles v ON v.id=o.vehicle_id AND v.organization_id=o.company_organization_id AND v.branch_id=o.company_branch_id AND v.status='active'
 JOIN public.petro_organizations company ON company.id=o.company_organization_id AND company.approval_status='approved' AND company.operational_status='active'
 JOIN public.petro_branches b ON b.id=o.company_branch_id AND b.organization_id=company.id AND b.approval_status='approved' AND b.operational_status='active'
 JOIN public.petro_fleet_driver_links l ON l.id=p.link_id AND l.vehicle_id=v.id AND l.status='active' AND l.starts_at<=clock_timestamp()
 JOIN public.petro_fleet_drivers d ON d.id=l.driver_id AND d.status='active'
 JOIN petro_private.petro_fleet_driver_pair_secrets s ON s.id=p.pin_secret_id AND s.link_id=l.id AND s.vehicle_id=v.id AND s.driver_id=d.id AND s.active
 WHERE o.id=p_order_id)
$$;
CREATE FUNCTION petro_private.service_order_documentation_rule(p_order_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE o public.petro_service_orders%ROWTYPE;r petro_private.service_documentation_rules%ROWTYPE;stored jsonb;serial boolean;
BEGIN
 SELECT rule_snapshot INTO stored FROM petro_private.service_order_executions WHERE order_id=p_order_id;
 IF FOUND THEN RETURN stored; END IF;
 SELECT * INTO STRICT o FROM public.petro_service_orders WHERE id=p_order_id;
 SELECT * INTO STRICT r FROM petro_private.service_documentation_rules WHERE service_group=o.service_group AND effective_at<=now() ORDER BY version DESC LIMIT 1;
 SELECT coalesce(attributes->'serialRequired'='true'::jsonb,false) INTO serial FROM public.petro_catalog_items WHERE id=o.catalog_item_id;
 RETURN jsonb_build_object('version',r.version,'serviceGroup',r.service_group,'odometerRequired',r.odometer_required,'washBeforeRequired',r.wash_before_required,'washAfterRequired',r.wash_after_required,'serialRequired',r.serial_required OR coalesce(serial,false));
END $$;
REVOKE ALL ON FUNCTION petro_private.service_order_worker_current(uuid),petro_private.service_order_identity_current(uuid),petro_private.service_order_documentation_rule(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION petro_private.can_access_service_order_evidence(p_object_path text,p_action text) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(petro_private.workforce_user_active(auth.uid()),false) AND EXISTS(
 SELECT 1 FROM petro_private.service_order_evidence e JOIN public.petro_service_orders o ON o.id=e.order_id WHERE e.object_path=p_object_path AND(
 (p_action='read' AND coalesce(petro_private.service_order_readable(o.id),false) AND(e.status='accepted' OR e.uploader_id=auth.uid()))
 OR(p_action='upload' AND e.uploader_id=auth.uid() AND e.status='pending' AND e.upload_expires_at>clock_timestamp()
 AND coalesce(petro_private.service_order_worker_current(o.id),false)
 AND(o.status='reserved' AND o.expires_at>clock_timestamp() OR o.status='in_progress')
 AND(e.kind<>'wash_before' OR o.status='reserved') AND(e.kind<>'wash_after' OR o.status='in_progress'))))
$$;
REVOKE ALL ON FUNCTION petro_private.can_access_service_order_evidence(text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION petro_private.can_access_service_order_evidence(text,text) TO authenticated;
CREATE POLICY petro_order_evidence_select ON storage.objects FOR SELECT TO authenticated USING(bucket_id='petro-private-documents' AND petro_private.can_access_service_order_evidence(name,'read'));
CREATE POLICY petro_order_evidence_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK(bucket_id='petro-private-documents' AND petro_private.can_access_service_order_evidence(name,'upload'));

CREATE FUNCTION public.petro_service_order_execution(p_order_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o public.petro_service_orders%ROWTYPE;r jsonb;delivery jsonb;
BEGIN
 IF NOT coalesce(petro_private.service_order_readable(p_order_id),false) THEN RAISE EXCEPTION 'FORBIDDEN_ORDER' USING ERRCODE='42501'; END IF;
 SELECT * INTO STRICT o FROM public.petro_service_orders WHERE id=p_order_id;
 r:=petro_private.service_order_documentation_rule(o.id);
 SELECT jsonb_build_object('actualQuantity',trim_scale(d.actual_quantity)::text,'actualAmountMinor',d.actual_amount_minor::text,'serialNumber',d.serial_number,'identityCurrent',d.identity_current,'performedAt',d.performed_at,'odometerEventId',d.odometer_event_id,
 'readingKm',(SELECT trim_scale(reading_km)::text FROM public.petro_vehicle_odometer_events WHERE id=d.odometer_event_id),
 'odometerStatus',(SELECT status FROM public.petro_vehicle_odometer_events WHERE id=d.odometer_event_id)) INTO delivery FROM petro_private.service_order_deliveries d WHERE d.order_id=o.id;
 RETURN petro_private.service_order_view(o.id)||jsonb_build_object('documentationRule',r,'delivery',delivery,
 'canStart',o.status='reserved' AND o.expires_at>clock_timestamp() AND coalesce(petro_private.service_order_identity_current(o.id),false),
 'canDeliver',o.status='in_progress' AND coalesce(petro_private.service_order_worker_current(o.id),false),
 'evidence',coalesce((SELECT jsonb_agg(jsonb_build_object('id',e.id,'kind',e.kind,'fileName',e.file_name,'contentType',e.content_type,'byteSize',e.byte_size,'status',e.status,'createdAt',e.created_at,'acceptedAt',e.accepted_at) ORDER BY e.created_at,e.id)
 FROM petro_private.service_order_evidence e WHERE e.order_id=o.id AND(e.status='accepted' OR e.uploader_id=auth.uid())),'[]'::jsonb));
END $$;

CREATE FUNCTION public.petro_service_order_evidence_file(p_evidence_id uuid,p_action text DEFAULT 'read') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE e petro_private.service_order_evidence%ROWTYPE;
BEGIN
 SELECT * INTO e FROM petro_private.service_order_evidence WHERE id=p_evidence_id;
 IF NOT FOUND OR p_action NOT IN('read','upload') OR NOT coalesce(petro_private.can_access_service_order_evidence(e.object_path,p_action),false) THEN RAISE EXCEPTION 'FORBIDDEN_EVIDENCE' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('id',e.id,'orderId',e.order_id,'bucket','petro-private-documents','objectPath',e.object_path,'contentType',e.content_type,'byteSize',e.byte_size,'status',e.status);
END $$;
CREATE FUNCTION public.petro_create_service_order_evidence(p_order_id uuid,p_kind text,p_file_name text,p_content_type text,p_byte_size bigint,p_request_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o public.petro_service_orders%ROWTYPE;e petro_private.service_order_evidence%ROWTYPE;c petro_private.service_order_commands%ROWTYPE;fingerprint text;
BEGIN
 IF NOT coalesce(petro_private.service_order_worker_current(p_order_id),false) THEN RAISE EXCEPTION 'FORBIDDEN_ORDER' USING ERRCODE='42501'; END IF;
 IF p_kind IS NULL OR p_kind NOT IN('odometer','wash_before','wash_after','serial') OR p_file_name IS NULL OR char_length(p_file_name) NOT BETWEEN 1 AND 160 OR p_content_type IS NULL OR p_content_type NOT IN('image/png','image/jpeg')
 OR p_byte_size IS NULL OR p_byte_size NOT BETWEEN 1 AND 10485760 OR p_request_key IS NULL OR p_request_key!~'^[A-Za-z0-9._:-]{16,120}$' THEN RAISE EXCEPTION 'INVALID_EVIDENCE_INPUT' USING ERRCODE='22023'; END IF;
 fingerprint:=encode(sha256(convert_to(jsonb_build_array('evidence.create',p_order_id,p_kind,p_file_name,p_content_type,p_byte_size)::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('service-order:'||auth.uid()::text||':'||p_request_key,0));
 SELECT * INTO c FROM petro_private.service_order_commands WHERE actor_id=auth.uid() AND request_key=p_request_key;
 IF FOUND THEN
 IF c.action<>'evidence.create' OR c.payload_fingerprint<>fingerprint THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='23505'; END IF;
 RETURN public.petro_service_order_evidence_file(c.evidence_id,'read');
 END IF;
 SELECT * INTO o FROM public.petro_service_orders WHERE id=p_order_id FOR UPDATE;
 IF o.status NOT IN('reserved','in_progress') OR(o.status='reserved' AND o.expires_at<=clock_timestamp())
 OR(p_kind='wash_before' AND o.status<>'reserved') OR(p_kind='wash_after' AND o.status<>'in_progress') THEN RAISE EXCEPTION 'ORDER_EVIDENCE_PHASE' USING ERRCODE='55000'; END IF;
 IF(SELECT count(*) FROM petro_private.service_order_evidence WHERE order_id=o.id)>=30 THEN RAISE EXCEPTION 'ORDER_EVIDENCE_LIMIT' USING ERRCODE='23514'; END IF;
 INSERT INTO petro_private.service_order_evidence(order_id,uploader_id,kind,file_name,content_type,byte_size,object_path)
 VALUES(o.id,auth.uid(),p_kind,p_file_name,p_content_type,p_byte_size,'orders/'||o.id::text||'/'||gen_random_uuid()::text) RETURNING * INTO e;
 INSERT INTO petro_private.service_order_commands(actor_id,request_key,action,payload_fingerprint,order_id,evidence_id) VALUES(auth.uid(),p_request_key,'evidence.create',fingerprint,o.id,e.id);
 RETURN public.petro_service_order_evidence_file(e.id,'upload');
END $$;
CREATE FUNCTION public.petro_finalize_service_order_evidence(p_evidence_id uuid,p_request_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE e petro_private.service_order_evidence%ROWTYPE;o public.petro_service_orders%ROWTYPE;object_row storage.objects%ROWTYPE;c petro_private.service_order_commands%ROWTYPE;fingerprint text;
BEGIN
 SELECT * INTO e FROM petro_private.service_order_evidence WHERE id=p_evidence_id;
 IF NOT FOUND OR e.uploader_id IS DISTINCT FROM auth.uid() OR NOT coalesce(petro_private.service_order_worker_current(e.order_id),false) THEN RAISE EXCEPTION 'FORBIDDEN_EVIDENCE' USING ERRCODE='42501'; END IF;
 IF p_request_key IS NULL OR p_request_key!~'^[A-Za-z0-9._:-]{16,120}$' THEN RAISE EXCEPTION 'INVALID_EVIDENCE_INPUT' USING ERRCODE='22023'; END IF;
 fingerprint:=encode(sha256(convert_to(jsonb_build_array('evidence.finalize',p_evidence_id)::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('service-order:'||auth.uid()::text||':'||p_request_key,0));
 SELECT * INTO c FROM petro_private.service_order_commands WHERE actor_id=auth.uid() AND request_key=p_request_key;
 IF FOUND THEN
 IF c.action<>'evidence.finalize' OR c.payload_fingerprint<>fingerprint THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='23505'; END IF;
 RETURN public.petro_service_order_evidence_file(e.id,'read');
 END IF;
 SELECT * INTO o FROM public.petro_service_orders WHERE id=e.order_id FOR UPDATE;
 SELECT * INTO e FROM petro_private.service_order_evidence WHERE id=p_evidence_id FOR UPDATE;
 IF e.status='accepted' THEN RETURN public.petro_service_order_evidence_file(e.id,'read'); END IF;
 IF NOT coalesce(petro_private.can_access_service_order_evidence(e.object_path,'upload'),false) THEN RAISE EXCEPTION 'ORDER_EVIDENCE_PHASE' USING ERRCODE='55000'; END IF;
 SELECT * INTO object_row FROM storage.objects WHERE bucket_id='petro-private-documents' AND name=e.object_path;
 IF NOT FOUND OR object_row.owner_id::text IS DISTINCT FROM auth.uid()::text
 OR coalesce(object_row.metadata->>'size','')!~'^[0-9]+$' OR(object_row.metadata->>'size')::numeric<>e.byte_size
 OR object_row.metadata->>'mimetype' IS DISTINCT FROM e.content_type THEN RAISE EXCEPTION 'EVIDENCE_UPLOAD_UNVERIFIED' USING ERRCODE='23514'; END IF;
 UPDATE petro_private.service_order_evidence SET status='accepted',storage_object_id=object_row.id,accepted_at=clock_timestamp() WHERE id=e.id;
 INSERT INTO petro_private.service_order_commands(actor_id,request_key,action,payload_fingerprint,order_id,evidence_id) VALUES(auth.uid(),p_request_key,'evidence.finalize',fingerprint,e.order_id,e.id);
 RETURN public.petro_service_order_evidence_file(e.id,'read');
END $$;

CREATE FUNCTION public.petro_start_service_order(p_order_id uuid,p_expected_version bigint,p_request_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o public.petro_service_orders%ROWTYPE;c petro_private.service_order_commands%ROWTYPE;r jsonb;fingerprint text;merchant_kind text;
BEGIN
 IF NOT coalesce(petro_private.service_order_worker_current(p_order_id),false) THEN RAISE EXCEPTION 'FORBIDDEN_ORDER' USING ERRCODE='42501'; END IF;
 IF p_expected_version IS NULL OR p_expected_version<1 OR p_request_key IS NULL OR p_request_key!~'^[A-Za-z0-9._:-]{16,120}$' THEN RAISE EXCEPTION 'INVALID_EXECUTION_INPUT' USING ERRCODE='22023'; END IF;
 fingerprint:=encode(sha256(convert_to(jsonb_build_array('start',p_order_id,p_expected_version)::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('service-order:'||auth.uid()::text||':'||p_request_key,0));
 SELECT * INTO c FROM petro_private.service_order_commands WHERE actor_id=auth.uid() AND request_key=p_request_key;
 IF FOUND THEN
 IF c.action<>'start' OR c.payload_fingerprint<>fingerprint THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='23505'; END IF;
 RETURN public.petro_service_order_execution(c.order_id);
 END IF;
 SELECT * INTO o FROM public.petro_service_orders WHERE id=p_order_id FOR UPDATE;
 IF o.version<>p_expected_version THEN RAISE EXCEPTION 'ORDER_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
 IF o.status<>'reserved' OR o.started_at IS NOT NULL OR o.expires_at<=clock_timestamp() OR o.payment_status<>'held' THEN RAISE EXCEPTION 'ORDER_NOT_STARTABLE' USING ERRCODE='55000'; END IF;
 PERFORM 1 FROM public.petro_fleet_vehicles WHERE id=o.vehicle_id FOR UPDATE;
 PERFORM 1 FROM public.petro_branches WHERE id=o.company_branch_id FOR UPDATE;
 PERFORM 1 FROM public.petro_worker_assignments a JOIN petro_private.worker_pin_proofs p ON p.assignment_id=a.id WHERE p.id=o.first_proof_id FOR SHARE OF a;
 PERFORM 1 FROM public.petro_vehicle_credentials c1 JOIN petro_private.worker_pin_proofs p ON p.credential_id=c1.id WHERE p.id=o.first_proof_id FOR SHARE OF c1;
 PERFORM 1 FROM public.petro_fleet_driver_links WHERE id=o.driver_link_id FOR SHARE;
 PERFORM 1 FROM petro_private.petro_fleet_driver_pair_secrets s JOIN petro_private.worker_pin_proofs p ON p.pin_secret_id=s.id WHERE p.id=o.first_proof_id FOR SHARE OF s;
 IF NOT coalesce(petro_private.service_order_identity_current(o.id),false) THEN RAISE EXCEPTION 'ORDER_IDENTITY_CHANGED' USING ERRCODE='42501'; END IF;
 SELECT kind INTO merchant_kind FROM public.petro_organizations WHERE id=o.merchant_organization_id;
 IF merchant_kind='provider' AND NOT coalesce(petro_private.subscription_allows_new_service(o.merchant_organization_id,o.merchant_branch_id),false) THEN RAISE EXCEPTION 'PROVIDER_SUBSCRIPTION_REQUIRED' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.petro_subscription_vehicle_assignments a JOIN public.petro_subscriptions s ON s.id=a.subscription_id WHERE a.vehicle_id=o.vehicle_id AND a.status='active' AND a.starts_at<=clock_timestamp() AND(a.ends_at IS NULL OR a.ends_at>clock_timestamp()) AND s.status='active' AND s.starts_at<=clock_timestamp() AND s.ends_at>clock_timestamp() AND(s.cancellation_effective_at IS NULL OR s.cancellation_effective_at>clock_timestamp())) THEN RAISE EXCEPTION 'SUBSCRIPTION_COVERAGE_REQUIRED' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.petro_fleet_usage_reservations u JOIN public.petro_finance_reservations f ON f.id=u.finance_reservation_id WHERE u.id=o.usage_reservation_id AND u.status='reserved' AND f.status='active' AND f.amount_minor=o.amount_minor) THEN RAISE EXCEPTION 'ORDER_HOLD_REQUIRES_REVIEW' USING ERRCODE='55000'; END IF;
 r:=petro_private.service_order_documentation_rule(o.id);
 IF(r->>'washBeforeRequired')::boolean AND NOT EXISTS(SELECT 1 FROM petro_private.service_order_evidence WHERE order_id=o.id AND kind='wash_before' AND status='accepted') THEN RAISE EXCEPTION 'WASH_BEFORE_REQUIRED' USING ERRCODE='23514'; END IF;
 INSERT INTO petro_private.service_order_executions(order_id,rule_snapshot,started_by) VALUES(o.id,r,auth.uid());
 UPDATE public.petro_service_orders SET status='in_progress',started_at=clock_timestamp(),updated_at=clock_timestamp(),version=version+1 WHERE id=o.id;
 INSERT INTO petro_private.service_order_events(order_id,order_version,kind,actor_id,detail) VALUES(o.id,o.version+1,'started',auth.uid(),jsonb_build_object('documentationRule',r));
 INSERT INTO petro_private.service_order_commands(actor_id,request_key,action,payload_fingerprint,order_id) VALUES(auth.uid(),p_request_key,'start',fingerprint,o.id);
 RETURN public.petro_service_order_execution(o.id);
END $$;

CREATE FUNCTION public.petro_deliver_service_order(p_order_id uuid,p_expected_version bigint,p_input jsonb,p_request_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o public.petro_service_orders%ROWTYPE;c petro_private.service_order_commands%ROWTYPE;r jsonb;fingerprint text;q numeric;amount bigint;reading numeric;serial text;odo_id uuid;odo_status text:='accepted';identity_ok boolean;
 stock public.petro_inventory_reservations%ROWTYPE;previous_stock numeric;
BEGIN
 IF NOT coalesce(petro_private.service_order_worker_current(p_order_id),false) THEN RAISE EXCEPTION 'FORBIDDEN_ORDER' USING ERRCODE='42501'; END IF;
 IF p_expected_version IS NULL OR p_expected_version<1 OR p_request_key IS NULL OR p_request_key!~'^[A-Za-z0-9._:-]{16,120}$' OR jsonb_typeof(p_input) IS DISTINCT FROM 'object'
 OR(p_input-ARRAY['actualQuantity','readingKm','serialNumber'])<>'{}'::jsonb OR coalesce(p_input->>'actualQuantity','')!~'^[0-9]{1,9}(\.[0-9]{1,3})?$'
 OR(p_input->>'readingKm' IS NOT NULL AND(p_input->>'readingKm')!~'^[0-9]{1,11}(\.[0-9]{1,3})?$') OR char_length(coalesce(p_input->>'serialNumber',''))>120 THEN RAISE EXCEPTION 'INVALID_EXECUTION_INPUT' USING ERRCODE='22023'; END IF;
 fingerprint:=encode(sha256(convert_to(jsonb_build_array('deliver',p_order_id,p_expected_version,p_input)::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('service-order:'||auth.uid()::text||':'||p_request_key,0));
 SELECT * INTO c FROM petro_private.service_order_commands WHERE actor_id=auth.uid() AND request_key=p_request_key;
 IF FOUND THEN
 IF c.action<>'deliver' OR c.payload_fingerprint<>fingerprint THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='23505'; END IF;
 RETURN public.petro_service_order_execution(c.order_id);
 END IF;
 SELECT * INTO o FROM public.petro_service_orders WHERE id=p_order_id FOR UPDATE;
 IF o.version<>p_expected_version THEN RAISE EXCEPTION 'ORDER_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
 IF o.status<>'in_progress' OR o.started_at IS NULL OR o.payment_status<>'held' THEN RAISE EXCEPTION 'ORDER_NOT_DELIVERABLE' USING ERRCODE='55000'; END IF;
 PERFORM 1 FROM public.petro_fleet_vehicles WHERE id=o.vehicle_id FOR UPDATE;
 PERFORM 1 FROM public.petro_branches WHERE id=o.company_branch_id FOR UPDATE;
 q:=(p_input->>'actualQuantity')::numeric;
 IF q<=0 OR q>o.quantity OR round(q,(o.item_snapshot->>'quantityScale')::integer)<>q THEN RAISE EXCEPTION 'DELIVERY_EXCEEDS_AUTHORIZATION' USING ERRCODE='23514'; END IF;
 amount:=round(q*(o.item_snapshot->>'unitPriceMinor')::numeric)::bigint;
 IF amount<1 OR amount>o.amount_minor THEN RAISE EXCEPTION 'DELIVERY_EXCEEDS_AUTHORIZATION' USING ERRCODE='23514'; END IF;
 r:=petro_private.service_order_documentation_rule(o.id);reading:=nullif(p_input->>'readingKm','')::numeric;serial:=nullif(btrim(p_input->>'serialNumber'),'');
 IF (r->>'odometerRequired')::boolean AND reading IS NULL THEN RAISE EXCEPTION 'ODOMETER_REQUIRED' USING ERRCODE='23514'; END IF;
 IF reading IS NOT NULL AND NOT EXISTS(SELECT 1 FROM petro_private.service_order_evidence WHERE order_id=o.id AND kind='odometer' AND status='accepted') THEN RAISE EXCEPTION 'ODOMETER_IMAGE_REQUIRED' USING ERRCODE='23514'; END IF;
 IF (r->>'washAfterRequired')::boolean AND NOT EXISTS(SELECT 1 FROM petro_private.service_order_evidence WHERE order_id=o.id AND kind='wash_after' AND status='accepted') THEN RAISE EXCEPTION 'WASH_AFTER_REQUIRED' USING ERRCODE='23514'; END IF;
 IF (r->>'serialRequired')::boolean AND(serial IS NULL OR NOT EXISTS(SELECT 1 FROM petro_private.service_order_evidence WHERE order_id=o.id AND kind='serial' AND status='accepted')) THEN RAISE EXCEPTION 'SERIAL_EVIDENCE_REQUIRED' USING ERRCODE='23514'; END IF;
 identity_ok:=coalesce(petro_private.service_order_identity_current(o.id),false);
 IF reading IS NOT NULL THEN
 IF EXISTS(SELECT 1 FROM public.petro_vehicle_odometer_events WHERE vehicle_id=o.vehicle_id AND status='accepted' AND reading_km>reading) THEN odo_status:='pending_review'; END IF;
 INSERT INTO public.petro_vehicle_odometer_events(organization_id,branch_id,vehicle_id,reading_km,recorded_at,status,source,reason,created_by)
 SELECT organization_id,branch_id,id,reading,clock_timestamp(),odo_status,'service_order','قراءة عداد أثناء تنفيذ طلب خدمة '||o.id::text,auth.uid() FROM public.petro_fleet_vehicles WHERE id=o.vehicle_id RETURNING id INTO odo_id;
 END IF;
 IF o.inventory_reservation_id IS NOT NULL THEN
 SELECT * INTO STRICT stock FROM public.petro_inventory_reservations WHERE id=o.inventory_reservation_id FOR UPDATE;
 IF stock.status<>'reserved' OR stock.quantity<>o.quantity OR stock.source_reference<>o.id OR stock.location_id<>o.inventory_location_id OR stock.item_id<>o.catalog_item_id THEN RAISE EXCEPTION 'ORDER_STOCK_REQUIRES_REVIEW' USING ERRCODE='55000'; END IF;
 previous_stock:=stock.quantity;
 IF q<previous_stock THEN PERFORM petro_private.inventory_apply_delta(stock.organization_id,stock.location_id,stock.item_id,0,-(previous_stock-q),NULL,stock.id,'release','تحرير كمية غير منفذة من طلب خدمة '||o.id::text); END IF;
 PERFORM petro_private.inventory_apply_delta(stock.organization_id,stock.location_id,stock.item_id,-q,-q,NULL,stock.id,'consume','صرف فعلي لطلب خدمة '||o.id::text);
 UPDATE public.petro_inventory_reservations SET quantity=q,status='consumed',completed_at=clock_timestamp(),completed_by=auth.uid(),completed_by_system=NULL WHERE id=stock.id;
 END IF;
 INSERT INTO petro_private.service_order_deliveries(order_id,actual_quantity,actual_amount_minor,unit_price_minor,odometer_event_id,serial_number,identity_current,performed_by)
 VALUES(o.id,q,amount,(o.item_snapshot->>'unitPriceMinor')::numeric,odo_id,serial,identity_ok,auth.uid());
 UPDATE public.petro_service_orders SET status=CASE WHEN identity_ok AND odo_status='accepted' THEN 'delivered' ELSE 'review_required' END,delivered_at=clock_timestamp(),updated_at=clock_timestamp(),version=version+1 WHERE id=o.id;
 INSERT INTO petro_private.service_order_events(order_id,order_version,kind,actor_id,detail)
 VALUES(o.id,o.version+1,'delivered',auth.uid(),jsonb_build_object('actualQuantity',trim_scale(q)::text,'actualAmountMinor',amount::text,'bookedQuantity',trim_scale(o.quantity)::text,'bookedAmountMinor',o.amount_minor::text,'identityCurrent',identity_ok,'odometerStatus',CASE WHEN reading IS NOT NULL THEN odo_status END,'physicalStockIssued',o.kind='product'));
 INSERT INTO petro_private.service_order_commands(actor_id,request_key,action,payload_fingerprint,order_id) VALUES(auth.uid(),p_request_key,'deliver',fingerprint,o.id);
 RETURN public.petro_service_order_execution(o.id);
END $$;
REVOKE ALL ON FUNCTION public.petro_service_order_execution(uuid),public.petro_service_order_evidence_file(uuid,text),public.petro_create_service_order_evidence(uuid,text,text,text,bigint,text),public.petro_finalize_service_order_evidence(uuid,text),public.petro_start_service_order(uuid,bigint,text),public.petro_deliver_service_order(uuid,bigint,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.petro_service_order_execution(uuid),public.petro_service_order_evidence_file(uuid,text),public.petro_create_service_order_evidence(uuid,text,text,text,bigint,text),public.petro_finalize_service_order_evidence(uuid,text),public.petro_start_service_order(uuid,bigint,text),public.petro_deliver_service_order(uuid,bigint,jsonb,text) TO authenticated;
COMMIT;
