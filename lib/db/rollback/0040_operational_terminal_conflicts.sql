BEGIN;
-- Function-only rollback; never edits any order, proof, ledger or inventory history.
DO $operation_conflict_guard$
BEGIN
 IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN(VALUES ('petro_private','cancel_service_order_core','37996868ed1abee46b5dd3233174b3ebc2f3aec538ddafe4fd61f1294ab73633'),
('public','petro_confirm_service_order','f119d3371ba4b819d9e60a0b603df85f4f4d45fe70d2feafbd1092f31fe9ade8'),
('public','petro_deliver_service_order','0931468baab19bd97a39d4a386929172c726e93a1018ad8bf644ca40a17c5ca3'),
('public','petro_start_service_order','0b90454f8583b448aa047510c7510438076de753f3e21db974a54f60f8531d46'),
('public','petro_worker_reserve_service_order','7cbc6c7252bce095b9530b319e7f4374724118676240fed2912cbfb24246cb17')) e(schema_name,function_name,expected_hash) ON n.nspname=e.schema_name AND p.proname=e.function_name)<>5
 OR EXISTS(SELECT 1 FROM(VALUES ('petro_private','cancel_service_order_core','37996868ed1abee46b5dd3233174b3ebc2f3aec538ddafe4fd61f1294ab73633'),
('public','petro_confirm_service_order','f119d3371ba4b819d9e60a0b603df85f4f4d45fe70d2feafbd1092f31fe9ade8'),
('public','petro_deliver_service_order','0931468baab19bd97a39d4a386929172c726e93a1018ad8bf644ca40a17c5ca3'),
('public','petro_start_service_order','0b90454f8583b448aa047510c7510438076de753f3e21db974a54f60f8531d46'),
('public','petro_worker_reserve_service_order','7cbc6c7252bce095b9530b319e7f4374724118676240fed2912cbfb24246cb17')) e(schema_name,function_name,expected_hash) LEFT JOIN pg_namespace n ON n.nspname=e.schema_name LEFT JOIN pg_proc p ON p.pronamespace=n.oid AND p.proname=e.function_name WHERE p.oid IS NULL OR encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')<>e.expected_hash) THEN
 RAISE EXCEPTION '0040 rollback: reviewed operational function definition drift';END IF;
END $operation_conflict_guard$;
CREATE OR REPLACE FUNCTION petro_private.cancel_service_order_core(p_order_id uuid, p_actor_id uuid, p_system_actor text, p_expected_version bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
END $function$

CREATE OR REPLACE FUNCTION public.petro_confirm_service_order(p_order_id uuid, p_expected_version bigint, p_pin_hmac text, p_request_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE actor uuid:=auth.uid();o public.petro_service_orders%ROWTYPE;d petro_private.service_order_deliveries%ROWTYPE;
 command petro_private.service_order_confirmation_commands%ROWTYPE;fingerprint text;result jsonb;
 limiter petro_private.petro_fleet_pair_rate_limits%ROWTYPE;proof petro_private.worker_pin_proofs%ROWTYPE;secret bytea;supplied bytea;difference integer:=0;byte_index integer;
 attempts integer;window_started timestamptz;locked_until_value timestamptz;current_time_value timestamptz:=clock_timestamp();
 u public.petro_fleet_usage_reservations%ROWTYPE;funds public.petro_finance_reservations%ROWTYPE;available numeric;control_account uuid;
 policy petro_private.merchant_settlement_policy_versions%ROWTYPE;period_start_value timestamptz;period_end_value timestamptz;eligible_value timestamptz;
 payment_id uuid:=gen_random_uuid();entry_id uuid:=gen_random_uuid();receipt_id uuid:=gen_random_uuid();receipt_counter bigint;receipt_number_value text;released bigint;rule jsonb;required_kind text;receipt_snapshot jsonb;
BEGIN
 IF NOT coalesce(petro_private.service_order_worker_current(p_order_id),false) THEN RAISE EXCEPTION 'FORBIDDEN_ORDER' USING ERRCODE='42501';END IF;
 IF p_expected_version IS NULL OR p_expected_version<1 OR p_pin_hmac IS NULL OR p_pin_hmac!~'^[0-9a-f]{64}$'
 OR p_request_key IS NULL OR p_request_key!~'^[A-Za-z0-9._:-]{16,120}$' THEN RAISE EXCEPTION 'INVALID_CONFIRMATION_INPUT' USING ERRCODE='22023';END IF;
 fingerprint:=encode(sha256(convert_to(jsonb_build_array(p_order_id,p_expected_version,p_pin_hmac)::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('order-payment:'||actor::text||':'||p_request_key,0));
 SELECT * INTO command FROM petro_private.service_order_confirmation_commands WHERE actor_id=actor AND request_key=p_request_key;
 IF FOUND THEN
 IF command.payload_fingerprint<>fingerprint OR command.order_id<>p_order_id THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';END IF;
 RETURN command.result;
 END IF;
 SELECT * INTO o FROM public.petro_service_orders WHERE id=p_order_id FOR UPDATE;
 IF o.version<>p_expected_version THEN RAISE EXCEPTION 'ORDER_VERSION_CONFLICT' USING ERRCODE='40001';END IF;
 IF o.status<>'delivered' OR o.delivered_at IS NULL OR o.payment_status<>'held' OR o.captured_entry_id IS NOT NULL THEN RAISE EXCEPTION 'ORDER_NOT_CONFIRMABLE' USING ERRCODE='55000';END IF;
 SELECT * INTO STRICT d FROM petro_private.service_order_deliveries WHERE order_id=o.id;
 IF NOT d.identity_current OR d.actual_amount_minor>o.amount_minor OR d.actual_quantity>o.quantity OR d.actual_amount_minor<>round(d.actual_quantity*d.unit_price_minor)::bigint THEN RAISE EXCEPTION 'DELIVERY_REQUIRES_REVIEW' USING ERRCODE='55000';END IF;
 PERFORM 1 FROM public.petro_fleet_vehicles WHERE id=o.vehicle_id FOR UPDATE;
 PERFORM 1 FROM public.petro_branches WHERE id=o.company_branch_id FOR UPDATE;
 SELECT * INTO STRICT proof FROM petro_private.worker_pin_proofs WHERE id=o.first_proof_id;
 PERFORM 1 FROM public.petro_worker_assignments WHERE id=proof.assignment_id FOR SHARE;
 PERFORM 1 FROM public.petro_vehicle_credentials WHERE id=proof.credential_id FOR SHARE;
 PERFORM 1 FROM public.petro_fleet_driver_links WHERE id=o.driver_link_id FOR SHARE;
 SELECT pin_hmac INTO secret FROM petro_private.petro_fleet_driver_pair_secrets WHERE id=proof.pin_secret_id AND active FOR SHARE;
 IF secret IS NULL OR octet_length(secret)<>32 OR NOT coalesce(petro_private.service_order_identity_current(o.id),false) THEN RAISE EXCEPTION 'ORDER_IDENTITY_CHANGED' USING ERRCODE='42501';END IF;
 rule:=petro_private.service_order_documentation_rule(o.id);
 IF(rule->>'odometerRequired')::boolean AND(d.odometer_event_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.petro_vehicle_odometer_events WHERE id=d.odometer_event_id AND status='accepted')) THEN RAISE EXCEPTION 'ODOMETER_REQUIRES_REVIEW' USING ERRCODE='55000';END IF;
 FOREACH required_kind IN ARRAY ARRAY['odometer','wash_before','wash_after','serial'] LOOP
 IF (CASE required_kind WHEN 'odometer' THEN (rule->>'odometerRequired')::boolean WHEN 'wash_before' THEN(rule->>'washBeforeRequired')::boolean WHEN 'wash_after' THEN(rule->>'washAfterRequired')::boolean ELSE(rule->>'serialRequired')::boolean END) THEN
 IF NOT EXISTS(SELECT 1 FROM petro_private.service_order_evidence e JOIN storage.objects s ON s.id=e.storage_object_id AND s.bucket_id='petro-private-documents' AND s.name=e.object_path
 WHERE e.order_id=o.id AND e.kind=required_kind AND e.status='accepted' AND s.owner_id::text=e.uploader_id::text AND s.metadata->>'mimetype'=e.content_type AND s.metadata->>'size'=e.byte_size::text) THEN RAISE EXCEPTION 'ORDER_EVIDENCE_REQUIRES_REVIEW' USING ERRCODE='55000';END IF;
 END IF;
 END LOOP;
 INSERT INTO petro_private.petro_fleet_pair_rate_limits(vehicle_id) VALUES(o.vehicle_id) ON CONFLICT DO NOTHING;
 SELECT * INTO STRICT limiter FROM petro_private.petro_fleet_pair_rate_limits WHERE vehicle_id=o.vehicle_id FOR UPDATE;
 current_time_value:=clock_timestamp();
 IF limiter.locked_until>current_time_value THEN
 result:=jsonb_build_object('orderId',o.id,'version',o.version,'paid',false,'valid',false,'locked',true,'retryAt',limiter.locked_until);
 ELSE
 attempts:=limiter.failed_attempts;window_started:=limiter.window_started_at;
 IF window_started+interval '15 minutes'<=current_time_value THEN attempts:=0;window_started:=current_time_value;END IF;
 supplied:=decode(p_pin_hmac,'hex');
 FOR byte_index IN 0..31 LOOP difference:=difference | (get_byte(secret,byte_index) # get_byte(supplied,byte_index));END LOOP;
 IF difference<>0 THEN
 attempts:=least(5,attempts+1);locked_until_value:=CASE WHEN attempts>=5 THEN current_time_value+interval '15 minutes' END;
 UPDATE petro_private.petro_fleet_pair_rate_limits SET failed_attempts=attempts,window_started_at=window_started,locked_until=locked_until_value,updated_at=current_time_value WHERE vehicle_id=o.vehicle_id;
 result:=jsonb_build_object('orderId',o.id,'version',o.version,'paid',false,'valid',false,'locked',locked_until_value IS NOT NULL,'retryAt',locked_until_value);
 ELSE
 UPDATE petro_private.petro_fleet_pair_rate_limits SET failed_attempts=0,window_started_at=current_time_value,locked_until=NULL,updated_at=current_time_value WHERE vehicle_id=o.vehicle_id;
 END IF;
 END IF;
 IF result IS NOT NULL THEN
 INSERT INTO petro_private.service_order_confirmation_commands(actor_id,request_key,order_id,payload_fingerprint,result) VALUES(actor,p_request_key,o.id,fingerprint,result);
 RETURN result;
 END IF;
 SELECT * INTO STRICT u FROM public.petro_fleet_usage_reservations WHERE id=o.usage_reservation_id FOR UPDATE;
 SELECT * INTO STRICT funds FROM public.petro_finance_reservations WHERE id=u.finance_reservation_id FOR UPDATE;
 IF u.status<>'reserved' OR u.amount_minor<>o.amount_minor OR u.quantity<>o.quantity OR funds.status<>'active' OR funds.source_type<>'fleet_usage' OR funds.source_id<>u.id OR funds.amount_minor<>o.amount_minor THEN RAISE EXCEPTION 'ORDER_HOLD_REQUIRES_REVIEW' USING ERRCODE='55000';END IF;
 SELECT id INTO STRICT control_account FROM public.petro_finance_accounts WHERE account_kind='merchant_payable' AND account_code='SYS-MERCHANT-PAYABLE' AND normal_side='credit' AND currency='EGP';
 PERFORM 1 FROM public.petro_finance_accounts WHERE id IN(funds.account_id,control_account) ORDER BY id FOR UPDATE;
 SELECT available_minor+funds.amount_minor INTO available FROM public.petro_finance_account_balances WHERE account_id=funds.account_id;
 IF available IS NULL OR available<d.actual_amount_minor THEN RAISE EXCEPTION 'INSUFFICIENT_CAPTURE_FUNDS' USING ERRCODE='23514';END IF;
 IF o.kind='product' AND NOT EXISTS(SELECT 1 FROM public.petro_inventory_reservations WHERE id=o.inventory_reservation_id AND status='consumed' AND quantity=d.actual_quantity AND source_reference=o.id) THEN RAISE EXCEPTION 'PHYSICAL_DELIVERY_REQUIRES_REVIEW' USING ERRCODE='55000';END IF;
 IF NOT coalesce(petro_private.service_order_identity_current(o.id),false) THEN RAISE EXCEPTION 'ORDER_IDENTITY_CHANGED' USING ERRCODE='42501';END IF;
 -- Match the immutable journal's canonical transaction timestamp; PIN windows use wall-clock time above.
 current_time_value:=transaction_timestamp();
 SELECT * INTO STRICT policy FROM petro_private.merchant_settlement_policy_versions WHERE(organization_id IS NULL OR organization_id=o.merchant_organization_id) AND(branch_id IS NULL OR branch_id=o.merchant_branch_id) AND effective_from<=current_time_value
 ORDER BY(branch_id IS NOT NULL)DESC,(organization_id IS NOT NULL)DESC,effective_from DESC,version_no DESC LIMIT 1;
 period_start_value:=date_trunc('month',current_time_value AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'Africa/Cairo';
 period_end_value:=(date_trunc('month',current_time_value AT TIME ZONE 'Africa/Cairo')+interval '1 month') AT TIME ZONE 'Africa/Cairo';
 eligible_value:=((period_end_value AT TIME ZONE 'Africa/Cairo')+make_interval(days=>policy.payout_delay_days)) AT TIME ZONE 'Africa/Cairo';
 released:=o.amount_minor-d.actual_amount_minor;
 UPDATE public.petro_finance_reservations SET amount_minor=d.actual_amount_minor WHERE id=funds.id;
 PERFORM petro_private.finance_post_entry(entry_id,'reservation_consumption',u.id,o.company_organization_id,'SERVICE-ORDER-PAYMENT:'||o.id::text,
 'تأكيد دفع القيمة المنفذة لطلب خدمة '||o.id::text,
 jsonb_build_array(jsonb_build_object('accountId',funds.account_id,'side','debit','amountMinor',d.actual_amount_minor::text),jsonb_build_object('accountId',control_account,'side','credit','amountMinor',d.actual_amount_minor::text)));
 PERFORM petro_private.finance_consume_reservation(funds.id,entry_id);
 UPDATE public.petro_fleet_usage_reservations SET amount_minor=d.actual_amount_minor,quantity=d.actual_quantity,status='consumed',closed_at=current_time_value,consumed_entry_id=entry_id WHERE id=u.id;
 INSERT INTO petro_private.service_order_payments(id,order_id,usage_id,financial_reservation_id,journal_entry_id,booked_amount_minor,charged_amount_minor,released_amount_minor,confirmed_by,confirmed_at)
 VALUES(payment_id,o.id,u.id,funds.id,entry_id,o.amount_minor,d.actual_amount_minor,released,actor,current_time_value);
 INSERT INTO petro_private.service_order_receivables(order_id,payment_id,merchant_organization_id,merchant_branch_id,control_account_id,earned_amount_minor,settlement_policy_id,settlement_snapshot,earned_at,period_start,period_end,eligible_at)
 VALUES(o.id,payment_id,o.merchant_organization_id,o.merchant_branch_id,control_account,d.actual_amount_minor,policy.id,jsonb_build_object('policyId',policy.id,'version',policy.version_no,'cycle',policy.cycle,'timezone',policy.timezone,'delayDays',policy.payout_delay_days,'source',policy.source),current_time_value,period_start_value,period_end_value,eligible_value);
 receipt_counter:=nextval('petro_private.service_receipt_number_seq');
 receipt_number_value:='SR-'||to_char(current_time_value AT TIME ZONE 'Africa/Cairo','YYYY')||'-'||lpad(receipt_counter::text,greatest(8,char_length(receipt_counter::text)),'0');
 receipt_snapshot:=jsonb_build_object('documentKind','service_receipt','taxTreatment','not_configured','currency','EGP','orderId',o.id,'receiptNumber',receipt_number_value,
 'bookedAmountMinor',o.amount_minor::text,'chargedAmountMinor',d.actual_amount_minor::text,'releasedAmountMinor',released::text,'quantity',trim_scale(d.actual_quantity)::text,'unitPriceMinor',trim_scale(d.unit_price_minor)::text,
 'item',o.item_snapshot,'vehicle',o.vehicle_snapshot,'merchant',o.merchant_snapshot,
 'company',(SELECT jsonb_build_object('name',name,'code',code) FROM public.petro_organizations WHERE id=o.company_organization_id),
 'companyBranch',(SELECT jsonb_build_object('name',name,'code',code) FROM public.petro_branches WHERE id=o.company_branch_id),
 'workerName',(SELECT display_name FROM public.petro_profiles WHERE user_id=actor),'confirmedAt',current_time_value,'journalEntryId',entry_id);
 INSERT INTO petro_private.service_order_receipts(id,order_id,payment_id,receipt_number,snapshot,issued_at) VALUES(receipt_id,o.id,payment_id,receipt_number_value,receipt_snapshot,current_time_value);
 UPDATE public.petro_service_orders SET payment_status='paid',captured_entry_id=entry_id,version=version+1,updated_at=current_time_value WHERE id=o.id;
 INSERT INTO petro_private.service_order_events(order_id,order_version,kind,actor_id,detail) VALUES(o.id,o.version+1,'paid',actor,jsonb_build_object('paymentId',payment_id,'receiptNumber',receipt_number_value,'bookedAmountMinor',o.amount_minor::text,'chargedAmountMinor',d.actual_amount_minor::text,'releasedAmountMinor',released::text,'journalEntryId',entry_id));
 INSERT INTO public.petro_finance_outbox(event_type,source_type,source_id,payload) VALUES('order.paid','service_order',o.id,jsonb_build_object('orderId',o.id,'paymentId',payment_id,'receiptId',receipt_id,'merchantOrganizationId',o.merchant_organization_id,'merchantBranchId',o.merchant_branch_id,'chargedAmountMinor',d.actual_amount_minor::text,'currency','EGP'));
 result:=public.petro_service_order_payment(o.id)||jsonb_build_object('valid',true,'locked',false);
 INSERT INTO petro_private.service_order_confirmation_commands(actor_id,request_key,order_id,payload_fingerprint,result) VALUES(actor,p_request_key,o.id,fingerprint,result);
 RETURN result;
END $function$

CREATE OR REPLACE FUNCTION public.petro_deliver_service_order(p_order_id uuid, p_expected_version bigint, p_input jsonb, p_request_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
END $function$

CREATE OR REPLACE FUNCTION public.petro_start_service_order(p_order_id uuid, p_expected_version bigint, p_request_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
END $function$

CREATE OR REPLACE FUNCTION public.petro_worker_reserve_service_order(p_proof_id uuid, p_reference_id uuid, p_price_version_id uuid, p_input jsonb, p_location_id uuid, p_request_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
END $function$

COMMIT;
