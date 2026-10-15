-- Disposable local-only end-to-end tests for 0012. Synthetic data is rolled back.
BEGIN;

DO $finance_initial_seed$
BEGIN
  IF (SELECT count(*) FROM public.petro_finance_settings)<>1
     OR (SELECT count(*) FROM public.petro_finance_accounts)<>3
     OR EXISTS (SELECT 1 FROM public.petro_finance_accounts WHERE organization_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.petro_finance_bank_accounts)
     OR EXISTS (SELECT 1 FROM public.petro_finance_journal_entries)
     OR EXISTS (SELECT 1 FROM public.petro_finance_journal_lines)
     OR EXISTS (SELECT 1 FROM public.petro_finance_topup_requests)
     OR EXISTS (SELECT 1 FROM public.petro_finance_bank_receipts)
     OR EXISTS (SELECT 1 FROM public.petro_finance_receipt_allocations)
     OR EXISTS (SELECT 1 FROM public.petro_finance_subscription_collections)
     OR EXISTS (SELECT 1 FROM public.petro_finance_transfers)
     OR EXISTS (SELECT 1 FROM public.petro_finance_reservations)
     OR EXISTS (SELECT 1 FROM public.petro_finance_commands)
     OR EXISTS (SELECT 1 FROM public.petro_finance_outbox) THEN
    RAISE EXCEPTION '0012 should seed only configuration and control accounts, not financial activity or organization balances';
  END IF;
END
$finance_initial_seed$;

INSERT INTO auth.users (id,email,raw_user_meta_data,email_confirmed_at) VALUES
 ('00000000-0000-4000-8000-000000001201','finance-owner@example.invalid',
  '{"username":"finance_owner_test","display_name":"Finance Owner Test"}',now()),
 ('00000000-0000-4000-8000-000000001202','finance-reviewer-one@example.invalid',
  '{"username":"finance_reviewer_one","display_name":"Finance Reviewer One"}',now()),
 ('00000000-0000-4000-8000-000000001203','finance-reviewer-two@example.invalid',
  '{"username":"finance_reviewer_two","display_name":"Finance Reviewer Two"}',now()),
 ('00000000-0000-4000-8000-000000001204','finance-operations@example.invalid',
  '{"username":"finance_operations_test","display_name":"Finance Operations Test"}',now()),
 ('00000000-0000-4000-8000-000000001205','finance-auditor@example.invalid',
  '{"username":"finance_auditor_test","display_name":"Finance Auditor Test"}',now()),
 ('00000000-0000-4000-8000-000000001206','finance-support@example.invalid',
  '{"username":"finance_support_test","display_name":"Finance Support Test"}',now());

UPDATE public.petro_profiles SET active=true,account_status='active'
WHERE user_id IN (
 '00000000-0000-4000-8000-000000001201','00000000-0000-4000-8000-000000001202',
 '00000000-0000-4000-8000-000000001203','00000000-0000-4000-8000-000000001204',
 '00000000-0000-4000-8000-000000001205','00000000-0000-4000-8000-000000001206'
);
INSERT INTO public.petro_platform_roles(user_id,role,active) VALUES
 ('00000000-0000-4000-8000-000000001201','owner',true),
 ('00000000-0000-4000-8000-000000001202','finance',true),
 ('00000000-0000-4000-8000-000000001203','finance',true),
 ('00000000-0000-4000-8000-000000001204','operations',true),
 ('00000000-0000-4000-8000-000000001205','auditor',true),
 ('00000000-0000-4000-8000-000000001206','support',true);

CREATE TEMP TABLE finance_test_ids (
  owner_id uuid NOT NULL, reviewer_one_id uuid NOT NULL, reviewer_two_id uuid NOT NULL,
  operations_id uuid NOT NULL, auditor_id uuid NOT NULL, support_id uuid NOT NULL,
  company_id uuid, company_branch_id uuid, provider_id uuid, provider_branch_id uuid,
  bank_id uuid, topup_id uuid, provider_plan_id uuid, provider_version_id uuid,
  provider_request_id uuid, provider_subscription_id uuid, subscription_receipt_id uuid
) ON COMMIT DROP;
GRANT SELECT,INSERT,UPDATE ON pg_temp.finance_test_ids TO authenticated,service_role;
INSERT INTO finance_test_ids(owner_id,reviewer_one_id,reviewer_two_id,operations_id,auditor_id,support_id)
VALUES ('00000000-0000-4000-8000-000000001201','00000000-0000-4000-8000-000000001202',
 '00000000-0000-4000-8000-000000001203','00000000-0000-4000-8000-000000001204',
 '00000000-0000-4000-8000-000000001205','00000000-0000-4000-8000-000000001206');

DO $finance_setup$
DECLARE v_company_id uuid; v_company_branch uuid; v_provider_id uuid; v_provider_branch uuid;
  v_bank_id uuid; v_plan_id uuid; v_version_id uuid; v_request_id uuid; v_subscription_id uuid;
  v_topup_id uuid; value jsonb; v_owner_id uuid; v_reviewer_one uuid;
BEGIN
  SELECT finance_test_ids.owner_id,finance_test_ids.reviewer_one_id
    INTO v_owner_id,v_reviewer_one FROM finance_test_ids;
  PERFORM set_config('request.jwt.claim.sub',v_owner_id::text,true);
  v_company_id:=public.petro_create_organization_details(
    'شركة اختبار الدفتر المالي','company','FIN-CORE-COMPANY',NULL,
    'مسؤول اختبار','+201000001201','finance-company@example.invalid','عنوان اختبار'
  );
  PERFORM public.petro_approve_organization(v_company_id,1,'اعتماد شركة الاختبار المالي');
  PERFORM public.petro_set_organization_operational_status(v_company_id,2,'active','تفعيل شركة الاختبار المالي');
  v_company_branch:=public.petro_create_branch_details(
    v_company_id,'FIN-COMPANY-1','فرع شركة الاختبار','عنوان اختبار','القاهرة',
    NULL,NULL,'{}'::jsonb,'مسؤول فرع الاختبار','+201000001211'
  );
  PERFORM public.petro_approve_branch(v_company_id,v_company_branch,1,'اعتماد فرع الشركة للاختبار');
  PERFORM public.petro_set_branch_operational_status(v_company_id,v_company_branch,2,'active','تفعيل فرع الشركة للاختبار');

  v_provider_id:=public.petro_create_organization_details(
    'مقدم اختبار التحصيل','provider','FIN-CORE-PROVIDER',NULL,
    'مسؤول اختبار','+201000001202','finance-provider@example.invalid','عنوان اختبار'
  );
  PERFORM public.petro_approve_organization(v_provider_id,1,'اعتماد مقدم الاختبار');
  PERFORM public.petro_set_organization_operational_status(v_provider_id,2,'active','تفعيل مقدم الاختبار');
  v_provider_branch:=public.petro_create_branch_details(
    v_provider_id,'FIN-PROVIDER-1','فرع مقدم الاختبار','عنوان اختبار','القاهرة',
    NULL,NULL,'{}'::jsonb,'مسؤول فرع الاختبار','+201000001212'
  );
  PERFORM public.petro_approve_branch(v_provider_id,v_provider_branch,1,'اعتماد فرع المقدم');
  PERFORM public.petro_set_branch_operational_status(v_provider_id,v_provider_branch,2,'active','تفعيل فرع المقدم');

  v_plan_id:=public.petro_billing_admin_create_plan(
    'finance-provider-smoke','provider','خطة مقدم لاختبار التحصيل',500000,'إنشاء خطة محلية'
  );
  v_version_id:=public.petro_billing_admin_add_plan_version(
    v_plan_id,500000,now(),
    '[{"key":"test_entitlement","label":"استحقاق اختبار","value":true,"approved":true}]'::jsonb,
    '[]'::jsonb,'إعداد نسخة خطة محلية'
  );
  PERFORM public.petro_billing_admin_publish_plan_version(v_plan_id,v_version_id,'نشر نسخة خطة محلية');
  v_request_id:=public.petro_billing_admin_create_request(
    v_provider_id,v_provider_branch,'new',NULL,v_plan_id,v_version_id,NULL,
    now()+interval '2 days',now()+interval '367 days',
    'فرع مقدم اختبار معتمد','طلب محلي لاختبار تحصيل الاشتراك',true
  );
  v_subscription_id:=public.petro_billing_admin_review_request(
    v_request_id,'approve','اعتماد طلب محلي للاختبار'
  );
  IF (SELECT status FROM public.petro_subscriptions WHERE id=v_subscription_id)<>'pending_payment' THEN
    RAISE EXCEPTION 'paid provider subscription did not remain pending payment';
  END IF;

  value:=public.petro_finance_admin_add_bank_account(
    'بنك اختبار','حساب تحصيل اختباري','1201','إضافة وجهة اختبار','finance-bank-create-1'
  );
  v_bank_id:=(value->>'id')::uuid;

  v_topup_id:=(public.petro_finance_admin_create_topup(
    v_company_id,1000000,'بنك الشركة','FIN-CORE-TOPUP-10000',
    'طلب شحن اختباري بقيمة 10000 جنيه','finance-topup-create-1'
  )->>'id')::uuid;

  UPDATE finance_test_ids AS test SET
    company_id=v_company_id,company_branch_id=v_company_branch,
    provider_id=v_provider_id,provider_branch_id=v_provider_branch,
    bank_id=v_bank_id,topup_id=v_topup_id,provider_plan_id=v_plan_id,
    provider_version_id=v_version_id,provider_request_id=v_request_id,
    provider_subscription_id=v_subscription_id
  WHERE test.owner_id=v_owner_id;
END
$finance_setup$;

-- Test-only local fixture standing in for a completed private upload. No Storage service is used.
RESET ROLE;
INSERT INTO public.petro_documents(
  uploader_id,organization_id,finance_topup_request_id,document_type,file_name,content_type,
  byte_size,storage_path,status,uploaded_at
)
SELECT owner_id,company_id,topup_id,'إثبات تحويل','topup-test.pdf','application/pdf',
  42,'finance-test/topup-evidence.pdf','pending_review',now()
FROM finance_test_ids;
INSERT INTO public.petro_documents(
  uploader_id,organization_id,branch_id,finance_subscription_request_id,
  document_type,file_name,content_type,byte_size,storage_path,status,uploaded_at
)
SELECT owner_id,provider_id,provider_branch_id,provider_request_id,
  'إثبات اشتراك','subscription-test.pdf','application/pdf',42,
  'finance-test/subscription-evidence.pdf','pending_review',now()
FROM finance_test_ids;
SET LOCAL ROLE authenticated;

DO $finance_organization_choices$
DECLARE f finance_test_ids%ROWTYPE; result jsonb; provider_choice jsonb;
BEGIN
  SELECT * INTO f FROM finance_test_ids;
  PERFORM set_config('request.jwt.claim.sub',f.reviewer_one_id::text,true);
  result:=public.petro_finance_admin_organizations(NULL,1,100);
  SELECT item INTO provider_choice FROM jsonb_array_elements(result->'items') item
  WHERE item->>'id'=f.provider_id::text;
  IF provider_choice IS NULL OR provider_choice->>'kind'<>'provider'
     OR NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(provider_choice->'branches') branch
       WHERE branch->>'id'=f.provider_branch_id::text
     ) THEN
    RAISE EXCEPTION 'finance organization choices omitted the provider branch needed for subscription receipts';
  END IF;

  PERFORM set_config('request.jwt.claim.sub',f.operations_id::text,true);
  result:=public.petro_finance_admin_organizations(NULL,1,100);
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(result->'items') item
    WHERE item->>'id'=f.provider_id::text
  ) OR NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(result->'items') item
    WHERE item->>'id'=f.company_id::text
  ) THEN
    RAISE EXCEPTION 'operations organization choices exceeded the company-topup scope';
  END IF;
END
$finance_organization_choices$;

DO $finance_bank_and_topup$
DECLARE f finance_test_ids%ROWTYPE; value jsonb; repeated jsonb; summary jsonb;
BEGIN
  SELECT * INTO f FROM finance_test_ids;
  PERFORM set_config('request.jwt.claim.sub',f.reviewer_one_id::text,true);
  value:=public.petro_finance_admin_approve_bank_account(
    f.bank_id,'اعتماد مستقل لوجهة التحصيل','finance-bank-approve-1'
  );
  IF value->>'status'<>'active' THEN RAISE EXCEPTION 'bank account was not activated'; END IF;
  PERFORM set_config('request.jwt.claim.sub',f.owner_id::text,true);
  value:=public.petro_finance_admin_submit_topup(
    f.topup_id,1,'إرسال طلب الشحن المحلي','finance-topup-submit-1'
  );
  IF value->>'status'<>'submitted' THEN RAISE EXCEPTION 'topup did not submit'; END IF;
  PERFORM set_config('request.jwt.claim.sub',f.reviewer_one_id::text,true);
  value:=public.petro_finance_admin_approve_topup(
    f.topup_id,f.bank_id,1000000,1000000,'تمت مطابقة التحويل المحلي',
    true,'finance-topup-approve-1'
  );
  repeated:=public.petro_finance_admin_approve_topup(
    f.topup_id,f.bank_id,1000000,1000000,'تمت مطابقة التحويل المحلي',
    true,'finance-topup-approve-1'
  );
  IF value<>repeated THEN RAISE EXCEPTION 'same idempotency key did not replay original approval'; END IF;
  summary:=public.petro_finance_admin_summary();
  IF value->>'status'<>'funded' OR summary->>'companyFundsMinor'<>'1000000' THEN
    RAISE EXCEPTION 'approved topup failed to fund the company main account exactly once';
  END IF;
  BEGIN
    PERFORM public.petro_finance_admin_approve_topup(
      f.topup_id,f.bank_id,1000001,1000000,'محتوى مختلف للمفتاح نفسه',
      true,'finance-topup-approve-1'
    );
    RAISE EXCEPTION 'same idempotency key accepted a different payload';
  EXCEPTION WHEN SQLSTATE '23505' THEN NULL; END;
  BEGIN
    PERFORM public.petro_finance_admin_record_receipt(
      f.company_id,NULL,f.bank_id,'بنك الشركة','FIN-CORE-TOPUP-10000',
      1000000,'محاولة تكرار مرجع التحويل',true,'finance-duplicate-bank-ref'
    );
    RAISE EXCEPTION 'bank reference was accepted twice';
  EXCEPTION WHEN SQLSTATE '23505' THEN NULL; END;
END
$finance_bank_and_topup$;

DO $finance_transfers$
DECLARE f finance_test_ids%ROWTYPE; value jsonb; main_balance bigint; branch_balance bigint;
  accounts_result jsonb;
BEGIN
  SELECT * INTO f FROM finance_test_ids;
  PERFORM set_config('request.jwt.claim.sub',f.reviewer_one_id::text,true);
  value:=public.petro_finance_admin_transfer(
    f.company_id,NULL,f.company_branch_id,300000,'FIN-MOVE-3000',
    'تحويل 3000 جنيه لفرع الشركة','finance-transfer-1'
  );
  IF value->>'amountMinor'<>'300000' THEN RAISE EXCEPTION 'transfer amount was not exact piasters'; END IF;
  PERFORM public.petro_finance_admin_transfer(
    f.company_id,f.company_branch_id,NULL,100000,'FIN-RETURN-1000',
    'إرجاع 1000 جنيه للرصيد الرئيسي','finance-transfer-2'
  );
  accounts_result:=public.petro_finance_admin_accounts(NULL,1,100);
  SELECT (account->>'ledgerBalanceMinor')::bigint INTO main_balance
  FROM jsonb_array_elements(accounts_result->'items') account
  WHERE account->>'organizationId'=f.company_id::text AND account->>'branchId' IS NULL;
  SELECT (account->>'ledgerBalanceMinor')::bigint INTO branch_balance
  FROM jsonb_array_elements(accounts_result->'items') account
  WHERE account->>'organizationId'=f.company_id::text AND account->>'branchId'=f.company_branch_id::text;
  IF main_balance<>800000 OR branch_balance<>200000 OR main_balance+branch_balance<>1000000 THEN
    RAISE EXCEPTION 'internal transfer duplicated company funds or returned the wrong amount';
  END IF;
  BEGIN
    PERFORM public.petro_finance_admin_transfer(
      f.company_id,NULL,f.company_branch_id,900000,'FIN-OVERDRAW',
      'محاولة تجاوز المتاح','finance-transfer-overdraw'
    );
    RAISE EXCEPTION 'transfer used more than available funds';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL; END;
  BEGIN
    PERFORM public.petro_finance_admin_transfer(
      f.company_id,f.provider_branch_id,NULL,100,'FIN-CROSS-ORG',
      'محاولة استخدام فرع جهة أخرى','finance-transfer-cross-org'
    );
    RAISE EXCEPTION 'cross-organization branch was accepted';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL; WHEN SQLSTATE '55000' THEN NULL; END;
END
$finance_transfers$;

-- Exercise the private reserve/release hooks only as service_role; no service-order flow exists here.
RESET ROLE;
CREATE TEMP TABLE finance_test_reservation_input(account_id uuid,actor_id uuid) ON COMMIT DROP;
CREATE TEMP TABLE finance_test_reservation(reservation_id uuid) ON COMMIT DROP;
GRANT SELECT ON pg_temp.finance_test_reservation_input TO service_role,authenticated;
GRANT INSERT,SELECT ON pg_temp.finance_test_reservation TO service_role,authenticated;
INSERT INTO finance_test_reservation_input
SELECT balance.account_id,test.reviewer_one_id
FROM public.petro_finance_account_balances balance
JOIN finance_test_ids test ON test.company_id=balance.organization_id
WHERE balance.branch_id IS NULL AND balance.account_kind='company_funding';
SET LOCAL ROLE service_role;
INSERT INTO finance_test_reservation
SELECT petro_private.finance_reserve_funds(
  input.account_id,'isolated_test',gen_random_uuid(),700000,
  'حجز معزول لاختبار المتاح',input.actor_id
) FROM finance_test_reservation_input input;
SET LOCAL ROLE authenticated;
DO $finance_reservation$
DECLARE f finance_test_ids%ROWTYPE;
BEGIN
  SELECT * INTO f FROM finance_test_ids;
  PERFORM set_config('request.jwt.claim.sub',f.reviewer_one_id::text,true);
  BEGIN
    PERFORM public.petro_finance_admin_transfer(
      f.company_id,NULL,f.company_branch_id,200000,'FIN-RESERVED-OVERDRAW',
      'محاولة استعمال مبلغ محجوز','finance-transfer-reserved'
    );
    RAISE EXCEPTION 'transfer spent reserved funds';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL; END;
END
$finance_reservation$;
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT petro_private.finance_release_reservation(reservation_id,
  (SELECT reviewer_one_id FROM finance_test_ids))
FROM finance_test_reservation;
SET LOCAL ROLE authenticated;

DO $finance_subscriptions$
DECLARE f finance_test_ids%ROWTYPE; receipt jsonb; v_receipt_id uuid; value jsonb;
  held_summary jsonb; subscription_rows jsonb; receipt_rows jsonb;
BEGIN
  SELECT * INTO f FROM finance_test_ids;
  PERFORM set_config('request.jwt.claim.sub',f.reviewer_one_id::text,true);
  receipt:=public.petro_finance_admin_record_receipt(
    f.provider_id,f.provider_branch_id,f.bank_id,'بنك مقدم الاختبار',
    'FIN-PROVIDER-SUB-RECEIPT',600000,'مراجعة إثبات قبض اشتراك الاختبار',
    true,'finance-provider-receipt-1'
  );
  v_receipt_id:=(receipt->>'id')::uuid;
  UPDATE finance_test_ids SET subscription_receipt_id=v_receipt_id;
  PERFORM set_config('request.jwt.claim.sub',f.reviewer_two_id::text,true);
  value:=public.petro_finance_admin_allocate_receipt(
    v_receipt_id,'subscription',f.provider_subscription_id,300000,
    'تخصيص جزئي لاختبار تحصيل الاشتراك','finance-sub-allocate-1'
  );
  PERFORM public.petro_finance_admin_allocate_receipt(
    v_receipt_id,'subscription',f.provider_subscription_id,200000,
    'استكمال المبلغ المستحق للاختبار','finance-sub-allocate-2'
  );
  held_summary:=public.petro_finance_admin_summary();
  subscription_rows:=public.petro_finance_admin_list_subscriptions(NULL,NULL,1,20);
  receipt_rows:=public.petro_finance_admin_list_receipts('FIN-PROVIDER-SUB-RECEIPT',1,20);
  IF held_summary->>'subscriptionHeldMinor'<>'500000'
     OR NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(subscription_rows->'items') item
       WHERE item->>'subscriptionId'=f.provider_subscription_id::text
         AND item->>'subscriptionStatus'='pending_payment'
         AND item->>'collectionStatus'='collected_on_hold'
         AND item->>'amountDueMinor'='500000'
         AND item->>'amountCollectedMinor'='500000'
         AND item->>'activationBlocker'='subscription_accounting_policy_unconfigured'
     )
     OR NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(receipt_rows->'items') item
       WHERE item->>'id'=v_receipt_id::text
         AND item->>'status'='partially_allocated'
         AND item->>'unallocatedMinor'='100000'
     ) THEN
    RAISE EXCEPTION 'subscription collection did not preserve snapshot, hold cash, or leave subscription pending';
  END IF;
  BEGIN
    PERFORM public.petro_finance_admin_allocate_receipt(
      v_receipt_id,'subscription',f.provider_subscription_id,1,
      'محاولة تجاوز المبلغ','finance-sub-allocate-over'
    );
    RAISE EXCEPTION 'over-allocation of subscription was accepted';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL; END;
END
$finance_subscriptions$;

DO $finance_permissions$
DECLARE f finance_test_ids%ROWTYPE; summary jsonb; journal jsonb;
BEGIN
  SELECT * INTO f FROM finance_test_ids;
  IF has_table_privilege('authenticated','public.petro_finance_journal_entries','INSERT')
     OR has_table_privilege('authenticated','public.petro_finance_journal_lines','INSERT')
     OR has_table_privilege('authenticated','public.petro_finance_accounts','UPDATE')
     OR has_table_privilege('authenticated','public.petro_finance_account_balances','UPDATE')
     OR has_function_privilege('anon','public.petro_finance_admin_summary()','EXECUTE') THEN
    RAISE EXCEPTION 'client has direct financial-write privileges';
  END IF;
  PERFORM set_config('request.jwt.claim.sub',f.operations_id::text,true);
  BEGIN
    PERFORM public.petro_finance_admin_transfer(
      f.company_id,NULL,f.company_branch_id,1,'FIN-OPS-DENIED','تجربة منع العمليات','finance-ops-denied'
    );
    RAISE EXCEPTION 'operations role was allowed to transfer';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
  PERFORM public.petro_finance_admin_list_topups(NULL,NULL,1,20);
  BEGIN
    PERFORM public.petro_finance_admin_summary();
    RAISE EXCEPTION 'operations role was allowed to view finance summary';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
  PERFORM set_config('request.jwt.claim.sub',f.auditor_id::text,true);
  summary:=public.petro_finance_admin_summary();
  IF summary->>'currency'<>'EGP' OR summary->>'companyFundsMinor'<>'1000000'
     OR summary->>'subscriptionHeldMinor'<>'500000' THEN
    RAISE EXCEPTION 'auditor read-only summary did not separate funds from subscription receipts';
  END IF;
  BEGIN
    PERFORM public.petro_finance_admin_transfer(
      f.company_id,NULL,f.company_branch_id,1,'FIN-AUDIT-DENIED','تجربة منع المراجع','finance-auditor-denied'
    );
    RAISE EXCEPTION 'auditor was allowed to mutate financial data';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
  PERFORM set_config('request.jwt.claim.sub',f.support_id::text,true);
  BEGIN
    PERFORM public.petro_finance_admin_summary();
    RAISE EXCEPTION 'support role was allowed to read finance';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
END
$finance_permissions$;

DO $finance_reconciliation$
DECLARE result jsonb; f finance_test_ids%ROWTYPE; transfer jsonb; detail jsonb; entry_id uuid;
BEGIN
  SELECT * INTO f FROM finance_test_ids;
  PERFORM set_config('request.jwt.claim.sub',f.reviewer_two_id::text,true);
  result:=public.petro_finance_admin_reconciliation();
  IF result->>'status'<>'balanced' OR result->>'autoRepairPerformed'<>'false' THEN
    RAISE EXCEPTION 'reconciliation found an inconsistency in the synthetic balanced ledger';
  END IF;
  BEGIN
    transfer:=public.petro_finance_admin_transfer(
      f.company_id,NULL,f.company_branch_id,50000,'FIN-REVERSAL-SEED',
      'حركة لاختبار القيد العكسي','finance-reversal-seed'
    );
    entry_id:=(transfer->>'journalEntryId')::uuid;
    PERFORM public.petro_finance_admin_reverse_journal(
      entry_id,'تصحيح حركة اختبار معزولة','finance-reversal-1'
    );
    detail:=public.petro_finance_admin_journal_detail(
      (SELECT (item->>'id')::uuid
       FROM jsonb_array_elements(public.petro_finance_admin_list_journal(
         f.company_id,NULL,NULL,'REV-',1,20
       )->'items') item
       WHERE item->>'reversesEntryId'=entry_id::text)
    );
    IF detail->>'reversesEntryId'<>entry_id::text OR detail->>'entryType'<>'reversal' THEN
      RAISE EXCEPTION 'reversal was not linked to its original journal entry';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE='P0001' THEN RAISE; END IF;
    RAISE;
  END;
END
$finance_reconciliation$;

RESET ROLE;
DO $finance_immutable$
BEGIN
  BEGIN
    UPDATE public.petro_finance_journal_entries SET reason='تعديل غير مسموح'
    WHERE reference='FIN-RETURN-1000';
    RAISE EXCEPTION 'immutable journal entry was editable';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
END
$finance_immutable$;

SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
