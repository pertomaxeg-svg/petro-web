BEGIN;
-- Quote-only scoped RPCs: no order, financial hold, stock movement or journal write.
CREATE FUNCTION petro_private.worker_service_quote_context(p_proof_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE proof petro_private.worker_pin_proofs%ROWTYPE; merchant_id uuid; kind text;
BEGIN
 SELECT * INTO proof FROM petro_private.worker_pin_proofs WHERE id=p_proof_id AND actor_id=auth.uid();
 IF NOT FOUND OR NOT coalesce(petro_private.worker_pin_proof_valid(proof.id,auth.uid(),proof.merchant_branch_id,proof.service_group),false) THEN
 RAISE EXCEPTION 'OPERATIONAL_PROOF_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT b.organization_id,o.kind INTO merchant_id,kind FROM public.petro_branches b JOIN public.petro_organizations o ON o.id=b.organization_id WHERE b.id=proof.merchant_branch_id;
 IF kind='provider' AND NOT coalesce(petro_private.subscription_allows_new_service(merchant_id,proof.merchant_branch_id),false) THEN
 RAISE EXCEPTION 'PROVIDER_SUBSCRIPTION_REQUIRED' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('proofId',proof.id,'branchId',proof.merchant_branch_id,'merchantId',merchant_id,'serviceGroup',proof.service_group,
 'vehicleId',proof.vehicle_id,'linkId',proof.link_id,'expiresAt',proof.expires_at);
END $$;

CREATE FUNCTION petro_private.worker_service_item_price(p_context jsonb,p_reference_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 IF p_context->>'serviceGroup'='fuel' THEN
  SELECT jsonb_build_object('id',f.id,'name',f.name_ar,'kind','fuel','brandName',NULL,'unitCode',f.unit_code,
   'quantityScale',least(u.quantity_scale,3),'priceVersionId',price.id,'unitPriceMinor',trim_scale(price.price_per_unit*100)::text)
  INTO result FROM public.petro_fuel_types f JOIN public.petro_catalog_units u ON u.code=f.unit_code AND u.active
  JOIN public.petro_fleet_vehicles v ON v.id=(p_context->>'vehicleId')::uuid AND v.fuel_type=f.code
  JOIN LATERAL(SELECT p.id,p.price_per_unit FROM public.petro_fuel_price_versions p WHERE p.fuel_type_id=f.id AND p.status='published'
   AND p.valid_from<=now() AND (p.valid_to IS NULL OR p.valid_to>now()) AND p.unit_code=f.unit_code
   ORDER BY p.valid_from DESC,p.version DESC,p.id LIMIT 1) price ON true
  WHERE f.id=p_reference_id AND f.active;
 ELSE
  SELECT jsonb_build_object('id',i.id,'name',i.name,'kind',i.item_kind,'brandName',i.brand_name,'unitCode',i.unit_code,
   'quantityScale',least(u.quantity_scale,3),'priceVersionId',price.id,'unitPriceMinor',price.price_minor::text)
  INTO result FROM public.petro_catalog_items i JOIN public.petro_catalog_categories c ON c.id=i.category_id AND c.active
  JOIN public.petro_catalog_units u ON u.code=i.unit_code AND u.active
  JOIN public.petro_catalog_branch_availability availability ON availability.item_id=i.id
   AND availability.organization_id=i.organization_id AND availability.branch_id=(p_context->>'branchId')::uuid AND availability.available
  JOIN LATERAL(SELECT p.id,p.price_minor FROM public.petro_catalog_price_versions p WHERE p.item_id=i.id AND p.organization_id=i.organization_id
   AND (p.branch_id IS NULL OR p.branch_id=(p_context->>'branchId')::uuid) AND p.status='published'
   AND p.valid_from<=now() AND (p.valid_to IS NULL OR p.valid_to>now())
   ORDER BY (p.branch_id IS NOT NULL) DESC,p.valid_from DESC,p.version DESC,p.id LIMIT 1) price ON true
  WHERE i.id=p_reference_id AND i.organization_id=(p_context->>'merchantId')::uuid AND c.domain_kind='catalog'
   AND i.display_status='active' AND i.review_status='approved' AND NOT i.central_suspended
   AND (CASE WHEN c.code IN ('wash','oils','batteries','filters','parts','consumables') THEN c.code ELSE c.service_group END)=p_context->>'serviceGroup';
 END IF;
 RETURN result;
END $$;

CREATE FUNCTION public.petro_worker_service_options(p_proof_id uuid,p_search text DEFAULT NULL,p_page integer DEFAULT 1,p_page_size integer DEFAULT 20) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE context jsonb; ids uuid[]; reference uuid; item jsonb; items jsonb:='[]'::jsonb; total integer; position integer:=0;
BEGIN
 IF p_page IS NULL OR p_page NOT BETWEEN 1 AND 100000 OR p_page_size IS NULL OR p_page_size NOT BETWEEN 1 AND 50 OR char_length(coalesce(p_search,''))>160 THEN
 RAISE EXCEPTION 'INVALID_QUOTE_FILTER' USING ERRCODE='22023'; END IF;
 context:=petro_private.worker_service_quote_context(p_proof_id);
 IF context->>'serviceGroup'='fuel' THEN
  SELECT array_agg(f.id ORDER BY f.name_ar,f.id) INTO ids FROM public.petro_fuel_types f JOIN public.petro_fleet_vehicles v
   ON v.id=(context->>'vehicleId')::uuid AND v.fuel_type=f.code
   WHERE f.active AND (nullif(btrim(p_search),'') IS NULL OR f.name_ar ILIKE '%'||btrim(p_search)||'%');
 ELSE
  SELECT array_agg(i.id ORDER BY i.name,i.id) INTO ids FROM public.petro_catalog_items i JOIN public.petro_catalog_categories c ON c.id=i.category_id AND c.active
  WHERE i.organization_id=(context->>'merchantId')::uuid AND i.display_status='active' AND i.review_status='approved' AND NOT i.central_suspended
   AND (CASE WHEN c.code IN ('wash','oils','batteries','filters','parts','consumables') THEN c.code ELSE c.service_group END)=context->>'serviceGroup'
   AND EXISTS(SELECT 1 FROM public.petro_catalog_branch_availability a WHERE a.item_id=i.id AND a.branch_id=(context->>'branchId')::uuid AND a.available)
   AND (nullif(btrim(p_search),'') IS NULL OR i.name ILIKE '%'||btrim(p_search)||'%' OR coalesce(i.brand_name,'') ILIKE '%'||btrim(p_search)||'%');
 END IF;
 total:=0;
 FOREACH reference IN ARRAY coalesce(ids,'{}'::uuid[]) LOOP
  item:=petro_private.worker_service_item_price(context,reference);
  IF item IS NULL THEN CONTINUE; END IF;
  total:=total+1;
  IF total<=(p_page-1)*p_page_size OR jsonb_array_length(items)>=p_page_size THEN CONTINUE; END IF;
  IF item->>'kind'='product' THEN
   item:=item||jsonb_build_object('locations',coalesce((SELECT jsonb_agg(jsonb_build_object('id',l.id,'name',l.name,'availableQuantity',trim_scale(coalesce(b.on_hand-b.reserved,0))::text) ORDER BY l.name,l.id)
    FROM public.petro_inventory_locations l LEFT JOIN public.petro_inventory_balances b ON b.location_id=l.id AND b.item_id=reference AND b.organization_id=l.organization_id
    WHERE l.organization_id=(context->>'merchantId')::uuid AND l.branch_id=(context->>'branchId')::uuid AND l.active AND l.location_kind='sellable'),'[]'::jsonb));
  ELSE item:=item||jsonb_build_object('locations','[]'::jsonb); END IF;
  items:=items||jsonb_build_array(item);
 END LOOP;
 RETURN jsonb_build_object('items',items,'total',total,'page',p_page,'pageSize',p_page_size,'expiresAt',context->>'expiresAt');
END $$;

CREATE FUNCTION public.petro_worker_quote_service(p_proof_id uuid,p_reference_id uuid,p_price_version_id uuid,p_input jsonb,p_location_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE context jsonb; item jsonb; quantity numeric; amount numeric; target numeric; scope jsonb; available bigint:=0; stock numeric:=0;
 policy_allowed boolean; funds_allowed boolean; stock_allowed boolean; denial text; result jsonb;
BEGIN
 context:=petro_private.worker_service_quote_context(p_proof_id);
 IF p_reference_id IS NULL OR p_price_version_id IS NULL OR jsonb_typeof(p_input) IS DISTINCT FROM 'object'
 OR (SELECT count(*) FROM jsonb_object_keys(p_input))<>1 OR NOT (p_input ? 'quantity' OR p_input ? 'amountMinor') THEN
 RAISE EXCEPTION 'INVALID_QUOTE_INPUT' USING ERRCODE='22023'; END IF;
 item:=petro_private.worker_service_item_price(context,p_reference_id);
 IF item IS NULL THEN RAISE EXCEPTION 'SERVICE_PRICE_UNAVAILABLE' USING ERRCODE='23514'; END IF;
 IF item->>'priceVersionId' IS DISTINCT FROM p_price_version_id::text THEN RAISE EXCEPTION 'SERVICE_PRICE_CHANGED' USING ERRCODE='40001'; END IF;
 IF p_input ? 'amountMinor' THEN
  IF item->>'kind'<>'fuel' OR coalesce(p_input->>'amountMinor','') !~ '^[0-9]{1,15}$' THEN RAISE EXCEPTION 'INVALID_FUEL_AMOUNT' USING ERRCODE='22023'; END IF;
  target:=(p_input->>'amountMinor')::numeric;
  quantity:=floor(target/(item->>'unitPriceMinor')::numeric*1000)/1000;
 ELSE
  IF coalesce(p_input->>'quantity','') !~ '^[0-9]{1,9}(\.[0-9]{1,3})?$' THEN RAISE EXCEPTION 'INVALID_QUOTE_QUANTITY' USING ERRCODE='22023'; END IF;
  quantity:=(p_input->>'quantity')::numeric;
 END IF;
 IF quantity<=0 OR round(quantity,(item->>'quantityScale')::integer)<>quantity THEN RAISE EXCEPTION 'INVALID_UNIT_QUANTITY' USING ERRCODE='22023'; END IF;
 amount:=round(quantity*(item->>'unitPriceMinor')::numeric);
 IF amount<=0 OR amount>9000000000000000 OR (target IS NOT NULL AND amount>target) THEN RAISE EXCEPTION 'INVALID_QUOTE_AMOUNT' USING ERRCODE='22023'; END IF;
 scope:=petro_private.fleet_check_usage_policy((context->>'vehicleId')::uuid,(context->>'linkId')::uuid,(context->>'merchantId')::uuid,(context->>'branchId')::uuid,context->>'serviceGroup',amount::bigint,quantity);
 policy_allowed:=coalesce((scope->>'allowed')::boolean,false);
 SELECT coalesce(b.available_minor,0) INTO available FROM public.petro_finance_accounts a JOIN public.petro_finance_account_balances b ON b.account_id=a.id
 WHERE a.organization_id=(SELECT organization_id FROM public.petro_fleet_vehicles WHERE id=(context->>'vehicleId')::uuid)
 AND a.branch_id=(SELECT branch_id FROM public.petro_fleet_vehicles WHERE id=(context->>'vehicleId')::uuid) AND a.account_kind='branch_funding';
 funds_allowed:=coalesce(available,0)>=amount;
 stock_allowed:=item->>'kind'<>'product';
 IF item->>'kind'='product' THEN
  IF p_location_id IS NULL THEN RAISE EXCEPTION 'INVENTORY_LOCATION_REQUIRED' USING ERRCODE='22023'; END IF;
  SELECT coalesce(b.on_hand-b.reserved,0) INTO stock FROM public.petro_inventory_locations l
   LEFT JOIN public.petro_inventory_balances b ON b.location_id=l.id AND b.item_id=p_reference_id AND b.organization_id=l.organization_id
   WHERE l.id=p_location_id AND l.organization_id=(context->>'merchantId')::uuid AND l.branch_id=(context->>'branchId')::uuid AND l.active AND l.location_kind='sellable';
  stock_allowed:=FOUND AND stock>=quantity;
 ELSIF p_location_id IS NOT NULL THEN RAISE EXCEPTION 'UNEXPECTED_INVENTORY_LOCATION' USING ERRCODE='22023';
 END IF;
 denial:=CASE WHEN NOT policy_allowed THEN coalesce(scope->>'reason','policy_denied') WHEN NOT funds_allowed THEN 'insufficient_funds' WHEN NOT stock_allowed THEN 'out_of_stock' ELSE NULL END;
 result:=jsonb_build_object('proofId',p_proof_id,'item',item,'locationId',p_location_id,'quantity',trim_scale(quantity)::text,'amountMinor',amount::bigint::text,
  'canReserve',policy_allowed AND funds_allowed AND stock_allowed,'denialCode',denial,'expiresAt',context->>'expiresAt','quotedAt',now());
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION petro_private.worker_service_quote_context(uuid),petro_private.worker_service_item_price(jsonb,uuid),
 public.petro_worker_service_options(uuid,text,integer,integer),public.petro_worker_quote_service(uuid,uuid,uuid,jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.petro_worker_service_options(uuid,text,integer,integer),public.petro_worker_quote_service(uuid,uuid,uuid,jsonb,uuid) TO authenticated;
COMMIT;
