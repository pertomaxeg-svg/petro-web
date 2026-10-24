import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, ArrowLeftRight, Box, Check, ChevronLeft, ChevronRight, CircleAlert,
  ClipboardList, MapPin, PackageCheck, Plus, RefreshCw, Search, ShieldCheck,
  X, Warehouse,
} from "lucide-react";
import {
  getGetAdminInventoryQueryKey, useExecuteAdminInventoryCommand, useGetAdminInventory,
} from "@workspace/api-client-react";
import type { ExecuteAdminInventoryCommandAction, GetAdminInventoryParams } from "@workspace/api-client-react";
import "./AdminInventoryPage.css";

type DataRow = Record<string, unknown>;
type View = "organizations" | "summary" | "stock" | "documents" | "transfers" | "counts" | "alerts" | "movements" | "reconciliation";
const asRow = (value: unknown): DataRow => value && typeof value === "object" && !Array.isArray(value) ? value as DataRow : {};
const asRows = (value: unknown): DataRow[] => Array.isArray(value) ? value.map(asRow) : [];
const text = (value: unknown, fallback = "—") => typeof value === "string" && value.trim() ? value.trim() : fallback;
const numberValue = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};
const count = (value: unknown) => {
  const raw = typeof value === "string" ? value.trim()
    : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return "—";
  const negative = raw.startsWith("-");
  const [integer, fraction = ""] = (negative ? raw.slice(1) : raw).split(".");
  const groupedInteger = new Intl.NumberFormat("ar-EG", { maximumFractionDigits: 0 }).format(BigInt(integer));
  const trimmedFraction = fraction.replace(/0+$/, "");
  const localizedFraction = trimmedFraction.replace(/\d/g, (digit) => "٠١٢٣٤٥٦٧٨٩"[Number(digit)]);
  const decimalSeparator = new Intl.NumberFormat("ar-EG").formatToParts(1.1).find((part) => part.type === "decimal")?.value ?? ".";
  return `${negative ? "−" : ""}${groupedInteger}${localizedFraction ? `${decimalSeparator}${localizedFraction}` : ""}`;
};
const statusText = (value: unknown) => ({
  active: "نشط", inactive: "غير نشط", suspended: "موقوف", pending: "قيد المراجعة",
  not_reviewed: "بانتظار المراجعة", approved: "معتمد", rejected: "مرفوض", draft: "مسودة",
  posted: "مرحل", completed: "مكتمل", reserved: "محجوز", released: "محرر", consumed: "مستهلك",
  consistent: "متطابق", inconsistent: "يحتاج مراجعة",
} as Record<string, string>)[text(value, "").toLowerCase()] ?? text(value);
const organizationKindText = (value: unknown) => ({
  station: "محطة", provider: "مقدّم خدمات", company: "شركة",
} as Record<string, string>)[text(value, "").toLowerCase()] ?? text(value);
const locationKindText = (value: unknown) => ({
  sellable: "مخزون صالح", quarantine: "منطقة مرتجعات", damaged: "منطقة تالف", transit: "مخزون منقول",
} as Record<string, string>)[text(value, "").toLowerCase()] ?? text(value);
const documentTypeText = (value: unknown) => ({
  opening: "رصيد افتتاحي", receipt: "استلام", issue: "صرف", return: "مرتجع", damage: "إتلاف", transfer: "نقل داخلي",
  count: "جرد", adjustment: "تسوية كمية",
} as Record<string, string>)[text(value, "").toLowerCase()] ?? text(value);
const movementKindText = (value: unknown) => ({
  opening: "رصيد افتتاحي", receipt: "استلام", issue: "صرف", return: "إرجاع", damage_in: "إتلاف وارد",
  damage_out: "إتلاف صادر", transfer_in: "نقل وارد", transfer_out: "نقل صادر",
  reserve: "حجز", release: "تحرير حجز", consume: "استهلاك", count_adjustment: "تسوية جرد",
  adjustment: "تسوية كمية",
} as Record<string, string>)[text(value, "").toLowerCase()] ?? text(value);
const unitText = (value: unknown) => ({
  piece: "قطعة", pack: "عبوة", litre: "لتر", service: "خدمة",
} as Record<string, string>)[text(value, "").toLowerCase()] ?? text(value);
const dateText = (value: unknown) => typeof value === "string" && !Number.isNaN(Date.parse(value))
  ? new Intl.DateTimeFormat("ar-EG", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo" }).format(new Date(value)) : "—";
const rowId = (value: DataRow) => text(value.id, text(value.documentId, text(value.itemId, "")));
const errText = (error: unknown) => {
  const outer = asRow(error);
  const data = asRow(outer.data);
  const response = asRow(outer.response);
  const status = numberValue(data.statusCode) ?? numberValue(data.status) ?? numberValue(response.status) ?? numberValue(outer.status);
  if (status === 403) return "ليس لديك إذن لتنفيذ هذا الإجراء أو عرض هذا النطاق. يمكن لمسؤول المنصة مراجعة صلاحيات عضويتك.";
  if (status === 409) return "تعارضت العملية مع تحديث أحدث للمخزون. حدّث البيانات وراجع الرصيد قبل إعادة المحاولة.";
  if (status === 401) return "انتهت صلاحية الجلسة أو يلزم تسجيل الدخول مجددًا.";
  return text(data.message, text(outer.message, "تعذر إتمام الطلب. احتفظ بالمدخلات وحاول مجددًا."));
};
const isForbidden = (error: unknown) => /403|إذن|صلاحية|permission|forbidden/i.test(errText(error));
const itemName = (item: DataRow) => text(item.name, "اسم غير متاح");
const pageSize = 20;

function State({ title, detail, error, retry, permission }: {
  title: string; detail?: string; error?: boolean; retry?: () => void; permission?: boolean;
}) {
  return <div className={`inv-state${error ? " is-error" : ""}${permission ? " inv-permission" : ""}`} role={error ? "alert" : "status"}>
    <span>{permission ? <ShieldCheck size={19}/> : error ? <CircleAlert size={19}/> : <Box size={19}/>}</span>
    <b>{title}</b>{detail && <p>{detail}</p>}
    {retry && <button className="inv-button inv-button-quiet" onClick={retry}><RefreshCw size={14}/> إعادة المحاولة</button>}
  </div>;
}

function LoadingState({ rows = 4 }: { rows?: number }) {
  return <div className="inv-skeleton" role="status" aria-label="جارٍ تحميل بيانات المخزون">{Array.from({ length: rows }, (_, index) => <i key={index}/>)}</div>;
}

function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return <label className={`inv-field${wide ? " is-wide" : ""}`}><span>{label}</span>{children}</label>;
}

function Pagination({ page, total, onPage }: { page: number; total: number; onPage: (page: number) => void }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages < 2) return null;
  return <div className="inv-pagination">
    <button className="inv-button inv-button-quiet" disabled={page <= 1} onClick={() => onPage(Math.max(1, page - 1))}><ChevronRight size={15}/> السابقة</button>
    <span>صفحة {page.toLocaleString("ar-EG")} من {totalPages.toLocaleString("ar-EG")} · {total.toLocaleString("ar-EG")} سجل</span>
    <button className="inv-button inv-button-quiet" disabled={page >= totalPages} onClick={() => onPage(Math.min(totalPages, page + 1))}>التالية <ChevronLeft size={15}/></button>
  </div>;
}

export function AdminInventoryPage({ canManageInventory = false }: { canManageInventory?: boolean }) {
  const cache = useQueryClient();
  const command = useExecuteAdminInventoryCommand();
  const [view, setView] = useState<View>("organizations");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [statusFilter, setStatusFilter] = useState("");
  const [selectedOrgId, setSelectedOrgId] = useState("");
  const [selectedLocationId, setSelectedLocationId] = useState("");
  const [selectedDocumentId, setSelectedDocumentId] = useState("");
  const [documentType, setDocumentType] = useState("receipt");
  const [returnSourceByLine, setReturnSourceByLine] = useState<Record<number, string>>({});
  const [showReorderForm, setShowReorderForm] = useState(false);
  const [reorderDefaults, setReorderDefaults] = useState({ itemId: "", level: "" });
  const [itemSearch, setItemSearch] = useState("");
  const [showLocationForm, setShowLocationForm] = useState(false);
  const [showDocumentForm, setShowDocumentForm] = useState(false);
  const [documentLineIds, setDocumentLineIds] = useState<number[]>([0]);
  const [nextLineId, setNextLineId] = useState(1);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const retryKeys = useRef(new Map<string, string>());

  const orgParams = useMemo<GetAdminInventoryParams>(() => ({
    view: "organizations", page, pageSize, ...(search.trim() ? { search: search.trim() } : {}),
  }), [page, search]);
  const organizations = useGetAdminInventory(orgParams, { query: { queryKey: getGetAdminInventoryQueryKey(orgParams), retry: false } });
  const locationsParams = useMemo<GetAdminInventoryParams>(() => ({ view: "locations", ...(selectedOrgId ? { organizationId: selectedOrgId } : {}) }), [selectedOrgId]);
  const locations = useGetAdminInventory(locationsParams, { query: { queryKey: getGetAdminInventoryQueryKey(locationsParams), retry: false, enabled: Boolean(selectedOrgId) } });
  const branchesParams = useMemo<GetAdminInventoryParams>(() => ({ view: "branches", ...(selectedOrgId ? { organizationId: selectedOrgId } : {}) }), [selectedOrgId]);
  const branches = useGetAdminInventory(branchesParams, { query: { queryKey: getGetAdminInventoryQueryKey(branchesParams), retry: false, enabled: Boolean(selectedOrgId) } });
  const itemsParams = useMemo<GetAdminInventoryParams>(() => ({
    view: "items", ...(selectedOrgId ? { organizationId: selectedOrgId } : {}), page: 1, pageSize: 100,
    ...(itemSearch.trim() ? { search: itemSearch.trim() } : {}),
  }), [selectedOrgId, itemSearch]);
  const catalogItems = useGetAdminInventory(itemsParams, { query: { queryKey: getGetAdminInventoryQueryKey(itemsParams), retry: false, enabled: Boolean(selectedOrgId) } });
  const balancesParams = useMemo<GetAdminInventoryParams>(() => ({
    view: "balances", ...(selectedLocationId ? { locationId: selectedLocationId } : {}), page, pageSize,
    sortBy: (["name", "available", "updatedAt"].includes(sortBy) ? sortBy : "name") as GetAdminInventoryParams["sortBy"],
    sortDirection,
    ...(search.trim() && view === "stock" ? { search: search.trim() } : {}),
  }), [selectedLocationId, search, view, page, sortBy, sortDirection]);
  const balances = useGetAdminInventory(balancesParams, { query: { queryKey: getGetAdminInventoryQueryKey(balancesParams), retry: false, enabled: Boolean(selectedLocationId) } });
  const documentsView: GetAdminInventoryParams["view"] = view === "transfers" ? "transfers" : view === "counts" ? "counts" : "documents";
  const documentsParams = useMemo<GetAdminInventoryParams>(() => ({
    view: documentsView, ...(selectedLocationId ? { locationId: selectedLocationId } : {}), page, pageSize,
    sortBy: (["createdAt", "status", "type"].includes(sortBy) ? sortBy : "createdAt") as GetAdminInventoryParams["sortBy"],
    sortDirection,
    ...(statusFilter ? { status: statusFilter as GetAdminInventoryParams["status"] } : {}),
    ...(search.trim() ? { search: search.trim() } : {}),
  }), [documentsView, selectedLocationId, page, search, sortBy, sortDirection, statusFilter]);
  const documents = useGetAdminInventory(documentsParams, { query: { queryKey: getGetAdminInventoryQueryKey(documentsParams), retry: false, enabled: ["documents", "transfers", "counts"].includes(view) && Boolean(selectedLocationId) } });
  const movementsParams = useMemo<GetAdminInventoryParams>(() => ({
    view: "movements", ...(selectedLocationId ? { locationId: selectedLocationId } : {}), page, pageSize,
    sortBy: (["occurredAt", "itemName", "kind"].includes(sortBy) ? sortBy : "occurredAt") as GetAdminInventoryParams["sortBy"],
    sortDirection,
    ...(search.trim() ? { search: search.trim() } : {}),
  }), [selectedLocationId, page, search, sortBy, sortDirection]);
  const movements = useGetAdminInventory(movementsParams, { query: { queryKey: getGetAdminInventoryQueryKey(movementsParams), retry: false, enabled: view === "movements" && Boolean(selectedLocationId) } });
  const documentParams = useMemo<GetAdminInventoryParams>(() => ({ view: "document", ...(selectedDocumentId ? { documentId: selectedDocumentId } : {}) }), [selectedDocumentId]);
  const documentDetail = useGetAdminInventory(documentParams, { query: { queryKey: getGetAdminInventoryQueryKey(documentParams), retry: false, enabled: Boolean(selectedDocumentId) } });
  const reconciliationParams = useMemo<GetAdminInventoryParams>(() => ({
    view: "reconciliation", ...(selectedOrgId ? { organizationId: selectedOrgId } : {}),
    ...(selectedLocationId ? { locationId: selectedLocationId } : {}),
  }), [selectedOrgId, selectedLocationId]);
  const reconciliation = useGetAdminInventory(reconciliationParams, { query: { queryKey: getGetAdminInventoryQueryKey(reconciliationParams), retry: false, enabled: view === "reconciliation" && Boolean(selectedLocationId) } });
  const summaryParams = useMemo<GetAdminInventoryParams>(() => ({ view: "summary", ...(selectedLocationId ? { locationId: selectedLocationId } : {}) }), [selectedLocationId]);
  const summary = useGetAdminInventory(summaryParams, { query: { queryKey: getGetAdminInventoryQueryKey(summaryParams), retry: false, enabled: view === "summary" && Boolean(selectedLocationId) } });
  const alertParams = useMemo<GetAdminInventoryParams>(() => ({
    view: "alerts", ...(selectedLocationId ? { locationId: selectedLocationId } : {}), page, pageSize,
    ...(search.trim() ? { search: search.trim() } : {}),
  }), [selectedLocationId, page, search]);
  const alerts = useGetAdminInventory(alertParams, { query: { queryKey: getGetAdminInventoryQueryKey(alertParams), retry: false, enabled: view === "alerts" && Boolean(selectedLocationId) } });
  const returnSourcesParams = useMemo<GetAdminInventoryParams>(() => ({
    view: "return_sources", ...(selectedLocationId ? { locationId: selectedLocationId } : {}),
    page: 1, pageSize: 100, ...(itemSearch.trim() ? { search: itemSearch.trim() } : {}),
  }), [selectedLocationId, itemSearch]);
  const returnSources = useGetAdminInventory(returnSourcesParams, { query: { queryKey: getGetAdminInventoryQueryKey(returnSourcesParams), retry: false, enabled: showDocumentForm && documentType === "return" && Boolean(selectedLocationId) } });

  const orgRows = asRows(organizations.data?.items);
  const locationRows = asRows(locations.data?.items);
  const branchRows = asRows(branches.data?.items);
  const itemRows = asRows(catalogItems.data?.items);
  const balanceRows = asRows(balances.data?.items);
  const activeOrg = orgRows.find((org) => rowId(org) === selectedOrgId);
  const activeLocation = locationRows.find((location) => rowId(location) === selectedLocationId);
  const totalOrg = numberValue(organizations.data?.total) ?? orgRows.length;
  const totalBalances = numberValue(balances.data?.total) ?? balanceRows.length;
  const totalDocuments = numberValue(documents.data?.total) ?? asRows(documents.data?.items).length;
  const totalMovements = numberValue(movements.data?.total) ?? asRows(movements.data?.items).length;
  const totalAlerts = numberValue(alerts.data?.total) ?? asRows(alerts.data?.items).length;
  const summaryRow = asRow(summary.data?.summary);

  useEffect(() => {
    if (!selectedOrgId && orgRows.length) setSelectedOrgId(rowId(orgRows[0]));
  }, [orgRows, selectedOrgId]);
  useEffect(() => {
    if (!selectedLocationId && locationRows.length) setSelectedLocationId(rowId(locationRows[0]));
    else if (selectedLocationId && !locationRows.some((location) => rowId(location) === selectedLocationId)) {
      setSelectedLocationId(locationRows.length ? rowId(locationRows[0]) : "");
    }
  }, [locationRows, selectedLocationId]);

  async function refreshAffected() {
    await cache.invalidateQueries({ queryKey: getGetAdminInventoryQueryKey() });
  }
  async function send(action: ExecuteAdminInventoryCommandAction, payload: DataRow) {
    const fingerprint = JSON.stringify([action, payload]);
    const idempotencyKey = retryKeys.current.get(fingerprint) ?? `${crypto.randomUUID()}-${crypto.randomUUID()}`;
    retryKeys.current.set(fingerprint, idempotencyKey);
    const result = await command.mutateAsync({ data: { action, payload, idempotencyKey } });
    retryKeys.current.delete(fingerprint);
    await refreshAffected();
    return result;
  }
  function clearMessages() { setError(""); setNotice(""); }
  function changeView(next: View) {
    setView(next); setPage(1); setSearch(""); setSelectedDocumentId(""); clearMessages();
  }
  function submitForm(e: FormEvent<HTMLFormElement>, fn: (form: HTMLFormElement) => Promise<void>) {
    e.preventDefault();
    clearMessages();
    void fn(e.currentTarget);
  }
  async function createLocation(form: HTMLFormElement) {
    if (!canManageInventory) { setError("لا تملك صلاحية إدارة مواقع المخزون."); return; }
    const data = new FormData(form);
    try {
      const created = await send("location.create", {
        organizationId: selectedOrgId,
        branchId: String(data.get("branchId") ?? "").trim(),
        name: String(data.get("name") ?? "").trim(),
        kind: String(data.get("kind") ?? "").trim(),
        reason: String(data.get("reason") ?? "").trim(),
      });
      setNotice("تم إرسال إنشاء موقع التخزين. تم تحديث بيانات المخزون المتاحة.");
      setShowLocationForm(false);
      if (typeof created.id === "string") {
        setSelectedLocationId(created.id);
        setView("stock");
      }
    } catch (caught) { setError(errText(caught)); }
  }
  async function createDocument(form: HTMLFormElement) {
    if (!canManageInventory) { setError("لا تملك صلاحية إنشاء مستندات المخزون."); return; }
    const data = new FormData(form);
    const lines = Array.from(form.querySelectorAll<HTMLElement>("[data-inv-line]")).map((line) => ({
      itemId: String(line.querySelector<HTMLSelectElement>("[name=itemId]")?.value ?? ""),
      quantity: String(line.querySelector<HTMLInputElement>("[name=quantity]")?.value ?? ""),
      ...(documentType === "return" ? { sourceMovementId: String(line.querySelector<HTMLSelectElement>("[name=sourceMovementId]")?.value ?? "") } : {}),
    })).filter((line) => {
      const quantity = Number(line.quantity);
      return line.itemId && Number.isFinite(quantity) && (documentType !== "return" || line.sourceMovementId)
        && (documentType === "count" ? quantity >= 0 : documentType === "adjustment" ? quantity !== 0 : quantity > 0);
    });
    if (!lines.length) { setError(documentType === "return" ? "اختر حركة صرف أصلية، ثم أدخل كمية الإرجاع." : "اختر صنفًا واحدًا على الأقل وأدخل كمية صحيحة."); return; }
    if (new Set(lines.map((line) => line.itemId)).size !== lines.length) { setError("لا تكرر الصنف في المستند؛ اجمع كميته في سطر واحد."); return; }
    try {
      await send("document.create", {
        organizationId: selectedOrgId,
        sourceLocationId: String(data.get("sourceLocationId") ?? ""),
        ...(String(data.get("targetLocationId") ?? "") ? { targetLocationId: String(data.get("targetLocationId")) } : {}),
        type: documentType,
        reason: String(data.get("reason") ?? "").trim(),
        lines,
      });
      setNotice("تم إنشاء مستند المخزون وإرسال تفاصيله للمراجعة حسب سير العمل.");
      setShowDocumentForm(false);
      setDocumentLineIds([0]);
      setReturnSourceByLine({});
      if (documentType === "transfer") setView("transfers");
      else if (documentType === "count") setView("counts");
    } catch (caught) { setError(errText(caught)); }
  }
  async function reviewDocument(form: HTMLFormElement) {
    if (!canManageInventory) { setError("لا تملك صلاحية مراجعة مستندات المخزون."); return; }
    const data = new FormData(form);
    try {
      await send("document.review", {
        documentId: selectedDocumentId,
        decision: String(data.get("decision") ?? "").trim(),
        reason: String(data.get("reason") ?? "").trim(),
      });
      setNotice("تم إرسال قرار مراجعة المستند.");
      form.reset();
    } catch (caught) { setError(errText(caught)); }
  }
  async function saveReorderRule(form: HTMLFormElement) {
    if (!canManageInventory) { setError("لا تملك صلاحية تعديل حدود إعادة الطلب."); return; }
    const data = new FormData(form);
    try {
      await send("reorder.set", {
        organizationId: selectedOrgId,
        locationId: selectedLocationId,
        itemId: String(data.get("itemId") ?? ""),
        reorderLevel: String(data.get("reorderLevel") ?? ""),
        reason: String(data.get("reason") ?? "").trim(),
      });
      setNotice("تم حفظ حد التنبيه وتسجيل سبب التغيير.");
      setShowReorderForm(false);
      await refreshAffected();
    } catch (caught) { setError(errText(caught)); }
  }

  const tabs: { id: View; label: string; icon: ReactNode }[] = [
    { id: "organizations", label: "الجهات", icon: <Warehouse size={16}/> },
    { id: "summary", label: "الملخص", icon: <ShieldCheck size={16}/> },
    { id: "stock", label: "أرصدة الأصناف", icon: <PackageCheck size={16}/> },
    { id: "documents", label: "المستندات", icon: <ClipboardList size={16}/> },
    { id: "transfers", label: "التحويلات", icon: <ArrowLeftRight size={16}/> },
    { id: "counts", label: "الجرد", icon: <ClipboardList size={16}/> },
    { id: "alerts", label: "تنبيهات النقص", icon: <AlertTriangle size={16}/> },
    { id: "movements", label: "حركة المخزون", icon: <ArrowLeftRight size={16}/> },
    { id: "reconciliation", label: "المطابقة", icon: <ShieldCheck size={16}/> },
  ];

  return <main className="inv-page" dir="rtl">
    <header className="inv-heading">
      <div><span className="inv-eyebrow">العمليات المركزية / المخزون</span><h1>مخزون منتجات التجار</h1>
        <p>متابعة الأرصدة ومواقع التخزين وسجل حيازة المنتجات التجارية للجهات التي تملك مخزونًا.</p></div>
      <span className="inv-heading-mark"><ShieldCheck size={15}/> سجل تشغيلي موثّق</span>
    </header>
    <aside className="inv-scope" role="note">
      <AlertTriangle size={18}/>
      <div><strong>نطاق هذه الصفحة محدد بمخزون المنتجات التجارية.</strong> لا تشمل مبيعات الخدمات، أو مخزون خزانات الوقود، أو الفواتير، أو القيود المالية، أو التجارة الإلكترونية.</div>
    </aside>

    <nav className="inv-tabs" role="tablist" aria-label="أقسام مخزون المنتجات">
      {tabs.map((tab) => <button key={tab.id} role="tab" aria-selected={view === tab.id} onClick={() => changeView(tab.id)}>{tab.icon}{tab.label}</button>)}
    </nav>
    {error && <div className="inv-alert" role="alert"><CircleAlert size={18}/><span>{error}</span><button className="inv-row-action" onClick={() => setError("")} aria-label="إغلاق التنبيه"><X size={16}/></button></div>}
    {notice && <div className="inv-success" role="status"><Check size={17}/><span>{notice}</span><button className="inv-row-action" onClick={() => setNotice("")} aria-label="إغلاق الإشعار"><X size={16}/></button></div>}

    {view === "organizations" && <section className="inv-panel">
      <div className="inv-panel-head"><div><span className="inv-eyebrow">دليل الجهات</span><h2>الجهات التجارية ومواقعها</h2><p>اختر جهة لعرض مواقع التخزين التابعة لها وإدارة أرصدة المنتجات.</p></div><span className="inv-count">{totalOrg.toLocaleString("ar-EG")} جهة</span></div>
      <div className="inv-toolbar">
        <label className="inv-search"><Search size={17}/><input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="ابحث عن جهة بالاسم أو الرمز" aria-label="البحث عن جهة"/></label>
      </div>
      {organizations.isLoading ? <LoadingState/> : organizations.isError ? <State error permission={isForbidden(organizations.error)} title={isForbidden(organizations.error) ? "لا توجد صلاحية لعرض دليل الجهات" : "تعذر تحميل دليل الجهات"} detail={errText(organizations.error)} retry={() => void organizations.refetch()}/> :
        orgRows.length === 0 ? <State title={search ? "لا توجد نتائج مطابقة" : "لا توجد جهات في هذا النطاق"} detail={search ? "جرّب عبارة بحث مختلفة أو امسح البحث." : "عند توفر جهة تجارية مخولة، ستظهر هنا بياناتها الفعلية."}/> :
          <div className="inv-workspace">
            <div>
              <div className="inv-table-wrap"><table className="inv-table"><thead><tr><th>الجهة</th><th>النوع</th><th>الحالة</th><th>الفروع</th><th>المواقع</th><th>الأصناف المتتبعة</th></tr></thead><tbody>
                {orgRows.map((org, index) => <tr key={rowId(org) || index} aria-selected={selectedOrgId === rowId(org)}>
                  <td><button className="inv-row-action" aria-pressed={selectedOrgId === rowId(org)} aria-label={`اختيار الجهة ${text(org.name, "جهة بلا اسم")}`} onClick={() => { setSelectedOrgId(rowId(org)); setSelectedLocationId(""); }}><b>{text(org.name, "جهة بلا اسم")}</b></button><small>{text(org.code, "لا يوجد رمز تجاري")}</small></td>
                  <td>{organizationKindText(org.kind)}</td><td><span className={`inv-status${org.status === "inactive" || org.status === "suspended" ? " is-inactive" : ""}`}>{statusText(org.status)}</span></td>
                  <td>{count(org.branchCount)}</td><td>{count(org.locationCount)}</td><td>{count(org.trackedItemCount)}</td>
                </tr>)}
              </tbody></table></div>
              <Pagination page={page} total={totalOrg} onPage={setPage}/>
            </div>
            <div className="inv-side-stack">
              <section className="inv-panel">
                <div className="inv-panel-head"><div><span className="inv-eyebrow">المواقع</span><h2>{text(activeOrg?.name, "اختر جهة")}</h2></div>
                  {canManageInventory && <button className="inv-button inv-button-quiet" disabled={!selectedOrgId} onClick={() => { clearMessages(); setShowLocationForm((open) => !open); }}><Plus size={15}/> موقع</button>}
                </div>
                {canManageInventory && showLocationForm && <form className="inv-form" onSubmit={(e) => submitForm(e, createLocation)}>
                  <div className="inv-form-grid">
                    <Field label="الفرع"><select name="branchId" required defaultValue=""><option value="" disabled>اختر فرعًا بالاسم</option>{branchRows.map((branch) => <option key={rowId(branch)} value={rowId(branch)}>{text(branch.name)} · {text(branch.code)}</option>)}</select></Field>
                    <Field label="اسم الموقع"><input name="name" required minLength={2} maxLength={120}/></Field>
                    <Field label="نوع الموقع"><select name="kind" required defaultValue="sellable"><option value="sellable">مخزون صالح</option><option value="quarantine">منطقة مرتجعات</option><option value="damaged">منطقة تالف</option><option value="transit">مخزون منقول</option></select></Field>
                    <input type="hidden" name="reason" value="تسجيل آلي: إجراء إداري من لوحة التحكم"/>
                  </div>
                  <p className="inv-subtle">يجب أن يكون الفرع فعالًا وتابعًا للجهة المحددة. لا ينشئ هذا الإجراء فرعًا جديدًا.</p>
                  <div className="inv-actions"><button className="inv-button inv-button-primary" disabled={command.isPending || branches.isLoading || branchRows.length === 0}><Plus size={15}/> إنشاء الموقع</button><button className="inv-button" type="button" onClick={() => setShowLocationForm(false)}>إلغاء</button></div>
                </form>}
                {locations.isLoading ? <LoadingState rows={2}/> : locations.isError ? <State error permission={isForbidden(locations.error)} title="تعذر تحميل المواقع" detail={errText(locations.error)} retry={() => void locations.refetch()}/> :
                  locationRows.length === 0 ? <State title={selectedOrgId ? "لا توجد مواقع مخزون لهذه الجهة" : "اختر جهة لعرض المواقع"} detail={selectedOrgId ? branchRows.length ? "يمكن إنشاء موقع مخزون في فرع فعال تابع للجهة." : "لا توجد فروع فعالة متاحة لهذه الجهة؛ أنشئ فرعًا أولًا من ملف الجهة." : "حدد جهة من القائمة."}/> :
                    <div className="inv-select-cards">{locationRows.map((location, index) => <button key={rowId(location) || index} className={`inv-location-card${selectedLocationId === rowId(location) ? " is-active" : ""}`} onClick={() => { setSelectedLocationId(rowId(location)); setView("stock"); setPage(1); }}>
                      <b>{text(location.name, "موقع بلا اسم")}</b><MapPin size={16}/><span>{text(location.branchName, locationKindText(location.kind))} · {locationKindText(location.kind)} · متاح {count(location.availableItems)} من {count(location.trackedItems)}</span>
                    </button>)}</div>}
              </section>
            </div>
          </div>}
    </section>}

    {view === "summary" && <section className="inv-panel">
      <div className="inv-panel-head"><div><span className="inv-eyebrow">ملخص موقع محدد</span><h2>{text(summaryRow.locationName, "ملخص المخزون")}</h2><p>المؤشرات أعداد سجلات؛ لا تجمع كميات وحدات مختلفة في رقم واحد.</p></div></div>
      <div className="inv-toolbar"><label className="inv-field inv-filter"><span>موقع التخزين</span><select value={selectedLocationId} onChange={(e) => setSelectedLocationId(e.target.value)}><option value="">اختر موقعًا</option>{locationRows.map((location, index) => <option key={rowId(location) || index} value={rowId(location)}>{text(location.name)} · {text(location.branchName)}</option>)}</select></label></div>
      {!selectedLocationId ? <State title="اختر موقع تخزين" detail="حدد جهة وموقعًا تابعًا لها لعرض مؤشرات فعلية."/> :
        summary.isLoading ? <LoadingState rows={3}/> : summary.isError ? <State error permission={isForbidden(summary.error)} title="تعذر تحميل الملخص" detail={errText(summary.error)} retry={() => void summary.refetch()}/> :
          <div className="inv-summary-grid">
            <article><span>أصناف لها رصيد مسجل</span><b>{count(summaryRow.trackedItems)}</b></article>
            <article><span>أصناف عليها حجز</span><b>{count(summaryRow.reservedItems)}</b></article>
            <article><span>مستندات تنتظر المراجعة</span><b>{count(summaryRow.pendingDocuments)}</b></article>
            <article><span>أصناف دون رصيد متاح</span><b>{count(summaryRow.emptyStockItems)}</b></article>
            <article><span>أصناف عند حد التنبيه</span><b>{count(summaryRow.lowStockItems)}</b></article>
          </div>}
    </section>}

    {view === "stock" && <section className="inv-panel">
      <div className="inv-panel-head"><div><span className="inv-eyebrow">رصيد حالي</span><h2>{text(activeLocation?.name, "أرصدة المنتجات")}</h2><p>الرصيد المتاح يساوي الكمية الموجودة مطروحًا منها الكمية المحجوزة.</p></div>
        <div className="inv-actions"><button className="inv-button" disabled={!selectedLocationId} onClick={() => void balances.refetch()}><RefreshCw size={15}/> تحديث</button>{canManageInventory && <><button className="inv-button inv-button-quiet" disabled={!selectedLocationId || !selectedOrgId} onClick={() => { clearMessages(); setReorderDefaults({ itemId: "", level: "" }); setShowReorderForm((open) => !open); }}><AlertTriangle size={15}/> حد التنبيه</button><button className="inv-button inv-button-primary" disabled={!selectedLocationId || !selectedOrgId} onClick={() => { clearMessages(); setShowDocumentForm((open) => !open); }}><Plus size={15}/> مستند مخزون</button></>}</div>
      </div>
      <div className="inv-meta">{activeOrg && <span>الجهة: <b>{text(activeOrg.name)}</b></span>}{activeLocation && <span>الفرع: <b>{text(activeLocation.branchName)}</b></span>}</div>
      <div className="inv-toolbar">
        <label className="inv-search"><Search size={17}/><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ابحث عن صنف أو رمز داخلي" aria-label="البحث في أرصدة المنتجات"/></label>
        <label className="inv-field inv-filter"><span>موقع التخزين</span><select value={selectedLocationId} onChange={(e) => setSelectedLocationId(e.target.value)}><option value="">اختر موقعًا</option>{locationRows.map((location, index) => <option key={rowId(location) || index} value={rowId(location)}>{text(location.name)} · {text(location.branchName)}</option>)}</select></label>
        <label className="inv-field inv-filter"><span>ترتيب حسب</span><select value={["name", "available", "updatedAt"].includes(sortBy) ? sortBy : "name"} onChange={(e) => { setSortBy(e.target.value); setSortDirection(e.target.value === "name" ? "asc" : "desc"); setPage(1); }}><option value="name">اسم الصنف</option><option value="available">الكمية المتاحة</option><option value="updatedAt">آخر تحديث</option></select></label>
        <button className="inv-button inv-button-quiet" type="button" onClick={() => { setSortDirection((direction) => direction === "asc" ? "desc" : "asc"); setPage(1); }}>{sortDirection === "asc" ? "تصاعدي" : "تنازلي"}</button>
      </div>
      {canManageInventory && showReorderForm && <form className="inv-form" onSubmit={(e) => submitForm(e, saveReorderRule)}>
        <div className="inv-panel-head"><div><span className="inv-eyebrow">تنبيه تشغيلي</span><h2>حد إعادة الطلب</h2><p>يُضبط لكل صنف وموقع؛ لا ينشئ كمية أو عملية شراء.</p></div><button className="inv-row-action" type="button" aria-label="إغلاق" onClick={() => setShowReorderForm(false)}><X size={17}/></button></div>
        <div className="inv-form-grid">
          <Field label="الصنف"><select name="itemId" required defaultValue={reorderDefaults.itemId}><option value="" disabled>اختر صنفًا من الجهة</option>{itemRows.map((item, index) => <option key={rowId(item) || index} value={text(item.itemId, "")}>{text(item.name)} · {unitText(item.unitCode)}</option>)}</select></Field>
          <Field label="حد إعادة الطلب"><input name="reorderLevel" type="number" min="0" step="any" required defaultValue={reorderDefaults.level} placeholder="مثال: 5"/></Field>
          <input type="hidden" name="reason" value="تسجيل آلي: إجراء إداري من لوحة التحكم"/>
        </div>
        <p className="inv-subtle">القيمة صفر تعني التنبيه عند النفاد فقط. لا يوجد حد تلقائي عند ترك الصنف دون إعداد.</p>
        <div className="inv-actions"><button className="inv-button inv-button-primary" disabled={command.isPending || catalogItems.isLoading || !selectedLocationId}><Check size={15}/> حفظ الحد</button><button className="inv-button" type="button" onClick={() => setShowReorderForm(false)}>إلغاء</button></div>
      </form>}
      {canManageInventory && showDocumentForm && <form className="inv-form inv-panel" onSubmit={(e) => submitForm(e, createDocument)}>
        <div className="inv-panel-head"><div><span className="inv-eyebrow">مستند مقيّد بسبب</span><h2>إنشاء مستند مخزون</h2><p>اختر الصنف والكمية بدقة. لا يُعدّ إنشاء المستند ترحيلًا ماليًا.</p></div><button className="inv-row-action" type="button" aria-label="إغلاق" onClick={() => setShowDocumentForm(false)}><X size={17}/></button></div>
        <div className="inv-form-grid">
           <Field label="نوع المستند"><select name="type" value={documentType} onChange={(e) => { setDocumentType(e.target.value); setReturnSourceByLine({}); }} required>
             <option value="opening">رصيد افتتاحي — مرة واحدة لكل صنف وموقع</option><option value="receipt">استلام بضاعة</option><option value="issue">صرف بضاعة</option><option value="return">إرجاع إلى منطقة المرتجعات</option>
            <option value="damage">نقل إلى منطقة التالف</option><option value="transfer">نقل بين المواقع</option><option value="count">جرد فعلي</option><option value="adjustment">تسوية كمية بسبب موثق</option>
          </select></Field>
          <Field label="موقع المصدر"><select name="sourceLocationId" required defaultValue={selectedLocationId}>{locationRows.map((location, index) => <option key={rowId(location) || index} value={rowId(location)}>{text(location.name)} · {text(location.branchName)}</option>)}</select></Field>
          {(documentType === "transfer" || documentType === "damage" || documentType === "return") && <Field label={documentType === "damage" ? "موقع التالف" : documentType === "return" ? "منطقة المرتجعات" : "موقع الوجهة"}>
            <select name="targetLocationId" required defaultValue=""><option value="" disabled>اختر موقعًا</option>{locationRows.filter((location) => rowId(location) !== selectedLocationId && (documentType === "damage" ? location.kind === "damaged" : documentType === "return" ? location.kind === "quarantine" : true)).map((location, index) => <option key={rowId(location) || index} value={rowId(location)}>{text(location.name)} · {text(location.branchName)}</option>)}</select>
          </Field>}
          <input type="hidden" name="reason" value="تسجيل آلي: إجراء إداري من لوحة التحكم"/>
        </div>
        <div className="inv-lines">
          <div className="inv-panel-head"><div><h2>الأصناف والكميات</h2><p>الأصناف النشطة والمعتمدة في كتالوج الجهة فقط.</p></div><button className="inv-button inv-button-quiet" type="button" onClick={() => { setDocumentLineIds((ids) => [...ids, nextLineId]); setNextLineId((id) => id + 1); }}><Plus size={15}/> إضافة سطر</button></div>
          <label className="inv-search"><Search size={17}/><input value={itemSearch} onChange={(e) => setItemSearch(e.target.value)} placeholder="ابحث عن صنف معتمد بالاسم أو الرمز" aria-label="البحث عن صنف"/></label>
           {documentType === "return" && (returnSources.isLoading
             ? <p className="inv-subtle" role="status">جارٍ تحميل حركات الصرف القابلة للإرجاع…</p>
             : returnSources.isError
               ? <State error permission={isForbidden(returnSources.error)} title="تعذر تحميل حركات الصرف" detail={errText(returnSources.error)} retry={() => void returnSources.refetch()}/>
               : asRows(returnSources.data?.items).length === 0
                 ? <p className="inv-subtle">لا توجد حركة صرف متبقية للإرجاع ضمن هذا الموقع.</p>
                 : null)}
           <div id="inv-lines">{documentLineIds.map((lineId) => {
             const selectedSource = asRows(returnSources.data?.items).find((source) => String(source.movementId) === returnSourceByLine[lineId]);
             return <div className="inv-line-row" data-inv-line key={lineId}>
               {documentType === "return" ? <>
                 <Field label="حركة الصرف الأصلية"><select name="sourceMovementId" required value={returnSourceByLine[lineId] ?? ""} onChange={(event) => setReturnSourceByLine((current) => ({ ...current, [lineId]: event.target.value }))}>
                   <option value="" disabled>اختر صرفًا سابقًا لهذا الموقع</option>
                   {asRows(returnSources.data?.items).map((source, index) => <option key={String(source.movementId ?? index)} value={String(source.movementId ?? "")}>{text(source.itemName)} · متبقٍ {count(source.remainingQuantity)} {unitText(source.unitCode)} · {dateText(source.occurredAt)}</option>)}
                 </select></Field>
                 <input type="hidden" name="itemId" value={text(selectedSource?.itemId, "")}/>
               </> : <Field label="الصنف"><select name="itemId" required defaultValue=""><option value="" disabled>اختر صنفًا</option>{itemRows.map((item, index) => <option key={rowId(item) || index} value={text(item.itemId, "")}>{text(item.name)} · {unitText(item.unitCode)} · {text(item.internalCode, "دون رمز")}</option>)}</select></Field>}
               <Field label={documentType === "count" ? "الكمية الفعلية" : documentType === "adjustment" ? "فرق الكمية (النقص بالسالب)" : "الكمية"}><input name="quantity" required type="number" min={documentType === "count" ? "0" : documentType === "adjustment" ? undefined : "0.000001"} step="any" placeholder={documentType === "adjustment" ? "مثال: -0.125 للنقص" : undefined}/></Field>
               <button className="inv-button inv-remove-line" type="button" disabled={documentLineIds.length <= 1} onClick={() => { setDocumentLineIds((ids) => ids.filter((id) => id !== lineId)); setReturnSourceByLine((sources) => { const next = { ...sources }; delete next[lineId]; return next; }); }} aria-label="حذف السطر"><X size={15}/> حذف</button>
             </div>;
           })}</div>
        </div>
        {catalogItems.isError ? <State error title="تعذر تحميل أصناف الكتالوج" detail={errText(catalogItems.error)} retry={() => void catalogItems.refetch()}/> : null}
        <div className="inv-actions"><button className="inv-button inv-button-primary" disabled={command.isPending || catalogItems.isLoading || itemRows.length === 0}><ClipboardList size={15}/> إنشاء المستند</button><button className="inv-button" type="button" onClick={() => setShowDocumentForm(false)}>إلغاء</button></div>
      </form>}
      {!selectedLocationId ? <State title="اختر موقع تخزين" detail="حدد الجهة وموقعها من تبويب الجهات لعرض رصيد الأصناف الفعلي."/> :
        balances.isLoading ? <LoadingState rows={5}/> : balances.isError ? <State error permission={isForbidden(balances.error)} title="تعذر تحميل الأرصدة" detail={errText(balances.error)} retry={() => void balances.refetch()}/> :
           balanceRows.length === 0 ? <State title={search ? "لا توجد أصناف مطابقة" : "لا توجد أرصدة أصناف لهذا الموقع"} detail={search ? "امسح البحث أو جرّب اسمًا ورمزًا مختلفين." : "لا توجد سجلات أرصدة في نتيجة الخدمة لهذا الموقع."}/> :
             <div className="inv-table-wrap"><table className="inv-table"><thead><tr><th>الصنف</th><th>التصنيف</th><th>الوحدة</th><th>على اليد</th><th>محجوز</th><th>متاح</th><th>حد التنبيه</th><th>آخر تحديث</th></tr></thead><tbody>
              {balanceRows.map((item, index) => {
                const available = numberValue(item.available);
                 return <tr key={rowId(item) || index}><td><b>{itemName(item)}</b><small>{text(item.internalCode, "دون رمز داخلي")}</small></td>
                   <td>{text(item.categoryName, "تصنيف غير متاح")}</td><td>{unitText(item.unitCode)}</td>
                  <td className="inv-num">{count(item.onHand)}</td><td className="inv-num">{count(item.reserved)}</td>
                  <td className={`inv-num${available !== null && available <= 0 ? " inv-low" : " inv-available"}`}>{count(item.available)}</td>
                   <td>{item.reorderLevel === null || item.reorderLevel === undefined ? "غير مضبوط" : <>{count(item.reorderLevel)} {unitText(item.unitCode)}{item.reorderStatus === "empty" ? " · نفد" : item.reorderStatus === "low" ? " · منخفض" : ""}</>}
                     {canManageInventory && <button className="inv-row-action" onClick={() => { setReorderDefaults({ itemId: text(item.itemId, ""), level: text(item.reorderLevel, "0") }); setShowReorderForm(true); }}>تعديل</button>}</td>
                  <td>{dateText(item.updatedAt)}<small>إصدار {count(item.version)}</small></td>
                </tr>;
              })}
             </tbody></table></div>}
      {selectedLocationId && !balances.isLoading && !balances.isError && totalBalances > 0 && <Pagination page={page} total={totalBalances} onPage={setPage}/>}
    </section>}

    {["documents", "transfers", "counts"].includes(view) && <section className="inv-panel">
      <div className="inv-panel-head"><div><span className="inv-eyebrow">أثر الحيازة</span><h2>{view === "transfers" ? "التحويلات الداخلية" : view === "counts" ? "مستندات الجرد" : "مستندات المخزون"}</h2><p>{view === "transfers" ? "نقل موثق بين مواقع الجهة نفسها، مع خصم وإضافة متزامنين." : view === "counts" ? "تسجل كل جلسة لقطة للرصيد؛ إذا تغير قبل الاعتماد تُطلب إعادة الجرد." : "سجل عمليات المخزون التجارية وقرارات المراجعة؛ لا ينشئ قيودًا مالية."}</p></div><div className="inv-actions"><span className="inv-count">{totalDocuments.toLocaleString("ar-EG")} سجل</span>{canManageInventory && view !== "documents" && <button className="inv-button inv-button-primary" disabled={!selectedLocationId} onClick={() => { setDocumentType(view === "transfers" ? "transfer" : "count"); setDocumentLineIds([0]); setReturnSourceByLine({}); setView("stock"); setShowDocumentForm(true); }}><Plus size={15}/>{view === "transfers" ? "إنشاء تحويل" : "بدء جرد"}</button>}</div></div>
      <div className="inv-toolbar"><label className="inv-search"><Search size={17}/><input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="ابحث بالسبب أو النوع أو الحالة" aria-label="البحث في المستندات"/></label>
         <label className="inv-field inv-filter"><span>موقع التخزين</span><select value={selectedLocationId} onChange={(e) => setSelectedLocationId(e.target.value)}><option value="">كل المواقع المتاحة</option>{locationRows.map((location, index) => <option key={rowId(location) || index} value={rowId(location)}>{text(location.name)}</option>)}</select></label>
         <label className="inv-field inv-filter"><span>الحالة</span><select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}><option value="">كل الحالات</option><option value="pending">بانتظار المراجعة</option><option value="approved">معتمد</option><option value="rejected">مرفوض</option></select></label>
         <label className="inv-field inv-filter"><span>ترتيب حسب</span><select value={["createdAt", "status", "type"].includes(sortBy) ? sortBy : "createdAt"} onChange={(e) => { setSortBy(e.target.value); setSortDirection(e.target.value === "createdAt" ? "desc" : "asc"); setPage(1); }}><option value="createdAt">تاريخ الإنشاء</option><option value="status">الحالة</option><option value="type">النوع</option></select></label>
         <button className="inv-button inv-button-quiet" type="button" onClick={() => { setSortDirection((direction) => direction === "asc" ? "desc" : "asc"); setPage(1); }}>{sortDirection === "asc" ? "تصاعدي" : "تنازلي"}</button></div>
      {!selectedLocationId ? <State title="اختر موقع التخزين" detail="حدد الجهة وموقعًا تابعًا لها لعرض مستندات المخزون."/> : documents.isLoading ? <LoadingState rows={5}/> : documents.isError ? <State error permission={isForbidden(documents.error)} title="تعذر تحميل المستندات" detail={errText(documents.error)} retry={() => void documents.refetch()}/> :
      asRows(documents.data?.items).length === 0 ? <State title={search ? "لا توجد مستندات مطابقة" : "لا توجد مستندات مخزون"} detail="ستظهر هنا المستندات التي ترجعها الخدمة ضمن نطاق صلاحياتك."/> :
          <><div className="inv-table-wrap"><table className="inv-table"><thead><tr><th>المستند</th><th>النوع</th><th>الحالة</th><th>المصدر</th><th>الوجهة</th><th>التاريخ</th><th></th></tr></thead><tbody>
            {asRows(documents.data?.items).map((doc, index) => <tr key={rowId(doc) || index}><td><b>{documentTypeText(doc.type)} · {dateText(doc.createdAt)}</b><small>{text(doc.reason, "لا يوجد سبب معروض")}</small></td><td>{documentTypeText(doc.type)}</td><td><span className={`inv-status${doc.status === "rejected" ? " is-rejected" : doc.status === "pending" || doc.status === "draft" ? " is-pending" : ""}`}>{statusText(doc.status)}</span></td><td>{text(doc.sourceLocationName, "غير متاح")}</td><td>{text(doc.targetLocationName, "—")}</td><td>{dateText(doc.createdAt ?? doc.updatedAt)}</td><td><button className="inv-row-action" onClick={() => setSelectedDocumentId(rowId(doc))}>عرض التفاصيل</button></td></tr>)}
          </tbody></table></div><Pagination page={page} total={totalDocuments} onPage={setPage}/></>}
      {selectedDocumentId && <section className="inv-panel">
         <div className="inv-panel-head"><div><span className="inv-eyebrow">تفاصيل المستند</span><h2>مستند {documentTypeText(asRow(asRow(documentDetail.data).document).type)}</h2></div><button className="inv-row-action" onClick={() => setSelectedDocumentId("")} aria-label="إغلاق التفاصيل"><X size={17}/></button></div>
        {documentDetail.isLoading ? <LoadingState rows={2}/> : documentDetail.isError ? <State error permission={isForbidden(documentDetail.error)} title="تعذر تحميل تفاصيل المستند" detail={errText(documentDetail.error)} retry={() => void documentDetail.refetch()}/> :
           <DocumentDetail document={asRow(asRow(documentDetail.data).document)} lines={asRows(asRow(documentDetail.data).lines)} busy={command.isPending} canReview={canManageInventory} onReview={reviewDocument}/>}
      </section>}
    </section>}

    {view === "alerts" && <section className="inv-panel">
      <div className="inv-panel-head"><div><span className="inv-eyebrow">حدود الصنف والموقع</span><h2>تنبيهات انخفاض المخزون</h2><p>يعرض هذا القسم الأصناف التي وصل المتاح فيها إلى الحد الذي ضبطه مسؤول مخول، أو نفد رصيدها.</p></div><div className="inv-actions"><span className="inv-count">{totalAlerts.toLocaleString("ar-EG")} تنبيه</span>{canManageInventory && <button className="inv-button inv-button-primary" onClick={() => { setView("stock"); setShowReorderForm(true); }}><AlertTriangle size={15}/> إدارة الحدود</button>}</div></div>
      <div className="inv-toolbar"><label className="inv-search"><Search size={17}/><input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="ابحث عن صنف أو رمز داخلي" aria-label="البحث في تنبيهات المخزون"/></label>
        <label className="inv-field inv-filter"><span>موقع التخزين</span><select value={selectedLocationId} onChange={(e) => setSelectedLocationId(e.target.value)}><option value="">اختر موقعًا</option>{locationRows.map((location, index) => <option key={rowId(location) || index} value={rowId(location)}>{text(location.name)} · {text(location.branchName)}</option>)}</select></label></div>
      {!selectedLocationId ? <State title="اختر موقع تخزين" detail="حدد الجهة والموقع لعرض التنبيهات الفعلية."/> :
        alerts.isLoading ? <LoadingState rows={4}/> : alerts.isError ? <State error permission={isForbidden(alerts.error)} title="تعذر تحميل التنبيهات" detail={errText(alerts.error)} retry={() => void alerts.refetch()}/> :
          asRows(alerts.data?.items).length === 0 ? <State title={search ? "لا توجد تنبيهات مطابقة" : "لا توجد أصناف تجاوزت حدها"} detail="الأصناف بلا حد إعادة طلب لا تولد تنبيهًا تلقائيًا. اضبط الحدود من صفحة الأرصدة عند الحاجة."/> :
            <><div className="inv-table-wrap"><table className="inv-table"><thead><tr><th>الصنف</th><th>المتاح</th><th>حد إعادة الطلب</th><th>الحالة</th><th>الموقع</th><th>آخر تعديل</th></tr></thead><tbody>
              {asRows(alerts.data?.items).map((item, index) => <tr key={rowId(item) || index}><td><b>{itemName(item)}</b><small>{text(item.internalCode, "دون رمز داخلي")}</small></td><td className="inv-num">{count(item.available)} {unitText(item.unitCode)}</td><td className="inv-num">{count(item.reorderLevel)} {unitText(item.unitCode)}</td><td><span className={`inv-status${item.status === "empty" ? " is-rejected" : " is-pending"}`}>{item.status === "empty" ? "نفد المتاح" : "بلغ الحد"}</span></td><td>{text(item.branchName)}</td><td>{dateText(item.updatedAt)}</td></tr>)}
            </tbody></table></div><Pagination page={page} total={totalAlerts} onPage={setPage}/></>}
    </section>}

    {view === "movements" && <section className="inv-panel">
      <div className="inv-panel-head"><div><span className="inv-eyebrow">تاريخ التغييرات</span><h2>حركة المخزون</h2><p>التغييرات الموثقة في حيازة منتجات الجهة المحددة.</p></div><span className="inv-count">{totalMovements.toLocaleString("ar-EG")} حركة</span></div>
      <div className="inv-toolbar"><label className="inv-search"><Search size={17}/><input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="ابحث بالصنف أو السبب أو نوع الحركة" aria-label="البحث في حركة المخزون"/></label>
         <label className="inv-field inv-filter"><span>موقع التخزين</span><select value={selectedLocationId} onChange={(e) => setSelectedLocationId(e.target.value)}><option value="">كل المواقع المتاحة</option>{locationRows.map((location, index) => <option key={rowId(location) || index} value={rowId(location)}>{text(location.name)}</option>)}</select></label>
         <label className="inv-field inv-filter"><span>ترتيب حسب</span><select value={["occurredAt", "itemName", "kind"].includes(sortBy) ? sortBy : "occurredAt"} onChange={(e) => { setSortBy(e.target.value); setSortDirection(e.target.value === "occurredAt" ? "desc" : "asc"); setPage(1); }}><option value="occurredAt">تاريخ الحركة</option><option value="itemName">اسم الصنف</option><option value="kind">نوع الحركة</option></select></label>
         <button className="inv-button inv-button-quiet" type="button" onClick={() => { setSortDirection((direction) => direction === "asc" ? "desc" : "asc"); setPage(1); }}>{sortDirection === "asc" ? "تصاعدي" : "تنازلي"}</button></div>
      {!selectedLocationId ? <State title="اختر موقع التخزين" detail="حدد الجهة وموقعًا تابعًا لها لعرض سجل الحركات."/> : movements.isLoading ? <LoadingState rows={5}/> : movements.isError ? <State error permission={isForbidden(movements.error)} title="تعذر تحميل حركة المخزون" detail={errText(movements.error)} retry={() => void movements.refetch()}/> :
        asRows(movements.data?.items).length === 0 ? <State title={search ? "لا توجد حركات مطابقة" : "لا توجد حركات مخزون"} detail="لا تتوفر حركات ضمن النطاق المحدد في نتيجة الخدمة."/> :
           <><div className="inv-table-wrap"><table className="inv-table"><thead><tr><th>التاريخ</th><th>الصنف</th><th>الحركة</th><th>الكمية</th><th>الموقع</th><th>المسؤول</th><th>المستند</th><th>السبب</th></tr></thead><tbody>
            {asRows(movements.data?.items).map((movement, index) => {
              const delta = numberValue(movement.onHandDelta);
              return <tr key={rowId(movement) || index}><td>{dateText(movement.occurredAt)}</td><td><b>{text(movement.itemName, "اسم غير متاح")}</b><small>{text(movement.internalCode, "دون رمز داخلي")}</small></td><td>{movementKindText(movement.kind)}</td><td className="inv-num">{delta !== null && delta > 0 ? "+" : ""}{count(movement.onHandDelta)} {unitText(movement.unitCode)}</td><td>{text(movement.locationName)}<small>{text(movement.branchName)}</small></td><td>{text(movement.actorName, "مسؤول مخزون")}</td><td>{text(movement.documentId) ? <button className="inv-row-action" onClick={() => setSelectedDocumentId(text(movement.documentId))}>عرض المستند المرتبط</button> : "حركة مباشرة"}</td><td>{text(movement.reason, "—")}</td></tr>;
            })}
          </tbody></table></div><Pagination page={page} total={totalMovements} onPage={setPage}/></>}
      {selectedDocumentId && <section className="inv-panel"><div className="inv-panel-head"><div><span className="inv-eyebrow">المصدر</span><h2>المستند المرتبط بالحركة</h2></div><button className="inv-row-action" onClick={() => setSelectedDocumentId("")} aria-label="إغلاق التفاصيل"><X size={17}/></button></div>
        {documentDetail.isLoading ? <LoadingState rows={2}/> : documentDetail.isError ? <State error permission={isForbidden(documentDetail.error)} title="تعذر تحميل المستند المرتبط" detail={errText(documentDetail.error)} retry={() => void documentDetail.refetch()}/> :
          <DocumentDetail document={asRow(asRow(documentDetail.data).document)} lines={asRows(asRow(documentDetail.data).lines)} busy={command.isPending} canReview={canManageInventory} onReview={reviewDocument}/>}
      </section>}
    </section>}

    {view === "reconciliation" && <section className="inv-panel">
      <div className="inv-panel-head"><div><span className="inv-eyebrow">سلامة الرصيد</span><h2>مطابقة المخزون</h2><p>مقارنة اتساق نتائج أرصدة الموقع كما تقدمها الخدمة.</p></div></div>
      <div className="inv-toolbar"><label className="inv-field inv-filter"><span>موقع التخزين</span><select value={selectedLocationId} onChange={(e) => setSelectedLocationId(e.target.value)}><option value="">اختر موقعًا</option>{locationRows.map((location, index) => <option key={rowId(location) || index} value={rowId(location)}>{text(location.name)} · {text(location.branchName)}</option>)}</select></label></div>
      {!selectedLocationId ? <State title="اختر موقعًا للمطابقة" detail="تُجرى المطابقة على موقع محدد ولا تستبدل الجرد الفعلي."/> :
        reconciliation.isLoading ? <LoadingState rows={3}/> : reconciliation.isError ? <State error permission={isForbidden(reconciliation.error)} title="تعذر إجراء المطابقة" detail={errText(reconciliation.error)} retry={() => void reconciliation.refetch()}/> :
          <Reconciliation data={asRow(reconciliation.data)}/>}
    </section>}
  </main>;
}

function DocumentDetail({ document, lines, busy, canReview, onReview }: {
  document: DataRow; lines: DataRow[]; busy: boolean; canReview: boolean;
  onReview: (form: HTMLFormElement) => Promise<void>;
}) {
  const pending = ["pending", "draft", "not_reviewed"].includes(text(document.status, "").toLowerCase());
  return <div className="inv-document">
    <div className="inv-meta"><span>الحالة: <b>{statusText(document.status)}</b></span><span>النوع: <b>{documentTypeText(document.type)}</b></span><span>المصدر: <b>{text(document.sourceLocationName, "غير متاح")}</b></span><span>الوجهة: <b>{text(document.targetLocationName, "—")}</b></span><span>تاريخ الإنشاء: <b>{dateText(document.createdAt)}</b></span><span>أنشأه: <b>{text(document.createdByName, "اسم غير متاح")}</b></span>{Boolean(document.reviewedAt) && <><span>راجعه: <b>{text(document.reviewedByName, "اسم غير متاح")}</b></span><span>وقت المراجعة: <b>{dateText(document.reviewedAt)}</b></span></>}</div>
    {typeof document.reason === "string" && document.reason && <p className="inv-subtle">سبب المستند: {text(document.reason)}</p>}
    {typeof document.reviewReason === "string" && document.reviewReason && <p className="inv-subtle">سبب قرار المراجعة: {text(document.reviewReason)}</p>}
    {lines.length ? <div className="inv-table-wrap"><table className="inv-table"><thead><tr><th>الصنف</th><th>الكمية</th><th>الوحدة</th><th>مرجع الجرد أو الإرجاع</th></tr></thead><tbody>{lines.map((line, index) => <tr key={rowId(line) || index}><td><b>{text(line.itemName, text(line.name))}</b><small>{text(line.internalCode, "دون رمز داخلي")}</small></td><td className="inv-num">{count(line.quantity)}</td><td>{unitText(line.unitCode)}</td><td>{line.snapshotQuantity !== null && line.snapshotQuantity !== undefined ? <>لقطة {count(line.snapshotQuantity)} · إصدار {count(line.snapshotVersion)}</> : line.originalIssueAt ? <>صرف أصلي {dateText(line.originalIssueAt)}<small>{text(line.originalIssueReason)}</small></> : "—"}</td></tr>)}</tbody></table></div> : <p className="inv-subtle">لا توجد أسطر معروضة لهذا المستند.</p>}
    {pending && !canReview && <p className="inv-subtle">المستند ينتظر قرار مراجع مخوّل. يمكنك عرض التفاصيل دون اعتمادها.</p>}
    {pending && canReview && <form className="inv-form" onSubmit={(e) => { e.preventDefault(); void onReview(e.currentTarget); }}>
      <div className="inv-panel-head"><div><span className="inv-eyebrow">إجراء مراجعة</span><h2>قرار المراجع</h2><p>الإجراء سيُسجل ضمن سجل التدقيق مع السبب.</p></div></div>
      <div className="inv-form-grid"><Field label="قرار المراجعة"><select name="decision" required defaultValue=""><option value="" disabled>اختر قرارًا</option><option value="approve">اعتماد</option><option value="reject">رفض</option></select></Field><input type="hidden" name="reason" value="تسجيل آلي: إجراء إداري من لوحة التحكم"/></div>
      <button className="inv-button inv-button-primary" disabled={busy}><Check size={15}/> إرسال قرار المراجعة</button>
    </form>}
  </div>;
}

function Reconciliation({ data }: { data: DataRow }) {
  const consistent = data.consistent === true;
  const items = asRows(data.items);
  return <div className={`inv-state${consistent ? "" : " is-error"}`} role={consistent ? "status" : "alert"}>
    <span>{consistent ? <Check size={20}/> : <AlertTriangle size={20}/>}</span>
    <b>{consistent ? "نتيجة الخدمة: الأرصدة متسقة" : "نتيجة الخدمة: توجد فروقات أو لا يمكن تأكيد الاتساق"}</b>
    <p>{consistent ? "الخدمة أبلغت عن اتساق بيانات الموقع." : "راجع عناصر المطابقة أدناه وتحقق من سجل الحركة. لا تُعدّل الصفحة الرصيد تلقائيًا."}</p>
    {items.length > 0 && <div className="inv-document" style={{ width: "100%", marginTop: 8 }}>
      {items.map((item, index) => <div className="inv-document-line" key={rowId(item) || index}><span><b>{text(item.name, text(item.itemName, "صنف غير متاح"))}</b><small className="inv-subtle"> {text(item.detail, text(item.reason, ""))}</small></span><b>{statusText(item.status || (item.consistent === true ? "consistent" : item.consistent === false ? "inconsistent" : ""))}</b></div>)}
    </div>}
  </div>;
}
