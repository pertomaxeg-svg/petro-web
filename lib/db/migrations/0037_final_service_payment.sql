BEGIN;
CREATE TABLE petro_private.merchant_settlement_policy_versions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,branch_id uuid,
 version_no integer NOT NULL CHECK(version_no>0),cycle text NOT NULL CHECK(cycle='calendar_month'),timezone text NOT NULL CHECK(timezone='Africa/Cairo'),
 payout_delay_days integer NOT NULL CHECK(payout_delay_days BETWEEN 0 AND 90),effective_from timestamptz NOT NULL,
 source text NOT NULL CHECK(source IN('engineering_reference_v3','admin')),created_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(branch_id,organization_id) REFERENCES public.petro_branches(id,organization_id) ON DELETE RESTRICT,
 CHECK(branch_id IS NULL OR organization_id IS NOT NULL),CHECK((source='engineering_reference_v3' AND created_by IS NULL) OR(source='admin' AND created_by IS NOT NULL)),
 UNIQUE NULLS NOT DISTINCT(organization_id,branch_id,version_no)
);
INSERT INTO petro_private.merchant_settlement_policy_versions(version_no,cycle,timezone,payout_delay_days,effective_from,source)
VALUES(1,'calendar_month','Africa/Cairo',0,'-infinity','engineering_reference_v3');
CREATE TABLE petro_private.service_order_payments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid NOT NULL UNIQUE REFERENCES public.petro_service_orders(id) ON DELETE RESTRICT,
 usage_id uuid NOT NULL UNIQUE REFERENCES public.petro_fleet_usage_reservations(id) ON DELETE RESTRICT,
 financial_reservation_id uuid NOT NULL UNIQUE REFERENCES public.petro_finance_reservations(id) ON DELETE RESTRICT,
 journal_entry_id uuid NOT NULL UNIQUE REFERENCES public.petro_finance_journal_entries(id) ON DELETE RESTRICT,
 booked_amount_minor bigint NOT NULL CHECK(booked_amount_minor>0),charged_amount_minor bigint NOT NULL CHECK(charged_amount_minor>0),
 released_amount_minor bigint NOT NULL CHECK(released_amount_minor>=0),currency text NOT NULL DEFAULT 'EGP' CHECK(currency='EGP'),
 confirmed_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,confirmed_at timestamptz NOT NULL,
 CHECK(charged_amount_minor+released_amount_minor=booked_amount_minor)
);
CREATE TABLE petro_private.service_order_receivables(
 order_id uuid PRIMARY KEY REFERENCES public.petro_service_orders(id) ON DELETE RESTRICT,
 payment_id uuid NOT NULL UNIQUE REFERENCES petro_private.service_order_payments(id) ON DELETE RESTRICT,
 merchant_organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
 merchant_branch_id uuid NOT NULL,control_account_id uuid NOT NULL REFERENCES public.petro_finance_accounts(id) ON DELETE RESTRICT,
 earned_amount_minor bigint NOT NULL CHECK(earned_amount_minor>0),currency text NOT NULL DEFAULT 'EGP' CHECK(currency='EGP'),
 settlement_policy_id uuid NOT NULL REFERENCES petro_private.merchant_settlement_policy_versions(id) ON DELETE RESTRICT,
 settlement_snapshot jsonb NOT NULL CHECK(jsonb_typeof(settlement_snapshot)='object'),
 earned_at timestamptz NOT NULL,period_start timestamptz NOT NULL,period_end timestamptz NOT NULL,eligible_at timestamptz NOT NULL,
 FOREIGN KEY(merchant_branch_id,merchant_organization_id) REFERENCES public.petro_branches(id,organization_id) ON DELETE RESTRICT,
 CHECK(period_start<=earned_at AND earned_at<period_end AND eligible_at>=period_end)
);
CREATE INDEX service_order_receivable_scope ON petro_private.service_order_receivables(merchant_organization_id,merchant_branch_id,eligible_at,order_id);
CREATE SEQUENCE petro_private.service_receipt_number_seq;
REVOKE ALL ON SEQUENCE petro_private.service_receipt_number_seq FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE petro_private.service_order_receipts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid NOT NULL UNIQUE REFERENCES public.petro_service_orders(id) ON DELETE RESTRICT,
 payment_id uuid NOT NULL UNIQUE REFERENCES petro_private.service_order_payments(id) ON DELETE RESTRICT,
 receipt_number text NOT NULL UNIQUE,snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 issued_at timestamptz NOT NULL
);
CREATE TABLE petro_private.service_order_confirmation_commands(
 actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,request_key text NOT NULL CHECK(char_length(request_key) BETWEEN 16 AND 120),
 order_id uuid NOT NULL REFERENCES public.petro_service_orders(id) ON DELETE RESTRICT,
 payload_fingerprint text NOT NULL CHECK(payload_fingerprint~'^[0-9a-f]{64}$'),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(actor_id,request_key)
);
ALTER TABLE petro_private.service_order_events DROP CONSTRAINT service_order_events_kind_check;
ALTER TABLE petro_private.service_order_events ADD CONSTRAINT service_order_events_kind_check CHECK(kind IN('reserved','cancelled','expiry_failed','started','delivered','paid'));
ALTER TABLE petro_private.merchant_settlement_policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE petro_private.service_order_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE petro_private.service_order_receivables ENABLE ROW LEVEL SECURITY;
ALTER TABLE petro_private.service_order_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE petro_private.service_order_confirmation_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON petro_private.merchant_settlement_policy_versions,petro_private.service_order_payments,petro_private.service_order_receivables,petro_private.service_order_receipts,petro_private.service_order_confirmation_commands FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION petro_private.guard_service_payment_history() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Service payment history is immutable' USING ERRCODE='55000';END $$;
REVOKE ALL ON FUNCTION petro_private.guard_service_payment_history() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER merchant_settlement_policy_immutable BEFORE UPDATE OR DELETE ON petro_private.merchant_settlement_policy_versions FOR EACH ROW EXECUTE FUNCTION petro_private.guard_service_payment_history();
CREATE TRIGGER service_order_payment_immutable BEFORE UPDATE OR DELETE ON petro_private.service_order_payments FOR EACH ROW EXECUTE FUNCTION petro_private.guard_service_payment_history();
CREATE TRIGGER service_order_receivable_immutable BEFORE UPDATE OR DELETE ON petro_private.service_order_receivables FOR EACH ROW EXECUTE FUNCTION petro_private.guard_service_payment_history();
CREATE TRIGGER service_order_receipt_immutable BEFORE UPDATE OR DELETE ON petro_private.service_order_receipts FOR EACH ROW EXECUTE FUNCTION petro_private.guard_service_payment_history();
CREATE TRIGGER service_confirmation_command_immutable BEFORE UPDATE OR DELETE ON petro_private.service_order_confirmation_commands FOR EACH ROW EXECUTE FUNCTION petro_private.guard_service_payment_history();

CREATE FUNCTION public.petro_service_order_payment(p_order_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o public.petro_service_orders%ROWTYPE;delivery petro_private.service_order_deliveries%ROWTYPE;payment jsonb;
BEGIN
 IF NOT coalesce(petro_private.service_order_readable(p_order_id),false) THEN RAISE EXCEPTION 'FORBIDDEN_ORDER' USING ERRCODE='42501';END IF;
 SELECT * INTO STRICT o FROM public.petro_service_orders WHERE id=p_order_id;
 SELECT * INTO delivery FROM petro_private.service_order_deliveries WHERE order_id=o.id;
 SELECT jsonb_build_object('id',p.id,'chargedAmountMinor',p.charged_amount_minor::text,'bookedAmountMinor',p.booked_amount_minor::text,
 'releasedAmountMinor',p.released_amount_minor::text,'currency',p.currency,'confirmedAt',p.confirmed_at,'journalEntryId',p.journal_entry_id,
 'receipt',jsonb_build_object('id',r.id,'number',r.receipt_number,'issuedAt',r.issued_at,'snapshot',r.snapshot),
 'receivable',jsonb_build_object('merchantBranchId',v.merchant_branch_id,'earnedAmountMinor',v.earned_amount_minor::text,'eligibleAt',v.eligible_at,'periodStart',v.period_start,'periodEnd',v.period_end))
 INTO payment FROM petro_private.service_order_payments p JOIN petro_private.service_order_receipts r ON r.payment_id=p.id JOIN petro_private.service_order_receivables v ON v.payment_id=p.id WHERE p.order_id=o.id;
 RETURN jsonb_build_object('orderId',o.id,'status',o.status,'paymentStatus',o.payment_status,'version',o.version,'paid',o.payment_status='paid',
 'bookedAmountMinor',o.amount_minor::text,'actualAmountMinor',delivery.actual_amount_minor::text,'payment',payment,
 'canConfirm',o.status='delivered' AND o.payment_status='held' AND delivery.order_id IS NOT NULL AND delivery.identity_current
 AND coalesce(petro_private.service_order_identity_current(o.id),false)
 AND(delivery.odometer_event_id IS NULL OR EXISTS(SELECT 1 FROM public.petro_vehicle_odometer_events WHERE id=delivery.odometer_event_id AND status='accepted')));
END $$;
CREATE FUNCTION public.petro_service_order_payment_context(p_order_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE vehicle uuid;
BEGIN
 IF NOT coalesce(petro_private.service_order_worker_current(p_order_id),false) THEN RAISE EXCEPTION 'FORBIDDEN_ORDER' USING ERRCODE='42501';END IF;
 SELECT vehicle_id INTO vehicle FROM public.petro_service_orders WHERE id=p_order_id;
 RETURN jsonb_build_object('vehicleId',vehicle);
END $$;

CREATE FUNCTION public.petro_confirm_service_order(p_order_id uuid,p_expected_version bigint,p_pin_hmac text,p_request_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
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
 IF CASE required_kind WHEN 'odometer' THEN (rule->>'odometerRequired')::boolean WHEN 'wash_before' THEN(rule->>'washBeforeRequired')::boolean WHEN 'wash_after' THEN(rule->>'washAfterRequired')::boolean ELSE(rule->>'serialRequired')::boolean END THEN
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
END $$;
REVOKE ALL ON FUNCTION public.petro_service_order_payment(uuid),public.petro_service_order_payment_context(uuid),public.petro_confirm_service_order(uuid,bigint,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.petro_service_order_payment(uuid),public.petro_service_order_payment_context(uuid),public.petro_confirm_service_order(uuid,bigint,text,text) TO authenticated;
COMMIT;
