BEGIN;
CREATE TABLE public.petro_service_orders(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
 company_branch_id uuid NOT NULL,
 merchant_organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
 merchant_branch_id uuid NOT NULL,
 created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 vehicle_id uuid NOT NULL,
 driver_link_id uuid NOT NULL REFERENCES public.petro_fleet_driver_links(id) ON DELETE RESTRICT,
 first_proof_id uuid NOT NULL UNIQUE REFERENCES petro_private.worker_pin_proofs(id) ON DELETE RESTRICT,
 service_group text NOT NULL CHECK(service_group IN('fuel','wash','oils','batteries','filters','parts','consumables')),
 kind text NOT NULL CHECK(kind IN('fuel','service','product')),
 fuel_type_id uuid REFERENCES public.petro_fuel_types(id) ON DELETE RESTRICT,
 catalog_item_id uuid,
 fuel_price_version_id uuid REFERENCES public.petro_fuel_price_versions(id) ON DELETE RESTRICT,
 catalog_price_version_id uuid REFERENCES public.petro_catalog_price_versions(id) ON DELETE RESTRICT,
 inventory_location_id uuid,
 inventory_reservation_id uuid UNIQUE REFERENCES public.petro_inventory_reservations(id) ON DELETE RESTRICT,
 usage_reservation_id uuid NOT NULL UNIQUE REFERENCES public.petro_fleet_usage_reservations(id) ON DELETE RESTRICT,
 quantity numeric(20,3) NOT NULL CHECK(quantity>0),
 amount_minor bigint NOT NULL CHECK(amount_minor BETWEEN 1 AND 1000000000000),
 currency text NOT NULL DEFAULT 'EGP' CHECK(currency='EGP'),
 item_snapshot jsonb NOT NULL CHECK(jsonb_typeof(item_snapshot)='object'),
 vehicle_snapshot jsonb NOT NULL CHECK(jsonb_typeof(vehicle_snapshot)='object'),
 merchant_snapshot jsonb NOT NULL CHECK(jsonb_typeof(merchant_snapshot)='object'),
 status text NOT NULL DEFAULT 'reserved' CHECK(status IN('reserved','in_progress','delivered','review_required','cancelled')),
 payment_status text NOT NULL DEFAULT 'held' CHECK(payment_status IN('held','unpaid','paid')),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 captured_entry_id uuid REFERENCES public.petro_finance_journal_entries(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 started_at timestamptz,
 delivered_at timestamptz,
 cancelled_at timestamptz,
 cancelled_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
 cancelled_by_system text,
 cancel_code text CHECK(cancel_code IN('operator_cancelled','reservation_expired')),
 expiry_attempts integer NOT NULL DEFAULT 0 CHECK(expiry_attempts BETWEEN 0 AND 5),
 expiry_next_at timestamptz,
 last_expiry_error_code text CHECK(last_expiry_error_code IS NULL OR last_expiry_error_code ~ '^[0-9A-Z]{5}$'),
 FOREIGN KEY(company_branch_id,company_organization_id) REFERENCES public.petro_branches(id,organization_id) ON DELETE RESTRICT,
 FOREIGN KEY(merchant_branch_id,merchant_organization_id) REFERENCES public.petro_branches(id,organization_id) ON DELETE RESTRICT,
 FOREIGN KEY(vehicle_id,company_organization_id) REFERENCES public.petro_fleet_vehicles(id,organization_id) ON DELETE RESTRICT,
 FOREIGN KEY(catalog_item_id,merchant_organization_id) REFERENCES public.petro_catalog_items(id,organization_id) ON DELETE RESTRICT,
 FOREIGN KEY(inventory_location_id,merchant_organization_id) REFERENCES public.petro_inventory_locations(id,organization_id) ON DELETE RESTRICT,
 CHECK((kind='fuel')=(service_group='fuel')),
 CHECK((kind='fuel' AND fuel_type_id IS NOT NULL AND fuel_price_version_id IS NOT NULL AND catalog_item_id IS NULL AND catalog_price_version_id IS NULL AND inventory_location_id IS NULL AND inventory_reservation_id IS NULL)
 OR(kind='service' AND catalog_item_id IS NOT NULL AND catalog_price_version_id IS NOT NULL AND fuel_type_id IS NULL AND fuel_price_version_id IS NULL AND inventory_location_id IS NULL AND inventory_reservation_id IS NULL)
 OR(kind='product' AND catalog_item_id IS NOT NULL AND catalog_price_version_id IS NOT NULL AND fuel_type_id IS NULL AND fuel_price_version_id IS NULL AND inventory_location_id IS NOT NULL AND inventory_reservation_id IS NOT NULL)),
 CHECK(expires_at>created_at),
 CHECK((payment_status='paid')=(captured_entry_id IS NOT NULL)),
 CHECK(payment_status<>'paid' OR status IN('delivered','review_required')),
 CHECK(status<>'reserved' OR (started_at IS NULL AND delivered_at IS NULL AND payment_status='held')),
 CHECK(status NOT IN('in_progress','delivered') OR started_at IS NOT NULL),
 CHECK(status<>'delivered' OR delivered_at IS NOT NULL),
 CHECK((status<>'cancelled' AND cancelled_at IS NULL AND cancelled_by IS NULL AND cancelled_by_system IS NULL AND cancel_code IS NULL)
 OR(status='cancelled' AND started_at IS NULL AND payment_status='unpaid' AND cancelled_at IS NOT NULL AND cancel_code IS NOT NULL
 AND((cancelled_by IS NOT NULL AND cancelled_by_system IS NULL)
 OR(cancelled_by IS NULL AND cancelled_by_system IS NOT NULL AND cancelled_by_system='service_order_expiry'))))
);
CREATE INDEX petro_service_orders_actor_time ON public.petro_service_orders(created_by,created_at DESC,id);
CREATE INDEX petro_service_orders_merchant_status ON public.petro_service_orders(merchant_branch_id,status,created_at DESC,id);
CREATE INDEX petro_service_orders_company_time ON public.petro_service_orders(company_organization_id,company_branch_id,created_at DESC,id);
CREATE INDEX petro_service_orders_expiry ON public.petro_service_orders(expires_at,expiry_next_at,id) WHERE status='reserved' AND started_at IS NULL;
CREATE TABLE petro_private.service_order_commands(
 actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 request_key text NOT NULL CHECK(char_length(request_key) BETWEEN 16 AND 120),
 action text NOT NULL CHECK(action IN('reserve','cancel')),
 payload_fingerprint text NOT NULL CHECK(payload_fingerprint ~ '^[0-9a-f]{64}$'),
 order_id uuid NOT NULL REFERENCES public.petro_service_orders(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(actor_id,request_key)
);
CREATE TABLE petro_private.service_order_events(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 order_id uuid NOT NULL REFERENCES public.petro_service_orders(id) ON DELETE RESTRICT,
 order_version bigint NOT NULL CHECK(order_version>0),
 kind text NOT NULL CHECK(kind IN('reserved','cancelled','expiry_failed')),
 actor_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
 system_actor text,
 detail jsonb NOT NULL CHECK(jsonb_typeof(detail)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((actor_id IS NOT NULL AND system_actor IS NULL)
 OR(actor_id IS NULL AND system_actor IS NOT NULL AND system_actor='service_order_expiry'))
);
CREATE INDEX service_order_events_order ON petro_private.service_order_events(order_id,id);
REVOKE ALL ON SEQUENCE petro_private.service_order_events_id_seq FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE public.petro_service_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE petro_private.service_order_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE petro_private.service_order_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.petro_service_orders,petro_private.service_order_commands,petro_private.service_order_events FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION petro_private.guard_service_order_event() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Service order events are immutable' USING ERRCODE='55000'; END $$;
REVOKE ALL ON FUNCTION petro_private.guard_service_order_event() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER service_order_events_immutable BEFORE UPDATE OR DELETE ON petro_private.service_order_events FOR EACH ROW EXECUTE FUNCTION petro_private.guard_service_order_event();

CREATE FUNCTION petro_private.service_order_central(p_write boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 SELECT coalesce(petro_private.workforce_user_active(auth.uid()),false)
 AND petro_private.platform_has(CASE WHEN p_write THEN ARRAY['owner','operations','finance']::text[] ELSE ARRAY['owner','operations','finance','auditor']::text[] END)
$$;
CREATE FUNCTION petro_private.service_order_readable(p_order_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 SELECT coalesce(petro_private.workforce_user_active(auth.uid()),false) AND EXISTS(
 SELECT 1 FROM public.petro_service_orders o WHERE o.id=p_order_id AND(
 petro_private.service_order_central(false) OR(o.created_by=auth.uid() AND coalesce(petro_private.workforce_can_execute(auth.uid(),o.merchant_branch_id,o.service_group),false))))
$$;
CREATE FUNCTION petro_private.service_order_view(p_order_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 SELECT jsonb_build_object('id',o.id,'status',o.status,'paymentStatus',o.payment_status,'version',o.version,'serviceGroup',o.service_group,'kind',o.kind,
 'quantity',trim_scale(o.quantity)::text,'amountMinor',o.amount_minor::text,'currency',o.currency,
 'itemSnapshot',o.item_snapshot,'vehicleSnapshot',o.vehicle_snapshot,'merchantSnapshot',o.merchant_snapshot,
 'createdAt',o.created_at,'expiresAt',o.expires_at,'startedAt',o.started_at,'cancelledAt',o.cancelled_at,'cancelCode',o.cancel_code,
 'cancelledByKind',CASE WHEN o.cancelled_by_system IS NOT NULL THEN 'system' WHEN o.cancelled_by IS NOT NULL THEN 'user' ELSE NULL END,
 'requiresReview',o.status='review_required','expiryAttempts',o.expiry_attempts,
 'canCancel',o.status IN('reserved','review_required') AND o.started_at IS NULL AND o.payment_status='held' AND(
 petro_private.service_order_central(true) OR(o.created_by=auth.uid() AND coalesce(petro_private.workforce_can_execute(auth.uid(),o.merchant_branch_id,o.service_group),false))))
 FROM public.petro_service_orders o WHERE o.id=p_order_id
$$;
REVOKE ALL ON FUNCTION petro_private.service_order_central(boolean),petro_private.service_order_readable(uuid),petro_private.service_order_view(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.petro_worker_reserve_service_order(p_proof_id uuid,p_reference_id uuid,p_price_version_id uuid,p_input jsonb,p_location_id uuid,p_request_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid:=auth.uid(); v_fingerprint text; v_command petro_private.service_order_commands%ROWTYPE;
 v_proof petro_private.worker_pin_proofs%ROWTYPE; v_quote jsonb; v_usage jsonb; v_usage_row public.petro_fleet_usage_reservations%ROWTYPE;
 v_vehicle public.petro_fleet_vehicles%ROWTYPE; v_order_id uuid:=gen_random_uuid(); v_stock_id uuid; v_kind text; v_quantity numeric; v_amount bigint;
 v_vehicle_snapshot jsonb; v_merchant_snapshot jsonb;
BEGIN
 IF NOT coalesce(petro_private.workforce_user_active(v_actor),false) THEN RAISE EXCEPTION 'FORBIDDEN_OPERATION' USING ERRCODE='42501'; END IF;
 IF p_proof_id IS NULL OR p_reference_id IS NULL OR p_price_version_id IS NULL OR jsonb_typeof(p_input) IS DISTINCT FROM 'object'
 OR p_request_key IS NULL OR p_request_key !~ '^[A-Za-z0-9._:-]{16,120}$' THEN RAISE EXCEPTION 'INVALID_ORDER_INPUT' USING ERRCODE='22023'; END IF;
 v_fingerprint:=encode(sha256(convert_to(jsonb_build_array('reserve',p_proof_id,p_reference_id,p_price_version_id,p_input,p_location_id)::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('service-order:'||v_actor::text||':'||p_request_key,0));
 SELECT * INTO v_command FROM petro_private.service_order_commands c WHERE c.actor_id=v_actor AND c.request_key=p_request_key FOR UPDATE;
 IF FOUND THEN
  IF v_command.action<>'reserve' OR v_command.payload_fingerprint<>v_fingerprint THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='23505'; END IF;
  IF NOT coalesce(petro_private.service_order_readable(v_command.order_id),false) THEN RAISE EXCEPTION 'FORBIDDEN_ORDER' USING ERRCODE='42501'; END IF;
  RETURN petro_private.service_order_view(v_command.order_id);
 END IF;
 SELECT * INTO v_proof FROM petro_private.worker_pin_proofs p WHERE p.id=p_proof_id AND p.actor_id=v_actor FOR UPDATE;
 IF NOT FOUND OR NOT coalesce(petro_private.worker_pin_proof_valid(v_proof.id,v_actor,v_proof.merchant_branch_id,v_proof.service_group),false) THEN
 RAISE EXCEPTION 'OPERATIONAL_PROOF_REQUIRED' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.petro_worker_assignments a WHERE a.id=v_proof.assignment_id AND a.version=v_proof.assignment_version AND a.active FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'FORBIDDEN_OPERATION_SCOPE' USING ERRCODE='42501'; END IF;
 v_quote:=public.petro_worker_quote_service(p_proof_id,p_reference_id,p_price_version_id,p_input,p_location_id);
 IF NOT coalesce((v_quote->>'canReserve')::boolean,false) THEN RAISE EXCEPTION 'SERVICE_NOT_RESERVABLE: %',coalesce(v_quote->>'denialCode','not_allowed') USING ERRCODE='23514'; END IF;
 v_kind:=v_quote->'item'->>'kind';v_quantity:=(v_quote->>'quantity')::numeric;v_amount:=(v_quote->>'amountMinor')::bigint;
 v_usage:=petro_private.fleet_reserve_usage_core(v_proof.vehicle_id,v_proof.link_id,v_proof.id,
 (SELECT organization_id FROM public.petro_branches WHERE id=v_proof.merchant_branch_id),v_proof.merchant_branch_id,v_proof.service_group,v_amount,v_quantity,
 'service-order:'||v_order_id::text,'حجز طلب خدمة '||v_order_id::text,v_actor);
 SELECT * INTO STRICT v_usage_row FROM public.petro_fleet_usage_reservations WHERE id=(v_usage->>'id')::uuid;
 IF v_kind='product' THEN
  PERFORM 1 FROM public.petro_inventory_locations l WHERE l.id=p_location_id AND l.organization_id=v_usage_row.merchant_organization_id AND l.branch_id=v_usage_row.merchant_branch_id AND l.active AND l.location_kind='sellable' FOR SHARE;
  IF NOT FOUND OR NOT coalesce(petro_private.inventory_validate_item(v_usage_row.merchant_organization_id,p_reference_id,v_quantity),false) THEN RAISE EXCEPTION 'INVENTORY_ITEM_UNAVAILABLE' USING ERRCODE='23514'; END IF;
  v_stock_id:=gen_random_uuid();
  INSERT INTO public.petro_inventory_reservations(id,organization_id,location_id,item_id,source_reference,quantity,idempotency_key,payload_hash,created_by)
  VALUES(v_stock_id,v_usage_row.merchant_organization_id,p_location_id,p_reference_id,v_order_id,v_quantity,'service-order:'||v_order_id::text,md5(jsonb_build_array(v_order_id,p_reference_id,p_location_id,v_quantity)::text),v_actor);
  PERFORM petro_private.inventory_apply_delta(v_usage_row.merchant_organization_id,p_location_id,p_reference_id,0,v_quantity,NULL,v_stock_id,'reserve','حجز مخزون لطلب خدمة '||v_order_id::text);
 END IF;
 IF NOT coalesce(petro_private.worker_pin_proof_valid(v_proof.id,v_actor,v_proof.merchant_branch_id,v_proof.service_group),false) THEN RAISE EXCEPTION 'OPERATIONAL_PROOF_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT * INTO STRICT v_vehicle FROM public.petro_fleet_vehicles WHERE id=v_proof.vehicle_id;
 SELECT jsonb_build_object('plate',v_vehicle.plate_original,'brand',v_vehicle.brand,'model',v_vehicle.model,'driverName',d.full_name)
 INTO v_vehicle_snapshot FROM public.petro_fleet_driver_links l JOIN public.petro_fleet_drivers d ON d.id=l.driver_id WHERE l.id=v_proof.link_id;
 SELECT jsonb_build_object('organizationName',o.name,'branchName',b.name) INTO v_merchant_snapshot FROM public.petro_branches b JOIN public.petro_organizations o ON o.id=b.organization_id WHERE b.id=v_proof.merchant_branch_id;
 INSERT INTO public.petro_service_orders(id,company_organization_id,company_branch_id,merchant_organization_id,merchant_branch_id,created_by,vehicle_id,driver_link_id,first_proof_id,service_group,kind,
 fuel_type_id,catalog_item_id,fuel_price_version_id,catalog_price_version_id,inventory_location_id,inventory_reservation_id,usage_reservation_id,quantity,amount_minor,item_snapshot,vehicle_snapshot,merchant_snapshot,expires_at)
 VALUES(v_order_id,v_usage_row.organization_id,v_usage_row.branch_id,v_usage_row.merchant_organization_id,v_usage_row.merchant_branch_id,v_actor,v_proof.vehicle_id,v_proof.link_id,v_proof.id,v_proof.service_group,v_kind,
 CASE WHEN v_kind='fuel' THEN p_reference_id END,CASE WHEN v_kind<>'fuel' THEN p_reference_id END,
 CASE WHEN v_kind='fuel' THEN p_price_version_id END,CASE WHEN v_kind<>'fuel' THEN p_price_version_id END,p_location_id,v_stock_id,v_usage_row.id,v_quantity,v_amount,
 v_quote->'item',v_vehicle_snapshot,v_merchant_snapshot,clock_timestamp()+interval '15 minutes');
 UPDATE petro_private.worker_pin_proofs SET consumed_at=clock_timestamp() WHERE id=v_proof.id AND consumed_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'OPERATIONAL_PROOF_ALREADY_USED' USING ERRCODE='40001'; END IF;
 INSERT INTO petro_private.service_order_events(order_id,order_version,kind,actor_id,detail) VALUES(v_order_id,1,'reserved',v_actor,jsonb_build_object('amountMinor',v_amount::text,'quantity',trim_scale(v_quantity)::text,'vehiclePolicyVersionId',v_usage_row.vehicle_policy_version_id,'branchPolicyVersionId',v_usage_row.branch_policy_version_id));
 INSERT INTO petro_private.service_order_commands(actor_id,request_key,action,payload_fingerprint,order_id) VALUES(v_actor,p_request_key,'reserve',v_fingerprint,v_order_id);
 RETURN petro_private.service_order_view(v_order_id);
END $$;
CREATE FUNCTION public.petro_service_orders_query(p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_view text;v_id uuid;v_page integer;v_size integer;v_status text;v_search text;v_total bigint;v_items jsonb;v_central boolean;
BEGIN
 IF NOT coalesce(petro_private.workforce_user_active(auth.uid()),false) THEN RAISE EXCEPTION 'FORBIDDEN_ORDER' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_filters) IS DISTINCT FROM 'object' OR (p_filters-ARRAY['view','orderId','page','pageSize','status','search']::text[])<>'{}'::jsonb THEN RAISE EXCEPTION 'INVALID_ORDER_FILTER' USING ERRCODE='22023'; END IF;
 v_view:=coalesce(p_filters->>'view','mine');
 IF v_view NOT IN('mine','central') THEN RAISE EXCEPTION 'INVALID_ORDER_VIEW' USING ERRCODE='22023'; END IF;
 v_central:=v_view='central';
 IF v_central AND NOT coalesce(petro_private.service_order_central(false),false) THEN RAISE EXCEPTION 'FORBIDDEN_ORDER' USING ERRCODE='42501'; END IF;
 v_id:=nullif(p_filters->>'orderId','')::uuid;
 IF v_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.petro_service_orders WHERE id=v_id) THEN RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF NOT coalesce(petro_private.service_order_readable(v_id),false) THEN RAISE EXCEPTION 'FORBIDDEN_ORDER' USING ERRCODE='42501'; END IF;
  RETURN petro_private.service_order_view(v_id)||jsonb_build_object('timeline',coalesce((
   SELECT jsonb_agg(jsonb_build_object('id',e.id::text,'kind',e.kind,'version',e.order_version,'createdAt',e.created_at,
    'actorKind',CASE WHEN e.system_actor IS NOT NULL THEN 'system' ELSE 'user' END,
    'actorName',CASE WHEN e.system_actor IS NOT NULL THEN 'النظام' ELSE coalesce(nullif(p.display_name,''),'مستخدم مخول') END,
    'detail',e.detail) ORDER BY e.id)
   FROM(SELECT * FROM petro_private.service_order_events WHERE order_id=v_id ORDER BY id DESC LIMIT 100)e
   LEFT JOIN public.petro_profiles p ON p.user_id=e.actor_id),'[]'::jsonb));
 END IF;
 v_page:=coalesce((p_filters->>'page')::integer,1);v_size:=coalesce((p_filters->>'pageSize')::integer,20);
 v_status:=nullif(p_filters->>'status','');v_search:=nullif(btrim(p_filters->>'search'),'');
 IF v_page NOT BETWEEN 1 AND 100000 OR v_size NOT BETWEEN 1 AND 50 OR char_length(coalesce(v_search,''))>160
 OR(v_status IS NOT NULL AND v_status NOT IN('reserved','in_progress','delivered','review_required','cancelled')) THEN RAISE EXCEPTION 'INVALID_ORDER_FILTER' USING ERRCODE='22023'; END IF;
 SELECT count(*) INTO v_total FROM public.petro_service_orders o WHERE
 (v_central OR(o.created_by=auth.uid() AND coalesce(petro_private.workforce_can_execute(auth.uid(),o.merchant_branch_id,o.service_group),false)))
 AND(v_status IS NULL OR o.status=v_status) AND(v_search IS NULL OR o.item_snapshot->>'name' ILIKE '%'||v_search||'%' OR o.vehicle_snapshot->>'plate' ILIKE '%'||v_search||'%' OR o.merchant_snapshot->>'branchName' ILIKE '%'||v_search||'%');
 SELECT coalesce(jsonb_agg(row_data ORDER BY created_at DESC,id DESC),'[]'::jsonb) INTO v_items FROM(
 SELECT o.id,o.created_at,petro_private.service_order_view(o.id) row_data FROM public.petro_service_orders o WHERE
 (v_central OR(o.created_by=auth.uid() AND coalesce(petro_private.workforce_can_execute(auth.uid(),o.merchant_branch_id,o.service_group),false)))
 AND(v_status IS NULL OR o.status=v_status) AND(v_search IS NULL OR o.item_snapshot->>'name' ILIKE '%'||v_search||'%' OR o.vehicle_snapshot->>'plate' ILIKE '%'||v_search||'%' OR o.merchant_snapshot->>'branchName' ILIKE '%'||v_search||'%')
 ORDER BY o.created_at DESC,o.id DESC LIMIT v_size OFFSET(v_page-1)*v_size) rows_page;
 RETURN jsonb_build_object('items',v_items,'total',v_total,'page',v_page,'pageSize',v_size,'canManage',petro_private.service_order_central(true));
END $$;

CREATE FUNCTION petro_private.cancel_service_order_core(p_order_id uuid,p_actor_id uuid,p_system_actor text,p_expected_version bigint DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_order public.petro_service_orders%ROWTYPE;v_usage public.petro_fleet_usage_reservations%ROWTYPE;
 v_funds public.petro_finance_reservations%ROWTYPE;v_stock public.petro_inventory_reservations%ROWTYPE;v_balance public.petro_inventory_balances%ROWTYPE;v_reason text;
BEGIN
 IF (p_actor_id IS NULL)=(p_system_actor IS NULL) OR(p_system_actor IS NOT NULL AND p_system_actor<>'service_order_expiry')
 OR(p_actor_id IS NOT NULL AND p_actor_id IS DISTINCT FROM auth.uid()) THEN RAISE EXCEPTION 'INVALID_ORDER_EXECUTOR' USING ERRCODE='42501'; END IF;
 SELECT * INTO v_order FROM public.petro_service_orders WHERE id=p_order_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 IF p_expected_version IS NOT NULL AND p_expected_version<>v_order.version THEN RAISE EXCEPTION 'ORDER_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
 IF v_order.status='cancelled' THEN RETURN petro_private.service_order_view(v_order.id); END IF;
 IF v_order.status NOT IN('reserved','review_required') OR v_order.started_at IS NOT NULL OR v_order.payment_status<>'held'
 OR(p_system_actor IS NOT NULL AND(v_order.status<>'reserved' OR v_order.expires_at>clock_timestamp())) THEN RAISE EXCEPTION 'ORDER_NOT_CANCELLABLE' USING ERRCODE='55000'; END IF;
 PERFORM 1 FROM public.petro_fleet_vehicles WHERE id=v_order.vehicle_id FOR UPDATE;
 PERFORM 1 FROM public.petro_branches WHERE id=v_order.company_branch_id FOR UPDATE;
 SELECT * INTO STRICT v_usage FROM public.petro_fleet_usage_reservations WHERE id=v_order.usage_reservation_id FOR UPDATE;
 IF v_usage.status<>'reserved' OR v_usage.amount_minor<>v_order.amount_minor OR v_usage.vehicle_id<>v_order.vehicle_id THEN RAISE EXCEPTION 'ORDER_HOLD_REQUIRES_REVIEW' USING ERRCODE='55000'; END IF;
 SELECT * INTO STRICT v_funds FROM public.petro_finance_reservations WHERE id=v_usage.finance_reservation_id FOR UPDATE;
 PERFORM 1 FROM public.petro_finance_accounts WHERE id=v_funds.account_id FOR UPDATE;
 IF v_funds.status<>'active' OR v_funds.source_type<>'fleet_usage' OR v_funds.source_id<>v_usage.id OR v_funds.amount_minor<>v_order.amount_minor THEN RAISE EXCEPTION 'ORDER_HOLD_REQUIRES_REVIEW' USING ERRCODE='55000'; END IF;
 v_reason:=CASE WHEN p_system_actor IS NOT NULL THEN 'انتهاء مهلة حجز طلب خدمة ' ELSE 'إلغاء حجز طلب خدمة من المخول ' END||v_order.id::text;
 IF p_system_actor IS NOT NULL THEN
  UPDATE public.petro_finance_reservations SET status='released',closed_at=clock_timestamp(),closed_by=NULL,closed_by_system=p_system_actor WHERE id=v_funds.id;
 ELSE
  PERFORM petro_private.finance_release_reservation(v_funds.id,p_actor_id);
 END IF;
 IF v_order.inventory_reservation_id IS NOT NULL THEN
  SELECT * INTO STRICT v_stock FROM public.petro_inventory_reservations WHERE id=v_order.inventory_reservation_id FOR UPDATE;
  IF v_stock.status<>'reserved' OR v_stock.source_reference<>v_order.id OR v_stock.organization_id<>v_order.merchant_organization_id
  OR v_stock.location_id<>v_order.inventory_location_id OR v_stock.item_id<>v_order.catalog_item_id OR v_stock.quantity<>v_order.quantity THEN RAISE EXCEPTION 'ORDER_STOCK_REQUIRES_REVIEW' USING ERRCODE='55000'; END IF;
  IF p_system_actor IS NOT NULL THEN
   SELECT * INTO STRICT v_balance FROM public.petro_inventory_balances WHERE location_id=v_stock.location_id AND item_id=v_stock.item_id FOR UPDATE;
   IF v_balance.reserved<v_stock.quantity THEN RAISE EXCEPTION 'ORDER_STOCK_REQUIRES_REVIEW' USING ERRCODE='55000'; END IF;
   UPDATE public.petro_inventory_balances SET reserved=reserved-v_stock.quantity,version=version+1,updated_at=clock_timestamp() WHERE location_id=v_stock.location_id AND item_id=v_stock.item_id;
   INSERT INTO public.petro_inventory_movements(organization_id,location_id,item_id,reservation_id,movement_kind,on_hand_delta,reserved_delta,reason,actor_id,system_actor)
   VALUES(v_stock.organization_id,v_stock.location_id,v_stock.item_id,v_stock.id,'release',0,-v_stock.quantity,v_reason,NULL,p_system_actor);
   UPDATE public.petro_inventory_reservations SET status='released',completed_at=clock_timestamp(),completed_by=NULL,completed_by_system=p_system_actor WHERE id=v_stock.id;
  ELSE
   PERFORM petro_private.inventory_apply_delta(v_stock.organization_id,v_stock.location_id,v_stock.item_id,0,-v_stock.quantity,NULL,v_stock.id,'release',v_reason);
   UPDATE public.petro_inventory_reservations SET status='released',completed_at=clock_timestamp(),completed_by=p_actor_id,completed_by_system=NULL WHERE id=v_stock.id;
  END IF;
 END IF;
 UPDATE public.petro_fleet_usage_reservations SET status='released',closed_at=clock_timestamp() WHERE id=v_usage.id;
 UPDATE public.petro_service_orders SET status='cancelled',payment_status='unpaid',cancelled_at=clock_timestamp(),cancelled_by=p_actor_id,cancelled_by_system=p_system_actor,
 cancel_code=CASE WHEN p_system_actor IS NOT NULL THEN 'reservation_expired' ELSE 'operator_cancelled' END,version=version+1,updated_at=clock_timestamp(),expiry_next_at=NULL WHERE id=v_order.id;
 INSERT INTO petro_private.service_order_events(order_id,order_version,kind,actor_id,system_actor,detail)
 VALUES(v_order.id,v_order.version+1,'cancelled',p_actor_id,p_system_actor,jsonb_build_object('previousStatus',v_order.status,'amountMinor',v_order.amount_minor::text,'reasonCode',CASE WHEN p_system_actor IS NOT NULL THEN 'reservation_expired' ELSE 'operator_cancelled' END));
 IF p_system_actor IS NOT NULL THEN RETURN jsonb_build_object('id',v_order.id,'status','cancelled','version',v_order.version+1); END IF;
 RETURN petro_private.service_order_view(v_order.id);
END $$;

CREATE FUNCTION public.petro_cancel_service_order(p_order_id uuid,p_expected_version bigint,p_request_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid:=auth.uid();v_fingerprint text;v_command petro_private.service_order_commands%ROWTYPE;v_order public.petro_service_orders%ROWTYPE;v_result jsonb;
BEGIN
 IF NOT coalesce(petro_private.workforce_user_active(v_actor),false) THEN RAISE EXCEPTION 'FORBIDDEN_ORDER' USING ERRCODE='42501'; END IF;
 IF p_order_id IS NULL OR p_expected_version IS NULL OR p_expected_version<1 OR p_request_key IS NULL OR p_request_key !~ '^[A-Za-z0-9._:-]{16,120}$' THEN RAISE EXCEPTION 'INVALID_ORDER_INPUT' USING ERRCODE='22023'; END IF;
 v_fingerprint:=encode(sha256(convert_to(jsonb_build_array('cancel',p_order_id,p_expected_version)::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('service-order:'||v_actor::text||':'||p_request_key,0));
 SELECT * INTO v_command FROM petro_private.service_order_commands c WHERE c.actor_id=v_actor AND c.request_key=p_request_key FOR UPDATE;
 IF FOUND THEN
  IF v_command.action<>'cancel' OR v_command.payload_fingerprint<>v_fingerprint THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='23505'; END IF;
  IF NOT coalesce(petro_private.service_order_readable(v_command.order_id),false) THEN RAISE EXCEPTION 'FORBIDDEN_ORDER' USING ERRCODE='42501'; END IF;
  RETURN petro_private.service_order_view(v_command.order_id);
 END IF;
 SELECT * INTO v_order FROM public.petro_service_orders WHERE id=p_order_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 IF NOT coalesce(petro_private.service_order_central(true),false) AND NOT(
  v_order.created_by=v_actor AND coalesce(petro_private.workforce_can_execute(v_actor,v_order.merchant_branch_id,v_order.service_group),false)) THEN RAISE EXCEPTION 'FORBIDDEN_ORDER' USING ERRCODE='42501'; END IF;
 v_result:=petro_private.cancel_service_order_core(p_order_id,v_actor,NULL,p_expected_version);
 INSERT INTO petro_private.service_order_commands(actor_id,request_key,action,payload_fingerprint,order_id) VALUES(v_actor,p_request_key,'cancel',v_fingerprint,p_order_id);
 RETURN v_result;
END $$;

CREATE FUNCTION petro_private.petro_expire_service_orders(p_limit integer DEFAULT 100) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_row record;v_processed integer:=0;v_failed integer:=0;v_code text;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'INVALID_EXPIRY_BATCH' USING ERRCODE='22023'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('pertomax.service-order.expiry',0)) THEN RETURN jsonb_build_object('processed',0,'failed',0,'busy',true); END IF;
 FOR v_row IN SELECT o.id FROM public.petro_service_orders o WHERE o.status='reserved' AND o.started_at IS NULL
 AND o.expires_at<=clock_timestamp() AND o.expiry_attempts<5 AND(o.expiry_next_at IS NULL OR o.expiry_next_at<=clock_timestamp())
 ORDER BY o.company_branch_id,o.id FOR UPDATE SKIP LOCKED LIMIT p_limit
 LOOP
  BEGIN
   PERFORM petro_private.cancel_service_order_core(v_row.id,NULL,'service_order_expiry',NULL);
   v_processed:=v_processed+1;
  EXCEPTION WHEN OTHERS THEN
   GET STACKED DIAGNOSTICS v_code=RETURNED_SQLSTATE;
   UPDATE public.petro_service_orders SET expiry_attempts=expiry_attempts+1,last_expiry_error_code=v_code,
    status=CASE WHEN expiry_attempts+1>=5 THEN 'review_required' ELSE 'reserved' END,
    expiry_next_at=CASE WHEN expiry_attempts+1>=5 THEN NULL ELSE clock_timestamp()+make_interval(mins=>least(15,expiry_attempts+1)) END,
    updated_at=clock_timestamp(),version=version+1 WHERE id=v_row.id;
   INSERT INTO petro_private.service_order_events(order_id,order_version,kind,system_actor,detail)
   SELECT id,version,'expiry_failed','service_order_expiry',jsonb_build_object('errorCode',v_code,'attempt',expiry_attempts) FROM public.petro_service_orders WHERE id=v_row.id;
   v_failed:=v_failed+1;
  END;
 END LOOP;
 RETURN jsonb_build_object('processed',v_processed,'failed',v_failed,'busy',false);
END $$;
REVOKE ALL ON FUNCTION petro_private.cancel_service_order_core(uuid,uuid,text,bigint),petro_private.petro_expire_service_orders(integer) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.petro_worker_reserve_service_order(uuid,uuid,uuid,jsonb,uuid,text),public.petro_service_orders_query(jsonb),public.petro_cancel_service_order(uuid,bigint,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.petro_worker_reserve_service_order(uuid,uuid,uuid,jsonb,uuid,text),public.petro_service_orders_query(jsonb),public.petro_cancel_service_order(uuid,bigint,text) TO authenticated;

DO $scheduler$
DECLARE v_installed boolean:=EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron');
BEGIN
 IF NOT v_installed THEN
  CREATE EXTENSION pg_cron WITH SCHEMA pg_catalog;
  REVOKE ALL ON SCHEMA cron FROM PUBLIC,anon,authenticated,service_role;
 ELSIF has_schema_privilege('anon','cron','USAGE') OR has_schema_privilege('authenticated','cron','USAGE') OR has_schema_privilege('service_role','cron','USAGE') THEN
  RAISE EXCEPTION 'Review existing cron client grants before installing the order job';
 END IF;
 IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='pertomax_service_order_expiry') THEN RAISE EXCEPTION 'Order expiry job name already exists; inspect before applying'; END IF;
 PERFORM cron.schedule('pertomax_service_order_expiry','* * * * *','SELECT petro_private.petro_expire_service_orders(100);');
END $scheduler$;
COMMIT;
