import { useState } from "react";
import { Link } from "wouter";
import {
  getGetAdminFleetCatalogQueryKey,
  getGetAdminFleetCompanySummariesQueryKey,
  getGetAdminOrganizationBillingQueryKey,
  getGetAdminOrganizationFinanceAccountsQueryKey,
  getListAdminFinanceJournalQueryKey,
  getListAdminFinanceTransfersQueryKey,
  getListAdminOrganizationMembershipsQueryKey,
  useGetAdminFleetCatalog,
  useGetAdminFleetCompanySummaries,
  useGetAdminOrganizationBilling,
  useGetAdminOrganizationFinanceAccounts,
  useListAdminFinanceJournal,
  useListAdminFinanceTransfers,
  useListAdminOrganizationMemberships,
} from "@workspace/api-client-react";
import { FleetCardRequestsPanel } from "./FleetCardRequestsPanel";

type Row = Record<string, unknown>;
type OrgKind = "company" | "station" | "provider";

const asRow = (value: unknown): Row =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Row
    : {};
const asRows = (value: unknown): Row[] => Array.isArray(value) ? value.map(asRow) : [];
const text = (value: unknown, fallback = "—"): string =>
  typeof value === "string" && value.trim() ? value.trim() : fallback;
const num = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};
const record = (data: unknown): Row => asRow(data);
const dataRows = (data: unknown): Row[] => asRows(record(data)["items"]);
const totalOf = (data: unknown): number | null => num(record(data)["total"]);
const stateLabel: Record<string, string> = {
  active: "نشط",
  suspended: "موقوف",
  pending: "قيد المراجعة",
  approved: "معتمد",
  inactive: "غير نشط",
  expired: "منتهٍ",
  unpaid: "بانتظار السداد",
  pending_payment: "بانتظار السداد",
  collected_on_hold: "محصّل بانتظار الاعتماد",
  partially_collected: "محصّل جزئيًا",
  needs_changes: "تحتاج تعديلًا",
  rejected: "مرفوض",
  draft: "مسودة",
  published: "منشور",
  scheduled: "مجدول",
  cancelled: "ملغى",
  organization_owner: "مالك الجهة",
  manager: "مدير",
  finance: "مسؤول مالي",
  worker: "عامل",
  viewer: "مشاهد",
  organization: "كل الجهة",
  branches: "فروع محددة",
  vehicle: "مركبة",
  company_funding: "الحساب الرئيسي",
  branch_funding: "حساب فرع",
  new: "اشتراك جديد",
  renewal: "تجديد",
  plan_change: "تغيير الباقة",
  custom_price: "سعر مخصص",
};

function label(value: unknown, fallback = "—"): string {
  if (typeof value !== "string") return fallback;
  return stateLabel[value] ?? value;
}

function moneyMinor(value: unknown): string {
  const raw = typeof value === "number" ? String(value) : value;
  if (typeof raw !== "string" || !/^-?\d+$/.test(raw)) return "غير متاح";
  const amount = BigInt(raw);
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const whole = new Intl.NumberFormat("ar-EG").format(absolute / 100n);
  const fraction = Number(absolute % 100n);
  const decimal = fraction === 0 ? "" : `٫${new Intl.NumberFormat("ar-EG", { minimumIntegerDigits: 2 }).format(fraction)}`;
  return `${negative ? "−" : ""}${whole}${decimal} جنيه`;
}

function dateLabel(value: unknown): string {
  if (typeof value !== "string") return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("ar-EG", { dateStyle: "medium" }).format(date);
}

function QueryState({ loading, failed, empty, children }: {
  loading: boolean;
  failed: boolean;
  empty: boolean;
  children: React.ReactNode;
}) {
  if (loading) return <div className="co-data-state" role="status">جارٍ تحميل البيانات…</div>;
  if (failed) return <div className="co-data-state co-data-state-error" role="alert">تعذر تحميل هذا القسم. حدّث الصفحة أو أعد المحاولة.</div>;
  if (empty) return <div className="co-data-state">{children}</div>;
  return null;
}

function Pager({ page, totalPages, onPage }: { page: number; totalPages: number; onPage: (next: number) => void }) {
  if (totalPages <= 1) return null;
  return <nav className="co-page-controls" aria-label="صفحات النتائج">
    <button type="button" className="co-small-button" disabled={page <= 1} onClick={() => onPage(page - 1)}>السابق</button>
    <span>صفحة {new Intl.NumberFormat("ar-EG").format(page)} من {new Intl.NumberFormat("ar-EG").format(totalPages)}</span>
    <button type="button" className="co-small-button" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>التالي</button>
  </nav>;
}

function SectionTabs<T extends string>({ value, options, onChange }: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return <div className="co-subtabs" role="tablist">
    {options.map((option) => <button
      key={option.value}
      type="button"
      role="tab"
      aria-selected={value === option.value}
      className={value === option.value ? "is-active" : ""}
      onClick={() => onChange(option.value)}
    >{option.label}</button>)}
  </div>;
}

export function OrganizationSummaryPanel({
  organizationId, organizationName, kind, branchCount, branchesFailed = false, branchesLoading = false,
}: {
  organizationId: string;
  organizationName: string;
  kind: OrgKind;
  branchCount: number | null;
  branchesFailed?: boolean;
  branchesLoading?: boolean;
}) {
  const members = useListAdminOrganizationMemberships(
    { organizationId, page: 1, pageSize: 1 },
    { query: { queryKey: getListAdminOrganizationMembershipsQueryKey({ organizationId, page: 1, pageSize: 1 }), retry: false } },
  );
  const fleetParams = { organizationId, page: 1, pageSize: 1 };
  const fleet = useGetAdminFleetCompanySummaries(fleetParams, {
    query: { queryKey: getGetAdminFleetCompanySummariesQueryKey(fleetParams), enabled: kind === "company", retry: false },
  });
  const billingParams = { organizationId, section: "subscriptions" as const, page: 1, pageSize: 10 };
  const billing = useGetAdminOrganizationBilling(billingParams, {
    query: { queryKey: getGetAdminOrganizationBillingQueryKey(billingParams), enabled: kind !== "station", retry: false },
  });
  const financeParams = { organizationId, page: 1, pageSize: 10 };
  const finance = useGetAdminOrganizationFinanceAccounts(financeParams, {
    query: { queryKey: getGetAdminOrganizationFinanceAccountsQueryKey(financeParams), enabled: kind === "company", retry: false },
  });
  const fleetCompany = record(record(fleet.data)["company"]);
  const balances = record(record(finance.data)["balancesMinor"]);
  const subscriptions = dataRows(billing.data);
  const currentSubscription = subscriptions.find((item) => item["status"] === "active")
    ?? subscriptions.find((item) => item["status"] === "scheduled")
    ?? subscriptions.find((item) => item["status"] === "pending_payment")
    ?? null;
  const currentSnapshot = record(currentSubscription?.["planSnapshot"]);
  const currentName = currentSubscription
    ? text(currentSnapshot["name"], text(currentSubscription["planName"], "اسم الباقة غير متاح"))
    : "لا توجد باقة سارية";
  const currentNameLabel = currentSubscription?.["status"] === "pending_payment"
    ? `بانتظار السداد: ${currentName}`
    : currentSubscription?.["status"] === "scheduled"
      ? `مجدولة: ${currentName}`
      : currentName;

  return <section className="co-profile-overview" aria-labelledby="co-profile-overview-title">
    <div className="co-profile-section-title">
      <div><span className="co-eyebrow">ملف الجهة</span><h2 id="co-profile-overview-title">{organizationName}</h2></div>
      <p>ملخص من السجلات الحالية؛ تظهر حالة التحميل أو عدم توفر البيانات بوضوح.</p>
    </div>
    <div className="co-profile-metrics">
      <Metric title="الفروع" value={branchesLoading ? "جارٍ التحميل" : branchesFailed ? "تعذر التحميل" : branchCount === null ? "غير متاح" : branchCount} />
      <Metric title="المستخدمون والعضويات" value={members.isLoading ? "جارٍ التحميل" : members.isError ? "تعذر التحميل" : totalOf(members.data) ?? "غير متاح"} />
      {kind === "company" && <>
        <Metric title="المركبات" value={fleet.isLoading ? "جارٍ التحميل" : fleet.isError ? "تعذر التحميل" : num(fleetCompany["vehicleCount"]) ?? "غير متاح"} />
        <Metric title="السائقون النشطون" value={fleet.isLoading ? "جارٍ التحميل" : fleet.isError ? "تعذر التحميل" : num(fleetCompany["activeDriverCount"]) ?? "غير متاح"} />
        <Metric title="المركبات المغطاة" value={fleet.isLoading ? "جارٍ التحميل" : fleet.isError ? "تعذر التحميل" : num(fleetCompany["coveredVehicleCount"]) ?? "غير متاح"} />
        <Metric title="الرصيد الدفتري" value={finance.isLoading ? "جارٍ التحميل" : finance.isError ? "تعذر التحميل" : record(finance.data)["accountState"] === "missing" ? "لا يوجد حساب" : moneyMinor(balances["ledgerBalanceMinor"])} />
        <Metric title="المتاح" value={finance.isLoading ? "جارٍ التحميل" : finance.isError ? "تعذر التحميل" : record(finance.data)["accountState"] === "missing" ? "لا يوجد حساب" : moneyMinor(balances["availableMinor"])} />
        <Metric title="المحجوز" value={finance.isLoading ? "جارٍ التحميل" : finance.isError ? "تعذر التحميل" : record(finance.data)["accountState"] === "missing" ? "لا يوجد حساب" : moneyMinor(balances["reservedMinor"])} />
      </>}
      {kind === "provider" && <Metric title="الاشتراكات" value={billing.isLoading ? "جارٍ التحميل" : billing.isError ? "تعذر التحميل" : totalOf(billing.data) ?? "غير متاح"} />}
    </div>
    {kind !== "station" && <div className="co-profile-subscription">
      <div>
        <span>الباقة الحالية</span>
          <strong>{billing.isLoading ? "جارٍ التحميل" : billing.isError ? "تعذر التحميل" : currentNameLabel}</strong>
      </div>
        <div><span>حالة الاشتراك</span><strong>{billing.isLoading ? "جارٍ التحميل" : billing.isError ? "تعذر التحميل" : currentSubscription ? label(currentSubscription["status"]) : subscriptions.length ? "لا يوجد اشتراك سارٍ" : "لا يوجد اشتراك مسجل"}</strong></div>
        <div><span>تاريخ السريان</span><strong>{currentSubscription ? dateLabel(currentSubscription["startsAt"] ?? currentSubscription["starts_at"]) : "—"}</strong></div>
        <div><span>تاريخ الانتهاء</span><strong>{currentSubscription ? dateLabel(currentSubscription["endsAt"] ?? currentSubscription["ends_at"]) : "—"}</strong></div>
    </div>}
  </section>;
}

function Metric({ title, value }: { title: string; value: string | number }) {
  return <div className="co-profile-metric"><span>{title}</span><strong>{typeof value === "number" ? new Intl.NumberFormat("ar-EG").format(value) : value}</strong></div>;
}

export function OrganizationMembersPanel({ organizationId }: { organizationId: string }) {
  const [page, setPage] = useState(1);
  const params = { organizationId, page, pageSize: 10 };
  const query = useListAdminOrganizationMemberships(params, {
    query: { queryKey: getListAdminOrganizationMembershipsQueryKey(params), retry: false },
  });
  const data = record(query.data);
  const rows = dataRows(data);
  const totalPages = Math.max(1, num(data["totalPages"]) ?? 1);
  return <section className="co-profile-panel">
    <SectionHeading title="مستخدمو الجهة" description="عضويات الجهة ونطاق الفروع منفصلة عن أدوار المنصة." count={totalOf(data)} />
    <QueryState loading={query.isLoading} failed={query.isError} empty={!query.isLoading && !query.isError && rows.length === 0}>لا توجد عضويات مسجلة لهذه الجهة.</QueryState>
    {!query.isLoading && !query.isError && rows.length > 0 && <div className="co-data-table-wrap"><table className="co-profile-table">
      <thead><tr><th>المستخدم</th><th>دور الجهة</th><th>النطاق</th><th>الحالة</th><th>الفروع</th><th>الملف</th></tr></thead>
      <tbody>{rows.map((row, index) => {
        const branches = asRows(row["branches"]);
        const userId = text(row["userId"], "");
        return <tr key={text(row["membershipId"], `${page}-${index}`)}>
          <td><strong>{text(record(row["profile"])["display_name"], text(record(row["profile"])["username"], "اسم غير متاح"))}</strong><small>{text(record(row["profile"])["username"], "")}</small></td>
          <td>{label(row["role"])}</td><td>{label(row["scope"])}</td>
          <td><span className={`co-status-chip ${row["active"] === true ? "is-active" : "is-inactive"}`}>{row["active"] === true ? "نشط" : "موقوف"}</span></td>
          <td>{row["scope"] === "organization" ? "كل فروع الجهة" : branches.map((branch) => text(branch["name"])).join("، ") || "لا توجد فروع محددة"}</td>
          <td>{userId ? <Link href={`/admin/platform-users/${encodeURIComponent(userId)}`} className="co-row-link">فتح ملف المستخدم</Link> : "—"}</td>
        </tr>;
      })}</tbody>
    </table></div>}
    <Pager page={page} totalPages={totalPages} onPage={setPage} />
  </section>;
}

export function OrganizationFleetPanel({ organizationId }: { organizationId: string }) {
  const [section, setSection] = useState<"vehicles" | "drivers" | "credentials" | "requests">("vehicles");
  const [page, setPage] = useState(1);
  const vehicleParams = { view: "vehicles" as const, organizationId, page, pageSize: 10, sort: "plate" as const };
  const driverParams = { view: "drivers" as const, organizationId, page, pageSize: 10, sort: "name" as const };
  const credentialParams = { view: "credentials" as const, organizationId, page, pageSize: 10, sort: "newest" as const };
  const branchParams = { organizationId, page: 1, pageSize: 100 };
  const vehicles = useGetAdminFleetCatalog(vehicleParams, { query: { queryKey: getGetAdminFleetCatalogQueryKey(vehicleParams), enabled: section === "vehicles", retry: false } });
  const drivers = useGetAdminFleetCatalog(driverParams, { query: { queryKey: getGetAdminFleetCatalogQueryKey(driverParams), enabled: section === "drivers", retry: false } });
  const credentials = useGetAdminFleetCatalog(credentialParams, { query: { queryKey: getGetAdminFleetCatalogQueryKey(credentialParams), enabled: section === "credentials", retry: false } });
  const branchSummary = useGetAdminFleetCompanySummaries(branchParams, {
    query: { queryKey: getGetAdminFleetCompanySummariesQueryKey(branchParams), enabled: section === "vehicles", retry: false },
  });
  const activeQuery = section === "vehicles" ? vehicles : section === "drivers" ? drivers : credentials;
  const rows = dataRows(activeQuery.data);
  const branchNames = new Map(asRows(record(branchSummary.data)["branches"]).map((branch) => [
    text(branch["id"], ""),
    text(branch["name"], "اسم الفرع غير متاح"),
  ]));
  const totalPages = Math.max(1, num(record(activeQuery.data)["totalPages"]) ?? 1);
  return <section className="co-profile-panel" data-testid="organization-fleet-panel">
    <SectionHeading title="أسطول الشركة" description="بيانات المركبات والسائقين والبطاقات المربوطة بهذه الشركة فقط." />
    <SectionTabs value={section} options={[
      { value: "vehicles", label: "المركبات" },
      { value: "drivers", label: "السائقون" },
      { value: "credentials", label: "البطاقات" },
      { value: "requests", label: "طلبات التعريف" },
    ]} onChange={(value) => { setPage(1); setSection(value); }} />
    {section === "requests" && <FleetCardRequestsPanel organizationId={organizationId} />}
    {section !== "requests" && <QueryState loading={activeQuery.isLoading} failed={activeQuery.isError} empty={!activeQuery.isLoading && !activeQuery.isError && rows.length === 0}>
      {section === "vehicles" ? "لا توجد مركبات مسجلة لهذه الشركة." : section === "drivers" ? "لا يوجد سائقون مسجلون لهذه الشركة." : "لا توجد بطاقات مرتبطة بهذه الشركة."}
    </QueryState>}
    {section !== "requests" && !activeQuery.isLoading && !activeQuery.isError && rows.length > 0 && <div className="co-data-table-wrap"><table className="co-profile-table">
      <thead>{section === "vehicles"
        ? <tr><th>المركبة</th><th>الفرع</th><th>الحالة</th><th>التغطية</th><th>التفاصيل</th></tr>
        : section === "drivers"
          ? <tr><th>السائق</th><th>الكود التشغيلي</th><th>الحالة</th><th>التفاصيل</th></tr>
          : <tr><th>نوع البطاقة</th><th>المركبة</th><th>الحالة</th><th>التفعيل</th><th>التفاصيل</th></tr>}</thead>
      <tbody>{rows.map((row, index) => {
        const id = text(row["id"], "");
        return <tr key={id || `${page}-${index}`}>
          {section === "vehicles" ? <>
            <td><strong>{text(row["plateStandard"], text(row["plateOriginal"], "لوحة غير متاحة"))}</strong><small>{[row["brand"], row["model"], row["modelYear"]].filter(Boolean).join(" ")}</small></td>
            <td>{text(row["branchName"], branchSummary.isLoading ? "جارٍ تحميل اسم الفرع" : branchSummary.isError ? "تعذر تحميل الفرع" : branchNames.get(text(row["branchId"], "")) ?? "اسم الفرع غير متاح")}</td><td>{label(row["status"])}</td>
            <td>{row["isCovered"] === true ? "مغطاة" : row["isCovered"] === false ? "غير مغطاة" : "غير محدد"}</td>
            <td>{id ? <Link href={`/admin/fleet/vehicles/${encodeURIComponent(id)}`} className="co-row-link">فتح المركبة</Link> : "—"}</td>
          </> : section === "drivers" ? <>
            <td><strong>{text(row["fullName"], "اسم غير متاح")}</strong><small>{text(row["phone"], "")}</small></td>
            <td>{text(row["driverCode"])}</td><td>{label(row["status"])}</td>
            <td>{id ? <Link href={`/admin/fleet/drivers/${encodeURIComponent(id)}`} className="co-row-link">فتح السائق</Link> : "—"}</td>
          </> : <>
            <td>{label(row["credentialType"], "بطاقة تعريف")}</td>
            <td>{text(row["plateStandard"], text(row["vehiclePlate"], "المركبة غير متاحة"))}</td>
            <td>{label(row["status"])}</td><td>{label(row["activationStatus"], "غير مفعلة")}</td>
            <td>{id ? <Link href={`/admin/fleet/credentials?credentialId=${encodeURIComponent(id)}`} className="co-row-link">عرض البطاقة</Link> : "—"}</td>
          </>}
        </tr>;
      })}</tbody>
    </table></div>}
    {section === "vehicles" && branchSummary.isError && <p className="co-inline-note" role="status">تعذر تحميل أسماء الفروع المرتبطة؛ بيانات المركبات ما زالت مقيدة بالشركة.</p>}
    {section !== "requests" && <Pager page={page} totalPages={totalPages} onPage={setPage} />}
  </section>;
}

export function OrganizationBillingPanel({ organizationId }: { organizationId: string }) {
  const [section, setSection] = useState<"requests" | "subscriptions" | "priceOverrides">("subscriptions");
  const [page, setPage] = useState(1);
  const params = { organizationId, section, page, pageSize: 10 };
  const query = useGetAdminOrganizationBilling(params, {
    query: { queryKey: getGetAdminOrganizationBillingQueryKey(params), retry: false },
  });
  const data = record(query.data);
  const rows = dataRows(data);
  const totalPages = Math.max(1, num(data["totalPages"]) ?? 1);
  return <section className="co-profile-panel">
    <SectionHeading title="الاشتراكات والأسعار" description="عرض طلبات هذه الجهة ونسخ اشتراكاتها والأسعار الخاصة بها، دون تغيير السجلات." count={totalOf(data)} />
    <SectionTabs value={section} options={[
      { value: "subscriptions", label: "الاشتراكات" },
      { value: "requests", label: "الطلبات" },
      { value: "priceOverrides", label: "الأسعار الخاصة" },
    ]} onChange={(value) => { setPage(1); setSection(value); }} />
    <QueryState loading={query.isLoading} failed={query.isError} empty={!query.isLoading && !query.isError && rows.length === 0}>
      {section === "subscriptions" ? "لا توجد اشتراكات لهذه الجهة." : section === "requests" ? "لا توجد طلبات اشتراك أو تغيير مسجلة." : "لا توجد أسعار خاصة مسجلة لهذه الجهة."}
    </QueryState>
    {!query.isLoading && !query.isError && rows.length > 0 && <div className="co-data-table-wrap"><table className="co-profile-table">
      <thead>{section === "subscriptions"
        ? <tr><th>الباقة المحفوظة</th><th>الحالة</th><th>السريان</th><th>النهاية</th><th>تفاصيل النسخة</th></tr>
        : section === "requests"
          ? <tr><th>نوع الطلب</th><th>الحالة</th><th>النطاق</th><th>التاريخ</th><th>التفاصيل</th></tr>
          : <tr><th>الخطة</th><th>النطاق</th><th>السعر الخاص</th><th>السريان</th><th>التفاصيل</th></tr>}</thead>
      <tbody>{rows.map((row, index) => {
        const snapshot = record(row["planSnapshot"]);
        return <tr key={text(row["id"], `${page}-${index}`)}>
          {section === "subscriptions" ? <>
            <td><strong>{text(snapshot["name"], text(row["planName"], "اسم النسخة غير متاح"))}</strong><small>{text(snapshot["billingUnit"], "")}</small></td>
            <td>{label(row["status"])}</td><td>{dateLabel(row["startsAt"] ?? row["starts_at"])}</td><td>{dateLabel(row["endsAt"] ?? row["ends_at"])}</td>
            <td><details className="co-inline-details"><summary>عرض النسخة</summary><p>السعر المحفوظ: {moneyMinor(snapshot["priceMinor"] ?? row["priceMinor"])}</p><p>المميزات محفوظة ضمن نسخة الاشتراك.</p></details></td>
          </> : section === "requests" ? <>
            <td><strong>{label(row["requestType"])}</strong><small>{text(row["coverageNote"], "")}</small></td>
            <td>{label(row["status"])}</td><td>{text(row["branchName"], row["branchId"] ? "فرع محدد" : "نطاق الجهة")}</td><td>{dateLabel(row["createdAt"] ?? row["created_at"])}</td>
            <td><details className="co-inline-details"><summary>عرض التفاصيل</summary><p>سبب الطلب: {text(row["reason"], "غير مسجل")}</p><p>السعر المطلوب: {moneyMinor(row["requestedPriceMinor"])}</p></details></td>
          </> : <>
            <td><strong>{text(row["planName"], "اسم الخطة غير متاح")}</strong></td>
            <td>{text(row["branchName"], row["branchId"] ? "فرع محدد" : "كل الجهة")}</td><td>{moneyMinor(row["priceMinor"] ?? row["customPriceMinor"])}</td>
            <td>{dateLabel(row["startsAt"] ?? row["starts_at"])}</td>
            <td><details className="co-inline-details"><summary>عرض التفاصيل</summary><p>سبب الاعتماد: {text(row["reason"], "غير مسجل")}</p><p>المعتمد: {text(row["approvedByName"], "غير متاح")}</p></details></td>
          </>}
        </tr>;
      })}</tbody>
    </table></div>}
    {record(query.data)["truncatedAtSource"] === true && <p className="co-inline-note">تعرض هذه القائمة السجلات المتاحة ضمن حد الأرشيف الحالي.</p>}
    <Pager page={page} totalPages={totalPages} onPage={setPage} />
  </section>;
}

export function OrganizationFinancePanel({ organizationId }: { organizationId: string }) {
  const [section, setSection] = useState<"accounts" | "transfers" | "journal">("accounts");
  const [page, setPage] = useState(1);
  const accountParams = { organizationId, page, pageSize: 10 };
  const transferParams = { organizationId, page, pageSize: 10 };
  const journalParams = { organizationId, page, pageSize: 10 };
  const accounts = useGetAdminOrganizationFinanceAccounts(accountParams, { query: { queryKey: getGetAdminOrganizationFinanceAccountsQueryKey(accountParams), retry: false } });
  const transfers = useListAdminFinanceTransfers(transferParams, { query: { queryKey: getListAdminFinanceTransfersQueryKey(transferParams), enabled: section === "transfers", retry: false } });
  const journal = useListAdminFinanceJournal(journalParams, { query: { queryKey: getListAdminFinanceJournalQueryKey(journalParams), enabled: section === "journal", retry: false } });
  const activeQuery = section === "accounts" ? accounts : section === "transfers" ? transfers : journal;
  const data = record(activeQuery.data);
  const rows = dataRows(activeQuery.data);
  const accountData = record(accounts.data);
  const balances = record(accountData["balancesMinor"]);
  const accountMetric = (key: string) => accounts.isLoading
    ? "جارٍ التحميل"
    : accounts.isError
      ? "تعذر التحميل"
      : accountData["accountState"] === "missing"
        ? "لا يوجد حساب"
        : moneyMinor(balances[key]);
  const totalPages = Math.max(1, num(data["totalPages"]) ?? 1);
  return <section className="co-profile-panel">
    <SectionHeading title="الحسابات والحركات المالية" description="أرصدة مشتقة من دفتر الشركة؛ لا يشمل هذا الملخص إيراد المنصة أو أرصدة المركبات." count={totalOf(data)} />
    <div className="co-finance-summary">
      <Metric title="الرصيد الدفتري" value={accountMetric("ledgerBalanceMinor")} />
      <Metric title="المتاح" value={accountMetric("availableMinor")} />
      <Metric title="المحجوز" value={accountMetric("reservedMinor")} />
    </div>
    <SectionTabs value={section} options={[
      { value: "accounts", label: "الحسابات" },
      { value: "transfers", label: "التحويلات الداخلية" },
      { value: "journal", label: "القيود" },
    ]} onChange={(value) => { setPage(1); setSection(value); }} />
    <QueryState loading={activeQuery.isLoading} failed={activeQuery.isError} empty={!activeQuery.isLoading && !activeQuery.isError && (section !== "accounts" && rows.length === 0 || section === "accounts" && rows.length === 0)}>
      {section === "accounts" && data["accountState"] === "missing" ? "لا يوجد حساب تمويل مسجل لهذه الشركة." : section === "accounts" ? "لا توجد حسابات ظاهرة لهذه الشركة." : section === "transfers" ? "لا توجد تحويلات داخلية مسجلة." : "لا توجد قيود ظاهرة لهذه الجهة."}
    </QueryState>
    {!activeQuery.isLoading && !activeQuery.isError && rows.length > 0 && <div className="co-data-table-wrap"><table className="co-profile-table">
      <thead>{section === "accounts"
        ? <tr><th>الحساب</th><th>الفرع</th><th>الرصيد الدفتري</th><th>المحجوز</th><th>المتاح</th></tr>
        : section === "transfers"
          ? <tr><th>المرجع</th><th>من</th><th>إلى</th><th>المبلغ</th><th>التاريخ</th></tr>
          : <tr><th>المرجع</th><th>نوع الحركة</th><th>المبلغ</th><th>الحالة</th><th>التاريخ</th></tr>}</thead>
      <tbody>{rows.map((row, index) => <tr key={text(row["id"], `${page}-${index}`)}>
        {section === "accounts" ? <>
          <td><strong>{label(row["accountKind"], text(row["displayName"], "حساب تمويل"))}</strong><small>{text(row["accountCode"], "")}</small></td>
          <td>{text(row["branchName"], row["branchId"] ? "فرع مرتبط" : "الحساب الرئيسي")}</td>
          <td>{moneyMinor(row["ledgerBalanceMinor"])}</td><td>{moneyMinor(row["reservedMinor"])}</td><td>{moneyMinor(row["availableMinor"])}</td>
        </> : section === "transfers" ? <>
          <td>{text(row["reference"])}</td><td>{text(row["fromAccountName"], "الحساب الرئيسي")}</td><td>{text(row["toAccountName"], "حساب فرع")}</td>
          <td>{moneyMinor(row["amountMinor"])}</td><td>{dateLabel(row["createdAt"] ?? row["created_at"])}</td>
        </> : <>
          <td>{text(row["reference"])}</td><td>{label(row["entryType"])}</td><td>{moneyMinor(row["amountMinor"] ?? row["debitMinor"])}</td>
          <td>{label(row["status"], "مرحّل")}</td><td>{dateLabel(row["postedAt"] ?? row["createdAt"] ?? row["created_at"])}</td>
        </>}
      </tr>)}</tbody>
    </table></div>}
    <Pager page={page} totalPages={totalPages} onPage={setPage} />
  </section>;
}

function SectionHeading({ title, description, count }: { title: string; description: string; count?: number | null }) {
  return <div className="co-profile-section-title">
    <div><h2>{title}</h2><p>{description}</p></div>
    {count !== undefined && <span className="co-result-count">{count === null ? "—" : new Intl.NumberFormat("ar-EG").format(count)} سجل</span>}
  </div>;
}
