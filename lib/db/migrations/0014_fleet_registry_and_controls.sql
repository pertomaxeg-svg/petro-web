BEGIN;

CREATE TABLE public.petro_fleet_vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL,
  plate_original text NOT NULL CHECK (char_length(btrim(plate_original)) BETWEEN 2 AND 80),
  plate_standard text NOT NULL CHECK (char_length(btrim(plate_standard)) BETWEEN 2 AND 80),
  plate_normalized text GENERATED ALWAYS AS
    (regexp_replace(lower(btrim(plate_standard)), '[[:space:]]+', '', 'g')) STORED,
  vehicle_category text NOT NULL CHECK (char_length(btrim(vehicle_category)) BETWEEN 2 AND 80),
  vehicle_type text NOT NULL CHECK (char_length(btrim(vehicle_type)) BETWEEN 2 AND 80),
  brand text NOT NULL CHECK (char_length(btrim(brand)) BETWEEN 1 AND 100),
  model text NOT NULL CHECK (char_length(btrim(model)) BETWEEN 1 AND 100),
  model_year integer CHECK (model_year BETWEEN 1886 AND 2200),
  chassis_number text CHECK (chassis_number IS NULL OR char_length(btrim(chassis_number)) <= 100),
  internal_code text CHECK (internal_code IS NULL OR char_length(btrim(internal_code)) BETWEEN 1 AND 80),
  fuel_type text NOT NULL CHECK (char_length(btrim(fuel_type)) BETWEEN 2 AND 80),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','inactive')),
  status_reason text,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  updated_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT petro_fleet_vehicles_branch_org_fk
    FOREIGN KEY (branch_id, organization_id)
    REFERENCES public.petro_branches(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT petro_fleet_vehicles_plate_normalized_check CHECK (plate_normalized <> ''),
  CONSTRAINT petro_fleet_vehicles_org_plate_unique UNIQUE (organization_id, plate_normalized),
  CONSTRAINT petro_fleet_vehicles_id_org_unique UNIQUE (id, organization_id),
  CONSTRAINT petro_fleet_vehicles_id_scope_unique UNIQUE (id, organization_id, branch_id)
);

CREATE UNIQUE INDEX petro_fleet_vehicles_org_internal_code_unique
  ON public.petro_fleet_vehicles (organization_id, lower(btrim(internal_code)))
  WHERE internal_code IS NOT NULL;
CREATE INDEX petro_fleet_vehicles_org_branch_status_idx
  ON public.petro_fleet_vehicles (organization_id, branch_id, status, created_at DESC);

CREATE TABLE public.petro_fleet_drivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  driver_code text NOT NULL CHECK (char_length(btrim(driver_code)) BETWEEN 1 AND 80),
  full_name text NOT NULL CHECK (char_length(btrim(full_name)) BETWEEN 2 AND 160),
  phone text CHECK (phone IS NULL OR char_length(btrim(phone)) BETWEEN 3 AND 40),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','inactive')),
  status_reason text,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  updated_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT petro_fleet_drivers_org_code_unique UNIQUE (organization_id, driver_code),
  CONSTRAINT petro_fleet_drivers_id_scope_unique UNIQUE (id, organization_id)
);

CREATE TABLE public.petro_fleet_driver_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  vehicle_id uuid NOT NULL,
  driver_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended','revoked')),
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  ended_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  ended_at timestamptz,
  CONSTRAINT petro_fleet_driver_links_vehicle_scope_fk
    FOREIGN KEY (vehicle_id, organization_id)
    REFERENCES public.petro_fleet_vehicles(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT petro_fleet_driver_links_driver_scope_fk
    FOREIGN KEY (driver_id, organization_id)
    REFERENCES public.petro_fleet_drivers(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT petro_fleet_driver_links_dates_check
    CHECK ((status = 'active' AND ends_at IS NULL AND ended_at IS NULL)
        OR (status <> 'active' AND ends_at IS NOT NULL AND ended_at IS NOT NULL))
);

CREATE UNIQUE INDEX petro_fleet_driver_links_active_pair_unique
  ON public.petro_fleet_driver_links (vehicle_id, driver_id)
  WHERE status = 'active';
CREATE INDEX petro_fleet_driver_links_vehicle_idx
  ON public.petro_fleet_driver_links (vehicle_id, status, starts_at DESC);

CREATE TABLE petro_private.petro_fleet_driver_pair_secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid NOT NULL REFERENCES public.petro_fleet_driver_links(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL,
  vehicle_id uuid NOT NULL,
  driver_id uuid NOT NULL,
  pin_hmac bytea NOT NULL CHECK (octet_length(pin_hmac) = 32),
  key_version smallint NOT NULL DEFAULT 1 CHECK (key_version = 1),
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  disabled_at timestamptz,
  CONSTRAINT petro_fleet_driver_pair_secrets_link_scope_fk
    FOREIGN KEY (link_id) REFERENCES public.petro_fleet_driver_links(id) ON DELETE RESTRICT,
  CONSTRAINT petro_fleet_driver_pair_secrets_vehicle_scope_fk
    FOREIGN KEY (vehicle_id, organization_id)
    REFERENCES public.petro_fleet_vehicles(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT petro_fleet_driver_pair_secrets_driver_scope_fk
    FOREIGN KEY (driver_id, organization_id)
    REFERENCES public.petro_fleet_drivers(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT petro_fleet_driver_pair_secrets_active_dates_check
    CHECK ((active AND disabled_at IS NULL) OR (NOT active AND disabled_at IS NOT NULL))
);
CREATE UNIQUE INDEX petro_fleet_driver_pair_secrets_active_link_unique
  ON petro_private.petro_fleet_driver_pair_secrets (link_id) WHERE active;
CREATE UNIQUE INDEX petro_fleet_driver_pair_secrets_active_pin_per_vehicle_unique
  ON petro_private.petro_fleet_driver_pair_secrets (vehicle_id, pin_hmac) WHERE active;

CREATE TABLE petro_private.petro_fleet_pair_rate_limits (
  vehicle_id uuid PRIMARY KEY REFERENCES public.petro_fleet_vehicles(id) ON DELETE RESTRICT,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE petro_private.petro_fleet_pair_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid NOT NULL REFERENCES public.petro_fleet_driver_links(id) ON DELETE RESTRICT,
  vehicle_id uuid NOT NULL REFERENCES public.petro_fleet_vehicles(id) ON DELETE RESTRICT,
  verified_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '2 minutes'),
  consumed_at timestamptz,
  CHECK (expires_at > verified_at)
);

CREATE TABLE public.petro_fleet_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  vehicle_id uuid,
  driver_id uuid,
  event_type text NOT NULL CHECK (event_type IN (
    'vehicle_created','vehicle_updated','vehicle_moved','vehicle_status_changed',
    'driver_created','driver_updated','driver_status_changed',
    'driver_link_created','driver_link_ended','pair_pin_set','pair_pin_rotated'
  )),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  event_at timestamptz NOT NULL DEFAULT now(),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (vehicle_id, organization_id)
    REFERENCES public.petro_fleet_vehicles(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (driver_id, organization_id)
    REFERENCES public.petro_fleet_drivers(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT petro_fleet_events_detail_no_pin_check
    CHECK (NOT (detail ?| ARRAY['pin','pinCode','pinHmac','pinHash']))
);
CREATE INDEX petro_fleet_events_vehicle_time_idx
  ON public.petro_fleet_events (vehicle_id, event_at DESC);
CREATE INDEX petro_fleet_events_driver_time_idx
  ON public.petro_fleet_events (driver_id, event_at DESC);

CREATE TABLE public.petro_fleet_policy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL,
  vehicle_id uuid,
  scope_kind text NOT NULL CHECK (scope_kind IN ('branch','vehicle')),
  version_no integer NOT NULL CHECK (version_no > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','cancelled')),
  effective_from timestamptz NOT NULL,
  timezone text NOT NULL DEFAULT 'Africa/Cairo' CHECK (timezone = 'Africa/Cairo'),
  allowed_weekdays smallint[] NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  allowed_merchant_organization_ids uuid[] NOT NULL DEFAULT '{}',
  allowed_merchant_branch_ids uuid[] NOT NULL DEFAULT '{}',
  max_operation_minor bigint NOT NULL CHECK (max_operation_minor > 0),
  max_operation_quantity numeric(14,3) NOT NULL CHECK (max_operation_quantity > 0),
  daily_amount_limit_minor bigint NOT NULL CHECK (daily_amount_limit_minor > 0),
  weekly_amount_limit_minor bigint NOT NULL CHECK (weekly_amount_limit_minor > 0),
  monthly_amount_limit_minor bigint NOT NULL CHECK (monthly_amount_limit_minor > 0),
  daily_quantity_limit numeric(14,3) NOT NULL CHECK (daily_quantity_limit > 0),
  weekly_quantity_limit numeric(14,3) NOT NULL CHECK (weekly_quantity_limit > 0),
  monthly_quantity_limit numeric(14,3) NOT NULL CHECK (monthly_quantity_limit > 0),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  published_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT petro_fleet_policy_versions_scope_check
    CHECK ((scope_kind = 'branch' AND vehicle_id IS NULL)
        OR (scope_kind = 'vehicle' AND vehicle_id IS NOT NULL)),
  CONSTRAINT petro_fleet_policy_versions_days_check
    CHECK (cardinality(allowed_weekdays) BETWEEN 1 AND 7
      AND allowed_weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),
  CONSTRAINT petro_fleet_policy_versions_time_check CHECK (start_time < end_time),
  CONSTRAINT petro_fleet_policy_versions_publish_check
    CHECK (status <> 'published' OR (published_at IS NOT NULL AND published_by IS NOT NULL)),
  CONSTRAINT petro_fleet_policy_versions_branch_scope_fk
    FOREIGN KEY (branch_id, organization_id)
    REFERENCES public.petro_branches(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT petro_fleet_policy_versions_vehicle_scope_fk
    FOREIGN KEY (vehicle_id, organization_id, branch_id)
    REFERENCES public.petro_fleet_vehicles(id, organization_id, branch_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX petro_fleet_policy_branch_version_unique
  ON public.petro_fleet_policy_versions (organization_id, branch_id, version_no)
  WHERE scope_kind = 'branch';
CREATE UNIQUE INDEX petro_fleet_policy_vehicle_version_unique
  ON public.petro_fleet_policy_versions (vehicle_id, version_no)
  WHERE scope_kind = 'vehicle';
CREATE INDEX petro_fleet_policy_effective_idx
  ON public.petro_fleet_policy_versions (organization_id, branch_id, scope_kind, effective_from DESC)
  WHERE status = 'published';

CREATE TABLE public.petro_fleet_policy_rules (
  policy_version_id uuid NOT NULL REFERENCES public.petro_fleet_policy_versions(id) ON DELETE RESTRICT,
  service_group text NOT NULL CHECK (service_group IN ('fuel','wash','oils','parts')),
  enabled boolean NOT NULL DEFAULT false,
  max_operation_minor bigint NOT NULL DEFAULT 0 CHECK (max_operation_minor >= 0),
  max_operation_quantity numeric(14,3) NOT NULL DEFAULT 0 CHECK (max_operation_quantity >= 0),
  daily_amount_limit_minor bigint NOT NULL DEFAULT 0 CHECK (daily_amount_limit_minor >= 0),
  weekly_amount_limit_minor bigint NOT NULL DEFAULT 0 CHECK (weekly_amount_limit_minor >= 0),
  monthly_amount_limit_minor bigint NOT NULL DEFAULT 0 CHECK (monthly_amount_limit_minor >= 0),
  daily_quantity_limit numeric(14,3) NOT NULL DEFAULT 0 CHECK (daily_quantity_limit >= 0),
  weekly_quantity_limit numeric(14,3) NOT NULL DEFAULT 0 CHECK (weekly_quantity_limit >= 0),
  monthly_quantity_limit numeric(14,3) NOT NULL DEFAULT 0 CHECK (monthly_quantity_limit >= 0),
  PRIMARY KEY (policy_version_id, service_group),
  CONSTRAINT petro_fleet_policy_rules_enabled_limits_check CHECK (
    NOT enabled OR (
      max_operation_minor > 0 AND max_operation_quantity > 0
      AND daily_amount_limit_minor > 0 AND weekly_amount_limit_minor > 0
      AND monthly_amount_limit_minor > 0 AND daily_quantity_limit > 0
      AND weekly_quantity_limit > 0 AND monthly_quantity_limit > 0
    )
  )
);

CREATE TABLE public.petro_fleet_usage_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL,
  vehicle_id uuid NOT NULL,
  driver_link_id uuid NOT NULL REFERENCES public.petro_fleet_driver_links(id) ON DELETE RESTRICT,
  service_group text NOT NULL CHECK (service_group IN ('fuel','wash','oils','parts')),
  merchant_organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  merchant_branch_id uuid NOT NULL REFERENCES public.petro_branches(id) ON DELETE RESTRICT,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
  request_key text NOT NULL CHECK (char_length(request_key) BETWEEN 16 AND 120),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{32}$'),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','consumed','released')),
  vehicle_policy_version_id uuid NOT NULL REFERENCES public.petro_fleet_policy_versions(id) ON DELETE RESTRICT,
  branch_policy_version_id uuid NOT NULL REFERENCES public.petro_fleet_policy_versions(id) ON DELETE RESTRICT,
  finance_reservation_id uuid UNIQUE REFERENCES public.petro_finance_reservations(id) ON DELETE RESTRICT,
  consumed_entry_id uuid REFERENCES public.petro_finance_journal_entries(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CONSTRAINT petro_fleet_usage_reservation_vehicle_scope_fk
    FOREIGN KEY (vehicle_id, organization_id, branch_id)
    REFERENCES public.petro_fleet_vehicles(id, organization_id, branch_id) ON DELETE RESTRICT,
  CONSTRAINT petro_fleet_usage_reservation_merchant_branch_scope_fk
    FOREIGN KEY (merchant_branch_id, merchant_organization_id)
    REFERENCES public.petro_branches(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT petro_fleet_usage_reservation_closed_check
    CHECK ((status = 'reserved' AND closed_at IS NULL)
        OR (status <> 'reserved' AND closed_at IS NOT NULL)),
  CONSTRAINT petro_fleet_usage_reservation_consumed_entry_check
    CHECK ((status = 'consumed') = (consumed_entry_id IS NOT NULL)),
  UNIQUE (organization_id, request_key)
);
CREATE INDEX petro_fleet_usage_vehicle_time_idx
  ON public.petro_fleet_usage_reservations (vehicle_id, created_at DESC)
  WHERE status IN ('reserved','consumed');
CREATE INDEX petro_fleet_usage_branch_time_idx
  ON public.petro_fleet_usage_reservations (branch_id, created_at DESC)
  WHERE status IN ('reserved','consumed');

CREATE TABLE public.petro_subscription_vehicle_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES public.petro_subscriptions(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  vehicle_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  ended_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  ended_at timestamptz,
  FOREIGN KEY (vehicle_id, organization_id) REFERENCES public.petro_fleet_vehicles(id, organization_id) ON DELETE RESTRICT,
  CHECK ((status = 'active' AND ends_at IS NULL AND ended_at IS NULL)
      OR (status = 'ended' AND ends_at IS NOT NULL AND ended_at IS NOT NULL))
);
CREATE UNIQUE INDEX petro_subscription_vehicle_assignments_active_vehicle_unique
  ON public.petro_subscription_vehicle_assignments (vehicle_id) WHERE status = 'active';
CREATE INDEX petro_subscription_vehicle_assignments_subscription_idx
  ON public.petro_subscription_vehicle_assignments (subscription_id, status);

CREATE TABLE public.petro_vehicle_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL,
  vehicle_id uuid NOT NULL,
  credential_type text NOT NULL CHECK (credential_type IN ('nfc','qr')),
  token_sha256 text NOT NULL CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  token_hint text NOT NULL CHECK (token_hint ~ '^[0-9a-f]{6}$'),
  status text NOT NULL CHECK (status IN ('active','revoked','replaced','lost')),
  request_id uuid,
  activated_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  activated_at timestamptz NOT NULL DEFAULT now(),
  revoked_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  revoked_at timestamptz,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  FOREIGN KEY (vehicle_id, organization_id, branch_id)
    REFERENCES public.petro_fleet_vehicles(id, organization_id, branch_id) ON DELETE RESTRICT,
  UNIQUE (token_sha256)
);
CREATE UNIQUE INDEX petro_vehicle_credentials_one_active_type_per_vehicle
  ON public.petro_vehicle_credentials (vehicle_id, credential_type) WHERE status = 'active';

CREATE TABLE public.petro_fleet_credential_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL,
  vehicle_id uuid NOT NULL,
  credential_type text NOT NULL CHECK (credential_type IN ('nfc','qr')),
  request_type text NOT NULL CHECK (request_type IN ('issue','replace','stop')),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN (
    'requested','approved','assigned','scheduled','installed','active',
    'rejected','cancelled','completed'
  )),
  payment_state text NOT NULL CHECK (payment_state IN ('not_required','awaiting_collection','waived')),
  issue_price_minor bigint NOT NULL CHECK (issue_price_minor >= 0),
  previous_credential_id uuid REFERENCES public.petro_vehicle_credentials(id) ON DELETE RESTRICT,
  assigned_to uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  scheduled_at timestamptz,
  proof_document_id uuid REFERENCES public.petro_documents(id) ON DELETE RESTRICT,
  replacement_ready boolean NOT NULL DEFAULT false,
  waiver_reason text,
  approved_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (vehicle_id, organization_id, branch_id)
    REFERENCES public.petro_fleet_vehicles(id, organization_id, branch_id) ON DELETE RESTRICT,
  CHECK ((credential_type = 'nfc' AND issue_price_minor >= 0
             AND payment_state IN ('awaiting_collection','waived'))
      OR (credential_type = 'qr' AND issue_price_minor = 0 AND payment_state = 'not_required')),
  CHECK ((payment_state = 'waived') = (waiver_reason IS NOT NULL)),
  CHECK (
    (status IN ('approved','assigned','scheduled','installed','active','completed')
      AND approved_at IS NOT NULL AND approved_by IS NOT NULL)
    OR (status IN ('requested','rejected','cancelled') AND approved_at IS NULL AND approved_by IS NULL)
  )
);
CREATE UNIQUE INDEX petro_fleet_credential_open_request_unique
  ON public.petro_fleet_credential_requests (vehicle_id, credential_type)
  WHERE status IN ('requested','approved','assigned','scheduled','installed');
CREATE INDEX petro_fleet_credential_requests_org_time_idx
  ON public.petro_fleet_credential_requests (organization_id, status, created_at DESC);

ALTER TABLE public.petro_vehicle_credentials
  ADD CONSTRAINT petro_vehicle_credentials_request_fk
  FOREIGN KEY (request_id) REFERENCES public.petro_fleet_credential_requests(id) ON DELETE RESTRICT;

CREATE TABLE public.petro_fleet_tag_stock_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_code text NOT NULL UNIQUE CHECK (char_length(btrim(unit_code)) BETWEEN 2 AND 100),
  unit_type text NOT NULL DEFAULT 'nfc' CHECK (unit_type = 'nfc'),
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available','reserved','installed','damaged','lost')),
  request_id uuid REFERENCES public.petro_fleet_credential_requests(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('reserved','installed') AND request_id IS NOT NULL)
      OR (status NOT IN ('reserved','installed')))
);
CREATE TABLE public.petro_fleet_tag_stock_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unit_id uuid NOT NULL REFERENCES public.petro_fleet_tag_stock_units(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('received','reserved','installed','released','damaged','lost')),
  request_id uuid REFERENCES public.petro_fleet_credential_requests(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.petro_fleet_credential_requests
  ADD COLUMN stock_unit_id uuid REFERENCES public.petro_fleet_tag_stock_units(id) ON DELETE RESTRICT;

CREATE TABLE public.petro_vehicle_odometer_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL,
  vehicle_id uuid NOT NULL,
  reading_km numeric(14,3) NOT NULL CHECK (reading_km >= 0),
  recorded_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('accepted','pending_review','rejected')),
  source text NOT NULL CHECK (char_length(btrim(source)) BETWEEN 2 AND 80),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  evidence_document_id uuid REFERENCES public.petro_documents(id) ON DELETE RESTRICT,
  supersedes_event_id uuid REFERENCES public.petro_vehicle_odometer_events(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  review_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (vehicle_id, organization_id, branch_id)
    REFERENCES public.petro_fleet_vehicles(id, organization_id, branch_id) ON DELETE RESTRICT,
  CHECK ((status = 'pending_review' AND reviewed_at IS NULL)
      OR (status <> 'pending_review' AND (reviewed_at IS NULL OR reviewed_by IS NOT NULL)))
);
CREATE INDEX petro_vehicle_odometer_vehicle_time_idx
  ON public.petro_vehicle_odometer_events (vehicle_id, recorded_at DESC);

CREATE TABLE public.petro_vehicle_maintenance_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL,
  vehicle_id uuid NOT NULL,
  maintenance_type text NOT NULL CHECK (maintenance_type IN ('oil','parts','battery','filters','tires','other')),
  performed_at timestamptz NOT NULL,
  odometer_event_id uuid REFERENCES public.petro_vehicle_odometer_events(id) ON DELETE RESTRICT,
  notes text NOT NULL CHECK (char_length(btrim(notes)) BETWEEN 3 AND 2000),
  next_due_at timestamptz,
  next_due_km numeric(14,3) CHECK (next_due_km IS NULL OR next_due_km >= 0),
  document_id uuid REFERENCES public.petro_documents(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','cancelled')),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (vehicle_id, organization_id, branch_id)
    REFERENCES public.petro_fleet_vehicles(id, organization_id, branch_id) ON DELETE RESTRICT,
  CHECK (next_due_at IS NOT NULL OR next_due_km IS NOT NULL)
);
CREATE INDEX petro_vehicle_maintenance_vehicle_time_idx
  ON public.petro_vehicle_maintenance_records (vehicle_id, performed_at DESC);

CREATE TABLE public.petro_fleet_import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL CHECK (status IN ('previewed','applied','rejected')),
  payload jsonb NOT NULL,
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  applied_at timestamptz,
  CHECK (jsonb_typeof(payload) = 'object'),
  CHECK (jsonb_typeof(validation_errors) = 'array'),
  CHECK ((status = 'applied') = (applied_at IS NOT NULL AND applied_by IS NOT NULL))
);

CREATE TABLE public.petro_fleet_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type text NOT NULL CHECK (event_type IN ('document_due','maintenance_due','fleet_audit_notice')),
  source_type text NOT NULL CHECK (source_type IN ('document','maintenance','vehicle','driver')),
  source_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES public.petro_organizations(id) ON DELETE RESTRICT,
  scheduled_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  CONSTRAINT petro_fleet_outbox_source_unique UNIQUE (event_type, source_type, source_id, scheduled_at)
);

CREATE TABLE public.petro_fleet_idempotency (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 16 AND 120),
  action text NOT NULL CHECK (char_length(action) BETWEEN 2 AND 80),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{32}$'),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_id, idempotency_key)
);

ALTER TABLE public.petro_documents
  ADD COLUMN vehicle_id uuid,
  ADD CONSTRAINT petro_documents_vehicle_scope_fk
    FOREIGN KEY (vehicle_id, organization_id, branch_id)
    REFERENCES public.petro_fleet_vehicles(id, organization_id, branch_id) ON DELETE RESTRICT,
  ADD CONSTRAINT petro_documents_vehicle_requires_branch_check
    CHECK (vehicle_id IS NULL OR branch_id IS NOT NULL);

CREATE INDEX petro_documents_vehicle_idx
  ON public.petro_documents (vehicle_id, created_at DESC)
  WHERE vehicle_id IS NOT NULL;

ALTER TABLE public.petro_fleet_vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_fleet_drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_fleet_driver_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE petro_private.petro_fleet_driver_pair_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE petro_private.petro_fleet_driver_pair_secrets FORCE ROW LEVEL SECURITY;
ALTER TABLE petro_private.petro_fleet_pair_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE petro_private.petro_fleet_pair_rate_limits FORCE ROW LEVEL SECURITY;
ALTER TABLE petro_private.petro_fleet_pair_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE petro_private.petro_fleet_pair_verifications FORCE ROW LEVEL SECURITY;
ALTER TABLE public.petro_fleet_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_fleet_policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_fleet_policy_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_fleet_usage_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_subscription_vehicle_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_vehicle_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_fleet_credential_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_fleet_tag_stock_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_fleet_tag_stock_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_vehicle_odometer_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_vehicle_maintenance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_fleet_import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_fleet_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.petro_fleet_idempotency ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.petro_vehicle_maintenance_records
  ADD COLUMN cancelled_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancel_reason text,
  ADD CONSTRAINT petro_vehicle_maintenance_cancel_check CHECK (
    (status='cancelled' AND cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL
      AND cancel_reason IS NOT NULL)
    OR (status='recorded' AND cancelled_by IS NULL AND cancelled_at IS NULL AND cancel_reason IS NULL)
  );

REVOKE ALL ON public.petro_fleet_vehicles, public.petro_fleet_drivers, public.petro_fleet_driver_links,
  petro_private.petro_fleet_driver_pair_secrets, petro_private.petro_fleet_pair_rate_limits,
  petro_private.petro_fleet_pair_verifications,
  public.petro_fleet_events, public.petro_fleet_policy_versions, public.petro_fleet_policy_rules,
  public.petro_fleet_usage_reservations,
  public.petro_subscription_vehicle_assignments, public.petro_vehicle_credentials,
  public.petro_fleet_credential_requests, public.petro_fleet_tag_stock_units,
  public.petro_fleet_tag_stock_events, public.petro_vehicle_odometer_events,
  public.petro_vehicle_maintenance_records, public.petro_fleet_import_jobs, public.petro_fleet_outbox,
  public.petro_fleet_idempotency
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION petro_private.fleet_can_read()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT auth.uid() IS NOT NULL AND petro_private.user_active()
    AND EXISTS (
      SELECT 1 FROM public.petro_platform_roles role_row
      WHERE role_row.user_id = auth.uid() AND role_row.active
        AND role_row.role IN ('owner','operations','auditor')
    )
$$;

CREATE FUNCTION petro_private.fleet_can_manage()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT auth.uid() IS NOT NULL AND petro_private.user_active()
    AND EXISTS (
      SELECT 1 FROM public.petro_platform_roles role_row
      WHERE role_row.user_id = auth.uid() AND role_row.active
        AND role_row.role IN ('owner','operations')
    )
$$;

CREATE FUNCTION public.petro_admin_fleet_catalog(p_view text, p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor uuid := auth.uid();
  page_no integer := least(100000, greatest(1, coalesce((p_filters->>'page')::integer, 1)));
  page_size integer := least(100, greatest(1, coalesce((p_filters->>'pageSize')::integer, 25)));
  search_text text := nullif(btrim(p_filters->>'query'), '');
  sort_key text := coalesce(nullif(p_filters->>'sort',''),'newest');
  selected_id uuid := nullif(p_filters->>'id', '')::uuid;
  result jsonb;
  total_count bigint;
BEGIN
  IF NOT petro_private.fleet_can_read() THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_view NOT IN ('overview','vehicles','vehicle','drivers','policies','coverage',
      'credentials','documents','odometer','maintenance','events','imports') THEN
    RAISE EXCEPTION 'INVALID_FLEET_VIEW' USING ERRCODE = '22023';
  END IF;
  IF sort_key NOT IN ('newest','oldest','name','plate','updatedAt') THEN
    RAISE EXCEPTION 'INVALID_FLEET_SORT' USING ERRCODE = '22023';
  END IF;

  IF p_view = 'overview' THEN
    SELECT jsonb_build_object(
      'vehicles', (SELECT count(*) FROM public.petro_fleet_vehicles),
      'activeVehicles', (SELECT count(*) FROM public.petro_fleet_vehicles WHERE status='active'),
      'drivers', (SELECT count(*) FROM public.petro_fleet_drivers),
      'activeDrivers', (SELECT count(*) FROM public.petro_fleet_drivers WHERE status='active'),
      'coveredVehicles', (SELECT count(DISTINCT vehicle_id)
        FROM public.petro_subscription_vehicle_assignments
        WHERE status='active' AND starts_at<=now() AND (ends_at IS NULL OR ends_at>now())),
      'pendingCredentials', (SELECT count(*) FROM public.petro_fleet_credential_requests
        WHERE status IN ('requested','approved','assigned','scheduled','installed')),
      'pendingOdometerReviews', (SELECT count(*) FROM public.petro_vehicle_odometer_events
        WHERE status='pending_review'),
      'unreadDueEvents', (SELECT count(*) FROM public.petro_fleet_outbox
        WHERE delivered_at IS NULL AND scheduled_at<=now())
    ) INTO result;
  ELSIF p_view = 'vehicles' THEN
    WITH filtered AS (
      SELECT v.*,
        EXISTS (SELECT 1 FROM public.petro_subscription_vehicle_assignments coverage
          JOIN public.petro_subscriptions subscription ON subscription.id=coverage.subscription_id
          WHERE coverage.vehicle_id=v.id AND coverage.status='active'
            AND coverage.starts_at<=now() AND (coverage.ends_at IS NULL OR coverage.ends_at>now())
            AND subscription.status IN ('active','scheduled')
            AND subscription.starts_at<=now() AND subscription.ends_at>now()
            AND (subscription.cancellation_effective_at IS NULL OR subscription.cancellation_effective_at>now())
        ) AS is_covered,
        (SELECT count(*) FROM public.petro_fleet_driver_links link
          WHERE link.vehicle_id=v.id AND link.status='active') AS active_driver_count,
        (SELECT count(*) FROM public.petro_vehicle_credentials credential
          WHERE credential.vehicle_id=v.id AND credential.status='active') AS active_credential_count
      FROM public.petro_fleet_vehicles v
      WHERE (nullif(p_filters->>'organizationId','') IS NULL OR v.organization_id=(p_filters->>'organizationId')::uuid)
        AND (nullif(p_filters->>'branchId','') IS NULL OR v.branch_id=(p_filters->>'branchId')::uuid)
        AND (nullif(p_filters->>'status','') IS NULL OR v.status=p_filters->>'status')
        AND (nullif(p_filters->>'fuelType','') IS NULL OR v.fuel_type=p_filters->>'fuelType')
        AND (nullif(p_filters->>'coverage','') IS NULL
          OR (p_filters->>'coverage'='covered' AND EXISTS (
            SELECT 1 FROM public.petro_subscription_vehicle_assignments c
            JOIN public.petro_subscriptions s ON s.id=c.subscription_id
            WHERE c.vehicle_id=v.id AND c.status='active' AND c.starts_at<=now()
              AND (c.ends_at IS NULL OR c.ends_at>now()) AND s.status IN ('active','scheduled')
              AND s.starts_at<=now() AND s.ends_at>now()
          ))
          OR (p_filters->>'coverage'='uncovered' AND NOT EXISTS (
            SELECT 1 FROM public.petro_subscription_vehicle_assignments c
            JOIN public.petro_subscriptions s ON s.id=c.subscription_id
            WHERE c.vehicle_id=v.id AND c.status='active' AND c.starts_at<=now()
              AND (c.ends_at IS NULL OR c.ends_at>now()) AND s.status IN ('active','scheduled')
              AND s.starts_at<=now() AND s.ends_at>now()
          )))
        AND (search_text IS NULL OR v.plate_original ILIKE '%'||search_text||'%'
          OR v.plate_standard ILIKE '%'||search_text||'%'
          OR coalesce(v.internal_code,'') ILIKE '%'||search_text||'%'
          OR v.brand ILIKE '%'||search_text||'%' OR v.model ILIKE '%'||search_text||'%')
    )
    SELECT jsonb_build_object(
      'items', coalesce(jsonb_agg(jsonb_build_object(
        'id', f.id, 'organizationId', f.organization_id, 'branchId', f.branch_id,
        'plateOriginal', f.plate_original, 'plateStandard', f.plate_standard,
        'plateNormalized', f.plate_normalized, 'category', f.vehicle_category,
        'vehicleType', f.vehicle_type, 'brand', f.brand, 'model', f.model,
        'modelYear', f.model_year, 'chassisNumber', f.chassis_number,
        'internalCode', f.internal_code, 'fuelType', f.fuel_type,
        'status', f.status, 'statusReason', f.status_reason, 'version', f.version,
        'isCovered', f.is_covered, 'activeDriverCount', f.active_driver_count,
        'activeCredentialCount', f.active_credential_count, 'createdAt', f.created_at,
        'updatedAt', f.updated_at
      ) ORDER BY
        CASE WHEN sort_key IN ('updatedAt','newest') THEN f.updated_at END DESC,
        CASE WHEN sort_key='oldest' THEN f.created_at END ASC,
        CASE WHEN sort_key='plate' THEN f.plate_normalized END ASC,
        f.id
      ) FILTER (WHERE f.id IS NOT NULL), '[]'::jsonb),
      'total', (SELECT count(*) FROM filtered),
      'page', page_no, 'pageSize', page_size
    ) INTO result
    FROM (
      SELECT * FROM filtered
      ORDER BY
        CASE WHEN sort_key IN ('updatedAt','newest') THEN updated_at END DESC,
        CASE WHEN sort_key='oldest' THEN created_at END ASC,
        CASE WHEN sort_key='plate' THEN plate_normalized END ASC,
        id
      LIMIT page_size OFFSET (page_no-1)*page_size
    ) f;
  ELSIF p_view = 'vehicle' THEN
    SELECT jsonb_build_object(
      'vehicle', (SELECT jsonb_build_object(
        'id',v.id,'organizationId',v.organization_id,'branchId',v.branch_id,
        'plateOriginal',v.plate_original,'plateStandard',v.plate_standard,
        'plateNormalized',v.plate_normalized,'category',v.vehicle_category,
        'vehicleType',v.vehicle_type,'brand',v.brand,'model',v.model,
        'modelYear',v.model_year,'chassisNumber',v.chassis_number,'internalCode',v.internal_code,
        'fuelType',v.fuel_type,'status',v.status,'statusReason',v.status_reason,
        'version',v.version,'createdAt',v.created_at,'updatedAt',v.updated_at)
        FROM public.petro_fleet_vehicles v WHERE v.id=selected_id),
      'driverLinks', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id',l.id,'driverId',d.id,'driverName',d.full_name,'driverCode',d.driver_code,
        'status',l.status,'startsAt',l.starts_at,'endsAt',l.ends_at,'reason',l.reason)
        ORDER BY l.starts_at DESC)
        FROM public.petro_fleet_driver_links l
        JOIN public.petro_fleet_drivers d ON d.id=l.driver_id
        WHERE l.vehicle_id=selected_id), '[]'::jsonb),
      'credentials', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id',c.id,'type',c.credential_type,'status',c.status,'hint',c.token_hint,
        'activatedAt',c.activated_at,'revokedAt',c.revoked_at,'reason',c.reason)
        ORDER BY c.activated_at DESC)
        FROM public.petro_vehicle_credentials c WHERE c.vehicle_id=selected_id), '[]'::jsonb),
      'coverage', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id',a.id,'subscriptionId',a.subscription_id,'startsAt',a.starts_at,
        'endsAt',a.ends_at,'status',a.status,'reason',a.reason)
        ORDER BY a.starts_at DESC)
        FROM public.petro_subscription_vehicle_assignments a WHERE a.vehicle_id=selected_id), '[]'::jsonb),
      'documents', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id',d.id,'type',d.document_type,'fileName',d.file_name,'status',d.status,
        'expiresOn',d.expires_on,'createdAt',d.created_at)
        ORDER BY d.created_at DESC)
        FROM public.petro_documents d WHERE d.vehicle_id=selected_id), '[]'::jsonb),
      'odometer', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id',o.id,'readingKm',o.reading_km,'recordedAt',o.recorded_at,'status',o.status,
        'source',o.source,'reason',o.reason,'evidenceDocumentId',o.evidence_document_id,
        'supersedesEventId',o.supersedes_event_id,'reviewReason',o.review_reason)
        ORDER BY o.recorded_at DESC)
        FROM public.petro_vehicle_odometer_events o WHERE o.vehicle_id=selected_id), '[]'::jsonb),
      'maintenance', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id',m.id,'type',m.maintenance_type,'performedAt',m.performed_at,
        'odometerEventId',m.odometer_event_id,'notes',m.notes,'nextDueAt',m.next_due_at,
        'nextDueKm',m.next_due_km,'documentId',m.document_id,'status',m.status)
        ORDER BY m.performed_at DESC)
        FROM public.petro_vehicle_maintenance_records m WHERE m.vehicle_id=selected_id), '[]'::jsonb),
      'events', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id',e.id,'type',e.event_type,'reason',e.reason,'actorId',e.actor_id,
        'at',e.event_at,'detail',e.detail) ORDER BY e.event_at DESC)
        FROM public.petro_fleet_events e WHERE e.vehicle_id=selected_id), '[]'::jsonb)
    ) INTO result;
    IF result->'vehicle' IS NULL OR result->'vehicle'='null'::jsonb THEN
      RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002';
    END IF;
  ELSIF p_view = 'drivers' THEN
    WITH filtered AS (
      SELECT d.*,(SELECT count(*) FROM public.petro_fleet_driver_links l
        WHERE l.driver_id=d.id AND l.status='active') AS active_link_count
      FROM public.petro_fleet_drivers d
      WHERE (nullif(p_filters->>'organizationId','') IS NULL OR d.organization_id=(p_filters->>'organizationId')::uuid)
        AND (nullif(p_filters->>'status','') IS NULL OR d.status=p_filters->>'status')
        AND (search_text IS NULL OR d.full_name ILIKE '%'||search_text||'%'
          OR d.driver_code ILIKE '%'||search_text||'%' OR coalesce(d.phone,'') ILIKE '%'||search_text||'%')
    )
    SELECT jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object(
      'id',f.id,'organizationId',f.organization_id,'driverCode',f.driver_code,
      'fullName',f.full_name,'phone',f.phone,'status',f.status,'statusReason',f.status_reason,
      'version',f.version,'activeLinkCount',f.active_link_count,'createdAt',f.created_at,
      'updatedAt',f.updated_at) ORDER BY
        CASE WHEN sort_key='name' THEN f.full_name END ASC,
        CASE WHEN sort_key='oldest' THEN f.created_at END ASC,
        CASE WHEN sort_key NOT IN ('name','oldest') THEN f.created_at END DESC,
        f.id), '[]'::jsonb),
      'total',(SELECT count(*) FROM filtered),'page',page_no,'pageSize',page_size)
      INTO result FROM (
        SELECT * FROM filtered ORDER BY
          CASE WHEN sort_key='name' THEN full_name END ASC,
          CASE WHEN sort_key='oldest' THEN created_at END ASC,
          CASE WHEN sort_key NOT IN ('name','oldest') THEN created_at END DESC,
          id LIMIT page_size OFFSET (page_no-1)*page_size
      ) f;
  ELSIF p_view = 'policies' THEN
    WITH filtered AS (
      SELECT p.* FROM public.petro_fleet_policy_versions p
      WHERE (nullif(p_filters->>'organizationId','') IS NULL OR p.organization_id=(p_filters->>'organizationId')::uuid)
        AND (nullif(p_filters->>'branchId','') IS NULL OR p.branch_id=(p_filters->>'branchId')::uuid)
        AND (nullif(p_filters->>'vehicleId','') IS NULL OR p.vehicle_id=(p_filters->>'vehicleId')::uuid)
        AND (search_text IS NULL OR p.id::text ILIKE '%'||search_text||'%'
          OR p.status ILIKE '%'||search_text||'%' OR p.scope_kind ILIKE '%'||search_text||'%'
          OR p.reason ILIKE '%'||search_text||'%')
    )
    SELECT jsonb_build_object(
      'items',coalesce(jsonb_agg(jsonb_build_object(
        'id',p.id,'organizationId',p.organization_id,'branchId',p.branch_id,
        'vehicleId',p.vehicle_id,'scope',p.scope_kind,'version',p.version_no,'status',p.status,
        'effectiveFrom',p.effective_from,'timezone',p.timezone,'allowedWeekdays',p.allowed_weekdays,
        'startTime',p.start_time,'endTime',p.end_time,
        'allowedMerchantOrganizationIds',p.allowed_merchant_organization_ids,
        'allowedMerchantBranchIds',p.allowed_merchant_branch_ids,'maxOperationMinor',p.max_operation_minor,
        'maxOperationQuantity',p.max_operation_quantity,'dailyAmountLimitMinor',p.daily_amount_limit_minor,
        'weeklyAmountLimitMinor',p.weekly_amount_limit_minor,'monthlyAmountLimitMinor',p.monthly_amount_limit_minor,
        'dailyQuantityLimit',p.daily_quantity_limit,'weeklyQuantityLimit',p.weekly_quantity_limit,
        'monthlyQuantityLimit',p.monthly_quantity_limit,'reason',p.reason,'createdAt',p.created_at,
        'rules',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.service_group),'[]'::jsonb)
          FROM public.petro_fleet_policy_rules r WHERE r.policy_version_id=p.id)
      ) ORDER BY
        CASE WHEN sort_key='oldest' THEN p.created_at END ASC,
        CASE WHEN sort_key<>'oldest' THEN p.created_at END DESC,
        p.id),'[]'::jsonb),
      'total',(SELECT count(*) FROM filtered),'page',page_no,'pageSize',page_size
    ) INTO result FROM (
      SELECT * FROM filtered ORDER BY
        CASE WHEN sort_key='oldest' THEN created_at END ASC,
        CASE WHEN sort_key<>'oldest' THEN created_at END DESC,
        id LIMIT page_size OFFSET (page_no-1)*page_size
    ) p;
  ELSIF p_view = 'coverage' THEN
    WITH filtered AS (
      SELECT a.*,v.branch_id,v.plate_standard,s.status AS subscription_status,
        s.starts_at AS subscription_starts_at,s.ends_at AS subscription_ends_at,
        s.units AS subscription_units,s.billing_unit
      FROM public.petro_subscription_vehicle_assignments a
      JOIN public.petro_fleet_vehicles v ON v.id=a.vehicle_id
      JOIN public.petro_subscriptions s ON s.id=a.subscription_id
      WHERE (nullif(p_filters->>'organizationId','') IS NULL OR a.organization_id=(p_filters->>'organizationId')::uuid)
        AND (nullif(p_filters->>'vehicleId','') IS NULL OR a.vehicle_id=(p_filters->>'vehicleId')::uuid)
        AND (search_text IS NULL OR v.plate_standard ILIKE '%'||search_text||'%'
          OR a.subscription_id::text ILIKE '%'||search_text||'%' OR a.status ILIKE '%'||search_text||'%')
    )
    SELECT jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object(
      'id',a.id,'subscriptionId',a.subscription_id,'organizationId',a.organization_id,
      'vehicleId',a.vehicle_id,'branchId',a.branch_id,'plate',a.plate_standard,
      'startsAt',a.starts_at,'endsAt',a.ends_at,'status',a.status,'reason',a.reason,
      'subscriptionStatus',a.subscription_status,'subscriptionStartsAt',a.subscription_starts_at,
      'subscriptionEndsAt',a.subscription_ends_at,'subscriptionUnits',a.subscription_units,
      'billingUnit',a.billing_unit)
      ORDER BY CASE WHEN sort_key='oldest' THEN a.starts_at END ASC,
        CASE WHEN sort_key<>'oldest' THEN a.starts_at END DESC,a.id),'[]'::jsonb),
      'total',(SELECT count(*) FROM filtered),'page',page_no,'pageSize',page_size)
    INTO result FROM (
      SELECT * FROM filtered ORDER BY
        CASE WHEN sort_key='oldest' THEN starts_at END ASC,
        CASE WHEN sort_key<>'oldest' THEN starts_at END DESC,
        id LIMIT page_size OFFSET (page_no-1)*page_size
    ) a;
  ELSIF p_view = 'credentials' THEN
    WITH filtered AS (
      SELECT r.*,v.plate_standard FROM public.petro_fleet_credential_requests r
      JOIN public.petro_fleet_vehicles v ON v.id=r.vehicle_id
      WHERE (nullif(p_filters->>'organizationId','') IS NULL OR r.organization_id=(p_filters->>'organizationId')::uuid)
        AND (nullif(p_filters->>'status','') IS NULL OR r.status=p_filters->>'status')
        AND (nullif(p_filters->>'vehicleId','') IS NULL OR r.vehicle_id=(p_filters->>'vehicleId')::uuid)
        AND (search_text IS NULL OR v.plate_standard ILIKE '%'||search_text||'%'
          OR r.credential_type ILIKE '%'||search_text||'%' OR r.status ILIKE '%'||search_text||'%'
          OR r.id::text ILIKE '%'||search_text||'%')
    )
    SELECT jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object(
      'id',r.id,'organizationId',r.organization_id,'branchId',r.branch_id,'vehicleId',r.vehicle_id,
      'plate',r.plate_standard,'type',r.credential_type,'requestType',r.request_type,'status',r.status,
      'paymentState',r.payment_state,'issuePriceMinor',r.issue_price_minor,
      'previousCredentialId',r.previous_credential_id,'assignedTo',r.assigned_to,
      'scheduledAt',r.scheduled_at,'proofDocumentId',r.proof_document_id,
      'waiverReason',r.waiver_reason,'approvedBy',r.approved_by,'approvedAt',r.approved_at,
      'reason',r.reason,'createdAt',r.created_at,'updatedAt',r.updated_at)
      ORDER BY CASE WHEN sort_key='oldest' THEN r.created_at END ASC,
        CASE WHEN sort_key<>'oldest' THEN r.created_at END DESC,r.id),'[]'::jsonb),
      'total',(SELECT count(*) FROM filtered),'page',page_no,'pageSize',page_size)
    INTO result FROM (
      SELECT * FROM filtered ORDER BY
        CASE WHEN sort_key='oldest' THEN created_at END ASC,
        CASE WHEN sort_key<>'oldest' THEN created_at END DESC,
        id LIMIT page_size OFFSET (page_no-1)*page_size
    ) r;
  ELSIF p_view = 'documents' THEN
    WITH filtered AS (
      SELECT d.* FROM public.petro_documents d
      WHERE d.vehicle_id IS NOT NULL
        AND (nullif(p_filters->>'vehicleId','') IS NULL OR d.vehicle_id=(p_filters->>'vehicleId')::uuid)
        AND (nullif(p_filters->>'organizationId','') IS NULL OR d.organization_id=(p_filters->>'organizationId')::uuid)
        AND (search_text IS NULL OR d.file_name ILIKE '%'||search_text||'%'
          OR d.document_type ILIKE '%'||search_text||'%' OR d.status ILIKE '%'||search_text||'%')
    )
    SELECT jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object(
      'id',d.id,'organizationId',d.organization_id,'branchId',d.branch_id,'vehicleId',d.vehicle_id,
      'type',d.document_type,'fileName',d.file_name,'contentType',d.content_type,
      'byteSize',d.byte_size,'status',d.status,'expiresOn',d.expires_on,'version',d.version,
      'reviewReason',d.review_reason,'createdAt',d.created_at,'uploadedAt',d.uploaded_at)
      ORDER BY CASE WHEN sort_key='oldest' THEN d.created_at END ASC,
        CASE WHEN sort_key<>'oldest' THEN d.created_at END DESC,d.id),'[]'::jsonb),
      'total',(SELECT count(*) FROM filtered),'page',page_no,'pageSize',page_size)
    INTO result FROM (
      SELECT * FROM filtered ORDER BY
        CASE WHEN sort_key='oldest' THEN created_at END ASC,
        CASE WHEN sort_key<>'oldest' THEN created_at END DESC,
        id LIMIT page_size OFFSET (page_no-1)*page_size
    ) d;
  ELSIF p_view = 'odometer' THEN
    WITH filtered AS (
      SELECT o.* FROM public.petro_vehicle_odometer_events o
      WHERE (nullif(p_filters->>'vehicleId','') IS NULL OR o.vehicle_id=(p_filters->>'vehicleId')::uuid)
        AND (nullif(p_filters->>'status','') IS NULL OR o.status=p_filters->>'status')
        AND (search_text IS NULL OR o.status ILIKE '%'||search_text||'%'
          OR o.source ILIKE '%'||search_text||'%' OR o.reason ILIKE '%'||search_text||'%'
          OR o.reading_km::text ILIKE '%'||search_text||'%')
    )
    SELECT jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object(
      'id',o.id,'organizationId',o.organization_id,'vehicleId',o.vehicle_id,
      'readingKm',o.reading_km,'recordedAt',o.recorded_at,'status',o.status,'source',o.source,
      'reason',o.reason,'evidenceDocumentId',o.evidence_document_id,
      'supersedesEventId',o.supersedes_event_id,'reviewReason',o.review_reason)
      ORDER BY CASE WHEN sort_key='oldest' THEN o.recorded_at END ASC,
        CASE WHEN sort_key<>'oldest' THEN o.recorded_at END DESC,o.id),'[]'::jsonb),
      'total',(SELECT count(*) FROM filtered),'page',page_no,'pageSize',page_size)
    INTO result FROM (
      SELECT * FROM filtered ORDER BY
        CASE WHEN sort_key='oldest' THEN recorded_at END ASC,
        CASE WHEN sort_key<>'oldest' THEN recorded_at END DESC,
        id LIMIT page_size OFFSET (page_no-1)*page_size
    ) o;
  ELSIF p_view = 'maintenance' THEN
    WITH filtered AS (
      SELECT m.* FROM public.petro_vehicle_maintenance_records m
      WHERE (nullif(p_filters->>'vehicleId','') IS NULL OR m.vehicle_id=(p_filters->>'vehicleId')::uuid)
        AND (nullif(p_filters->>'status','') IS NULL OR m.status=p_filters->>'status')
        AND (search_text IS NULL OR m.status ILIKE '%'||search_text||'%'
          OR m.maintenance_type ILIKE '%'||search_text||'%' OR coalesce(m.notes,'') ILIKE '%'||search_text||'%')
    )
    SELECT jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object(
      'id',m.id,'organizationId',m.organization_id,'vehicleId',m.vehicle_id,
      'type',m.maintenance_type,'performedAt',m.performed_at,'odometerEventId',m.odometer_event_id,
      'notes',m.notes,'nextDueAt',m.next_due_at,'nextDueKm',m.next_due_km,
      'documentId',m.document_id,'status',m.status,'reason',m.reason)
      ORDER BY CASE WHEN sort_key='oldest' THEN m.performed_at END ASC,
        CASE WHEN sort_key<>'oldest' THEN m.performed_at END DESC,m.id),'[]'::jsonb),
      'total',(SELECT count(*) FROM filtered),'page',page_no,'pageSize',page_size)
    INTO result FROM (
      SELECT * FROM filtered ORDER BY
        CASE WHEN sort_key='oldest' THEN performed_at END ASC,
        CASE WHEN sort_key<>'oldest' THEN performed_at END DESC,
        id LIMIT page_size OFFSET (page_no-1)*page_size
    ) m;
  ELSIF p_view = 'events' THEN
    WITH filtered AS (
      SELECT e.* FROM public.petro_fleet_events e
      WHERE (nullif(p_filters->>'vehicleId','') IS NULL OR e.vehicle_id=(p_filters->>'vehicleId')::uuid)
        AND (nullif(p_filters->>'driverId','') IS NULL OR e.driver_id=(p_filters->>'driverId')::uuid)
        AND (search_text IS NULL OR e.event_type ILIKE '%'||search_text||'%'
          OR e.reason ILIKE '%'||search_text||'%' OR e.id::text ILIKE '%'||search_text||'%')
    )
    SELECT jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object(
      'id',e.id,'organizationId',e.organization_id,'vehicleId',e.vehicle_id,'driverId',e.driver_id,
      'type',e.event_type,'reason',e.reason,'actorId',e.actor_id,'at',e.event_at,'detail',e.detail)
      ORDER BY CASE WHEN sort_key='oldest' THEN e.event_at END ASC,
        CASE WHEN sort_key<>'oldest' THEN e.event_at END DESC,e.id),'[]'::jsonb),
      'total',(SELECT count(*) FROM filtered),'page',page_no,'pageSize',page_size)
    INTO result FROM (
      SELECT * FROM filtered ORDER BY
        CASE WHEN sort_key='oldest' THEN event_at END ASC,
        CASE WHEN sort_key<>'oldest' THEN event_at END DESC,
        id LIMIT page_size OFFSET (page_no-1)*page_size
    ) e;
  ELSIF p_view = 'imports' THEN
    WITH filtered AS (
      SELECT j.* FROM public.petro_fleet_import_jobs j
      WHERE j.created_by=actor OR petro_private.fleet_can_manage()
    )
    SELECT jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object(
      'id',j.id,'status',j.status,'errors',j.validation_errors,
      'createdAt',j.created_at,'appliedAt',j.applied_at,'appliedBy',j.applied_by)
      ORDER BY CASE WHEN sort_key='oldest' THEN j.created_at END ASC,
        CASE WHEN sort_key<>'oldest' THEN j.created_at END DESC,j.id),'[]'::jsonb),
      'total',(SELECT count(*) FROM filtered WHERE search_text IS NULL
        OR status ILIKE '%'||search_text||'%' OR id::text ILIKE '%'||search_text||'%'),
      'page',page_no,'pageSize',page_size)
    INTO result FROM (
      SELECT * FROM filtered
      WHERE search_text IS NULL OR status ILIKE '%'||search_text||'%' OR id::text ILIKE '%'||search_text||'%'
      ORDER BY CASE WHEN sort_key='oldest' THEN created_at END ASC,
        CASE WHEN sort_key<>'oldest' THEN created_at END DESC,
        id LIMIT page_size OFFSET (page_no-1)*page_size
    ) j;
  END IF;
  RETURN coalesce(result,'{}'::jsonb);
END
$$;

CREATE FUNCTION public.petro_admin_fleet_command(
  p_action text, p_payload jsonb, p_reason text, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
<<cmd>>
DECLARE
  actor uuid := auth.uid();
  command_id bigint;
  previous_action text;
  previous_hash text;
  previous_response jsonb;
  payload_hash text;
  result jsonb;
  org_id uuid;
  branch_id uuid;
  vehicle_id uuid;
  driver_id uuid;
  link_id uuid;
  source_branch_id uuid;
  request_id uuid;
  credential_id uuid;
  stock_unit_id uuid;
  policy_id uuid;
  current_version bigint;
  next_version integer;
  current_status text;
  current_org_kind text;
  pin_digest bytea;
  credential_price bigint;
  credential_type text;
  token_sha256 text;
  token_hint text;
  proof_document_id uuid;
  assigned_user_id uuid;
  credential_request_type text;
  credential_request_status text;
  credential_payment_state text;
  previous_credential_id uuid;
  replacement_ready boolean;
  request_stock_unit_id uuid;
  waiver boolean;
  import_payload jsonb;
  validation_errors jsonb;
  row_number integer := 0;
  effective_at timestamptz;
  subscription_starts_at timestamptz;
  subscription_ends_at timestamptz;
  requested_start timestamptz;
  subscription_branch_id uuid;
  subscription_units integer;
  subscription_billing_unit text;
  allowed_org_count integer;
  allowed_branch_count integer;
  rule_row jsonb;
BEGIN
  IF NOT petro_private.fleet_can_manage() THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p_payload) <> 'object'
     OR p_action NOT IN (
       'vehicle.create','vehicle.update','vehicle.move','vehicle.status',
       'driver.create','driver.update','driver.status',
       'driver.link.create','driver.link.end','driver.pin.rotate',
       'policy.create','policy.update','policy.publish',
       'coverage.assign','coverage.end',
       'credential.request','credential.approve','credential.assign','credential.install',
       'credential.activate_qr','credential.activate_nfc','credential.stop',
       'odometer.record','odometer.review','maintenance.create','maintenance.cancel',
       'tag_stock.receive','tag_stock.reserve','tag_stock.damage',
       'import.preview','import.apply'
     )
     OR char_length(btrim(coalesce(p_reason,''))) NOT BETWEEN 3 AND 500
     OR char_length(coalesce(p_idempotency_key,'')) NOT BETWEEN 16 AND 120 THEN
    RAISE EXCEPTION 'INVALID_FLEET_COMMAND' USING ERRCODE='22023';
  END IF;
  payload_hash := md5(p_action || ':' || p_payload::text);
  INSERT INTO public.petro_fleet_idempotency(actor_id,idempotency_key,action,payload_hash)
    VALUES(actor,p_idempotency_key,p_action,payload_hash)
    ON CONFLICT (actor_id,idempotency_key) DO NOTHING
    RETURNING id INTO command_id;
  IF command_id IS NULL THEN
    SELECT idem.action,idem.payload_hash,idem.response
      INTO previous_action,previous_hash,previous_response
      FROM public.petro_fleet_idempotency AS idem
      WHERE idem.actor_id=actor AND idem.idempotency_key=p_idempotency_key FOR UPDATE;
    IF previous_action<>p_action OR previous_hash<>payload_hash THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT' USING ERRCODE='23505';
    END IF;
    IF previous_response IS NULL THEN
      RAISE EXCEPTION 'IDEMPOTENT_REQUEST_IN_PROGRESS' USING ERRCODE='40001';
    END IF;
    RETURN previous_response || jsonb_build_object('replayed',true);
  END IF;

  IF p_action LIKE 'vehicle.%' THEN
    vehicle_id := nullif(p_payload->>'vehicleId','')::uuid;
    org_id := nullif(p_payload->>'organizationId','')::uuid;
    branch_id := nullif(p_payload->>'branchId','')::uuid;
    IF p_action='vehicle.create' THEN
      IF NOT EXISTS (SELECT 1 FROM public.petro_organizations o
        WHERE o.id=org_id AND o.kind='company') THEN
        RAISE EXCEPTION 'COMPANY_NOT_FOUND' USING ERRCODE='23503';
      END IF;
      INSERT INTO public.petro_fleet_vehicles(
        organization_id,branch_id,plate_original,plate_standard,vehicle_category,vehicle_type,
        brand,model,model_year,chassis_number,internal_code,fuel_type,created_by,updated_by
      ) VALUES (
        org_id,branch_id,btrim(p_payload->>'plateOriginal'),btrim(p_payload->>'plateStandard'),
        btrim(p_payload->>'category'),btrim(p_payload->>'vehicleType'),btrim(p_payload->>'brand'),
        btrim(p_payload->>'model'),nullif(p_payload->>'modelYear','')::integer,
        nullif(btrim(p_payload->>'chassisNumber'),''),nullif(btrim(p_payload->>'internalCode'),''),
        btrim(p_payload->>'fuelType'),actor,actor
      ) RETURNING id INTO vehicle_id;
      INSERT INTO public.petro_fleet_events(organization_id,vehicle_id,event_type,reason,actor_id,detail)
        VALUES(org_id,vehicle_id,'vehicle_created',p_reason,actor,'{}'::jsonb);
      credential_type := nullif(p_payload->>'credentialType','');
      IF credential_type IS NOT NULL THEN
        IF credential_type NOT IN ('nfc','qr') THEN RAISE EXCEPTION 'INVALID_CREDENTIAL_TYPE' USING ERRCODE='22023'; END IF;
        SELECT nfc_issue_price_minor INTO credential_price FROM public.petro_billing_settings WHERE singleton_id=true;
        INSERT INTO public.petro_fleet_credential_requests(
          organization_id,branch_id,vehicle_id,credential_type,request_type,status,payment_state,
          issue_price_minor,reason,created_by
        ) VALUES (
          org_id,branch_id,vehicle_id,credential_type,'issue','requested',
          CASE WHEN credential_type='nfc' THEN 'awaiting_collection' ELSE 'not_required' END,
          CASE WHEN credential_type='nfc' THEN credential_price ELSE 0 END,p_reason,actor
        ) RETURNING id INTO request_id;
      END IF;
      result := jsonb_build_object('id',vehicle_id,'organizationId',org_id,'branchId',branch_id,
        'status','active','version',1,'credentialRequestId',request_id);
    ELSIF p_action='vehicle.update' THEN
      UPDATE public.petro_fleet_vehicles SET
        plate_original=btrim(p_payload->>'plateOriginal'),
        plate_standard=btrim(p_payload->>'plateStandard'),
        vehicle_category=btrim(p_payload->>'category'),vehicle_type=btrim(p_payload->>'vehicleType'),
        brand=btrim(p_payload->>'brand'),model=btrim(p_payload->>'model'),
        model_year=nullif(p_payload->>'modelYear','')::integer,
        chassis_number=nullif(btrim(p_payload->>'chassisNumber'),''),
        internal_code=nullif(btrim(p_payload->>'internalCode'),''),
        fuel_type=btrim(p_payload->>'fuelType'),version=version+1,
        updated_by=actor,updated_at=now()
      WHERE id=vehicle_id AND version=(p_payload->>'expectedVersion')::bigint
      RETURNING organization_id,branch_id,version INTO org_id,branch_id,current_version;
      IF NOT FOUND THEN RAISE EXCEPTION 'VEHICLE_VERSION_CONFLICT_OR_NOT_FOUND' USING ERRCODE='40001'; END IF;
      INSERT INTO public.petro_fleet_events(organization_id,vehicle_id,event_type,reason,actor_id,detail)
        VALUES(org_id,vehicle_id,'vehicle_updated',p_reason,actor,'{}'::jsonb);
      result := jsonb_build_object('id',vehicle_id,'version',current_version);
    ELSIF p_action='vehicle.move' THEN
      SELECT v.organization_id,v.branch_id,v.version INTO org_id,source_branch_id,current_version
        FROM public.petro_fleet_vehicles v WHERE v.id=vehicle_id FOR UPDATE;
      IF NOT FOUND OR current_version<>(p_payload->>'expectedVersion')::bigint THEN
        RAISE EXCEPTION 'VEHICLE_VERSION_CONFLICT_OR_NOT_FOUND' USING ERRCODE='40001';
      END IF;
      UPDATE public.petro_fleet_vehicles AS moved_vehicle
        SET branch_id=(p_payload->>'targetBranchId')::uuid,
          version=moved_vehicle.version+1,updated_by=actor,updated_at=now()
        WHERE moved_vehicle.id=vehicle_id
        RETURNING moved_vehicle.branch_id,moved_vehicle.version INTO branch_id,current_version;
      INSERT INTO public.petro_fleet_events(organization_id,vehicle_id,event_type,reason,actor_id,detail)
        VALUES(org_id,vehicle_id,'vehicle_moved',p_reason,actor,
          jsonb_build_object('fromBranchId',source_branch_id,'toBranchId',branch_id));
      result := jsonb_build_object('id',vehicle_id,'branchId',branch_id,'version',current_version,
        'historyPreserved',true);
    ELSE
      UPDATE public.petro_fleet_vehicles SET status=p_payload->>'status',
        status_reason=p_reason,version=version+1,updated_by=actor,updated_at=now()
        WHERE id=vehicle_id AND version=(p_payload->>'expectedVersion')::bigint
        RETURNING organization_id,branch_id,status,version INTO org_id,branch_id,current_status,current_version;
      IF NOT FOUND THEN RAISE EXCEPTION 'VEHICLE_VERSION_CONFLICT_OR_NOT_FOUND' USING ERRCODE='40001'; END IF;
      INSERT INTO public.petro_fleet_events(organization_id,vehicle_id,event_type,reason,actor_id,detail)
        VALUES(org_id,vehicle_id,'vehicle_status_changed',p_reason,actor,
          jsonb_build_object('status',current_status));
      result := jsonb_build_object('id',vehicle_id,'status',current_status,'version',current_version);
    END IF;
  ELSIF p_action IN ('driver.create','driver.update','driver.status') THEN
    driver_id := nullif(p_payload->>'driverId','')::uuid;
    org_id := nullif(p_payload->>'organizationId','')::uuid;
    IF p_action='driver.create' THEN
      IF NOT EXISTS (SELECT 1 FROM public.petro_organizations o
        WHERE o.id=org_id AND o.kind='company') THEN RAISE EXCEPTION 'COMPANY_NOT_FOUND' USING ERRCODE='23503'; END IF;
      INSERT INTO public.petro_fleet_drivers(organization_id,driver_code,full_name,phone,created_by,updated_by)
        VALUES(org_id,btrim(p_payload->>'driverCode'),btrim(p_payload->>'fullName'),
          nullif(btrim(p_payload->>'phone'),''),actor,actor)
        RETURNING id INTO driver_id;
      INSERT INTO public.petro_fleet_events(organization_id,driver_id,event_type,reason,actor_id,detail)
        VALUES(org_id,driver_id,'driver_created',p_reason,actor,'{}'::jsonb);
      result := jsonb_build_object('id',driver_id,'organizationId',org_id,'status','active','version',1);
    ELSIF p_action='driver.update' THEN
      UPDATE public.petro_fleet_drivers SET driver_code=btrim(p_payload->>'driverCode'),
        full_name=btrim(p_payload->>'fullName'),phone=nullif(btrim(p_payload->>'phone'),''),
        version=version+1,updated_by=actor,updated_at=now()
        WHERE id=driver_id AND version=(p_payload->>'expectedVersion')::bigint
        RETURNING organization_id,version INTO org_id,current_version;
      IF NOT FOUND THEN RAISE EXCEPTION 'DRIVER_VERSION_CONFLICT_OR_NOT_FOUND' USING ERRCODE='40001'; END IF;
      INSERT INTO public.petro_fleet_events(organization_id,driver_id,event_type,reason,actor_id,detail)
        VALUES(org_id,driver_id,'driver_updated',p_reason,actor,'{}'::jsonb);
      result := jsonb_build_object('id',driver_id,'version',current_version);
    ELSE
      UPDATE public.petro_fleet_drivers SET status=p_payload->>'status',
        status_reason=p_reason,version=version+1,updated_by=actor,updated_at=now()
        WHERE id=driver_id AND version=(p_payload->>'expectedVersion')::bigint
        RETURNING organization_id,status,version INTO org_id,current_status,current_version;
      IF NOT FOUND THEN RAISE EXCEPTION 'DRIVER_VERSION_CONFLICT_OR_NOT_FOUND' USING ERRCODE='40001'; END IF;
      IF current_status<>'active' THEN
        UPDATE public.petro_fleet_driver_links AS active_link SET status='revoked',ends_at=now(),
          ended_by=actor,ended_at=now(),reason=p_reason
          WHERE active_link.driver_id=driver_id AND active_link.status='active';
        UPDATE petro_private.petro_fleet_driver_pair_secrets AS secret SET active=false,
          disabled_by=actor,disabled_at=now()
          WHERE secret.driver_id=driver_id AND secret.active;
        UPDATE petro_private.petro_fleet_pair_verifications verification SET consumed_at=now()
          FROM public.petro_fleet_driver_links ended_link
          WHERE ended_link.driver_id=driver_id AND ended_link.status='revoked'
            AND verification.link_id=ended_link.id AND verification.consumed_at IS NULL;
      END IF;
      INSERT INTO public.petro_fleet_events(organization_id,driver_id,event_type,reason,actor_id,detail)
        VALUES(org_id,driver_id,'driver_status_changed',p_reason,actor,
          jsonb_build_object('status',current_status));
      result := jsonb_build_object('id',driver_id,'status',current_status,'version',current_version);
    END IF;
  ELSIF p_action='driver.link.create' THEN
    vehicle_id := (p_payload->>'vehicleId')::uuid;
    driver_id := (p_payload->>'driverId')::uuid;
    SELECT v.organization_id INTO org_id FROM public.petro_fleet_vehicles v
      JOIN public.petro_fleet_drivers d ON d.id=driver_id AND d.organization_id=v.organization_id
      WHERE v.id=vehicle_id AND v.status='active' AND d.status='active'
      FOR UPDATE OF v,d;
    IF NOT FOUND THEN RAISE EXCEPTION 'DRIVER_VEHICLE_SCOPE_OR_STATUS_INVALID' USING ERRCODE='23514'; END IF;
    INSERT INTO public.petro_fleet_driver_links(organization_id,vehicle_id,driver_id,reason,created_by)
      VALUES(org_id,vehicle_id,driver_id,p_reason,actor) RETURNING id INTO link_id;
    IF nullif(p_payload->>'pinHmac','') IS NOT NULL THEN
      IF p_payload->>'pinHmac' !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'INVALID_PAIR_SECRET' USING ERRCODE='22023'; END IF;
      pin_digest := decode(p_payload->>'pinHmac','hex');
      INSERT INTO petro_private.petro_fleet_driver_pair_secrets(
        link_id,organization_id,vehicle_id,driver_id,pin_hmac,created_by
      ) VALUES(link_id,org_id,vehicle_id,driver_id,pin_digest,actor);
    END IF;
    INSERT INTO public.petro_fleet_events(organization_id,vehicle_id,driver_id,event_type,reason,actor_id,detail)
      VALUES(org_id,vehicle_id,driver_id,'driver_link_created',p_reason,actor,
        jsonb_build_object('linkId',link_id,'pinSet',nullif(p_payload->>'pinHmac','') IS NOT NULL));
    result := jsonb_build_object('id',link_id,'vehicleId',vehicle_id,'driverId',driver_id,'status','active');
  ELSIF p_action='driver.link.end' THEN
    link_id := (p_payload->>'linkId')::uuid;
    UPDATE public.petro_fleet_driver_links SET status='ended',ends_at=now(),
      ended_by=actor,ended_at=now(),reason=p_reason
      WHERE id=link_id AND status='active'
      RETURNING organization_id,vehicle_id,driver_id INTO org_id,vehicle_id,driver_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACTIVE_DRIVER_LINK_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    UPDATE petro_private.petro_fleet_driver_pair_secrets AS secret SET active=false,
      disabled_by=actor,disabled_at=now() WHERE secret.link_id=link_id AND secret.active;
    UPDATE petro_private.petro_fleet_pair_verifications AS verification SET consumed_at=now()
      WHERE verification.link_id=link_id AND verification.consumed_at IS NULL;
    INSERT INTO public.petro_fleet_events(organization_id,vehicle_id,driver_id,event_type,reason,actor_id,detail)
      VALUES(org_id,vehicle_id,driver_id,'driver_link_ended',p_reason,actor,jsonb_build_object('linkId',link_id));
    result := jsonb_build_object('id',link_id,'status','ended');
  ELSIF p_action='driver.pin.rotate' THEN
    link_id := (p_payload->>'linkId')::uuid;
    IF p_payload->>'pinHmac' !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'INVALID_PAIR_SECRET' USING ERRCODE='22023'; END IF;
    SELECT active_link.organization_id,active_link.vehicle_id,active_link.driver_id
      INTO org_id,vehicle_id,driver_id
      FROM public.petro_fleet_driver_links AS active_link
      WHERE active_link.id=link_id AND active_link.status='active' FOR UPDATE;
    IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.petro_fleet_vehicles WHERE id=vehicle_id AND status='active')
      OR NOT EXISTS (SELECT 1 FROM public.petro_fleet_drivers WHERE id=driver_id AND status='active') THEN
      RAISE EXCEPTION 'ACTIVE_DRIVER_LINK_NOT_FOUND' USING ERRCODE='P0002';
    END IF;
    UPDATE petro_private.petro_fleet_driver_pair_secrets AS secret SET active=false,
      disabled_by=actor,disabled_at=now() WHERE secret.link_id=link_id AND secret.active;
    UPDATE petro_private.petro_fleet_pair_verifications AS verification SET consumed_at=now()
      WHERE verification.link_id=link_id AND verification.consumed_at IS NULL;
    INSERT INTO petro_private.petro_fleet_driver_pair_secrets(
      link_id,organization_id,vehicle_id,driver_id,pin_hmac,created_by
    ) VALUES(link_id,org_id,vehicle_id,driver_id,decode(p_payload->>'pinHmac','hex'),actor);
    INSERT INTO public.petro_fleet_events(organization_id,vehicle_id,driver_id,event_type,reason,actor_id,detail)
      VALUES(org_id,vehicle_id,driver_id,'pair_pin_rotated',p_reason,actor,jsonb_build_object('linkId',link_id));
    result := jsonb_build_object('linkId',link_id,'pinChanged',true);
  ELSIF p_action IN ('policy.create','policy.update') THEN
    org_id := (p_payload->>'organizationId')::uuid;
    branch_id := (p_payload->>'branchId')::uuid;
    vehicle_id := nullif(p_payload->>'vehicleId','')::uuid;
    IF p_action='policy.create' THEN
      IF (p_payload->>'scope') NOT IN ('branch','vehicle')
        OR ((p_payload->>'scope')='branch' AND vehicle_id IS NOT NULL)
        OR ((p_payload->>'scope')='vehicle' AND vehicle_id IS NULL) THEN
        RAISE EXCEPTION 'INVALID_POLICY_SCOPE' USING ERRCODE='22023';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended(
        coalesce(vehicle_id::text,branch_id::text)||':fleet-policy',0));
      IF NOT EXISTS (SELECT 1 FROM public.petro_organizations o WHERE o.id=org_id AND o.kind='company') THEN
        RAISE EXCEPTION 'COMPANY_NOT_FOUND' USING ERRCODE='23503';
      END IF;
      SELECT coalesce(max(p.version_no),0)+1 INTO next_version
        FROM public.petro_fleet_policy_versions p
        WHERE p.organization_id=org_id AND p.branch_id=cmd.branch_id
          AND p.vehicle_id IS NOT DISTINCT FROM cmd.vehicle_id;
      INSERT INTO public.petro_fleet_policy_versions(
        organization_id,branch_id,vehicle_id,scope_kind,version_no,status,effective_from,
        allowed_weekdays,start_time,end_time,allowed_merchant_organization_ids,
        allowed_merchant_branch_ids,max_operation_minor,max_operation_quantity,
        daily_amount_limit_minor,weekly_amount_limit_minor,monthly_amount_limit_minor,
        daily_quantity_limit,weekly_quantity_limit,monthly_quantity_limit,reason,created_by
      ) VALUES (
        org_id,branch_id,vehicle_id,p_payload->>'scope',next_version,'draft',
        (p_payload->>'effectiveFrom')::timestamptz,
        ARRAY(SELECT value::smallint FROM jsonb_array_elements_text(p_payload->'allowedWeekdays') AS days(value)),
        (p_payload->>'startTime')::time,(p_payload->>'endTime')::time,
        ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(p_payload->'allowedMerchantOrganizationIds') AS orgs(value)),
        ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(p_payload->'allowedMerchantBranchIds') AS branches(value)),
        (p_payload->>'maxOperationMinor')::bigint,(p_payload->>'maxOperationQuantity')::numeric,
        (p_payload->>'dailyAmountLimitMinor')::bigint,(p_payload->>'weeklyAmountLimitMinor')::bigint,
        (p_payload->>'monthlyAmountLimitMinor')::bigint,(p_payload->>'dailyQuantityLimit')::numeric,
        (p_payload->>'weeklyQuantityLimit')::numeric,(p_payload->>'monthlyQuantityLimit')::numeric,
        p_reason,actor
      ) RETURNING id INTO policy_id;
      IF jsonb_typeof(p_payload->'rules')<>'array' OR jsonb_array_length(p_payload->'rules')<>4 THEN
        RAISE EXCEPTION 'POLICY_REQUIRES_FOUR_SERVICE_RULES' USING ERRCODE='22023';
      END IF;
      FOR rule_row IN SELECT value FROM jsonb_array_elements(p_payload->'rules') LOOP
        INSERT INTO public.petro_fleet_policy_rules(
          policy_version_id,service_group,enabled,max_operation_minor,max_operation_quantity,
          daily_amount_limit_minor,weekly_amount_limit_minor,monthly_amount_limit_minor,
          daily_quantity_limit,weekly_quantity_limit,monthly_quantity_limit
        ) VALUES (
          policy_id,rule_row->>'serviceGroup',coalesce((rule_row->>'enabled')::boolean,false),
          coalesce((rule_row->>'maxOperationMinor')::bigint,0),
          coalesce((rule_row->>'maxOperationQuantity')::numeric,0),
          coalesce((rule_row->>'dailyAmountLimitMinor')::bigint,0),
          coalesce((rule_row->>'weeklyAmountLimitMinor')::bigint,0),
          coalesce((rule_row->>'monthlyAmountLimitMinor')::bigint,0),
          coalesce((rule_row->>'dailyQuantityLimit')::numeric,0),
          coalesce((rule_row->>'weeklyQuantityLimit')::numeric,0),
          coalesce((rule_row->>'monthlyQuantityLimit')::numeric,0)
        );
      END LOOP;
    ELSE
      policy_id := (p_payload->>'policyVersionId')::uuid;
      SELECT p.organization_id,p.branch_id,p.vehicle_id,p.version_no
        INTO org_id,branch_id,vehicle_id,next_version
        FROM public.petro_fleet_policy_versions p
        WHERE p.id=policy_id AND p.status='draft' FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'DRAFT_POLICY_NOT_FOUND' USING ERRCODE='P0002'; END IF;
      UPDATE public.petro_fleet_policy_versions SET
        effective_from=(p_payload->>'effectiveFrom')::timestamptz,
        allowed_weekdays=ARRAY(SELECT value::smallint FROM jsonb_array_elements_text(p_payload->'allowedWeekdays') AS days(value)),
        start_time=(p_payload->>'startTime')::time,end_time=(p_payload->>'endTime')::time,
        allowed_merchant_organization_ids=ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(p_payload->'allowedMerchantOrganizationIds') AS orgs(value)),
        allowed_merchant_branch_ids=ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(p_payload->'allowedMerchantBranchIds') AS branches(value)),
        max_operation_minor=(p_payload->>'maxOperationMinor')::bigint,
        max_operation_quantity=(p_payload->>'maxOperationQuantity')::numeric,
        daily_amount_limit_minor=(p_payload->>'dailyAmountLimitMinor')::bigint,
        weekly_amount_limit_minor=(p_payload->>'weeklyAmountLimitMinor')::bigint,
        monthly_amount_limit_minor=(p_payload->>'monthlyAmountLimitMinor')::bigint,
        daily_quantity_limit=(p_payload->>'dailyQuantityLimit')::numeric,
        weekly_quantity_limit=(p_payload->>'weeklyQuantityLimit')::numeric,
        monthly_quantity_limit=(p_payload->>'monthlyQuantityLimit')::numeric,
        reason=p_reason
        WHERE id=policy_id AND status='draft';
      IF jsonb_typeof(p_payload->'rules')<>'array' OR jsonb_array_length(p_payload->'rules')<>4 THEN
        RAISE EXCEPTION 'POLICY_REQUIRES_FOUR_SERVICE_RULES' USING ERRCODE='22023';
      END IF;
      DELETE FROM public.petro_fleet_policy_rules WHERE policy_version_id=policy_id;
      FOR rule_row IN SELECT value FROM jsonb_array_elements(p_payload->'rules') LOOP
        INSERT INTO public.petro_fleet_policy_rules(
          policy_version_id,service_group,enabled,max_operation_minor,max_operation_quantity,
          daily_amount_limit_minor,weekly_amount_limit_minor,monthly_amount_limit_minor,
          daily_quantity_limit,weekly_quantity_limit,monthly_quantity_limit
        ) VALUES (
          policy_id,rule_row->>'serviceGroup',coalesce((rule_row->>'enabled')::boolean,false),
          coalesce((rule_row->>'maxOperationMinor')::bigint,0),
          coalesce((rule_row->>'maxOperationQuantity')::numeric,0),
          coalesce((rule_row->>'dailyAmountLimitMinor')::bigint,0),
          coalesce((rule_row->>'weeklyAmountLimitMinor')::bigint,0),
          coalesce((rule_row->>'monthlyAmountLimitMinor')::bigint,0),
          coalesce((rule_row->>'dailyQuantityLimit')::numeric,0),
          coalesce((rule_row->>'weeklyQuantityLimit')::numeric,0),
          coalesce((rule_row->>'monthlyQuantityLimit')::numeric,0)
        );
      END LOOP;
    END IF;
    result := jsonb_build_object('id',policy_id,'organizationId',org_id,'branchId',branch_id,
      'vehicleId',vehicle_id,'status','draft','version',next_version);
  ELSIF p_action='policy.publish' THEN
    policy_id := (p_payload->>'policyVersionId')::uuid;
    SELECT p.organization_id,p.branch_id,p.vehicle_id,p.version_no,p.effective_from,p.status,
      cardinality(p.allowed_merchant_organization_ids),cardinality(p.allowed_merchant_branch_ids)
      INTO org_id,branch_id,vehicle_id,next_version,effective_at,current_status,allowed_org_count,allowed_branch_count
      FROM public.petro_fleet_policy_versions p WHERE p.id=policy_id FOR UPDATE;
    IF NOT FOUND OR current_status<>'draft' THEN RAISE EXCEPTION 'DRAFT_POLICY_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF effective_at<now()
       OR allowed_org_count=0 OR allowed_branch_count=0
       OR (SELECT count(*) FROM public.petro_fleet_policy_rules r WHERE r.policy_version_id=policy_id)<>4
       OR (SELECT count(DISTINCT r.service_group) FROM public.petro_fleet_policy_rules r WHERE r.policy_version_id=policy_id)<>4
       OR (vehicle_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM public.petro_fleet_vehicles v WHERE v.id=vehicle_id AND v.status='active'))
       OR NOT EXISTS (SELECT 1 FROM public.petro_branches b WHERE b.id=branch_id) THEN
      RAISE EXCEPTION 'POLICY_MISSING_REQUIRED_SCOPE_OR_RULES' USING ERRCODE='23514';
    END IF;
    UPDATE public.petro_fleet_policy_versions SET status='published',published_by=actor,published_at=now()
      WHERE id=policy_id AND status='draft';
    result := jsonb_build_object('id',policy_id,'status','published','effectiveFrom',effective_at,
      'version',next_version);
  ELSIF p_action IN ('coverage.assign','coverage.end') THEN
    request_id := nullif(p_payload->>'assignmentId','')::uuid;
    vehicle_id := nullif(p_payload->>'vehicleId','')::uuid;
    IF p_action='coverage.assign' THEN
      request_id := (p_payload->>'subscriptionId')::uuid;
      SELECT s.organization_id,s.branch_id,s.billing_unit,s.status,s.starts_at,s.ends_at,s.units
        INTO org_id,subscription_branch_id,subscription_billing_unit,current_status,
          subscription_starts_at,subscription_ends_at,subscription_units
        FROM public.petro_subscriptions s WHERE s.id=request_id FOR UPDATE;
      IF NOT FOUND OR subscription_billing_unit<>'vehicle' OR current_status NOT IN ('active','scheduled') THEN
        RAISE EXCEPTION 'VEHICLE_SUBSCRIPTION_NOT_ELIGIBLE' USING ERRCODE='23514';
      END IF;
      requested_start := (p_payload->>'startsAt')::timestamptz;
      SELECT v.branch_id INTO branch_id
        FROM public.petro_fleet_vehicles v
        JOIN public.petro_organizations o ON o.id=v.organization_id AND o.kind='company'
        WHERE v.id=vehicle_id AND v.organization_id=org_id AND v.status='active';
      IF NOT FOUND OR (subscription_branch_id IS NOT NULL AND subscription_branch_id<>branch_id) THEN
        RAISE EXCEPTION 'VEHICLE_SUBSCRIPTION_SCOPE_MISMATCH' USING ERRCODE='23514';
      END IF;
      IF requested_start<now()
        OR requested_start<subscription_starts_at
        OR requested_start>=subscription_ends_at
        OR (SELECT count(*) FROM public.petro_subscription_vehicle_assignments a
            WHERE a.subscription_id=request_id AND a.status='active'
              AND a.starts_at<=requested_start
              AND (a.ends_at IS NULL OR a.ends_at>requested_start))
           >= subscription_units THEN
        RAISE EXCEPTION 'SUBSCRIPTION_COVERAGE_CAPACITY_OR_PERIOD_EXCEEDED' USING ERRCODE='23514';
      END IF;
      INSERT INTO public.petro_subscription_vehicle_assignments(
        subscription_id,organization_id,vehicle_id,starts_at,reason,created_by
      ) VALUES(request_id,org_id,vehicle_id,requested_start,p_reason,actor)
      RETURNING id INTO link_id;
      result := jsonb_build_object('id',link_id,'subscriptionId',request_id,'vehicleId',vehicle_id,'status','active');
    ELSE
      UPDATE public.petro_subscription_vehicle_assignments SET status='ended',ends_at=now(),
        ended_by=actor,ended_at=now(),reason=p_reason
        WHERE id=request_id AND status='active'
        RETURNING organization_id,vehicle_id,subscription_id INTO org_id,vehicle_id,policy_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'ACTIVE_COVERAGE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
      result := jsonb_build_object('id',request_id,'status','ended','subscriptionId',policy_id,'vehicleId',vehicle_id);
    END IF;
  ELSIF p_action='credential.request' THEN
    vehicle_id := (p_payload->>'vehicleId')::uuid;
    SELECT v.organization_id,v.branch_id INTO org_id,branch_id
      FROM public.petro_fleet_vehicles v WHERE v.id=vehicle_id AND v.status='active' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACTIVE_VEHICLE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    credential_type := p_payload->>'credentialType';
    IF credential_type NOT IN ('nfc','qr')
      OR (p_payload->>'requestType') NOT IN ('issue','replace') THEN
      RAISE EXCEPTION 'INVALID_CREDENTIAL_REQUEST' USING ERRCODE='22023';
    END IF;
    IF p_payload->>'requestType'='replace' THEN
      credential_id := (p_payload->>'previousCredentialId')::uuid;
      IF NOT EXISTS (SELECT 1 FROM public.petro_vehicle_credentials c
        WHERE c.id=credential_id AND c.vehicle_id=cmd.vehicle_id
          AND c.credential_type=p_payload->>'credentialType' AND c.status='active') THEN
        RAISE EXCEPTION 'ACTIVE_CREDENTIAL_NOT_FOUND' USING ERRCODE='P0002';
      END IF;
    END IF;
    SELECT nfc_issue_price_minor INTO credential_price
      FROM public.petro_billing_settings WHERE singleton_id=true;
    INSERT INTO public.petro_fleet_credential_requests(
      organization_id,branch_id,vehicle_id,credential_type,request_type,payment_state,
      issue_price_minor,previous_credential_id,reason,created_by
    ) VALUES (
      org_id,branch_id,vehicle_id,credential_type,p_payload->>'requestType',
      CASE WHEN credential_type='nfc' THEN 'awaiting_collection' ELSE 'not_required' END,
      CASE WHEN credential_type='nfc' THEN credential_price ELSE 0 END,
      nullif(p_payload->>'previousCredentialId','')::uuid,p_reason,actor
    ) RETURNING id INTO request_id;
    result := jsonb_build_object('id',request_id,'vehicleId',vehicle_id,'credentialType',credential_type,
      'requestType',p_payload->>'requestType','status','requested',
      'issuePriceMinor',CASE WHEN credential_type='nfc' THEN credential_price ELSE 0 END,
      'paymentState',CASE WHEN credential_type='nfc' THEN 'awaiting_collection' ELSE 'not_required' END);
  ELSIF p_action='credential.approve' THEN
    request_id := (p_payload->>'requestId')::uuid;
    SELECT r.vehicle_id,r.credential_type,r.organization_id,r.status
      INTO vehicle_id,credential_type,org_id,current_status
      FROM public.petro_fleet_credential_requests r
      WHERE r.id=request_id AND r.status='requested' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CREDENTIAL_REQUEST_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF coalesce((p_payload->>'waive')::boolean,false) THEN
      IF NOT EXISTS (SELECT 1 FROM public.petro_platform_roles role_row
        WHERE role_row.user_id=actor AND role_row.role='owner' AND role_row.active) THEN
        RAISE EXCEPTION 'WAIVER_REQUIRES_OWNER' USING ERRCODE='42501';
      END IF;
      UPDATE public.petro_fleet_credential_requests SET status='approved',
        payment_state=CASE WHEN credential_type='nfc' THEN 'waived' ELSE 'not_required' END,
        waiver_reason=CASE WHEN credential_type='nfc' THEN p_reason ELSE NULL END,
        approved_by=actor,approved_at=now(),updated_at=now()
        WHERE id=request_id;
    ELSE
      UPDATE public.petro_fleet_credential_requests SET status='approved',
        approved_by=actor,approved_at=now(),updated_at=now()
        WHERE id=request_id;
    END IF;
    result := jsonb_build_object('id',request_id,'vehicleId',vehicle_id,'status','approved',
      'paymentState',CASE WHEN coalesce((p_payload->>'waive')::boolean,false)
        AND credential_type='nfc' THEN 'waived'
        WHEN credential_type='nfc' THEN 'awaiting_collection' ELSE 'not_required' END);
  ELSIF p_action='credential.assign' THEN
    request_id := (p_payload->>'requestId')::uuid;
    assigned_user_id := (p_payload->>'assignedTo')::uuid;
    IF NOT EXISTS (SELECT 1 FROM public.petro_profiles profile
      WHERE profile.user_id=assigned_user_id AND profile.active)
      OR NOT EXISTS (SELECT 1 FROM public.petro_platform_roles role_row
        WHERE role_row.user_id=assigned_user_id AND role_row.active
          AND role_row.role IN ('owner','operations')) THEN
      RAISE EXCEPTION 'ASSIGNEE_NOT_AUTHORIZED' USING ERRCODE='42501';
    END IF;
    UPDATE public.petro_fleet_credential_requests SET assigned_to=assigned_user_id,
      scheduled_at=nullif(p_payload->>'scheduledAt','')::timestamptz,
      status=CASE WHEN nullif(p_payload->>'scheduledAt','') IS NULL THEN 'assigned' ELSE 'scheduled' END,
      updated_at=now()
      WHERE id=request_id AND status='approved'
      RETURNING vehicle_id,credential_type INTO vehicle_id,credential_type;
    IF NOT FOUND THEN RAISE EXCEPTION 'APPROVED_CREDENTIAL_REQUEST_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    result := jsonb_build_object('id',request_id,'status',
      CASE WHEN nullif(p_payload->>'scheduledAt','') IS NULL THEN 'assigned' ELSE 'scheduled' END,
      'assignedTo',assigned_user_id,'vehicleId',vehicle_id,'credentialType',credential_type);
  ELSIF p_action='credential.install' THEN
    request_id := (p_payload->>'requestId')::uuid;
    proof_document_id := (p_payload->>'proofDocumentId')::uuid;
    stock_unit_id := (p_payload->>'stockUnitId')::uuid;
    SELECT r.vehicle_id,r.organization_id,r.branch_id,r.credential_type,r.assigned_to
      INTO vehicle_id,org_id,branch_id,credential_type,assigned_user_id
      FROM public.petro_fleet_credential_requests r
      WHERE r.id=request_id AND r.status IN ('assigned','scheduled') FOR UPDATE;
    IF NOT FOUND OR credential_type<>'nfc'
      OR NOT EXISTS (SELECT 1 FROM public.petro_documents d
        WHERE d.id=proof_document_id AND d.vehicle_id=cmd.vehicle_id
          AND d.organization_id=org_id AND d.branch_id=cmd.branch_id
          AND d.status IN ('attached','pending_review'))
      OR NOT EXISTS (SELECT 1 FROM public.petro_fleet_tag_stock_units u
        WHERE u.id=stock_unit_id AND u.status='reserved' AND u.request_id=request_id) THEN
      RAISE EXCEPTION 'NFC_INSTALLATION_EVIDENCE_OR_STOCK_MISMATCH' USING ERRCODE='23514';
    END IF;
    UPDATE public.petro_fleet_credential_requests SET status='installed',
      proof_document_id=(p_payload->>'proofDocumentId')::uuid,
      stock_unit_id=(p_payload->>'stockUnitId')::uuid,
      replacement_ready=true,updated_at=now()
      WHERE id=request_id;
    UPDATE public.petro_fleet_tag_stock_units SET status='installed'
      WHERE id=stock_unit_id AND request_id=request_id AND status='reserved';
    INSERT INTO public.petro_fleet_tag_stock_events(unit_id,event_type,request_id,reason,actor_id)
      VALUES(stock_unit_id,'installed',request_id,p_reason,actor);
    result := jsonb_build_object('id',request_id,'status','installed','proofDocumentId',proof_document_id);
  ELSIF p_action IN ('credential.activate_qr','credential.activate_nfc') THEN
    request_id := (p_payload->>'requestId')::uuid;
    token_sha256 := p_payload->>'tokenSha256';
    token_hint := p_payload->>'tokenHint';
    SELECT r.organization_id,r.branch_id,r.vehicle_id,r.credential_type,r.request_type,
      r.status,r.payment_state,r.previous_credential_id,r.proof_document_id,r.replacement_ready,
      r.stock_unit_id
      INTO org_id,branch_id,vehicle_id,credential_type,credential_request_type,credential_request_status,
        credential_payment_state,previous_credential_id,proof_document_id,replacement_ready,request_stock_unit_id
      FROM public.petro_fleet_credential_requests r WHERE r.id=request_id FOR UPDATE;
    IF NOT FOUND OR token_sha256 !~ '^[0-9a-f]{64}$'
      OR token_hint !~ '^[0-9a-f]{6}$'
      OR (p_action='credential.activate_qr' AND credential_type<>'qr')
      OR (p_action='credential.activate_nfc' AND credential_type<>'nfc') THEN
      RAISE EXCEPTION 'CREDENTIAL_ACTIVATION_INPUT_INVALID' USING ERRCODE='22023';
    END IF;
    IF (p_action='credential.activate_qr' AND credential_request_status NOT IN ('approved','assigned','scheduled'))
      OR (p_action='credential.activate_nfc' AND (
        credential_request_status<>'installed' OR credential_payment_state<>'waived'
        OR proof_document_id IS NULL OR request_stock_unit_id IS NULL
        OR NOT replacement_ready OR credential_request_type NOT IN ('issue','replace')
        OR NOT EXISTS (SELECT 1 FROM public.petro_fleet_tag_stock_units stock
          WHERE stock.id=request_stock_unit_id
            AND stock.request_id=(p_payload->>'requestId')::uuid
            AND stock.status='installed')
      )) THEN
      RAISE EXCEPTION 'CREDENTIAL_ACTIVATION_BLOCKED' USING ERRCODE='23514';
    END IF;
    IF previous_credential_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.petro_vehicle_credentials c WHERE c.id=previous_credential_id
        AND c.vehicle_id=cmd.vehicle_id AND c.status='active'
    ) THEN RAISE EXCEPTION 'PREVIOUS_CREDENTIAL_NOT_ACTIVE' USING ERRCODE='23514'; END IF;
    IF previous_credential_id IS NOT NULL THEN
      UPDATE public.petro_vehicle_credentials SET status='replaced',revoked_by=actor,
        revoked_at=now(),reason=p_reason WHERE id=previous_credential_id AND status='active';
    END IF;
    INSERT INTO public.petro_vehicle_credentials(
      organization_id,branch_id,vehicle_id,credential_type,token_sha256,token_hint,status,
      request_id,activated_by,reason
    ) VALUES(org_id,branch_id,vehicle_id,credential_type,token_sha256,token_hint,'active',
      request_id,actor,p_reason) RETURNING id INTO link_id;
    UPDATE public.petro_fleet_credential_requests SET status='active',updated_at=now()
      WHERE id=request_id;
    result := jsonb_build_object('id',link_id,'requestId',request_id,'vehicleId',vehicle_id,
      'credentialType',credential_type,'status','active','hint',token_hint);
  ELSIF p_action='credential.stop' THEN
    credential_id := (p_payload->>'credentialId')::uuid;
    UPDATE public.petro_vehicle_credentials AS credential_row SET status='revoked',revoked_by=actor,
      revoked_at=now(),reason=p_reason WHERE id=credential_id AND status='active'
      RETURNING credential_row.vehicle_id,credential_row.organization_id INTO vehicle_id,org_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACTIVE_CREDENTIAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    result := jsonb_build_object('id',credential_id,'vehicleId',vehicle_id,'status','revoked');
  ELSIF p_action='tag_stock.receive' THEN
    INSERT INTO public.petro_fleet_tag_stock_units(unit_code,created_by)
      VALUES(btrim(p_payload->>'unitCode'),actor) RETURNING id INTO stock_unit_id;
    INSERT INTO public.petro_fleet_tag_stock_events(unit_id,event_type,reason,actor_id)
      VALUES(stock_unit_id,'received',p_reason,actor);
    result := jsonb_build_object('id',stock_unit_id,'status','available');
  ELSIF p_action='tag_stock.reserve' THEN
    request_id := (p_payload->>'requestId')::uuid;
    stock_unit_id := (p_payload->>'stockUnitId')::uuid;
    UPDATE public.petro_fleet_tag_stock_units SET status='reserved',
      request_id=(p_payload->>'requestId')::uuid
      WHERE id=stock_unit_id AND status='available';
    IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.petro_fleet_credential_requests r
      WHERE r.id=request_id AND r.credential_type='nfc'
        AND r.status IN ('approved','assigned','scheduled')) THEN
      RAISE EXCEPTION 'NFC_STOCK_RESERVATION_INVALID' USING ERRCODE='23514';
    END IF;
    UPDATE public.petro_fleet_credential_requests SET stock_unit_id=(p_payload->>'stockUnitId')::uuid,
      updated_at=now() WHERE id=request_id;
    INSERT INTO public.petro_fleet_tag_stock_events(unit_id,event_type,request_id,reason,actor_id)
      VALUES(stock_unit_id,'reserved',request_id,p_reason,actor);
    result := jsonb_build_object('id',stock_unit_id,'requestId',request_id,'status','reserved');
  ELSIF p_action='tag_stock.damage' THEN
    stock_unit_id := (p_payload->>'stockUnitId')::uuid;
    UPDATE public.petro_fleet_tag_stock_units SET status='damaged',request_id=NULL
      WHERE id=stock_unit_id AND status='available';
    IF NOT FOUND THEN RAISE EXCEPTION 'AVAILABLE_STOCK_UNIT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    INSERT INTO public.petro_fleet_tag_stock_events(unit_id,event_type,reason,actor_id)
      VALUES(stock_unit_id,'damaged',p_reason,actor);
    result := jsonb_build_object('id',stock_unit_id,'status','damaged');
  ELSIF p_action='odometer.record' THEN
    vehicle_id := (p_payload->>'vehicleId')::uuid;
    SELECT v.organization_id,v.branch_id INTO org_id,branch_id
      FROM public.petro_fleet_vehicles v WHERE v.id=vehicle_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'VEHICLE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    current_status := 'accepted';
    IF (p_payload->>'recordedAt')::timestamptz>now()
      OR EXISTS (SELECT 1 FROM public.petro_vehicle_odometer_events o
        WHERE o.vehicle_id=cmd.vehicle_id AND o.status='accepted'
          AND (p_payload->>'readingKm')::numeric<o.reading_km) THEN
      current_status := 'pending_review';
    END IF;
    proof_document_id := nullif(p_payload->>'evidenceDocumentId','')::uuid;
    IF proof_document_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.petro_documents d WHERE d.id=proof_document_id
        AND d.vehicle_id=cmd.vehicle_id AND d.organization_id=org_id AND d.branch_id=cmd.branch_id
    ) THEN RAISE EXCEPTION 'ODOMETER_EVIDENCE_SCOPE_MISMATCH' USING ERRCODE='23514'; END IF;
    IF nullif(p_payload->>'supersedesEventId','') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.petro_vehicle_odometer_events prior
        WHERE prior.id=(p_payload->>'supersedesEventId')::uuid AND prior.vehicle_id=cmd.vehicle_id) THEN
      RAISE EXCEPTION 'ODOMETER_CORRECTION_SCOPE_MISMATCH' USING ERRCODE='23514';
    END IF;
    INSERT INTO public.petro_vehicle_odometer_events(
      organization_id,branch_id,vehicle_id,reading_km,recorded_at,status,source,reason,
      evidence_document_id,supersedes_event_id,created_by
    ) VALUES(
      org_id,branch_id,vehicle_id,(p_payload->>'readingKm')::numeric,
      (p_payload->>'recordedAt')::timestamptz,current_status,
      btrim(p_payload->>'source'),p_reason,proof_document_id,
      nullif(p_payload->>'supersedesEventId','')::uuid,actor
    ) RETURNING id INTO link_id;
    IF current_status='accepted' THEN
      INSERT INTO public.petro_fleet_outbox(event_type,source_type,source_id,organization_id,scheduled_at,payload)
        SELECT 'maintenance_due','maintenance',m.id,org_id,now(),
          jsonb_build_object('vehicleId',cmd.vehicle_id,'odometerEventId',link_id)
        FROM public.petro_vehicle_maintenance_records m
        WHERE m.vehicle_id=cmd.vehicle_id AND m.status='recorded'
          AND m.next_due_km IS NOT NULL AND m.next_due_km<=(p_payload->>'readingKm')::numeric
        ON CONFLICT (event_type,source_type,source_id,scheduled_at) DO NOTHING;
    END IF;
    result := jsonb_build_object('id',link_id,'status',current_status,
      'reviewRequired',current_status='pending_review');
  ELSIF p_action='odometer.review' THEN
    link_id := (p_payload->>'eventId')::uuid;
    current_status := p_payload->>'decision';
    IF current_status NOT IN ('accepted','rejected') THEN RAISE EXCEPTION 'INVALID_ODOMETER_DECISION' USING ERRCODE='22023'; END IF;
    UPDATE public.petro_vehicle_odometer_events AS odometer_row SET status=current_status,
      reviewed_by=actor,reviewed_at=now(),review_reason=p_reason
      WHERE id=link_id AND status='pending_review'
      RETURNING odometer_row.vehicle_id,odometer_row.organization_id INTO vehicle_id,org_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'PENDING_ODOMETER_EVENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    result := jsonb_build_object('id',link_id,'vehicleId',vehicle_id,'status',current_status);
  ELSIF p_action='maintenance.create' THEN
    vehicle_id := (p_payload->>'vehicleId')::uuid;
    SELECT v.organization_id,v.branch_id INTO org_id,branch_id
      FROM public.petro_fleet_vehicles v WHERE v.id=vehicle_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'VEHICLE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    proof_document_id := nullif(p_payload->>'documentId','')::uuid;
    IF proof_document_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.petro_documents d WHERE d.id=proof_document_id
        AND d.vehicle_id=cmd.vehicle_id AND d.organization_id=org_id AND d.branch_id=cmd.branch_id
    ) THEN RAISE EXCEPTION 'MAINTENANCE_DOCUMENT_SCOPE_MISMATCH' USING ERRCODE='23514'; END IF;
    INSERT INTO public.petro_vehicle_maintenance_records(
      organization_id,branch_id,vehicle_id,maintenance_type,performed_at,odometer_event_id,
      notes,next_due_at,next_due_km,document_id,reason,created_by
    ) VALUES(
      org_id,branch_id,vehicle_id,p_payload->>'maintenanceType',
      (p_payload->>'performedAt')::timestamptz,
      nullif(p_payload->>'odometerEventId','')::uuid,btrim(p_payload->>'notes'),
      nullif(p_payload->>'nextDueAt','')::timestamptz,
      nullif(p_payload->>'nextDueKm','')::numeric,proof_document_id,p_reason,actor
    ) RETURNING id INTO link_id;
    IF nullif(p_payload->>'nextDueAt','') IS NOT NULL THEN
      INSERT INTO public.petro_fleet_outbox(event_type,source_type,source_id,organization_id,scheduled_at,payload)
        VALUES('maintenance_due','maintenance',link_id,org_id,
          (p_payload->>'nextDueAt')::timestamptz,
          jsonb_build_object('vehicleId',vehicle_id,'dueAt',p_payload->>'nextDueAt'))
        ON CONFLICT (event_type,source_type,source_id,scheduled_at) DO NOTHING;
    END IF;
    result := jsonb_build_object('id',link_id,'vehicleId',vehicle_id,'status','recorded');
  ELSIF p_action='maintenance.cancel' THEN
    link_id := (p_payload->>'maintenanceId')::uuid;
    UPDATE public.petro_vehicle_maintenance_records SET status='cancelled',
      cancelled_by=actor,cancelled_at=now(),cancel_reason=p_reason
      WHERE id=link_id AND status='recorded'
      RETURNING vehicle_id,organization_id INTO vehicle_id,org_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACTIVE_MAINTENANCE_RECORD_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    result := jsonb_build_object('id',link_id,'vehicleId',vehicle_id,'status','cancelled');
  ELSIF p_action='import.preview' THEN
    IF p_payload::text ~* '"(pin|pinCode|pinHmac|pinHash)"[[:space:]]*:' THEN
      RAISE EXCEPTION 'PIN_FIELDS_FORBIDDEN_IN_IMPORT' USING ERRCODE='22023';
    END IF;
    validation_errors := coalesce(p_payload->'validationErrors','[]'::jsonb);
    IF jsonb_typeof(validation_errors)<>'array'
      OR jsonb_typeof(coalesce(p_payload->'vehicles','[]'::jsonb))<>'array'
      OR jsonb_typeof(coalesce(p_payload->'drivers','[]'::jsonb))<>'array'
      OR jsonb_typeof(coalesce(p_payload->'policies','[]'::jsonb))<>'array' THEN
      RAISE EXCEPTION 'IMPORT_PAYLOAD_INVALID_OR_EMPTY' USING ERRCODE='22023';
    END IF;
    IF (jsonb_array_length(coalesce(p_payload->'vehicles','[]'::jsonb))
        +jsonb_array_length(coalesce(p_payload->'drivers','[]'::jsonb))
        +jsonb_array_length(coalesce(p_payload->'policies','[]'::jsonb)))=0 THEN
      RAISE EXCEPTION 'IMPORT_PAYLOAD_INVALID_OR_EMPTY' USING ERRCODE='22023';
    END IF;
    row_number := 0;
    FOR rule_row IN SELECT value FROM jsonb_array_elements(coalesce(p_payload->'vehicles','[]'::jsonb)) LOOP
      row_number := row_number+1;
      org_id := (rule_row->>'organizationId')::uuid;
      branch_id := (rule_row->>'branchId')::uuid;
      IF NOT EXISTS (SELECT 1 FROM public.petro_organizations o WHERE o.id=org_id AND o.kind='company') THEN
        validation_errors := validation_errors||jsonb_build_array(jsonb_build_object(
          'sheet','المركبات','row',row_number+1,'field','organizationId','message','الشركة غير موجودة أو غير مؤهلة.'));
      ELSIF NOT EXISTS (SELECT 1 FROM public.petro_branches b
        WHERE b.id=branch_id AND b.organization_id=org_id) THEN
        validation_errors := validation_errors||jsonb_build_array(jsonb_build_object(
          'sheet','المركبات','row',row_number+1,'field','branchId','message','الفرع لا يتبع الشركة المحددة.'));
      ELSIF EXISTS (SELECT 1 FROM public.petro_fleet_vehicles v
        WHERE v.organization_id=org_id AND lower(regexp_replace(v.plate_standard,'[[:space:]]','','g'))
          =lower(regexp_replace(btrim(rule_row->>'plateStandard'),'[[:space:]]','','g'))) THEN
        validation_errors := validation_errors||jsonb_build_array(jsonb_build_object(
          'sheet','المركبات','row',row_number+1,'field','plateStandard','message','اللوحة مسجلة مسبقًا.'));
      END IF;
    END LOOP;
    row_number := 0;
    FOR rule_row IN SELECT value FROM jsonb_array_elements(coalesce(p_payload->'drivers','[]'::jsonb)) LOOP
      row_number := row_number+1;
      org_id := (rule_row->>'organizationId')::uuid;
      IF NOT EXISTS (SELECT 1 FROM public.petro_organizations o WHERE o.id=org_id AND o.kind='company') THEN
        validation_errors := validation_errors||jsonb_build_array(jsonb_build_object(
          'sheet','السائقون','row',row_number+1,'field','organizationId','message','الشركة غير موجودة أو غير مؤهلة.'));
      ELSIF EXISTS (SELECT 1 FROM public.petro_fleet_drivers d
        WHERE d.organization_id=org_id AND lower(d.driver_code)=lower(btrim(rule_row->>'driverCode'))) THEN
        validation_errors := validation_errors||jsonb_build_array(jsonb_build_object(
          'sheet','السائقون','row',row_number+1,'field','driverCode','message','كود السائق مسجل مسبقًا.'));
      END IF;
    END LOOP;
    INSERT INTO public.petro_fleet_import_jobs(status,payload,validation_errors,created_by)
      VALUES('previewed',p_payload,validation_errors,actor)
      RETURNING id INTO request_id;
    result := jsonb_build_object('id',request_id,'status','previewed',
      'validationErrors',validation_errors,
      'vehicleCount',coalesce(jsonb_array_length(p_payload->'vehicles'),0),
      'driverCount',coalesce(jsonb_array_length(p_payload->'drivers'),0),
      'policyCount',coalesce(jsonb_array_length(p_payload->'policies'),0));
  ELSIF p_action='import.apply' THEN
    request_id := (p_payload->>'jobId')::uuid;
    SELECT j.status,j.payload,j.validation_errors INTO current_status,import_payload,validation_errors
      FROM public.petro_fleet_import_jobs j WHERE j.id=request_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'IMPORT_JOB_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF current_status='applied' THEN
      result := jsonb_build_object('id',request_id,'status','applied','replayed',true);
    ELSIF current_status<>'previewed' OR jsonb_array_length(validation_errors)>0 THEN
      RAISE EXCEPTION 'IMPORT_JOB_HAS_ERRORS_OR_IS_CLOSED' USING ERRCODE='23514';
    ELSE
      IF import_payload::text ~* '"(pin|pinCode|pinHmac|pinHash)"[[:space:]]*:' THEN
        RAISE EXCEPTION 'PIN_FIELDS_FORBIDDEN_IN_IMPORT' USING ERRCODE='22023';
      END IF;
      FOR rule_row IN SELECT value FROM jsonb_array_elements(coalesce(import_payload->'vehicles','[]'::jsonb)) LOOP
        org_id := (rule_row->>'organizationId')::uuid;
        IF NOT EXISTS (SELECT 1 FROM public.petro_organizations o WHERE o.id=org_id AND o.kind='company') THEN
          RAISE EXCEPTION 'IMPORT_COMPANY_NOT_FOUND' USING ERRCODE='23503';
        END IF;
        INSERT INTO public.petro_fleet_vehicles(
          organization_id,branch_id,plate_original,plate_standard,vehicle_category,vehicle_type,
          brand,model,model_year,chassis_number,internal_code,fuel_type,created_by,updated_by
        ) VALUES(
          org_id,(rule_row->>'branchId')::uuid,btrim(rule_row->>'plateOriginal'),
          btrim(rule_row->>'plateStandard'),btrim(rule_row->>'category'),
          btrim(rule_row->>'vehicleType'),btrim(rule_row->>'brand'),btrim(rule_row->>'model'),
          nullif(rule_row->>'modelYear','')::integer,nullif(btrim(rule_row->>'chassisNumber'),''),
          nullif(btrim(rule_row->>'internalCode'),''),btrim(rule_row->>'fuelType'),actor,actor
        ) RETURNING id INTO vehicle_id;
        INSERT INTO public.petro_fleet_events(organization_id,vehicle_id,event_type,reason,actor_id,detail)
          VALUES(org_id,vehicle_id,'vehicle_created',p_reason,actor,jsonb_build_object('importJobId',request_id));
      END LOOP;
      FOR rule_row IN SELECT value FROM jsonb_array_elements(coalesce(import_payload->'drivers','[]'::jsonb)) LOOP
        org_id := (rule_row->>'organizationId')::uuid;
        IF NOT EXISTS (SELECT 1 FROM public.petro_organizations o WHERE o.id=org_id AND o.kind='company') THEN
          RAISE EXCEPTION 'IMPORT_COMPANY_NOT_FOUND' USING ERRCODE='23503';
        END IF;
        INSERT INTO public.petro_fleet_drivers(organization_id,driver_code,full_name,phone,created_by,updated_by)
          VALUES(org_id,btrim(rule_row->>'driverCode'),btrim(rule_row->>'fullName'),
            nullif(btrim(rule_row->>'phone'),''),actor,actor) RETURNING id INTO driver_id;
        INSERT INTO public.petro_fleet_events(organization_id,driver_id,event_type,reason,actor_id,detail)
          VALUES(org_id,driver_id,'driver_created',p_reason,actor,jsonb_build_object('importJobId',request_id));
      END LOOP;
      row_number := 0;
      FOR rule_row IN SELECT value FROM jsonb_array_elements(coalesce(import_payload->'policies','[]'::jsonb)) LOOP
        row_number := row_number + 1;
        PERFORM public.petro_admin_fleet_command(
          'policy.create',rule_row,p_reason,
          request_id::text||':policy:'||row_number::text
        );
      END LOOP;
      UPDATE public.petro_fleet_import_jobs SET status='applied',applied_by=actor,applied_at=now()
        WHERE id=request_id;
      result := jsonb_build_object('id',request_id,'status','applied',
        'vehiclesApplied',coalesce(jsonb_array_length(import_payload->'vehicles'),0),
        'driversApplied',coalesce(jsonb_array_length(import_payload->'drivers'),0),
        'policyDraftsCreated',coalesce(jsonb_array_length(import_payload->'policies'),0));
    END IF;
  ELSE
    RAISE EXCEPTION 'FLEET_COMMAND_NOT_IMPLEMENTED' USING ERRCODE='0A000';
  END IF;

  INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
    VALUES(actor,org_id,'fleet.'||replace(p_action,'.','_'),
      nullif(coalesce(result->>'id',result->>'linkId',result->>'vehicleId'),'')::uuid,
      jsonb_build_object('reason',p_reason,'idempotencyKey',p_idempotency_key));
  UPDATE public.petro_fleet_idempotency SET response=result WHERE id=command_id;
  RETURN result || jsonb_build_object('replayed',false);
END
$$;

CREATE FUNCTION public.petro_admin_fleet_verify_driver_pair(p_link_id uuid, p_pin_hmac text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor uuid := auth.uid();
  v_vehicle_id uuid;
  v_driver_id uuid;
  expected_digest bytea;
  supplied_digest bytea;
  v_attempts integer;
  v_window_started_at timestamptz;
  v_locked_until timestamptz;
  diff integer := 0;
  byte_index integer;
  verification_id uuid;
BEGIN
  IF (actor IS NOT NULL AND NOT petro_private.fleet_can_manage())
    OR (actor IS NULL AND coalesce(current_setting('request.jwt.claim.role',true),'')<>'service_role') THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF p_pin_hmac !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'INVALID_PAIR_SECRET' USING ERRCODE='22023';
  END IF;
  supplied_digest := decode(p_pin_hmac,'hex');
  SELECT l.vehicle_id,l.driver_id INTO v_vehicle_id,v_driver_id
    FROM public.petro_fleet_driver_links l
    JOIN public.petro_fleet_vehicles v ON v.id=l.vehicle_id AND v.status='active'
    JOIN public.petro_fleet_drivers d ON d.id=l.driver_id AND d.status='active'
    WHERE l.id=p_link_id AND l.status='active';
  IF NOT FOUND THEN RETURN jsonb_build_object('valid',false,'locked',false); END IF;
  INSERT INTO petro_private.petro_fleet_pair_rate_limits(vehicle_id)
    VALUES(v_vehicle_id) ON CONFLICT (vehicle_id) DO NOTHING;
  SELECT failed_attempts,window_started_at,locked_until
    INTO v_attempts,v_window_started_at,v_locked_until
    FROM petro_private.petro_fleet_pair_rate_limits
    WHERE vehicle_id=v_vehicle_id FOR UPDATE;
  IF v_locked_until IS NOT NULL AND v_locked_until>now() THEN
    RETURN jsonb_build_object('valid',false,'locked',true,'retryAt',v_locked_until);
  END IF;
  IF v_window_started_at + interval '15 minutes' <= now() THEN
    v_attempts:=0;
    v_window_started_at:=now();
    v_locked_until:=NULL;
  END IF;
  SELECT s.pin_hmac INTO expected_digest
    FROM petro_private.petro_fleet_driver_pair_secrets s
    WHERE s.link_id=p_link_id AND s.vehicle_id=v_vehicle_id AND s.driver_id=v_driver_id AND s.active;
  IF FOUND THEN
    FOR byte_index IN 0..31 LOOP
      diff := diff | (get_byte(expected_digest,byte_index) # get_byte(supplied_digest,byte_index));
    END LOOP;
  ELSE
    diff := 1;
  END IF;
  IF diff=0 THEN
    UPDATE petro_private.petro_fleet_pair_rate_limits SET failed_attempts=0,
      window_started_at=now(),locked_until=NULL,updated_at=now()
      WHERE vehicle_id=v_vehicle_id;
    INSERT INTO petro_private.petro_fleet_pair_verifications(link_id,vehicle_id)
      VALUES(p_link_id,v_vehicle_id) RETURNING id INTO verification_id;
    RETURN jsonb_build_object('valid',true,'locked',false,'verificationId',verification_id);
  END IF;
  v_attempts:=v_attempts+1;
  IF v_attempts>=5 THEN v_locked_until:=now()+interval '15 minutes'; END IF;
  UPDATE petro_private.petro_fleet_pair_rate_limits SET
    failed_attempts=v_attempts,window_started_at=v_window_started_at,
    locked_until=v_locked_until,updated_at=now()
    WHERE vehicle_id=v_vehicle_id;
  RETURN jsonb_build_object('valid',false,'locked',v_locked_until IS NOT NULL,'retryAt',v_locked_until);
END
$$;

CREATE FUNCTION petro_private.can_access_fleet_document(p_object_path text,p_action text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_action IN ('read','upload') AND EXISTS (
    SELECT 1 FROM public.petro_documents d
    WHERE d.storage_path=p_object_path AND d.vehicle_id IS NOT NULL
      AND (
        (p_action='read' AND petro_private.fleet_can_read())
        OR (p_action='upload' AND d.uploader_id=auth.uid()
          AND d.status='pending_upload' AND d.upload_expires_at>now()
          AND petro_private.fleet_can_manage())
      )
  )
$$;

CREATE FUNCTION public.petro_fleet_create_vehicle_document_upload(
  p_vehicle_id uuid,p_document_type text,p_file_name text,p_content_type text,
  p_byte_size bigint,p_expires_on date
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor uuid := auth.uid();
  v_org_id uuid;
  v_branch_id uuid;
  document_id uuid;
  object_path text;
BEGIN
  IF NOT petro_private.fleet_can_manage()
    OR char_length(btrim(coalesce(p_document_type,''))) NOT BETWEEN 2 AND 80
    OR char_length(coalesce(p_file_name,'')) NOT BETWEEN 1 AND 160
    OR p_content_type NOT IN ('application/pdf','image/png','image/jpeg')
    OR p_byte_size NOT BETWEEN 1 AND 10485760 THEN
    RAISE EXCEPTION 'FORBIDDEN_OR_INVALID_DOCUMENT_INPUT' USING ERRCODE='42501';
  END IF;
  SELECT v.organization_id,v.branch_id INTO v_org_id,v_branch_id
    FROM public.petro_fleet_vehicles v WHERE v.id=p_vehicle_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'VEHICLE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  object_path := 'documents/'||gen_random_uuid()::text;
  INSERT INTO public.petro_documents(
    uploader_id,organization_id,branch_id,vehicle_id,document_type,file_name,
    content_type,byte_size,storage_path,expires_on
  ) VALUES (
    actor,v_org_id,v_branch_id,p_vehicle_id,btrim(p_document_type),p_file_name,
    p_content_type,p_byte_size,object_path,p_expires_on
  ) RETURNING id INTO document_id;
  INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
    VALUES(actor,v_org_id,'fleet.vehicle_document.upload_started',document_id,
      jsonb_build_object('vehicleId',p_vehicle_id,'mime',p_content_type,'size',p_byte_size));
  IF p_expires_on IS NOT NULL THEN
    INSERT INTO public.petro_fleet_outbox(event_type,source_type,source_id,organization_id,scheduled_at,payload)
    VALUES('document_due','document',document_id,v_org_id,
      p_expires_on::timestamp AT TIME ZONE 'Africa/Cairo',
      jsonb_build_object('vehicleId',p_vehicle_id,'documentType',p_document_type,'expiresOn',p_expires_on))
    ON CONFLICT (event_type,source_type,source_id,scheduled_at) DO NOTHING;
  END IF;
  RETURN jsonb_build_object('id',document_id,'objectPath',object_path,'bucket','petro-private-documents');
END
$$;

CREATE FUNCTION petro_private.fleet_check_usage_policy(
  p_vehicle_id uuid, p_driver_link_id uuid, p_merchant_organization_id uuid,
  p_merchant_branch_id uuid, p_service_group text, p_amount_minor bigint,
  p_quantity numeric
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_organization_id uuid;
  v_branch_id uuid;
  v_vehicle_policy public.petro_fleet_policy_versions%ROWTYPE;
  v_branch_policy public.petro_fleet_policy_versions%ROWTYPE;
  v_vehicle_rule public.petro_fleet_policy_rules%ROWTYPE;
  v_branch_rule public.petro_fleet_policy_rules%ROWTYPE;
  v_local_time timestamp;
  v_day_start timestamptz;
  v_week_start timestamptz;
  v_month_start timestamptz;
  v_day_amount bigint;
  v_week_amount bigint;
  v_month_amount bigint;
  v_day_quantity numeric;
  v_week_quantity numeric;
  v_month_quantity numeric;
  v_reason text;
BEGIN
  IF p_service_group NOT IN ('fuel','wash','oils','parts')
    OR p_amount_minor<=0 OR p_quantity<=0 THEN
    RETURN jsonb_build_object('allowed',false,'reason','invalid_request');
  END IF;
  SELECT v.organization_id,v.branch_id INTO v_organization_id,v_branch_id
    FROM public.petro_fleet_vehicles v
    WHERE v.id=p_vehicle_id AND v.status='active';
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','vehicle_not_active'); END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.petro_fleet_driver_links l
    JOIN public.petro_fleet_drivers d ON d.id=l.driver_id AND d.status='active'
    JOIN petro_private.petro_fleet_driver_pair_secrets s ON s.link_id=l.id AND s.active
    WHERE l.id=p_driver_link_id AND l.vehicle_id=p_vehicle_id
      AND l.organization_id=v_organization_id AND l.status='active'
  ) THEN RETURN jsonb_build_object('allowed',false,'reason','driver_pair_not_active'); END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.petro_subscription_vehicle_assignments a
    JOIN public.petro_subscriptions s ON s.id=a.subscription_id
    WHERE a.vehicle_id=p_vehicle_id AND a.organization_id=v_organization_id
      AND a.status='active' AND a.starts_at<=now() AND (a.ends_at IS NULL OR a.ends_at>now())
      AND s.organization_id=v_organization_id AND s.billing_unit='vehicle'
      AND s.status='active' AND s.starts_at<=now() AND s.ends_at>now()
      AND (s.cancellation_effective_at IS NULL OR s.cancellation_effective_at>now())
  ) THEN RETURN jsonb_build_object('allowed',false,'reason','subscription_coverage_required'); END IF;

  SELECT p.* INTO v_branch_policy
    FROM public.petro_fleet_policy_versions p
    WHERE p.organization_id=v_organization_id AND p.branch_id=v_branch_id
      AND p.scope_kind='branch' AND p.status='published' AND p.effective_from<=now()
    ORDER BY p.effective_from DESC,p.version_no DESC LIMIT 1;
  SELECT p.* INTO v_vehicle_policy
    FROM public.petro_fleet_policy_versions p
    WHERE p.vehicle_id=p_vehicle_id AND p.scope_kind='vehicle'
      AND p.status='published' AND p.effective_from<=now()
    ORDER BY p.effective_from DESC,p.version_no DESC LIMIT 1;
  IF v_branch_policy.id IS NULL OR v_vehicle_policy.id IS NULL THEN
    RETURN jsonb_build_object('allowed',false,'reason','policy_not_configured');
  END IF;
  v_local_time := now() AT TIME ZONE 'Africa/Cairo';
  IF NOT (v_local_time::time >= v_branch_policy.start_time
      AND v_local_time::time < v_branch_policy.end_time)
    OR NOT (extract(isodow FROM v_local_time)::smallint = ANY(v_branch_policy.allowed_weekdays))
    OR NOT (v_local_time::time >= v_vehicle_policy.start_time
      AND v_local_time::time < v_vehicle_policy.end_time)
    OR NOT (extract(isodow FROM v_local_time)::smallint = ANY(v_vehicle_policy.allowed_weekdays)) THEN
    RETURN jsonb_build_object('allowed',false,'reason','outside_allowed_schedule');
  END IF;
  IF NOT (p_merchant_organization_id = ANY(v_branch_policy.allowed_merchant_organization_ids))
    OR NOT (p_merchant_organization_id = ANY(v_vehicle_policy.allowed_merchant_organization_ids))
    OR NOT (p_merchant_branch_id = ANY(v_branch_policy.allowed_merchant_branch_ids))
    OR NOT (p_merchant_branch_id = ANY(v_vehicle_policy.allowed_merchant_branch_ids)) THEN
    RETURN jsonb_build_object('allowed',false,'reason','merchant_not_allowed');
  END IF;
  SELECT r.* INTO v_branch_rule FROM public.petro_fleet_policy_rules r
    WHERE r.policy_version_id=v_branch_policy.id AND r.service_group=p_service_group;
  SELECT r.* INTO v_vehicle_rule FROM public.petro_fleet_policy_rules r
    WHERE r.policy_version_id=v_vehicle_policy.id AND r.service_group=p_service_group;
  IF NOT FOUND OR v_branch_rule.service_group IS NULL OR NOT v_branch_rule.enabled OR NOT v_vehicle_rule.enabled THEN
    RETURN jsonb_build_object('allowed',false,'reason','service_group_not_allowed');
  END IF;
  IF p_amount_minor>v_branch_policy.max_operation_minor
    OR p_amount_minor>v_vehicle_policy.max_operation_minor
    OR p_amount_minor>v_branch_rule.max_operation_minor
    OR p_amount_minor>v_vehicle_rule.max_operation_minor
    OR p_quantity>v_branch_policy.max_operation_quantity
    OR p_quantity>v_vehicle_policy.max_operation_quantity
    OR p_quantity>v_branch_rule.max_operation_quantity
    OR p_quantity>v_vehicle_rule.max_operation_quantity THEN
    RETURN jsonb_build_object('allowed',false,'reason','operation_limit_exceeded');
  END IF;

  v_local_time := now() AT TIME ZONE 'Africa/Cairo';
  v_day_start := date_trunc('day',v_local_time) AT TIME ZONE 'Africa/Cairo';
  v_week_start := date_trunc('week',v_local_time) AT TIME ZONE 'Africa/Cairo';
  v_month_start := date_trunc('month',v_local_time) AT TIME ZONE 'Africa/Cairo';
  SELECT
    coalesce(sum(u.amount_minor) FILTER (WHERE u.created_at>=v_day_start),0)::bigint,
    coalesce(sum(u.amount_minor) FILTER (WHERE u.created_at>=v_week_start),0)::bigint,
    coalesce(sum(u.amount_minor) FILTER (WHERE u.created_at>=v_month_start),0)::bigint,
    coalesce(sum(u.quantity) FILTER (WHERE u.created_at>=v_day_start),0),
    coalesce(sum(u.quantity) FILTER (WHERE u.created_at>=v_week_start),0),
    coalesce(sum(u.quantity) FILTER (WHERE u.created_at>=v_month_start),0)
  INTO v_day_amount,v_week_amount,v_month_amount,v_day_quantity,v_week_quantity,v_month_quantity
  FROM public.petro_fleet_usage_reservations u
  WHERE u.vehicle_id=p_vehicle_id AND u.status IN ('reserved','consumed');
  IF v_day_amount+p_amount_minor>v_vehicle_policy.daily_amount_limit_minor
    OR v_week_amount+p_amount_minor>v_vehicle_policy.weekly_amount_limit_minor
    OR v_month_amount+p_amount_minor>v_vehicle_policy.monthly_amount_limit_minor
    OR v_day_quantity+p_quantity>v_vehicle_policy.daily_quantity_limit
    OR v_week_quantity+p_quantity>v_vehicle_policy.weekly_quantity_limit
    OR v_month_quantity+p_quantity>v_vehicle_policy.monthly_quantity_limit THEN
    RETURN jsonb_build_object('allowed',false,'reason','vehicle_total_limit_exceeded');
  END IF;
  SELECT
    coalesce(sum(u.amount_minor) FILTER (WHERE u.created_at>=v_day_start),0)::bigint,
    coalesce(sum(u.amount_minor) FILTER (WHERE u.created_at>=v_week_start),0)::bigint,
    coalesce(sum(u.amount_minor) FILTER (WHERE u.created_at>=v_month_start),0)::bigint,
    coalesce(sum(u.quantity) FILTER (WHERE u.created_at>=v_day_start),0),
    coalesce(sum(u.quantity) FILTER (WHERE u.created_at>=v_week_start),0),
    coalesce(sum(u.quantity) FILTER (WHERE u.created_at>=v_month_start),0)
  INTO v_day_amount,v_week_amount,v_month_amount,v_day_quantity,v_week_quantity,v_month_quantity
  FROM public.petro_fleet_usage_reservations u
  WHERE u.branch_id=v_branch_id AND u.status IN ('reserved','consumed');
  IF v_day_amount+p_amount_minor>v_branch_policy.daily_amount_limit_minor
    OR v_week_amount+p_amount_minor>v_branch_policy.weekly_amount_limit_minor
    OR v_month_amount+p_amount_minor>v_branch_policy.monthly_amount_limit_minor
    OR v_day_quantity+p_quantity>v_branch_policy.daily_quantity_limit
    OR v_week_quantity+p_quantity>v_branch_policy.weekly_quantity_limit
    OR v_month_quantity+p_quantity>v_branch_policy.monthly_quantity_limit THEN
    RETURN jsonb_build_object('allowed',false,'reason','branch_total_limit_exceeded');
  END IF;
  SELECT
    coalesce(sum(u.amount_minor) FILTER (WHERE u.created_at>=v_day_start),0)::bigint,
    coalesce(sum(u.amount_minor) FILTER (WHERE u.created_at>=v_week_start),0)::bigint,
    coalesce(sum(u.amount_minor) FILTER (WHERE u.created_at>=v_month_start),0)::bigint,
    coalesce(sum(u.quantity) FILTER (WHERE u.created_at>=v_day_start),0),
    coalesce(sum(u.quantity) FILTER (WHERE u.created_at>=v_week_start),0),
    coalesce(sum(u.quantity) FILTER (WHERE u.created_at>=v_month_start),0)
  INTO v_day_amount,v_week_amount,v_month_amount,v_day_quantity,v_week_quantity,v_month_quantity
  FROM public.petro_fleet_usage_reservations u
  WHERE u.vehicle_id=p_vehicle_id AND u.service_group=p_service_group
    AND u.status IN ('reserved','consumed');
  IF v_day_amount+p_amount_minor>v_vehicle_rule.daily_amount_limit_minor
    OR v_week_amount+p_amount_minor>v_vehicle_rule.weekly_amount_limit_minor
    OR v_month_amount+p_amount_minor>v_vehicle_rule.monthly_amount_limit_minor
    OR v_day_quantity+p_quantity>v_vehicle_rule.daily_quantity_limit
    OR v_week_quantity+p_quantity>v_vehicle_rule.weekly_quantity_limit
    OR v_month_quantity+p_quantity>v_vehicle_rule.monthly_quantity_limit THEN
    RETURN jsonb_build_object('allowed',false,'reason','vehicle_service_limit_exceeded');
  END IF;
  SELECT
    coalesce(sum(u.amount_minor) FILTER (WHERE u.created_at>=v_day_start),0)::bigint,
    coalesce(sum(u.amount_minor) FILTER (WHERE u.created_at>=v_week_start),0)::bigint,
    coalesce(sum(u.amount_minor) FILTER (WHERE u.created_at>=v_month_start),0)::bigint,
    coalesce(sum(u.quantity) FILTER (WHERE u.created_at>=v_day_start),0),
    coalesce(sum(u.quantity) FILTER (WHERE u.created_at>=v_week_start),0),
    coalesce(sum(u.quantity) FILTER (WHERE u.created_at>=v_month_start),0)
  INTO v_day_amount,v_week_amount,v_month_amount,v_day_quantity,v_week_quantity,v_month_quantity
  FROM public.petro_fleet_usage_reservations u
  WHERE u.branch_id=v_branch_id AND u.service_group=p_service_group
    AND u.status IN ('reserved','consumed');
  IF v_day_amount+p_amount_minor>v_branch_rule.daily_amount_limit_minor
    OR v_week_amount+p_amount_minor>v_branch_rule.weekly_amount_limit_minor
    OR v_month_amount+p_amount_minor>v_branch_rule.monthly_amount_limit_minor
    OR v_day_quantity+p_quantity>v_branch_rule.daily_quantity_limit
    OR v_week_quantity+p_quantity>v_branch_rule.weekly_quantity_limit
    OR v_month_quantity+p_quantity>v_branch_rule.monthly_quantity_limit THEN
    RETURN jsonb_build_object('allowed',false,'reason','branch_service_limit_exceeded');
  END IF;
  RETURN jsonb_build_object('allowed',true,'organizationId',v_organization_id,'branchId',v_branch_id,
    'branchPolicyVersionId',v_branch_policy.id,'vehiclePolicyVersionId',v_vehicle_policy.id);
END
$$;

CREATE POLICY petro_fleet_vehicle_documents_read
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id='petro-private-documents'
  AND petro_private.can_access_fleet_document(name,'read')
);
CREATE POLICY petro_fleet_vehicle_documents_upload
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id='petro-private-documents'
  AND petro_private.can_access_fleet_document(name,'upload')
);

CREATE FUNCTION public.petro_fleet_reserve_usage(
  p_vehicle_id uuid, p_driver_link_id uuid, p_pair_verification_id uuid,
  p_merchant_organization_id uuid, p_merchant_branch_id uuid, p_service_group text,
  p_amount_minor bigint, p_quantity numeric, p_request_key text, p_reason text, p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_scope jsonb;
  v_org_id uuid;
  v_branch_id uuid;
  v_account_id uuid;
  v_finance_reservation_id uuid;
  v_usage_id uuid;
  v_existing public.petro_fleet_usage_reservations%ROWTYPE;
  v_hash text;
BEGIN
  IF coalesce(current_setting('request.jwt.claim.role',true),'')<>'service_role' OR p_actor_id IS NULL
    OR char_length(coalesce(p_request_key,'')) NOT BETWEEN 16 AND 120
    OR char_length(btrim(coalesce(p_reason,''))) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'FORBIDDEN_OR_INVALID_RESERVATION' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_key,0));
  v_hash := md5(concat_ws('|',p_vehicle_id,p_driver_link_id,p_pair_verification_id,
    p_merchant_organization_id,p_merchant_branch_id,p_service_group,p_amount_minor,p_quantity));
  SELECT * INTO v_existing FROM public.petro_fleet_usage_reservations u
    WHERE u.request_key=p_request_key FOR UPDATE;
  IF FOUND THEN
    IF v_existing.payload_hash<>v_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('id',v_existing.id,'status',v_existing.status,'replayed',true,
      'branchId',v_existing.branch_id,'amountMinor',v_existing.amount_minor);
  END IF;
  SELECT v.organization_id,v.branch_id INTO v_org_id,v_branch_id
    FROM public.petro_fleet_vehicles v
    WHERE v.id=p_vehicle_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VEHICLE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM public.petro_branches b WHERE b.id=v_branch_id FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM petro_private.petro_fleet_pair_verifications pv
    JOIN public.petro_fleet_driver_links l ON l.id=pv.link_id AND l.status='active'
    JOIN petro_private.petro_fleet_driver_pair_secrets s ON s.link_id=l.id AND s.active
    WHERE pv.id=p_pair_verification_id AND pv.link_id=p_driver_link_id
      AND pv.vehicle_id=p_vehicle_id AND pv.expires_at>now() AND pv.consumed_at IS NULL
  ) THEN RAISE EXCEPTION 'DRIVER_PAIR_VERIFICATION_REQUIRED' USING ERRCODE='42501'; END IF;
  v_scope := petro_private.fleet_check_usage_policy(
    p_vehicle_id,p_driver_link_id,p_merchant_organization_id,p_merchant_branch_id,
    p_service_group,p_amount_minor,p_quantity
  );
  IF coalesce((v_scope->>'allowed')::boolean,false)=false THEN
    RAISE EXCEPTION 'FLEET_POLICY_DENIED: %',coalesce(v_scope->>'reason','not_allowed')
      USING ERRCODE='23514';
  END IF;
  v_account_id := petro_private.finance_account_for_scope(v_org_id,v_branch_id);
  IF v_account_id IS NULL THEN RAISE EXCEPTION 'BRANCH_FUNDING_ACCOUNT_MISSING' USING ERRCODE='23514'; END IF;
  INSERT INTO public.petro_fleet_usage_reservations(
    organization_id,branch_id,vehicle_id,driver_link_id,service_group,
    merchant_organization_id,merchant_branch_id,amount_minor,quantity,
    request_key,payload_hash,vehicle_policy_version_id,branch_policy_version_id,created_by
  ) VALUES (
    v_org_id,v_branch_id,p_vehicle_id,p_driver_link_id,p_service_group,
    p_merchant_organization_id,p_merchant_branch_id,p_amount_minor,p_quantity,
    p_request_key,v_hash,(v_scope->>'vehiclePolicyVersionId')::uuid,
    (v_scope->>'branchPolicyVersionId')::uuid,p_actor_id
  ) RETURNING id INTO v_usage_id;
  v_finance_reservation_id := petro_private.finance_reserve_funds(
    v_account_id,'fleet_usage',v_usage_id,p_amount_minor,p_reason,p_actor_id
  );
  UPDATE public.petro_fleet_usage_reservations SET finance_reservation_id=v_finance_reservation_id
    WHERE id=v_usage_id;
  UPDATE petro_private.petro_fleet_pair_verifications SET consumed_at=now()
    WHERE id=p_pair_verification_id AND consumed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'DRIVER_PAIR_VERIFICATION_ALREADY_USED' USING ERRCODE='40001'; END IF;
  RETURN jsonb_build_object('id',v_usage_id,'status','reserved','replayed',false,
    'branchId',v_branch_id,'amountMinor',p_amount_minor,'financeReservationId',v_finance_reservation_id);
END
$$;

CREATE FUNCTION public.petro_fleet_release_usage(p_usage_id uuid,p_actor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_usage public.petro_fleet_usage_reservations%ROWTYPE;
BEGIN
  IF coalesce(current_setting('request.jwt.claim.role',true),'')<>'service_role' OR p_actor_id IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_usage FROM public.petro_fleet_usage_reservations
    WHERE id=p_usage_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_USAGE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_usage.status='released' THEN
    RETURN jsonb_build_object('id',v_usage.id,'status','released','replayed',true);
  END IF;
  IF v_usage.status<>'reserved' OR v_usage.finance_reservation_id IS NULL THEN
    RAISE EXCEPTION 'FLEET_USAGE_NOT_RELEASABLE' USING ERRCODE='55000';
  END IF;
  PERFORM petro_private.finance_release_reservation(v_usage.finance_reservation_id,p_actor_id);
  UPDATE public.petro_fleet_usage_reservations SET status='released',closed_at=now()
    WHERE id=v_usage.id AND status='reserved';
  INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
    VALUES(p_actor_id,v_usage.organization_id,'fleet.usage.released',v_usage.id,
      jsonb_build_object('branchId',v_usage.branch_id,'amountMinor',v_usage.amount_minor));
  RETURN jsonb_build_object('id',v_usage.id,'status','released','replayed',false);
END
$$;

CREATE FUNCTION public.petro_fleet_consume_usage(
  p_usage_id uuid,p_journal_entry_id uuid,p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_usage public.petro_fleet_usage_reservations%ROWTYPE;
BEGIN
  IF coalesce(current_setting('request.jwt.claim.role',true),'')<>'service_role' OR p_actor_id IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_usage FROM public.petro_fleet_usage_reservations
    WHERE id=p_usage_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_USAGE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_usage.status='consumed' AND v_usage.consumed_entry_id=p_journal_entry_id THEN
    RETURN jsonb_build_object('id',v_usage.id,'status','consumed','journalEntryId',p_journal_entry_id,'replayed',true);
  END IF;
  IF v_usage.status<>'reserved' OR v_usage.finance_reservation_id IS NULL THEN
    RAISE EXCEPTION 'FLEET_USAGE_NOT_CONSUMABLE' USING ERRCODE='55000';
  END IF;
  PERFORM petro_private.finance_consume_reservation(v_usage.finance_reservation_id,p_journal_entry_id);
  UPDATE public.petro_fleet_usage_reservations SET status='consumed',closed_at=now(),
    consumed_entry_id=p_journal_entry_id
    WHERE id=v_usage.id AND status='reserved';
  INSERT INTO public.petro_audit_events(actor_id,organization_id,action,target_id,detail)
    VALUES(p_actor_id,v_usage.organization_id,'fleet.usage.consumed',v_usage.id,
      jsonb_build_object('journalEntryId',p_journal_entry_id,'branchId',v_usage.branch_id,
        'amountMinor',v_usage.amount_minor));
  RETURN jsonb_build_object('id',v_usage.id,'status','consumed','journalEntryId',p_journal_entry_id,'replayed',false);
END
$$;

REVOKE ALL ON FUNCTION petro_private.fleet_can_read() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION petro_private.fleet_can_manage() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION petro_private.can_access_fleet_document(text,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION petro_private.fleet_check_usage_policy(uuid,uuid,uuid,uuid,text,bigint,numeric)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.petro_admin_fleet_catalog(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.petro_admin_fleet_command(text,jsonb,text,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.petro_admin_fleet_verify_driver_pair(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.petro_fleet_create_vehicle_document_upload(uuid,text,text,text,bigint,date)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.petro_fleet_reserve_usage(uuid,uuid,uuid,uuid,uuid,text,bigint,numeric,text,text,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.petro_fleet_release_usage(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.petro_fleet_consume_usage(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.petro_admin_fleet_catalog(text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_admin_fleet_command(text,jsonb,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_admin_fleet_verify_driver_pair(uuid,text) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.petro_fleet_create_vehicle_document_upload(uuid,text,text,text,bigint,date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.petro_fleet_reserve_usage(uuid,uuid,uuid,uuid,uuid,text,bigint,numeric,text,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.petro_fleet_release_usage(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.petro_fleet_consume_usage(uuid,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION petro_private.can_access_fleet_document(text,text) TO authenticated;

COMMIT;
