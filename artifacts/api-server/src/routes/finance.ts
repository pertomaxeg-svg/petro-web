import {createHash} from "node:crypto";
import { raw, Router, type IRouter, type Request, type Response } from "express";
import {
  AllocateAdminFinanceReceiptBody,
  ApproveAdminFinanceBankAccountBody,
  ApproveAdminFinanceTopupBody,
  CreateAdminFinanceBankAccountBody,
  CreateAdminFinanceTopupBody,
  CreateAdminFinanceTransferBody,
  DisableAdminFinanceBankAccountBody,
  RecordAdminFinanceReceiptBody,
  ReverseAdminFinanceJournalEntryBody,
  ReviewAdminFinanceTopupBody,
  SubmitAdminFinanceTopupBody,
  UpdateAdminFinanceTopupBody,
} from "@workspace/api-zod";
import { isRecord, setNoStore } from "../lib/supabaseServer";
import { requireSession, type SessionContext } from "./management";

const router: IRouter = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const READ_ROLES = ["owner", "finance", "auditor"] as const;
const MUTATE_ROLES = ["owner", "finance"] as const;
const SUBMIT_ROLES = ["owner", "finance", "operations"] as const;
type FinanceRole = (typeof SUBMIT_ROLES)[number] | "auditor";

function fail(res: Response, status: number, message: string): void {
  res.status(status).json({ message });
}

function validId(value: string | undefined): value is string {
  return Boolean(value && UUID_RE.test(value));
}

function parseBody<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
): T | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function mapFinanceError(
  res: Response,
  error: { code?: string; message?: string } | null,
): void {
  if (!error) return;
  if (error.code === "42501" || error.code === "PGRST301") {
    fail(res, 403, "ليست لديك صلاحية لهذا الإجراء.");
  } else if (error.code === "PGRST202" || error.code === "42883") {
    fail(res, 503, "مخطط الإدارة المالية غير مطبق أو غير متوافق بعد.");
  } else if (error.code === "P0002") {
    fail(res, 404, "لم يتم العثور على السجل المطلوب.");
  } else if (["23505", "23514", "40001", "PT409", "55000"].includes(error.code ?? "")) {
    fail(res, 409, "تعارضت الحالة أو الرصيد أو المرجع. حدّث السجل قبل إعادة المحاولة.");
  } else if (error.code === "22023" || error.code === "22003") {
    fail(res, 400, "تحقق من المبلغ والحقول والسبب المطلوب.");
  } else {
    fail(res, 500, "تعذر تنفيذ الإجراء المالي.");
  }
}

async function authorizedSession(
  req: Request,
  res: Response,
  allowed: readonly FinanceRole[],
): Promise<SessionContext | null> {
  const session = await requireSession(req, res);
  if (!session) return null;
  const { data, error } = await session.supabase.rpc("petro_access_context");
  if (error || !isRecord(data)) {
    fail(res, 503, "تعذر التحقق من صلاحية الإدارة المالية.");
    return null;
  }
  const value = data["platform_roles"] ?? data["platformRoles"];
  const roles = Array.isArray(value) ? value : [];
  if (!allowed.some((role) => roles.includes(role))) {
    fail(res, 403, "هذا الإجراء غير متاح للدور الحالي.");
    return null;
  }
  return session;
}

type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };

async function callFinanceRpc(
  session: SessionContext,
  functionName: string,
  args?: Record<string, unknown>,
): Promise<RpcResult> {
  const rpc = session.supabase.rpc as unknown as (
    name: string,
    parameters?: Record<string, unknown>,
  ) => Promise<RpcResult>;
  return rpc.call(session.supabase, functionName, args);
}

async function runRpc(
  req: Request,
  res: Response,
  functionName: string,
  args: Record<string, unknown> | undefined,
  allowed: readonly FinanceRole[],
  status = 200,
): Promise<void> {
  setNoStore(res);
  const session = await authorizedSession(req, res, allowed);
  if (!session) return;
  const { data, error } = await callFinanceRpc(session, functionName, args);
  if (error) {
    mapFinanceError(res, error);
    return;
  }
  res.status(status).json(data);
}

function queryValue(req: Request, key: string, maxLength = 120): string | null | undefined {
  const value = req.query[key];
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length > maxLength) return undefined;
  return value;
}

function pageValue(req: Request, key: "page" | "pageSize", fallback: number, max: number): number | null {
  const value = req.query[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : null;
}

function queryId(req: Request, key: string): string | null | undefined {
  const value = req.query[key];
  if (value === undefined) return null;
  return typeof value === "string" && validId(value) ? value : undefined;
}

router.get("/admin/finance/summary", (req, res) =>
  runRpc(req, res, "petro_finance_admin_summary", undefined, READ_ROLES));

router.get("/admin/finance/organizations", async (req, res): Promise<void> => {
  const search = queryValue(req, "search");
  const page = pageValue(req, "page", 1, 100000);
  const pageSize = pageValue(req, "pageSize", 20, 100);
  if (search === undefined || page === null || pageSize === null) { fail(res, 400, "مرشحات البحث أو الصفحة غير صالحة."); return; }
  await runRpc(req, res, "petro_finance_admin_organizations", {
    p_search: search, p_page: page, p_page_size: pageSize,
  }, SUBMIT_ROLES);
});

router.get("/admin/finance/accounts", async (req, res): Promise<void> => {
  const search = queryValue(req, "search");
  const page = pageValue(req, "page", 1, 100000);
  const pageSize = pageValue(req, "pageSize", 20, 100);
  if (search === undefined || page === null || pageSize === null) { fail(res, 400, "مرشحات البحث أو الصفحة غير صالحة."); return; }
  await runRpc(req, res, "petro_finance_admin_accounts", {
    p_search: search, p_page: page, p_page_size: pageSize,
  }, READ_ROLES);
});

router.get("/admin/finance/organization-accounts", async (req, res): Promise<void> => {
  setNoStore(res);
  const rawOrganizationId = queryValue(req, "organizationId", 64);
  const organizationId = typeof rawOrganizationId === "string" && validId(rawOrganizationId)
    ? rawOrganizationId
    : undefined;
  const page = pageValue(req, "page", 1, 100000);
  const pageSize = pageValue(req, "pageSize", 10, 100);
  if (!organizationId || page === null || pageSize === null) {
    fail(res, 400, "معرّف الجهة أو خيارات عرض الحسابات غير صالحة.");
    return;
  }
  const session = await authorizedSession(req, res, READ_ROLES);
  if (!session) return;
  const { data: organization, error: organizationError } = await session.supabase
    .from("petro_organizations")
    .select("id,name,code")
    .eq("id", organizationId)
    .maybeSingle();
  if (organizationError) {
    mapFinanceError(res, organizationError);
    return;
  }
  if (!isRecord(organization) || organization["id"] !== organizationId) {
    fail(res, 404, "لم يتم العثور على الجهة المطلوبة.");
    return;
  }

  const search = typeof organization["code"] === "string" && organization["code"].trim()
    ? organization["code"].trim()
    : String(organization["name"] ?? "");
  const accounts: Record<string, unknown>[] = [];
  let totalPages = 1;
  for (let rpcPage = 1; rpcPage <= totalPages; rpcPage += 1) {
    if (rpcPage > 1000) {
      fail(res, 413, "يتجاوز عدد الحسابات حد العرض الآمن. استخدم كشف الحساب المفصل.");
      return;
    }
    const { data, error } = await callFinanceRpc(session, "petro_finance_admin_accounts", {
      p_search: search,
      p_page: rpcPage,
      p_page_size: 100,
    });
    if (error) {
      mapFinanceError(res, error);
      return;
    }
    if (!isRecord(data) || !Array.isArray(data["items"])) {
      fail(res, 503, "تعذر قراءة حسابات الجهة من الدفتر المالي.");
      return;
    }
    const scoped = data["items"].filter((item): item is Record<string, unknown> =>
      isRecord(item) && item["organizationId"] === organizationId
    );
    accounts.push(...scoped);
    const reportedPages = Number(data["totalPages"] ?? 1);
    totalPages = Number.isSafeInteger(reportedPages) && reportedPages >= 1 ? reportedPages : 1;
  }

  const sumMinor = (key: string): string | null => {
    let total = 0n;
    for (const account of accounts) {
      const amount = account[key];
      const normalized = typeof amount === "number" ? String(amount) : amount;
      if (typeof normalized !== "string" || !/^-?\d+$/.test(normalized)) return null;
      total += BigInt(normalized);
    }
    return total.toString();
  };
  const ledgerBalanceMinor = sumMinor("ledgerBalanceMinor");
  const reservedMinor = sumMinor("reservedMinor");
  const availableMinor = sumMinor("availableMinor");
  if (ledgerBalanceMinor === null || reservedMinor === null || availableMinor === null) {
    fail(res, 503, "تعذر مطابقة أرصدة الجهة مع دفترها.");
    return;
  }
  const offset = (page - 1) * pageSize;
  res.json({
    organizationId,
    accountState: accounts.length ? "available" : "missing",
    balancesMinor: { ledgerBalanceMinor, reservedMinor, availableMinor },
    items: accounts.slice(offset, offset + pageSize),
    page,
    pageSize,
    total: accounts.length,
    totalPages: Math.ceil(accounts.length / pageSize),
  });
});

router.get("/admin/finance/bank-accounts", (req, res) =>
  runRpc(req, res, "petro_finance_admin_bank_accounts", undefined, READ_ROLES));

router.post("/admin/finance/bank-accounts", async (req, res): Promise<void> => {
  const body = parseBody(CreateAdminFinanceBankAccountBody, req.body);
  if (!body) { fail(res, 400, "بيانات حساب الاستقبال غير صالحة."); return; }
  await runRpc(req, res, "petro_finance_admin_add_bank_account", {
    p_bank_name: body.bankName, p_display_label: body.displayLabel,
    p_account_last4: body.accountLast4, p_reason: body.reason,
    p_idempotency_key: body.idempotencyKey,
  }, MUTATE_ROLES, 201);
});

router.post("/admin/finance/bank-accounts/:bankAccountId/approve", async (req, res): Promise<void> => {
  if (!validId(req.params["bankAccountId"])) { fail(res, 400, "معرّف الحساب غير صالح."); return; }
  const body = parseBody(ApproveAdminFinanceBankAccountBody, req.body);
  if (!body) { fail(res, 400, "سبب الاعتماد أو مفتاح التكرار غير صالح."); return; }
  await runRpc(req, res, "petro_finance_admin_approve_bank_account", {
    p_bank_account_id: req.params["bankAccountId"], p_reason: body.reason,
    p_idempotency_key: body.idempotencyKey,
  }, MUTATE_ROLES);
});

router.post("/admin/finance/bank-accounts/:bankAccountId/disable", async (req, res): Promise<void> => {
  if (!validId(req.params["bankAccountId"])) { fail(res, 400, "معرّف الحساب غير صالح."); return; }
  const body = parseBody(DisableAdminFinanceBankAccountBody, req.body);
  if (!body) { fail(res, 400, "سبب الإيقاف أو مفتاح التكرار غير صالح."); return; }
  await runRpc(req, res, "petro_finance_admin_disable_bank_account", {
    p_bank_account_id: req.params["bankAccountId"], p_reason: body.reason,
    p_idempotency_key: body.idempotencyKey,
  }, MUTATE_ROLES);
});

router.get("/admin/finance/topups", async (req, res): Promise<void> => {
  const search = queryValue(req, "search");
  const status = queryValue(req, "status", 40);
  const page = pageValue(req, "page", 1, 100000);
  const pageSize = pageValue(req, "pageSize", 20, 100);
  if (search === undefined || status === undefined || page === null || pageSize === null) { fail(res, 400, "مرشحات طلبات الشحن غير صالحة."); return; }
  await runRpc(req, res, "petro_finance_admin_list_topups", {
    p_status: status, p_search: search, p_page: page, p_page_size: pageSize,
  }, [...READ_ROLES, "operations"]);
});

router.get("/admin/finance/topups/:topupId", async (req, res): Promise<void> => {
  if (!validId(req.params["topupId"])) { fail(res, 400, "معرّف طلب الشحن غير صالح."); return; }
  await runRpc(req, res, "petro_finance_admin_topup_detail", {
    p_topup_id: req.params["topupId"],
  }, [...READ_ROLES, "operations"]);
});

router.post("/admin/finance/topups", async (req, res): Promise<void> => {
  const body = parseBody(CreateAdminFinanceTopupBody, req.body);
  if (!body) { fail(res, 400, "بيانات طلب الشحن غير صالحة."); return; }
  await runRpc(req, res, "petro_finance_admin_create_topup", {
    p_organization_id: body.organizationId, p_amount_minor: body.amountMinor,
    p_payer_bank_name: body.payerBankName, p_bank_reference: body.bankReference,
    p_reason: body.reason, p_idempotency_key: body.idempotencyKey,
  }, SUBMIT_ROLES, 201);
});

router.patch("/admin/finance/topups/:topupId", async (req, res): Promise<void> => {
  if (!validId(req.params["topupId"])) { fail(res, 400, "معرّف طلب الشحن غير صالح."); return; }
  const body = parseBody(UpdateAdminFinanceTopupBody, req.body);
  if (!body) { fail(res, 400, "بيانات تعديل طلب الشحن غير صالحة."); return; }
  await runRpc(req, res, "petro_finance_admin_update_topup", {
    p_topup_id: req.params["topupId"], p_expected_version: body.expectedVersion,
    p_amount_minor: body.amountMinor, p_payer_bank_name: body.payerBankName,
    p_bank_reference: body.bankReference, p_reason: body.reason,
    p_idempotency_key: body.idempotencyKey,
  }, SUBMIT_ROLES);
});

router.post("/admin/finance/topups/:topupId/submit", async (req, res): Promise<void> => {
  if (!validId(req.params["topupId"])) { fail(res, 400, "معرّف طلب الشحن غير صالح."); return; }
  const body = parseBody(SubmitAdminFinanceTopupBody, req.body);
  if (!body) { fail(res, 400, "بيانات الإرسال غير صالحة."); return; }
  await runRpc(req, res, "petro_finance_admin_submit_topup", {
    p_topup_id: req.params["topupId"], p_expected_version: body.expectedVersion,
    p_reason: body.reason, p_idempotency_key: body.idempotencyKey,
  }, SUBMIT_ROLES);
});

router.post("/admin/finance/topups/:topupId/review", async (req, res): Promise<void> => {
  if (!validId(req.params["topupId"])) { fail(res, 400, "معرّف طلب الشحن غير صالح."); return; }
  const body = parseBody(ReviewAdminFinanceTopupBody, req.body);
  if (!body) { fail(res, 400, "قرار أو سبب المراجعة غير صالح."); return; }
  await runRpc(req, res, "petro_finance_admin_review_topup", {
    p_topup_id: req.params["topupId"], p_expected_version: body.expectedVersion,
    p_decision: body.decision, p_reason: body.reason,
    p_idempotency_key: body.idempotencyKey,
  }, MUTATE_ROLES);
});

router.post("/admin/finance/topups/:topupId/approve", async (req, res): Promise<void> => {
  if (!validId(req.params["topupId"])) { fail(res, 400, "معرّف طلب الشحن غير صالح."); return; }
  const body = parseBody(ApproveAdminFinanceTopupBody, req.body);
  if (!body) { fail(res, 400, "بيانات مطابقة التحويل غير صالحة."); return; }
  await runRpc(req, res, "petro_finance_admin_approve_topup", {
    p_topup_id: req.params["topupId"], p_bank_account_id: body.bankAccountId,
    p_actual_amount_minor: body.actualAmountMinor,
    p_allocation_amount_minor: body.allocationAmountMinor ?? null,
    p_reason: body.reason, p_confirmed_against_bank: body.confirmedAgainstBank,
    p_idempotency_key: body.idempotencyKey,
  }, MUTATE_ROLES);
});

router.get("/admin/finance/receipts", async (req, res): Promise<void> => {
  const search = queryValue(req, "search");
  const page = pageValue(req, "page", 1, 100000);
  const pageSize = pageValue(req, "pageSize", 20, 100);
  if (search === undefined || page === null || pageSize === null) { fail(res, 400, "مرشحات الإيصالات غير صالحة."); return; }
  await runRpc(req, res, "petro_finance_admin_list_receipts", {
    p_search: search, p_page: page, p_page_size: pageSize,
  }, READ_ROLES);
});

router.get("/admin/finance/receipts/:receiptId", (req, res) => {
  if (!validId(req.params["receiptId"])) { fail(res, 400, "معرّف الإيصال غير صالح."); return; }
  return runRpc(req, res, "petro_finance_admin_receipt_detail", {
    p_receipt_id: req.params["receiptId"],
  }, READ_ROLES);
});

router.post("/admin/finance/receipts", async (req, res): Promise<void> => {
  const body = parseBody(RecordAdminFinanceReceiptBody, req.body);
  if (!body) { fail(res, 400, "بيانات إثبات القبض غير صالحة."); return; }
  await runRpc(req, res, "petro_finance_admin_record_receipt", {
    p_organization_id: body.organizationId, p_branch_id: body.branchId ?? null,
    p_receiving_bank_account_id: body.bankAccountId, p_payer_bank_name: body.payerBankName,
    p_bank_reference: body.bankReference, p_amount_minor: body.amountMinor,
    p_reason: body.reason, p_confirmed_against_bank: body.confirmedAgainstBank,
    p_idempotency_key: body.idempotencyKey,
  }, MUTATE_ROLES, 201);
});

router.post("/admin/finance/receipts/:receiptId/allocate", async (req, res): Promise<void> => {
  if (!validId(req.params["receiptId"])) { fail(res, 400, "معرّف الإيصال غير صالح."); return; }
  const body = parseBody(AllocateAdminFinanceReceiptBody, req.body);
  if (!body) { fail(res, 400, "بيانات تخصيص الإيصال غير صالحة."); return; }
  await runRpc(req, res, "petro_finance_admin_allocate_receipt", {
    p_receipt_id: req.params["receiptId"], p_target_type: body.targetType,
    p_target_id: body.targetId, p_amount_minor: body.amountMinor,
    p_reason: body.reason, p_idempotency_key: body.idempotencyKey,
  }, MUTATE_ROLES);
});

router.get("/admin/finance/transfers", async (req, res): Promise<void> => {
  const organizationId = queryId(req, "organizationId");
  const page = pageValue(req, "page", 1, 100000);
  const pageSize = pageValue(req, "pageSize", 20, 100);
  if (organizationId === undefined || page === null || pageSize === null) { fail(res, 400, "مرشحات التحويل غير صالحة."); return; }
  await runRpc(req, res, "petro_finance_admin_list_transfers", {
    p_organization_id: organizationId, p_page: page, p_page_size: pageSize,
  }, READ_ROLES);
});

router.post("/admin/finance/transfers", async (req, res): Promise<void> => {
  const body = parseBody(CreateAdminFinanceTransferBody, req.body);
  if (!body) { fail(res, 400, "بيانات التحويل الداخلي غير صالحة."); return; }
  await runRpc(req, res, "petro_finance_admin_transfer", {
    p_organization_id: body.organizationId, p_source_branch_id: body.sourceBranchId ?? null,
    p_target_branch_id: body.targetBranchId ?? null, p_amount_minor: body.amountMinor,
    p_reference: body.reference, p_reason: body.reason,
    p_idempotency_key: body.idempotencyKey,
  }, MUTATE_ROLES, 201);
});

router.get("/admin/finance/subscriptions", async (req, res): Promise<void> => {
  const search = queryValue(req, "search");
  const status = queryValue(req, "status", 40);
  const page = pageValue(req, "page", 1, 100000);
  const pageSize = pageValue(req, "pageSize", 20, 100);
  if (search === undefined || status === undefined || page === null || pageSize === null) { fail(res, 400, "مرشحات الاشتراكات غير صالحة."); return; }
  await runRpc(req, res, "petro_finance_admin_list_subscriptions", {
    p_search: search, p_status: status, p_page: page, p_page_size: pageSize,
  }, READ_ROLES);
});

router.get("/admin/finance/journal", async (req, res): Promise<void> => {
  const organizationId = queryId(req, "organizationId");
  const accountId = queryId(req, "accountId");
  const entryType = queryValue(req, "entryType", 40);
  const search = queryValue(req, "search");
  const page = pageValue(req, "page", 1, 100000);
  const pageSize = pageValue(req, "pageSize", 20, 100);
  if (organizationId === undefined || accountId === undefined || entryType === undefined
      || search === undefined || page === null || pageSize === null) {
    fail(res, 400, "مرشحات دفتر القيود غير صالحة."); return;
  }
  await runRpc(req, res, "petro_finance_admin_list_journal", {
    p_organization_id: organizationId, p_account_id: accountId, p_entry_type: entryType,
    p_search: search, p_page: page, p_page_size: pageSize,
  }, READ_ROLES);
});

router.get("/admin/finance/journal/:entryId", async (req, res): Promise<void> => {
  if (!validId(req.params["entryId"])) { fail(res, 400, "معرّف القيد غير صالح."); return; }
  await runRpc(req, res, "petro_finance_admin_journal_detail", {
    p_entry_id: req.params["entryId"],
  }, READ_ROLES);
});

router.post("/admin/finance/journal/:entryId/reverse", async (req, res): Promise<void> => {
  if (!validId(req.params["entryId"])) { fail(res, 400, "معرّف القيد غير صالح."); return; }
  const body = parseBody(ReverseAdminFinanceJournalEntryBody, req.body);
  if (!body) { fail(res, 400, "سبب القيد العكسي أو مفتاح التكرار غير صالح."); return; }
  await runRpc(req, res, "petro_finance_admin_reverse_journal", {
    p_entry_id: req.params["entryId"], p_reason: body.reason,
    p_idempotency_key: body.idempotencyKey,
  }, MUTATE_ROLES);
});

router.get("/admin/finance/reconciliation", (req, res) =>
  runRpc(req, res, "petro_finance_admin_reconciliation", undefined, READ_ROLES));

// Same scoped RPC for central and merchant roles; never require an active subscription to read earned money.
router.get("/finance/merchant-statement", async(req,res):Promise<void>=>{
 setNoStore(res);
 const session=await requireSession(req,res);if(!session)return;
 if(Object.keys(req.query).some(k=>!["organizationId","branchId","page"].includes(k))){fail(res,400,"مرشحات كشف المستحقات غير صالحة.");return;}
 const organizationId=queryId(req,"organizationId"),branchId=queryId(req,"branchId"),page=pageValue(req,"page",1,100000);
 if(organizationId===undefined||branchId===undefined||(organizationId!==null&&!validId(organizationId))||(branchId!==null&&!validId(branchId))||page===null){
 fail(res,400,"اختر جهة وفرعًا صحيحين وصفحة صالحة.");return;}
 const {data,error}=await callFinanceRpc(session,"petro_merchant_statement",{p_organization_id:organizationId,p_branch_id:branchId,p_page:page});
 if(error){mapFinanceError(res,error);return;}res.json(data);
});


function withdrawalError(res:Response,error:{code?:string;message?:string}):void{
 const messages:Record<string,string>={FORBIDDEN_WITHDRAWAL:"هذه المساحة متاحة لمالية الجهة أو مديرها على مستوى الجهة، ومالية المنصة.",WITHDRAWAL_BANK_CHANGED:"تغير اعتماد الحساب البنكي؛ راجع البنك وأنشئ طلبًا بالنسخة المعتمدة.",WITHDRAWAL_NO_ELIGIBLE_REMAINDER:"المستحق لم يحِن موعده أو أصبح محجوزًا أو مستردًا. حدّث الكشف.",WITHDRAWAL_VERSION_CONFLICT:"تغير الطلب؛ حدّث البيانات قبل المتابعة.",WITHDRAWAL_REFUND_PENDING:"يوجد طلب استرداد مفتوح على هذه المستحقات. يلزم حسمه قبل الاعتماد.",INVALID_WITHDRAWAL:"راجع الحساب والمستحقات المحددة ومرجع المحاولة."};
 if(Object.hasOwn(messages,error.message??"")){res.status(error.code==="42501"?403:error.code==="22023"?400:409).json({message:messages[error.message!]});return;}mapFinanceError(res,error);
}
router.get("/finance/merchant-withdrawals/:organizationId",async(req,res):Promise<void>=>{
 setNoStore(res);const session=await requireSession(req,res);if(!session)return;
 const page=pageValue(req,"page",1,100000);
 if(!validId(req.params["organizationId"])||page===null||Object.keys(req.query).some(k=>k!=="page")){fail(res,400,"مرشحات السحب غير صالحة.");return;}
 const {data,error}=await callFinanceRpc(session,"petro_merchant_withdrawals",{p_organization_id:req.params["organizationId"],p_page:page});if(error){withdrawalError(res,error);return;}res.json(data);
});
router.get("/finance/merchant-withdrawals/:organizationId/options",async(req,res):Promise<void>=>{
 setNoStore(res);const session=await requireSession(req,res);if(!session)return;
 const page=pageValue(req,"page",1,100000);
 if(!validId(req.params["organizationId"])||page===null||Object.keys(req.query).some(k=>k!=="page")){fail(res,400,"مرشحات المستحقات غير صالحة.");return;}
 const {data,error}=await callFinanceRpc(session,"petro_merchant_withdrawal_options",{p_organization_id:req.params["organizationId"],p_page:page});if(error){withdrawalError(res,error);return;}res.json(data);
});
router.post("/finance/merchant-withdrawals/:organizationId",async(req,res):Promise<void>=>{
 setNoStore(res);const session=await requireSession(req,res);if(!session)return;
 const b=req.body;
 if(!validId(req.params["organizationId"])||!isRecord(b)||Object.keys(b).some(k=>!["bankVersionId","paymentIds","idempotencyKey"].includes(k))
 ||typeof b["bankVersionId"]!=="string"||!validId(b["bankVersionId"])||!Array.isArray(b["paymentIds"])||b["paymentIds"].length<1||b["paymentIds"].length>100||b["paymentIds"].some(x=>typeof x!=="string"||!validId(x))
 ||typeof b["idempotencyKey"]!=="string"||!/^[A-Za-z0-9._:-]{16,120}$/.test(b["idempotencyKey"])){fail(res,400,"اختر الحساب والمستحقات دون إدخال مبالغ أو حقول إضافية.");return;}
 const {data,error}=await callFinanceRpc(session,"petro_submit_merchant_withdrawal",{p_organization_id:req.params["organizationId"],p_bank_version_id:b["bankVersionId"],p_payment_ids:b["paymentIds"],p_request_key:b["idempotencyKey"]});if(error){withdrawalError(res,error);return;}res.status(201).json(data);
});
router.post("/finance/merchant-withdrawals/:id/review",async(req,res):Promise<void>=>{
 setNoStore(res);const session=await requireSession(req,res);if(!session)return;const b=req.body;
 if(!validId(req.params["id"])||!isRecord(b)||Object.keys(b).some(k=>!["expectedVersion","action","idempotencyKey"].includes(k))
 ||typeof b["expectedVersion"]!=="number"||!Number.isSafeInteger(b["expectedVersion"])||b["expectedVersion"]<1||typeof b["action"]!=="string"||!["approve","reject","cancel"].includes(b["action"])
 ||typeof b["idempotencyKey"]!=="string"||!/^[A-Za-z0-9._:-]{16,120}$/.test(b["idempotencyKey"])){fail(res,400,"قرار السحب أو نسخة الطلب غير صالح.");return;}
 const {data,error}=await callFinanceRpc(session,"petro_review_merchant_withdrawal",{p_id:req.params["id"],p_expected_version:b["expectedVersion"],p_action:b["action"],p_request_key:b["idempotencyKey"]});if(error){withdrawalError(res,error);return;}res.json(data);
});


const payoutProofTypes=["application/pdf","image/png","image/jpeg"];
function proofMagic(type:string,bytes:Buffer):boolean{
 return type==="application/pdf"?bytes.length>=5&&bytes.subarray(0,5).toString("ascii")==="%PDF-":type==="image/png"?bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):type==="image/jpeg"&&bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
}
function proofError(res:Response,error:{code?:string;message?:string}):void{
 const labels:Record<string,string>={FORBIDDEN_PAYOUT_PROOF:"لا تملك صلاحية هذا الإثبات الخاص.",INVALID_PAYOUT_PROOF:"راجع الملف ونسخة الطلب ومرجع المحاولة.",PAYOUT_PROOF_VERSION_CONFLICT:"تغير اعتماد الطلب أو البنك؛ حدّث الطلب قبل رفع إثبات جديد.",PAYOUT_PROOF_CONTENT_CONFLICT:"الإثبات المقبول يحوي ملفًا مختلفًا ولا يمكن استبداله.",PAYOUT_PROOF_UPLOAD_UNVERIFIED:"لم يثبت حفظ الملف بحجمه ونوعه وهوية رافعه.",PAYOUT_PROOF_LIMIT:"وصل الطلب إلى الحد المسموح من محاولات الإثبات."};
 if(Object.hasOwn(labels,error.message??"")){res.status(error.code==="42501"?403:error.code==="22023"?400:409).json({message:labels[error.message!]});return;}mapFinanceError(res,error);
}
router.get("/finance/merchant-withdrawals/:id/proofs",async(req,res):Promise<void>=>{
 setNoStore(res);const session=await requireSession(req,res);if(!session)return;
 if(!validId(req.params["id"])||Object.keys(req.query).length){fail(res,400,"مرجع الطلب غير صالح.");return;}
 const r=await callFinanceRpc(session,"petro_merchant_payout_proofs",{p_withdrawal_id:req.params["id"]});if(r.error){proofError(res,r.error);return;}res.json(r.data);
});
router.post("/finance/merchant-withdrawals/:id/proofs",async(req,res):Promise<void>=>{
 setNoStore(res);const session=await requireSession(req,res);if(!session)return;const b=req.body;
 if(!validId(req.params["id"])||!isRecord(b)||Object.keys(b).some(k=>!["expectedVersion","fileName","contentType","byteSize","idempotencyKey"].includes(k))
 ||typeof b["expectedVersion"]!=="number"||!Number.isSafeInteger(b["expectedVersion"])||b["expectedVersion"]<1
 ||typeof b["fileName"]!=="string"||b["fileName"].trim().length<1||b["fileName"].length>160||typeof b["contentType"]!=="string"||!payoutProofTypes.includes(b["contentType"])
 ||typeof b["byteSize"]!=="number"||!Number.isSafeInteger(b["byteSize"])||b["byteSize"]<1||b["byteSize"]>10485760
 ||typeof b["idempotencyKey"]!=="string"||!/^[A-Za-z0-9._:-]{16,120}$/.test(b["idempotencyKey"])){fail(res,400,"اختر PDF أو PNG أو JPEG حتى10 ميجابايت مع نسخة الطلب.");return;}
 const r=await callFinanceRpc(session,"petro_create_merchant_payout_proof",{p_withdrawal_id:req.params["id"],p_expected_version:b["expectedVersion"],p_file_name:b["fileName"],p_content_type:b["contentType"],p_byte_size:b["byteSize"],p_request_key:b["idempotencyKey"]});if(r.error){proofError(res,r.error);return;}res.status(201).json(r.data);
});
router.put("/finance/merchant-payout-proofs/:id/content",raw({type:"application/octet-stream",limit:"10mb"}),async(req,res):Promise<void>=>{
 setNoStore(res);const session=await requireSession(req,res);if(!session)return;
 if(!validId(req.params["id"])||!Buffer.isBuffer(req.body)){fail(res,400,"محتوى الملف غير صالح.");return;}
 const r=await callFinanceRpc(session,"petro_merchant_payout_proof_file",{p_id:req.params["id"],p_action:"read"});if(r.error){proofError(res,r.error);return;}
 const d=r.data;
 if(!isRecord(d)||d["bucket"]!=="petro-private-documents"||typeof d["objectPath"]!=="string"||typeof d["contentType"]!=="string"){fail(res,502,"تعذر التحقق من مرجع الملف.");return;}
 const bytes=req.body as Buffer;if(bytes.length!==Number(d["byteSize"])||!proofMagic(d["contentType"],bytes)){fail(res,400,"محتوى الملف أو حجمه لا يطابق طلب الرفع.");return;}
 const bucket=session.supabase.storage.from("petro-private-documents");let exists=d["status"]==="accepted";
 if(!exists){
 const permit=await callFinanceRpc(session,"petro_merchant_payout_proof_file",{p_id:req.params["id"],p_action:"upload"});if(permit.error){proofError(res,permit.error);return;}
 const upload=await bucket.upload(d["objectPath"],bytes,{contentType:d["contentType"],upsert:false,cacheControl:"0"});
 if(upload.error){const status=String((upload.error as unknown as {statusCode?:string}).statusCode??"");if(status==="409"||status==="400"&&/already exists|Duplicate/i.test(upload.error.message))exists=true;else{fail(res,503,"تعذر تأكيد حفظ الملف؛ أعد رفع الملف نفسه.");return;}}
 }
 const stored=await bucket.download(d["objectPath"]);if(stored.error||!stored.data){fail(res,503,"تعذر قراءة الملف المحفوظ للتحقق منه.");return;}
 const saved=Buffer.from(await stored.data.arrayBuffer());if(!saved.equals(bytes)){fail(res,409,"الملف المحفوظ مختلف؛ لا يمكن استبدال إثبات سابق.");return;}
 const digest=createHash("sha256").update(saved).digest("hex");
 const accepted=await callFinanceRpc(session,"petro_accept_merchant_payout_proof",{p_id:req.params["id"],p_sha256:digest,p_request_key:"accept-payout-proof:"+req.params["id"]});if(accepted.error){proofError(res,accepted.error);return;}res.json(accepted.data);
});
router.get("/finance/merchant-payout-proofs/:id/download",async(req,res):Promise<void>=>{
 setNoStore(res);const session=await requireSession(req,res);if(!session)return;
 if(!validId(req.params["id"])||Object.keys(req.query).length){fail(res,400,"مرجع الملف غير صالح.");return;}
 const r=await callFinanceRpc(session,"petro_merchant_payout_proof_file",{p_id:req.params["id"],p_action:"read"});if(r.error){proofError(res,r.error);return;}const d=r.data;
 if(!isRecord(d)||d["status"]!=="accepted"||typeof d["objectPath"]!=="string"){fail(res,409,"لم يكتمل رفع الإثبات.");return;}
 const signed=await session.supabase.storage.from("petro-private-documents").createSignedUrl(d["objectPath"],60);
 if(signed.error||!signed.data?.signedUrl){fail(res,503,"تعذر فتح الإثبات الخاص؛ أعد المحاولة.");return;}res.json({url:signed.data.signedUrl,expiresInSeconds:60});
});


router.get("/finance/merchant-payout-proofs/:id/content",async(req,res):Promise<void>=>{
 setNoStore(res);const session=await requireSession(req,res);if(!session)return;
 if(!validId(req.params["id"])||Object.keys(req.query).length){fail(res,400,"مرجع الإثبات غير صالح.");return;}
 const r=await callFinanceRpc(session,"petro_merchant_payout_proof_file",{p_id:req.params["id"],p_action:"read"});if(r.error){proofError(res,r.error);return;}const d=r.data;
 if(!isRecord(d)||d["status"]!=="accepted"||typeof d["objectPath"]!=="string"||typeof d["contentType"]!=="string"||typeof d["fileName"]!=="string"){fail(res,409,"لم يكتمل قبول الملف.");return;}
 const stored=await session.supabase.storage.from("petro-private-documents").download(d["objectPath"]);
 if(stored.error||!stored.data){fail(res,503,"تعذر تنزيل الإثبات الخاص.");return;}const bytes=Buffer.from(await stored.data.arrayBuffer());
 if(bytes.length!==Number(d["byteSize"])||!proofMagic(d["contentType"],bytes)){fail(res,409,"محتوى الإثبات المحفوظ يحتاج مراجعة.");return;}
 res.setHeader("Content-Type",d["contentType"]);res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("Content-Disposition","attachment; filename*=UTF-8''"+encodeURIComponent(d["fileName"]));res.send(bytes);
});

export default router;
