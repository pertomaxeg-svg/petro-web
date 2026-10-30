-- TEST ONLY. Loaded exclusively into loopback/disposable CI sessions.
-- Insert-only historical import fixture; no production time override, immutable UPDATE/DELETE or disabled trigger.
CREATE FUNCTION pg_temp.withdrawal_historical_payment(source_order uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE p petro_private.service_order_payments%ROWTYPE;v petro_private.service_order_receivables%ROWTYPE;o public.petro_service_orders%ROWTYPE;
 usage_id_value uuid:=gen_random_uuid();hold_id uuid:=gen_random_uuid();order_id_value uuid:=gen_random_uuid();payment_id_value uuid:=gen_random_uuid();proof_id uuid:=gen_random_uuid();entry_id uuid:=gen_random_uuid();
 funding uuid;period_start_value timestamptz;period_end_value timestamptz;earned_value timestamptz;BEGIN
 SELECT * INTO STRICT p FROM petro_private.service_order_payments WHERE order_id=source_order;
 SELECT * INTO STRICT v FROM petro_private.service_order_receivables WHERE payment_id=p.id;
 SELECT * INTO STRICT o FROM public.petro_service_orders WHERE id=p.order_id;
 SELECT account_id INTO STRICT funding FROM public.petro_finance_reservations WHERE id=p.financial_reservation_id;
 period_start_value:=(date_trunc('month',statement_timestamp() AT TIME ZONE 'Africa/Cairo')-interval '2 months') AT TIME ZONE 'Africa/Cairo';
 period_end_value:=(date_trunc('month',statement_timestamp() AT TIME ZONE 'Africa/Cairo')-interval '1 month') AT TIME ZONE 'Africa/Cairo';
 earned_value:=period_start_value+interval '1 day';
 PERFORM petro_private.finance_post_entry(entry_id,'reservation_consumption',usage_id_value,o.company_organization_id,'HISTORICAL-CI:'||order_id_value,'استيراد تاريخ مالي اصطناعي معزول',
 jsonb_build_array(jsonb_build_object('accountId',funding,'side','debit','amountMinor',p.charged_amount_minor::text),jsonb_build_object('accountId',v.control_account_id,'side','credit','amountMinor',p.charged_amount_minor::text)));
 INSERT INTO petro_private.worker_pin_proofs SELECT(jsonb_populate_record(NULL::petro_private.worker_pin_proofs,to_jsonb(x)||jsonb_build_object('id',proof_id,'created_at',earned_value-interval '5 minutes','expires_at',earned_value+interval '5 minutes','consumed_at',earned_value))).*
 FROM petro_private.worker_pin_proofs x WHERE x.id=o.first_proof_id;
 INSERT INTO public.petro_finance_reservations SELECT(jsonb_populate_record(NULL::public.petro_finance_reservations,to_jsonb(x)||jsonb_build_object('id',hold_id,'source_id',usage_id_value,'created_by',auth.uid(),'closed_by',auth.uid(),'consumed_entry_id',entry_id,'created_at',earned_value,'closed_at',earned_value))).*
 FROM public.petro_finance_reservations x WHERE x.id=p.financial_reservation_id;
 INSERT INTO public.petro_fleet_usage_reservations SELECT(jsonb_populate_record(NULL::public.petro_fleet_usage_reservations,to_jsonb(x)||jsonb_build_object('id',usage_id_value,'finance_reservation_id',hold_id,'consumed_entry_id',entry_id,'request_key','historical-ci-'||usage_id_value,'created_at',earned_value,'closed_at',earned_value))).*
 FROM public.petro_fleet_usage_reservations x WHERE x.id=p.usage_id;
 INSERT INTO public.petro_service_orders SELECT(jsonb_populate_record(NULL::public.petro_service_orders,to_jsonb(o)||jsonb_build_object('id',order_id_value,'created_by',auth.uid(),'first_proof_id',proof_id,'usage_reservation_id',usage_id_value,'captured_entry_id',entry_id,'inventory_reservation_id',NULL,'created_at',earned_value,'updated_at',earned_value,'started_at',earned_value,'delivered_at',earned_value,'expires_at',earned_value+interval '15 minutes'))).*;
 INSERT INTO petro_private.service_order_payments SELECT(jsonb_populate_record(NULL::petro_private.service_order_payments,to_jsonb(p)||jsonb_build_object('id',payment_id_value,'order_id',order_id_value,'usage_id',usage_id_value,'financial_reservation_id',hold_id,'journal_entry_id',entry_id,'confirmed_at',earned_value))).*;
 INSERT INTO petro_private.service_order_receipts SELECT(jsonb_populate_record(NULL::petro_private.service_order_receipts,to_jsonb(x)||jsonb_build_object('id',gen_random_uuid(),'order_id',order_id_value,'payment_id',payment_id_value,'receipt_number','HIST-CI-'||order_id_value,'issued_at',earned_value,'snapshot',x.snapshot||jsonb_build_object('orderId',order_id_value,'paymentId',payment_id_value,'journalEntryId',entry_id,'issuedAt',earned_value,'documentNumber','HIST-CI-'||order_id_value)))).*
 FROM petro_private.service_order_receipts x WHERE x.payment_id=p.id;
 INSERT INTO petro_private.service_order_receivables SELECT(jsonb_populate_record(NULL::petro_private.service_order_receivables,to_jsonb(v)||jsonb_build_object('order_id',order_id_value,'payment_id',payment_id_value,'earned_at',earned_value,'period_start',period_start_value,'period_end',period_end_value,'eligible_at',period_end_value,'settlement_snapshot',v.settlement_snapshot||jsonb_build_object('periodStart',period_start_value,'periodEnd',period_end_value,'eligibleAt',period_end_value)))).*;
 RETURN payment_id_value;
END $$;
