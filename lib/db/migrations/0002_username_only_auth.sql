BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.petro_profiles
    WHERE username IS NULL
       OR login_identifier_type IS DISTINCT FROM 'username'
  ) THEN
    RAISE EXCEPTION
      'AUTH-02 stopped safely: existing profiles need explicit username reconciliation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM auth.users u
    LEFT JOIN public.petro_profiles p ON p.user_id = u.id
    WHERE p.user_id IS NULL
       OR u.email IS NULL
       OR btrim(u.email) = ''
  ) THEN
    RAISE EXCEPTION
      'AUTH-02 stopped safely: existing Auth accounts need explicit profile or recovery-email reconciliation';
  END IF;
END;
$$;

ALTER TABLE public.petro_profiles
  ALTER COLUMN username SET NOT NULL,
  ALTER COLUMN login_identifier_type SET DEFAULT 'username',
  ALTER COLUMN login_identifier_type SET NOT NULL;

ALTER TABLE public.petro_profiles
  DROP CONSTRAINT IF EXISTS petro_profiles_login_identifier_type;

ALTER TABLE public.petro_profiles
  ADD CONSTRAINT petro_profiles_login_identifier_type
  CHECK (login_identifier_type = 'username');

CREATE OR REPLACE FUNCTION petro_private.handle_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  normalized_username text;
  normalized_display_name text;
BEGIN
  IF NEW.email IS NULL OR btrim(NEW.email) = '' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A recovery email is required for a Pertomax account';
  END IF;

  normalized_username := nullif(
    lower(btrim(coalesce(NEW.raw_user_meta_data->>'username', ''))),
    ''
  );

  IF normalized_username IS NULL
     OR normalized_username !~ '^[a-z0-9][a-z0-9_.-]{2,31}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A valid username is required for a Pertomax account';
  END IF;

  normalized_display_name := nullif(
    left(btrim(coalesce(NEW.raw_user_meta_data->>'display_name', '')), 120),
    ''
  );
  IF normalized_display_name IS NULL
     OR lower(normalized_display_name) = lower(coalesce(NEW.email, '')) THEN
    normalized_display_name := 'مستخدم جديد';
  END IF;

  INSERT INTO public.petro_profiles (
    user_id,
    display_name,
    active,
    username,
    login_identifier_type,
    account_status
  )
  VALUES (
    NEW.id,
    normalized_display_name,
    false,
    normalized_username,
    'username',
    'pending'
  )
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

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
    RAISE EXCEPTION
      'AUTH-02 stopped safely: multiple auth profile triggers already exist';
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
        'AUTH-02 stopped safely: trigger name is already used by another function';
    END IF;

    EXECUTE
      'CREATE TRIGGER petro_auth_user_created
         AFTER INSERT ON auth.users
         FOR EACH ROW
         EXECUTE FUNCTION petro_private.handle_auth_user()';
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    WHERE t.tgrelid = 'auth.users'::regclass
      AND NOT t.tgisinternal
      AND t.tgfoid = 'petro_private.handle_auth_user()'::regprocedure
      AND t.tgenabled IN ('O', 'A')
  ) THEN
    RAISE EXCEPTION
      'AUTH-02 stopped safely: the enabled auth profile trigger could not be verified';
  END IF;
END;
$$;

COMMIT;
