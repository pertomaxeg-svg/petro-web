import { Router, type IRouter, type Response } from "express";
import {
  ExecuteAdminInventoryCommandBody,
  GetAdminInventoryQueryParams,
} from "@workspace/api-zod";
import { requireSession } from "./management";
import { isRecord, setNoStore } from "../lib/supabaseServer";

const router: IRouter = Router();
type Session = NonNullable<Awaited<ReturnType<typeof requireSession>>>;
type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };
type InventoryAction = "location.create" | "document.create" | "document.review"
  | "reservation.reserve" | "reservation.release" | "reservation.consume";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const queryViews = new Set(["organizations", "locations", "branches", "items", "balances", "documents", "movements", "document", "reconciliation"]);
const documentTypes = new Set(["receipt", "issue", "return", "damage", "transfer", "count", "adjustment"]);

function fail(res: Response, status: number, message: string): void {
  res.status(status).json({ message });
}

function rpc(session: Session, name: string, args: Record<string, unknown>): Promise<RpcResult> {
  const call = session.supabase.rpc as unknown as (
    functionName: string,
    parameters?: Record<string, unknown>,
  ) => Promise<RpcResult>;
  return call.call(session.supabase, name, args);
}

function mapError(res: Response, error: { code?: string; message?: string } | null): void {
  const code = error?.code ?? "";
  if (code === "42501" || code === "PGRST301") {
    fail(res, 403, "ليست لديك صلاحية لهذا الإجراء أو لهذا النطاق.");
  } else if (code === "P0002") {
    fail(res, 404, "السجل المطلوب غير موجود أو غير متاح لهذا الحساب.");
  } else if (code === "22023" || code === "22P02") {
    fail(res, 400, "تحقق من الحقول والكميات والوحدة ثم أعد المحاولة.");
  } else if (["23505", "23514", "40001", "55000"].includes(code)) {
    fail(res, 409, "لم يُعتمد التغيير بسبب تعارض أو شرط غير مستوفى. حدّث البيانات ثم أعد المحاولة.");
  } else if (code === "PGRST202" || code === "42883") {
    fail(res, 503, "إدارة المخزون غير مفعلة على قاعدة البيانات الحالية.");
  } else {
    fail(res, 500, "تعذر إكمال الطلب الآن.");
  }
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function validText(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.trim().length >= min && value.trim().length <= max;
}

function validateCommand(action: InventoryAction, payload: Record<string, unknown>): string | null {
  if (action === "location.create") {
    if (!validUuid(payload["organizationId"]) || !validUuid(payload["branchId"])) return "اختر الجهة والفرع.";
    if (!validText(payload["name"], 2, 120) || !validText(payload["reason"], 5, 500)) return "أدخل اسم المخزن وسبب الإنشاء.";
    if (!["sellable", "quarantine", "damaged", "transit"].includes(String(payload["kind"]))) return "نوع المخزن غير صالح.";
  }
  if (action === "document.create") {
    if (!validUuid(payload["organizationId"]) || !validUuid(payload["sourceLocationId"])) return "اختر الجهة وموقع المخزون.";
    if (!documentTypes.has(String(payload["type"])) || !validText(payload["reason"], 5, 500)) return "حدد نوع الحركة والسبب.";
    if (!Array.isArray(payload["lines"]) || payload["lines"].length < 1 || payload["lines"].length > 100) return "أضف من بند إلى 100 بند.";
    if (payload["type"] === "transfer" || payload["type"] === "damage" || payload["type"] === "return") {
      if (!validUuid(payload["targetLocationId"])) return "اختر الموقع المستلم.";
    }
    for (const entry of payload["lines"]) {
      if (!isRecord(entry) || !validUuid(entry["itemId"])) return "اختر صنفًا صحيحًا لكل بند.";
      const quantity = entry["quantity"];
      const negativeAdjustment = payload["type"] === "adjustment";
      const quantityPattern = negativeAdjustment
        ? /^-?\d+(?:\.\d{1,6})?$/
        : /^\d+(?:\.\d{1,6})?$/;
      if (!(typeof quantity === "number" || (typeof quantity === "string" && quantityPattern.test(quantity)))) return "أدخل كمية صحيحة حتى 6 منازل عشرية.";
      const numericQuantity = Number(quantity);
      if (!Number.isFinite(numericQuantity)
        || (payload["type"] === "count" && numericQuantity < 0)
        || (payload["type"] === "adjustment" && numericQuantity === 0)
        || (!["count", "adjustment"].includes(String(payload["type"])) && numericQuantity <= 0)) {
        return "الكمية غير صالحة لهذا النوع.";
      }
    }
  }
  if (action === "document.review") {
    if (!validUuid(payload["documentId"]) || !["approve", "reject"].includes(String(payload["decision"]))) return "بيانات المراجعة غير مكتملة.";
    if (!validText(payload["reason"], 5, 500)) return "سبب القرار مطلوب.";
  }
  if (action === "reservation.reserve") {
    if (!validUuid(payload["organizationId"]) || !validUuid(payload["locationId"])
      || !validUuid(payload["itemId"]) || !validUuid(payload["sourceReference"])) return "حدد الجهة والمخزن والصنف ومرجع الطلب.";
    if (typeof payload["quantity"] !== "number" && typeof payload["quantity"] !== "string") return "أدخل الكمية.";
    const quantity = Number(payload["quantity"]);
    if (!Number.isFinite(quantity) || quantity <= 0 || !validText(payload["reason"], 5, 500)) return "الكمية وسبب الحجز مطلوبان.";
  }
  if (action === "reservation.release" || action === "reservation.consume") {
    if (!validUuid(payload["reservationId"]) || !validText(payload["reason"], 5, 500)) return "مرجع الحجز والسبب مطلوبان.";
  }
  return null;
}

router.get("/admin/inventory", async (req, res) => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const parsed = GetAdminInventoryQueryParams.safeParse(req.query);
  if (!parsed.success || !queryViews.has(parsed.data.view)) {
    fail(res, 400, "حدد القسم المطلوب ثم أعد المحاولة.");
    return;
  }
  const params = parsed.data;
  const payload: Record<string, unknown> = {
    ...(params.organizationId ? { organizationId: params.organizationId } : {}),
    ...(params.locationId ? { locationId: params.locationId } : {}),
    ...(params.documentId ? { documentId: params.documentId } : {}),
    ...(params.search ? { search: params.search.trim() } : {}),
    ...(params.page ? { page: params.page } : {}),
    ...(params.pageSize ? { pageSize: params.pageSize } : {}),
  };
  if (["locations", "branches", "items"].includes(params.view) && !params.organizationId) {
    fail(res, 400, "حدد الجهة أولًا.");
    return;
  }
  if (["balances", "documents", "movements", "reconciliation"].includes(params.view) && !params.locationId) {
    fail(res, 400, "حدد موقع المخزون أولًا.");
    return;
  }
  if (params.view === "document" && !params.documentId) {
    fail(res, 400, "حدد الحركة المطلوبة.");
    return;
  }
  const { data, error } = await rpc(session, "petro_inventory_admin_query", {
    p_action: params.view,
    p_payload: payload,
  });
  if (error) {
    mapError(res, error);
    return;
  }
  if (!isRecord(data)) {
    fail(res, 500, "لم تصل بيانات المخزون بالشكل المتوقع.");
    return;
  }
  res.json(data);
});

router.post(["/admin/inventory", "/admin/inventory/commands"], async (req, res) => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const parsed = ExecuteAdminInventoryCommandBody.safeParse(req.body);
  if (!parsed.success || !isRecord(parsed.data.payload)) {
    fail(res, 400, "راجع نوع الحركة والبيانات المطلوبة.");
    return;
  }
  const action = parsed.data.action as InventoryAction;
  const validationError = validateCommand(action, parsed.data.payload);
  if (validationError) {
    fail(res, 400, validationError);
    return;
  }
  const { data, error } = await rpc(session, "petro_inventory_admin_command", {
    p_action: action,
    p_payload: parsed.data.payload,
    p_idempotency_key: parsed.data.idempotencyKey,
  });
  if (error) {
    mapError(res, error);
    return;
  }
  if (!isRecord(data) || typeof data["id"] !== "string" || typeof data["status"] !== "string") {
    fail(res, 500, "لم تكتمل نتيجة الحركة بالشكل المتوقع.");
    return;
  }
  res.status(action.endsWith(".create") ? 201 : 200).json(data);
});

export default router;
