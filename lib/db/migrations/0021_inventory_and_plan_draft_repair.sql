BEGIN;

-- Drafts are editable work in progress. A datetime-local value that was valid
-- when the form opened must not make a draft unsavable a minute later.
CREATE OR REPLACE FUNCTION public.petro_billing_admin_add_plan_version_v2(
  p_plan_id uuid,
  p_display_name text,
  p_description text,
  p_price_minor bigint,
  p_billing_unit text,
  p_billing_cycle text,
  p_currency text,
  p_effective_at timestamptz,
  p_entitlements jsonb,
  p_settings jsonb,
  p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE plan_row public.petro_plans%ROWTYPE; next_version integer; version_id uuid;
BEGIN
  IF NOT petro_private.plan_admin_authorized() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO plan_row FROM public.petro_plans WHERE id = p_plan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan not found' USING ERRCODE = 'P0002'; END IF;
  IF p_display_name IS NULL OR length(btrim(p_display_name)) NOT BETWEEN 2 AND 100
     OR p_description IS NULL OR length(p_description) > 1000
     OR p_price_minor IS NULL OR p_price_minor NOT BETWEEN 0 AND 1000000000
     OR (plan_row.audience = 'station' AND p_price_minor <> 0)
     OR (plan_row.audience <> 'station' AND p_price_minor = 0)
     OR p_billing_unit IS NULL
     OR p_billing_unit <> (CASE WHEN plan_row.audience = 'company' THEN 'vehicle' ELSE 'branch' END)
     OR p_billing_cycle IS DISTINCT FROM 'annual' OR p_currency IS DISTINCT FROM 'EGP'
     OR p_effective_at IS NULL
     OR NOT petro_private.plan_configuration_valid(p_entitlements)
     OR NOT petro_private.plan_configuration_valid(p_settings)
     OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'invalid plan version draft' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(max(version), 0) + 1 INTO next_version
  FROM public.petro_plan_versions WHERE plan_id = p_plan_id;
  INSERT INTO public.petro_plan_versions (
    plan_id, version, display_name, description, annual_price_minor,
    nfc_issue_price_minor, billing_unit, features, effective_at, created_by,
    publication_status, billing_cycle, currency, entitlements, settings
  ) VALUES (
    p_plan_id, next_version, btrim(p_display_name), btrim(p_description), p_price_minor,
    0, p_billing_unit,
    ARRAY(SELECT entry.item ->> 'key' FROM jsonb_array_elements(p_entitlements) AS entry(item)),
    p_effective_at, auth.uid(), 'draft', p_billing_cycle, p_currency, p_entitlements, p_settings
  ) RETURNING id INTO version_id;

  INSERT INTO public.petro_audit_events(actor_id, organization_id, action, target_id, detail)
  VALUES (auth.uid(), NULL, 'plan.version_drafted', version_id,
          jsonb_build_object('planId', p_plan_id, 'version', next_version, 'reason', btrim(p_reason)));
  RETURN version_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.petro_billing_admin_update_draft_version(
  p_plan_id uuid,
  p_version_id uuid,
  p_display_name text,
  p_description text,
  p_price_minor bigint,
  p_billing_unit text,
  p_billing_cycle text,
  p_currency text,
  p_effective_at timestamptz,
  p_entitlements jsonb,
  p_settings jsonb,
  p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE plan_row public.petro_plans%ROWTYPE; version_row public.petro_plan_versions%ROWTYPE;
BEGIN
  IF NOT petro_private.plan_admin_authorized() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO plan_row FROM public.petro_plans WHERE id = p_plan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO version_row FROM public.petro_plan_versions
  WHERE id = p_version_id AND plan_id = p_plan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan version not found' USING ERRCODE = 'P0002'; END IF;
  IF version_row.publication_status <> 'draft' THEN
    RAISE EXCEPTION 'only draft versions can be edited' USING ERRCODE = '55000';
  END IF;
  IF p_display_name IS NULL OR length(btrim(p_display_name)) NOT BETWEEN 2 AND 100
     OR p_description IS NULL OR length(p_description) > 1000
     OR p_price_minor IS NULL OR p_price_minor NOT BETWEEN 0 AND 1000000000
     OR (plan_row.audience = 'station' AND p_price_minor <> 0)
     OR (plan_row.audience <> 'station' AND p_price_minor = 0)
     OR p_billing_unit IS NULL
     OR p_billing_unit <> (CASE WHEN plan_row.audience = 'company' THEN 'vehicle' ELSE 'branch' END)
     OR p_billing_cycle IS DISTINCT FROM 'annual' OR p_currency IS DISTINCT FROM 'EGP'
     OR p_effective_at IS NULL
     OR NOT petro_private.plan_configuration_valid(p_entitlements)
     OR NOT petro_private.plan_configuration_valid(p_settings)
     OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'invalid plan version draft' USING ERRCODE = '22023';
  END IF;

  UPDATE public.petro_plan_versions
  SET display_name = btrim(p_display_name), description = btrim(p_description),
      annual_price_minor = p_price_minor, billing_unit = p_billing_unit,
      billing_cycle = p_billing_cycle, currency = p_currency,
      features = ARRAY(SELECT entry.item ->> 'key' FROM jsonb_array_elements(p_entitlements) AS entry(item)),
      effective_at = p_effective_at, entitlements = p_entitlements, settings = p_settings
  WHERE id = p_version_id;
  UPDATE public.petro_plans
  SET name = btrim(p_display_name), description = btrim(p_description)
  WHERE id = p_plan_id;
  INSERT INTO public.petro_audit_events(actor_id, organization_id, action, target_id, detail)
  VALUES (auth.uid(), NULL, 'plan.version_draft_updated', p_version_id,
          jsonb_build_object('planId', p_plan_id, 'reason', btrim(p_reason)));
  RETURN p_version_id;
END;
$$;

CREATE TABLE public.petro_inventory_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL REFERENCES public.petro_branches(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 120),
  location_kind text NOT NULL CHECK (location_kind IN ('sellable','quarantine','damaged','transit')),
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  UNIQUE (organization_id, branch_id, location_kind, name)
);
CREATE INDEX petro_inventory_locations_org_idx
  ON public.petro_inventory_locations(organization_id, branch_id, active);

CREATE TABLE public.petro_inventory_balances (
  organization_id uuid NOT NULL,
  location_id uuid NOT NULL,
  item_id uuid NOT NULL,
  on_hand numeric(20,6) NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved numeric(20,6) NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND reserved <= on_hand),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, item_id),
  FOREIGN KEY (location_id, organization_id)
    REFERENCES public.petro_inventory_locations(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (item_id, organization_id)
    REFERENCES public.petro_catalog_items(id, organization_id) ON DELETE RESTRICT
);
CREATE INDEX petro_inventory_balances_item_idx
  ON public.petro_inventory_balances(organization_id, item_id, location_id);

CREATE TABLE public.petro_inventory_reorder_rules (
  organization_id uuid NOT NULL,
  location_id uuid NOT NULL,
  item_id uuid NOT NULL,
  reorder_level numeric(20,6) NOT NULL CHECK (reorder_level >= 0),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 5 AND 500),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  updated_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT petro_inventory_reorder_rules_pk PRIMARY KEY (location_id,item_id),
  FOREIGN KEY (location_id,organization_id)
    REFERENCES public.petro_inventory_locations(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (item_id,organization_id)
    REFERENCES public.petro_catalog_items(id,organization_id) ON DELETE RESTRICT
);
CREATE INDEX petro_inventory_reorder_rules_org_idx
  ON public.petro_inventory_reorder_rules(organization_id,location_id);

CREATE TABLE public.petro_inventory_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  source_location_id uuid NOT NULL REFERENCES public.petro_inventory_locations(id) ON DELETE RESTRICT,
  target_location_id uuid REFERENCES public.petro_inventory_locations(id) ON DELETE RESTRICT,
  document_type text NOT NULL CHECK (document_type IN ('opening','receipt','issue','return','damage','transfer','count','adjustment')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 5 AND 500),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,120}$'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{32}$'),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  review_reason text,
  UNIQUE (organization_id, idempotency_key),
  CHECK (
    (document_type IN ('transfer','damage','return') AND target_location_id IS NOT NULL)
    OR (document_type NOT IN ('transfer','damage','return') AND target_location_id IS NULL)
  ),
  CHECK (target_location_id IS NULL OR target_location_id <> source_location_id)
);
CREATE INDEX petro_inventory_documents_queue_idx
  ON public.petro_inventory_documents(organization_id, status, created_at DESC);
CREATE INDEX petro_inventory_documents_location_idx
  ON public.petro_inventory_documents(source_location_id, created_at DESC);

CREATE TABLE public.petro_inventory_document_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.petro_inventory_documents(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL,
  item_id uuid NOT NULL,
  quantity numeric(20,6) NOT NULL,
  expected_quantity numeric(20,6),
  expected_version bigint,
  related_movement_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, item_id),
  FOREIGN KEY (item_id, organization_id)
    REFERENCES public.petro_catalog_items(id, organization_id) ON DELETE RESTRICT
);
CREATE INDEX petro_inventory_document_lines_item_idx
  ON public.petro_inventory_document_lines(organization_id, item_id, document_id);
CREATE INDEX petro_inventory_document_lines_related_movement_idx
  ON public.petro_inventory_document_lines(related_movement_id,document_id)
  WHERE related_movement_id IS NOT NULL;

CREATE TABLE public.petro_inventory_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES public.petro_inventory_locations(id) ON DELETE RESTRICT,
  item_id uuid NOT NULL REFERENCES public.petro_catalog_items(id) ON DELETE RESTRICT,
  source_reference uuid NOT NULL,
  quantity numeric(20,6) NOT NULL CHECK (quantity > 0),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','released','consumed')),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,120}$'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{32}$'),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  completed_at timestamptz,
  UNIQUE (organization_id, idempotency_key)
);
CREATE INDEX petro_inventory_reservations_active_idx
  ON public.petro_inventory_reservations(location_id, item_id, created_at)
  WHERE status='reserved';

CREATE TABLE public.petro_inventory_movements (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES public.petro_inventory_locations(id) ON DELETE RESTRICT,
  item_id uuid NOT NULL REFERENCES public.petro_catalog_items(id) ON DELETE RESTRICT,
  document_id uuid REFERENCES public.petro_inventory_documents(id) ON DELETE RESTRICT,
  reservation_id uuid REFERENCES public.petro_inventory_reservations(id) ON DELETE RESTRICT,
  movement_kind text NOT NULL CHECK (movement_kind IN (
     'opening','receipt','issue','return','damage_out','damage_in','transfer_out','transfer_in',
    'count_adjustment','adjustment','reserve','release','consume'
  )),
  on_hand_delta numeric(20,6) NOT NULL DEFAULT 0,
  reserved_delta numeric(20,6) NOT NULL DEFAULT 0,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 5 AND 500),
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (on_hand_delta <> 0 OR reserved_delta <> 0),
  CHECK ((document_id IS NOT NULL) <> (reservation_id IS NOT NULL))
);
ALTER TABLE public.petro_inventory_document_lines
  ADD CONSTRAINT petro_inventory_document_lines_related_movement_fk
  FOREIGN KEY (related_movement_id) REFERENCES public.petro_inventory_movements(id) ON DELETE RESTRICT;
CREATE INDEX petro_inventory_movements_item_time_idx
  ON public.petro_inventory_movements(organization_id, item_id, occurred_at DESC, id DESC);
CREATE INDEX petro_inventory_movements_location_time_idx
  ON public.petro_inventory_movements(location_id, occurred_at DESC, id DESC);
CREATE UNIQUE INDEX petro_inventory_movement_document_once
  ON public.petro_inventory_movements(document_id, item_id, location_id, movement_kind)
  WHERE document_id IS NOT NULL;
CREATE UNIQUE INDEX petro_inventory_movement_reservation_once
  ON public.petro_inventory_movements(reservation_id, location_id, movement_kind)
  WHERE reservation_id IS NOT NULL;

CREATE TABLE public.petro_inventory_commands (
  organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,120}$'),
  command_name text NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{32}$'),
  result jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, idempotency_key)
);

CREATE FUNCTION petro_private.inventory_can_read(p_organization_id uuid, p_branch_id uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$
  SELECT petro_private.user_active()
    AND (
      petro_private.catalog_is_admin(false)
      OR EXISTS (
        SELECT 1 FROM public.petro_memberships m
        WHERE m.user_id=auth.uid() AND m.organization_id=p_organization_id AND m.active
          AND (m.scope='organization'
            OR (p_branch_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM public.petro_membership_branches mb
              WHERE mb.membership_id=m.id AND mb.organization_id=m.organization_id
                AND mb.branch_id=p_branch_id
            )))
      )
    )
$$;

CREATE FUNCTION petro_private.inventory_can_write(
  p_organization_id uuid, p_branch_id uuid, p_approval boolean DEFAULT false
)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$
  SELECT petro_private.user_active()
    AND (
      petro_private.platform_has(ARRAY['owner','operations']::text[])
      OR EXISTS (
        SELECT 1 FROM public.petro_memberships m
        WHERE m.user_id=auth.uid() AND m.organization_id=p_organization_id AND m.active
          AND m.role IN ('organization_owner','manager')
          AND (m.scope='organization'
            OR (p_branch_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM public.petro_membership_branches mb
              WHERE mb.membership_id=m.id AND mb.organization_id=m.organization_id
                AND mb.branch_id=p_branch_id
            )))
      )
      OR (NOT p_approval AND EXISTS (
        SELECT 1 FROM public.petro_memberships m
        JOIN public.petro_membership_branches mb
          ON mb.membership_id=m.id AND mb.organization_id=m.organization_id
        WHERE m.user_id=auth.uid() AND m.organization_id=p_organization_id
          AND m.active AND m.role='worker' AND m.scope='branches'
          AND mb.branch_id=p_branch_id
      ))
    )
$$;

CREATE FUNCTION petro_private.inventory_validate_item(
  p_organization_id uuid, p_item_id uuid, p_quantity numeric, p_allow_zero boolean DEFAULT false
)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.petro_catalog_items i
    JOIN public.petro_catalog_categories c ON c.id=i.category_id
    JOIN public.petro_catalog_units u ON u.code=i.unit_code
    WHERE i.id=p_item_id AND i.organization_id=p_organization_id
      AND i.item_kind='product' AND i.display_status='active'
      AND i.review_status='approved' AND NOT i.central_suspended
      AND c.active AND c.domain_kind='catalog' AND c.service_group<>'fuel'
      AND (p_allow_zero OR p_quantity<>0)
      AND p_quantity IS NOT NULL
      AND abs(p_quantity) < 1000000000000
      AND round(p_quantity,u.quantity_scale)=p_quantity
  )
$$;

CREATE FUNCTION petro_private.inventory_apply_delta(
  p_organization_id uuid, p_location_id uuid, p_item_id uuid,
  p_on_hand_delta numeric, p_reserved_delta numeric, p_document_id uuid,
  p_reservation_id uuid, p_movement_kind text, p_reason text
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE balance_row public.petro_inventory_balances%ROWTYPE; new_on_hand numeric; new_reserved numeric;
BEGIN
  INSERT INTO public.petro_inventory_balances(organization_id,location_id,item_id)
  VALUES (p_organization_id,p_location_id,p_item_id)
  ON CONFLICT (location_id,item_id) DO NOTHING;
  SELECT * INTO balance_row FROM public.petro_inventory_balances
  WHERE location_id=p_location_id AND item_id=p_item_id FOR UPDATE;
  new_on_hand := balance_row.on_hand + p_on_hand_delta;
  new_reserved := balance_row.reserved + p_reserved_delta;
  IF new_on_hand < 0 OR new_reserved < 0 OR new_reserved > new_on_hand THEN
    RAISE EXCEPTION 'INVENTORY_AVAILABLE_CONFLICT' USING ERRCODE='23514';
  END IF;
  UPDATE public.petro_inventory_balances
  SET on_hand=new_on_hand, reserved=new_reserved, version=version+1, updated_at=now()
  WHERE location_id=p_location_id AND item_id=p_item_id;
  INSERT INTO public.petro_inventory_movements(
    organization_id,location_id,item_id,document_id,reservation_id,movement_kind,
    on_hand_delta,reserved_delta,reason,actor_id
  ) VALUES (
    p_organization_id,p_location_id,p_item_id,p_document_id,p_reservation_id,p_movement_kind,
    p_on_hand_delta,p_reserved_delta,btrim(p_reason),auth.uid()
  );
END
$$;

CREATE FUNCTION public.petro_inventory_admin_query(p_action text, p_payload jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
<<inventory_query>>
DECLARE org_id uuid; location_id uuid; document_id uuid; page_num integer; page_size integer;
        search_text text; result jsonb; sort_by text; sort_direction text; status_filter text;
BEGIN
  sort_by:=coalesce(nullif(p_payload->>'sortBy',''),'name');
  sort_direction:=CASE WHEN p_payload->>'sortDirection'='asc' THEN 'asc' ELSE 'desc' END;
  status_filter:=nullif(p_payload->>'status','');
  IF p_action='organizations' THEN
    IF NOT petro_private.user_active() OR NOT petro_private.catalog_is_admin(false) THEN
      RAISE EXCEPTION 'not authorized' USING ERRCODE='42501';
    END IF;
    page_num:=greatest(1,least(coalesce((p_payload->>'page')::integer,1),100000));
    page_size:=greatest(1,least(coalesce((p_payload->>'pageSize')::integer,20),100));
    SELECT jsonb_build_object(
      'items',coalesce(jsonb_agg(row_data ORDER BY row_data->>'name'),'[]'::jsonb),
      'page',page_num,'pageSize',page_size,
      'total',(SELECT count(*) FROM public.petro_organizations o
        WHERE o.kind IN ('station','provider')
          AND (nullif(btrim(p_payload->>'search'),'') IS NULL
            OR o.name ILIKE '%'||btrim(p_payload->>'search')||'%'
            OR coalesce(o.code,'') ILIKE '%'||btrim(p_payload->>'search')||'%'))
    ) INTO result
    FROM (
      SELECT jsonb_build_object(
        'id',o.id,'code',o.code,'name',o.name,'kind',o.kind,'status',o.status,
        'branchCount',(SELECT count(*) FROM public.petro_branches b WHERE b.organization_id=o.id),
        'locationCount',(SELECT count(*) FROM public.petro_inventory_locations l WHERE l.organization_id=o.id AND l.active),
        'trackedItemCount',(SELECT count(DISTINCT bal.item_id) FROM public.petro_inventory_balances bal WHERE bal.organization_id=o.id)
      ) AS row_data
      FROM public.petro_organizations o
      WHERE o.kind IN ('station','provider')
        AND (nullif(btrim(p_payload->>'search'),'') IS NULL
          OR o.name ILIKE '%'||btrim(p_payload->>'search')||'%'
          OR coalesce(o.code,'') ILIKE '%'||btrim(p_payload->>'search')||'%')
      ORDER BY o.name,o.id
      OFFSET (page_num-1)*page_size LIMIT page_size
    ) page_rows;
    RETURN coalesce(result,jsonb_build_object('items','[]'::jsonb,'page',page_num,'pageSize',page_size,'total',0));
  ELSIF p_action='locations' THEN
    org_id:=(p_payload->>'organizationId')::uuid;
    IF NOT petro_private.user_active() OR NOT (
      petro_private.catalog_is_admin(false)
      OR EXISTS (
        SELECT 1 FROM public.petro_memberships m
        WHERE m.user_id=auth.uid() AND m.organization_id=org_id AND m.active
      )
    ) THEN
      RAISE EXCEPTION 'not authorized' USING ERRCODE='42501';
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id',l.id,'organizationId',l.organization_id,'branchId',l.branch_id,
      'branchName',b.name,'branchCode',b.code,'name',l.name,'kind',l.location_kind,'active',l.active,
      'trackedItems',(SELECT count(*) FROM public.petro_inventory_balances x WHERE x.location_id=l.id),
      'availableItems',(SELECT count(*) FROM public.petro_inventory_balances x WHERE x.location_id=l.id AND x.on_hand>x.reserved)
    ) ORDER BY b.name,l.name),'[]'::jsonb)
    INTO result
    FROM public.petro_inventory_locations l
    JOIN public.petro_branches b ON b.id=l.branch_id AND b.organization_id=l.organization_id
    WHERE l.organization_id=org_id AND l.active AND petro_private.inventory_can_read(org_id,l.branch_id);
    RETURN jsonb_build_object('items',coalesce(result,'[]'::jsonb));
  ELSIF p_action='branches' THEN
    org_id:=(p_payload->>'organizationId')::uuid;
    IF NOT petro_private.user_active() OR NOT (
      petro_private.catalog_is_admin(false)
      OR EXISTS (
        SELECT 1 FROM public.petro_memberships m
        WHERE m.user_id=auth.uid() AND m.organization_id=org_id AND m.active
      )
    ) THEN RAISE EXCEPTION 'not authorized' USING ERRCODE='42501'; END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id',b.id,'organizationId',b.organization_id,'name',b.name,'code',b.code,'status',b.status
    ) ORDER BY b.name,b.id),'[]'::jsonb) INTO result
    FROM public.petro_branches b
    WHERE b.organization_id=org_id AND b.status='active'
      AND petro_private.inventory_can_read(org_id,b.id);
    RETURN jsonb_build_object('items',coalesce(result,'[]'::jsonb));
  ELSIF p_action='items' THEN
    org_id:=(p_payload->>'organizationId')::uuid;
    IF NOT petro_private.user_active() OR NOT (
      petro_private.catalog_is_admin(false)
      OR EXISTS (
        SELECT 1 FROM public.petro_memberships m
        WHERE m.user_id=auth.uid() AND m.organization_id=org_id AND m.active
      )
    ) THEN
      RAISE EXCEPTION 'not authorized' USING ERRCODE='42501';
    END IF;
    page_num:=greatest(1,least(coalesce((p_payload->>'page')::integer,1),100000));
    page_size:=greatest(1,least(coalesce((p_payload->>'pageSize')::integer,25),100));
    search_text:=nullif(btrim(p_payload->>'search'),'');
    SELECT jsonb_build_object(
      'items',coalesce(jsonb_agg(row_data ORDER BY row_data->>'name'),'[]'::jsonb),
      'page',page_num,'pageSize',page_size,
      'total',(SELECT count(*) FROM public.petro_catalog_items i
        JOIN public.petro_catalog_categories c ON c.id=i.category_id
        WHERE i.organization_id=org_id AND i.item_kind='product'
          AND i.display_status='active' AND i.review_status='approved' AND NOT i.central_suspended
          AND c.active AND c.domain_kind='catalog' AND c.service_group<>'fuel'
          AND (search_text IS NULL OR i.name ILIKE '%'||search_text||'%'
            OR coalesce(i.internal_code,'') ILIKE '%'||search_text||'%'))
    ) INTO result
    FROM (
      SELECT jsonb_build_object(
        'itemId',i.id,'name',i.name,'internalCode',i.internal_code,'unitCode',i.unit_code,
        'categoryCode',c.code,'categoryName',c.name_ar
      ) row_data
      FROM public.petro_catalog_items i
      JOIN public.petro_catalog_categories c ON c.id=i.category_id
      WHERE i.organization_id=org_id AND i.item_kind='product'
        AND i.display_status='active' AND i.review_status='approved' AND NOT i.central_suspended
        AND c.active AND c.domain_kind='catalog' AND c.service_group<>'fuel'
        AND (search_text IS NULL OR i.name ILIKE '%'||search_text||'%'
          OR coalesce(i.internal_code,'') ILIKE '%'||search_text||'%')
      ORDER BY i.name,i.id OFFSET (page_num-1)*page_size LIMIT page_size
    ) rows_page;
    RETURN coalesce(result,jsonb_build_object('items','[]'::jsonb,'page',page_num,'pageSize',page_size,'total',0));
  ELSIF p_action='balances' THEN
    location_id:=(p_payload->>'locationId')::uuid;
    SELECT l.organization_id INTO org_id FROM public.petro_inventory_locations l WHERE l.id=location_id AND l.active;
    IF org_id IS NULL OR NOT petro_private.inventory_can_read(org_id,
      (SELECT l.branch_id FROM public.petro_inventory_locations l WHERE l.id=location_id)) THEN
      RAISE EXCEPTION 'not authorized' USING ERRCODE='42501';
    END IF;
    page_num:=greatest(1,least(coalesce((p_payload->>'page')::integer,1),100000));
    page_size:=greatest(1,least(coalesce((p_payload->>'pageSize')::integer,25),100));
    search_text:=nullif(btrim(p_payload->>'search'),'');
    SELECT jsonb_build_object(
      'items',coalesce(jsonb_agg(row_data ORDER BY row_order),'[]'::jsonb),
      'page',page_num,'pageSize',page_size,
      'total',(SELECT count(*) FROM public.petro_inventory_balances b
        JOIN public.petro_catalog_items i ON i.id=b.item_id AND i.organization_id=b.organization_id
        WHERE b.location_id=inventory_query.location_id
          AND (search_text IS NULL OR i.name ILIKE '%'||search_text||'%'
            OR coalesce(i.internal_code,'') ILIKE '%'||search_text||'%'))
    ) INTO result
    FROM (
      SELECT jsonb_build_object(
        'itemId',i.id,'name',i.name,'internalCode',i.internal_code,'unitCode',i.unit_code,
        'categoryCode',c.code,'categoryName',c.name_ar,'onHand',b.on_hand::text,'reserved',b.reserved::text,
        'available',(b.on_hand-b.reserved)::text,'version',b.version,'updatedAt',b.updated_at,
        'reorderLevel',r.reorder_level::text,
        'reorderStatus',CASE WHEN r.item_id IS NULL THEN NULL
          WHEN b.on_hand-b.reserved<=0 THEN 'empty'
          WHEN b.on_hand-b.reserved<=r.reorder_level THEN 'low' ELSE 'normal' END
      ) row_data,
        row_number() OVER (ORDER BY
          CASE WHEN sort_by='name' AND sort_direction='asc' THEN i.name END ASC,
          CASE WHEN sort_by='name' AND sort_direction='desc' THEN i.name END DESC,
          CASE WHEN sort_by='available' AND sort_direction='asc' THEN b.on_hand-b.reserved END ASC,
          CASE WHEN sort_by='available' AND sort_direction='desc' THEN b.on_hand-b.reserved END DESC,
          CASE WHEN sort_by='updatedAt' AND sort_direction='asc' THEN b.updated_at END ASC,
          CASE WHEN sort_by='updatedAt' AND sort_direction='desc' THEN b.updated_at END DESC,
          i.name,i.id) AS row_order
      FROM public.petro_inventory_balances b
      JOIN public.petro_catalog_items i ON i.id=b.item_id AND i.organization_id=b.organization_id
      JOIN public.petro_catalog_categories c ON c.id=i.category_id
      LEFT JOIN public.petro_inventory_reorder_rules r
        ON r.location_id=b.location_id AND r.item_id=b.item_id
      WHERE b.location_id=inventory_query.location_id
        AND (search_text IS NULL OR i.name ILIKE '%'||search_text||'%'
          OR coalesce(i.internal_code,'') ILIKE '%'||search_text||'%')
      ORDER BY
        CASE WHEN sort_by='name' AND sort_direction='asc' THEN i.name END ASC,
        CASE WHEN sort_by='name' AND sort_direction='desc' THEN i.name END DESC,
        CASE WHEN sort_by='available' AND sort_direction='asc' THEN b.on_hand-b.reserved END ASC,
        CASE WHEN sort_by='available' AND sort_direction='desc' THEN b.on_hand-b.reserved END DESC,
        CASE WHEN sort_by='updatedAt' AND sort_direction='asc' THEN b.updated_at END ASC,
        CASE WHEN sort_by='updatedAt' AND sort_direction='desc' THEN b.updated_at END DESC,
        i.name,i.id OFFSET (page_num-1)*page_size LIMIT page_size
    ) rows_page;
    RETURN coalesce(result,jsonb_build_object('items','[]'::jsonb,'page',page_num,'pageSize',page_size,'total',0));
  ELSIF p_action IN ('summary','alerts','return_sources') THEN
    location_id:=(p_payload->>'locationId')::uuid;
    SELECT l.organization_id INTO org_id FROM public.petro_inventory_locations l WHERE l.id=location_id AND l.active;
    IF org_id IS NULL OR NOT petro_private.inventory_can_read(org_id,
      (SELECT l.branch_id FROM public.petro_inventory_locations l WHERE l.id=location_id)) THEN
      RAISE EXCEPTION 'not authorized' USING ERRCODE='42501';
    END IF;
    page_num:=greatest(1,least(coalesce((p_payload->>'page')::integer,1),100000));
    page_size:=greatest(1,least(coalesce((p_payload->>'pageSize')::integer,25),100));
    search_text:=nullif(btrim(p_payload->>'search'),'');
    IF p_action='summary' THEN
      SELECT jsonb_build_object(
        'locationId',l.id,'locationName',l.name,'branchName',b.name,
        'trackedItems',(SELECT count(*) FROM public.petro_inventory_balances x WHERE x.location_id=l.id),
        'reservedItems',(SELECT count(*) FROM public.petro_inventory_balances x WHERE x.location_id=l.id AND x.reserved>0),
        'pendingDocuments',(SELECT count(*) FROM public.petro_inventory_documents d
          WHERE d.status='pending' AND (d.source_location_id=l.id OR d.target_location_id=l.id)),
        'lowStockItems',(SELECT count(*) FROM public.petro_inventory_reorder_rules r
          JOIN public.petro_inventory_balances x ON x.location_id=r.location_id AND x.item_id=r.item_id
          WHERE r.location_id=l.id AND x.on_hand-x.reserved>0 AND x.on_hand-x.reserved<=r.reorder_level),
        'emptyStockItems',(SELECT count(*) FROM public.petro_inventory_reorder_rules r
          LEFT JOIN public.petro_inventory_balances x ON x.location_id=r.location_id AND x.item_id=r.item_id
          WHERE r.location_id=l.id AND coalesce(x.on_hand-x.reserved,0)<=0)
      ) INTO result
      FROM public.petro_inventory_locations l
      JOIN public.petro_branches b ON b.id=l.branch_id
      WHERE l.id=location_id;
      RETURN jsonb_build_object('items','[]'::jsonb,'summary',result);
    ELSIF p_action='alerts' THEN
      SELECT jsonb_build_object(
        'items',coalesce(jsonb_agg(row_data ORDER BY available_quantity ASC,item_name),'[]'::jsonb),
        'page',page_num,'pageSize',page_size,
        'total',(SELECT count(*) FROM public.petro_inventory_reorder_rules r
          JOIN public.petro_catalog_items i ON i.id=r.item_id
          LEFT JOIN public.petro_inventory_balances x ON x.location_id=r.location_id AND x.item_id=r.item_id
          WHERE r.location_id=inventory_query.location_id
            AND coalesce(x.on_hand-x.reserved,0)<=r.reorder_level
            AND (search_text IS NULL OR i.name ILIKE '%'||search_text||'%' OR coalesce(i.internal_code,'') ILIKE '%'||search_text||'%'))
      ) INTO result
      FROM (
        SELECT jsonb_build_object(
          'itemId',i.id,'name',i.name,'internalCode',i.internal_code,'unitCode',i.unit_code,
          'onHand',coalesce(x.on_hand,0)::text,'reserved',coalesce(x.reserved,0)::text,
          'available',coalesce(x.on_hand-x.reserved,0)::text,'reorderLevel',r.reorder_level::text,
          'status',CASE WHEN coalesce(x.on_hand-x.reserved,0)<=0 THEN 'empty' ELSE 'low' END,
          'reason',r.reason,'updatedAt',r.updated_at,'branchName',b.name
        ) row_data,coalesce(x.on_hand-x.reserved,0) available_quantity,i.name item_name
        FROM public.petro_inventory_reorder_rules r
        JOIN public.petro_catalog_items i ON i.id=r.item_id AND i.organization_id=r.organization_id
        JOIN public.petro_inventory_locations l ON l.id=r.location_id
        JOIN public.petro_branches b ON b.id=l.branch_id
        LEFT JOIN public.petro_inventory_balances x ON x.location_id=r.location_id AND x.item_id=r.item_id
        WHERE r.location_id=inventory_query.location_id
          AND coalesce(x.on_hand-x.reserved,0)<=r.reorder_level
          AND (search_text IS NULL OR i.name ILIKE '%'||search_text||'%' OR coalesce(i.internal_code,'') ILIKE '%'||search_text||'%')
        ORDER BY coalesce(x.on_hand-x.reserved,0),i.name
        OFFSET (page_num-1)*page_size LIMIT page_size
      ) rows_page;
      RETURN coalesce(result,jsonb_build_object('items','[]'::jsonb,'page',page_num,'pageSize',page_size,'total',0));
    ELSE
      SELECT jsonb_build_object(
        'items',coalesce(jsonb_agg(row_data ORDER BY occurred_at DESC),'[]'::jsonb),
        'page',page_num,'pageSize',page_size,
        'total',(SELECT count(*) FROM public.petro_inventory_movements m
          JOIN public.petro_catalog_items i ON i.id=m.item_id
          WHERE m.location_id=inventory_query.location_id AND m.movement_kind='issue' AND m.on_hand_delta<0
            AND -m.on_hand_delta>coalesce((
              SELECT sum(ln.quantity) FROM public.petro_inventory_document_lines ln
              JOIN public.petro_inventory_documents d ON d.id=ln.document_id
              WHERE ln.related_movement_id=m.id AND d.status IN ('pending','approved')
            ),0)
            AND (search_text IS NULL OR i.name ILIKE '%'||search_text||'%' OR m.reason ILIKE '%'||search_text||'%'))
      ) INTO result
      FROM (
        SELECT jsonb_build_object(
          'movementId',m.id,'itemId',i.id,'itemName',i.name,'unitCode',i.unit_code,
          'remainingQuantity',(-m.on_hand_delta-coalesce((
            SELECT sum(ln.quantity) FROM public.petro_inventory_document_lines ln
            JOIN public.petro_inventory_documents d ON d.id=ln.document_id
            WHERE ln.related_movement_id=m.id AND d.status IN ('pending','approved')
          ),0))::text,'occurredAt',m.occurred_at,'reason',m.reason
        ) row_data,m.occurred_at
        FROM public.petro_inventory_movements m
        JOIN public.petro_catalog_items i ON i.id=m.item_id
        WHERE m.location_id=inventory_query.location_id AND m.movement_kind='issue' AND m.on_hand_delta<0
          AND -m.on_hand_delta>coalesce((
            SELECT sum(ln.quantity) FROM public.petro_inventory_document_lines ln
            JOIN public.petro_inventory_documents d ON d.id=ln.document_id
            WHERE ln.related_movement_id=m.id AND d.status IN ('pending','approved')
          ),0)
          AND (search_text IS NULL OR i.name ILIKE '%'||search_text||'%' OR m.reason ILIKE '%'||search_text||'%')
        ORDER BY m.occurred_at DESC,m.id DESC
        OFFSET (page_num-1)*page_size LIMIT page_size
      ) rows_page;
      RETURN coalesce(result,jsonb_build_object('items','[]'::jsonb,'page',page_num,'pageSize',page_size,'total',0));
    END IF;
  ELSIF p_action IN ('documents','movements','transfers','counts') THEN
    location_id:=(p_payload->>'locationId')::uuid;
    SELECT l.organization_id INTO org_id FROM public.petro_inventory_locations l WHERE l.id=location_id;
    IF org_id IS NULL OR NOT petro_private.inventory_can_read(org_id,
      (SELECT branch_id FROM public.petro_inventory_locations WHERE id=location_id)) THEN
      RAISE EXCEPTION 'not authorized' USING ERRCODE='42501';
    END IF;
    page_num:=greatest(1,least(coalesce((p_payload->>'page')::integer,1),100000));
    page_size:=greatest(1,least(coalesce((p_payload->>'pageSize')::integer,25),100));
    search_text:=nullif(btrim(p_payload->>'search'),'');
    IF p_action IN ('documents','transfers','counts') THEN
      SELECT jsonb_build_object(
        'items',coalesce(jsonb_agg(row_data ORDER BY row_order),'[]'::jsonb),
        'page',page_num,'pageSize',page_size,
        'total',(SELECT count(*) FROM public.petro_inventory_documents d
          WHERE (d.source_location_id=location_id OR d.target_location_id=location_id)
            AND (status_filter IS NULL OR d.status=status_filter)
            AND (p_action NOT IN ('transfers','counts')
              OR (p_action='transfers' AND d.document_type='transfer')
              OR (p_action='counts' AND d.document_type='count'))
            AND (search_text IS NULL OR d.reason ILIKE '%'||search_text||'%'
              OR d.document_type ILIKE '%'||search_text||'%' OR d.status ILIKE '%'||search_text||'%'))
      ) INTO result
      FROM (
        SELECT jsonb_build_object('id',d.id,'organizationId',d.organization_id,
          'sourceLocationId',d.source_location_id,'targetLocationId',d.target_location_id,
          'sourceLocationName',(SELECT l.name FROM public.petro_inventory_locations l WHERE l.id=d.source_location_id),
          'targetLocationName',(SELECT l.name FROM public.petro_inventory_locations l WHERE l.id=d.target_location_id),
          'type',d.document_type,'status',d.status,'reason',d.reason,
           'createdAt',d.created_at,'createdByName',(SELECT nullif(p.display_name,'') FROM public.petro_profiles p WHERE p.user_id=d.created_by),
           'reviewedAt',d.reviewed_at,'reviewedByName',(SELECT nullif(p.display_name,'') FROM public.petro_profiles p WHERE p.user_id=d.reviewed_by),
            'lineCount',(SELECT count(*) FROM public.petro_inventory_document_lines x WHERE x.document_id=d.id)
         ) row_data,
         row_number() OVER (ORDER BY
           CASE WHEN sort_by='createdAt' AND sort_direction='asc' THEN d.created_at END ASC,
           CASE WHEN sort_by='createdAt' AND sort_direction='desc' THEN d.created_at END DESC,
           CASE WHEN sort_by='status' AND sort_direction='asc' THEN d.status END ASC,
           CASE WHEN sort_by='status' AND sort_direction='desc' THEN d.status END DESC,
           CASE WHEN sort_by='type' AND sort_direction='asc' THEN d.document_type END ASC,
           CASE WHEN sort_by='type' AND sort_direction='desc' THEN d.document_type END DESC,
           d.created_at DESC,d.id DESC) AS row_order
        FROM public.petro_inventory_documents d
        WHERE (d.source_location_id=location_id OR d.target_location_id=location_id)
          AND (status_filter IS NULL OR d.status=status_filter)
          AND (p_action NOT IN ('transfers','counts')
            OR (p_action='transfers' AND d.document_type='transfer')
            OR (p_action='counts' AND d.document_type='count'))
          AND (search_text IS NULL OR d.reason ILIKE '%'||search_text||'%'
            OR d.document_type ILIKE '%'||search_text||'%' OR d.status ILIKE '%'||search_text||'%')
        ORDER BY
          CASE WHEN sort_by='createdAt' AND sort_direction='asc' THEN d.created_at END ASC,
          CASE WHEN sort_by='createdAt' AND sort_direction='desc' THEN d.created_at END DESC,
          CASE WHEN sort_by='status' AND sort_direction='asc' THEN d.status END ASC,
          CASE WHEN sort_by='status' AND sort_direction='desc' THEN d.status END DESC,
          CASE WHEN sort_by='type' AND sort_direction='asc' THEN d.document_type END ASC,
          CASE WHEN sort_by='type' AND sort_direction='desc' THEN d.document_type END DESC,
          d.created_at DESC,d.id DESC
        OFFSET (page_num-1)*page_size LIMIT page_size
      ) rows_page;
      RETURN coalesce(result,jsonb_build_object('items','[]'::jsonb,'page',page_num,'pageSize',page_size,'total',0));
    END IF;
    SELECT jsonb_build_object(
      'items',coalesce(jsonb_agg(row_data ORDER BY row_order),'[]'::jsonb),
      'page',page_num,'pageSize',page_size,
      'total',(SELECT count(*) FROM public.petro_inventory_movements m
        JOIN public.petro_catalog_items i ON i.id=m.item_id
        WHERE m.location_id=inventory_query.location_id
          AND (search_text IS NULL OR i.name ILIKE '%'||search_text||'%'
            OR m.reason ILIKE '%'||search_text||'%' OR m.movement_kind ILIKE '%'||search_text||'%'))
    ) INTO result
    FROM (
      SELECT jsonb_build_object('id',m.id,'itemId',m.item_id,'itemName',i.name,
        'internalCode',i.internal_code,
        'unitCode',i.unit_code,'kind',m.movement_kind,'onHandDelta',m.on_hand_delta::text,
        'reservedDelta',m.reserved_delta::text,'reason',m.reason,
        'actorName',coalesce(nullif(profile.display_name,''),'مسؤول مخزون'),
        'locationName',l.name,'branchName',b.name,
        'occurredAt',m.occurred_at,'documentId',m.document_id,'reservationId',m.reservation_id
      ) row_data,
      row_number() OVER (ORDER BY
        CASE WHEN sort_by='occurredAt' AND sort_direction='asc' THEN m.occurred_at END ASC,
        CASE WHEN sort_by='occurredAt' AND sort_direction='desc' THEN m.occurred_at END DESC,
        CASE WHEN sort_by='itemName' AND sort_direction='asc' THEN i.name END ASC,
        CASE WHEN sort_by='itemName' AND sort_direction='desc' THEN i.name END DESC,
        CASE WHEN sort_by='kind' AND sort_direction='asc' THEN m.movement_kind END ASC,
        CASE WHEN sort_by='kind' AND sort_direction='desc' THEN m.movement_kind END DESC,
        m.occurred_at DESC,m.id DESC) AS row_order
      FROM public.petro_inventory_movements m
      JOIN public.petro_catalog_items i ON i.id=m.item_id
      JOIN public.petro_inventory_locations l ON l.id=m.location_id
      JOIN public.petro_branches b ON b.id=l.branch_id
      LEFT JOIN public.petro_profiles profile ON profile.user_id=m.actor_id
      WHERE m.location_id=inventory_query.location_id
        AND (search_text IS NULL OR i.name ILIKE '%'||search_text||'%'
          OR m.reason ILIKE '%'||search_text||'%' OR m.movement_kind ILIKE '%'||search_text||'%')
      ORDER BY
        CASE WHEN sort_by='occurredAt' AND sort_direction='asc' THEN m.occurred_at END ASC,
        CASE WHEN sort_by='occurredAt' AND sort_direction='desc' THEN m.occurred_at END DESC,
        CASE WHEN sort_by='itemName' AND sort_direction='asc' THEN i.name END ASC,
        CASE WHEN sort_by='itemName' AND sort_direction='desc' THEN i.name END DESC,
        CASE WHEN sort_by='kind' AND sort_direction='asc' THEN m.movement_kind END ASC,
        CASE WHEN sort_by='kind' AND sort_direction='desc' THEN m.movement_kind END DESC,
        m.occurred_at DESC,m.id DESC
      OFFSET (page_num-1)*page_size LIMIT page_size
    ) rows_page;
    RETURN coalesce(result,jsonb_build_object('items','[]'::jsonb,'page',page_num,'pageSize',page_size,'total',0));
  ELSIF p_action='document' THEN
    document_id:=(p_payload->>'documentId')::uuid;
    SELECT d.organization_id INTO org_id FROM public.petro_inventory_documents d WHERE d.id=document_id;
    IF org_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.petro_inventory_documents d
      JOIN public.petro_inventory_locations l ON l.id=d.source_location_id
      WHERE d.id=document_id AND petro_private.inventory_can_read(org_id,l.branch_id)
    ) THEN RAISE EXCEPTION 'not authorized' USING ERRCODE='42501'; END IF;
    SELECT jsonb_build_object(
      'document',jsonb_build_object(
        'id',d.id,'organizationId',d.organization_id,'sourceLocationId',d.source_location_id,
        'targetLocationId',d.target_location_id,
        'sourceLocationName',(SELECT l.name FROM public.petro_inventory_locations l WHERE l.id=d.source_location_id),
        'targetLocationName',(SELECT l.name FROM public.petro_inventory_locations l WHERE l.id=d.target_location_id),
        'type',d.document_type,'status',d.status,
        'reason',d.reason,'createdBy',d.created_by,'createdAt',d.created_at,
        'createdByName',(SELECT nullif(p.display_name,'') FROM public.petro_profiles p WHERE p.user_id=d.created_by),
        'reviewedBy',d.reviewed_by,'reviewedAt',d.reviewed_at,'reviewReason',d.review_reason,
        'reviewedByName',(SELECT nullif(p.display_name,'') FROM public.petro_profiles p WHERE p.user_id=d.reviewed_by)
      ),
      'lines',coalesce((SELECT jsonb_agg(jsonb_build_object(
        'itemId',i.id,'itemName',i.name,'internalCode',i.internal_code,'unitCode',i.unit_code,'quantity',ln.quantity::text,
        'snapshotQuantity',ln.expected_quantity::text,'snapshotVersion',ln.expected_version,
        'originalIssueAt',(SELECT m.occurred_at FROM public.petro_inventory_movements m WHERE m.id=ln.related_movement_id),
        'originalIssueReason',(SELECT m.reason FROM public.petro_inventory_movements m WHERE m.id=ln.related_movement_id)
      ) ORDER BY i.name) FROM public.petro_inventory_document_lines ln
        JOIN public.petro_catalog_items i ON i.id=ln.item_id WHERE ln.document_id=d.id),'[]'::jsonb)
    ) INTO result FROM public.petro_inventory_documents d WHERE d.id=document_id;
    RETURN result;
  ELSIF p_action='reconciliation' THEN
    IF NOT petro_private.user_active() OR NOT petro_private.catalog_is_admin(false) THEN
      RAISE EXCEPTION 'not authorized' USING ERRCODE='42501';
    END IF;
    org_id:=nullif(p_payload->>'organizationId','')::uuid;
    location_id:=nullif(p_payload->>'locationId','')::uuid;
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'locationId',b.location_id,'organizationId',b.organization_id,'itemId',b.item_id,
      'itemName',i.name,'internalCode',i.internal_code,'locationName',l.name,
      'onHand',b.on_hand::text,'ledgerOnHand',coalesce(m.on_hand_total,0)::text,
      'reserved',b.reserved::text,'ledgerReserved',coalesce(m.reserved_total,0)::text,
      'matches',b.on_hand=coalesce(m.on_hand_total,0) AND b.reserved=coalesce(m.reserved_total,0)
    ) ORDER BY b.organization_id,b.location_id,b.item_id),'[]'::jsonb)
    INTO result
    FROM public.petro_inventory_balances b
    JOIN public.petro_catalog_items i ON i.id=b.item_id AND i.organization_id=b.organization_id
    JOIN public.petro_inventory_locations l ON l.id=b.location_id
    LEFT JOIN (
      SELECT movement.location_id,movement.item_id,
        sum(movement.on_hand_delta) on_hand_total,sum(movement.reserved_delta) reserved_total
      FROM public.petro_inventory_movements movement
      GROUP BY movement.location_id,movement.item_id
    ) m ON m.location_id=b.location_id AND m.item_id=b.item_id
     WHERE (org_id IS NULL OR b.organization_id=org_id)
       AND (inventory_query.location_id IS NULL OR b.location_id=inventory_query.location_id)
       AND (b.on_hand<>coalesce(m.on_hand_total,0) OR b.reserved<>coalesce(m.reserved_total,0));
    RETURN jsonb_build_object('items',coalesce(result,'[]'::jsonb),'consistent',jsonb_array_length(coalesce(result,'[]'::jsonb))=0);
  END IF;
  RAISE EXCEPTION 'invalid inventory query' USING ERRCODE='22023';
END;
$$;

CREATE FUNCTION public.petro_inventory_admin_command(
  p_action text, p_payload jsonb, p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
<<inventory_command>>
DECLARE org_id uuid; location_id uuid; target_location_id uuid; document_id uuid;
        reservation_id uuid; branch_id uuid; target_branch_id uuid; source_reference uuid;
        source_movement_id bigint; remaining_quantity numeric; expected_quantity numeric;
        expected_version bigint; source_movement public.petro_inventory_movements%ROWTYPE;
        item_id uuid; item_row public.petro_catalog_items%ROWTYPE;
        doc public.petro_inventory_documents%ROWTYPE; line record; balance_row public.petro_inventory_balances%ROWTYPE;
        quantity numeric; delta numeric; request_hash text; prior public.petro_inventory_commands%ROWTYPE;
        response_json jsonb; decision text; doc_type text; line_count integer; actor uuid:=auth.uid();
BEGIN
  IF actor IS NULL OR NOT petro_private.user_active()
     OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object'
     OR p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,120}$' THEN
    RAISE EXCEPTION 'invalid inventory command' USING ERRCODE='22023';
  END IF;

  IF p_action='location.create' THEN
    org_id:=(p_payload->>'organizationId')::uuid;
    branch_id:=(p_payload->>'branchId')::uuid;
  ELSIF p_action='reorder.set' THEN
    org_id:=(p_payload->>'organizationId')::uuid;
    location_id:=(p_payload->>'locationId')::uuid;
    SELECT l.branch_id INTO branch_id FROM public.petro_inventory_locations l
    WHERE l.id=location_id AND l.organization_id=org_id;
  ELSIF p_action='document.create' THEN
    org_id:=(p_payload->>'organizationId')::uuid;
    location_id:=(p_payload->>'sourceLocationId')::uuid;
    SELECT l.branch_id INTO branch_id FROM public.petro_inventory_locations l WHERE l.id=location_id AND l.organization_id=org_id;
  ELSIF p_action='document.review' THEN
    document_id:=(p_payload->>'documentId')::uuid;
    SELECT * INTO doc FROM public.petro_inventory_documents WHERE id=document_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'inventory document not found' USING ERRCODE='P0002'; END IF;
    org_id:=doc.organization_id;
    SELECT l.branch_id INTO branch_id FROM public.petro_inventory_locations l WHERE l.id=doc.source_location_id;
  ELSIF p_action IN ('reservation.reserve','reservation.release','reservation.consume') THEN
    org_id:=(p_payload->>'organizationId')::uuid;
    IF p_action='reservation.reserve' THEN
      location_id:=(p_payload->>'locationId')::uuid;
    ELSE
      reservation_id:=(p_payload->>'reservationId')::uuid;
      SELECT * INTO STRICT line FROM public.petro_inventory_reservations WHERE id=reservation_id FOR UPDATE;
      org_id:=line.organization_id;
      location_id:=line.location_id;
    END IF;
    SELECT l.branch_id INTO branch_id FROM public.petro_inventory_locations l WHERE l.id=location_id AND l.organization_id=org_id;
  ELSE
    RAISE EXCEPTION 'invalid inventory command' USING ERRCODE='22023';
  END IF;
  IF org_id IS NULL OR branch_id IS NULL THEN RAISE EXCEPTION 'inventory scope not found' USING ERRCODE='P0002'; END IF;
  IF NOT petro_private.inventory_can_write(org_id,branch_id,p_action IN ('document.review','reorder.set')) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE='42501';
  END IF;
  IF p_action='document.review' AND doc.target_location_id IS NOT NULL THEN
    SELECT l.branch_id INTO target_branch_id
    FROM public.petro_inventory_locations l WHERE l.id=doc.target_location_id;
    IF NOT petro_private.inventory_can_write(org_id,target_branch_id,true) THEN
      RAISE EXCEPTION 'not authorized for target stock location' USING ERRCODE='42501';
    END IF;
  END IF;

  request_hash:=md5(jsonb_build_object('action',p_action,'payload',p_payload)::text);
  INSERT INTO public.petro_inventory_commands(organization_id,idempotency_key,command_name,payload_hash)
  VALUES(org_id,p_idempotency_key,p_action,request_hash) ON CONFLICT DO NOTHING;
  SELECT * INTO prior FROM public.petro_inventory_commands
  WHERE organization_id=org_id AND idempotency_key=p_idempotency_key FOR UPDATE;
  IF prior.command_name<>p_action OR prior.payload_hash<>request_hash THEN
    RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT' USING ERRCODE='23505';
  END IF;
  IF prior.completed_at IS NOT NULL THEN RETURN prior.result; END IF;

  IF p_action='reorder.set' THEN
    IF length(btrim(coalesce(p_payload->>'reason',''))) NOT BETWEEN 5 AND 500
      OR NOT EXISTS (
        SELECT 1 FROM public.petro_organizations o
        JOIN public.petro_inventory_locations l ON l.organization_id=o.id
        JOIN public.petro_catalog_items i ON i.organization_id=o.id
        WHERE o.id=org_id AND o.kind IN ('station','provider') AND o.status='active'
          AND l.id=location_id AND l.branch_id=inventory_command.branch_id AND l.active
          AND i.id=(p_payload->>'itemId')::uuid
      ) THEN
      RAISE EXCEPTION 'invalid inventory reorder rule' USING ERRCODE='22023';
    END IF;
    item_id:=(p_payload->>'itemId')::uuid;
    quantity:=(p_payload->>'reorderLevel')::numeric;
    IF quantity<0 OR NOT petro_private.inventory_validate_item(org_id,item_id,quantity,true) THEN
      RAISE EXCEPTION 'invalid inventory reorder level' USING ERRCODE='22023';
    END IF;
    INSERT INTO public.petro_inventory_reorder_rules(
      organization_id,location_id,item_id,reorder_level,reason,created_by,updated_by
    ) VALUES (org_id,location_id,item_id,quantity,btrim(p_payload->>'reason'),actor,actor)
    ON CONFLICT ON CONSTRAINT petro_inventory_reorder_rules_pk DO UPDATE
      SET reorder_level=EXCLUDED.reorder_level,reason=EXCLUDED.reason,
          updated_by=EXCLUDED.updated_by,updated_at=now();
    INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
    VALUES(actor,org_id,'inventory.reorder_rule_set',item_id,
      jsonb_build_object('locationId',location_id,'reorderLevel',quantity::text,'reason',btrim(p_payload->>'reason')));
    response_json:=jsonb_build_object('id',item_id,'status','saved');
  ELSIF p_action='location.create' THEN
    IF NOT petro_private.inventory_can_write(org_id,branch_id,true) THEN
      RAISE EXCEPTION 'not authorized' USING ERRCODE='42501';
    END IF;
    IF p_payload->>'kind' IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.petro_organizations o JOIN public.petro_branches b
        ON b.organization_id=o.id
      WHERE o.id=org_id AND o.kind IN ('station','provider') AND o.status='active'
        AND b.id=branch_id AND b.status='active'
    ) OR p_payload->>'kind' NOT IN ('sellable','quarantine','damaged','transit')
      OR length(btrim(coalesce(p_payload->>'name',''))) NOT BETWEEN 2 AND 120
      OR length(btrim(coalesce(p_payload->>'reason',''))) NOT BETWEEN 5 AND 500 THEN
      RAISE EXCEPTION 'invalid inventory location' USING ERRCODE='22023';
    END IF;
    INSERT INTO public.petro_inventory_locations(organization_id,branch_id,name,location_kind,created_by)
    VALUES(org_id,branch_id,btrim(p_payload->>'name'),p_payload->>'kind',actor)
    RETURNING id INTO location_id;
    INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
    VALUES(actor,org_id,'inventory.location_created',location_id,
      jsonb_build_object('branchId',branch_id,'kind',p_payload->>'kind','reason',btrim(p_payload->>'reason')));
    response_json:=jsonb_build_object('id',location_id,'status','active');

  ELSIF p_action='document.create' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.petro_organizations o
      WHERE o.id=org_id AND o.kind IN ('station','provider') AND o.status='active'
    ) THEN RAISE EXCEPTION 'merchant organization is not active' USING ERRCODE='23514'; END IF;
    SELECT l.* INTO STRICT line FROM public.petro_inventory_locations l
    WHERE l.id=location_id AND l.organization_id=org_id AND l.active FOR UPDATE;
    doc_type:=p_payload->>'type';
    target_location_id:=nullif(p_payload->>'targetLocationId','')::uuid;
    IF doc_type IS NULL OR doc_type NOT IN ('opening','receipt','issue','return','damage','transfer','count','adjustment')
      OR length(btrim(coalesce(p_payload->>'reason',''))) NOT BETWEEN 5 AND 500
      OR jsonb_typeof(p_payload->'lines')<>'array'
      OR jsonb_array_length(p_payload->'lines') NOT BETWEEN 1 AND 100
      OR ((doc_type IN ('damage','transfer','return')) IS DISTINCT FROM (target_location_id IS NOT NULL)) THEN
      RAISE EXCEPTION 'invalid inventory document' USING ERRCODE='22023';
    END IF;
    IF target_location_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.petro_inventory_locations t
      WHERE t.id=target_location_id AND t.organization_id=org_id AND t.active
        AND (doc_type<>'damage' OR t.location_kind='damaged')
        AND (doc_type<>'return' OR t.location_kind='quarantine')
    ) THEN RAISE EXCEPTION 'invalid inventory target' USING ERRCODE='23514'; END IF;
    IF target_location_id IS NOT NULL THEN
      SELECT t.branch_id INTO target_branch_id
      FROM public.petro_inventory_locations t WHERE t.id=target_location_id;
      IF NOT petro_private.inventory_can_write(org_id,target_branch_id,false) THEN
        RAISE EXCEPTION 'not authorized for target stock location' USING ERRCODE='42501';
      END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_payload->'lines') x
      WHERE (x->>'itemId') IS NULL OR (x->>'quantity') IS NULL)
      OR (SELECT count(*) FROM jsonb_array_elements(p_payload->'lines')) <>
         (SELECT count(DISTINCT x->>'itemId') FROM jsonb_array_elements(p_payload->'lines') x) THEN
      RAISE EXCEPTION 'invalid or duplicate inventory lines' USING ERRCODE='22023';
    END IF;
    IF doc_type='opening' AND EXISTS (
      SELECT 1 FROM public.petro_inventory_documents d
      JOIN public.petro_inventory_document_lines ln ON ln.document_id=d.id
      WHERE d.source_location_id=location_id AND d.document_type='opening'
        AND d.status IN ('pending','approved')
        AND ln.item_id IN (SELECT (x->>'itemId')::uuid FROM jsonb_array_elements(p_payload->'lines') x)
    ) THEN
      RAISE EXCEPTION 'opening balance already exists for this item and location' USING ERRCODE='23505';
    END IF;
    IF doc_type='opening' AND EXISTS (
      SELECT 1 FROM public.petro_inventory_movements m
      WHERE m.location_id=inventory_command.location_id
        AND m.item_id IN (SELECT (x->>'itemId')::uuid FROM jsonb_array_elements(p_payload->'lines') x)
    ) THEN
      RAISE EXCEPTION 'opening balance must precede all movements for these items' USING ERRCODE='23514';
    END IF;
    IF doc_type<>'opening' AND EXISTS (
      SELECT 1 FROM public.petro_inventory_documents d
      JOIN public.petro_inventory_document_lines ln ON ln.document_id=d.id
      WHERE d.source_location_id=location_id AND d.document_type='opening'
        AND d.status='pending'
        AND ln.item_id IN (SELECT (x->>'itemId')::uuid FROM jsonb_array_elements(p_payload->'lines') x)
    ) THEN
      RAISE EXCEPTION 'an opening balance for this item is waiting for review' USING ERRCODE='23514';
    END IF;
    INSERT INTO public.petro_inventory_documents(
      organization_id,source_location_id,target_location_id,document_type,reason,
      idempotency_key,payload_hash,created_by
    ) VALUES (
      org_id,location_id,target_location_id,doc_type,btrim(p_payload->>'reason'),
      p_idempotency_key,request_hash,actor
    ) RETURNING id INTO document_id;
    FOR line IN SELECT value FROM jsonb_array_elements(p_payload->'lines') LOOP
      item_id:=(line.value->>'itemId')::uuid;
      quantity:=(line.value->>'quantity')::numeric;
      source_movement_id:=nullif(line.value->>'sourceMovementId','')::bigint;
      IF NOT petro_private.inventory_validate_item(org_id,item_id,quantity,doc_type='count')
        OR (doc_type='count' AND quantity<0)
        OR (doc_type<>'count' AND quantity=0)
        OR (doc_type NOT IN ('adjustment') AND quantity<0) THEN
        RAISE EXCEPTION 'invalid inventory item quantity' USING ERRCODE='22023';
      END IF;
      IF (doc_type='return') IS DISTINCT FROM (source_movement_id IS NOT NULL) THEN
        RAISE EXCEPTION 'return requires an original issue movement' USING ERRCODE='22023';
      END IF;
      expected_quantity:=NULL;
      expected_version:=NULL;
      IF doc_type='count' THEN
        INSERT INTO public.petro_inventory_balances(organization_id,location_id,item_id)
        VALUES(org_id,location_id,item_id) ON CONFLICT DO NOTHING;
        SELECT b.on_hand,b.version INTO expected_quantity,expected_version
        FROM public.petro_inventory_balances b
        WHERE b.location_id=inventory_command.location_id AND b.item_id=inventory_command.item_id FOR UPDATE;
      END IF;
      IF doc_type='return' THEN
        SELECT * INTO source_movement FROM public.petro_inventory_movements m
        WHERE m.id=source_movement_id FOR UPDATE;
        IF NOT FOUND OR source_movement.organization_id<>org_id
          OR source_movement.location_id<>location_id OR source_movement.item_id<>item_id
          OR source_movement.movement_kind<>'issue' OR source_movement.on_hand_delta>=0 THEN
          RAISE EXCEPTION 'invalid original issue movement for return' USING ERRCODE='23514';
        END IF;
        SELECT -source_movement.on_hand_delta-coalesce(sum(ln.quantity),0)
          INTO remaining_quantity
        FROM public.petro_inventory_document_lines ln
        JOIN public.petro_inventory_documents d ON d.id=ln.document_id
        WHERE ln.related_movement_id=source_movement_id AND d.status IN ('pending','approved');
        IF quantity>coalesce(remaining_quantity,0) THEN
          RAISE EXCEPTION 'return quantity exceeds original issue' USING ERRCODE='23514';
        END IF;
      END IF;
      INSERT INTO public.petro_inventory_document_lines(
        document_id,organization_id,item_id,quantity,expected_quantity,expected_version,related_movement_id
      ) VALUES(document_id,org_id,item_id,quantity,expected_quantity,expected_version,source_movement_id);
    END LOOP;
    INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
    VALUES(actor,org_id,'inventory.document_created',document_id,
      jsonb_build_object('type',doc_type,'reason',btrim(p_payload->>'reason')));
    response_json:=jsonb_build_object('id',document_id,'status','pending','type',doc_type);

  ELSIF p_action='document.review' THEN
    decision:=p_payload->>'decision';
    IF doc.status<>'pending' OR decision IS NULL OR decision NOT IN ('approve','reject')
      OR length(btrim(coalesce(p_payload->>'reason',''))) NOT BETWEEN 5 AND 500 THEN
      RAISE EXCEPTION 'invalid inventory review' USING ERRCODE='55000';
    END IF;
    IF decision='approve' THEN
      FOR line IN
        SELECT ln.item_id,ln.quantity,ln.expected_quantity,ln.expected_version,ln.related_movement_id
        FROM public.petro_inventory_document_lines ln
        JOIN public.petro_catalog_items i ON i.id=ln.item_id AND i.organization_id=ln.organization_id
        WHERE ln.document_id=doc.id ORDER BY ln.item_id
      LOOP
        item_id:=line.item_id;
        quantity:=line.quantity;
        IF doc.document_type='count' THEN
          INSERT INTO public.petro_inventory_balances(organization_id,location_id,item_id)
          VALUES(org_id,doc.source_location_id,item_id) ON CONFLICT DO NOTHING;
          SELECT b.* INTO balance_row FROM public.petro_inventory_balances b
          WHERE b.location_id=doc.source_location_id AND b.item_id=line.item_id FOR UPDATE;
          IF balance_row.version<>line.expected_version OR balance_row.on_hand<>line.expected_quantity THEN
            RAISE EXCEPTION 'inventory changed after count snapshot; recount before approval' USING ERRCODE='40001';
          END IF;
          delta:=quantity-balance_row.on_hand;
          IF balance_row.reserved>quantity THEN
            RAISE EXCEPTION 'INVENTORY_COUNT_BELOW_RESERVED' USING ERRCODE='23514';
          END IF;
          IF delta<>0 THEN PERFORM petro_private.inventory_apply_delta(
            org_id,doc.source_location_id,item_id,delta,0,doc.id,NULL,'count_adjustment',btrim(p_payload->>'reason')
          ); END IF;
        ELSIF doc.document_type='opening' THEN
          INSERT INTO public.petro_inventory_balances(organization_id,location_id,item_id)
          VALUES(org_id,doc.source_location_id,item_id) ON CONFLICT DO NOTHING;
          SELECT b.* INTO balance_row FROM public.petro_inventory_balances b
          WHERE b.location_id=doc.source_location_id AND b.item_id=inventory_command.item_id FOR UPDATE;
          IF balance_row.version<>0 OR balance_row.on_hand<>0 OR balance_row.reserved<>0
            OR EXISTS (SELECT 1 FROM public.petro_inventory_movements m
              WHERE m.location_id=doc.source_location_id AND m.item_id=inventory_command.item_id) THEN
            RAISE EXCEPTION 'opening balance must be first movement for item and location' USING ERRCODE='23514';
          END IF;
          PERFORM petro_private.inventory_apply_delta(
            org_id,doc.source_location_id,item_id,quantity,0,doc.id,NULL,'opening',btrim(p_payload->>'reason')
          );
        ELSIF doc.document_type='receipt' THEN
          PERFORM petro_private.inventory_apply_delta(
            org_id,doc.source_location_id,item_id,quantity,0,doc.id,NULL,'receipt',btrim(p_payload->>'reason')
          );
        ELSIF doc.document_type='return' THEN
          SELECT * INTO source_movement FROM public.petro_inventory_movements m
          WHERE m.id=line.related_movement_id FOR UPDATE;
          IF NOT FOUND OR source_movement.organization_id<>org_id
            OR source_movement.location_id<>doc.source_location_id
            OR source_movement.item_id<>line.item_id OR source_movement.movement_kind<>'issue'
            OR source_movement.on_hand_delta>=0 THEN
            RAISE EXCEPTION 'original issue no longer qualifies for return' USING ERRCODE='23514';
          END IF;
          SELECT -source_movement.on_hand_delta-coalesce(sum(ln.quantity),0)
            INTO remaining_quantity
          FROM public.petro_inventory_document_lines ln
          JOIN public.petro_inventory_documents d ON d.id=ln.document_id
          WHERE ln.related_movement_id=line.related_movement_id
            AND d.status IN ('pending','approved') AND d.id<>doc.id;
          IF quantity>coalesce(remaining_quantity,0) THEN
            RAISE EXCEPTION 'return quantity exceeds unreturned original issue' USING ERRCODE='23514';
          END IF;
          PERFORM petro_private.inventory_apply_delta(
            org_id,doc.target_location_id,item_id,quantity,0,doc.id,NULL,'return',btrim(p_payload->>'reason')
          );
        ELSIF doc.document_type='issue' THEN
          PERFORM petro_private.inventory_apply_delta(
            org_id,doc.source_location_id,item_id,-quantity,0,doc.id,NULL,'issue',btrim(p_payload->>'reason')
          );
        ELSIF doc.document_type='adjustment' THEN
          PERFORM petro_private.inventory_apply_delta(
            org_id,doc.source_location_id,item_id,quantity,0,doc.id,NULL,'adjustment',btrim(p_payload->>'reason')
          );
        ELSIF doc.document_type='transfer' OR doc.document_type='damage' THEN
          PERFORM petro_private.inventory_apply_delta(
            org_id,doc.source_location_id,item_id,-quantity,0,doc.id,NULL,
            CASE WHEN doc.document_type='damage' THEN 'damage_out' ELSE 'transfer_out' END,
            btrim(p_payload->>'reason')
          );
          PERFORM petro_private.inventory_apply_delta(
            org_id,doc.target_location_id,item_id,quantity,0,doc.id,NULL,
            CASE WHEN doc.document_type='damage' THEN 'damage_in' ELSE 'transfer_in' END,
            btrim(p_payload->>'reason')
          );
        END IF;
      END LOOP;
    END IF;
    UPDATE public.petro_inventory_documents
    SET status=CASE WHEN decision='approve' THEN 'approved' ELSE 'rejected' END,
        reviewed_by=actor,reviewed_at=now(),review_reason=btrim(p_payload->>'reason')
    WHERE id=doc.id;
    INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
    VALUES(actor,org_id,'inventory.document_'||decision,doc.id,
      jsonb_build_object('type',doc.document_type,'reason',btrim(p_payload->>'reason')));
    response_json:=jsonb_build_object('id',doc.id,'status',CASE WHEN decision='approve' THEN 'approved' ELSE 'rejected' END);

  ELSIF p_action='reservation.reserve' THEN
    location_id:=(p_payload->>'locationId')::uuid;
    item_id:=(p_payload->>'itemId')::uuid;
    quantity:=(p_payload->>'quantity')::numeric;
    IF NOT petro_private.inventory_validate_item(org_id,item_id,quantity)
      OR NOT EXISTS (SELECT 1 FROM public.petro_catalog_items i
        WHERE i.id=item_id AND i.organization_id=org_id AND i.display_status='active' AND NOT i.central_suspended)
      OR coalesce(p_payload->>'sourceReference','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR length(btrim(coalesce(p_payload->>'reason',''))) NOT BETWEEN 5 AND 500 THEN
      RAISE EXCEPTION 'invalid inventory reservation' USING ERRCODE='22023';
    END IF;
    source_reference:=(p_payload->>'sourceReference')::uuid;
    IF NOT EXISTS (
      SELECT 1 FROM public.petro_inventory_locations l
      JOIN public.petro_organizations o ON o.id=l.organization_id
      WHERE l.id=location_id AND l.organization_id=org_id AND l.active
        AND l.location_kind='sellable' AND o.kind IN ('station','provider') AND o.status='active'
    ) THEN RAISE EXCEPTION 'inventory location is not eligible' USING ERRCODE='23514'; END IF;
    INSERT INTO public.petro_inventory_balances(organization_id,location_id,item_id)
    VALUES(org_id,location_id,item_id) ON CONFLICT DO NOTHING;
    SELECT b.* INTO balance_row FROM public.petro_inventory_balances b
    WHERE b.location_id=inventory_command.location_id AND b.item_id=inventory_command.item_id FOR UPDATE;
    IF balance_row.on_hand-balance_row.reserved<quantity THEN
      RAISE EXCEPTION 'INVENTORY_AVAILABLE_CONFLICT' USING ERRCODE='23514';
    END IF;
    INSERT INTO public.petro_inventory_reservations(
      organization_id,location_id,item_id,source_reference,quantity,idempotency_key,payload_hash,created_by
    ) VALUES (
      org_id,location_id,item_id,source_reference,quantity,
      p_idempotency_key,request_hash,actor
    ) RETURNING id INTO reservation_id;
    PERFORM petro_private.inventory_apply_delta(
      org_id,location_id,item_id,0,quantity,NULL,reservation_id,'reserve',btrim(p_payload->>'reason')
    );
    response_json:=jsonb_build_object('id',reservation_id,'status','reserved','quantity',quantity::text);

  ELSE
    reservation_id:=(p_payload->>'reservationId')::uuid;
    SELECT * INTO STRICT line FROM public.petro_inventory_reservations
    WHERE id=reservation_id AND organization_id=org_id FOR UPDATE;
    IF line.status<>'reserved' OR length(btrim(coalesce(p_payload->>'reason',''))) NOT BETWEEN 5 AND 500 THEN
      RAISE EXCEPTION 'reservation is no longer active' USING ERRCODE='55000';
    END IF;
    SELECT b.* INTO balance_row FROM public.petro_inventory_balances b
    WHERE b.location_id=line.location_id AND b.item_id=line.item_id FOR UPDATE;
    IF p_action='reservation.release' THEN
      PERFORM petro_private.inventory_apply_delta(
        org_id,line.location_id,line.item_id,0,-line.quantity,NULL,line.id,'release',btrim(p_payload->>'reason')
      );
      UPDATE public.petro_inventory_reservations SET status='released',completed_by=actor,completed_at=now() WHERE id=line.id;
      response_json:=jsonb_build_object('id',line.id,'status','released');
    ELSE
      PERFORM petro_private.inventory_apply_delta(
        org_id,line.location_id,line.item_id,-line.quantity,-line.quantity,NULL,line.id,'consume',btrim(p_payload->>'reason')
      );
      UPDATE public.petro_inventory_reservations SET status='consumed',completed_by=actor,completed_at=now() WHERE id=line.id;
      response_json:=jsonb_build_object('id',line.id,'status','consumed');
    END IF;
  END IF;

  UPDATE public.petro_inventory_commands SET result=response_json,completed_at=now()
  WHERE organization_id=org_id AND idempotency_key=p_idempotency_key;
  RETURN response_json;
END;
$$;

CREATE FUNCTION public.petro_inventory_admin_reconcile(p_organization_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$
  SELECT public.petro_inventory_admin_query(
    'reconciliation', jsonb_build_object('organizationId',p_organization_id)
  )
$$;

CREATE FUNCTION petro_private.inventory_guard_immutable()
RETURNS trigger
LANGUAGE plpgsql SET search_path=''
AS $$
BEGIN
  RAISE EXCEPTION 'inventory ledger rows are immutable' USING ERRCODE='55000';
END
$$;

CREATE TRIGGER petro_inventory_movements_immutable
  BEFORE UPDATE OR DELETE ON public.petro_inventory_movements
  FOR EACH ROW EXECUTE FUNCTION petro_private.inventory_guard_immutable();

ALTER TABLE public.petro_inventory_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_inventory_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_inventory_reorder_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_inventory_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_inventory_document_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_inventory_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_inventory_commands ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.petro_inventory_locations,public.petro_inventory_balances,
  public.petro_inventory_reorder_rules,
  public.petro_inventory_documents,public.petro_inventory_document_lines,
  public.petro_inventory_reservations,public.petro_inventory_movements,
  public.petro_inventory_commands
FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.petro_inventory_admin_query(text,jsonb) FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.petro_inventory_admin_command(text,jsonb,text) FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.petro_inventory_admin_reconcile(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.petro_inventory_admin_query(text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_inventory_admin_command(text,jsonb,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_inventory_admin_reconcile(uuid) TO authenticated;
REVOKE ALL ON FUNCTION petro_private.inventory_can_read(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION petro_private.inventory_can_write(uuid,uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION petro_private.inventory_validate_item(uuid,uuid,numeric,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION petro_private.inventory_apply_delta(uuid,uuid,uuid,numeric,numeric,uuid,uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION petro_private.inventory_guard_immutable() FROM PUBLIC,anon,authenticated,service_role;

COMMENT ON TABLE public.petro_inventory_balances IS
  'Derived on-hand and reserved quantities for merchant products; the immutable movement ledger is authoritative.';
COMMENT ON TABLE public.petro_inventory_reorder_rules IS
  'Per-location, per-product restock thresholds. Zero alerts only at stockout; no threshold means no generated alert.';
COMMENT ON TABLE public.petro_inventory_movements IS
  'Append-only stock movement and reservation ledger; product stock only, never service, fuel tank, or finance balances.';
COMMENT ON FUNCTION public.petro_inventory_admin_command(text,jsonb,text) IS
  'Transactional inventory document, count snapshot, return lineage, reorder rule, reservation, and idempotency command. Does not create sales, service orders, or financial postings.';

COMMIT;
