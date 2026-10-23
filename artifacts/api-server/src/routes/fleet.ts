import { createHash, createHmac, randomUUID } from "node:crypto";
import type { Cell, Workbook, Worksheet } from "exceljs";
import express, { Router, type IRouter, type Request, type Response } from "express";
import {
  ApplyAdminFleetImportBody,
  CreateAdminFleetDocumentUploadIntentBody,
  ExecuteAdminFleetCommandBody,
  GetAdminFleetCardsQueryParams,
  GetAdminFleetCardsResponse,
  GetAdminFleetCompanySummariesQueryParams,
  GetAdminFleetCatalogQueryParams,
  SetAdminFleetConsumptionRateBody,
  RevealAdminFleetDriverPairPinBody,
  RevealAdminFleetDriverPairPinResponse,
  VerifyAdminFleetDriverPairBody,
} from "@workspace/api-zod";
import { requireSession } from "./management";
import { isRecord, setNoStore } from "../lib/supabaseServer";
import { decryptFleetPairPin, encryptFleetPairPin } from "../lib/fleetPinCrypto";

const router: IRouter = Router();
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type FleetSession = NonNullable<Awaited<ReturnType<typeof requireSession>>>;
type RpcResult = { data: unknown; error: { message?: string; code?: string } | null };
type JsonRecord = Record<string, unknown>;
type ImportIssue = { sheet: string; row: number; field: string; message: string };

function fail(res: Response, status: number, message: string, code?: string): void {
  res.status(status).json({ message, ...(code ? { code } : {}) });
}

function mapError(res: Response, error: { message?: string; code?: string }): void {
  const code = error.code ?? "";
  const message = error.message ?? "";
  const conflictCodes = new Set(["23505", "23514", "40001", "55000"]);
  const status = code === "42501" ? 403 : code === "P0002" ? 404 : code === "22023" ? 400 : conflictCodes.has(code) ? 409 : 500;
  const safeMessage = status === 403
    ? "ليست لديك صلاحية تنفيذ هذا الإجراء."
    : status === 404
      ? "السجل المطلوب غير موجود أو لم يعد متاحًا."
      : status === 400
        ? "راجع الحقول المطلوبة ثم أعد المحاولة."
        : status === 409
          ? message.includes("FLEET_MOVE_HAS_OPEN_RESERVATIONS")
            ? "لا يمكن نقل المركبة مع حجز خدمة قائم؛ أكمل الحجز أو أفرجه أولًا."
            : "تعذر تنفيذ الإجراء بسبب تعارض أو شرط غير مستوفى."
          : "تعذر إكمال الطلب الآن.";
  fail(res, status, safeMessage, message.split(":")[0]?.slice(0, 80));
}

function getRpc(session: FleetSession) {
  return session.supabase.rpc as unknown as (
    name: string,
    parameters?: Record<string, unknown>,
  ) => Promise<RpcResult>;
}

async function callRpc(
  session: FleetSession,
  functionName: string,
  args?: Record<string, unknown>,
): Promise<RpcResult> {
  return getRpc(session).call(session.supabase, functionName, args);
}

function safeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function fleetHmacSecret(): string | null {
  const value = process.env["SESSION_SECRET"];
  return typeof value === "string" && value.length >= 32 ? value : null;
}

function pairPinDigest(vehicleId: string, pinCode: string): string {
  const secret = fleetHmacSecret();
  if (!secret) throw new Error("FLEET_PIN_SECRET_UNAVAILABLE");
  return createHmac("sha256", secret)
    .update("pertomax-eg:fleet:driver-pair:v1\0")
    .update(vehicleId.toLowerCase())
    .update("\0")
    .update(pinCode)
    .digest("hex");
}

function credentialToken(requestId: string, idempotencyKey: string): string {
  const secret = fleetHmacSecret();
  if (!secret) throw new Error("FLEET_PIN_SECRET_UNAVAILABLE");
  return createHmac("sha256", secret)
    .update("pertomax-eg:fleet:credential:v1\0")
    .update(requestId.toLowerCase())
    .update("\0")
    .update(idempotencyKey)
    .digest("base64url");
}

function validateCommandPayload(action: string, payload: JsonRecord): string | null {
  const required = (names: string[]) => names.every((name) => safeString(payload[name]));
  const uuid = (name: string) => {
    const value = safeString(payload[name]);
    return Boolean(value && UUID_RE.test(value));
  };
  if (action === "vehicle.create" || action === "vehicle.update") {
    if (!required(["plateOriginal", "plateStandard", "category", "vehicleType", "brand", "model", "fuelType"])) {
      return "أكمل بيانات المركبة المطلوبة.";
    }
    if (action === "vehicle.create" && (!uuid("organizationId") || !uuid("branchId"))) return "اختر الشركة والفرع.";
    if (action === "vehicle.update" && (!uuid("vehicleId") || !safeString(payload.expectedVersion))) return "تعذر التحقق من نسخة المركبة.";
    if (safeString(payload.modelYear) && !/^\d{4}$/.test(String(payload.modelYear))) return "سنة الصنع غير صالحة.";
  }
  if (action === "vehicle.move" && (!uuid("vehicleId") || !uuid("targetBranchId") || !safeString(payload.expectedVersion))) {
    return "حدد المركبة والفرع الجديد.";
  }
  if (action === "vehicle.status" && (
    !uuid("vehicleId")
    || !safeString(payload.expectedVersion)
    || !["active", "suspended", "inactive"].includes(String(payload.status))
  )) {
    return "حالة المركبة غير صالحة.";
  }
  if (action === "driver.create" || action === "driver.update") {
    if (action === "driver.create" && !required(["fullName"])) return "أدخل اسم السائق.";
    if (action === "driver.update" && !required(["driverCode", "fullName"])) return "أكمل بيانات السائق المطلوبة.";
    if (action === "driver.create" && !uuid("organizationId")) return "اختر الشركة.";
    if (action === "driver.update" && (!uuid("driverId") || !safeString(payload.expectedVersion))) return "تعذر التحقق من نسخة السائق.";
  }
  if (action === "driver.link.create") {
    if (!uuid("vehicleId") || !uuid("driverId")) return "اختر المركبة والسائق من القوائم.";
    const startsAt = safeString(payload.startsAt);
    if (startsAt && (!Number.isFinite(new Date(startsAt).getTime()) || new Date(startsAt).getTime() > Date.now())) {
      return "تاريخ بداية الإسناد غير صالح.";
    }
    if (!/^\d{4}$/.test(String(payload.pinCode ?? ""))) {
      return "يجب تعيين رمز سري من أربعة أرقام مع ربط السائق بالمركبة.";
    }
  }
  if (action === "driver.pin.rotate" && (!uuid("linkId") || !uuid("vehicleId") || !/^\d{4}$/.test(String(payload.pinCode ?? "")))) {
    return "أدخل كودًا جديدًا من أربعة أرقام.";
  }
  if ((action === "driver.link.end" && !uuid("linkId")) ||
      (action === "driver.status" && (
        !uuid("driverId")
        || !safeString(payload.expectedVersion)
        || !["active", "suspended", "inactive"].includes(String(payload.status))
      ))) {
    return "تعذر تحديد سجل السائق أو حالته.";
  }
  if (action === "credential.activate_qr" || action === "credential.activate_nfc") {
    if (!uuid("requestId")) return "تعذر تحديد طلب البطاقة.";
  }
  if (action === "import.preview" || action === "import.apply") {
    return "استخدم مسار استيراد ملف Excel المخصص.";
  }
  if (Object.keys(payload).some((key) => /^(pin|pincode|pinhmac|pinhash)$/i.test(key) && !["pinCode"].includes(key))) {
    return "لا ترسل رمزًا أو بصمة PIN مباشرة.";
  }
  return null;
}

function hmacPayload(action: string, payload: JsonRecord): JsonRecord {
  const result = { ...payload };
  if (action === "driver.link.create" || action === "driver.pin.rotate") {
    const pinCode = String(result["pinCode"] ?? "");
    const vehicleId = String(result["vehicleId"] ?? "");
    delete result["pinCode"];
    if (!/^\d{4}$/.test(pinCode)) throw new Error("FLEET_PIN_INVALID");
    const encryptedPin = encryptFleetPairPin(vehicleId, pinCode);
    result["pinHmac"] = pairPinDigest(vehicleId, pinCode);
    result["pinCiphertext"] = encryptedPin.ciphertext;
    result["pinKeyVersion"] = encryptedPin.keyVersion;
  }
  return result;
}

router.get("/admin/fleet/catalog", async (req: Request, res: Response) => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const parsed = GetAdminFleetCatalogQueryParams.safeParse(req.query);
  if (!parsed.success) return fail(res, 400, "معايير البحث غير صالحة.");
  const { view, ...filters } = parsed.data;
  const { data, error } = await callRpc(session, "petro_admin_fleet_catalog", {
    p_view: view,
    p_filters: filters,
  });
  if (error) return mapError(res, error);
  res.json(data ?? {});
});

router.get("/admin/fleet/company-summaries", async (req: Request, res: Response) => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const parsed = GetAdminFleetCompanySummariesQueryParams.safeParse(req.query);
  if (!parsed.success) return fail(res, 400, "معايير عرض الشركات والفروع غير صالحة.");
  const { data, error } = await callRpc(session, "petro_admin_fleet_company_summaries", {
    p_organization_id: parsed.data.organizationId ?? null,
    p_query: parsed.data.query ?? null,
    p_page: parsed.data.page,
    p_page_size: parsed.data.pageSize,
  });
  if (error) return mapError(res, error);
  res.json(data ?? {});
});

router.get("/admin/fleet/drivers/:driverId", async (req: Request, res: Response) => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const driverId = safeString(req.params["driverId"]);
  if (!driverId || !UUID_RE.test(driverId)) return fail(res, 400, "حدد سجل السائق من القائمة.");
  const { data, error } = await callRpc(session, "petro_admin_fleet_driver_detail", {
    p_driver_id: driverId,
  });
  if (error) return mapError(res, error);
  res.json(data ?? {});
});

router.get("/admin/fleet/consumption-rates", async (req: Request, res: Response) => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const organizationId = safeString(req.query["organizationId"]);
  const branchId = safeString(req.query["branchId"]);
  if (!organizationId || !UUID_RE.test(organizationId) || (branchId && !UUID_RE.test(branchId))) {
    return fail(res, 400, "اختر الشركة والفرع من السجل.");
  }
  const { data, error } = await callRpc(session, "petro_admin_fleet_consumption_rates", {
    p_organization_id: organizationId,
    p_branch_id: branchId ?? null,
  });
  if (error) return mapError(res, error);
  res.json(data ?? {});
});

router.post("/admin/fleet/consumption-rates", async (req: Request, res: Response) => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const parsed = SetAdminFleetConsumptionRateBody.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "بيانات معدل الاستهلاك غير صالحة.");
  const { data, error } = await callRpc(session, "petro_admin_fleet_set_consumption_rate", {
    p_organization_id: parsed.data.organizationId,
    p_branch_id: parsed.data.branchId,
    p_liters_per_100km: parsed.data.litersPer100Km,
    p_reason: parsed.data.reason,
    p_idempotency_key: parsed.data.idempotencyKey,
  });
  if (error) return mapError(res, error);
  res.status(201).json(data ?? {});
});

router.get("/admin/fleet/subscription-options", async (req: Request, res: Response) => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const rawOrganizationId = safeString(req.query["organizationId"]);
  const search = safeString(req.query["search"]) ?? null;
  const rawPage = safeString(req.query["page"]) ?? "1";
  const rawPageSize = safeString(req.query["pageSize"]) ?? "20";
  const page = /^\d{1,6}$/.test(rawPage) ? Number(rawPage) : NaN;
  const pageSize = /^\d{1,3}$/.test(rawPageSize) ? Number(rawPageSize) : NaN;
  if ((rawOrganizationId && !UUID_RE.test(rawOrganizationId))
      || (search !== null && search.length > 160)
      || !Number.isInteger(page) || page < 1
      || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    return fail(res, 400, "معايير اختيار الاشتراك غير صالحة.");
  }
  const { data, error } = await callRpc(session, "petro_admin_fleet_subscription_options", {
    p_organization_id: rawOrganizationId ?? null,
    p_search: search,
    p_page: page,
    p_page_size: pageSize,
  });
  if (error) return mapError(res, error);
  res.json(data ?? {});
});

router.get("/admin/fleet/cards", async (req: Request, res: Response): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const parsed = GetAdminFleetCardsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    fail(res, 400, "معايير إدارة البطاقات غير صالحة.");
    return;
  }
  const filters = {
    organizationId: parsed.data.organizationId ?? null,
    vehicleId: parsed.data.vehicleId ?? null,
    status: parsed.data.status ?? null,
    search: parsed.data.search ?? null,
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
  };
  const { data, error } = parsed.data.view === "history"
    ? await callRpc(session, "petro_admin_fleet_card_history", { p_filters: filters })
    : await callRpc(session, "petro_admin_fleet_cards_catalog", {
        p_view: parsed.data.view,
        p_filters: filters,
      });
  if (error) {
    mapError(res, error);
    return;
  }
  const response = GetAdminFleetCardsResponse.safeParse(data ?? {});
  if (!response.success) {
    req.log.error({ error: response.error.message }, "Fleet card query returned an invalid response");
    fail(res, 502, "تعذر قراءة بيانات إدارة البطاقات.");
    return;
  }
  res.json(response.data);
});

router.get("/admin/fleet/stock-options", async (req: Request, res: Response) => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const search = safeString(req.query["search"]) ?? null;
  const rawPage = safeString(req.query["page"]) ?? "1";
  const rawPageSize = safeString(req.query["pageSize"]) ?? "20";
  const page = /^\d{1,6}$/.test(rawPage) ? Number(rawPage) : NaN;
  const pageSize = /^\d{1,3}$/.test(rawPageSize) ? Number(rawPageSize) : NaN;
  if ((search !== null && search.length > 160)
      || !Number.isInteger(page) || page < 1
      || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    return fail(res, 400, "معايير اختيار وحدة الشريحة غير صالحة.");
  }
  const { data, error } = await callRpc(session, "petro_admin_fleet_stock_options", {
    p_search: search,
    p_page: page,
    p_page_size: pageSize,
  });
  if (error) return mapError(res, error);
  res.json(data ?? {});
});

router.get("/admin/fleet/stock-reservations", async (req: Request, res: Response) => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const search = safeString(req.query["search"]) ?? null;
  const pageValue = safeString(req.query["page"]);
  const pageSizeValue = safeString(req.query["pageSize"]);
  const page = pageValue === undefined ? 1 : Number(pageValue);
  const pageSize = pageSizeValue === undefined ? 20 : Number(pageSizeValue);
  if (
    (search !== null && search.length > 160)
    || !Number.isInteger(page) || page < 1 || page > 100000
    || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100
  ) {
    return fail(res, 400, "معايير البحث عن وحدات التعريف المحجوزة غير صالحة.");
  }
  const { data, error } = await callRpc(session, "petro_admin_fleet_stock_reservations", {
    p_search: search,
    p_page: page,
    p_page_size: pageSize,
  });
  if (error) return mapError(res, error);
  res.json(data ?? {});
});

router.post("/admin/fleet/commands", async (req: Request, res: Response) => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const parsed = ExecuteAdminFleetCommandBody.safeParse(req.body);
  if (!parsed.success || !isRecord(parsed.data.payload)) return fail(res, 400, "صيغة الأمر غير صالحة.");
  const { action, reason, idempotencyKey } = parsed.data;
  const payload = { ...parsed.data.payload };
  if (action === "driver.create" && !safeString(payload.driverCode)) {
    const organizationId = safeString(payload.organizationId);
    payload.driverCode = `AUTO-${createHash("sha256")
      .update("fleet-driver-code\0")
      .update(organizationId)
      .update("\0")
      .update(idempotencyKey)
      .digest("hex")
      .slice(0, 24)
      .toUpperCase()}`;
  }
  const payloadError = validateCommandPayload(action, payload);
  if (payloadError) return fail(res, 400, payloadError);

  let oneTimeToken: string | undefined;
  let rpcPayload: JsonRecord;
  try {
    rpcPayload = hmacPayload(action, payload);
    if (action === "credential.activate_qr" || action === "credential.activate_nfc") {
      oneTimeToken = credentialToken(String(payload["requestId"]), idempotencyKey);
      const tokenSha256 = createHash("sha256").update(oneTimeToken).digest("hex");
      rpcPayload["tokenSha256"] = tokenSha256;
      rpcPayload["tokenHint"] = tokenSha256.slice(0, 6);
    }
  } catch {
    return fail(res, 503, "تعذر تجهيز العملية الآمنة. راجع إعدادات الخدمة.");
  }
  const { data, error } = action === "coverage.assign"
    ? await callRpc(session, "petro_admin_fleet_assign_coverage", {
        p_payload: rpcPayload,
        p_reason: reason,
        p_idempotency_key: idempotencyKey,
      })
    : await callRpc(session, "petro_admin_fleet_command", {
        p_action: action,
        p_payload: rpcPayload,
        p_reason: reason,
        p_idempotency_key: idempotencyKey,
      });
  if (error) return mapError(res, error);
  res.json({
    ...(isRecord(data) ? data : {}),
    ...(oneTimeToken ? { oneTimeToken } : {}),
  });
});

router.post("/admin/fleet/driver-pairs/verify", async (req: Request, res: Response) => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const parsed = VerifyAdminFleetDriverPairBody.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "أدخل رمزًا صحيحًا من أربعة أرقام.");
  let pinHmac: string;
  try {
    pinHmac = pairPinDigest(parsed.data.vehicleId, parsed.data.pinCode);
  } catch {
    return fail(res, 503, "تعذر تجهيز التحقق الآمن.");
  }
  const { data, error } = await callRpc(session, "petro_admin_fleet_verify_driver_pair", {
    p_link_id: parsed.data.linkId,
    p_pin_hmac: pinHmac,
  });
  if (error) return mapError(res, error);
  res.json(data ?? { valid: false, locked: false });
});

router.post("/admin/fleet/driver-pairs/reveal", async (req: Request, res: Response): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const parsed = RevealAdminFleetDriverPairPinBody.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, "أدخل سببًا واضحًا لعرض الرمز.");
    return;
  }
  const { data, error } = await callRpc(session, "petro_admin_fleet_pair_pin_reveal", {
    p_link_id: parsed.data.linkId,
    p_reason: parsed.data.reason,
  });
  if (error) {
    mapError(res, error);
    return;
  }
  if (!isRecord(data)) {
    fail(res, 502, "تعذر تأكيد حالة الرمز.");
    return;
  }
  if (data["resetRequired"] === true) {
    res.status(409).json({ message: "الرمز السابق لا يمكن استعادته؛ أنشئ رمزًا جديدًا لهذا الإسناد." });
    return;
  }
  const version = Number(data["keyVersion"]);
  const vehicleId = safeString(data["vehicleId"]);
  const ciphertext = safeString(data["ciphertext"]);
  if (!vehicleId || !ciphertext) {
    fail(res, 502, "تعذر قراءة بيانات الرمز المشفر.");
    return;
  }
  let pinCode: string;
  try {
    pinCode = decryptFleetPairPin(vehicleId, version, ciphertext);
  } catch {
    req.log.error({ keyVersion: version }, "Fleet PIN decryption failed");
    fail(res, 503, "تعذر فتح الرمز؛ تحقق من إعداد مفتاح التشفير وإصداره.");
    return;
  }
  const response = RevealAdminFleetDriverPairPinResponse.safeParse({
    resetRequired: false,
    pinCode,
    expiresInSeconds: 20,
  });
  if (!response.success) {
    req.log.error("Fleet PIN response validation failed");
    fail(res, 502, "تعذر تأكيد عرض الرمز.");
    return;
  }
  res.json(response.data);
});

router.post("/admin/fleet/documents/upload-intent", async (req: Request, res: Response) => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const parsed = CreateAdminFleetDocumentUploadIntentBody.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "بيانات الملف غير صالحة.");
  const { data, error } = await callRpc(session, "petro_fleet_create_vehicle_document_upload", {
    p_vehicle_id: parsed.data.vehicleId,
    p_document_type: parsed.data.documentType,
    p_file_name: parsed.data.fileName,
    p_content_type: parsed.data.contentType,
    p_byte_size: parsed.data.byteSize,
    p_expires_on: parsed.data.expiresOn ? parsed.data.expiresOn.toISOString().slice(0, 10) : null,
  });
  if (error) return mapError(res, error);
  res.status(201).json(data ?? {});
});

function cellText(cell: Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if ("text" in value && typeof value.text === "string") return value.text.trim();
    if ("result" in value) return String(value.result ?? "").trim();
    return "";
  }
  return String(value).trim();
}

function getRows(sheet: Worksheet | undefined, sheetName: string, issues: ImportIssue[]): Map<string, string>[] {
  if (!sheet) {
    issues.push({ sheet: sheetName, row: 1, field: "", message: "الورقة المطلوبة غير موجودة." });
    return [];
  }
  const headers: string[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => { headers[col - 1] = cellText(cell); });
  if (headers.some((header) => /pin|رمز\s*السائق/i.test(header))) {
    issues.push({ sheet: sheetName, row: 1, field: "", message: "ممنوع استيراد أكواد السائقين أو PIN." });
    return [];
  }
  if (headers.length === 0) {
    issues.push({ sheet: sheetName, row: 1, field: "", message: "عناوين الأعمدة غير موجودة." });
    return [];
  }
  const rows: Map<string, string>[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const values = new Map<string, string>();
    headers.forEach((header, index) => {
      if (header) values.set(header, cellText(row.getCell(index + 1)));
    });
    if ([...values.values()].some(Boolean)) rows.push(values);
  });
  return rows;
}

function addRequiredIssue(
  value: string,
  sheet: string,
  row: number,
  field: string,
  issues: ImportIssue[],
): boolean {
  if (value) return true;
  issues.push({ sheet, row, field, message: "هذا الحقل مطلوب." });
  return false;
}

function uuidCell(value: string, sheet: string, row: number, field: string, issues: ImportIssue[]): boolean {
  if (UUID_RE.test(value)) return true;
  issues.push({ sheet, row, field, message: "استخدم معرّف UUID صالحًا." });
  return false;
}

function listCell(value: string, sheet: string, row: number, field: string, issues: ImportIssue[]): string[] {
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  values.forEach((item) => uuidCell(item, sheet, row, field, issues));
  return [...new Set(values)];
}

function amountCell(value: string, sheet: string, row: number, field: string, issues: ImportIssue[], optional = false): string {
  if (!value && optional) return "0";
  if (/^\d{1,13}$/.test(value)) return value;
  issues.push({ sheet, row, field, message: "أدخل مبلغًا صحيحًا بالقرش دون فواصل." });
  return "0";
}

function quantityCell(value: string, sheet: string, row: number, field: string, issues: ImportIssue[], optional = false): string {
  if (!value && optional) return "0";
  if (/^\d{1,12}(?:\.\d{1,3})?$/.test(value)) return value;
  issues.push({ sheet, row, field, message: "أدخل كمية موجبة بدقة لا تتجاوز ثلاثة أرقام عشرية." });
  return "0";
}

function booleanCell(value: string, sheet: string, row: number, field: string, issues: ImportIssue[]): boolean {
  const normalized = value.toLowerCase();
  if (["true", "1", "yes", "نعم"].includes(normalized)) return true;
  if (["false", "0", "no", "لا"].includes(normalized)) return false;
  issues.push({ sheet, row, field, message: "استخدم نعم أو لا." });
  return false;
}

const VEHICLE_HEADERS = [
  "معرّف الشركة", "معرّف الفرع", "اللوحة الأصلية", "اللوحة القياسية", "الفئة", "النوع",
  "الماركة", "الموديل", "سنة الصنع", "رقم الشاسيه", "الرقم الداخلي", "نوع الوقود",
];
const DRIVER_HEADERS = ["معرّف الشركة", "كود السائق", "اسم السائق", "رقم الاتصال"];
const POLICY_HEADERS = [
  "النطاق", "معرّف الشركة", "معرّف الفرع", "معرّف المركبة", "السريان من",
  "أيام الأسبوع 1-7", "من الساعة", "إلى الساعة", "معرّفات جهات الخدمة",
  "معرّفات فروع الخدمة", "أقصى مبلغ للعملية بالقرش", "أقصى كمية للعملية",
  "إجمالي يومي بالقرش", "إجمالي أسبوعي بالقرش", "إجمالي شهري بالقرش",
  "إجمالي كمية يومية", "إجمالي كمية أسبوعية", "إجمالي كمية شهرية",
  "مجموعة الخدمة", "مسموح", "أقصى مبلغ للمجموعة بالقرش", "أقصى كمية للمجموعة",
  "مبلغ المجموعة اليومي بالقرش", "مبلغ المجموعة الأسبوعي بالقرش", "مبلغ المجموعة الشهري بالقرش",
  "كمية المجموعة اليومية", "كمية المجموعة الأسبوعية", "كمية المجموعة الشهرية",
];

function parseWorkbook(workbook: Workbook): { payload: JsonRecord; issues: ImportIssue[] } {
  const issues: ImportIssue[] = [];
  const vehicles: JsonRecord[] = [];
  const drivers: JsonRecord[] = [];
  const policyGroups = new Map<string, { header: JsonRecord; rules: JsonRecord[]; rows: number[] }>();
  const vehicleRows = getRows(workbook.getWorksheet("المركبات"), "المركبات", issues);
  const driverRows = getRows(workbook.getWorksheet("السائقون"), "السائقون", issues);
  const policyRows = getRows(workbook.getWorksheet("السياسات"), "السياسات", issues);
  const seenPlates = new Set<string>();
  const seenDriverCodes = new Set<string>();

  vehicleRows.forEach((row, index) => {
    const rowNumber = index + 2;
    const company = row.get(VEHICLE_HEADERS[0]!) ?? "";
    const branch = row.get(VEHICLE_HEADERS[1]!) ?? "";
    const plateOriginal = row.get(VEHICLE_HEADERS[2]!) ?? "";
    const plateStandard = row.get(VEHICLE_HEADERS[3]!) ?? "";
    ["company", "branch", "plateOriginal", "plateStandard"].forEach((key, i) => {
      const value = [company, branch, plateOriginal, plateStandard][i]!;
      addRequiredIssue(value, "المركبات", rowNumber, VEHICLE_HEADERS[i]!, issues);
    });
    uuidCell(company, "المركبات", rowNumber, VEHICLE_HEADERS[0]!, issues);
    uuidCell(branch, "المركبات", rowNumber, VEHICLE_HEADERS[1]!, issues);
    const normalizedPlate = plateStandard.toLowerCase().replace(/\s+/g, "");
    const plateKey = `${company}:${normalizedPlate}`;
    if (seenPlates.has(plateKey)) issues.push({ sheet: "المركبات", row: rowNumber, field: VEHICLE_HEADERS[3]!, message: "اللوحة مكررة في الملف." });
    seenPlates.add(plateKey);
    const modelYear = row.get(VEHICLE_HEADERS[8]!) ?? "";
    if (modelYear && !/^\d{4}$/.test(modelYear)) issues.push({ sheet: "المركبات", row: rowNumber, field: VEHICLE_HEADERS[8]!, message: "سنة الصنع غير صالحة." });
    const entry: JsonRecord = {
      organizationId: company, branchId: branch, plateOriginal, plateStandard,
      category: row.get(VEHICLE_HEADERS[4]!) ?? "", vehicleType: row.get(VEHICLE_HEADERS[5]!) ?? "",
      brand: row.get(VEHICLE_HEADERS[6]!) ?? "", model: row.get(VEHICLE_HEADERS[7]!) ?? "",
      modelYear, chassisNumber: row.get(VEHICLE_HEADERS[9]!) ?? "",
      internalCode: row.get(VEHICLE_HEADERS[10]!) ?? "", fuelType: row.get(VEHICLE_HEADERS[11]!) ?? "",
    };
    for (const key of ["category", "vehicleType", "brand", "model", "fuelType"]) {
      addRequiredIssue(String(entry[key] ?? ""), "المركبات", rowNumber, key, issues);
    }
    vehicles.push(entry);
  });

  driverRows.forEach((row, index) => {
    const rowNumber = index + 2;
    const company = row.get(DRIVER_HEADERS[0]!) ?? "";
    const driverCode = row.get(DRIVER_HEADERS[1]!) ?? "";
    const fullName = row.get(DRIVER_HEADERS[2]!) ?? "";
    addRequiredIssue(company, "السائقون", rowNumber, DRIVER_HEADERS[0]!, issues);
    addRequiredIssue(driverCode, "السائقون", rowNumber, DRIVER_HEADERS[1]!, issues);
    addRequiredIssue(fullName, "السائقون", rowNumber, DRIVER_HEADERS[2]!, issues);
    uuidCell(company, "السائقون", rowNumber, DRIVER_HEADERS[0]!, issues);
    const codeKey = `${company}:${driverCode.toLowerCase()}`;
    if (seenDriverCodes.has(codeKey)) issues.push({ sheet: "السائقون", row: rowNumber, field: DRIVER_HEADERS[1]!, message: "كود السائق مكرر في الملف." });
    seenDriverCodes.add(codeKey);
    drivers.push({ organizationId: company, driverCode, fullName, phone: row.get(DRIVER_HEADERS[3]!) ?? "" });
  });

  policyRows.forEach((row, index) => {
    const rowNumber = index + 2;
    const scope = row.get(POLICY_HEADERS[0]!) ?? "";
    const organizationId = row.get(POLICY_HEADERS[1]!) ?? "";
    const branchId = row.get(POLICY_HEADERS[2]!) ?? "";
    const vehicleId = row.get(POLICY_HEADERS[3]!) ?? "";
    const effectiveFrom = row.get(POLICY_HEADERS[4]!) ?? "";
    const weekdays = (row.get(POLICY_HEADERS[5]!) ?? "").split(",").map((value) => Number(value.trim())).filter(Number.isFinite);
    const allowedMerchantOrganizationIds = listCell(row.get(POLICY_HEADERS[8]!) ?? "", "السياسات", rowNumber, POLICY_HEADERS[8]!, issues);
    const allowedMerchantBranchIds = listCell(row.get(POLICY_HEADERS[9]!) ?? "", "السياسات", rowNumber, POLICY_HEADERS[9]!, issues);
    if (!["branch", "vehicle"].includes(scope)) issues.push({ sheet: "السياسات", row: rowNumber, field: POLICY_HEADERS[0]!, message: "استخدم branch أو vehicle." });
    uuidCell(organizationId, "السياسات", rowNumber, POLICY_HEADERS[1]!, issues);
    uuidCell(branchId, "السياسات", rowNumber, POLICY_HEADERS[2]!, issues);
    if (scope === "vehicle") uuidCell(vehicleId, "السياسات", rowNumber, POLICY_HEADERS[3]!, issues);
    addRequiredIssue(effectiveFrom, "السياسات", rowNumber, POLICY_HEADERS[4]!, issues);
    if (weekdays.length < 1 || weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
      issues.push({ sheet: "السياسات", row: rowNumber, field: POLICY_HEADERS[5]!, message: "حدد أيامًا من 1 إلى 7." });
    }
    const serviceGroup = row.get(POLICY_HEADERS[18]!) ?? "";
    if (!["fuel", "wash", "oils", "parts"].includes(serviceGroup)) {
      issues.push({ sheet: "السياسات", row: rowNumber, field: POLICY_HEADERS[18]!, message: "مجموعة الخدمة غير صالحة." });
    }
    const enabled = booleanCell(row.get(POLICY_HEADERS[19]!) ?? "", "السياسات", rowNumber, POLICY_HEADERS[19]!, issues);
    const key = [scope, organizationId, branchId, vehicleId, effectiveFrom].join("|");
    const header: JsonRecord = {
      scope, organizationId, branchId, vehicleId: vehicleId || null, effectiveFrom,
      allowedWeekdays: weekdays, startTime: row.get(POLICY_HEADERS[6]!) ?? "",
      endTime: row.get(POLICY_HEADERS[7]!) ?? "",
      allowedMerchantOrganizationIds, allowedMerchantBranchIds,
      maxOperationMinor: amountCell(row.get(POLICY_HEADERS[10]!) ?? "", "السياسات", rowNumber, POLICY_HEADERS[10]!, issues),
      maxOperationQuantity: quantityCell(row.get(POLICY_HEADERS[11]!) ?? "", "السياسات", rowNumber, POLICY_HEADERS[11]!, issues),
      dailyAmountLimitMinor: amountCell(row.get(POLICY_HEADERS[12]!) ?? "", "السياسات", rowNumber, POLICY_HEADERS[12]!, issues),
      weeklyAmountLimitMinor: amountCell(row.get(POLICY_HEADERS[13]!) ?? "", "السياسات", rowNumber, POLICY_HEADERS[13]!, issues),
      monthlyAmountLimitMinor: amountCell(row.get(POLICY_HEADERS[14]!) ?? "", "السياسات", rowNumber, POLICY_HEADERS[14]!, issues),
      dailyQuantityLimit: quantityCell(row.get(POLICY_HEADERS[15]!) ?? "", "السياسات", rowNumber, POLICY_HEADERS[15]!, issues),
      weeklyQuantityLimit: quantityCell(row.get(POLICY_HEADERS[16]!) ?? "", "السياسات", rowNumber, POLICY_HEADERS[16]!, issues),
      monthlyQuantityLimit: quantityCell(row.get(POLICY_HEADERS[17]!) ?? "", "السياسات", rowNumber, POLICY_HEADERS[17]!, issues),
    };
    const group = policyGroups.get(key) ?? { header, rules: [], rows: [] };
    const rule: JsonRecord = {
      serviceGroup, enabled,
      maxOperationMinor: amountCell(row.get(POLICY_HEADERS[20]!) ?? "", "السياسات", rowNumber, POLICY_HEADERS[20]!, issues, !enabled),
      maxOperationQuantity: quantityCell(row.get(POLICY_HEADERS[21]!) ?? "", "السياسات", rowNumber, POLICY_HEADERS[21]!, issues, !enabled),
      dailyAmountLimitMinor: amountCell(row.get(POLICY_HEADERS[22]!) ?? "", "السياسات", rowNumber, POLICY_HEADERS[22]!, issues, !enabled),
      weeklyAmountLimitMinor: amountCell(row.get(POLICY_HEADERS[23]!) ?? "", "السياسات", rowNumber, POLICY_HEADERS[23]!, issues, !enabled),
      monthlyAmountLimitMinor: amountCell(row.get(POLICY_HEADERS[24]!) ?? "", "السياسات", rowNumber, POLICY_HEADERS[24]!, issues, !enabled),
      dailyQuantityLimit: quantityCell(row.get(POLICY_HEADERS[25]!) ?? "", "السياسات", rowNumber, POLICY_HEADERS[25]!, issues, !enabled),
      weeklyQuantityLimit: quantityCell(row.get(POLICY_HEADERS[26]!) ?? "", "السياسات", rowNumber, POLICY_HEADERS[26]!, issues, !enabled),
      monthlyQuantityLimit: quantityCell(row.get(POLICY_HEADERS[27]!) ?? "", "السياسات", rowNumber, POLICY_HEADERS[27]!, issues, !enabled),
    };
    if (group.rules.some((existing) => existing["serviceGroup"] === serviceGroup)) {
      issues.push({ sheet: "السياسات", row: rowNumber, field: POLICY_HEADERS[18]!, message: "مجموعة الخدمة مكررة ضمن السياسة." });
    }
    group.rules.push(rule);
    group.rows.push(rowNumber);
    policyGroups.set(key, group);
  });

  const policies: JsonRecord[] = [];
  for (const group of policyGroups.values()) {
    if (group.rules.length !== 4) {
      issues.push({ sheet: "السياسات", row: group.rows[0] ?? 1, field: "", message: "تحتاج كل سياسة إلى صف لكل مجموعة خدمة من الأربع." });
    }
    policies.push({ ...group.header, rules: group.rules });
  }
  return { payload: { vehicles, drivers, policies }, issues };
}

router.get("/admin/fleet/imports/template", async (req: Request, res: Response) => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const access = await callRpc(session, "petro_admin_fleet_catalog", { p_view: "overview", p_filters: {} });
  if (access.error) return mapError(res, access.error);
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Pertomax EG";
  workbook.subject = "Fleet data import template";
  const instructions = workbook.addWorksheet("تعليمات");
  instructions.addRows([
    ["استيراد الأسطول في Pertomax EG"],
    ["وقت إصدار القالب", new Date().toISOString()],
    ["أدخل بيانات المركبات والسائقين والسياسات في الأوراق المخصصة ثم ارفع الملف للمعاينة."],
    ["المعرّفات المطلوبة هي UUID من بيانات الجهة والفرع؛ لا تُنشأ جهات أو فروع من هذا الملف."],
    ["المبالغ بالقرش، والكمية حتى ثلاثة أرقام عشرية. أرقام PIN ممنوعة ولا تُستورد."],
    ["معاينة الملف لا تطبق أي سجل. التطبيق لاحقًا ذري بالكامل، وكل السياسات تُنشأ كمسودات غير منشورة."],
    ["السريان الزمني للسياسات يجب ألا يكون رجعيًا؛ أيام الأسبوع مرقمة 1=الاثنين إلى 7=الأحد."],
  ]);
  const vehicleSheet = workbook.addWorksheet("المركبات");
  vehicleSheet.addRow(VEHICLE_HEADERS);
  const driverSheet = workbook.addWorksheet("السائقون");
  driverSheet.addRow(DRIVER_HEADERS);
  const policySheet = workbook.addWorksheet("السياسات");
  policySheet.addRow(POLICY_HEADERS);
  for (const sheet of [vehicleSheet, driverSheet, policySheet]) {
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).alignment = { wrapText: true, vertical: "middle" };
    sheet.getRow(1).height = 42;
    sheet.columns.forEach((column) => { column.width = 22; });
  }
  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader("Content-Type", XLSX_MIME);
  res.setHeader("Content-Disposition", 'attachment; filename="pertomax-fleet-import-template.xlsx"');
  res.status(200).send(Buffer.from(buffer));
});

router.post(
  "/admin/fleet/imports/preview",
  express.raw({ type: XLSX_MIME, limit: "10mb" }),
  async (req: Request, res: Response) => {
    setNoStore(res);
    const session = await requireSession(req, res);
    if (!session) return;
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return fail(res, 400, "ارفع ملف Excel صالحًا.");
    try {
      const { default: ExcelJS } = await import("exceljs");
      const workbook = new ExcelJS.Workbook();
      const workbookBytes = new Uint8Array(req.body).buffer as Parameters<typeof workbook.xlsx.load>[0];
      await workbook.xlsx.load(workbookBytes);
      const { payload, issues } = parseWorkbook(workbook);
      const validationErrors = issues.map((issue) => ({
        sheet: issue.sheet, row: issue.row, field: issue.field, message: issue.message,
      }));
      const { data, error } = await callRpc(session, "petro_admin_fleet_command", {
        p_action: "import.preview",
        p_payload: { ...payload, validationErrors },
        p_reason: "معاينة استيراد ملف الأسطول",
        p_idempotency_key: randomUUID(),
      });
      if (error) return mapError(res, error);
      res.json({ ...(isRecord(data) ? data : {}), issues });
    } catch {
      return fail(res, 400, "تعذر قراءة المصنف. استخدم قالب Excel المقدم وتحقق من سلامة الملف.");
    }
  },
);

router.post("/admin/fleet/imports/:jobId/apply", async (req: Request, res: Response) => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const parsed = ApplyAdminFleetImportBody.safeParse(req.body);
  const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
  if (!parsed.success || !jobId || !UUID_RE.test(jobId)) return fail(res, 400, "بيانات تطبيق الاستيراد غير صالحة.");
  const { data, error } = await callRpc(session, "petro_admin_fleet_command", {
    p_action: "import.apply",
    p_payload: { jobId },
    p_reason: parsed.data.reason,
    p_idempotency_key: parsed.data.idempotencyKey,
  });
  if (error) return mapError(res, error);
  res.json(data ?? {});
});

function cryptoRandomKey(): string {
  return randomUUID();
}

export default router;
