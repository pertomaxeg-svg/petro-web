import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const PROJECT_REF = "msvgzsfzrqlrfpstthhe";
const EXPECTED_LEGACY_FUNCTION_MD5 = "d6a0defdb1102d00b0743723db453bad";
const EXPECTED_MIGRATIONS = [
  {
    name: "0008_platform_user_administration",
    file: "0008_platform_user_administration.sql",
    sha256: "0b913746970a7f0c8337de55afc1ac2f11c36f8e8f02e4f578b9c630aa5cd1a4",
    probes: [
      ["function", "public.petro_admin_list_platform_users(integer,integer,text,text,text)"],
      ["function", "public.petro_admin_get_platform_user(uuid)"],
      ["function", "public.petro_admin_set_platform_roles(uuid,text[],text)"],
      ["function", "public.petro_admin_set_account_status(uuid,text,text)"],
    ],
  },
  {
    name: "0010_plan_subscription_admin",
    file: "0010_plan_subscription_admin.sql",
    sha256: "1cf42d340414865e016de0521f90d237a1173a84bc0549e43a1acb475917d1e6",
    probes: [
      ["table", "public.petro_plan_price_overrides"],
      ["table", "public.petro_subscription_requests"],
      ["table", "public.petro_subscriptions"],
      ["column", "public", "petro_plans", "stop_new_at"],
      ["column", "public", "petro_plan_versions", "publication_status"],
      ["column", "public", "petro_plan_versions", "billing_cycle"],
      ["column", "public", "petro_plan_versions", "currency"],
      ["column", "public", "petro_plan_versions", "entitlements"],
      ["column", "public", "petro_plan_versions", "settings"],
      ...[
        "petro_billing_admin_catalog",
        "petro_billing_admin_create_plan",
        "petro_billing_admin_add_plan_version",
        "petro_billing_admin_publish_plan_version",
        "petro_billing_admin_set_plan_stop",
        "petro_billing_admin_create_request",
        "petro_billing_admin_review_request",
        "petro_billing_admin_cancel_subscription",
      ].map((name) => ["functionName", "public", name]),
      ...[
        "guard_plan_version_immutability",
        "guard_subscription_snapshot",
        "plan_admin_authorized",
        "subscription_allows_new_service",
      ].map((name) => ["functionName", "petro_private", name]),
    ],
  },
  {
    name: "0011_plan_authoring_and_provider_pricing",
    file: "0011_plan_authoring_and_provider_pricing.sql",
    sha256: "1f238d233924480f8e03a762805840367b3ca5616679820e913d0a53f709117a",
    probes: [
      ["table", "public.petro_billing_settings"],
      ["column", "public", "petro_plans", "description"],
      ["column", "public", "petro_plan_versions", "display_name"],
      ["column", "public", "petro_plan_versions", "description"],
      ["column", "public", "petro_plan_price_overrides", "supersedes_override_id"],
      ["index", "public", "petro_plan_price_overrides_supersedes_unique"],
      ...[
        "petro_billing_admin_create_plan_v2",
        "petro_billing_admin_add_plan_version_v2",
        "petro_billing_admin_update_draft_version",
        "petro_billing_admin_update_price_defaults",
        "petro_billing_admin_set_provider_price_override",
        "petro_billing_admin_catalog_v2",
      ].map((name) => ["functionName", "public", name]),
      ["billingSettingsDefaults"],
    ],
    postconditions: [["requestTypeConstraint"]],
  },
  {
    name: "0012_finance_core",
    file: "0012_finance_core.sql",
    sha256: "b0c78f1dbc4c12fe71e2c03293f3fd035ea0f3a6b538463f0a15d1f3ef37a997",
    probes: [
      ...[
        "petro_finance_settings",
        "petro_finance_bank_accounts",
        "petro_finance_accounts",
        "petro_finance_journal_entries",
        "petro_finance_journal_lines",
        "petro_finance_topup_requests",
        "petro_finance_bank_reference_registry",
        "petro_finance_bank_receipts",
        "petro_finance_receipt_allocations",
        "petro_finance_subscription_collections",
        "petro_finance_transfers",
        "petro_finance_reservations",
        "petro_finance_commands",
        "petro_finance_outbox",
      ].map((name) => ["table", `public.${name}`]),
      ["table", "public.petro_finance_account_balances"],
      ["column", "public", "petro_documents", "finance_topup_request_id"],
      ["column", "public", "petro_documents", "finance_subscription_request_id"],
      ["column", "public", "petro_documents", "finance_bank_receipt_id"],
      ["constraint", "public.petro_documents", "petro_documents_finance_context_check"],
      ...[
        "petro_finance_bank_account_identity_unique",
        "petro_finance_bank_accounts_queue",
        "petro_finance_company_funding_account_unique",
        "petro_finance_branch_funding_account_unique",
        "petro_finance_bank_clearing_account_unique",
        "petro_finance_control_account_unique",
        "petro_finance_journal_reference_unique",
        "petro_finance_journal_one_reversal",
        "petro_finance_journal_scope_time",
        "petro_finance_journal_type_time",
        "petro_finance_journal_lines_entry_idx",
        "petro_finance_journal_lines_account_idx",
        "petro_finance_topup_queue",
        "petro_finance_topup_org",
        "petro_finance_topup_reference_unique",
        "petro_finance_receipts_time",
        "petro_finance_receipt_reference_unique",
        "petro_finance_allocations_receipt",
        "petro_finance_allocations_target",
        "petro_finance_subscription_collections_status",
        "petro_finance_subscription_collections_org",
        "petro_finance_transfer_reference_unique",
        "petro_finance_transfer_org_time",
        "petro_finance_reservation_active_source",
        "petro_finance_reservations_account_status",
        "petro_finance_outbox_source_unique",
        "petro_finance_outbox_pending",
        "petro_documents_finance_topup_idx",
        "petro_documents_finance_subscription_idx",
        "petro_documents_finance_receipt_idx",
      ].map((name) => ["index", "public", name]),
      ...[
        "petro_finance_admin_summary",
        "petro_finance_admin_organizations",
        "petro_finance_admin_accounts",
        "petro_finance_admin_bank_accounts",
        "petro_finance_admin_add_bank_account",
        "petro_finance_admin_approve_bank_account",
        "petro_finance_admin_create_topup",
        "petro_finance_admin_update_topup",
        "petro_finance_admin_submit_topup",
        "petro_finance_admin_review_topup",
        "petro_finance_admin_list_topups",
        "petro_finance_admin_topup_detail",
        "petro_finance_admin_disable_bank_account",
        "petro_finance_admin_record_receipt",
        "petro_finance_admin_approve_topup",
        "petro_finance_admin_list_receipts",
        "petro_finance_admin_allocate_receipt",
        "petro_finance_admin_transfer",
        "petro_finance_admin_list_transfers",
        "petro_finance_admin_list_subscriptions",
        "petro_finance_admin_list_journal",
        "petro_finance_admin_journal_detail",
        "petro_finance_admin_reconciliation",
        "petro_finance_admin_reverse_journal",
        "petro_finance_create_document_upload",
      ].map((name) => ["functionName", "public", name]),
      ...[
        "finance_can_read",
        "finance_can_mutate",
        "finance_can_submit",
        "finance_begin_command",
        "finance_finish_command",
        "finance_post_entry",
        "finance_account_for_scope",
        "finance_bank_asset",
        "finance_normalize_reference",
        "guard_finance_journal_immutable",
        "assert_finance_entry_balanced",
        "finance_record_receipt",
        "finance_allocate_receipt",
        "finance_reserve_funds",
        "finance_release_reservation",
        "can_read_finance_document",
      ].map((name) => ["functionName", "petro_private", name]),
      ["trigger", "public.petro_finance_journal_entries", "petro_finance_journal_entries_immutable"],
      ["trigger", "public.petro_finance_journal_lines", "petro_finance_journal_lines_immutable"],
      ["policy", "public", "petro_documents", "petro_finance_documents_read"],
      ["policy", "storage", "objects", "petro_finance_storage_evidence_read"],
       ["financeJournalEntryTypeConstraint"],
    ],
    postconditions: [
      ["financeRls"],
      ["financeNoDirectTableAccess"],
      ["financeAdminFunctionPrivileges"],
      ["financePrivateFunctionPrivileges"],
    ],
  },
  {
    name: "0013_finance_receipt_detail_and_reservation_capture",
    file: "0013_finance_receipt_detail_and_reservation_capture.sql",
    sha256: "e42a9974d238b30687794959514a95d20a5d39e01d1c6e849060e861a0e73862",
    probes: [
      ["column", "public", "petro_finance_reservations", "consumed_entry_id"],
      ["constraint", "public.petro_finance_reservations", "petro_finance_reservation_consumed_entry_check"],
      ["financeJournalEntryTypeConstraintPost0013"],
      ["functionName", "public", "petro_finance_admin_receipt_detail"],
      ["functionName", "petro_private", "finance_consume_reservation"],
    ],
    postconditions: [
      ["financeAdminFunctionPrivilegesPost0013"],
      ["financePrivateFunctionPrivileges"],
    ],
  },
  {
    name: "0014_fleet_registry_and_controls",
    file: "0014_fleet_registry_and_controls.sql",
    sha256: "fe0ab7cbbd9f97d02ea18fabd938b36eab21a57efb462b6bff925c5de25b2357",
    probes: [
      ...[
        "petro_fleet_vehicles",
        "petro_fleet_drivers",
        "petro_fleet_driver_links",
        "petro_fleet_events",
        "petro_fleet_policy_versions",
        "petro_fleet_policy_rules",
        "petro_fleet_usage_reservations",
        "petro_subscription_vehicle_assignments",
        "petro_vehicle_credentials",
        "petro_fleet_credential_requests",
        "petro_fleet_tag_stock_units",
        "petro_fleet_tag_stock_events",
        "petro_vehicle_odometer_events",
        "petro_vehicle_maintenance_records",
        "petro_fleet_import_jobs",
        "petro_fleet_outbox",
        "petro_fleet_idempotency",
      ].map((name) => ["table", `public.${name}`]),
      ...[
        "petro_fleet_driver_pair_secrets",
        "petro_fleet_pair_rate_limits",
        "petro_fleet_pair_verifications",
      ].map((name) => ["table", `petro_private.${name}`]),
      ["column", "public", "petro_documents", "vehicle_id"],
      ...[
        "petro_fleet_vehicles_org_internal_code_unique",
        "petro_fleet_driver_links_active_pair_unique",
        "petro_fleet_policy_branch_version_unique",
        "petro_fleet_policy_vehicle_version_unique",
        "petro_subscription_vehicle_assignments_active_vehicle_unique",
        "petro_vehicle_credentials_one_active_type_per_vehicle",
        "petro_fleet_credential_open_request_unique",
      ].map((name) => ["index", "public", name]),
      ...[
        "petro_fleet_driver_pair_secrets_active_link_unique",
        "petro_fleet_driver_pair_secrets_active_pin_per_vehicle_unique",
      ].map((name) => ["index", "petro_private", name]),
      ...[
        "public.petro_admin_fleet_catalog(text,jsonb)",
        "public.petro_admin_fleet_command(text,jsonb,text,text)",
        "public.petro_admin_fleet_verify_driver_pair(uuid,text)",
        "public.petro_fleet_create_vehicle_document_upload(uuid,text,text,text,bigint,date)",
        "public.petro_fleet_reserve_usage(uuid,uuid,uuid,uuid,uuid,text,bigint,numeric,text,text,uuid)",
        "public.petro_fleet_release_usage(uuid,uuid)",
        "public.petro_fleet_consume_usage(uuid,uuid,uuid)",
        "petro_private.fleet_can_read()",
        "petro_private.fleet_can_manage()",
        "petro_private.can_access_fleet_document(text,text)",
        "petro_private.fleet_check_usage_policy(uuid,uuid,uuid,uuid,text,bigint,numeric)",
      ].map((signature) => ["function", signature]),
      ["policy", "storage", "objects", "petro_fleet_vehicle_documents_read"],
      ["policy", "storage", "objects", "petro_fleet_vehicle_documents_upload"],
      ["fleetRls"],
      ["fleetNoDirectTableAccess"],
      ["fleetFunctionPrivileges"],
    ],
    postconditions: [
      ["fleetRls"],
      ["fleetNoDirectTableAccess"],
      ["fleetFunctionPrivileges"],
    ],
  },
  {
    name: "0015_fleet_subscription_options",
    file: "0015_fleet_subscription_options.sql",
    sha256: "e3d6ed52f5a4bb6c6059bfaba085c5724f998a597a8b9332b59cb9341e7fa4b4",
    probes: [
      ["function", "public.petro_admin_fleet_assign_coverage(jsonb,text,text)"],
      ["function", "public.petro_admin_fleet_subscription_options(uuid,text,integer,integer)"],
      ["function", "public.petro_admin_fleet_stock_options(text,integer,integer)"],
    ],
    postconditions: [["fleet0015FunctionPrivileges"]],
  },
  {
    name: "0016_fleet_history_and_admin_directory",
    file: "0016_fleet_history_and_admin_directory.sql",
    sha256: "60c94d0f5916383a8f4dfbbf634fc7c7aa5426868519f0e21cb421fab04f7245",
    probes: [
      ["table", "public.petro_fleet_consumption_rate_versions"],
      ["index", "public", "petro_fleet_consumption_company_version_unique"],
      ["index", "public", "petro_fleet_consumption_branch_version_unique"],
      ["index", "public", "petro_fleet_consumption_rate_history_idx"],
      ["trigger", "public.petro_fleet_vehicles", "petro_fleet_vehicle_move_reserved_guard"],
      ["trigger", "public.petro_fleet_consumption_rate_versions", "petro_fleet_consumption_rate_append_only"],
      ["constraint", "public.petro_fleet_usage_reservations", "petro_fleet_usage_reservation_branch_scope_fk"],
      ["constraint", "public.petro_vehicle_credentials", "petro_vehicle_credentials_branch_scope_fk"],
      ["constraint", "public.petro_fleet_credential_requests", "petro_fleet_credential_requests_branch_scope_fk"],
      ["constraint", "public.petro_vehicle_odometer_events", "petro_vehicle_odometer_events_branch_scope_fk"],
      ["constraint", "public.petro_vehicle_maintenance_records", "petro_vehicle_maintenance_records_branch_scope_fk"],
      ...[
        "public.petro_admin_fleet_company_summaries(uuid,text,integer,integer)",
        "public.petro_admin_fleet_driver_detail(uuid)",
        "public.petro_admin_fleet_stock_reservations(text,integer,integer)",
        "public.petro_admin_fleet_consumption_rates(uuid,uuid)",
        "public.petro_admin_fleet_set_consumption_rate(uuid,uuid,numeric,text,text)",
        "petro_private.prevent_fleet_move_with_reserved_usage()",
        "petro_private.fleet_check_usage_policy_at(uuid,uuid,uuid,uuid,text,bigint,numeric,timestamptz)",
        "petro_private.prevent_fleet_consumption_rate_mutation()",
      ].map((signature) => ["function", signature]),
      ["fleet0016PostConstraints"],
      ["fleet0016Rls"],
      ["fleet0016NoDirectTableAccess"],
      ["fleet0016FunctionPrivileges"],
      ["fleet0016PrivateFunctionPrivileges"],
    ],
    postconditions: [
      ["fleet0016PostConstraints"],
      ["fleet0016Rls"],
      ["fleet0016NoDirectTableAccess"],
      ["fleet0016FunctionPrivileges"],
      ["fleet0016PrivateFunctionPrivileges"],
    ],
  },
  {
    name: "0017_catalog_services_and_fuel_pricing",
    file: "0017_catalog_services_and_fuel_pricing.sql",
    sha256: "f582fd44dfb7b314149d0810a8fe24ad8132f12ad56b3704e2725b032a6c7710",
    probes: [
      ...[
        "petro_catalog_units",
        "petro_catalog_categories",
        "petro_fuel_types",
        "petro_catalog_items",
        "petro_catalog_branch_availability",
        "petro_catalog_price_versions",
        "petro_fuel_price_versions",
        "petro_catalog_images",
        "petro_catalog_idempotency",
      ].map((name) => ["table", `public.${name}`]),
      ["column", "public", "petro_catalog_items", "central_suspended"],
      ...[
        "petro_catalog_items_org_internal_code_unique",
        "petro_catalog_items_org_barcode_unique",
        "petro_catalog_items_org_status_idx",
        "petro_catalog_items_category_idx",
        "petro_catalog_branch_availability_branch_idx",
        "petro_catalog_price_scope_time_idx",
        "petro_fuel_price_type_time_idx",
        "petro_catalog_images_item_status_idx",
      ].map((name) => ["index", "public", name]),
      ...[
        "public.petro_catalog_admin_categories()",
        "public.petro_catalog_reference_data()",
        "public.petro_catalog_admin_organizations(text,text,integer,integer)",
        "public.petro_catalog_admin_fuel_list(text,integer,integer)",
        "public.petro_catalog_list_items(uuid,uuid,text,text,text,text,integer,integer)",
        "public.petro_catalog_item_detail(uuid)",
        "public.petro_catalog_fuel_preview(uuid,numeric,bigint)",
        "public.petro_catalog_command(text,jsonb,text,text)",
        "public.petro_catalog_image_upload_info(uuid)",
        "public.petro_catalog_image_download_info(uuid)",
        "public.petro_catalog_image_complete(uuid,text)",
        "public.petro_catalog_image_fail(uuid)",
        "petro_private.catalog_is_admin(boolean)",
        "petro_private.catalog_can_read_org(uuid,uuid)",
        "petro_private.catalog_merchant_can_manage_org(uuid,uuid)",
        "petro_private.catalog_attributes_valid(text,jsonb)",
        "petro_private.catalog_command_begin(uuid,text,jsonb,text,text)",
        "petro_private.catalog_command_finish(uuid,text,jsonb)",
        "petro_private.catalog_can_access_image(text,text)",
      ].map((signature) => ["function", signature]),
      ["policy", "storage", "objects", "petro_catalog_image_read"],
      ["policy", "storage", "objects", "petro_catalog_image_upload"],
      ["policy", "storage", "objects", "petro_catalog_image_delete_pending"],
      ["catalogRls"],
      ["catalogNoDirectTableAccess"],
      ["catalogFunctionPrivileges"],
      ["catalogPrivateFunctionPrivileges"],
      ["catalogStoragePolicies"],
    ],
    postconditions: [
      ["catalogRls"],
      ["catalogNoDirectTableAccess"],
      ["catalogFunctionPrivileges"],
      ["catalogPrivateFunctionPrivileges"],
      ["catalogStoragePolicies"],
    ],
  },
  {
    name: "0018_catalog_contract_guards",
    file: "0018_catalog_contract_guards.sql",
    sha256: "21b58e05ef327ec034cd42827bc87e73cd6df33e6c3f5d959f0408455f51ab0a",
    probes: [["catalogContractGuards"]],
    postconditions: [
      ["catalogContractGuards"],
      ["catalogPrivateFunctionPrivileges"],
      ["function", "petro_private.catalog_attributes_valid(text,jsonb)"],
      ["function", "petro_private.guard_catalog_wash_variant()"],
      ["function", "petro_private.guard_fuel_type_unit()"],
      ["function", "petro_private.petro_valid_branch_hours(jsonb)"],
    ],
  },
  {
    name: "0019_wash_variant_update_guard",
    file: "0019_wash_variant_update_guard.sql",
    sha256: "fbfbbc17373bdfe4859566c82189b3d892c3b84d92fa923b8980a4cb9b173156",
    probes: [["catalogWashUpdateGuard"]],
    postconditions: [
      ["catalogWashUpdateGuard"],
      ["function", "petro_private.guard_catalog_wash_variant_update()"],
    ],
  },
  {
    name: "0020_platform_user_temporary_passwords",
    file: "0020_platform_user_temporary_passwords.sql",
    sha256: "a99001b508848f9564ce7817d9bf984e239dee19e24e723c17a5be06a8578ef0",
    probes: [
      ["column", "public", "petro_profiles", "password_change_required"],
      ["function", "public.petro_admin_create_platform_user_access(uuid,text[],text)"],
      ["functionName", "public", "petro_admin_create_platform_user_access"],
    ],
    postconditions: [
      ["platformUserTemporaryPasswordContract"],
      ["platformUserTemporaryPasswordPrivileges"],
      ["platformUserTemporaryPasswordDefinition"],
    ],
  },
  {
    name: "0021_inventory_and_plan_draft_repair",
    file: "0021_inventory_and_plan_draft_repair.sql",
    sha256: "31370320648dc88d85115ef96066f137f7008f57df0d3aaa04d98426c8dbc7b7",
    probes: [
      ...[
        "petro_inventory_locations",
        "petro_inventory_balances",
        "petro_inventory_documents",
        "petro_inventory_document_lines",
        "petro_inventory_reservations",
        "petro_inventory_movements",
        "petro_inventory_commands",
      ].map((name) => ["table", `public.${name}`]),
      ["function", "public.petro_inventory_admin_query(text,jsonb)"],
      ["function", "public.petro_inventory_admin_command(text,jsonb,text)"],
      ["function", "public.petro_inventory_admin_reconcile(uuid)"],
      ["function", "petro_private.inventory_can_read(uuid,uuid)"],
      ["function", "petro_private.inventory_can_write(uuid,uuid,boolean)"],
      ["function", "petro_private.inventory_validate_item(uuid,uuid,numeric,boolean)"],
      ["function", "petro_private.inventory_apply_delta(uuid,uuid,uuid,numeric,numeric,uuid,uuid,text,text)"],
      ["function", "petro_private.inventory_guard_immutable()"],
      ["trigger", "public.petro_inventory_movements", "petro_inventory_movements_immutable"],
      ["planDraftVersionDefinition"],
      ["inventoryRls"],
      ["inventoryNoDirectTableAccess"],
      ["inventoryFunctionPrivileges"],
    ],
    postconditions: [
      ["planDraftVersionDefinition"],
      ["inventoryRls"],
      ["inventoryNoDirectTableAccess"],
      ["inventoryFunctionPrivileges"],
    ],
  },
];

const inputFlags = new Set(process.argv.slice(2).filter((flag) => flag !== "--"));
const apply = inputFlags.has("--apply");
const migrationFlags = [...inputFlags].filter((flag) => flag.startsWith("--migration="));
if (migrationFlags.length > 1) throw new Error("Select at most one migration per apply run.");
const selectedMigrationName = migrationFlags[0]?.slice("--migration=".length);
for (const flag of inputFlags) {
  if (
    flag !== "--apply"
    && flag !== `--project-ref=${PROJECT_REF}`
    && !flag.startsWith("--migration=")
  ) {
    throw new Error(`Unsupported argument: ${flag}`);
  }
}
if (apply && !inputFlags.has(`--project-ref=${PROJECT_REF}`)) {
  throw new Error(`Applying requires the explicit --project-ref=${PROJECT_REF} confirmation.`);
}
if (apply && !selectedMigrationName) {
  throw new Error("Applying requires exactly one explicit --migration=<approved-name> selection.");
}
if (selectedMigrationName && !EXPECTED_MIGRATIONS.some((migration) => migration.name === selectedMigrationName)) {
  throw new Error(`Migration is not in the approved allowlist: ${selectedMigrationName}`);
}

function loadDatabaseOptions() {
  const supabaseUrlText = process.env.SUPABASE_URL?.trim();
  const databaseUrlText = process.env.SUPABASE_DB_URL?.trim();
  if (!supabaseUrlText || !databaseUrlText) {
    throw new Error("SUPABASE_URL and SUPABASE_DB_URL must be configured in the workspace environment.");
  }
  const supabaseUrl = new URL(supabaseUrlText);
  if (supabaseUrl.protocol !== "https:" || supabaseUrl.hostname.toLowerCase() !== `${PROJECT_REF}.supabase.co`) {
    throw new Error("SUPABASE_URL does not identify the approved Pertomax EG project.");
  }

  const databaseUrl = new URL(databaseUrlText);
  if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)) {
    throw new Error("SUPABASE_DB_URL must use the PostgreSQL protocol.");
  }
  const usesDirectHost = databaseUrl.hostname.toLowerCase() === `db.${PROJECT_REF}.supabase.co`;
  const poolerParts = databaseUrl.username.split(".");
  const usesApprovedPooler =
    databaseUrl.hostname.toLowerCase().endsWith(".pooler.supabase.com")
    && poolerParts.includes(PROJECT_REF);
  if (!usesDirectHost && !usesApprovedPooler) {
    throw new Error("SUPABASE_DB_URL does not identify the approved Pertomax EG project.");
  }
  const sslMode = databaseUrl.searchParams.get("sslmode")?.toLowerCase();
  if (!databaseUrl.username || !databaseUrl.password || !["require", "verify-ca", "verify-full"].includes(sslMode)) {
    throw new Error("The approved PostgreSQL connection must include credentials and require SSL.");
  }
  for (const parameter of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) {
    databaseUrl.searchParams.delete(parameter);
  }
  const rootCaPath = fileURLToPath(new URL("../../../attached_assets/0_prod-ca-2021_1791951896116.crt", import.meta.url));
  return {
    connectionString: databaseUrl.toString(),
    ssl: { ca: readFileSync(rootCaPath, "utf8"), rejectUnauthorized: true },
    connectionTimeoutMillis: 10_000,
    application_name: "pertomax-approved-admin-migrations",
  };
}

function hash(text) {
  return createHash("sha256").update(text).digest("hex");
}

function loadMigrations() {
  return EXPECTED_MIGRATIONS.map((spec) => {
    const path = new URL(`../migrations/${spec.file}`, import.meta.url);
    const source = readFileSync(path, "utf8").replaceAll("\r\n", "\n");
    if (hash(source) !== spec.sha256) {
      throw new Error(`Approved migration fingerprint mismatch: ${spec.file}`);
    }
    if (!/^\s*BEGIN;\s*/i.test(source) || !/\s*COMMIT;\s*$/i.test(source)) {
      throw new Error(`Migration must have explicit transaction wrappers: ${spec.file}`);
    }
    const body = source.replace(/^\s*BEGIN;\s*/i, "").replace(/\s*COMMIT;\s*$/i, "");
    return { ...spec, source, body };
  });
}

function compareRows(a, b) {
  const aKey = a.map(String).join("\u001f");
  const bKey = b.map(String).join("\u001f");
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

async function getDefaultAcl(client) {
  const { rows: scopeRows } = await client.query("SELECT count(*)::int AS count FROM pg_default_acl");
  const { rows } = await client.query(`
    SELECT owner.rolname AS owner_role, schema_name.nspname AS schema_name,
           acl.defaclobjtype::text AS object_type, COALESCE(grantee.rolname, 'PUBLIC') AS grantee,
           entry.privilege_type AS privilege, entry.is_grantable
    FROM pg_default_acl acl
    JOIN pg_roles owner ON owner.oid=acl.defaclrole
    JOIN pg_namespace schema_name ON schema_name.oid=acl.defaclnamespace
    CROSS JOIN LATERAL aclexplode(acl.defaclacl) entry
    LEFT JOIN pg_roles grantee ON grantee.oid=entry.grantee
    ORDER BY owner_role, schema_name, object_type, grantee, privilege, is_grantable
  `);
  const canonicalRows = rows.map((row) => [
    row.owner_role, row.schema_name, row.object_type, row.grantee, row.privilege, row.is_grantable,
  ]).sort(compareRows);
  return {
    scopeCount: scopeRows[0].count,
    rows: canonicalRows,
    sha256: hash(JSON.stringify(canonicalRows)),
  };
}

async function getLegacyFunctionSnapshot(client) {
  const result = await client.query(`
    SELECT proc.proname,
           md5(pg_get_functiondef(proc.oid)) AS definition_md5,
           proc.proacl::text AS acl,
           proc.prosecdef AS security_definer,
           COALESCE(proc.proconfig, ARRAY[]::text[]) AS configuration,
           has_function_privilege('anon', proc.oid, 'EXECUTE') AS anon_execute,
           has_function_privilege('authenticated', proc.oid, 'EXECUTE') AS authenticated_execute,
           has_function_privilege('service_role', proc.oid, 'EXECUTE') AS service_role_execute,
           has_function_privilege(current_user, proc.oid, 'EXECUTE') AS current_user_execute
    FROM pg_proc proc
    WHERE proc.oid IN (
      'public.petro_set_account_status(uuid,text)'::regprocedure,
      'public.petro_admin_set_account_status(uuid,text,text)'::regprocedure
    )
    ORDER BY proc.proname
  `);
  if (result.rowCount !== 2) throw new Error("An expected legacy or 0008 account-status function is missing; no migration was applied.");
  const legacy = result.rows.find((row) => row.proname === "petro_set_account_status");
  const administration = result.rows.find((row) => row.proname === "petro_admin_set_account_status");
  if (
    legacy.definition_md5 !== EXPECTED_LEGACY_FUNCTION_MD5
    || legacy.anon_execute
    || !legacy.authenticated_execute
    || !legacy.service_role_execute
    || !legacy.current_user_execute
    || !administration.security_definer
    || !administration.configuration.includes('search_path=""')
    || administration.anon_execute
    || !administration.authenticated_execute
    || !administration.current_user_execute
  ) {
    throw new Error("The legacy or 0008 account-status RPC definition, security, or grants differ from the approved baseline; no migration was applied.");
  }
  return result.rows;
}

const ENTRY_TYPES_0012 = [
  "bank_receipt",
  "topup_allocation",
  "subscription_collection",
  "internal_transfer",
  "reversal",
];
const ENTRY_TYPES_0013 = [
  "bank_receipt",
  "topup_allocation",
  "subscription_collection",
  "internal_transfer",
  "reservation_consumption",
  "reversal",
];

function matchesExactEntryTypeConstraint(definition, expectedValues) {
  if (!definition) return false;
  const values = [...definition.matchAll(/'([^']*)'/g)].map((match) => match[1]);
  if (
    values.length !== expectedValues.length
    || values.some((value, index) => value !== expectedValues[index])
  ) {
    return false;
  }
  const skeleton = definition
    .replace(/'[^']*'\s*::\s*text/gi, "VALUE")
    .replace(/\s*::\s*text\[\]/gi, "")
    .replace(/\s+/g, "")
    .replace(/[()]/g, "")
    .toLowerCase();
  return skeleton === `checkentry_type=anyarray[${expectedValues.map(() => "value").join(",")}]`;
}

async function getFinanceEntryTypeConstraintState(client) {
  const result = await client.query(`
    SELECT pg_get_constraintdef(oid) AS definition, convalidated
    FROM pg_constraint
    WHERE conrelid='public.petro_finance_journal_entries'::regclass
      AND conname='petro_finance_journal_entries_entry_type_check'
  `);
  if (result.rowCount !== 1 || !result.rows[0].convalidated) {
    return { baseline: false, post0013: false };
  }
  return {
    baseline: matchesExactEntryTypeConstraint(result.rows[0].definition, ENTRY_TYPES_0012),
    post0013: matchesExactEntryTypeConstraint(result.rows[0].definition, ENTRY_TYPES_0013),
  };
}

async function assertFinanceEntryTypeConstraintBaseline(client) {
  const state = await getFinanceEntryTypeConstraintState(client);
  if (!state.baseline) {
    throw new Error(
      "The live journal entry-type constraint differs from the exact 0012 baseline; no migration was applied.",
    );
  }
}

async function probeObject(client, probe) {
  const [kind, ...values] = probe;
  if (kind === "table") {
    return (await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [values[0]])).rows[0].present;
  }
  if (kind === "function") {
    return (await client.query("SELECT to_regprocedure($1) IS NOT NULL AS present", [values[0]])).rows[0].present;
  }
  if (kind === "column") {
    return (await client.query(
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3) AS present",
      values,
    )).rows[0].present;
  }
  if (kind === "functionName") {
    return (await client.query(
      "SELECT EXISTS (SELECT 1 FROM pg_proc proc JOIN pg_namespace ns ON ns.oid=proc.pronamespace WHERE ns.nspname=$1 AND proc.proname=$2) AS present",
      values,
    )).rows[0].present;
  }
  if (kind === "planDraftVersionDefinition") {
    const source = readFileSync(
      new URL("../migrations/0021_inventory_and_plan_draft_repair.sql", import.meta.url),
      "utf8",
    );
    const expected = source.match(
      /CREATE OR REPLACE FUNCTION public\.petro_billing_admin_update_draft_version\([\s\S]*?\)\s*RETURNS uuid[\s\S]*?\bAS \$\$([\s\S]*?)\$\$;/i,
    );
    if (!expected) throw new Error("0021 does not contain the reviewed draft-plan RPC definition.");
    const actual = await client.query(
      "SELECT btrim(proc.prosrc, E' \\t\\n\\r') AS prosrc FROM pg_proc proc WHERE proc.oid='public.petro_billing_admin_update_draft_version(uuid,uuid,text,text,bigint,text,text,text,timestamptz,jsonb,jsonb,text)'::regprocedure",
    );
    return actual.rowCount === 1 && actual.rows[0].prosrc === expected[1].trim();
  }
  if (kind === "inventoryRls") {
    return (await client.query(`
      WITH expected(table_name) AS (VALUES
        ('petro_inventory_locations'),('petro_inventory_balances'),
        ('petro_inventory_documents'),('petro_inventory_document_lines'),
        ('petro_inventory_reservations'),('petro_inventory_movements'),
        ('petro_inventory_commands')
      )
      SELECT count(*)=7 AND bool_and(coalesce(relation.relrowsecurity,false)) AS present
      FROM expected
      LEFT JOIN pg_class relation
        ON relation.oid=to_regclass('public.'||expected.table_name)
    `)).rows[0].present;
  }
  if (kind === "inventoryNoDirectTableAccess") {
    return (await client.query(`
      WITH objects(table_name) AS (VALUES
        ('public.petro_inventory_locations'),('public.petro_inventory_balances'),
        ('public.petro_inventory_documents'),('public.petro_inventory_document_lines'),
        ('public.petro_inventory_reservations'),('public.petro_inventory_movements'),
        ('public.petro_inventory_commands')
      ),
      existing AS (
        SELECT table_name FROM objects WHERE to_regclass(table_name) IS NOT NULL
      ),
      complete AS (
        SELECT (SELECT count(*) FROM existing)=(SELECT count(*) FROM objects) AS yes
      )
      SELECT complete.yes AND NOT EXISTS (
        SELECT 1 FROM existing
        CROSS JOIN (VALUES ('anon'),('authenticated'),('service_role')) AS roles(role_name)
        CROSS JOIN (VALUES
          ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')
        ) AS privileges(privilege_name)
        WHERE has_table_privilege(roles.role_name,existing.table_name,privileges.privilege_name)
          OR EXISTS (
            SELECT 1 FROM pg_class relation
            CROSS JOIN LATERAL aclexplode(
              coalesce(relation.relacl,acldefault('r',relation.relowner))
            ) acl
            WHERE relation.oid=to_regclass(existing.table_name)
              AND acl.grantee=0 AND acl.privilege_type=privileges.privilege_name
          )
      ) AS present
      FROM complete
    `)).rows[0].present;
  }
  if (kind === "inventoryFunctionPrivileges") {
    return (await client.query(`
      WITH public_expected(signature) AS (VALUES
        ('public.petro_inventory_admin_query(text,jsonb)'::text),
        ('public.petro_inventory_admin_command(text,jsonb,text)'::text),
        ('public.petro_inventory_admin_reconcile(uuid)'::text)
      ),
      private_expected(signature) AS (VALUES
        ('petro_private.inventory_can_read(uuid,uuid)'::text),
        ('petro_private.inventory_can_write(uuid,uuid,boolean)'::text),
        ('petro_private.inventory_validate_item(uuid,uuid,numeric,boolean)'::text),
        ('petro_private.inventory_apply_delta(uuid,uuid,uuid,numeric,numeric,uuid,uuid,text,text)'::text),
        ('petro_private.inventory_guard_immutable()'::text)
      )
      SELECT NOT EXISTS (
        SELECT 1 FROM public_expected
        LEFT JOIN LATERAL (SELECT to_regprocedure(public_expected.signature) AS oid) resolved ON true
        LEFT JOIN pg_proc proc ON proc.oid=resolved.oid
        WHERE proc.oid IS NULL OR NOT proc.prosecdef
          OR NOT (coalesce(proc.proconfig,ARRAY[]::text[]) @> ARRAY['search_path=""']::text[])
          OR NOT has_function_privilege('authenticated',proc.oid,'EXECUTE')
          OR has_function_privilege('anon',proc.oid,'EXECUTE')
          OR has_function_privilege('service_role',proc.oid,'EXECUTE')
          OR EXISTS (
            SELECT 1 FROM aclexplode(coalesce(proc.proacl,acldefault('f',proc.proowner))) acl
            WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM private_expected
        LEFT JOIN LATERAL (SELECT to_regprocedure(private_expected.signature) AS oid) resolved ON true
        LEFT JOIN pg_proc proc ON proc.oid=resolved.oid
        WHERE proc.oid IS NULL
          OR (private_expected.signature NOT LIKE '%inventory_guard_immutable%'
            AND (NOT proc.prosecdef
              OR NOT (coalesce(proc.proconfig,ARRAY[]::text[]) @> ARRAY['search_path=""']::text[])))
          OR has_function_privilege('anon',proc.oid,'EXECUTE')
          OR has_function_privilege('authenticated',proc.oid,'EXECUTE')
          OR has_function_privilege('service_role',proc.oid,'EXECUTE')
          OR EXISTS (
            SELECT 1 FROM aclexplode(coalesce(proc.proacl,acldefault('f',proc.proowner))) acl
            WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
          )
      ) AS present
    `)).rows[0].present;
  }
  if (kind === "platformUserTemporaryPasswordContract") {
    return (await client.query(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_class relation ON relation.oid=attribute.attrelid
        JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
        JOIN pg_attrdef default_value
          ON default_value.adrelid=relation.oid AND default_value.adnum=attribute.attnum
        WHERE namespace.nspname='public'
          AND relation.relname='petro_profiles'
          AND attribute.attname='password_change_required'
          AND attribute.atttypid='boolean'::regtype
          AND attribute.attnotnull
          AND pg_get_expr(default_value.adbin, default_value.adrelid)='false'
      ) AND EXISTS (
        SELECT 1 FROM pg_proc proc
        WHERE proc.oid='public.petro_admin_create_platform_user_access(uuid,text[],text)'::regprocedure
          AND proc.prosecdef
          AND proc.prorettype='text[]'::regtype
          AND COALESCE(proc.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=""']::text[]
      ) AS present
    `)).rows[0].present;
  }
  if (kind === "platformUserTemporaryPasswordPrivileges") {
    const result = await client.query(`
      SELECT has_function_privilege('authenticated', proc.oid, 'EXECUTE')
        AND NOT has_function_privilege('anon', proc.oid, 'EXECUTE')
        AND NOT has_function_privilege('service_role', proc.oid, 'EXECUTE')
        AND NOT EXISTS (
          SELECT 1
          FROM aclexplode(COALESCE(proc.proacl, acldefault('f', proc.proowner))) privilege
          WHERE privilege.grantee=0 AND privilege.privilege_type='EXECUTE'
        ) AS present
      FROM pg_proc proc
      WHERE proc.oid='public.petro_admin_create_platform_user_access(uuid,text[],text)'::regprocedure
    `);
    return result.rowCount === 1 && result.rows[0].present;
  }
  if (kind === "index") {
    return (await client.query(
      "SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname=$1 AND indexname=$2) AS present",
      values,
    )).rows[0].present;
  }
  if (kind === "trigger") {
    return (await client.query(
      "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass($1) AND tgname=$2 AND NOT tgisinternal) AS present",
      values,
    )).rows[0].present;
  }
  if (kind === "policy") {
    return (await client.query(
      "SELECT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname=$1 AND tablename=$2 AND policyname=$3) AS present",
      values,
    )).rows[0].present;
  }
  if (kind === "constraint") {
    return (await client.query(
      "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass($1) AND conname=$2) AS present",
      values,
    )).rows[0].present;
  }
  if (kind === "financeJournalEntryTypeConstraint") {
    const state = await getFinanceEntryTypeConstraintState(client);
    return state.baseline || state.post0013;
  }
  if (kind === "financeJournalEntryTypeConstraintPost0013") {
    return (await getFinanceEntryTypeConstraintState(client)).post0013;
  }
  if (kind === "financeRls") {
    return (await client.query(`
      SELECT NOT EXISTS (
        SELECT 1 FROM (VALUES
          ('petro_finance_settings'),('petro_finance_bank_accounts'),('petro_finance_accounts'),
          ('petro_finance_journal_entries'),('petro_finance_journal_lines'),
          ('petro_finance_topup_requests'),('petro_finance_bank_reference_registry'),
          ('petro_finance_bank_receipts'),('petro_finance_receipt_allocations'),
          ('petro_finance_subscription_collections'),('petro_finance_transfers'),
          ('petro_finance_reservations'),('petro_finance_commands'),('petro_finance_outbox')
        ) AS expected(table_name)
        LEFT JOIN pg_class relation ON relation.oid=to_regclass('public.'||expected.table_name)
        WHERE relation.oid IS NULL OR NOT relation.relrowsecurity
      ) AS present
    `)).rows[0].present;
  }
  if (kind === "financeNoDirectTableAccess") {
    return (await client.query(`
      SELECT NOT EXISTS (
        SELECT 1 FROM (VALUES
          ('public.petro_finance_settings'),('public.petro_finance_bank_accounts'),
          ('public.petro_finance_accounts'),('public.petro_finance_journal_entries'),
          ('public.petro_finance_journal_lines'),('public.petro_finance_topup_requests'),
          ('public.petro_finance_bank_reference_registry'),('public.petro_finance_bank_receipts'),
          ('public.petro_finance_receipt_allocations'),('public.petro_finance_subscription_collections'),
          ('public.petro_finance_transfers'),('public.petro_finance_reservations'),
          ('public.petro_finance_commands'),('public.petro_finance_outbox')
        ) AS objects(table_name)
        CROSS JOIN (VALUES ('anon'),('authenticated'),('service_role')) AS roles(role_name)
        CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) AS privileges(privilege_name)
        WHERE has_table_privilege(roles.role_name, objects.table_name, privileges.privilege_name)
      ) AS present
    `)).rows[0].present;
  }
  if (kind === "financeAdminFunctionPrivileges") {
    return (await client.query(`
      SELECT count(*) IN (24,25)
        AND (count(*)=24 OR count(*) FILTER (
          WHERE proc.proname='petro_finance_admin_receipt_detail'
        )=1)
        AND bool_and(has_function_privilege('authenticated',proc.oid,'EXECUTE'))
        AND bool_and(NOT has_function_privilege('anon',proc.oid,'EXECUTE'))
        AND bool_and(proc.prosecdef)
        AS present
      FROM pg_proc proc JOIN pg_namespace namespace ON namespace.oid=proc.pronamespace
      WHERE namespace.nspname='public' AND proc.proname LIKE 'petro_finance_admin_%'
    `)).rows[0].present;
  }
  if (kind === "financeAdminFunctionPrivilegesPost0013") {
    return (await client.query(`
      SELECT count(*)=25
        AND bool_and(has_function_privilege('authenticated',proc.oid,'EXECUTE'))
        AND bool_and(NOT has_function_privilege('anon',proc.oid,'EXECUTE'))
        AND bool_and(proc.prosecdef)
        AS present
      FROM pg_proc proc JOIN pg_namespace namespace ON namespace.oid=proc.pronamespace
      WHERE namespace.nspname='public' AND proc.proname LIKE 'petro_finance_admin_%'
    `)).rows[0].present;
  }
  if (kind === "financePrivateFunctionPrivileges") {
    return (await client.query(`
      SELECT NOT EXISTS (
        SELECT 1 FROM pg_proc proc JOIN pg_namespace namespace ON namespace.oid=proc.pronamespace
        WHERE namespace.nspname='petro_private'
          AND proc.proname IN (
            'finance_can_read','finance_can_mutate','finance_can_submit','finance_begin_command',
            'finance_finish_command','finance_post_entry','finance_account_for_scope',
            'finance_bank_asset','finance_normalize_reference','guard_finance_journal_immutable',
            'assert_finance_entry_balanced','finance_record_receipt','finance_allocate_receipt',
            'finance_reserve_funds','finance_release_reservation','finance_consume_reservation'
          )
          AND (has_function_privilege('anon',proc.oid,'EXECUTE')
            OR has_function_privilege('authenticated',proc.oid,'EXECUTE')
            OR (proc.proname='finance_consume_reservation'
              AND NOT has_function_privilege('service_role',proc.oid,'EXECUTE')))
      ) AS present
    `)).rows[0].present;
  }
  if (kind === "financeInitialSeedState") {
    const { rows } = await client.query(`
      SELECT
        (SELECT count(*)=1 FROM public.petro_finance_settings) AS one_settings_row,
        (SELECT count(*)=3 AND count(*) FILTER (WHERE account_code IN (
          'SYS-UNALLOCATED-RECEIPTS','SYS-SUBSCRIPTION-HELD','SYS-MERCHANT-PAYABLE'
        ))=3 AND count(*) FILTER (WHERE organization_id IS NOT NULL)=0
         FROM public.petro_finance_accounts) AS only_control_accounts,
        (SELECT count(*)=0 FROM public.petro_finance_bank_accounts) AS no_bank_accounts,
        (SELECT count(*)=0 FROM public.petro_finance_journal_entries) AS no_journal_entries,
        (SELECT count(*)=0 FROM public.petro_finance_journal_lines) AS no_journal_lines,
        (SELECT count(*)=0 FROM public.petro_finance_topup_requests) AS no_topups,
        (SELECT count(*)=0 FROM public.petro_finance_bank_receipts) AS no_receipts,
        (SELECT count(*)=0 FROM public.petro_finance_receipt_allocations) AS no_allocations,
        (SELECT count(*)=0 FROM public.petro_finance_subscription_collections) AS no_subscription_collections,
        (SELECT count(*)=0 FROM public.petro_finance_transfers) AS no_transfers,
        (SELECT count(*)=0 FROM public.petro_finance_reservations) AS no_reservations,
        (SELECT count(*)=0 FROM public.petro_finance_commands) AS no_commands,
        (SELECT count(*)=0 FROM public.petro_finance_outbox) AS no_outbox
    `);
    return Object.values(rows[0]).every(Boolean);
  }
  if (kind === "requestTypeConstraint") {
    const table = await client.query("SELECT to_regclass('public.petro_subscription_requests') IS NOT NULL AS present");
    if (!table.rows[0].present) return false;
    return (await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid=to_regclass('public.petro_subscription_requests')
          AND conname='petro_subscription_requests_request_type_check'
          AND pg_get_constraintdef(oid) NOT ILIKE '%custom_price%'
      ) AS present
    `)).rows[0].present;
  }
  if (kind === "billingSettingsDefaults") {
    const table = await client.query("SELECT to_regclass('public.petro_billing_settings') IS NOT NULL AS present");
    if (!table.rows[0].present) return false;
    return (await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM public.petro_billing_settings
        WHERE singleton_id
          AND company_annual_prices_minor=ARRAY[50000,75000,100000]::bigint[]
          AND provider_annual_price_minor=500000
          AND nfc_issue_price_minor=10000
      ) AS present
    `)).rows[0].present;
  }
  if (kind === "fleetRls") {
    return (await client.query(`
      SELECT NOT EXISTS (
        SELECT 1 FROM (VALUES
          ('public','petro_fleet_vehicles'),('public','petro_fleet_drivers'),
          ('public','petro_fleet_driver_links'),('public','petro_fleet_events'),
          ('public','petro_fleet_policy_versions'),('public','petro_fleet_policy_rules'),
          ('public','petro_fleet_usage_reservations'),('public','petro_subscription_vehicle_assignments'),
          ('public','petro_vehicle_credentials'),('public','petro_fleet_credential_requests'),
          ('public','petro_fleet_tag_stock_units'),('public','petro_fleet_tag_stock_events'),
          ('public','petro_vehicle_odometer_events'),('public','petro_vehicle_maintenance_records'),
          ('public','petro_fleet_import_jobs'),('public','petro_fleet_outbox'),('public','petro_fleet_idempotency'),
          ('petro_private','petro_fleet_driver_pair_secrets'),
          ('petro_private','petro_fleet_pair_rate_limits'),
          ('petro_private','petro_fleet_pair_verifications')
        ) AS expected(schema_name, table_name)
        LEFT JOIN pg_class relation ON relation.oid=to_regclass(expected.schema_name||'.'||expected.table_name)
        WHERE relation.oid IS NULL OR NOT relation.relrowsecurity
      ) AS present
    `)).rows[0].present;
  }
  if (kind === "fleetNoDirectTableAccess") {
    return (await client.query(`
      WITH objects(table_name) AS (VALUES
          ('public.petro_fleet_vehicles'),('public.petro_fleet_drivers'),
          ('public.petro_fleet_driver_links'),('public.petro_fleet_events'),
          ('public.petro_fleet_policy_versions'),('public.petro_fleet_policy_rules'),
          ('public.petro_fleet_usage_reservations'),('public.petro_subscription_vehicle_assignments'),
          ('public.petro_vehicle_credentials'),('public.petro_fleet_credential_requests'),
          ('public.petro_fleet_tag_stock_units'),('public.petro_fleet_tag_stock_events'),
          ('public.petro_vehicle_odometer_events'),('public.petro_vehicle_maintenance_records'),
          ('public.petro_fleet_import_jobs'),('public.petro_fleet_outbox'),('public.petro_fleet_idempotency'),
          ('petro_private.petro_fleet_driver_pair_secrets'),
          ('petro_private.petro_fleet_pair_rate_limits'),
          ('petro_private.petro_fleet_pair_verifications')
      ),
      existing AS (
        SELECT table_name FROM objects WHERE to_regclass(table_name) IS NOT NULL
      ),
      completeness AS (
        SELECT (SELECT count(*) FROM existing)=(SELECT count(*) FROM objects) AS all_exist
      )
      SELECT completeness.all_exist AND NOT EXISTS (
        SELECT 1 FROM existing
        CROSS JOIN (VALUES ('anon'),('authenticated'),('service_role')) AS roles(role_name)
        CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) AS privileges(privilege_name)
        WHERE has_table_privilege(roles.role_name, existing.table_name, privileges.privilege_name)
      ) AS present
      FROM completeness
    `)).rows[0].present;
  }
  if (kind === "fleetFunctionPrivileges") {
    return (await client.query(`
      WITH expected(signature, authenticated_execute, service_execute) AS (
        VALUES
          ('public.petro_admin_fleet_catalog(text,jsonb)',true,false),
          ('public.petro_admin_fleet_command(text,jsonb,text,text)',true,false),
          ('public.petro_admin_fleet_verify_driver_pair(uuid,text)',true,true),
          ('public.petro_fleet_create_vehicle_document_upload(uuid,text,text,text,bigint,date)',true,false),
          ('public.petro_fleet_reserve_usage(uuid,uuid,uuid,uuid,uuid,text,bigint,numeric,text,text,uuid)',false,true),
          ('public.petro_fleet_release_usage(uuid,uuid)',false,true),
          ('public.petro_fleet_consume_usage(uuid,uuid,uuid)',false,true),
          ('petro_private.fleet_can_read()',false,false),
          ('petro_private.fleet_can_manage()',false,false),
          ('petro_private.can_access_fleet_document(text,text)',true,false),
          ('petro_private.fleet_check_usage_policy(uuid,uuid,uuid,uuid,text,bigint,numeric)',false,false)
      )
      SELECT NOT EXISTS (
        SELECT 1 FROM expected
        LEFT JOIN LATERAL (SELECT to_regprocedure(expected.signature) AS oid) resolved ON true
        LEFT JOIN pg_proc proc ON proc.oid=resolved.oid
        WHERE proc.oid IS NULL
          OR NOT proc.prosecdef
          OR has_function_privilege('anon',proc.oid,'EXECUTE')
          OR has_function_privilege('authenticated',proc.oid,'EXECUTE')<>expected.authenticated_execute
          OR has_function_privilege('service_role',proc.oid,'EXECUTE')<>expected.service_execute
      ) AS present
    `)).rows[0].present;
  }
  if (kind === "fleet0015FunctionPrivileges") {
    return (await client.query(`
      WITH expected(signature) AS (VALUES
        ('public.petro_admin_fleet_assign_coverage(jsonb,text,text)'::text),
        ('public.petro_admin_fleet_subscription_options(uuid,text,integer,integer)'::text),
        ('public.petro_admin_fleet_stock_options(text,integer,integer)'::text)
      )
      SELECT NOT EXISTS (
        SELECT 1 FROM expected
        LEFT JOIN LATERAL (SELECT to_regprocedure(expected.signature) AS oid) resolved ON true
        LEFT JOIN pg_proc proc ON proc.oid=resolved.oid
        WHERE proc.oid IS NULL
          OR NOT proc.prosecdef
          OR has_function_privilege('anon',proc.oid,'EXECUTE')
          OR NOT has_function_privilege('authenticated',proc.oid,'EXECUTE')
          OR has_function_privilege('service_role',proc.oid,'EXECUTE')
      ) AS present
    `)).rows[0].present;
  }
  if (kind === "fleet0016PostConstraints") {
    const tableNames = [
      "petro_fleet_policy_versions",
      "petro_fleet_usage_reservations",
      "petro_vehicle_credentials",
      "petro_fleet_credential_requests",
      "petro_vehicle_odometer_events",
      "petro_vehicle_maintenance_records",
      "petro_documents",
    ];
    const { rows } = await client.query(`
      SELECT relation.relname AS table_name, constraint_row.conname,
             pg_get_constraintdef(constraint_row.oid) AS definition,
             constraint_row.convalidated
      FROM pg_constraint constraint_row
      JOIN pg_class relation ON relation.oid=constraint_row.conrelid
      JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname='public' AND relation.relname=ANY($1::text[])
        AND constraint_row.contype='f'
    `, [tableNames]);
    const normalize = (value) => value.replace(/\s+/g, " ").replaceAll("public.", "");
    const hasFk = (table, name, definition) => rows.some((row) =>
      row.table_name === table
      && row.conname === name
      && row.convalidated
      && normalize(row.definition).startsWith(definition)
    );
    const vehicleScopeTables = [
      ["petro_fleet_policy_versions", "petro_fleet_policy_versions_vehicle_scope_fk"],
      ["petro_fleet_usage_reservations", "petro_fleet_usage_reservation_vehicle_scope_fk"],
      ["petro_vehicle_credentials", "petro_vehicle_credentials_vehicle_scope_fk"],
      ["petro_fleet_credential_requests", "petro_fleet_credential_requests_vehicle_scope_fk"],
      ["petro_vehicle_odometer_events", "petro_vehicle_odometer_events_vehicle_scope_fk"],
      ["petro_vehicle_maintenance_records", "petro_vehicle_maintenance_records_vehicle_scope_fk"],
      ["petro_documents", "petro_documents_vehicle_scope_fk"],
    ];
    const branchScopeTables = [
      ["petro_fleet_policy_versions", "petro_fleet_policy_versions_branch_scope_fk"],
      ["petro_fleet_usage_reservations", "petro_fleet_usage_reservation_branch_scope_fk"],
      ["petro_vehicle_credentials", "petro_vehicle_credentials_branch_scope_fk"],
      ["petro_fleet_credential_requests", "petro_fleet_credential_requests_branch_scope_fk"],
      ["petro_vehicle_odometer_events", "petro_vehicle_odometer_events_branch_scope_fk"],
      ["petro_vehicle_maintenance_records", "petro_vehicle_maintenance_records_branch_scope_fk"],
    ];
    const vehicleDefinition =
      "FOREIGN KEY (vehicle_id, organization_id) REFERENCES petro_fleet_vehicles(id, organization_id) ON DELETE RESTRICT";
    const branchDefinition =
      "FOREIGN KEY (branch_id, organization_id) REFERENCES petro_branches(id, organization_id) ON DELETE RESTRICT";
    if (!vehicleScopeTables.every(([table, name]) => hasFk(table, name, vehicleDefinition))) return false;
    if (!branchScopeTables.every(([table, name]) => hasFk(table, name, branchDefinition))) return false;
    if (rows.some((row) =>
      vehicleScopeTables.some(([table]) => row.table_name === table)
      && normalize(row.definition).startsWith(
        "FOREIGN KEY (vehicle_id, organization_id, branch_id) REFERENCES petro_fleet_vehicles(id, organization_id, branch_id)",
      )
    )) return false;
    const unique = await client.query(`
      SELECT pg_get_constraintdef(oid) AS definition, convalidated
      FROM pg_constraint
      WHERE conrelid='public.petro_fleet_vehicles'::regclass
        AND conname='petro_fleet_vehicles_id_org_unique' AND contype='u'
    `);
    return unique.rowCount === 1
      && unique.rows[0].convalidated
      && normalize(unique.rows[0].definition) === "UNIQUE (id, organization_id)";
  }
  if (kind === "fleet0016Rls") {
    return (await client.query(`
      SELECT coalesce((
        SELECT relation.relrowsecurity
        FROM pg_class relation
        WHERE relation.oid=to_regclass('public.petro_fleet_consumption_rate_versions')
      ),false) AS present
    `)).rows[0].present;
  }
  if (kind === "fleet0016NoDirectTableAccess") {
    return (await client.query(`
      WITH target AS (
        SELECT to_regclass('public.petro_fleet_consumption_rate_versions') AS relation_id
      )
      SELECT target.relation_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM (VALUES ('anon'),('authenticated'),('service_role')) roles(role_name)
        CROSS JOIN (VALUES
          ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')
        ) privileges(privilege_name)
        WHERE has_table_privilege(
          roles.role_name,target.relation_id,privileges.privilege_name
        )
      ) AS present FROM target
    `)).rows[0].present;
  }
  if (kind === "fleet0016FunctionPrivileges") {
    return (await client.query(`
      WITH expected(signature) AS (VALUES
        ('public.petro_admin_fleet_company_summaries(uuid,text,integer,integer)'::text),
        ('public.petro_admin_fleet_driver_detail(uuid)'::text),
        ('public.petro_admin_fleet_stock_reservations(text,integer,integer)'::text),
        ('public.petro_admin_fleet_consumption_rates(uuid,uuid)'::text),
        ('public.petro_admin_fleet_set_consumption_rate(uuid,uuid,numeric,text,text)'::text)
      )
      SELECT NOT EXISTS (
        SELECT 1 FROM expected
        LEFT JOIN LATERAL (SELECT to_regprocedure(expected.signature) AS oid) resolved ON true
        LEFT JOIN pg_proc proc ON proc.oid=resolved.oid
        WHERE proc.oid IS NULL OR NOT proc.prosecdef
          OR has_function_privilege('anon',proc.oid,'EXECUTE')
          OR NOT has_function_privilege('authenticated',proc.oid,'EXECUTE')
          OR has_function_privilege('service_role',proc.oid,'EXECUTE')
      ) AS present
    `)).rows[0].present;
  }
  if (kind === "fleet0016PrivateFunctionPrivileges") {
    return (await client.query(`
      WITH expected(signature) AS (VALUES
        ('petro_private.prevent_fleet_move_with_reserved_usage()'::text),
        ('petro_private.fleet_check_usage_policy_at(uuid,uuid,uuid,uuid,text,bigint,numeric,timestamptz)'::text),
        ('petro_private.prevent_fleet_consumption_rate_mutation()'::text)
      )
      SELECT NOT EXISTS (
        SELECT 1 FROM expected
        LEFT JOIN LATERAL (SELECT to_regprocedure(expected.signature) AS oid) resolved ON true
        LEFT JOIN pg_proc proc ON proc.oid=resolved.oid
        WHERE proc.oid IS NULL OR NOT proc.prosecdef
          OR has_function_privilege('anon',proc.oid,'EXECUTE')
          OR has_function_privilege('authenticated',proc.oid,'EXECUTE')
          OR has_function_privilege('service_role',proc.oid,'EXECUTE')
      ) AS present
    `)).rows[0].present;
  }
  if (kind === "catalogRls") {
    return (await client.query(`
      SELECT NOT EXISTS (
        SELECT 1 FROM (VALUES
          ('petro_catalog_units'),('petro_catalog_categories'),('petro_fuel_types'),
          ('petro_catalog_items'),('petro_catalog_branch_availability'),
          ('petro_catalog_price_versions'),('petro_fuel_price_versions'),
          ('petro_catalog_images'),('petro_catalog_idempotency')
        ) AS expected(table_name)
        LEFT JOIN pg_class relation
          ON relation.oid=to_regclass('public.'||expected.table_name)
        WHERE relation.oid IS NULL OR NOT relation.relrowsecurity
      ) AS present
    `)).rows[0].present;
  }
  if (kind === "catalogNoDirectTableAccess") {
    return (await client.query(`
      WITH objects(table_name) AS (VALUES
        ('public.petro_catalog_units'),('public.petro_catalog_categories'),
        ('public.petro_fuel_types'),('public.petro_catalog_items'),
        ('public.petro_catalog_branch_availability'),('public.petro_catalog_price_versions'),
        ('public.petro_fuel_price_versions'),('public.petro_catalog_images'),
        ('public.petro_catalog_idempotency')
      ),
      existing AS (
        SELECT table_name FROM objects WHERE to_regclass(table_name) IS NOT NULL
      ),
      complete AS (
        SELECT (SELECT count(*) FROM existing)=(SELECT count(*) FROM objects) AS yes
      )
      SELECT complete.yes AND NOT EXISTS (
        SELECT 1 FROM existing
        CROSS JOIN (VALUES ('anon'),('authenticated'),('service_role')) AS roles(role_name)
        CROSS JOIN (VALUES
          ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')
        ) AS privileges(privilege_name)
        WHERE has_table_privilege(roles.role_name,existing.table_name,privileges.privilege_name)
           OR EXISTS (
             SELECT 1 FROM pg_class relation
             CROSS JOIN LATERAL aclexplode(
               coalesce(relation.relacl,acldefault('r',relation.relowner))
             ) acl
             WHERE relation.oid=to_regclass(existing.table_name)
               AND acl.grantee=0 AND acl.privilege_type=privileges.privilege_name
           )
      ) AS present
      FROM complete
    `)).rows[0].present;
  }
  if (kind === "catalogFunctionPrivileges") {
    return (await client.query(`
      WITH expected(signature) AS (VALUES
        ('public.petro_catalog_admin_categories()'::text),
        ('public.petro_catalog_reference_data()'::text),
        ('public.petro_catalog_admin_organizations(text,text,integer,integer)'::text),
        ('public.petro_catalog_admin_fuel_list(text,integer,integer)'::text),
        ('public.petro_catalog_list_items(uuid,uuid,text,text,text,text,integer,integer)'::text),
        ('public.petro_catalog_item_detail(uuid)'::text),
        ('public.petro_catalog_fuel_preview(uuid,numeric,bigint)'::text),
        ('public.petro_catalog_command(text,jsonb,text,text)'::text),
        ('public.petro_catalog_image_upload_info(uuid)'::text),
        ('public.petro_catalog_image_download_info(uuid)'::text),
        ('public.petro_catalog_image_complete(uuid,text)'::text),
        ('public.petro_catalog_image_fail(uuid)'::text)
      )
      SELECT NOT EXISTS (
        SELECT 1 FROM expected
        LEFT JOIN LATERAL (SELECT to_regprocedure(expected.signature) AS oid) resolved ON true
        LEFT JOIN pg_proc proc ON proc.oid=resolved.oid
        WHERE proc.oid IS NULL OR NOT proc.prosecdef
          OR NOT has_function_privilege('authenticated',proc.oid,'EXECUTE')
          OR has_function_privilege('anon',proc.oid,'EXECUTE')
          OR has_function_privilege('service_role',proc.oid,'EXECUTE')
          OR EXISTS (
            SELECT 1 FROM aclexplode(
              coalesce(proc.proacl,acldefault('f',proc.proowner))
            ) acl
            WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
          )
      ) AS present
    `)).rows[0].present;
  }
  if (kind === "catalogPrivateFunctionPrivileges") {
    return (await client.query(`
      WITH expected(signature,authenticated_execute) AS (VALUES
        ('petro_private.catalog_is_admin(boolean)'::text,true),
        ('petro_private.catalog_can_read_org(uuid,uuid)'::text,true),
        ('petro_private.catalog_merchant_can_manage_org(uuid,uuid)'::text,true),
        ('petro_private.catalog_attributes_valid(text,jsonb)'::text,false),
        ('petro_private.catalog_command_begin(uuid,text,jsonb,text,text)'::text,false),
        ('petro_private.catalog_command_finish(uuid,text,jsonb)'::text,false),
        ('petro_private.catalog_can_access_image(text,text)'::text,true)
      )
      SELECT NOT EXISTS (
        SELECT 1 FROM expected
        LEFT JOIN LATERAL (SELECT to_regprocedure(expected.signature) AS oid) resolved ON true
        LEFT JOIN pg_proc proc ON proc.oid=resolved.oid
        WHERE proc.oid IS NULL OR NOT proc.prosecdef
          OR has_function_privilege('authenticated',proc.oid,'EXECUTE')<>expected.authenticated_execute
          OR has_function_privilege('anon',proc.oid,'EXECUTE')
          OR has_function_privilege('service_role',proc.oid,'EXECUTE')
          OR EXISTS (
            SELECT 1 FROM aclexplode(
              coalesce(proc.proacl,acldefault('f',proc.proowner))
            ) acl
            WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
          )
      ) AS present
    `)).rows[0].present;
  }
  if (kind === "catalogStoragePolicies") {
    return (await client.query(`
      WITH policies AS (
        SELECT policyname,cmd,qual,with_check
        FROM pg_policies
        WHERE schemaname='storage' AND tablename='objects'
          AND policyname IN (
            'petro_catalog_image_read','petro_catalog_image_upload',
            'petro_catalog_image_delete_pending'
          )
      )
      SELECT count(*)=3
        AND bool_and(
          CASE policyname
            WHEN 'petro_catalog_image_read' THEN cmd='SELECT'
              AND qual LIKE '%petro-private-documents%'
              AND qual LIKE '%catalog_can_access_image%'
            WHEN 'petro_catalog_image_upload' THEN cmd='INSERT'
              AND with_check LIKE '%petro-private-documents%'
              AND with_check LIKE '%catalog_can_access_image%'
            WHEN 'petro_catalog_image_delete_pending' THEN cmd='DELETE'
              AND qual LIKE '%petro-private-documents%'
              AND qual LIKE '%catalog_can_access_image%'
            ELSE false
          END
        ) AS present
      FROM policies
    `)).rows[0].present;
  }
  if (kind === "catalogContractGuards") {
    return (await client.query(`
      SELECT
        EXISTS (
          SELECT 1 FROM pg_trigger trigger_row
          JOIN pg_class relation ON relation.oid=trigger_row.tgrelid
          JOIN pg_namespace schema_row ON schema_row.oid=relation.relnamespace
          JOIN pg_proc procedure_row ON procedure_row.oid=trigger_row.tgfoid
          WHERE schema_row.nspname='public'
            AND relation.relname='petro_catalog_items'
            AND trigger_row.tgname='petro_catalog_wash_variant_guard'
            AND NOT trigger_row.tgisinternal
            AND trigger_row.tgenabled='O'
            AND procedure_row.oid=to_regprocedure('petro_private.guard_catalog_wash_variant()')
        )
        AND EXISTS (
          SELECT 1 FROM pg_trigger trigger_row
          JOIN pg_class relation ON relation.oid=trigger_row.tgrelid
          JOIN pg_namespace schema_row ON schema_row.oid=relation.relnamespace
          JOIN pg_proc procedure_row ON procedure_row.oid=trigger_row.tgfoid
          WHERE schema_row.nspname='public'
            AND relation.relname='petro_fuel_types'
            AND trigger_row.tgname='petro_fuel_type_unit_guard'
            AND NOT trigger_row.tgisinternal
            AND trigger_row.tgenabled='O'
            AND procedure_row.oid=to_regprocedure('petro_private.guard_fuel_type_unit()')
        )
        AND CASE
          WHEN to_regprocedure('petro_private.petro_valid_branch_hours(jsonb)') IS NOT NULL
          THEN pg_get_functiondef(to_regprocedure('petro_private.petro_valid_branch_hours(jsonb)'))
            LIKE '%open24Hours%'
          ELSE false
        END
        AND CASE
          WHEN to_regprocedure('petro_private.catalog_attributes_valid(text,jsonb)') IS NOT NULL
          THEN pg_get_functiondef(to_regprocedure('petro_private.catalog_attributes_valid(text,jsonb)'))
            LIKE '%washMode%'
          ELSE false
        END
        AND NOT EXISTS (
          WITH expected(signature) AS (VALUES
            ('petro_private.guard_catalog_wash_variant()'::text),
            ('petro_private.guard_fuel_type_unit()'::text)
          )
          SELECT 1
          FROM expected
          LEFT JOIN LATERAL (SELECT to_regprocedure(expected.signature) AS oid) resolved ON true
          LEFT JOIN pg_proc procedure_row ON procedure_row.oid=resolved.oid
          WHERE procedure_row.oid IS NULL OR NOT procedure_row.prosecdef
            OR has_function_privilege('anon',procedure_row.oid,'EXECUTE')
            OR has_function_privilege('authenticated',procedure_row.oid,'EXECUTE')
            OR has_function_privilege('service_role',procedure_row.oid,'EXECUTE')
            OR EXISTS (
              SELECT 1 FROM aclexplode(
                coalesce(procedure_row.proacl,acldefault('f',procedure_row.proowner))
              ) acl
              WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
            )
        )
        AS present
    `)).rows[0].present;
  }
  if (kind === "catalogWashUpdateGuard") {
    return (await client.query(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_trigger trigger_row
        JOIN pg_class relation ON relation.oid=trigger_row.tgrelid
        JOIN pg_namespace schema_row ON schema_row.oid=relation.relnamespace
        JOIN pg_proc procedure_row ON procedure_row.oid=trigger_row.tgfoid
        WHERE schema_row.nspname='public'
          AND relation.relname='petro_catalog_items'
          AND trigger_row.tgname='petro_catalog_wash_variant_update_guard'
          AND NOT trigger_row.tgisinternal
          AND trigger_row.tgenabled='O'
          AND procedure_row.oid=to_regprocedure('petro_private.guard_catalog_wash_variant_update()')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure_row
        WHERE procedure_row.oid=to_regprocedure('petro_private.guard_catalog_wash_variant_update()')
          AND (
            NOT procedure_row.prosecdef
            OR has_function_privilege('anon',procedure_row.oid,'EXECUTE')
            OR has_function_privilege('authenticated',procedure_row.oid,'EXECUTE')
            OR has_function_privilege('service_role',procedure_row.oid,'EXECUTE')
            OR EXISTS (
              SELECT 1 FROM aclexplode(
                coalesce(procedure_row.proacl,acldefault('f',procedure_row.proowner))
              ) acl
              WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
            )
          )
      )
      AND to_regprocedure('petro_private.guard_catalog_wash_variant_update()') IS NOT NULL
      AS present
    `)).rows[0].present;
  }
  throw new Error(`Unknown migration probe: ${kind}`);
}

async function getMigrationState(client, spec) {
  const results = [];
  for (const probe of spec.probes) {
    results.push({
      label: probe.slice(0, 2).join(":"),
      present: await probeObject(client, probe),
    });
  }
  const presentCount = results.filter((result) => result.present).length;
  return {
    status: presentCount === 0 ? "absent" : presentCount === results.length ? "complete" : "partial",
    results,
  };
}

async function getLedgerRows(client, names) {
  const result = await client.query(
    "SELECT version, name, statements FROM supabase_migrations.schema_migrations WHERE name = ANY($1::text[])",
    [names],
  );
  return result.rows;
}

async function validateMigrationLedger(client, migrations) {
  const names = migrations.map((migration) => migration.name);
  const ledgerRows = await getLedgerRows(client, names);
  for (const migration of migrations) {
    const state = await getMigrationState(client, migration);
    const records = ledgerRows.filter((record) => record.name === migration.name);
    if (state.status === "partial") {
      const present = state.results.filter((result) => result.present).map((result) => result.label);
      const missing = state.results.filter((result) => !result.present).map((result) => result.label);
      throw new Error(`${migration.name} has a partial in-scope schema footprint; present=[${present.join(", ")}], missing=[${missing.join(", ")}]. No migration was applied.`);
    }
    if (records.length > 1) {
      throw new Error(`${migration.name} has duplicate migration-ledger rows; no migration was applied.`);
    }
    if (records.length === 0 && state.status === "complete") {
      const present = state.results.filter((result) => result.present).map((result) => result.label);
      throw new Error(`${migration.name} has ${present.length} matching resources but no genuine ledger record: [${present.join(", ")}]. It will not be replayed or backfilled.`);
    }
    if (records.length === 1) {
      if (state.status !== "complete" || !records[0].statements?.includes(migration.source)) {
        const present = state.results.filter((result) => result.present).map((result) => result.label);
        const missing = state.results.filter((result) => !result.present).map((result) => result.label);
        throw new Error(`${migration.name} ledger/source does not match its live schema; present=[${present.join(", ")}], missing=[${missing.join(", ")}]. No migration was applied.`);
      }
      await assertPostconditions(client, migration);
    }
    migration.liveState = state.status;
    migration.recorded = records.length === 1;
  }
}

async function assertPostconditions(client, migration) {
  for (const probe of migration.postconditions ?? []) {
    if (probe[0] === "platformUserTemporaryPasswordDefinition") {
      const functionMatch = migration.source.match(
        /CREATE OR REPLACE FUNCTION public\.petro_admin_create_platform_user_access\([\s\S]*?\)\s*RETURNS text\[\][\s\S]*?\bAS \$\$([\s\S]*?)\$\$;/i,
      );
      if (!functionMatch) {
        throw new Error("0020 source does not contain the expected role-assignment RPC body.");
      }
      const functionResult = await client.query(
        "SELECT btrim(proc.prosrc, E' \\t\\n\\r') AS prosrc FROM pg_proc proc WHERE proc.oid='public.petro_admin_create_platform_user_access(uuid,text[],text)'::regprocedure",
      );
      if (functionResult.rowCount !== 1 || functionResult.rows[0].prosrc !== functionMatch[1].trim()) {
        throw new Error("0020 live role-assignment RPC body differs from the reviewed migration source.");
      }
      continue;
    }
    if (!await probeObject(client, probe)) {
      throw new Error(`${migration.name} is missing a required postcondition: ${probe[0]}.`);
    }
  }
}

async function assertCoreObjects(client) {
  const result = await client.query(`
    SELECT
      to_regclass('public.petro_plans') IS NOT NULL AS plans,
      to_regclass('public.petro_plan_versions') IS NOT NULL AS versions,
      to_regclass('public.petro_organizations') IS NOT NULL AS organizations,
      to_regclass('public.petro_branches') IS NOT NULL AS branches,
      to_regclass('public.petro_profiles') IS NOT NULL AS profiles,
      to_regclass('public.petro_platform_roles') IS NOT NULL AS platform_roles,
      to_regclass('public.petro_audit_events') IS NOT NULL AS audit_events,
      to_regclass('auth.users') IS NOT NULL AS auth_users,
       to_regclass('supabase_migrations.schema_migrations') IS NOT NULL AS migration_ledger,
       to_regclass('storage.buckets') IS NOT NULL AS storage_bucket_catalog
  `);
  if (Object.values(result.rows[0]).some((value) => !value)) {
    throw new Error("The approved project's current schema does not satisfy the reviewed migration prerequisites.");
  }
  const bucket = await client.query(
    "SELECT public FROM storage.buckets WHERE id='petro-private-documents'",
  );
  if (bucket.rowCount !== 1 || bucket.rows[0].public) {
    throw new Error("The existing private document bucket is missing or public; no migration was applied.");
  }
}

async function assertFleet0016Baseline(client) {
  const tableNames = [
    "petro_fleet_policy_versions",
    "petro_fleet_usage_reservations",
    "petro_vehicle_credentials",
    "petro_fleet_credential_requests",
    "petro_vehicle_odometer_events",
    "petro_vehicle_maintenance_records",
    "petro_documents",
  ];
  const constraints = await client.query(`
    SELECT relation.relname AS table_name, constraint_row.conname,
           pg_get_constraintdef(constraint_row.oid) AS definition,
           constraint_row.convalidated
    FROM pg_constraint constraint_row
    JOIN pg_class relation ON relation.oid=constraint_row.conrelid
    JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    WHERE namespace.nspname='public' AND relation.relname=ANY($1::text[])
      AND constraint_row.contype='f'
    ORDER BY relation.relname,constraint_row.conname
  `, [tableNames]);
  const normalize = (value) => value.replace(/\s+/g, " ").replaceAll("public.", "");
  const expectedDefinition =
    "FOREIGN KEY (vehicle_id, organization_id, branch_id) REFERENCES petro_fleet_vehicles(id, organization_id, branch_id) ON DELETE RESTRICT";
  for (const tableName of tableNames) {
    const matching = constraints.rows.filter((row) =>
      row.table_name === tableName && normalize(row.definition) === expectedDefinition
    );
    if (matching.length !== 1 || !matching[0].convalidated) {
      throw new Error(
        `0016 FK preflight mismatch on ${tableName}: expected exactly one validated vehicle/organization/branch FK; found ${matching.length}.`,
      );
    }
  }
  for (const [tableName, constraintName] of [
    ["petro_fleet_policy_versions", "petro_fleet_policy_versions_vehicle_scope_fk"],
    ["petro_fleet_usage_reservations", "petro_fleet_usage_reservation_vehicle_scope_fk"],
    ["petro_documents", "petro_documents_vehicle_scope_fk"],
  ]) {
    if (!constraints.rows.some((row) =>
      row.table_name === tableName && row.conname === constraintName
      && normalize(row.definition) === expectedDefinition && row.convalidated
    )) {
      throw new Error(`0016 FK preflight found a changed named constraint: ${tableName}.${constraintName}.`);
    }
  }
  if (constraints.rows.some((row) =>
    row.table_name === "petro_fleet_usage_reservations"
    && row.conname === "petro_fleet_usage_reservation_branch_scope_fk"
  )) {
    throw new Error("0016 branch-snapshot FK already exists without its migration ledger record.");
  }
  const vehicleKey = await client.query(`
    SELECT pg_get_constraintdef(oid) AS definition,convalidated
    FROM pg_constraint
    WHERE conrelid='public.petro_fleet_vehicles'::regclass
      AND conname='petro_fleet_vehicles_id_org_unique' AND contype='u'
  `);
  if (
    vehicleKey.rowCount !== 1
    || !vehicleKey.rows[0].convalidated
    || normalize(vehicleKey.rows[0].definition) !== "UNIQUE (id, organization_id)"
  ) {
    throw new Error("0016 requires the exact existing (id, organization_id) vehicle key; no duplicate key will be added.");
  }
  const command = await client.query(
    "SELECT pg_get_functiondef($1::regprocedure) AS definition",
    ["public.petro_admin_fleet_command(text,jsonb,text,text)"],
  );
  const originalLinkInsert = /INSERT\s+INTO\s+public\.petro_fleet_driver_links\s*\(\s*organization_id\s*,\s*vehicle_id\s*,\s*driver_id\s*,\s*reason\s*,\s*created_by\s*\)\s*VALUES\s*\(\s*org_id\s*,\s*vehicle_id\s*,\s*driver_id\s*,\s*p_reason\s*,\s*actor\s*\)\s*RETURNING\s+id\s+INTO\s+link_id\s*;/i;
  if (!originalLinkInsert.test(command.rows[0]?.definition ?? "")) {
    throw new Error("0016 driver-link command differs from the reviewed source; no function rewrite will be attempted.");
  }
  const counts = await client.query(`
    SELECT
      (SELECT count(*) FROM public.petro_fleet_vehicles)::bigint AS vehicles,
      (SELECT count(*) FROM public.petro_fleet_policy_versions)::bigint AS policies,
      (SELECT count(*) FROM public.petro_fleet_usage_reservations)::bigint AS reservations,
      (SELECT count(*) FROM public.petro_vehicle_credentials)::bigint AS credentials,
      (SELECT count(*) FROM public.petro_fleet_credential_requests)::bigint AS credential_requests,
      (SELECT count(*) FROM public.petro_vehicle_odometer_events)::bigint AS odometer_events,
      (SELECT count(*) FROM public.petro_vehicle_maintenance_records)::bigint AS maintenance_records,
      (SELECT count(*) FROM public.petro_documents WHERE vehicle_id IS NOT NULL)::bigint AS vehicle_documents
  `);
  const snapshot = {
    constraints: constraints.rows.map((row) => ({
      table: row.table_name,
      name: row.conname,
      definition: normalize(row.definition),
      validated: row.convalidated,
    })),
    counts: counts.rows[0],
    driverCommandDefinitionSha256: hash(command.rows[0].definition),
  };
  return { snapshot, sha256: hash(JSON.stringify(snapshot)) };
}

async function assertPlatformUserFunctionPrivileges(client) {
  const functions = [
    "public.petro_admin_list_platform_users(integer,integer,text,text,text)",
    "public.petro_admin_get_platform_user(uuid)",
    "public.petro_admin_set_platform_roles(uuid,text[],text)",
    "public.petro_admin_set_account_status(uuid,text,text)",
  ];
  for (const signature of functions) {
    const result = await client.query(`
      SELECT has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') AS authenticated_execute,
             has_function_privilege('anon', $1::regprocedure, 'EXECUTE') AS anon_execute
    `, [signature]);
    if (!result.rows[0].authenticated_execute || result.rows[0].anon_execute) {
      throw new Error(`Platform-user RPC grants are not restricted to authenticated users: ${signature}`);
    }
  }
}

async function assertNo0009(client) {
  const result = await client.query(
    "SELECT count(*)::int AS count FROM supabase_migrations.schema_migrations WHERE name ILIKE '%0009%'",
  );
  if (result.rows[0].count !== 0) {
    throw new Error("A 0009 ledger row exists; this release must leave 0009 deferred.");
  }
}

async function assertNoLegacyConsumedReservations(client) {
  const result = await client.query(`
    SELECT count(*)::int AS count
    FROM public.petro_finance_reservations
    WHERE status='consumed'
  `);
  if (result.rows[0].count !== 0) {
    throw new Error(
      "0013 requires an approved mapping for existing consumed reservations; no mapping is guessed or applied.",
    );
  }
}

async function assertCatalog0018Baseline(client) {
  const result = await client.query(`
    SELECT
      (SELECT count(*)::int
       FROM public.petro_fuel_types
       WHERE vehicle_fuel_family NOT IN ('gasoline','diesel') OR unit_code<>'litre') AS incompatible_fuel_types,
      (SELECT count(*)::int
       FROM public.petro_catalog_items item
       JOIN public.petro_catalog_categories category ON category.id=item.category_id
       WHERE category.code='wash' AND (item.item_kind<>'service' OR item.unit_code<>'service')) AS incompatible_wash_units,
      (SELECT count(*)::int
       FROM public.petro_catalog_items item
       JOIN public.petro_catalog_categories category ON category.id=item.category_id
       WHERE category.code<>'fuel'
         AND NOT petro_private.catalog_attributes_valid(category.code,item.attributes)) AS invalid_catalog_attributes,
      (SELECT count(*)::int
       FROM public.petro_branches
       WHERE NOT petro_private.petro_valid_branch_hours(hours)) AS invalid_branch_hours
  `);
  const snapshot = result.rows[0];
  if (Object.values(snapshot).some((count) => Number(count) !== 0)) {
    throw new Error(
      `0018 affected-resource preflight found incompatible rows; no migration applied. Counts=${JSON.stringify(snapshot)}`,
    );
  }
  return { snapshot, sha256: hash(JSON.stringify(snapshot)) };
}

async function assertCatalog0019Baseline(client) {
  const result = await client.query(`
    SELECT count(*)::int AS incomplete_wash_variants
    FROM public.petro_catalog_items item
    JOIN public.petro_catalog_categories category ON category.id=item.category_id
    WHERE category.code='wash'
      AND (
        item.item_kind<>'service' OR item.unit_code<>'service'
        OR item.attributes->>'washMode' NOT IN ('interior','exterior','interior_exterior')
        OR coalesce(length(btrim(item.attributes->>'vehicleType')),0)=0
        OR coalesce(length(btrim(item.attributes->>'vehicleSize')),0)=0
      )
  `);
  const snapshot = result.rows[0];
  if (Number(snapshot.incomplete_wash_variants) !== 0) {
    throw new Error(
      `0019 preflight found incomplete existing wash variants; no migration applied. Count=${snapshot.incomplete_wash_variants}`,
    );
  }
  return { snapshot, sha256: hash(JSON.stringify(snapshot)) };
}

async function runPreflight(client, migrations) {
  const identity = await client.query(`
    SELECT current_database() AS database_name, current_user AS database_user,
           current_setting('server_version_num')::int AS server_version_num,
           ssl, version AS tls_version
    FROM pg_stat_ssl
    WHERE pid=pg_backend_pid()
  `);
  if (identity.rowCount !== 1 || !identity.rows[0].ssl || !["TLSv1.2", "TLSv1.3"].includes(identity.rows[0].tls_version)) {
    throw new Error("Database connection did not negotiate verified TLS.");
  }
  await assertCoreObjects(client);
  await assertNo0009(client);
  const acl = await getDefaultAcl(client);
  const legacy = await getLegacyFunctionSnapshot(client);
  await validateMigrationLedger(client, migrations);
  const financeCore = migrations.find((migration) => migration.name === "0012_finance_core");
  const financeCapture = migrations.find((migration) =>
    migration.name === "0013_finance_receipt_detail_and_reservation_capture");
  if (financeCore?.liveState === "complete" && financeCapture?.liveState === "absent") {
    await assertFinanceEntryTypeConstraintBaseline(client);
    await assertNoLegacyConsumedReservations(client);
  }
  const fleetHistoryMigration = migrations.find(
    (migration) => migration.name === "0016_fleet_history_and_admin_directory",
  );
  const fleetBaseline = fleetHistoryMigration?.liveState === "absent"
    ? await assertFleet0016Baseline(client)
    : null;
  const catalogGuardMigration = migrations.find(
    (migration) => migration.name === "0018_catalog_contract_guards",
  );
  const catalog0018Baseline = catalogGuardMigration?.liveState === "absent"
    ? await assertCatalog0018Baseline(client)
    : null;
  const catalogUpdateGuardMigration = migrations.find(
    (migration) => migration.name === "0019_wash_variant_update_guard",
  );
  const catalog0019Baseline = catalogUpdateGuardMigration?.liveState === "absent"
    ? await assertCatalog0019Baseline(client)
    : null;
  return { identity: identity.rows[0], acl, legacy, fleetBaseline, catalog0018Baseline, catalog0019Baseline };
}

async function applyOne(client, migration, aclBaseline, legacyBaseline, fleetBaseline, catalog0018Baseline, catalog0019Baseline) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('pertomax-approved-admin-migrations', 0))");
    await assertNo0009(client);
    const existing = await getLedgerRows(client, [migration.name]);
    const state = await getMigrationState(client, migration);
    if (existing.length === 1 && state.status === "complete" && existing[0].statements?.includes(migration.source)) {
      await client.query("COMMIT");
      migration.liveState = "complete";
      migration.recorded = true;
      return "already-applied";
    }
    if (existing.length !== 0 || state.status !== "absent") {
      throw new Error(`${migration.name} changed after preflight; transaction aborted without applying it.`);
    }
    if (migration.name === "0013_finance_receipt_detail_and_reservation_capture") {
      await assertFinanceEntryTypeConstraintBaseline(client);
      await assertNoLegacyConsumedReservations(client);
    }
    if (migration.name === "0016_fleet_history_and_admin_directory") {
      if (!fleetBaseline) throw new Error("0016 has no saved pre-application snapshot.");
      const liveBaseline = await assertFleet0016Baseline(client);
      if (liveBaseline.sha256 !== fleetBaseline.sha256) {
        throw new Error("0016 affected constraints or table counts changed after preflight; transaction aborted.");
      }
    }
    if (migration.name === "0018_catalog_contract_guards") {
      if (!catalog0018Baseline) throw new Error("0018 has no saved affected-resource preflight snapshot.");
      const liveBaseline = await assertCatalog0018Baseline(client);
      if (liveBaseline.sha256 !== catalog0018Baseline.sha256) {
        throw new Error("0018 affected catalog or branch data changed after preflight; transaction aborted.");
      }
    }
    if (migration.name === "0019_wash_variant_update_guard") {
      if (!catalog0019Baseline) throw new Error("0019 has no saved wash-variant preflight snapshot.");
      const liveBaseline = await assertCatalog0019Baseline(client);
      if (liveBaseline.sha256 !== catalog0019Baseline.sha256) {
        throw new Error("0019 wash variant rows changed after preflight; transaction aborted.");
      }
    }

    await client.query(migration.body);
    const appliedState = await getMigrationState(client, migration);
    if (appliedState.status !== "complete") {
      const missing = appliedState.results.filter((result) => !result.present).map((result) => result.label);
      throw new Error(`${migration.name} did not create every reviewed object; missing=[${missing.join(", ")}]; transaction rolled back.`);
    }
    if (migration.postconditions?.length) {
      await assertPostconditions(client, migration);
    }
    if (migration.name === "0008_platform_user_administration") {
      await assertPlatformUserFunctionPrivileges(client);
    }
    if (
      migration.name === "0012_finance_core"
      && !await probeObject(client, ["financeInitialSeedState"])
    ) {
      throw new Error("0012 created unexpected accounts or financial records; transaction rolled back.");
    }
    const aclAfter = await getDefaultAcl(client);
    if (
      aclAfter.scopeCount !== aclBaseline.scopeCount
      || JSON.stringify(aclAfter.rows) !== JSON.stringify(aclBaseline.rows)
    ) {
      throw new Error(`${migration.name} changed default ACLs; transaction rolled back.`);
    }
    const legacyAfter = await getLegacyFunctionSnapshot(client);
    if (JSON.stringify(legacyAfter) !== JSON.stringify(legacyBaseline)) {
      throw new Error(`${migration.name} changed the legacy function or grants; transaction rolled back.`);
    }

    const versionResult = await client.query(`
      SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISS') AS version
    `);
    let version = versionResult.rows[0].version;
    while ((await client.query(
      "SELECT 1 FROM supabase_migrations.schema_migrations WHERE version=$1",
      [version],
    )).rowCount > 0) {
      const next = await client.query(`
        SELECT to_char((clock_timestamp() AT TIME ZONE 'UTC') + interval '1 second', 'YYYYMMDDHH24MISS') AS version
      `);
      version = next.rows[0].version;
    }
    await client.query(
      `INSERT INTO supabase_migrations.schema_migrations (version, name, statements, created_by)
       VALUES ($1, $2, ARRAY[$3]::text[], $4)`,
      [version, migration.name, migration.source, `pertomax-approved-rollout:${migration.sha256}`],
    );
    await client.query("COMMIT");
    migration.liveState = "complete";
    migration.recorded = true;
    migration.version = version;
    return "applied";
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function main() {
  const migrations = loadMigrations();
  const selectedMigrations = selectedMigrationName
    ? migrations.filter((migration) => migration.name === selectedMigrationName)
    : migrations;
  const options = loadDatabaseOptions();
  const client = new Client(options);
  await client.connect();
  try {
    const preflight = await runPreflight(client, migrations);
    console.log(`Verified target Supabase project ${PROJECT_REF}; PostgreSQL ${preflight.identity.server_version_num}, ${preflight.identity.tls_version}.`);
    console.log(`Snapshotted ${preflight.acl.scopeCount} live default-ACL scopes and ${preflight.acl.rows.length} grant rows (sha256 ${preflight.acl.sha256}); legacy RPC snapshot captured.`);
    const legacyStatusRpc = preflight.legacy.find((row) => row.proname === "petro_set_account_status");
    const adminStatusRpc = preflight.legacy.find((row) => row.proname === "petro_admin_set_account_status");
    console.log(`Status RPC ACLs: old=${legacyStatusRpc.definition_md5} (authenticated=${legacyStatusRpc.authenticated_execute}, service_role=${legacyStatusRpc.service_role_execute}, anon=${legacyStatusRpc.anon_execute}); 0008=${adminStatusRpc.definition_md5} (authenticated=${adminStatusRpc.authenticated_execute}, anon=${adminStatusRpc.anon_execute}).`);
    if (preflight.fleetBaseline) {
      console.log(
        `0016 exact preflight matched its seven historical vehicle-scope FKs and existing vehicle key; affected-row counts ${JSON.stringify(preflight.fleetBaseline.snapshot.counts)}; snapshot sha256 ${preflight.fleetBaseline.sha256}.`,
      );
    }
    if (preflight.catalog0018Baseline) {
      console.log(
        `0018 affected-resource preflight found no incompatible fuel units, wash variants, catalog attributes, or branch hours; snapshot ${JSON.stringify(preflight.catalog0018Baseline.snapshot)} sha256 ${preflight.catalog0018Baseline.sha256}.`,
      );
    }
    if (preflight.catalog0019Baseline) {
      console.log(
        `0019 affected-resource preflight found zero incomplete wash variants; snapshot ${JSON.stringify(preflight.catalog0019Baseline.snapshot)} sha256 ${preflight.catalog0019Baseline.sha256}.`,
      );
    }
    if (!apply) {
      console.log("DRY RUN ONLY: no schema or ledger writes made. Reviewed migrations:");
      for (const migration of selectedMigrations) {
        console.log(`- ${migration.name}: ${migration.liveState}${migration.recorded ? " (source fingerprint matched)" : ""}; sha256 ${migration.sha256}`);
      }
      console.log("To apply, explicitly pass --apply --project-ref=msvgzsfzrqlrfpstthhe.");
      return;
    }

    console.log(`APPLY MODE: selected ${selectedMigrations.map((migration) => migration.name).join(", ")} only; 0009 and historical migrations are excluded.`);
    for (const migration of selectedMigrations) {
      if (migration.recorded) {
        console.log(`${migration.name}: already applied with exact source; skipped.`);
        continue;
      }
      const result = await applyOne(
        client, migration, preflight.acl, preflight.legacy, preflight.fleetBaseline,
        preflight.catalog0018Baseline, preflight.catalog0019Baseline,
      );
      console.log(`${migration.name}: ${result}${migration.version ? `; ledger version ${migration.version}` : ""}; sha256 ${migration.sha256}.`);
    }
    const postflight = await runPreflight(client, migrations);
    await assertPlatformUserFunctionPrivileges(client);
    console.log(`Postflight passed; ${postflight.acl.scopeCount} live default-ACL scopes and ${postflight.acl.rows.length} grant rows unchanged (sha256 ${postflight.acl.sha256}), legacy RPC and grants unchanged, 0009 still deferred.`);
    for (const migration of migrations) console.log(`${migration.name}: ${migration.liveState} and exact source recorded.`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`Approved Pertomax migration runner stopped safely: ${error.message}`);
  process.exitCode = 1;
});
