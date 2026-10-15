-- Verifies the isolated 0009 cutover: new APIs remain available only to
-- authenticated callers; the legacy RPC is removed only from client roles.
DO $privileges$
BEGIN
  IF has_function_privilege(
       'authenticated',
       'public.petro_set_account_status(uuid,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.petro_set_account_status(uuid,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'legacy account status RPC is still callable by client roles';
  END IF;

  IF NOT has_function_privilege(
       'service_role',
       'public.petro_set_account_status(uuid,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION '0009 unexpectedly removed the existing service_role grant';
  END IF;

  IF NOT has_function_privilege(
       'authenticated',
       'public.petro_admin_set_account_status(uuid,text,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.petro_admin_set_account_status(uuid,text,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'reasoned account status RPC privileges are incorrect after 0009';
  END IF;
END;
$privileges$;
