import { Router, type IRouter, type Request, type Response } from "express";
import { isRecord, setNoStore } from "../lib/supabaseServer";
import { requireSession } from "./management";

const router: IRouter = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ORGANIZATION_QUERY_KEYS = new Set(["search", "kind", "page", "pageSize"]);
const FUEL_QUERY_KEYS = new Set(["search", "page", "pageSize"]);
const ITEM_QUERY_KEYS = new Set(["search", "organizationId", "categoryCode", "itemKind", "status", "page", "pageSize"]);
const CENTRAL_COMMANDS = new Set([
  "category.create", "category.update", "category.status",
  "fuel.type.create", "fuel.type.update", "fuel.type.status",
  "fuel.price.create_draft", "fuel.price.publish", "fuel.price.cancel",
  "item.review",
]);

type RpcError = { code?: string; message?: string };
type RpcResult = { data: unknown; error: RpcError | null };

function fail(res: Response, status: number, message: string): void {
  res.status(status).json({ message });
}

function queryString(value: unknown, max: number): string | null | undefined {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length > max) return undefined;
  return value.trim() || null;
}

function integer(value: unknown, fallback: number, max: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : null;
}

function mapCatalogError(res: Response, error: RpcError): void {
  if (error.code === "42501" || error.code === "PGRST301") {
    fail(res, 403, "ليست لديك صلاحية لهذا الإجراء.");
  } else if (error.code === "PGRST202" || error.code === "42883") {
    fail(res, 503, "مخطط الكتالوج والأسعار غير متاح الآن.");
  } else if (error.code === "P0002") {
    fail(res, 404, "لم يتم العثور على السجل المطلوب أو لم يعد متاحًا.");
  } else if (["23505", "23514", "40001", "55000", "23P01"].includes(error.code ?? "")) {
    fail(res, 409, "تعارضت حالة السجل أو فترة السعر. حدّث البيانات قبل إعادة المحاولة.");
  } else if (error.code === "22023") {
    fail(res, 400, "تحقق من الحقول والسبب المطلوب.");
  } else {
    fail(res, 500, "تعذر تحميل أو تحديث الكتالوج.");
  }
}

async function requireCatalogRole(
  req: Request,
  res: Response,
  write: boolean,
) {
  const session = await requireSession(req, res);
  if (!session) return null;
  const { data, error } = await session.supabase.rpc("petro_access_context");
  if (error || !isRecord(data)) {
    fail(res, 503, "تعذر التحقق من صلاحيات الكتالوج.");
    return null;
  }
  const roles = data["platform_roles"] ?? data["platformRoles"];
  const allowed = write
    ? ["owner", "operations"]
    : ["owner", "operations", "finance", "auditor"];
  if (!Array.isArray(roles) || !roles.some(role => allowed.includes(String(role)))) {
    fail(res, 403, "لا يملك الحساب تفويض الكتالوج المركزي.");
    return null;
  }
  return session;
}

async function callRpc(
  session: NonNullable<Awaited<ReturnType<typeof requireCatalogRole>>>,
  name: string,
  args: Record<string, unknown> = {},
): Promise<RpcResult> {
  const rpc = session.supabase.rpc as unknown as (
    functionName: string,
    parameters?: Record<string, unknown>,
  ) => Promise<RpcResult>;
  return rpc.call(session.supabase, name, args);
}

function rejectUnknownQuery(req: Request, allowed: Set<string>, res: Response): boolean {
  if (Object.keys(req.query).some(key => !allowed.has(key))) {
    fail(res, 400, "تتضمن المرشحات حقولًا غير مدعومة.");
    return true;
  }
  return false;
}

router.get("/admin/catalog/categories", async (req, res): Promise<void> => {
  setNoStore(res);
  if (Object.keys(req.query).length > 0) {
    fail(res, 400, "لا يدعم هذا المسار مرشحات.");
    return;
  }
  const session = await requireCatalogRole(req, res, false);
  if (!session) return;
  const { data, error } = await callRpc(session, "petro_catalog_admin_categories");
  if (error) return mapCatalogError(res, error);
  if (!isRecord(data) || !Array.isArray(data["categories"]) || !Array.isArray(data["units"])) {
    fail(res, 502, "أعاد الخادم بيانات كتالوج غير متوافقة.");
    return;
  }
  res.status(200).json(data);
});

router.get("/admin/catalog/organizations", async (req, res): Promise<void> => {
  setNoStore(res);
  if (rejectUnknownQuery(req, ORGANIZATION_QUERY_KEYS, res)) return;
  const search = queryString(req.query["search"], 120);
  const kind = queryString(req.query["kind"], 16);
  const page = integer(req.query["page"], 1, 100_000);
  const pageSize = integer(req.query["pageSize"], 20, 100);
  if (search === undefined || kind === undefined || page === null || pageSize === null ||
      (kind !== null && kind !== "station" && kind !== "provider")) {
    fail(res, 400, "تحقق من نوع الجهة ومرشحات البحث.");
    return;
  }
  const session = await requireCatalogRole(req, res, false);
  if (!session) return;
  const { data, error } = await callRpc(session, "petro_catalog_admin_organizations", {
    p_search: search,
    p_kind: kind,
    p_page: page,
    p_page_size: pageSize,
  });
  if (error) return mapCatalogError(res, error);
  if (!isRecord(data) || !Array.isArray(data["items"])) {
    fail(res, 502, "أعاد الخادم سجل جهات غير صالح.");
    return;
  }
  res.status(200).json(data);
});

router.get("/admin/catalog/fuel-types", async (req, res): Promise<void> => {
  setNoStore(res);
  if (rejectUnknownQuery(req, FUEL_QUERY_KEYS, res)) return;
  const search = queryString(req.query["search"], 120);
  const page = integer(req.query["page"], 1, 100_000);
  const pageSize = integer(req.query["pageSize"], 20, 100);
  if (search === undefined || page === null || pageSize === null) {
    fail(res, 400, "تحقق من مرشحات البحث ورقم الصفحة.");
    return;
  }
  const session = await requireCatalogRole(req, res, false);
  if (!session) return;
  const { data, error } = await callRpc(session, "petro_catalog_admin_fuel_list", {
    p_search: search,
    p_page: page,
    p_page_size: pageSize,
  });
  if (error) return mapCatalogError(res, error);
  if (!isRecord(data) || !Array.isArray(data["items"])) {
    fail(res, 502, "أعاد الخادم سجل أنواع الوقود غير صالح.");
    return;
  }
  res.status(200).json(data);
});

router.get("/admin/catalog/items", async (req, res): Promise<void> => {
  setNoStore(res);
  if (rejectUnknownQuery(req, ITEM_QUERY_KEYS, res)) return;
  const organizationId = req.query["organizationId"];
  const categoryCode = queryString(req.query["categoryCode"], 40);
  const itemKind = queryString(req.query["itemKind"], 16);
  const status = queryString(req.query["status"], 24);
  const search = queryString(req.query["search"], 160);
  const page = integer(req.query["page"], 1, 100_000);
  const pageSize = integer(req.query["pageSize"], 20, 100);
  if (typeof organizationId !== "string" || !UUID_RE.test(organizationId) ||
      categoryCode === undefined || itemKind === undefined || status === undefined || search === undefined ||
      page === null || pageSize === null ||
      (itemKind !== null && itemKind !== "product" && itemKind !== "service") ||
      (status !== null && !["draft", "active", "suspended"].includes(status))) {
    fail(res, 400, "تحقق من الجهة وفلاتر الأصناف.");
    return;
  }
  const session = await requireCatalogRole(req, res, false);
  if (!session) return;
  const { data, error } = await callRpc(session, "petro_catalog_list_items", {
    p_organization_id: organizationId,
    p_branch_id: null,
    p_category_code: categoryCode,
    p_item_kind: itemKind,
    p_status: status,
    p_search: search,
    p_page: page,
    p_page_size: pageSize,
  });
  if (error) return mapCatalogError(res, error);
  if (!isRecord(data) || !Array.isArray(data["items"])) {
    fail(res, 502, "أعاد الخادم سجل الأصناف غير صالح.");
    return;
  }
  res.status(200).json(data);
});

router.post("/admin/catalog/commands", async (req, res): Promise<void> => {
  setNoStore(res);
  const { action, payload, reason, idempotencyKey } = req.body ?? {};
  if (typeof action !== "string" || !CENTRAL_COMMANDS.has(action) ||
      !isRecord(payload) || typeof reason !== "string" || reason.trim().length < 3 ||
      reason.trim().length > 500 || typeof idempotencyKey !== "string" || !UUID_RE.test(idempotencyKey)) {
    fail(res, 400, "تحقق من نوع الإجراء والبيانات والسبب ومفتاح المحاولة.");
    return;
  }
  const session = await requireCatalogRole(req, res, true);
  if (!session) return;
  const { data, error } = await callRpc(session, "petro_catalog_command", {
    p_action: action,
    p_payload: payload,
    p_reason: reason.trim(),
    p_idempotency_key: idempotencyKey,
  });
  if (error) return mapCatalogError(res, error);
  if (!isRecord(data)) {
    fail(res, 502, "لم تُرجع قاعدة البيانات نتيجة إجراء صالحة.");
    return;
  }
  res.status(200).json(data);
});

export default router;
