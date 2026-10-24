BEGIN;

-- Additive guards and compatible catalog metadata. No business data is seeded.
-- Apply only after the disposable rebuild and the live preflight in the rollback plan.

CREATE OR REPLACE FUNCTION petro_private.catalog_attributes_valid(
  p_category_code text,p_attributes jsonb
) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=''
AS $$
BEGIN
  IF p_attributes IS NULL OR jsonb_typeof(p_attributes)<>'object' THEN RETURN false; END IF;
  IF p_category_code='wash' THEN
    IF (p_attributes-ARRAY['washMode','vehicleType','vehicleSize','vehicleTypes','durationMinutes','included','addOns'])<>'{}'::jsonb THEN RETURN false; END IF;
    IF p_attributes ? 'washMode' AND p_attributes->>'washMode' NOT IN ('interior','exterior','interior_exterior') THEN RETURN false; END IF;
    IF p_attributes ? 'vehicleType' AND (
      jsonb_typeof(p_attributes->'vehicleType')<>'string'
      OR char_length(btrim(p_attributes->>'vehicleType')) NOT BETWEEN 1 AND 80
    ) THEN RETURN false; END IF;
    IF p_attributes ? 'vehicleSize' AND (
      jsonb_typeof(p_attributes->'vehicleSize')<>'string'
      OR char_length(btrim(p_attributes->>'vehicleSize')) NOT BETWEEN 1 AND 80
    ) THEN RETURN false; END IF;
    IF p_attributes ? 'vehicleTypes' AND (
      jsonb_typeof(p_attributes->'vehicleTypes')<>'array'
      OR jsonb_array_length(p_attributes->'vehicleTypes')>30
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_attributes->'vehicleTypes') AS vals(value)
        WHERE jsonb_typeof(vals.value)<>'string' OR char_length(btrim(vals.value#>>'{}')) NOT BETWEEN 1 AND 80)
    ) THEN RETURN false; END IF;
    IF p_attributes ? 'durationMinutes' AND (
      jsonb_typeof(p_attributes->'durationMinutes')<>'number'
      OR (p_attributes->>'durationMinutes')::numeric<=0
      OR (p_attributes->>'durationMinutes')::numeric<>trunc((p_attributes->>'durationMinutes')::numeric)
    ) THEN RETURN false; END IF;
    IF p_attributes ? 'included' AND (
      jsonb_typeof(p_attributes->'included')<>'string'
      OR char_length(p_attributes->>'included')>2000
    ) THEN RETURN false; END IF;
    IF p_attributes ? 'addOns' AND (
      jsonb_typeof(p_attributes->'addOns')<>'array'
      OR jsonb_array_length(p_attributes->'addOns')>30
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_attributes->'addOns') AS vals(value)
        WHERE jsonb_typeof(vals.value)<>'string' OR char_length(btrim(vals.value#>>'{}')) NOT BETWEEN 1 AND 160)
    ) THEN RETURN false; END IF;
  ELSIF p_category_code='oils' THEN
    IF (p_attributes-ARRAY['viscosity','specification','volumeMl'])<>'{}'::jsonb THEN RETURN false; END IF;
    IF p_attributes ? 'viscosity' AND (
      jsonb_typeof(p_attributes->'viscosity')<>'string' OR char_length(btrim(p_attributes->>'viscosity'))>40
    ) THEN RETURN false; END IF;
    IF p_attributes ? 'specification' AND (
      jsonb_typeof(p_attributes->'specification')<>'string' OR char_length(btrim(p_attributes->>'specification'))>120
    ) THEN RETURN false; END IF;
    IF p_attributes ? 'volumeMl' AND (
      jsonb_typeof(p_attributes->'volumeMl')<>'number' OR (p_attributes->>'volumeMl')::numeric<=0
    ) THEN RETURN false; END IF;
  ELSIF p_category_code='batteries' THEN
    IF (p_attributes-ARRAY['capacityAh','voltage','warrantyMonths','specification'])<>'{}'::jsonb THEN RETURN false; END IF;
    IF p_attributes ? 'capacityAh' AND (
      jsonb_typeof(p_attributes->'capacityAh')<>'number' OR (p_attributes->>'capacityAh')::numeric<=0
    ) THEN RETURN false; END IF;
    IF p_attributes ? 'voltage' AND (
      jsonb_typeof(p_attributes->'voltage')<>'number' OR (p_attributes->>'voltage')::numeric<=0
    ) THEN RETURN false; END IF;
    IF p_attributes ? 'warrantyMonths' AND (
      jsonb_typeof(p_attributes->'warrantyMonths')<>'number'
      OR (p_attributes->>'warrantyMonths')::numeric<=0
      OR (p_attributes->>'warrantyMonths')::numeric<>trunc((p_attributes->>'warrantyMonths')::numeric)
    ) THEN RETURN false; END IF;
    IF p_attributes ? 'specification' AND (
      jsonb_typeof(p_attributes->'specification')<>'string' OR char_length(btrim(p_attributes->>'specification'))>120
    ) THEN RETURN false; END IF;
  ELSIF p_category_code IN ('filters','parts','consumables') THEN
    IF (p_attributes-ARRAY['partNumber','compatibility','specification'])<>'{}'::jsonb THEN RETURN false; END IF;
    IF p_attributes ? 'partNumber' AND (
      jsonb_typeof(p_attributes->'partNumber')<>'string' OR char_length(btrim(p_attributes->>'partNumber'))>100
    ) THEN RETURN false; END IF;
    IF p_attributes ? 'compatibility' AND (
      jsonb_typeof(p_attributes->'compatibility') NOT IN ('string','array')
      OR (jsonb_typeof(p_attributes->'compatibility')='string' AND char_length(p_attributes->>'compatibility')>1000)
      OR (jsonb_typeof(p_attributes->'compatibility')='array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_attributes->'compatibility') AS vals(value)
        WHERE jsonb_typeof(vals.value)<>'string' OR char_length(btrim(vals.value#>>'{}'))=0
      ))
    ) THEN RETURN false; END IF;
    IF p_attributes ? 'specification' AND (
      jsonb_typeof(p_attributes->'specification')<>'string' OR char_length(btrim(p_attributes->>'specification'))>500
    ) THEN RETURN false; END IF;
  ELSIF p_category_code='other_services' THEN
    IF (p_attributes-ARRAY['included','durationMinutes'])<>'{}'::jsonb THEN RETURN false; END IF;
    IF p_attributes ? 'included' AND (
      jsonb_typeof(p_attributes->'included')<>'string' OR char_length(p_attributes->>'included')>2000
    ) THEN RETURN false; END IF;
    IF p_attributes ? 'durationMinutes' AND (
      jsonb_typeof(p_attributes->'durationMinutes')<>'number'
      OR (p_attributes->>'durationMinutes')::numeric<=0
    ) THEN RETURN false; END IF;
  ELSE
    RETURN false;
  END IF;
  RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN false;
END
$$;

CREATE OR REPLACE FUNCTION petro_private.guard_catalog_wash_variant() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE category_code text;
BEGIN
  SELECT c.code INTO category_code
  FROM public.petro_catalog_categories c
  WHERE c.id=NEW.category_id;
  IF category_code='wash' AND (
    NEW.item_kind<>'service'
    OR NEW.unit_code<>'service'
    OR NEW.attributes->>'washMode' NOT IN ('interior','exterior','interior_exterior')
    OR coalesce(length(btrim(NEW.attributes->>'vehicleType')),0)=0
    OR coalesce(length(btrim(NEW.attributes->>'vehicleSize')),0)=0
  ) THEN
    RAISE EXCEPTION 'CATALOG_WASH_VARIANT_REQUIRED'
      USING ERRCODE='23514',
            HINT='حدد نوع الغسيل ونوع المركبة وحجمها، واختر وحدة الخدمة.';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION petro_private.guard_catalog_wash_variant() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER petro_catalog_wash_variant_guard
BEFORE INSERT ON public.petro_catalog_items
FOR EACH ROW EXECUTE FUNCTION petro_private.guard_catalog_wash_variant();

CREATE OR REPLACE FUNCTION petro_private.guard_fuel_type_unit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
BEGIN
  IF NEW.vehicle_fuel_family IN ('gasoline','diesel') AND NEW.unit_code='litre' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'CATALOG_FUEL_UNIT_INCOMPATIBLE'
    USING ERRCODE='23514',
          HINT='وحدة البنزين والسولار هي اللتر؛ الأنواع الأخرى تحتاج وحدة متوافقة معتمدة قبل الإضافة.';
END
$$;
REVOKE ALL ON FUNCTION petro_private.guard_fuel_type_unit() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER petro_fuel_type_unit_guard
BEFORE INSERT OR UPDATE OF vehicle_fuel_family,unit_code ON public.petro_fuel_types
FOR EACH ROW EXECUTE FUNCTION petro_private.guard_fuel_type_unit();

CREATE OR REPLACE FUNCTION petro_private.petro_valid_branch_hours(p_hours jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=''
AS $$
DECLARE
  day_key text;
  day_value jsonb;
  open_time text;
  close_time text;
BEGIN
  IF p_hours IS NULL OR jsonb_typeof(p_hours)<>'object' THEN RETURN false; END IF;
  FOR day_key,day_value IN SELECT key,value FROM jsonb_each(p_hours) LOOP
    IF day_key NOT IN ('sun','mon','tue','wed','thu','fri','sat')
       OR jsonb_typeof(day_value)<>'object'
       OR NOT (day_value?'closed')
       OR jsonb_typeof(day_value->'closed')<>'boolean' THEN
      RETURN false;
    END IF;
    IF (day_value->>'closed')::boolean THEN
      IF day_value?'open' OR day_value?'close' OR day_value?'open24Hours' THEN RETURN false; END IF;
    ELSIF day_value->'open24Hours'='true'::jsonb THEN
      IF day_value?'open' OR day_value?'close' THEN RETURN false; END IF;
    ELSE
      IF day_value?'open24Hours' AND jsonb_typeof(day_value->'open24Hours')<>'boolean' THEN RETURN false; END IF;
      open_time:=day_value->>'open'; close_time:=day_value->>'close';
      IF open_time IS NULL OR close_time IS NULL
         OR open_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         OR close_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
        RETURN false;
      END IF;
    END IF;
  END LOOP;
  RETURN true;
END
$$;

COMMIT;
