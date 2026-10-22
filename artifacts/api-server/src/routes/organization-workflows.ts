import { createHash } from "node:crypto";
import { basename } from "node:path";
import { Router, type IRouter, type Request, type Response, raw } from "express";
import {
  CreateDocumentUploadIntentBody,
  CreateOrganizationChangeRequestBody,
  CreateOrganizationJoinRequestBody,
  DecideAdminOrganizationRequestBody,
  ListOrganizationChangeRequestsQueryParams,
  ListOrganizationJoinRequestsQueryParams,
  ProposeOrganizationBankAccountBody,
  ResubmitOrganizationChangeRequestBody,
  UpdateOrganizationJoinRequestBody,
} from "@workspace/api-zod";
import { requireSession, type SessionContext } from "./management";
import { isRecord, setNoStore } from "../lib/supabaseServer";

const router: IRouter = Router();
const BUCKET = "petro-private-documents";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRIVATE_DOCUMENT_SELECT =
  "id,uploader_id,organization_id,branch_id,join_request_id,change_request_id,bank_account_version_id,finance_topup_request_id,finance_subscription_request_id,finance_bank_receipt_id,document_type,file_name,content_type,byte_size,expires_on,status,uploaded_at,reviewed_by,reviewed_at,review_reason,version,created_at";
const BANK_VERSION_SELECT =
  "id,bank_account_id,organization_id,version,bank_name,beneficiary_name,account_last4,status,created_by,created_at,reviewed_by,reviewed_at,decision_reason";

type PlatformRole = "owner" | "operations" | "finance";

function fail(res: Response, status: number, message: string): void {
  res.status(status).json({ message });
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function mapWorkflowError(res: Response, error: { code?: string; message?: string } | null): void {
  if (error?.code === "42501" || error?.code === "PGRST301") {
    fail(res, 403, "ليست لديك صلاحية لهذا الإجراء.");
  } else if (error?.code === "23505" || error?.code === "40001" || error?.code === "55000") {
    const message = error.message?.includes("SENSITIVE_CHANGE_REQUIRES_REVIEW")
      ? "هذا الحقل يحتاج طلب مراجعة قبل التعديل."
      : "تغير الطلب أو السجل. حدّث الصفحة ثم أعد المحاولة.";
    fail(res, 409, message);
  } else if (error?.code === "P0002") {
    fail(res, 404, "لم يتم العثور على السجل المطلوب.");
  } else if (error?.code === "22023") {
    fail(res, 400, "البيانات أو حالة الطلب غير صالحة.");
  } else {
    fail(res, 400, "تعذر تنفيذ الطلب. تحقق من البيانات والصلاحيات.");
  }
}

async function platformRoles(session: SessionContext): Promise<Set<PlatformRole> | null> {
  const { data, error } = await session.supabase.rpc("petro_access_context");
  if (error || !isRecord(data)) return null;
  const rolesValue = data["platform_roles"] ?? data["platformRoles"];
  if (!Array.isArray(rolesValue)) return new Set();
  const roles = rolesValue.filter(
    (role): role is PlatformRole => role === "owner" || role === "operations" || role === "finance",
  );
  return new Set(roles);
}

async function requireCentral(
  req: Request,
  res: Response,
  allowedRoles: PlatformRole[],
): Promise<{ session: SessionContext; roles: Set<PlatformRole> } | null> {
  const session = await requireSession(req, res);
  if (!session) return null;
  const roles = await platformRoles(session);
  if (!roles) {
    fail(res, 503, "تعذر التحقق من صلاحيات الإدارة.");
    return null;
  }
  if (!allowedRoles.some((role) => roles.has(role))) {
    fail(res, 403, "ليست لديك صلاحية الوصول إلى طلبات الإدارة المركزية.");
    return null;
  }
  return { session, roles };
}

function parseBody<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T | null {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

function sanitizedFilename(input: string): string | null {
  const leaf = basename(input.replaceAll("\\", "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\p{L}\p{M}\p{N}._ -]/gu, "")
    .trim()
    .slice(0, 160);
  return leaf.length > 0 && leaf !== "." && leaf !== ".." ? leaf : null;
}

function fileSignatureMatches(mime: string, bytes: Buffer): boolean {
  if (mime === "image/png") {
    return bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      && bytes.subarray(12, 16).toString("ascii") === "IHDR";
  }
  if (mime === "image/jpeg") {
    return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  }
  if (mime === "application/pdf") {
    const header = bytes.subarray(0, 1024).toString("latin1");
    const trailer = bytes.subarray(Math.max(0, bytes.length - 2048)).toString("latin1");
    const content = bytes.toString("latin1");
    return header.includes("%PDF-") && trailer.includes("%%EOF")
      && !/\/(JavaScript|JS|Launch|EmbeddedFile|OpenAction|AA)\b/i.test(content);
  }
  return false;
}

function extensionMatches(mime: string, fileName: string): boolean {
  const lower = fileName.toLocaleLowerCase("en-US");
  return mime === "application/pdf" ? lower.endsWith(".pdf")
    : mime === "image/png" ? lower.endsWith(".png")
      : mime === "image/jpeg" ? /\.(jpe?g)$/.test(lower)
        : false;
}

function pickDocumentFields(doc: Record<string, unknown>): Record<string, unknown> {
  return {
    id: doc["id"],
    uploader_id: doc["uploader_id"],
    organization_id: doc["organization_id"],
    branch_id: doc["branch_id"],
    join_request_id: doc["join_request_id"],
    change_request_id: doc["change_request_id"],
    bank_account_version_id: doc["bank_account_version_id"],
    document_type: doc["document_type"],
    file_name: doc["file_name"],
    content_type: doc["content_type"],
    byte_size: doc["byte_size"],
    expires_on: doc["expires_on"],
    status: doc["status"],
    uploaded_at: doc["uploaded_at"],
    reviewed_by: doc["reviewed_by"],
    reviewed_at: doc["reviewed_at"],
    review_reason: doc["review_reason"],
    version: doc["version"],
    created_at: doc["created_at"],
  };
}

router.get("/organization-join-requests", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res, false);
  if (!session) return;
  const query = parseBody(ListOrganizationJoinRequestsQueryParams, req.query);
  if (!query) {
    fail(res, 400, "مرشح حالة الطلب غير صالح.");
    return;
  }
  let request = session.supabase
    .from("petro_org_join_requests")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);
  if (query.status) request = request.eq("status", query.status);
  const { data, error } = await request;
  if (error) {
    mapWorkflowError(res, error);
    return;
  }
  res.json({ items: data ?? [] });
});

router.post("/organization-join-requests", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res, false);
  if (!session) return;
  const body = parseBody(CreateOrganizationJoinRequestBody, req.body);
  if (!body) {
    fail(res, 400, "بيانات طلب الانضمام غير مكتملة أو غير صالحة.");
    return;
  }
  let applicantId: string | null = null;
  if (body.applicantUsername) {
    const roles = await platformRoles(session);
    if (!roles) {
      fail(res, 503, "تعذر التحقق من صلاحية إنشاء الطلب.");
      return;
    }
    if (!roles.has("owner") && !roles.has("operations")) {
      fail(res, 403, "إنشاء طلب نيابة عن مستخدم مخصص للإدارة المركزية المخولة.");
      return;
    }
    const { data: profile, error: profileError } = await session.supabase
      .from("petro_profiles")
      .select("user_id")
      .eq("username", body.applicantUsername.trim().toLowerCase())
      .maybeSingle();
    if (profileError) {
      fail(res, 503, "تعذر التحقق من حساب المستخدم المستفيد.");
      return;
    }
    if (!profile) {
      fail(res, 404, "تعذر العثور على حساب مؤهل بهذا الاسم.");
      return;
    }
    applicantId = profile.user_id;
  }
  const { data, error } = await session.supabase.rpc("petro_create_org_join_request", {
    p_applicant_id: applicantId,
    p_organization_data: body.organization,
    p_initial_branch_data: body.initialBranch,
  });
  if (error) {
    mapWorkflowError(res, error);
    return;
  }
  res.status(201).json({ id: data, message: "تم حفظ طلب الانضمام كمسودة. لم تُنشأ جهة أو عضوية بعد." });
});

router.get("/organization-join-requests/:requestId", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res, false);
  if (!session) return;
  const requestId = req.params["requestId"];
  if (!safeId(requestId)) {
    fail(res, 400, "معرّف الطلب غير صالح.");
    return;
  }
  const { data, error } = await session.supabase
    .from("petro_org_join_requests")
    .select("*")
    .eq("id", requestId)
    .maybeSingle();
  if (error) {
    mapWorkflowError(res, error);
    return;
  }
  if (!data) {
    fail(res, 404, "لم يتم العثور على الطلب.");
    return;
  }
  res.json(data);
});

router.patch("/organization-join-requests/:requestId", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res, false);
  if (!session) return;
  const requestId = req.params["requestId"];
  const body = parseBody(UpdateOrganizationJoinRequestBody, req.body);
  if (!safeId(requestId) || !body) {
    fail(res, 400, "بيانات تحديث الطلب غير صالحة.");
    return;
  }
  const { error } = await session.supabase.rpc("petro_update_org_join_request", {
    p_request_id: requestId,
    p_expected_version: body.expectedVersion,
    p_organization_data: body.organization,
    p_initial_branch_data: body.initialBranch,
  });
  if (error) {
    mapWorkflowError(res, error);
    return;
  }
  res.json({ message: "تم حفظ المسودة. أرسلها للمراجعة عند اكتمالها." });
});

router.get("/organization-join-requests/:requestId/documents", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res, false);
  if (!session) return;
  const requestId = req.params["requestId"];
  if (!safeId(requestId)) { fail(res, 400, "معرّف الطلب غير صالح."); return; }
  const { data, error } = await session.supabase.from("petro_documents")
    .select(PRIVATE_DOCUMENT_SELECT).eq("join_request_id", requestId)
    .order("created_at", { ascending: false }).limit(100);
  if (error) { mapWorkflowError(res, error); return; }
  res.json({ items: data ?? [] });
});

router.post("/organization-join-requests/:requestId/submit", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res, false);
  if (!session) return;
  const requestId = req.params["requestId"];
  const body = isRecord(req.body) && Number.isInteger(req.body["expectedVersion"])
    ? { expectedVersion: req.body["expectedVersion"] as number }
    : null;
  if (!safeId(requestId) || !body || body.expectedVersion < 1) {
    fail(res, 400, "إصدار الطلب غير صالح.");
    return;
  }
  const { error } = await session.supabase.rpc("petro_submit_org_join_request", {
    p_request_id: requestId,
    p_expected_version: body.expectedVersion,
  });
  if (error) {
    mapWorkflowError(res, error);
    return;
  }
  res.json({ message: "تم إرسال الطلب للمراجعة المركزية." });
});

router.post("/organization-join-requests/:requestId/withdraw", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res, false);
  if (!session) return;
  const requestId = req.params["requestId"];
  const expectedVersion = isRecord(req.body) ? req.body["expectedVersion"] : null;
  if (!safeId(requestId) || !Number.isInteger(expectedVersion) || Number(expectedVersion) < 1) {
    fail(res, 400, "إصدار الطلب غير صالح.");
    return;
  }
  const { error } = await session.supabase.rpc("petro_withdraw_org_join_request", {
    p_request_id: requestId,
    p_expected_version: Number(expectedVersion),
  });
  if (error) {
    mapWorkflowError(res, error);
    return;
  }
  res.status(204).end();
});

router.get("/admin/organization-requests", async (req, res): Promise<void> => {
  setNoStore(res);
  const access = await requireCentral(req, res, ["owner", "operations", "finance"]);
  if (!access) return;
  const requestType = req.query["requestType"];
  const status = req.query["status"];
  if (requestType !== undefined && !["join", "change", "bank", "document"].includes(String(requestType))) {
    fail(res, 400, "نوع الطلب غير صالح.");
    return;
  }
  if (status !== undefined && (typeof status !== "string" || status.length > 30)) {
    fail(res, 400, "حالة الطلب غير صالحة.");
    return;
  }
  const items: Record<string, unknown>[] = [];
  const want = (type: string) => requestType === undefined || requestType === type;
  if (want("join") && (access.roles.has("owner") || access.roles.has("operations"))) {
    let query = access.session.supabase.from("petro_org_join_requests")
      .select("id,applicant_id,status,version,created_at,organization_data,initial_branch_data,decision_reason")
      .order("created_at", { ascending: true }).limit(100);
    if (status) query = query.eq("status", status);
    else query = query.in("status", ["submitted", "needs_completion"]);
    const { data, error } = await query;
    if (error) { mapWorkflowError(res, error); return; }
    for (const row of data ?? []) items.push({
      id: row.id, requestType: "join", status: row.status, version: row.version, createdAt: row.created_at,
      applicantId: row.applicant_id, organizationId: null, branchId: null,
      title: isRecord(row.organization_data) ? String(row.organization_data["name"] ?? "طلب انضمام") : "طلب انضمام",
      summary: { organization: row.organization_data, initialBranch: row.initial_branch_data, decisionReason: row.decision_reason },
    });
  }
  if (want("change") && (access.roles.has("owner") || access.roles.has("operations"))) {
    let query = access.session.supabase.from("petro_org_change_requests")
      .select("id,organization_id,branch_id,target_type,applicant_id,status,version,created_at,current_snapshot,proposed_data,decision_reason")
      .order("created_at", { ascending: true }).limit(100);
    if (status) query = query.eq("status", status);
    else query = query.in("status", ["submitted", "needs_completion"]);
    const { data, error } = await query;
    if (error) { mapWorkflowError(res, error); return; }
    for (const row of data ?? []) items.push({
      id: row.id, requestType: "change", status: row.status, version: row.version, createdAt: row.created_at,
      applicantId: row.applicant_id, organizationId: row.organization_id, branchId: row.branch_id,
      title: row.target_type === "branch" ? "طلب تعديل فرع" : "طلب تعديل جهة",
      summary: { targetType: row.target_type, current: row.current_snapshot, proposed: row.proposed_data, decisionReason: row.decision_reason },
    });
  }
  if (want("bank") && (access.roles.has("owner") || access.roles.has("finance"))) {
    let query = access.session.supabase.from("petro_bank_account_versions")
      .select(BANK_VERSION_SELECT)
      .order("created_at", { ascending: true }).limit(100);
    if (status) query = query.eq("status", status);
    else query = query.in("status", ["pending", "needs_completion"]);
    const { data, error } = await query;
    if (error) { mapWorkflowError(res, error); return; }
    const accountIds = [...new Set((data ?? []).map((row) => row.bank_account_id))];
    const accountVersions = new Map<string, number>();
    if (accountIds.length > 0) {
      const { data: accounts, error: accountsError } = await access.session.supabase
        .from("petro_bank_accounts").select("id,version").in("id", accountIds);
      if (accountsError) { mapWorkflowError(res, accountsError); return; }
      for (const account of accounts ?? []) accountVersions.set(account.id, account.version);
    }
    for (const row of data ?? []) items.push({
      id: row.id, requestType: "bank", status: row.status, version: row.version, createdAt: row.created_at,
      applicantId: row.created_by, organizationId: row.organization_id, branchId: null,
      title: `مقترح حساب بنكي · آخر أرقام ${row.account_last4}`,
      summary: { bankAccountId: row.bank_account_id, accountVersion: accountVersions.get(row.bank_account_id), bankName: row.bank_name, beneficiaryName: row.beneficiary_name, accountLast4: row.account_last4, decisionReason: row.decision_reason },
    });
  }
  if (want("document") && (access.roles.has("owner") || access.roles.has("operations"))) {
    let query = access.session.supabase.from("petro_documents")
      .select(PRIVATE_DOCUMENT_SELECT)
      .order("created_at", { ascending: true }).limit(100);
    if (status) query = query.eq("status", status);
    else query = query.in("status", ["pending_review", "needs_completion"]);
    const { data, error } = await query;
    if (error) { mapWorkflowError(res, error); return; }
    for (const row of data ?? []) items.push({
      id: row.id, requestType: "document", status: row.status, version: row.version, createdAt: row.created_at,
      applicantId: row.uploader_id, organizationId: row.organization_id, branchId: row.branch_id,
      title: `مستند ${row.document_type}`,
      summary: { fileName: row.file_name, contentType: row.content_type, byteSize: row.byte_size, expiresOn: row.expires_on, reviewReason: row.review_reason },
    });
  }
  items.sort((a, b) => String(a["createdAt"]).localeCompare(String(b["createdAt"])));
  res.json({ items });
});

router.post("/admin/organization-requests/:requestType/:requestId/decision", async (req, res): Promise<void> => {
  setNoStore(res);
  const parsedParams = req.params["requestType"];
  const requestId = req.params["requestId"];
  const body = parseBody(DecideAdminOrganizationRequestBody, req.body);
  if (!["join", "change", "bank", "document"].includes(String(parsedParams)) || !safeId(requestId) || !body) {
    fail(res, 400, "بيانات القرار غير صالحة.");
    return;
  }
  const roleSet: PlatformRole[] = parsedParams === "bank" ? ["owner", "finance"] : ["owner", "operations"];
  const access = await requireCentral(req, res, roleSet);
  if (!access) return;
  if (parsedParams === "join") {
    const { data, error } = await access.session.supabase.rpc("petro_review_org_join_request", {
      p_request_id: requestId,
      p_expected_version: body.expectedVersion,
      p_action: body.action,
      p_reason: body.reason,
      p_link_organization_id: body.linkOrganizationId ?? null,
      p_link_branch_id: body.linkBranchId ?? null,
      p_link_role: body.membershipRole ?? null,
    });
    if (error) { mapWorkflowError(res, error); return; }
    res.json({ message: `تم تسجيل القرار: ${String(data?.status ?? body.action)}.` });
    return;
  }
  if (parsedParams === "change") {
    const { data, error } = await access.session.supabase.rpc("petro_review_org_change_request", {
      p_request_id: requestId, p_expected_request_version: body.expectedVersion,
      p_action: body.action, p_reason: body.reason,
    });
    if (error) { mapWorkflowError(res, error); return; }
    res.json({ message: data === "conflict" ? "لم يُطبق التعديل لأن السجل تغير بعد تقديم الطلب." : "تم تسجيل قرار المراجعة." });
    return;
  }
  if (parsedParams === "bank") {
    if (!Number.isInteger(body.expectedAccountVersion) || Number(body.expectedAccountVersion) < 0) {
      fail(res, 400, "إصدار الحساب البنكي مطلوب لاتخاذ القرار.");
      return;
    }
    const { data, error } = await access.session.supabase.rpc("petro_review_bank_account_version", {
      p_version_id: requestId, p_expected_request_version: body.expectedVersion,
      p_action: body.action, p_reason: body.reason,
      p_expected_account_version: body.expectedAccountVersion,
    });
    if (error) { mapWorkflowError(res, error); return; }
    res.json({ message: data === "conflict" ? "لم تُعتمد النسخة لأن الحساب تغير." : "تم تسجيل قرار مراجعة الحساب البنكي." });
    return;
  }
  const { data: doc, error: docError } = await access.session.supabase
    .from("petro_documents").select("version").eq("id", requestId).maybeSingle();
  if (docError || !doc || doc.version !== body.expectedVersion) {
    if (docError) mapWorkflowError(res, docError);
    else fail(res, 409, "تغير المستند. حدّث الصفحة ثم أعد المحاولة.");
    return;
  }
  const { error } = await access.session.supabase.rpc("petro_review_document", {
    p_document_id: requestId, p_expected_version: body.expectedVersion,
    p_action: body.action, p_reason: body.reason,
  });
  if (error) { mapWorkflowError(res, error); return; }
  res.json({ message: "تم تسجيل قرار المستند." });
});

router.get("/organization-change-requests", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const query = parseBody(ListOrganizationChangeRequestsQueryParams, req.query);
  if (!query) { fail(res, 400, "مرشحات الطلب غير صالحة."); return; }
  let request = session.supabase.from("petro_org_change_requests").select("*")
    .order("created_at", { ascending: false }).limit(100);
  if (query.organizationId) request = request.eq("organization_id", query.organizationId);
  if (query.branchId) request = request.eq("branch_id", query.branchId);
  const { data, error } = await request;
  if (error) { mapWorkflowError(res, error); return; }
  res.json({ items: data ?? [] });
});

router.post("/organization-change-requests", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const body = parseBody(CreateOrganizationChangeRequestBody, req.body);
  if (!body) { fail(res, 400, "بيانات طلب التعديل غير صالحة."); return; }
  const { data, error } = await session.supabase.rpc("petro_create_org_change_request", {
    p_organization_id: body.organizationId, p_branch_id: body.branchId ?? null,
    p_expected_entity_version: body.expectedEntityVersion, p_proposed_data: body.proposedData,
  });
  if (error) { mapWorkflowError(res, error); return; }
  res.status(201).json({ id: data, message: "تم تقديم التغيير للمراجعة. ستبقى البيانات المعتمدة كما هي حتى القرار." });
});

router.post("/organization-change-requests/:requestId/resubmit", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const requestId = req.params["requestId"];
  const body = parseBody(ResubmitOrganizationChangeRequestBody, req.body);
  if (!safeId(requestId) || !body) { fail(res, 400, "بيانات إعادة التقديم غير صالحة."); return; }
  const { error } = await session.supabase.rpc("petro_resubmit_org_change_request", {
    p_request_id: requestId, p_expected_request_version: body.expectedRequestVersion,
    p_proposed_data: body.proposedData,
  });
  if (error) { mapWorkflowError(res, error); return; }
  res.json({ message: "تم تحديث المقترح وإعادته للمراجعة." });
});

router.post("/organization-change-requests/:requestId/withdraw", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const requestId = req.params["requestId"];
  const expectedVersion = isRecord(req.body) ? req.body["expectedVersion"] : null;
  if (!safeId(requestId) || !Number.isInteger(expectedVersion) || Number(expectedVersion) < 1) {
    fail(res, 400, "إصدار الطلب غير صالح.");
    return;
  }
  const { error } = await session.supabase.rpc("petro_withdraw_org_change_request", {
    p_request_id: requestId, p_expected_version: Number(expectedVersion),
  });
  if (error) { mapWorkflowError(res, error); return; }
  res.status(204).end();
});

router.get("/organizations/:organizationId/bank-accounts", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const organizationId = req.params["organizationId"];
  if (!safeId(organizationId)) { fail(res, 400, "معرّف الجهة غير صالح."); return; }
  const { data, error } = await session.supabase.from("petro_bank_account_versions")
    .select(BANK_VERSION_SELECT).eq("organization_id", organizationId)
    .order("created_at", { ascending: false }).limit(100);
  if (error) { mapWorkflowError(res, error); return; }
  const accountIds = [...new Set((data ?? []).map((row) => row.bank_account_id))];
  const accountVersions = new Map<string, number>();
  if (accountIds.length > 0) {
    const { data: accounts, error: accountsError } = await session.supabase
      .from("petro_bank_accounts").select("id,version").in("id", accountIds);
    if (accountsError) { mapWorkflowError(res, accountsError); return; }
    for (const account of accounts ?? []) accountVersions.set(account.id, account.version);
  }
  if (accountIds.some((id) => !accountVersions.has(id))) {
    fail(res, 500, "تعذر تحميل إصدار الحساب البنكي. أعد المحاولة.");
    return;
  }
  res.json({ items: (data ?? []).map((row) => ({
    ...row, account_version: accountVersions.get(row.bank_account_id)!,
  })) });
});

router.post("/organizations/:organizationId/bank-accounts", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const organizationId = req.params["organizationId"];
  const body = parseBody(ProposeOrganizationBankAccountBody, req.body);
  if (!safeId(organizationId) || !body) { fail(res, 400, "بيانات الحساب البنكي غير صالحة."); return; }
  const { data, error } = await session.supabase.rpc("petro_propose_bank_account_version", {
    p_organization_id: organizationId,
    p_bank_account_id: body.bankAccountId ?? null,
    p_expected_account_version: body.expectedAccountVersion ?? null,
    p_bank_name: body.bankName,
    p_beneficiary_name: body.beneficiaryName,
    p_account_identifier: body.accountIdentifier,
  });
  if (error) { mapWorkflowError(res, error); return; }
  if (!isRecord(data)) { fail(res, 503, "تعذر تأكيد حفظ المقترح."); return; }
  res.status(201).json({
    accountId: data["accountId"], versionId: data["versionId"], version: data["version"],
    status: "pending", accountLast4: data["last4"], message: "تم حفظ النسخة المقترحة. لم تصبح معتمدة بعد.",
  });
});

router.get("/bank-account-versions/:versionId", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const versionId = req.params["versionId"];
  if (!safeId(versionId)) { fail(res, 400, "معرّف النسخة غير صالح."); return; }
  const { data, error } = await session.supabase.rpc("petro_get_bank_account_version", { p_version_id: versionId });
  if (error) { mapWorkflowError(res, error); return; }
  res.json(data);
});

router.post("/bank-account-versions/:versionId/withdraw", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const versionId = req.params["versionId"];
  const expectedVersion = isRecord(req.body) ? req.body["expectedVersion"] : null;
  if (!safeId(versionId) || !Number.isInteger(expectedVersion) || Number(expectedVersion) < 1) {
    fail(res, 400, "إصدار النسخة غير صالح.");
    return;
  }
  const { error } = await session.supabase.rpc("petro_withdraw_bank_account_version", {
    p_version_id: versionId, p_expected_version: Number(expectedVersion),
  });
  if (error) { mapWorkflowError(res, error); return; }
  res.status(204).end();
});

router.get("/documents", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res, false);
  if (!session) return;
  const filterKeys = [
    "organizationId", "branchId", "joinRequestId", "changeRequestId", "bankVersionId",
    "topupRequestId", "subscriptionRequestId", "receiptId",
  ] as const;
  const filters: Array<[string, string]> = [];
  for (const key of filterKeys) {
    const value = req.query[key];
    if (value !== undefined) {
      if (typeof value !== "string" || !safeId(value)) { fail(res, 400, "مرشح المستندات غير صالح."); return; }
      filters.push([key, value]);
    }
  }
  if (filters.length === 0) {
    fail(res, 400, "حدد الجهة أو الفرع أو الطلب لعرض المستندات.");
    return;
  }
  const columnByKey: Record<string, string> = {
    organizationId: "organization_id", branchId: "branch_id", joinRequestId: "join_request_id",
    changeRequestId: "change_request_id", bankVersionId: "bank_account_version_id",
    topupRequestId: "finance_topup_request_id",
    subscriptionRequestId: "finance_subscription_request_id",
    receiptId: "finance_bank_receipt_id",
  };
  let query = session.supabase.from("petro_documents").select(PRIVATE_DOCUMENT_SELECT)
    .order("created_at", { ascending: false }).limit(100);
  for (const [key, value] of filters) query = query.eq(columnByKey[key]!, value);
  const { data, error } = await query;
  if (error) { mapWorkflowError(res, error); return; }
  res.json({ items: (data ?? []).map((row) => pickDocumentFields(row as Record<string, unknown>)) });
});

router.post("/documents", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res, false);
  if (!session) return;
  const body = parseBody(CreateDocumentUploadIntentBody, req.body);
  if (!body) { fail(res, 400, "بيانات المستند غير صالحة."); return; }
  const cleanName = sanitizedFilename(body.fileName);
  if (!cleanName || !extensionMatches(body.contentType, cleanName)) {
    fail(res, 400, "امتداد الملف لا يطابق نوع المستند.");
    return;
  }
  const financeContext = ["topup_request", "subscription_request", "receipt"].includes(body.contextType);
  const { data, error } = financeContext
    ? await session.supabase.rpc("petro_finance_create_document_upload", {
      p_context_type: body.contextType, p_context_id: body.contextId,
      p_document_type: body.documentType, p_file_name: cleanName,
      p_content_type: body.contentType, p_byte_size: body.byteSize,
    })
    : await session.supabase.rpc("petro_create_document_upload", {
      p_context_type: body.contextType, p_context_id: body.contextId,
      p_document_type: body.documentType, p_file_name: cleanName,
      p_content_type: body.contentType, p_byte_size: body.byteSize,
      p_expires_on: body.expiresOn ? body.expiresOn.toISOString().slice(0, 10) : null,
    });
  if (error) { mapWorkflowError(res, error); return; }
  if (!isRecord(data) || typeof data["id"] !== "string") {
    fail(res, 503, "تعذر إنشاء طلب رفع الملف.");
    return;
  }
  res.status(201).json({ id: data["id"], message: "أُنشئ طلب رفع مؤقت؛ ارفع الملف قبل انتهاء صلاحيته." });
});

router.put(
  "/documents/:documentId/content",
  raw({ type: "application/octet-stream", limit: "10mb" }),
  async (req, res): Promise<void> => {
    setNoStore(res);
    const session = await requireSession(req, res, false);
    if (!session) return;
    const documentId = req.params["documentId"];
    if (!safeId(documentId) || !Buffer.isBuffer(req.body)) { fail(res, 400, "الملف غير صالح."); return; }
    const { data: doc, error: docError } = await session.supabase.from("petro_documents")
      .select("id,uploader_id,storage_path,content_type,byte_size,file_name,status,upload_expires_at")
      .eq("id", documentId).maybeSingle();
    if (docError || !doc) { if (docError) mapWorkflowError(res, docError); else fail(res, 404, "لم يتم العثور على طلب رفع الملف."); return; }
    const bytes = req.body as Buffer;
    if (doc.uploader_id !== session.userId) {
      fail(res, 403, "لا تملك صلاحية رفع هذا الملف.");
      return;
    }
    if (doc.status !== "pending_upload" || new Date(doc.upload_expires_at).getTime() <= Date.now()) {
      await session.supabase.rpc("petro_fail_document_upload", { p_document_id: documentId });
      fail(res, 409, "انتهت صلاحية طلب رفع الملف أو استُخدم سابقًا. أنشئ طلب رفع جديدًا.");
      return;
    }
    const declaredByteSize = Number(doc.byte_size);
    if (!Number.isSafeInteger(declaredByteSize) || declaredByteSize !== bytes.length
      || declaredByteSize > 10 * 1024 * 1024) {
      await session.supabase.rpc("petro_fail_document_upload", { p_document_id: documentId });
      fail(res, 400, "حجم الملف لا يطابق طلب الرفع أو يتجاوز الحد المسموح.");
      return;
    }
    if (!fileSignatureMatches(doc.content_type, bytes)) {
      await session.supabase.rpc("petro_fail_document_upload", { p_document_id: documentId });
      fail(res, 400, "محتوى الملف لا يطابق صيغة الصورة المختارة.");
      return;
    }
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const { error: uploadError } = await session.supabase.storage.from(BUCKET)
      .upload(doc.storage_path, bytes, { contentType: doc.content_type, upsert: false, cacheControl: "0" });
    if (uploadError) {
      await session.supabase.rpc("petro_fail_document_upload", { p_document_id: documentId });
      fail(res, 502, "تعذر حفظ الملف في التخزين الخاص.");
      return;
    }
    const { error: completeError } = await session.supabase.rpc("petro_complete_document_upload", {
      p_document_id: documentId, p_sha256: checksum,
    });
    if (completeError) {
      await session.supabase.storage.from(BUCKET).remove([doc.storage_path]);
      await session.supabase.rpc("petro_fail_document_upload", { p_document_id: documentId });
      mapWorkflowError(res, completeError);
      return;
    }
    res.json({ message: "تم حفظ الملف الخاص بعد فحص النوع والحجم. ينتظر مراجعة الإدارة." });
  },
);

router.get("/documents/:documentId/download", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res, false);
  if (!session) return;
  const documentId = req.params["documentId"];
  if (!safeId(documentId)) { fail(res, 400, "معرّف المستند غير صالح."); return; }
  const { data: doc, error } = await session.supabase.from("petro_documents")
    .select("storage_path,file_name,status").eq("id", documentId).maybeSingle();
  if (error || !doc || doc.status === "pending_upload" || doc.status === "upload_failed") {
    if (error) mapWorkflowError(res, error); else fail(res, 404, "المستند غير متاح للتنزيل.");
    return;
  }
  const { data, error: linkError } = await session.supabase.storage.from(BUCKET)
    .createSignedUrl(doc.storage_path, 60, { download: doc.file_name });
  if (linkError || !data?.signedUrl) {
    fail(res, 403, "لا يمكن الوصول إلى هذا الملف أو انتهت صلاحية الجلسة.");
    return;
  }
  res.json({ url: data.signedUrl, expiresInSeconds: 60 });
});

export default router;
