import { Router, type IRouter, type Request, type Response } from "express";
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
  } else if (["23505", "23514", "40001", "55000"].includes(error.code ?? "")) {
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

export default router;
