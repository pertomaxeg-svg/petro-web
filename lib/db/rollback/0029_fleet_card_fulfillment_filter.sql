BEGIN;

DO $card_fulfillment_filter_rollback$
DECLARE
  definition text := pg_catalog.pg_get_functiondef('public.petro_admin_fleet_cards_catalog(text,jsonb)'::regprocedure);
  targets text[] := ARRAY[$target$  selected_status text := nullif(btrim(p_filters->>'status'),'');
  selected_fulfillment text := nullif(btrim(p_filters->>'fulfillmentMethod'),'');$target$,
    $target$  IF selected_fulfillment IS NOT NULL AND
     (selected_fulfillment NOT IN ('install','pickup') OR p_view<>'requests') THEN
    RAISE EXCEPTION 'INVALID_CARD_FULFILLMENT_FILTER' USING ERRCODE='22023';
  END IF;

  IF p_view = 'overview' THEN$target$,
    $target$        AND (selected_status IS NULL OR request.status=selected_status)
        AND (selected_fulfillment IS NULL OR request.fulfillment_method=selected_fulfillment)$target$];
  replacements text[] := ARRAY[$replacement$  selected_status text := nullif(btrim(p_filters->>'status'),'');$replacement$,
    $replacement$  IF p_view = 'overview' THEN$replacement$,
    $replacement$        AND (selected_status IS NULL OR request.status=selected_status)$replacement$];
  i integer;
BEGIN
  FOR i IN 1..array_length(targets,1) LOOP
    IF cardinality(string_to_array(definition,targets[i]))<>2 THEN
      RAISE EXCEPTION '0029 rollback card catalog anchor % differs from reviewed source',i;
    END IF;
    definition := replace(definition,targets[i],replacements[i]);
  END LOOP;
  IF md5(definition)<>'bd041ff8a089cced5cc5a6370e34333d' THEN
    RAISE EXCEPTION '0029 rollback would not restore reviewed card catalog';
  END IF;
  EXECUTE definition;
END
$card_fulfillment_filter_rollback$;

COMMIT;
