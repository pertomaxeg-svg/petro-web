import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowLeft, CircleAlert, ClipboardList, RefreshCw, Search } from "lucide-react";
import { customFetch } from "@workspace/api-client-react";

type JsonRecord = Record<string, unknown>;
type ServiceOrder = {
  id: string;
  status: "reserved" | "in_progress" | "delivered" | "review_required" | "cancelled";
  paymentStatus?: string;
  version: number;
  serviceGroup?: string;
  kind?: string;
  quantity?: string;
  amountMinor?: string;
  itemSnapshot?: JsonRecord;
  vehicleSnapshot?: JsonRecord;
  merchantSnapshot?: JsonRecord;
  createdAt?: string;
  expiresAt?: string | null;
  startedAt?: string | null;
  cancelledAt?: string | null;
  requiresReview?: boolean;
};
type ServiceOrderPage = {
  items: ServiceOrder[];
  total: number;
  page: number;
  pageSize: number;
  canManage: boolean;
};
type ServiceOrderEvent = {
  id: string;
  kind: string;
  version: number;
  createdAt: string;
  actorName?: string;
};
type ServiceOrderDetail = ServiceOrder & {
  timeline?: ServiceOrderEvent[];
};

const statusLabel: Record<ServiceOrder["status"], string> = {
  reserved: "محجوز",
  in_progress: "قيد التنفيذ",
  delivered: "مكتمل",
  review_required: "يتطلب مراجعة",
  cancelled: "ملغى",
};
const statusOptions: Array<[string, string]> = [
  ["", "كل الحالات"],
  ["reserved", "محجوز"],
  ["in_progress", "قيد التنفيذ"],
  ["delivered", "مكتمل"],
  ["review_required", "يتطلب مراجعة"],
  ["cancelled", "ملغى"],
];

function recordValue(record: JsonRecord | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function currency(minor: string | undefined): string {
  if (!minor || !/^\d+$/.test(minor)) return "—";
  const value = BigInt(minor);
  const pounds = (value / 100n).toLocaleString("ar-EG");
  const piasters = String(value % 100n).padStart(2, "0");
  return `${pounds}.${piasters} ج.م`;
}

function dateTime(value: string | undefined | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? "—"
    : parsed.toLocaleString("ar-EG", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo" });
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const value = error as { status?: unknown; message?: unknown; data?: unknown };
    if (value.data && typeof value.data === "object" && "message" in value.data && typeof value.data.message === "string") {
      return value.data.message;
    }
    if (value.status === 401) return "يلزم تسجيل الدخول من جديد.";
    if (value.status === 403) return "لا تملك صلاحية عرض طلبات الخدمات المركزية.";
    if (typeof value.message === "string") return value.message;
  }
  return "تعذر تحميل السجل. أعد المحاولة.";
}

function orderTitle(order: ServiceOrder): string {
  const itemName = recordValue(order.itemSnapshot, "name");
  if (itemName) return itemName;
  const serviceLabels: Record<string, string> = {
    fuel: "وقود",
    wash: "غسيل",
    oil: "زيوت",
    parts: "قطع غيار",
    installation: "تركيب",
  };
  return serviceLabels[order.serviceGroup ?? ""] || "خدمة";
}

function eventTitle(kind: string): string {
  const labels: Record<string, string> = {
    reserved: "حجز الطلب",
    started: "بدء التنفيذ",
    delivered: "تسجيل التسليم",
    cancelled: "إلغاء الطلب",
    expired: "انتهاء مهلة الحجز",
    review_required: "إحالة للمراجعة",
    evidence_created: "رفع مستند",
    evidence_accepted: "اعتماد مستند",
    evidence_rejected: "رفض مستند",
  };
  return labels[kind] || "تحديث مسجل";
}

export default function AdminServiceOrders() {
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState("");
  const pageSize = 20;
  const query = useQuery({
    queryKey: ["admin-service-orders", page, pageSize, status, search],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (status) params.set("status", status);
      if (search) params.set("search", search);
      return customFetch<ServiceOrderPage>(`/api/admin/service-orders?${params.toString()}`);
    },
    retry: false,
    staleTime: 15_000,
  });
  const detail = useQuery({
    queryKey: ["admin-service-order", selectedId],
    queryFn: () => customFetch<ServiceOrderDetail>(`/api/admin/service-orders/${encodeURIComponent(selectedId)}`),
    enabled: Boolean(selectedId),
    retry: false,
    staleTime: 15_000,
  });

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setSearch(searchDraft.trim());
  }

  function changeStatus(value: string) {
    setStatus(value);
    setPage(1);
  }

  const totalPages = Math.max(1, Math.ceil((query.data?.total ?? 0) / pageSize));
  const selectedOrder = detail.data;

  return <main className="ac-page aso-page" dir="rtl">
    <div className="ac-heading-row">
      <div>
        <span className="ac-eyebrow">التشغيل المركزي <i/></span>
        <h1>طلبات الخدمات</h1>
        <p>متابعة الطلبات وحالات التنفيذ من السجل المعتمد.</p>
      </div>
      <button className="ac-button ac-button-quiet" type="button" onClick={() => void query.refetch()} disabled={query.isFetching}>
        <RefreshCw size={15}/> تحديث السجل
      </button>
    </div>

    <section className="aso-summary" aria-label="ملخص طلبات الخدمات">
      <span className="aso-summary-icon"><ClipboardList size={20}/></span>
      <div><small>النتائج المطابقة للمرشحات</small><b>{query.isLoading ? "…" : query.data ? query.data.total.toLocaleString("ar-EG") : "—"}</b></div>
      <span className="aso-summary-note">مصدر البيانات: سجل طلبات الخدمة</span>
    </section>

    <section className="aso-panel">
      <form className="aso-filters" onSubmit={submitSearch}>
        <label className="aso-search"><span>بحث</span><div><Search size={16}/><input value={searchDraft} onChange={event => setSearchDraft(event.target.value)} maxLength={160} placeholder="الخدمة أو لوحة المركبة أو الفرع" aria-label="بحث في طلبات الخدمات"/></div></label>
        <label className="aso-status-filter"><span>الحالة</span><select value={status} onChange={event => changeStatus(event.target.value)} aria-label="تصفية حسب حالة الطلب">
          {statusOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <button className="ac-button" type="submit"><Search size={15}/> تطبيق البحث</button>
      </form>

      {query.isLoading ? <div className="aso-state" aria-live="polite"><span className="aso-skeleton"/><span className="aso-skeleton"/><span className="aso-skeleton"/></div>
        : query.isError ? <div className="aso-state aso-error" role="alert"><CircleAlert size={21}/><h2>تعذر تحميل الطلبات</h2><p>{errorMessage(query.error)}</p><button type="button" className="ac-button ac-button-quiet" onClick={() => void query.refetch()}><RefreshCw size={15}/> إعادة المحاولة</button></div>
        : query.data?.items.length === 0 ? <div className="aso-state aso-empty"><ClipboardList size={25}/><h2>لا توجد طلبات مطابقة</h2><p>غيّر الحالة أو عبارة البحث لعرض سجلات أخرى.</p></div>
        : <div className="aso-order-list" aria-label="طلبات الخدمات">
          {(query.data?.items ?? []).map(order => {
            const selected = selectedId === order.id;
            const merchant = recordValue(order.merchantSnapshot, "branchName") || recordValue(order.merchantSnapshot, "organizationName");
            const vehicle = recordValue(order.vehicleSnapshot, "plate");
            return <button type="button" key={order.id} className={`aso-order-card ${selected ? "selected" : ""}`} onClick={() => setSelectedId(selected ? "" : order.id)} aria-expanded={selected}>
              <span className={`aso-status aso-status-${order.status}`}>{statusLabel[order.status] ?? order.status}</span>
              <span className="aso-order-main"><b>{orderTitle(order)}</b><small>{merchant || "فرع غير متاح"}{vehicle ? ` · ${vehicle}` : ""}</small></span>
              <span className="aso-order-amount"><b>{currency(order.amountMinor)}</b><small>{dateTime(order.createdAt)}</small></span>
              <ArrowLeft size={16} aria-hidden="true"/>
            </button>;
          })}
        </div>}

      {!query.isError && (query.data?.total ?? 0) > 0 && <div className="aso-pagination">
        <span>صفحة {page.toLocaleString("ar-EG")} من {totalPages.toLocaleString("ar-EG")}</span>
        <div><button type="button" className="ac-button ac-button-quiet" onClick={() => setPage(value => Math.max(1, value - 1))} disabled={page <= 1 || query.isFetching}>السابق</button><button type="button" className="ac-button ac-button-quiet" onClick={() => setPage(value => Math.min(totalPages, value + 1))} disabled={page >= totalPages || query.isFetching}>التالي <ArrowLeft size={14}/></button></div>
      </div>}
    </section>

    {selectedId && <section className="aso-detail" aria-live="polite">
      {detail.isLoading ? <div className="aso-detail-loading"><span className="aso-skeleton"/><span className="aso-skeleton"/></div>
        : detail.isError ? <div className="aso-state aso-error" role="alert"><CircleAlert size={20}/><h2>تعذر تحميل تفاصيل الطلب</h2><p>{errorMessage(detail.error)}</p><button type="button" className="ac-button ac-button-quiet" onClick={() => void detail.refetch()}><RefreshCw size={15}/> إعادة المحاولة</button></div>
        : selectedOrder && <>
          <div className="aso-detail-heading"><div><span className="ac-eyebrow">سجل الطلب <i/></span><h2>{orderTitle(selectedOrder)}</h2></div><button type="button" className="ac-button ac-button-quiet" onClick={() => setSelectedId("")}>إغلاق</button></div>
          <div className="aso-facts">
            <div><small>الحالة</small><b>{statusLabel[selectedOrder.status] ?? selectedOrder.status}</b></div>
            <div><small>قيمة الطلب</small><b>{currency(selectedOrder.amountMinor)}</b></div>
            <div><small>الكمية</small><b>{selectedOrder.quantity || "—"}</b></div>
            <div><small>الفرع</small><b>{recordValue(selectedOrder.merchantSnapshot, "branchName") || "—"}</b></div>
            <div><small>المركبة</small><b>{recordValue(selectedOrder.vehicleSnapshot, "plate") || "—"}</b></div>
            <div><small>تاريخ الإنشاء</small><b>{dateTime(selectedOrder.createdAt)}</b></div>
          </div>
          <div className="aso-timeline-heading"><Activity size={17}/><h3>التسلسل الزمني</h3></div>
          {detail.data?.timeline?.length ? <ol className="aso-timeline">{detail.data.timeline.map(event => <li key={event.id}><span className="aso-timeline-dot"/><div><b>{eventTitle(event.kind)}</b><small>{event.actorName || "مستخدم مخول"} · {dateTime(event.createdAt)}</small></div><span>نسخة {event.version.toLocaleString("ar-EG")}</span></li>)}</ol>
            : <p className="aso-no-timeline">لا توجد أحداث إضافية في السجل.</p>}
        </>}
    </section>}
  </main>;
}
