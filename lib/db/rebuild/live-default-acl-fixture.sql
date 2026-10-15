-- Test-only model of the approved Supabase default-ACL catalog.
-- This creates local roles/schemas and defaults only; never apply it to Supabase.
CREATE ROLE supabase_auth_admin NOLOGIN;
CREATE ROLE dashboard_user NOLOGIN;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE SCHEMA IF NOT EXISTS graphql;
CREATE SCHEMA IF NOT EXISTS graphql_public;
CREATE SCHEMA IF NOT EXISTS realtime;

-- The application snapshot already contains the six public rows for postgres
-- and supabase_admin. These statements reproduce the omitted managed scopes.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage
  GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage
  GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage
  GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA extensions
  GRANT ALL ON SEQUENCES TO postgres WITH GRANT OPTION;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA extensions
  GRANT ALL ON FUNCTIONS TO postgres WITH GRANT OPTION;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA extensions
  GRANT ALL ON TABLES TO postgres WITH GRANT OPTION;

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql
  GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql
  GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql
  GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql_public
  GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql_public
  GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql_public
  GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA realtime
  GRANT ALL ON SEQUENCES TO postgres, dashboard_user;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA realtime
  GRANT ALL ON FUNCTIONS TO postgres, dashboard_user;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA realtime
  GRANT ALL ON TABLES TO dashboard_user;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA realtime
  GRANT SELECT, INSERT ON TABLES TO postgres WITH GRANT OPTION;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA realtime
  GRANT UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLES TO postgres;

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth
  GRANT ALL ON SEQUENCES TO postgres, dashboard_user;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth
  GRANT ALL ON FUNCTIONS TO postgres, dashboard_user;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth
  GRANT ALL ON TABLES TO postgres, dashboard_user;

DO $assert_acl_shape$
DECLARE
  acl_count integer;
  unexpected_count integer;
BEGIN
  SELECT count(*) INTO acl_count FROM pg_default_acl;
  IF acl_count <> 24 THEN
    RAISE EXCEPTION 'expected the approved 24-row default-ACL catalog, got %', acl_count;
  END IF;

  WITH expected(owner_role, schema_name, object_type) AS (
    VALUES
      ('postgres','public','S'), ('postgres','public','f'), ('postgres','public','r'),
      ('postgres','storage','S'), ('postgres','storage','f'), ('postgres','storage','r'),
      ('supabase_admin','extensions','S'), ('supabase_admin','extensions','f'), ('supabase_admin','extensions','r'),
      ('supabase_admin','graphql','S'), ('supabase_admin','graphql','f'), ('supabase_admin','graphql','r'),
      ('supabase_admin','graphql_public','S'), ('supabase_admin','graphql_public','f'), ('supabase_admin','graphql_public','r'),
      ('supabase_admin','public','S'), ('supabase_admin','public','f'), ('supabase_admin','public','r'),
      ('supabase_admin','realtime','S'), ('supabase_admin','realtime','f'), ('supabase_admin','realtime','r'),
      ('supabase_auth_admin','auth','S'), ('supabase_auth_admin','auth','f'), ('supabase_auth_admin','auth','r')
  ),
  actual(owner_role, schema_name, object_type) AS (
    SELECT d.defaclrole::regrole::text, n.nspname, d.defaclobjtype::text
    FROM pg_default_acl d
    JOIN pg_namespace n ON n.oid = d.defaclnamespace
  ),
  differences AS (
    (SELECT * FROM expected EXCEPT SELECT * FROM actual)
    UNION ALL
    (SELECT * FROM actual EXCEPT SELECT * FROM expected)
  )
  SELECT count(*) INTO unexpected_count FROM differences;

  IF unexpected_count <> 0 THEN
    RAISE EXCEPTION 'isolated ACL fixture does not match the approved owner/schema/object scopes';
  END IF;

  WITH privilege_types(object_type, privilege) AS (
    VALUES
      ('S','SELECT'), ('S','UPDATE'), ('S','USAGE'),
      ('f','EXECUTE'),
      ('r','DELETE'), ('r','INSERT'), ('r','MAINTAIN'), ('r','REFERENCES'),
      ('r','SELECT'), ('r','TRIGGER'), ('r','TRUNCATE'), ('r','UPDATE')
  ),
  scope_grantees(owner_role, schema_name, object_type, grantee) AS (
    SELECT owner_role, schema_name, object_type, grantee
    FROM (VALUES ('postgres','public'), ('postgres','storage')) scope(owner_role,schema_name)
    CROSS JOIN (VALUES ('S'),('f'),('r')) object_scope(object_type)
    CROSS JOIN (VALUES ('anon'),('authenticated'),('postgres'),('service_role')) grantee_scope(grantee)
    UNION ALL
    SELECT 'supabase_admin','extensions',object_type,'postgres'
    FROM (VALUES ('S'),('f'),('r')) object_scope(object_type)
    UNION ALL
    SELECT 'supabase_admin',schema_name,object_type,grantee
    FROM (VALUES ('graphql'),('graphql_public'),('public')) schema_scope(schema_name)
    CROSS JOIN (VALUES ('S'),('f'),('r')) object_scope(object_type)
    CROSS JOIN (VALUES ('anon'),('authenticated'),('postgres'),('service_role')) grantee_scope(grantee)
    UNION ALL
    SELECT 'supabase_admin','realtime',object_type,grantee
    FROM (VALUES ('S'),('f'),('r')) object_scope(object_type)
    CROSS JOIN (VALUES ('dashboard_user'),('postgres')) grantee_scope(grantee)
    UNION ALL
    SELECT 'supabase_auth_admin','auth',object_type,grantee
    FROM (VALUES ('S'),('f'),('r')) object_scope(object_type)
    CROSS JOIN (VALUES ('dashboard_user'),('postgres')) grantee_scope(grantee)
  ),
  expected AS (
    SELECT
      scope_grantees.owner_role,
      scope_grantees.schema_name,
      scope_grantees.object_type,
      scope_grantees.grantee,
      privilege_types.privilege,
      CASE
        WHEN scope_grantees.owner_role='supabase_admin'
          AND scope_grantees.schema_name='extensions' THEN true
        WHEN scope_grantees.owner_role='supabase_admin'
          AND scope_grantees.schema_name='realtime'
          AND scope_grantees.object_type='r'
          AND scope_grantees.grantee='postgres'
          AND privilege_types.privilege IN ('SELECT','INSERT') THEN true
        ELSE false
      END AS is_grantable
    FROM scope_grantees
    JOIN privilege_types USING (object_type)
  ),
  actual AS (
    SELECT
      owner_role.rolname AS owner_role,
      schema_name.nspname AS schema_name,
      default_acl.defaclobjtype::text AS object_type,
      grantee.rolname AS grantee,
      acl_entry.privilege_type AS privilege,
      acl_entry.is_grantable
    FROM pg_default_acl default_acl
    JOIN pg_roles owner_role ON owner_role.oid=default_acl.defaclrole
    JOIN pg_namespace schema_name ON schema_name.oid=default_acl.defaclnamespace
    CROSS JOIN LATERAL aclexplode(default_acl.defaclacl) acl_entry
    JOIN pg_roles grantee ON grantee.oid=acl_entry.grantee
  ),
  differences AS (
    (SELECT * FROM expected EXCEPT SELECT * FROM actual)
    UNION ALL
    (SELECT * FROM actual EXCEPT SELECT * FROM expected)
  )
  SELECT count(*) INTO unexpected_count FROM differences;

  IF unexpected_count <> 0 THEN
    RAISE EXCEPTION 'isolated ACL fixture privileges differ from the approved live owner/schema/grantee grants';
  END IF;
END;
$assert_acl_shape$;
