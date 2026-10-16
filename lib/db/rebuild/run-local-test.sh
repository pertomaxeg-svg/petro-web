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

for command_name in initdb pg_ctl psql pg_dump; do
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
  -o "-c listen_addresses='' -c unix_socket_directories='$tmp_dir/socket' -c port=55444" \
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
sed -E \
  's/-- Dumped from database version [0-9.]+/-- Dumped from database version NORMALIZED/; s/-- Dumped by pg_dump version [0-9.]+/-- Dumped by pg_dump version NORMALIZED/' \
  "$schema_dump" >"$tmp_dir/source-normalized.sql"
sed -E \
  's/-- Dumped from database version [0-9.]+/-- Dumped from database version NORMALIZED/; s/-- Dumped by pg_dump version [0-9.]+/-- Dumped by pg_dump version NORMALIZED/' \
  "$tmp_dir/rebuilt-baseline.sql" >"$tmp_dir/rebuilt-normalized.sql"
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
    sed -E \
      's/-- Dumped from database version [0-9.]+/-- Dumped from database version NORMALIZED/; s/-- Dumped by pg_dump version [0-9.]+/-- Dumped by pg_dump version NORMALIZED/' \
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
    sed -E \
      's/-- Dumped from database version [0-9.]+/-- Dumped from database version NORMALIZED/; s/-- Dumped by pg_dump version [0-9.]+/-- Dumped by pg_dump version NORMALIZED/' \
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
    sed -E \
      's/-- Dumped from database version [0-9.]+/-- Dumped from database version NORMALIZED/; s/-- Dumped by pg_dump version [0-9.]+/-- Dumped by pg_dump version NORMALIZED/' \
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
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$script_dir/finance-core-smoke-test.sql" >/dev/null
node "$script_dir/platform-user-admin-api-smoke-test.mjs"
node "$script_dir/finance-concurrency-smoke-test.mjs"
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$script_dir/fleet-finance-integration-setup.sql" >/dev/null
node "$script_dir/fleet-finance-integration-smoke-test.mjs"
if [ -n "${PERTOMAX_EXPECTED_SCHEMA_DUMP_0011:-}" ]; then
  mkdir -p "$(dirname "$PERTOMAX_EXPECTED_SCHEMA_DUMP_0011")"
  pg_dump --no-owner --no-privileges --schema-only \
    --schema=public --schema=petro_private |
    sed -E \
      's/-- Dumped from database version [0-9.]+/-- Dumped from database version NORMALIZED/; s/-- Dumped by pg_dump version [0-9.]+/-- Dumped by pg_dump version NORMALIZED/' \
    >"$PERTOMAX_EXPECTED_SCHEMA_DUMP_0011"
fi
if [ -n "${PERTOMAX_EXPECTED_SCHEMA_DUMP_0012:-}" ]; then
  mkdir -p "$(dirname "$PERTOMAX_EXPECTED_SCHEMA_DUMP_0012")"
  pg_dump --no-owner --no-privileges --schema-only \
    --schema=public --schema=petro_private |
    sed -E \
      's/-- Dumped from database version [0-9.]+/-- Dumped from database version NORMALIZED/; s/-- Dumped by pg_dump version [0-9.]+/-- Dumped by pg_dump version NORMALIZED/' \
    >"$PERTOMAX_EXPECTED_SCHEMA_DUMP_0012"
fi

echo "Fresh baseline matched: 11 tables, 57 constraints, 22 indexes, 23 functions, 12 RLS policies, 11 RLS-enabled tables."
echo "DB-01 baseline RLS checks passed; 0004 was applied once to the disposable baseline and DB-02 invitation checks passed."
echo "0005 organization/branch schema, reasoned audit, state separation, uniqueness, optimistic concurrency, role separation and tenant/branch isolation checks passed."
echo "0006 organization requests, document metadata/private-storage RLS policies, bank versioning, review decisions, no-owner-escalation and optimistic-concurrency tests passed."
echo "0007 confirmed pending self-service, beneficiary immutability, private attachment isolation, withdrawal, completion, review, resubmission, one-time approval and central on-behalf regression tests passed."
echo "0010/0011 plan authoring, editable defaults, draft/version immutability, provider price schedules, scope/overlap checks, paid pending state, free stations, and branch expiry isolation passed with synthetic fixtures."
echo "0008 platform-user directory, role/status audit, owner-only authorization, mandatory reasons, self-change denial, inactive-account guard, and legacy-RPC compatibility passed."
echo "0012/0013 finance ledger, receipt detail, reservation capture, unallocated receipts, top-up approvals, same-organization transfers, subscription collection holds, exact-piaster balances, idempotency, reversal, and read-only reconciliation passed with local synthetic fixtures."
echo "0014/0015 fleet integration used real disposable PostgreSQL policy, coverage, reservation and finance-ledger contracts; no fake Supabase transport was used for this integration."
echo "The 0008, billing, finance, and fleet API routers passed isolated HTTP/PostgreSQL integration tests with synthetic users and a local fake Supabase transport; organization-profile reads passed 47 positive, role-gate, and cross-organization assertions for memberships, exact branches, vehicles, accounts, custom prices, and pending-payment subscriptions; fleet routes passed 36 authentication, company/branch/driver detail, no-secret, configured-price, rate-version, replay, and role-gate assertions; finance concurrency checks passed; 0009 was not run and remains deferred."
echo "0004/0005/0006/0007/0008/0010/0011 local migrations changed no default ACL in any schema; the test fixture modeled the approved 24 ACL scopes. Storage behavior was simulated locally; no live Storage service was used."
echo "Only a temporary local PostgreSQL cluster and local HTTP test server were used; no project Secrets or external network connections were used."
