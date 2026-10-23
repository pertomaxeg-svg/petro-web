BEGIN;

DO $issued_card_categories$
DECLARE
  definition text;
  target text := '(selected_status IS NULL OR credential.status=selected_status)';
  replacement text := '(selected_status IS NULL OR (selected_status=''inactive'' AND credential.status<>''active'') OR credential.status=selected_status)';
BEGIN
  definition := pg_catalog.pg_get_functiondef('public.petro_admin_fleet_cards_catalog(text,jsonb)'::regprocedure);
  IF cardinality(string_to_array(definition,target))<>2 THEN
    RAISE EXCEPTION '0027 issued-card catalog differs from reviewed source';
  END IF;
  EXECUTE replace(definition,target,replacement);
END
$issued_card_categories$;

COMMIT;
