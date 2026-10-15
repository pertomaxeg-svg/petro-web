import { Router, type IRouter, type Request, type Response } from "express";
import { createHash, randomBytes } from "node:crypto";
import {
  ApproveBranchBody,
  ApproveOrganizationBody,
  CreateBranchBody,
  CreateOrganizationBody,
  UpdateBranchBody,
  UpdateBranchStatusBody,
  UpdateOrganizationBody,
  UpdateOrganizationStatusBody,
} from "@workspace/api-zod";
import { createSupabaseServerClient, isRecord, readString, readStringArray, setNoStore } from "../lib/supabaseServer";

const router: IRouter = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEMBERSHIP_ROLES = new Set([
  "organization_owner",
  "manager",
  "finance",
  "worker",
  "viewer",
]);
const ORGANIZATION_KINDS = new Set(["company", "station", "provider"]);
const MEMBERSHIP_SCOPES = new Set(["organization", "branches"]);
const PLATFORM_ROLES = new Set(["owner", "operations", "finance", "support", "auditor"]);
const ORGANIZATION_SELECT =
  "id,name,kind,code,legal_name,contact_name,contact_phone,contact_email,address,country_code,currency,status,approval_status,operational_status,created_at,updated_at,version";
const BRANCH_SELECT =
  "id,organization_id,code,name,address,governorate,latitude,longitude,hours,contact_name,contact_phone,status,approval_status,operational_status,created_at,updated_at,version";
const SEARCH_RESTRICTED = /[^\p{L}\p{M}\p{N}\s_-]/gu;
const PAGE_SIZE_MAX = 100;
const PLATFORM_ROLE_CATALOG = [
  {
    role: "owner",
    label: "مالك المنصة",
    scope: "platform",
    permissions: [
      { code: "organizations.manage", label: "إدارة الجهات والفروع" },
      { code: "organization_requests.review", label: "مراجعة طلبات الانضمام وتغييرات البيانات" },
      { code: "bank_details.review", label: "مراجعة بيانات الحسابات البنكية" },
      { code: "platform_users.manage", label: "إدارة مستخدمي المنصة وأدوارهم" },
      { code: "audit.read", label: "قراءة سجل التدقيق المركزي" },
    ],
  },
  {
    role: "operations",
    label: "العمليات",
    scope: "platform",
    permissions: [
      { code: "organizations.manage", label: "إدارة الجهات والفروع" },
      { code: "organization_requests.review", label: "مراجعة طلبات الانضمام وتغييرات البيانات" },
      { code: "profiles.read", label: "قراءة ملفات الحسابات اللازمة للتشغيل" },
    ],
  },
  {
    role: "finance",
    label: "المالية",
    scope: "platform",
    permissions: [
      { code: "bank_details.read", label: "قراءة تفاصيل الحسابات البنكية المصرح بها" },
      { code: "bank_changes.review", label: "مراجعة تغييرات الحسابات البنكية" },
    ],
  },
  {
    role: "support",
    label: "الدعم",
    scope: "platform",
    permissions: [],
  },
  {
    role: "auditor",
    label: "مراجع",
    scope: "platform",
    permissions: [{ code: "audit.read", label: "قراءة سجل التدقيق المصرح به" }],
  },
] as const;

export type SessionContext = {
  supabase: ReturnType<typeof createSupabaseServerClient>;
  userId: string;
};

function fail(res: Response, status: number, message: string): void {
  res.status(status).json({ message });
}

function validId(value: string | undefined): value is string {
  return Boolean(value && UUID_RE.test(value));
}

export async function requireSession(
  req: Request,
  res: Response,
  requireActive = true,
): Promise<SessionContext | null> {
  try {
    const supabase = createSupabaseServerClient(req, res);
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError || !authData.user) {
      fail(res, 401, "يلزم تسجيل الدخول.");
      return null;
    }

    const { data: profile, error: profileError } = await supabase
      .from("petro_profiles")
      .select("active,account_status")
      .eq("user_id", authData.user.id)
      .maybeSingle();
    if (profileError || !profile) {
      fail(res, 503, "تعذر قراءة صلاحية الحساب.");
      return null;
    }
    if (profile.account_status === "suspended" || (!profile.active && profile.account_status !== "pending")) {
      await supabase.auth.signOut({ scope: "local" });
      fail(res, 403, "هذا الحساب معطل.");
      return null;
    }
    if (requireActive && !profile.active) {
      fail(res, 403, "الحساب بانتظار اعتماد الصلاحيات.");
      return null;
    }

    return { supabase, userId: authData.user.id };
  } catch {
    fail(res, 503, "تعذر التحقق من جلسة الدخول.");
    return null;
  }
}

export function apiError(res: Response, error: { code?: string; message?: string } | null): void {
  if (error?.code === "42501" || error?.code === "PGRST301") {
    fail(res, 403, "ليست لديك صلاحية لهذا الإجراء.");
  } else if (
    (error?.code === "PGRST202" || error?.code === "42883") &&
    error.message?.includes("petro_admin_")
  ) {
    fail(res, 503, "إدارة مستخدمي المنصة بانتظار تفعيل مخطط قاعدة البيانات المتوافق.");
  } else if (error?.code === "23505") {
    fail(res, 409, "الكود مستخدم بالفعل داخل هذا النطاق.");
  } else if (error?.code === "23514" && error.message?.includes("last active platform owner")) {
    fail(res, 409, "لا يمكن تنفيذ الإجراء لأنه سيترك المنصة بلا مالك نشط.");
  } else if (error?.code === "23514" && error.message?.includes("target account must be active")) {
    fail(res, 409, "فعّل الحساب أولًا قبل منحه دورًا على مستوى المنصة.");
  } else if (error?.code === "23514") {
    fail(res, 409, "تعذر تنفيذ الإجراء بسبب قيد حماية للحساب.");
  } else if (error?.code === "40001") {
    fail(res, 409, "تغير السجل بعد فتحه. حدّث الصفحة ثم أعد المحاولة.");
  } else if (error?.code === "55000" && error.message?.includes("SENSITIVE_CHANGE_REQUIRES_REVIEW")) {
    fail(res, 409, "هذا الحقل يحتاج طلب مراجعة قبل التعديل.");
  } else if (error?.code === "55000") {
    fail(res, 409, "تغيرت حالة السجل. حدّث الصفحة ثم أعد المحاولة.");
  } else if (error?.code === "P0002") {
    fail(res, 404, "لم يتم العثور على السجل المطلوب.");
  } else {
    fail(res, 400, "تعذر تنفيذ الطلب. تحقق من البيانات والصلاحيات.");
  }
}

function queryString(req: Request, name: string): string | undefined {
  const value = req.query[name];
  return typeof value === "string" ? value : undefined;
}

function pageQuery(req: Request): { page: number; pageSize: number; from: number; to: number } | null {
  const rawPage = queryString(req, "page");
  const rawPageSize = queryString(req, "pageSize");
  const page = rawPage === undefined ? 1 : Number(rawPage);
  const pageSize = rawPageSize === undefined ? 25 : Number(rawPageSize);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > PAGE_SIZE_MAX
  ) {
    return null;
  }
  const from = (page - 1) * pageSize;
  return Number.isSafeInteger(from) ? { page, pageSize, from, to: from + pageSize - 1 } : null;
}

function safeSearch(req: Request): string | null {
  const raw = queryString(req, "search");
  if (!raw) return null;
  const term = raw.replace(SEARCH_RESTRICTED, "").trim().slice(0, 100);
  return term.length >= 2 ? term : null;
}

function pageResponse<T>(items: T[], page: number, pageSize: number, count: number | null) {
  const total = count ?? 0;
  return { items, page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}

function organizationIdFrom(req: Request): string | null {
  const candidate = req.params["organizationId"];
  return typeof candidate === "string" && validId(candidate) ? candidate : null;
}

router.get("/organizations", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const page = pageQuery(req);
  const kind = queryString(req, "kind");
  const approvalStatus = queryString(req, "approvalStatus");
  const operationalStatus = queryString(req, "operationalStatus");
  const sortBy = queryString(req, "sortBy") ?? "createdAt";
  const sortDirection = queryString(req, "sortDirection") ?? "desc";
  const search = safeSearch(req);
  const allowedSorts: Record<string, string> = {
    name: "name",
    code: "code",
    kind: "kind",
    approvalStatus: "approval_status",
    operationalStatus: "operational_status",
    createdAt: "created_at",
  };
  if (
    !page ||
    (queryString(req, "search") && !search) ||
    (kind && !ORGANIZATION_KINDS.has(kind)) ||
    (approvalStatus && !["pending", "approved"].includes(approvalStatus)) ||
    (operationalStatus && !["inactive", "active", "suspended"].includes(operationalStatus)) ||
    !allowedSorts[sortBy] ||
    !["asc", "desc"].includes(sortDirection)
  ) {
    fail(res, 400, "تحقق من البحث والفلاتر وترتيب النتائج.");
    return;
  }

  let query = session.supabase
    .from("petro_organizations")
    .select(ORGANIZATION_SELECT, { count: "exact" });
  if (search) query = query.or(`name.ilike.%${search}%,code.ilike.%${search}%,legal_name.ilike.%${search}%`);
  if (kind) query = query.eq("kind", kind);
  if (approvalStatus) query = query.eq("approval_status", approvalStatus);
  if (operationalStatus) query = query.eq("operational_status", operationalStatus);
  const { data, error, count } = await query
    .order(allowedSorts[sortBy], { ascending: sortDirection === "asc" })
    .order("id", { ascending: true })
    .range(page.from, page.to);
  if (error) {
    apiError(res, error);
    return;
  }
  res.json(pageResponse(data ?? [], page.page, page.pageSize, count));
});

router.post("/organizations", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const parsed = CreateOrganizationBody.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, "تحقق من اسم الجهة ونوعها وكودها وبياناتها.");
    return;
  }
  const input = parsed.data;
  const { data, error } = await session.supabase.rpc("petro_create_organization_details", {
    p_name: input.name.trim(),
    p_kind: input.kind,
    p_code: input.code.trim().toUpperCase(),
    p_legal_name: input.legalName ?? null,
    p_contact_name: input.contactName ?? null,
    p_contact_phone: input.contactPhone ?? null,
    p_contact_email: input.contactEmail?.trim().toLowerCase() ?? null,
    p_address: input.address.trim(),
  });
  if (error) {
    apiError(res, error);
    return;
  }
  res.status(201).json({ id: data, message: "تم إنشاء الجهة بحالة انتظار الاعتماد." });
});

router.get("/organizations/:organizationId", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const organizationId = organizationIdFrom(req);
  if (!organizationId) {
    fail(res, 400, "معرّف الجهة غير صالح.");
    return;
  }
  const { data, error } = await session.supabase
    .from("petro_organizations")
    .select(ORGANIZATION_SELECT)
    .eq("id", organizationId)
    .maybeSingle();
  if (error) {
    apiError(res, error);
    return;
  }
  if (!data) {
    fail(res, 404, "لم يتم العثور على الجهة المطلوبة.");
    return;
  }
  res.json(data);
});

router.patch("/organizations/:organizationId", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const organizationId = organizationIdFrom(req);
  const parsed = UpdateOrganizationBody.safeParse(req.body);
  if (!organizationId || !parsed.success) {
    fail(res, 400, "تحقق من بيانات الجهة ورقم الإصدار.");
    return;
  }
  const input = parsed.data;
  const { error } = await session.supabase.rpc("petro_update_organization_details", {
    p_organization_id: organizationId,
    p_expected_version: input.expectedVersion,
    p_name: input.name.trim(),
    p_kind: input.kind,
    p_code: input.code.trim().toUpperCase(),
    p_legal_name: input.legalName ?? null,
    p_contact_name: input.contactName ?? null,
    p_contact_phone: input.contactPhone ?? null,
    p_contact_email: input.contactEmail?.trim().toLowerCase() ?? null,
    p_address: input.address.trim(),
    p_reason: input.reason.trim(),
  });
  if (error) {
    apiError(res, error);
    return;
  }
  res.json({ message: "تم تحديث بيانات الجهة وتسجيل التغيير." });
});

router.post("/organizations/:organizationId/approval", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const organizationId = organizationIdFrom(req);
  const parsed = ApproveOrganizationBody.safeParse(req.body);
  if (!organizationId || !parsed.success) {
    fail(res, 400, "أدخل سبب الاعتماد وتحقق من رقم الإصدار.");
    return;
  }
  const { error } = await session.supabase.rpc("petro_approve_organization", {
    p_organization_id: organizationId,
    p_expected_version: parsed.data.expectedVersion,
    p_reason: parsed.data.reason.trim(),
  });
  if (error) {
    apiError(res, error);
    return;
  }
  res.json({ message: "تم اعتماد الجهة. لم تُفعّل تشغيليًا بعد." });
});

router.patch("/organizations/:organizationId/status", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const organizationId = organizationIdFrom(req);
  const parsed = UpdateOrganizationStatusBody.safeParse(req.body);
  if (!organizationId || !parsed.success) {
    fail(res, 400, "أدخل سبب التغيير وتحقق من الحالة ورقم الإصدار.");
    return;
  }
  const { error } = await session.supabase.rpc("petro_set_organization_operational_status", {
    p_organization_id: organizationId,
    p_expected_version: parsed.data.expectedVersion,
    p_operational_status: parsed.data.operationalStatus,
    p_reason: parsed.data.reason.trim(),
  });
  if (error) {
    apiError(res, error);
    return;
  }
  res.json({ status: parsed.data.operationalStatus, message: "تم تحديث حالة التشغيل وتسجيل السبب." });
});

router.get("/organizations/:organizationId/branches", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const organizationId = organizationIdFrom(req);
  if (!organizationId) {
    fail(res, 400, "معرّف الجهة غير صالح.");
    return;
  }
  const { data, error } = await session.supabase
    .from("petro_branches")
    .select(BRANCH_SELECT)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });
  if (error) {
    apiError(res, error);
    return;
  }
  res.json({ items: data ?? [] });
});

router.get("/branches", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const organizationId = queryString(req, "organizationId");
  const page = pageQuery(req);
  const approvalStatus = queryString(req, "approvalStatus");
  const operationalStatus = queryString(req, "operationalStatus");
  const sortBy = queryString(req, "sortBy") ?? "createdAt";
  const sortDirection = queryString(req, "sortDirection") ?? "desc";
  const search = safeSearch(req);
  const allowedSorts: Record<string, string> = {
    name: "name",
    code: "code",
    approvalStatus: "approval_status",
    operationalStatus: "operational_status",
    createdAt: "created_at",
  };
  if (
    !validId(organizationId) ||
    !page ||
    (queryString(req, "search") && !search) ||
    (approvalStatus && !["pending", "approved"].includes(approvalStatus)) ||
    (operationalStatus && !["inactive", "active", "suspended"].includes(operationalStatus)) ||
    !allowedSorts[sortBy] ||
    !["asc", "desc"].includes(sortDirection)
  ) {
    fail(res, 400, "تحقق من الجهة والبحث والفلاتر وترتيب النتائج.");
    return;
  }
  let query = session.supabase
    .from("petro_branches")
    .select(BRANCH_SELECT, { count: "exact" })
    .eq("organization_id", organizationId);
  if (search) query = query.or(`name.ilike.%${search}%,code.ilike.%${search}%,address.ilike.%${search}%,governorate.ilike.%${search}%`);
  if (approvalStatus) query = query.eq("approval_status", approvalStatus);
  if (operationalStatus) query = query.eq("operational_status", operationalStatus);
  const { data, error, count } = await query
    .order(allowedSorts[sortBy], { ascending: sortDirection === "asc" })
    .order("id", { ascending: true })
    .range(page.from, page.to);
  if (error) {
    apiError(res, error);
    return;
  }
  res.json(pageResponse(data ?? [], page.page, page.pageSize, count));
});

router.post("/organizations/:organizationId/branches", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const organizationId = organizationIdFrom(req);
  const parsed = CreateBranchBody.safeParse(req.body);
  if (!organizationId || !parsed.success) {
    fail(res, 400, "تحقق من كود الفرع واسمه وبيانات موقعه وساعات العمل.");
    return;
  }
  const input = parsed.data;
  const { data, error } = await session.supabase.rpc("petro_create_branch_details", {
    p_organization_id: organizationId,
    p_code: input.code.trim().toUpperCase(),
    p_name: input.name.trim(),
    p_address: input.address.trim(),
    p_governorate: input.governorate ?? null,
    p_latitude: input.latitude ?? null,
    p_longitude: input.longitude ?? null,
    p_hours: input.hours,
    p_contact_name: input.contactName ?? null,
    p_contact_phone: input.contactPhone ?? null,
  });
  if (error) {
    apiError(res, error);
    return;
  }
  res.status(201).json({ id: data, message: "تم إنشاء الفرع بحالة انتظار الاعتماد." });
});

router.patch("/branches/:branchId", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const branchId = req.params["branchId"];
  const parsed = UpdateBranchBody.safeParse(req.body);
  if (!validId(branchId) || !parsed.success) {
    fail(res, 400, "تحقق من بيانات الفرع ورقم الإصدار.");
    return;
  }
  const input = parsed.data;
  const { error } = await session.supabase.rpc("petro_update_branch_details", {
    p_organization_id: input.organizationId,
    p_branch_id: branchId,
    p_expected_version: input.expectedVersion,
    p_code: input.code.trim().toUpperCase(),
    p_name: input.name.trim(),
    p_address: input.address.trim(),
    p_governorate: input.governorate ?? null,
    p_latitude: input.latitude ?? null,
    p_longitude: input.longitude ?? null,
    p_hours: input.hours,
    p_contact_name: input.contactName ?? null,
    p_contact_phone: input.contactPhone ?? null,
    p_reason: input.reason.trim(),
  });
  if (error) {
    apiError(res, error);
    return;
  }
  res.json({ message: "تم تحديث بيانات الفرع وتسجيل التغيير." });
});

router.post("/branches/:branchId/approval", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const branchId = req.params["branchId"];
  const parsed = ApproveBranchBody.safeParse(req.body);
  if (!validId(branchId) || !parsed.success) {
    fail(res, 400, "أدخل سبب الاعتماد وتحقق من الجهة ورقم الإصدار.");
    return;
  }
  const { error } = await session.supabase.rpc("petro_approve_branch", {
    p_organization_id: parsed.data.organizationId,
    p_branch_id: branchId,
    p_expected_version: parsed.data.expectedVersion,
    p_reason: parsed.data.reason.trim(),
  });
  if (error) {
    apiError(res, error);
    return;
  }
  res.json({ message: "تم اعتماد الفرع. لم يُفعّل تشغيليًا بعد." });
});

router.patch("/branches/:branchId/status", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const branchId = req.params["branchId"];
  const parsed = UpdateBranchStatusBody.safeParse(req.body);
  if (!validId(branchId) || !parsed.success) {
    fail(res, 400, "أدخل سبب التغيير وتحقق من الجهة والحالة ورقم الإصدار.");
    return;
  }
  const { error } = await session.supabase.rpc("petro_set_branch_operational_status", {
    p_organization_id: parsed.data.organizationId,
    p_branch_id: branchId,
    p_expected_version: parsed.data.expectedVersion,
    p_operational_status: parsed.data.operationalStatus,
    p_reason: parsed.data.reason.trim(),
  });
  if (error) {
    apiError(res, error);
    return;
  }
  res.json({ message: "تم تحديث حالة الفرع وتسجيل السبب." });
});

router.get("/organizations/:organizationId/memberships", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;

  const organizationId = organizationIdFrom(req);
  if (!organizationId) {
    fail(res, 400, "معرّف الجهة غير صالح.");
    return;
  }

  const { data: memberships, error: membershipError } = await session.supabase
    .from("petro_memberships")
    .select("id,user_id,organization_id,role,scope,active")
    .eq("organization_id", organizationId)
    .order("role");
  if (membershipError) {
    apiError(res, membershipError);
    return;
  }

  const membershipIds = (memberships ?? []).map((item) => item.id);
  const userIds = [...new Set((memberships ?? []).map((item) => item.user_id))];
  if (membershipIds.length === 0) {
    res.json({ items: [] });
    return;
  }

  const [branchResult, profileResult] = await Promise.all([
    session.supabase
      .from("petro_membership_branches")
      .select("membership_id,branch_id")
      .in("membership_id", membershipIds),
    session.supabase
      .from("petro_profiles")
      .select("user_id,display_name,username,active,account_status")
      .in("user_id", userIds),
  ]);
  if (branchResult.error) {
    apiError(res, branchResult.error);
    return;
  }
  if (profileResult.error) {
    apiError(res, profileResult.error);
    return;
  }

  const profiles = new Map((profileResult.data ?? []).map((profile) => [profile.user_id, profile]));
  const branchesByMembership = new Map<string, string[]>();
  for (const item of branchResult.data ?? []) {
    const items = branchesByMembership.get(item.membership_id) ?? [];
    items.push(item.branch_id);
    branchesByMembership.set(item.membership_id, items);
  }

  res.json({
    items: (memberships ?? []).map((membership) => ({
      ...membership,
      profile: profiles.get(membership.user_id) ?? null,
      branchIds: branchesByMembership.get(membership.id) ?? [],
    })),
  });
});

router.post("/organizations/:organizationId/memberships", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;

  const organizationId = organizationIdFrom(req);
  const userId = readString(req.body, "userId", 64);
  const role = readString(req.body, "role", 40);
  const scope = readString(req.body, "scope", 20);
  const branchIds = readStringArray(req.body, "branchIds", 100);
  const active = isRecord(req.body) ? req.body["active"] !== false : true;
  if (
    !organizationId ||
    !validId(userId ?? undefined) ||
    !role ||
    !MEMBERSHIP_ROLES.has(role) ||
    !scope ||
    !MEMBERSHIP_SCOPES.has(scope) ||
    !branchIds ||
    branchIds.some((id) => !validId(id))
  ) {
    fail(res, 400, "تحقق من حساب الموظف والدور ونطاق الفروع.");
    return;
  }

  const { data, error } = await session.supabase.rpc("petro_set_membership", {
    p_organization_id: organizationId,
    p_user_id: userId,
    p_role: role,
    p_scope: scope,
    p_branch_ids: branchIds,
    p_active: active,
  });
  if (error) {
    apiError(res, error);
    return;
  }
  res.json({ id: data, message: "تم تحديث صلاحيات الموظف وتسجيل التغيير." });
});

router.get("/organizations/:organizationId/invitations", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;

  const organizationId = organizationIdFrom(req);
  if (!organizationId) {
    fail(res, 400, "معرّف الجهة غير صالح.");
    return;
  }

  const { data, error } = await session.supabase.rpc("petro_list_invitations", {
    p_organization_id: organizationId,
  });
  if (error) {
    apiError(res, error);
    return;
  }
  res.json({ items: data ?? [] });
});

router.post("/organizations/:organizationId/invitations", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;

  const organizationId = organizationIdFrom(req);
  const email = readString(req.body, "email", 254)?.toLowerCase();
  const role = readString(req.body, "role", 40);
  const scope = readString(req.body, "scope", 20);
  const branchIds = readStringArray(req.body, "branchIds", 100);
  if (
    !organizationId ||
    !email ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    !role ||
    !MEMBERSHIP_ROLES.has(role) ||
    !scope ||
    !MEMBERSHIP_SCOPES.has(scope) ||
    !branchIds ||
    branchIds.some((id) => !validId(id))
  ) {
    fail(res, 400, "تحقق من البريد والدور ونطاق الفروع.");
    return;
  }

  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const { data, error } = await session.supabase.rpc("petro_create_invitation", {
    p_organization_id: organizationId,
    p_email: email,
    p_role: role,
    p_scope: scope,
    p_branch_ids: branchIds,
    p_token_hash: tokenHash,
  });
  if (error) {
    apiError(res, error);
    return;
  }

  const origin = req.get("origin");
  const referer = req.get("referer");
  let appPrefix = "";
  try {
    if (origin && referer) {
      const refererUrl = new URL(referer);
      if (refererUrl.origin === new URL(origin).origin) {
        const routeMatch = refererUrl.pathname.match(
          /^(.*?)(?:\/(?:workspace|sign-in|sign-up|reset-password)(?:\/|$))/,
        );
        appPrefix = routeMatch?.[1] ?? "";
      }
    }
  } catch {
    appPrefix = "";
  }

  res.status(201).json({
    id: data,
    inviteUrl: `${origin ?? ""}${appPrefix}/sign-up?invite=${encodeURIComponent(rawToken)}`,
    expiresInDays: 7,
    message: "أُنشئت الدعوة. انسخ الرابط الآن؛ لن يُعرض رمزها مرة أخرى.",
  });
});

router.post("/invitations/accept", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res, false);
  if (!session) return;

  const token = readString(req.body, "token", 128);
  if (!token || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    fail(res, 400, "رابط الدعوة غير صالح.");
    return;
  }
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const { data, error } = await session.supabase.rpc("petro_accept_invitation", {
    p_token_hash: tokenHash,
  });
  if (error) {
    apiError(res, error);
    return;
  }
  res.json({ id: data, message: "تم قبول الدعوة وتفعيل صلاحيات الجهة." });
});

router.delete("/invitations/:invitationId", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;

  const invitationId = req.params["invitationId"];
  if (!validId(invitationId)) {
    fail(res, 400, "معرّف الدعوة غير صالح.");
    return;
  }
  const { error } = await session.supabase.rpc("petro_revoke_invitation", {
    p_invitation_id: invitationId,
  });
  if (error) {
    apiError(res, error);
    return;
  }
  res.status(204).end();
});

router.patch("/users/:userId/status", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;

  const userId = req.params["userId"];
  const status = readString(req.body, "status", 20);
  const reason = readString(req.body, "reason", 500)?.trim();
  if (
    !validId(userId) ||
    (status !== "active" && status !== "suspended") ||
    !reason ||
    reason.length < 5
  ) {
    fail(res, 400, "تحقق من معرّف الحساب والحالة وسبب الإجراء (5–500 حرف).");
    return;
  }
  const { error } = await session.supabase.rpc("petro_admin_set_account_status", {
    p_user_id: userId,
    p_status: status,
    p_reason: reason,
  });
  if (error) {
    apiError(res, error);
    return;
  }
  res.json({ status, message: "تم تحديث حالة الحساب وتسجيل التغيير." });
});

router.get("/admin/platform-users", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;

  const page = pageQuery(req);
  const rawSearch = queryString(req, "search");
  const search = safeSearch(req);
  const accountStatus = queryString(req, "accountStatus");
  const role = queryString(req, "role");
  if (
    !page ||
    (rawSearch && !search) ||
    (accountStatus && !["pending", "active", "suspended"].includes(accountStatus)) ||
    (role && !PLATFORM_ROLES.has(role))
  ) {
    fail(res, 400, "تحقق من البحث وحالة الحساب والدور ورقم الصفحة.");
    return;
  }

  const { data, error } = await session.supabase.rpc("petro_admin_list_platform_users", {
    p_page: page.page,
    p_page_size: page.pageSize,
    p_search: search,
    p_account_status: accountStatus ?? null,
    p_role: role ?? null,
  });
  if (error) {
    apiError(res, error);
    return;
  }

  const rows = (data ?? []) as Array<{
    user_id: string;
    username: string;
    display_name: string;
    active: boolean;
    account_status: "pending" | "active" | "suspended";
    created_at: string;
    platform_roles: string[];
    total_count: number | string;
  }>;
  const total = rows.length ? Number(rows[0]?.total_count ?? 0) : 0;
  res.json({
    items: rows.map((row) => ({
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name,
      active: row.active,
      accountStatus: row.account_status,
      createdAt: row.created_at,
      platformRoles: row.platform_roles,
    })),
    page: page.page,
    pageSize: page.pageSize,
    total,
    totalPages: Math.ceil(total / page.pageSize),
  });
});

router.get("/admin/platform-users/:userId", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;

  const userId = req.params["userId"];
  if (!validId(userId)) {
    fail(res, 400, "معرّف الحساب غير صالح.");
    return;
  }

  const { data, error } = await session.supabase.rpc("petro_admin_get_platform_user", {
    p_user_id: userId,
  });
  if (error) {
    apiError(res, error);
    return;
  }
  if (!isRecord(data) || !isRecord(data.user)) {
    fail(res, 404, "لم يتم العثور على حساب المنصة.");
    return;
  }
  res.json({ ...data, roleCatalog: PLATFORM_ROLE_CATALOG });
});

router.patch("/admin/platform-users/:userId/roles", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;

  const userId = req.params["userId"];
  const roles = readStringArray(req.body, "roles", 5);
  const reason = readString(req.body, "reason", 500)?.trim();
  if (
    !validId(userId) ||
    !roles ||
    roles.some((role) => !PLATFORM_ROLES.has(role)) ||
    new Set(roles).size !== roles.length ||
    !reason ||
    reason.length < 5
  ) {
    fail(res, 400, "تحقق من الحساب والأدوار وسبب التغيير (5–500 حرف).");
    return;
  }

  const { data, error } = await session.supabase.rpc("petro_admin_set_platform_roles", {
    p_user_id: userId,
    p_roles: roles,
    p_reason: reason,
  });
  if (error) {
    apiError(res, error);
    return;
  }
  res.json({
    roles: data ?? [],
    message: "تم تحديث أدوار المنصة وتسجيل السبب في سجل التدقيق.",
  });
});

export default router;
