-- Test-only recreation of the Supabase-managed auth.users trigger omitted
-- from current-schema.sql (which intentionally contains only public/private).
-- Mirrors the final trigger state from migration 0002 without replaying 0002.
DO $$
DECLARE
  matching_trigger_count integer;
  matching_trigger_name name;
  matching_trigger_enabled "char";
BEGIN
  SELECT count(*), (array_agg(t.tgname))[1], (array_agg(t.tgenabled))[1]
  INTO matching_trigger_count, matching_trigger_name, matching_trigger_enabled
  FROM pg_trigger t
  WHERE t.tgrelid = 'auth.users'::regclass
    AND NOT t.tgisinternal
    AND t.tgfoid = 'petro_private.handle_auth_user()'::regprocedure;

  IF matching_trigger_count > 1 THEN
    RAISE EXCEPTION 'local auth bootstrap found duplicate profile triggers';
  ELSIF matching_trigger_count = 1 THEN
    IF matching_trigger_enabled NOT IN ('O', 'A') THEN
      EXECUTE format(
        'ALTER TABLE auth.users ENABLE TRIGGER %I',
        matching_trigger_name
      );
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1
      FROM pg_trigger t
      WHERE t.tgrelid = 'auth.users'::regclass
        AND NOT t.tgisinternal
        AND t.tgname = 'petro_auth_user_created'
    ) THEN
      RAISE EXCEPTION
        'local auth bootstrap trigger name conflicts with another function';
    END IF;

    CREATE TRIGGER petro_auth_user_created
      AFTER INSERT ON auth.users
      FOR EACH ROW
      EXECUTE FUNCTION petro_private.handle_auth_user();
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    WHERE t.tgrelid = 'auth.users'::regclass
      AND NOT t.tgisinternal
      AND t.tgfoid = 'petro_private.handle_auth_user()'::regprocedure
      AND t.tgenabled IN ('O', 'A')
  ) THEN
    RAISE EXCEPTION 'local auth bootstrap trigger could not be verified';
  END IF;
END;
$$;
