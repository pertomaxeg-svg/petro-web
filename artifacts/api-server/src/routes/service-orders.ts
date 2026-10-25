import { Router, type IRouter, type Request, type Response } from "express";
import { isRecord, setNoStore } from "../lib/supabaseServer";
import { requireSession } from "./management";

const router: IRouter = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUS_FILTERS = new Set([
  "reserved",
  "in_progress",
  "delivered",
  "review_required",
  "cancelled",
]);
const ALLOWED_QUERY_KEYS = new Set(["page", "pageSize", "status", "search"]);

type RpcResult = {
  data: unknown;
  error: { code?: string; message?: string } | null;
};

function fail(res: Response, status: number, message: string): void {
  res.status(status).json({ message });
}

function parseInteger(value: unknown, fallback: number, max: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : null;
}

function mapServiceOrderError(
  res: Response,
  error: { code?: string; message?: string },
): void {
  const code = error.code ?? "";
  if (code === "42501" || code === "PGRST301") {
    fail(res, 403, "ليست لديك صلاحية قراءة طلبات الخدمات.");
  } else if (code === "PGRST202" || code === "42883") {
    fail(res, 503, "مخطط طلبات الخدمات غير متاح أو غير متوافق بعد.");
  } else if (code === "P0002") {
    fail(res, 404, "طلب الخدمة غير موجود أو لم يعد متاحًا.");
  } else if (["23505", "23514", "40001", "55000"].includes(code)) {
    fail(res, 409, "تغيّرت حالة الطلب. حدّث السجل قبل المتابعة.");
  } else if (code === "22023" || code === "22003") {
    fail(res, 400, "تحقق من مرشحات طلبات الخدمات.");
  } else {
    fail(res, 500, "تعذر تحميل طلبات الخدمات الآن.");
  }
}

async function readServiceOrders(
  req: Request,
  res: Response,
  orderId?: string,
): Promise<void> {
  setNoStore(res);
  if (Object.keys(req.query).some((key) => !ALLOWED_QUERY_KEYS.has(key))) {
    fail(res, 400, "تتضمن المرشحات حقولًا غير مدعومة.");
    return;
  }
  if (orderId !== undefined && !UUID_RE.test(orderId)) {
    fail(res, 400, "معرّف طلب الخدمة غير صالح.");
    return;
  }

  const page = parseInteger(req.query["page"], 1, 100_000);
  const pageSize = parseInteger(req.query["pageSize"], 20, 50);
  const statusValue = req.query["status"];
  const searchValue = req.query["search"];
  if (
    page === null ||
    pageSize === null ||
    (statusValue !== undefined &&
      (typeof statusValue !== "string" || !STATUS_FILTERS.has(statusValue))) ||
    (searchValue !== undefined &&
      (typeof searchValue !== "string" || searchValue.length > 160))
  ) {
    fail(res, 400, "تحقق من رقم الصفحة والحالة وعبارة البحث.");
    return;
  }

  const session = await requireSession(req, res);
  if (!session) return;

  const filters: Record<string, unknown> = {
    view: "central",
    page,
    pageSize,
  };
  if (orderId) filters["orderId"] = orderId;
  if (typeof statusValue === "string" && statusValue) filters["status"] = statusValue;
  if (typeof searchValue === "string" && searchValue.trim()) {
    filters["search"] = searchValue.trim();
  }

  const rpc = session.supabase.rpc as unknown as (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<RpcResult>;
  const { data, error } = await rpc.call(session.supabase, "petro_service_orders_query", {
    p_filters: filters,
  });
  if (error) {
    mapServiceOrderError(res, error);
    return;
  }
  if (!isRecord(data)) {
    fail(res, 502, "أعاد الخادم سجل طلبات غير صالح.");
    return;
  }
  res.status(200).json(data);
}

router.get("/admin/service-orders", (req, res) => readServiceOrders(req, res));
router.get("/admin/service-orders/:orderId", (req, res) =>
  readServiceOrders(req, res, req.params["orderId"]),
);

export default router;
