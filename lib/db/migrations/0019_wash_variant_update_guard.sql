BEGIN;

-- Keep each wash service's vehicle/type/size variant intact after creation.
CREATE OR REPLACE FUNCTION petro_private.guard_catalog_wash_variant_update() RETURNS trigger
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
    OR NOT petro_private.catalog_attributes_valid('wash',NEW.attributes)
  ) THEN
    RAISE EXCEPTION 'CATALOG_WASH_VARIANT_REQUIRED'
      USING ERRCODE='23514',
            HINT='احتفظ بنوع الغسيل ونوع المركبة وحجمها، واختر وحدة الخدمة.';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION petro_private.guard_catalog_wash_variant_update() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER petro_catalog_wash_variant_update_guard
BEFORE UPDATE OF category_id,item_kind,unit_code,attributes ON public.petro_catalog_items
FOR EACH ROW EXECUTE FUNCTION petro_private.guard_catalog_wash_variant_update();

COMMIT;
