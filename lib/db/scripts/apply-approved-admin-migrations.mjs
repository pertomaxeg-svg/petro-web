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
    ],
    postconditions: [
      ["financeRls"],
      ["financeNoDirectTableAccess"],
      ["financeAdminFunctionPrivileges"],
      ["financePrivateFunctionPrivileges"],
    ],
  },
];

const inputFlags = new Set(process.argv.slice(2).filter((flag) => flag !== "--"));
const apply = inputFlags.has("--apply");
for (const flag of inputFlags) {
  if (flag !== "--apply" && flag !== `--project-ref=${PROJECT_REF}`) {
    throw new Error(`Unsupported argument: ${flag}`);
  }
}
if (apply && !inputFlags.has(`--project-ref=${PROJECT_REF}`)) {
  throw new Error(`Applying requires the explicit --project-ref=${PROJECT_REF} confirmation.`);
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
      SELECT count(*)=24
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
            'finance_reserve_funds','finance_release_reservation'
          )
          AND (has_function_privilege('anon',proc.oid,'EXECUTE')
            OR has_function_privilege('authenticated',proc.oid,'EXECUTE'))
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
  return { identity: identity.rows[0], acl, legacy };
}

async function applyOne(client, migration, aclBaseline, legacyBaseline) {
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

    await client.query(migration.body);
    const appliedState = await getMigrationState(client, migration);
    if (appliedState.status !== "complete") {
      throw new Error(`${migration.name} did not create every reviewed object; transaction rolled back.`);
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
    if (!apply) {
      console.log("DRY RUN ONLY: no schema or ledger writes made. Reviewed migrations:");
      for (const migration of migrations) {
        console.log(`- ${migration.name}: ${migration.liveState}${migration.recorded ? " (source fingerprint matched)" : ""}; sha256 ${migration.sha256}`);
      }
      console.log("To apply, explicitly pass --apply --project-ref=msvgzsfzrqlrfpstthhe.");
      return;
    }

    console.log("APPLY MODE: only reviewed 0008, 0010, 0011, and 0012 are eligible; 0009 and historical migrations are excluded.");
    for (const migration of migrations) {
      if (migration.recorded) {
        console.log(`${migration.name}: already applied with exact source; skipped.`);
        continue;
      }
      const result = await applyOne(client, migration, preflight.acl, preflight.legacy);
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
