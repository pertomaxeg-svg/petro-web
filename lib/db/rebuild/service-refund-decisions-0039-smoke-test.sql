-- Only inside disposable paid-order acceptance transaction.
DO $refund_decision_gate$ BEGIN
 IF to_regprocedure('public.petro_decide_service_refund(uuid,bigint,text,text,text,text)') IS NULL
 OR to_regclass('petro_private.service_refund_decisions') IS NULL
 OR to_regclass('petro_private.service_refund_allocations') IS NULL THEN
 RAISE EXCEPTION 'ACTUAL_REFUND_DECISION_MISSING';END IF;
END $refund_decision_gate$;

DO $actual_refund$
DECLARE p petro_private.service_order_payments%ROWTYPE;v petro_private.service_order_receivables%ROWTYPE;
 request jsonb;decision jsonb;read_view jsonb;item jsonb;actor uuid;target_request uuid;amount_before numeric;control_before numeric;stock_before bigint;journal_before bigint;
 original_receipt jsonb;settlement_entry uuid:=gen_random_uuid();bank_account uuid;debt_account uuid;refunded_entry uuid;
BEGIN
 SELECT * INTO STRICT p FROM petro_private.service_order_payments WHERE charged_amount_minor=8750;
 SELECT * INTO STRICT v FROM petro_private.service_order_receivables WHERE payment_id=p.id;
 PERFORM set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000003701',true);
 FOR target_request IN SELECT r.id FROM petro_private.service_refund_requests r WHERE r.payment_id=p.id
 AND NOT EXISTS(SELECT 1 FROM petro_private.service_refund_withdrawals WHERE request_id=r.id) LOOP
 PERFORM public.petro_withdraw_service_refund(target_request,1,'actual-refund-free-'||target_request::text);END LOOP;
 request:=public.petro_request_service_refund(p.order_id,'1000','quality',NULL,'actual-refund-reject-request');
 target_request:=(request->>'id')::uuid;
 FOREACH actor IN ARRAY ARRAY['00000000-0000-4000-8000-000000003801'::uuid,'00000000-0000-4000-8000-000000003803'::uuid,'00000000-0000-4000-8000-000000003804'::uuid,'00000000-0000-4000-8000-000000003702'::uuid] LOOP
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 BEGIN PERFORM public.petro_decide_service_refund(target_request,1,'refund','1000',NULL,'actual-refund-role-denial');RAISE EXCEPTION 'Non-platform-finance actor posted refund';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 END LOOP;
 PERFORM set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000003701',true);
 SELECT count(*) INTO journal_before FROM public.petro_finance_journal_entries;
 decision:=public.petro_decide_service_refund(target_request,1,'reject',NULL,NULL,'actual-refund-reject-0001');
 IF decision->>'status'<>'rejected' OR decision->>'moneyRefunded'<>'false' OR(SELECT count(*) FROM public.petro_finance_journal_entries)<>journal_before THEN RAISE EXCEPTION 'Rejected claim moved money';END IF;
 IF public.petro_decide_service_refund(target_request,1,'reject',NULL,NULL,'actual-refund-reject-0001') IS DISTINCT FROM decision THEN RAISE EXCEPTION 'Decision rejection replay changed';END IF;
 BEGIN PERFORM public.petro_withdraw_service_refund(target_request,1,'actual-refund-closed-withdraw');RAISE EXCEPTION 'Decided request withdrawn';EXCEPTION WHEN SQLSTATE 'PT409' THEN IF SQLERRM<>'REFUND_VERSION_CONFLICT' THEN RAISE;END IF;END;
 SELECT snapshot INTO original_receipt FROM petro_private.service_order_receipts WHERE payment_id=p.id;
 SELECT ledger_balance_minor INTO amount_before FROM public.petro_finance_account_balances WHERE account_id=(SELECT account_id FROM public.petro_finance_reservations WHERE id=p.financial_reservation_id);
 SELECT ledger_balance_minor INTO control_before FROM public.petro_finance_account_balances WHERE account_id=v.control_account_id;
 SELECT count(*) INTO stock_before FROM public.petro_inventory_movements;
 request:=public.petro_request_service_refund(p.order_id,'5000','billing',NULL,'actual-refund-partial-request');
 target_request:=(request->>'id')::uuid;
 BEGIN PERFORM public.petro_decide_service_refund(target_request,1,'refund','5001',NULL,'actual-refund-excess-request');RAISE EXCEPTION 'Refund exceeded requested amount';EXCEPTION WHEN check_violation THEN NULL;END;
 BEGIN PERFORM public.petro_decide_service_refund(target_request,2,'refund','4000',NULL,'actual-refund-stale-decision');RAISE EXCEPTION 'Stale refund decision accepted';EXCEPTION WHEN SQLSTATE 'PT409' THEN IF SQLERRM<>'REFUND_VERSION_CONFLICT' THEN RAISE;END IF;END;
 decision:=public.petro_decide_service_refund(target_request,1,'refund','4000',NULL,'actual-refund-partial-0001');
 IF decision->>'status'<>'refunded' OR decision->>'moneyRefunded'<>'true' OR decision->>'refundedAmountMinor'<>'4000' THEN RAISE EXCEPTION 'Actual partial refund state missing: %',decision;END IF;
 refunded_entry:=(decision->>'journalEntryId')::uuid;
 IF public.petro_decide_service_refund(target_request,1,'refund','4000',NULL,'actual-refund-partial-0001') IS DISTINCT FROM decision THEN RAISE EXCEPTION 'Actual refund replay changed';END IF;
 BEGIN PERFORM public.petro_decide_service_refund(target_request,1,'refund','3999',NULL,'actual-refund-partial-0001');RAISE EXCEPTION 'Changed refund amount reused key';EXCEPTION WHEN unique_violation THEN NULL;END;
 IF(SELECT ledger_balance_minor FROM public.petro_finance_account_balances WHERE account_id=(SELECT account_id FROM public.petro_finance_reservations WHERE id=p.financial_reservation_id))<>amount_before+4000
 OR(SELECT ledger_balance_minor FROM public.petro_finance_account_balances WHERE account_id=v.control_account_id)<>control_before-4000 THEN RAISE EXCEPTION 'Refund did not credit original funding/debit merchant control exactly';END IF;
 IF NOT EXISTS(SELECT 1 FROM petro_private.service_refund_allocations WHERE request_id=target_request AND payment_id=p.id AND amount_minor=4000 AND unsettled_amount_minor=4000 AND merchant_debt_minor=0) THEN
 RAISE EXCEPTION 'Original receivable allocation absent';END IF;
 read_view:=public.petro_service_order_refund_requests(p.order_id);
 IF read_view->>'refundedAmountMinor'<>'4000' OR read_view->>'remainingRequestableMinor'<>'4750' OR read_view->>'requestedAmountMinor'<>'0' THEN RAISE EXCEPTION 'Closed partial request capacity wrong: %',read_view;END IF;
 SELECT x INTO item FROM jsonb_array_elements(read_view->'items') x WHERE x->>'id'=target_request::text;
 IF item->>'status'<>'refunded' OR item->>'canWithdraw'<>'false' OR item->'decision'->'document'->'snapshot'->>'taxTreatment'<>'not_configured'
 OR item->'decision'->'document'->'snapshot'->>'originalReceiptNumber'<>(SELECT receipt_number FROM petro_private.service_order_receipts WHERE payment_id=p.id) THEN RAISE EXCEPTION 'Immutable service credit document invalid: %',item;END IF;
 BEGIN PERFORM public.petro_finance_admin_reverse_journal(refunded_entry,'رفض عكس قيد رد خدمة','actual-refund-generic-reverse');RAISE EXCEPTION 'Refund journal reversed without updating subledger';EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'USE_SERVICE_ORDER_REFUND_WORKFLOW' THEN RAISE;END IF;END;
 request:=public.petro_request_service_refund(p.order_id,'4750','quality',NULL,'actual-refund-remainder-request');
 PERFORM public.petro_decide_service_refund((request->>'id')::uuid,1,'refund','4750',NULL,'actual-refund-remainder-0001');
 BEGIN PERFORM public.petro_request_service_refund(p.order_id,'1','quality',NULL,'actual-refund-overpayment-01');RAISE EXCEPTION 'Fully refunded original accepted extra claim';EXCEPTION WHEN check_violation THEN NULL;END;
 IF(SELECT sum(amount_minor) FROM petro_private.service_refund_allocations WHERE payment_id=p.id)<>8750
 OR(SELECT snapshot FROM petro_private.service_order_receipts WHERE payment_id=p.id) IS DISTINCT FROM original_receipt
 OR(SELECT count(*) FROM public.petro_inventory_movements)<>stock_before THEN RAISE EXCEPTION 'Refund edited original receipt, exceeded payment or moved stock';END IF;

 -- Actual balanced payout journal/immutable allocation as a disposable historical-settlement fixture.
 -- Monthly bank-proof/eligibility authorization belongs to the future withdrawal RPC, not a public endpoint here.
 SELECT * INTO STRICT p FROM petro_private.service_order_payments WHERE charged_amount_minor=10000;
 SELECT * INTO STRICT v FROM petro_private.service_order_receivables WHERE payment_id=p.id;
 SELECT id INTO STRICT bank_account FROM public.petro_finance_accounts WHERE account_kind='bank_clearing' LIMIT 1;
 PERFORM petro_private.finance_post_entry(settlement_entry,'internal_transfer',gen_random_uuid(),v.merchant_organization_id,'MERCHANT-SETTLEMENT:'||p.id::text,'سداد تاجر اصطناعي معزول',
 jsonb_build_array(jsonb_build_object('accountId',v.control_account_id,'side','debit','amountMinor','9000'),jsonb_build_object('accountId',bank_account,'side','credit','amountMinor','9000')));
 INSERT INTO petro_private.service_receivable_settlements(payment_id,journal_entry_id,amount_minor,created_by) VALUES(p.id,settlement_entry,9000,auth.uid());
 request:=public.petro_request_service_refund(p.order_id,'10000','quality',NULL,'actual-refund-settled-request');
 decision:=public.petro_decide_service_refund((request->>'id')::uuid,1,'refund','10000',NULL,'actual-refund-after-settlement');
 IF NOT EXISTS(SELECT 1 FROM petro_private.service_refund_allocations WHERE payment_id=p.id AND amount_minor=10000 AND unsettled_amount_minor=1000 AND merchant_debt_minor=9000) THEN RAISE EXCEPTION 'After-settlement refund hid merchant debt in company funding';END IF;
 SELECT id INTO STRICT debt_account FROM public.petro_finance_accounts WHERE account_code='SYS-MERCHANT-REFUND-RECEIVABLE';
 IF(SELECT ledger_balance_minor FROM public.petro_finance_account_balances WHERE account_id=debt_account)<>9000 THEN RAISE EXCEPTION 'Merchant refund debt account not debited';END IF;
 BEGIN PERFORM public.petro_finance_admin_reverse_journal(settlement_entry,'رفض عكس سداد مسجل','actual-settlement-reverse-deny');RAISE EXCEPTION 'Settlement reversed outside adjustment workflow';EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'USE_SERVICE_SETTLEMENT_ADJUSTMENT_WORKFLOW' THEN RAISE;END IF;END;
 IF(SELECT count(*) FROM public.petro_inventory_movements)<>stock_before THEN RAISE EXCEPTION 'Money refund restocked physical units';END IF;
 IF EXISTS(SELECT 1 FROM public.petro_finance_journal_lines l JOIN public.petro_finance_journal_entries j ON j.id=l.entry_id WHERE j.entry_type='service_refund' GROUP BY j.id HAVING sum(l.amount_minor)FILTER(WHERE side='debit')<>sum(l.amount_minor)FILTER(WHERE side='credit')) THEN RAISE EXCEPTION 'Refund journal imbalance';END IF;
 BEGIN UPDATE petro_private.service_refund_decisions SET amount_minor=1 WHERE payment_id=p.id;RAISE EXCEPTION 'Refund decisions edited';EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;END;
END $actual_refund$;
