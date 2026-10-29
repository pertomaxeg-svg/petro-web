#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script_dir="$repo_root/lib/db/rebuild"
schema_dump="$script_dir/current-schema.sql"
tmp_dir="$(mktemp -d /tmp/pertomax-db01.XXXXXX)"
pg_started=0

cleanup() {
  if [ "$pg_started" -eq 1 ]; then
    pg_ctl -D "$tmp_dir/data" -m immediate stop >/dev/null 2>&1 || true
  fi
  rm -rf -- "$tmp_dir"
}
trap cleanup EXIT

for command_name in initdb pg_ctl psql pg_dump pg_basebackup; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing PostgreSQL 17 tool: $command_name" >&2
    exit 2
  fi
done

pg_dump_version="$(pg_dump --version | sed -E 's/.*\) ([0-9]+)\..*/\1/')"
if [ "$pg_dump_version" != "17" ]; then
  echo "This test requires PostgreSQL 17 tools; pg_dump major is $pg_dump_version." >&2
  exit 2
fi
if [ ! -s "$schema_dump" ]; then
  echo "Schema snapshot is missing: $schema_dump" >&2
  exit 2
fi

mkdir -p "$tmp_dir/socket"
initdb -D "$tmp_dir/data" --username=postgres --auth-local=trust \
  --auth-host=reject --no-instructions >"$tmp_dir/initdb.log" 2>&1
pg_ctl -D "$tmp_dir/data" \
  -o "-c listen_addresses='' -c unix_socket_directories='$tmp_dir/socket' -c port=55444 -c shared_preload_libraries=pg_cron -c cron.database_name=postgres -c cron.use_background_workers=on -c max_worker_processes=16" \
  -l "$tmp_dir/postgres.log" start >/dev/null
pg_started=1

export PGHOST="$tmp_dir/socket"
export PGPORT=55444
export PGUSER=postgres
export PGDATABASE=postgres

psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$script_dir/local-auth-bootstrap.sql" >/dev/null

# A new PostgreSQL database already has public; omit only that duplicate schema statement.
sed '/^CREATE SCHEMA public;$/d' "$schema_dump" |
  psql --no-psqlrc --single-transaction --set ON_ERROR_STOP=1 >/dev/null
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$script_dir/local-auth-post-baseline.sql" >/dev/null
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$script_dir/local-storage-bootstrap.sql" >/dev/null
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$script_dir/live-default-acl-fixture.sql" >/dev/null

psql --no-psqlrc --set ON_ERROR_STOP=1 <<'SQL' >/dev/null
DO $$
DECLARE
  table_count integer;
  constraint_count integer;
  index_count integer;
  function_count integer;
  policy_count integer;
  rls_count integer;
  trigger_count integer;
BEGIN
  SELECT count(*) INTO table_count
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'petro_private') AND c.relkind = 'r';
  SELECT count(*) INTO constraint_count
  FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = r.relnamespace
  WHERE n.nspname IN ('public', 'petro_private');
  SELECT count(*) INTO index_count
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'petro_private') AND c.relkind = 'i';
  SELECT count(*) INTO function_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public', 'petro_private');
  SELECT count(*) INTO policy_count
  FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'petro_private');
  SELECT count(*) INTO rls_count
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'petro_private')
    AND c.relkind = 'r' AND c.relrowsecurity;
  SELECT count(*) INTO trigger_count
  FROM pg_trigger t
  WHERE t.tgrelid = 'auth.users'::regclass AND NOT t.tgisinternal
    AND t.tgfoid = 'petro_private.handle_auth_user()'::regprocedure
    AND t.tgenabled IN ('O', 'A');

  IF table_count <> 11 OR constraint_count <> 57 OR index_count <> 22
     OR function_count <> 23 OR policy_count <> 12 OR rls_count <> 11
     OR trigger_count <> 1 THEN
    RAISE EXCEPTION
      'reconstructed schema metadata counts differ from approved snapshot (tables %, constraints %, indexes %, functions %, policies %, RLS %, auth triggers %)',
      table_count, constraint_count, index_count, function_count,
      policy_count, rls_count, trigger_count;
  END IF;
END
$$;
SQL

# Compare the imported baseline before applying any later migration.
pg_dump --no-owner --schema-only --schema=public --schema=petro_private \
  >"$tmp_dir/rebuilt-baseline.sql"
node "$script_dir/normalize-pg-dump.mjs" "$schema_dump" >"$tmp_dir/source-normalized.sql"
node "$script_dir/normalize-pg-dump.mjs" "$tmp_dir/rebuilt-baseline.sql" >"$tmp_dir/rebuilt-normalized.sql"
if ! cmp -s "$tmp_dir/source-normalized.sql" "$tmp_dir/rebuilt-normalized.sql"; then
  echo "Fresh baseline differs from the saved schema snapshot:" >&2
  diff -u "$tmp_dir/source-normalized.sql" "$tmp_dir/rebuilt-normalized.sql" |
    sed -n '1,100p' >&2 || true
  exit 1
fi

# DB-01 tests the audited baseline before the already-approved DB-02 forward migration.
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$script_dir/rls-smoke-test.sql" >/dev/null

# The current snapshot already contains 0001-0003; do not replay them.
# 0004 is already applied in the live project but deliberately absent from its
# Supabase ledger. A fresh isolated rebuild must apply 0004 once before 0005;
# this script never connects to Supabase and never changes that ledger.
default_acl_snapshot() {
  psql --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
    --command="SELECT COALESCE(string_agg(format('%s|%s|%s|%s', defaclrole::regrole, defaclnamespace::regnamespace, defaclobjtype, COALESCE(defaclacl::text, '')), E'\\n' ORDER BY defaclrole, defaclnamespace, defaclobjtype), '') FROM pg_default_acl;"
}
# Prepare the retained scheduler dependency after baseline verification and before app schema snapshots.
default_acl_snapshot >"$tmp_dir/default-acl-before-cron-dependency.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog; REVOKE ALL ON SCHEMA cron FROM PUBLIC,anon,authenticated,service_role;" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-cron-dependency.txt"
cmp "$tmp_dir/default-acl-before-cron-dependency.txt" "$tmp_dir/default-acl-after-cron-dependency.txt"
default_acl_snapshot >"$tmp_dir/default-acl-before-0004.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$repo_root/lib/db/migrations/0004_db02_invitation_permissions.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0004.txt"
if ! cmp -s "$tmp_dir/default-acl-before-0004.txt" "$tmp_dir/default-acl-after-0004.txt"; then
  echo "DB-02 unexpectedly changed one or more default ACLs:" >&2
  diff -u "$tmp_dir/default-acl-before-0004.txt" "$tmp_dir/default-acl-after-0004.txt" >&2 || true
  exit 1
fi
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$script_dir/db02-privilege-test.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-before-0005.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$repo_root/lib/db/migrations/0005_central_organizations_branches.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0005.txt"
if ! cmp -s "$tmp_dir/default-acl-before-0005.txt" "$tmp_dir/default-acl-after-0005.txt"; then
  echo "0005 unexpectedly changed one or more default ACLs:" >&2
  diff -u "$tmp_dir/default-acl-before-0005.txt" "$tmp_dir/default-acl-after-0005.txt" >&2 || true
  exit 1
fi
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$script_dir/central-organizations-smoke-test.sql" >/dev/null
if [ -n "${PERTOMAX_EXPECTED_SCHEMA_DUMP:-}" ]; then
  mkdir -p "$(dirname "$PERTOMAX_EXPECTED_SCHEMA_DUMP")"
  pg_dump --no-owner --no-privileges --schema-only \
    --schema=public --schema=petro_private \
    >"$PERTOMAX_EXPECTED_SCHEMA_DUMP"
fi
default_acl_snapshot >"$tmp_dir/default-acl-before-0006.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$repo_root/lib/db/migrations/0006_organization_requests_documents_banking.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0006.txt"
if ! cmp -s "$tmp_dir/default-acl-before-0006.txt" "$tmp_dir/default-acl-after-0006.txt"; then
  echo "0006 unexpectedly changed one or more default ACLs:" >&2
  diff -u "$tmp_dir/default-acl-before-0006.txt" "$tmp_dir/default-acl-after-0006.txt" >&2 || true
  exit 1
fi
if [ -n "${PERTOMAX_DEFAULT_ACL_DUMP_0006:-}" ]; then
  mkdir -p "$(dirname "$PERTOMAX_DEFAULT_ACL_DUMP_0006")"
  default_acl_snapshot >"$PERTOMAX_DEFAULT_ACL_DUMP_0006"
fi
if [ -n "${PERTOMAX_EXPECTED_SCHEMA_DUMP_0006:-}" ]; then
  mkdir -p "$(dirname "$PERTOMAX_EXPECTED_SCHEMA_DUMP_0006")"
  pg_dump --no-owner --no-privileges --schema-only \
    --schema=public --schema=petro_private |
    node "$script_dir/normalize-pg-dump.mjs" \
    >"$PERTOMAX_EXPECTED_SCHEMA_DUMP_0006"
fi
default_acl_snapshot >"$tmp_dir/default-acl-before-0007.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$repo_root/lib/db/migrations/0007_confirmed_pending_join_applicants.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0007.txt"
if ! cmp -s "$tmp_dir/default-acl-before-0007.txt" "$tmp_dir/default-acl-after-0007.txt"; then
  echo "0007 unexpectedly changed one or more default ACLs:" >&2
  diff -u "$tmp_dir/default-acl-before-0007.txt" "$tmp_dir/default-acl-after-0007.txt" >&2 || true
  exit 1
fi
if [ -n "${PERTOMAX_DEFAULT_ACL_DUMP_0007:-}" ]; then
  mkdir -p "$(dirname "$PERTOMAX_DEFAULT_ACL_DUMP_0007")"
  default_acl_snapshot >"$PERTOMAX_DEFAULT_ACL_DUMP_0007"
fi
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$script_dir/organization-workflows-smoke-test.sql" >/dev/null
if [ -n "${PERTOMAX_EXPECTED_SCHEMA_DUMP_0007:-}" ]; then
  mkdir -p "$(dirname "$PERTOMAX_EXPECTED_SCHEMA_DUMP_0007")"
  pg_dump --no-owner --no-privileges --schema-only \
    --schema=public --schema=petro_private |
    node "$script_dir/normalize-pg-dump.mjs" \
    >"$PERTOMAX_EXPECTED_SCHEMA_DUMP_0007"
fi

# Plan authoring is independent of platform-user administration and the
# deferred 0009 migration, so verify 0010/0011 before applying 0008.
default_acl_snapshot >"$tmp_dir/default-acl-before-0010.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$repo_root/lib/db/migrations/0010_plan_subscription_admin.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0010.txt"
if ! cmp -s "$tmp_dir/default-acl-before-0010.txt" "$tmp_dir/default-acl-after-0010.txt"; then
  echo "0010 unexpectedly changed one or more default ACLs:" >&2
  diff -u "$tmp_dir/default-acl-before-0010.txt" "$tmp_dir/default-acl-after-0010.txt" >&2 || true
  exit 1
fi
default_acl_snapshot >"$tmp_dir/default-acl-before-0011.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$repo_root/lib/db/migrations/0011_plan_authoring_and_provider_pricing.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0011.txt"
if ! cmp -s "$tmp_dir/default-acl-before-0011.txt" "$tmp_dir/default-acl-after-0011.txt"; then
  echo "0011 unexpectedly changed one or more default ACLs:" >&2
  diff -u "$tmp_dir/default-acl-before-0011.txt" "$tmp_dir/default-acl-after-0011.txt" >&2 || true
  exit 1
fi
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$script_dir/plan-subscription-admin-smoke-test.sql" >/dev/null

default_acl_snapshot >"$tmp_dir/default-acl-before-0008.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$repo_root/lib/db/migrations/0008_platform_user_administration.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0008.txt"
if ! cmp -s "$tmp_dir/default-acl-before-0008.txt" "$tmp_dir/default-acl-after-0008.txt"; then
  echo "0008 unexpectedly changed one or more default ACLs:" >&2
  diff -u "$tmp_dir/default-acl-before-0008.txt" "$tmp_dir/default-acl-after-0008.txt" >&2 || true
  exit 1
fi
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$script_dir/platform-user-administration-smoke-test.sql" >/dev/null
if [ -n "${PERTOMAX_EXPECTED_SCHEMA_DUMP_0008:-}" ]; then
  mkdir -p "$(dirname "$PERTOMAX_EXPECTED_SCHEMA_DUMP_0008")"
  pg_dump --no-owner --no-privileges --schema-only \
    --schema=public --schema=petro_private |
    node "$script_dir/normalize-pg-dump.mjs" \
    >"$PERTOMAX_EXPECTED_SCHEMA_DUMP_0008"
fi
default_acl_snapshot >"$tmp_dir/default-acl-before-0012.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$repo_root/lib/db/migrations/0012_finance_core.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0012.txt"
if ! cmp -s "$tmp_dir/default-acl-before-0012.txt" "$tmp_dir/default-acl-after-0012.txt"; then
  echo "0012 unexpectedly changed one or more default ACLs:" >&2
  diff -u "$tmp_dir/default-acl-before-0012.txt" "$tmp_dir/default-acl-after-0012.txt" >&2 || true
  exit 1
fi
default_acl_snapshot >"$tmp_dir/default-acl-before-0013.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$repo_root/lib/db/migrations/0013_finance_receipt_detail_and_reservation_capture.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0013.txt"
if ! cmp -s "$tmp_dir/default-acl-before-0013.txt" "$tmp_dir/default-acl-after-0013.txt"; then
  echo "0013 unexpectedly changed one or more default ACLs:" >&2
  diff -u "$tmp_dir/default-acl-before-0013.txt" "$tmp_dir/default-acl-after-0013.txt" >&2 || true
  exit 1
fi
default_acl_snapshot >"$tmp_dir/default-acl-before-0014.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$repo_root/lib/db/migrations/0014_fleet_registry_and_controls.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0014.txt"
if ! cmp -s "$tmp_dir/default-acl-before-0014.txt" "$tmp_dir/default-acl-after-0014.txt"; then
  echo "0014 unexpectedly changed one or more default ACLs:" >&2
  diff -u "$tmp_dir/default-acl-before-0014.txt" "$tmp_dir/default-acl-after-0014.txt" >&2 || true
  exit 1
fi
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$script_dir/fleet-core-smoke-test.sql" >/dev/null
echo "0014 fleet local smoke passed: 36 assertions across role gates, idempotency, scope, PIN lock, policy immutability, QR/NFC readiness, odometer review, atomic import, and pagination for 10 catalog views."
default_acl_snapshot >"$tmp_dir/default-acl-before-0015.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$repo_root/lib/db/migrations/0015_fleet_subscription_options.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0015.txt"
if ! cmp -s "$tmp_dir/default-acl-before-0015.txt" "$tmp_dir/default-acl-after-0015.txt"; then
  echo "0015 unexpectedly changed one or more default ACLs:" >&2
  diff -u "$tmp_dir/default-acl-before-0015.txt" "$tmp_dir/default-acl-after-0015.txt" >&2 || true
  exit 1
fi
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$script_dir/fleet-subscription-options-smoke-test.sql" >/dev/null
echo "0015 fleet subscription selector smoke passed: active/scheduled vehicle plans, search, pagination, and role gate on synthetic subscriptions."
default_acl_snapshot >"$tmp_dir/default-acl-before-0016.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$repo_root/lib/db/migrations/0016_fleet_history_and_admin_directory.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0016.txt"
if ! cmp -s "$tmp_dir/default-acl-before-0016.txt" "$tmp_dir/default-acl-after-0016.txt"; then
  echo "0016 unexpectedly changed one or more default ACLs:" >&2
  diff -u "$tmp_dir/default-acl-before-0016.txt" "$tmp_dir/default-acl-after-0016.txt" >&2 || true
  exit 1
fi
default_acl_snapshot >"$tmp_dir/default-acl-before-0017.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$repo_root/lib/db/migrations/0017_catalog_services_and_fuel_pricing.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0017.txt"
if ! cmp -s "$tmp_dir/default-acl-before-0017.txt" "$tmp_dir/default-acl-after-0017.txt"; then
  echo "0017 unexpectedly changed one or more default ACLs:" >&2
  diff -u "$tmp_dir/default-acl-before-0017.txt" "$tmp_dir/default-acl-after-0017.txt" >&2 || true
  exit 1
fi
default_acl_snapshot >"$tmp_dir/default-acl-before-0018.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$repo_root/lib/db/migrations/0018_catalog_contract_guards.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0018.txt"
if ! cmp -s "$tmp_dir/default-acl-before-0018.txt" "$tmp_dir/default-acl-after-0018.txt"; then
  echo "0018 unexpectedly changed one or more default ACLs:" >&2
  diff -u "$tmp_dir/default-acl-before-0018.txt" "$tmp_dir/default-acl-after-0018.txt" >&2 || true
  exit 1
fi
default_acl_snapshot >"$tmp_dir/default-acl-before-0019.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$repo_root/lib/db/migrations/0019_wash_variant_update_guard.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0019.txt"
if ! cmp -s "$tmp_dir/default-acl-before-0019.txt" "$tmp_dir/default-acl-after-0019.txt"; then
  echo "0019 unexpectedly changed one or more default ACLs:" >&2
  diff -u "$tmp_dir/default-acl-before-0019.txt" "$tmp_dir/default-acl-after-0019.txt" >&2 || true
  exit 1
fi
default_acl_snapshot >"$tmp_dir/default-acl-before-0020.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$repo_root/lib/db/migrations/0020_platform_user_temporary_passwords.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0020.txt"
if ! cmp -s "$tmp_dir/default-acl-before-0020.txt" "$tmp_dir/default-acl-after-0020.txt"; then
  echo "0020 unexpectedly changed one or more default ACLs:" >&2
  diff -u "$tmp_dir/default-acl-before-0020.txt" "$tmp_dir/default-acl-after-0020.txt" >&2 || true
  exit 1
fi
default_acl_snapshot >"$tmp_dir/default-acl-before-0021.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$repo_root/lib/db/migrations/0021_inventory_and_plan_draft_repair.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0021.txt"
if ! cmp -s "$tmp_dir/default-acl-before-0021.txt" "$tmp_dir/default-acl-after-0021.txt"; then
  echo "0021 unexpectedly changed one or more default ACLs:" >&2
  diff -u "$tmp_dir/default-acl-before-0021.txt" "$tmp_dir/default-acl-after-0021.txt" >&2 || true
  exit 1
fi
default_acl_snapshot >"$tmp_dir/default-acl-before-0022.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$repo_root/lib/db/migrations/0022_fleet_onboarding_fulfillment_and_policy_groups.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0022.txt"
if ! cmp -s "$tmp_dir/default-acl-before-0022.txt" "$tmp_dir/default-acl-after-0022.txt"; then
  echo "0022 unexpectedly changed one or more default ACLs:" >&2
  diff -u "$tmp_dir/default-acl-before-0022.txt" "$tmp_dir/default-acl-after-0022.txt" >&2 || true
  exit 1
fi
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$script_dir/inventory-smoke-test.sql" >/dev/null
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$script_dir/platform-user-provisioning-smoke-test.sql" >/dev/null
psql --no-psqlrc --set ON_ERROR_STOP=1 <<'SQL' >/dev/null
DO $branch_hours_0018$
BEGIN
  IF NOT petro_private.petro_valid_branch_hours('{"sun":{"closed":false,"open24Hours":true},"mon":{"closed":true}}'::jsonb)
     OR petro_private.petro_valid_branch_hours('{"sun":{"closed":false,"open24Hours":true,"open":"09:00"}}'::jsonb)
     OR petro_private.petro_valid_branch_hours('{"sun":{"closed":false,"open24Hours":false}}'::jsonb) THEN
    RAISE EXCEPTION '0018 branch-hours contract validation failed';
  END IF;
END
$branch_hours_0018$;
SQL
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$script_dir/catalog-services-smoke-test.sql" >/dev/null
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$script_dir/finance-core-smoke-test.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-before-0023.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$repo_root/lib/db/migrations/0023_fleet_card_center_and_driver_pin_recovery.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0023.txt"
if ! cmp -s "$tmp_dir/default-acl-before-0023.txt" "$tmp_dir/default-acl-after-0023.txt"; then
  echo "0023 unexpectedly changed one or more default ACLs:" >&2
  diff -u "$tmp_dir/default-acl-before-0023.txt" "$tmp_dir/default-acl-after-0023.txt" >&2 || true
  exit 1
fi
default_acl_snapshot >"$tmp_dir/default-acl-before-0024.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$repo_root/lib/db/migrations/0024_fleet_card_history_onboarding_requests.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0024.txt"
if ! cmp -s "$tmp_dir/default-acl-before-0024.txt" "$tmp_dir/default-acl-after-0024.txt"; then
  echo "0024 unexpectedly changed one or more default ACLs:" >&2
  diff -u "$tmp_dir/default-acl-before-0024.txt" "$tmp_dir/default-acl-after-0024.txt" >&2 || true
  exit 1
fi
default_acl_snapshot >"$tmp_dir/default-acl-before-0025.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$repo_root/lib/db/migrations/0025_fleet_onboarding_limit_contract.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0025.txt"
if ! cmp -s "$tmp_dir/default-acl-before-0025.txt" "$tmp_dir/default-acl-after-0025.txt"; then
  echo "0025 unexpectedly changed one or more default ACLs:" >&2
  diff -u "$tmp_dir/default-acl-before-0025.txt" "$tmp_dir/default-acl-after-0025.txt" >&2 || true
  exit 1
fi
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$script_dir/fleet-onboarding-0022-smoke-test.sql" >/dev/null
echo "PASS: fleet onboarding policy-contract smoke test (local PostgreSQL)"
psql --no-psqlrc -At --set ON_ERROR_STOP=1 -c "SELECT md5(pg_get_functiondef(oid)),proacl::text FROM pg_proc WHERE oid='petro_private.fleet_check_usage_policy_at(uuid,uuid,uuid,uuid,text,bigint,numeric,timestamptz)'::regprocedure" >"$tmp_dir/evaluator-before-0026.txt"
default_acl_snapshot >"$tmp_dir/default-acl-before-0026.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$repo_root/lib/db/migrations/0026_fleet_fuel_tank_capacity_guard.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0026.txt"
cmp "$tmp_dir/default-acl-before-0026.txt" "$tmp_dir/default-acl-after-0026.txt"
psql --no-psqlrc -At --set ON_ERROR_STOP=1 -c "SELECT md5(pg_get_functiondef(oid)),proacl::text FROM pg_proc WHERE oid='public.petro_admin_fleet_cards_catalog(text,jsonb)'::regprocedure" >"$tmp_dir/cards-before-0027.txt"
default_acl_snapshot >"$tmp_dir/default-acl-before-0027.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/migrations/0027_fleet_issued_card_categories.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0027.txt"
cmp "$tmp_dir/default-acl-before-0027.txt" "$tmp_dir/default-acl-after-0027.txt"
psql --no-psqlrc -At --set ON_ERROR_STOP=1 -c "SELECT md5(pg_get_functiondef(oid)),proacl::text FROM pg_proc WHERE oid='public.petro_admin_fleet_catalog(text,jsonb)'::regprocedure" >"$tmp_dir/directory-before-0028.txt"
default_acl_snapshot >"$tmp_dir/default-acl-before-0028.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/migrations/0028_fleet_directory_photo_identity.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0028.txt"
cmp "$tmp_dir/default-acl-before-0028.txt" "$tmp_dir/default-acl-after-0028.txt"
psql --no-psqlrc -At --set ON_ERROR_STOP=1 -c "SELECT md5(pg_get_functiondef(oid)),proacl::text FROM pg_proc WHERE oid='public.petro_admin_fleet_cards_catalog(text,jsonb)'::regprocedure" >"$tmp_dir/cards-before-0029.txt"
default_acl_snapshot >"$tmp_dir/default-acl-before-0029.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/migrations/0029_fleet_card_fulfillment_filter.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0029.txt"
cmp "$tmp_dir/default-acl-before-0029.txt" "$tmp_dir/default-acl-after-0029.txt"
pg_dump --schema-only --no-owner --schema=public --schema=petro_private | node "$script_dir/normalize-pg-dump.mjs" >"$tmp_dir/schema-before-0030.sql"
default_acl_snapshot >"$tmp_dir/default-acl-before-0030.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/migrations/0030_worker_branch_service_assignments.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0030.txt"
cmp "$tmp_dir/default-acl-before-0030.txt" "$tmp_dir/default-acl-after-0030.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$script_dir/worker-assignments-0030-smoke-test.sql" >/dev/null
pg_dump --schema-only --no-owner --schema=public --schema=petro_private | node "$script_dir/normalize-pg-dump.mjs" >"$tmp_dir/schema-before-0031.sql"
default_acl_snapshot >"$tmp_dir/default-acl-before-0031.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/migrations/0031_operational_pin_proofs.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0031.txt"
cmp "$tmp_dir/default-acl-before-0031.txt" "$tmp_dir/default-acl-after-0031.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$script_dir/operational-pin-0031-smoke-test.sql" >/dev/null
pg_dump --schema-only --no-owner --schema=public --schema=petro_private | node "$script_dir/normalize-pg-dump.mjs" >"$tmp_dir/schema-before-0032.sql"
default_acl_snapshot >"$tmp_dir/default-acl-before-0032.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/migrations/0032_internal_usage_reservation_core.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0032.txt"
cmp "$tmp_dir/default-acl-before-0032.txt" "$tmp_dir/default-acl-after-0032.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$script_dir/reservation-core-0032-smoke-test.sql" >/dev/null
pg_dump --schema-only --no-owner --schema=public --schema=petro_private | node "$script_dir/normalize-pg-dump.mjs" >"$tmp_dir/schema-before-0033.sql"
default_acl_snapshot >"$tmp_dir/default-acl-before-0033.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/migrations/0033_worker_service_quotation.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0033.txt"
cmp "$tmp_dir/default-acl-before-0033.txt" "$tmp_dir/default-acl-after-0033.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$script_dir/service-quotation-0033-smoke-test.sql" >/dev/null
pg_dump --schema-only --no-owner --schema=public --schema=petro_private | node "$script_dir/normalize-pg-dump.mjs" >"$tmp_dir/schema-before-0034.sql"
default_acl_snapshot >"$tmp_dir/default-acl-before-0034.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/migrations/0034_system_execution_attribution.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0034.txt"
cmp "$tmp_dir/default-acl-before-0034.txt" "$tmp_dir/default-acl-after-0034.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$script_dir/system-attribution-0034-smoke-test.sql" >/dev/null
pg_dump --schema-only --no-owner --schema=public --schema=petro_private | node "$script_dir/normalize-pg-dump.mjs" >"$tmp_dir/schema-before-0035.sql"
default_acl_snapshot >"$tmp_dir/default-acl-before-0035.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/migrations/0035_service_order_reservation.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0035.txt"
cmp "$tmp_dir/default-acl-before-0035.txt" "$tmp_dir/default-acl-after-0035.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$script_dir/service-orders-0035-smoke-test.sql" >/dev/null
pg_dump --schema-only --no-owner --schema=public --schema=petro_private | node "$script_dir/normalize-pg-dump.mjs" >"$tmp_dir/schema-before-0036.sql"
default_acl_snapshot >"$tmp_dir/default-acl-before-0036.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/migrations/0036_service_execution_evidence.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0036.txt"
cmp "$tmp_dir/default-acl-before-0036.txt" "$tmp_dir/default-acl-after-0036.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$script_dir/service-execution-0036-smoke-test.sql" >/dev/null
pg_dump --schema-only --no-owner --schema=public --schema=petro_private | node "$script_dir/normalize-pg-dump.mjs" >"$tmp_dir/schema-before-0037.sql"
default_acl_snapshot >"$tmp_dir/default-acl-before-0037.txt"
test "$(psql --no-psqlrc -At --set ON_ERROR_STOP=1 --file="$script_dir/service-payment-0037-contract.sql")" = "f"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/migrations/0037_final_service_payment.sql" >/dev/null
test "$(psql --no-psqlrc -At --set ON_ERROR_STOP=1 --file="$script_dir/service-payment-0037-contract.sql")" = "t"
default_acl_snapshot >"$tmp_dir/default-acl-after-0037.txt"
cmp "$tmp_dir/default-acl-before-0037.txt" "$tmp_dir/default-acl-after-0037.txt"
pg_dump --schema-only --no-owner --schema=public --schema=petro_private | node "$script_dir/normalize-pg-dump.mjs" >"$tmp_dir/schema-before-0038.sql"
default_acl_snapshot >"$tmp_dir/default-acl-before-0038.txt"
test "$(psql --no-psqlrc -At --set ON_ERROR_STOP=1 --file="$script_dir/service-refund-intake-0038-contract.sql")" = "f"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/migrations/0038_service_refund_intake.sql" >/dev/null
test "$(psql --no-psqlrc -At --set ON_ERROR_STOP=1 --file="$script_dir/service-refund-intake-0038-contract.sql")" = "t"
default_acl_snapshot >"$tmp_dir/default-acl-after-0038.txt"
cmp "$tmp_dir/default-acl-before-0038.txt" "$tmp_dir/default-acl-after-0038.txt"
pg_dump --schema-only --no-owner --schema=public --schema=petro_private | node "$script_dir/normalize-pg-dump.mjs" >"$tmp_dir/schema-before-0039.sql"
default_acl_snapshot >"$tmp_dir/default-acl-before-0039.txt"
test "$(psql --no-psqlrc -At --set ON_ERROR_STOP=1 --file="$script_dir/service-refund-decisions-0039-contract.sql")" = "f"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/migrations/0039_service_refund_decisions.sql" >/dev/null
test "$(psql --no-psqlrc -At --set ON_ERROR_STOP=1 --file="$script_dir/service-refund-decisions-0039-contract.sql")" = "t"
default_acl_snapshot >"$tmp_dir/default-acl-after-0039.txt"
cmp "$tmp_dir/default-acl-before-0039.txt" "$tmp_dir/default-acl-after-0039.txt"
pg_dump --schema-only --no-owner --schema=public --schema=petro_private | node "$script_dir/normalize-pg-dump.mjs" >"$tmp_dir/schema-before-0040.sql"
default_acl_snapshot >"$tmp_dir/default-acl-before-0040.txt"
test "$(psql --no-psqlrc -At --set ON_ERROR_STOP=1 --file="$script_dir/operational-terminal-conflicts-0040-contract.sql")" = "f"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/migrations/0040_operational_terminal_conflicts.sql" >/dev/null
test "$(psql --no-psqlrc -At --set ON_ERROR_STOP=1 --file="$script_dir/operational-terminal-conflicts-0040-contract.sql")" = "t"
default_acl_snapshot >"$tmp_dir/default-acl-after-0040.txt"
cmp "$tmp_dir/default-acl-before-0040.txt" "$tmp_dir/default-acl-after-0040.txt"
pg_dump --schema-only --no-owner --schema=public --schema=petro_private | node "$script_dir/normalize-pg-dump.mjs" >"$tmp_dir/schema-before-0041.sql"
default_acl_snapshot >"$tmp_dir/default-acl-before-0041.txt"
test "$(psql --no-psqlrc -At --set ON_ERROR_STOP=1 --file="$script_dir/service-product-returns-0041-contract.sql")" = "f"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/migrations/0041_service_product_returns.sql" >/dev/null
test "$(psql --no-psqlrc -At --set ON_ERROR_STOP=1 --file="$script_dir/service-product-returns-0041-contract.sql")" = "t"
default_acl_snapshot >"$tmp_dir/default-acl-after-0041.txt"
cmp "$tmp_dir/default-acl-before-0041.txt" "$tmp_dir/default-acl-after-0041.txt"
pg_dump --schema-only --no-owner --schema=public --schema=petro_private | node "$script_dir/normalize-pg-dump.mjs" >"$tmp_dir/schema-before-0042.sql"
default_acl_snapshot >"$tmp_dir/default-acl-before-0042.txt"
test "$(psql --no-psqlrc -At --set ON_ERROR_STOP=1 --file="$script_dir/merchant-statement-0042-contract.sql")" = "f"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/migrations/0042_merchant_statement.sql" >/dev/null
test "$(psql --no-psqlrc -At --set ON_ERROR_STOP=1 --file="$script_dir/merchant-statement-0042-contract.sql")" = "t"
default_acl_snapshot >"$tmp_dir/default-acl-after-0042.txt"
cmp "$tmp_dir/default-acl-before-0042.txt" "$tmp_dir/default-acl-after-0042.txt"
pg_dump --schema-only --no-owner --schema=public --schema=petro_private | node "$script_dir/normalize-pg-dump.mjs" >"$tmp_dir/schema-before-0043.sql"
default_acl_snapshot >"$tmp_dir/default-acl-before-0043.txt"
test "$(psql --no-psqlrc -At --set ON_ERROR_STOP=1 --file="$script_dir/merchant-withdrawals-0043-contract.sql")" = "f"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/migrations/0043_merchant_withdrawal_intake.sql" >/dev/null
test "$(psql --no-psqlrc -At --set ON_ERROR_STOP=1 --file="$script_dir/merchant-withdrawals-0043-contract.sql")" = "t"
default_acl_snapshot >"$tmp_dir/default-acl-after-0043.txt"
cmp "$tmp_dir/default-acl-before-0043.txt" "$tmp_dir/default-acl-after-0043.txt"
pg_dump --schema-only --no-owner --schema=public --schema=petro_private | node "$script_dir/normalize-pg-dump.mjs" >"$tmp_dir/schema-before-0044.sql"
default_acl_snapshot >"$tmp_dir/default-acl-before-0044.txt"
test "$(psql --no-psqlrc -At --set ON_ERROR_STOP=1 --file="$script_dir/merchant-payout-proof-0044-contract.sql")" = "f"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/migrations/0044_merchant_payout_proofs.sql" >/dev/null
test "$(psql --no-psqlrc -At --set ON_ERROR_STOP=1 --file="$script_dir/merchant-payout-proof-0044-contract.sql")" = "t"
default_acl_snapshot >"$tmp_dir/default-acl-after-0044.txt"
cmp "$tmp_dir/default-acl-before-0044.txt" "$tmp_dir/default-acl-after-0044.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$script_dir/service-payment-0037-smoke-test.sql" >/dev/null
export PERTOMAX_BEFORE_REFUND_SNAPSHOT="$tmp_dir/before-financial-browser"
node "$script_dir/platform-user-admin-api-smoke-test.mjs"
if [ ! -s "$PERTOMAX_BEFORE_REFUND_SNAPSHOT/PG_VERSION" ] || [ ! -d "$PERTOMAX_BEFORE_REFUND_SNAPSHOT/base" ] || [ "$PGHOST" != "$tmp_dir/socket" ] || [ "$PGDATABASE" != "postgres" ]; then
 echo "Missing isolated pre-refund fixture snapshot; do not attempt any reset." >&2
 exit 1
fi
if psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/rollback/0044_merchant_payout_proofs.sql" >"$tmp_dir/0044-refusal.log" 2>&1; then
 echo "0044 rollback erased proof history" >&2;exit 1
fi
rg -q '0044 rollback refuses' "$tmp_dir/0044-refusal.log"
if psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/rollback/0043_merchant_withdrawal_intake.sql" >"$tmp_dir/0043-rollback-refusal.log" 2>&1; then
 echo "0043 rollback erased financial withdrawal history" >&2;exit 1
fi
rg -q '0043 rollback refuses' "$tmp_dir/0043-rollback-refusal.log"
if psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/rollback/0041_service_product_returns.sql" >"$tmp_dir/0041-rollback-refusal.log" 2>&1; then
 echo "0041 rollback erased physical return history" >&2
 exit 1
fi
rg -q '0041 rollback refuses to remove physical return history' "$tmp_dir/0041-rollback-refusal.log"
if psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/rollback/0039_service_refund_decisions.sql" >"$tmp_dir/0039-rollback-refusal.log" 2>&1; then
 echo "0039 rollback erased posted monetary refund history" >&2
 exit 1
fi
rg -q '0039 rollback refuses to remove refund or settlement financial history' "$tmp_dir/0039-rollback-refusal.log"
# Financial rollback is REFUSED with history. Reset the COMPLETE disposable cluster to
# its consistent physical backup for a separate CLEAN rollback test. Logical dump/restore
# reparses legacy CHECK trees and changes schema initial-ACL bookkeeping, obscuring exact
# rollback comparison. A physical backup preserves both; no schema normalization bypass.
# This is solely test-fixture reset, never production rollback or selective ledger deletion.
pg_ctl -D "$tmp_dir/data" -m fast stop >/dev/null
pg_started=0
mv "$tmp_dir/data" "$tmp_dir/after-monetary-fixture"
mv "$PERTOMAX_BEFORE_REFUND_SNAPSHOT" "$tmp_dir/data"
pg_ctl -D "$tmp_dir/data" \
  -o "-c listen_addresses='' -c unix_socket_directories='$tmp_dir/socket' -c port=55444 -c shared_preload_libraries=pg_cron -c cron.database_name=postgres -c cron.use_background_workers=on -c max_worker_processes=16" \
  -l "$tmp_dir/postgres.log" start >/dev/null
pg_started=1
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/rollback/0044_merchant_payout_proofs.sql" >/dev/null
pg_dump --schema-only --no-owner --schema=public --schema=petro_private | node "$script_dir/normalize-pg-dump.mjs" >"$tmp_dir/schema-after-0044.sql"
cmp "$tmp_dir/schema-before-0044.sql" "$tmp_dir/schema-after-0044.sql"
default_acl_snapshot >"$tmp_dir/default-acl-after-0044-rollback.txt"
cmp "$tmp_dir/default-acl-before-0044.txt" "$tmp_dir/default-acl-after-0044-rollback.txt"
echo "PASS:0044 proof history refusal and exact independent schema/defaultACL rollback"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/rollback/0043_merchant_withdrawal_intake.sql" >/dev/null
pg_dump --schema-only --no-owner --schema=public --schema=petro_private | node "$script_dir/normalize-pg-dump.mjs" >"$tmp_dir/schema-after-0043-rollback.sql"
cmp "$tmp_dir/schema-before-0043.sql" "$tmp_dir/schema-after-0043-rollback.sql"
default_acl_snapshot >"$tmp_dir/default-acl-after-0043-rollback.txt"
cmp "$tmp_dir/default-acl-before-0043.txt" "$tmp_dir/default-acl-after-0043-rollback.txt"
echo "PASS:0043 withdrawal history refusal and exact independent clean rollback"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/rollback/0042_merchant_statement.sql" >/dev/null
pg_dump --schema-only --no-owner --schema=public --schema=petro_private | node "$script_dir/normalize-pg-dump.mjs" >"$tmp_dir/schema-after-0042-rollback.sql"
cmp "$tmp_dir/schema-before-0042.sql" "$tmp_dir/schema-after-0042-rollback.sql"
default_acl_snapshot >"$tmp_dir/default-acl-after-0042-rollback.txt"
cmp "$tmp_dir/default-acl-before-0042.txt" "$tmp_dir/default-acl-after-0042-rollback.txt"
echo "PASS: read-only merchant statement exact independent schema/defaultACL rollback"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/rollback/0041_service_product_returns.sql" >/dev/null
pg_dump --schema-only --no-owner --schema=public --schema=petro_private | node "$script_dir/normalize-pg-dump.mjs" >"$tmp_dir/schema-after-0041-rollback.sql"
if ! cmp -s "$tmp_dir/schema-before-0041.sql" "$tmp_dir/schema-after-0041-rollback.sql"; then
 diff -u "$tmp_dir/schema-before-0041.sql" "$tmp_dir/schema-after-0041-rollback.sql" | head -100 >&2 || true
 exit 1
fi
default_acl_snapshot >"$tmp_dir/default-acl-after-0041-rollback.txt"
cmp "$tmp_dir/default-acl-before-0041.txt" "$tmp_dir/default-acl-after-0041-rollback.txt"
echo "PASS: 0041 physical return history preserving rollback; exact independent clean schema/defaultACL"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/rollback/0040_operational_terminal_conflicts.sql" >/dev/null
pg_dump --schema-only --no-owner --schema=public --schema=petro_private | node "$script_dir/normalize-pg-dump.mjs" >"$tmp_dir/schema-after-0040-rollback.sql"
if ! cmp -s "$tmp_dir/schema-before-0040.sql" "$tmp_dir/schema-after-0040-rollback.sql"; then
 diff -u "$tmp_dir/schema-before-0040.sql" "$tmp_dir/schema-after-0040-rollback.sql" | head -100 >&2 || true
 exit 1
fi
default_acl_snapshot >"$tmp_dir/default-acl-after-0040-rollback.txt"
cmp "$tmp_dir/default-acl-before-0040.txt" "$tmp_dir/default-acl-after-0040-rollback.txt"
echo "PASS: 0040 terminal operational conflicts preserve exact function/schema/defaultACL rollback"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/rollback/0039_service_refund_decisions.sql" >/dev/null
pg_dump --schema-only --no-owner --schema=public --schema=petro_private | node "$script_dir/normalize-pg-dump.mjs" >"$tmp_dir/schema-after-0039-rollback.sql"
if ! cmp -s "$tmp_dir/schema-before-0039.sql" "$tmp_dir/schema-after-0039-rollback.sql"; then
 diff -u "$tmp_dir/schema-before-0039.sql" "$tmp_dir/schema-after-0039-rollback.sql" | head -100 >&2 || true
 exit 1
fi
default_acl_snapshot >"$tmp_dir/default-acl-after-0039-rollback.txt"
cmp "$tmp_dir/default-acl-before-0039.txt" "$tmp_dir/default-acl-after-0039-rollback.txt"
echo "PASS: actual monetary refund history refuses rollback; independent clean fixture restores exact schema/defaultACL"

if [ "$(psql --no-psqlrc -At --set ON_ERROR_STOP=1 -c "SELECT count(*) FROM petro_private.service_refund_requests")" != "0" ]; then
 if psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/rollback/0038_service_refund_intake.sql" >"$tmp_dir/0038-rollback-refusal.log" 2>&1; then
  echo "0038 rollback erased refund request history" >&2
  exit 1
 fi
 rg -q '0038 rollback refuses to remove refund request history' "$tmp_dir/0038-rollback-refusal.log"
 # Disposable runner only; never truncate hosted financial/request history.
 psql --no-psqlrc --set ON_ERROR_STOP=1 -c "TRUNCATE petro_private.service_refund_commands,petro_private.service_refund_withdrawals,petro_private.service_refund_requests;" >/dev/null
fi
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/rollback/0038_service_refund_intake.sql" >/dev/null
pg_dump --schema-only --no-owner --schema=public --schema=petro_private | node "$script_dir/normalize-pg-dump.mjs" >"$tmp_dir/schema-after-0038-rollback.sql"
cmp "$tmp_dir/schema-before-0038.sql" "$tmp_dir/schema-after-0038-rollback.sql"
default_acl_snapshot >"$tmp_dir/default-acl-after-0038-rollback.txt"
cmp "$tmp_dir/default-acl-before-0038.txt" "$tmp_dir/default-acl-after-0038-rollback.txt"
echo "PASS: refund request intake RLS, amount capacity, history and preserving schema/ACL rollback"
if [ "$(psql --no-psqlrc -At --set ON_ERROR_STOP=1 -c "SELECT count(*) FROM petro_private.service_order_confirmation_commands")" != "0" ]; then
 if psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/rollback/0037_final_service_payment.sql" >"$tmp_dir/0037-rollback-refusal.log" 2>&1; then
  echo "0037 rollback erased financial confirmation history" >&2
  exit 1
 fi
 rg -q 'rollback refuses to remove financial or confirmation history' "$tmp_dir/0037-rollback-refusal.log"
 # NEW relations with this disposable runner's synthetic records only.
 # Never delete or rewrite immutable finance journal/inventory history.
 psql --no-psqlrc --set ON_ERROR_STOP=1 -c "TRUNCATE petro_private.service_order_confirmation_commands,petro_private.service_order_receipts,petro_private.service_order_receivables,petro_private.service_order_payments,petro_private.service_order_events RESTART IDENTITY;" >/dev/null
fi
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/rollback/0037_final_service_payment.sql" >/dev/null
pg_dump --schema-only --no-owner --schema=public --schema=petro_private | node "$script_dir/normalize-pg-dump.mjs" >"$tmp_dir/schema-after-0037-rollback.sql"
cmp "$tmp_dir/schema-before-0037.sql" "$tmp_dir/schema-after-0037-rollback.sql"
default_acl_snapshot >"$tmp_dir/default-acl-after-0037-rollback.txt"
cmp "$tmp_dir/default-acl-before-0037.txt" "$tmp_dir/default-acl-after-0037-rollback.txt"
echo "PASS: final PIN limiter, actual partial financial capture, merchant receipt/receivable and preserving schema/defaultACL rollback"
if [ "$(psql --no-psqlrc -At --set ON_ERROR_STOP=1 -c "SELECT count(*) FROM petro_private.service_order_executions")" != "0" ]; then
 if psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/rollback/0036_service_execution_evidence.sql" >"$tmp_dir/0036-rollback-refusal.log" 2>&1; then
  echo "0036 rollback erased execution history" >&2
  exit 1
 fi
 rg -q 'rollback refuses to remove execution or evidence history' "$tmp_dir/0036-rollback-refusal.log"
 # Only NEW order/execution/evidence relations, containing local synthetic fixtures.
 # Never remove or rewrite the existing immutable finance/inventory ledgers.
 psql --no-psqlrc --set ON_ERROR_STOP=1 -c "TRUNCATE petro_private.service_order_deliveries,petro_private.service_order_evidence,petro_private.service_order_executions,petro_private.service_order_commands,petro_private.service_order_events RESTART IDENTITY;" >/dev/null
fi
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/rollback/0036_service_execution_evidence.sql" >/dev/null
pg_dump --schema-only --no-owner --schema=public --schema=petro_private | node "$script_dir/normalize-pg-dump.mjs" >"$tmp_dir/schema-after-0036-rollback.sql"
cmp "$tmp_dir/schema-before-0036.sql" "$tmp_dir/schema-after-0036-rollback.sql"
default_acl_snapshot >"$tmp_dir/default-acl-after-0036-rollback.txt"
cmp "$tmp_dir/default-acl-before-0036.txt" "$tmp_dir/default-acl-after-0036-rollback.txt"
echo "PASS: actual scoped start/evidence/delivery, partial stock issue, held payment separation and exact schema/defaultACL rollback"
if [ "$(psql --no-psqlrc -At --set ON_ERROR_STOP=1 -c "SELECT count(*) FROM public.petro_service_orders")" != "0" ]; then
 if psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/rollback/0035_service_order_reservation.sql" >"$tmp_dir/0035-rollback-refusal.log" 2>&1; then
  echo "0035 rollback erased service order history" >&2
  exit 1
 fi
 rg -q 'rollback refuses to remove service order history' "$tmp_dir/0035-rollback-refusal.log"
 # Only NEW relations containing this runner's synthetic orders; never do this on live data.
 psql --no-psqlrc --set ON_ERROR_STOP=1 -c "TRUNCATE petro_private.service_order_events,petro_private.service_order_commands,public.petro_service_orders RESTART IDENTITY;" >/dev/null
fi
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/rollback/0035_service_order_reservation.sql" >/dev/null
pg_dump --schema-only --no-owner --schema=public --schema=petro_private | node "$script_dir/normalize-pg-dump.mjs" >"$tmp_dir/schema-after-0035-rollback.sql"
cmp "$tmp_dir/schema-before-0035.sql" "$tmp_dir/schema-after-0035-rollback.sql"
default_acl_snapshot >"$tmp_dir/default-acl-after-0035-rollback.txt"
cmp "$tmp_dir/default-acl-before-0035.txt" "$tmp_dir/default-acl-after-0035-rollback.txt"
echo "PASS: actual service order reserve/cancel/expiry, real holds, stock release and preserving application-schema rollback"

# Prove rollback cannot erase a persisted system executor. Disposable fixture only.
psql --no-psqlrc --set ON_ERROR_STOP=1 <<'SQL' >/dev/null
DO $fixture$
DECLARE account uuid; actor uuid:='00000000-0000-4000-8000-000000003301'; reservation uuid;
BEGIN
 SELECT a.id INTO STRICT account FROM public.petro_finance_accounts a
 JOIN public.petro_organizations o ON o.id=a.organization_id
 JOIN public.petro_branches b ON b.id=a.branch_id
 WHERE o.code='QUOTE-IT-A' AND b.code='QUOTE-IT-A1' AND a.account_kind='branch_funding';
 reservation:=petro_private.finance_reserve_funds(account,'fleet_usage','00000000-0000-4000-8000-000000003499',1,'Disposable system rollback refusal fixture',actor);
 UPDATE public.petro_finance_reservations SET status='released',closed_at=now(),closed_by_system='service_order_expiry' WHERE id=reservation;
END $fixture$;
SQL
if psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/rollback/0034_system_execution_attribution.sql" >"$tmp_dir/0034-rollback-refusal.log" 2>&1; then
 echo "0034 rollback erased system attribution" >&2
 exit 1
fi
rg -q 'rollback refuses to discard system execution attribution' "$tmp_dir/0034-rollback-refusal.log"
# Never normalize production attribution. Only this exact synthetic fixture in the disposable DB.
psql --no-psqlrc --set ON_ERROR_STOP=1 -c "UPDATE public.petro_finance_reservations SET closed_by=created_by,closed_by_system=NULL WHERE source_type='fleet_usage' AND source_id='00000000-0000-4000-8000-000000003499' AND reason='Disposable system rollback refusal fixture';" >/dev/null
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/rollback/0034_system_execution_attribution.sql" >/dev/null
pg_dump --schema-only --no-owner --schema=public --schema=petro_private | node "$script_dir/normalize-pg-dump.mjs" >"$tmp_dir/schema-after-0034-rollback.sql"
cmp "$tmp_dir/schema-before-0034.sql" "$tmp_dir/schema-after-0034-rollback.sql"
default_acl_snapshot >"$tmp_dir/default-acl-after-0034-rollback.txt"
cmp "$tmp_dir/default-acl-before-0034.txt" "$tmp_dir/default-acl-after-0034-rollback.txt"
echo "PASS: truthful system/human attribution, narrow expiry-only constraints, immutable inventory history and preserving rollback"

psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/rollback/0033_worker_service_quotation.sql" >/dev/null
pg_dump --schema-only --no-owner --schema=public --schema=petro_private | node "$script_dir/normalize-pg-dump.mjs" >"$tmp_dir/schema-after-0033-rollback.sql"
cmp "$tmp_dir/schema-before-0033.sql" "$tmp_dir/schema-after-0033-rollback.sql"
default_acl_snapshot >"$tmp_dir/default-acl-after-0033-rollback.txt"
cmp "$tmp_dir/default-acl-before-0033.txt" "$tmp_dir/default-acl-after-0033-rollback.txt"
echo "PASS: scoped service quotation, exact prices, policy/funding/stock gates and read-only schema/ACL rollback"

psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/rollback/0032_internal_usage_reservation_core.sql" >/dev/null
pg_dump --schema-only --no-owner --schema=public --schema=petro_private | node "$script_dir/normalize-pg-dump.mjs" >"$tmp_dir/schema-after-0032-rollback.sql"
cmp "$tmp_dir/schema-before-0032.sql" "$tmp_dir/schema-after-0032-rollback.sql"
default_acl_snapshot >"$tmp_dir/default-acl-after-0032-rollback.txt"
cmp "$tmp_dir/default-acl-before-0032.txt" "$tmp_dir/default-acl-after-0032-rollback.txt"
echo "PASS: internal usage core real holds, legacy proof/replay/policy/grants and exact schema/ACL rollback"

if [ "$(psql --no-psqlrc -At --set ON_ERROR_STOP=1 -c "SELECT (SELECT count(*) FROM petro_private.worker_pin_proofs)+(SELECT count(*) FROM petro_private.worker_pin_commands)")" != "0" ]; then
  if psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/rollback/0031_operational_pin_proofs.sql" >"$tmp_dir/0031-rollback-refusal.log" 2>&1; then
    echo "0031 rollback unexpectedly removed operational proof records" >&2
    exit 1
  fi
  rg -q 'rollback refuses to delete operational proof records' "$tmp_dir/0031-rollback-refusal.log"
  # Exclusively synthetic records in this runner-owned disposable database.
  psql --no-psqlrc --set ON_ERROR_STOP=1 -c "DELETE FROM petro_private.worker_pin_commands; DELETE FROM petro_private.worker_pin_proofs;" >/dev/null
fi
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/rollback/0031_operational_pin_proofs.sql" >/dev/null
pg_dump --schema-only --no-owner --schema=public --schema=petro_private | node "$script_dir/normalize-pg-dump.mjs" >"$tmp_dir/schema-after-0031-rollback.sql"
cmp "$tmp_dir/schema-before-0031.sql" "$tmp_dir/schema-after-0031-rollback.sql"
default_acl_snapshot >"$tmp_dir/default-acl-after-0031-rollback.txt"
cmp "$tmp_dir/default-acl-before-0031.txt" "$tmp_dir/default-acl-after-0031-rollback.txt"
echo "PASS: operational PIN scope, replay, expiry, rotation, lockout and exact schema/ACL rollback"
if psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/rollback/0030_worker_branch_service_assignments.sql" >"$tmp_dir/0030-rollback-refusal.log" 2>&1; then
  echo "0030 rollback unexpectedly deleted persisted synthetic worker records" >&2
  exit 1
fi
rg -q 'rollback refuses to delete workforce records' "$tmp_dir/0030-rollback-refusal.log"
# This runner owns the disposable cluster; these records are exclusively synthetic API/browser fixtures.
psql --no-psqlrc --set ON_ERROR_STOP=1 -c "DELETE FROM petro_private.worker_assignment_events; DELETE FROM petro_private.worker_assignment_commands; DELETE FROM public.petro_worker_assignments;" >/dev/null
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/rollback/0030_worker_branch_service_assignments.sql" >/dev/null
pg_dump --schema-only --no-owner --schema=public --schema=petro_private | node "$script_dir/normalize-pg-dump.mjs" >"$tmp_dir/schema-after-0030-rollback.sql"
cmp "$tmp_dir/schema-before-0030.sql" "$tmp_dir/schema-after-0030-rollback.sql"
default_acl_snapshot >"$tmp_dir/default-acl-after-0030-rollback.txt"
cmp "$tmp_dir/default-acl-before-0030.txt" "$tmp_dir/default-acl-after-0030-rollback.txt"
echo "PASS: worker branch/service authorization, API/browser persistence, data-preserving rollback refusal and exact schema/ACL rollback"

psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$script_dir/fleet-directory-photo-0028-smoke-test.sql" >/dev/null
echo "PASS: rejected and unfinished directory photos excluded"
node "$script_dir/finance-concurrency-smoke-test.mjs"
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$script_dir/fleet-finance-integration-setup.sql" >/dev/null
node "$script_dir/fleet-finance-integration-smoke-test.mjs"
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$repo_root/lib/db/rollback/0026_fleet_fuel_tank_capacity_guard.sql" >/dev/null
psql --no-psqlrc -At --set ON_ERROR_STOP=1 -c "SELECT md5(pg_get_functiondef(oid)),proacl::text FROM pg_proc WHERE oid='petro_private.fleet_check_usage_policy_at(uuid,uuid,uuid,uuid,text,bigint,numeric,timestamptz)'::regprocedure" >"$tmp_dir/evaluator-after-0026-rollback.txt"
cmp "$tmp_dir/evaluator-before-0026.txt" "$tmp_dir/evaluator-after-0026-rollback.txt"
default_acl_snapshot >"$tmp_dir/default-acl-after-0026-rollback.txt"
cmp "$tmp_dir/default-acl-before-0026.txt" "$tmp_dir/default-acl-after-0026-rollback.txt"
echo "PASS: 0026 actual fuel tank capacity guard and exact evaluator/ACL rollback"
if [ -n "${PERTOMAX_EXPECTED_SCHEMA_DUMP_0011:-}" ]; then
  mkdir -p "$(dirname "$PERTOMAX_EXPECTED_SCHEMA_DUMP_0011")"
  pg_dump --no-owner --no-privileges --schema-only \
    --schema=public --schema=petro_private |
    node "$script_dir/normalize-pg-dump.mjs" \
    >"$PERTOMAX_EXPECTED_SCHEMA_DUMP_0011"
fi
if [ -n "${PERTOMAX_EXPECTED_SCHEMA_DUMP_0012:-}" ]; then
  mkdir -p "$(dirname "$PERTOMAX_EXPECTED_SCHEMA_DUMP_0012")"
  pg_dump --no-owner --no-privileges --schema-only \
    --schema=public --schema=petro_private |
    node "$script_dir/normalize-pg-dump.mjs" \
    >"$PERTOMAX_EXPECTED_SCHEMA_DUMP_0012"
fi

# Keep the UI browser's saved QR lifecycle isolated from the following 0023
# SQL fixture, whose issued-card assertion is scoped to its synthetic card.
# This cleanup runs only against this disposable local cluster.
psql --no-psqlrc --set ON_ERROR_STOP=1 <<'SQL' >/dev/null
BEGIN;
DO $cleanup_ui_qr$
DECLARE
  request_row record;
BEGIN
  FOR request_row IN
    SELECT request.id
    FROM public.petro_fleet_credential_requests request
    JOIN public.petro_fleet_vehicles vehicle ON vehicle.id=request.vehicle_id
    WHERE vehicle.plate_standard='TEST-UI-VEHICLE-01'
      AND request.credential_type='qr'
      AND request.request_type='issue'
      AND request.reason='طلب QR اختباري معزول'
  LOOP
    DELETE FROM public.petro_vehicle_credentials
      WHERE request_id=request_row.id AND credential_type='qr';
    DELETE FROM public.petro_fleet_credential_requests
      WHERE id=request_row.id;
  END LOOP;
END
$cleanup_ui_qr$;
COMMIT;
SQL

psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$script_dir/fleet-cards-0023-smoke-test.sql" >/dev/null
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/rollback/0028_fleet_directory_photo_identity.sql" >/dev/null
psql --no-psqlrc -At --set ON_ERROR_STOP=1 -c "SELECT md5(pg_get_functiondef(oid)),proacl::text FROM pg_proc WHERE oid='public.petro_admin_fleet_catalog(text,jsonb)'::regprocedure" >"$tmp_dir/directory-after-0028-rollback.txt"
cmp "$tmp_dir/directory-before-0028.txt" "$tmp_dir/directory-after-0028-rollback.txt"
default_acl_snapshot >"$tmp_dir/default-acl-after-0028-rollback.txt"
cmp "$tmp_dir/default-acl-before-0028.txt" "$tmp_dir/default-acl-after-0028-rollback.txt"
echo "PASS: 0028 directory photo identity and exact catalog/ACL rollback"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file="$repo_root/lib/db/rollback/0029_fleet_card_fulfillment_filter.sql" >/dev/null
psql --no-psqlrc -At --set ON_ERROR_STOP=1 -c "SELECT md5(pg_get_functiondef(oid)),proacl::text FROM pg_proc WHERE oid='public.petro_admin_fleet_cards_catalog(text,jsonb)'::regprocedure" >"$tmp_dir/cards-after-0029-rollback.txt"
cmp "$tmp_dir/cards-before-0029.txt" "$tmp_dir/cards-after-0029-rollback.txt"
default_acl_snapshot >"$tmp_dir/default-acl-after-0029-rollback.txt"
cmp "$tmp_dir/default-acl-before-0029.txt" "$tmp_dir/default-acl-after-0029-rollback.txt"
echo "PASS: 0029 fulfillment filtering and exact card catalog/ACL rollback"
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$repo_root/lib/db/rollback/0027_fleet_issued_card_categories.sql" >/dev/null
psql --no-psqlrc -At --set ON_ERROR_STOP=1 -c "SELECT md5(pg_get_functiondef(oid)),proacl::text FROM pg_proc WHERE oid='public.petro_admin_fleet_cards_catalog(text,jsonb)'::regprocedure" >"$tmp_dir/cards-after-0027-rollback.txt"
cmp "$tmp_dir/cards-before-0027.txt" "$tmp_dir/cards-after-0027-rollback.txt"
default_acl_snapshot >"$tmp_dir/default-acl-after-0027-rollback.txt"
cmp "$tmp_dir/default-acl-before-0027.txt" "$tmp_dir/default-acl-after-0027-rollback.txt"
echo "PASS: 0027 issued-card categories and exact catalog/ACL rollback"
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$script_dir/rollback-0023-fleet-cards-and-pin.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0023-rollback.txt"
if ! cmp -s "$tmp_dir/default-acl-before-0023.txt" "$tmp_dir/default-acl-after-0023-rollback.txt"; then
  echo "0023 rollback unexpectedly changed one or more default ACLs:" >&2
  diff -u "$tmp_dir/default-acl-before-0023.txt" "$tmp_dir/default-acl-after-0023-rollback.txt" >&2 || true
  exit 1
fi
psql --no-psqlrc --set ON_ERROR_STOP=1 <<'SQL' >/dev/null
DO $fleet_0023_rollback$
BEGIN
  IF to_regprocedure('public.petro_admin_fleet_command(text,jsonb,text,text)') IS NULL
     OR to_regprocedure('public.petro_admin_fleet_command_legacy_0014(text,jsonb,text,text)') IS NOT NULL
     OR to_regprocedure('public.petro_admin_fleet_cards_catalog(text,jsonb)') IS NOT NULL
     OR to_regprocedure('public.petro_admin_fleet_pair_pin_reveal(uuid,text)') IS NOT NULL
     OR NOT has_function_privilege('authenticated','public.petro_admin_fleet_command(text,jsonb,text,text)','EXECUTE')
     OR has_function_privilege('anon','public.petro_admin_fleet_command(text,jsonb,text,text)','EXECUTE')
     OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='petro_private'
         AND table_name='petro_fleet_driver_pair_secrets'
         AND column_name='pin_ciphertext'
     ) THEN
    RAISE EXCEPTION '0023 rollback did not restore the old RPC safely or discarded retained data';
  END IF;
END
$fleet_0023_rollback$;
SQL
echo "PASS: 0023 card catalog/PIN recovery smoke test and rollback (local PostgreSQL)"
# The browser fixtures deliberately persist optional (zero) caps. A downgrade
# must refuse these rows rather than silently imposing limits on real users.
if psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$repo_root/lib/db/rollback/0025_fleet_onboarding_limit_contract.sql" \
  >"$tmp_dir/0025-rollback-guard.log" 2>&1; then
  echo "0025 rollback should reject persisted optional-limit fixtures" >&2
  exit 1
fi
if ! rg -q 'Rollback blocked: policies use the optional-limit contract' "$tmp_dir/0025-rollback-guard.log"; then
  cat "$tmp_dir/0025-rollback-guard.log" >&2
  exit 1
fi
# Disposable-cluster fixture normalization ONLY, after all behavior tests.
# Production rollback must keep its refusal until an operator replaces policies.
psql --no-psqlrc --set ON_ERROR_STOP=1 <<'SQL' >/dev/null
UPDATE public.petro_fleet_policy_versions SET
  monthly_amount_limit_minor=greatest(monthly_amount_limit_minor,1),
  daily_quantity_limit=greatest(daily_quantity_limit,1),
  weekly_quantity_limit=greatest(weekly_quantity_limit,1),
  monthly_quantity_limit=greatest(monthly_quantity_limit,1);
UPDATE public.petro_fleet_policy_rules SET
  monthly_amount_limit_minor=greatest(monthly_amount_limit_minor,1),
  daily_quantity_limit=greatest(daily_quantity_limit,1),
  weekly_quantity_limit=greatest(weekly_quantity_limit,1),
  monthly_quantity_limit=greatest(monthly_quantity_limit,1);
SQL
default_acl_snapshot >"$tmp_dir/default-acl-before-0025-rollback.txt"
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$repo_root/lib/db/rollback/0025_fleet_onboarding_limit_contract.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0025-rollback.txt"
if ! cmp -s "$tmp_dir/default-acl-before-0025.txt" "$tmp_dir/default-acl-after-0025-rollback.txt"; then
  echo "0025 rollback unexpectedly changed one or more default ACLs:" >&2
  diff -u "$tmp_dir/default-acl-before-0025.txt" "$tmp_dir/default-acl-after-0025-rollback.txt" >&2 || true
  exit 1
fi
echo "PASS: 0025 optional policy limits rollback (local PostgreSQL)"
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$script_dir/rollback-0024-fleet-card-history.sql" >/dev/null
default_acl_snapshot >"$tmp_dir/default-acl-after-0024-rollback.txt"
if ! cmp -s "$tmp_dir/default-acl-before-0024.txt" "$tmp_dir/default-acl-after-0024-rollback.txt"; then
  echo "0024 rollback unexpectedly changed one or more default ACLs:" >&2
  diff -u "$tmp_dir/default-acl-before-0024.txt" "$tmp_dir/default-acl-after-0024-rollback.txt" >&2 || true
  exit 1
fi
echo "PASS: 0024 fleet card onboarding history and rollback (local PostgreSQL)"

echo "Fresh baseline matched: 11 tables, 57 constraints, 22 indexes, 23 functions, 12 RLS policies, 11 RLS-enabled tables."
echo "DB-01 baseline RLS checks passed; 0004 was applied once to the disposable baseline and DB-02 invitation checks passed."
echo "0005 organization/branch schema, reasoned audit, state separation, uniqueness, optimistic concurrency, role separation and tenant/branch isolation checks passed."
echo "0006 organization requests, document metadata/private-storage RLS policies, bank versioning, review decisions, no-owner-escalation and optimistic-concurrency tests passed."
echo "0007 confirmed pending self-service, beneficiary immutability, private attachment isolation, withdrawal, completion, review, resubmission, one-time approval and central on-behalf regression tests passed."
echo "0010/0011 plan authoring, editable defaults, draft/version immutability, provider price schedules, scope/overlap checks, paid pending state, free stations, and branch expiry isolation passed with synthetic fixtures."
echo "0008 platform-user directory, role/status audit, owner-only authorization, mandatory reasons, self-change denial, inactive-account guard, and legacy-RPC compatibility passed."
echo "0020 temporary password reset gate, owner-only initial role assignment, pending-account confirmation, role history, idempotent retry, and narrow function grants passed with synthetic users."
echo "0021 merchant inventory smoke passed with local synthetic records: role and branch isolation, immutable product stock ledger, exact fractional quantity, idempotency, receipt/transfer/return/damage, reservation/release/consume, insufficient-stock atomic rejection, and reconciliation."
echo "0012/0013 finance ledger, receipt detail, reservation capture, unallocated receipts, top-up approvals, same-organization transfers, subscription collection holds, exact-piaster balances, idempotency, reversal, and read-only reconciliation passed with local synthetic fixtures."
echo "0014/0015 fleet integration used real disposable PostgreSQL policy, coverage, reservation and finance-ledger contracts; no fake Supabase transport was used for this integration."
echo "0017 catalog/fuel pricing checks passed in the disposable PostgreSQL cluster: merchant ownership, branch scope, central-role review, exact EGP minor-unit price, Cairo validity, idempotency, optimistic conflicts, service attributes, and direct-table/RPC grants."
echo "The 0008, billing, finance, fleet, and catalog API routers passed isolated HTTP/PostgreSQL integration tests with synthetic users and local PostgreSQL behind the test Supabase transport; catalog coverage includes positive role reads, Arabic reference names and units, price-unavailable handling, replay, role gates, cross-organization isolation, and incompatible fuel-unit rejection. Organization-profile reads passed 47 assertions; fleet routes passed 36; finance concurrency checks passed. 0009 was not run and remains deferred."
echo "0004/0005/0006/0007/0008/0010/0011/0017/0018/0019 local migrations changed no default ACL in any schema; the test fixture modeled the approved 24 ACL scopes. Storage behavior was simulated locally; no live Storage service was used."
echo "0018 fuel-unit guards, wash variants, and optional per-day 24-hour branch hours passed disposable PostgreSQL tests."
echo "0019 wash variant updates retained type, vehicle, size, and service unit in disposable PostgreSQL tests."
echo "Only a temporary local PostgreSQL cluster and local HTTP test server were used; no project Secrets or external network connections were used."
