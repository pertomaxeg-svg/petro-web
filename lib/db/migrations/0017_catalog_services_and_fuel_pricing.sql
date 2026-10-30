BEGIN;

DO $$
BEGIN
  IF to_regclass('public.petro_catalog_categories') IS NOT NULL
     OR to_regclass('public.petro_catalog_items') IS NOT NULL
     OR to_regclass('public.petro_fuel_types') IS NOT NULL
     OR to_regclass('public.petro_catalog_price_versions') IS NOT NULL
     OR to_regprocedure('public.petro_catalog_command(text,jsonb,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'CATALOG_0017_PREFLIGHT: catalog objects already exist; inspect the exact live source before proceeding';
  END IF;
  IF to_regclass('public.petro_organizations') IS NULL
     OR to_regclass('public.petro_branches') IS NULL
     OR to_regclass('public.petro_memberships') IS NULL
     OR to_regclass('public.petro_platform_roles') IS NULL
     OR to_regclass('public.petro_audit_events') IS NULL
     OR to_regclass('public.petro_documents') IS NULL
     OR to_regclass('storage.objects') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM storage.buckets
       WHERE id='petro-private-documents' AND public=false
     )
     OR to_regprocedure('petro_private.can_manage_org(uuid)') IS NULL
     OR to_regprocedure('petro_private.can_manage_branch(uuid,uuid)') IS NULL
     OR to_regprocedure('petro_private.can_read_org(uuid)') IS NULL
     OR to_regprocedure('petro_private.can_read_branch(uuid,uuid)') IS NULL
     OR to_regprocedure('petro_private.platform_has(text[])') IS NULL THEN
    RAISE EXCEPTION 'CATALOG_0017_PREFLIGHT: required Pertomax organization, authorization, audit, or private-storage objects differ from the reviewed baseline';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy
    WHERE polrelid='storage.objects'::regclass
      AND polname IN (
        'petro_catalog_image_read',
        'petro_catalog_image_upload',
        'petro_catalog_image_delete_pending'
      )
  ) THEN
    RAISE EXCEPTION 'CATALOG_0017_PREFLIGHT: catalog storage policies already exist';
  END IF;
END
$$;

CREATE TABLE public.petro_catalog_units (
  code text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  name_ar text NOT NULL CHECK (char_length(btrim(name_ar)) BETWEEN 2 AND 80),
  quantity_scale smallint NOT NULL CHECK (quantity_scale BETWEEN 0 AND 6),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT
);

CREATE TABLE public.petro_catalog_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  name_ar text NOT NULL CHECK (char_length(btrim(name_ar)) BETWEEN 2 AND 100),
  domain_kind text NOT NULL CHECK (domain_kind IN ('fuel','catalog')),
  service_group text NOT NULL CHECK (service_group IN ('fuel','wash','oils','parts')),
  allowed_item_kinds text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  is_system boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  CHECK (
    (domain_kind='fuel' AND service_group='fuel' AND allowed_item_kinds=ARRAY['fuel']::text[])
    OR
    (domain_kind='catalog' AND service_group<>'fuel'
      AND cardinality(allowed_item_kinds)>0
      AND allowed_item_kinds <@ ARRAY['product','service']::text[])
  )
);

CREATE TABLE public.petro_fuel_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  name_ar text NOT NULL CHECK (char_length(btrim(name_ar)) BETWEEN 2 AND 80),
  vehicle_fuel_family text NOT NULL CHECK (vehicle_fuel_family IN ('gasoline','diesel','natural_gas','other')),
  unit_code text NOT NULL DEFAULT 'litre'
    REFERENCES public.petro_catalog_units(code) ON DELETE RESTRICT,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT
);

CREATE TABLE public.petro_catalog_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  category_id uuid NOT NULL REFERENCES public.petro_catalog_categories(id) ON DELETE RESTRICT,
  item_kind text NOT NULL CHECK (item_kind IN ('product','service')),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 160),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 4000),
  internal_code text CHECK (internal_code IS NULL OR char_length(btrim(internal_code)) BETWEEN 1 AND 80),
  barcode text CHECK (barcode IS NULL OR char_length(btrim(barcode)) BETWEEN 3 AND 80),
  brand_name text CHECK (brand_name IS NULL OR char_length(btrim(brand_name)) <= 120),
  unit_code text NOT NULL REFERENCES public.petro_catalog_units(code) ON DELETE RESTRICT,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attributes)='object'),
  display_status text NOT NULL DEFAULT 'draft' CHECK (display_status IN ('draft','active','suspended')),
  central_suspended boolean NOT NULL DEFAULT false,
  review_status text NOT NULL DEFAULT 'not_reviewed' CHECK (review_status IN ('not_reviewed','approved','rejected')),
  review_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  UNIQUE (id, organization_id),
  CHECK (internal_code IS NULL OR internal_code=btrim(internal_code)),
  CHECK (barcode IS NULL OR barcode=btrim(barcode)),
  CHECK (brand_name IS NULL OR brand_name=btrim(brand_name))
);

CREATE UNIQUE INDEX petro_catalog_items_org_internal_code_unique
  ON public.petro_catalog_items(organization_id, lower(internal_code))
  WHERE internal_code IS NOT NULL;
CREATE UNIQUE INDEX petro_catalog_items_org_barcode_unique
  ON public.petro_catalog_items(organization_id, lower(barcode))
  WHERE barcode IS NOT NULL;
CREATE INDEX petro_catalog_items_org_status_idx
  ON public.petro_catalog_items(organization_id, display_status, updated_at DESC);
CREATE INDEX petro_catalog_items_category_idx
  ON public.petro_catalog_items(category_id, display_status, name);

CREATE TABLE public.petro_catalog_branch_availability (
  organization_id uuid NOT NULL,
  item_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  available boolean NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  PRIMARY KEY (item_id, branch_id),
  FOREIGN KEY (item_id, organization_id)
    REFERENCES public.petro_catalog_items(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (branch_id, organization_id)
    REFERENCES public.petro_branches(id, organization_id) ON DELETE RESTRICT
);
CREATE INDEX petro_catalog_branch_availability_branch_idx
  ON public.petro_catalog_branch_availability(organization_id, branch_id, available);

CREATE TABLE public.petro_catalog_price_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  item_id uuid NOT NULL,
  branch_id uuid,
  version integer NOT NULL CHECK (version > 0),
  price_minor bigint NOT NULL CHECK (price_minor > 0),
  currency text NOT NULL DEFAULT 'EGP' CHECK (currency='EGP'),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','canceled')),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  published_at timestamptz,
  published_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  UNIQUE (item_id, branch_id, version),
  FOREIGN KEY (item_id, organization_id)
    REFERENCES public.petro_catalog_items(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (branch_id, organization_id)
    REFERENCES public.petro_branches(id, organization_id) ON DELETE RESTRICT,
  CHECK (valid_to IS NULL OR valid_to>valid_from),
  CHECK (status<>'published' OR (published_at IS NOT NULL AND published_by IS NOT NULL)),
  CHECK ((published_at IS NULL)=(published_by IS NULL))
);
CREATE INDEX petro_catalog_price_scope_time_idx
  ON public.petro_catalog_price_versions(item_id, branch_id, status, valid_from DESC);

CREATE TABLE public.petro_fuel_price_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fuel_type_id uuid NOT NULL REFERENCES public.petro_fuel_types(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  price_per_unit numeric(18,6) NOT NULL CHECK (price_per_unit>0),
  currency text NOT NULL DEFAULT 'EGP' CHECK (currency='EGP'),
  unit_code text NOT NULL REFERENCES public.petro_catalog_units(code) ON DELETE RESTRICT,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','canceled')),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  published_at timestamptz,
  published_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  UNIQUE (fuel_type_id, version),
  CHECK (valid_to IS NULL OR valid_to>valid_from),
  CHECK (status<>'published' OR (published_at IS NOT NULL AND published_by IS NOT NULL)),
  CHECK ((published_at IS NULL)=(published_by IS NULL))
);
CREATE INDEX petro_fuel_price_type_time_idx
  ON public.petro_fuel_price_versions(fuel_type_id, status, valid_from DESC);

CREATE TABLE public.petro_catalog_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  item_id uuid NOT NULL,
  branch_id uuid,
  uploader_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 160),
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg','image/png')),
  byte_size bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 5242880),
  storage_path text NOT NULL UNIQUE,
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending_upload'
    CHECK (status IN ('pending_upload','ready','upload_failed','removed')),
  upload_expires_at timestamptz NOT NULL,
  uploaded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (item_id, organization_id)
    REFERENCES public.petro_catalog_items(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (branch_id, organization_id)
    REFERENCES public.petro_branches(id, organization_id) ON DELETE RESTRICT,
  CHECK (status<>'ready' OR (uploaded_at IS NOT NULL AND sha256 IS NOT NULL)),
  CHECK (storage_path LIKE 'catalog-images/%')
);
CREATE INDEX petro_catalog_images_item_status_idx
  ON public.petro_catalog_images(item_id, status, created_at DESC);

CREATE TABLE public.petro_catalog_idempotency (
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 16 AND 120),
  command_hash text NOT NULL CHECK (command_hash ~ '^[0-9a-f]{32}$'),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, idempotency_key)
);

INSERT INTO public.petro_catalog_units(code,name_ar,quantity_scale) VALUES
  ('litre','لتر',3),
  ('piece','قطعة',0),
  ('service','خدمة',0),
  ('pack','عبوة',0);

INSERT INTO public.petro_catalog_categories(code,name_ar,domain_kind,service_group,allowed_item_kinds,is_system) VALUES
  ('fuel','الوقود','fuel','fuel',ARRAY['fuel']::text[],true),
  ('wash','الغسيل','catalog','wash',ARRAY['service']::text[],true),
  ('oils','الزيوت','catalog','oils',ARRAY['product','service']::text[],true),
  ('batteries','البطاريات','catalog','parts',ARRAY['product','service']::text[],true),
  ('filters','الفلاتر','catalog','parts',ARRAY['product','service']::text[],true),
  ('parts','قطع الغيار','catalog','parts',ARRAY['product','service']::text[],true),
  ('consumables','الاستهلاكيات','catalog','parts',ARRAY['product','service']::text[],true),
  ('other_services','خدمات أخرى','catalog','parts',ARRAY['service']::text[],true);

INSERT INTO public.petro_fuel_types(code,name_ar,vehicle_fuel_family,unit_code) VALUES
  ('gasoline_80','بنزين 80','gasoline','litre'),
  ('gasoline_92','بنزين 92','gasoline','litre'),
  ('gasoline_95','بنزين 95','gasoline','litre'),
  ('diesel','سولار','diesel','litre');

ALTER TABLE public.petro_catalog_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_catalog_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_fuel_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_catalog_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_catalog_branch_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_catalog_price_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_fuel_price_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_catalog_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_catalog_idempotency ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  public.petro_catalog_units,
  public.petro_catalog_categories,
  public.petro_fuel_types,
  public.petro_catalog_items,
  public.petro_catalog_branch_availability,
  public.petro_catalog_price_versions,
  public.petro_fuel_price_versions,
  public.petro_catalog_images,
  public.petro_catalog_idempotency
FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION petro_private.catalog_is_admin(p_write boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$
  SELECT CASE WHEN p_write
    THEN petro_private.platform_has(ARRAY['owner','operations']::text[])
    ELSE petro_private.platform_has(ARRAY['owner','operations','finance','auditor']::text[])
  END
$$;

CREATE FUNCTION petro_private.catalog_can_read_org(p_organization_id uuid,p_branch_id uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$
  SELECT petro_private.catalog_is_admin(false)
      OR CASE WHEN p_branch_id IS NULL
        THEN petro_private.can_read_org(p_organization_id)
        ELSE petro_private.can_read_branch(p_organization_id,p_branch_id)
      END
$$;

CREATE FUNCTION petro_private.catalog_merchant_can_manage_org(p_organization_id uuid,p_branch_id uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$
  SELECT petro_private.user_active()
    AND EXISTS (
      SELECT 1 FROM public.petro_organizations o
      WHERE o.id=p_organization_id AND o.kind IN ('station','provider') AND o.status='active'
        AND (p_branch_id IS NULL OR EXISTS (
          SELECT 1 FROM public.petro_branches b
          WHERE b.id=p_branch_id AND b.organization_id=o.id AND b.status='active'
        ))
        AND (
          EXISTS (
            SELECT 1 FROM public.petro_memberships m
            WHERE m.user_id=auth.uid() AND m.organization_id=o.id AND m.active
              AND m.scope='organization' AND m.role IN ('organization_owner','manager')
          )
          OR (p_branch_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.petro_memberships m
            JOIN public.petro_membership_branches mb
              ON mb.membership_id=m.id AND mb.organization_id=m.organization_id
            WHERE m.user_id=auth.uid() AND m.organization_id=o.id AND m.active
              AND m.scope='branches' AND m.role IN ('organization_owner','manager')
              AND mb.branch_id=p_branch_id
          ))
        )
    )
$$;

CREATE FUNCTION petro_private.catalog_attributes_valid(p_category_code text,p_attributes jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=''
AS $$
BEGIN
  IF p_attributes IS NULL OR jsonb_typeof(p_attributes)<>'object' THEN RETURN false; END IF;
  IF p_category_code='wash' THEN
    IF (p_attributes-ARRAY['vehicleTypes','durationMinutes','included'])<>'{}'::jsonb THEN RETURN false; END IF;
    IF p_attributes ? 'vehicleTypes' AND (
      jsonb_typeof(p_attributes->'vehicleTypes')<>'array'
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_attributes->'vehicleTypes') AS vals(value)
        WHERE jsonb_typeof(vals.value)<>'string' OR char_length(btrim(vals.value#>>'{}'))=0)
    ) THEN RETURN false; END IF;
    IF p_attributes ? 'durationMinutes' AND (
      jsonb_typeof(p_attributes->'durationMinutes')<>'number'
      OR (p_attributes->>'durationMinutes')::numeric<=0
    ) THEN RETURN false; END IF;
    IF p_attributes ? 'included' AND (
      jsonb_typeof(p_attributes->'included')<>'string'
      OR char_length(p_attributes->>'included')>2000
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

CREATE FUNCTION petro_private.catalog_command_begin(
  p_actor uuid,p_action text,p_payload jsonb,p_reason text,p_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE expected_hash text; cached_hash text; cached_result jsonb;
BEGIN
  IF p_actor IS NULL OR p_key IS NULL OR char_length(p_key) NOT BETWEEN 16 AND 120 THEN
    RAISE EXCEPTION 'CATALOG_IDEMPOTENCY_REQUIRED' USING ERRCODE='22023';
  END IF;
  expected_hash := md5(p_action||'|'||coalesce(p_payload,'{}'::jsonb)::text||'|'||coalesce(p_reason,''));
  INSERT INTO public.petro_catalog_idempotency(actor_id,idempotency_key,command_hash)
  VALUES(p_actor,p_key,expected_hash) ON CONFLICT (actor_id,idempotency_key) DO NOTHING;
  SELECT command_hash,result INTO cached_hash,cached_result
  FROM public.petro_catalog_idempotency
  WHERE actor_id=p_actor AND idempotency_key=p_key FOR UPDATE;
  IF cached_hash<>expected_hash THEN
    RAISE EXCEPTION 'CATALOG_IDEMPOTENCY_PAYLOAD_MISMATCH' USING ERRCODE='23505';
  END IF;
  IF cached_result IS NOT NULL THEN
    RETURN cached_result||jsonb_build_object('replayed',true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.petro_catalog_idempotency
    WHERE actor_id=p_actor AND idempotency_key=p_key AND command_hash=expected_hash
  ) THEN
    RAISE EXCEPTION 'CATALOG_IDEMPOTENCY_CONFLICT' USING ERRCODE='40001';
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION petro_private.catalog_command_finish(
  p_actor uuid,p_key text,p_result jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
BEGIN
  UPDATE public.petro_catalog_idempotency
  SET result=p_result
  WHERE actor_id=p_actor AND idempotency_key=p_key AND result IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CATALOG_IDEMPOTENCY_RESULT_MISSING' USING ERRCODE='40001';
  END IF;
  RETURN p_result;
END
$$;

CREATE FUNCTION public.petro_catalog_admin_categories() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE result jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT petro_private.catalog_is_admin(false) THEN
    RAISE EXCEPTION 'CATALOG_READ_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  SELECT jsonb_build_object(
    'categories',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.name_ar)
      FROM public.petro_catalog_categories c),'[]'::jsonb),
    'units',coalesce((SELECT jsonb_agg(to_jsonb(u) ORDER BY u.name_ar)
      FROM public.petro_catalog_units u),'[]'::jsonb),
    'canManage',petro_private.catalog_is_admin(true)
  ) INTO result;
  RETURN result;
END
$$;

CREATE FUNCTION public.petro_catalog_reference_data() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'CATALOG_READ_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object(
    'categories',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id',c.id,'code',c.code,'nameAr',c.name_ar,'serviceGroup',c.service_group,
      'allowedItemKinds',c.allowed_item_kinds,'version',c.version)
      ORDER BY c.name_ar) FROM public.petro_catalog_categories c
      WHERE c.active AND c.domain_kind='catalog'),'[]'::jsonb),
    'units',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'code',u.code,'nameAr',u.name_ar,'quantityScale',u.quantity_scale)
      ORDER BY u.name_ar) FROM public.petro_catalog_units u WHERE u.active),'[]'::jsonb)
  );
END
$$;

CREATE FUNCTION public.petro_catalog_admin_organizations(
  p_search text DEFAULT NULL,p_kind text DEFAULT NULL,p_page integer DEFAULT 1,p_page_size integer DEFAULT 20
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE total_count integer; result jsonb; offset_value integer;
BEGIN
  IF auth.uid() IS NULL OR NOT petro_private.catalog_is_admin(false)
     OR p_page<1 OR p_page_size NOT BETWEEN 1 AND 100
     OR (p_kind IS NOT NULL AND p_kind NOT IN ('station','provider')) THEN
    RAISE EXCEPTION 'CATALOG_READ_FORBIDDEN_OR_INVALID' USING ERRCODE='42501';
  END IF;
  offset_value := (p_page-1)*p_page_size;
  SELECT count(*)::integer INTO total_count
  FROM public.petro_organizations o
  WHERE o.kind IN ('station','provider')
    AND (p_kind IS NULL OR o.kind=p_kind)
    AND (p_search IS NULL OR o.name ILIKE '%'||p_search||'%' OR coalesce(o.code,'') ILIKE '%'||p_search||'%');
  SELECT coalesce(jsonb_agg(row_data ORDER BY row_data->>'name'),'[]'::jsonb) INTO result
  FROM (
    SELECT jsonb_build_object(
      'id',o.id,'name',o.name,'code',o.code,'kind',o.kind,'status',o.status,
      'branchCount',(SELECT count(*) FROM public.petro_branches b WHERE b.organization_id=o.id),
      'itemCount',(SELECT count(*) FROM public.petro_catalog_items i WHERE i.organization_id=o.id),
      'activeItemCount',(SELECT count(*) FROM public.petro_catalog_items i WHERE i.organization_id=o.id AND i.display_status='active')
    ) AS row_data
    FROM public.petro_organizations o
    WHERE o.kind IN ('station','provider')
      AND (p_kind IS NULL OR o.kind=p_kind)
      AND (p_search IS NULL OR o.name ILIKE '%'||p_search||'%' OR coalesce(o.code,'') ILIKE '%'||p_search||'%')
    ORDER BY o.name,o.id LIMIT p_page_size OFFSET offset_value
  ) rows;
  RETURN jsonb_build_object('items',result,'total',total_count,'page',p_page,'pageSize',p_page_size,
    'totalPages',ceil(total_count::numeric/p_page_size)::integer);
END
$$;

CREATE FUNCTION public.petro_catalog_admin_fuel_list(
  p_search text DEFAULT NULL,p_page integer DEFAULT 1,p_page_size integer DEFAULT 20
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE total_count integer; result jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT petro_private.catalog_is_admin(false)
     OR p_page<1 OR p_page_size NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'CATALOG_READ_FORBIDDEN_OR_INVALID' USING ERRCODE='42501';
  END IF;
  SELECT count(*)::integer INTO total_count FROM public.petro_fuel_types f
  WHERE p_search IS NULL OR f.code ILIKE '%'||p_search||'%' OR f.name_ar ILIKE '%'||p_search||'%';
  SELECT coalesce(jsonb_agg(row_data ORDER BY row_data->>'nameAr'),'[]'::jsonb) INTO result
  FROM (
    SELECT jsonb_build_object(
      'id',f.id,'code',f.code,'nameAr',f.name_ar,'vehicleFuelFamily',f.vehicle_fuel_family,
      'unitCode',f.unit_code,'active',f.active,'version',f.version,
      'currentPrice',current_price.price_per_unit::text,
      'currentPriceVersionId',current_price.id,
      'currentPriceValidFrom',current_price.valid_from,
      'nextPrice',next_price.price_per_unit::text,
      'nextPriceVersionId',next_price.id,
      'nextPriceValidFrom',next_price.valid_from,
      'canManage',petro_private.catalog_is_admin(true),
      'priceHistory',coalesce(history.items,'[]'::jsonb)
    ) AS row_data
    FROM public.petro_fuel_types f
    LEFT JOIN LATERAL (
      SELECT p.id,p.price_per_unit,p.valid_from FROM public.petro_fuel_price_versions p
      WHERE p.fuel_type_id=f.id AND p.status='published'
        AND p.valid_from<=now() AND (p.valid_to IS NULL OR now()<p.valid_to)
      ORDER BY p.valid_from DESC LIMIT 1
    ) current_price ON true
    LEFT JOIN LATERAL (
      SELECT p.id,p.price_per_unit,p.valid_from FROM public.petro_fuel_price_versions p
      WHERE p.fuel_type_id=f.id AND p.status='published' AND p.valid_from>now()
      ORDER BY p.valid_from LIMIT 1
    ) next_price ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'id',p.id,'version',p.version,'pricePerUnit',p.price_per_unit::text,'unitCode',p.unit_code,
        'validFrom',p.valid_from,'validTo',p.valid_to,'status',p.status,'reason',p.reason
      ) ORDER BY p.valid_from DESC) AS items
      FROM (
        SELECT * FROM public.petro_fuel_price_versions p
        WHERE p.fuel_type_id=f.id ORDER BY p.valid_from DESC LIMIT 20
      ) p
    ) history ON true
    WHERE p_search IS NULL OR f.code ILIKE '%'||p_search||'%' OR f.name_ar ILIKE '%'||p_search||'%'
    ORDER BY f.name_ar,f.id LIMIT p_page_size OFFSET (p_page-1)*p_page_size
  ) rows;
  RETURN jsonb_build_object('items',result,'total',total_count,'page',p_page,'pageSize',p_page_size,
    'totalPages',ceil(total_count::numeric/p_page_size)::integer,
    'canManage',petro_private.catalog_is_admin(true));
END
$$;

CREATE FUNCTION public.petro_catalog_list_items(
  p_organization_id uuid,p_branch_id uuid DEFAULT NULL,p_category_code text DEFAULT NULL,
  p_item_kind text DEFAULT NULL,p_status text DEFAULT NULL,p_search text DEFAULT NULL,
  p_page integer DEFAULT 1,p_page_size integer DEFAULT 20
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE total_count integer; result jsonb; can_read_org_scope boolean;
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR p_page<1 OR p_page_size NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'CATALOG_READ_FORBIDDEN_OR_INVALID' USING ERRCODE='42501';
  END IF;
  SELECT petro_private.catalog_can_read_org(p_organization_id,p_branch_id) INTO can_read_org_scope;
  IF NOT coalesce(can_read_org_scope,false) THEN
    RAISE EXCEPTION 'CATALOG_READ_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.petro_organizations o
    WHERE o.id=p_organization_id AND o.kind IN ('station','provider')
  ) THEN
    RAISE EXCEPTION 'CATALOG_ORGANIZATION_NOT_FOUND' USING ERRCODE='P0002';
  END IF;
  SELECT count(*)::integer INTO total_count
  FROM public.petro_catalog_items i
  JOIN public.petro_catalog_categories c ON c.id=i.category_id
  WHERE i.organization_id=p_organization_id
    AND (p_branch_id IS NULL OR EXISTS (
      SELECT 1 FROM public.petro_catalog_branch_availability a
      WHERE a.item_id=i.id AND a.branch_id=p_branch_id AND a.available
    ))
    AND (p_category_code IS NULL OR c.code=p_category_code)
    AND (p_item_kind IS NULL OR i.item_kind=p_item_kind)
    AND (p_status IS NULL OR i.display_status=p_status)
    AND (p_search IS NULL OR i.name ILIKE '%'||p_search||'%' OR coalesce(i.internal_code,'') ILIKE '%'||p_search||'%'
      OR coalesce(i.brand_name,'') ILIKE '%'||p_search||'%');
  SELECT coalesce(jsonb_agg(row_data ORDER BY row_data->>'name'),'[]'::jsonb) INTO result
  FROM (
    SELECT jsonb_build_object(
      'id',i.id,'organizationId',i.organization_id,'categoryCode',c.code,'categoryName',c.name_ar,
      'serviceGroup',c.service_group,'kind',i.item_kind,'name',i.name,'description',i.description,
      'internalCode',i.internal_code,'barcode',i.barcode,'brandName',i.brand_name,'unitCode',i.unit_code,
      'attributes',i.attributes,'status',i.display_status,'centralSuspended',i.central_suspended,'reviewStatus',i.review_status,
      'version',i.version,'updatedAt',i.updated_at,
       'canManage',petro_private.catalog_merchant_can_manage_org(i.organization_id,p_branch_id),
       'canManageOrganization',petro_private.catalog_merchant_can_manage_org(i.organization_id,NULL),
       'canReview',petro_private.catalog_is_admin(true),
      'branchAvailable',CASE WHEN p_branch_id IS NULL THEN NULL ELSE true END,
      'priceMinor',coalesce(branch_price.price_minor,org_price.price_minor)::text,
      'priceScope',CASE WHEN branch_price.id IS NOT NULL THEN 'branch'
        WHEN org_price.id IS NOT NULL THEN 'organization' ELSE NULL END,
      'priceVersionId',coalesce(branch_price.id,org_price.id),
      'priceValidFrom',coalesce(branch_price.valid_from,org_price.valid_from),
       'imageCount',(SELECT count(*) FROM public.petro_catalog_images im
         WHERE im.item_id=i.id AND im.status='ready'
           AND (p_branch_id IS NULL OR im.branch_id IS NULL OR im.branch_id=p_branch_id))
    ) AS row_data
    FROM public.petro_catalog_items i
    JOIN public.petro_catalog_categories c ON c.id=i.category_id
    LEFT JOIN LATERAL (
      SELECT p.id,p.price_minor,p.valid_from FROM public.petro_catalog_price_versions p
      WHERE p.item_id=i.id AND p.branch_id=p_branch_id AND p.status='published'
        AND p.valid_from<=now() AND (p.valid_to IS NULL OR now()<p.valid_to)
      ORDER BY p.valid_from DESC LIMIT 1
    ) branch_price ON p_branch_id IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT p.id,p.price_minor,p.valid_from FROM public.petro_catalog_price_versions p
      WHERE p.item_id=i.id AND p.branch_id IS NULL AND p.status='published'
        AND p.valid_from<=now() AND (p.valid_to IS NULL OR now()<p.valid_to)
      ORDER BY p.valid_from DESC LIMIT 1
    ) org_price ON true
    WHERE i.organization_id=p_organization_id
      AND (p_branch_id IS NULL OR EXISTS (
        SELECT 1 FROM public.petro_catalog_branch_availability a
        WHERE a.item_id=i.id AND a.branch_id=p_branch_id AND a.available
      ))
      AND (p_category_code IS NULL OR c.code=p_category_code)
      AND (p_item_kind IS NULL OR i.item_kind=p_item_kind)
      AND (p_status IS NULL OR i.display_status=p_status)
      AND (p_search IS NULL OR i.name ILIKE '%'||p_search||'%' OR coalesce(i.internal_code,'') ILIKE '%'||p_search||'%'
        OR coalesce(i.brand_name,'') ILIKE '%'||p_search||'%')
    ORDER BY i.name,i.id LIMIT p_page_size OFFSET (p_page-1)*p_page_size
  ) rows;
  RETURN jsonb_build_object('items',result,'total',total_count,'page',p_page,'pageSize',p_page_size,
    'totalPages',ceil(total_count::numeric/p_page_size)::integer,
    'canManage',petro_private.catalog_merchant_can_manage_org(p_organization_id,p_branch_id),
    'canManageOrganization',petro_private.catalog_merchant_can_manage_org(p_organization_id,NULL),
    'canReview',petro_private.catalog_is_admin(true));
END
$$;

CREATE FUNCTION public.petro_catalog_item_detail(p_item_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE org_id uuid; branch_scope uuid; result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'CATALOG_READ_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT i.organization_id INTO org_id FROM public.petro_catalog_items i WHERE i.id=p_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_ITEM_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF NOT petro_private.catalog_can_read_org(org_id,NULL) THEN
    SELECT b.branch_id INTO branch_scope
    FROM public.petro_catalog_branch_availability b
    WHERE b.item_id=p_item_id AND b.available
      AND petro_private.catalog_can_read_org(org_id,b.branch_id)
    ORDER BY b.branch_id LIMIT 1;
    IF branch_scope IS NULL THEN RAISE EXCEPTION 'CATALOG_READ_FORBIDDEN' USING ERRCODE='42501'; END IF;
  END IF;
  SELECT jsonb_build_object(
    'item',jsonb_build_object(
      'id',i.id,'organizationId',i.organization_id,'organizationName',o.name,'organizationKind',o.kind,
      'categoryCode',c.code,'categoryName',c.name_ar,'serviceGroup',c.service_group,'kind',i.item_kind,
      'name',i.name,'description',i.description,'internalCode',i.internal_code,'barcode',i.barcode,
      'brandName',i.brand_name,'unitCode',i.unit_code,'attributes',i.attributes,
      'status',i.display_status,'centralSuspended',i.central_suspended,'reviewStatus',i.review_status,'reviewReason',i.review_reason,
       'version',i.version,'createdAt',i.created_at,'updatedAt',i.updated_at,
       'canManage',petro_private.catalog_merchant_can_manage_org(i.organization_id,branch_scope),
       'canManageOrganization',petro_private.catalog_merchant_can_manage_org(i.organization_id,NULL),
       'canReview',petro_private.catalog_is_admin(true)
    ),
     'manageableBranches',coalesce((
       SELECT jsonb_agg(jsonb_build_object('id',b.id,'name',b.name) ORDER BY b.name)
       FROM public.petro_branches b
       WHERE b.organization_id=org_id AND b.status='active'
         AND petro_private.catalog_merchant_can_manage_org(org_id,b.id)
     ),'[]'::jsonb),
    'availability',coalesce((
       SELECT jsonb_agg(jsonb_build_object('branchId',b.id,'branchName',b.name,'available',a.available,
         'canManage',petro_private.catalog_merchant_can_manage_org(i.organization_id,b.id),
        'version',a.version,'updatedAt',a.updated_at) ORDER BY b.name)
      FROM public.petro_catalog_branch_availability a
      JOIN public.petro_branches b ON b.id=a.branch_id AND b.organization_id=a.organization_id
      WHERE a.item_id=i.id
        AND (branch_scope IS NULL OR b.id=branch_scope)
    ),'[]'::jsonb),
    'prices',coalesce((
      SELECT jsonb_agg(jsonb_build_object('id',p.id,'branchId',p.branch_id,'version',p.version,
        'priceMinor',p.price_minor::text,'currency',p.currency,'validFrom',p.valid_from,'validTo',p.valid_to,
        'status',p.status,'reason',p.reason,'createdAt',p.created_at)
        ORDER BY p.valid_from DESC)
      FROM public.petro_catalog_price_versions p
      WHERE p.item_id=i.id AND (branch_scope IS NULL OR p.branch_id IS NULL OR p.branch_id=branch_scope)
    ),'[]'::jsonb),
    'images',coalesce((
      SELECT jsonb_agg(jsonb_build_object('id',im.id,'fileName',im.file_name,'contentType',im.content_type,
        'byteSize',im.byte_size,'status',im.status,'createdAt',im.created_at)
        ORDER BY im.created_at DESC)
      FROM public.petro_catalog_images im
      WHERE im.item_id=i.id AND im.status='ready'
        AND (branch_scope IS NULL OR im.branch_id IS NULL OR im.branch_id=branch_scope)
    ),'[]'::jsonb)
  ) INTO result
  FROM public.petro_catalog_items i
  JOIN public.petro_catalog_categories c ON c.id=i.category_id
  JOIN public.petro_organizations o ON o.id=i.organization_id
  WHERE i.id=p_item_id;
  RETURN result;
END
$$;

CREATE FUNCTION public.petro_catalog_fuel_preview(
  p_fuel_type_id uuid,p_quantity numeric DEFAULT NULL,p_amount_minor bigint DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE fuel_row record; price_row record; result_amount bigint; result_quantity numeric;
BEGIN
  IF auth.uid() IS NULL OR NOT petro_private.catalog_is_admin(false)
     OR (p_quantity IS NULL)=(p_amount_minor IS NULL)
     OR (p_quantity IS NOT NULL AND p_quantity<=0)
     OR (p_amount_minor IS NOT NULL AND p_amount_minor<=0) THEN
    RAISE EXCEPTION 'CATALOG_PREVIEW_INVALID_OR_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  SELECT id,name_ar,unit_code,vehicle_fuel_family,active INTO fuel_row
  FROM public.petro_fuel_types WHERE id=p_fuel_type_id;
  IF NOT FOUND OR NOT fuel_row.active THEN
    RETURN jsonb_build_object('available',false,'reason','fuel_type_inactive_or_missing');
  END IF;
  SELECT id,price_per_unit,valid_from,valid_to INTO price_row
  FROM public.petro_fuel_price_versions
  WHERE fuel_type_id=p_fuel_type_id AND status='published'
    AND valid_from<=now() AND (valid_to IS NULL OR now()<valid_to)
  ORDER BY valid_from DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('available',false,'reason','no_effective_reference_price');
  END IF;
  IF p_quantity IS NOT NULL THEN
    result_quantity:=round(p_quantity,3);
    result_amount:=round(result_quantity*price_row.price_per_unit*100)::bigint;
  ELSE
    result_amount:=p_amount_minor;
    result_quantity:=round((p_amount_minor::numeric/100)/price_row.price_per_unit,3);
  END IF;
  RETURN jsonb_build_object(
    'available',true,'fuelTypeId',fuel_row.id,'fuelTypeName',fuel_row.name_ar,
    'vehicleFuelFamily',fuel_row.vehicle_fuel_family,'unitCode',fuel_row.unit_code,
    'pricePerUnit',price_row.price_per_unit::text,'priceVersionId',price_row.id,
    'validFrom',price_row.valid_from,'quantity',result_quantity::text,'amountMinor',result_amount::text,
    'rounding','half-up-to-one-piaster; quantity rounded to 0.001 unit',
    'financialOperation',false
  );
END
$$;

CREATE FUNCTION public.petro_catalog_command(
  p_action text,p_payload jsonb,p_reason text,p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
#variable_conflict use_variable
DECLARE
  actor uuid:=auth.uid(); cached jsonb; result jsonb; org_id uuid; branch_id uuid;
  item_id uuid; category_id uuid; fuel_id uuid; price_id uuid; image_id uuid;
  item_row record; category_row record; existing_row record; valid_from_value timestamptz;
  valid_to_value timestamptz; price_minor_value bigint; amount_value numeric;
  version_value integer; status_value text; name_value text; code_value text;
  attributes_value jsonb; unit_value text; branch_scope uuid;
BEGIN
  IF actor IS NULL OR p_action IS NULL OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object'
     OR char_length(btrim(coalesce(p_reason,''))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'CATALOG_INVALID_COMMAND' USING ERRCODE='22023';
  END IF;
  cached:=petro_private.catalog_command_begin(actor,p_action,p_payload,p_reason,p_idempotency_key);
  IF cached IS NOT NULL THEN RETURN cached; END IF;

  IF p_action LIKE 'category.%' OR p_action LIKE 'fuel.%' OR p_action LIKE 'unit.%' THEN
    IF NOT petro_private.catalog_is_admin(true) THEN
      RAISE EXCEPTION 'CATALOG_PLATFORM_WRITE_FORBIDDEN' USING ERRCODE='42501';
    END IF;
  END IF;

  IF p_action='unit.create' THEN
    code_value:=lower(btrim(p_payload->>'code'));
    name_value:=btrim(p_payload->>'nameAr');
    version_value:=coalesce((p_payload->>'quantityScale')::integer,-1);
    IF code_value !~ '^[a-z][a-z0-9_]{1,39}$'
       OR char_length(name_value) NOT BETWEEN 2 AND 80
       OR version_value NOT BETWEEN 0 AND 6 THEN
      RAISE EXCEPTION 'CATALOG_UNIT_INVALID' USING ERRCODE='22023';
    END IF;
    INSERT INTO public.petro_catalog_units(code,name_ar,quantity_scale,created_by)
    VALUES(code_value,name_value,version_value,actor);
    INSERT INTO public.petro_audit_events(actor_id,action,target_id,detail)
    VALUES(actor,'catalog.unit.created',NULL,jsonb_build_object('code',code_value,'nameAr',name_value,'quantityScale',version_value,'reason',p_reason));
    result:=jsonb_build_object('code',code_value,'nameAr',name_value,'quantityScale',version_value,'active',true);

  ELSIF p_action='unit.status' THEN
    code_value:=p_payload->>'code';
    IF code_value IS NULL OR code_value IN ('litre','piece','service','pack') THEN
      RAISE EXCEPTION 'CATALOG_SYSTEM_UNIT_IMMUTABLE' USING ERRCODE='55000';
    END IF;
    UPDATE public.petro_catalog_units SET active=(p_payload->>'status'='active')
    WHERE code=code_value AND (p_payload->>'status') IN ('active','suspended');
    IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_UNIT_NOT_FOUND_OR_INVALID' USING ERRCODE='P0002'; END IF;
    INSERT INTO public.petro_audit_events(actor_id,action,target_id,detail)
    VALUES(actor,'catalog.unit.status',NULL,jsonb_build_object('code',code_value,'status',p_payload->>'status','reason',p_reason));
    result:=jsonb_build_object('code',code_value,'status',p_payload->>'status');

  ELSIF p_action='category.create' THEN
    code_value:=lower(btrim(p_payload->>'code'));
    name_value:=btrim(p_payload->>'nameAr');
    status_value:=coalesce(p_payload->>'serviceGroup','');
    IF code_value='fuel' OR status_value NOT IN ('wash','oils','parts')
       OR char_length(code_value) NOT BETWEEN 2 AND 40
       OR name_value IS NULL OR char_length(name_value) NOT BETWEEN 2 AND 100
       OR jsonb_typeof(coalesce(p_payload->'allowedItemKinds','[]'::jsonb))<>'array'
       OR cardinality(ARRAY(SELECT jsonb_array_elements_text(coalesce(p_payload->'allowedItemKinds','[]'::jsonb))))=0
       OR NOT (ARRAY(SELECT jsonb_array_elements_text(coalesce(p_payload->'allowedItemKinds','[]'::jsonb))) <@ ARRAY['product','service']::text[]) THEN
      RAISE EXCEPTION 'CATALOG_CATEGORY_INVALID' USING ERRCODE='22023';
    END IF;
    IF EXISTS (SELECT 1 FROM public.petro_catalog_categories WHERE code=code_value) THEN
      RAISE EXCEPTION 'CATALOG_CATEGORY_EXISTS' USING ERRCODE='23505';
    END IF;
    INSERT INTO public.petro_catalog_categories(code,name_ar,domain_kind,service_group,allowed_item_kinds,created_by,updated_by)
    VALUES(code_value,name_value,'catalog',status_value,
      ARRAY(SELECT jsonb_array_elements_text(coalesce(p_payload->'allowedItemKinds','[]'::jsonb))),
      actor,actor) RETURNING id INTO category_id;
    INSERT INTO public.petro_audit_events(actor_id,action,target_id,detail)
    VALUES(actor,'catalog.category.created',category_id,jsonb_build_object('code',code_value,'reason',p_reason));
    result:=jsonb_build_object('id',category_id,'code',code_value,'nameAr',name_value,'status','active');

  ELSIF p_action='category.update' OR p_action='category.status' THEN
    category_id:=nullif(p_payload->>'categoryId','')::uuid;
    SELECT * INTO category_row FROM public.petro_catalog_categories WHERE id=category_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_CATEGORY_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF (p_payload->>'expectedVersion')::integer IS DISTINCT FROM category_row.version THEN
      RAISE EXCEPTION 'CATALOG_CATEGORY_VERSION_CONFLICT' USING ERRCODE='40001';
    END IF;
    IF p_action='category.status' THEN
      status_value:=p_payload->>'status';
      IF status_value NOT IN ('active','suspended') THEN RAISE EXCEPTION 'CATALOG_CATEGORY_STATUS_INVALID' USING ERRCODE='22023'; END IF;
      UPDATE public.petro_catalog_categories SET active=(status_value='active'),version=version+1,
        updated_at=now(),updated_by=actor WHERE id=category_id;
    ELSE
      name_value:=btrim(coalesce(p_payload->>'nameAr',category_row.name_ar));
      IF char_length(name_value) NOT BETWEEN 2 AND 100 THEN RAISE EXCEPTION 'CATALOG_CATEGORY_INVALID' USING ERRCODE='22023'; END IF;
      UPDATE public.petro_catalog_categories SET name_ar=name_value,version=version+1,
        updated_at=now(),updated_by=actor WHERE id=category_id;
    END IF;
    INSERT INTO public.petro_audit_events(actor_id,action,target_id,detail)
    VALUES(actor,'catalog.category.updated',category_id,jsonb_build_object('status',p_payload->>'status','nameAr',p_payload->>'nameAr','reason',p_reason));
    result:=jsonb_build_object('id',category_id,'version',category_row.version+1);

  ELSIF p_action='fuel.type.create' THEN
    code_value:=lower(btrim(p_payload->>'code')); name_value:=btrim(p_payload->>'nameAr');
    status_value:=p_payload->>'vehicleFuelFamily'; unit_value:=coalesce(p_payload->>'unitCode','litre');
    IF char_length(code_value) NOT BETWEEN 2 AND 40 OR char_length(name_value) NOT BETWEEN 2 AND 80
       OR status_value NOT IN ('gasoline','diesel','natural_gas','other')
       OR NOT EXISTS (SELECT 1 FROM public.petro_catalog_units WHERE code=unit_value AND active) THEN
      RAISE EXCEPTION 'FUEL_TYPE_INVALID' USING ERRCODE='22023';
    END IF;
    INSERT INTO public.petro_fuel_types(code,name_ar,vehicle_fuel_family,unit_code,created_by,updated_by)
    VALUES(code_value,name_value,status_value,unit_value,actor,actor) RETURNING id INTO fuel_id;
    INSERT INTO public.petro_audit_events(actor_id,action,target_id,detail)
    VALUES(actor,'catalog.fuel_type.created',fuel_id,jsonb_build_object('code',code_value,'reason',p_reason));
    result:=jsonb_build_object('id',fuel_id,'code',code_value,'nameAr',name_value,'active',true);

  ELSIF p_action='fuel.type.update' OR p_action='fuel.type.status' THEN
    fuel_id:=nullif(p_payload->>'fuelTypeId','')::uuid;
    SELECT * INTO item_row FROM public.petro_fuel_types WHERE id=fuel_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'FUEL_TYPE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF (p_payload->>'expectedVersion')::integer IS DISTINCT FROM item_row.version THEN
      RAISE EXCEPTION 'FUEL_TYPE_VERSION_CONFLICT' USING ERRCODE='40001';
    END IF;
    IF p_action='fuel.type.status' THEN
      status_value:=p_payload->>'status';
      IF status_value NOT IN ('active','suspended') THEN RAISE EXCEPTION 'FUEL_TYPE_STATUS_INVALID' USING ERRCODE='22023'; END IF;
      UPDATE public.petro_fuel_types SET active=(status_value='active'),version=version+1,
        updated_at=now(),updated_by=actor WHERE id=fuel_id;
    ELSE
      code_value:=lower(btrim(coalesce(p_payload->>'code',item_row.code)));
      name_value:=btrim(coalesce(p_payload->>'nameAr',item_row.name_ar));
      status_value:=coalesce(p_payload->>'vehicleFuelFamily',item_row.vehicle_fuel_family);
      unit_value:=coalesce(p_payload->>'unitCode',item_row.unit_code);
      IF code_value !~ '^[a-z][a-z0-9_]{1,39}$'
         OR char_length(name_value) NOT BETWEEN 2 AND 80
         OR status_value NOT IN ('gasoline','diesel','natural_gas','other')
         OR NOT EXISTS (SELECT 1 FROM public.petro_catalog_units WHERE code=unit_value AND active) THEN
        RAISE EXCEPTION 'FUEL_TYPE_INVALID' USING ERRCODE='22023';
      END IF;
      UPDATE public.petro_fuel_types SET code=code_value,name_ar=name_value,
        vehicle_fuel_family=status_value,unit_code=unit_value,
        version=version+1,updated_at=now(),updated_by=actor WHERE id=fuel_id;
    END IF;
    INSERT INTO public.petro_audit_events(actor_id,action,target_id,detail)
    VALUES(actor,'catalog.fuel_type.updated',fuel_id,jsonb_build_object('status',p_payload->>'status','reason',p_reason));
    result:=jsonb_build_object('id',fuel_id,'version',item_row.version+1);

  ELSIF p_action='fuel.price.create_draft' THEN
    fuel_id:=nullif(p_payload->>'fuelTypeId','')::uuid;
    IF NOT EXISTS (SELECT 1 FROM public.petro_fuel_types WHERE id=fuel_id AND active) THEN
      RAISE EXCEPTION 'FUEL_TYPE_INACTIVE_OR_MISSING' USING ERRCODE='P0002';
    END IF;
    IF coalesce(p_payload->>'pricePerUnit','') !~ '^[0-9]{1,12}([.][0-9]{1,6})?$' THEN
      RAISE EXCEPTION 'FUEL_PRICE_INVALID' USING ERRCODE='22023';
    END IF;
    amount_value:=(p_payload->>'pricePerUnit')::numeric;
    valid_from_value:=((p_payload->>'validFromLocal')::timestamp without time zone) AT TIME ZONE 'Africa/Cairo';
    valid_to_value:=CASE WHEN nullif(p_payload->>'validToLocal','') IS NULL THEN NULL
      ELSE ((p_payload->>'validToLocal')::timestamp without time zone) AT TIME ZONE 'Africa/Cairo' END;
    IF amount_value<=0 OR valid_from_value<now()-interval '5 seconds'
       OR (valid_to_value IS NOT NULL AND valid_to_value<=valid_from_value) THEN
      RAISE EXCEPTION 'FUEL_PRICE_RANGE_INVALID' USING ERRCODE='22023';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('fuel:'||fuel_id::text,0));
    SELECT coalesce(max(version),0)+1 INTO version_value
    FROM public.petro_fuel_price_versions WHERE fuel_type_id=fuel_id;
    INSERT INTO public.petro_fuel_price_versions(fuel_type_id,version,price_per_unit,unit_code,valid_from,valid_to,reason,created_by)
    SELECT fuel_id,version_value,amount_value,f.unit_code,valid_from_value,valid_to_value,p_reason,actor
    FROM public.petro_fuel_types f WHERE f.id=fuel_id
    RETURNING id INTO price_id;
    INSERT INTO public.petro_audit_events(actor_id,action,target_id,detail)
    VALUES(actor,'catalog.fuel_price.draft_created',price_id,jsonb_build_object('fuelTypeId',fuel_id,'pricePerUnit',amount_value::text,'validFrom',valid_from_value,'validTo',valid_to_value,'reason',p_reason));
    result:=jsonb_build_object('id',price_id,'version',version_value,'status','draft','pricePerUnit',amount_value::text);

  ELSIF p_action='fuel.price.publish' OR p_action='fuel.price.cancel' THEN
    price_id:=nullif(p_payload->>'priceVersionId','')::uuid;
    SELECT p.*,p.fuel_type_id AS scoped_fuel_id INTO existing_row
    FROM public.petro_fuel_price_versions p WHERE p.id=price_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'FUEL_PRICE_VERSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('fuel:'||existing_row.scoped_fuel_id::text,0));
    IF p_action='fuel.price.cancel' THEN
      IF existing_row.status='published' AND existing_row.valid_from<=now() THEN
        RAISE EXCEPTION 'ACTIVE_PRICE_IMMUTABLE' USING ERRCODE='55000';
      END IF;
      IF existing_row.status NOT IN ('draft','published') THEN RAISE EXCEPTION 'PRICE_STATE_INVALID' USING ERRCODE='55000'; END IF;
      UPDATE public.petro_fuel_price_versions SET status='canceled' WHERE id=price_id;
      result:=jsonb_build_object('id',price_id,'status','canceled');
    ELSE
      IF existing_row.status<>'draft' OR existing_row.valid_from<now()-interval '5 seconds'
         OR NOT EXISTS (SELECT 1 FROM public.petro_fuel_types WHERE id=existing_row.scoped_fuel_id AND active) THEN
        RAISE EXCEPTION 'FUEL_PRICE_NOT_PUBLISHABLE' USING ERRCODE='55000';
      END IF;
      FOR item_row IN
        SELECT p.* FROM public.petro_fuel_price_versions p
        WHERE p.fuel_type_id=existing_row.scoped_fuel_id AND p.status='published'
          AND tstzrange(p.valid_from,p.valid_to,'[)') && tstzrange(existing_row.valid_from,existing_row.valid_to,'[)')
        FOR UPDATE
      LOOP
        IF item_row.valid_from<existing_row.valid_from
           AND (item_row.valid_to IS NULL OR item_row.valid_to>existing_row.valid_from) THEN
          UPDATE public.petro_fuel_price_versions SET valid_to=existing_row.valid_from
          WHERE id=item_row.id;
          INSERT INTO public.petro_audit_events(actor_id,action,target_id,detail)
          VALUES(actor,'catalog.fuel_price.range_closed',item_row.id,jsonb_build_object('newVersionId',price_id,'validTo',existing_row.valid_from,'reason',p_reason));
        ELSE
          RAISE EXCEPTION 'FUEL_PRICE_OVERLAP' USING ERRCODE='23P01';
        END IF;
      END LOOP;
      UPDATE public.petro_fuel_price_versions SET status='published',published_at=now(),published_by=actor
      WHERE id=price_id;
      result:=jsonb_build_object('id',price_id,'status','published','validFrom',existing_row.valid_from);
    END IF;
    INSERT INTO public.petro_audit_events(actor_id,action,target_id,detail)
    VALUES(actor,'catalog.fuel_price.'||CASE WHEN p_action='fuel.price.publish' THEN 'published' ELSE 'canceled' END,
      price_id,jsonb_build_object('reason',p_reason));

  ELSIF p_action='item.create' THEN
    org_id:=nullif(p_payload->>'organizationId','')::uuid;
    category_id:=nullif(p_payload->>'categoryId','')::uuid;
    SELECT * INTO category_row FROM public.petro_catalog_categories WHERE id=category_id AND active AND domain_kind='catalog';
    IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_CATEGORY_INACTIVE_OR_MISSING' USING ERRCODE='P0002'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.petro_organizations o WHERE o.id=org_id AND o.kind IN ('station','provider')) THEN
      RAISE EXCEPTION 'CATALOG_ORGANIZATION_NOT_FOUND' USING ERRCODE='P0002';
    END IF;
    IF NOT petro_private.catalog_merchant_can_manage_org(org_id,NULL) THEN RAISE EXCEPTION 'CATALOG_ORG_WRITE_FORBIDDEN' USING ERRCODE='42501'; END IF;
    status_value:=p_payload->>'kind';
    name_value:=btrim(p_payload->>'name');
    unit_value:=p_payload->>'unitCode';
    attributes_value:=coalesce(p_payload->'attributes','{}'::jsonb);
    IF status_value NOT IN ('product','service') OR NOT (category_row.allowed_item_kinds @> ARRAY[status_value]::text[])
       OR char_length(name_value) NOT BETWEEN 2 AND 160
       OR NOT EXISTS (SELECT 1 FROM public.petro_catalog_units WHERE code=unit_value AND active)
        OR NOT petro_private.catalog_attributes_valid(category_row.code,attributes_value)
       OR (category_row.code='wash' AND status_value<>'service')
       OR (category_row.code='wash' AND (
           (attributes_value ? 'vehicleTypes' AND jsonb_typeof(attributes_value->'vehicleTypes')<>'array')
           OR (attributes_value ? 'durationMinutes' AND jsonb_typeof(attributes_value->'durationMinutes')<>'number')
       ))
       OR (category_row.code='oils' AND attributes_value ?| ARRAY['vehicleTypes','voltage','capacityAh'])
       OR (category_row.code IN ('batteries','filters','parts','consumables')
           AND attributes_value ?| ARRAY['viscosity','specification','volumeMl','durationMinutes']) THEN
      RAISE EXCEPTION 'CATALOG_ITEM_FIELDS_INVALID' USING ERRCODE='22023';
    END IF;
    INSERT INTO public.petro_catalog_items(
      organization_id,category_id,item_kind,name,description,internal_code,barcode,brand_name,
      unit_code,attributes,created_by,updated_by
    ) VALUES(
      org_id,category_id,status_value,name_value,coalesce(p_payload->>'description',''),
      nullif(btrim(p_payload->>'internalCode'),''),nullif(btrim(p_payload->>'barcode'),''),
      nullif(btrim(p_payload->>'brandName'),''),unit_value,attributes_value,actor,actor
    ) RETURNING id INTO item_id;
    INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
    VALUES(actor,org_id,'catalog.item.created',item_id,jsonb_build_object('kind',status_value,'categoryId',category_id,'reason',p_reason));
    result:=jsonb_build_object('id',item_id,'organizationId',org_id,'status','draft','version',1);

  ELSIF p_action='item.update' THEN
    item_id:=nullif(p_payload->>'itemId','')::uuid;
    SELECT i.*,i.organization_id AS scoped_org_id INTO item_row
    FROM public.petro_catalog_items i WHERE i.id=item_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_ITEM_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    org_id:=item_row.scoped_org_id;
    branch_id:=nullif(p_payload->>'branchId','')::uuid;
    IF NOT petro_private.catalog_merchant_can_manage_org(org_id,branch_id) THEN RAISE EXCEPTION 'CATALOG_ITEM_WRITE_FORBIDDEN' USING ERRCODE='42501'; END IF;
    IF (p_payload->>'expectedVersion')::integer IS DISTINCT FROM item_row.version THEN
      RAISE EXCEPTION 'CATALOG_ITEM_VERSION_CONFLICT' USING ERRCODE='40001';
    END IF;
    name_value:=btrim(coalesce(p_payload->>'name',item_row.name));
    attributes_value:=coalesce(p_payload->'attributes',item_row.attributes);
    IF char_length(name_value) NOT BETWEEN 2 AND 160 OR jsonb_typeof(attributes_value)<>'object' THEN
      RAISE EXCEPTION 'CATALOG_ITEM_FIELDS_INVALID' USING ERRCODE='22023';
    END IF;
    SELECT c.code INTO code_value FROM public.petro_catalog_categories c WHERE c.id=item_row.category_id;
    IF NOT petro_private.catalog_attributes_valid(code_value,attributes_value)
       OR NOT EXISTS (SELECT 1 FROM public.petro_catalog_units u WHERE u.code=coalesce(p_payload->>'unitCode',item_row.unit_code) AND u.active) THEN
      RAISE EXCEPTION 'CATALOG_ITEM_ATTRIBUTES_INVALID' USING ERRCODE='22023';
    END IF;
    UPDATE public.petro_catalog_items SET
      name=name_value,
      description=CASE WHEN p_payload ? 'description' THEN coalesce(p_payload->>'description','') ELSE description END,
      internal_code=CASE WHEN p_payload ? 'internalCode' THEN nullif(btrim(p_payload->>'internalCode'),'') ELSE internal_code END,
      barcode=CASE WHEN p_payload ? 'barcode' THEN nullif(btrim(p_payload->>'barcode'),'') ELSE barcode END,
      brand_name=CASE WHEN p_payload ? 'brandName' THEN nullif(btrim(p_payload->>'brandName'),'') ELSE brand_name END,
      unit_code=coalesce(p_payload->>'unitCode',unit_code),attributes=attributes_value,
      version=version+1,updated_at=now(),updated_by=actor
    WHERE id=item_id;
    INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
    VALUES(actor,org_id,'catalog.item.updated',item_id,jsonb_build_object('version',item_row.version+1,'reason',p_reason));
    result:=jsonb_build_object('id',item_id,'version',item_row.version+1);

  ELSIF p_action='item.status' THEN
    item_id:=nullif(p_payload->>'itemId','')::uuid; status_value:=p_payload->>'status';
    SELECT i.*,i.organization_id AS scoped_org_id INTO item_row FROM public.petro_catalog_items i WHERE i.id=item_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_ITEM_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF (p_payload->>'expectedVersion')::integer IS DISTINCT FROM item_row.version THEN
      RAISE EXCEPTION 'CATALOG_ITEM_VERSION_CONFLICT' USING ERRCODE='40001';
    END IF;
    org_id:=item_row.scoped_org_id;
    IF status_value='suspended' THEN
      IF NOT petro_private.catalog_is_admin(true) THEN
        RAISE EXCEPTION 'CATALOG_ITEM_STATUS_FORBIDDEN' USING ERRCODE='42501';
      END IF;
    ELSIF status_value='active' AND petro_private.catalog_is_admin(true) AND item_row.central_suspended THEN
      IF char_length(btrim(p_reason))<3 THEN RAISE EXCEPTION 'CATALOG_REASON_REQUIRED' USING ERRCODE='22023'; END IF;
    ELSIF status_value NOT IN ('draft','active') OR NOT petro_private.catalog_merchant_can_manage_org(org_id,NULL)
       OR item_row.central_suspended THEN
      RAISE EXCEPTION 'CATALOG_ITEM_STATUS_FORBIDDEN' USING ERRCODE='42501';
    END IF;
    IF status_value='suspended' AND char_length(btrim(p_reason))<3 THEN RAISE EXCEPTION 'CATALOG_REASON_REQUIRED' USING ERRCODE='22023'; END IF;
    IF status_value='active' AND item_row.review_status<>'approved' THEN
      RAISE EXCEPTION 'CATALOG_ITEM_REVIEW_REQUIRED' USING ERRCODE='55000';
    END IF;
    UPDATE public.petro_catalog_items SET display_status=status_value,
      central_suspended=CASE WHEN status_value='suspended' THEN true
        WHEN status_value='active' AND petro_private.catalog_is_admin(true) THEN false ELSE central_suspended END,
      version=version+1,updated_at=now(),updated_by=actor
    WHERE id=item_id;
    INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
    VALUES(actor,org_id,'catalog.item.status',item_id,jsonb_build_object('status',status_value,'reason',p_reason));
    result:=jsonb_build_object('id',item_id,'status',status_value,'version',item_row.version+1);

  ELSIF p_action='item.review' THEN
    item_id:=nullif(p_payload->>'itemId','')::uuid; status_value:=p_payload->>'reviewStatus';
    IF NOT petro_private.catalog_is_admin(true) OR status_value NOT IN ('approved','rejected','not_reviewed') THEN
      RAISE EXCEPTION 'CATALOG_REVIEW_FORBIDDEN' USING ERRCODE='42501';
    END IF;
    SELECT * INTO item_row FROM public.petro_catalog_items WHERE id=item_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_ITEM_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF (p_payload->>'expectedVersion')::integer IS DISTINCT FROM item_row.version THEN
      RAISE EXCEPTION 'CATALOG_ITEM_VERSION_CONFLICT' USING ERRCODE='40001';
    END IF;
    UPDATE public.petro_catalog_items SET review_status=status_value,review_reason=p_reason,
      version=version+1,updated_at=now(),updated_by=actor WHERE id=item_id;
    INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
    VALUES(actor,item_row.organization_id,'catalog.item.review',item_id,jsonb_build_object('status',status_value,'reason',p_reason));
    result:=jsonb_build_object('id',item_id,'reviewStatus',status_value,'version',item_row.version+1);

  ELSIF p_action='item.branch_availability' THEN
    item_id:=nullif(p_payload->>'itemId','')::uuid; branch_id:=nullif(p_payload->>'branchId','')::uuid;
    SELECT i.organization_id INTO org_id FROM public.petro_catalog_items i WHERE i.id=item_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_ITEM_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.petro_branches b WHERE b.id=branch_id AND b.organization_id=org_id AND b.status='active')
       OR NOT petro_private.catalog_merchant_can_manage_org(org_id,branch_id) THEN
      RAISE EXCEPTION 'CATALOG_BRANCH_SCOPE_FORBIDDEN' USING ERRCODE='42501';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('availability:'||item_id::text||':'||branch_id::text,0)
    );
    SELECT a.version INTO version_value FROM public.petro_catalog_branch_availability a
    WHERE a.item_id=item_id AND a.branch_id=branch_id FOR UPDATE;
    IF FOUND THEN
      IF (p_payload->>'expectedVersion')::integer IS DISTINCT FROM version_value THEN
        RAISE EXCEPTION 'CATALOG_BRANCH_AVAILABILITY_VERSION_CONFLICT' USING ERRCODE='40001';
      END IF;
    ELSIF coalesce((p_payload->>'expectedVersion')::integer,0)<>0 THEN
      RAISE EXCEPTION 'CATALOG_BRANCH_AVAILABILITY_VERSION_CONFLICT' USING ERRCODE='40001';
    END IF;
    INSERT INTO public.petro_catalog_branch_availability AS current_availability
      (organization_id,item_id,branch_id,available,reason,created_by,updated_by)
    VALUES(org_id,item_id,branch_id,coalesce((p_payload->>'available')::boolean,false),p_reason,actor,actor)
    ON CONFLICT ON CONSTRAINT petro_catalog_branch_availability_pkey
    DO UPDATE SET available=excluded.available,version=current_availability.version+1,
      reason=excluded.reason,updated_at=now(),updated_by=actor;
    INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
    VALUES(actor,org_id,'catalog.item.branch_availability',item_id,jsonb_build_object('branchId',branch_id,'available',coalesce((p_payload->>'available')::boolean,false),'reason',p_reason));
    result:=jsonb_build_object('itemId',item_id,'branchId',branch_id,'available',coalesce((p_payload->>'available')::boolean,false));

  ELSIF p_action='item.price.create_draft' THEN
    item_id:=nullif(p_payload->>'itemId','')::uuid; branch_id:=nullif(p_payload->>'branchId','')::uuid;
    IF coalesce(p_payload->>'priceMinor','') !~ '^[1-9][0-9]{0,14}$' THEN
      RAISE EXCEPTION 'CATALOG_PRICE_INVALID' USING ERRCODE='22023';
    END IF;
    price_minor_value:=(p_payload->>'priceMinor')::bigint;
    SELECT i.organization_id,i.display_status,i.category_id INTO org_id,status_value,category_id
    FROM public.petro_catalog_items i WHERE i.id=item_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_ITEM_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF NOT petro_private.catalog_merchant_can_manage_org(org_id,branch_id) THEN RAISE EXCEPTION 'CATALOG_PRICE_WRITE_FORBIDDEN' USING ERRCODE='42501'; END IF;
    IF branch_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.petro_catalog_branch_availability a
      WHERE a.item_id=item_id AND a.branch_id=branch_id AND a.available
    ) THEN RAISE EXCEPTION 'CATALOG_BRANCH_NOT_AVAILABLE' USING ERRCODE='23514'; END IF;
    valid_from_value:=((p_payload->>'validFromLocal')::timestamp without time zone) AT TIME ZONE 'Africa/Cairo';
    valid_to_value:=CASE WHEN nullif(p_payload->>'validToLocal','') IS NULL THEN NULL
      ELSE ((p_payload->>'validToLocal')::timestamp without time zone) AT TIME ZONE 'Africa/Cairo' END;
    IF valid_from_value<now()-interval '5 seconds' OR (valid_to_value IS NOT NULL AND valid_to_value<=valid_from_value) THEN
      RAISE EXCEPTION 'CATALOG_PRICE_RANGE_INVALID' USING ERRCODE='22023';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('item:'||item_id::text||':'||coalesce(branch_id::text,'org'),0));
    SELECT coalesce(max(p.version),0)+1 INTO version_value
    FROM public.petro_catalog_price_versions p
    WHERE p.item_id=item_id AND p.branch_id IS NOT DISTINCT FROM branch_id;
    INSERT INTO public.petro_catalog_price_versions(organization_id,item_id,branch_id,version,price_minor,valid_from,valid_to,reason,created_by)
    VALUES(org_id,item_id,branch_id,version_value,price_minor_value,valid_from_value,valid_to_value,p_reason,actor)
    RETURNING id INTO price_id;
    INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
    VALUES(actor,org_id,'catalog.item_price.draft_created',price_id,
      jsonb_build_object('itemId',item_id,'branchId',branch_id,'priceMinor',price_minor_value::text,'validFrom',valid_from_value,'validTo',valid_to_value,'reason',p_reason));
    result:=jsonb_build_object('id',price_id,'version',version_value,'status','draft','priceMinor',price_minor_value::text);

  ELSIF p_action='item.price.publish' OR p_action='item.price.cancel' THEN
    price_id:=nullif(p_payload->>'priceVersionId','')::uuid;
    SELECT p.*,p.organization_id AS scoped_org_id,p.item_id AS scoped_item_id,p.branch_id AS scoped_branch_id
      INTO existing_row FROM public.petro_catalog_price_versions p WHERE p.id=price_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_PRICE_VERSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    org_id:=existing_row.scoped_org_id; item_id:=existing_row.scoped_item_id; branch_id:=existing_row.scoped_branch_id;
    IF NOT petro_private.catalog_merchant_can_manage_org(org_id,branch_id) THEN RAISE EXCEPTION 'CATALOG_PRICE_WRITE_FORBIDDEN' USING ERRCODE='42501'; END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('item:'||item_id::text||':'||coalesce(branch_id::text,'org'),0));
    IF p_action='item.price.cancel' THEN
      IF existing_row.status='published' AND existing_row.valid_from<=now() THEN RAISE EXCEPTION 'ACTIVE_PRICE_IMMUTABLE' USING ERRCODE='55000'; END IF;
      IF existing_row.status NOT IN ('draft','published') THEN RAISE EXCEPTION 'PRICE_STATE_INVALID' USING ERRCODE='55000'; END IF;
      UPDATE public.petro_catalog_price_versions SET status='canceled' WHERE id=price_id;
      result:=jsonb_build_object('id',price_id,'status','canceled');
    ELSE
      IF existing_row.status<>'draft' OR existing_row.valid_from<now()-interval '5 seconds'
         OR NOT EXISTS (
          SELECT 1 FROM public.petro_catalog_items i JOIN public.petro_catalog_categories c ON c.id=i.category_id
            WHERE i.id=item_id AND i.display_status='active' AND i.review_status<>'rejected' AND c.active
         ) THEN
        RAISE EXCEPTION 'CATALOG_PRICE_NOT_PUBLISHABLE' USING ERRCODE='55000';
      END IF;
      IF branch_id IS NOT NULL AND (
        NOT EXISTS (SELECT 1 FROM public.petro_catalog_branch_availability a
          WHERE a.item_id=item_id AND a.branch_id=branch_id AND a.available)
        OR NOT EXISTS (SELECT 1 FROM public.petro_branches b
          WHERE b.id=branch_id AND b.organization_id=org_id AND b.status='active')
      ) THEN RAISE EXCEPTION 'CATALOG_BRANCH_NOT_AVAILABLE' USING ERRCODE='23514'; END IF;
      FOR item_row IN
        SELECT p.* FROM public.petro_catalog_price_versions p
        WHERE p.item_id=item_id AND p.branch_id IS NOT DISTINCT FROM branch_id AND p.status='published'
          AND tstzrange(p.valid_from,p.valid_to,'[)') && tstzrange(existing_row.valid_from,existing_row.valid_to,'[)')
        FOR UPDATE
      LOOP
        IF item_row.valid_from<existing_row.valid_from
           AND (item_row.valid_to IS NULL OR item_row.valid_to>existing_row.valid_from) THEN
          UPDATE public.petro_catalog_price_versions SET valid_to=existing_row.valid_from WHERE id=item_row.id;
          INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
          VALUES(actor,org_id,'catalog.item_price.range_closed',item_row.id,
            jsonb_build_object('newVersionId',price_id,'validTo',existing_row.valid_from,'reason',p_reason));
        ELSE
          RAISE EXCEPTION 'CATALOG_PRICE_OVERLAP' USING ERRCODE='23P01';
        END IF;
      END LOOP;
      UPDATE public.petro_catalog_price_versions SET status='published',published_at=now(),published_by=actor
      WHERE id=price_id;
      result:=jsonb_build_object('id',price_id,'status','published','validFrom',existing_row.valid_from);
    END IF;
    INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
    VALUES(actor,org_id,'catalog.item_price.'||CASE WHEN p_action='item.price.publish' THEN 'published' ELSE 'canceled' END,
      price_id,jsonb_build_object('reason',p_reason));

  ELSIF p_action='item.image.intent' THEN
    item_id:=nullif(p_payload->>'itemId','')::uuid;
    branch_id:=nullif(p_payload->>'branchId','')::uuid;
    SELECT i.organization_id INTO org_id FROM public.petro_catalog_items i WHERE i.id=item_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_ITEM_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF NOT petro_private.catalog_merchant_can_manage_org(org_id,branch_id) THEN RAISE EXCEPTION 'CATALOG_IMAGE_WRITE_FORBIDDEN' USING ERRCODE='42501'; END IF;
    IF branch_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.petro_branches WHERE id=branch_id AND organization_id=org_id AND status='active'
    ) THEN RAISE EXCEPTION 'CATALOG_BRANCH_SCOPE_FORBIDDEN' USING ERRCODE='42501'; END IF;
    name_value:=btrim(p_payload->>'fileName'); status_value:=p_payload->>'contentType';
    IF char_length(name_value) NOT BETWEEN 1 AND 160 OR status_value NOT IN ('image/jpeg','image/png')
       OR coalesce((p_payload->>'byteSize')::bigint,0) NOT BETWEEN 1 AND 5242880 THEN
      RAISE EXCEPTION 'CATALOG_IMAGE_INVALID' USING ERRCODE='22023';
    END IF;
    image_id:=gen_random_uuid();
    INSERT INTO public.petro_catalog_images(id,organization_id,item_id,branch_id,uploader_id,file_name,content_type,byte_size,storage_path,upload_expires_at)
    VALUES(image_id,org_id,item_id,branch_id,actor,name_value,status_value,(p_payload->>'byteSize')::bigint,
      'catalog-images/'||gen_random_uuid()::text,now()+interval '30 minutes');
    INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
    VALUES(actor,org_id,'catalog.item_image.upload_started',image_id,
      jsonb_build_object('itemId',item_id,'contentType',status_value,'byteSize',(p_payload->>'byteSize')::bigint));
    result:=jsonb_build_object('id',image_id,'bucket','petro-private-documents','status','pending_upload');

  ELSIF p_action='item.image.remove' THEN
    image_id:=nullif(p_payload->>'imageId','')::uuid;
    SELECT im.organization_id,im.item_id,im.branch_id INTO org_id,item_id,branch_id
    FROM public.petro_catalog_images im WHERE im.id=image_id FOR UPDATE;
    IF NOT FOUND OR NOT petro_private.catalog_merchant_can_manage_org(org_id,branch_id) THEN
      RAISE EXCEPTION 'CATALOG_IMAGE_NOT_FOUND_OR_FORBIDDEN' USING ERRCODE='42501';
    END IF;
    UPDATE public.petro_catalog_images SET status='removed' WHERE id=image_id AND status='ready';
    IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_IMAGE_NOT_REMOVABLE' USING ERRCODE='55000'; END IF;
    INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
    VALUES(actor,org_id,'catalog.item_image.removed',image_id,jsonb_build_object('itemId',item_id,'reason',p_reason));
    result:=jsonb_build_object('id',image_id,'status','removed');

  ELSE
    RAISE EXCEPTION 'CATALOG_ACTION_UNKNOWN' USING ERRCODE='22023';
  END IF;

  RETURN petro_private.catalog_command_finish(actor,p_idempotency_key,result);
END
$$;

CREATE FUNCTION public.petro_catalog_image_upload_info(p_image_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE row_data record;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'CATALOG_IMAGE_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT im.*,im.organization_id AS scoped_org_id,im.branch_id AS scoped_branch_id
    INTO row_data FROM public.petro_catalog_images im WHERE im.id=p_image_id;
  IF NOT FOUND OR row_data.uploader_id<>auth.uid() OR row_data.status<>'pending_upload'
     OR row_data.upload_expires_at<=now()
      OR NOT petro_private.catalog_merchant_can_manage_org(row_data.scoped_org_id,row_data.scoped_branch_id) THEN
    RAISE EXCEPTION 'CATALOG_IMAGE_UPLOAD_UNAVAILABLE' USING ERRCODE='P0002';
  END IF;
  RETURN jsonb_build_object('id',row_data.id,'path',row_data.storage_path,'contentType',row_data.content_type,
    'byteSize',row_data.byte_size,'fileName',row_data.file_name);
END
$$;

CREATE FUNCTION public.petro_catalog_image_download_info(p_image_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE row_data record;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'CATALOG_IMAGE_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT im.*,im.organization_id AS scoped_org_id,im.branch_id AS scoped_branch_id
    INTO row_data FROM public.petro_catalog_images im WHERE im.id=p_image_id AND im.status='ready';
  IF NOT FOUND OR NOT petro_private.catalog_can_read_org(row_data.scoped_org_id,row_data.scoped_branch_id)
     OR (NOT petro_private.catalog_is_admin(false) AND NOT petro_private.catalog_can_read_org(row_data.scoped_org_id,NULL)
         AND row_data.branch_id IS NULL) THEN
    RAISE EXCEPTION 'CATALOG_IMAGE_NOT_FOUND_OR_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  RETURN jsonb_build_object('id',row_data.id,'path',row_data.storage_path,'contentType',row_data.content_type,
    'fileName',row_data.file_name);
END
$$;

CREATE FUNCTION public.petro_catalog_image_complete(p_image_id uuid,p_sha256 text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE row_data record;
BEGIN
  IF auth.uid() IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'CATALOG_IMAGE_COMPLETE_INVALID' USING ERRCODE='22023';
  END IF;
  SELECT im.*,im.organization_id AS scoped_org_id,im.branch_id AS scoped_branch_id
    INTO row_data FROM public.petro_catalog_images im WHERE im.id=p_image_id FOR UPDATE;
  IF NOT FOUND OR row_data.uploader_id<>auth.uid() OR row_data.status<>'pending_upload'
     OR row_data.upload_expires_at<=now()
      OR NOT petro_private.catalog_merchant_can_manage_org(row_data.scoped_org_id,row_data.scoped_branch_id) THEN
    RAISE EXCEPTION 'CATALOG_IMAGE_UPLOAD_UNAVAILABLE' USING ERRCODE='P0002';
  END IF;
  UPDATE public.petro_catalog_images SET status='ready',sha256=p_sha256,uploaded_at=now() WHERE id=p_image_id;
  INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
  VALUES(auth.uid(),row_data.scoped_org_id,'catalog.item_image.uploaded',p_image_id,
    jsonb_build_object('itemId',row_data.item_id,'sha256',p_sha256,'byteSize',row_data.byte_size));
  RETURN jsonb_build_object('id',p_image_id,'status','ready');
END
$$;

CREATE FUNCTION public.petro_catalog_image_fail(p_image_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
BEGIN
  UPDATE public.petro_catalog_images SET status='upload_failed'
  WHERE id=p_image_id AND uploader_id=auth.uid() AND status='pending_upload';
END
$$;

CREATE FUNCTION petro_private.catalog_can_access_image(p_object_path text,p_action text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.petro_catalog_images im
    WHERE im.storage_path=p_object_path
      AND (
        (p_action='upload' AND im.status='pending_upload' AND im.uploader_id=auth.uid()
          AND im.upload_expires_at>now()
          AND petro_private.catalog_merchant_can_manage_org(im.organization_id,im.branch_id))
        OR
        (p_action='read' AND im.status='ready'
          AND petro_private.catalog_can_read_org(im.organization_id,im.branch_id))
        OR
        (p_action='delete' AND im.status IN ('pending_upload','upload_failed','removed')
          AND (im.uploader_id=auth.uid() OR petro_private.catalog_merchant_can_manage_org(im.organization_id,im.branch_id)))
      )
  )
$$;

CREATE POLICY petro_catalog_image_read ON storage.objects FOR SELECT TO authenticated
USING (bucket_id='petro-private-documents' AND petro_private.catalog_can_access_image(name,'read'));
CREATE POLICY petro_catalog_image_upload ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id='petro-private-documents' AND petro_private.catalog_can_access_image(name,'upload'));
CREATE POLICY petro_catalog_image_delete_pending ON storage.objects FOR DELETE TO authenticated
USING (bucket_id='petro-private-documents' AND petro_private.catalog_can_access_image(name,'delete'));

REVOKE ALL ON FUNCTION petro_private.catalog_is_admin(boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION petro_private.catalog_can_read_org(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION petro_private.catalog_merchant_can_manage_org(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION petro_private.catalog_command_begin(uuid,text,jsonb,text,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION petro_private.catalog_command_finish(uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION petro_private.catalog_can_access_image(text,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION petro_private.catalog_attributes_valid(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION petro_private.catalog_is_admin(boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION petro_private.catalog_can_read_org(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION petro_private.catalog_merchant_can_manage_org(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION petro_private.catalog_can_access_image(text,text) TO authenticated;

REVOKE ALL ON FUNCTION public.petro_catalog_admin_categories() FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.petro_catalog_reference_data() FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.petro_catalog_admin_organizations(text,text,integer,integer) FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.petro_catalog_admin_fuel_list(text,integer,integer) FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.petro_catalog_list_items(uuid,uuid,text,text,text,text,integer,integer) FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.petro_catalog_item_detail(uuid) FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.petro_catalog_fuel_preview(uuid,numeric,bigint) FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.petro_catalog_command(text,jsonb,text,text) FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.petro_catalog_image_upload_info(uuid) FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.petro_catalog_image_download_info(uuid) FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.petro_catalog_image_complete(uuid,text) FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.petro_catalog_image_fail(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.petro_catalog_admin_categories() TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_catalog_reference_data() TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_catalog_admin_organizations(text,text,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_catalog_admin_fuel_list(text,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_catalog_list_items(uuid,uuid,text,text,text,text,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_catalog_item_detail(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_catalog_fuel_preview(uuid,numeric,bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_catalog_command(text,jsonb,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_catalog_image_upload_info(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_catalog_image_download_info(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_catalog_image_complete(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_catalog_image_fail(uuid) TO authenticated;

DO $$
DECLARE table_name text; object_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'petro_catalog_units','petro_catalog_categories','petro_fuel_types','petro_catalog_items',
    'petro_catalog_branch_availability','petro_catalog_price_versions','petro_fuel_price_versions',
    'petro_catalog_images','petro_catalog_idempotency'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid=pg_catalog.to_regclass('public.'||table_name) AND c.relrowsecurity
    ) THEN RAISE EXCEPTION 'CATALOG_0017_POSTCONDITION: RLS missing on %',table_name; END IF;
    IF has_table_privilege('anon','public.'||table_name,'SELECT')
       OR has_table_privilege('authenticated','public.'||table_name,'SELECT')
       OR has_table_privilege('service_role','public.'||table_name,'SELECT') THEN
      RAISE EXCEPTION 'CATALOG_0017_POSTCONDITION: direct table read grant exists on %',table_name;
    END IF;
  END LOOP;
  FOREACH object_name IN ARRAY ARRAY[
    'public.petro_catalog_admin_categories()',
    'public.petro_catalog_reference_data()',
    'public.petro_catalog_admin_organizations(text,text,integer,integer)',
    'public.petro_catalog_admin_fuel_list(text,integer,integer)',
    'public.petro_catalog_list_items(uuid,uuid,text,text,text,text,integer,integer)',
    'public.petro_catalog_item_detail(uuid)',
    'public.petro_catalog_fuel_preview(uuid,numeric,bigint)',
    'public.petro_catalog_command(text,jsonb,text,text)',
    'public.petro_catalog_image_upload_info(uuid)',
    'public.petro_catalog_image_download_info(uuid)',
    'public.petro_catalog_image_complete(uuid,text)',
    'public.petro_catalog_image_fail(uuid)'
  ] LOOP
    IF NOT has_function_privilege('authenticated',object_name,'EXECUTE')
       OR has_function_privilege('anon',object_name,'EXECUTE')
       OR has_function_privilege('service_role',object_name,'EXECUTE')
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc p
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))
         ) acl
         WHERE p.oid=pg_catalog.to_regprocedure(object_name)
           AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
       ) THEN
      RAISE EXCEPTION 'CATALOG_0017_POSTCONDITION: unexpected RPC grants on %',object_name;
    END IF;
  END LOOP;
  IF has_function_privilege('anon','petro_private.catalog_can_access_image(text,text)','EXECUTE')
     OR has_function_privilege('service_role','petro_private.catalog_can_access_image(text,text)','EXECUTE')
     OR NOT has_function_privilege('authenticated','petro_private.catalog_can_access_image(text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'CATALOG_0017_POSTCONDITION: catalog Storage helper grants differ';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))
    ) acl
    WHERE p.oid='petro_private.catalog_can_access_image(text,text)'::regprocedure
      AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
  ) THEN
    RAISE EXCEPTION 'CATALOG_0017_POSTCONDITION: catalog Storage helper is executable by PUBLIC';
  END IF;
END
$$;

COMMIT;
