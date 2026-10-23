import { useMemo, useState, type FormEvent } from "react";
import {
  AlertCircle, ArrowLeft, ArrowRight, Boxes, CircleDollarSign, Clock3,
  CreditCard, History, KeyRound, PackageCheck, Plus, RefreshCw, Search, ShieldCheck,
  Smartphone, Warehouse,
} from "lucide-react";
import { Link } from "wouter";
import {
  getGetAdminFleetCardsQueryKey, getGetAdminFleetStockReservationsQueryKey,
  useGetAdminFleetCards, useGetAdminFleetStockReservations,
} from "@workspace/api-client-react";
import type { GetAdminFleetCardsParams, GetAdminFleetStockReservationsParams } from "@workspace/api-client-react";
import { formatFleetField } from "./fleetDisplay";
import "./FleetCardsAdmin.css";

type FleetCardRow = Record<string, unknown>;
type CardsView = GetAdminFleetCardsParams["view"];
export type FleetCardAction =
  | "credential.approve" | "credential.assign" | "credential.activate_qr"
  | "credential.activate_nfc" | "credential.stop" | "credential.install"
  | "credential.request" | "tag_stock.receive" | "tag_stock.reserve" | "tag_stock.damage";

type Props = {
  canMutate: boolean;
  canActivateNfc?: boolean;
  onOpenAction: (action: FleetCardAction, row: FleetCardRow) => void;
  organizationId?: string;
  vehicleId?: string;
};

const viewOptions: Array<{ id: CardsView; title: string; icon: typeof CreditCard }> = [
  { id: "overview", title: "نظرة عامة", icon: CreditCard },
  { id: "requests", title: "طلبات التعريف", icon: Clock3 },
  { id: "issued", title: "البطاقات الصادرة", icon: KeyRound },
  { id: "stock", title: "مخزون الشرائح", icon: Warehouse },
  { id: "history", title: "سجل الحركة", icon: History },
];
const statusLabels: Record<string, string> = {
  requested: "مطلوب", pending: "قيد المراجعة", pending_review: "بانتظار المراجعة",
  approved: "معتمد", assigned: "مخصص", scheduled: "مجدول", installed: "تم التركيب",
  active: "نشط", stopped: "متوقف", revoked: "مبطل", suspended: "موقوف", rejected: "مرفوض",
  cancelled: "ملغي", available: "متاح", reserved: "محجوز", damaged: "تالف",
  received: "مستلم", lost: "مفقود", eligible: "مؤهل", inactive: "غير نشط",
  paid: "مدفوع", unpaid: "غير مدفوع", pending_payment: "بانتظار التحصيل",
  awaiting_collection: "بانتظار التحصيل",
  waived: "معفى", not_required: "غير مطلوب", collected: "تم التحصيل",
};
const summaryLabels: Record<string, string> = {
  openRequests: "طلبات مفتوحة", awaitingCollection: "بانتظار التحصيل",
  activeNfc: "شرائح NFC نشطة", activeQr: "رموز QR نشطة",
  availableStock: "شرائح متاحة", reservedStock: "شرائح محجوزة",
  damagedStock: "شرائح تالفة", lostStock: "شرائح مفقودة",
};
const credentialTypeLabel = (value: unknown) => {
  const type = String(value ?? "");
  return type === "nfc" ? "شريحة NFC" : type === "qr" ? "رمز QR" : "غير محدد";
};
const requestTypeLabel = (value: unknown) => {
  const type = String(value ?? "");
  return ({ issue: "إصدار", replace: "استبدال", stop: "إيقاف" } as Record<string, string>)[type] ?? "";
};
const actionLabels: Record<FleetCardAction, string> = {
  "credential.approve": "اعتماد الطلب",
  "credential.assign": "إسناد الطلب",
  "credential.activate_qr": "إصدار QR",
  "credential.activate_nfc": "تفعيل NFC",
  "credential.stop": "إيقاف البطاقة",
  "credential.install": "تسجيل التركيب",
  "credential.request": "طلب تعريف",
  "tag_stock.receive": "تسجيل الاستلام",
  "tag_stock.reserve": "حجز شريحة",
  "tag_stock.damage": "تسجيل كتالف",
};
const eligibleStatuses: Partial<Record<FleetCardAction, string[]>> = {
  "credential.approve": ["requested", "pending", "pending_review"],
  "credential.assign": ["approved"],
  "credential.activate_qr": ["approved", "assigned", "scheduled"],
  "credential.activate_nfc": ["installed"],
  "credential.stop": ["active"],
  "credential.install": ["assigned", "scheduled"],
  "credential.request": ["eligible"],
  "tag_stock.receive": ["expected", "pending_receipt"],
  "tag_stock.reserve": ["assigned", "scheduled"],
  "tag_stock.damage": ["available", "reserved"],
};
const safeText = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "—";
const statusText = (value: unknown) => {
  const key = String(value ?? "");
  return statusLabels[key] ?? (key ? key.replaceAll("_", " ") : "غير محدد");
};
const dateText = (value: unknown) => {
  if (typeof value !== "string" || !value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "—"
    : new Intl.DateTimeFormat("ar-EG", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo" }).format(parsed);
};
const egp = (value: unknown) => {
  return formatFleetField("issuePriceMinor", value);
};
const record = (value: unknown): FleetCardRow =>
  value && typeof value === "object" && !Array.isArray(value) ? value as FleetCardRow : {};
const requestReference = (row: FleetCardRow) => {
  const id = typeof row.id === "string" ? row.id.replaceAll("-", "") : "";
  return id ? `طلب-${id.slice(-8).toUpperCase()}` : "مرجع الطلب غير متاح";
};
const activityLabel = (value: unknown) => {
  const action = String(value ?? "").split(".").slice(-2).join(".").replace(/^fleet\./, "");
  return ({
    "credential.request": "إنشاء طلب تعريف",
    "credential.approve": "اعتماد الطلب",
    "credential.assign": "إسناد الطلب",
    "credential.install": "تسجيل التركيب",
    "credential.activate_nfc": "تفعيل NFC منطقي",
    "credential.activate_qr": "إصدار QR منطقي",
    "credential.stop": "إيقاف البطاقة",
    "tag_stock.receive": "استلام شريحة",
    "tag_stock.reserve": "حجز شريحة",
    "tag_stock.damage": "تسجيل شريحة تالفة",
    "credential_request": "إنشاء طلب تعريف",
    "credential_approve": "اعتماد الطلب",
    "credential_assign": "إسناد الطلب",
    "credential_install": "تسجيل التركيب",
    "credential_activate_nfc": "تفعيل NFC منطقي",
    "credential_activate_qr": "إصدار QR منطقي",
    "credential_stop": "إيقاف البطاقة",
    "tag_stock_receive": "استلام شريحة",
    "tag_stock_reserve": "حجز شريحة",
    "tag_stock_damage": "تسجيل شريحة تالفة",
  } as Record<string, string>)[action] ?? "تحديث سجل البطاقة";
};

function allowedActions(row: FleetCardRow, canMutate: boolean, canActivateNfc: boolean, view: CardsView): FleetCardAction[] {
  if (!canMutate || row.canMutate === false || row.mutationAllowed === false) return [];
  const status = String(row.status ?? "");
  return (Object.keys(eligibleStatuses) as FleetCardAction[]).filter(action => {
    if (!eligibleStatuses[action]?.includes(status)) return false;
    if (action.startsWith("credential.") && !["requests", "issued"].includes(view)) return false;
    if (action.startsWith("tag_stock.") && !["requests", "stock"].includes(view)) return false;
    if (action === "tag_stock.reserve" && !["assigned", "scheduled"].includes(status)) return false;
    if (action === "credential.activate_nfc"
        && (!canActivateNfc || !["collected", "paid", "waived", "not_required"].includes(String(row.paymentState ?? "")))) return false;
    return true;
  });
}

function SkeletonRows() {
  return <div className="fc-skeleton" role="status" aria-label="جارٍ تحميل سجلات البطاقات">
    <i/><i/><i/><i/>
  </div>;
}

export function FleetCardsAdmin({ canMutate, canActivateNfc = false, onOpenAction, organizationId, vehicleId }: Props) {
  const [view, setView] = useState<CardsView>("overview");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const params = useMemo<GetAdminFleetCardsParams>(() => ({
    view, page, pageSize,
    ...(organizationId ? { organizationId } : {}),
    ...(vehicleId ? { vehicleId } : {}),
    ...(status ? { status } : {}),
    ...(search ? { search } : {}),
  }), [view, page, pageSize, organizationId, vehicleId, status, search]);
  const query = useGetAdminFleetCards(params, {
    query: { queryKey: getGetAdminFleetCardsQueryKey(params), retry: false, refetchOnMount: "always" },
  });
  const [selectedRequest, setSelectedRequest] = useState<FleetCardRow | null>(null);
  const requestHistoryParams = useMemo<GetAdminFleetCardsParams>(() => ({
    view: "history",
    page: 1,
    pageSize: 50,
    ...(typeof selectedRequest?.organizationId === "string" ? { organizationId: selectedRequest.organizationId } : {}),
    ...(typeof selectedRequest?.vehicleId === "string" ? { vehicleId: selectedRequest.vehicleId } : {}),
  }), [selectedRequest]);
  const requestHistory = useGetAdminFleetCards(requestHistoryParams, {
    query: {
      queryKey: getGetAdminFleetCardsQueryKey(requestHistoryParams),
      enabled: Boolean(selectedRequest),
      retry: false,
      refetchOnMount: "always",
    },
  });
  const reservationParams = useMemo<GetAdminFleetStockReservationsParams>(() => ({
    page: 1, pageSize: 8,
    ...(organizationId ? { organizationId } : {}),
    ...(vehicleId ? { vehicleId } : {}),
    ...(search ? { search } : {}),
  }), [organizationId, vehicleId, search]);
  const reservations = useGetAdminFleetStockReservations(reservationParams, {
    query: {
      queryKey: getGetAdminFleetStockReservationsQueryKey(reservationParams),
      enabled: view === "stock" || view === "requests",
      retry: false,
    },
  });
  const items = Array.isArray(query.data?.items) ? query.data.items.map(record) : [];
  const summary = record(query.data?.summary);
  const total = Number(query.data?.total ?? 0);
  const maxPage = Math.max(1, Math.ceil(total / pageSize));
  const reservationItems = Array.isArray(reservations.data?.items) ? reservations.data.items.map(record) : [];
  const requestHistoryItems = Array.isArray(requestHistory.data?.items) ? requestHistory.data.items.map(record) : [];

  const changeView = (next: CardsView) => {
    setSelectedRequest(null);
    setView(next);
    setPage(1);
    setStatus("");
  };
  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSearch(searchDraft.trim());
    setPage(1);
  };
  const resetFilters = () => {
    setSearch("");
    setSearchDraft("");
    setStatus("");
    setPage(1);
  };
  const retryAll = () => {
    void query.refetch();
    if (view === "stock" || view === "requests") void reservations.refetch();
  };

  return <section className="fleet-cards-page" dir="rtl" aria-label="محتوى إدارة البطاقات">
    {!canMutate && <div className="fc-readonly" role="status">
      <ShieldCheck size={17}/><span><b>وضع القراءة فقط</b> — يمكنك مراجعة السجلات والمخزون دون تنفيذ تغييرات.</span>
    </div>}

    <section className="fc-assurance" aria-label="تنبيه حول دورة إصدار البطاقة">
      <div className="fc-assurance-icon"><AlertCircle size={19}/></div>
      <div>
        <b>الطلب أو الإسناد لا يعني اكتمال الإصدار</b>
        <p>طلب التعريف أو إسناده لا يثبت سداد الرسوم، ولا يعني تركيب الشريحة فعليًا أو كتابة NFC أو تفعيل البطاقة.</p>
      </div>
       <span className="fc-assurance-mark">حالة الطلب</span>
    </section>

    {!!Object.keys(summary).length && <section className="fc-summary" aria-label="ملخص السجلات">
      {Object.entries(summary).filter(([key, value]) => summaryLabels[key] && typeof value === "number").map(([key, value]) =>
        <article key={key}>
          <small>{summaryLabels[key]}</small>
          <bdi>{new Intl.NumberFormat("ar-EG").format(value as number)}</bdi>
        </article>,
      )}
    </section>}

    <nav className="fc-tabs" aria-label="أقسام إدارة البطاقات">
      {viewOptions.map(({ id, title, icon: Icon }, index) => <button
        key={id} type="button" className={view === id ? "is-active" : ""}
        aria-current={view === id ? "page" : undefined} onClick={() => changeView(id)}
      >
        <Icon size={16}/><span>{title}</span><small>{String(index + 1).padStart(2, "0")}</small>
      </button>)}
    </nav>

    {view === "issued" && <nav className="fc-state-tabs" aria-label="تصنيف البطاقات الصادرة">
      {[["", "كل البطاقات"], ["active", "البطاقات الفعالة"], ["inactive", "البطاقات غير الفعالة"]].map(([value, label]) =>
        <button type="button" key={value} data-testid={`fc-issued-${value || "all"}`} aria-pressed={status === value} onClick={() => { setStatus(value); setPage(1); }}>{label}</button>
      )}
    </nav>}
    <section className="fc-workspace">
      <div className="fc-toolbar">
        <div>
          <span className="fc-section-index">إدارة البطاقات</span>
          <h2>{viewOptions.find(option => option.id === view)?.title}</h2>
        </div>
        <div className="fc-primary-actions">
          {canMutate && view === "requests" && <button type="button" onClick={() => onOpenAction("credential.request", {})}><Plus size={15}/> طلب تعريف لمركبة</button>}
          {canMutate && view === "stock" && <button type="button" onClick={() => onOpenAction("tag_stock.receive", {})}><Plus size={15}/> تسجيل استلام شرائح</button>}
        </div>
        {view !== "overview" && <form className="fc-search" onSubmit={submitSearch}>
          <Search size={16}/>
          <input value={searchDraft} onChange={event => setSearchDraft(event.target.value)} aria-label="بحث في السجلات" placeholder="ابحث باللوحة أو الشركة"/>
          <button type="submit">بحث</button>
        </form>}
      </div>

      {view !== "overview" && <div className="fc-filters">
        <label>الحالة
          <select value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}>
            <option value="">كل الحالات</option>
            {Object.entries(statusLabels).filter(([key]) => !["paid", "unpaid", "pending_payment", "waived", "not_required", "collected"].includes(key)).map(([key, label]) =>
              <option value={key} key={key}>{label}</option>,
            )}
          </select>
        </label>
        {(search || status) && <button type="button" className="fc-clear" onClick={resetFilters}>مسح عوامل التصفية</button>}
        <span className="fc-result-count">{query.isSuccess ? `${new Intl.NumberFormat("ar-EG").format(total)} سجل` : "بيانات مباشرة من النظام"}</span>
      </div>}

      {query.isLoading ? <SkeletonRows/> : query.isError ? <section className="fc-state is-error" role="alert">
        <span><AlertCircle size={20}/></span><b>تعذر تحميل سجلات البطاقات</b>
        <p>لم نتمكن من جلب بيانات هذا العرض. أعد المحاولة؛ لم يتم تنفيذ أي إجراء.</p>
        <button type="button" onClick={retryAll}><RefreshCw size={15}/> إعادة المحاولة</button>
      </section> : view === "overview" ? <section className="fc-overview-note" role="status">
        <b>ملخص سجلات التعريف</b><p>تعرض المؤشرات أعلاه الطلبات المفتوحة والتحصيل ومخزون الشرائح من السجلات الحالية.</p>
      </section> : items.length === 0 ? <section className="fc-state" role="status">
        <span><Boxes size={21}/></span><b>لا توجد سجلات مطابقة</b>
        <p>{search || status ? "جرّب تغيير البحث أو الحالة المحددة." : "ستظهر هنا السجلات عند ورودها من النظام."}</p>
        {(search || status) && <button type="button" onClick={resetFilters}>عرض كل السجلات</button>}
      </section> : <div className="fc-table-wrap">
        <table>
          <thead><tr>
            <th>المركبة / المرجع</th><th>الشركة والفرع</th><th>النوع</th>
            <th>الحالة</th><th>رسوم الإصدار</th><th>التحصيل</th>
            <th>آخر تحديث</th><th>الإجراءات</th>
          </tr></thead>
          <tbody>{items.map((row, index) => {
            const actions = allowedActions(row, canMutate, canActivateNfc, view);
            const rowKey = `${String(row.unitCode ?? row.plate ?? row.requestType ?? "record")}-${index}`;
            const identifier = safeText(row.plate ?? row.unitCode ?? row.requestType);
            const requestType = credentialTypeLabel(row.type ?? row.unitType);
            const payment = row.paymentState;
            const displaysFee = view === "requests" && row.issuePriceMinor !== undefined;
            return <tr key={rowKey}>
              <td><b>{identifier}</b><small>{requestTypeLabel(row.requestType) || safeText(row.reason)}</small>{view === "requests" && <small className="fc-request-reference">{requestReference(row)}</small>}</td>
              <td><b>{safeText(row.organizationName)}</b><small>{safeText(row.branchName)}</small></td>
              <td><span className="fc-type">{String(row.type ?? row.unitType) === "nfc" ? <Smartphone size={15}/> : <CreditCard size={15}/>} {requestType}</span></td>
              <td><span className={`fc-status status-${String(row.status ?? "unknown")}`}>{statusText(row.status)}</span></td>
              <td>{displaysFee ? <><bdi className="fc-price">{egp(row.issuePriceMinor)}</bdi><small>رسوم الإصدار</small></> : "—"}</td>
              <td>{payment ? <span className={`fc-payment payment-${String(payment)}`}>{statusText(payment)}</span> : "—"}</td>
              <td>{dateText(row.updatedAt ?? row.activatedAt ?? row.createdAt)}</td>
              <td>
                <div className="fc-actions">
                  {view === "requests" && <button type="button" className="fc-details-button" onClick={() => setSelectedRequest(row)}>تفاصيل الطلب</button>}
                  {actions.map(action =>
                    <button type="button" key={action} onClick={() => onOpenAction(action, row)}>{actionLabels[action]}</button>,
                  )}
                  {!actions.length && view !== "requests" && <span className="fc-no-action">—</span>}
                </div>
              </td>
            </tr>;
          })}</tbody>
        </table>
        <footer className="fc-pagination">
          <span>الصفحة {new Intl.NumberFormat("ar-EG").format(page)} من {new Intl.NumberFormat("ar-EG").format(maxPage)}</span>
          <div>
            <button type="button" onClick={() => setPage(current => Math.max(1, current - 1))} disabled={page <= 1}><ArrowRight size={14}/> السابق</button>
            <button type="button" onClick={() => setPage(current => Math.min(maxPage, current + 1))} disabled={page >= maxPage}>التالي <ArrowLeft size={14}/></button>
          </div>
        </footer>
      </div>}

      {(view === "requests" || view === "stock") && <section className="fc-reservations">
        <header><div><span className="fc-section-index">FOLLOW-UP / STOCK</span><h3><PackageCheck size={17}/> حجوزات الشرائح القابلة للاستكمال</h3></div><span>حسب بيانات الحجز الحالية</span></header>
        {reservations.isLoading ? <div className="fc-reservation-loading"><i/><i/></div>
          : reservations.isError ? <div className="fc-reservation-error" role="alert">تعذر تحميل الحجوزات. <button type="button" onClick={() => void reservations.refetch()}>إعادة المحاولة</button></div>
            : reservationItems.length ? <div className="fc-reservation-list">{reservationItems.map((reservation, index) => {
              const requestStatus = String(reservation.requestStatus ?? "");
              const canResume = canMutate && ["assigned", "scheduled"].includes(requestStatus) && reservation.canMutate !== false;
              return <article key={`${String(reservation.unitCode ?? "unit")}-${index}`}>
                <span className="fc-reservation-icon"><PackageCheck size={17}/></span>
                <div className="fc-reservation-info"><b>{safeText(reservation.vehiclePlate ?? reservation.unitCode)}</b><small>{safeText(reservation.organizationName)} · {safeText(reservation.branchName)}</small></div>
                <span className={`fc-status status-${requestStatus}`}>{statusText(requestStatus)}</span>
                 {canResume && <button type="button" onClick={() => onOpenAction("credential.install", reservation)}>استكمال التركيب</button>}
              </article>;
            })}</div>
              : <div className="fc-reservations-empty">لا توجد حجوزات قابلة للاستكمال في النطاق الحالي.</div>}
      </section>}
    </section>

    <footer className="fc-legend">
      <CircleDollarSign size={16}/>
      <p><b>الرسوم والتحصيل حقلاّن مستقلان.</b> تُعرض رسوم الإصدار بالجنيه المصري بعد تحويل القروش إلى جنيهات؛ حالة التحصيل لا تُستنتج من حالة الطلب.</p>
       <span>عمليات الأسطول</span>
    </footer>
    {selectedRequest && <div className="fc-detail-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setSelectedRequest(null); }}>
      <section className="fc-request-detail" role="dialog" aria-modal="true" aria-labelledby="fc-request-detail-title">
        <header><div><small>مرجع ثابت للطلب</small><h2 id="fc-request-detail-title">{requestReference(selectedRequest)}</h2></div><button type="button" className="fc-detail-close" onClick={() => setSelectedRequest(null)}>إغلاق</button></header>
        <dl className="fc-request-facts">
          <div><dt>المركبة</dt><dd>{safeText(selectedRequest.plate)}</dd></div>
          <div><dt>الشركة والفرع</dt><dd>{safeText(selectedRequest.organizationName)} · {safeText(selectedRequest.branchName)}</dd></div>
          <div><dt>نوع التعريف</dt><dd>{credentialTypeLabel(selectedRequest.type)} · {requestTypeLabel(selectedRequest.requestType) || "طلب إصدار"}</dd></div>
          <div><dt>الحالة</dt><dd>{statusText(selectedRequest.status)} · {statusText(selectedRequest.paymentState)}</dd></div>
          <div><dt>رسوم الإصدار</dt><dd>{egp(selectedRequest.issuePriceMinor)}</dd></div>
          <div><dt>طريقة الاستلام</dt><dd>{selectedRequest.fulfillmentMethod === "install" ? "تركيب بالموقع" : selectedRequest.fulfillmentMethod === "pickup" ? "استلام من الفرع" : "غير محددة"}</dd></div>
          <div className="fc-request-fact-wide"><dt>المكان</dt><dd>{safeText(selectedRequest.fulfillmentMethod === "install" ? selectedRequest.installationAddress : selectedRequest.pickupLocation)}</dd></div>
          <div><dt>جهة التواصل</dt><dd>{safeText(selectedRequest.fulfillmentContactName)}</dd></div>
          <div><dt>هاتف التواصل</dt><dd><bdi dir="ltr">{safeText(selectedRequest.fulfillmentContactPhone)}</bdi></dd></div>
          <div><dt>موعد التنفيذ</dt><dd>{dateText(selectedRequest.scheduledAt)}</dd></div>
          <div><dt>تاريخ الطلب</dt><dd>{dateText(selectedRequest.createdAt)}</dd></div>
          <div className="fc-request-fact-wide"><dt>السبب المسجل</dt><dd>{safeText(selectedRequest.reason)}</dd></div>
        </dl>
        <div className="fc-request-links">
          {typeof selectedRequest.vehicleId === "string" && <Link href={`/admin/fleet/vehicles/${encodeURIComponent(selectedRequest.vehicleId)}`}>فتح ملف المركبة</Link>}
          {typeof selectedRequest.organizationId === "string" && <Link href={`/admin/organizations/${encodeURIComponent(selectedRequest.organizationId)}`}>فتح ملف الشركة</Link>}
        </div>
        <section className="fc-request-history">
          <div><h3>سجل حركة التعريف على المركبة</h3><small>يُعرض من سجل التدقيق المتاح للمركبة، ولا يُنشئ سجلًا بديلًا للطلب.</small></div>
          {requestHistory.isLoading ? <div className="fc-detail-loading" role="status">جارٍ تحميل سجل الحركة…</div>
            : requestHistory.isError ? <div className="fc-detail-error" role="alert">تعذر تحميل سجل الحركة. <button type="button" onClick={() => void requestHistory.refetch()}>إعادة المحاولة</button></div>
              : requestHistoryItems.length ? <ol>{requestHistoryItems.map((item, index) => <li key={`${String(item.id ?? "event")}-${index}`}><b>{activityLabel(item.action)}</b><span>{dateText(item.createdAt)}</span>{typeof item.reason === "string" && item.reason.length > 0 && <small>{safeText(item.reason)}</small>}</li>)}</ol>
                : <p className="fc-detail-empty">لا توجد أحداث مسجلة بعد لهذا النطاق.</p>}
        </section>
      </section>
    </div>}
  </section>;
}
