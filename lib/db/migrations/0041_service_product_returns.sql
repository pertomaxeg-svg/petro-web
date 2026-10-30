BEGIN;
CREATE TABLE petro_private.service_product_returns(
 id uuid PRIMARY KEY,order_id uuid NOT NULL REFERENCES public.petro_service_orders(id),
 payment_id uuid NOT NULL REFERENCES petro_private.service_order_payments(id),
 merchant_organization_id uuid NOT NULL REFERENCES public.petro_organizations(id),merchant_branch_id uuid NOT NULL,
 item_id uuid NOT NULL,source_movement_id bigint NOT NULL REFERENCES public.petro_inventory_movements(id),
 inventory_document_id uuid NOT NULL UNIQUE REFERENCES public.petro_inventory_documents(id),
 return_movement_id bigint NOT NULL UNIQUE REFERENCES public.petro_inventory_movements(id),
 quarantine_location_id uuid NOT NULL REFERENCES public.petro_inventory_locations(id),
 quantity numeric(20,6) NOT NULL CHECK(quantity>0 AND quantity<1000000000000),
 received_by uuid NOT NULL REFERENCES auth.users(id),received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 FOREIGN KEY(merchant_branch_id,merchant_organization_id) REFERENCES public.petro_branches(id,organization_id),
 FOREIGN KEY(item_id,merchant_organization_id) REFERENCES public.petro_catalog_items(id,organization_id)
);
CREATE INDEX service_product_returns_order_idx ON petro_private.service_product_returns(order_id,received_at,id);
CREATE INDEX service_product_returns_source_idx ON petro_private.service_product_returns(source_movement_id);
CREATE TABLE petro_private.service_product_return_inspections(
 id uuid PRIMARY KEY,return_id uuid NOT NULL REFERENCES petro_private.service_product_returns(id),
 inventory_document_id uuid NOT NULL UNIQUE REFERENCES public.petro_inventory_documents(id),
 target_location_id uuid NOT NULL REFERENCES public.petro_inventory_locations(id),
 quantity numeric(20,6) NOT NULL CHECK(quantity>0 AND quantity<1000000000000),
 disposition text NOT NULL CHECK(disposition IN('accepted','damaged')),
 inspected_by uuid NOT NULL REFERENCES auth.users(id),inspected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object')
);
CREATE INDEX service_product_return_inspections_return_idx ON petro_private.service_product_return_inspections(return_id,inspected_at,id);
CREATE TABLE petro_private.service_product_return_commands(
 actor_id uuid NOT NULL REFERENCES auth.users(id),request_key text NOT NULL CHECK(request_key~'^[A-Za-z0-9._:-]{16,120}$'),
 fingerprint text NOT NULL CHECK(fingerprint~'^[0-9a-f]{64}$'),result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(actor_id,request_key)
);
ALTER TABLE petro_private.service_product_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE petro_private.service_product_return_inspections ENABLE ROW LEVEL SECURITY;
ALTER TABLE petro_private.service_product_return_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON petro_private.service_product_returns,petro_private.service_product_return_inspections,petro_private.service_product_return_commands FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION petro_private.guard_service_product_return_history() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Service product return history is immutable' USING ERRCODE='55000';END $$;
REVOKE ALL ON FUNCTION petro_private.guard_service_product_return_history() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER service_product_return_immutable BEFORE UPDATE OR DELETE ON petro_private.service_product_returns FOR EACH ROW EXECUTE FUNCTION petro_private.guard_service_product_return_history();
CREATE TRIGGER service_product_return_inspection_immutable BEFORE UPDATE OR DELETE ON petro_private.service_product_return_inspections FOR EACH ROW EXECUTE FUNCTION petro_private.guard_service_product_return_history();
CREATE TRIGGER service_product_return_command_immutable BEFORE UPDATE OR DELETE ON petro_private.service_product_return_commands FOR EACH ROW EXECUTE FUNCTION petro_private.guard_service_product_return_history();

CREATE FUNCTION public.petro_service_product_returns(p_order_id uuid,p_page integer DEFAULT 1) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE o public.petro_service_orders%ROWTYPE;d petro_private.service_order_deliveries%ROWTYPE;p petro_private.service_order_payments%ROWTYPE;
 received numeric;inspected numeric;accepted numeric;damaged numeric;can_manage boolean;locations jsonb;items jsonb;total bigint;
BEGIN
 IF p_page IS NULL OR p_page<1 OR p_page>100000 THEN RAISE EXCEPTION 'INVALID_PRODUCT_RETURN_INPUT' USING ERRCODE='22023';END IF;
 IF NOT coalesce(petro_private.service_refund_order_access(p_order_id,false),false) THEN RAISE EXCEPTION 'FORBIDDEN_PRODUCT_RETURN' USING ERRCODE='42501';END IF;
 SELECT * INTO STRICT o FROM public.petro_service_orders WHERE id=p_order_id;
 SELECT * INTO d FROM petro_private.service_order_deliveries WHERE order_id=o.id;
 SELECT * INTO p FROM petro_private.service_order_payments WHERE order_id=o.id;
 IF o.kind<>'product' OR d.order_id IS NULL OR p.id IS NULL OR o.inventory_reservation_id IS NULL THEN
 RETURN jsonb_build_object('applicable',false,'canReceive',false,'items','[]'::jsonb,'total',0,'page',p_page,'pageSize',20,'locations','[]'::jsonb);
 END IF;
 can_manage:=coalesce(petro_private.workforce_user_active(auth.uid()),false) AND coalesce(petro_private.inventory_can_write(o.merchant_organization_id,o.merchant_branch_id,true),false);
 SELECT coalesce(sum(quantity),0),count(*) INTO received,total FROM petro_private.service_product_returns WHERE order_id=o.id;
 SELECT coalesce(sum(i.quantity),0),coalesce(sum(i.quantity)FILTER(WHERE i.disposition='accepted'),0),coalesce(sum(i.quantity)FILTER(WHERE i.disposition='damaged'),0)
 INTO inspected,accepted,damaged FROM petro_private.service_product_return_inspections i JOIN petro_private.service_product_returns r ON r.id=i.return_id WHERE r.order_id=o.id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',l.id,'name',l.name,'kind',l.location_kind) ORDER BY l.location_kind,l.name,l.id),'[]'::jsonb) INTO locations
 FROM public.petro_inventory_locations l WHERE can_manage AND l.organization_id=o.merchant_organization_id AND l.branch_id=o.merchant_branch_id AND l.active AND l.location_kind IN('sellable','quarantine','damaged');
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x."open" DESC,x."receivedAt" DESC,x.id),'[]'::jsonb) INTO items FROM(
 SELECT r.id,r.inventory_document_id AS "documentId",trim_scale(r.quantity)::text AS quantity,trim_scale(r.quantity-coalesce(a.quantity,0))::text AS "remainingQuantity",
 (coalesce(a.events,0)+1)::bigint AS version,r.received_at AS "receivedAt",r.snapshot->>'actorName' AS "receivedByName",
 r.snapshot->>'locationName' AS "quarantineName",r.snapshot->>'note' AS note,(r.quantity>coalesce(a.quantity,0)) AS "open",
 can_manage AND r.quantity>coalesce(a.quantity,0) AS "canInspect",coalesce(a.events,0)::bigint AS "inspectionCount"
 FROM petro_private.service_product_returns r
 LEFT JOIN LATERAL(SELECT sum(i.quantity)AS quantity,count(*) AS events FROM petro_private.service_product_return_inspections i WHERE i.return_id=r.id)a ON true
 WHERE r.order_id=o.id ORDER BY (r.quantity>coalesce(a.quantity,0)) DESC,r.received_at DESC,r.id LIMIT 20 OFFSET(p_page-1)*20
 )x;
 RETURN jsonb_build_object('applicable',true,'orderId',o.id,'productName',o.item_snapshot->>'name','unitCode',o.item_snapshot->>'unitCode',
 'quantityScale',(o.item_snapshot->>'quantityScale')::integer,'serialNumber',d.serial_number,
 'deliveredQuantity',trim_scale(d.actual_quantity)::text,'returnedQuantity',trim_scale(received)::text,
 'remainingReturnableQuantity',trim_scale(d.actual_quantity-received)::text,'awaitingInspectionQuantity',trim_scale(received-inspected)::text,
 'acceptedQuantity',trim_scale(accepted)::text,'damagedQuantity',trim_scale(damaged)::text,
 'canReceive',can_manage AND received<d.actual_quantity,'version',total+1,'locations',locations,'items',items,'total',total,'page',p_page,'pageSize',20);
END $$;
REVOKE ALL ON FUNCTION public.petro_service_product_returns(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.petro_service_product_returns(uuid,integer) TO authenticated;

CREATE FUNCTION public.petro_service_product_return_inspections(p_return_id uuid,p_page integer DEFAULT 1) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE r petro_private.service_product_returns%ROWTYPE;items jsonb;total bigint;
BEGIN
 IF p_page IS NULL OR p_page<1 OR p_page>100000 THEN RAISE EXCEPTION 'INVALID_PRODUCT_RETURN_INPUT' USING ERRCODE='22023';END IF;
 SELECT * INTO r FROM petro_private.service_product_returns WHERE id=p_return_id;
 IF NOT FOUND OR NOT coalesce(petro_private.service_refund_order_access(r.order_id,false),false) THEN RAISE EXCEPTION 'FORBIDDEN_PRODUCT_RETURN' USING ERRCODE='42501';END IF;
 SELECT count(*) INTO total FROM petro_private.service_product_return_inspections WHERE return_id=r.id;
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x."inspectedAt" DESC,x.id),'[]'::jsonb) INTO items FROM(
 SELECT i.id,i.inventory_document_id AS "documentId",trim_scale(i.quantity)::text AS quantity,i.disposition,i.inspected_at AS "inspectedAt",
 i.snapshot->>'actorName' AS "inspectedByName",i.snapshot->>'locationName' AS "targetName",i.snapshot->>'note' AS note
 FROM petro_private.service_product_return_inspections i WHERE i.return_id=r.id ORDER BY i.inspected_at DESC,i.id LIMIT 20 OFFSET(p_page-1)*20)x;
 RETURN jsonb_build_object('returnId',r.id,'items',items,'total',total,'page',p_page,'pageSize',20);
END $$;
REVOKE ALL ON FUNCTION public.petro_service_product_return_inspections(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.petro_service_product_return_inspections(uuid,integer) TO authenticated;

CREATE FUNCTION public.petro_receive_service_product_return(p_order_id uuid,p_expected_version bigint,p_target_location_id uuid,p_quantity text,p_note text,p_request_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
<<return_intake>>
DECLARE actor uuid:=auth.uid();o public.petro_service_orders%ROWTYPE;d petro_private.service_order_deliveries%ROWTYPE;p petro_private.service_order_payments%ROWTYPE;
 m public.petro_inventory_movements%ROWTYPE;s public.petro_inventory_reservations%ROWTYPE;l public.petro_inventory_locations%ROWTYPE;
 cmd petro_private.service_product_return_commands%ROWTYPE;q numeric;received numeric;events bigint;fingerprint_value text;result jsonb;
 return_id uuid:=gen_random_uuid();document_id uuid:=gen_random_uuid();movement_id bigint;note_value text:=nullif(btrim(p_note),'');snapshot_value jsonb;
BEGIN
 SELECT * INTO o FROM public.petro_service_orders WHERE id=p_order_id;
 IF NOT FOUND OR NOT coalesce(petro_private.workforce_user_active(actor),false) OR NOT coalesce(petro_private.inventory_can_write(o.merchant_organization_id,o.merchant_branch_id,true),false) THEN RAISE EXCEPTION 'FORBIDDEN_PRODUCT_RETURN' USING ERRCODE='42501';END IF;
 IF p_expected_version IS NULL OR p_expected_version<1 OR p_quantity IS NULL OR p_quantity!~'^[0-9]{1,12}(\.[0-9]{1,6})?$'
 OR p_request_key IS NULL OR p_request_key!~'^[A-Za-z0-9._:-]{16,120}$' OR char_length(coalesce(note_value,''))>1000 THEN RAISE EXCEPTION 'INVALID_PRODUCT_RETURN_INPUT' USING ERRCODE='22023';END IF;
 q:=p_quantity::numeric;
 IF q<=0 OR q>=1000000000000 THEN RAISE EXCEPTION 'INVALID_PRODUCT_RETURN_INPUT' USING ERRCODE='22023';END IF;
 fingerprint_value:=encode(sha256(convert_to(jsonb_build_array('receive',p_order_id,p_expected_version,p_target_location_id,trim_scale(q)::text,note_value)::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('service-product-return:'||actor::text||':'||p_request_key,0));
 SELECT * INTO cmd FROM petro_private.service_product_return_commands WHERE actor_id=actor AND request_key=p_request_key;
 IF FOUND THEN IF cmd.fingerprint<>fingerprint_value THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';END IF;RETURN cmd.result;END IF;
 SELECT * INTO STRICT o FROM public.petro_service_orders WHERE id=p_order_id FOR UPDATE;
 IF NOT coalesce(petro_private.workforce_user_active(actor),false) OR NOT coalesce(petro_private.inventory_can_write(o.merchant_organization_id,o.merchant_branch_id,true),false) THEN RAISE EXCEPTION 'FORBIDDEN_PRODUCT_RETURN' USING ERRCODE='42501';END IF;
 SELECT coalesce(sum(quantity),0),count(*) INTO received,events FROM petro_private.service_product_returns WHERE order_id=o.id;
 IF p_expected_version<>events+1 THEN RAISE EXCEPTION 'PRODUCT_RETURN_VERSION_CONFLICT' USING ERRCODE='PT409';END IF;
 SELECT * INTO p FROM petro_private.service_order_payments WHERE order_id=o.id;
 SELECT * INTO d FROM petro_private.service_order_deliveries WHERE order_id=o.id;
 IF o.kind<>'product' OR p.id IS NULL OR d.order_id IS NULL OR o.inventory_reservation_id IS NULL THEN RAISE EXCEPTION 'PRODUCT_RETURN_REQUIRES_PAID_DELIVERY' USING ERRCODE='55000';END IF;
 IF (o.item_snapshot->>'quantityScale') IS NULL OR q<>round(q,(o.item_snapshot->>'quantityScale')::integer) THEN RAISE EXCEPTION 'INVALID_PRODUCT_RETURN_INPUT' USING ERRCODE='22023';END IF;
 SELECT * INTO STRICT s FROM public.petro_inventory_reservations WHERE id=o.inventory_reservation_id FOR UPDATE;
 SELECT * INTO m FROM public.petro_inventory_movements WHERE reservation_id=s.id AND movement_kind='consume' FOR UPDATE;
 IF NOT FOUND OR s.status<>'consumed' OR s.source_reference<>o.id OR s.quantity<>d.actual_quantity OR s.item_id<>o.catalog_item_id OR s.location_id<>o.inventory_location_id
 OR m.organization_id<>o.merchant_organization_id OR m.item_id<>o.catalog_item_id OR m.location_id<>o.inventory_location_id OR -m.on_hand_delta<>d.actual_quantity OR -m.reserved_delta<>d.actual_quantity THEN RAISE EXCEPTION 'PRODUCT_RETURN_ORIGIN_REQUIRES_REVIEW' USING ERRCODE='55000';END IF;
 IF received+q>d.actual_quantity THEN RAISE EXCEPTION 'PRODUCT_RETURN_EXCEEDS_DELIVERY' USING ERRCODE='23514';END IF;
 SELECT * INTO l FROM public.petro_inventory_locations WHERE id=p_target_location_id FOR SHARE;
 IF NOT FOUND OR NOT l.active OR l.location_kind<>'quarantine' OR l.organization_id<>o.merchant_organization_id OR l.branch_id IS DISTINCT FROM o.merchant_branch_id THEN RAISE EXCEPTION 'INVALID_PRODUCT_RETURN_LOCATION' USING ERRCODE='23514';END IF;
 INSERT INTO public.petro_inventory_documents(id,organization_id,source_location_id,target_location_id,document_type,status,reason,idempotency_key,payload_hash,created_by,reviewed_by,reviewed_at)
 VALUES(document_id,o.merchant_organization_id,o.inventory_location_id,l.id,'return','approved','استلام مرتجع فعلي لطلب خدمة '||o.id::text,'service-return:'||return_id::text,md5(fingerprint_value),actor,actor,clock_timestamp());
 INSERT INTO public.petro_inventory_document_lines(document_id,organization_id,item_id,quantity,related_movement_id)
 VALUES(document_id,o.merchant_organization_id,o.catalog_item_id,q,m.id);
 -- Reserve the actual quarantined units for inspection. Generic transfers/counts cannot
 -- remove these holds; only the matching scoped inspection releases its exact quantity.
 PERFORM petro_private.inventory_apply_delta(o.merchant_organization_id,l.id,o.catalog_item_id,q,q,document_id,NULL,'return','استلام وحجز مرتجع للفحص '||return_id::text);
 SELECT mv.id INTO STRICT movement_id FROM public.petro_inventory_movements mv WHERE mv.document_id=return_intake.document_id AND mv.movement_kind='return';
 snapshot_value:=jsonb_build_object('product',o.item_snapshot,'vehicle',o.vehicle_snapshot,'merchant',o.merchant_snapshot,'serialNumber',d.serial_number,'sourceMovementId',m.id::text,'locationName',l.name,'note',note_value,'actorName',(SELECT display_name FROM public.petro_profiles WHERE user_id=actor));
 INSERT INTO petro_private.service_product_returns(id,order_id,payment_id,merchant_organization_id,merchant_branch_id,item_id,source_movement_id,inventory_document_id,return_movement_id,quarantine_location_id,quantity,received_by,snapshot)
 VALUES(return_id,o.id,p.id,o.merchant_organization_id,o.merchant_branch_id,o.catalog_item_id,m.id,document_id,movement_id,l.id,q,actor,snapshot_value);
 result:=jsonb_build_object('id',return_id,'orderId',o.id,'status','received','quantity',trim_scale(q)::text,'documentId',document_id,'version',events+2);
 INSERT INTO petro_private.service_product_return_commands(actor_id,request_key,fingerprint,result) VALUES(actor,p_request_key,fingerprint_value,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.petro_receive_service_product_return(uuid,bigint,uuid,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.petro_receive_service_product_return(uuid,bigint,uuid,text,text,text) TO authenticated;

CREATE FUNCTION public.petro_inspect_service_product_return(p_return_id uuid,p_expected_version bigint,p_target_location_id uuid,p_quantity text,p_disposition text,p_note text,p_request_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=auth.uid();r petro_private.service_product_returns%ROWTYPE;o public.petro_service_orders%ROWTYPE;l public.petro_inventory_locations%ROWTYPE;
 cmd petro_private.service_product_return_commands%ROWTYPE;q numeric;inspected numeric;events bigint;fingerprint_value text;result jsonb;
 inspection_id uuid:=gen_random_uuid();document_id uuid:=gen_random_uuid();note_value text:=nullif(btrim(p_note),'');snapshot_value jsonb;
BEGIN
 SELECT * INTO r FROM petro_private.service_product_returns WHERE id=p_return_id;
 IF NOT FOUND OR NOT coalesce(petro_private.workforce_user_active(actor),false) OR NOT coalesce(petro_private.inventory_can_write(r.merchant_organization_id,r.merchant_branch_id,true),false) THEN RAISE EXCEPTION 'FORBIDDEN_PRODUCT_RETURN' USING ERRCODE='42501';END IF;
 IF p_expected_version IS NULL OR p_expected_version<1 OR p_quantity IS NULL OR p_quantity!~'^[0-9]{1,12}(\.[0-9]{1,6})?$'
 OR p_disposition IS NULL OR p_disposition NOT IN('accepted','damaged') OR p_request_key IS NULL OR p_request_key!~'^[A-Za-z0-9._:-]{16,120}$'
 OR char_length(coalesce(note_value,''))>1000 THEN RAISE EXCEPTION 'INVALID_PRODUCT_RETURN_INPUT' USING ERRCODE='22023';END IF;
 q:=p_quantity::numeric;
 IF q<=0 OR q>=1000000000000 THEN RAISE EXCEPTION 'INVALID_PRODUCT_RETURN_INPUT' USING ERRCODE='22023';END IF;
 fingerprint_value:=encode(sha256(convert_to(jsonb_build_array('inspect',p_return_id,p_expected_version,p_target_location_id,trim_scale(q)::text,p_disposition,note_value)::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('service-product-return:'||actor::text||':'||p_request_key,0));
 SELECT * INTO cmd FROM petro_private.service_product_return_commands WHERE actor_id=actor AND request_key=p_request_key;
 IF FOUND THEN IF cmd.fingerprint<>fingerprint_value THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';END IF;RETURN cmd.result;END IF;
 PERFORM 1 FROM public.petro_service_orders WHERE id=r.order_id FOR UPDATE;
 IF NOT coalesce(petro_private.workforce_user_active(actor),false) OR NOT coalesce(petro_private.inventory_can_write(r.merchant_organization_id,r.merchant_branch_id,true),false) THEN RAISE EXCEPTION 'FORBIDDEN_PRODUCT_RETURN' USING ERRCODE='42501';END IF;
 SELECT * INTO STRICT o FROM public.petro_service_orders WHERE id=r.order_id;
 SELECT coalesce(sum(quantity),0),count(*) INTO inspected,events FROM petro_private.service_product_return_inspections WHERE return_id=r.id;
 IF p_expected_version<>events+1 THEN RAISE EXCEPTION 'PRODUCT_RETURN_VERSION_CONFLICT' USING ERRCODE='PT409';END IF;
 IF q<>round(q,(o.item_snapshot->>'quantityScale')::integer) THEN RAISE EXCEPTION 'INVALID_PRODUCT_RETURN_INPUT' USING ERRCODE='22023';END IF;
 IF inspected+q>r.quantity THEN RAISE EXCEPTION 'PRODUCT_INSPECTION_EXCEEDS_RECEIPT' USING ERRCODE='23514';END IF;
 SELECT * INTO l FROM public.petro_inventory_locations WHERE id=p_target_location_id FOR SHARE;
 IF NOT FOUND OR NOT l.active OR l.organization_id<>r.merchant_organization_id OR l.branch_id IS DISTINCT FROM r.merchant_branch_id
 OR l.id=r.quarantine_location_id OR l.location_kind<>(CASE WHEN p_disposition='accepted' THEN 'sellable' ELSE 'damaged' END) THEN RAISE EXCEPTION 'INVALID_PRODUCT_RETURN_LOCATION' USING ERRCODE='23514';END IF;
 INSERT INTO public.petro_inventory_documents(id,organization_id,source_location_id,target_location_id,document_type,status,reason,idempotency_key,payload_hash,created_by,reviewed_by,reviewed_at)
 VALUES(document_id,r.merchant_organization_id,r.quarantine_location_id,l.id,CASE WHEN p_disposition='accepted' THEN 'transfer' ELSE 'damage' END,'approved','فحص وتصنيف مرتجع خدمة '||r.id::text,'service-return-inspection:'||inspection_id::text,md5(fingerprint_value),actor,actor,clock_timestamp());
 INSERT INTO public.petro_inventory_document_lines(document_id,organization_id,item_id,quantity,related_movement_id)
 VALUES(document_id,r.merchant_organization_id,r.item_id,q,r.return_movement_id);
 PERFORM petro_private.inventory_apply_delta(r.merchant_organization_id,r.quarantine_location_id,r.item_id,-q,-q,document_id,NULL,CASE WHEN p_disposition='accepted' THEN 'transfer_out' ELSE 'damage_out' END,'تحرير مرتجع بعد الفحص '||r.id::text);
 PERFORM petro_private.inventory_apply_delta(r.merchant_organization_id,l.id,r.item_id,q,0,document_id,NULL,CASE WHEN p_disposition='accepted' THEN 'transfer_in' ELSE 'damage_in' END,'نتيجة فحص مرتجع '||r.id::text);
 snapshot_value:=jsonb_build_object('locationName',l.name,'note',note_value,'actorName',(SELECT display_name FROM public.petro_profiles WHERE user_id=actor),'returnMovementId',r.return_movement_id::text);
 INSERT INTO petro_private.service_product_return_inspections(id,return_id,inventory_document_id,target_location_id,quantity,disposition,inspected_by,snapshot)
 VALUES(inspection_id,r.id,document_id,l.id,q,p_disposition,actor,snapshot_value);
 result:=jsonb_build_object('id',inspection_id,'returnId',r.id,'orderId',r.order_id,'status','inspected','quantity',trim_scale(q)::text,'disposition',p_disposition,'documentId',document_id,'version',events+2);
 INSERT INTO petro_private.service_product_return_commands(actor_id,request_key,fingerprint,result) VALUES(actor,p_request_key,fingerprint_value,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.petro_inspect_service_product_return(uuid,bigint,uuid,text,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.petro_inspect_service_product_return(uuid,bigint,uuid,text,text,text,text) TO authenticated;
COMMIT;
