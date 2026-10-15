import { Router, type IRouter, type Request, type Response } from "express";
import {
  CancelAdminSubscriptionBody,
  CreateAdminBillingPlanBody,
  CreateAdminProviderPriceOverrideBody,
  CreateAdminBillingPlanVersionBody,
  CreateAdminSubscriptionRequestBody,
  PublishAdminBillingPlanVersionBody,
  ReviewAdminSubscriptionRequestBody,
  ScheduleAdminBillingPlanStopBody,
  UpdateAdminBillingPlanDraftBody,
  UpdateAdminBillingPriceDefaultsBody,
} from "@workspace/api-zod";
import { isRecord, setNoStore } from "../lib/supabaseServer";
import { requireSession, type SessionContext } from "./management";

const router: IRouter = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

async function requireOwner(req: Request, res: Response): Promise<SessionContext | null> {
  const session = await requireSession(req, res);
  if (!session) return null;
  const { data, error } = await session.supabase.rpc("petro_access_context");
  if (error || !isRecord(data)) {
    fail(res, 503, "تعذر التحقق من صلاحيات إدارة الباقات.");
    return null;
  }
  const roles = data["platform_roles"] ?? data["platformRoles"];
  if (!Array.isArray(roles) || !roles.includes("owner")) {
    fail(res, 403, "إدارة الباقات والاشتراكات متاحة لمالك المنصة فقط.");
    return null;
  }
  return session;
}

function mapBillingError(
  res: Response,
  error: { code?: string; message?: string } | null,
): void {
  if (!error) return;
  if (error.code === "42501" || error.code === "PGRST301") {
    fail(res, 403, "ليست لديك صلاحية لهذا الإجراء.");
  } else if (error.code === "PGRST202" || error.code === "42883") {
    fail(res, 503, "مخطط إدارة الباقات غير مطبق في قاعدة البيانات بعد.");
  } else if (error.code === "P0002") {
    fail(res, 404, "لم يتم العثور على السجل المطلوب.");
  } else if (["23505", "23514", "40001", "55000"].includes(error.code ?? "")) {
    fail(res, 409, "تعارضت حالة الخطة أو النطاق أو التواريخ. حدّث البيانات قبل إعادة المحاولة.");
  } else if (error.code === "22023") {
    fail(res, 400, "تحقق من الحقول والسبب المطلوب.");
  } else {
    fail(res, 500, "تعذر تنفيذ إجراء إدارة الباقات.");
  }
}

router.get("/admin/billing/catalog", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireOwner(req, res);
  if (!session) return;
  const { data, error } = await session.supabase.rpc("petro_billing_admin_catalog_v2");
  if (error) {
    mapBillingError(res, error);
    return;
  }
  if (!isRecord(data)) {
    fail(res, 503, "استجابة مخطط إدارة الباقات غير متوافقة.");
    return;
  }
  res.json(data);
});

router.post("/admin/billing/plans", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireOwner(req, res);
  if (!session) return;
  const body = parseBody(CreateAdminBillingPlanBody, req.body);
  if (!body) {
    fail(res, 400, "بيانات الخطة أو سبب الإنشاء غير صالح.");
    return;
  }
  const { data, error } = await session.supabase.rpc("petro_billing_admin_create_plan_v2", {
    p_code: body.code,
    p_audience: body.audience,
    p_name: body.name,
    p_description: body.description,
    p_price_minor: body.annualPriceMinor,
    p_billing_unit: body.billingUnit,
    p_billing_cycle: body.billingCycle,
    p_currency: body.currency,
    p_effective_at: body.effectiveAt.toISOString(),
    p_entitlements: body.entitlements,
    p_settings: body.settings,
    p_reason: body.reason,
  });
  if (error) {
    mapBillingError(res, error);
    return;
  }
  if (typeof data !== "string") {
    fail(res, 500, "لم تُرجع قاعدة البيانات معرّف الخطة.");
    return;
  }
  res.status(201).json({ id: data, status: "draft", message: "تم حفظ الخطة كمسودة بلا حقوق معتمدة." });
});

router.post("/admin/billing/plans/:planId/versions", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireOwner(req, res);
  if (!session) return;
  const planId = req.params["planId"];
  const body = parseBody(CreateAdminBillingPlanVersionBody, req.body);
  if (!validId(planId) || !body) {
    fail(res, 400, "تحقق من معرّف الخطة وبيانات النسخة وسبب التعديل.");
    return;
  }
  const { data, error } = await session.supabase.rpc("petro_billing_admin_add_plan_version_v2", {
    p_plan_id: planId,
    p_display_name: body.displayName,
    p_description: body.description,
    p_price_minor: body.annualPriceMinor,
    p_billing_unit: body.billingUnit,
    p_billing_cycle: body.billingCycle,
    p_currency: body.currency,
    p_effective_at: body.effectiveAt.toISOString(),
    p_entitlements: body.entitlements,
    p_settings: body.settings,
    p_reason: body.reason,
  });
  if (error) {
    mapBillingError(res, error);
    return;
  }
  if (typeof data !== "string") {
    fail(res, 500, "لم تُرجع قاعدة البيانات معرّف النسخة.");
    return;
  }
  res.status(201).json({ id: data, status: "draft", message: "حُفظت نسخة مسودة؛ لم تُنشر حقوق غير معتمدة." });
});

router.patch("/admin/billing/plans/:planId/versions/:versionId", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireOwner(req, res);
  if (!session) return;
  const planId = req.params["planId"];
  const versionId = req.params["versionId"];
  const body = parseBody(UpdateAdminBillingPlanDraftBody, req.body);
  if (!validId(planId) || !validId(versionId) || !body) {
    fail(res, 400, "تحقق من معرّفات الخطة والنسخة وبيانات المسودة وسبب التعديل.");
    return;
  }
  const { data, error } = await session.supabase.rpc("petro_billing_admin_update_draft_version", {
    p_plan_id: planId,
    p_version_id: versionId,
    p_display_name: body.displayName,
    p_description: body.description,
    p_price_minor: body.annualPriceMinor,
    p_billing_unit: body.billingUnit,
    p_billing_cycle: body.billingCycle,
    p_currency: body.currency,
    p_effective_at: body.effectiveAt.toISOString(),
    p_entitlements: body.entitlements,
    p_settings: body.settings,
    p_reason: body.reason,
  });
  if (error) {
    mapBillingError(res, error);
    return;
  }
  if (typeof data !== "string") {
    fail(res, 500, "لم تُرجع قاعدة البيانات معرّف النسخة.");
    return;
  }
  res.json({ id: data, status: "draft", message: "تم تحديث المسودة فقط؛ لم تتغير النسخ المنشورة أو الاشتراكات السابقة." });
});

router.patch("/admin/billing/pricing-defaults", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireOwner(req, res);
  if (!session) return;
  const body = parseBody(UpdateAdminBillingPriceDefaultsBody, req.body);
  if (!body) {
    fail(res, 400, "تحقق من أسعار الاقتراحات وسعر إصدار NFC وسبب التغيير.");
    return;
  }
  const { error } = await session.supabase.rpc("petro_billing_admin_update_price_defaults", {
    p_company_prices_minor: body.companyAnnualPricesMinor,
    p_provider_price_minor: body.providerAnnualPriceMinor,
    p_nfc_issue_price_minor: body.nfcIssuePriceMinor,
    p_reason: body.reason,
  });
  if (error) {
    mapBillingError(res, error);
    return;
  }
  res.json({ id: "billing-price-defaults", status: "updated", message: "حُفظت الأسعار الافتراضية المقترحة وNFC مستقلًا؛ لم تتغير أي خطة أو نسخة سابقة." });
});

router.post("/admin/billing/provider-price-overrides", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireOwner(req, res);
  if (!session) return;
  const body = parseBody(CreateAdminProviderPriceOverrideBody, req.body);
  if (!body) {
    fail(res, 400, "تحقق من الجهة والفرع والخطة والسعر وفترة السريان والسبب.");
    return;
  }
  const { data, error } = await session.supabase.rpc("petro_billing_admin_set_provider_price_override", {
    p_organization_id: body.organizationId,
    p_branch_id: body.branchId,
    p_plan_id: body.planId,
    p_price_minor: body.priceMinor,
    p_effective_from: body.effectiveFrom.toISOString(),
    p_effective_to: body.effectiveTo?.toISOString() ?? null,
    p_supersedes_override_id: body.supersedesOverrideId,
    p_reason: body.reason,
  });
  if (error) {
    mapBillingError(res, error);
    return;
  }
  if (typeof data !== "string") {
    fail(res, 500, "لم تُرجع قاعدة البيانات معرّف السعر المخصص.");
    return;
  }
  res.status(201).json({ id: data, status: "scheduled", message: "حُفظ السعر كفترة مستقلة دون إنشاء طلب اشتراك أو تفعيله." });
});

router.post("/admin/billing/plans/:planId/versions/:versionId/publish", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireOwner(req, res);
  if (!session) return;
  const planId = req.params["planId"];
  const versionId = req.params["versionId"];
  const body = parseBody(PublishAdminBillingPlanVersionBody, req.body);
  if (!validId(planId) || !validId(versionId) || !body) {
    fail(res, 400, "تحقق من المعرّفات وسبب النشر.");
    return;
  }
  const { data, error } = await session.supabase.rpc("petro_billing_admin_publish_plan_version", {
    p_plan_id: planId,
    p_version_id: versionId,
    p_reason: body.reason,
  });
  if (error) {
    mapBillingError(res, error);
    return;
  }
  res.json({
    id: versionId,
    status: typeof data === "string" ? data : null,
    message: "تم اعتماد النسخة وفق صلاحياتها وتاريخ سريانها.",
  });
});

router.post("/admin/billing/plans/:planId/stop", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireOwner(req, res);
  if (!session) return;
  const planId = req.params["planId"];
  const body = parseBody(ScheduleAdminBillingPlanStopBody, req.body);
  if (!validId(planId) || !body) {
    fail(res, 400, "تحقق من معرّف الخطة وتاريخ الإيقاف المستقبلي وسببه.");
    return;
  }
  const { data, error } = await session.supabase.rpc("petro_billing_admin_set_plan_stop", {
    p_plan_id: planId,
    p_stop_new_at: body.stopNewAt?.toISOString() ?? null,
    p_reason: body.reason,
  });
  if (error) {
    mapBillingError(res, error);
    return;
  }
  res.json({
    id: planId,
    status: data ? "scheduled" : "cleared",
    message: data ? "جُدول إيقاف الطلبات الجديدة؛ الاشتراكات القائمة لم تتغير." : "أُلغي موعد الإيقاف.",
  });
});

router.post("/admin/billing/subscription-requests", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireOwner(req, res);
  if (!session) return;
  const body = parseBody(CreateAdminSubscriptionRequestBody, req.body);
  if (!body) {
    fail(res, 400, "تحقق من الجهة والنطاق والخطة والتواريخ والسبب.");
    return;
  }
  const { data, error } = await session.supabase.rpc("petro_billing_admin_create_request", {
    p_organization_id: body.organizationId,
    p_branch_id: body.branchId,
    p_request_type: body.requestType,
    p_current_subscription_id: body.currentSubscriptionId,
    p_plan_id: body.planId,
    p_plan_version_id: body.planVersionId,
    p_requested_price_minor: null,
    p_starts_at: body.startsAt.toISOString(),
    p_ends_at: body.endsAt.toISOString(),
    p_coverage_note: body.coverageNote,
    p_reason: body.reason,
    p_submit: body.submit,
  });
  if (error) {
    mapBillingError(res, error);
    return;
  }
  if (typeof data !== "string") {
    fail(res, 500, "لم تُرجع قاعدة البيانات معرّف الطلب.");
    return;
  }
  res.status(201).json({
    id: data,
    status: body.submit ? "submitted" : "draft",
    message: body.submit ? "أُرسل الطلب للمراجعة." : "حُفظ الطلب كمسودة.",
  });
});

router.post("/admin/billing/subscription-requests/:requestId/review", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireOwner(req, res);
  if (!session) return;
  const requestId = req.params["requestId"];
  const body = parseBody(ReviewAdminSubscriptionRequestBody, req.body);
  if (!validId(requestId) || !body) {
    fail(res, 400, "تحقق من معرّف الطلب وقرار المراجعة وسببه.");
    return;
  }
  const { data, error } = await session.supabase.rpc("petro_billing_admin_review_request", {
    p_request_id: requestId,
    p_decision: body.decision,
    p_reason: body.reason,
  });
  if (error) {
    mapBillingError(res, error);
    return;
  }
  const resultId = typeof data === "string" ? data : requestId;
  const status = body.decision === "approve" ? "approved" : body.decision;
  res.json({
    id: resultId,
    status,
    message: body.decision === "approve"
      ? "سُجلت الموافقة؛ الاشتراك المدفوع ينتظر ربط التحصيل المالي ولا يعد مدفوعًا."
      : "حُفظ قرار مراجعة الطلب وسببه.",
  });
});

router.post("/admin/billing/subscriptions/:subscriptionId/cancel", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireOwner(req, res);
  if (!session) return;
  const subscriptionId = req.params["subscriptionId"];
  const body = parseBody(CancelAdminSubscriptionBody, req.body);
  if (!validId(subscriptionId) || !body) {
    fail(res, 400, "تحقق من معرّف الاشتراك وتاريخ الإلغاء وسببه.");
    return;
  }
  const { data, error } = await session.supabase.rpc("petro_billing_admin_cancel_subscription", {
    p_subscription_id: subscriptionId,
    p_effective_at: body.effectiveAt.toISOString(),
    p_reason: body.reason,
  });
  if (error) {
    mapBillingError(res, error);
    return;
  }
  res.json({
    id: subscriptionId,
    status: typeof data === "string" ? data : null,
    message: "جُدول الإلغاء دون تغيير نسخة السعر أو الحقوق المحفوظة.",
  });
});

export default router;
