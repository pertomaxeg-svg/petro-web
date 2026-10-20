import { cloneElement, isValidElement, useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, BadgeCheck, ClipboardList, FileText, Fuel, Gauge, ImagePlus, LockKeyhole,
  Plus, RefreshCw, Search, ShieldCheck, Truck, UserRound, Wrench, Upload, X,
} from "lucide-react";
import {
  getDownloadAdminFleetImportTemplateQueryKey, getGetAdminFleetCatalogQueryKey, getGetAdminFleetCompanySummariesQueryKey,
  getGetAdminFleetDriverDetailQueryKey, getGetAdminFleetStockReservationsQueryKey,
  useApplyAdminFleetImport, useCreateAdminFleetDocumentUploadIntent,
  useDownloadAdminFleetImportTemplate,
  useGetAdminFleetCompanySummaries,
  useExecuteAdminFleetCommand, useGetAdminFleetCatalog, useGetAdminFleetDriverDetail,
  useGetAdminFleetStockReservations, usePreviewAdminFleetImport,
} from "@workspace/api-client-react";
import type { GetAdminFleetCatalogParams, GetAdminFleetCompanySummariesParams, GetAdminFleetStockReservationsParams } from "@workspace/api-client-react";
import { FleetReferencePicker } from "./FleetReferencePicker";
import { FleetDirectory, FleetFuelRate } from "./FleetDirectory";
import "./FleetAdmin.css";

type Row = Record<string, unknown>;
type View = GetAdminFleetCatalogParams["view"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const referenceKinds: Record<string, "organization" | "branch" | "vehicle" | "driver" | "subscription" | "request" | "credential" | "policy" | "coverage" | "document" | "odometer" | "maintenance" | "link" | "platformUser" | "stockUnit"> = {
  organizationId: "organization", branchId: "branch", targetBranchId: "branch",
  vehicleId: "vehicle", driverId: "driver", subscriptionId: "subscription",
  requestId: "request", credentialId: "credential", previousCredentialId: "credential",
  policyVersionId: "policy", assignmentId: "coverage", proofDocumentId: "document",
  evidenceDocumentId: "document", supersedesEventId: "odometer", eventId: "odometer",
  maintenanceId: "maintenance", odometerEventId: "odometer", documentId: "document",
  linkId: "link", assignedTo: "platformUser", stockUnitId: "stockUnit",
};
const views: Array<{ path: string; view: View; title: string; icon: ReactNode }> = [
  { path: "/admin/fleet", view: "overview", title: "الشركات", icon: <ClipboardList size={17}/> },
  { path: "/admin/fleet/vehicles", view: "vehicles", title: "المركبات", icon: <Truck size={17}/> },
  { path: "/admin/fleet/drivers", view: "drivers", title: "السائقون", icon: <UserRound size={17}/> },
  { path: "/admin/fleet/policies", view: "policies", title: "السياسات", icon: <ShieldCheck size={17}/> },
  { path: "/admin/fleet/coverage", view: "coverage", title: "التغطية", icon: <BadgeCheck size={17}/> },
  { path: "/admin/fleet/credentials", view: "credentials", title: "رموز التعريف", icon: <LockKeyhole size={17}/> },
  { path: "/admin/fleet/documents", view: "documents", title: "المستندات", icon: <FileText size={17}/> },
  { path: "/admin/fleet/odometer", view: "odometer", title: "قراءة العداد", icon: <Gauge size={17}/> },
  { path: "/admin/fleet/maintenance", view: "maintenance", title: "الصيانة", icon: <Wrench size={17}/> },
  { path: "/admin/fleet/imports", view: "imports", title: "الاستيراد", icon: <Upload size={17}/> },
];
const policyGroups = [
  { id: "fuel", title: "الوقود" },
  { id: "wash", title: "الغسيل" },
  { id: "oils", title: "الزيوت" },
  { id: "parts", title: "قطع الغيار" },
];
const policyRuleLimits = [
  ["maxOperationMinor", "أقصى مبلغ للعملية بالقرش"],
  ["maxOperationQuantity", "أقصى كمية للعملية"],
  ["dailyAmountLimitMinor", "حد المبلغ اليومي بالقرش"],
  ["weeklyAmountLimitMinor", "حد المبلغ الأسبوعي بالقرش"],
  ["monthlyAmountLimitMinor", "حد المبلغ الشهري بالقرش"],
  ["dailyQuantityLimit", "حد الكمية اليومي"],
  ["weeklyQuantityLimit", "حد الكمية الأسبوعي"],
  ["monthlyQuantityLimit", "حد الكمية الشهري"],
] as const;
const fields = (obj: unknown): Row => obj && typeof obj === "object" && !Array.isArray(obj) ? obj as Row : {};
const get = (row: Row, ...keys: string[]) => keys.map(key => row[key]).find(value => value !== undefined && value !== null);
const text = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value) : "—";
const hiddenSensitiveKey = /pin|hmac|token|storage|object.?path|paymentstate|issuepriceminor|waiverreason|api.?key/i;
const isHiddenKey = (key: string) => key === "id" || key.endsWith("Id") || key.endsWith("_id") || key.startsWith("id_") || (hiddenSensitiveKey.test(key) && key !== "tokenHint");
function safeRows(data: unknown, view: View): Row[] {
  const root = fields(data);
  if (view === "vehicle" && root.vehicle && typeof root.vehicle === "object") return [fields(root.vehicle)];
  const preferred = [view, view === "vehicles" ? "items" : "", "items", "records", "results", "data"];
  for (const key of preferred) {
    const value = root[key];
    if (Array.isArray(value)) return value.map(fields);
    if (value && typeof value === "object") {
      const nested = fields(value);
      const inner = nested.items ?? nested.records;
      if (Array.isArray(inner)) return inner.map(fields);
    }
  }
  if (Array.isArray(data)) return data.map(fields);
  return [];
}
const titles: Record<string, string> = {
  active: "نشط", inactive: "غير نشط", suspended: "موقوف", draft: "مسودة", published: "منشور",
  pending: "قيد المراجعة", approved: "معتمد", rejected: "مرفوض", covered: "مغطاة", uncovered: "غير مغطاة",
  eligible: "مؤهل", ineligible: "غير مؤهل", installed: "مثبت", assigned: "مخصص", stopped: "متوقف",
  valid: "ساري", expired: "منتهي", submitted: "مرسل", needs_review: "بحاجة إلى مراجعة",
  requested: "مطلوب", scheduled: "مجدول", pending_review: "بانتظار المراجعة", ended: "منتهٍ",
  cancelled: "ملغي", revoked: "ملغى", available: "متاح", reserved: "محجوز", damaged: "تالف",
  company: "شركة", branch: "فرع", vehicle: "مركبة", qr: "QR", nfc: "NFC",
  needs_completion: "يحتاج استكمالًا", not_required: "غير مطلوب",
  vehicle_created: "إنشاء مركبة", vehicle_updated: "تعديل مركبة", vehicle_moved: "نقل مركبة",
  vehicle_status_changed: "تغيير حالة مركبة", driver_created: "إنشاء سائق", driver_updated: "تعديل سائق",
  driver_status_changed: "تغيير حالة سائق", driver_link_created: "ربط سائق", driver_link_ended: "إنهاء ربط سائق",
  pair_pin_set: "تعيين رمز ربط", pair_pin_rotated: "تغيير رمز ربط",
  gasoline: "بنزين", petrol: "بنزين", diesel: "سولار", natural_gas: "غاز طبيعي",
  fuel: "الوقود", wash: "الغسيل", oils: "الزيوت", parts: "قطع الغيار",
  vehicle_onboarding: "تسجيل المركبة", manual: "إدخال يدوي",
};
const statusText = (value: unknown) => titles[String(value)] ?? text(value);
function readable(value: unknown): string {
  if (Array.isArray(value)) return value.map(readable).filter(item => item !== "—").join("، ") || "—";
  if (value && typeof value === "object") {
    return Object.entries(fields(value)).filter(([key]) => !isHiddenKey(key))
      .map(([key, item]) => `${labels[key] ?? key}: ${readable(item)}`).join(" · ") || "—";
  }
  return statusText(value);
}
const apiStatus = (error: unknown) => (error as { status?: number; response?: { status?: number } })?.status ?? (error as { response?: { status?: number } })?.response?.status;
async function postSensitive(path: string, body: Row): Promise<Row> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let result: Row = {};
  try { result = fields(await response.json()); } catch { /* keep a safe generic error */ }
  if (!response.ok) {
    throw Object.assign(new Error(text(result.message) === "—" ? "تعذر تنفيذ الإجراء." : text(result.message)), {
      status: response.status, data: result,
    });
  }
  return result;
}
function apiError(error: unknown) {
  const status = apiStatus(error);
  if (status === 401) return "انتهت الجلسة أو يلزم تسجيل الدخول مجددًا.";
  if (status === 403) return "رفض الخادم هذا الإجراء؛ لا يتوفر التفويض المطلوب.";
  if (status === 409) return "تعارض مع سجل أحدث. حدّث البيانات ثم راجع الحالة قبل إعادة المحاولة.";
  return (error as { data?: { message?: string }; message?: string })?.data?.message || (error as { message?: string })?.message || "تعذر إتمام الطلب. حاول مرة أخرى.";
}
const labels: Record<string, string> = {
  id: "السجل", organizationName: "الشركة", organization: "الشركة", branchName: "الفرع",
  plateOriginal: "رقم اللوحة", plateStandard: "اللوحة المعيارية", plateStandardCorrection: "تصحيح اللوحة المعيارية", plateNormalized: "اللوحة الموحّدة", category: "الفئة", type: "النوع",
  vehicleType: "نوع المركبة", modelYear: "سنة الصنع", brand: "الصانع", model: "الطراز", year: "سنة الصنع", chassisNumber: "رقم الشاسيه", internalCode: "الكود الداخلي",
  fuelType: "فئة الوقود", status: "الحالة", coverage: "التغطية", eligibility: "الأهلية", activeCredentials: "الرموز النشطة",
  version: "نسخة السجل", expectedVersion: "نسخة السجل الحالية", organizationId: "الشركة", branchId: "الفرع",
  isCovered: "تغطية سارية", activeCredentialCount: "الرموز النشطة", activeLinkCount: "الروابط النشطة",
  driverCode: "كود السائق", fullName: "اسم السائق", phone: "الهاتف", vehicleId: "المركبة", driverId: "السائق",
  startsAt: "يبدأ في", endsAt: "ينتهي في", effectiveFrom: "ساري من", effectiveTo: "ساري حتى",
  updatedAt: "آخر تحديث", at: "وقت الحدث", reason: "سبب الإجراء", reviewReason: "سبب المراجعة",
  timezone: "المنطقة الزمنية", plate: "اللوحة", eventType: "نوع الحدث", detail: "تفاصيل الحدث",
  serviceGroup: "مجموعة الخدمة", service_group: "مجموعة الخدمة", enabled: "مفعّل", replacementReady: "جاهز للاستبدال",
  scope: "النطاق", schedule: "الجدول", allowedMerchants: "مقدمو الخدمة", serviceGroups: "مجموعات الخدمة",
  allowedWeekdays: "أيام الأسبوع (١ إلى ٧)", startTime: "بداية الفترة", endTime: "نهاية الفترة",
  allowedMerchantOrganizationIds: "جهات الخدمة المسموح بها", allowedMerchantBranchIds: "فروع الخدمة المسموح بها",
  maxOperationMinor: "حد العملية بالقرش", maxOperationQuantity: "حد كمية العملية",
  dailyAmountLimitMinor: "حد يومي بالقرش", weeklyAmountLimitMinor: "حد أسبوعي بالقرش", monthlyAmountLimitMinor: "حد شهري بالقرش",
  dailyQuantityLimit: "كمية يومية", weeklyQuantityLimit: "كمية أسبوعية", monthlyQuantityLimit: "كمية شهرية",
  rules: "قواعد مجموعات الخدمة", targetBranchId: "الفرع الجديد",
  linkId: "ربط السائق", pinCode: "رمز PIN جديد", policyVersionId: "نسخة السياسة",
  requestId: "طلب التعريف", proofDocumentId: "مستند إثبات التركيب", stockUnitId: "وحدة المخزون",
  assignedTo: "المسؤول عن التنفيذ", scheduledAt: "موعد التنفيذ", credentialType: "نوع الرمز",
  previousCredentialId: "الرمز السابق", waive: "إعفاء معتمد", unitCode: "كود وحدة المخزون",
  readingKm: "قراءة الكيلومتر", evidenceDocumentId: "مستند الإثبات", supersedesEventId: "القراءة المصححة",
  maintenanceId: "سجل الصيانة", odometerEventId: "قراءة العداد المرتبطة", nextDueAt: "الاستحقاق التالي",
  nextDueKm: "كيلومتر الاستحقاق", performedAt: "تاريخ تنفيذ الصيانة", documentId: "المستند",
  decision: "القرار",
  subscriptionId: "الاشتراك", billingUnit: "وحدة الاشتراك", requestType: "نوع الطلب", tokenHint: "تلميح الرمز",
  documentType: "نوع المستند", fileName: "اسم الملف", reviewStatus: "حالة المراجعة", expiresOn: "ينتهي في",
  reading: "قراءة العداد", odometer: "قراءة العداد", recordedAt: "تاريخ القراءة", correction: "التصحيح",
  maintenanceType: "نوع الصيانة", dueAt: "موعد الاستحقاق", dueOdometer: "العداد عند الاستحقاق",
  jobId: "رقم المهمة", rowCount: "عدد الصفوف", issueCount: "عدد الملاحظات", createdAt: "أُنشئ في",
  branchCount: "عدد الفروع", vehicleCount: "عدد المركبات", totalVehicles: "إجمالي المركبات",
  activeVehicleCount: "المركبات النشطة", activeVehicles: "المركبات النشطة",
  activeDriverCount: "السائقون المرتبطون النشطون", activeDrivers: "السائقون النشطون",
  coveredVehicleCount: "المركبات المغطاة", coveredVehicles: "المركبات المغطاة",
  total: "الإجمالي", totalCount: "إجمالي النتائج", page: "الصفحة", pageSize: "عدد النتائج في الصفحة",
  validationErrors: "أخطاء التحقق", issues: "الملاحظات", vehiclesApplied: "المركبات المضافة",
  driversApplied: "السائقون المضافون", policyDraftsCreated: "مسودات السياسات المنشأة",
  statusReason: "سبب الحالة", expectedConsumption: "معدل الوقود المتوقع", current: "الإصدار الحالي",
  vehicleCountsByStatus: "المركبات حسب الحالة", branchTotal: "إجمالي الفروع",
};
const actionLabels: Record<string, string> = {
  "vehicle.create": "إضافة مركبة", "vehicle.update": "تعديل بيانات المركبة",
  "vehicle.move": "نقل المركبة", "vehicle.status": "تغيير حالة المركبة",
  "driver.create": "إضافة سائق تشغيلي", "driver.update": "تعديل بيانات السائق",
  "driver.status": "تغيير حالة السائق", "driver.link.create": "ربط سائق بمركبة",
  "driver.link.end": "إنهاء ربط السائق", "driver.pin.rotate": "تغيير رمز الربط",
  "policy.create": "إنشاء مسودة سياسة", "policy.update": "تعديل مسودة سياسة",
  "policy.publish": "نشر السياسة", "coverage.assign": "إسناد تغطية",
  "coverage.end": "إنهاء التغطية", "credential.request": "طلب إصدار رمز",
  "credential.approve": "اعتماد طلب الرمز", "credential.assign": "إسناد طلب الرمز",
  "credential.install": "تسجيل تركيب الرمز", "credential.activate_qr": "إصدار رمز QR لمرة واحدة",
  "credential.activate_nfc": "إصدار رمز NFC لمرة واحدة", "credential.stop": "إيقاف الرمز",
  "tag_stock.receive": "تسجيل وحدة مخزون", "tag_stock.reserve": "حجز وحدة مخزون",
  "tag_stock.damage": "تسجيل وحدة تالفة", "odometer.record": "تسجيل قراءة عداد",
  "odometer.review": "مراجعة قراءة العداد", "maintenance.create": "تسجيل صيانة",
  "maintenance.cancel": "إلغاء سجل صيانة",
};
const requestStatusesByAction: Record<string, string[]> = {
  "credential.approve": ["requested"],
  "credential.assign": ["approved"],
  "credential.activate_qr": ["approved", "assigned", "scheduled"],
  "credential.activate_nfc": ["installed"],
  "tag_stock.reserve": ["assigned", "scheduled"],
};
const referenceStatusesByAction: Record<string, Record<string, string[]>> = {
  "driver.link.create": { vehicleId: ["active"], driverId: ["active"] },
  "driver.link.end": { linkId: ["active"] },
  "driver.pin.rotate": { vehicleId: ["active"], linkId: ["active"] },
  "coverage.assign": { vehicleId: ["active"] },
  "credential.request": { vehicleId: ["active"], previousCredentialId: ["active"] },
  "credential.stop": { credentialId: ["active"] },
};
function date(value: unknown) { if (typeof value !== "string" || !value) return "—"; const parsed = new Date(value); return Number.isNaN(+parsed) ? value : new Intl.DateTimeFormat("ar-EG", { dateStyle: "medium" }).format(parsed); }
const vehicleCreateRequiredByStep: Record<number, string[]> = {
  0: ["plateOriginal", "plateStandard", "category", "vehicleType", "brand", "model", "fuelType"],
  1: ["organizationId", "branchId"],
  2: [],
  3: [],
};
function egpFromMinor(value: number | null) {
  if (value === null || !Number.isSafeInteger(value) || value < 0) return "السعر غير متاح";
  const whole = Math.trunc(value / 100);
  const fraction = value % 100;
  const pounds = new Intl.NumberFormat("ar-EG").format(whole);
  return fraction === 0 ? `${pounds} جنيه مصري` : `${pounds}٫${fraction.toLocaleString("ar-EG", { minimumIntegerDigits: 2, useGrouping: false })} جنيه مصري`;
}
function Field({ label, children, wide = false, required = false, error, hint }: { label: string; children: ReactNode; wide?: boolean; required?: boolean; error?: string; hint?: string }) {
  const childProps = isValidElement(children) ? children.props as { name?: string; "data-testid"?: string } : {};
  const key = childProps.name ?? label;
  const slug = key.toLowerCase().replace(/[^a-z0-9\u0600-\u06ff_-]+/g, "-").replace(/^-+|-+$/g, "");
  const control = isValidElement(children) && typeof children.type === "string" && !childProps["data-testid"]
    ? cloneElement(children as ReactElement<{ "data-testid"?: string }>, { "data-testid": `fleet-field-${slug}` })
    : children;
  return <label className={`fleet-field ${wide ? "fleet-wide" : ""}`}><span className="fleet-field-label">{label}{required && <b className="fleet-required-mark">مطلوب</b>}</span>{control}{hint && <small className="fleet-field-hint">{hint}</small>}{error && <small className="fleet-field-error" role="alert">{error}</small>}</label>;
}
function Reason({ value, onChange }: { value: string; onChange: (value: string) => void }) { return <Field label="سبب موثّق — مطلوب (٣ إلى ٥٠٠ حرف)" wide><textarea data-testid="fleet-reason" required minLength={3} maxLength={500} value={value} onChange={event => onChange(event.target.value)} placeholder="اكتب سبب الإجراء لتسجيله في التدقيق."/></Field>; }
function Skeleton() { return <div className="fleet-skeleton" aria-label="جارٍ تحميل سجلات الأسطول"><i/><i/><i/><i/></div>; }
function State({ error = false, title, children, retry }: { error?: boolean; title: string; children?: ReactNode; retry?: () => void }) { return <section className={`fleet-state ${error ? "fleet-state-error" : ""}`} role={error ? "alert" : "status"}><span>{error ? <RefreshCw size={19}/> : <Truck size={19}/>}</span><b>{title}</b>{children && <p>{children}</p>}{retry && <button data-testid="fleet-state-retry" className="fleet-button fleet-quiet" onClick={retry}><RefreshCw size={15}/> إعادة المحاولة</button>}</section>; }

export function FleetAdminPage({ canMutate, isOwner }: { canMutate: boolean; isOwner: boolean }) {
  const [path, navigate] = useLocation();
  const isCompanyDirectory = path === "/admin/fleet";
  const isCompanyDetail = /^\/admin\/fleet\/companies\/[^/]+$/.test(path);
  const isCompanyVehicles = /^\/admin\/fleet\/companies\/[^/]+\/vehicles$/.test(path);
  const isBranchFleet = /^\/admin\/fleet\/companies\/[^/]+\/branches\/[^/]+$/.test(path);
  const isCompanyRoute = isCompanyDirectory || isCompanyDetail || isCompanyVehicles || isBranchFleet;
  const isDriverDetail = path.startsWith("/admin/fleet/drivers/") && path !== "/admin/fleet/drivers";
  const isVehicleDetail = path.startsWith("/admin/fleet/vehicles/") && path !== "/admin/fleet/vehicles/new";
  const active = views.find(item => item.path === path) ?? (isDriverDetail ? views.find(item => item.view === "drivers")! : isVehicleDetail || path === "/admin/fleet/vehicles/new" ? views.find(item => item.view === "vehicles")! : views[0]);
  const detailId = isVehicleDetail || isDriverDetail ? decodeURIComponent(path.split("/").pop() ?? "") : "";
  const view = isVehicleDetail ? "vehicle" : active.view;
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");
  const [coverageFilter, setCoverageFilter] = useState("");
  const [fuelFilter, setFuelFilter] = useState("");
  const [organizationFilter, setOrganizationFilter] = useState("");
  const [branchFilter, setBranchFilter] = useState("");
  const [vehicleFilter, setVehicleFilter] = useState("");
  const [formReferences, setFormReferences] = useState<Record<string, string>>({});
  const [merchantBranchScope, setMerchantBranchScope] = useState("");
  const [formWeekdays, setFormWeekdays] = useState<string[]>([]);
  const [documentVehicleId, setDocumentVehicleId] = useState("");
  const [verifyVehicleId, setVerifyVehicleId] = useState("");
  const [verifyLinkId, setVerifyLinkId] = useState("");
  const [vehiclePhoto, setVehiclePhoto] = useState<File | null>(null);
  const [vehiclePhotoPreview, setVehiclePhotoPreview] = useState("");
  const [odometerEvidencePhoto, setOdometerEvidencePhoto] = useState<File | null>(null);
  const [photoUploadPending, setPhotoUploadPending] = useState(false);
  const [vehicleCreatedMessage, setVehicleCreatedMessage] = useState("");
  const [formOrganizationId, setFormOrganizationId] = useState("");
  const [formVehicleId, setFormVehicleId] = useState("");
  const [formWizardStep, setFormWizardStep] = useState(0);
  const [wizardErrors, setWizardErrors] = useState<Record<string, string>>({});
  const [initialDriverMode, setInitialDriverMode] = useState<"none" | "existing" | "new">("none");
  const [initialReadingInput, setInitialReadingInput] = useState("");
  const [initialReadingTimeInput, setInitialReadingTimeInput] = useState("");
  const createdVehiclePhotoRef = useRef<{ signature: string; photoSignature: string; evidenceSignature: string; id: string; driverLinked: boolean; driverCreated: boolean; driverId: string; photoSaved: boolean; odometerRecorded: boolean; evidenceSaved: boolean; vehiclePhotoIntentId?: string; evidenceIntentId?: string; evidenceDocumentId?: string } | null>(null);
  const driverLinkRetryRef = useRef<{ signature: string; key: string } | null>(null);
  const driverCreateRetryRef = useRef<{ signature: string; key: string } | null>(null);
  const odometerRetryRef = useRef<{ signature: string; key: string } | null>(null);
  const [sort, setSort] = useState<"newest" | "oldest" | "name" | "plate" | "updatedAt">("newest");
  const [showForm, setShowForm] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<Row>({});
  const [problem, setProblem] = useState("");
  const [message, setMessage] = useState("");
  const [reason, setReason] = useState("");
  const [documentReview, setDocumentReview] = useState<Row | null>(null);
  const [documentDecision, setDocumentDecision] = useState("");
  const [documentReason, setDocumentReason] = useState("");
  const [pairPin, setPairPin] = useState("");
  const [pairResult, setPairResult] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPreview, setImportPreview] = useState<Row | null>(null);
  const [importReason, setImportReason] = useState("");
  const [command, setCommand] = useState("");
  const [vehicleCredentialChoice, setVehicleCredentialChoice] = useState("");
  const [policyScope, setPolicyScope] = useState("branch");
  const [cacheBust, setCacheBust] = useState(0);
  const [lastStockStatus, setLastStockStatus] = useState("");
  const [lastReservedStockUnitId, setLastReservedStockUnitId] = useState("");
  const [lastReservedRequestId, setLastReservedRequestId] = useState("");
  const [lastReservedVehicleId, setLastReservedVehicleId] = useState("");
  const [lastReservedRequestLabel, setLastReservedRequestLabel] = useState("");
  const selectedReserveRequestRef = useRef<{ id: string; vehicleId: string; label: string } | null>(null);
  const [oneTimeToken, setOneTimeToken] = useState("");
  const dialogRef = useRef<HTMLElement | null>(null);
  const commandRetryRef = useRef<{ signature: string; key: string } | null>(null);
  const importApplyRetryRef = useRef<{ signature: string; key: string } | null>(null);
  useEffect(() => {
    if (path === "/admin/fleet/vehicles/new") {
      if (canMutate) {
        setCommand("vehicle.create");
        setShowForm(true);
      } else {
        navigate("/admin/fleet/vehicles");
      }
    }
  }, [path, canMutate, navigate]);
  useEffect(() => { setPage(1); }, [view]);
  useEffect(() => {
    if (!showForm) return;
    const dialog = dialogRef.current;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href]") ?? []);
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (createdVehiclePhotoRef.current && (!createdVehiclePhotoRef.current.driverLinked || !createdVehiclePhotoRef.current.photoSaved || !createdVehiclePhotoRef.current.odometerRecorded || !createdVehiclePhotoRef.current.evidenceSaved)) {
          setProblem("أُنشئت المركبة. أكمل الخطوات الاختيارية أو اختر صراحةً المتابعة دونها قبل إغلاق النموذج.");
          return;
        }
        setShowForm(false); setOneTimeToken(""); if (path === "/admin/fleet/vehicles/new") navigate("/admin/fleet/vehicles"); return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [showForm, path, navigate]);
  useEffect(() => {
    if (!vehiclePhoto) { setVehiclePhotoPreview(""); return; }
    const url = URL.createObjectURL(vehiclePhoto);
    setVehiclePhotoPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [vehiclePhoto]);
  const params = useMemo<GetAdminFleetCatalogParams>(() => ({
    view, page, pageSize: 20,
    ...(isVehicleDetail ? { id: detailId, vehicleId: detailId } : {}),
    ...(isDriverDetail ? { driverId: detailId } : {}),
    ...(!["overview", "vehicle"].includes(view) && search.trim().length >= 2 ? { query: search.trim() } : {}),
    ...(statusFilter && ["vehicles", "drivers", "credentials", "odometer", "maintenance"].includes(view) ? { status: statusFilter } : {}),
    ...(coverageFilter && view === "vehicles" ? { coverage: coverageFilter as "covered" | "uncovered" } : {}),
    ...(fuelFilter && view === "vehicles" ? { fuelType: fuelFilter } : {}),
    ...(organizationFilter && ["vehicles", "drivers", "policies", "coverage", "credentials"].includes(view) ? { organizationId: organizationFilter } : {}),
    ...(branchFilter && ["vehicles", "policies"].includes(view) ? { branchId: branchFilter } : {}),
    ...(vehicleFilter && ["policies", "coverage", "credentials", "documents", "odometer", "maintenance"].includes(view) ? { vehicleId: vehicleFilter } : {}),
    ...(!["overview", "vehicle"].includes(view) ? { sort } : {}),
  }), [view, page, search, detailId, cacheBust, statusFilter, coverageFilter, fuelFilter, organizationFilter, branchFilter, vehicleFilter, sort]);
  const query = useGetAdminFleetCatalog(params, { query: { queryKey: getGetAdminFleetCatalogQueryKey(params), enabled: !isDriverDetail, retry: false, refetchOnMount: "always" } });
  const driverDetail = useGetAdminFleetDriverDetail(detailId, {
    query: {
      queryKey: getGetAdminFleetDriverDetailQueryKey(detailId),
      enabled: isDriverDetail,
      retry: false,
      refetchOnMount: "always",
    },
  });
  const fleetMetaParams: GetAdminFleetCompanySummariesParams = { page: 1, pageSize: 1 };
  const fleetMeta = useGetAdminFleetCompanySummaries(fleetMetaParams, {
    query: { queryKey: getGetAdminFleetCompanySummariesQueryKey(fleetMetaParams), enabled: canMutate && ["vehicles", "credentials"].includes(view), retry: false },
  });
  const driverEventsParams: GetAdminFleetCatalogParams = { view: "events", driverId: detailId, page: 1, pageSize: 50 };
  const driverEvents = useGetAdminFleetCatalog(driverEventsParams, { query: { queryKey: getGetAdminFleetCatalogQueryKey(driverEventsParams), enabled: isDriverDetail, retry: false } });
  const reservationParams: GetAdminFleetStockReservationsParams = {
    page,
    pageSize: 20,
    ...(search.trim().length >= 2 ? { search: search.trim() } : {}),
  };
  const stockReservations = useGetAdminFleetStockReservations(reservationParams, {
    query: {
      queryKey: getGetAdminFleetStockReservationsQueryKey(reservationParams),
      enabled: view === "credentials" && canMutate,
      retry: false,
    },
  });
  const cache = useQueryClient();
  const execute = useExecuteAdminFleetCommand();
  const uploadIntent = useCreateAdminFleetDocumentUploadIntent();
  const templateDownload = useDownloadAdminFleetImportTemplate({ query: { queryKey: getDownloadAdminFleetImportTemplateQueryKey(), enabled: false, retry: false } });
  const previewMutation = usePreviewAdminFleetImport();
  const applyMutation = useApplyAdminFleetImport();
  const records = safeRows(query.data, view);
  const root = fields(query.data);
  const reservedStockRows = Array.isArray(stockReservations.data?.items) ? stockReservations.data.items as Row[] : [];
  const nfcIssuePriceMinor = typeof fleetMeta.data?.nfcIssuePriceMinor === "number" ? fleetMeta.data.nfcIssuePriceMinor : null;
  const pageInfo = fields(root.pageInfo ?? root.pagination ?? query.data);
  const title = isVehicleDetail ? "ملف المركبة" : isDriverDetail ? "ملف السائق" : isCompanyRoute ? isBranchFleet ? "أسطول الفرع" : isCompanyVehicles ? "مركبات الشركة" : isCompanyDetail ? "الشركة والفروع" : "الشركات" : active.title;
  const refresh = async () => {
    await cache.invalidateQueries({ queryKey: getGetAdminFleetCatalogQueryKey(params) });
    await cache.invalidateQueries({ queryKey: getGetAdminFleetStockReservationsQueryKey() });
    if (isDriverDetail) {
      await cache.invalidateQueries({ queryKey: getGetAdminFleetDriverDetailQueryKey(detailId) });
    }
    setCacheBust(value => value + 1);
  };
  const actionOptions: Record<string, string[]> = {
    vehicles: ["vehicle.create", "vehicle.update", "vehicle.move", "vehicle.status"],
    vehicle: ["vehicle.update", "vehicle.move", "vehicle.status"],
    drivers: ["driver.create", "driver.update", "driver.status", "driver.link.create", "driver.link.end", "driver.pin.rotate"],
    policies: ["policy.create"],
    coverage: ["coverage.assign", "coverage.end"],
    credentials: ["credential.request", "credential.approve", "credential.assign", "credential.activate_qr", ...(isOwner ? ["credential.activate_nfc"] : []), "credential.stop", "tag_stock.receive", "tag_stock.reserve", "tag_stock.damage", ...(lastStockStatus === "reserved" && UUID_RE.test(lastReservedStockUnitId) && UUID_RE.test(lastReservedRequestId) ? ["credential.install"] : [])],
    odometer: ["odometer.record", "odometer.review"],
    maintenance: ["maintenance.create", "maintenance.cancel"],
  };
  const selectedAction = actionOptions[view]?.includes(command) ? command : actionOptions[view]?.[0] ?? "";
  const fieldsByAction: Record<string, string[]> = {
    "vehicle.create": ["organizationId", "branchId", "plateOriginal", "category", "vehicleType", "brand", "model", "modelYear", "chassisNumber", "internalCode", "fuelType", "credentialType"],
    "vehicle.update": ["vehicleId", "expectedVersion", "plateOriginal", "category", "vehicleType", "brand", "model", "modelYear", "chassisNumber", "internalCode", "fuelType"],
    "vehicle.move": ["vehicleId", "targetBranchId", "expectedVersion"],
    "vehicle.status": ["vehicleId", "status", "expectedVersion"],
    "driver.create": ["organizationId", "driverCode", "fullName", "phone"],
    "driver.update": ["driverId", "expectedVersion", "driverCode", "fullName", "phone"],
    "driver.status": ["driverId", "status", "expectedVersion"],
    "driver.link.create": ["driverId", "vehicleId", "pinCode", "startsAt", "endsAt"],
    "driver.link.end": ["linkId"],
    "driver.pin.rotate": ["vehicleId", "linkId", "pinCode"],
    "policy.create": ["scope", "organizationId", "branchId", "vehicleId", "effectiveFrom", "allowedWeekdays", "startTime", "endTime", "allowedMerchantOrganizationIds", "allowedMerchantBranchIds", "maxOperationMinor", "maxOperationQuantity", "dailyAmountLimitMinor", "weeklyAmountLimitMinor", "monthlyAmountLimitMinor", "dailyQuantityLimit", "weeklyQuantityLimit", "monthlyQuantityLimit"],
    "policy.update": ["policyVersionId", "effectiveFrom", "allowedWeekdays", "startTime", "endTime", "allowedMerchantOrganizationIds", "allowedMerchantBranchIds", "maxOperationMinor", "maxOperationQuantity", "dailyAmountLimitMinor", "weeklyAmountLimitMinor", "monthlyAmountLimitMinor", "dailyQuantityLimit", "weeklyQuantityLimit", "monthlyQuantityLimit"],
    "policy.publish": ["policyVersionId"],
    "coverage.assign": ["vehicleId", "subscriptionId", "startsAt"],
    "coverage.end": ["assignmentId"],
    "credential.request": ["vehicleId", "credentialType", "requestType", "previousCredentialId"],
    "credential.approve": ["requestId", "waive"],
    "credential.assign": ["requestId", "assignedTo", "scheduledAt"],
    "credential.install": ["requestId", "proofDocumentId", "stockUnitId"],
    "credential.activate_qr": ["requestId"],
    "credential.activate_nfc": ["requestId"],
    "credential.stop": ["credentialId"],
    "tag_stock.receive": ["unitCode"],
    "tag_stock.reserve": ["requestId", "stockUnitId"],
    "tag_stock.damage": ["stockUnitId"],
    "odometer.record": ["vehicleId", "readingKm", "recordedAt", "source", "evidenceDocumentId", "supersedesEventId"],
    "odometer.review": ["eventId", "decision"],
    "maintenance.create": ["vehicleId", "maintenanceType", "performedAt", "odometerEventId", "notes", "nextDueAt", "nextDueKm", "documentId"],
    "maintenance.cancel": ["maintenanceId"],
  };
  const clearWizardError = (field: string) => {
    setWizardErrors(current => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
    setProblem("");
  };
  const reportWizardError = (field: string, message: string) => {
    setWizardErrors({ [field]: message });
    setProblem(message);
    const named = dialogRef.current?.querySelector<HTMLInputElement>(`[name="${field}"]`);
    const focusable = named?.type === "hidden"
      ? named.parentElement?.querySelector<HTMLElement>("button, input:not([type=hidden]), select")
      : named;
    focusable?.focus();
  };
  const openAction = (action: string, row: Row = {}) => {
    setSelectedRecord(row); setCommand(action); setVehicleCredentialChoice(""); setReason(""); setProblem(""); setWizardErrors({}); setMessage(""); setOneTimeToken("");
    setVehicleCreatedMessage(""); setFormWizardStep(0); setInitialDriverMode("none"); setInitialReadingInput(""); setInitialReadingTimeInput(""); setVehiclePhoto(null); setOdometerEvidencePhoto(null);
    createdVehiclePhotoRef.current = null; driverLinkRetryRef.current = null; driverCreateRetryRef.current = null; odometerRetryRef.current = null;
    commandRetryRef.current = null;
    const contextRow = Object.keys(row).length ? row : isVehicleDetail ? fields(root.vehicle) : isDriverDetail ? (records.find(item => String(item.id ?? "") === detailId) ?? {}) : {};
    const organizationId = text(get(contextRow, "organizationId", "companyOrgId"));
    const vehicleId = text(get(contextRow, "vehicleId", "id"));
    const driverId = text(get(contextRow, "driverId", "id"));
    const references: Record<string, string> = {};
    for (const field of fieldsByAction[action] ?? []) {
      if (field === "organizationId" && UUID_RE.test(organizationId)) references[field] = organizationId;
      if (field === "branchId" && UUID_RE.test(text(get(contextRow, "branchId")))) references[field] = text(get(contextRow, "branchId"));
      if (field === "vehicleId" && (isVehicleDetail || contextRow.vehicleId) && UUID_RE.test(vehicleId)) references[field] = vehicleId;
      if (field === "driverId" && (isDriverDetail || contextRow.driverId) && UUID_RE.test(driverId)) references[field] = driverId;
      if (field === "expectedVersion" && contextRow.version !== undefined && contextRow.version !== null) references[field] = String(contextRow.version);
      if (field === "requestId" && UUID_RE.test(text(get(contextRow, "requestId", "id")))) references[field] = text(get(contextRow, "requestId", "id"));
      if (field === "stockUnitId" && UUID_RE.test(text(get(contextRow, "stockUnitId", "id")))) references[field] = text(get(contextRow, "stockUnitId", "id"));
      if (field === "subscriptionId" && UUID_RE.test(text(get(contextRow, "subscriptionId")))) references[field] = text(get(contextRow, "subscriptionId"));
      if (field === "allowedMerchantOrganizationIds" || field === "allowedMerchantBranchIds") {
        const values = get(contextRow, field);
        if (Array.isArray(values)) references[field] = values.filter(value => typeof value === "string" && UUID_RE.test(value)).join(",");
      }
    }
    const rowStockUnitId = text(get(contextRow, "stockUnitId", "id"));
    const rowRequestId = text(get(contextRow, "requestId"));
    const rowVehicleId = text(get(contextRow, "vehicleId"));
    if (action === "credential.install") {
      const stockUnitId = UUID_RE.test(rowStockUnitId) ? rowStockUnitId : lastReservedStockUnitId;
      const requestId = UUID_RE.test(rowRequestId) ? rowRequestId : lastReservedRequestId;
      if (UUID_RE.test(stockUnitId) && UUID_RE.test(requestId)) {
        references.stockUnitId = stockUnitId;
        references.requestId = requestId;
        const vehicleId = UUID_RE.test(rowVehicleId) ? rowVehicleId : lastReservedVehicleId;
        if (UUID_RE.test(vehicleId)) setLastReservedVehicleId(vehicleId);
        setLastReservedStockUnitId(stockUnitId);
        setLastReservedRequestId(requestId);
        const label = [get(contextRow, "vehiclePlate"), get(contextRow, "branchName")].map(value => text(value)).filter(value => value !== "—").join(" · ");
        if (label) setLastReservedRequestLabel(label);
      }
    }
    setFormReferences(references);
    const weekdays = get(contextRow, "allowedWeekdays");
    setFormWeekdays(Array.isArray(weekdays) ? weekdays.map(String).filter(day => /^[1-7]$/.test(day)) : []);
    setMerchantBranchScope("");
    setFormOrganizationId(references.organizationId ?? "");
    setFormVehicleId(action === "credential.install" ? (UUID_RE.test(rowVehicleId) ? rowVehicleId : lastReservedVehicleId) : references.vehicleId ?? "");
    if (action === "tag_stock.reserve") selectedReserveRequestRef.current = null;
    if (action === "policy.create") setPolicyScope(text(get(row, "scope")) === "—" ? "branch" : text(get(row, "scope")));
    setShowForm(true);
  };
  const closeForm = () => {
    if (createdVehiclePhotoRef.current && (!createdVehiclePhotoRef.current.driverLinked || !createdVehiclePhotoRef.current.photoSaved || !createdVehiclePhotoRef.current.odometerRecorded || !createdVehiclePhotoRef.current.evidenceSaved)) {
      setProblem("أُنشئت المركبة. أكمل الخطوات الاختيارية أو اختر صراحةً المتابعة دونها قبل إغلاق النموذج.");
      return;
    }
    dialogRef.current?.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach(input => { input.value = ""; });
    setShowForm(false); setOneTimeToken(""); setVehiclePhoto(null); setOdometerEvidencePhoto(null);
    createdVehiclePhotoRef.current = null; driverLinkRetryRef.current = null; driverCreateRetryRef.current = null; odometerRetryRef.current = null;
    commandRetryRef.current = null;
    if (path === "/admin/fleet/vehicles/new") navigate("/admin/fleet/vehicles");
  };
  const sendCommand = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setProblem(""); setMessage("");
    const form = new FormData(event.currentTarget);
    const createVehicle = command === "vehicle.create";
    const initialDriverModeValue = createVehicle ? String(form.get("initialDriverMode") ?? initialDriverMode) : "none";
    const driverMode = initialDriverModeValue === "existing" || initialDriverModeValue === "new" ? initialDriverModeValue : "none";
    const initialDriverId = createVehicle && driverMode === "existing" ? String(formReferences.initialDriverId ?? "") : "";
    const newDriverCode = createVehicle ? String(form.get("newDriverCode") ?? "").trim() : "";
    const newDriverName = createVehicle ? String(form.get("newDriverName") ?? "").trim() : "";
    const newDriverPhone = createVehicle ? String(form.get("newDriverPhone") ?? "").trim() : "";
    const initialLinkPin = createVehicle ? String(form.get("initialDriverPin") ?? "") : "";
    const initialLinkStartsAt = createVehicle ? String(form.get("initialLinkStartsAt") ?? "") : "";
    const initialReadingRaw = createVehicle ? String(form.get("initialReadingKm") ?? "").trim() : "";
    const initialRecordedAt = createVehicle ? String(form.get("initialRecordedAt") ?? "").trim() : "";
    const secretAndWorkflowFields = new Set(["reason", "initialDriverMode", "newDriverCode", "newDriverName", "newDriverPhone", "initialDriverPin", "initialLinkStartsAt", "initialReadingKm", "initialRecordedAt"]);
    const payload: Row = {};
    for (const [key, value] of form.entries()) if (!secretAndWorkflowFields.has(key) && !key.startsWith("rule_") && String(value).trim()) payload[key] = String(value).trim();
    delete payload.initialDriverId;
    for (const [field, value] of Object.entries(formReferences)) if (value) payload[field] = value;
    if (command === "vehicle.create") delete payload.initialDriverId;
    if (command === "vehicle.create" || command === "vehicle.update") {
      const plateOriginal = String(payload.plateOriginal ?? "").trim();
      const correction = String(form.get("plateStandardCorrection") ?? "").trim();
      const correctionRequested = form.get("overridePlateStandard") === "on";
      delete payload.overridePlateStandard;
      delete payload.plateStandardCorrection;
      if (correctionRequested && !correction) {
        reportWizardError("plateStandardCorrection", "أدخل صيغة المطابقة المصححة أو أزل اختيار التصحيح.");
        return;
      }
      payload.plateStandard = correctionRequested ? correction : plateOriginal.replace(/\s+/gu, "");
    }
    if (command === "vehicle.update") {
      const required = ["plateOriginal", "category", "vehicleType", "brand", "model", "fuelType"];
      const missing = required.find(field => !String(payload[field] ?? "").trim());
      if (missing) {
        reportWizardError(missing, `${labels[missing] ?? "هذا الحقل"} مطلوب.`);
        return;
      }
    }
    if ((command === "vehicle.create" || command === "vehicle.update") && String(payload.modelYear ?? "").trim()) {
      const year = Number(payload.modelYear);
      if (!Number.isInteger(year) || year < 1900 || year > new Date().getFullYear()) {
        reportWizardError("modelYear", `أدخل سنة صنع بين ١٩٠٠ و${new Date().getFullYear()}.`);
        return;
      }
    }
    if (command === "vehicle.create" && formWizardStep < 3) {
      const requiredByStep: Record<number, string[]> = {
  0: ["plateOriginal", "category", "vehicleType", "brand", "model", "fuelType"],
        1: ["organizationId", "branchId"],
      };
      const missing = (requiredByStep[formWizardStep] ?? []).find(field => !String(payload[field] ?? "").trim());
      if (missing) {
        const fieldLabel = labels[missing] ?? missing;
        const message = `${fieldLabel} مطلوب لإكمال هذه الخطوة.`;
        reportWizardError(missing, `أكمل الحقل المحدد: ${message}`);
        return;
      }
      setWizardErrors({});
      if (formWizardStep === 2 && driverMode === "existing" && !UUID_RE.test(initialDriverId)) {
        reportWizardError("initialDriverId", "اختر سائقًا تشغيليًا من الشركة المحددة.");
        return;
      }
      if (formWizardStep === 2 && driverMode === "new" && (!newDriverCode || !newDriverName)) {
        const errors: Record<string, string> = {};
        if (!newDriverCode) errors.newDriverCode = "الكود التشغيلي مطلوب.";
        if (!newDriverName) errors.newDriverName = "اسم السائق مطلوب.";
        setWizardErrors(errors);
        setProblem("أكمل بيانات السائق الجديد المحددة.");
        const focusField = !newDriverCode ? "newDriverCode" : "newDriverName";
        dialogRef.current?.querySelector<HTMLInputElement>(`[name="${focusField}"]`)?.focus();
        return;
      }
      if (formWizardStep === 2 && driverMode !== "none" && !initialLinkStartsAt) {
        reportWizardError("initialLinkStartsAt", "تاريخ بداية إسناد السائق إلى المركبة مطلوب.");
        return;
      }
      if (formWizardStep === 2 && initialLinkPin && !/^\d{4}$/.test(initialLinkPin)) {
        reportWizardError("initialDriverPin", "الرمز اختياري، لكن عند إدخاله يجب أن يتكون من أربعة أرقام.");
        return;
      }
      if (formWizardStep === 2 && Boolean(initialReadingRaw) !== Boolean(initialRecordedAt)) {
        const missingField = initialReadingRaw ? "initialRecordedAt" : "initialReadingKm";
        reportWizardError(missingField, initialReadingRaw ? "أدخل وقت تسجيل قراءة العداد." : "أدخل قراءة العداد بالكيلومتر.");
        return;
      }
      if (formWizardStep === 2 && initialReadingRaw && (!Number.isFinite(Number(initialReadingRaw)) || Number(initialReadingRaw) < 0 || Number.isNaN(new Date(initialRecordedAt).getTime()))) {
        const invalidField = !Number.isFinite(Number(initialReadingRaw)) || Number(initialReadingRaw) < 0 ? "initialReadingKm" : "initialRecordedAt";
        reportWizardError(invalidField, invalidField === "initialReadingKm" ? "تحقق من قراءة العداد." : "تحقق من وقت تسجيل القراءة.");
        return;
      }
      if (formWizardStep === 2 && odometerEvidencePhoto && !initialReadingRaw) {
        reportWizardError("initialReadingKm", "أضف قراءة العداد قبل إرفاق صورة إثباتها.");
        return;
      }
      setFormWizardStep(step => Math.min(3, step + 1));
      return;
    }
    if (command === "vehicle.create" && (!String(payload.organizationId ?? "").trim() || !String(payload.branchId ?? "").trim())) {
      reportWizardError(!String(payload.organizationId ?? "").trim() ? "organizationId" : "branchId", "اختر الشركة والفرع من القوائم قبل الحفظ.");
      return;
    }
    if (reason.trim().length < 3) { setProblem("سبب الإجراء مطلوب."); return; }
    if (fieldsByAction[command]?.includes("pinCode")) {
      const pinInput = event.currentTarget.querySelector<HTMLInputElement>('input[name="pinCode"]');
      const pinCode = String(payload.pinCode ?? "");
      if ((command === "driver.pin.rotate" || pinCode) && !/^\d{4}$/.test(pinCode)) {
        setProblem(command === "driver.pin.rotate" ? "أدخل رمز PIN جديدًا من أربعة أرقام." : "رمز PIN اختياري، وعند إدخاله يجب أن يتكون من أربعة أرقام.");
        return;
      }
      if (pinInput) pinInput.value = "";
    }
    const requiredReferences: Record<string, string[]> = {
      "vehicle.create": ["organizationId", "branchId"],
      "vehicle.update": ["vehicleId"],
      "vehicle.move": ["vehicleId", "targetBranchId"],
      "vehicle.status": ["vehicleId"],
      "driver.create": ["organizationId"],
      "driver.update": ["driverId"],
      "driver.status": ["driverId"],
      "driver.link.create": ["driverId", "vehicleId"],
      "driver.link.end": ["linkId"],
      "driver.pin.rotate": ["linkId", "vehicleId"],
      "coverage.assign": ["vehicleId", "subscriptionId"],
      "coverage.end": ["assignmentId"],
      "credential.request": ["vehicleId"],
      "credential.approve": ["requestId"],
      "credential.assign": ["requestId", "assignedTo"],
      "credential.install": ["requestId", "proofDocumentId", "stockUnitId"],
      "credential.activate_qr": ["requestId"],
      "credential.activate_nfc": ["requestId"],
      "credential.stop": ["credentialId"],
      "odometer.record": ["vehicleId"],
      "odometer.review": ["eventId"],
      "maintenance.create": ["vehicleId"],
      "maintenance.cancel": ["maintenanceId"],
    };
    if ((command === "driver.link.end" || command === "credential.stop") && !UUID_RE.test(formVehicleId)) {
      setProblem("اختر المركبة أولًا لعرض روابطها أو رموزها النشطة.");
      return;
    }
    if ((requiredReferences[command] ?? []).some(field => !String(payload[field] ?? "").trim())) {
      setProblem("اختر السجلات المرتبطة من القوائم. لا تُدخل معرّفات يدويًا.");
      return;
    }
    const requiredFieldsByAction: Record<string, string[]> = {
      "vehicle.update": ["expectedVersion"], "vehicle.move": ["expectedVersion"], "vehicle.status": ["expectedVersion"],
      "driver.update": ["expectedVersion"], "driver.status": ["expectedVersion"],
      "driver.link.create": ["startsAt"], "odometer.record": ["readingKm", "recordedAt", "source"],
    };
    if ((requiredFieldsByAction[command] ?? []).some(field => !String(payload[field] ?? "").trim())) {
      setProblem("أكمل نسخة السجل أو التاريخ أو المصدر المطلوب قبل الحفظ.");
      return;
    }
    const arrayFields = ["allowedWeekdays", "allowedMerchantOrganizationIds", "allowedMerchantBranchIds"];
    for (const field of arrayFields) if (typeof payload[field] === "string") {
      const values = String(payload[field]).split(",").map(value => value.trim()).filter(Boolean);
      payload[field] = field === "allowedWeekdays" ? values.map(Number) : values;
    }
    if (command === "policy.create" || command === "policy.update") {
      payload.allowedWeekdays = formWeekdays.map(Number);
      payload.allowedMerchantOrganizationIds = String(formReferences.allowedMerchantOrganizationIds ?? "").split(",").filter(Boolean);
      payload.allowedMerchantBranchIds = String(formReferences.allowedMerchantBranchIds ?? "").split(",").filter(Boolean);
      if (!formWeekdays.length) { setProblem("اختر يوم استخدام واحدًا على الأقل؛ عدم الاختيار لا يفتح الاستخدام."); return; }
    }
    const numericFields = ["modelYear", "expectedVersion", "maxOperationMinor", "maxOperationQuantity", "dailyAmountLimitMinor", "weeklyAmountLimitMinor", "monthlyAmountLimitMinor", "dailyQuantityLimit", "weeklyQuantityLimit", "monthlyQuantityLimit", "readingKm", "nextDueKm"];
    for (const field of numericFields) if (typeof payload[field] === "string") payload[field] = Number(payload[field]);
    if (command === "credential.approve") payload.waive = form.get("waive") === "true";
    if (command === "policy.create" || command === "policy.update") {
      payload.rules = policyGroups.map(({ id }) => ({
        serviceGroup: id,
        enabled: form.get(`rule_${id}_enabled`) === "on",
        ...Object.fromEntries(policyRuleLimits.map(([field]) => {
          const raw = String(form.get(`rule_${id}_${field}`) ?? "").trim();
          return [field, raw ? Number(raw) : 0];
        })),
      }));
    }
    const retryPayload = { ...payload };
    delete retryPayload.pinCode;
    const signature = `${command}:${JSON.stringify(retryPayload)}:${driverMode}:${initialDriverId}:${newDriverCode}:${newDriverName}:${newDriverPhone}:${initialReadingRaw}:${initialRecordedAt}:${initialLinkStartsAt}:${reason.trim()}`;
    const photoSignature = vehiclePhoto ? `${vehiclePhoto.name}:${vehiclePhoto.type}:${vehiclePhoto.size}:${vehiclePhoto.lastModified}` : "";
    const evidenceSignature = odometerEvidencePhoto ? `${odometerEvidencePhoto.name}:${odometerEvidencePhoto.type}:${odometerEvidencePhoto.size}:${odometerEvidencePhoto.lastModified}` : "";
    if (createVehicle && createdVehiclePhotoRef.current && createdVehiclePhotoRef.current.signature !== signature) {
      setProblem("أُنشئت المركبة بالفعل؛ لا تغيّر بيانات الإنشاء أو السائق أو العداد أثناء استكمال الخطوات.");
      return;
    }
    if (createVehicle && createdVehiclePhotoRef.current &&
        (createdVehiclePhotoRef.current.photoSignature !== photoSignature
         || createdVehiclePhotoRef.current.evidenceSignature !== evidenceSignature)) {
      setProblem("استخدم الملف نفسه لإعادة المحاولة، أو تابع دون إرفاقه.");
      return;
    }
    if (createVehicle && formWizardStep === 3) {
      const pinInput = event.currentTarget.querySelector<HTMLInputElement>('input[name="initialDriverPin"]');
      if (initialLinkPin && (!/^\d{4}$/.test(initialLinkPin) || driverMode === "none")) {
        setProblem("رمز الربط اختياري؛ عند استخدامه اختر سائقًا وأدخل تاريخ البداية ورمزًا من أربعة أرقام.");
        return;
      }
      if (initialReadingRaw && (!Number.isFinite(Number(initialReadingRaw)) || Number(initialReadingRaw) < 0 || !initialRecordedAt || Number.isNaN(new Date(initialRecordedAt).getTime()))) {
        setProblem("تحقق من قراءة العداد وتاريخها.");
        return;
      }
      if (pinInput) pinInput.value = "";
    }
    const uploadPrivateImage = async (vehicleId: string, file: File, documentType: string, intentKey: "vehiclePhotoIntentId" | "evidenceIntentId") => {
      let documentId = createdVehiclePhotoRef.current?.[intentKey] ?? "";
      if (documentId) {
        const existing = await fetch(`/api/documents/${encodeURIComponent(documentId)}/download`, { credentials: "include" }).catch(() => null);
        if (existing?.ok) return documentId;
      } else {
        const intent = await uploadIntent.mutateAsync({ data: {
          vehicleId, documentType, fileName: file.name.slice(0, 160),
          contentType: file.type as "image/png" | "image/jpeg", byteSize: file.size,
        } });
        documentId = String(intent.id ?? "");
        if (!UUID_RE.test(documentId)) throw new Error("تعذر تجهيز رفع الملف الخاص.");
        if (createdVehiclePhotoRef.current) createdVehiclePhotoRef.current[intentKey] = documentId;
      }
      let uploadResponse: Response | null = null;
      try {
        uploadResponse = await fetch(`/api/documents/${encodeURIComponent(documentId)}/content`, {
          method: "PUT", credentials: "include",
          headers: { "Content-Type": "application/octet-stream" }, body: file,
        });
      } catch {
        // A dropped response may follow a successful private storage commit.
      }
      if (!uploadResponse?.ok) {
        const verification = await fetch(`/api/documents/${encodeURIComponent(documentId)}/download`, { credentials: "include" }).catch(() => null);
        if (!verification?.ok) throw Object.assign(new Error("تعذر تأكيد حفظ الملف في التخزين الخاص؛ أعد المحاولة دون إعادة إنشاء المركبة."), { status: uploadResponse?.status ?? 502 });
      }
      return documentId;
    };
    const key = commandRetryRef.current?.key ?? crypto.randomUUID();
    commandRetryRef.current = { signature, key };
    let result: Row = {};
    try {
      const requestBody = { action: command, payload, reason: reason.trim(), idempotencyKey: key };
      result = fields(fieldsByAction[command]?.includes("pinCode")
        ? await postSensitive("/api/admin/fleet/commands", requestBody)
        : await execute.mutateAsync({ data: requestBody as never }));
      if (createVehicle) {
        const vehicleId = String(get(result, "id", "vehicleId") ?? "");
        if (!UUID_RE.test(vehicleId)) throw new Error("أُرسلت المركبة لكن تعذر تأكيد سجلها من الخادم.");
        createdVehiclePhotoRef.current = createdVehiclePhotoRef.current?.signature === signature
          ? createdVehiclePhotoRef.current
          : {
            signature, photoSignature, evidenceSignature, id: vehicleId,
            driverLinked: driverMode === "none",
            driverCreated: driverMode !== "new",
            driverId: initialDriverId,
            photoSaved: !vehiclePhoto,
            odometerRecorded: !initialReadingRaw,
            evidenceSaved: !odometerEvidencePhoto,
          };
        setVehicleCreatedMessage(`تم إنشاء المركبة ${String(payload.plateOriginal ?? "")}؛ تُحفظ كل خطوة لاحقة على حدة ولا تعيد إنشاءها عند المحاولة.`);
        if (driverMode === "new" && !createdVehiclePhotoRef.current.driverCreated) {
          const driverSignature = `${signature}:${newDriverCode}:${newDriverName}:${newDriverPhone}`;
          const driverKey = driverCreateRetryRef.current?.signature === driverSignature ? driverCreateRetryRef.current.key : crypto.randomUUID();
          driverCreateRetryRef.current = { signature: driverSignature, key: driverKey };
          const driverResult = fields(await execute.mutateAsync({ data: {
            action: "driver.create",
            payload: { organizationId: String(payload.organizationId), driverCode: newDriverCode, fullName: newDriverName, ...(newDriverPhone ? { phone: newDriverPhone } : {}) },
            reason: reason.trim(),
            idempotencyKey: driverKey,
          } as never }));
          const newDriverId = String(get(driverResult, "id", "driverId") ?? "");
          if (!UUID_RE.test(newDriverId)) throw new Error("حُفظت المركبة لكن تعذر تأكيد سجل السائق التشغيلي.");
          createdVehiclePhotoRef.current.driverId = newDriverId;
          createdVehiclePhotoRef.current.driverCreated = true;
          driverCreateRetryRef.current = null;
        }
        const chosenDriverId = driverMode === "existing" ? initialDriverId : driverMode === "new" ? createdVehiclePhotoRef.current.driverId : "";
        if (chosenDriverId && !createdVehiclePhotoRef.current.driverLinked) {
          const isoDate = (value: string) => {
            const parsed = new Date(value);
            return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
          };
          const linkSignature = `${vehicleId}:${chosenDriverId}:${initialLinkStartsAt}:${reason.trim()}`;
          const linkKey = driverLinkRetryRef.current?.signature === linkSignature
            ? driverLinkRetryRef.current.key
            : crypto.randomUUID();
          driverLinkRetryRef.current = { signature: linkSignature, key: linkKey };
          await postSensitive("/api/admin/fleet/commands", {
            action: "driver.link.create",
            payload: {
              vehicleId, driverId: chosenDriverId, ...(initialLinkPin ? { pinCode: initialLinkPin } : {}),
              startsAt: isoDate(initialLinkStartsAt),
            },
            reason: reason.trim(),
            idempotencyKey: linkKey,
          });
          createdVehiclePhotoRef.current.driverLinked = true;
          driverLinkRetryRef.current = null;
        }
        if (vehiclePhoto && !createdVehiclePhotoRef.current.photoSaved) {
          setPhotoUploadPending(true);
          try {
            const documentId = await uploadPrivateImage(vehicleId, vehiclePhoto, "vehicle_photo", "vehiclePhotoIntentId");
            createdVehiclePhotoRef.current.photoSaved = true;
            void documentId;
          } finally {
            setPhotoUploadPending(false);
          }
        }
        if (odometerEvidencePhoto && !createdVehiclePhotoRef.current.evidenceSaved) {
          setPhotoUploadPending(true);
          try {
            const evidenceId = await uploadPrivateImage(vehicleId, odometerEvidencePhoto, "odometer_evidence", "evidenceIntentId");
            createdVehiclePhotoRef.current.evidenceDocumentId = evidenceId;
            createdVehiclePhotoRef.current.evidenceSaved = true;
          } finally {
            setPhotoUploadPending(false);
          }
        }
        if (initialReadingRaw && !createdVehiclePhotoRef.current.odometerRecorded) {
          const readingSignature = `${vehicleId}:${initialReadingRaw}:${initialRecordedAt}:${createdVehiclePhotoRef.current.evidenceDocumentId ?? ""}:${reason.trim()}`;
          const readingKey = odometerRetryRef.current?.signature === readingSignature ? odometerRetryRef.current.key : crypto.randomUUID();
          odometerRetryRef.current = { signature: readingSignature, key: readingKey };
          await execute.mutateAsync({ data: {
            action: "odometer.record",
            payload: {
              vehicleId, readingKm: Number(initialReadingRaw),
              recordedAt: new Date(initialRecordedAt).toISOString(),
              source: "vehicle_onboarding",
              ...(createdVehiclePhotoRef.current.evidenceDocumentId ? { evidenceDocumentId: createdVehiclePhotoRef.current.evidenceDocumentId } : {}),
            },
            reason: reason.trim(),
            idempotencyKey: readingKey,
          } as never });
          createdVehiclePhotoRef.current.odometerRecorded = true;
          odometerRetryRef.current = null;
        }
        const incomplete = !createdVehiclePhotoRef.current.driverLinked || !createdVehiclePhotoRef.current.driverCreated || !createdVehiclePhotoRef.current.photoSaved || !createdVehiclePhotoRef.current.odometerRecorded || !createdVehiclePhotoRef.current.evidenceSaved;
        if (incomplete) throw new Error("تم حفظ المركبة، وما زالت خطوة اختيارية بحاجة إلى إكمال.");
      }
      if (command === "credential.activate_qr" || command === "credential.activate_nfc") {
        const token = get(result, "oneTimeToken");
        if (typeof token === "string") setOneTimeToken(token);
      }
      if (command === "tag_stock.receive") setLastStockStatus(text(get(result, "status")));
      if (command === "tag_stock.reserve") {
        setLastStockStatus(text(get(result, "status")));
        setLastReservedStockUnitId(String(get(result, "id", "stockUnitId") ?? ""));
        const reservedRequestId = String(get(result, "requestId") ?? selectedReserveRequestRef.current?.id ?? "");
        if (UUID_RE.test(reservedRequestId)) {
          setLastReservedRequestId(reservedRequestId);
          setLastReservedVehicleId(selectedReserveRequestRef.current?.id === reservedRequestId ? selectedReserveRequestRef.current.vehicleId : "");
          setLastReservedRequestLabel(selectedReserveRequestRef.current?.id === reservedRequestId ? selectedReserveRequestRef.current.label : "");
        }
      }
      if (command === "tag_stock.damage" || command === "credential.install") {
        setLastStockStatus(text(get(result, "status")));
        setLastReservedStockUnitId("");
        setLastReservedRequestId("");
        setLastReservedVehicleId("");
        setLastReservedRequestLabel("");
      }
      setMessage(command.startsWith("credential.activate_") ? "صدر معرّف منطقي لمرة واحدة من الخدمة. لا يمثل ذلك كتابة فعلية على NFC أو تحصيلًا." : command === "vehicle.create" && driverMode !== "none" && !initialLinkPin ? "تم حفظ المركبة وربط السائق دون رمز تعبئة؛ يمكن للمخول تعيينه لاحقًا." : "تم إرسال الإجراء إلى الخادم وتسجيله.");
      setShowForm(false); setReason("");
      commandRetryRef.current = null;
      createdVehiclePhotoRef.current = null;
      setVehicleCreatedMessage("");
      setVehiclePhoto(null);
      setOdometerEvidencePhoto(null);
      if (path === "/admin/fleet/vehicles/new") navigate("/admin/fleet/vehicles");
      await refresh();
    } catch (error) {
      if (createdVehiclePhotoRef.current) setVehicleCreatedMessage(`تم إنشاء المركبة ${String(payload.plateOriginal ?? "المركبة")}؛ تعذر إكمال خطوة لاحقة. أعد المحاولة في هذا النموذج لتجنب التكرار.`);
      setProblem(apiError(error));
    }
    finally {
      delete payload.pinCode;
      execute.reset();
    }
  };
  async function verifyPair(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const pinCode = pairPin;
    const linkId = String(form.get("linkId") ?? "");
    const vehicleId = String(form.get("vehicleId") ?? "");
    setPairPin("");
    setPairResult("");
    try {
      const result = await postSensitive("/api/admin/fleet/driver-pairs/verify", { linkId, vehicleId, pinCode });
      setPairResult(result.valid ? "تم التحقق من الربط." : result.locked ? "محاولات التحقق مقفلة مؤقتًا." : "تعذر التحقق من الرمز.");
    }
    catch (error) { setPairResult(apiError(error)); }
  }
  async function uploadDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setProblem(""); setMessage("");
    const form = new FormData(event.currentTarget);
    const file = form.get("file");
    if (!(file instanceof File) || !file.size) { setProblem("اختر ملفًا صالحًا."); return; }
    if (file.size > 10 * 1024 * 1024 || !["application/pdf", "image/png", "image/jpeg"].includes(file.type)) { setProblem("الحد الأقصى ١٠ ميغابايت؛ الملفات المقبولة PDF أو PNG أو JPEG."); return; }
    try {
      const intent = await uploadIntent.mutateAsync({ data: { vehicleId: String(form.get("vehicleId")), documentType: String(form.get("documentType")), fileName: file.name.slice(0, 160), contentType: file.type as "application/pdf" | "image/png" | "image/jpeg", byteSize: file.size } });
      const response = await fetch(`/api/documents/${encodeURIComponent(intent.id)}/content`, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/octet-stream" }, body: file });
      if (!response.ok) throw Object.assign(new Error("تعذر رفع الملف."), { status: response.status });
      setMessage("تم رفع الملف إلى التخزين الخاص.");
      await refresh();
    } catch (error) { setProblem(apiError(error)); }
  }
  async function downloadTemplate() {
    setProblem("");
    try { const result = await templateDownload.refetch(); if (result.error) throw result.error; if (!result.data) throw new Error("تعذر تنزيل القالب."); const url = URL.createObjectURL(result.data); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "pertomax-fleet-import-template.xlsx"; anchor.click(); URL.revokeObjectURL(url); }
    catch (error) { setProblem(apiError(error)); }
  }
  async function previewImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setProblem(""); setImportPreview(null);
    if (!importFile) { setProblem("اختر ملف XLSX للمعاينة."); return; }
    try { setImportPreview(fields(await previewMutation.mutateAsync({ data: importFile }))); }
    catch (error) { setProblem(apiError(error)); }
  }
  async function applyImport() {
    const jobId = text(get(importPreview ?? {}, "jobId", "id"));
    if (jobId === "—" || importReason.trim().length < 3) { setProblem("تأكد من وجود رقم مهمة وسبب موثّق."); return; }
    setProblem("");
    const signature = `${jobId}:${importReason.trim()}`;
    const idempotencyKey = importApplyRetryRef.current?.signature === signature
      ? importApplyRetryRef.current.key
      : crypto.randomUUID();
    importApplyRetryRef.current = { signature, key: idempotencyKey };
    try { await applyMutation.mutateAsync({ jobId, data: { reason: importReason.trim(), idempotencyKey } }); setMessage("تم إرسال التطبيق الذري للمهمة."); setImportPreview(null); setImportReason(""); importApplyRetryRef.current = null; await refresh(); }
    catch (error) { setProblem(apiError(error)); }
  }
  async function copyToken() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(oneTimeToken);
      setMessage("نُسخ الرمز لمرة واحدة.");
    } catch { setProblem("تعذر نسخ الرمز؛ حدده وانسخه يدويًا."); }
  }
  async function reviewFleetDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!documentReview || !["approve", "reject", "needs_completion"].includes(documentDecision) || documentReason.trim().length < 3) {
      setProblem("اختر قرار المراجعة واكتب سببًا موثقًا.");
      return;
    }
    setProblem("");
    const documentId = text(get(documentReview, "id"));
    const expectedVersion = Number(get(documentReview, "version"));
    try {
      const response = await fetch(`/api/admin/organization-requests/document/${encodeURIComponent(documentId)}/decision`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion, action: documentDecision, reason: documentReason.trim() }),
      });
      if (!response.ok) throw Object.assign(new Error("تعذر تسجيل قرار المستند."), { status: response.status });
      setMessage("سُجل قرار مراجعة المستند.");
      setDocumentReview(null); setDocumentReason(""); setDocumentDecision("");
      await refresh();
    } catch (error) { setProblem(apiError(error)); }
  }
  const entries = records.slice(0, !["overview", "vehicle"].includes(view) ? 20 : records.length);
  const formCompanyVehicles = formOrganizationId
    ? records.filter(record => String(record.organizationId ?? "") === formOrganizationId)
    : [];
  const driverRecord = isDriverDetail ? fields(driverDetail.data) : null;
  const driverLinks = Array.isArray(driverRecord?.links) ? driverRecord.links as Row[] : [];
  const vehicleRecord = fields(root.vehicle);
  const formDefaults = isVehicleDetail ? vehicleRecord : isDriverDetail ? driverRecord ?? {} : selectedRecord;
  const acceptedReadings = (Array.isArray(root.odometer) ? root.odometer.map(fields) : [])
    .filter(item => String(item.status ?? "") === "accepted")
    .sort((left, right) => new Date(String(left.recordedAt ?? "")).getTime() - new Date(String(right.recordedAt ?? "")).getTime());
  const latestAcceptedReading = acceptedReadings.at(-1);
  const priorAcceptedReading = acceptedReadings.at(-2);
  const acceptedDistanceKm = latestAcceptedReading && priorAcceptedReading
    ? Number(latestAcceptedReading.readingKm) - Number(priorAcceptedReading.readingKm)
    : null;
  const importIssues = Array.isArray(importPreview?.validationErrors) ? importPreview.validationErrors as Row[] : Array.isArray(importPreview?.issues) ? importPreview.issues as Row[] : [];
  const totalRecords = get(pageInfo, "total", "totalCount");
  const numericTotal = typeof totalRecords === "number" ? totalRecords : typeof totalRecords === "string" && /^\d+$/.test(totalRecords) ? Number(totalRecords) : undefined;
  const totalPages = numericTotal !== undefined ? Math.max(1, Math.ceil(numericTotal / Number(get(pageInfo, "pageSize") ?? 20))) : undefined;
  const tableHeaders = useMemo(() => {
    const keys: string[] = [];
    for (const row of entries) for (const key of Object.keys(row)) if (!isHiddenKey(key) && !keys.includes(key)) keys.push(key);
    return keys.slice(0, 8);
  }, [query.data, view, page]);

  return <div className="fleet-page" dir="rtl">
        {!isCompanyRoute && <div className="fleet-heading"><div><div className="fleet-eyebrow"><span/> إدارة الأسطول / مركز التشغيل</div><h1>{title}</h1><p>الشركات والمركبات والسائقون وضوابط الاستخدام في مكان واحد.</p></div><div className="fleet-heading-mark">PERTOMAX <b>EG</b><small>إدارة تشغيلية</small></div></div>}
      <main className="fleet-main">
         {!isCompanyRoute && <div className="fleet-toolbar"><div className="fleet-breadcrumb"><span>الأسطول</span><ArrowLeft size={13}/><b>{title}</b></div>
           <div className="fleet-tools">{!["overview", "vehicle"].includes(view) && !isVehicleDetail && !isDriverDetail && <label className="fleet-search"><Search size={16}/><input data-testid="fleet-record-search" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder="بحث في سجلات هذا القسم" aria-label="البحث في السجل"/></label>}
            <button data-testid="fleet-refresh" className="fleet-button fleet-quiet" onClick={() => void refresh()}><RefreshCw size={15}/> تحديث</button>
            {canMutate && actionOptions[view]?.length > 0 && <><select data-testid="fleet-action-select" className="fleet-action-select" aria-label="اختر إجراء الأسطول" value={selectedAction} onChange={event => setCommand(event.target.value)}>{actionOptions[view].map(action => <option key={action} value={action}>{actionLabels[action] ?? "إجراء"}</option>)}</select><button data-testid="fleet-action-open" className="fleet-button" onClick={() => openAction(selectedAction)}><Plus size={16}/> تنفيذ إجراء</button></>}
            {canMutate && view === "vehicles" && <button data-testid="fleet-vehicle-create" className="fleet-button fleet-quiet" onClick={() => { navigate("/admin/fleet/vehicles/new"); openAction("vehicle.create"); }}><Plus size={16}/> مركبة</button>}
          </div>
        </div>}
         {view !== "overview" && <div className="fleet-filterbar">
           {(view === "vehicles" || view === "drivers" || view === "credentials" || view === "odometer" || view === "maintenance") && !isVehicleDetail && !isDriverDetail && <label>الحالة<select data-testid="fleet-status-filter" value={statusFilter} onChange={event => { setStatusFilter(event.target.value); setPage(1); }}><option value="">كل الحالات</option>{(view === "vehicles" || view === "drivers" ? ["active", "suspended", "inactive"] : view === "odometer" ? ["accepted", "pending_review", "rejected"] : view === "maintenance" ? ["recorded", "cancelled"] : ["requested", "approved", "assigned", "scheduled", "installed", "active"]).map(value => <option key={value} value={value}>{statusText(value)}</option>)}</select></label>}
           {!["overview", "vehicle"].includes(view) && !isVehicleDetail && !isDriverDetail && <label>الترتيب<select data-testid="fleet-sort" value={sort} onChange={event => { setSort(event.target.value as typeof sort); setPage(1); }}><option value="newest">الأحدث</option><option value="oldest">الأقدم</option>{view === "drivers" && <option value="name">الاسم</option>}{view === "vehicles" && <><option value="plate">رقم اللوحة</option><option value="updatedAt">آخر تحديث</option></>}</select></label>}
           {view === "vehicles" && <><label>التغطية<select data-testid="fleet-coverage-filter" value={coverageFilter} onChange={event => { setCoverageFilter(event.target.value); setPage(1); }}><option value="">كل التغطيات</option><option value="covered">مغطاة</option><option value="uncovered">غير مغطاة</option></select></label><label>نوع الوقود<input data-testid="fleet-fuel-filter" value={fuelFilter} onChange={event => { setFuelFilter(event.target.value); setPage(1); }} placeholder="تصفية الوقود"/></label></>}
          {(view === "vehicles" || view === "drivers" || view === "policies" || view === "coverage" || view === "credentials") && !isVehicleDetail && !isDriverDetail && <FleetReferencePicker kind="organization" label="الشركة" value={organizationFilter} allowAll onChange={value => { setOrganizationFilter(value); setBranchFilter(""); setVehicleFilter(""); setPage(1); }}/>}
          {(view === "vehicles" || view === "policies") && !isVehicleDetail && <FleetReferencePicker kind="branch" label="الفرع" value={branchFilter} organizationId={organizationFilter} allowAll onChange={value => { setBranchFilter(value); setPage(1); }}/>}
          {["policies", "coverage", "credentials", "documents", "odometer", "maintenance"].includes(view) && <FleetReferencePicker kind="vehicle" label="المركبة" value={vehicleFilter} organizationId={organizationFilter || undefined} allowAll onChange={value => { setVehicleFilter(value); setPage(1); }}/>}
        </div>}
         {message && <div className="fleet-feedback" role="status">{message}<button data-testid="fleet-message-dismiss" aria-label="إخفاء التنبيه" onClick={() => setMessage("")}><X size={15}/></button></div>}
         {problem && <div className="fleet-feedback is-error" role="alert">{problem}<button data-testid="fleet-error-dismiss" aria-label="إخفاء الخطأ" onClick={() => setProblem("")}><X size={15}/></button></div>}
         {oneTimeToken && <section className="fleet-token-once" aria-label="رمز منطقي لمرة واحدة"><div><b>رمز لمرة واحدة من الخادم</b><small>احتفظ به وفق الإجراء المعتمد؛ لن نعرضه مجددًا بعد الإغلاق. ليس إثباتًا لكتابة NFC فعلية.</small></div><code dir="ltr">{oneTimeToken}</code><button data-testid="fleet-token-copy" className="fleet-row-action" onClick={() => void copyToken()}>نسخ الرمز</button><button data-testid="fleet-token-hide" className="fleet-icon-button" onClick={() => setOneTimeToken("")} aria-label="إخفاء الرمز">إخفاء</button></section>}
        {isCompanyRoute ? <FleetDirectory canMutate={canMutate} branchOnly={!isCompanyDirectory}/> : query.isLoading ? <Skeleton/> : query.isError ? <State error title="تعذر تحميل بيانات الأسطول" retry={() => void query.refetch()}>{apiError(query.error)}</State> :
        <>
          {view === "overview" && <><section className="fleet-intro"><div className="fleet-intro-copy"><span className="fleet-eyebrow">قراءة تشغيلية مباشرة</span><h2>سجلات الأسطول<br/><em>ومؤشرات التشغيل.</em></h2><p>لوحة ضبط للشركات والفروع والمركبات والسائقين، مع سجل واضح للسياسات والتغطية.</p></div><div className="fleet-quick-links">{views.slice(1).map((item, index) => <Link data-testid={`fleet-quick-${item.view}`} key={item.path} href={item.path}><span className="fleet-index">{String(index + 1).padStart(2, "0")}</span><span>{item.icon}<b>{item.title}</b></span><ArrowLeft size={15}/></Link>)}</div></section><section className="fleet-overview-metrics">{Object.entries(root).filter(([key, value]) => typeof value === "number" && !isHiddenKey(key)).map(([key, value]) => <article key={key}><small>{labels[key] ?? key}</small><bdi>{Number(value).toLocaleString("ar-EG")}</bdi></article>)}</section></>}
           {view === "credentials" && canMutate && <section className="fleet-panel">
             <div className="fleet-panel-head"><div><span className="fleet-eyebrow">متابعة المخزون</span><h2>وحدات تعريف محجوزة</h2><p>تظهر الحجوزات المحفوظة حتى بعد تحديث الصفحة، مع طلبها ومركبتها والفرع المرتبط بها.</p></div></div>
             {stockReservations.isLoading ? <Skeleton/> : stockReservations.isError ? <State error title="تعذر تحميل الحجوزات" retry={() => void stockReservations.refetch()}>{apiError(stockReservations.error)}</State> : reservedStockRows.length ? <div className="fleet-table-scroll"><table className="fleet-table"><thead><tr><th>الوحدة</th><th>الشركة / الفرع</th><th>المركبة</th><th>حالة الطلب</th><th>تاريخ الحجز</th><th>الإجراء</th></tr></thead><tbody>{reservedStockRows.map((reservation, index) => {
               const requestStatus = String(reservation.requestStatus ?? "");
               return <tr key={String(reservation.stockUnitId ?? reservation.id ?? index)}>
                 <td><bdi dir="ltr">{text(reservation.unitCode)}</bdi></td>
                 <td>{text(reservation.organizationName)} / {text(reservation.branchName)}</td>
                 <td><bdi dir="ltr">{text(reservation.vehiclePlate)}</bdi></td>
                 <td><span className={`fleet-status status-${requestStatus}`}>{statusText(requestStatus)}</span></td>
                 <td>{date(reservation.reservedAt)}</td>
                 <td><div className="fleet-row-actions">{["assigned", "scheduled"].includes(requestStatus)
                   ? <button data-testid={`fleet-stock-resume-install-${index + 1}`} className="fleet-row-action" onClick={() => openAction("credential.install", reservation)}>استكمال تسجيل التركيب</button>
                   : requestStatus === "approved"
                     ? <button data-testid={`fleet-stock-resume-assign-${index + 1}`} className="fleet-row-action" onClick={() => openAction("credential.assign", reservation)}>استكمال الإسناد</button>
                     : <span className="fleet-row-action-text">مراجعة الطلب</span>}</div></td>
               </tr>;
             })}</tbody></table></div> : <p className="fleet-muted">لا توجد وحدات مخزون محجوزة حاليًا.</p>}
           </section>}
           {view === "imports" && <section className="fleet-panel">
            <div className="fleet-panel-head"><div><span className="fleet-eyebrow">استيراد ذري</span><h2>ملف عمل واحد، ومراجعة قبل التطبيق</h2><p>المعاينة لا تغيّر السجلات. التطبيق كله أو لا شيء.</p></div><button data-testid="fleet-import-template" className="fleet-button fleet-quiet" onClick={() => void downloadTemplate()}><FileText size={16}/> تنزيل قالب XLSX</button></div>
            {canMutate && <form className="fleet-form" onSubmit={previewImport}><Field label="ملف Excel"><input data-testid="fleet-import-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={event => setImportFile(event.target.files?.[0] ?? null)}/></Field><button data-testid="fleet-import-preview" className="fleet-button" disabled={!importFile || previewMutation.isPending}>{previewMutation.isPending ? "جارٍ التحقق…" : "معاينة والتحقق"}</button></form>}
            {importPreview && <div className="fleet-preview"><b>نتيجة المعاينة</b><div className="fleet-facts">{Object.entries(importPreview).filter(([key]) => !isHiddenKey(key) && !["issues", "validationErrors"].includes(key)).map(([key, value]) => <div key={key}><small>{labels[key] ?? key}</small><b>{readable(value)}</b></div>)}</div>{importIssues.length > 0 ? <div className="fleet-issues"><b>ملاحظات الصفوف ({importIssues.length.toLocaleString("ar-EG")})</b>{importIssues.map((issue, index) => <div key={`${text(issue.sheet)}-${text(issue.row)}-${index}`}><b>{text(issue.sheet)} · صف {text(issue.row)}</b><span>{labels[String(issue.field)] ?? text(issue.field)} — {text(issue.message)}</span></div>)}</div> : <p className="fleet-inline-status">لم تُعد المعاينة ملاحظات صفوف.</p>}<Reason value={importReason} onChange={setImportReason}/>{canMutate && text(get(importPreview, "status")) === "previewed" && <button data-testid="fleet-import-apply" className="fleet-button" disabled={importIssues.length > 0 || importReason.trim().length < 3 || text(get(importPreview, "jobId", "id")) === "—" || applyMutation.isPending} onClick={() => void applyImport()}>{applyMutation.isPending ? "جارٍ تطبيق الملف…" : "تطبيق جميع الصفوف ذريًا"}</button>}</div>}
          </section>}
          {view === "documents" && <section className="fleet-panel"><div className="fleet-panel-head"><div><span className="fleet-eyebrow">مستند خاص</span><h2>رفع ملف مركبة</h2><p>تُحفظ البيانات الوصفية والملف في مسار خاص محمي.</p></div></div>{canMutate ? <form className="fleet-form" onSubmit={uploadDocument}><FleetReferencePicker kind="vehicle" name="vehicleId" label="المركبة" value={documentVehicleId} organizationId={organizationFilter || undefined} onChange={setDocumentVehicleId}/><Field label="نوع المستند"><input data-testid="fleet-document-type" name="documentType" required minLength={2} maxLength={80}/></Field><Field label="الملف"><input data-testid="fleet-document-file" name="file" type="file" accept="application/pdf,image/png,image/jpeg" required/></Field><button data-testid="fleet-document-upload" className="fleet-button" disabled={uploadIntent.isPending || !documentVehicleId}>{uploadIntent.isPending ? "جارٍ تجهيز الرفع…" : "رفع الملف"}</button></form> : <p className="fleet-muted">الرفع متاح لمالك المنصة والعمليات فقط.</p>}</section>}
          {view === "drivers" && canMutate && !isDriverDetail && <section className="fleet-panel fleet-verify"><div><span className="fleet-eyebrow">عملية محمية</span><h2>التحقق من ربط السائق</h2><p>أدخل رمزًا من أربعة أرقام. يُرسل للتحقق ولا يُعرض أو يُحفظ في السجل.</p></div><form onSubmit={verifyPair}><FleetReferencePicker kind="vehicle" name="vehicleId" label="المركبة" value={verifyVehicleId} organizationId={organizationFilter || undefined} onChange={value => { setVerifyVehicleId(value); setVerifyLinkId(""); }}/><FleetReferencePicker kind="link" name="linkId" label="ربط السائق النشط" value={verifyLinkId} vehicleId={verifyVehicleId || undefined} onChange={setVerifyLinkId}/><Field label="رمز PIN"><input data-testid="fleet-verify-pin" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{4}" maxLength={4} value={pairPin} onChange={event => setPairPin(event.target.value.replace(/\D/g, "").slice(0, 4))} required/></Field><button data-testid="fleet-verify-submit" className="fleet-button" disabled={pairPin.length !== 4 || !verifyVehicleId || !verifyLinkId}>{pairPin.length !== 4 ? "أدخل الرمز" : "تحقق"}</button></form>{pairResult && <p role="status" className="fleet-inline-status">{pairResult}</p>}</section>}
          {view === "credentials" && <p className="fleet-caution"><LockKeyhole size={15}/> التنشيط المنطقي لا يعني دفعًا أو كتابة فعلية على NFC. يتطلب NFC إعفاءً معتمدًا وإثبات تركيب ومخزونًا مركبًا.</p>}
          {view === "coverage" && <p className="fleet-caution"><BadgeCheck size={15}/> التغطية قراءة أو إسناد فقط؛ لا تُحصّل اشتراكًا ولا تتجاوز أهلية الأسطول.</p>}
          {view === "policies" && <p className="fleet-caution"><ShieldCheck size={15}/> نشر السياسة يضبط الأهلية اللاحقة فقط؛ لا ينفّذ خدمة أو دفعة.</p>}
          {view === "documents" && <p className="fleet-caution">التنزيل متاح فقط عبر رابط الخادم الموقّع. لا تُعرض مسارات التخزين.</p>}
          {isVehicleDetail && <section className="fleet-panel fleet-record-detail"><div className="fleet-panel-head"><div><span className="fleet-eyebrow">مركبة / ملف كامل</span><h2>{text(get(vehicleRecord, "plateOriginal", "plateStandard"))}</h2><p>الحقائق والارتباطات من ملف المركبة.</p></div></div><div className="fleet-facts">{Object.entries(vehicleRecord).filter(([key, value]) => !isHiddenKey(key) && (value === null || typeof value !== "object")).map(([key, value]) => <div key={key}><small>{labels[key] ?? key}</small><b>{key.toLowerCase().includes("at") ? date(value) : statusText(value)}</b></div>)}</div>{(["driverLinks", "credentials", "coverage", "documents", "odometer", "maintenance", "events"] as const).map(key => { const list = root[key]; if (!Array.isArray(list)) return null; return <section className="fleet-detail-list" key={key}><h3>{({ driverLinks: "روابط السائقين", credentials: "الرموز النشطة وتلميحاتها", coverage: "التغطية", documents: "المستندات", odometer: "قراءات العداد", maintenance: "الصيانة", events: "سجل الأحداث" } as Record<string, string>)[key]}</h3>{list.length ? <div className="fleet-facts">{list.map((record, index) => <div key={`${key}-${index}`}>{Object.entries(fields(record)).filter(([field]) => !isHiddenKey(field)).map(([field, value]) => <span key={field}><small>{labels[field] ?? field}</small><b>{typeof value === "object" ? readable(value) : field.toLowerCase().includes("at") ? date(value) : statusText(value)}</b></span>)}</div>)}</div> : <p className="fleet-muted">لا توجد عناصر في هذا القسم.</p>}</section>; })}</section>}
          {isVehicleDetail && <section className="fleet-efficiency-panel"><div><small>آخر قراءة مقبولة</small><b>{latestAcceptedReading ? `${text(latestAcceptedReading.readingKm)} كم` : "لا توجد قراءة مقبولة"}</b></div><div><small>المسافة بين آخر قراءتين مقبولتين</small><b>{acceptedDistanceKm !== null && Number.isFinite(acceptedDistanceKm) && acceptedDistanceKm >= 0 ? `${acceptedDistanceKm.toLocaleString("ar-EG")} كم` : "غير متاح"}</b></div><div><small>كفاءة الوقود الفعلية</small><b>غير متاحة</b><p>لا توجد أحداث تعبئة بكمية وقود فعلية لحساب كم/لتر أو لتر/١٠٠ كم.</p></div></section>}
          {isVehicleDetail && UUID_RE.test(String(vehicleRecord.organizationId ?? "")) && <FleetFuelRate organizationId={String(vehicleRecord.organizationId)} branchId={UUID_RE.test(String(vehicleRecord.branchId ?? "")) ? String(vehicleRecord.branchId) : undefined} canMutate={canMutate}/>}
          {isDriverDetail && <section className="fleet-panel fleet-record-detail">
            <div className="fleet-panel-head"><div><span className="fleet-eyebrow">سائق / ملف</span><h2>{driverRecord ? text(driverRecord.fullName) : "بيانات السائق"}</h2><p>الملف والإسنادات المؤرخة من السجل المخول؛ رمز PIN لا يُعرض أو يُسترجع.</p></div></div>
            {driverDetail.isLoading ? <Skeleton/> : driverDetail.isError ? <State error title="تعذر تحميل ملف السائق" retry={() => void driverDetail.refetch()}>{apiError(driverDetail.error)}</State> : driverRecord ? <>
              <div className="fleet-facts">{Object.entries(driverRecord).filter(([key, value]) => key !== "links" && !isHiddenKey(key) && (value === null || typeof value !== "object")).map(([key, value]) => <div key={key}><small>{labels[key] ?? key}</small><b>{key.toLowerCase().includes("at") ? date(value) : statusText(value)}</b></div>)}</div>
              <div className="fleet-detail-list"><h3>إسنادات المركبات</h3>{driverLinks.length ? <div className="fleet-facts">{driverLinks.map((link, index) => <div key={`driver-link-${String(link.id ?? index)}`}>
                <span><small>المركبة</small><b>{text(link.vehiclePlate)}</b></span>
                <span><small>الفرع الحالي</small><b>{text(link.branchName)}</b></span>
                <span><small>حالة الإسناد</small><b>{statusText(link.status)}</b></span>
                <span><small>بداية الإسناد</small><b>{date(link.startsAt)}</b></span>
                <span><small>نهاية الإسناد</small><b>{link.endsAt ? date(link.endsAt) : "مستمر"}</b></span>
                {Boolean(link.vehicleId) && <Link className="fleet-row-action" href={`/admin/fleet/vehicles/${encodeURIComponent(String(link.vehicleId))}`}>فتح ملف المركبة</Link>}
              </div>)}</div> : <p className="fleet-muted">لا توجد إسنادات مسجلة لهذا السائق.</p>}</div>
            </> : <State title="لم يُعثر على سجل السائق">تحقق من أن السجل ما زال متاحًا ضمن نطاق صلاحيتك.</State>}
            {driverEvents.isLoading ? <Skeleton/> : driverEvents.isError ? <State error title="تعذر تحميل سجل الأحداث" retry={() => void driverEvents.refetch()}>{apiError(driverEvents.error)}</State> : <div className="fleet-detail-list"><h3>أحداث السائق</h3>{safeRows(driverEvents.data, "events").length ? <div className="fleet-facts">{safeRows(driverEvents.data, "events").map((event, index) => <div key={`driver-event-${index}`}>{Object.entries(event).filter(([key]) => !isHiddenKey(key)).map(([key, value]) => <span key={key}><small>{labels[key] ?? key}</small><b>{typeof value === "object" ? readable(value) : key.toLowerCase().includes("at") ? date(value) : statusText(value)}</b></span>)}</div>)}</div> : <p className="fleet-muted">لا توجد أحداث مرتبطة في السجل المتاح.</p>}</div>}
          </section>}
          {view !== "overview" && <section className="fleet-table-card">
            <div className="fleet-table-head"><div><span className="fleet-eyebrow">السجلات المعتمدة</span><h2>{isVehicleDetail || isDriverDetail ? "تفاصيل السجل" : `${title} — السجل`}</h2></div><span className="fleet-count">{text(totalRecords ?? records.length)} <small>{totalRecords === undefined ? "نتيجة" : "سجل مطابق"}</small></span></div>
            {entries.length === 0 ? <State title="لا توجد سجلات للعرض">ستظهر هنا النتائج التي يعيدها الخادم، دون سجلات أو مؤشرات افتراضية.</State> :
            <div className="fleet-table-scroll"><table><thead><tr>{tableHeaders.map(key => <th key={key}>{labels[key] ?? key}</th>)}<th>إجراء</th></tr></thead><tbody>{entries.map((row, index) => {
              const id = text(get(row, "id", "vehicleId", "driverId", "policyId", "documentId", "eventId", "jobId"));
              const opensRecord = (view === "vehicles" || view === "drivers") && id !== "—";
              const openRecord = () => { if (view === "vehicles") navigate(`/admin/fleet/vehicles/${encodeURIComponent(id)}`); else if (view === "drivers") navigate(`/admin/fleet/drivers/${encodeURIComponent(id)}`); };
              return <tr key={`${id}-${index}`} data-testid={`row-fleet-${view}-${index + 1}`} tabIndex={opensRecord ? 0 : undefined} role={opensRecord ? "link" : undefined} aria-label={opensRecord ? `فتح سجل ${view === "vehicles" ? "المركبة" : "السائق"} ${text(get(row, "plateOriginal", "fullName", "driverCode"))}` : undefined} onKeyDown={event => { if (opensRecord && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); openRecord(); } }} onClick={() => { if (opensRecord) openRecord(); }}>
                {tableHeaders.map(key => <td key={key}>{key.toLowerCase().includes("status") ? <span className={`fleet-status status-${String(row[key] ?? "").toLowerCase()}`}>{statusText(row[key])}</span> : <bdi dir={/id|plate|phone|code|amount|quantity|reading/i.test(key) ? "ltr" : undefined}>{typeof row[key] === "object" ? readable(row[key]) : key.toLowerCase().includes("at") || key.toLowerCase().includes("date") ? date(row[key]) : statusText(row[key])}</bdi>}</td>)}
                   <td>{view === "policies" && canMutate ? <div className="fleet-row-actions"><button data-testid={`fleet-policy-edit-${index + 1}`} className="fleet-row-action" onClick={event => { event.stopPropagation(); openAction(text(get(row, "status")) === "draft" ? "policy.update" : "policy.create", row); }}>{text(get(row, "status")) === "draft" ? "تعديل المسودة" : "نسخة جديدة"}</button>{text(get(row, "status")) === "draft" && <button data-testid={`fleet-policy-publish-${index + 1}`} className="fleet-row-action" onClick={event => { event.stopPropagation(); openAction("policy.publish", row); }}>نشر</button>}</div> : view === "documents" && id !== "—" ? <div className="fleet-row-actions"><button data-testid={`fleet-document-download-${index + 1}`} className="fleet-row-action" onClick={event => { event.stopPropagation(); void fetch(`/api/documents/${encodeURIComponent(id)}/download`, { credentials: "include" }).then(async response => { if (!response.ok) throw Object.assign(new Error("تعذر تنزيل المستند."), { status: response.status }); const body = await response.json() as Row; const href = text(get(body, "url", "downloadUrl")); if (href !== "—") window.location.assign(href); }).catch(error => setProblem(apiError(error))); }}>تنزيل</button>{canMutate && ["pending_review", "needs_completion"].includes(String(row.status)) && <button data-testid={`fleet-document-review-${index + 1}`} className="fleet-row-action" onClick={event => { event.stopPropagation(); setDocumentReview(row); setDocumentDecision(""); setDocumentReason(""); }}>مراجعة</button>}</div> : view === "imports" ? <button data-testid={`fleet-import-details-${index + 1}`} className="fleet-row-action" onClick={event => { event.stopPropagation(); setImportPreview(row); }}>تفاصيل المهمة</button> : <span className="fleet-row-action-text">{view === "vehicles" || view === "drivers" ? "فتح الملف" : statusText(get(row, "status"))}</span>}</td>
              </tr>;
            })}</tbody></table></div>}
            {!["overview", "vehicle"].includes(view) && entries.length > 0 && <div className="fleet-pagination"><span>عرض {entries.length.toLocaleString("ar-EG")} من {text(totalRecords ?? records.length)} سجل</span><div><button data-testid="fleet-prev-page" disabled={page <= 1} onClick={() => setPage(value => Math.max(1, value - 1))}>السابق</button><b>{page.toLocaleString("ar-EG")} / {totalPages?.toLocaleString("ar-EG") ?? "—"}</b><button data-testid="fleet-next-page" disabled={totalPages !== undefined ? page >= totalPages : entries.length < 20} onClick={() => setPage(value => value + 1)}>التالي</button></div></div>}
          </section>}
          {view === "documents" && entries.length > 0 && <p className="fleet-muted">تظهر بيانات المستند الوصفية فقط؛ لا تُعرض بصمات الملف أو مسارات التخزين.</p>}
          {view === "odometer" && <p className="fleet-caution"><Fuel size={15}/> مراجعة القراءة والتصحيح لا يغيّران سجل الخدمة المنفذة.</p>}
          {view === "maintenance" && <p className="fleet-muted">سجلات الصيانة ومواعيد الاستحقاق مصدرها الخادم.</p>}
        </>}
        {showForm && <div className="fleet-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closeForm(); }}><section ref={dialogRef} tabIndex={-1} className="fleet-dialog" role="dialog" aria-modal="true" aria-labelledby="fleet-dialog-title"><header><div><span className="fleet-eyebrow">إجراء مسجل</span><h2 id="fleet-dialog-title">{actionLabels[command] ?? "إجراء الأسطول"}</h2></div><button data-testid="fleet-dialog-close" className="fleet-icon-button" aria-label="إغلاق" onClick={closeForm}><X size={18}/></button></header><form className="fleet-form" noValidate={command === "vehicle.create" || command === "vehicle.update"} onSubmit={sendCommand}>
          {command === "vehicle.create" && <ol className="fleet-create-steps" aria-label="خطوات تسجيل المركبة">{["بيانات المركبة", "الشركة والفرع", "السائق والتعرّف", "المراجعة والحفظ"].map((step, index) => <li key={step} aria-current={formWizardStep === index ? "step" : undefined} className={formWizardStep === index ? "is-current" : index < formWizardStep ? "is-done" : ""}><b>{index + 1}</b><span>{step}</span></li>)}</ol>}
          {(command === "driver.link.end" || command === "credential.stop") && <FleetReferencePicker testId={`fleet-context-vehicle-${command.replaceAll(".", "-")}`} kind="vehicle" value={formVehicleId} organizationId={formOrganizationId || undefined} label="المركبة — لتحديد السجل المرتبط" emptyLabel="ابحث برقم اللوحة" onChange={(value, option) => { setFormVehicleId(value); if (option?.organizationId) setFormOrganizationId(option.organizationId); }}/>}
          {vehicleCreatedMessage && <div className="fleet-feedback" role="status"><p>{vehicleCreatedMessage}</p>{createdVehiclePhotoRef.current && !photoUploadPending && (!createdVehiclePhotoRef.current.driverLinked || !createdVehiclePhotoRef.current.driverCreated || !createdVehiclePhotoRef.current.photoSaved || !createdVehiclePhotoRef.current.odometerRecorded || !createdVehiclePhotoRef.current.evidenceSaved) && <button data-testid="fleet-create-continue-partial" type="button" className="fleet-button fleet-button-secondary" onClick={() => {
            const workflow = createdVehiclePhotoRef.current;
            const skipped = [!workflow?.driverCreated && "ملف السائق", !workflow?.driverLinked && "ربط السائق", !workflow?.photoSaved && "صورة المركبة", !workflow?.odometerRecorded && "قراءة العداد", !workflow?.evidenceSaved && "إثبات القراءة"].filter(Boolean).join("، ");
            setVehiclePhoto(null); setOdometerEvidencePhoto(null); setShowForm(false); setReason(""); setProblem("");
            commandRetryRef.current = null; createdVehiclePhotoRef.current = null; driverLinkRetryRef.current = null; driverCreateRetryRef.current = null; odometerRetryRef.current = null;
            setVehicleCreatedMessage(""); setMessage(`تم حفظ المركبة؛ لم تُستكمل: ${skipped || "خطوات اختيارية"}. يمكنك إضافة ما يلزم من أقسام الأسطول دون إعادة إنشاء المركبة.`);
            if (path === "/admin/fleet/vehicles/new") navigate("/admin/fleet/vehicles");
            void refresh();
          }}>المتابعة دون استكمال الخطوات المتعذرة</button>}</div>}
          <div className="fleet-form-grid">{(fieldsByAction[command] ?? []).map(field => {
          const optional = new Set(["modelYear", "chassisNumber", "internalCode", "phone", "endsAt", "previousCredentialId", "scheduledAt", "evidenceDocumentId", "supersedesEventId", "odometerEventId", "nextDueAt", "nextDueKm", "documentId", "credentialType"]);
          const isRequired = !optional.has(field) && !(field === "vehicleId" && command === "policy.create" && policyScope === "branch") && !(field === "branchId" && command === "policy.create" && policyScope === "vehicle");
          const defaultValue = field === "policyVersionId" ? formDefaults.id : field === "expectedVersion" ? formReferences.expectedVersion ?? formDefaults.version : field === "vehicleId" && isVehicleDetail ? formDefaults.id : field === "driverId" && isDriverDetail ? formDefaults.id : formDefaults[field];
          const dateTime = ["startsAt", "endsAt", "effectiveFrom", "scheduledAt", "recordedAt", "performedAt", "nextDueAt"].includes(field);
          const normalizedDefault = dateTime && typeof defaultValue === "string" ? defaultValue.slice(0, 16) : defaultValue;
          const stepByField = field === "organizationId" || field === "branchId" ? 1 : field === "credentialType" ? 2 : 0;
          const stepHidden = command === "vehicle.create" && formWizardStep < 3 && stepByField !== formWizardStep;
          const wizardRequired = command === "vehicle.create" && !stepHidden && (vehicleCreateRequiredByStep[formWizardStep] ?? []).includes(field);
          const common = { name: field, required: command === "vehicle.create" ? wizardRequired : isRequired, "aria-invalid": Boolean(wizardErrors[field]), onChange: () => clearWizardError(field), dir: /id|code|plate|phone/i.test(field) ? "ltr" as const : undefined, ...(field === "expectedVersion" ? {} : { defaultValue: String(normalizedDefault ?? "") }), "data-testid": `fleet-field-${field}` };
          const selectCommon = { ...common };
          delete selectCommon.defaultValue;
          const wizardHint = field === "plateOriginal" ? "أدخل اللوحة كما تظهر في المستند؛ تُشتق صيغة المطابقة بحذف المسافات فقط."
            : field === "plateStandard" ? "تُستخدم للمطابقة والبحث؛ تُشتق تلقائيًا من اللوحة الأصلية."
              : field === "category" ? "ابدأ الكتابة لعرض القيم المسجلة في هذه الشركة، أو أدخل التصنيف كما في مستند المركبة."
                : field === "vehicleType" ? "تظهر اقتراحات من سجلات الشركة؛ أدخل نوع المركبة كما يرد في مستنداتها."
                  : field === "brand" ? "ابحث بين أسماء الصانع المسجلة للشركة أو أدخل الاسم كما يظهر في المستند."
                    : field === "model" ? "ابحث بين طرازات الشركة المسجلة أو أدخل الطراز كما في المستند."
                      : field === "fuelType" ? "هذه فئة وقود المركبة (بنزين أو سولار أو غاز). درجة البنزين 80 أو 92 أو 95 تُحدد عند تسجيل التعبئة مستقبلًا."
                        : undefined;
          const companyValueOptions = ["category", "vehicleType", "brand", "model"].includes(field)
            ? [...new Set(formCompanyVehicles.map(record => String(record[field] ?? "").trim()).filter(Boolean))].slice(0, 30)
            : [];
          const companyValueListId = `fleet-company-values-${field}`;
          const wrap = (node: ReactNode) => <div key={field} hidden={stepHidden}>{node}</div>;
          const choices: Record<string, Array<[string, string]>> = {
            status: [["active", "نشط"], ["suspended", "موقوف"], ["inactive", "غير نشط"]],
            scope: [["branch", "نطاق فرع"], ["vehicle", "نطاق مركبة"]],
            fuelType: [["gasoline", "بنزين"], ["diesel", "سولار"], ["natural_gas", "غاز طبيعي"]],
            credentialType: [["qr", "QR"], ["nfc", "NFC"]],
            requestType: [["issue", "إصدار"], ["replace", "استبدال"]],
            maintenanceType: [["oil", "زيت"], ["parts", "قطع غيار"], ["battery", "بطارية"], ["filters", "فلاتر"], ["tires", "إطارات"], ["other", "أخرى"]],
            decision: command === "odometer.review" ? [["accepted", "مقبول"], ["rejected", "مرفوض"]] : [],
          };
          const fieldChoices = field === "fuelType" && String(normalizedDefault) === "petrol"
            ? [...(choices[field] ?? []), ["petrol", "بنزين محفوظ سابقًا"] as [string, string]]
            : choices[field] ?? [];
          if (field === "waive") return isOwner ? wrap(<Field label="إعفاء معتمد — لمالك المنصة فقط"><input type="checkbox" name="waive" value="true"/></Field>) : null;
          const referenceKind = referenceKinds[field];
          if (referenceKind) {
            const selectedId = formReferences[field] ?? (UUID_RE.test(String(defaultValue ?? "")) ? String(defaultValue) : "");
            if (field === "stockUnitId" && command === "credential.install" && selectedId) return wrap(<><input type="hidden" name={field} value={selectedId}/><Field label={labels[field]}><div className="fleet-reference-fixed">وحدة المخزون المحجوزة في هذه الجلسة</div></Field></>);
            if (field === "requestId" && command === "credential.install" && selectedId) return wrap(<><input type="hidden" name={field} value={selectedId}/><Field label={labels[field]}><div className="fleet-reference-fixed">{lastReservedRequestLabel || "الطلب المرتبط بوحدة المخزون المحجوزة"}</div></Field></>);
            const initialLabel = String(
              field === "organizationId" ? formDefaults.organizationName ?? formDefaults.companyName
                : field === "branchId" || field === "targetBranchId" ? formDefaults.branchName
                  : field === "vehicleId" ? formDefaults.plateOriginal ?? formDefaults.plateStandard
                    : field === "driverId" ? formDefaults.driverName ?? formDefaults.fullName
                      : field === "subscriptionId" ? formDefaults.planName ?? formDefaults.subscriptionLabel
                        : field === "requestId" ? formDefaults.requestLabel ?? formDefaults.plateOriginal
                          : field === "credentialId" ? formDefaults.credentialType ?? formDefaults.type
                            : field === "assignedTo" ? formDefaults.assignedToName ?? formDefaults.displayName
                              : "",
            );
            const locked = selectedId && ((field === "vehicleId" && isVehicleDetail && ["vehicle.update", "vehicle.status"].includes(command)) || (field === "driverId" && isDriverDetail && ["driver.update", "driver.status"].includes(command)));
            if (locked) return wrap(<><input type="hidden" name={field} value={selectedId}/><Field label={labels[field] ?? field}><div className="fleet-reference-fixed">{initialLabel || "السجل الحالي المحدد"}</div></Field></>);
            return wrap(<FleetReferencePicker kind={referenceKind} name={field} label={labels[field] ?? field} value={selectedId} initialLabel={initialLabel} organizationId={formOrganizationId || undefined} vehicleId={formVehicleId || undefined} allowedStatuses={field === "requestId" ? requestStatusesByAction[command] : referenceStatusesByAction[command]?.[field]} requiresWaiver={command === "credential.activate_nfc" && field === "requestId"} requiresProof={command === "credential.activate_nfc" && field === "requestId"} required={command === "vehicle.create" ? wizardRequired : isRequired} error={wizardErrors[field]} onChange={(value, option) => {
              clearWizardError(field);
              setFormReferences(current => {
                const next = { ...current, [field]: value };
                if (field === "organizationId") {
                  delete next.branchId; delete next.targetBranchId; delete next.vehicleId; delete next.driverId; delete next.initialDriverId; delete next.subscriptionId;
                }
                return next;
              });
              if (field === "organizationId") { setFormOrganizationId(value); setFormVehicleId(""); driverLinkRetryRef.current = null; }
              if (field === "vehicleId") { setFormVehicleId(value); if (option?.organizationId) setFormOrganizationId(option.organizationId); if (option?.version) setFormReferences(current => ({ ...current, expectedVersion: option.version! })); }
              if (field === "driverId" && option?.organizationId) setFormOrganizationId(option.organizationId);
              if (field === "driverId" && option?.version) setFormReferences(current => ({ ...current, expectedVersion: option.version! }));
              if (field === "requestId" && option?.vehicleId) { setFormVehicleId(option.vehicleId); if (option.organizationId) setFormOrganizationId(option.organizationId); }
              if (field === "requestId" && command === "tag_stock.reserve") selectedReserveRequestRef.current = { id: value, vehicleId: option?.vehicleId ?? "", label: option?.label ?? "طلب الإصدار المحدد" };
            }}/>);
          }
          if (fieldChoices.length) {
            const controlled = field === "scope" || field === "credentialType";
            return wrap(<Field label={labels[field] ?? field} required={wizardRequired} error={wizardErrors[field]} hint={wizardHint}><select {...selectCommon} {...(controlled ? { value: field === "scope" ? policyScope : vehicleCredentialChoice } : { defaultValue: String(normalizedDefault ?? "") })} onChange={event => { clearWizardError(field); if (field === "scope") setPolicyScope(event.target.value); else if (field === "credentialType") setVehicleCredentialChoice(event.target.value); }}>{field === "fuelType" && <option value="">اختر فئة الوقود من مستند المركبة</option>}{field === "credentialType" && <option value="">بدون طلب إصدار الآن</option>}{fieldChoices.map(([value, label]) => <option key={value} value={value} disabled={field === "credentialType" && value === "nfc" && nfcIssuePriceMinor === null}>{field === "credentialType" && value === "nfc" ? `NFC · ${egpFromMinor(nfcIssuePriceMinor)}` : label}</option>)}</select>{field === "credentialType" && <small>سعر إصدار الشريحة منفصل عن الاشتراك؛ الطلب لا يثبت التحصيل أو التركيب أو التفعيل.</small>}</Field>);
          }
          if (field === "expectedVersion") return wrap(<input type="hidden" name={field} value={formReferences.expectedVersion ?? String(defaultValue ?? "")} data-testid="fleet-current-record-version"/>);
          if (field === "pinCode") return wrap(<Field label={labels[field]}><input {...common} type="password" inputMode="numeric" autoComplete="new-password" pattern="[0-9]{4}" maxLength={4}/></Field>);
          if (field === "allowedWeekdays") return wrap(<fieldset className="fleet-weekday-picker"><legend>{labels[field]}</legend><p>الأيام غير المحددة تمنع الاستخدام.</p><div>{[["1","الاثنين"],["2","الثلاثاء"],["3","الأربعاء"],["4","الخميس"],["5","الجمعة"],["6","السبت"],["7","الأحد"]].map(([day, name]) => <label key={day}><input data-testid={`fleet-weekday-${day}`} type="checkbox" checked={formWeekdays.includes(day)} onChange={event => setFormWeekdays(current => event.target.checked ? [...current, day].sort() : current.filter(item => item !== day))}/>{name}</label>)}</div></fieldset>);
          if (field === "allowedMerchantOrganizationIds") return wrap(<FleetReferencePicker kind="organization" label={labels[field]} value="" multiple selectedValues={String(formReferences[field] ?? "").split(",").filter(Boolean)} onValuesChange={values => setFormReferences(current => ({ ...current, [field]: values.join(",") }))}/>);
          if (field === "allowedMerchantBranchIds") return wrap(<div className="fleet-policy-branch-picker"><FleetReferencePicker kind="organization" label="اختر جهة لعرض فروعها" value={merchantBranchScope} onChange={value => { setMerchantBranchScope(value); setFormReferences(current => ({ ...current, [field]: "" })); }}/><FleetReferencePicker kind="branch" label={labels[field]} value="" multiple selectedValues={String(formReferences[field] ?? "").split(",").filter(Boolean)} organizationId={merchantBranchScope || undefined} onValuesChange={values => setFormReferences(current => ({ ...current, [field]: values.join(",") }))}/></div>);
          if (field === "startTime" || field === "endTime") return wrap(<Field label={labels[field]} required={wizardRequired} error={wizardErrors[field]}><input {...common} type="time"/></Field>);
          if (field === "notes") return wrap(<Field label={labels[field] ?? field}><textarea {...common}/></Field>);
          const numeric = ["modelYear", "expectedVersion", "maxOperationMinor", "maxOperationQuantity", "dailyAmountLimitMinor", "weeklyAmountLimitMinor", "monthlyAmountLimitMinor", "dailyQuantityLimit", "weeklyQuantityLimit", "monthlyQuantityLimit", "readingKm", "nextDueKm"].includes(field);
          return wrap(<Field label={labels[field] ?? field} required={wizardRequired} error={wizardErrors[field]} hint={wizardHint}><><input {...common} list={companyValueOptions.length ? companyValueListId : undefined} min={field === "modelYear" ? "1900" : undefined} max={field === "modelYear" ? String(new Date().getFullYear()) : undefined} minLength={["plateOriginal", "category", "vehicleType", "brand", "model"].includes(field) ? 2 : undefined} maxLength={["plateOriginal", "category", "vehicleType", "brand", "model"].includes(field) ? 80 : undefined} type={numeric ? "number" : dateTime ? "datetime-local" : "text"}/>{companyValueOptions.length > 0 && <datalist id={companyValueListId}>{companyValueOptions.map(option => <option key={option} value={option}/>)}</datalist>}</></Field>);
        })}</div>
        {command === "vehicle.update" && <details className="fleet-plate-correction"><summary>تصحيح استثنائي لصيغة المطابقة</summary><p>تُشتق الصيغة تلقائيًا من اللوحة. استخدم هذا التصحيح فقط إذا راجعت المستند، وستبقى اللوحة الأصلية محفوظة.</p><label><input type="checkbox" name="overridePlateStandard"/> أحتاج إلى تصحيح القيمة المشتقة</label><Field label="الصيغة المصححة"><input data-testid="fleet-field-plateStandardCorrection" name="plateStandardCorrection" dir="ltr" minLength={2} maxLength={80} onChange={() => clearWizardError("plateStandardCorrection")}/></Field></details>}
        {command === "vehicle.create" && <section className="fleet-create-optional" hidden={formWizardStep < 2}>
          <div className="fleet-create-option-block"><h3>السائق التشغيلي (اختياري)</h3><p>السائق سجل تشغيلي فقط؛ لا يُنشأ حساب دخول أو مستخدم Auth.</p>
            <Field label="اختيار السائق"><select data-testid="fleet-create-driver-mode" name="initialDriverMode" value={initialDriverMode} onChange={event => { const mode = event.target.value as "none" | "existing" | "new"; setInitialDriverMode(mode); if (mode !== "existing") setFormReferences(current => { const next = { ...current }; delete next.initialDriverId; return next; }); driverLinkRetryRef.current = null; }}><option value="none">بدون سائق الآن</option><option value="existing">استخدام سائق موجود</option><option value="new">إضافة سائق تشغيلي جديد</option></select></Field>
            {initialDriverMode === "existing" && <FleetReferencePicker kind="driver" name="initialDriverId" label="السائق التشغيلي" value={formReferences.initialDriverId ?? ""} organizationId={formOrganizationId || undefined} testId="fleet-create-existing-driver" required error={wizardErrors.initialDriverId} onChange={value => { clearWizardError("initialDriverId"); setFormReferences(current => ({ ...current, initialDriverId: value })); driverLinkRetryRef.current = null; }}/>}
            {initialDriverMode === "new" && <div className="fleet-form-grid"><Field label="الكود التشغيلي للسائق" required error={wizardErrors.newDriverCode}><input data-testid="fleet-create-driver-code" name="newDriverCode" autoComplete="off" dir="ltr" maxLength={80} onChange={() => clearWizardError("newDriverCode")}/></Field><Field label="اسم السائق" required error={wizardErrors.newDriverName}><input data-testid="fleet-create-driver-name" name="newDriverName" maxLength={160} onChange={() => clearWizardError("newDriverName")}/></Field><Field label="رقم الهاتف (اختياري)"><input data-testid="fleet-create-driver-phone" name="newDriverPhone" inputMode="tel" dir="ltr" maxLength={40}/></Field></div>}
            {initialDriverMode !== "none" && <div className="fleet-create-link-fields"><p>رمز الربط اختياري. إذا أدخلته، يُستخدم مرة واحدة لإنشاء الربط الآمن؛ لن يُخزّن في واجهة التطبيق.</p><Field label="رمز ربط جديد من أربعة أرقام (اختياري)" error={wizardErrors.initialDriverPin}><input data-testid="fleet-create-driver-pin" type="password" name="initialDriverPin" inputMode="numeric" autoComplete="new-password" maxLength={4} onChange={() => clearWizardError("initialDriverPin")}/></Field><Field label="بداية الربط — مطلوبة عند إسناد السائق" required error={wizardErrors.initialLinkStartsAt}><input data-testid="fleet-create-link-starts-at" type="datetime-local" name="initialLinkStartsAt" onChange={() => clearWizardError("initialLinkStartsAt")}/></Field><Field label="نهاية الربط (اختياري)"><input data-testid="fleet-create-link-ends-at" type="datetime-local" name="initialLinkEndsAt"/></Field></div>}
          </div>
          <div className="fleet-create-option-block"><h3>قراءة العداد الأولية (اختيارية)</h3><p>تُسجل قراءة مؤرخة من مسار العداد المعتمد؛ لا تُحسب كفاءة الوقود دون أحداث تعبئة فعلية.</p><Field label="قراءة العداد بالكيلومتر" error={wizardErrors.initialReadingKm}><input data-testid="fleet-create-odometer-reading" type="number" name="initialReadingKm" min="0" step="0.001" value={initialReadingInput} onChange={event => { setInitialReadingInput(event.target.value); clearWizardError("initialReadingKm"); }}/></Field><Field label="وقت تسجيل القراءة" error={wizardErrors.initialRecordedAt}><input data-testid="fleet-create-odometer-time" type="datetime-local" name="initialRecordedAt" value={initialReadingTimeInput} onChange={event => { setInitialReadingTimeInput(event.target.value); clearWizardError("initialRecordedAt"); }}/></Field><div className="fleet-create-photo"><div><ImagePlus size={18}/><div><b>إثبات القراءة (اختياري)</b><small>صورة PNG أو JPEG تُحفظ عبر مسار المستند الخاص.</small></div></div><input data-testid="fleet-create-odometer-evidence" type="file" accept="image/png,image/jpeg" onChange={event => { const file = event.target.files?.[0] ?? null; if (file && !["image/png", "image/jpeg"].includes(file.type)) { setProblem("اختر صورة PNG أو JPEG فقط."); event.target.value = ""; return; } if (file && file.size > 10 * 1024 * 1024) { setProblem("حجم الصورة يتجاوز الحد المسموح 10 ميغابايت."); event.target.value = ""; return; } setProblem(""); setOdometerEvidencePhoto(file); }}/></div></div>
          <div className="fleet-create-option-block"><h3>صورة المركبة (اختيارية)</h3><p>تُرفع بعد إنشاء المركبة إلى التخزين الخاص.</p><div className="fleet-create-photo"><input data-testid="fleet-create-vehicle-photo" type="file" accept="image/png,image/jpeg" onChange={event => { const file = event.target.files?.[0] ?? null; if (file && !["image/png", "image/jpeg"].includes(file.type)) { setProblem("اختر صورة PNG أو JPEG فقط."); event.target.value = ""; return; } if (file && file.size > 10 * 1024 * 1024) { setProblem("حجم الصورة يتجاوز الحد المسموح 10 ميغابايت."); event.target.value = ""; return; } setProblem(""); setVehiclePhoto(file); }}/>{vehiclePhotoPreview && <img src={vehiclePhotoPreview} alt="معاينة صورة المركبة قبل الرفع"/>}</div></div>
        </section>}
         {command === "vehicle.create" && formWizardStep === 3 && <section className="fleet-create-review"><h3>مراجعة قبل الحفظ</h3><p>سيُنشأ سجل المركبة مرة واحدة. السائق والربط والعداد والملفات خطوات مستقلة؛ يمكن متابعة السجل إذا تعذرت خطوة لاحقة.</p><dl><div><dt>اللوحة</dt><dd>{text(formDefaults.plateOriginal) === "—" ? "أدخلت في الخطوة الأولى" : text(formDefaults.plateOriginal)}</dd></div><div><dt>الشركة والفرع</dt><dd>{formOrganizationId ? "محددان من القوائم" : "لم يُحددا"}</dd></div><div><dt>السائق التشغيلي</dt><dd>{initialDriverMode === "none" ? "بدون سائق" : initialDriverMode === "new" ? "سجل سائق جديد" : "سائق موجود"}</dd></div><div><dt>رمز الربط</dt><dd>{initialDriverMode === "none" ? "لا يوجد" : "اختياري؛ يُرسل مرة واحدة عند الربط"}</dd></div><div><dt>طلب تعريف المركبة</dt><dd>{vehicleCredentialChoice === "nfc" ? `طلب NFC · ${egpFromMinor(nfcIssuePriceMinor)}` : vehicleCredentialChoice === "qr" ? "طلب QR" : "لا يوجد طلب إصدار"}</dd></div><div><dt>قراءة العداد</dt><dd>{initialReadingInput ? `${initialReadingInput} كم · ${initialReadingTimeInput || "يلزم اختيار الوقت"}` : "لم تُسجل"}</dd></div><div><dt>إثبات العداد</dt><dd>{odometerEvidencePhoto ? "صورة مرفقة" : "بدون صورة"}</dd></div><div><dt>صورة المركبة</dt><dd>{vehiclePhoto ? "صورة مرفقة" : "بدون صورة"}</dd></div></dl><small>سعر NFC المعروض هو سعر الإصدار من إعدادات الخادم؛ لا يُحصّل هذا النموذج مبلغًا ولا يثبت أو ينشّط بطاقة.</small></section>}
        {(command === "policy.create" || command === "policy.update") && <fieldset className="fleet-policy-rules"><legend>حدود مجموعات الخدمة</legend><p>تبدأ كل مجموعة غير مفعّلة. لا يؤدي ترك حد فارغ إلى سماح مفتوح.</p><div className="fleet-policy-group-list">{policyGroups.map(group => {
          const currentRules = Array.isArray(formDefaults.rules) ? formDefaults.rules.map(fields) : [];
          const currentRule = currentRules.find(rule => text(get(rule, "serviceGroup", "service_group")) === group.id) ?? {};
          return <section key={group.id}><label className="fleet-policy-toggle"><input data-testid={`fleet-policy-rule-${group.id}`} type="checkbox" name={`rule_${group.id}_enabled`} defaultChecked={get(currentRule, "enabled") === true}/><b>{group.title}</b><span>غير مفعّل حتى الاعتماد</span></label><div className="fleet-policy-limit-grid">{policyRuleLimits.map(([field, label]) => <Field key={field} label={label}><input type="number" min="0" step="any" name={`rule_${group.id}_${field}`} defaultValue={String(get(currentRule, field, field.replace(/[A-Z]/g, value => `_${value.toLowerCase()}`)) ?? "")} placeholder="٠"/></Field>)}</div></section>;
        })}</div></fieldset>}{(command !== "vehicle.create" || formWizardStep === 3) && <Reason value={reason} onChange={setReason}/>}
        {problem && <p className="fleet-feedback is-error" role="alert">{problem}</p>}
        <div className="fleet-dialog-actions">
           {command === "vehicle.create" && formWizardStep > 0 && <button data-testid="fleet-wizard-back" type="button" className="fleet-button fleet-quiet" onClick={() => setFormWizardStep(step => Math.max(0, step - 1))}>السابق</button>}
           <button data-testid="fleet-command-submit" className="fleet-button" disabled={execute.isPending || photoUploadPending || uploadIntent.isPending || !canMutate || (command !== "vehicle.create" || formWizardStep === 3) && reason.trim().length < 3}>{execute.isPending || photoUploadPending || uploadIntent.isPending ? "جارٍ الحفظ…" : command === "vehicle.create" && formWizardStep < 3 ? "التالي" : command === "vehicle.create" ? "إنشاء المركبة" : "حفظ الإجراء"}</button>
           <button data-testid="fleet-command-cancel" type="button" className="fleet-button fleet-quiet" onClick={closeForm}>إلغاء</button>
        </div></form></section></div>}
        {documentReview && <div className="fleet-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setDocumentReview(null); }}><section className="fleet-dialog" role="dialog" aria-modal="true" aria-labelledby="fleet-document-review-title"><header><div><span className="fleet-eyebrow">مراجعة مستند مركبة</span><h2 id="fleet-document-review-title">{text(get(documentReview, "fileName"))}</h2></div><button data-testid="fleet-document-review-close" className="fleet-icon-button" aria-label="إغلاق" onClick={() => setDocumentReview(null)}><X size={18}/></button></header><form className="fleet-form" onSubmit={reviewFleetDocument}><Field label="قرار المراجعة"><select data-testid="fleet-document-decision" value={documentDecision} onChange={event => setDocumentDecision(event.target.value)} required><option value="">اختر القرار</option><option value="approve">اعتماد</option><option value="needs_completion">طلب استكمال</option><option value="reject">رفض</option></select></Field><Reason value={documentReason} onChange={setDocumentReason}/><div className="fleet-dialog-actions"><button data-testid="fleet-document-review-submit" className="fleet-button" disabled={documentReason.trim().length < 3}>تأكيد القرار</button><button data-testid="fleet-document-review-cancel" type="button" className="fleet-button fleet-quiet" onClick={() => setDocumentReview(null)}>إلغاء</button></div></form></section></div>}
        <div className="fleet-scope-note"><LockKeyhole size={14}/> الخدمة المنفذة، الكتابة الفعلية على NFC، الدفع، بوابات الشركات/الهاتف والبريد الإلكتروني أو PDF ليست ضمن هذه المساحة.</div>
       </main>
  </div>;
}
