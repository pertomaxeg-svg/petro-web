-- Disposable local-only end-to-end tests for 0012/0013. Synthetic data is rolled back.
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
  provider_branch_two_id uuid,
  bank_id uuid, topup_id uuid, provider_plan_id uuid, provider_version_id uuid,
  provider_version_two_id uuid,
  provider_request_id uuid, provider_subscription_id uuid,
  provider_request_two_id uuid, provider_subscription_two_id uuid,
  subscription_receipt_id uuid
) ON COMMIT DROP;
GRANT SELECT,INSERT,UPDATE ON pg_temp.finance_test_ids TO authenticated,service_role;
INSERT INTO finance_test_ids(owner_id,reviewer_one_id,reviewer_two_id,operations_id,auditor_id,support_id)
VALUES ('00000000-0000-4000-8000-000000001201','00000000-0000-4000-8000-000000001202',
 '00000000-0000-4000-8000-000000001203','00000000-0000-4000-8000-000000001204',
 '00000000-0000-4000-8000-000000001205','00000000-0000-4000-8000-000000001206');

DO $finance_setup$
DECLARE v_company_id uuid; v_company_branch uuid; v_provider_id uuid; v_provider_branch uuid;
  v_provider_branch_two uuid; v_bank_id uuid; v_plan_id uuid; v_version_id uuid;
  v_request_id uuid; v_subscription_id uuid; v_version_two_id uuid;
  v_request_two_id uuid; v_subscription_two_id uuid;
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
  IF EXISTS (SELECT 1 FROM public.petro_subscriptions WHERE organization_id=v_company_id) THEN
    RAISE EXCEPTION 'funding independence fixture unexpectedly contains a company subscription';
  END IF;
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
  v_provider_branch_two:=public.petro_create_branch_details(
    v_provider_id,'FIN-PROVIDER-2','فرع مقدم الاختبار الثاني','عنوان اختبار','القاهرة',
    NULL,NULL,'{}'::jsonb,'مسؤول فرع الاختبار الثاني','+201000001213'
  );
  PERFORM public.petro_approve_branch(v_provider_id,v_provider_branch_two,1,'اعتماد فرع المقدم الثاني');
  PERFORM public.petro_set_branch_operational_status(v_provider_id,v_provider_branch_two,2,'active','تفعيل فرع المقدم الثاني');

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
  v_version_two_id:=public.petro_billing_admin_add_plan_version(
    v_plan_id,500000,now()+interval '400 days',
    '[{"key":"test_entitlement","label":"استحقاق اختبار معدل","value":false,"approved":true}]'::jsonb,
    '[]'::jsonb,'نسخة مستقبلية لاختبار ثبات الشروط'
  );
  PERFORM public.petro_billing_admin_publish_plan_version(
    v_plan_id,v_version_two_id,'نشر نسخة مستقبلية لاختبار التحصيل'
  );
  v_request_two_id:=public.petro_billing_admin_create_request(
    v_provider_id,v_provider_branch,'new',NULL,v_plan_id,v_version_two_id,NULL,
    now()+interval '400 days',now()+interval '765 days',
    'فرع مقدم الاختبار معتمد','طلب محلي لاختبار سقف تخصيص الإيصال على النسخة المستقبلية',true
  );
  v_subscription_two_id:=public.petro_billing_admin_review_request(
    v_request_two_id,'approve','اعتماد طلب محلي ثاني للاختبار'
  );
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
    provider_branch_two_id=v_provider_branch_two,
    bank_id=v_bank_id,topup_id=v_topup_id,provider_plan_id=v_plan_id,
    provider_version_id=v_version_id,provider_version_two_id=v_version_two_id,
    provider_request_id=v_request_id,
    provider_subscription_id=v_subscription_id,
    provider_request_two_id=v_request_two_id,provider_subscription_two_id=v_subscription_two_id
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
INSERT INTO public.petro_documents(
  uploader_id,organization_id,branch_id,finance_subscription_request_id,
  document_type,file_name,content_type,byte_size,storage_path,status,uploaded_at
)
SELECT owner_id,provider_id,provider_branch_id,provider_request_two_id,
  'إثبات اشتراك','subscription-future-test.pdf','application/pdf',42,
  'finance-test/subscription-future-evidence.pdf','pending_review',now()
FROM finance_test_ids;
CREATE FUNCTION public.finance_test_counts(p_command_key text DEFAULT NULL,p_reference text DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=''
AS $$
  SELECT jsonb_build_object(
    'journalEntries',(SELECT count(*) FROM public.petro_finance_journal_entries),
    'outboxEvents',(SELECT count(*) FROM public.petro_finance_outbox),
    'auditEvents',(SELECT count(*) FROM public.petro_audit_events),
    'commandsForKey',(SELECT count(*) FROM public.petro_finance_commands
      WHERE idempotency_key=p_command_key),
    'receiptsForReference',(SELECT count(*) FROM public.petro_finance_bank_receipts
      WHERE bank_reference=p_reference),
    'journalEntryId',(SELECT id FROM public.petro_finance_journal_entries
      WHERE reference=p_reference LIMIT 1)
  )
$$;
REVOKE ALL ON FUNCTION public.finance_test_counts(text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.finance_test_counts(text,text) TO authenticated;
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
  failed boolean; journal_before bigint; outbox_before bigint; counts jsonb;
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
  counts:=public.finance_test_counts('finance-topup-approve-1',NULL);
  journal_before:=(counts->>'journalEntries')::bigint;
  outbox_before:=(counts->>'outboxEvents')::bigint;
  failed:=false;
  BEGIN
    PERFORM public.petro_finance_admin_approve_topup(
      f.topup_id,gen_random_uuid(),1000000,1000000,'محاولة قبل الحفظ',
      true,'finance-topup-approve-1'
    );
  EXCEPTION WHEN OTHERS THEN failed:=true; END;
  counts:=public.finance_test_counts('finance-topup-approve-1',NULL);
  IF NOT failed
     OR (counts->>'journalEntries')::bigint<>journal_before
     OR (counts->>'outboxEvents')::bigint<>outbox_before
     OR (counts->>'commandsForKey')::bigint<>0 THEN
    RAISE EXCEPTION 'failed top-up approval persisted a command or partial ledger state';
  END IF;
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
  BEGIN
    PERFORM public.petro_finance_admin_record_receipt(
      f.provider_id,f.provider_branch_id,f.bank_id,'بنك مقدم الاختبار',
      'FIN-CORE-TOPUP-10000',500000,
      'محاولة تسجيل التحويل نفسه كقبض اشتراك مستقل',true,'finance-cross-purpose-bank-ref'
    );
    RAISE EXCEPTION 'bank transfer was recorded again for a different financial purpose';
  EXCEPTION WHEN SQLSTATE '23505' THEN NULL; END;
END
$finance_bank_and_topup$;

-- Inject a failure after the journal header is written, then retry the same
-- command key to prove the enclosing transaction leaves no partial money.
RESET ROLE;
CREATE FUNCTION public.finance_test_fail_receipt_line() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.petro_finance_journal_entries entry
    WHERE entry.id=NEW.entry_id AND entry.entry_type='bank_receipt'
  ) THEN
    RAISE EXCEPTION 'synthetic post-entry failure' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER finance_test_fail_receipt_line
  BEFORE INSERT ON public.petro_finance_journal_lines
  FOR EACH ROW EXECUTE FUNCTION public.finance_test_fail_receipt_line();
SET LOCAL ROLE authenticated;
DO $finance_receipt_retry$
DECLARE f finance_test_ids%ROWTYPE; failed boolean:=false;
  journal_before bigint; outbox_before bigint; audit_before bigint; counts jsonb;
BEGIN
  SELECT * INTO f FROM finance_test_ids;
  PERFORM set_config('request.jwt.claim.sub',f.reviewer_one_id::text,true);
  counts:=public.finance_test_counts('finance-receipt-after-write','FIN-RECEIPT-RETRY-01');
  journal_before:=(counts->>'journalEntries')::bigint;
  outbox_before:=(counts->>'outboxEvents')::bigint;
  audit_before:=(counts->>'auditEvents')::bigint;
  BEGIN
    PERFORM public.petro_finance_admin_record_receipt(
      f.company_id,NULL,f.bank_id,'بنك الشركة','FIN-RECEIPT-RETRY-01',
      150000,'اختبار فشل بعد كتابة القيد',true,'finance-receipt-after-write'
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN failed:=true; END;
  counts:=public.finance_test_counts('finance-receipt-after-write','FIN-RECEIPT-RETRY-01');
  IF NOT failed
     OR (counts->>'journalEntries')::bigint<>journal_before
     OR (counts->>'outboxEvents')::bigint<>outbox_before
     OR (counts->>'auditEvents')::bigint<>audit_before
     OR (counts->>'receiptsForReference')::bigint<>0
     OR (counts->>'commandsForKey')::bigint<>0 THEN
    RAISE EXCEPTION 'post-entry failure left partial receipt, command, outbox, audit, or journal data';
  END IF;
END
$finance_receipt_retry$;
RESET ROLE;
DROP TRIGGER finance_test_fail_receipt_line ON public.petro_finance_journal_lines;
DROP FUNCTION public.finance_test_fail_receipt_line();
SET LOCAL ROLE authenticated;
DO $finance_receipt_retry_success$
DECLARE f finance_test_ids%ROWTYPE; value jsonb; repeated jsonb; counts jsonb;
  journal_before bigint; outbox_before bigint;
BEGIN
  SELECT * INTO f FROM finance_test_ids;
  PERFORM set_config('request.jwt.claim.sub',f.reviewer_one_id::text,true);
  counts:=public.finance_test_counts('finance-receipt-after-write','FIN-RECEIPT-RETRY-01');
  journal_before:=(counts->>'journalEntries')::bigint;
  outbox_before:=(counts->>'outboxEvents')::bigint;
  value:=public.petro_finance_admin_record_receipt(
    f.company_id,NULL,f.bank_id,'بنك الشركة','FIN-RECEIPT-RETRY-01',
    150000,'اختبار فشل بعد كتابة القيد',true,'finance-receipt-after-write'
  );
  repeated:=public.petro_finance_admin_record_receipt(
    f.company_id,NULL,f.bank_id,'بنك الشركة','FIN-RECEIPT-RETRY-01',
    150000,'اختبار فشل بعد كتابة القيد',true,'finance-receipt-after-write'
  );
  counts:=public.finance_test_counts('finance-receipt-after-write','FIN-RECEIPT-RETRY-01');
  IF value<>repeated
     OR (counts->>'journalEntries')::bigint<>journal_before+1
     OR (counts->>'outboxEvents')::bigint<>outbox_before+1
     OR (counts->>'receiptsForReference')::bigint<>1
     OR (counts->>'commandsForKey')::bigint<>1 THEN
    RAISE EXCEPTION 'receipt retry after a successful commit did not replay exactly one receipt';
  END IF;
END
$finance_receipt_retry_success$;

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
CREATE TEMP TABLE finance_test_reservation_input(
  account_id uuid,actor_id uuid,source_id uuid,control_account_id uuid
) ON COMMIT DROP;
CREATE TEMP TABLE finance_test_reservation(
  reservation_id uuid,account_id uuid,source_id uuid,consumption_entry_id uuid
) ON COMMIT DROP;
GRANT SELECT ON pg_temp.finance_test_reservation_input TO service_role,authenticated;
GRANT INSERT,SELECT,UPDATE ON pg_temp.finance_test_reservation TO service_role,authenticated;
INSERT INTO finance_test_reservation_input
SELECT balance.account_id,test.reviewer_one_id,gen_random_uuid(),control.id
FROM public.petro_finance_account_balances balance
JOIN finance_test_ids test ON test.company_id=balance.organization_id
JOIN public.petro_finance_accounts control
  ON control.account_kind='bank_clearing' AND control.receiving_bank_account_id=test.bank_id
WHERE balance.branch_id IS NULL AND balance.account_kind='company_funding';
SET LOCAL ROLE service_role;
INSERT INTO finance_test_reservation
SELECT petro_private.finance_reserve_funds(
  input.account_id,'isolated_test',input.source_id,750000,
  'حجز معزول لاختبار المتاح',input.actor_id
),input.account_id,input.source_id,NULL FROM finance_test_reservation_input input;
SET LOCAL ROLE authenticated;
DO $finance_reservation$
DECLARE f finance_test_ids%ROWTYPE; original_entry_id uuid;
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
  SELECT (public.finance_test_counts(NULL,'FIN-RETURN-1000')->>'journalEntryId')::uuid
    INTO original_entry_id;
  BEGIN
    PERFORM public.petro_finance_admin_reverse_journal(
      original_entry_id,'محاولة عكس تخترق مبلغًا محجوزًا','finance-reverse-reserved'
    );
    RAISE EXCEPTION 'reversal spent reserved funds';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL; END;
END
$finance_reservation$;
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT petro_private.finance_release_reservation(reservation_id,
  (SELECT reviewer_one_id FROM finance_test_ids))
FROM finance_test_reservation;
SELECT petro_private.finance_release_reservation(reservation_id,
  (SELECT reviewer_one_id FROM finance_test_ids))
FROM finance_test_reservation;
WITH source AS (
  SELECT input.account_id,input.actor_id,gen_random_uuid() AS source_id
  FROM finance_test_reservation_input input
)
INSERT INTO finance_test_reservation(reservation_id,account_id,source_id,consumption_entry_id)
SELECT petro_private.finance_reserve_funds(
  source.account_id,'isolated_test',source.source_id,25000,
  'حجز لاختبار استهلاك اصطناعي',source.actor_id
),source.account_id,source.source_id,NULL FROM source;
RESET ROLE;
UPDATE finance_test_reservation reservation
SET consumption_entry_id=petro_private.finance_post_entry(
  gen_random_uuid(),'reservation_consumption',reservation.source_id,
  test.company_id,'FIN-RESERVATION-CONSUMPTION-TEST',
  'قيد موازن اصطناعي لاختبار استهلاك الحجز فقط',
  jsonb_build_array(
    jsonb_build_object('accountId',reservation.account_id,'side','debit','amountMinor','25000'),
    jsonb_build_object('accountId',input.control_account_id,'side','credit','amountMinor','25000')
  )
)
FROM finance_test_ids test,finance_test_reservation_input input
WHERE reservation.consumption_entry_id IS NULL
  AND reservation.source_id NOT IN (
    SELECT original.source_id FROM finance_test_reservation_input original
  )
  AND input.control_account_id IS NOT NULL;
SET LOCAL ROLE service_role;
DO $finance_reservation_consume$
DECLARE reservation finance_test_reservation%ROWTYPE; result jsonb; repeated jsonb; f finance_test_ids%ROWTYPE;
BEGIN
  SELECT * INTO reservation FROM finance_test_reservation
  WHERE consumption_entry_id IS NOT NULL;
  SELECT * INTO f FROM finance_test_ids;
  result:=petro_private.finance_consume_reservation(reservation.reservation_id,reservation.consumption_entry_id);
  repeated:=petro_private.finance_consume_reservation(reservation.reservation_id,reservation.consumption_entry_id);
  IF result->>'status'<>'consumed' OR result->>'replayed'<>'false'
     OR repeated->>'replayed'<>'true'
     OR result->>'journalEntryId'<>reservation.consumption_entry_id::text
     OR repeated->>'journalEntryId'<>reservation.consumption_entry_id::text THEN
    RAISE EXCEPTION 'reservation consumption did not persist and replay its linked journal entry';
  END IF;
  BEGIN
    PERFORM petro_private.finance_consume_reservation(reservation.reservation_id,gen_random_uuid());
    RAISE EXCEPTION 'consumed reservation accepted a different journal entry';
  EXCEPTION WHEN SQLSTATE '23505' THEN NULL; END;
  BEGIN
    PERFORM petro_private.finance_release_reservation(reservation.reservation_id,f.reviewer_one_id);
    RAISE EXCEPTION 'consumed reservation was released';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
END
$finance_reservation_consume$;
SET LOCAL ROLE authenticated;
DO $finance_reservation_balance$
DECLARE f finance_test_ids%ROWTYPE; accounts_result jsonb; balance_minor bigint;
BEGIN
  SELECT * INTO f FROM finance_test_ids;
  PERFORM set_config('request.jwt.claim.sub',f.reviewer_one_id::text,true);
  accounts_result:=public.petro_finance_admin_accounts(NULL,1,100);
  SELECT (account->>'availableMinor')::bigint INTO balance_minor
  FROM jsonb_array_elements(accounts_result->'items') account
  WHERE account->>'organizationId'=f.company_id::text AND account->>'branchId' IS NULL;
  IF balance_minor<>775000 THEN
    RAISE EXCEPTION 'consumed reservation did not debit exactly 25000 piasters from available company funds';
  END IF;
END
$finance_reservation_balance$;

DO $finance_subscriptions$
DECLARE f finance_test_ids%ROWTYPE; receipt jsonb; v_receipt_id uuid;
  second_receipt jsonb; second_receipt_id uuid; value jsonb; repeated jsonb;
  detail jsonb;
  held_summary jsonb; subscription_rows jsonb; receipt_rows jsonb; second_receipt_rows jsonb;
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
  repeated:=public.petro_finance_admin_allocate_receipt(
    v_receipt_id,'subscription',f.provider_subscription_id,300000,
    'تخصيص جزئي لاختبار تحصيل الاشتراك','finance-sub-allocate-1'
  );
  IF value<>repeated THEN RAISE EXCEPTION 'subscription allocation did not replay its original result'; END IF;
  BEGIN
    PERFORM public.petro_finance_admin_allocate_receipt(
      v_receipt_id,'subscription',f.provider_subscription_id,300001,
      'حمولة مختلفة للمفتاح نفسه','finance-sub-allocate-1'
    );
    RAISE EXCEPTION 'allocation accepted a different payload for its idempotency key';
  EXCEPTION WHEN SQLSTATE '23505' THEN NULL; END;
  PERFORM public.petro_finance_admin_allocate_receipt(
    v_receipt_id,'subscription',f.provider_subscription_id,200000,
    'استكمال المبلغ المستحق للاختبار','finance-sub-allocate-2'
  );
  BEGIN
    PERFORM public.petro_finance_admin_allocate_receipt(
      v_receipt_id,'subscription',f.provider_subscription_two_id,100001,
      'محاولة تجاوز قيمة الإيصال','finance-sub-allocate-receipt-cap'
    );
    RAISE EXCEPTION 'receipt allocations exceeded the verified receipt amount';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL; END;
  PERFORM public.petro_finance_admin_allocate_receipt(
    v_receipt_id,'subscription',f.provider_subscription_two_id,100000,
    'تخصيص باقي الإيصال','finance-sub-allocate-receipt-cap'
  );
  PERFORM set_config('request.jwt.claim.sub',f.reviewer_one_id::text,true);
  second_receipt:=public.petro_finance_admin_record_receipt(
    f.provider_id,f.provider_branch_id,f.bank_id,'بنك مقدم الاختبار',
    'FIN-PROVIDER-SUB-RECEIPT-2',400000,'مطابقة إيصال إكمال الاشتراك',
    true,'finance-provider-receipt-2'
  );
  second_receipt_id:=(second_receipt->>'id')::uuid;
  PERFORM set_config('request.jwt.claim.sub',f.reviewer_two_id::text,true);
  PERFORM public.petro_finance_admin_allocate_receipt(
    second_receipt_id,'subscription',f.provider_subscription_two_id,400000,
    'إكمال التحصيل في الاختبار المعزول','finance-sub-allocate-3'
  );
  held_summary:=public.petro_finance_admin_summary();
  subscription_rows:=public.petro_finance_admin_list_subscriptions(NULL,NULL,1,20);
  receipt_rows:=public.petro_finance_admin_list_receipts('FIN-PROVIDER-SUB-RECEIPT',1,20);
  second_receipt_rows:=public.petro_finance_admin_list_receipts('FIN-PROVIDER-SUB-RECEIPT-2',1,20);
  detail:=public.petro_finance_admin_receipt_detail(v_receipt_id);
  IF held_summary->>'subscriptionHeldMinor'<>'1000000'
      OR held_summary->>'companyFundsMinor'<>'975000'
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
       SELECT 1 FROM jsonb_array_elements(subscription_rows->'items') item
       WHERE item->>'subscriptionId'=f.provider_subscription_two_id::text
         AND item->>'subscriptionStatus'='pending_payment'
         AND item->>'collectionStatus'='collected_on_hold'
         AND item->>'amountDueMinor'='500000'
         AND item->>'amountCollectedMinor'='500000'
         AND item->>'activationBlocker'='subscription_accounting_policy_unconfigured'
      )
     OR NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(receipt_rows->'items') item
       WHERE item->>'id'=v_receipt_id::text
          AND item->>'status'='fully_allocated'
          AND item->>'unallocatedMinor'='0'
      )
     OR NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(second_receipt_rows->'items') item
       WHERE item->>'id'=second_receipt_id::text
         AND item->>'status'='fully_allocated'
         AND item->>'unallocatedMinor'='0'
     ) THEN
    RAISE EXCEPTION 'subscription collection did not preserve snapshot, hold cash, or leave subscription pending';
  END IF;
  IF detail->'journal'->>'debitMinor'<>'600000'
     OR detail->'journal'->>'creditMinor'<>'600000'
     OR jsonb_array_length(detail->'allocations')<>3
     OR detail->'documents'='[]'::jsonb
     OR NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(detail->'allocations') allocation
       WHERE allocation->>'snapshotPriceMinor'='500000'
         AND allocation->>'planVersionId'=f.provider_version_id::text
         AND allocation->'planSnapshot'->'entitlements'->0->>'value'='true'
     )
     OR NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(detail->'allocations') allocation
       WHERE allocation->>'snapshotPriceMinor'='500000'
         AND allocation->>'planVersionId'=f.provider_version_two_id::text
         AND allocation->'planSnapshot'->'entitlements'->0->>'value'='false'
     ) THEN
    RAISE EXCEPTION 'receipt detail omitted its balanced source, allocations, evidence, or original plan snapshot';
  END IF;

  PERFORM set_config('request.jwt.claim.sub',f.auditor_id::text,true);
  detail:=public.petro_finance_admin_receipt_detail(v_receipt_id);
  IF detail->>'bankReference' IS NOT NULL OR detail->>'receivingAccountLast4' IS NOT NULL
     OR detail->>'maskedReference'<>'EIPT' THEN
    RAISE EXCEPTION 'auditor receipt detail exposed an unmasked bank reference or account tail';
  END IF;
  PERFORM set_config('request.jwt.claim.sub',f.support_id::text,true);
  BEGIN
    PERFORM public.petro_finance_admin_receipt_detail(v_receipt_id);
    RAISE EXCEPTION 'support role was allowed to read receipt details';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
END
$finance_subscriptions$;

DO $finance_permissions$
DECLARE f finance_test_ids%ROWTYPE; summary jsonb; direct_write_failed boolean:=false;
BEGIN
  SELECT * INTO f FROM finance_test_ids;
  IF has_table_privilege('authenticated','public.petro_finance_journal_entries','INSERT')
     OR has_table_privilege('authenticated','public.petro_finance_journal_lines','INSERT')
     OR has_table_privilege('authenticated','public.petro_finance_accounts','UPDATE')
     OR has_table_privilege('authenticated','public.petro_finance_account_balances','UPDATE')
     OR has_function_privilege('anon','public.petro_finance_admin_summary()','EXECUTE') THEN
    RAISE EXCEPTION 'client has direct financial-write privileges';
  END IF;
  BEGIN
    UPDATE public.petro_finance_account_balances
    SET ledger_balance_minor=ledger_balance_minor+1
    WHERE account_id IN (
      SELECT id FROM public.petro_finance_accounts WHERE organization_id=f.company_id
    );
  EXCEPTION WHEN OTHERS THEN direct_write_failed:=true; END;
  IF NOT direct_write_failed THEN
    RAISE EXCEPTION 'financial user directly changed a derived balance';
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
  IF summary->>'currency'<>'EGP' OR summary->>'companyFundsMinor'<>'975000'
     OR summary->>'subscriptionHeldMinor'<>'1000000' THEN
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
DECLARE result jsonb; f finance_test_ids%ROWTYPE; transfer jsonb; reversal jsonb;
  repeated jsonb; detail jsonb; entry_id uuid; reversal_id uuid; main_balance bigint;
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
    reversal:=public.petro_finance_admin_reverse_journal(
      entry_id,'تصحيح حركة اختبار معزولة','finance-reversal-1'
    );
    repeated:=public.petro_finance_admin_reverse_journal(
      entry_id,'تصحيح حركة اختبار معزولة','finance-reversal-1'
    );
    IF reversal<>repeated THEN RAISE EXCEPTION 'reversal retry did not replay the original result'; END IF;
    BEGIN
      PERFORM public.petro_finance_admin_reverse_journal(
        entry_id,'محاولة عكس ثانية بمفتاح مختلف','finance-reversal-duplicate'
      );
      RAISE EXCEPTION 'same journal entry was reversed a second time';
    EXCEPTION WHEN SQLSTATE '23505' THEN NULL; END;
    reversal_id:=(reversal->>'id')::uuid;
    detail:=public.petro_finance_admin_journal_detail(reversal_id);
    IF detail->>'reversesEntryId'<>entry_id::text OR detail->>'entryType'<>'reversal' THEN
      RAISE EXCEPTION 'reversal was not linked to its original journal entry';
    END IF;
    SELECT (item->>'ledgerBalanceMinor')::bigint INTO main_balance
    FROM jsonb_array_elements(public.petro_finance_admin_accounts(NULL,1,100)->'items') item
    WHERE item->>'organizationId'=f.company_id::text AND item->>'branchId' IS NULL;
    IF main_balance<>775000 THEN RAISE EXCEPTION 'reversal did not restore the exact main-account balance'; END IF;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE='P0001' THEN RAISE; END IF;
    RAISE;
  END;
END
$finance_reconciliation$;

-- Create one deliberately inconsistent row in the disposable transaction only.
-- Disable exactly the two deferred balance checks for these test inserts, then
-- re-enable them before asking reconciliation to detect it.
RESET ROLE;
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE public.petro_finance_journal_entries DISABLE TRIGGER petro_finance_entry_balance_check;
ALTER TABLE public.petro_finance_journal_lines DISABLE TRIGGER petro_finance_lines_balance_check;
INSERT INTO public.petro_finance_journal_entries(
  id,entry_type,source_id,organization_id,reference,reason,actor_id
)
SELECT gen_random_uuid(),'reservation_consumption',gen_random_uuid(),test.company_id,
  'FIN-SYNTHETIC-IMBALANCE','فرق اصطناعي لاختبار كشف المطابقة',test.owner_id
FROM finance_test_ids test;
INSERT INTO public.petro_finance_journal_lines(entry_id,account_id,side,amount_minor)
SELECT entry.id,account.id,'debit',1
FROM public.petro_finance_journal_entries entry
JOIN finance_test_ids test ON entry.organization_id=test.company_id
JOIN public.petro_finance_accounts account
  ON account.organization_id=test.company_id AND account.account_kind='company_funding'
WHERE entry.reference='FIN-SYNTHETIC-IMBALANCE';
ALTER TABLE public.petro_finance_journal_entries ENABLE TRIGGER petro_finance_entry_balance_check;
ALTER TABLE public.petro_finance_journal_lines ENABLE TRIGGER petro_finance_lines_balance_check;
SET LOCAL ROLE authenticated;
DO $finance_reconciliation_anomaly$
DECLARE f finance_test_ids%ROWTYPE; result jsonb;
BEGIN
  SELECT * INTO f FROM finance_test_ids;
  PERFORM set_config('request.jwt.claim.sub',f.owner_id::text,true);
  result:=public.petro_finance_admin_reconciliation();
  IF result->>'status'<>'issues_found'
     OR result->>'unbalancedEntries'<>'1'
     OR result->>'autoRepairPerformed'<>'false' THEN
    RAISE EXCEPTION 'reconciliation failed to detect synthetic imbalance without silent repair';
  END IF;
END
$finance_reconciliation_anomaly$;

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
