import { Router, type IRouter, type Request, type Response } from "express";
import { isRecord, setNoStore } from "../lib/supabaseServer";
import { requireSession } from "./management";

const router: IRouter = Router();
const ALLOWED_QUERY_KEYS = new Set(["page", "pageSize", "action", "from", "to"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DETAIL_KEYS: Record<string, string[]> = {
  "organization.operational_status_changed": ["before", "after"],
  "organization.approved": ["approval_before", "approval_after", "operational_status"],
  "organization.created": ["approval_status", "kind", "code"],
  "branch.created": ["approval_status", "code"],
  "organization.document.approve": ["document_type", "version"],
  "catalog.fuel_type.updated": ["status"],
};

type AuditRow = {
  id: string | number;
  actor_id: string;
  organization_id: string | null;
  action: string;
  target_id: string | null;
  detail: unknown;
  occurred_at: string;
};

function fail(res: Response, status: number, message: string): void {
  res.status(status).json({ message });
}

function parseInteger(value: unknown, fallback: number, max: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : null;
}

function parseDateBoundary(value: unknown, endOfDay = false): string | null | undefined {
  if (value === undefined) return null;
  if (typeof value !== "string" || !DATE_RE.test(value)) return undefined;
  const timestamp = new Date(value + (endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z"));
  if (Number.isNaN(timestamp.valueOf()) || timestamp.toISOString().slice(0, 10) !== value) {
    return undefined;
  }
  return timestamp.toISOString();
}

function safeDetail(action: string, detail: unknown): Record<string, string | number | boolean> {
  if (!isRecord(detail)) return {};
  const allowed = DETAIL_KEYS[action] ?? [];
  const safe: Record<string, string | number | boolean> = {};
  for (const key of allowed) {
    const value = detail[key];
    if (typeof value === "string" && value.length <= 80) safe[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
    else if (typeof value === "boolean") safe[key] = value;
  }
  return safe;
}

function mapDbError(res: Response, code: string | undefined): void {
  if (code === "42501" || code === "PGRST301") {
    fail(res, 403, "لا تملك صلاحية قراءة سجل التدقيق المركزي.");
  } else {
    fail(res, 503, "تعذر تحميل سجل التدقيق الآن.");
  }
}

router.get("/admin/audit-events", async (req: Request, res: Response): Promise<void> => {
  setNoStore(res);
  if (Object.keys(req.query).some((key) => !ALLOWED_QUERY_KEYS.has(key))) {
    fail(res, 400, "تتضمن المرشحات حقولًا غير مدعومة.");
    return;
  }

  const page = parseInteger(req.query["page"], 1, 100_000);
  const pageSize = parseInteger(req.query["pageSize"], 20, 50);
  const action = req.query["action"];
  const from = parseDateBoundary(req.query["from"]);
  const to = parseDateBoundary(req.query["to"], true);
  if (
    page === null ||
    pageSize === null ||
    (action !== undefined &&
      (typeof action !== "string" || !/^[a-z][a-z0-9_.-]{0,99}$/.test(action))) ||
    from === undefined ||
    to === undefined ||
    (from && to && from > to)
  ) {
    fail(res, 400, "تحقق من الصفحة ورمز العملية وفترة البحث.");
    return;
  }

  const session = await requireSession(req, res);
  if (!session) return;

  const { data: accessContext, error: accessError } = await session.supabase.rpc("petro_access_context");
  if (accessError) {
    mapDbError(res, accessError.code);
    return;
  }
  if (!isRecord(accessContext)) {
    fail(res, 503, "تعذر تحميل صلاحيات الحساب.");
    return;
  }
  const roles = accessContext["platform_roles"];
  if (!Array.isArray(roles) || !roles.some((role) => role === "owner" || role === "auditor")) {
    fail(res, 403, "لا تملك صلاحية قراءة سجل التدقيق المركزي.");
    return;
  }

  let query = session.supabase
    .from("petro_audit_events")
    .select("id,actor_id,organization_id,action,target_id,detail,occurred_at", { count: "exact" });
  if (typeof action === "string") query = query.eq("action", action);
  if (from) query = query.gte("occurred_at", from);
  if (to) query = query.lte("occurred_at", to);

  const start = (page - 1) * pageSize;
  const { data, error, count } = await query
    .order("occurred_at", { ascending: false })
    .order("id", { ascending: false })
    .range(start, start + pageSize - 1);
  if (error) {
    mapDbError(res, error.code);
    return;
  }
  if (!Array.isArray(data)) {
    fail(res, 502, "أعاد الخادم سجل تدقيق غير صالح.");
    return;
  }

  const items = (data as unknown as AuditRow[]).map((row) => ({
    id: String(row.id),
    actorId: row.actor_id,
    organizationId: row.organization_id,
    action: row.action,
    targetId: row.target_id,
    occurredAt: row.occurred_at,
    detail: safeDetail(row.action, row.detail),
  }));
  res.status(200).json({ items, total: count ?? 0, page, pageSize });
});

export default router;
