-- Runs only within the disposable paid-product acceptance transaction.
DO $physical_return$
DECLARE p petro_private.service_order_payments%ROWTYPE;o public.petro_service_orders%ROWTYPE;source_move public.petro_inventory_movements%ROWTYPE;
 quarantine uuid:=gen_random_uuid();damaged uuid:=gen_random_uuid();received jsonb;inspected jsonb;view_data jsonb;return_id uuid;
 original_on_hand numeric;quarantine_on_hand numeric;finance_count bigint;movement_count bigint;doc_id uuid;escape_doc jsonb;
BEGIN
 PERFORM set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000003701',true);
 SELECT pay.* INTO STRICT p FROM petro_private.service_order_payments pay JOIN public.petro_service_orders so ON so.id=pay.order_id WHERE so.kind='product';
 SELECT * INTO STRICT o FROM public.petro_service_orders WHERE id=p.order_id;
 SELECT * INTO STRICT source_move FROM public.petro_inventory_movements WHERE reservation_id=o.inventory_reservation_id AND movement_kind='consume';
 INSERT INTO public.petro_inventory_locations(id,organization_id,branch_id,name,location_kind,created_by)
 VALUES(quarantine,o.merchant_organization_id,o.merchant_branch_id,'حجر مرتجع خدمة معزول','quarantine',auth.uid()),
 (damaged,o.merchant_organization_id,o.merchant_branch_id,'تالف مرتجع خدمة معزول','damaged',auth.uid());
 SELECT on_hand INTO STRICT original_on_hand FROM public.petro_inventory_balances WHERE location_id=o.inventory_location_id AND item_id=o.catalog_item_id;
 SELECT count(*) INTO finance_count FROM public.petro_finance_journal_entries;
 SELECT count(*) INTO movement_count FROM public.petro_inventory_movements;
 view_data:=public.petro_service_product_returns(o.id,1);
 IF view_data->>'applicable'<>'true' OR view_data->>'remainingReturnableQuantity'<>'1' OR view_data->>'canReceive'<>'true' THEN RAISE EXCEPTION 'Paid product physical return view invalid: %',view_data;END IF;
 -- An actual consumed service unit is NOT a manual issue movement. Keep generic guards.
 BEGIN
  PERFORM public.petro_inventory_admin_command('document.create',jsonb_build_object('organizationId',o.merchant_organization_id,'sourceLocationId',o.inventory_location_id,'targetLocationId',quarantine,'type','return','reason','فحص ربط مرتجع خدمة معزول','lines',jsonb_build_array(jsonb_build_object('itemId',o.catalog_item_id,'quantity','1','sourceMovementId',source_move.id))),'physical-return-generic-0041');
  RAISE EXCEPTION 'Generic inventory return accepted service consumption';
 EXCEPTION WHEN check_violation THEN NULL;END;
 BEGIN PERFORM public.petro_receive_service_product_return(o.id,1,o.inventory_location_id,'1',NULL,'physical-wrong-target-0041');RAISE EXCEPTION 'Returned unit became sellable before inspection';EXCEPTION WHEN check_violation THEN NULL;END;
 BEGIN PERFORM public.petro_receive_service_product_return(o.id,1,quarantine,'2',NULL,'physical-over-receive-0041');RAISE EXCEPTION 'Received more than actually delivered';EXCEPTION WHEN check_violation THEN NULL;END;
 received:=public.petro_receive_service_product_return(o.id,1,quarantine,'1',NULL,'physical-receive-valid-0041');
 IF received->>'status'<>'received' OR received->>'quantity'<>'1' THEN RAISE EXCEPTION 'Physical receipt missing: %',received;END IF;
 return_id:=(received->>'id')::uuid;doc_id:=(received->>'documentId')::uuid;
 IF public.petro_receive_service_product_return(o.id,1,quarantine,'1',NULL,'physical-receive-valid-0041') IS DISTINCT FROM received THEN RAISE EXCEPTION 'Physical receipt replay changed';END IF;
 IF(SELECT on_hand FROM public.petro_inventory_balances WHERE location_id=o.inventory_location_id AND item_id=o.catalog_item_id)<>original_on_hand
 OR(SELECT on_hand FROM public.petro_inventory_balances WHERE location_id=quarantine AND item_id=o.catalog_item_id)<>1
 OR(SELECT reserved FROM public.petro_inventory_balances WHERE location_id=quarantine AND item_id=o.catalog_item_id)<>1 THEN RAISE EXCEPTION 'Physical receipt did not add exactly one quarantined unit';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.petro_inventory_documents WHERE id=doc_id AND document_type='return' AND status='approved' AND target_location_id=quarantine)
 OR NOT EXISTS(SELECT 1 FROM public.petro_inventory_document_lines WHERE document_id=doc_id AND related_movement_id=source_move.id AND quantity=1) THEN RAISE EXCEPTION 'Physical return lost original consume lineage';END IF;
 BEGIN PERFORM public.petro_receive_service_product_return(o.id,1,quarantine,'1',NULL,'physical-stale-receive-0041');RAISE EXCEPTION 'Stale return accepted';EXCEPTION WHEN SQLSTATE 'PT409' THEN IF SQLERRM<>'PRODUCT_RETURN_VERSION_CONFLICT' THEN RAISE;END IF;END;
 BEGIN PERFORM public.petro_receive_service_product_return(o.id,2,quarantine,'1',NULL,'physical-double-receive-0041');RAISE EXCEPTION 'Actual delivered unit returned twice';EXCEPTION WHEN check_violation THEN NULL;END;
 BEGIN PERFORM public.petro_receive_service_product_return(o.id,1,quarantine,'2',NULL,'physical-receive-valid-0041');RAISE EXCEPTION 'Changed physical intent reused key';EXCEPTION WHEN unique_violation THEN NULL;END;
 escape_doc:=public.petro_inventory_admin_command('document.create',jsonb_build_object('organizationId',o.merchant_organization_id,'sourceLocationId',quarantine,'targetLocationId',o.inventory_location_id,'type','transfer','reason','اختبار منع تجاوز حجر مرتجع الخدمة','lines',jsonb_build_array(jsonb_build_object('itemId',o.catalog_item_id,'quantity','1'))),'physical-quarantine-escape-doc');
 BEGIN PERFORM public.petro_inventory_admin_command('document.review',jsonb_build_object('documentId',escape_doc->>'id','decision','approve','reason','اختبار عزل الكمية المحجوزة للفحص'),'physical-quarantine-escape-review');RAISE EXCEPTION 'Generic transfer bypassed physical inspection hold';EXCEPTION WHEN check_violation THEN NULL;END;
 PERFORM public.petro_inventory_admin_command('document.review',jsonb_build_object('documentId',escape_doc->>'id','decision','reject','reason','إغلاق محاولة تجاوز حجر معزولة'),'physical-quarantine-escape-reject');
 PERFORM set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000003702',true);
 BEGIN PERFORM public.petro_receive_service_product_return(o.id,2,quarantine,'1',NULL,'physical-worker-denied-0041');RAISE EXCEPTION 'Service worker received physical stock without inventory approval';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 view_data:=public.petro_service_product_returns(o.id,1);
 IF view_data->>'canReceive'<>'false' OR view_data->>'returnedQuantity'<>'1' THEN RAISE EXCEPTION 'Worker read scope/actions invalid';END IF;
 PERFORM set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000003701',true);
 BEGIN PERFORM public.petro_inspect_service_product_return(return_id,1,quarantine,'1','accepted',NULL,'physical-invalid-inspect-0041');RAISE EXCEPTION 'Inspection accepted into quarantine';EXCEPTION WHEN check_violation THEN NULL;END;
 inspected:=public.petro_inspect_service_product_return(return_id,1,o.inventory_location_id,'1','accepted',NULL,'physical-inspect-valid-0041');
 IF inspected->>'status'<>'inspected' OR inspected->>'quantity'<>'1' THEN RAISE EXCEPTION 'Physical inspection missing';END IF;
 IF public.petro_inspect_service_product_return(return_id,1,o.inventory_location_id,'1','accepted',NULL,'physical-inspect-valid-0041') IS DISTINCT FROM inspected THEN RAISE EXCEPTION 'Inspection replay changed';END IF;
 IF(SELECT on_hand FROM public.petro_inventory_balances WHERE location_id=quarantine AND item_id=o.catalog_item_id)<>0
 OR(SELECT reserved FROM public.petro_inventory_balances WHERE location_id=quarantine AND item_id=o.catalog_item_id)<>0
 OR(SELECT on_hand FROM public.petro_inventory_balances WHERE location_id=o.inventory_location_id AND item_id=o.catalog_item_id)<>original_on_hand+1
 OR(SELECT count(*) FROM public.petro_inventory_movements)<>movement_count+3 THEN RAISE EXCEPTION 'Inspection duplicated or lost returned stock';END IF;
 IF(SELECT count(*) FROM public.petro_finance_journal_entries)<>finance_count THEN RAISE EXCEPTION 'Physical return posted money';END IF;
 BEGIN PERFORM public.petro_inspect_service_product_return(return_id,1,damaged,'1','damaged',NULL,'physical-inspect-stale-0041');RAISE EXCEPTION 'Stale inspection accepted';EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
 BEGIN PERFORM public.petro_inspect_service_product_return(return_id,2,damaged,'1','damaged',NULL,'physical-double-inspect-0041');RAISE EXCEPTION 'Returned unit inspected twice';EXCEPTION WHEN check_violation THEN NULL;END;
 BEGIN UPDATE petro_private.service_product_returns SET quantity=2 WHERE id=return_id;RAISE EXCEPTION 'Physical history changed';EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;END;
 view_data:=public.petro_service_product_returns(o.id,1);
 IF view_data->>'returnedQuantity'<>'1' OR view_data->>'remainingReturnableQuantity'<>'0' OR view_data->>'awaitingInspectionQuantity'<>'0' OR view_data->>'acceptedQuantity'<>'1' THEN RAISE EXCEPTION 'Physical return summary not reconciled: %',view_data;END IF;
END $physical_return$;
