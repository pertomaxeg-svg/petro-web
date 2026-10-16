import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Building2, RefreshCw, Search, Truck } from "lucide-react";
import {
  getGetAdminFleetCatalogQueryKey,
  getGetAdminFleetCompanySummariesQueryKey,
  getGetAdminFleetConsumptionRatesQueryKey,
  useGetAdminFleetCatalog,
  useGetAdminFleetCompanySummaries,
  useGetAdminFleetConsumptionRates,
  useSetAdminFleetConsumptionRate,
} from "@workspace/api-client-react";
import type {
  FleetConsumptionRateInput,
  GetAdminFleetCatalogParams,
  GetAdminFleetCompanySummariesParams,
  GetAdminFleetConsumptionRatesParams,
} from "@workspace/api-client-react";
import { FleetReferencePicker } from "./FleetReferencePicker";

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const asRows = (value: unknown): Row[] => Array.isArray(value) ? value.map(row) : [];
const value = (record: Row, key: string) => record[key];
const display = (input: unknown) => typeof input === "string" || typeof input === "number" ? String(input) : "—";
const numeric = (input: unknown) => {
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (typeof input === "string" && /^-?\d+(?:\.\d+)?$/.test(input) && Number.isFinite(Number(input))) return Number(input);
  return null;
};
const formatCount = (input: unknown) => numeric(input)?.toLocaleString("ar-EG") ?? "—";
const formatDate = (input: unknown) => {
  if (typeof input !== "string" || !input) return "—";
  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? input : new Intl.DateTimeFormat("ar-EG", { dateStyle: "medium" }).format(date);
};
const statusLabels: Record<string, string> = {
  active: "نشط", inactive: "غير نشط", suspended: "موقوف", scheduled: "مجدول",
  pending_review: "بانتظار المراجعة", ended: "منتهٍ", cancelled: "ملغي",
  requested: "مطلوب", approved: "معتمد", assigned: "مخصص", installed: "مركب",
  rejected: "مرفوض", revoked: "ملغى", in_service: "في الصيانة",
};
const statusLabel = (input: unknown) => statusLabels[String(input)] ?? display(input);
const errorText = (error: unknown) => {
  const candidate = error as { response?: { status?: number; data?: { message?: string } }; status?: number; message?: string };
  const status = candidate?.response?.status ?? candidate?.status;
  if (status === 403) return "لا يتوفر التفويض اللازم لهذه البيانات.";
  if (status === 409) return "تعارضت العملية مع تحديث أحدث. راجع البيانات ثم أعد المحاولة.";
  return candidate?.response?.data?.message ?? candidate?.message ?? "تعذر تحميل البيانات.";
};

function LoadingState() {
  return <div className="fleet-directory-skeleton" aria-busy="true" aria-label="جارٍ تحميل الدليل"><i/><i/><i/></div>;
}
function ErrorState({ message, retry }: { message: string; retry: () => void }) {
  return <section className="fleet-directory-state is-error" role="alert"><b>تعذر تحميل السجل</b><p>{message}</p><button data-testid="fleet-directory-retry" className="fleet-button fleet-quiet" onClick={retry}><RefreshCw size={15}/> إعادة المحاولة</button></section>;
}
function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <section className="fleet-directory-state"><Building2 size={22}/><b>{title}</b><p>{detail}</p></section>;
}
function egpMinor(minor: number | null) {
  if (minor === null || !Number.isSafeInteger(minor) || minor < 0) return "السعر غير متاح الآن";
  const whole = Math.trunc(minor / 100);
  const fraction = minor % 100;
  const pounds = new Intl.NumberFormat("ar-EG").format(whole);
  return fraction === 0
    ? `${pounds} جنيه مصري`
    : `${pounds}٫${fraction.toLocaleString("ar-EG", { minimumIntegerDigits: 2, useGrouping: false })} جنيه مصري`;
}

export function FleetDirectory({ canMutate, branchOnly = false }: { canMutate: boolean; branchOnly?: boolean }) {
  const [path] = useLocation();
  const companyMatch = path.match(/^\/admin\/fleet\/companies\/([^/]+)$/);
  const companyVehiclesMatch = path.match(/^\/admin\/fleet\/companies\/([^/]+)\/vehicles$/);
  const branchMatch = path.match(/^\/admin\/fleet\/companies\/([^/]+)\/branches\/([^/]+)$/);
  const organizationId = decodeURIComponent(branchMatch?.[1] ?? companyVehiclesMatch?.[1] ?? companyMatch?.[1] ?? "");
  const branchId = decodeURIComponent(branchMatch?.[2] ?? "");
  const showVehicleCatalog = Boolean(branchId || companyVehiclesMatch);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [vehicleStatus, setVehicleStatus] = useState("");
  const [vehicleSort, setVehicleSort] = useState<"plate" | "updatedAt">("plate");
  const branchPageValue = Number(new URLSearchParams(window.location.search).get("branchesPage") ?? page);
  const branchSummaryPage = Number.isInteger(branchPageValue) && branchPageValue > 0 ? branchPageValue : 1;
  useEffect(() => { setPage(1); setSearch(""); setVehicleStatus(""); }, [organizationId, branchId]);
  const companyParams = useMemo<GetAdminFleetCompanySummariesParams>(() => ({
    ...(organizationId ? { organizationId } : {}),
    ...(!organizationId && search.trim().length >= 2 ? { query: search.trim() } : {}),
    page: branchId ? branchSummaryPage : page,
    pageSize: 20,
  }), [organizationId, branchId, branchSummaryPage, search, page]);
  const companies = useGetAdminFleetCompanySummaries(companyParams, {
    query: { queryKey: getGetAdminFleetCompanySummariesQueryKey(companyParams), enabled: !branchOnly || Boolean(organizationId), retry: false },
  });
  const vehicleParams = useMemo<GetAdminFleetCatalogParams>(() => ({
    view: "vehicles",
    organizationId,
    ...(branchId ? { branchId } : {}),
    page,
    pageSize: 20,
    sort: vehicleSort,
    ...(search.trim().length >= 2 ? { query: search.trim() } : {}),
    ...(vehicleStatus ? { status: vehicleStatus } : {}),
  }), [organizationId, branchId, page, vehicleSort, search, vehicleStatus]);
  const vehicles = useGetAdminFleetCatalog(vehicleParams, {
    query: { queryKey: getGetAdminFleetCatalogQueryKey(vehicleParams), enabled: showVehicleCatalog, retry: false },
  });
  const branchItems = asRows(companies.data?.branches);
  const company = row(companies.data?.company);
  const branch = branchItems.find(item => String(item.id ?? "") === branchId) ?? {};
  const items = showVehicleCatalog ? asRows(row(vehicles.data).items) : asRows(companies.data?.items);
  const total = showVehicleCatalog ? numeric(row(vehicles.data).total) : numeric(companies.data?.total);
  const pageSize = showVehicleCatalog ? numeric(row(vehicles.data).pageSize) ?? 20 : numeric(companies.data?.pageSize) ?? 20;
  const totalPages = total === null ? 1 : Math.max(1, Math.ceil(total / pageSize));
  const price = numeric(companies.data?.nfcIssuePriceMinor);
  const nfcPrice = egpMinor(price);
  const companyName = display(company.name);
  const title = branchId
    ? `أسطول ${display(branch.name) === "—" ? "الفرع" : display(branch.name)}`
    : companyVehiclesMatch
      ? `أسطول ${companyName}`
      : companyMatch ? companyName : "دليل شركات الأسطول";

  if (companies.isLoading || (showVehicleCatalog && vehicles.isLoading)) return <LoadingState/>;
  if (companies.isError) return <ErrorState message={errorText(companies.error)} retry={() => void companies.refetch()}/>;
  if (showVehicleCatalog && vehicles.isError) return <ErrorState message={errorText(vehicles.error)} retry={() => void vehicles.refetch()}/>;

  return <div className="fleet-directory" dir="rtl">
    <header className="fleet-directory-heading">
      <div><span className="fleet-eyebrow"><Building2 size={13}/> دليل الشركات والفروع</span><h1>{title}</h1>
        <p>{branchId ? "مركبات الفرع مع ترقيم من سجل الأسطول." : companyVehiclesMatch ? "قائمة مركبات الشركة من السجل الفعلي، مع بقاء الفرع ظاهرًا لكل مركبة." : companyMatch ? "الفروع وأعداد المركبات الفعلية المسجلة لكل فرع." : "ابحث عن شركة ثم انتقل إلى فروعها وسجل مركبات كل فرع."}</p>
      </div>
      <div className="fleet-directory-price"><small>سعر إصدار شريحة NFC</small><b>{nfcPrice}</b><span>سعر الإصدار منفصل؛ لا يثبت دفعًا أو تركيبًا.</span></div>
    </header>
    <nav className="fleet-context-nav" aria-label="مسار الشركات والفروع">
      <Link href="/admin/fleet" data-testid="fleet-companies-breadcrumb">الشركات</Link>
      {organizationId && <><ArrowLeft size={13}/><Link href={`/admin/fleet/companies/${encodeURIComponent(organizationId)}`} data-testid="fleet-company-breadcrumb">{companyName}</Link></>}
      {companyVehiclesMatch && <><ArrowLeft size={13}/><b>كل المركبات</b></>}
      {branchId && <><ArrowLeft size={13}/><b>{display(branch.name) === "—" ? "الفرع" : display(branch.name)}</b></>}
    </nav>

    {!organizationId && <section className="fleet-directory-panel">
      <div className="fleet-directory-toolbar">
        <label className="fleet-directory-search"><Search size={16}/><input data-testid="fleet-company-search" type="search" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder="ابحث باسم الشركة أو الكود"/></label>
        <span>{formatCount(total)} <small>شركة مطابقة</small></span>
      </div>
      {items.length ? <div className="fleet-table-scroll"><table><thead><tr><th>الشركة</th><th>الكود</th><th>الفروع</th><th>المركبات</th><th>نشطة</th><th>السائقون النشطون</th><th>مغطاة</th><th>فتح</th></tr></thead><tbody>{items.map((item, index) => {
        const id = String(item.id ?? "");
        return <tr key={id} data-testid={`fleet-company-row-${index + 1}`}>
          <td><b>{display(item.name)}</b></td><td><bdi dir="ltr">{display(item.code)}</bdi></td><td>{formatCount(item.branchCount)}</td><td>{formatCount(item.vehicleCount)}</td><td>{formatCount(item.activeVehicleCount)}</td><td>{formatCount(item.activeDriverCount)}</td><td>{formatCount(item.coveredVehicleCount)}</td><td><Link className="fleet-row-action" href={`/admin/fleet/companies/${encodeURIComponent(id)}`} data-testid={`fleet-company-open-${index + 1}`}>عرض الفروع</Link></td>
        </tr>;
      })}</tbody></table></div> : <EmptyState title="لا توجد شركات مطابقة" detail="غيّر عبارة البحث أو امسحها لعرض الشركات التي أرجعها الخادم."/>}
      {total !== null && total > pageSize && <Pagination page={page} pages={totalPages} onPage={setPage} label="شركات" />}
    </section>}

    {organizationId && !branchId && <section className="fleet-directory-panel">
      <div className="fleet-company-summary">
        <div><small>إجمالي الفروع</small><b>{formatCount(companies.data?.branchTotal)}</b></div>
        <div><small>الفروع المعروضة</small><b>{formatCount(branchItems.length)}</b></div>
        <Link className="fleet-row-action" href={`/admin/fleet/companies/${encodeURIComponent(organizationId)}/vehicles`}>عرض جميع مركبات الشركة</Link>
        <Link className="fleet-row-action" href={`/admin/organizations/${encodeURIComponent(organizationId)}`}>فتح ملف الشركة</Link>
      </div>
      {branchItems.length ? <div className="fleet-table-scroll"><table><thead><tr><th>الفرع</th><th>إجمالي المركبات</th><th>نشطة</th><th>حسب الحالة</th><th>فتح الأسطول</th></tr></thead><tbody>{branchItems.map((item, index) => {
        const id = String(item.id ?? "");
        const statusCounts = row(item.vehicleCountsByStatus);
        const branchHref = `/admin/fleet/companies/${encodeURIComponent(organizationId)}/branches/${encodeURIComponent(id)}?branchesPage=${page}`;
        return <tr key={id} data-testid={`fleet-branch-row-${index + 1}`}>
          <td><b>{display(item.name)}</b></td><td>{formatCount(item.vehicleCount)}</td><td>{formatCount(item.activeVehicleCount)}</td><td><div className="fleet-status-counts">{Object.entries(statusCounts).map(([status, count]) => <span key={status}>{statusLabel(status)}: {formatCount(count)}</span>)}</div></td>
          <td><Link className="fleet-row-action" href={branchHref} data-testid={`fleet-branch-open-${index + 1}`}>عرض المركبات</Link></td>
        </tr>;
      })}</tbody></table></div> : <section className="fleet-directory-state">
        <Building2 size={22}/><b>لا توجد فروع مسجلة لهذه الشركة</b>
        <p>تتطلب المركبة فرعًا تابعًا للشركة. أنشئ الفرع من ملفها الإداري ثم ارجع إلى الأسطول.</p>
        <div className="fleet-directory-empty-actions">
          {canMutate && <Link className="fleet-row-action" href={`/admin/organizations/${encodeURIComponent(organizationId)}?createBranch=1&returnTo=${encodeURIComponent(`/admin/fleet/companies/${encodeURIComponent(organizationId)}`)}`}>إضافة فرع من ملف الشركة</Link>}
          <Link className="fleet-row-action" href={`/admin/organizations/${encodeURIComponent(organizationId)}`}>فتح ملف الشركة</Link>
        </div>
      </section>}
      {numeric(companies.data?.branchTotal) !== null && Number(companies.data?.branchTotal) > pageSize && <Pagination page={page} pages={Math.ceil(Number(companies.data?.branchTotal) / pageSize)} onPage={setPage} label="فروع"/>}
    </section>}

    {showVehicleCatalog && <section className="fleet-directory-panel">
      <div className="fleet-directory-toolbar">
        <label className="fleet-directory-search"><Search size={16}/><input data-testid="fleet-branch-vehicle-search" type="search" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder="بحث باللوحة أو الطراز"/></label>
        <label className="fleet-inline-filter">الحالة<select data-testid="fleet-branch-status-filter" value={vehicleStatus} onChange={event => { setVehicleStatus(event.target.value); setPage(1); }}><option value="">كل الحالات</option><option value="active">نشطة</option><option value="suspended">موقوفة</option><option value="inactive">غير نشطة</option></select></label>
        <label className="fleet-inline-filter">الترتيب<select data-testid="fleet-branch-sort" value={vehicleSort} onChange={event => setVehicleSort(event.target.value as "plate" | "updatedAt")}><option value="plate">رقم اللوحة</option><option value="updatedAt">آخر تحديث</option></select></label>
        <span>{formatCount(total)} <small>مركبة</small></span>
      </div>
      {items.length ? <div className="fleet-table-scroll"><table><thead><tr>{companyVehiclesMatch && <th>الفرع</th>}<th>اللوحة</th><th>الفئة والنوع</th><th>الماركة والطراز</th><th>سنة الصنع</th><th>الوقود</th><th>الحالة</th><th>الملف</th></tr></thead><tbody>{items.map((item, index) => {
        const id = String(item.id ?? "");
        return <tr key={id} data-testid={`fleet-branch-vehicle-${index + 1}`}>{companyVehiclesMatch && <td>{display(item.branchName)}</td>}<td><bdi dir="ltr">{display(item.plateOriginal ?? item.plateStandard)}</bdi></td><td>{[display(item.category), display(item.vehicleType)].filter(x => x !== "—").join(" · ") || "—"}</td><td>{[display(item.brand), display(item.model)].filter(x => x !== "—").join(" · ") || "—"}</td><td>{display(item.modelYear)}</td><td>{display(item.fuelType)}</td><td><span className={`fleet-status status-${String(item.status ?? "")}`}>{statusLabel(item.status)}</span></td><td><Link className="fleet-row-action" href={`/admin/fleet/vehicles/${encodeURIComponent(id)}`} data-testid={`fleet-branch-vehicle-open-${index + 1}`}>ملف المركبة</Link></td></tr>;
      })}</tbody></table></div> : <EmptyState title="لا توجد مركبات للعرض" detail={companyVehiclesMatch ? "لا توجد مركبات مسجلة لهذه الشركة وفق البحث الحالي." : "لا توجد نتائج في هذا الفرع وفق مرشحات البحث الحالية."}/>}
      {total !== null && total > pageSize && <Pagination page={page} pages={totalPages} onPage={setPage} label="مركبات"/>}
    </section>}

    {(organizationId || branchId) && <ConsumptionRatePanel key={`${organizationId}:${branchId}`} organizationId={organizationId} branchId={branchId || undefined} companyName={display(company.name)} branchName={display(branch.name)} canMutate={canMutate}/>}
  </div>;
}

export function FleetFuelRate({ organizationId, branchId, canMutate }: { organizationId: string; branchId?: string; canMutate: boolean }) {
  return <ConsumptionRatePanel organizationId={organizationId} branchId={branchId} canMutate={canMutate}/>;
}

function Pagination({ page, pages, onPage, label }: { page: number; pages: number; onPage: (page: number) => void; label: string }) {
  return <div className="fleet-pagination"><span>{label} · صفحة {page.toLocaleString("ar-EG")} من {pages.toLocaleString("ar-EG")}</span><div><button data-testid="fleet-directory-prev" disabled={page <= 1} onClick={() => onPage(Math.max(1, page - 1))}>السابق</button><b>{page.toLocaleString("ar-EG")}</b><button data-testid="fleet-directory-next" disabled={page >= pages} onClick={() => onPage(Math.min(pages, page + 1))}>التالي</button></div></div>;
}

function ConsumptionRatePanel({ organizationId, branchId: fixedBranchId, companyName, branchName, canMutate }: { organizationId: string; branchId?: string; companyName?: string; branchName?: string; canMutate: boolean }) {
  const cache = useQueryClient();
  const [scopeBranchId, setScopeBranchId] = useState(fixedBranchId ?? "");
  const [liters, setLiters] = useState("");
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState("");
  const [success, setSuccess] = useState("");
  const params = useMemo<GetAdminFleetConsumptionRatesParams>(() => ({ organizationId, ...(scopeBranchId ? { branchId: scopeBranchId } : {}) }), [organizationId, scopeBranchId]);
  const rates = useGetAdminFleetConsumptionRates(params, {
    query: { queryKey: getGetAdminFleetConsumptionRatesQueryKey(params), enabled: Boolean(organizationId), retry: false },
  });
  const save = useSetAdminFleetConsumptionRate();
  const current = row(rates.data?.current);
  const history = asRows(rates.data?.history);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");
    setSuccess("");
    const rate = Number(liters);
    if (!Number.isFinite(rate) || rate <= 0 || reason.trim().length < 3) {
      setFormError("أدخل معدلًا أكبر من صفر وسببًا موثقًا من ٣ أحرف على الأقل.");
      return;
    }
    const payload: FleetConsumptionRateInput = {
      organizationId,
      branchId: scopeBranchId || null,
      litersPer100Km: rate,
      reason: reason.trim(),
      idempotencyKey: crypto.randomUUID(),
    };
    try {
      await save.mutateAsync({ data: payload });
      setSuccess("أُضيف إصدار جديد للمعدل؛ تبقى الإصدارات السابقة محفوظة.");
      setLiters("");
      setReason("");
      await cache.invalidateQueries({ queryKey: getGetAdminFleetConsumptionRatesQueryKey(params) });
    } catch (error) {
      setFormError(errorText(error));
    } finally {
      save.reset();
    }
  }
  return <section className="fleet-rate-panel">
    <header><div><span className="fleet-eyebrow">مرجع تشغيلي</span><h2>معدل استهلاك الوقود المتوقع</h2><p>لتر لكل ١٠٠ كم. ليس قراءة فعلية لمعدل الاستهلاك.</p></div><span>{fixedBranchId ? branchName ?? "نطاق الفرع" : companyName ?? "نطاق الشركة"}</span></header>
    {rates.isLoading ? <LoadingState/> : rates.isError ? <ErrorState message={errorText(rates.error)} retry={() => void rates.refetch()}/> :
      <div className="fleet-rate-current"><small>{scopeBranchId ? "المعدل الساري للفرع" : "المعدل الساري للشركة"}</small>{current && current.litersPer100Km !== undefined ? <b>{display(current.litersPer100Km)} <i>لتر / ١٠٠ كم</i></b> : <b>لا يوجد معدل ساري مُسجل</b>}<span>{current.effectiveFrom ? `ساري من ${formatDate(current.effectiveFrom)}` : "لا توجد قيمة سارية من الخادم"}</span></div>}
    {!fixedBranchId && canMutate && <FleetReferencePicker kind="branch" value={scopeBranchId} onChange={value => setScopeBranchId(value)} organizationId={organizationId} label="فرع لتحديد نطاق المعدل (اختياري)" emptyLabel="ابحث باسم الفرع" allowAll testId="fleet-rate-branch-picker"/>}
    {canMutate && <form className="fleet-rate-form" onSubmit={submit}>
      <label className="fleet-field">معدل متوقع (لتر / ١٠٠ كم)<input data-testid="fleet-rate-value" type="number" min="0.01" step="0.01" value={liters} onChange={event => setLiters(event.target.value)} required placeholder="أدخل القيمة"/></label>
      <label className="fleet-field fleet-wide">سبب التغيير<input data-testid="fleet-rate-reason" value={reason} onChange={event => setReason(event.target.value)} minLength={3} maxLength={500} required placeholder="سبب موثق للمراجعة"/></label>
      <button data-testid="fleet-rate-submit" className="fleet-button" disabled={save.isPending}>{save.isPending ? "جارٍ حفظ الإصدار…" : "إضافة إصدار للمعدل"}</button>
    </form>}
    {formError && <p className="fleet-feedback is-error" role="alert">{formError}</p>}
    {success && <p className="fleet-feedback" role="status">{success}</p>}
    <div className="fleet-rate-history"><h3>سجل الإصدارات</h3>{history.length ? <div className="fleet-table-scroll"><table><thead><tr><th>الإصدار</th><th>المعدل</th><th>النطاق</th><th>ساري من</th><th>سبب التغيير</th><th>تاريخ التسجيل</th></tr></thead><tbody>{history.map((item, index) => <tr key={`${String(item.version ?? index)}-${String(item.createdAt ?? "")}`}><td>{display(item.version)}</td><td>{display(item.litersPer100Km)} لتر / ١٠٠ كم</td><td>{String(item.scope ?? "") === "branch" ? "فرع" : "شركة"}</td><td>{formatDate(item.effectiveFrom)}</td><td>{display(item.reason)}</td><td>{formatDate(item.createdAt)}</td></tr>)}</tbody></table></div> : <p className="fleet-muted">لا توجد إصدارات سابقة في هذا النطاق.</p>}</div>
  </section>;
}
