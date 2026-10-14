BEGIN;

CREATE TABLE IF NOT EXISTS petro_private.petro_auth_signin_limits (
  bucket_key text PRIMARY KEY
    CHECK (bucket_key ~ '^[0-9a-f]{64}$'),
  attempt_count integer NOT NULL
    CHECK (attempt_count BETWEEN 1 AND 100),
  window_started_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE petro_private.petro_auth_signin_limits
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE petro_private.petro_auth_signin_limits
  FROM PUBLIC, anon, authenticated;

CREATE INDEX IF NOT EXISTS petro_auth_signin_limits_updated_at_idx
  ON petro_private.petro_auth_signin_limits (updated_at);

COMMENT ON TABLE petro_private.petro_auth_signin_limits IS
  'Stores HMAC-only per-IP-and-identifier sign-in attempt buckets; never store raw IPs or identifiers.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'petro_private'
      AND c.relname = 'petro_auth_signin_limits'
      AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'AUTH rate-limit table RLS could not be verified';
  END IF;

  IF has_table_privilege('anon', 'petro_private.petro_auth_signin_limits', 'SELECT')
     OR has_table_privilege('authenticated', 'petro_private.petro_auth_signin_limits', 'SELECT')
     OR has_table_privilege('anon', 'petro_private.petro_auth_signin_limits', 'INSERT')
     OR has_table_privilege('authenticated', 'petro_private.petro_auth_signin_limits', 'INSERT') THEN
    RAISE EXCEPTION 'AUTH rate-limit table is exposed to an application role';
  END IF;
END;
$$;

COMMIT;
