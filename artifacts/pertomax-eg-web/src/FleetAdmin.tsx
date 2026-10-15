import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, BadgeCheck, ClipboardList, FileText, Fuel, Gauge, LockKeyhole,
  Plus, RefreshCw, Search, ShieldCheck, Truck, UserRound, Wrench, Upload, X,
} from "lucide-react";
import {
  getGetAdminFleetCatalogQueryKey, useCreateAdminFleetDocumentUploadIntent,
  useExecuteAdminFleetCommand, useGetAdminFleetCatalog,
} from "@workspace/api-client-react";
import type { GetAdminFleetCatalogParams } from "@workspace/api-client-react";
import "./FleetAdmin.css";

type Row = Record<string, unknown>;
type View = GetAdminFleetCatalogParams["view"];
const views: Array<{ path: string; view: View; title: string; icon: ReactNode }> = [
  { path: "/admin/fleet", view: "overview", title: "نظرة عامة", icon: <ClipboardList size={17}/> },
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
const hiddenKey = /pin|token|storage|object.?path|paymentstate|issuepriceminor/i;
const isHiddenKey = (key: string) => hiddenKey.test(key) && key !== "tokenHint";
function sanitized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitized);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Row).filter(([key]) => !isHiddenKey(key)).map(([key, item]) => [key, sanitized(item)]));
  return value;
}
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
};
const statusText = (value: unknown) => titles[String(value)] ?? text(value);
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
  id: "المعرّف", organizationName: "الجهة", organization: "الجهة", branchName: "الفرع",
  plateOriginal: "رقم اللوحة", plateStandard: "اللوحة المعيارية", category: "الفئة", type: "النوع",
  vehicleType: "نوع المركبة", modelYear: "سنة الصنع", brand: "الصانع", model: "الطراز", year: "سنة الصنع", chassisNumber: "رقم الشاسيه", internalCode: "الكود الداخلي",
  fuelType: "الوقود", status: "الحالة", coverage: "التغطية", eligibility: "الأهلية", activeCredentials: "الرموز النشطة",
  version: "الإصدار", driverCode: "كود السائق", fullName: "الاسم", phone: "الهاتف", vehicleId: "المركبة",
  startsAt: "يبدأ في", endsAt: "ينتهي في", effectiveFrom: "ساري من", effectiveTo: "ساري حتى",
  scope: "النطاق", schedule: "الجدول", allowedMerchants: "مقدمو الخدمة", serviceGroups: "مجموعات الخدمة",
  allowedWeekdays: "أيام الأسبوع (١ إلى ٧)", startTime: "بداية الفترة", endTime: "نهاية الفترة",
  allowedMerchantOrganizationIds: "معرّفات جهات الخدمة", allowedMerchantBranchIds: "معرّفات فروع الخدمة",
  maxOperationMinor: "حد العملية بالقرش", maxOperationQuantity: "حد كمية العملية",
  dailyAmountLimitMinor: "حد يومي بالقرش", weeklyAmountLimitMinor: "حد أسبوعي بالقرش", monthlyAmountLimitMinor: "حد شهري بالقرش",
  dailyQuantityLimit: "كمية يومية", weeklyQuantityLimit: "كمية أسبوعية", monthlyQuantityLimit: "كمية شهرية",
  rules: "قواعد مجموعات الخدمة", targetBranchId: "معرّف الفرع الجديد",
  linkId: "معرّف الربط", pinCode: "رمز PIN جديد", policyVersionId: "معرّف إصدار السياسة",
  requestId: "معرّف الطلب", proofDocumentId: "معرّف مستند الإثبات", stockUnitId: "معرّف وحدة المخزون",
  assignedTo: "معرّف المنفذ", scheduledAt: "موعد التنفيذ", credentialType: "نوع الرمز",
  previousCredentialId: "معرّف الرمز السابق", waive: "إعفاء معتمد", unitCode: "كود وحدة المخزون",
  readingKm: "قراءة الكيلومتر", evidenceDocumentId: "معرّف مستند الإثبات", supersedesEventId: "القراءة المصححة",
  maintenanceId: "معرّف الصيانة", odometerEventId: "حدث قراءة العداد", nextDueAt: "الاستحقاق التالي",
  nextDueKm: "كيلومتر الاستحقاق", performedAt: "تاريخ تنفيذ الصيانة", documentId: "معرّف المستند",
  decision: "القرار",
  subscriptionId: "الاشتراك", billingUnit: "وحدة الاشتراك", requestType: "نوع الطلب", tokenHint: "تلميح الرمز",
  documentType: "نوع المستند", fileName: "اسم الملف", reviewStatus: "حالة المراجعة", expiresOn: "ينتهي في",
  reading: "قراءة العداد", odometer: "قراءة العداد", recordedAt: "تاريخ القراءة", correction: "التصحيح",
  maintenanceType: "نوع الصيانة", dueAt: "موعد الاستحقاق", dueOdometer: "العداد عند الاستحقاق",
  jobId: "رقم المهمة", rowCount: "عدد الصفوف", issueCount: "عدد الملاحظات", createdAt: "أُنشئ في",
};
function date(value: unknown) { if (typeof value !== "string" || !value) return "—"; const parsed = new Date(value); return Number.isNaN(+parsed) ? value : new Intl.DateTimeFormat("ar-EG", { dateStyle: "medium" }).format(parsed); }
function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) { return <label className={`fleet-field ${wide ? "fleet-wide" : ""}`}>{label}{children}</label>; }
function Reason({ value, onChange }: { value: string; onChange: (value: string) => void }) { return <Field label="سبب موثّق — مطلوب (٣ إلى ٥٠٠ حرف)" wide><textarea required minLength={3} maxLength={500} value={value} onChange={event => onChange(event.target.value)} placeholder="اكتب سبب الإجراء لتسجيله في التدقيق."/></Field>; }
function Skeleton() { return <div className="fleet-skeleton" aria-label="جارٍ تحميل سجلات الأسطول"><i/><i/><i/><i/></div>; }
function State({ error = false, title, children, retry }: { error?: boolean; title: string; children?: ReactNode; retry?: () => void }) { return <section className={`fleet-state ${error ? "fleet-state-error" : ""}`} role={error ? "alert" : "status"}><span>{error ? <RefreshCw size={19}/> : <Truck size={19}/>}</span><b>{title}</b>{children && <p>{children}</p>}{retry && <button className="fleet-button fleet-quiet" onClick={retry}><RefreshCw size={15}/> إعادة المحاولة</button>}</section>; }

export function FleetAdminPage({ canMutate, isOwner }: { canMutate: boolean; isOwner: boolean }) {
  const [path, navigate] = useLocation();
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
  const [sort, setSort] = useState<"newest" | "oldest" | "name" | "plate" | "updatedAt">("newest");
  const [showForm, setShowForm] = useState(false);
  const [fleetNavOpen, setFleetNavOpen] = useState(false);
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
  const [policyScope, setPolicyScope] = useState("branch");
  const [cacheBust, setCacheBust] = useState(0);
  const [lastStockUnitId, setLastStockUnitId] = useState("");
  const [lastStockStatus, setLastStockStatus] = useState("");
  const [selectedDriver, setSelectedDriver] = useState<Row | null>(null);
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
    if (!fleetNavOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setFleetNavOpen(false); };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [fleetNavOpen]);
  useEffect(() => {
    if (!showForm) return;
    const dialog = dialogRef.current;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href]") ?? []);
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setShowForm(false); setOneTimeToken(""); if (path === "/admin/fleet/vehicles/new") navigate("/admin/fleet/vehicles"); return; }
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
  const query = useGetAdminFleetCatalog(params, { query: { queryKey: getGetAdminFleetCatalogQueryKey(params), retry: false, refetchOnMount: "always" } });
  const driverEventsParams: GetAdminFleetCatalogParams = { view: "events", driverId: detailId, page: 1, pageSize: 50 };
  const driverEvents = useGetAdminFleetCatalog(driverEventsParams, { query: { queryKey: getGetAdminFleetCatalogQueryKey(driverEventsParams), enabled: isDriverDetail, retry: false } });
  const cache = useQueryClient();
  const execute = useExecuteAdminFleetCommand();
  const uploadIntent = useCreateAdminFleetDocumentUploadIntent();
  const records = safeRows(query.data, view);
  const root = fields(query.data);
  const pageInfo = fields(root.pageInfo ?? root.pagination ?? query.data);
  const title = isVehicleDetail ? "ملف المركبة" : isDriverDetail ? "ملف السائق" : active.title;
  const refresh = async () => {
    await cache.invalidateQueries({ queryKey: getGetAdminFleetCatalogQueryKey(params) });
    setCacheBust(value => value + 1);
  };
  const actionOptions: Record<string, string[]> = {
    vehicles: ["vehicle.create", "vehicle.update", "vehicle.move", "vehicle.status"],
    vehicle: ["vehicle.update", "vehicle.move", "vehicle.status"],
    drivers: ["driver.create", "driver.update", "driver.status", "driver.link.create", "driver.link.end", "driver.pin.rotate"],
    policies: ["policy.create"],
    coverage: ["coverage.assign", "coverage.end"],
    credentials: ["credential.request", "credential.approve", "credential.assign", "credential.activate_qr", ...(isOwner ? ["credential.activate_nfc"] : []), "credential.stop", "tag_stock.receive", ...(lastStockStatus === "available" ? ["tag_stock.reserve", "tag_stock.damage"] : []), ...(lastStockStatus === "reserved" ? ["credential.install"] : [])],
    odometer: ["odometer.record", "odometer.review"],
    maintenance: ["maintenance.create", "maintenance.cancel"],
  };
  const selectedAction = actionOptions[view]?.includes(command) ? command : actionOptions[view]?.[0] ?? "";
  const fieldsByAction: Record<string, string[]> = {
    "vehicle.create": ["organizationId", "branchId", "plateOriginal", "plateStandard", "category", "vehicleType", "brand", "model", "modelYear", "chassisNumber", "internalCode", "fuelType"],
    "vehicle.update": ["vehicleId", "expectedVersion", "plateOriginal", "plateStandard", "category", "vehicleType", "brand", "model", "modelYear", "chassisNumber", "internalCode", "fuelType"],
    "vehicle.move": ["vehicleId", "targetBranchId", "expectedVersion"],
    "vehicle.status": ["vehicleId", "status", "expectedVersion"],
    "driver.create": ["organizationId", "driverCode", "fullName", "phone"],
    "driver.update": ["driverId", "expectedVersion", "driverCode", "fullName", "phone"],
    "driver.status": ["driverId", "status", "expectedVersion"],
    "driver.link.create": ["driverId", "vehicleId", "pinCode", "startsAt", "endsAt"],
    "driver.link.end": ["linkId"],
    "driver.pin.rotate": ["linkId", "vehicleId", "pinCode"],
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
  const openAction = (action: string, row: Row = {}) => { setSelectedRecord(row); setCommand(action); setReason(""); setProblem(""); setMessage(""); setOneTimeToken(""); if (action === "policy.create") setPolicyScope(text(get(row, "scope")) === "—" ? "branch" : text(get(row, "scope"))); setShowForm(true); };
  const closeForm = () => { setShowForm(false); setOneTimeToken(""); if (path === "/admin/fleet/vehicles/new") navigate("/admin/fleet/vehicles"); };
  const sendCommand = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setProblem(""); setMessage("");
    if (reason.trim().length < 3) { setProblem("سبب الإجراء مطلوب."); return; }
    const form = new FormData(event.currentTarget);
    const payload: Row = {};
    for (const [key, value] of form.entries()) if (key !== "reason" && !key.startsWith("rule_") && String(value).trim()) payload[key] = String(value).trim();
    if (fieldsByAction[command]?.includes("pinCode")) {
      const pinInput = event.currentTarget.querySelector<HTMLInputElement>('input[name="pinCode"]');
      if (!/^\d{4}$/.test(String(payload.pinCode ?? ""))) { setProblem("أدخل رمز PIN جديدًا من أربعة أرقام."); return; }
      if (pinInput) pinInput.value = "";
    }
    const arrayFields = ["allowedWeekdays", "allowedMerchantOrganizationIds", "allowedMerchantBranchIds"];
    for (const field of arrayFields) if (typeof payload[field] === "string") {
      const values = String(payload[field]).split(",").map(value => value.trim()).filter(Boolean);
      payload[field] = field === "allowedWeekdays" ? values.map(Number) : values;
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
    const signature = `${command}:${JSON.stringify(retryPayload)}:${reason.trim()}`;
    const key = commandRetryRef.current?.signature === signature
      ? commandRetryRef.current.key
      : crypto.randomUUID();
    commandRetryRef.current = { signature, key };
    try {
      const requestBody = { action: command, payload, reason: reason.trim(), idempotencyKey: key };
      const result = fields(fieldsByAction[command]?.includes("pinCode")
        ? await postSensitive("/api/admin/fleet/commands", requestBody)
        : await execute.mutateAsync({ data: requestBody as never }));
      if (command === "credential.activate_qr" || command === "credential.activate_nfc") {
        const token = get(result, "oneTimeToken");
        if (typeof token === "string") setOneTimeToken(token);
      }
      if (command === "tag_stock.receive" || command === "tag_stock.reserve") {
        const stockId = get(result, "id");
        if (typeof stockId === "string") setLastStockUnitId(stockId);
        setLastStockStatus(text(get(result, "status")));
      }
      if (command === "tag_stock.damage" || command === "credential.install") setLastStockStatus(text(get(result, "status")));
      setMessage(command.startsWith("credential.activate_") ? "صدر معرّف منطقي لمرة واحدة من الخدمة. لا يمثل ذلك كتابة فعلية على NFC أو تحصيلًا." : "تم إرسال الإجراء إلى الخادم وتسجيله.");
      setShowForm(false); setReason("");
      commandRetryRef.current = null;
      if (path === "/admin/fleet/vehicles/new") navigate("/admin/fleet/vehicles");
      await refresh();
    } catch (error) { setProblem(apiError(error)); }
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
    try { const response = await fetch("/api/admin/fleet/imports/template", { credentials: "include" }); if (!response.ok) throw Object.assign(new Error("تعذر تنزيل القالب."), { status: response.status }); const blob = await response.blob(); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "fleet-import-template.xlsx"; anchor.click(); URL.revokeObjectURL(url); }
    catch (error) { setProblem(apiError(error)); }
  }
  async function previewImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setProblem(""); setImportPreview(null);
    if (!importFile) { setProblem("اختر ملف XLSX للمعاينة."); return; }
    try {
      const response = await fetch("/api/admin/fleet/imports/preview", { method: "POST", credentials: "include", headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }, body: importFile });
      if (!response.ok) throw Object.assign(new Error("تعذرت معاينة الملف."), { status: response.status });
      setImportPreview(fields(await response.json()));
    } catch (error) { setProblem(apiError(error)); }
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
    try { const response = await fetch(`/api/admin/fleet/imports/${encodeURIComponent(jobId)}/apply`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: importReason.trim(), idempotencyKey }) }); if (!response.ok) throw Object.assign(new Error("لم يُطبّق الاستيراد."), { status: response.status }); setMessage("تم إرسال التطبيق الذري للمهمة."); setImportPreview(null); setImportReason(""); importApplyRetryRef.current = null; await refresh(); }
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
  const driverRecord = selectedDriver?.id === detailId ? selectedDriver : records.find(row => String(row.id ?? "") === detailId) ?? null;
  const vehicleRecord = fields(root.vehicle);
  const formDefaults = isVehicleDetail ? vehicleRecord : isDriverDetail ? driverRecord ?? {} : selectedRecord;
  const importIssues = Array.isArray(importPreview?.issues) ? importPreview!.issues as Row[] : Array.isArray(importPreview?.validationErrors) ? importPreview!.validationErrors as Row[] : [];
  const totalRecords = get(pageInfo, "total", "totalCount");
  const totalPages = typeof totalRecords === "number" ? Math.max(1, Math.ceil(totalRecords / Number(get(pageInfo, "pageSize") ?? 20))) : undefined;
  const tableHeaders = useMemo(() => {
    const keys: string[] = [];
    for (const row of entries) for (const key of Object.keys(row)) if (!isHiddenKey(key) && !keys.includes(key)) keys.push(key);
    return keys.slice(0, 8);
  }, [query.data, view, page]);

  return <div className="fleet-page" dir="rtl">
    <div className="fleet-heading"><div><div className="fleet-eyebrow"><span/> إدارة الأسطول / مركز التشغيل</div><h1>{title}</h1><p>سجلات المركبات والسائقين وضوابط الأهلية — من بيانات الخادم فقط.</p></div><button className="fleet-mobile-nav-toggle" aria-controls="fleet-rail" aria-expanded={fleetNavOpen} onClick={() => setFleetNavOpen(true)}>أقسام الأسطول</button><div className="fleet-heading-mark">PERTOMAX <b>EG</b><small>FLEET CONTROL</small></div></div>
    <div className="fleet-layout">
      {fleetNavOpen && <button className="fleet-nav-scrim" aria-label="إغلاق أقسام الأسطول" onClick={() => setFleetNavOpen(false)}/>}
      <aside id="fleet-rail" className={`fleet-rail ${fleetNavOpen ? "is-open" : ""}`} aria-label="أقسام إدارة الأسطول">
        <div className="fleet-rail-title">سجل الأسطول <span>01—10</span></div>
        {views.map(item => <Link key={item.path} href={item.path} onClick={() => setFleetNavOpen(false)} className={`fleet-rail-link ${active.path === item.path && !isVehicleDetail ? "is-active" : ""}`}>{item.icon}<span>{item.title}</span><ArrowLeft size={13}/></Link>)}
        <div className="fleet-rail-note"><LockKeyhole size={15}/><span>تغييرات موثقة<br/>بسبب إلزامي</span></div>
      </aside>
      <main className="fleet-main">
        <div className="fleet-toolbar"><div className="fleet-breadcrumb"><Link href="/admin">الإدارة المركزية</Link><ArrowLeft size={13}/><span>الأسطول</span><ArrowLeft size={13}/><b>{title}</b></div>
          <div className="fleet-tools">{!["overview", "vehicle"].includes(view) && !isVehicleDetail && !isDriverDetail && <label className="fleet-search"><Search size={16}/><input value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder="بحث في سجلات هذا القسم" aria-label="البحث في السجل"/></label>}
            <button className="fleet-button fleet-quiet" onClick={() => void refresh()}><RefreshCw size={15}/> تحديث</button>
            {canMutate && actionOptions[view]?.length > 0 && <><select className="fleet-action-select" aria-label="اختر إجراء الأسطول" value={selectedAction} onChange={event => setCommand(event.target.value)}>{actionOptions[view].map(action => <option key={action} value={action}>{action.replaceAll(".", " · ")}</option>)}</select><button className="fleet-button" onClick={() => openAction(selectedAction)}><Plus size={16}/> تنفيذ إجراء</button></>}
            {canMutate && view === "vehicles" && <button className="fleet-button fleet-quiet" onClick={() => { navigate("/admin/fleet/vehicles/new"); openAction("vehicle.create"); }}><Plus size={16}/> مركبة</button>}
          </div>
        </div>
        {view !== "overview" && <div className="fleet-filterbar">
          {(view === "vehicles" || view === "drivers" || view === "credentials" || view === "odometer" || view === "maintenance") && !isVehicleDetail && !isDriverDetail && <label>الحالة<select value={statusFilter} onChange={event => { setStatusFilter(event.target.value); setPage(1); }}><option value="">كل الحالات</option>{(view === "vehicles" || view === "drivers" ? ["active", "suspended", "inactive"] : view === "odometer" ? ["accepted", "pending_review", "rejected"] : view === "maintenance" ? ["recorded", "cancelled"] : ["requested", "approved", "assigned", "scheduled", "installed", "active"]).map(value => <option key={value} value={value}>{statusText(value)}</option>)}</select></label>}
          {!["overview", "vehicle"].includes(view) && !isVehicleDetail && !isDriverDetail && <label>الترتيب<select value={sort} onChange={event => { setSort(event.target.value as typeof sort); setPage(1); }}><option value="newest">الأحدث</option><option value="oldest">الأقدم</option>{view === "drivers" && <option value="name">الاسم</option>}{view === "vehicles" && <><option value="plate">رقم اللوحة</option><option value="updatedAt">آخر تحديث</option></>}</select></label>}
          {view === "vehicles" && <><label>التغطية<select value={coverageFilter} onChange={event => { setCoverageFilter(event.target.value); setPage(1); }}><option value="">كل التغطيات</option><option value="covered">مغطاة</option><option value="uncovered">غير مغطاة</option></select></label><label>نوع الوقود<input value={fuelFilter} onChange={event => { setFuelFilter(event.target.value); setPage(1); }} placeholder="تصفية الوقود"/></label></>}
          {(view === "vehicles" || view === "drivers" || view === "policies" || view === "coverage" || view === "credentials") && !isVehicleDetail && !isDriverDetail && <label>معرّف الجهة<input value={organizationFilter} onChange={event => { setOrganizationFilter(event.target.value); setPage(1); }} placeholder="UUID الجهة" dir="ltr"/></label>}
          {(view === "vehicles" || view === "policies") && !isVehicleDetail && <label>معرّف الفرع<input value={branchFilter} onChange={event => { setBranchFilter(event.target.value); setPage(1); }} placeholder="UUID الفرع" dir="ltr"/></label>}
          {["policies", "coverage", "credentials", "documents", "odometer", "maintenance"].includes(view) && <label>معرّف المركبة<input value={vehicleFilter} onChange={event => { setVehicleFilter(event.target.value); setPage(1); }} placeholder="UUID المركبة" dir="ltr"/></label>}
        </div>}
        {message && <div className="fleet-feedback" role="status">{message}<button aria-label="إخفاء التنبيه" onClick={() => setMessage("")}><X size={15}/></button></div>}
        {problem && <div className="fleet-feedback is-error" role="alert">{problem}<button aria-label="إخفاء الخطأ" onClick={() => setProblem("")}><X size={15}/></button></div>}
        {oneTimeToken && <section className="fleet-token-once" aria-label="رمز منطقي لمرة واحدة"><div><b>رمز لمرة واحدة من الخادم</b><small>احتفظ به وفق الإجراء المعتمد؛ لن نعرضه مجددًا بعد الإغلاق. ليس إثباتًا لكتابة NFC فعلية.</small></div><code dir="ltr">{oneTimeToken}</code><button className="fleet-row-action" onClick={() => void copyToken()}>نسخ الرمز</button><button className="fleet-icon-button" onClick={() => setOneTimeToken("")} aria-label="إخفاء الرمز">إخفاء</button></section>}
        {query.isLoading ? <Skeleton/> : query.isError ? <State error title="تعذر تحميل بيانات الأسطول" retry={() => void query.refetch()}>{apiError(query.error)}</State> :
        <>
          {view === "overview" && <><section className="fleet-intro"><div className="fleet-intro-copy"><span className="fleet-eyebrow">قراءة تشغيلية مباشرة</span><h2>بيانات الأسطول<br/><em>كما وردت من الخدمة.</em></h2><p>لوحة ضبط مركزية لسجلات الشركة، روابط السائقين، والسياسات التي تحكم أهلية الخدمة لاحقًا.</p></div><div className="fleet-quick-links">{views.slice(1).map((item, index) => <Link key={item.path} href={item.path}><span className="fleet-index">{String(index + 1).padStart(2, "0")}</span><span>{item.icon}<b>{item.title}</b></span><ArrowLeft size={15}/></Link>)}</div></section><section className="fleet-overview-metrics">{Object.entries(root).filter(([key, value]) => typeof value === "number" && !isHiddenKey(key)).map(([key, value]) => <article key={key}><small>{labels[key] ?? key}</small><bdi>{Number(value).toLocaleString("ar-EG")}</bdi></article>)}</section></>}
          {view === "imports" && <section className="fleet-panel">
            <div className="fleet-panel-head"><div><span className="fleet-eyebrow">استيراد ذري</span><h2>ملف عمل واحد، ومراجعة قبل التطبيق</h2><p>المعاينة لا تغيّر السجلات. التطبيق كله أو لا شيء.</p></div><button className="fleet-button fleet-quiet" onClick={() => void downloadTemplate()}><FileText size={16}/> تنزيل قالب XLSX</button></div>
            {canMutate && <form className="fleet-form" onSubmit={previewImport}><Field label="ملف Excel"><input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={event => setImportFile(event.target.files?.[0] ?? null)}/></Field><button className="fleet-button" disabled={!importFile}>معاينة والتحقق</button></form>}
            {importPreview && <div className="fleet-preview"><b>نتيجة المعاينة</b><div className="fleet-facts">{Object.entries(importPreview).filter(([key]) => !isHiddenKey(key) && !["issues", "validationErrors"].includes(key)).map(([key, value]) => <div key={key}><small>{labels[key] ?? key}</small><b>{typeof value === "object" ? JSON.stringify(sanitized(value)) : text(value)}</b></div>)}</div>{importIssues.length > 0 ? <div className="fleet-issues"><b>ملاحظات الصفوف ({importIssues.length.toLocaleString("ar-EG")})</b>{importIssues.map((issue, index) => <div key={`${text(issue.sheet)}-${text(issue.row)}-${index}`}><b>{text(issue.sheet)} · صف {text(issue.row)}</b><span>{text(issue.field)} — {text(issue.message)}</span></div>)}</div> : <p className="fleet-inline-status">لم تُعد المعاينة ملاحظات صفوف.</p>}<Reason value={importReason} onChange={setImportReason}/>{canMutate && <button className="fleet-button" onClick={() => void applyImport()}>تطبيق جميع الصفوف ذريًا</button>}</div>}
          </section>}
          {view === "documents" && <section className="fleet-panel"><div className="fleet-panel-head"><div><span className="fleet-eyebrow">مستند خاص</span><h2>رفع ملف مركبة</h2><p>تُحفظ البيانات الوصفية والملف في مسار خاص محمي.</p></div></div>{canMutate ? <form className="fleet-form" onSubmit={uploadDocument}><Field label="معرّف المركبة"><input name="vehicleId" required/></Field><Field label="نوع المستند"><input name="documentType" required minLength={2} maxLength={80}/></Field><Field label="الملف"><input name="file" type="file" accept="application/pdf,image/png,image/jpeg" required/></Field><button className="fleet-button" disabled={uploadIntent.isPending}>{uploadIntent.isPending ? "جارٍ تجهيز الرفع…" : "رفع الملف"}</button></form> : <p className="fleet-muted">الرفع متاح لمالك المنصة والعمليات فقط.</p>}</section>}
          {view === "drivers" && canMutate && !isDriverDetail && <section className="fleet-panel fleet-verify"><div><span className="fleet-eyebrow">عملية محمية</span><h2>التحقق من ربط السائق</h2><p>أدخل رمزًا من أربعة أرقام. يُرسل للتحقق ولا يُعرض أو يُحفظ في السجل.</p></div><form onSubmit={verifyPair}><Field label="معرّف الربط"><input name="linkId" required/></Field><Field label="معرّف المركبة"><input name="vehicleId" required/></Field><Field label="رمز PIN"><input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{4}" maxLength={4} value={pairPin} onChange={event => setPairPin(event.target.value.replace(/\D/g, "").slice(0, 4))} required/></Field><button className="fleet-button" disabled={pairPin.length !== 4}>{pairPin.length !== 4 ? "أدخل الرمز" : "تحقق"}</button></form>{pairResult && <p role="status" className="fleet-inline-status">{pairResult}</p>}</section>}
          {view === "credentials" && <p className="fleet-caution"><LockKeyhole size={15}/> التنشيط المنطقي لا يعني دفعًا أو كتابة فعلية على NFC. يتطلب NFC إعفاءً معتمدًا وإثبات تركيب ومخزونًا مركبًا.</p>}
          {view === "coverage" && <p className="fleet-caution"><BadgeCheck size={15}/> التغطية قراءة أو إسناد فقط؛ لا تُحصّل اشتراكًا ولا تتجاوز أهلية الأسطول.</p>}
          {view === "policies" && <p className="fleet-caution"><ShieldCheck size={15}/> نشر السياسة يضبط الأهلية اللاحقة فقط؛ لا ينفّذ خدمة أو دفعة.</p>}
          {view === "documents" && <p className="fleet-caution">التنزيل متاح فقط عبر رابط الخادم الموقّع. لا تُعرض مسارات التخزين.</p>}
          {isVehicleDetail && <section className="fleet-panel fleet-record-detail"><div className="fleet-panel-head"><div><span className="fleet-eyebrow">مركبة / ملف كامل</span><h2>{text(get(vehicleRecord, "plateOriginal", "plateStandard"))}</h2><p>الحقائق والارتباطات من استجابة ملف المركبة.</p></div></div><div className="fleet-facts">{Object.entries(vehicleRecord).filter(([key, value]) => !isHiddenKey(key) && (value === null || typeof value !== "object")).map(([key, value]) => <div key={key}><small>{labels[key] ?? key}</small><b>{key.toLowerCase().includes("at") ? date(value) : statusText(value)}</b></div>)}</div>{(["driverLinks", "credentials", "coverage", "documents", "odometer", "maintenance", "events"] as const).map(key => { const list = root[key]; if (!Array.isArray(list)) return null; return <section className="fleet-detail-list" key={key}><h3>{({ driverLinks: "روابط السائقين", credentials: "الرموز النشطة وتلميحاتها", coverage: "التغطية", documents: "المستندات", odometer: "قراءات العداد", maintenance: "الصيانة", events: "سجل الأحداث" } as Record<string, string>)[key]}</h3>{list.length ? <div className="fleet-facts">{list.map((record, index) => <div key={`${key}-${index}`}>{Object.entries(fields(record)).filter(([field]) => !isHiddenKey(field)).map(([field, value]) => <span key={field}><small>{labels[field] ?? field}</small><b>{typeof value === "object" ? JSON.stringify(sanitized(value)) : field.toLowerCase().includes("at") ? date(value) : statusText(value)}</b></span>)}</div>)}</div> : <p className="fleet-muted">لا توجد عناصر في هذا القسم.</p>}</section>; })}</section>}
          {isDriverDetail && <section className="fleet-panel fleet-record-detail"><div className="fleet-panel-head"><div><span className="fleet-eyebrow">سائق / ملف</span><h2>{driverRecord ? text(driverRecord.fullName) : "بيانات السائق"}</h2><p>روابط السائقين وتواريخها تظهر ضمن بيانات المركبة؛ سجل الأحداث يُقرأ من واجهة الأحداث.</p></div></div>{driverRecord ? <div className="fleet-facts">{Object.entries(driverRecord).filter(([key, value]) => !isHiddenKey(key) && (value === null || typeof value !== "object")).map(([key, value]) => <div key={key}><small>{labels[key] ?? key}</small><b>{key.toLowerCase().includes("at") ? date(value) : statusText(value)}</b></div>)}</div> : <State title="تعذر تحديد سجل السائق">واجهة الكتالوج لا تدعم جلب سائق منفرد بمعرّفه؛ افتح الملف من صفحة قائمة السائقين لعرض بيانات السجل المختارة.</State>}{driverEvents.isLoading ? <Skeleton/> : driverEvents.isError ? <State error title="تعذر تحميل سجل الأحداث" retry={() => void driverEvents.refetch()}>{apiError(driverEvents.error)}</State> : <div className="fleet-detail-list"><h3>أحداث السائق</h3>{safeRows(driverEvents.data, "events").length ? <div className="fleet-facts">{safeRows(driverEvents.data, "events").map((event, index) => <div key={`driver-event-${index}`}>{Object.entries(event).filter(([key]) => !isHiddenKey(key)).map(([key, value]) => <span key={key}><small>{labels[key] ?? key}</small><b>{typeof value === "object" ? JSON.stringify(sanitized(value)) : key.toLowerCase().includes("at") ? date(value) : statusText(value)}</b></span>)}</div>)}</div> : <p className="fleet-muted">لا توجد أحداث مرتبطة في السجل المتاح.</p>}</div>}</section>}
          {view !== "overview" && <section className="fleet-table-card">
            <div className="fleet-table-head"><div><span className="fleet-eyebrow">مصدر البيانات: API</span><h2>{isVehicleDetail || isDriverDetail ? "تفاصيل السجل" : `${title} — السجل`}</h2></div><span className="fleet-count">{text(totalRecords ?? records.length)} <small>{totalRecords === undefined ? "نتيجة من الخادم" : "سجل مطابق"}</small></span></div>
            {entries.length === 0 ? <State title="لا توجد سجلات للعرض">ستظهر هنا النتائج التي يعيدها الخادم، دون سجلات أو مؤشرات افتراضية.</State> :
            <div className="fleet-table-scroll"><table><thead><tr>{tableHeaders.map(key => <th key={key}>{labels[key] ?? key}</th>)}<th>إجراء</th></tr></thead><tbody>{entries.map((row, index) => {
              const id = text(get(row, "id", "vehicleId", "driverId", "policyId", "documentId", "eventId", "jobId"));
              return <tr key={`${id}-${index}`} data-testid={`row-fleet-${id}`} onClick={() => id !== "—" && (view === "vehicles" ? navigate(`/admin/fleet/vehicles/${encodeURIComponent(id)}`) : view === "drivers" ? (setSelectedDriver(row), navigate(`/admin/fleet/drivers/${encodeURIComponent(id)}`)) : undefined)}>
                {tableHeaders.map(key => <td key={key}>{key.toLowerCase().includes("status") ? <span className={`fleet-status status-${String(row[key] ?? "").toLowerCase()}`}>{statusText(row[key])}</span> : <bdi dir={/id|plate|phone|code|amount|quantity|reading/i.test(key) ? "ltr" : undefined}>{typeof row[key] === "object" ? JSON.stringify(sanitized(row[key])) : key.toLowerCase().includes("at") || key.toLowerCase().includes("date") ? date(row[key]) : text(row[key])}</bdi>}</td>)}
                  <td>{view === "policies" && canMutate ? <div className="fleet-row-actions"><button className="fleet-row-action" onClick={event => { event.stopPropagation(); openAction(text(get(row, "status")) === "draft" ? "policy.update" : "policy.create", row); }}>{text(get(row, "status")) === "draft" ? "تعديل المسودة" : "نسخة جديدة"}</button>{text(get(row, "status")) === "draft" && <button className="fleet-row-action" onClick={event => { event.stopPropagation(); openAction("policy.publish", row); }}>نشر</button>}</div> : view === "documents" && id !== "—" ? <div className="fleet-row-actions"><button className="fleet-row-action" onClick={event => { event.stopPropagation(); void fetch(`/api/documents/${encodeURIComponent(id)}/download`, { credentials: "include" }).then(async response => { if (!response.ok) throw Object.assign(new Error("تعذر تنزيل المستند."), { status: response.status }); const body = await response.json() as Row; const href = text(get(body, "url", "downloadUrl")); if (href !== "—") window.location.assign(href); }).catch(error => setProblem(apiError(error))); }}>تنزيل</button>{canMutate && ["pending_review", "needs_completion"].includes(String(row.status)) && <button className="fleet-row-action" onClick={event => { event.stopPropagation(); setDocumentReview(row); setDocumentDecision(""); setDocumentReason(""); }}>مراجعة</button>}</div> : view === "imports" ? <button className="fleet-row-action" onClick={event => { event.stopPropagation(); setImportPreview({ ...row, issues: Array.isArray(row.errors) ? row.errors : [] }); }}>تفاصيل المهمة</button> : <span className="fleet-row-action-text">{view === "vehicles" || view === "drivers" ? "فتح الملف" : statusText(get(row, "status"))}</span>}</td>
              </tr>;
            })}</tbody></table></div>}
            {!["overview", "vehicle"].includes(view) && entries.length > 0 && <div className="fleet-pagination"><span>عرض {entries.length.toLocaleString("ar-EG")} من {text(totalRecords ?? records.length)} سجل</span><div><button disabled={page <= 1} onClick={() => setPage(value => Math.max(1, value - 1))}>السابق</button><b>{page.toLocaleString("ar-EG")} / {totalPages?.toLocaleString("ar-EG") ?? "—"}</b><button disabled={totalPages !== undefined ? page >= totalPages : entries.length < 20} onClick={() => setPage(value => value + 1)}>التالي</button></div></div>}
          </section>}
          {view === "documents" && entries.length > 0 && <p className="fleet-muted">تظهر بيانات المستند الوصفية فقط؛ لا تُعرض بصمات الملف أو مسارات التخزين.</p>}
          {view === "odometer" && <p className="fleet-caution"><Fuel size={15}/> مراجعة القراءة والتصحيح لا يغيّران سجل الخدمة المنفذة.</p>}
          {view === "maintenance" && <p className="fleet-muted">سجلات الصيانة ومواعيد الاستحقاق مصدرها الخادم.</p>}
        </>}
        {showForm && <div className="fleet-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closeForm(); }}><section ref={dialogRef} tabIndex={-1} className="fleet-dialog" role="dialog" aria-modal="true" aria-labelledby="fleet-dialog-title"><header><div><span className="fleet-eyebrow">إجراء مسجل</span><h2 id="fleet-dialog-title">{command.replaceAll(".", " · ")}</h2></div><button className="fleet-icon-button" aria-label="إغلاق" onClick={closeForm}><X size={18}/></button></header><form className="fleet-form" onSubmit={sendCommand}><div className="fleet-form-grid">{(fieldsByAction[command] ?? []).map(field => {
          const optional = new Set(["modelYear", "chassisNumber", "internalCode", "phone", "endsAt", "previousCredentialId", "scheduledAt", "evidenceDocumentId", "supersedesEventId", "odometerEventId", "nextDueAt", "nextDueKm", "documentId"]);
          const isRequired = !optional.has(field) && !(field === "vehicleId" && command === "policy.create" && policyScope === "branch") && !(field === "branchId" && command === "policy.create" && policyScope === "vehicle");
          const defaultValue = field === "stockUnitId" ? lastStockUnitId : field === "policyVersionId" ? formDefaults.id : field === "expectedVersion" ? formDefaults.version : field === "vehicleId" && isVehicleDetail ? formDefaults.id : field === "driverId" && isDriverDetail ? formDefaults.id : formDefaults[field];
          const dateTime = ["startsAt", "endsAt", "effectiveFrom", "scheduledAt", "recordedAt", "performedAt", "nextDueAt"].includes(field);
          const normalizedDefault = dateTime && typeof defaultValue === "string" ? defaultValue.slice(0, 16) : defaultValue;
          const common = { name: field, required: isRequired, dir: /id|code|plate|phone/i.test(field) ? "ltr" as const : undefined, defaultValue: String(normalizedDefault ?? "") };
          const choices: Record<string, Array<[string, string]>> = {
            status: [["active", "نشط"], ["suspended", "موقوف"], ["inactive", "غير نشط"]],
            scope: [["branch", "نطاق فرع"], ["vehicle", "نطاق مركبة"]],
            credentialType: [["qr", "QR"], ["nfc", "NFC"]],
            requestType: [["issue", "إصدار"], ["replace", "استبدال"]],
            maintenanceType: [["oil", "زيت"], ["parts", "قطع غيار"], ["battery", "بطارية"], ["filters", "فلاتر"], ["tires", "إطارات"], ["other", "أخرى"]],
            decision: command === "odometer.review" ? [["accepted", "مقبول"], ["rejected", "مرفوض"]] : [],
          };
          if (field === "waive") return isOwner ? <Field key={field} label="إعفاء معتمد — لمالك المنصة فقط"><input type="checkbox" name="waive" value="true"/></Field> : null;
          if (choices[field]?.length) return <Field key={field} label={labels[field] ?? field}><select {...common} value={field === "scope" ? policyScope : undefined} onChange={field === "scope" ? event => setPolicyScope(event.target.value) : undefined}>{choices[field].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>;
          if (field === "pinCode") return <Field key={field} label={labels[field]}><input {...common} type="password" inputMode="numeric" autoComplete="new-password" pattern="[0-9]{4}" maxLength={4}/></Field>;
          if (field === "allowedWeekdays" || field === "allowedMerchantOrganizationIds" || field === "allowedMerchantBranchIds") return <Field key={field} label={`${labels[field]} — مفصولة بفواصل`}><input {...common} placeholder={field === "allowedWeekdays" ? "1,2,3" : "UUID, UUID"}/></Field>;
          if (field === "startTime" || field === "endTime") return <Field key={field} label={labels[field]}><input {...common} type="time"/></Field>;
          if (field === "notes") return <Field key={field} label={labels[field] ?? field}><textarea {...common}/></Field>;
          const numeric = ["modelYear", "expectedVersion", "maxOperationMinor", "maxOperationQuantity", "dailyAmountLimitMinor", "weeklyAmountLimitMinor", "monthlyAmountLimitMinor", "dailyQuantityLimit", "weeklyQuantityLimit", "monthlyQuantityLimit", "readingKm", "nextDueKm"].includes(field);
          return <Field key={field} label={labels[field] ?? field}><input {...common} type={numeric ? "number" : dateTime ? "datetime-local" : "text"} min={field === "modelYear" ? 1886 : undefined} max={field === "modelYear" ? 2200 : undefined}/></Field>;
        })}</div>{(command === "policy.create" || command === "policy.update") && <fieldset className="fleet-policy-rules"><legend>حدود مجموعات الخدمة</legend><p>تبدأ كل مجموعة غير مفعّلة. لا يؤدي ترك حد فارغ إلى سماح مفتوح.</p><div className="fleet-policy-group-list">{policyGroups.map(group => {
          const currentRules = Array.isArray(formDefaults.rules) ? formDefaults.rules.map(fields) : [];
          const currentRule = currentRules.find(rule => text(get(rule, "serviceGroup", "service_group")) === group.id) ?? {};
          return <section key={group.id}><label className="fleet-policy-toggle"><input type="checkbox" name={`rule_${group.id}_enabled`} defaultChecked={get(currentRule, "enabled") === true}/><b>{group.title}</b><span>غير مفعّل حتى الاعتماد</span></label><div className="fleet-policy-limit-grid">{policyRuleLimits.map(([field, label]) => <Field key={field} label={label}><input type="number" min="0" step="any" name={`rule_${group.id}_${field}`} defaultValue={String(get(currentRule, field, field.replace(/[A-Z]/g, value => `_${value.toLowerCase()}`)) ?? "")} placeholder="٠"/></Field>)}</div></section>;
        })}</div></fieldset>}<Reason value={reason} onChange={setReason}/>{problem && <p className="fleet-feedback is-error" role="alert">{problem}</p>}<div className="fleet-dialog-actions"><button className="fleet-button" disabled={execute.isPending || !canMutate || reason.trim().length < 3}>{execute.isPending ? "جارٍ تسجيل الإجراء…" : "حفظ الإجراء"}</button><button type="button" className="fleet-button fleet-quiet" onClick={closeForm}>إلغاء</button></div></form></section></div>}
        {documentReview && <div className="fleet-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setDocumentReview(null); }}><section className="fleet-dialog" role="dialog" aria-modal="true" aria-labelledby="fleet-document-review-title"><header><div><span className="fleet-eyebrow">مراجعة مستند مركبة</span><h2 id="fleet-document-review-title">{text(get(documentReview, "fileName"))}</h2></div><button className="fleet-icon-button" aria-label="إغلاق" onClick={() => setDocumentReview(null)}><X size={18}/></button></header><form className="fleet-form" onSubmit={reviewFleetDocument}><Field label="قرار المراجعة"><select value={documentDecision} onChange={event => setDocumentDecision(event.target.value)} required><option value="">اختر القرار</option><option value="approve">اعتماد</option><option value="needs_completion">طلب استكمال</option><option value="reject">رفض</option></select></Field><Reason value={documentReason} onChange={setDocumentReason}/><div className="fleet-dialog-actions"><button className="fleet-button" disabled={documentReason.trim().length < 3}>تأكيد القرار</button><button type="button" className="fleet-button fleet-quiet" onClick={() => setDocumentReview(null)}>إلغاء</button></div></form></section></div>}
        <div className="fleet-scope-note"><LockKeyhole size={14}/> الخدمة المنفذة، الكتابة الفعلية على NFC، الدفع، بوابات الشركات/الهاتف والبريد الإلكتروني أو PDF ليست ضمن هذه المساحة.</div>
      </main>
    </div>
  </div>;
}
