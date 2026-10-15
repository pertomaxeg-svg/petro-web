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

# DB-01 tests the audited baseline before the proposed DB-02 privilege change.
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$script_dir/rls-smoke-test.sql" >/dev/null

# The current snapshot already contains 0001-0003; do not replay them.
# 0004 is a proposed, post-baseline migration and is applied only to this
# temporary local database, twice to verify its idempotency.
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$repo_root/lib/db/migrations/0004_db02_invitation_permissions.sql" >/dev/null
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$repo_root/lib/db/migrations/0004_db02_invitation_permissions.sql" >/dev/null
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --file="$script_dir/db02-privilege-test.sql" >/dev/null

echo "Fresh baseline matched: 11 tables, 57 constraints, 22 indexes, 23 functions, 12 RLS policies, 11 RLS-enabled tables."
echo "DB-01 baseline RLS checks passed before DB-02; the proposed 0004 migration passed twice locally."
echo "DB-02 invite RPC, privilege-default, role-escalation and tenant/branch isolation checks passed."
echo "Only a temporary local PostgreSQL cluster was used; no project Secrets or network connection were used."
