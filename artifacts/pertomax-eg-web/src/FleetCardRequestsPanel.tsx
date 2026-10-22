import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  getGetAdminFleetCardsQueryKey,
  useGetAdminFleetCards,
  type GetAdminFleetCardsParams,
} from "@workspace/api-client-react";
import { formatFleetField } from "./fleetDisplay";

type RequestRow = Record<string, unknown>;

const text = (value: unknown, fallback = "—") =>
  typeof value === "string" || typeof value === "number" ? String(value) : fallback;

const stateLabels: Record<string, string> = {
  requested: "مطلوب",
  pending: "قيد المراجعة",
  pending_review: "بانتظار المراجعة",
  approved: "معتمد",
  assigned: "مخصص",
  scheduled: "مجدول",
  installed: "تم التركيب",
  active: "نشط",
  rejected: "مرفوض",
  cancelled: "ملغي",
  paid: "تم التحصيل",
  collected: "تم التحصيل",
  unpaid: "بانتظار التحصيل",
  pending_payment: "بانتظار التحصيل",
  awaiting_collection: "بانتظار التحصيل",
  waived: "معفى",
  not_required: "غير مطلوب",
};

const stateText = (value: unknown) =>
  stateLabels[String(value ?? "")] ?? "غير متاح";

const requestReference = (row: RequestRow) => {
  const id = typeof row.id === "string" ? row.id.replaceAll("-", "") : "";
  return id ? `طلب-${id.slice(-8).toUpperCase()}` : "مرجع الطلب غير متاح";
};

const requestTypeText = (value: unknown) =>
  ({ issue: "إصدار", replace: "استبدال", stop: "إيقاف" } as Record<string, string>)[String(value ?? "")]
  ?? "طلب تعريف";

const credentialTypeText = (value: unknown) =>
  value === "nfc" ? "شريحة NFC" : value === "qr" ? "رمز QR" : "نوع غير محدد";

const fulfillmentText = (row: RequestRow) => {
  if (row.fulfillmentMethod === "install") {
    return { method: "تركيب بالموقع", location: text(row.installationAddress, "العنوان غير مسجل") };
  }
  if (row.fulfillmentMethod === "pickup") {
    return { method: "استلام من الفرع", location: text(row.pickupLocation, "مكان الاستلام غير مسجل") };
  }
  return { method: "طريقة التنفيذ غير محددة", location: "—" };
};

const dateText = (value: unknown) => {
  if (typeof value !== "string" || !value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("ar-EG", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Africa/Cairo",
      }).format(date);
};

export function FleetCardRequestsPanel({
  organizationId,
  vehicleId,
}: {
  organizationId?: string;
  vehicleId?: string;
}) {
  const [page, setPage] = useState(1);
  const pageSize = 8;
  const params = useMemo<GetAdminFleetCardsParams>(() => ({
    view: "requests",
    page,
    pageSize,
    ...(organizationId ? { organizationId } : {}),
    ...(vehicleId ? { vehicleId } : {}),
  }), [organizationId, vehicleId, page]);
  const query = useGetAdminFleetCards(params, {
    query: {
      queryKey: getGetAdminFleetCardsQueryKey(params),
      retry: false,
      refetchOnMount: "always",
    },
  });
  const rows = Array.isArray(query.data?.items) ? query.data.items as RequestRow[] : [];
  const totalPages = Math.max(1, Math.ceil((query.data?.total ?? 0) / pageSize));
  const scope = vehicleId ? "vehicle" : "company";

  return <section className="co-profile-panel fleet-card-requests" data-testid={`fleet-card-requests-${scope}`}>
    <div className="co-profile-section-title">
      <div>
        <span className="co-eyebrow">طلبات مرتبطة بالسجل نفسه</span>
        <h2>طلبات التعريف</h2>
        <p>يعرض هذا القسم الطلبات نفسها المحفوظة في مركز البطاقات، دون إنشاء نسخة أخرى.</p>
      </div>
      <Link href="/admin/cards" className="co-small-button">فتح مركز البطاقات</Link>
    </div>

    {query.isLoading ? <p className="fleet-card-requests-state" role="status">جارٍ تحميل طلبات التعريف…</p>
      : query.isError ? <div className="fleet-card-requests-state is-error" role="alert">
        <span>تعذر تحميل طلبات التعريف.</span>
        <button type="button" className="co-small-button" onClick={() => void query.refetch()}>إعادة المحاولة</button>
      </div>
        : rows.length === 0 ? <p className="fleet-card-requests-state" role="status">لا توجد طلبات تعريف مرتبطة بهذا السجل بعد.</p>
          : <>
            <div className="co-data-table-wrap">
              <table className="co-profile-table fleet-card-requests-table">
                <thead><tr>
                  <th>الطلب</th><th>المركبة والفرع</th><th>التسليم</th><th>الحالة والتحصيل</th><th>رسوم الإصدار والتاريخ</th><th>الملفات المرتبطة</th>
                </tr></thead>
                <tbody>{rows.map((row, index) => {
                  const id = text(row.id, "");
                  const fulfillment = fulfillmentText(row);
                  return <tr key={id || `${page}-${index}`} data-testid="fleet-card-request-row" data-request-id={id}>
                    <td><strong data-testid="fleet-card-request-reference">{requestReference(row)}</strong><small>{credentialTypeText(row.type)} · {requestTypeText(row.requestType)}</small></td>
                    <td><strong>{text(row.plate, "المركبة غير متاحة")}</strong><small>{text(row.branchName, "الفرع غير متاح")}</small></td>
                    <td><strong>{fulfillment.method}</strong><small>{fulfillment.location}</small></td>
                    <td><strong>{stateText(row.status)}</strong><small>التحصيل: {stateText(row.paymentState)}</small></td>
                    <td><strong>{formatFleetField("issuePriceMinor", row.issuePriceMinor)}</strong><small>{dateText(row.createdAt)}</small></td>
                    <td className="fleet-card-request-links">
                      {typeof row.vehicleId === "string" && <Link href={`/admin/fleet/vehicles/${encodeURIComponent(row.vehicleId)}`}>المركبة</Link>}
                      {typeof row.organizationId === "string" && <Link href={`/admin/organizations/${encodeURIComponent(row.organizationId)}`}>الشركة</Link>}
                    </td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
            {totalPages > 1 && <nav className="fleet-card-requests-pager" aria-label="صفحات طلبات التعريف">
              <button type="button" className="co-small-button" disabled={page <= 1} onClick={() => setPage(current => Math.max(1, current - 1))}>السابق</button>
              <span>صفحة {new Intl.NumberFormat("ar-EG").format(page)} من {new Intl.NumberFormat("ar-EG").format(totalPages)}</span>
              <button type="button" className="co-small-button" disabled={page >= totalPages} onClick={() => setPage(current => Math.min(totalPages, current + 1))}>التالي</button>
            </nav>}
          </>}
  </section>;
}
