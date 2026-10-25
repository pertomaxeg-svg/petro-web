import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { ClipboardList, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { customFetch } from "@workspace/api-client-react";

type AuditItem = {
  id: string;
  actorId: string;
  organizationId: string | null;
  action: string;
  targetId: string | null;
  occurredAt: string;
  detail: Record<string, string | number | boolean>;
};
type AuditPage = { items: AuditItem[]; total: number; page: number; pageSize: number };

const actionLabels: Record<string, string> = {
  "organization.created": "إنشاء جهة",
  "organization.approved": "اعتماد جهة",
  "organization.operational_status_changed": "تغيير حالة تشغيل الجهة",
  "branch.created": "إنشاء فرع",
  "organization.document.approve": "اعتماد مستند جهة",
  "catalog.fuel_type.updated": "تحديث نوع وقود",
  "plan.version_draft_updated": "تعديل مسودة باقة",
  "fleet.vehicle_create": "إضافة مركبة",
  "fleet.driver_create": "إضافة سائق",
  "fleet.driver_link_create": "ربط سائق بمركبة",
  "fleet.odometer_record": "تسجيل قراءة عداد",
  "fleet.vehicle_document.upload_started": "بدء رفع مستند مركبة",
  "fleet.driver_pin_reveal_unavailable": "تعذر عرض رمز السائق",
};
const detailLabels: Record<string, string> = {
  before: "قبل",
  after: "بعد",
  approval_before: "الاعتماد السابق",
  approval_after: "الاعتماد الحالي",
  operational_status: "حالة التشغيل",
  approval_status: "حالة الاعتماد",
  kind: "نوع الجهة",
  code: "الكود",
  document_type: "نوع المستند",
  version: "الإصدار",
  status: "الحالة",
};
const valueLabels: Record<string, string> = {
  approved: "معتمد",
  pending: "بانتظار المراجعة",
  active: "نشط",
  suspended: "موقوف",
  company: "شركة",
  station: "محطة",
  provider: "مقدم خدمة",
};

function shortId(value: string | null): string {
  return value ? value.slice(0, 8) + "…" + value.slice(-4) : "—";
}
function dateTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? "—" : parsed.toLocaleString("ar-EG", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Africa/Cairo",
  });
}
function errorText(error: unknown): string {
  if (error && typeof error === "object") {
    const value = error as { status?: unknown; message?: unknown; data?: unknown };
    if (value.data && typeof value.data === "object" && "message" in value.data && typeof value.data.message === "string") return value.data.message;
    if (value.status === 401) return "انتهت جلسة الدخول. سجّل الدخول مرة أخرى.";
    if (value.status === 403) return "لا تملك صلاحية قراءة سجل التدقيق المركزي.";
    if (typeof value.message === "string") return value.message;
  }
  return "تعذر تحميل السجل. أعد المحاولة.";
}

export default function AdminAuditLog() {
  const [actionDraft, setActionDraft] = useState("");
  const [action, setAction] = useState("");
  const [fromDraft, setFromDraft] = useState("");
  const [from, setFrom] = useState("");
  const [toDraft, setToDraft] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const query = useQuery({
    queryKey: ["admin-audit-events", page, pageSize, action, from, to],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (action) params.set("action", action);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      return customFetch<AuditPage>("/api/admin/audit-events?" + params.toString());
    },
    retry: false,
    staleTime: 15_000,
  });
  const totalPages = Math.max(1, Math.ceil((query.data?.total ?? 0) / pageSize));

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setAction(actionDraft.trim().toLowerCase());
    setFrom(fromDraft);
    setTo(toDraft);
  }

  return <main className="ac-page audit-page" dir="rtl">
    <div className="ac-heading-row">
      <div>
        <span className="ac-eyebrow">الحوكمة والامتثال <i/></span>
        <h1>سجل التدقيق المركزي</h1>
        <p>سجل قراءة فقط للقرارات والتغييرات المسجلة في المنصة.</p>
      </div>
      <button className="ac-button ac-button-quiet" type="button" onClick={() => void query.refetch()} disabled={query.isFetching}>
        <RefreshCw size={15}/> تحديث السجل
      </button>
    </div>

    <section className="audit-summary" aria-label="ملخص سجل التدقيق">
      <span className="audit-summary-icon"><ShieldCheck size={20}/></span>
      <div><small>إجمالي السجلات المطابقة</small><b>{(query.data?.total ?? 0).toLocaleString("ar-EG")}</b></div>
      <span className="audit-summary-note">التفاصيل الحساسة محجوبة من العرض.</span>
    </section>

    <section className="ac-panel audit-panel">
      <form className="audit-filters" onSubmit={applyFilters}>
        <label><span>رمز العملية</span><div><Search size={16}/><input value={actionDraft} onChange={(event) => setActionDraft(event.target.value)} maxLength={100} placeholder="مثال: organization.approved" aria-label="تصفية برمز العملية"/></div></label>
        <label><span>من تاريخ</span><input type="date" value={fromDraft} onChange={(event) => setFromDraft(event.target.value)} aria-label="من تاريخ"/></label>
        <label><span>إلى تاريخ</span><input type="date" value={toDraft} onChange={(event) => setToDraft(event.target.value)} aria-label="إلى تاريخ"/></label>
        <button className="ac-button" type="submit">تطبيق المرشحات</button>
      </form>

      {query.isLoading ? <div className="audit-state" aria-live="polite"><span className="aso-skeleton"/><span className="aso-skeleton"/><span className="aso-skeleton"/></div>
        : query.isError ? <div className="audit-state audit-error" role="alert"><h2>تعذر تحميل السجل</h2><p>{errorText(query.error)}</p><button type="button" className="ac-button ac-button-quiet" onClick={() => void query.refetch()}><RefreshCw size={15}/> إعادة المحاولة</button></div>
        : query.data?.items.length === 0 ? <div className="audit-state"><ClipboardList size={25}/><h2>لا توجد سجلات مطابقة</h2><p>جرّب فترة أوسع أو امسح رمز العملية.</p></div>
        : <div className="audit-list" aria-label="سجلات التدقيق">
          {query.data?.items.map((item) => <article className="audit-entry" key={item.id}>
            <div className="audit-entry-head">
              <div><span className="audit-action">{actionLabels[item.action] ?? item.action}</span><small>{dateTime(item.occurredAt)}</small></div>
              <span className="audit-event-id" title={"معرف السجل " + item.id}>سجل #{item.id}</span>
            </div>
            <div className="audit-identifiers">
              <span>المنفذ <b dir="ltr" title={item.actorId}>{shortId(item.actorId)}</b></span>
              {item.organizationId && <span>الجهة <b dir="ltr" title={item.organizationId}>{shortId(item.organizationId)}</b></span>}
              {item.targetId && <span>السجل المرتبط <b dir="ltr" title={item.targetId}>{shortId(item.targetId)}</b></span>}
            </div>
            {Object.keys(item.detail).length > 0 && <div className="audit-detail">
              {Object.entries(item.detail).map(([key, value]) => <span key={key}><small>{detailLabels[key] ?? key}</small><b>{valueLabels[String(value)] ?? String(value)}</b></span>)}
            </div>}
          </article>)}
        </div>}

      {!query.isError && (query.data?.total ?? 0) > 0 && <div className="audit-pagination">
        <span>صفحة {page.toLocaleString("ar-EG")} من {totalPages.toLocaleString("ar-EG")}</span>
        <div><button type="button" className="ac-button ac-button-quiet" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1 || query.isFetching}>السابق</button><button type="button" className="ac-button ac-button-quiet" onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={page >= totalPages || query.isFetching}>التالي</button></div>
      </div>}
    </section>
  </main>;
}
