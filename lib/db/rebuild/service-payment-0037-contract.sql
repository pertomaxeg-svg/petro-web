SELECT
       (SELECT count(*)=5 AND bool_and(c.relrowsecurity) FROM pg_class c WHERE c.oid IN(
        to_regclass('petro_private.merchant_settlement_policy_versions'),to_regclass('petro_private.service_order_payments'),
        to_regclass('petro_private.service_order_receivables'),to_regclass('petro_private.service_order_receipts'),to_regclass('petro_private.service_order_confirmation_commands')))
       AND NOT EXISTS(SELECT 1 FROM pg_class c CROSS JOIN(VALUES('anon'),('authenticated'),('service_role'))r(name)
        WHERE c.oid IN(to_regclass('petro_private.merchant_settlement_policy_versions'),to_regclass('petro_private.service_order_payments'),
        to_regclass('petro_private.service_order_receivables'),to_regclass('petro_private.service_order_receipts'),to_regclass('petro_private.service_order_confirmation_commands'))
        AND has_table_privilege(r.name,c.oid,'SELECT,INSERT,UPDATE,DELETE'))
       AND (SELECT count(*)=3 AND bool_and(p.prosecdef AND p.proconfig=ARRAY['search_path=""']::text[]
        AND has_function_privilege('authenticated',p.oid,'EXECUTE') AND NOT has_function_privilege('anon',p.oid,'EXECUTE')
        AND NOT has_function_privilege('service_role',p.oid,'EXECUTE'))
        FROM pg_proc p WHERE p.oid IN(to_regprocedure('public.petro_service_order_payment(uuid)'),
        to_regprocedure('public.petro_service_order_payment_context(uuid)'),to_regprocedure('public.petro_confirm_service_order(uuid,bigint,text,text)')))
       AND (SELECT count(*)=2 AND bool_and(NOT p.prosecdef AND p.proconfig=ARRAY['search_path=""']::text[]
        AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE') AND NOT has_function_privilege('anon',p.oid,'EXECUTE')
        AND NOT has_function_privilege('service_role',p.oid,'EXECUTE')) FROM pg_proc p WHERE p.oid IN(to_regprocedure('petro_private.guard_service_payment_history()'),to_regprocedure('petro_private.guard_service_payment_reversal()')))
       AND EXISTS(SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND tgname='service_payment_reversal_guard' AND tgrelid=to_regclass('public.petro_finance_journal_entries'))
       AND(SELECT count(*)=5 FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND tgname IN('merchant_settlement_policy_immutable','service_order_payment_immutable','service_order_receivable_immutable','service_order_receipt_immutable','service_confirmation_command_immutable'))
       AND coalesce((SELECT NOT has_sequence_privilege('anon',c.oid,'USAGE,SELECT,UPDATE')
        AND NOT has_sequence_privilege('authenticated',c.oid,'USAGE,SELECT,UPDATE') AND NOT has_sequence_privilege('service_role',c.oid,'USAGE,SELECT,UPDATE')
        FROM pg_class c WHERE c.oid=to_regclass('petro_private.service_receipt_number_seq')),false) AS present;
